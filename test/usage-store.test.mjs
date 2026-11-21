import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from './fixtures/usage/events.mjs'
import { digestSession } from '../lib/usage-digest.js'
const mod=await import('../lib/usage-store.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {}})
async function setup(t) {
  assert.equal(typeof mod.createUsageStore,'function')
  const dir=await mkdtemp(join(tmpdir(),'usage-store-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const source=fixture(), log=join(dir,'source.jsonl')
  await writeFile(log,'synthetic log')
  let exists=true,reads=0,gate=null
  const sessionQuery={
    async listSessions(signal){signal?.throwIfAborted();return exists?[{header:source.session,live:false,persisted:true,formatStatus:'current'}]:[]},
    async readSession(){reads++;if(gate)await gate;return structuredClone(source)},
  }
  const sessionPersistence={async list(){return exists?[{header:source.session,revision:'opaque',location:{kind:'jsonl',path:log}}]:[]}}
  const options={dir:join(dir,'cache'),sessionQuery,sessionPersistence,sessions:{get:()=>undefined},digest:digestSession}
  return {dir,log,source,options,create:()=>mod.createUsageStore(options),reads:()=>reads,delete:()=>{exists=false},undelete:()=>{exists=true},gate:p=>{gate=p}}
}
test('第二次和重新创建 store 不重读未变日志；文件变更才重读',async t=>{
  const s=await setup(t), store=s.create()
  const first=await store.refresh()
  assert.equal(first[0].rows.length,4)
  await store.refresh();assert.equal(s.reads(),1)
  await s.create().refresh();assert.equal(s.reads(),1)
  await writeFile(s.log,'changed synthetic log')
  await store.refresh();assert.equal(s.reads(),2)
})
test('损坏、格式版本不同和结构无效的摘要会重算',async t=>{
  const s=await setup(t)
  await s.create().refresh()
  const path=join(s.options.dir,(await readdir(s.options.dir)).find(f=>f.endsWith('.json')))
  for(const text of ['{','{"version":999}',JSON.stringify({version:1,digest:{rows:[]}})]){
    await writeFile(path,text)
    const rows=await s.create().refresh()
    assert.equal(rows[0].rows.length,4)
  }
  assert.equal(s.reads(),4)
})
test('会话删除保留累计数、不留标题，持久保存 deleted 标记',async t=>{
  const s=await setup(t),store=s.create()
  const before=await store.refresh();s.delete()
  const after=await store.refresh()
  assert.deepEqual(after[0].rows,before[0].rows)
  assert.equal(after[0].deleted,true)
  assert.equal((await s.create().refresh())[0].deleted,true)
  assert.equal(before[0].session.title,'测试 (2)')
  assert.equal(after[0].session.title,null)
  const name=(await readdir(s.options.dir)).find(f=>f.endsWith('.json'))
  assert.doesNotMatch(await readFile(join(s.options.dir,name),'utf8'),/测试 \(2\)/)
})
test('并发刷新共用一次读取，一个请求取消不影响另一个',async t=>{
  const s=await setup(t),store=s.create()
  let release;s.gate(new Promise(r=>{release=r}))
  const controller=new AbortController()
  const a=store.refresh(controller.signal),b=store.refresh()
  controller.abort();await assert.rejects(a,{name:'AbortError'})
  release();assert.equal((await b)[0].rows.length,4);assert.equal(s.reads(),1)
})
test('全部请求取消后不提交迟到的读取，下次刷新能重试',async t=>{
  const s=await setup(t),store=s.create()
  let release;s.gate(new Promise(r=>{release=r}))
  const c=new AbortController(),p=store.refresh(c.signal)
  while(!s.reads()) await new Promise(r=>setImmediate(r))
  c.abort();await assert.rejects(p,{name:'AbortError'});release()
  s.gate(null)
  assert.equal((await store.refresh())[0].rows.length,4)
  assert.equal(s.reads(),2)
  const c2=new AbortController();c2.abort()
  await assert.rejects(store.refresh(c2.signal),{name:'AbortError'})
})
test('活会话边读边增长：本次为固定观察，下次序号变化后更新',async t=>{
  const s=await setup(t), live={seq:24}
  s.options.sessions={get:()=>live}
  s.options.sessionQuery.listSessions=async()=>[{header:s.source.session,live:true,persisted:true}]
  const original=s.options.sessionQuery.readSession
  s.options.sessionQuery.readSession=async()=>{const snap=await original();live.seq++;return snap}
  const store=s.create()
  assert.equal((await store.refresh())[0].rows.length,4)
  await store.refresh();assert.equal(s.reads(),2)
})
test('结构损坏的各类记录被丢弃重算，不把实例锁死',async t=>{
  const s=await setup(t)
  await s.create().refresh()
  const path=join(s.options.dir,(await readdir(s.options.dir)).find(f=>f.endsWith('.json')))
  const original=JSON.parse(await readFile(path,'utf8'))
  for(const key of ['rows','tools','retryLog','turnEnds']){
    const broken=structuredClone(original);broken.digest[key]=[null]
    await writeFile(path,JSON.stringify(broken))
    const store=s.create()
    assert.equal((await store.refresh())[0].rows.length,4)
    assert.equal((await store.refresh())[0].rows.length,4)
  }
  const broken=structuredClone(original);broken.digest.rows[1].comp.sys='bad'
  await writeFile(path,JSON.stringify(broken))
  assert.equal((await s.create().refresh())[0].rows.length,4)
  assert.equal(s.reads(),6)
})
test('取消后的刷新完成清理前不启动另一轮，旧写入不能追过新写入',async t=>{
  const s=await setup(t),store=s.create()
  let release;s.gate(new Promise(r=>{release=r}))
  const controller=new AbortController(),old=store.refresh(controller.signal)
  while(!s.reads())await new Promise(r=>setImmediate(r))
  controller.abort();await assert.rejects(old,{name:'AbortError'})
  s.gate(null)
  const next=store.refresh()
  try {
    await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))
    assert.equal(s.reads(),1)
  }finally{release();await next}
  assert.equal(s.reads(),2)
})
test('一个会话读取失败不影响其他会话：留着上次的摘要、报告数量，恢复后更新',async t=>{
  const s=await setup(t), store=s.create(), warnings=[]
  s.options.logger={warn:m=>warnings.push(m)}
  const quiet=s.create()
  await store.refresh()
  await writeFile(s.log,'changed synthetic log')
  const original=s.options.sessionQuery.readSession
  s.options.sessionQuery.readSession=async()=>{throw new Error('broken log')}
  const kept=await quiet.refresh()
  assert.equal(kept[0].rows.length,4,'上次的摘要还在')
  assert.equal(quiet.unreadable(),1)
  assert.match(warnings.join(),/broken log/)
  s.options.sessionQuery.readSession=original
  assert.equal((await quiet.refresh())[0].rows.length,4)
  assert.equal(quiet.unreadable(),0)
})
test('从没读成功过的会话只计数，不让整次刷新失败',async t=>{
  const s=await setup(t)
  s.options.logger={warn(){}}
  s.options.sessionQuery.readSession=async()=>{throw new Error('broken log')}
  const store=s.create()
  assert.deepEqual(await store.refresh(),[])
  assert.equal(store.unreadable(),1)
})
test('被删除的会话重新出现时重读，标题回来',async t=>{
  const s=await setup(t), store=s.create()
  await store.refresh();s.delete()
  await store.refresh();s.undelete()
  const back=await store.refresh()
  assert.equal(back[0].deleted,false)
  assert.equal(back[0].session.title,'测试 (2)')
  assert.equal(s.reads(),2)
})

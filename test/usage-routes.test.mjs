import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture } from './fixtures/usage/events.mjs'
import { digestSession } from '../lib/usage-digest.js'
import { parseUsageConfig } from '../lib/usage-config.js'
const overview=await import('../lib/usage-overview.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {}})
const routes=await import('../lib/usage.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {}})
const config=parseUsageConfig({timeZone:'Asia/Singapore'}),now=Date.parse('2026-11-06T02:00:00Z')
function finite(value) {
  if(typeof value==='number')assert.ok(Number.isFinite(value))
  else if(value&&typeof value==='object')for(const child of Object.values(value))finite(child)
}
test('新安装、今天无请求、短基线都有可序列化的完整概览',()=>{
  assert.equal(typeof overview.buildOverview,'function')
  const empty=overview.buildOverview([],config,{now})
  finite(empty);assert.equal(empty.life.tokens,0);assert.equal(empty.life.peakTokens,0)
  assert.equal(empty.todayInfo.topTitle,null);assert.equal(empty.vitals[0].m,null)
  assert.equal(empty.vitals[0].anomaly,false)
  assert.deepEqual(empty.recentHours,{});assert.equal(empty.last30.length,30)
  assert.equal('quota' in empty,false);assert.equal('byPreset' in empty,false)
  const d={...digestSession(fixture()),deleted:true}
  const today=overview.buildOverview([d],config,{now})
  finite(today);assert.equal(today.life.tokens,154);assert.equal(today.T.n,4)
  assert.equal(today.life.retries,1);assert.equal(today.life.tools,1)
  assert.equal(today.topSes[0].title,'测试 (2)');assert.equal(today.topSes[0].deleted,true)
  assert.equal(today.todayInfo.topTitle.title,'测试');assert.equal(today.todayInfo.topTitle.share,1)
  assert.deepEqual(today.priceMissing,['unknown-model'])
  assert.equal(today.vitals[0].n,0)
  const tomorrow=overview.buildOverview([d],config,{now:now+86400e3})
  finite(tomorrow);assert.equal(tomorrow.todayInfo.reqs,0);assert.equal(tomorrow.todayInfo.topTitle,null)
  assert.equal(tomorrow.vitals[0].n,1)
  for(const g of today.gaps)assert.deepEqual(Object.keys(g),['fromSeconds','toSeconds','n','p50'])
})
test('范围切换和余额对账过滤提供方及起点，改价格不改摘要',()=>{
  assert.equal(typeof overview.buildCost,'function')
  const a={...digestSession(fixture()),deleted:false},b=structuredClone(a)
  b.session={...b.session,s:'other',preset:'standard',title:'测试 (7)'}
  for(const key of ['rows','tools','retryLog','turnEnds']) b[key]=b[key].map(r=>({...r,s:'other',preset:'standard'}))
  const all=overview.buildOverview([a,b],config,{now})
  const whale=overview.buildOverview([a,b],config,{now,group:'whale'})
  const other=overview.buildOverview([a,b],config,{now,group:'other'})
  assert.equal(all.life.tokens,308);assert.equal(whale.life.tokens,154);assert.equal(other.life.tokens,154)
  assert.equal(all.todayInfo.topTitle.share,1)
  assert.deepEqual(all.groupsAvailable.map(x=>[x.id,x.sessions]),[['all',2],['whale',1],['other',1]])
  assert.equal(overview.buildCost([a],config,{providers:['opencode-go'],since:0}).n,3)
  assert.deepEqual(overview.buildCost([a],config,{providers:['opencode-go'],since:now+1}),{c:0,n:0})
})
test('MAD 为零时增长的计数标异常，未达请求下限的比例不造基线',()=>{
  assert.equal(typeof overview.buildOverview,'function')
  const d={...digestSession(fixture()),deleted:false}
  const prior={...d.rows[0],t:now-86400e3,input:0,rd:0,out:0,wr:0,prompt:0}
  d.rows.unshift(prior)
  const out=overview.buildOverview([d],config,{now})
  assert.equal(out.vitals.find(v=>v.key==='token').anomaly,true)
  assert.equal(out.vitals.find(v=>v.key==='hit').n,0)
})
test('路由参数错误为 400 代码；不读数据；正确路由响应字段可用',async()=>{
  assert.equal(typeof routes.applyUsageRoutes,'function')
  const registered=[],scope={connection:{fetch:{register:r=>{registered.push(r);return()=>registered.splice(registered.indexOf(r),1)}}}}
  let reads=0
  const dispose=routes.applyUsageRoutes(scope,{store:{async refresh(){reads++;return[]},unreadable:()=>2},getConfig:()=>config,now:()=>now})
  const [main,cost]=registered
  assert.equal(main.path,'/api/dsh-workbench.usage.overview')
  assert.deepEqual(main.methods,['GET'])
  // 连接层只接受声明了 requestBody 的路由，没写时真实请求答 400（11-06 在临时 DSH 里查到）。
  for(const route of registered)assert.equal(route.requestBody,'buffered')
  for(const query of ['group=no','group=all&group=other','extra=1']){
    const r=await main.fetch(new Request(`http://localhost${main.path}?${query}`))
    assert.equal(r.status,400);assert.deepEqual(Object.keys(await r.json()),['error'])
  }
  for(const query of ['','providers=a&since=-1','providers=a&since=NaN','providers=a,,b&since=0','providers=a&since=1.5','providers=a&since=0&since=1']) assert.equal((await cost.fetch(new Request(`http://localhost${cost.path}?${query}`))).status,400)
  assert.equal(reads,0)
  const body=await (await main.fetch(new Request(`http://localhost${main.path}`))).json()
  assert.ok(body.life);finite(body)
  assert.equal(body.unreadable,2)
  assert.deepEqual(await (await cost.fetch(new Request(`http://localhost${cost.path}?providers=a,b&since=0`))).json(),{c:0,n:0})
  dispose();assert.equal(registered.length,0)
})
test('配置损坏在行启动时拒绝，读取错误不把路径带到响应',async t=>{
  assert.equal(typeof routes.apply,'function')
  const dir=await mkdtemp(join(tmpdir(),'usage-route-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  await writeFile(join(dir,'usage.json'),'{')
  assert.throws(()=>routes.apply({},{dir}),SyntaxError)
  const registrations=[],scope={connection:{fetch:{register:r=>{registrations.push(r);return()=>{}}}}}
  routes.applyUsageRoutes(scope,{store:{async refresh(){throw new Error('/private/secret')}},getConfig:()=>config,now:()=>now})
  const response=await registrations[0].fetch(new Request('http://localhost/api/dsh-workbench.usage.overview'))
  assert.equal(response.status,500)
  assert.deepEqual(await response.json(),{error:{code:'usage-read-failed'}})
})
test('双周比较独立于近 N 天展示范围',()=>{
  const d={...digestSession(fixture()),deleted:false}
  for(const key of ['rows','tools','retryLog','turnEnds'])d[key]=d[key].map(r=>({...r,t:r.t-8*86400e3}))
  const out=overview.buildOverview([d],{...config,recentDays:7},{now})
  assert.equal(out.T.n,0)
  assert.equal(out.cmp.find(r=>r.label==='requests').a,2)
  assert.ok(out.cmp.find(r=>r.label==='cost').a>0)
})

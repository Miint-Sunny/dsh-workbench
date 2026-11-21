import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/usage/events.mjs'
const mod = await import('../lib/usage-digest.js').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
test('分叉的分叉只算自己四行用量，恢复 end-seed 不丢已发生请求', () => {
  assert.equal(typeof mod.digestSession, 'function')
  const d = mod.digestSession(fixture())
  assert.equal(d.rows.length, 4)
  assert.equal(d.rows.reduce((n,r)=>n+r.prompt+r.out,0), 154)
  assert.equal(d.rows.filter(r=>r.kind==='main').length,2)
  assert.equal(d.rows[0].kind,'attempt'); assert.equal(d.rows[0].prompt,0)
  assert.equal(d.rows[1].retries,1); assert.equal(d.rows[1].attempts,1)
  assert.equal(d.rows[3].m,'unknown-model')
  assert.equal(d.tools.length,1); assert.equal(d.tools[0].ms,1000)
  assert.equal(d.session.title,'测试 (2)')
  assert.equal(d.session.ws,'workspace')
  assert.equal(d.turnEnds[0].kind,'error'); assert.equal(d.turnEnds[1].kind,'aborted')
  assert.deepEqual(d.retryLog.map(x=>[x.why,x.status]), [['overloaded',429]])
  assert.equal(d.rows[3].comp.sys,0)
  assert.ok(d.rows[1].comp.sys>0)
  const json=JSON.stringify(d)
  for(const text of ['inherited','answer','no usage','not retained','synthetic']) assert.equal(json.includes(text),false)
  assert.equal(d.rows.some(r=>'c' in r || 'saved' in r),false)
})
test('无复制段的恢复标记不截断；继承边界不靠 end-seed 猜测', () => {
  assert.equal(typeof mod.digestSession, 'function')
  const source=fixture()
  assert.equal(mod.digestSession({...source,inheritedEventCount:0}).rows.length,6)
  const d=mod.digestSession({...source,events:source.events.map(e=>e.type==='session/end-seed'?{...e,data:{}}:e)})
  assert.equal(d.rows.length,4)
})
test('上游代码和 HTTP 状态保存为数据，不保存错误正文', () => {
  assert.equal(typeof mod.digestSession, 'function')
  const source=fixture()
  const retry=source.events.find(e=>e.type==='llm/retry')
  retry.data.failure.message='503: Endpoint is unavailable'
  assert.deepEqual(mod.digestSession(source).retryLog.map(x=>[x.why,x.status]), [['endpoint_unavailable',503]])
  retry.data.failure.message='other private text'
  assert.deepEqual(mod.digestSession(source).retryLog.map(x=>[x.why,x.status]), [[null,null]])
})

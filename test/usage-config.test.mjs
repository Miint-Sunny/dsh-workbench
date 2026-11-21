import test from 'node:test'
import assert from 'node:assert/strict'
const mod = await import('../lib/usage-config.js').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
test('配置补全默认值，并拒绝无效数字、正则、时区和分组', () => {
  assert.equal(typeof mod.parseUsageConfig, 'function')
  const c=mod.parseUsageConfig({timeZone:'Asia/Singapore'})
  assert.equal(c.baselineDays,14); assert.equal(c.recentDays,30); assert.equal(c.usdCny,7)
  assert.equal(c.prices[0].pattern,'deepseek-v4-pro')
  for(const bad of [null,[],{baselineDays:0},{baselineDays:Infinity},{missHitBelow:2},{usdCny:-1},{timeZone:'bad/time'},{prices:[{pattern:'[',cur:'CNY',off:[1,2,3]}]},{groups:[{id:'all',preset:'^x'}]},{groups:[{id:'a',preset:'x'},{id:'a',preset:'y'}]},{wakeGroup:'absent'},{peak:{hours:[[12,9]]}},{typo:1}]) assert.throws(()=>mod.parseUsageConfig(bad))
})
test('费用在查询时按顺序选价、分时段和币种，未知模型明确缺价', () => {
  assert.equal(typeof mod.priceRows, 'function')
  const rows=[{m:'gemini-flash-lite',t:Date.parse('2026-11-06T02:00:00Z'),input:1000000,wr:0,rd:1000000,out:1000000},{m:'deepseek-v4-flash',t:Date.parse('2026-11-06T02:00:00Z'),input:1e6,rd:1e6,wr:0,out:1e6},{m:'new',t:0,input:1,rd:0,wr:0,out:0}]
  const c=mod.parseUsageConfig({timeZone:'UTC'})
  const r=mod.priceRows(rows,c)
  assert.ok(Math.abs(r.rows[0].c-19.81)<1e-9)
  assert.equal(r.rows[1].c,10.04)
  assert.deepEqual(r.priceMissing,['new'])
  const changed=mod.priceRows(rows,{...c,usdCny:1})
  assert.ok(Math.abs(changed.rows[0].c-2.83)<1e-9)
  assert.equal('c' in rows[0],false)
})

test('明细异常最小占比默认 5%，允许 0–1，拒绝范围外和非数值', () => {
  assert.equal(mod.parseUsageConfig().anomalyMinShare, 0.05)
  for (const anomalyMinShare of [0, 0.05, 1]) assert.equal(mod.parseUsageConfig({ anomalyMinShare }).anomalyMinShare, anomalyMinShare)
  for (const anomalyMinShare of [-0.01, 1.01, NaN, Infinity, '0.05', null]) assert.throws(() => mod.parseUsageConfig({ anomalyMinShare }), /anomalyMinShare/)
})

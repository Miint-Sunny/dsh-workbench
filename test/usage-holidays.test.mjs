import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/usage/events.mjs'
import { digestSession } from '../lib/usage-digest.js'
import { parseUsageConfig, priceRows } from '../lib/usage-config.js'
import { buildOverview } from '../lib/usage-overview.js'
const mod = await import('../lib/usage-holidays.js').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })

const peak = { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], hours: [[9, 12], [14, 18]] }
// 北京时间 10 点的 deepseek-v4-flash：高峰 10.04（2/.04/8），闲时 5.02（1/.02/4）。
const at10 = (day, extraHolidays) => priceRows([{ m: 'deepseek-v4-flash', t: Date.parse(`${day}T02:00:00Z`), input: 1e6, wr: 0, rd: 1e6, out: 1e6 }], parseUsageConfig({ peak: { ...peak, extraHolidays } })).rows[0]

test('假日表覆盖 2020 到 2026，日期都是合法的 YYYY-MM-DD', () => {
  assert.equal(typeof mod.holidaySet, 'function')
  assert.equal(mod.HOLIDAY_TABLE_LAST_YEAR, 2026)
  assert.deepEqual(Object.keys(mod.CN_PUBLIC_HOLIDAYS), ['2020', '2021', '2022', '2023', '2024', '2025', '2026'])
  assert.equal(Number(Object.keys(mod.CN_PUBLIC_HOLIDAYS).at(-1)), mod.HOLIDAY_TABLE_LAST_YEAR)
  const real = x => new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x
  for (const dates of Object.values(mod.CN_PUBLIC_HOLIDAYS)) for (const x of dates) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(x) && real(x), x)
  // 只收假日：2026 春节（02-15 到 02-23）、2025 端午（05-31 到 06-02）和 2023 春节（01-21 到 01-27）在表里，调休上班的 2023-01-28 不在。
  assert.ok(mod.CN_PUBLIC_HOLIDAYS['2026'].includes('2026-02-16'))
  assert.ok(mod.CN_PUBLIC_HOLIDAYS['2025'].includes('2025-06-01'))
  assert.ok(!mod.CN_PUBLIC_HOLIDAYS['2023'].includes('2023-01-28'))
})

test('普通工作日 10 点按高峰价，法定假日的周一全天闲时，调休上班的周六也是闲时', () => {
  assert.equal(at10('2026-11-05').peak, true)  // 周四
  assert.equal(at10('2026-11-05').c, 10.04)
  assert.equal(at10('2026-11-02').peak, true)  // 不是假日的周一
  const holiday = at10('2026-02-16')           // 春节假期的周一
  assert.equal(holiday.peak, false); assert.equal(holiday.c, 5.02)
  const adjusted = at10('2023-01-28')          // 春节调休上班的周六
  assert.equal(adjusted.peak, false); assert.equal(adjusted.c, 5.02)
})

test('extraHolidays 把工作日改成闲时，格式错误拒绝加载，缺省为空数组', () => {
  const extra = at10('2026-11-09', ['2026-11-09'])  // 周一
  assert.equal(extra.peak, false); assert.equal(extra.c, 5.02)
  assert.deepEqual(parseUsageConfig({}).peak.extraHolidays, [])
  // 老配置只写 peak 的旧三字段仍然可用，extraHolidays 补空数组。
  assert.deepEqual(parseUsageConfig({ peak }).peak.extraHolidays, [])
  for (const bad of [['2026-11-9'], ['2026-13-01'], ['2026-02-30'], ['2026-11-09 ', 1], '2026-11-09', [20261109]])
    assert.throws(() => parseUsageConfig({ peak: { ...peak, extraHolidays: bad } }), /extraHolidays/)
})

test('概览带 holidayTableLastYear；摘要缓存不含费用，改 extraHolidays 后同一份摘要按新价重算', () => {
  assert.equal(buildOverview([], parseUsageConfig({}), { now: Date.parse('2026-11-06T02:00:00Z') }).holidayTableLastYear, 2026)
  const digest = digestSession(fixture())  // 2026-11-06 周五 09:00（北京时间）落在高峰窗口
  const now = Date.parse('2026-11-06T02:00:00Z')
  const peaking = buildOverview([digest], parseUsageConfig({}), { now }).life.c
  const offPeak = buildOverview([digest], parseUsageConfig({ peak: { ...peak, extraHolidays: ['2026-11-06'] } }), { now }).life.c
  assert.equal('c' in digest.rows[0], false)
  assert.ok(offPeak < peaking && peaking > 0)
})

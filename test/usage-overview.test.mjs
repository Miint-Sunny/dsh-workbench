import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/usage/events.mjs'
import { digestSession } from '../lib/usage-digest.js'
import { parseUsageConfig, peakPeriod } from '../lib/usage-config.js'
import { buildOverview } from '../lib/usage-overview.js'

test('压缩没有轮次：不算进会话的轮数，也不算每轮分布里的一轮', () => {
  const digest = digestSession(fixture())
  const now = Date.parse('2026-11-06T02:00:00Z')
  const config = parseUsageConfig({})
  const compaction = { ...digest.rows.find(row => row.kind === 'main'), kind: 'compaction', turn: null }
  const before = buildOverview([digest], config, { now })
  const after = buildOverview([{ ...digest, rows: [...digest.rows, compaction] }], config, { now })
  assert.ok(before.topSes[0].turns > 0)
  assert.equal(after.topSes[0].turns, before.topSes[0].turns)
  assert.equal(after.quant.cost.n, before.quant.cost.n)
  assert.equal(after.life.turns, before.life.turns)
  assert.ok(after.life.c > before.life.c, '压缩的费用还算在累计里')
})

test('高峰时段：现在的状态和结束时间，节假日和周末跳过', () => {
  const config = parseUsageConfig({ peak: { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], hours: [[9, 12], [14, 18]] } })
  const beijing = text => Date.parse(`${text}:00+08:00`)
  assert.deepEqual(peakPeriod(beijing('2026-11-06T15:00'), config), { peak: true, until: beijing('2026-11-06T18:00') })
  assert.deepEqual(peakPeriod(beijing('2026-11-06T12:30'), config), { peak: false, until: beijing('2026-11-06T14:00') })
  assert.deepEqual(peakPeriod(beijing('2026-11-06T19:00'), config), { peak: false, until: beijing('2026-11-09T09:00') }, '周五晚上到下周一')
  assert.deepEqual(peakPeriod(beijing('2026-02-15T12:30'), config), { peak: false, until: beijing('2026-02-24T09:00') }, '春节假期连着跳过')
  const never = parseUsageConfig({ peak: { timeZone: 'Asia/Shanghai', weekdays: [], hours: [] } })
  assert.deepEqual(peakPeriod(beijing('2026-11-06T15:00'), never), { peak: false, until: null })
  const now = beijing('2026-11-06T15:00')
  assert.deepEqual(buildOverview([], config, { now }).period, { peak: true, until: beijing('2026-11-06T18:00') })
})

test('recentHours：按小时的用量，加起来等于当天，一年以前的不放', () => {
  const digest = digestSession(fixture())
  const config = parseUsageConfig({ timeZone: 'Asia/Shanghai' })
  const main = digest.rows.find(row => row.kind === 'main')
  const now = main.t + 3600e3
  const old = { ...main, t: now - 400 * 86400e3 }
  const data = buildOverview([{ ...digest, rows: [...digest.rows, old] }], config, { now })
  assert.equal(data.baselineDays, config.baselineDays)
  assert.equal(Object.keys(data.recentHours).length, Object.keys(data.year).length - 1, '400 天前那条只在 year 里')
  for (const [day, hours] of Object.entries(data.recentHours)) {
    const values = Object.values(hours)
    assert.equal(values.reduce((sum, hour) => sum + hour.tokens, 0), data.year[day].tokens)
    assert.equal(values.reduce((sum, hour) => sum + hour.n, 0), data.year[day].n)
    assert.ok(Math.abs(values.reduce((sum, hour) => sum + hour.c, 0) - data.year[day].c) < 1e-3)
    assert.ok(Object.keys(hours).every(hour => Number(hour) >= 0 && Number(hour) < 24))
  }
  assert.equal('band' in data, false)
  assert.equal('todayCurve' in data, false)
})

/** 概览的 `ranges`：左侧汇总在各范围的数字，窗口必须和图（usage-charts.js）求和的窗口一样。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/usage/events.mjs'
import { digestSession } from '../lib/usage-digest.js'
import { parseUsageConfig } from '../lib/usage-config.js'
import { buildOverview } from '../lib/usage-overview.js'
import { usageBarView, usageRangeTotals, usageShiftDay } from '../src/client/usage-charts.js'

const TODAY = '2026-11-10'
const NOW = Date.parse(`${TODAY}T14:30:00+08:00`)
const config = parseUsageConfig({ timeZone: 'Asia/Shanghai' })
const base = digestSession(fixture()).rows.find(row => row.kind === 'main')
const at = (back, hhmm) => Date.parse(`${usageShiftDay(TODAY, -back)}T${hhmm}:00+08:00`)

/** 每条记录的 input 是 2 的幂，所以某个范围的 token 合计直接说明它含哪几条。 */
const spec = [
  // [名字, 几天前, 时刻, 会话, 轮次, kind]
  ['today-early', 0, '00:10', 'A', 1, 'main'],
  ['today-now', 0, '14:20', 'B', 7, 'main'],
  ['night-before', 1, '23:50', 'A', 1, 'main'],
  ['yday-in', 1, '15:05', 'C', 2, 'main'],
  ['yday-out', 1, '14:50', 'C', 3, 'main'],
  ['compact-yday', 1, '16:00', 'C', null, 'compaction'],
  ['six-days', 6, '23:30', 'D', 1, 'main'],
  ['seven-days', 7, '23:30', 'D', 2, 'main'],
  ['d29', 29, '03:00', 'E', 1, 'main'],
  ['d30', 30, '03:00', 'E', 2, 'main'],
  ['d364', 364, '12:00', 'F', 1, 'main'],
  ['d365', 365, '12:00', 'F', 2, 'main'],
]
const bits = Object.fromEntries(spec.map(([name], index) => [name, 2 ** index]))
const rows = spec.map(([name, back, hhmm, s, turn, kind]) => ({ ...base, t: at(back, hhmm), s, turn, kind, input: bits[name], rd: 0, wr: 0, out: 0, prompt: bits[name] }))
const tools = [at(0, '09:00'), at(1, '20:00'), at(1, '10:00'), at(5, '10:00'), at(40, '10:00')].map((t, index) => ({ s: 'A', t, name: 'look', ms: 5, err: false, tok: index }))
const retryLog = [at(0, '01:00'), at(1, '22:00'), at(1, '09:00'), at(20, '09:00')].map(t => ({ t, s: 'A', p: 'x', code: null, why: null, status: null }))
const digest = { session: { s: 'A', ws: 'w', preset: null, title: 't', created: 0, req: 0, turns: 0, lastPrompt: 0, snap: 0 }, rows, tools, retryLog, turnEnds: [], deleted: false }
const data = buildOverview([digest], config, { now: NOW })
const sumOf = names => names.reduce((total, name) => total + bits[name], 0)

test('ranges：今日、24 小时、7 天、30 天、1 年各含哪几条记录（整点窗口和日历日窗口的边界）', () => {
  assert.equal(data.today, TODAY)
  assert.equal(data.nowH, 14)
  assert.deepEqual(Object.keys(data.ranges).sort(), ['24h', '30', '365', '7d', 'today'])
  assert.equal(data.ranges.today.tokens, sumOf(['today-early', 'today-now']))
  assert.equal(data.ranges['24h'].tokens, sumOf(['today-early', 'today-now', 'night-before', 'yday-in', 'compact-yday']), '昨天 14 时那一小时已经出了窗口')
  assert.equal(data.ranges['7d'].tokens, sumOf(['today-early', 'today-now', 'night-before', 'yday-in', 'yday-out', 'compact-yday', 'six-days']))
  assert.equal(data.ranges['30'].tokens, data.ranges['7d'].tokens + bits['seven-days'] + bits.d29)
  assert.equal(data.ranges['365'].tokens, data.ranges['30'].tokens + bits.d30 + bits.d364)
  assert.equal(data.life.tokens, data.ranges['365'].tokens + bits.d365)
})

test('ranges：和图求和的窗口逐项相等（token、费用、模型请求）', () => {
  for (const range of ['today', '24h', '7d']) {
    const total = usageBarView(data, range, data.today, 'tokens').total
    assert.equal(data.ranges[range].tokens, total.tokens, `${range} tokens`)
    assert.ok(Math.abs(data.ranges[range].c - total.c) < 1e-4, `${range} c（图里每小时先取整到 6 位）`)
    assert.equal(data.ranges[range].req, total.n, `${range} req`)
  }
  for (const range of ['30', '365']) {
    const total = usageRangeTotals(data, range)
    assert.equal(data.ranges[range].tokens, total.tokens, `${range} tokens`)
    assert.ok(Math.abs(data.ranges[range].c - total.c) < 1e-4, `${range} c`)
    assert.equal(data.ranges[range].req, total.n, `${range} req`)
  }
})

test('ranges：会话和轮次在窗口里去重，跨零点的同一轮只算一次；压缩不属于某一轮', () => {
  const { today, '24h': h24, '7d': d7 } = data.ranges
  assert.deepEqual([today.sessions, today.turns], [2, 2], 'A/1 和 B/7')
  assert.deepEqual([h24.sessions, h24.turns], [3, 3], 'A/1 跨零点只算一次，加上 B/7、C/2')
  assert.deepEqual([d7.sessions, d7.turns], [4, 5], '再加 C/3 和 D/1')
  assert.equal(h24.comp, 1)
  assert.equal(today.comp, 0)
  assert.equal(h24.req, 4, '压缩不算模型请求')
})

test('ranges：工具调用和重试按各自发生的小时落进窗口', () => {
  const { today, '24h': h24, '7d': d7, 30: d30 } = data.ranges
  assert.deepEqual([today.tools, h24.tools, d7.tools, d30.tools], [1, 2, 4, 4], '昨天 10 时的那次在 24 小时窗口之外，5 天前那次只在 7 天以内')
  assert.deepEqual([today.retries, h24.retries, d7.retries, d30.retries], [1, 2, 3, 4])
  assert.equal(data.life.tools, 5)
  assert.equal(data.life.retries, 4)
})

test('ranges：只有「全部」用 life，其余字段名和 life 里的汇总字段一致', () => {
  assert.equal('all' in data.ranges, false)
  for (const value of Object.values(data.ranges)) {
    for (const key of ['tokens', 'c', 'input', 'rd', 'out', 'req', 'turns', 'sessions', 'tools', 'comp', 'retries']) assert.ok(key in value && key in data.life, key)
  }
})

test('ranges：没有记录时各范围都是 0，模型和工作区是空数组', () => {
  const empty = buildOverview([], config, { now: NOW })
  for (const value of Object.values(empty.ranges)) {
    assert.deepEqual([value.models, value.workspaces], [[], []])
    assert.deepEqual(Object.values({ ...value, models: 0, workspaces: 0 }).filter(x => x !== 0), [])
  }
})

test('ranges：模型和工作区按这个范围的记录算，占比相对这个范围的合计，一个范围里没有的不出现', () => {
  const split = rows.map((row, index) => ({ ...row, m: index % 2 === 0 ? 'deepseek-v4-flash' : 'deepseek-v4-pro' }))
  const digests = ['A', 'B', 'C', 'D', 'E', 'F'].map(s => ({ ...digest, session: { ...digest.session, s, ws: `ws-${s}` }, rows: split.filter(row => row.s === s), tools: [], retryLog: [] }))
  const overview = buildOverview(digests, config, { now: NOW })
  for (const [range, value] of Object.entries(overview.ranges)) {
    assert.equal(value.models.reduce((total, model) => total + model.v, 0), value.tokens, `${range} 模型合计`)
    assert.equal(value.workspaces.reduce((total, ws) => total + ws.v, 0), value.tokens, `${range} 工作区合计`)
    if (value.tokens > 0) {
      assert.ok(Math.abs(value.models.reduce((total, model) => total + model.p, 0) - 1) < 1e-9, `${range} 模型占比`)
      assert.deepEqual(value.models.map(model => model.v), [...value.models.map(model => model.v)].sort((a, b) => b - a), `${range} 从大到小`)
    }
  }
  assert.deepEqual(overview.ranges.today.workspaces.map(ws => ws.n).sort(), ['ws-A', 'ws-B'], '今日只有 A、B 的记录')
  assert.deepEqual(overview.ranges['7d'].workspaces.map(ws => ws.n).sort(), ['ws-A', 'ws-B', 'ws-C', 'ws-D'])
  assert.equal(overview.ranges['7d'].workspaces.find(ws => ws.n === 'ws-D').v, bits['six-days'], '7 天里只有 6 天前那条，7 天前那条在窗口外')
  assert.equal(overview.ranges['30'].workspaces.find(ws => ws.n === 'ws-D').v, bits['six-days'] + bits['seven-days'])
  assert.equal(overview.modelN, overview.models.length)
  assert.equal(overview.models.reduce((total, model) => total + model.v, 0), overview.life.tokens, '累计的数组不变')
})

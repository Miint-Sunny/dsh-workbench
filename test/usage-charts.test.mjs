import test from 'node:test'
import assert from 'node:assert/strict'
import {
  usageIsSmallRange, usageShiftDay, usageMonthSpans, usageHeatDayGrid, usageHeatWeekGrid, usageHeatGridOf, usageHeatCuts, usageHeatMove,
  usageRangeDays, usageRangeTotals, usageRangeStats, usageBarSlots, usageBaseline, usageNiceMax, usageBarView, usageViewStats, usageHourStats, usagePickStats,
  usageBarMove, usageHeatTracks, usageBarAxis, usageBarGeometry, usageSigned,
} from '../src/client/usage-charts.js'
import { usageHeatLevel } from '../src/client/usage-model.js'

/** 2026-11-07 是周六，现在 18 时。从 first 起每天 0 时和 12 时各用一次。 */
function sample({ first = '2026-10-20', days = 19, nowH = 18 } = {}) {
  const year = {}
  const recentHours = {}
  for (let i = 0; i < days; i += 1) {
    const day = usageShiftDay(first, i)
    const scale = i + 1
    recentHours[day] = { 0: { tokens: 100 * scale, c: 1, n: 1 }, 12: { tokens: 300 * scale, c: 2, n: 3 } }
    year[day] = { tokens: 400 * scale, c: 3, n: 4 }
  }
  return {
    today: '2026-11-07', nowH, baselineDays: 14, year, recentHours,
    life: { first, streak: days, longest: days, busyWd: 2, busyHour: 9 },
  }
}

test('范围：今日、24 小时、7 天是柱状图，其余是热力图', () => {
  assert.deepEqual(['today', '24h', '7d', '30', '365', 'all'].map(usageIsSmallRange), [true, true, true, false, false, false])
})

test('30 天：一列一天，今天在最右边，还没到的时段和第一次使用之前没有格子', () => {
  const grid = usageHeatDayGrid(sample())
  assert.equal(grid.cols, 30)
  assert.equal(grid.rows, 8)
  const last = grid.cells.at(-1)
  assert.deepEqual([last.col, last.day, last.from, last.now], [29, '2026-11-07', 18, true], '现在 18 时，今天只到 18–21 时那一格')
  assert.equal(grid.cells.filter(cell => cell.day === '2026-11-07').length, 7)
  assert.equal(grid.cells.some(cell => cell.day < '2026-10-20'), false)
  const zero = grid.cells.find(cell => cell.day === '2026-10-20' && cell.from === 0)
  assert.deepEqual(zero.use, { tokens: 100, c: 1, n: 1 }, '3 小时加起来')
  assert.deepEqual(grid.rowLabels.map(label => label.hour), [0, 6, 12, 18])
})

test('30 天：更早的日子往左放，列数按 30 天一段取整；分隔线在每月 1 号那一列前面', () => {
  const grid = usageHeatDayGrid(sample({ first: '2026-08-15', days: 85 }))
  assert.equal(grid.cols, 90, '85 天放 3 段')
  const dayOf = col => usageShiftDay('2026-11-07', col - grid.cols + 1)
  assert.deepEqual(grid.rules.map(dayOf), ['2026-09-01', '2026-10-01', '2026-11-01'])
  assert.deepEqual(grid.rules, [22, 52, 83], '今天 11-07 在第 89 列')
  assert.deepEqual(grid.rules.map(col => dayOf(col - 1)), ['2026-08-31', '2026-09-30', '2026-10-31'])
  assert.equal(grid.cells.at(-1).day, '2026-11-07')
  const long = usageHeatDayGrid(sample({ first: '2025-01-01', days: 3 }))
  assert.equal(long.cols, 180, '最多 6 段')
})

test('30 天：第一次使用正好是某月 1 号时，那一列前面不画分隔线', () => {
  const grid = usageHeatDayGrid(sample({ first: '2026-09-01', days: 68 }))
  const dayOf = col => usageShiftDay('2026-11-07', col - grid.cols + 1)
  assert.deepEqual(grid.rules.map(dayOf), ['2026-10-01', '2026-11-01'])
  assert.equal(grid.rules.includes(grid.dayLabels[0].col), false, '9 月 1 号是画出来的第一列')
  const fresh = usageHeatDayGrid(sample({ first: '2026-11-01', days: 7 }))
  assert.deepEqual(fresh.rules, [], '左边全是隐藏的列')
})

test('30 天的轴：两层，月写在跨的列上，每天都有日期，窄的时候只留 1 和 5 的倍数', () => {
  const grid = usageHeatDayGrid(sample({ first: '2026-09-01', days: 68 }))
  const lastTwo = grid.months.slice(-2)
  assert.deepEqual(lastTwo.map(span => span.month), [10, 11])
  const dates = grid.dayLabels.slice(-8)
  assert.deepEqual(dates.map(label => label.date), [31, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(dates.map(label => label.minor), [true, false, true, true, true, false, true, true])
  assert.equal(dates.at(-1).today, true)
  assert.equal(grid.dayLabels.length, 68, '每天一个')
})

test('跨年的月份照样排', () => {
  const spans = usageMonthSpans(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'], 2)
  assert.deepEqual(spans.map(span => span.month), [12, 1])
})

test('只占一列的月：放不下字，只留最后一个，靠右写', () => {
  const spans = usageMonthSpans(['2026-09-28', '2026-10-05', '2026-10-12', '2026-11-02'], 2)
  assert.deepEqual(spans.map(({ month, end }) => [month, end]), [[10, false], [11, true]])
})

test('1 年和全部：一列一周，周一在最上面，今天在最后一列', () => {
  const data = sample()
  const year = usageHeatGridOf(data, '365')
  assert.equal(year.rows, 7)
  assert.equal(year.cells.at(-1).day, '2026-11-07')
  assert.equal(year.cells.at(-1).row, 5, '周六')
  assert.equal(year.cells.length, 365)
  assert.equal(new Set(year.cells.map(cell => cell.day)).size, 365, '每天一格')
  assert.equal(year.cells.every(cell => cell.size === 24), true)
  const all = usageHeatGridOf(data, 'all')
  assert.equal(all.cells[0].day, '2026-10-20', '有多少画多少')
  assert.equal(all.cols, 3)
  assert.deepEqual(usageHeatWeekGrid(data, '2026-11-02').cells.map(cell => cell.row), [0, 1, 2, 3, 4, 5])
})

test('分级线按传进来的格子算，没有用量的不上色', () => {
  const cuts = usageHeatCuts([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
  assert.equal(usageHeatLevel(100, cuts), 0)
  assert.equal(usageHeatLevel(1000, cuts), 4)
  assert.equal(usageHeatLevel(0, cuts), -1)
  assert.deepEqual(usageHeatCuts([0, 0]), [])
})

test('键盘：方向键走到相邻的格子，走到没有格子的地方不动', () => {
  const cells = [{ col: 0, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 0 }]
  assert.equal(usageHeatMove(cells, 0, 'ArrowDown'), 1)
  assert.equal(usageHeatMove(cells, 0, 'ArrowRight'), 2)
  assert.equal(usageHeatMove(cells, 1, 'ArrowRight'), null)
  assert.equal(usageHeatMove(cells, 0, 'ArrowUp'), null)
  assert.equal(usageHeatMove(cells, 1, 'Home'), 0)
  assert.equal(usageHeatMove(cells, 0, 'End'), 2)
  assert.equal(usageHeatMove(cells, 0, 'Enter'), null)
})

test('范围的数字：只算范围里的日子，连续两项从今天往回算', () => {
  const data = sample({ first: '2026-08-15', days: 85 })
  assert.equal(usageRangeDays(data, '30').length, 30)
  assert.equal(usageRangeDays(data, 'all').length, 85)
  assert.equal(usageRangeTotals(data, '30').n, 120)
  const stats = usageRangeStats(data, '30')
  assert.equal(stats.activeDays, 30)
  assert.equal(stats.streak, 85)
  assert.equal(stats.peakDay, '2026-11-07')
  assert.equal(stats.busyHour, 12)
  const all = usageRangeStats(data, 'all')
  assert.deepEqual([all.busyWd, all.busyHour], [2, 9], '全部沿用接口算好的')
})

test('今日：24 根柱子，还没到的小时留空，累计到现在', () => {
  const view = usageBarView(sample(), 'today', '2026-11-07', 'tokens')
  assert.equal(view.slots.length, 24)
  assert.equal(view.slots.filter(slot => slot.future).length, 5)
  assert.equal(view.slots[18].now, true)
  assert.equal(view.last, 18)
  assert.equal(view.total.tokens, 7600)
  assert.equal(view.cum[18], 7600)
  assert.equal(view.cum[19], null)
  assert.equal(view.lines, true)
  assert.equal(view.base.length, 24)
  assert.ok(view.top >= view.cum[18])
})

test('24 小时：从现在往回，跨过零点', () => {
  const slots = usageBarSlots(sample(), '24h', '2026-11-07')
  assert.equal(slots.length, 24)
  assert.deepEqual([slots[0].day, slots[0].hour], ['2026-11-06', 19])
  assert.deepEqual([slots[4].day, slots[4].hour], ['2026-11-06', 23])
  assert.deepEqual([slots[5].day, slots[5].hour], ['2026-11-07', 0])
  assert.deepEqual([slots[23].day, slots[23].hour], ['2026-11-07', 18])
  assert.equal(slots.some(slot => slot.future), false)
})

test('7 天：168 根柱子，只有柱子没有线', () => {
  const view = usageBarView(sample(), '7d', '2026-11-07', 'tokens')
  assert.equal(view.slots.length, 168)
  assert.equal(view.lines, false)
  assert.equal(view.base, null)
  assert.equal(view.slots[0].day, '2026-11-01')
})

test('基线：前 14 天每天的累计取分位数，第一次使用之前的日子不算', () => {
  const base = usageBaseline(sample(), 'day', '2026-11-07', 'tokens')
  // 12 时的累计是 400 × 第几天，前 14 天是第 5 到第 18 天，中位数是第 11.5 天。
  assert.equal(base[12].m, 4600)
  assert.equal(base[0].m, 1150, '0 时只有 100 × 第几天')
  assert.ok(base[12].lo < base[12].m && base[12].m < base[12].hi)
  const short = usageBaseline(sample({ first: '2026-11-05', days: 3 }), 'day', '2026-11-07', 'tokens')
  assert.equal(short[12].m, 600, '前面只有两天可比，400 和 800')
  assert.equal(usageBaseline(sample({ first: '2026-11-07', days: 1 }), 'day', '2026-11-07', 'tokens'), null, '第一天没有可比的日子')
})

test('基线跟着指标走，24 小时也按同一时刻往回算', () => {
  const data = sample()
  assert.equal(usageBaseline(data, 'day', '2026-11-07', 'n')[12].m, 4)
  const window = usageBaseline(data, '24h', '2026-11-07', 'tokens')
  assert.equal(window.length, 24)
  assert.ok(window[23].m > window[0].m)
})

test('高轴最大值取整到好读的数，并且不小于实际值', () => {
  assert.equal(usageNiceMax(0), 1)
  assert.equal(usageNiceMax(5_380_000), 6_000_000)
  assert.equal(usageNiceMax(1_000_000), 1_000_000)
  assert.equal(usageNiceMax(112), 150)
  assert.ok(usageNiceMax(0.79) >= 0.79)
})

test('数字一律按 token 算：切指标时图变，数字不变', () => {
  const data = sample()
  const tokens = usageBarView(data, 'today', '2026-11-07', 'tokens')
  const cost = usageBarView(data, 'today', '2026-11-07', 'c')
  assert.notEqual(tokens.top, cost.top)
  assert.deepEqual(usageViewStats(cost), usageViewStats(tokens))
})

test('今日的数字：累计和比中位数', () => {
  const stats = usageViewStats(usageBarView(sample(), 'today', '2026-11-07', 'tokens'))
  assert.equal(stats.lines, true)
  assert.equal(stats.tokens, 7600)
  assert.equal(stats.activeHours, 2)
  assert.equal(stats.peak.hour, 12)
  assert.ok(stats.vsMedian > 0, '今天是第 19 天，比前 14 天的中位数高')
})

test('7 天的数字：活跃天数、活跃小时、每小时中位数', () => {
  const stats = usageViewStats(usageBarView(sample(), '7d', '2026-11-07', 'tokens'))
  assert.equal(stats.lines, false)
  assert.equal(stats.activeDays, 7)
  assert.equal(stats.activeHours, 14)
  assert.equal(stats.peak.day, '2026-11-07')
  assert.ok(stats.medianHour > 0)
})

test('选中第二张图的一根柱子：这一小时的数字', () => {
  const view = usageBarView(sample(), 'today', '2026-11-07', 'tokens')
  const stats = usageHourStats(view, 12)
  assert.deepEqual([stats.tokens, stats.requests, stats.cum], [5700, 3, 7600])
  assert.equal(stats.share, 5700 / 7600)
  assert.equal(usageHourStats(usageBarView(sample(), '7d', '2026-11-07', 'tokens'), 0).cum, null, '7 天没有累计')
})

test('选中 3 小时的格子：这一格的数字和当天的数字', () => {
  const data = sample()
  const cell = usageHeatDayGrid(data).cells.find(item => item.day === '2026-11-06' && item.from === 12)
  const stats = usagePickStats(data, cell, '30')
  assert.equal(stats.whole, false)
  assert.equal(stats.tokens, 5400)
  assert.equal(stats.dayTokens, 7200)
  assert.equal(stats.shareOfDay, 0.75)
  assert.ok(stats.dayVsMedian > 0)
})

test('选中一天的格子：活跃小时、单小时最高、比活跃日中位数', () => {
  const data = sample()
  const cell = usageHeatGridOf(data, 'all').cells.find(item => item.day === '2026-11-06')
  const stats = usagePickStats(data, cell, 'all')
  assert.equal(stats.whole, true)
  assert.equal(stats.activeHours, 2)
  assert.equal(stats.peak.hour, 12)
  assert.ok(stats.vsActiveMedian > 0)
  const empty = usagePickStats(data, { day: '2026-01-01', size: 24, use: { tokens: 0, c: 0, n: 0 } }, 'all')
  assert.deepEqual([empty.activeHours, empty.peak, empty.vsActiveMedian], [0, null, null], '没有用量的那天不报错')
})

test('超过一年没有小时数据时，第二张图是空的，活跃小时写不出来', () => {
  const data = sample()
  const view = usageBarView(data, 'day', '2025-01-01', 'tokens')
  assert.equal(view.total.tokens, 0)
  assert.equal(view.empty, true)
  assert.equal(usageViewStats(view).peak, null)
  const old = usagePickStats(data, { day: '2025-01-01', size: 24, use: { tokens: 500, c: 1, n: 2 } }, 'all')
  assert.deepEqual([old.tokens, old.activeHours, old.peak], [500, null, null])
})

test('热力图的列：分隔线单占一列，后面的格子跟着往后错', () => {
  const grid = usageHeatDayGrid(sample({ first: '2026-08-15', days: 85 }))
  const { template, lineOf } = usageHeatTracks(grid)
  assert.equal(lineOf.length, 90)
  assert.equal(template.split(' ').filter(track => track === '3px').length, 3, '9、10、11 月 1 号前面各一条')
  assert.deepEqual([lineOf[0], lineOf[21], lineOf[22], lineOf[52], lineOf[83], lineOf[89]], [2, 23, 25, 56, 88, 94])
})

test('键盘在柱子之间走：还没到的小时走不过去', () => {
  assert.equal(usageBarMove(18, 18, 'ArrowRight'), null)
  assert.equal(usageBarMove(18, 17, 'ArrowRight'), 18)
  assert.equal(usageBarMove(18, 0, 'ArrowLeft'), null)
  assert.equal(usageBarMove(18, 5, 'Home'), 0)
  assert.equal(usageBarMove(18, 5, 'End'), 18)
  assert.equal(usageBarMove(18, 5, 'Enter'), null)
})

test('横轴：今日每 3 小时一个标签，没有竖线', () => {
  const { seps, labels } = usageBarAxis(usageBarView(sample(), 'today', '2026-11-07', 'tokens'))
  assert.deepEqual(seps, [])
  assert.deepEqual(labels.map(label => label.hour), [0, 3, 6, 9, 12, 15, 18, 21])
  assert.equal(labels.every(label => label.kind === 'hour'), true)
})

test('横轴：24 小时过零点那里写日期并画竖线；窗口刚好从零点开始时不画', () => {
  const { seps, labels } = usageBarAxis(usageBarView(sample(), '24h', '2026-11-07', 'tokens'))
  assert.deepEqual(seps, [5])
  assert.deepEqual(labels.find(label => label.kind === 'date'), { index: 5, kind: 'date', day: '2026-11-07', hour: 0 })
  const fromMidnight = usageBarAxis(usageBarView(sample({ nowH: 23 }), '24h', '2026-11-07', 'tokens'))
  assert.deepEqual(fromMidnight.seps, [])
  assert.equal(fromMidnight.labels[0].kind, 'date')
})

test('横轴：7 天每天一条竖线，写日期和 12 时', () => {
  const { seps, labels } = usageBarAxis(usageBarView(sample(), '7d', '2026-11-07', 'tokens'))
  assert.deepEqual(seps, [24, 48, 72, 96, 120, 144])
  assert.deepEqual(labels.filter(label => label.kind === 'date').map(label => label.day.slice(5)), ['11-01', '11-02', '11-03', '11-04', '11-05', '11-06', '11-07'])
  assert.equal(labels.filter(label => label.kind === 'minor').length, 7)
})

test('线从左下角出发，点落在这一小时结束的位置，没到的小时不画', () => {
  const view = usageBarView(sample(), 'today', '2026-11-07', 'tokens')
  const geometry = usageBarGeometry(view)
  assert.equal(geometry.cum.startsWith('M0 100L4.167 '), true)
  assert.equal(geometry.cum.split('L').length, 1 + 19)
  assert.equal(geometry.dot.left, (19 / 24 * 100).toFixed(3))
  assert.equal(geometry.heights[19], 0)
  assert.ok(geometry.heights[12] > geometry.heights[0])
  assert.ok(geometry.band.endsWith('Z'))
  const week = usageBarGeometry(usageBarView(sample(), '7d', '2026-11-07', 'tokens'))
  assert.deepEqual([week.band, week.median, week.cum, week.dot], [null, null, null, null])
  const first = usageBarGeometry(usageBarView(sample({ first: '2026-11-07', days: 1 }), 'today', '2026-11-07', 'tokens'))
  assert.deepEqual([first.band, first.median], [null, null], '第一天没有基线，只有累计线')
})

test('带符号的百分比：高带加号，低带减号，没有值是破折号', () => {
  assert.equal(usageSigned(0.123), '+12%')
  assert.equal(usageSigned(-0.5), '-50%')
  assert.equal(usageSigned(null), '—')
  assert.equal(usageSigned(Infinity), '—')
})

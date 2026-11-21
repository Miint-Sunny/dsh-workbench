/**
 * 用量页的图：范围、格子、柱子和图下面的数字。都是纯函数，不碰 DOM，界面在 usage.js。
 * 时间一律从左往右，今天在最右边。图跟着指标切换走，数字一律按 token 算，不随指标切换。
 * 方案在 docs/plans/2026-11-07-用量页热力图.md。
 */
import { usageQuantile } from './usage-model.js'

const USAGE_CHART_DAY_MS = 86400000
const USAGE_SEGMENT_DAYS = 30
const USAGE_MAX_SEGMENTS = 6
const USAGE_NO_USE = Object.freeze({ tokens: 0, c: 0, n: 0 })
const USAGE_SIGNED_FORMAT = new Intl.NumberFormat('en-US', { style: 'percent', signDisplay: 'always', maximumFractionDigits: 0 })

/** 今日、24 小时、7 天用柱状图，其余用热力图。 */
export const USAGE_SMALL_RANGES = ['today', '24h', '7d']
export const USAGE_RANGES = [...USAGE_SMALL_RANGES, '30', '365', 'all']
export const USAGE_DEFAULT_RANGE = '30'

/** @param {string} range 范围。@returns {boolean} 是不是柱状图的范围。 */
export function usageIsSmallRange(range) {
  return USAGE_SMALL_RANGES.includes(range)
}

const usageNoon = day => Date.parse(`${day}T12:00:00Z`)
const usageWeekdayOf = day => (new Date(usageNoon(day)).getUTCDay() + 6) % 7
const usageDayUse = (data, day) => data.year[day] ?? USAGE_NO_USE
const usageHourUse = (data, day, hour) => data.recentHours?.[day]?.[hour] ?? USAGE_NO_USE
const usageSumUse = uses => uses.reduce((total, use) => ({ tokens: total.tokens + use.tokens, c: total.c + use.c, n: total.n + use.n }), { ...USAGE_NO_USE })

/**
 * 日期加减。
 * @param {string} day `YYYY-MM-DD`。
 * @param {number} offset 天数，可以是负数。
 * @returns {string} `YYYY-MM-DD`。
 */
export function usageShiftDay(day, offset) {
  return new Date(usageNoon(day) + offset * USAGE_CHART_DAY_MS).toISOString().slice(0, 10)
}

/**
 * 上面的轴：每个月占哪几列。只占一列的月放不下字，只留最后一个，靠右写。
 * @param {Array<string | null>} days 每一列的日期，不画的列是 null。
 * @param {number} minSpan 至少占几列才写。
 * @returns {Array<{from: number, to: number, month: number, end: boolean}>} 按列排。
 */
export function usageMonthSpans(days, minSpan) {
  const spans = []
  days.forEach((day, col) => {
    if (day === null) return
    const key = day.slice(0, 7)
    const last = spans.at(-1)
    if (last?.key === key) last.to = col
    else spans.push({ key, from: col, to: col, month: Number(day.slice(5, 7)) })
  })
  const wide = (span) => span.to - span.from + 1 >= minSpan
  return spans
    .filter((span, index) => wide(span) || index === spans.length - 1)
    .map(({ from, to, month }) => ({ from, to, month, end: to - from + 1 < minSpan }))
}

/**
 * 30 天的格子：一列一天，一格 3 小时，今天在最右边，更早的往左滚动，列数按 30 天一段取整。
 * 每月 1 号那一列前面一条分隔线，左边那一列是第一次使用之前（不画）时不画。第一次使用之前和还没到的时段不算格子。
 * @param {object} data 用量接口的回答。
 * @returns {object} 格子、分隔线和轴。
 */
export function usageHeatDayGrid(data) {
  const first = data.life.first ?? data.today
  const age = Math.round((usageNoon(data.today) - usageNoon(first)) / USAGE_CHART_DAY_MS) + 1
  const cols = Math.min(USAGE_MAX_SEGMENTS, Math.ceil(age / USAGE_SEGMENT_DAYS)) * USAGE_SEGMENT_DAYS
  const cells = []
  const rules = []
  const dayLabels = []
  const days = []
  for (let col = 0; col < cols; col += 1) {
    const day = usageShiftDay(data.today, col - cols + 1)
    const hidden = day < first
    days.push(hidden ? null : day)
    if (hidden) continue
    const date = Number(day.slice(8))
    if (date === 1 && col > 0 && days[col - 1] !== null) rules.push(col)
    dayLabels.push({ col, date, minor: !(date === 1 || date % 5 === 0), today: day === data.today })
    for (let row = 0; row < 8; row += 1) {
      const from = row * 3
      if (day === data.today && from > data.nowH) continue
      const use = usageSumUse([0, 1, 2].map(step => usageHourUse(data, day, from + step)))
      cells.push({ col, row, day, from, size: 3, use, now: day === data.today && data.nowH >= from && data.nowH < from + 3 })
    }
  }
  return { kind: 'days', cols, rows: 8, cells, rules, months: usageMonthSpans(days, 2), dayLabels, rowLabels: [0, 1, 2, 3].map(step => ({ row: step * 2, span: 2, hour: step * 6 })) }
}

/**
 * 1 年和全部的格子：一列一周，周一在最上面，一格一天。
 * @param {object} data 用量接口的回答。
 * @param {string} startDay 从哪天开始画。
 * @returns {object} 格子和轴。
 */
export function usageHeatWeekGrid(data, startDay) {
  const start = usageShiftDay(startDay, -usageWeekdayOf(startDay))
  const cols = Math.floor((usageNoon(data.today) - usageNoon(start)) / USAGE_CHART_DAY_MS / 7) + 1
  const cells = []
  const mondays = []
  for (let col = 0; col < cols; col += 1) {
    mondays.push(usageShiftDay(start, col * 7))
    for (let row = 0; row < 7; row += 1) {
      const day = usageShiftDay(start, col * 7 + row)
      if (day > data.today || day < startDay) continue
      cells.push({ col, row, day, from: 0, size: 24, use: usageDayUse(data, day), now: day === data.today })
    }
  }
  return { kind: 'weeks', cols, rows: 7, cells, rules: [], months: usageMonthSpans(mondays, 2), rowLabels: [0, 2, 4].map(row => ({ row, span: 2, weekday: row })) }
}

/**
 * 某个热力图范围的格子。
 * @param {object} data 用量接口的回答。
 * @param {'30' | '365' | 'all'} range 范围。
 * @returns {object} `usageHeatDayGrid` 或 `usageHeatWeekGrid` 的结果。
 */
export function usageHeatGridOf(data, range) {
  if (range === '30') return usageHeatDayGrid(data)
  return usageHeatWeekGrid(data, range === '365' ? usageShiftDay(data.today, -364) : (data.life.first ?? data.today))
}

/**
 * 分级线：有用量的值取 20、40、60、80 分位。
 * @param {number[]} values 画出来的所有格子在当前指标上的值。
 * @returns {number[]} 四条分级线；都没有用量时是空数组。
 */
export function usageHeatCuts(values) {
  const used = values.filter(value => value > 0)
  return used.length === 0 ? [] : [0.2, 0.4, 0.6, 0.8].map(p => usageQuantile(used, p))
}

/**
 * 热力图的列：第一列是纵轴，每条分隔线单占一列。
 * @param {{cols: number, rules: number[]}} grid 格子。
 * @returns {{template: string, lineOf: number[]}} `grid-template-columns` 的值和每一列的起始网格线。
 */
export function usageHeatTracks(grid) {
  const rules = new Set(grid.rules)
  const tracks = ['38px']
  const lineOf = []
  let line = 2
  for (let col = 0; col < grid.cols; col += 1) {
    if (rules.has(col)) {
      tracks.push('3px')
      line += 1
    }
    tracks.push('var(--cell)')
    lineOf.push(line)
    line += 1
  }
  return { template: tracks.join(' '), lineOf }
}

/**
 * 键盘在格子之间移动。
 * @param {Array<{col: number, row: number}>} cells 格子。
 * @param {number} index 现在在哪一格。
 * @param {string} key 按键。
 * @returns {number | null} 要去的格子；不处理这个键或那个位置没有格子时是 null。
 */
export function usageHeatMove(cells, index, key) {
  if (cells.length === 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return cells.length - 1
  const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const offset = offsets[key]
  const here = cells[index]
  if (offset === undefined || here === undefined) return null
  const next = cells.findIndex(cell => cell.col === here.col + offset[0] && cell.row === here.row + offset[1])
  return next === -1 ? null : next
}

function usageRangeStart(data, range) {
  if (range === '30') return usageShiftDay(data.today, -29)
  if (range === '365') return usageShiftDay(data.today, -364)
  return data.life.first ?? data.today
}

/**
 * 范围里有用量的日子，升序。
 * @param {object} data 用量接口的回答。
 * @param {'30' | '365' | 'all'} range 范围。
 * @returns {string[]} 日期。
 */
export function usageRangeDays(data, range) {
  const start = usageRangeStart(data, range)
  return Object.keys(data.year).filter(day => day >= start && day <= data.today && data.year[day].tokens > 0).sort()
}

/**
 * 范围的合计，只算最右边这一段。
 * @param {object} data 用量接口的回答。
 * @param {'30' | '365' | 'all'} range 范围。
 * @returns {{tokens: number, c: number, n: number}} 合计。
 */
export function usageRangeTotals(data, range) {
  return usageSumUse(usageRangeDays(data, range).map(day => data.year[day]))
}

/**
 * 左侧汇总在所选范围的数字：「全部」是累计，其余范围来自接口的 `ranges`，窗口和图一致。
 * @param {object} data 用量接口的回答。
 * @param {string} range 范围。
 * @returns {{tokens: number, c: number, input: number, rd: number, out: number, req: number, turns: number, sessions: number, tools: number, comp: number, retries: number}} 汇总字段，同 `data.life` 里的同名字段。
 */
export function usageRangeSummary(data, range) {
  return range === 'all' ? data.life : data.ranges[range]
}

/**
 * 热力图下面的数字。「连续」两项从今天往回算，不随范围变。
 * @param {object} data 用量接口的回答。
 * @param {'30' | '365' | 'all'} range 范围。
 * @returns {object} 活跃天数、连续、中位数、单日最高和最活跃的时段。
 */
export function usageRangeStats(data, range) {
  const days = usageRangeDays(data, range)
  const tokens = days.map(day => data.year[day].tokens)
  const peakDay = days.reduce((best, day) => (best === null || data.year[day].tokens > data.year[best].tokens ? day : best), null)
  let busy = range === 'all' ? { wd: data.life.busyWd, hour: data.life.busyHour } : { wd: null, hour: null }
  if (range !== 'all') {
    let top = 0
    const totals = new Map()
    for (const day of days) {
      for (const [hour, use] of Object.entries(data.recentHours?.[day] ?? {})) {
        const key = `${usageWeekdayOf(day)}/${hour}`
        const sum = (totals.get(key) ?? 0) + use.tokens
        totals.set(key, sum)
        if (sum > top) { top = sum; busy = { wd: usageWeekdayOf(day), hour: Number(hour) } }
      }
    }
  }
  return {
    activeDays: days.length,
    streak: data.life.streak,
    longest: data.life.longest,
    median: days.length === 0 ? null : usageQuantile(tokens, 0.5),
    peakDay,
    peakTokens: peakDay === null ? 0 : data.year[peakDay].tokens,
    busyWd: busy.wd,
    busyHour: busy.hour,
  }
}

/** 窗口里第 i 小时对应哪一天哪一时。一天的窗口从 0 点算，24 小时从现在往回算。 */
function usageWindowSlot(kind, end, index, nowHour) {
  if (kind !== '24h') return { day: end, hour: index }
  const hour = nowHour - 23 + index
  return hour < 0 ? { day: usageShiftDay(end, -1), hour: hour + 24 } : { day: end, hour }
}

/**
 * 柱状图的柱子。
 * @param {object} data 用量接口的回答。
 * @param {'today' | '24h' | '7d' | 'day'} kind 窗口。
 * @param {string} end 窗口结束那天。
 * @returns {Array<{day: string, hour: number, use: object, future: boolean, now: boolean}>} 一小时一根。
 */
export function usageBarSlots(data, kind, end) {
  const slots = []
  if (kind === '7d') {
    for (let back = 6; back >= 0; back -= 1) {
      const day = usageShiftDay(end, -back)
      for (let hour = 0; hour < 24; hour += 1) slots.push({ day, hour })
    }
  } else {
    for (let index = 0; index < 24; index += 1) slots.push(usageWindowSlot(kind, end, index, data.nowH))
  }
  return slots.map(({ day, hour }) => ({
    day,
    hour,
    use: usageHourUse(data, day, hour),
    future: day === data.today && hour > data.nowH,
    now: day === data.today && hour === data.nowH,
  }))
}

/**
 * 基线：前几天里每天取同样窗口的累计，每个小时取中位数和 p25、p75。第一次使用之前的日子不算。
 * @param {object} data 用量接口的回答。
 * @param {'today' | '24h' | 'day'} kind 窗口。
 * @param {string} end 窗口结束那天。
 * @param {'tokens' | 'c' | 'n'} metric 指标。
 * @returns {Array<{m: number, lo: number, hi: number}> | null} 24 个点；没有可比的日子时是 null。
 */
export function usageBaseline(data, kind, end, metric) {
  const first = data.life.first ?? data.today
  const days = Array.from({ length: data.baselineDays }, (_, index) => usageShiftDay(end, -index - 1)).filter(day => day >= first)
  if (days.length === 0) return null
  const curves = days.map((day) => {
    let sum = 0
    return Array.from({ length: 24 }, (_, index) => {
      const slot = usageWindowSlot(kind, day, index, data.nowH)
      sum += usageHourUse(data, slot.day, slot.hour)[metric]
      return sum
    })
  })
  return Array.from({ length: 24 }, (_, index) => {
    const column = curves.map(curve => curve[index])
    return { m: usageQuantile(column, 0.5), lo: usageQuantile(column, 0.25), hi: usageQuantile(column, 0.75) }
  })
}

/**
 * 高轴的最大值，取整到好读的数。
 * @param {number} value 实际的最大值。
 * @returns {number} 不小于它的整数倍。
 */
export function usageNiceMax(value) {
  if (!(value > 0)) return 1
  const unit = 10 ** Math.floor(Math.log10(value))
  const step = [1, 1.5, 2, 3, 4, 5, 6, 8, 10].find(item => value <= item * unit * (1 + 1e-9)) ?? 10
  return step * unit
}

/**
 * 键盘在柱子之间移动。还没到的小时不能选。
 * @param {number} last 最后一根能选的柱子。
 * @param {number} index 现在在哪一根。
 * @param {string} key 按键。
 * @returns {number | null} 要去的柱子；不处理这个键或已经到头时是 null。
 */
export function usageBarMove(last, index, key) {
  if (key === 'Home') return 0
  if (key === 'End') return last
  if (key === 'ArrowLeft') return index > 0 ? index - 1 : null
  if (key === 'ArrowRight') return index < last ? index + 1 : null
  return null
}

/**
 * 柱状图要画的全部东西。7 天没有可靠的同期基线，只画柱子。
 * @param {object} data 用量接口的回答。
 * @param {'today' | '24h' | '7d' | 'day'} kind 窗口。
 * @param {string} end 窗口结束那天。
 * @param {'tokens' | 'c' | 'n'} metric 指标。
 * @returns {object} 柱子、累计、基线、合计和高轴最大值。
 */
export function usageBarView(data, kind, end, metric) {
  const slots = usageBarSlots(data, kind, end)
  const lines = kind !== '7d'
  const done = slots.filter(slot => !slot.future)
  const total = usageSumUse(done.map(slot => slot.use))
  let run = 0
  let runTokens = 0
  const cum = slots.map((slot) => {
    if (slot.future) return null
    run += slot.use[metric]
    return run
  })
  const cumTokens = slots.map((slot) => {
    if (slot.future) return null
    runTokens += slot.use.tokens
    return runTokens
  })
  const base = lines ? usageBaseline(data, kind, end, metric) : null
  const baseTokens = lines ? usageBaseline(data, kind, end, 'tokens') : null
  const peak = Math.max(
    0,
    ...done.map(slot => slot.use[metric]),
    ...(lines ? cum.filter(value => value !== null) : []),
    ...(base === null ? [] : base.map(point => point.hi)),
  )
  return { kind, end, metric, slots, lines, total, cum, cumTokens, base, baseTokens, top: usageNiceMax(peak), empty: peak === 0, last: done.length - 1 }
}

/**
 * 柱状图的横轴：一天的窗口每 3 小时写一次，过零点和 7 天每天的开头写日期并画一条竖线。
 * @param {object} view `usageBarView` 的结果。
 * @returns {{seps: number[], labels: Array<{index: number, kind: 'date' | 'hour' | 'minor', day: string, hour: number}>}} 竖线和标签都按第几根柱子算位置；`minor` 窄的时候不显示。
 */
export function usageBarAxis(view) {
  const seps = []
  const labels = []
  view.slots.forEach(({ day, hour }, index) => {
    const startsDay = hour === 0 && (view.kind === '7d' || view.kind === '24h')
    if (startsDay) {
      if (index > 0) seps.push(index)
      labels.push({ index, kind: 'date', day, hour })
    } else if (view.kind === '7d') {
      if (hour === 12) labels.push({ index, kind: 'minor', day, hour })
    } else if (hour % 3 === 0) {
      labels.push({ index, kind: 'hour', day, hour })
    }
  })
  return { seps, labels }
}

/**
 * 柱子的高度和线的路径，坐标系是 0–100。线的点落在这一小时结束的位置，所以从左下角的 0 出发。
 * @param {object} view `usageBarView` 的结果。
 * @returns {{heights: number[], band: string | null, median: string | null, cum: string | null, dot: {left: string, top: string} | null}} 没有线的窗口后四项是 null。
 */
export function usageBarGeometry(view) {
  const count = view.slots.length
  const x = index => (index / count * 100).toFixed(3)
  const y = value => (100 - value / view.top * 100).toFixed(2)
  const heights = view.slots.map(slot => (slot.future ? 0 : slot.use[view.metric] / view.top * 100))
  if (!view.lines) return { heights, band: null, median: null, cum: null, dot: null }
  const line = values => `M0 100L${values.flatMap((value, index) => (value === null ? [] : [`${x(index + 1)} ${y(value)}`])).join('L')}`
  const base = view.base
  return {
    heights,
    band: base === null ? null : `${line(base.map(point => point.hi))}L${[...base].reverse().map((point, index) => `${x(count - index)} ${y(point.lo)}`).join('L')}L0 100Z`,
    median: base === null ? null : line(base.map(point => point.m)),
    cum: line(view.cum),
    dot: { left: x(view.last + 1), top: y(view.cum[view.last]) },
  }
}

function usagePeakSlot(slots) {
  return slots.reduce((best, slot) => (slot.use.tokens > (best?.use.tokens ?? 0) ? slot : best), null)
}

/**
 * 带符号的百分比，比基线高带加号，低带减号。
 * @param {number | null | undefined} value 比例，0.12 是高 12%。
 * @returns {string} 比如 `+12%`；没有值时是破折号。
 */
export function usageSigned(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return USAGE_SIGNED_FORMAT.format(value)
}

/**
 * 柱状图下面的数字，没有选中时。
 * @param {object} view `usageBarView` 的结果。
 * @returns {object} `lines` 为真时是累计和比中位数，否则是 7 天那一组。
 */
export function usageViewStats(view) {
  const done = view.slots.filter(slot => !slot.future)
  const active = done.filter(slot => slot.use.tokens > 0)
  const peak = usagePeakSlot(done)
  const common = { tokens: view.total.tokens, cost: view.total.c, requests: view.total.n, activeHours: active.length, peak }
  if (!view.lines) {
    return {
      ...common,
      lines: false,
      activeDays: new Set(active.map(slot => slot.day)).size,
      medianHour: active.length === 0 ? null : usageQuantile(active.map(slot => slot.use.tokens), 0.5),
    }
  }
  const baseline = view.baseTokens?.[view.last]?.m
  return { ...common, lines: true, vsMedian: baseline > 0 ? view.cumTokens[view.last] / baseline - 1 : null }
}

/**
 * 选中第二张图的一根柱子时的数字。
 * @param {object} view `usageBarView` 的结果。
 * @param {number} index 第几根。
 * @returns {object} 这一小时的用量、累计和占这一段的比例。
 */
export function usageHourStats(view, index) {
  const { use } = view.slots[index]
  return {
    tokens: use.tokens,
    cost: use.c,
    requests: use.n,
    cum: view.lines ? view.cumTokens[index] : null,
    share: view.total.tokens > 0 ? use.tokens / view.total.tokens : null,
  }
}

/**
 * 选中一格或第一张图的一根柱子时的数字。
 * @param {object} data 用量接口的回答。
 * @param {{day: string, size: number, use: object}} pick 选中的是哪天、几小时、用量多少。
 * @param {string} range 第一张图的范围，用来算活跃日中位数。
 * @returns {object} `whole` 为真时选中的是一整天。
 */
export function usagePickStats(data, pick, range) {
  const common = { tokens: pick.use.tokens, cost: pick.use.c, requests: pick.use.n }
  const dayTokens = usageDayUse(data, pick.day).tokens
  if (pick.size === 24) {
    const hours = Object.entries(data.recentHours?.[pick.day] ?? {}).map(([hour, use]) => ({ hour: Number(hour), use })).filter(slot => slot.use.tokens > 0)
    const activeTokens = usageRangeDays(data, range).map(day => data.year[day].tokens)
    const median = activeTokens.length === 0 ? null : usageQuantile(activeTokens, 0.5)
    return {
      ...common,
      whole: true,
      activeHours: pick.use.tokens > 0 && hours.length === 0 ? null : hours.length,
      peak: usagePeakSlot(hours),
      vsActiveMedian: pick.use.tokens > 0 && median > 0 ? pick.use.tokens / median - 1 : null,
    }
  }
  const base = usageBaseline(data, 'day', pick.day, 'tokens')
  const until = pick.day === data.today ? data.nowH : 23
  return {
    ...common,
    whole: false,
    shareOfDay: dayTokens > 0 ? pick.use.tokens / dayTokens : null,
    dayTokens,
    dayVsMedian: base !== null && base[until].m > 0 && dayTokens > 0 ? dayTokens / base[until].m - 1 : null,
  }
}

/** 用量统计配置与查询时计价；缺失配置用默认值，损坏配置拒绝加载。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { holidaySet } from './usage-holidays.js'

const PRICES = [
  { pattern: 'deepseek-v4-pro', cur: 'CNY', peak: true, off: [4.5, .15, 13.5], on: [9, .3, 27] },
  { pattern: 'deepseek.*flash', cur: 'CNY', peak: true, off: [1, .02, 4], on: [2, .04, 8] },
  { pattern: 'gemini.*flash-lite', cur: 'USD', off: [.30, .03, 2.5] },
  { pattern: 'gemini.*flash', cur: 'USD', off: [.75, .075, 3.75] },
  { pattern: 'gemini.*pro', cur: 'USD', off: [2, .2, 12] },
]
const fail = field => { throw new Error(`usage config: invalid ${field}`) }
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field) }
function zone(value) { if (typeof value !== 'string' || !value) fail('timeZone'); try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0) } catch { fail('timeZone') } }
function pattern(value, field) { if (typeof value !== 'string' || !value) fail(field); try { new RegExp(value) } catch { fail(field) } }
function price(value) { return Array.isArray(value) && value.length === 3 && value.every(x => Number.isFinite(x) && x >= 0) }

/** 校验配置并补默认字段。@param {unknown} value JSON 对象。@returns {object} 可序列化的配置。 */
export function parseUsageConfig(value = {}) {
  object(value, 'object')
  const defaults = { baselineDays: 14, zThreshold: 3, anomalyMinShare: .05, minRequestsPerDay: 5, missHitBelow: .5, missPromptAbove: 2000, recentDays: 30, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, usdCny: 7, prices: PRICES, peak: { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], hours: [[9, 12], [14, 18]], extraHolidays: [] }, groups: [{ id: 'whale', preset: '^whale' }], wakeGroup: 'whale' }
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) fail(key)
  const c = structuredClone({ ...defaults, ...value })
  for (const key of ['baselineDays', 'minRequestsPerDay', 'recentDays']) if (!Number.isSafeInteger(c[key]) || c[key] < 1) fail(key)
  for (const key of ['zThreshold', 'usdCny']) if (!Number.isFinite(c[key]) || c[key] <= 0) fail(key)
  if (!Number.isFinite(c.missPromptAbove) || c.missPromptAbove < 0) fail('missPromptAbove')
  if (!Number.isFinite(c.missHitBelow) || c.missHitBelow < 0 || c.missHitBelow > 1) fail('missHitBelow')
  if (!Number.isFinite(c.anomalyMinShare) || c.anomalyMinShare < 0 || c.anomalyMinShare > 1) fail('anomalyMinShare')
  zone(c.timeZone)
  object(c.peak, 'peak'); zone(c.peak.timeZone)
  // peak 是整对象替换，老配置没写 extraHolidays 时补空数组，其余三个字段照旧必填。
  if (c.peak.extraHolidays === undefined) c.peak.extraHolidays = []
  if (!Array.isArray(c.peak.extraHolidays) || !c.peak.extraHolidays.every(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x)) fail('peak.extraHolidays')
  if (!Array.isArray(c.peak.weekdays) || !c.peak.weekdays.every(x => Number.isInteger(x) && x >= 0 && x <= 6)) fail('peak.weekdays')
  if (!Array.isArray(c.peak.hours) || !c.peak.hours.every(x => Array.isArray(x) && x.length === 2 && x.every(Number.isInteger) && x[0] >= 0 && x[1] <= 24 && x[0] < x[1])) fail('peak.hours')
  if (!Array.isArray(c.prices)) fail('prices')
  for (const p of c.prices) {
    object(p, 'prices'); pattern(p.pattern, 'prices.pattern')
    if (!['CNY', 'USD'].includes(p.cur) || !price(p.off) || p.peak !== undefined && typeof p.peak !== 'boolean' || p.peak && !price(p.on)) fail('prices')
  }
  if (!Array.isArray(c.groups)) fail('groups')
  const ids = new Set(['all', 'other'])
  for (const g of c.groups) {
    object(g, 'groups')
    if (typeof g.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(g.id) || ids.has(g.id)) fail('groups.id')
    ids.add(g.id); pattern(g.preset, 'groups.preset')
  }
  if (typeof c.wakeGroup !== 'string' || !c.groups.some(g => g.id === c.wakeGroup)) fail('wakeGroup')
  return c
}

/** 读取 usage.json；只有 ENOENT 使用默认值。@param {string} dir 工作台数据目录。@returns {object} 已校验配置。 */
export function readUsageConfig(dir) {
  let text
  try { text = readFileSync(join(dir, 'usage.json'), 'utf8') } catch (e) { if (e.code === 'ENOENT') return parseUsageConfig(); throw e }
  return parseUsageConfig(JSON.parse(text))
}

/** 创建分天、分小时的时区转换器。@param {string} timeZone IANA 时区。@returns {function(number): object} 日历字段。 */
export function calendar(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const cache = new Map()
  return time => {
    const minute = Math.floor(time / 60000)
    if (cache.has(minute)) return cache.get(minute)
    const p = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]))
    const day = `${p.year}-${p.month}-${p.day}`
    const result = { day, month: day.slice(0, 7), hour: Number(p.hour), wd: (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7, hm: `${p.hour}:${p.minute}` }
    cache.set(minute, result)
    return result
  }
}

/** 某个时刻是不是高峰时段的判断。法定节假日（内置表加 extraHolidays）全天闲时。@param {object} config 校验过的配置。@returns {(time: number) => boolean} 毫秒时间 → 是否高峰。 */
function peakRule(config) {
  const at = calendar(config.peak.timeZone), holidays = holidaySet(config.peak.extraHolidays)
  return time => {
    const b = at(time)
    return config.peak.weekdays.includes((b.wd + 1) % 7) && !holidays.has(b.day) && config.peak.hours.some(([from, to]) => b.hour >= from && b.hour < to)
  }
}

/**
 * 现在是不是高峰时段，这个状态什么时候结束。IANA 时区的偏移都是 15 分钟的整数倍，所以每 15 分钟看一次。
 * @param {number} now 毫秒时间。
 * @param {object} config 校验过的配置。
 * @returns {{peak: boolean, until: number | null}} until 是状态变化的毫秒时间，14 天内不变时是 null。
 */
export function peakPeriod(now, config) {
  const isPeak = peakRule(config), peak = isPeak(now), step = 15 * 60000, end = now + 14 * 86400000
  for (let time = (Math.floor(now / step) + 1) * step; time <= end; time += step) {
    if (isPeak(time) !== peak) return { peak, until: time }
  }
  return { peak, until: null }
}

/** 按配置顺序计价，不改摘要。法定节假日（内置表加 extraHolidays）在 peak.timeZone 下全天闲时，调休上班的周六日不被表收进去、照常闲时。@param {object[]} rows 原始请求数值。@param {object} config 已校验配置。@returns {object} 带费用的副本与缺价模型名。 */
export function priceRows(rows, config) {
  const table = config.prices.map(p => ({ ...p, re: new RegExp(p.pattern) }))
  const isPeak = peakRule(config), missing = new Set(), prices = new Map()
  return { rows: rows.map(row => {
    if (!prices.has(row.m)) prices.set(row.m, table.find(p => p.re.test(row.m ?? '')))
    const pr = prices.get(row.m), peak = isPeak(row.t)
    const tab = pr ? pr.peak && peak ? pr.on : pr.off : [0, 0, 0]
    if (!pr && row.m) missing.add(row.m)
    const k = (pr?.cur === 'USD' ? config.usdCny : 1) / 1e6
    const costIn = (row.input + row.wr) * tab[0] * k, costRd = row.rd * tab[1] * k, costOut = row.out * tab[2] * k
    const off = pr?.off ?? [0, 0, 0]
    const shift = pr?.peak && peak ? costIn + costRd + costOut - ((row.input + row.wr) * off[0] + row.rd * off[1] + row.out * off[2]) * k : 0
    return { ...row, peak, costIn, costRd, costOut, c: costIn + costRd + costOut, saved: row.rd * (tab[0] - tab[1]) * k, missX: (row.input + row.wr) * (tab[0] - tab[1]) * k, shift }
  }), priceMissing: [...missing].sort() }
}

/**
 * 用量主页的纯计算：数字格式、监控排序和结论、热力图的网格和分级、额度窗口、余额块。
 * 不碰 React 和 DOM，测试直接 import。文字一律不在这里拼，由 usage.js 经字典取。
 */

const USAGE_DAY_MS = 86400e3
const USAGE_Z_FORMAT = new Intl.NumberFormat('en-US', { signDisplay: 'always', minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** 上下文构成的各部分在接口里的键。 */
export const USAGE_COMP_KEYS = ['tools', 'res', 'reas', 'msg', 'inject', 'sys', 'comp']

/** 接口里 `status[].p` 和额度来源的显示名；没有登记的原样显示。 */
const USAGE_PROVIDER_NAMES = {
  'opencode-go': 'OpenCode Go',
  'deepseek-official': 'DeepSeek',
  google: 'Google Gemini',
  'zai-coding-cn': 'GLM Coding Plan',
}

/**
 * token 数的缩写。
 * @param {number | null | undefined} value token 数。
 * @returns {string} 例如 55.68M、1.3k；没有值时是破折号。
 */
export function usageTokens(value) {
  if (value == null) return '—'
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`
  return String(Math.round(value))
}

/**
 * 人民币金额。
 * @param {number | null | undefined} value 金额。
 * @param {number} [digits] 小数位，默认 2。
 * @returns {string} 例如 ¥15.16；没有值时是破折号。
 */
export function usageMoney(value, digits = 2) {
  return value == null ? '—' : `¥${value.toFixed(digits)}`
}

/**
 * 比例转百分数。
 * @param {number | null | undefined} value 0–1 的比例。
 * @param {number} [digits] 小数位，默认 1。
 * @returns {string} 例如 85.0%；没有值时是破折号。
 */
export function usagePercent(value, digits = 1) {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`
}

/**
 * 带千分位的整数。
 * @param {number} value 数。
 * @returns {string} 例如 1,349。
 */
export function usageCount(value) {
  return Math.round(value).toLocaleString('en-US')
}

/**
 * z 值的显示：带符号，一位小数。
 * @param {number | null | undefined} z z 值。
 * @returns {string} 例如 +5.3、-1.7；没有基线时是破折号。
 */
export function usageZ(z) {
  if (z == null) return '—'
  return USAGE_Z_FORMAT.format(z)
}

/**
 * 日期去掉年份。
 * @param {string} day `YYYY-MM-DD`。
 * @returns {string} `MM-DD`。
 */
export function usageMonthDay(day) {
  return day.slice(5)
}

/**
 * p 值的显示，照统计惯例省掉小数点前的 0。
 * @param {number | null | undefined} p p 值。
 * @returns {string} 例如 p < .001、p = .053；没有值时是空串。
 */
export function usagePValue(p) {
  if (p == null) return ''
  if (p < 0.001) return 'p < .001'
  return `p = ${p.toFixed(p < 0.1 ? 3 : 2).replace(/^0/, '')}`
}

/**
 * 毫秒时间在本机时区的月日。
 * @param {number} at 毫秒时间。
 * @returns {string} `MM-DD`。
 */
export function usageLocalMonthDay(at) {
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 提供方的显示名。
 * @param {string} id 接口里的提供方 id。
 * @param {string} [fallback] id 缺失时使用的本地化名称；自定义 id 原样保留。
 * @returns {string} 显示名。
 */
export function usageProviderName(id, fallback) {
  return USAGE_PROVIDER_NAMES[id] ?? (id || fallback)
}

/**
 * 监控行的顺序：偏离基线最大的在最上面，没有基线的排最后；z 相同时保持接口给的顺序。
 * @param {Array<{z: number | null}>} vitals 接口的 `vitals`。
 * @returns {Array<{z: number | null}>} 排好序的新数组。
 */
export function usageVitalOrder(vitals) {
  return [...vitals].sort((a, b) => Math.abs(b.z ?? -1) - Math.abs(a.z ?? -1))
}

/**
 * 监控行的亮度档：偏离越大越亮。|z| ≥ 2 为 `strong`，1 ≤ |z| < 2 为 `mid`，|z| < 1 为 `low`，没有基线为 `none`。
 * @param {number | null | undefined} z 监控行的 z 值。
 * @returns {'strong' | 'mid' | 'low' | 'none'} 亮度档。
 */
export function usageVitalTone(z) {
  if (z == null) return 'none'
  const size = Math.abs(z)
  return size >= 2 ? 'strong' : size >= 1 ? 'mid' : 'low'
}

/**
 * 顶栏的结论。`anomaly` 由宿主按 |z| ≥ 3 算好，这里只数。
 * @param {Array<{key: string, anomaly: boolean}>} vitals 接口的 `vitals`。
 * @returns {{bad: number, ok: number, serious: boolean}} 异常数、正常数，以及重试是否异常（用橙色）。
 */
export function usageVerdict(vitals) {
  const bad = vitals.filter(vital => vital.anomaly)
  return { bad: bad.length, ok: vitals.length - bad.length, serious: bad.some(vital => vital.key === 'retry') }
}

/**
 * 线性插值的分位数。
 * @param {number[]} values 数值，可以无序，至少一个。
 * @param {number} p 0–1。
 * @returns {number} 分位数。
 */
export function usageQuantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * p
  const low = Math.floor(at)
  const high = Math.ceil(at)
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

/**
 * 一天落在第几级。
 * @param {number | undefined} value 当天的值。
 * @param {number[]} cuts `usageHeatCuts` 给的分级线。
 * @returns {number} 0–4；没有用量时是 -1。
 */
export function usageHeatLevel(value, cuts) {
  if (value === undefined || value <= 0) return -1
  return cuts.filter(cut => value > cut).length
}

/**
 * 请求间隔分桶的标签要素，文字由字典拼。
 * @param {{fromSeconds: number, toSeconds: number | null}} gap 接口的一个分桶。
 * @returns {{kind: 'under' | 'over' | 'range', a: number, b?: number, unit: 'minute' | 'hour'}} 例如 1–5 分钟是 range、1、5、minute。
 */
export function usageGapLabel({ fromSeconds, toSeconds }) {
  const hours = (fromSeconds >= 3600) || (fromSeconds === 0 && toSeconds >= 3600)
  const unit = hours ? 'hour' : 'minute'
  const scale = hours ? 3600 : 60
  if (fromSeconds === 0) return { kind: 'under', a: toSeconds / scale, unit }
  if (toSeconds === null) return { kind: 'over', a: fromSeconds / scale, unit }
  return { kind: 'range', a: fromSeconds / scale, b: toSeconds / scale, unit }
}

/**
 * 从命中率分桶推缓存有效期：命中率中位数还过半的最后一个分桶的上界。
 * @param {Array<{toSeconds: number | null, p50: number | null}>} gaps 接口的 `gaps`，按间隔从短到长。
 * @returns {number | null} 分钟数；没有这样的分桶，或者最长的分桶也命中时是 null。
 */
export function usageCacheLifeMinutes(gaps) {
  let last = null
  for (const gap of gaps) if (gap.p50 != null && gap.p50 > 50) last = gap
  return last === null || last.toSeconds === null ? null : Math.round(last.toSeconds / 60)
}

/**
 * 额度重置时间，按本机时区：今天只写时分，别的日子带月日。
 * @param {string | undefined} iso ISO 8601 时间。
 * @param {number} [now] 现在的毫秒数。
 * @returns {string} 例如 19:46、11-08 02:00；没有或解析不了时是空串。
 */
export function usageResetTime(iso, now = Date.now()) {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const today = new Date(now)
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return sameDay ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
}

/**
 * 上下文构成，从大到小。
 * @param {Record<string, number> | undefined} comp 接口的 `compT` 或会话的 `comp`。
 * @returns {Array<{key: string, v: number}>} 各部分。
 */
export function usageCompParts(comp) {
  return USAGE_COMP_KEYS
    .map(key => ({ key, v: comp?.[key] ?? 0 }))
    .sort((a, b) => b.v - a.v)
}

/**
 * RATE_LIMIT 是不是全部有上游的具体原因：失败次数和 `why` 的合计对得上才算。
 * @param {{codes: Record<string, number>, why?: Record<string, number>}} status 接口的一个提供方。
 * @returns {boolean} 是否全部来自上游。
 */
export function usageRateLimitUpstream({ codes, why }) {
  const limited = codes.RATE_LIMIT ?? 0
  if (limited === 0 || why === undefined) return false
  return Object.values(why).reduce((sum, n) => sum + n, 0) === limited
}

/**
 * `{key: 次数}` 按次数从多到少排成一行的要素。
 * @param {Record<string, number> | undefined} counts 次数表。
 * @returns {string} 例如 overloaded 15 · TIMEOUT 2。
 */
export function usageCountList(counts) {
  return Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${n}`)
    .join(' · ')
}

/**
 * 费用构成里按分组列的行。只列有会话的分组；有会话的不到两组时一行也不列，因为那一行就是上面的合计。
 * @param {Array<{id: string, c: number, req: number, s: number}>} groups 接口总览的 `groups`，`s` 是会话数。
 * @returns {Array<{id: string, c: number, req: number, s: number}>} 要列的分组，顺序不变。
 */
export function usageSpendGroups(groups) {
  const used = groups.filter(group => group.s > 0)
  return used.length > 1 ? used : []
}

/**
 * 监控下面那句「最大来源」。心跳唤醒是「距上次请求超过 1 小时」里的一部分，所以它和其余原因比，
 * 不和包含它的那一项比；比其余原因都大时说心跳唤醒，否则说最大的那个原因。
 * @param {{missX: number, T: {c: number}, missBy: Array<{why: string, x: number}>, wakeInfo: {n: number, extra: number}}} data 接口的总览。
 * @returns {{kind: 'wake', top: number} | {kind: 'reason', reason: string, top: number} | null} 没有额外费用时是 null。
 */
export function usageMissLever({ missX, T, missBy, wakeInfo }) {
  if (!(missX > 0) || !(T.c > 0) || missBy.length === 0) return null
  const others = missBy.filter(row => row.why !== 'gap-over-1h')
  const largestOther = Math.max(0, ...others.map(row => row.x))
  if (wakeInfo.n > 0 && wakeInfo.extra >= largestOther) return { kind: 'wake', top: wakeInfo.extra }
  return { kind: 'reason', reason: missBy[0].why, top: missBy[0].x }
}

/**
 * 左栏「余额与额度」用的数据：DeepSeek 余额（人民币在前，余额为 0 的币种不列，全是 0 时留第一种）、余额减少和本机估算的差额（两边都是 0 时不列；余额接口比本机估算慢时「其他地方」取 0）、各家的额度窗口、查询出问题的提供方。
 * @param {{queriedAt?: number, providers?: Array<{id: string, name: string, state: string, stale?: boolean, queriedAt?: number, balances?: Array<{currency: string, total: string}>, plan?: string, windows?: Array<{key: string, percent?: number, resetsAt?: string}>}>, spend?: {cny: number, since: number} | null}} quota 宿主 quota.overview 的响应。
 * @param {{c: number} | null} local 余额开始观察以来本机会话的估算费用。
 * @returns {{balances: Array<{currency: string, total: string}>, gap: {since: number, spend: number, local: number, other: number} | null, plans: Array<{id: string, name: string, windows: Array<object>}>, problems: Array<{id: string, name: string, state: string, stale: boolean, queriedAt?: number}>, queriedAt?: number} | null} 什么都没有时是 null，比如一家的密钥都没配。
 */
export function usageBalanceBlock(quota, local) {
  const providers = quota.providers ?? []
  const official = providers.find(provider => provider.id === 'deepseek-official')
  const sorted = [...(official?.balances ?? [])].sort((a, b) => Number(b.currency === 'CNY') - Number(a.currency === 'CNY'))
  const nonzero = sorted.filter(balance => Number(balance.total) !== 0)
  const balances = nonzero.length > 0 ? nonzero : sorted.slice(0, 1)
  const spend = quota.spend
  const gap = spend == null || local === null || (spend.cny === 0 && local.c === 0)
    ? null
    : { since: spend.since, spend: spend.cny, local: local.c, other: Math.max(0, spend.cny - local.c) }
  const plans = providers
    .filter(provider => (provider.windows?.length ?? 0) > 0)
    .map(provider => ({
      id: provider.id,
      name: [provider.name, provider.plan].filter(Boolean).join(' '),
      windows: provider.windows,
    }))
  const problems = providers
    .filter(provider => provider.state !== 'ok')
    .map(provider => ({ id: provider.id, name: provider.name, state: provider.state, stale: provider.stale === true, queriedAt: provider.queriedAt }))
  if (balances.length === 0 && gap === null && plans.length === 0 && problems.length === 0) return null
  return { balances, gap, plans, problems, queriedAt: quota.queriedAt }
}

/**
 * 余额的显示：人民币用符号，别的币种写代码。
 * @param {{currency: string, total: string}} balance 余额。
 * @returns {string} 例如 ¥120.50、USD 380.27。
 */
export function usageBalanceText({ currency, total }) {
  const value = Number(total)
  const amount = Number.isFinite(value) ? value.toFixed(2) : total
  return currency === 'CNY' ? `¥${amount}` : `${currency} ${amount}`
}

/**
 * 毫秒时间在本机时区的时分。
 * @param {number | undefined} at 毫秒时间。
 * @returns {string} `HH:mm`；没有值时是空串。
 */
export function usageLocalTime(at) {
  if (at === undefined) return ''
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 侧边栏卡片两次自动读取之间的最短间隔。 */
export const USAGE_CARD_MIN_GAP_MS = 60_000

/**
 * 侧边栏卡片现在要不要读一次。卡片没有定时器，只在事件发生时问这个函数：挂载、窗口回到前台、有会话结束、展开。
 * 窗口不在前台时不读，事情记下来，等回到前台再读。
 * @param {{readAt: number | null, dirty: boolean, focused: boolean, now: number}} state 上次读到的时间、之后有没有会话结束、窗口在不在前台、现在。
 * @returns {boolean} 要不要读。
 */
export function usageCardShouldRead({ readAt, dirty, focused, now }) {
  if (readAt === null) return true
  if (!focused) return false
  if (usageLocalMonthDay(readAt) !== usageLocalMonthDay(now)) return true
  return dirty && now - readAt >= USAGE_CARD_MIN_GAP_MS
}

/**
 * 两次会话状态之间有没有会话结束。
 * @param {Map<string, {running?: boolean}>} before 之前的状态。
 * @param {Map<string, {running?: boolean}>} after 现在的状态。
 * @returns {boolean} 有会话从运行中变成不在运行时是 true。
 */
export function usageSessionFinished(before, after) {
  for (const [id, status] of after) {
    if (before.get(id)?.running === true && status?.running === false) return true
  }
  return false
}

/**
 * 侧边栏卡片的今日数字。
 * @param {{vitals: Array<{key: string, x?: number | null, anomaly?: boolean}>}} overview 宿主的概览。
 * @returns {{tokens: number, requests: number, cost: number, bad: number, serious: boolean}} 今天的 token、模型请求、估算费用，以及偏离基线的项数。
 */
export function usageCardToday(overview) {
  const value = key => overview.vitals.find(vital => vital.key === key)?.x ?? 0
  const verdict = usageVerdict(overview.vitals)
  return { tokens: value('token'), requests: value('req'), cost: value('c'), bad: verdict.bad, serious: verdict.serious }
}

/**
 * 卡片上一家额度一行，只写用得最多的那个窗口。
 * @param {Array<{id: string, name: string, windows: Array<{key: string, percent?: number}>}>} plans usageBalanceBlock 的 plans。
 * @returns {Array<{id: string, name: string, key: string, percent: number}>} 每家一行。
 */
export function usageCardPlans(plans) {
  return plans.map(plan => {
    const top = plan.windows.reduce((best, item) => ((item.percent ?? 0) > (best.percent ?? 0) ? item : best))
    return { id: plan.id, name: plan.name, key: top.key, percent: top.percent ?? 0 }
  })
}

/**
 * 本机时区今天零点。
 * @param {number} now 毫秒时间。
 * @returns {number} 零点的毫秒时间。
 */
export function usageLocalMidnight(now) {
  const at = new Date(now)
  at.setHours(0, 0, 0, 0)
  return at.getTime()
}

/**
 * 按 Esc 时卡片做什么。对话框和菜单优先；焦点在输入框里时 Esc 归输入框，除非鼠标正停在卡片上。
 * @param {{open: boolean, pageActive: boolean, hovering: boolean, typing: boolean, blocked: boolean}} state 卡片展开没有、用量主页开着没有、鼠标在不在卡片上、焦点在不在输入框里、有没有对话框或菜单。
 * @returns {'collapse' | 'close-page' | null} 收起卡片、回到会话，或者不管。
 */
export function usageCardEscapeAction({ open, pageActive, hovering, typing, blocked }) {
  if (blocked) return null
  if (typing && !hovering) return null
  if (open) return 'collapse'
  return pageActive ? 'close-page' : null
}


/** 用量统计的纯数值函数；缺少样本的统计量返回 null。 */

/** 插值分位数。@param {number[]} values 样本。@param {number} p 分位点。@returns {number|null} 分位数。 */
export function quantile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const i = (sorted.length - 1) * p
  return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i - Math.floor(i))
}

/** 正态一致性缩放的 MAD。@param {number[]} values 样本。@returns {number|null} 离散程度。 */
export function mad(values) {
  if (!values.length) return null
  const median = quantile(values, .5)
  return quantile(values.map(x => Math.abs(x - median)), .5) * 1.4826
}

/** 鲁棒标准分。@param {number|null} value 观测值。@param {number[]} baseline 基线。@returns {number|null} MAD 为零且偏离时返回 null。 */
export function robustZ(value, baseline) {
  if (value == null || !baseline.length) return null
  const m = quantile(baseline, .5), s = mad(baseline)
  return s > 0 ? (value - m) / s : value === m ? 0 : null
}

/** 含并列和连续性修正的双尾 Mann–Whitney 正态近似。@param {number[]} a 第一组。@param {number[]} b 第二组。@returns {object|null} p 值与样本量，每组至少八个。 */
export function mannWhitney(a, b) {
  if (a.length < 8 || b.length < 8) return null
  const all = [...a.map(v => [v, 0]), ...b.map(v => [v, 1])].sort((x, y) => x[0] - y[0])
  let ranks = 0, tie = 0
  for (let i = 0; i < all.length;) {
    let j = i
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++
    for (let k = i; k <= j; k++) if (all[k][1] === 0) ranks += (i + j) / 2 + 1
    tie += (j - i + 1) ** 3 - (j - i + 1)
    i = j + 1
  }
  const n1 = a.length, n2 = b.length, n = n1 + n2
  const u = ranks - n1 * (n1 + 1) / 2, mean = n1 * n2 / 2
  const variance = n1 * n2 / 12 * (n + 1 - tie / (n * (n - 1)))
  const delta = Math.max(0, Math.abs(u - mean) - .5)
  if (variance <= 0 || delta === 0) return { p: 1, n1, n2 }
  const x = delta / Math.sqrt(variance * 2), t = 1 / (1 + .5 * x)
  const p = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (.37409196 + t * (.09678418 + t * (-.18628806 + t * (.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-.82215223 + t * .17087277)))))))))
  return { p: Math.min(1, Math.max(0, p)), n1, n2 }
}

/** 非负样本的基尼系数。@param {number[]} values 样本。@returns {number} 空集或总量零为零。 */
export function gini(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const total = sorted.reduce((a, x) => a + x, 0)
  return total ? sorted.reduce((a, x, i) => a + (2 * (i + 1) - sorted.length - 1) * x, 0) / (sorted.length * total) : 0
}

/** 日历日期加天数，不受夏令时影响。@param {string} day YYYY-MM-DD。@param {number} offset 天数。@returns {string} 日期。 */
export function shiftDay(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400e3).toISOString().slice(0, 10)
}

/** 按近期日费用预测当月，区间沿用样稿的 1.35 系数。@param {object[]} daily 含零费用日的日序列。@param {string} today 当前日历日期。@param {number} baselineDays 基线天数。@returns {object} 已花费、剩余天数、预测和区间。 */
export function forecastMonth(daily, today, baselineDays) {
  const month = today.slice(0, 7)
  const [year, m, day] = today.split('-').map(Number)
  const rem = new Date(Date.UTC(year, m, 0)).getUTCDate() - day
  const observed = daily.filter(d => d.day <= today)
  const sample = observed.filter(d => d.day >= shiftDay(today, 1 - baselineDays)).map(d => d.c)
  const spent = observed.filter(d => d.day.startsWith(month)).reduce((a, d) => a + d.c, 0)
  const mean = sample.length ? sample.reduce((a, x) => a + x, 0) / sample.length : 0
  const sd = sample.length > 1 ? Math.sqrt(sample.reduce((a, x) => a + (x - mean) ** 2, 0) / (sample.length - 1)) : 0
  const est = spent + mean * rem
  const spread = sample.length ? 1.35 * sd * Math.sqrt(rem + rem * rem / sample.length) : 0
  return { spent, rem, mean, sd, est, lo: Math.max(spent, est - spread), hi: est + spread }
}

/** 活跃日期的当前和最长连续天数。@param {string[]} days 活跃日期。@param {string} today 当前日。@returns {object} 连续天数。 */
export function streaks(days, today) {
  const sorted = [...new Set(days)].filter(d => d <= today).sort(), set = new Set(sorted)
  let longest = 0, run = 0, prev = null, streak = 0
  for (const day of sorted) { run = prev && shiftDay(prev, 1) === day ? run + 1 : 1; longest = Math.max(longest, run); prev = day }
  for (let day = set.has(today) ? today : shiftDay(today, -1); set.has(day); day = shiftDay(day, -1)) streak++
  return { streak, longest }
}

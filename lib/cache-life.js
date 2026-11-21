/**
 * 这条路由的缓存大概能活多久：用量页摘要里每个请求的 gap 和 hit，按隔了多久分段，算每段的命中数。
 * 提供方基本不写这个数，所以页面用这台电脑自己的日志回答。纯函数。
 */

const BINS = [[0, 5], [5, 15], [15, 25], [25, 35], [35, 45], [45, 60], [60, 90], [90, 120], [120, null]]
/** 这些请求的前缀变过，没命中不是因为过期。 */
const PREFIX_CHANGED = new Set(['first', 'system', 'header'])
const MINUTE = 60_000

/**
 * 算一条路由的缓存寿命。
 * @param {object[]} rows 用量摘要的请求行（kind、p、prompt、gap、hit、reason）。
 * @param {string} provider 路由的提供方。
 * @param {{minPrompt?: number, hitAt?: number, warmRate?: number, warmSamples?: number, goneRate?: number, goneSamples?: number, knownFrom?: number}} [options] 判断的门槛。
 * @returns {{n: number, bins: {from: number, to: number|null, hit: number, n: number}[], known: boolean, warmUntil: number|null, warmAtLeast: number|null, goneAfter: number|null}} 分段和结论；样本不够时 known 是 false。
 */
export function cacheLife(rows, provider, { minPrompt = 2000, hitAt = 0.5, warmRate = 0.8, warmSamples = 3, goneRate = 0.2, goneSamples = 5, knownFrom = 15 } = {}) {
  const counts = BINS.map(([from, to]) => ({ from, to, hit: 0, n: 0 }))
  for (const row of rows) {
    if (row.kind !== 'main' || row.p !== provider || !(row.prompt >= minPrompt) || row.gap == null || row.hit == null || PREFIX_CHANGED.has(row.reason)) continue
    const minutes = row.gap / MINUTE
    const bin = counts.find(({ from, to }) => minutes >= from && (to === null || minutes < to))
    if (!bin) continue
    bin.n += 1
    if (row.hit >= hitAt) bin.hit += 1
  }
  const n = counts.reduce((sum, bin) => sum + bin.n, 0)
  const bins = counts.filter(bin => bin.n > 0)
  let warmEnd = -1
  while (warmEnd + 1 < counts.length && counts[warmEnd + 1].n >= warmSamples && counts[warmEnd + 1].hit / counts[warmEnd + 1].n >= warmRate) warmEnd += 1
  const last = counts[warmEnd]
  const edge = last === undefined ? null : last.to ?? last.from
  const known = edge !== null && edge >= knownFrom
  if (!known) return { n, bins, known: false, warmUntil: null, warmAtLeast: null, goneAfter: null }
  const next = counts[warmEnd + 1]
  const broken = next !== undefined && next.n >= warmSamples
  const gone = counts.slice(warmEnd + 1).find(bin => bin.n >= goneSamples && bin.hit / bin.n < goneRate)
  return { n, bins, known: true, warmUntil: broken ? edge : null, warmAtLeast: edge, goneAfter: gone?.from ?? null }
}

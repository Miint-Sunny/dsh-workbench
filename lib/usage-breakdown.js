/** 用量标签页的完整明细；窗口过滤与基线均使用统计时区，不保存额外日志。 */
import { calendar } from './usage-config.js'
import { quantile, robustZ, mad, shiftDay } from './usage-stats.js'
const sum = (a, f) => a.reduce((n, x) => n + f(x), 0)
const tokens = r => r.input + r.rd + r.wr + r.out
const distribution = a => ({ n: a.length, p50: quantile(a, .5), p90: quantile(a, .9), p99: quantile(a, .99) })
function grouped(values, key) {
  const map = new Map()
  for (const value of values) { const id = key(value); if (!map.has(id)) map.set(id, []); map.get(id).push(value) }
  return map
}
function baseline(rows, today, hour, config, value) {
  const first = rows.map(r => r.day).sort()[0]
  const days = Array.from({ length: config.baselineDays }, (_, i) => shiftDay(today, -i - 1)).filter(d => first && d >= first)
  const daily = grouped(rows.filter(r => r.hour <= hour), r => r.day)
  const history = days.map(d => sum(daily.get(d) ?? [], value))
  const current = sum(daily.get(today) ?? [], value), median = quantile(history, .5), z = robustZ(current, history)
  return { todayTokens: current, median, baselineN: history.length, z, anomaly: median !== null && (z === null ? mad(history) === 0 && current > median : Math.abs(z) >= config.zThreshold) }
}
function requestSummary(rows, retryLog, ends) {
  const main = rows.filter(r => r.kind === 'main'), prompt = sum(main, r => r.prompt)
  const codes = Object.create(null)
  for (const r of retryLog) { const key = r.why ?? r.code; if (key) codes[key] = (codes[key] ?? 0) + 1 }
  return { req: main.length, attempts: rows.filter(r => r.kind === 'attempt').length, compactions: rows.filter(r => r.kind === 'compaction').length, tokens: sum(rows, tokens), c: sum(rows, r => r.c), hit: prompt ? sum(main, r => r.rd) / prompt : null, ttft: distribution(main.filter(r => r.ttft > 0).map(r => r.ttft / 1000)), tps: distribution(main.filter(r => r.dec > 200 && r.out > 20).map(r => r.out / (r.dec / 1000))), context: distribution(main.map(r => r.prompt)), output: distribution(main.map(r => r.out)), retries: retryLog.length, errors: ends.filter(e => e.kind === 'error').length, aborted: ends.filter(e => e.kind === 'aborted').length, reasons: codes }
}

/** 生成四个维度，包含完整条目和样本量。@param {object} input 已按范围选择、计价并添加日历字段的请求及摘要。@returns {object} 会话、模型、工具、提供方明细。 */
export function usageBreakdown({ rows, tools, sessions, retryLog, turnEnds, today, hour, config }) {
  const since = shiftDay(today, 1 - config.recentDays), inside = r => r.day >= since && r.day <= today
  const at = calendar(config.timeZone), sessionMap = new Map(sessions.map(s => [s.s, s]))
  function requests(key, withRetry) {
    const groups = grouped(rows, key)
    if (withRetry) for (const r of [...retryLog, ...turnEnds]) if (!groups.has(key(r))) groups.set(key(r), [])
    return [...groups].flatMap(([name, all]) => {
      const recent = all.filter(inside), retries = withRetry ? retryLog.filter(r => key(r) === name && inside(r)) : [], ends = withRetry ? turnEnds.filter(r => key(r) === name && inside(r)) : []
      if (!recent.length && !retries.length && !ends.length) return []
      return [{ name, ...requestSummary(recent, retries, ends), ...(!withRetry ? { retries: null, errors: null, aborted: null, reasons: null } : {}), ...baseline(all, today, hour, config, tokens), providers: [...new Set(recent.map(r => r.p))].filter(Boolean) }]
    })
  }
  const sessionRows = requests(r => r.s, true).map(r => {
    const s = sessionMap.get(r.name)
    return { ...r, id: r.name, name: s?.deleted ? null : s?.title ?? null, ws: s?.ws ?? '', preset: s?.preset ?? null, deleted: !!s?.deleted }
  })
  const toolGroups = grouped(tools.map(t => ({ ...t, ...at(t.t) })), t => t.name)
  const toolRows = [...toolGroups].flatMap(([name, all]) => {
    const recent = all.filter(inside)
    if (!recent.length) return []
    return [{ name, calls: recent.length, errors: recent.filter(t => t.err).length, errorRate: recent.filter(t => t.err).length / recent.length, tokens: sum(recent, t => t.tok), duration: distribution(recent.map(t => t.ms / 1000)), result: distribution(recent.map(t => t.tok)), ...baseline(all, today, hour, config, t => t.tok) }]
  })
  return applyAnomalyMinShare({ sessions: sessionRows, models: requests(r => r.m, false), tools: toolRows, providers: requests(r => r.p, true) }, config.anomalyMinShare)
}


/**
 * 按各维度今日量占比筛掉小额异常，保留全部条目与统计值，并将剩余异常排在前面。
 * @param {object} dimensions 已算出 todayTokens 和 anomaly 的四维明细。
 * @param {number} minShare 同维度今日总量中的最小占比；0 不限制占比。
 * @returns {object} 不修改输入的明细副本。
 */
export function applyAnomalyMinShare(dimensions, minShare) {
  return Object.fromEntries(Object.entries(dimensions).map(([dimension, rows]) => {
    const total = sum(rows, row => row.todayTokens)
    const filtered = rows.map(row => ({ ...row, anomaly: row.anomaly && (total > 0 ? row.todayTokens / total : 0) >= minShare }))
    filtered.sort((a, b) => Number(b.anomaly) - Number(a.anomaly) || (dimension === 'tools' ? 0 : b.c - a.c) || b.tokens - a.tokens)
    return [dimension, filtered]
  }))
}

/** 用量主页响应；算法来自 research/raw/M 的样稿脚本，费用按当前配置计算。 */
import { calendar, peakPeriod, priceRows } from './usage-config.js'
import { usageBreakdown } from './usage-breakdown.js'
import { HOLIDAY_TABLE_LAST_YEAR } from './usage-holidays.js'
import { quantile as q, mad, robustZ, mannWhitney, gini, forecastMonth, streaks, shiftDay } from './usage-stats.js'

const sum = (a, f) => a.reduce((x, y) => x + f(y), 0)
const tok = r => r.input + r.rd + r.wr + r.out
/** 按键分组的 token 占比，从大到小。@param {object[]} rs 记录。@param {(row: object) => string | null} key 分组键。@returns {Array<{n: string | null, v: number, p: number}>} 名称、token、占这些记录合计的比例。 */
function shares(rs, key) {
  const values = new Map(), total = sum(rs, tok)
  for (const r of rs) { const k = key(r); values.set(k, (values.get(k) ?? 0) + tok(r)) }
  return [...values].map(([n, v]) => ({ n, v, p: total ? v / total : 0 })).sort((a, b) => b.v - a.v)
}
const blankParts = () => ({ sys: 0, tools: 0, inject: 0, msg: 0, reas: 0, res: 0, comp: 0 })
const newDay = () => ({ tokens: 0, c: 0, n: 0, rd: 0, p: 0, ttft: [], tps: [], prompt: [], retries: 0 })
const pct = a => ({ n: a.length, p50: q(a, .5), p90: q(a, .9), p99: q(a, .99), max: q(a, 1) })
const tpsOf = rows => rows.filter(r => r.dec > 200 && r.out > 20).map(r => r.out / (r.dec / 1000))
const ttftOf = rows => rows.filter(r => r.ttft > 0).map(r => r.ttft / 1000)
function counts(values, key) {
  const result = Object.create(null)
  for (const item of values) { const k = key(item); if (k != null) result[k] = (result[k] ?? 0) + 1 }
  return result
}
function assignGroups(digests, config) {
  const groups = config.groups.map(g => ({ ...g, re: new RegExp(g.preset) }))
  return new Map(digests.map(d => [d.session.s, groups.find(g => g.re.test(d.session.preset ?? ''))?.id ?? 'other']))
}
function turnsOf(rows) {
  const turns = new Map()
  for (const r of rows) {
    if (r.turn == null) continue // 压缩不属于某一轮
    const key = `${r.s}/${r.turn}`
    if (!turns.has(key)) turns.set(key, { c: 0, steps: 0, ttft: [], prompt: [], tps: [], day: r.day })
    const v = turns.get(key); v.c += r.c
    if (r.kind === 'main') {
      v.steps++; v.prompt.push(r.prompt)
      if (r.ttft > 0) v.ttft.push(r.ttft / 1000)
      if (r.dec > 200 && r.out > 20) v.tps.push(r.out / (r.dec / 1000))
    }
  }
  return [...turns.values()]
}
function addParts(target, r) {
  if (!r.comp) return
  const total = sum(Object.values(r.comp), x => x)
  if (total) for (const key in target) target[key] += r.comp[key] / total * r.prompt
}

/** 余额对账使用全部保留摘要。@param {object[]} digests 摘要。@param {object} config 价目。@param {object} options providers 与 since（毫秒）。@returns {{c:number,n:number}} 费用和请求行数。 */
export function buildCost(digests, config, { providers, since }) {
  const rows = digests.flatMap(d => d.rows).filter(r => r.t >= since && providers.includes(r.p))
  const priced = priceRows(rows, config).rows
  return { c: sum(priced, r => r.c), n: priced.length }
}

/**
 * 生成概览；分组按配置顺序首次命中。已删除会话仍参与累计和窗口统计。
 * @param {object[]} digests 会话摘要。
 * @param {object} config 已校验配置。
 * @param {{now?:number,group?:string}} options 固定观察时间与范围。
 * @returns {object} 样稿字段、分组可用性、缺价模型与异常标记；`holidayTableLastYear` 是内置假日表覆盖到的末年；无界面文字。
 */
export function buildOverview(digests, config, { now = Date.now(), group = 'all' } = {}) {
  const groupOf = assignGroups(digests, config)
  const groupsAvailable = ['all', ...config.groups.map(g => g.id), 'other'].map(id => ({ id, sessions: id === 'all' ? digests.length : digests.filter(d => groupOf.get(d.session.s) === id).length }))
  const selected = digests.filter(d => group === 'all' || groupOf.get(d.session.s) === group)
  const at = calendar(config.timeZone), clock = at(now), today = clock.day
  const sessions = selected.map(d => ({ ...d.session, deleted: d.deleted })), sMap = new Map(sessions.map(s => [s.s, s]))
  const priced = priceRows(selected.flatMap(d => d.rows), config)
  const rows = priced.rows.map(r => ({ ...r, ...at(r.t) })).sort((a, b) => a.t - b.t || a.s.localeCompare(b.s))
  const tools = selected.flatMap(d => d.tools), retryLog = selected.flatMap(d => d.retryLog).map(r => ({ ...r, ...at(r.t) })).sort((a, b) => a.t - b.t)
  const turnEnds = selected.flatMap(d => d.turnEnds).map(r => ({ ...r, ...at(r.t) }))
  const main = rows.filter(r => r.kind === 'main'), days = new Map()
  for (const r of rows) {
    if (!days.has(r.day)) days.set(r.day, newDay())
    const d = days.get(r.day); d.tokens += tok(r); d.c += r.c
    if (r.kind === 'main') {
      d.n++; d.rd += r.rd; d.p += r.prompt; d.prompt.push(r.prompt)
      if (r.ttft > 0) d.ttft.push(r.ttft / 1000)
      if (r.dec > 200 && r.out > 20) d.tps.push(r.out / (r.dec / 1000))
    }
  }
  for (const r of retryLog) { if (!days.has(r.day)) days.set(r.day, newDay()); days.get(r.day).retries++ }
  const active = [...days.keys()].filter(day => days.get(day).tokens > 0).sort()
  const peakDay = active.reduce((best, day) => best === null || days.get(day).tokens > days.get(best).tokens ? day : best, null)
  const busy = new Map()
  for (const r of rows) { const key = `${r.wd}/${r.hour}`; busy.set(key, (busy.get(key) ?? 0) + tok(r)) }
  const busiest = [...busy].sort((a, b) => b[1] - a[1])[0]?.[0]?.split('/').map(Number)
  const life = { tokens: sum(rows, tok), c: sum(rows, r => r.c), input: sum(rows, r => r.input), rd: sum(rows, r => r.rd), out: sum(rows, r => r.out), req: main.length, turns: new Set(rows.filter(r => r.turn != null).map(r => `${r.s}/${r.turn}`)).size, sessions: new Set(rows.map(r => r.s)).size, tools: tools.length, comp: rows.filter(r => r.kind === 'compaction').length, retries: retryLog.length, first: rows[0]?.day ?? null, activeDays: active.length, ...streaks(active, today), peakDay, medianActive: q(active.map(d => days.get(d).tokens), .5), peakTokens: peakDay ? days.get(peakDay).tokens : 0, busyWd: busiest?.[0] ?? null, busyHour: busiest?.[1] ?? null }
  const ranges = rangeSummaries({ workspaceOf: r => sMap.get(r.s)?.ws ?? null, rows, tools: tools.map(t => ({ ...t, ...at(t.t) })), retryLog, active, today, hour: clock.hour })
  const year = Object.fromEntries(active.map(d => [d, { tokens: days.get(d).tokens, c: days.get(d).c, n: days.get(d).n }]))
  // 用量页的图用：一年内每小时的用量，只放有用量的小时。口径和 year 相同，tokens 含全部记录，n 只数 main。
  const hoursSince = shiftDay(today, -365), recentHours = {}
  for (const r of rows) {
    if (r.day < hoursSince || r.day > today) continue
    const dayHours = recentHours[r.day] ??= {}, h = dayHours[r.hour] ??= { tokens: 0, c: 0, n: 0 }
    h.tokens += tok(r); h.c += r.c
    if (r.kind === 'main') h.n++
  }
  for (const dayHours of Object.values(recentHours)) for (const h of Object.values(dayHours)) h.c = Math.round(h.c * 1e6) / 1e6
  const models = shares(rows, r => r.m), workspaces = shares(rows, r => sMap.get(r.s)?.ws ?? null)
  const first = [...days.keys()].sort()[0]
  const baseline = Array.from({ length: config.baselineDays }, (_, i) => shiftDay(today, -i - 1)).filter(d => first && d >= first)
  function hoursOf(day, value = tok) {
    const hours = Array(24).fill(0)
    for (const r of rows) if (r.day === day) hours[r.hour] += value(r)
    for (let i = 1; i < 24; i++) hours[i] += hours[i - 1]
    return hours
  }
  const curves = baseline.map(d => hoursOf(d)), todayCurve = hoursOf(today).slice(0, clock.hour + 1)
  const TDay = days.get(today) ?? newDay()
  const rateBase = fn => baseline.map(d => days.get(d)?.n >= config.minRequestsPerDay ? fn(days.get(d)) : null).filter(v => v != null)
  function vital(key, x, base, count = false) {
    const m = q(base, .5), s = mad(base), z = robustZ(x, base)
    return { key, x, m, s, z, n: base.length, anomaly: x != null && m != null && (z == null ? count && s === 0 && x > m : Math.abs(z) >= config.zThreshold) }
  }
  const cum = (day, fn) => sum(rows.filter(r => r.day === day && r.hour <= clock.hour), fn)
  const vitals = [
    vital('token', todayCurve[clock.hour], curves.map(c => c[clock.hour]), true),
    vital('c', cum(today, r => r.c), baseline.map(d => cum(d, r => r.c)), true),
    vital('req', cum(today, r => Number(r.kind === 'main')), baseline.map(d => cum(d, r => Number(r.kind === 'main'))), true),
    vital('hit', TDay.p ? TDay.rd / TDay.p * 100 : null, rateBase(d => d.p ? d.rd / d.p * 100 : null)),
    vital('ttft', q(TDay.ttft, .5), rateBase(d => q(d.ttft, .5))),
    vital('tps', q(TDay.tps, .5), rateBase(d => q(d.tps, .5))),
    vital('ctx', q(TDay.prompt, .5), rateBase(d => q(d.prompt, .5))),
    vital('retry', TDay.retries, baseline.map(d => days.get(d)?.retries ?? 0), true),
  ]
  const last30 = Array.from({ length: config.recentDays }, (_, i) => shiftDay(today, i + 1 - config.recentDays))
  const ser = f => last30.map(d => days.get(d)?.n > 0 ? f(days.get(d)) : null)
  const series = { token: last30.map(d => days.get(d)?.tokens ?? 0), c: last30.map(d => days.get(d)?.c ?? 0), req: last30.map(d => days.get(d)?.n ?? 0), hit: ser(d => d.p ? d.rd / d.p * 100 : null), ttft: ser(d => q(d.ttft, .5)), ttft90: ser(d => q(d.ttft, .9)), tps: ser(d => q(d.tps, .5)), ctx: ser(d => q(d.prompt, .5)), retry: last30.map(d => days.get(d)?.retries ?? 0) }
  const todayEnds = turnEnds.filter(e => e.day === today), todayRetry = retryLog.filter(e => e.day === today)
  const titleTokens = new Map(), sessionTokens = new Map()
  for (const r of rows.filter(r => r.day === today)) {
    const title = sMap.get(r.s)?.title?.replace(/ \(\d+\)$/, '') ?? null
    titleTokens.set(title, (titleTokens.get(title) ?? 0) + tok(r)); sessionTokens.set(r.s, (sessionTokens.get(r.s) ?? 0) + tok(r))
  }
  const topTitle = [...titleTokens].sort((a, b) => b[1] - a[1])[0], todayTokens = sum([...sessionTokens.values()], x => x)
  const todayInfo = { reqs: TDay.n, errorTurns: todayEnds.filter(e => e.kind === 'error').length, abortedTurns: todayEnds.filter(e => e.kind === 'aborted').length, turns: todayEnds.length, why: counts(todayRetry, x => x.why ?? x.code), ttft90: q(TDay.ttft, .9), firstHm: todayRetry.find(x => x.why)?.hm ?? null, lastHm: todayRetry.filter(x => x.why).at(-1)?.hm ?? null, top: [...sessionTokens].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, tokens]) => ({ title: sMap.get(id)?.title ?? null, preset: sMap.get(id)?.preset ?? null, share: todayTokens ? tokens / todayTokens : 0, id })), topTitle: topTitle && todayTokens ? { title: topTitle[0], share: topTitle[1] / todayTokens } : null }
  const within = x => x.day >= last30[0] && x.day <= today
  const win = rows.filter(within), winMain = win.filter(r => r.kind === 'main'), winRetry = retryLog.filter(within), winEnds = turnEnds.filter(within)
  const provs = [...new Set([...winMain.map(r => r.p), ...winRetry.map(r => r.p), ...winEnds.map(r => r.p)])].filter(Boolean)
  const status = provs.map(p => {
    const req = winMain.filter(r => r.p === p), rl = winRetry.filter(r => r.p === p), ends = winEnds.filter(e => e.p === p)
    return { p, req: req.length, fails: rl.length, ok: req.length + rl.length ? req.length / (req.length + rl.length) : null, codes: counts(rl, x => x.code), why: counts(rl, x => x.why), ticks: last30.map(d => ({ d, n: req.filter(r => r.day === d).length, f: rl.filter(r => r.day === d).length, bad: ends.filter(e => e.day === d && e.kind === 'error').length })), errorTurns: ends.filter(e => e.kind === 'error').length, turnsAll: ends.length, ttft: q(ttftOf(req), .5), ttft90: q(ttftOf(req), .9), tps: q(tpsOf(req), .5), model: req[0]?.m ?? null }
  }).sort((a, b) => b.req - a.req)
  const bySes = new Map()
  for (const r of win) {
    if (!bySes.has(r.s)) bySes.set(r.s, { s: r.s, tokens: 0, c: 0, req: 0, rd: 0, p: 0, turns: new Set(), models: new Map(), comp: blankParts(), days: new Map() })
    const v = bySes.get(r.s); v.tokens += tok(r); v.c += r.c
    if (r.turn != null) v.turns.add(r.turn)
    v.models.set(r.m, (v.models.get(r.m) ?? 0) + 1); v.days.set(r.day, (v.days.get(r.day) ?? 0) + tok(r))
    if (r.kind === 'main') { v.req++; v.rd += r.rd; v.p += r.prompt; addParts(v.comp, r) }
  }
  const sesTotal = sum([...bySes.values()], v => v.tokens)
  const topSes = [...bySes.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 6).map(v => ({ title: sMap.get(v.s)?.title ?? null, id: v.s, ws: sMap.get(v.s)?.ws ?? '', preset: sMap.get(v.s)?.preset ?? null, deleted: !!sMap.get(v.s)?.deleted, model: [...v.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, tokens: v.tokens, share: sesTotal ? v.tokens / sesTotal : 0, c: v.c, req: v.req, turns: v.turns.size, hit: v.p ? v.rd / v.p : null, comp: v.comp, spark: last30.map(d => v.days.get(d) ?? 0) }))
  const turns = turnsOf(win), quant = { ctx: pct(winMain.map(r => r.prompt)), out: pct(winMain.map(r => r.out)), ttft: pct(ttftOf(winMain)), tps: pct(tpsOf(winMain)), cost: pct(turns.filter(t => t.c > 0).map(t => t.c)), steps: pct(turns.filter(t => t.steps > 0).map(t => t.steps)) }
  const edges = [0, 60, 300, 1800, 3000, 3600, 5400, 10800, 43200, null]
  const gaps = edges.slice(0, -1).map((fromSeconds, i) => { const toSeconds = edges[i + 1]; const a = winMain.filter(r => r.gap != null && r.prompt > config.missPromptAbove && r.gap / 1000 >= fromSeconds && (toSeconds === null || r.gap / 1000 < toSeconds)).map(r => r.hit * 100); return { fromSeconds, toSeconds, n: a.length, p50: q(a, .5) } })
  const tb = new Map(), winS = new Set(win.map(r => r.s))
  // 样稿的工具口径：窗口内有请求的会话，其全部已完成工具调用。
  for (const t of tools.filter(t => winS.has(t.s))) {
    if (!tb.has(t.name)) tb.set(t.name, { name: t.name, calls: 0, err: 0, ms: [], tok: 0 })
    const v = tb.get(t.name); v.calls++; if (t.err) v.err++; v.ms.push(t.ms / 1000); v.tok += t.tok
  }
  const toolTab = [...tb.values()].map(v => ({ name: v.name, calls: v.calls, err: v.err, p50: q(v.ms, .5), p90: q(v.ms, .9), tok: v.tok })).sort((a, b) => b.tok - a.tok).slice(0, 8)
  const firstModel = new Map()
  for (const r of rows) if (r.m && !firstModel.has(r.m)) firstModel.set(r.m, r.day)
  const months = [...new Set(active.map(d => d.slice(0, 7)))].sort().reverse().map(m => {
    const rs = rows.filter(r => r.month === m), ws = new Map(), ds = active.filter(d => d.startsWith(m))
    for (const r of rs) {
      const key = sMap.get(r.s)?.ws ?? null
      if (!ws.has(key)) ws.set(key, { n: key, req: 0, tokens: 0, ses: new Set() })
      const v = ws.get(key); if (r.kind === 'main') v.req++; v.tokens += tok(r); v.ses.add(r.s)
    }
    const pk = ds.reduce((a, d) => days.get(d).tokens > days.get(a).tokens ? d : a, ds[0])
    return { m, tokens: sum(rs, tok), c: sum(rs, r => r.c), req: rs.filter(r => r.kind === 'main').length, ses: new Set(rs.map(r => r.s)).size, days: ds.length, comp: rs.filter(r => r.kind === 'compaction').length, retries: retryLog.filter(x => x.month === m).length, ws: [...ws.values()].map(v => ({ ...v, ses: v.ses.size })).sort((a, b) => b.tokens - a.tokens).slice(0, 4), wsN: ws.size, peak: pk, peakT: days.get(pk).tokens, newModels: [...firstModel].filter(([, d]) => d.startsWith(m)).map(([n, d]) => ({ n, d })) }
  })
  const comparisonRows = rows.filter(r => r.day >= shiftDay(today, -13) && r.day <= today)
  const cmp = compareWeeks(comparisonRows, turnsOf(comparisonRows), today)
  const breakdown = usageBreakdown({ rows, tools, sessions, retryLog, turnEnds, today, hour: clock.hour, config })
  const details = windowStats(win, winMain, winRetry, turns, bySes, groupOf, sessions, days, first, today, config)
  return { generated: now, nowH: clock.hour, nowHm: clock.hm, today, period: peakPeriod(now, config), life, ranges, year, recentHours, baselineDays: config.baselineDays, models, workspaces, vitals, todayInfo, last30, series, status, topSes, quant, gaps, toolTab, toolN: tb.size, months, sesN: winS.size, modelN: models.length, provN: provs.length, ...details, cmp, windowN: last30.length, since30: last30[0], groupsAvailable, priceMissing: priced.priceMissing, holidayTableLastYear: HOLIDAY_TABLE_LAST_YEAR, breakdown }
}

/**
 * 用量页左侧汇总在各范围的数字：窗口和图一致，今日从 0 时到现在，24 小时是现在往回 24 个整点，7 天是今天往回 7 个日历日，
 * 30 天和 1 年按日历日，用量只算有用量的日子（同 `year`，和 `usageRangeTotals` 一致）。「全部」用 `life`。
 * @param {{rows: object[], tools: object[], retryLog: object[], active: string[], today: string, hour: number}} input 已带日期和小时的记录；工具和重试按各自完成和发生的时刻落在小时里。
 * @returns {Record<'today' | '24h' | '7d' | '30' | '365', object>} 字段同 `life` 的 tokens、c、input、rd、out、req、turns、sessions、tools、comp、retries，另有 `models` 和 `workspaces`（条目同顶层的同名数组，占比相对这个范围的 token 合计）。
 */
function rangeSummaries({ workspaceOf, rows, tools, retryLog, active, today, hour }) {
  const activeDays = new Set(active)
  const yesterday = shiftDay(today, -1)
  const notAhead = x => x.day < today || (x.day === today && x.hour <= hour)
  const calendarDays = back => x => x.day >= shiftDay(today, -back) && x.day <= today
  const windows = {
    today: { inside: x => x.day === today && x.hour <= hour },
    '24h': { inside: x => (x.day === today && x.hour <= hour) || (x.day === yesterday && x.hour > hour) },
    '7d': { inside: x => x.day >= shiftDay(today, -6) && notAhead(x) },
    30: { inside: calendarDays(29), activeOnly: true },
    365: { inside: calendarDays(364), activeOnly: true },
  }
  return Object.fromEntries(Object.entries(windows).map(([key, { inside, activeOnly }]) => {
    const rs = rows.filter(r => inside(r) && (!activeOnly || activeDays.has(r.day)))
    return [key, { tokens: sum(rs, tok), c: sum(rs, r => r.c), input: sum(rs, r => r.input), rd: sum(rs, r => r.rd), out: sum(rs, r => r.out), req: rs.filter(r => r.kind === 'main').length, turns: new Set(rs.filter(r => r.turn != null).map(r => `${r.s}/${r.turn}`)).size, sessions: new Set(rs.map(r => r.s)).size, tools: tools.filter(inside).length, comp: rs.filter(r => r.kind === 'compaction').length, retries: retryLog.filter(inside).length, models: shares(rs, r => r.m), workspaces: shares(rs, workspaceOf) }]
  }))
}

function windowStats(rows, main, retries, turns, bySes, groupOf, sessions, days, first, today, config) {
  const T = { n: rows.length, main: main.length, input: sum(rows, r => r.input), rd: sum(rows, r => r.rd), wr: sum(rows, r => r.wr), out: sum(rows, r => r.out), c: sum(rows, r => r.c), saved: sum(rows, r => r.saved), peakC: sum(rows.filter(r => r.peak), r => r.c), compN: rows.filter(r => r.kind === 'compaction').length, compC: sum(rows.filter(r => r.kind === 'compaction'), r => r.c), attempts: rows.filter(r => r.kind === 'attempt').length, attC: sum(rows.filter(r => r.kind === 'attempt'), r => r.c), turns: turns.length, sessions: bySes.size }
  T.hit = T.input + T.rd + T.wr ? T.rd / (T.input + T.rd + T.wr) : null
  T.shift = sum(rows, r => r.shift)
  const daily = []
  // 预测只需本月与基线覆盖范围，无需为多年空档分配日序列。
  const start = [today.slice(0, 7) + '-01', shiftDay(today, 1 - config.baselineDays)].sort()[0]
  for (let d = first && first > start ? first : start; first && d <= today; d = shiftDay(d, 1)) daily.push({ day: d, c: days.get(d)?.c ?? 0 })
  const fc = forecastMonth(daily, today, config.baselineDays)
  const misses = main.filter(r => r.prompt > config.missPromptAbove && r.hit < config.missHitBelow), missBy = new Map()
  for (const r of misses) {
    const why = r.reason === 'first' ? 'first-request' : r.gap !== null && r.gap > 3600e3 ? 'gap-over-1h' : r.reason === 'resume' ? 'resume' : r.reason === 'system' ? 'system-changed' : r.reason === 'header' ? 'tools-changed' : 'other'
    if (!missBy.has(why)) missBy.set(why, { why, n: 0, x: 0 })
    const v = missBy.get(why); v.n++; v.x += r.missX
  }
  const wakes = main.filter(r => groupOf.get(r.s) === config.wakeGroup && r.gap !== null && r.gap > 3600e3 && r.prompt > config.missPromptAbove)
  const wakeMisses = wakes.filter(r => r.hit < config.missHitBelow)
  const wakeInfo = { n: wakes.length, hit0: wakeMisses.length, extra: sum(wakeMisses, r => r.missX), avgCost: wakes.length ? sum(wakes, r => r.c) / wakes.length : 0 }
  const warm = main.filter(r => groupOf.get(r.s) === config.wakeGroup && r.gap !== null && r.gap > 600e3 && r.gap < 3000e3 && r.hit > .9)
  const warmInfo = { n: warm.length, avgCost: warm.length ? sum(warm, r => r.c) / warm.length : 0 }
  const compT = blankParts(); for (const r of main) addParts(compT, r)
  const costParts = { input: sum(rows, r => r.costIn), read: sum(rows, r => r.costRd), output: sum(rows, r => r.costOut) }
  const groups = [...config.groups.map(g => g.id), 'other'].map(id => { const ses = [...bySes.values()].filter(v => groupOf.get(v.s) === id); return { id, c: sum(ses, v => v.c), req: sum(ses, v => v.req), s: ses.length } })
  const stall = main.filter(r => r.retries > 0 && r.ttft > 0)
  const stallInfo = { n: stall.length, hours: sum(stall, r => r.ttft) / 3600e3, by: [...new Set(stall.map(r => groupOf.get(r.s)))].map(k => { const rs = stall.filter(r => groupOf.get(r.s) === k); return { k, n: rs.length, ms: sum(rs, r => r.ttft) } }) }
  const slow = main.filter(r => r.ttft > 30000), noRetry = main.filter(r => !r.retries && r.ttft > 0)
  const rel = { retries: retries.length, codes: counts(retries, r => r.code), stepsWithRetry: stall.length, retryTtftP50: q(ttftOf(stall), .5), noRetryP50: q(ttftOf(noRetry), .5), noRetryP99: q(ttftOf(noRetry), .99), slow: slow.length, slowMax: slow.length ? Math.max(...ttftOf(slow)) : null, compStarted: null }
  return { T, fc, missBy: [...missBy.values()].sort((a, b) => b.x - a.x), missN: misses.length, missX: sum(misses, r => r.missX), wakeInfo, warmInfo, compT, costParts, groups, gini: gini([...bySes.values()].filter(v => v.c > 0).map(v => v.c)), stallInfo, rel }
}

function compareWeeks(rows, turns, today) {
  const b0 = shiftDay(today, -6), a0 = shiftDay(today, -13)
  const pa = turns.filter(t => t.day >= a0 && t.day < b0), pb = turns.filter(t => t.day >= b0)
  const ra = rows.filter(r => r.day >= a0 && r.day < b0), rb = rows.filter(r => r.day >= b0)
  const hit = rs => { const p = sum(rs, r => r.prompt); return p ? 100 * sum(rs, r => r.rd) / p : null }
  const metric = (label, unit, fn, d) => {
    const a = pa.map(t => q(fn(t), .5)).filter(x => x != null), b = pb.map(t => q(fn(t), .5)).filter(x => x != null)
    return { label, unit, a: q(a, .5), b: q(b, .5), p: mannWhitney(a, b)?.p ?? null, n1: a.length, n2: b.length, d }
  }
  return [{ label: 'cost', unit: 'CNY', a: sum(ra, r => r.c), b: sum(rb, r => r.c), d: 2 }, { label: 'requests', unit: 'count', a: ra.filter(r => r.kind === 'main').length, b: rb.filter(r => r.kind === 'main').length, d: 0 }, { label: 'hit', unit: 'percent', a: hit(ra), b: hit(rb), d: 1 }, metric('turn-cost', 'CNY', t => [t.c], 3), metric('context', 'tokens', t => t.prompt, 0), metric('ttft', 'seconds', t => t.ttft, 2), metric('tps', 'tokens-per-second', t => t.tps, 0)]
}

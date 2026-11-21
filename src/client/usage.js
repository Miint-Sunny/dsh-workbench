/**
 * 用量主页：主区页面和侧边栏底部的速览卡片。结构照 GitHub 个人主页，左栏是累计和额度，右栏依次是
 * 图（usage-chart-view.js）、监控、会话、提供方、费用和上下文、分布、每月用量。数据来自宿主的
 * /api/dsh-workbench.usage.*，只在打开页面、切换范围和点刷新时读，不轮询。
 * 入口是侧边栏底部的速览卡片（UsageCard），同样不轮询。
 * 余额和额度读 dsh-workbench/quota 这一行的接口，那一行关着或读不到时那一块不显示。
 */
import { usageTokens, usageMoney, usagePercent, usageCount, usageZ, usageMonthDay, usageLocalMonthDay, usagePValue, usageProviderName, usageVitalOrder, usageVerdict, usageVitalTone, usageGapLabel, usageCacheLifeMinutes, usageResetTime, usageCompParts, usageRateLimitUpstream, usageCountList, usageBalanceBlock, usageBalanceText, usageLocalTime, usageMissLever, usageSpendGroups, usageCardShouldRead, usageSessionFinished, usageCardToday, usageCardPlans, usageLocalMidnight, usageCardEscapeAction, USAGE_CARD_MIN_GAP_MS } from './usage-model.js'
import { UsageCharts, UsageSegment, UsageRangeTabs, usageCardTyping, usageStoredRange, usageStoreRange } from './usage-chart-view.js'
import { usageRangeSummary } from './usage-charts.js'
import { USAGE_CSS } from './usage-style.js'
import { USAGE_PALETTE_SLOT } from './features.js'
import { mountModuleStyle } from './style.js'

/** 本功能要用的 DSH 服务：打开会话和页面，看会话什么时候结束。 */
export const USAGE_INJECT = ['uiWorkspace', 'uiSession', 'layout']

const USAGE_PANEL_ID = 'dsh-workbench-usage'
const USAGE_CARD_ID = 'dsh-workbench-usage-card'
const USAGE_CARD_PINNED_KEY = 'dsh-workbench.usage.card.expanded'
const USAGE_OVERVIEW_PATH = 'api/dsh-workbench.usage.overview'
const USAGE_COST_PATH = 'api/dsh-workbench.usage.cost'
const USAGE_QUOTA_PATH = 'api/dsh-workbench.quota.overview'
const USAGE_QUOTA_HOT_PERCENT = 75
const USAGE_QUOTA_LABELS = { '5h': 'usage.quota.5h', week: 'usage.quota.week', month: 'usage.quota.month' }
const USAGE_VITAL_FORMAT = {
  token: usageTokens,
  c: value => usageMoney(value),
  req: usageCount,
  hit: value => `${value.toFixed(1)}%`,
  ttft: value => `${value.toFixed(1)} s`,
  tps: value => `${Math.round(value)} tok/s`,
  ctx: usageTokens,
  retry: value => String(Math.round(value * 10) / 10),
}

let usageCtx
let usageStore
let usageT
let usageCardSink = null

/**
 * 读一个 JSON 接口。
 * @param {string} path 相对文档的路径。
 * @returns {Promise<any>} 解析后的响应；状态不是 2xx 时抛错。
 */
async function usageFetchJson(path) {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/**
 * 读左栏「余额与额度」的数据。这一行关着时不发请求。
 * @param {boolean} refresh 是否绕过宿主的缓存（点刷新时）。
 * @returns {Promise<object | null>} usageBalanceBlock 的结果；读不到时是 null。
 */
async function usageFetchBalance(refresh) {
  if (!usageStore.has('quota')) return null
  let quota
  try {
    quota = await usageFetchJson(`${USAGE_QUOTA_PATH}${refresh ? '?refresh=1' : ''}`)
  } catch {
    // 接口出错：这一块不显示，页面其余部分不受影响。
    return null
  }
  let local = null
  if (quota.spend != null) {
    try {
      local = await usageFetchJson(`${USAGE_COST_PATH}?providers=deepseek-official&since=${quota.spend.since}`)
    } catch {
      // 本机估算读不到：只少差额那几行，余额和额度照常显示。
    }
  }
  return usageBalanceBlock(quota, local)
}

/**
 * 构成条和色块的第几段用什么颜色：第一段蓝色，其余用灰。
 * @param {number} index 第几段。
 * @returns {string} CSS 颜色。
 */
function usageMarkColor(index) {
  return index === 0 ? 'var(--dwb-us-accent)' : `var(--dwb-us-g${Math.min(index, 6)})`
}

function UsageStack({ parts, label, empty = false }) {
  const total = parts.reduce((sum, part) => sum + part.v, 0) || 1
  return h('div', { className: `dwb-us-stack${empty ? ' dwb-us-stack-empty' : ''}`, role: 'img', 'aria-label': label },
    empty ? null : parts.map((part, index) => h('i', {
      key: part.key,
      style: { flex: `${(part.v / total).toFixed(4)} 1 0`, background: usageMarkColor(index) },
    })))
}

function UsageSwatch({ index }) {
  return h('i', { className: 'dwb-us-sw', style: { background: usageMarkColor(index) } })
}

/**
 * 每天一根的小柱：没有数据的日子留空，最后一根是今天。
 */
function UsageBars({ values, width = 112, height = 18, last = 'var(--dwb-us-last)', median = null, stretch = false }) {
  const numbers = values.filter(value => value != null)
  const max = Math.max(...numbers, median ?? 0, 1e-9)
  const step = width / values.length
  const bar = Math.max(1.5, step - 1.5)
  const medianY = median != null && median > 0 ? height - median / max * (height - 1) : null
  return h('svg', { className: 'bars', width, height, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: stretch ? 'none' : undefined, 'aria-hidden': true },
    values.map((value, index) => {
      if (value == null || value === 0) return null
      const barHeight = Math.max(1.5, value / max * (height - 1))
      return h('rect', {
        key: index,
        x: (index * step).toFixed(1),
        y: (height - barHeight).toFixed(1),
        width: bar.toFixed(1),
        height: barHeight.toFixed(1),
        rx: 0.5,
        style: { fill: index === values.length - 1 ? last : 'var(--dwb-us-bar)' },
      })
    }),
    medianY === null ? null : h('line', { x1: 0, x2: width, y1: medianY.toFixed(1), y2: medianY.toFixed(1), stroke: 'var(--dwb-us-g2)', strokeWidth: 1, strokeDasharray: '2 2' }))
}

function UsageStat({ value, label }) {
  return h('div', null, h('b', null, value), h('span', null, label))
}

function UsageQuotaRow({ item }) {
  const t = usageT
  const percent = item.percent ?? 0
  const hot = percent >= USAGE_QUOTA_HOT_PERCENT
  const labelKey = USAGE_QUOTA_LABELS[item.key]
  return h('div', { className: 'dwb-us-q' },
    h('span', { className: 'dwb-us-tr' }, labelKey === undefined ? (item.name ?? item.key) : t(labelKey)),
    h('span', { className: 'dwb-us-qb' }, h('i', { style: { width: `${Math.max(percent, 0.5).toFixed(1)}%`, background: hot ? 'var(--dwb-us-warn)' : 'var(--dwb-us-g1)' } })),
    h('span', { className: `dwb-us-qv${hot ? ' hi' : ''}` }, `${percent.toFixed(0)}%`),
    h('span', { className: 'dwb-us-n' }, usageResetTime(item.resetsAt)))
}

function UsageBalance({ block }) {
  const t = usageT
  return h('section', null,
    h('h5', null, t('usage.balance.title')),
    block.balances.map((balance, index) => h('div', { className: 'dwb-us-kv', key: balance.currency },
      h('span', null, index === 0 ? t('usage.balance.deepseek') : null),
      h('b', null, usageBalanceText(balance)))),
    block.gap === null ? null : h(Fragment, null,
      h('div', { className: 'dwb-us-kv' },
        h('span', null, t('usage.balance.since', { day: usageLocalMonthDay(block.gap.since) })),
        h('b', null, usageMoney(block.gap.spend))),
      h('div', { className: 'dwb-us-kv' }, h('span', null, t('usage.balance.local')), h('b', null, usageMoney(block.gap.local))),
      usageMoney(block.gap.other) === usageMoney(0) ? null : h('div', { className: 'dwb-us-kv' }, h('span', null, t('usage.balance.other')), h('b', null, usageMoney(block.gap.other)))),
    block.plans.map(plan => h(Fragment, { key: plan.id },
      h('div', { className: 'dwb-us-qh' }, plan.name),
      plan.windows.map(item => h(UsageQuotaRow, { key: item.key, item })))),
    block.problems.map(problem => h('div', { className: 'dwb-us-cap', key: problem.id },
      t(problem.stale ? 'usage.quota.stale' : 'usage.quota.problem', {
        name: problem.name,
        state: t(`usage.quota.state.${problem.state}`),
        time: usageLocalTime(problem.queriedAt),
      }))))
}

/**
 * 左侧汇总：大数、构成条和六个计数跟着所选范围走，「全部」是累计。窄布局时范围标签放在最上面。
 * 这个范围里没有用量时三个比例写破折号，构成条是空的。
 */
function UsageHead({ data, range, onRange }) {
  const t = usageT
  const summary = usageRangeSummary(data, range)
  const flow = [
    { key: 'read', v: summary.rd, name: t('usage.flow.read') },
    { key: 'input', v: summary.input, name: t('usage.flow.input') },
    { key: 'output', v: summary.out, name: t('usage.flow.output') },
  ]
  const flowTotal = summary.rd + summary.input + summary.out
  const share = part => usagePercent(flowTotal === 0 ? null : part.v / flowTotal)
  const caption = range === 'all'
    ? t('usage.hero.total', { day: data.life.first, cost: usageMoney(summary.c) })
    : t('usage.hero.range', { title: t(`usage.chart.title.${range}`), cost: usageMoney(summary.c) })
  return h('div', { className: 'dwb-us-head' },
    h(UsageRangeTabs, { t, id: 'dwb-us-head-range', value: range, onChange: onRange, className: 'dwb-us-seg-range dwb-us-seg-narrow' }),
    h('div', null,
      h('div', { className: 'dwb-us-hero' }, usageTokens(summary.tokens), ' ', h('span', null, t('usage.hero.unit'))),
      h('div', { className: 'dwb-us-cap' }, caption)),
    h(UsageStack, { parts: flow, empty: flowTotal === 0, label: flow.map(part => `${part.name} ${share(part)}`).join('，') }),
    h('div', { className: 'dwb-us-legend' }, flow.map((part, index) => h('span', { key: part.key }, h(UsageSwatch, { index }), `${part.name} ${share(part)}`))),
    h('div', { className: 'dwb-us-grid3' },
      h(UsageStat, { value: usageCount(summary.sessions), label: t('usage.stat.sessions') }),
      h(UsageStat, { value: usageCount(summary.turns), label: t('usage.stat.turns') }),
      h(UsageStat, { value: usageCount(summary.req), label: t('usage.stat.requests') }),
      h(UsageStat, { value: usageCount(summary.tools), label: t('usage.stat.tools') }),
      h(UsageStat, { value: usageCount(summary.comp), label: t('usage.stat.compactions') }),
      h(UsageStat, { value: usageCount(summary.retries), label: t('usage.stat.retries') })))
}

function UsageSide({ data, balance, range, onRange }) {
  const t = usageT
  const modelName = model => model.n ?? t('usage.models.unknown')
  const scoped = range === 'all' ? data : data.ranges[range]
  const models = scoped.models, workspaces = scoped.workspaces
  return h('aside', { className: 'dwb-us-side' },
    h(UsageHead, { data, range, onRange }),
    balance === null ? null : h(UsageBalance, { block: balance }),
    h('section', null,
      h('h5', null, t('usage.models'), ' ', h('span', null, models.length)),
      h(UsageStack, {
        empty: models.length === 0,
        parts: models.map((model, index) => ({ key: model.n ?? index, v: model.v })),
        label: models.map(model => `${modelName(model)} ${usagePercent(model.p)}`).join('，'),
      }),
      models.map((model, index) => h('div', { className: 'dwb-us-kv dwb-us-mono', key: model.n ?? index },
        h(UsageSwatch, { index }),
        h('span', { className: 'dwb-us-tr' }, modelName(model)),
        h('b', null, usagePercent(model.p))))),
    h('section', null,
      h('h5', null, t('usage.workspaces'), ' ', h('span', null, workspaces.length)),
      workspaces.slice(0, 5).map(workspace => h('div', { className: 'dwb-us-kv', key: workspace.n },
        h('span', { className: 'dwb-us-tr' }, workspace.n),
        h('b', null, usagePercent(workspace.p))))),
    data.toolTab.length === 0 ? null : h('section', null,
      h('h5', null, t('usage.tools'), ' ', h('span', null, data.toolN)),
      h('div', { className: 'dwb-us-tg th' },
        h('span', null),
        h('span', null, t('usage.tools.calls')),
        h('span', null, t('usage.tools.errors')),
        h('span', null, t('usage.tools.tokens'))),
      data.toolTab.map(tool => h('div', { className: 'dwb-us-tg', key: tool.name },
        h('span', { className: 'dwb-us-tr dwb-us-mono' }, tool.name),
        h('span', null, tool.calls),
        h('span', null, tool.err || '—'),
        h('b', null, usageTokens(tool.tok)))),
      h('div', { className: 'dwb-us-cap' }, t('usage.tools.note'))))
}

/**
 * 反常行下面那句说明。
 * @param {{key: string}} vital 这一行的指标。
 * @param {object} info 接口的 `todayInfo`。
 * @returns {string | null} 说明；这个指标没有可说的具体原因时是 null。
 */
function usageVitalNote(vital, info) {
  const t = usageT
  if (vital.key === 'retry') {
    const why = usageCountList(info.why)
    const unfinished = info.errorTurns + info.abortedTurns
    return why === '' || info.firstHm == null ? null : t('usage.vital.note.retry', { why, from: info.firstHm, to: info.lastHm, n: unfinished })
  }
  if (vital.key === 'ttft') {
    return info.ttft90 == null ? null : t('usage.vital.note.ttft', { n: info.reqs, p90: info.ttft90.toFixed(1) })
  }
  if (vital.key === 'token') {
    return info.topTitle?.title == null ? null : t('usage.vital.note.token', { share: usagePercent(info.topTitle.share, 0), title: info.topTitle.title })
  }
  return null
}

function UsageMonitorRow({ vital, data }) {
  const t = usageT
  const color = vital.key === 'retry' ? 'var(--dwb-us-serious)' : 'var(--dwb-us-warn)'
  const format = USAGE_VITAL_FORMAT[vital.key]
  const note = vital.anomaly ? usageVitalNote(vital, data.todayInfo) : null
  return h('div', { className: `dwb-us-mr dwb-us-t-${usageVitalTone(vital.z)}${vital.anomaly ? ' hot' : ''}` },
    h('span', { className: 'ml' },
      vital.anomaly ? h('i', { className: 'dwb-us-dot', style: { background: color } }) : null,
      t(`usage.vital.${vital.key}`)),
    h('span', { className: 'dwb-us-n' }, vital.x == null ? '—' : format(vital.x)),
    h('span', { className: 'dwb-us-n m' }, vital.m == null ? '—' : format(vital.m)),
    h('span', { className: 'dwb-us-n z' }, usageZ(vital.z)),
    h(UsageBars, { values: data.series[vital.key], width: 240, stretch: true, median: vital.m, last: vital.anomaly ? color : undefined }),
    note === null ? null : h('p', null, note))
}

function UsageLever({ data }) {
  const t = usageT
  const lever = usageMissLever(data)
  if (lever === null) return null
  const values = { share: usagePercent(data.missX / data.T.c, 0), cost: usageMoney(data.missX), top: usageMoney(lever.top) }
  const text = lever.kind === 'wake'
    ? t('usage.lever.wake', values)
    : t('usage.lever.reason', { ...values, reason: t(`usage.miss.${lever.reason}`) })
  return h('div', { className: 'dwb-us-lever' },
    h('i', { className: 'dwb-us-dot', style: { background: 'var(--dwb-us-accent)' } }),
    h('span', null, text))
}

function UsageMonitor({ data, sectionRef }) {
  const t = usageT
  return h('section', { className: 'dwb-us-sec', ref: sectionRef },
    h('header', { className: 'dwb-us-sh' }, h('h5', null, t('usage.monitor.title'))),
    h('div', { className: 'dwb-us-tb' },
      h('div', { className: 'dwb-us-mr dwb-us-mh' },
        h('span', { className: 'ml' }),
        h('span', { className: 'dwb-us-n' }, t('usage.monitor.today')),
        h('span', { className: 'dwb-us-n m' }, t('usage.monitor.median')),
        h('span', { className: 'dwb-us-n z' }, t('usage.monitor.z')),
        h('span', { className: 'sp' }, t('usage.monitor.series'))),
      usageVitalOrder(data.vitals).map(vital => h(UsageMonitorRow, { key: vital.key, vital, data })),
      h(UsageLever, { data })))
}

function UsageSessionCard({ session }) {
  const t = usageT
  const name = session.deleted ? t('usage.sessions.deleted') : (session.title ?? t('usage.sessions.untitled'))
  const location = /^session-|^[0-9a-f]{8}-/.test(session.id) ? session.ws : `${session.id} · ${session.ws}`
  const parts = usageCompParts(session.comp)
  const partsTotal = parts.reduce((sum, part) => sum + part.v, 0) || 1
  const open = () => { usageCtx.uiWorkspace?.openSession(session.id) }
  const action = session.deleted ? {} : {
    role: 'button',
    tabIndex: 0,
    'aria-label': t('usage.sessions.open', { name }),
    onClick: open,
    onKeyDown: (event) => { if (event.key === 'Enter') open() },
  }
  return h('article', { className: 'dwb-us-card', ...action },
    h('div', { className: 'dwb-us-ct' }, h('b', { className: 'dwb-us-tr' }, name), h('strong', null, usageTokens(session.tokens))),
    h('div', { className: 'dwb-us-cs' },
      h('span', { className: 'dwb-us-tr' }, location),
      h('span', null, `${usagePercent(session.share)} · ${usageMoney(session.c)}`)),
    h(UsageStack, { parts, label: parts.map(part => `${t(`usage.comp.${part.key}`)} ${usagePercent(part.v / partsTotal)}`).join('，') }),
    h('div', { className: 'dwb-us-cm' },
      h('span', null, t('usage.sessions.requests', { n: session.req })),
      h('span', null, t('usage.sessions.turns', { n: session.turns })),
      h('span', null, t('usage.sessions.hit', { value: usagePercent(session.hit, 0) }))),
    h(UsageBars, { values: session.spark, width: 228, height: 18, stretch: true }))
}

function UsageSessions({ data }) {
  const t = usageT
  if (data.topSes.length === 0) return null
  return h('section', { className: 'dwb-us-sec' },
    h('header', { className: 'dwb-us-sh' },
      h('h5', null, t('usage.sessions.title')),
      h('span', { className: 'dwb-us-cap' }, t('usage.sessions.note', { n: data.sesN, gini: data.gini.toFixed(2) }))),
    h('div', { className: 'dwb-us-cards' }, data.topSes.map(session => h(UsageSessionCard, { key: session.id, session }))))
}

function UsageProviderRow({ status }) {
  const t = usageT
  const name = usageProviderName(status.p)
  const tickClass = tick => (tick.bad > 0 ? 'dwb-us-bad' : tick.f > 0 ? 'dwb-us-warn' : tick.n > 0 ? 'dwb-us-ok' : 'dwb-us-off')
  const whyList = usageCountList(status.why)
  return h('div', { className: 'dwb-us-pr' },
    h('div', { className: 'dwb-us-pn' },
      h('b', { className: 'dwb-us-tr' }, name),
      h('span', null, t('usage.providers.requests', { n: usageCount(status.req) }))),
    h('div', { className: 'dwb-us-ticks', role: 'img', 'aria-label': t('usage.providers.aria', { name }) },
      status.ticks.map(tick => h('i', { key: tick.d, className: tickClass(tick) }))),
    h('div', { className: 'dwb-us-ps' },
      h('span', null, h('b', null, usagePercent(status.ok)), ' ', t('usage.providers.okRate')),
      h('span', null, h('b', null, status.ttft == null ? '—' : `${status.ttft.toFixed(2)} s`), ' ', t('usage.providers.ttft')),
      h('span', null, h('b', null, status.tps == null ? '—' : Math.round(status.tps)), ' tok/s')),
    status.fails > 0 ? h('p', { className: 'dwb-us-pd' },
      h('code', null, usageCountList(status.codes)),
      '　', t('usage.providers.failedTurns', { failed: status.errorTurns, total: status.turnsAll })) : null,
    usageRateLimitUpstream(status) ? h('p', { className: 'dwb-us-pd' }, t('usage.providers.upstream'), h('code', null, whyList)) : null)
}

function UsageProviders({ data }) {
  const t = usageT
  if (data.status.length === 0) return null
  return h('section', { className: 'dwb-us-sec' },
    h('header', { className: 'dwb-us-sh' },
      h('h5', null, t('usage.providers.title')),
      h('span', { className: 'dwb-us-lg2' }, ['ok', 'warn', 'bad', 'off'].map(state => h('span', { key: state },
        h('i', { className: `dwb-us-k dwb-us-${state}` }),
        t(`usage.providers.${state}`))))),
    data.status.map(status => h(UsageProviderRow, { key: status.p, status })))
}

function UsageMissPanel({ data }) {
  const t = usageT
  const wake = data.wakeInfo
  return h('div', { className: 'dwb-us-pan' },
    h('h6', null, t('usage.miss.title'), ' ', h('b', null, usageMoney(data.missX))),
    data.missBy.map((row, index) => h('div', { className: `dwb-us-rw${index === 0 ? ' lead' : ''}`, key: row.why },
      h('span', { className: 'dwb-us-tr' }, t(`usage.miss.${row.why}`)),
      h('span', { className: 'dwb-us-n' }, t('usage.miss.count', { n: row.n })),
      h('span', { className: 'dwb-us-n' }, usageMoney(row.x)))),
    wake.n > 0 ? h('p', { className: 'dwb-us-cap' }, t('usage.miss.wake', {
      n: wake.n,
      miss: wake.hit0,
      avg: usageMoney(wake.avgCost, 3),
      warm: usageMoney(data.warmInfo.avgCost, 4),
    })) : null)
}

function UsageGapsPanel({ data }) {
  const t = usageT
  const life = usageCacheLifeMinutes(data.gaps)
  const gapText = (gap) => {
    const label = usageGapLabel(gap)
    const unit = t(`usage.gaps.${label.unit}`)
    if (label.kind === 'range') return t('usage.gaps.range', { a: label.a, b: label.b, unit })
    return t(`usage.gaps.${label.kind}`, { value: `${label.a} ${unit}` })
  }
  return h('div', { className: 'dwb-us-pan' },
    h('h6', null, t('usage.gaps.title'), h('span', null, t('usage.gaps.tag'))),
    data.gaps.map(gap => h('div', { className: 'dwb-us-gb', key: gap.fromSeconds },
      h('span', { className: 'dwb-us-tr' }, gapText(gap)),
      h('span', { className: 'dwb-us-gt' }, h('i', { style: {
        width: `${gap.p50 == null ? 0 : Math.max(gap.p50, 0.6).toFixed(1)}%`,
        background: gap.p50 > 50 ? 'var(--dwb-us-g1)' : 'var(--dwb-us-accent)',
      } })),
      h('span', { className: 'dwb-us-n' }, gap.p50 == null ? '—' : `${gap.p50.toFixed(0)}%`),
      h('span', { className: 'dwb-us-n dwb-us-cap' }, `n = ${gap.n}`))),
    life === null ? null : h('p', { className: 'dwb-us-cap' }, t('usage.gaps.life', { minutes: life })))
}

function UsageCompPanel({ data }) {
  const t = usageT
  const parts = usageCompParts(data.compT)
  const total = parts.reduce((sum, part) => sum + part.v, 0) || 1
  const nameOf = key => t(`usage.comp.${key}`)
  return h('div', { className: 'dwb-us-pan' },
    h('h6', null, t('usage.comp.title'), h('span', null, t('usage.comp.tag'))),
    h(UsageStack, { parts, label: parts.map(part => `${nameOf(part.key)} ${usagePercent(part.v / total)}`).join('，') }),
    parts.map((part, index) => h('div', { className: `dwb-us-rw${index === 0 ? ' lead' : ''}`, key: part.key },
      h(UsageSwatch, { index }),
      h('span', { className: 'dwb-us-tr' }, nameOf(part.key)),
      h('span', { className: 'dwb-us-n' }, usagePercent(part.v / total)))))
}

function UsageSpendPanel({ data }) {
  const t = usageT
  const costs = [
    { key: 'input', v: data.costParts.input },
    { key: 'output', v: data.costParts.output },
    { key: 'read', v: data.costParts.read },
  ]
  const total = data.T.c || 1
  const fc = data.fc
  return h('div', { className: 'dwb-us-pan' },
    h('h6', null, t('usage.spend.title'), fc == null || fc.est == null ? null : h('span', null, t('usage.spend.forecast', {
      est: usageMoney(fc.est), lo: usageMoney(fc.lo), hi: usageMoney(fc.hi),
    }))),
    h(UsageStack, { parts: costs, label: costs.map(part => `${t(`usage.spend.${part.key}`)} ${usagePercent(part.v / total, 0)}`).join('，') }),
    costs.map((part, index) => h('div', { className: `dwb-us-rw${index === 0 ? ' lead' : ''}`, key: part.key },
      h(UsageSwatch, { index }),
      h('span', { className: 'dwb-us-tr' }, t(`usage.spend.${part.key}`)),
      h('span', { className: 'dwb-us-n' }, usageMoney(part.v)),
      h('span', { className: 'dwb-us-n' }, usagePercent(part.v / total, 0)))),
    h('div', { className: 'dwb-us-div' }),
    usageSpendGroups(data.groups).map(group => h('div', { className: 'dwb-us-rw', key: group.id },
      h('span', { className: 'dwb-us-tr' }, t(`usage.scope.${group.id}`)),
      h('span', { className: 'dwb-us-n' }, t('usage.spend.requests', { n: usageCount(group.req) })),
      h('span', { className: 'dwb-us-n' }, usageMoney(group.c)))),
    h('div', { className: 'dwb-us-rw' },
      h('span', { className: 'dwb-us-tr' }, t('usage.spend.peak')),
      h('span', { className: 'dwb-us-n' }),
      h('span', { className: 'dwb-us-n' }, usageMoney(data.T.peakC))))
}

function UsageCostPanels({ data }) {
  const t = usageT
  return h('section', { className: 'dwb-us-sec' },
    h('header', { className: 'dwb-us-sh' },
      h('h5', null, t('usage.cost.title')),
      h('span', { className: 'dwb-us-cap' }, t('usage.cost.note', {
        cost: usageMoney(data.T.c),
        n: usageCount(data.T.main),
        hit: usagePercent(data.T.hit),
        saved: usageMoney(data.T.saved),
      }))),
    h('div', { className: 'dwb-us-pans' },
      h(UsageMissPanel, { data }),
      h(UsageGapsPanel, { data }),
      h(UsageCompPanel, { data }),
      h(UsageSpendPanel, { data })))
}

function UsageDistribution({ data }) {
  const t = usageT
  const seconds = value => (value >= 100 ? `${usageCount(value)} s` : `${value.toFixed(2)} s`)
  const compare = Object.fromEntries(data.cmp.map(row => [row.label, row]))
  const rows = [
    ['ctx', data.quant.ctx, usageTokens, compare.context],
    ['out', data.quant.out, usageCount],
    ['ttft', data.quant.ttft, seconds, compare.ttft],
    ['tps', data.quant.tps, usageCount, compare.tps],
    ['cost', data.quant.cost, value => usageMoney(value, 3), compare['turn-cost']],
    ['steps', data.quant.steps, value => String(Math.round(value))],
  ]
  return h('section', { className: 'dwb-us-sec' },
    h('header', { className: 'dwb-us-sh' },
      h('h5', null, t('usage.dist.title')),
      h('span', { className: 'dwb-us-cap' }, t('usage.dist.note'))),
    h('div', { className: 'dwb-us-scroll' },
      h('table', { className: 'dwb-us-tbl' },
        h('thead', null, h('tr', null,
          h('th', { className: 'tl' }),
          h('th', null, 'n'),
          h('th', null, 'p50'),
          h('th', null, 'p90'),
          h('th', null, 'p99'),
          h('th', null, t('usage.dist.max')),
          h('th', null, t('usage.dist.before')),
          h('th', null, t('usage.dist.recent')),
          h('th', null, 'p'))),
        h('tbody', null, rows.map(([key, stats, format, row]) => {
          const value = stat => (stats?.[stat] == null ? '—' : format(stats[stat]))
          const significant = row?.p != null && row.p < 0.05
          return h('tr', { key },
            h('td', { className: 'tl' }, t(`usage.dist.${key}`)),
            h('td', null, stats == null ? '—' : usageCount(stats.n)),
            h('td', { className: 'hi' }, value('p50')),
            h('td', null, value('p90')),
            h('td', null, value('p99')),
            h('td', null, value('max')),
            h('td', null, row === undefined || row.a == null ? '' : format(row.a)),
            h('td', null, row === undefined || row.b == null ? '' : format(row.b)),
            h('td', { className: significant ? 'hi' : undefined }, usagePValue(row?.p)))
        })))))
}

function UsageMonths({ data }) {
  const t = usageT
  if (data.months.length === 0) return null
  const max = Math.max(...data.months.flatMap(month => month.ws.map(workspace => workspace.tokens)), 1)
  return h('section', { className: 'dwb-us-sec' },
    h('header', { className: 'dwb-us-sh' }, h('h5', null, t('usage.months.title'))),
    h('div', { className: 'dwb-us-months' }, data.months.map((month) => {
      const events = [
        month.peak == null ? null : t('usage.months.peak', { day: usageMonthDay(month.peak), tokens: usageTokens(month.peakT) }),
        ...month.newModels.map(model => t('usage.months.newModel', { name: model.n, day: usageMonthDay(model.d) })),
        month.comp > 0 ? t('usage.months.compactions', { n: month.comp }) : null,
        month.retries > 0 ? t('usage.months.retries', { n: month.retries }) : null,
      ].filter(text => text !== null)
      return h('div', { className: 'dwb-us-mo', key: month.m },
        h('div', { className: 'dwb-us-mh2' },
          h('b', null, t('usage.months.label', { year: month.m.slice(0, 4), month: Number(month.m.slice(5)) })),
          h('span', { className: 'dwb-us-cap' }, t('usage.months.summary', {
            tokens: usageTokens(month.tokens),
            cost: usageMoney(month.c),
            requests: usageCount(month.req),
            sessions: month.ses,
            days: month.days,
          }))),
        month.ws.map(workspace => h('div', { className: 'dwb-us-mw', key: workspace.n },
          h('span', { className: 'dwb-us-tr' }, workspace.n),
          h('span', { className: 'dwb-us-mb' }, h('i', { style: { width: `${Math.max(workspace.tokens / max * 100, 0.6).toFixed(1)}%` } })),
          h('span', { className: 'dwb-us-n' }, usageTokens(workspace.tokens)),
          h('span', { className: 'dwb-us-n dwb-us-cap' }, t('usage.months.requests', { n: usageCount(workspace.req) })))),
        h('div', { className: 'dwb-us-mev' }, events.map(text => h('span', { key: text }, text))))
    })))
}

const usageIsPageActive = () => usageCtx.layout.panelInfo.getSnapshot().activePanelId === USAGE_PANEL_ID

/** 完整明细共用表格；筛选、排序和展开只处理已经取得的数据。 */
function UsageDetailTable({ data, view }) {
  const t = usageT
  const [search, setSearch] = useState(''), [sort, setSort] = useState(null), [selected, setSelected] = useState(null)
  const trigger = useRef(null)
  const tools = view === 'tools'
  const list = data.breakdown?.[view] ?? []
  const nameOf = row => row.deleted ? t('usage.sessions.deleted') : view === 'providers' ? usageProviderName(row.name, t('usage.models.unknown')) : row.name ?? t(view === 'sessions' ? 'usage.sessions.untitled' : 'usage.models.unknown')
  const seconds = value => value == null ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} s`
  const columns = tools ? [
    ['calls', 'usage.details.calls', usageCount], ['errors', 'usage.details.errors', usageCount], ['errorRate', 'usage.details.errorRate', usagePercent], ['tokens', 'usage.details.tokens', usageTokens], ['duration.p50', t('usage.details.durationPercentile', { p: 'p50' }), seconds], ['duration.p90', t('usage.details.durationPercentile', { p: 'p90' }), seconds], ['duration.p99', t('usage.details.durationPercentile', { p: 'p99' }), seconds],
  ] : [
    ['req', 'usage.details.requests', usageCount], ['tokens', 'usage.details.tokens', usageTokens], ['c', 'usage.details.cost', usageMoney], ['hit', 'usage.details.hit', usagePercent], ['ttft.p50', t('usage.details.ttftPercentile', { p: 'p50' }), seconds], ['ttft.p90', t('usage.details.ttftPercentile', { p: 'p90' }), seconds], ...(view === 'providers' ? [['retries', 'usage.details.retries', usageCount], ['errors', 'usage.details.errors', usageCount]] : []),
  ]
  columns.push(['z', 'usage.details.z', usageZ], ['baselineN', 'usage.details.baseline', usageCount])
  const value = (row, key) => key.split('.').reduce((v, k) => v?.[k], row)
  const rows = list.filter(row => `${nameOf(row)} ${row.name ?? ''} ${row.ws ?? ''} ${row.preset ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  if (sort) rows.sort((a, b) => (value(b, sort) ?? -Infinity) - (value(a, sort) ?? -Infinity))
  // 展开的是哪一行按行的标识记（会话是 id，其余维度的 name 就是分组键）：刷新后行换成新对象照样展开，那一行没了才收起。
  const rowKey = row => row.id ?? row.name
  const selectedRow = selected === null ? undefined : list.find(row => rowKey(row) === selected.key)
  const close = () => { setSelected(null); trigger.current?.focus() }
  const distributions = selectedRow ? tools ? [['result', selectedRow.result, usageTokens], ['duration', selectedRow.duration, seconds]] : [['ttft', selectedRow.ttft, seconds], ['tps', selectedRow.tps, value => value == null ? '—' : usageCount(value)], ['context', selectedRow.context, usageTokens], ['output', selectedRow.output, usageTokens]] : []
  return h('section', { className: 'dwb-us-details', onKeyDown: event => { if (event.key === 'Escape' && selectedRow) { event.stopPropagation(); close() } } },
    h('div', { className: 'dwb-us-detail-controls' },
      h('span', { className: 'dwb-us-cap', role: 'status' }, t('usage.details.summary', { days: data.windowN, n: rows.length })),
      h('input', { type: 'search', value: search, 'aria-label': t('usage.details.search'), placeholder: t('usage.details.search'), onChange: event => setSearch(event.target.value) })),
    rows.length === 0 ? h('p', { role: 'status' }, t('usage.details.empty')) : h('div', { className: 'dwb-us-tablewrap', tabIndex: 0 },
      h('table', { className: 'dwb-us-detail-table' },
        h('thead', null, h('tr', null, h('th', null, t('usage.details.name')), ...columns.map(([key, label]) => h('th', { key, 'aria-sort': sort === key ? 'descending' : 'none' },
          h('button', { type: 'button', onClick: () => setSort(sort === key ? null : key) }, label.startsWith('usage.') ? t(label) : label, sort === key ? h(ui.IconChevronDownOutlineRegular) : null))))),
        h('tbody', null, rows.map((row, index) => h('tr', { key: row.id ?? row.name ?? index, className: row.anomaly ? 'hot' : undefined },
          h('td', null, h('button', { type: 'button', className: 'dwb-us-detail-name', 'aria-expanded': selectedRow === row, onClick: event => { trigger.current = event.currentTarget; setSelected(selectedRow === row ? null : { key: rowKey(row) }) } }, nameOf(row), h(selectedRow === row ? ui.IconChevronUpOutlineRegular : ui.IconChevronDownOutlineRegular)),
            row.ws ? h('small', null, row.ws) : null, row.anomaly ? h('small', { className: 'dwb-us-detail-alert' }, t('usage.details.abnormalBaseline', { value: usageTokens(row.todayTokens), median: usageTokens(row.median) })) : null),
          ...columns.map(([key, , format]) => h('td', { key }, key === 'c' && view === 'models' && data.priceMissing.includes(row.name) ? t('usage.details.noPrice') : format(value(row, key))))))))),
    selectedRow ? h('section', { className: 'dwb-us-detail-expanded' },
      h('header', null, h('h5', null, nameOf(selectedRow)), h('button', { type: 'button', 'aria-label': t('usage.details.close'), onClick: close }, h(ui.IconCloseOutlineRegular))),
      h('p', { className: 'dwb-us-cap' }, t('usage.details.today', { value: usageTokens(selectedRow.todayTokens), median: usageTokens(selectedRow.median), days: selectedRow.baselineN })),
      h('div', { className: 'dwb-us-tablewrap' }, h('table', { className: 'dwb-us-detail-table' },
        h('thead', null, h('tr', null, h('th', null, t('usage.details.distribution')), h('th', null, t('usage.details.samples')), ...['p50', 'p90', 'p99'].map(x => h('th', { key: x }, x)))),
        h('tbody', null, distributions.map(([key, stats, format]) => h('tr', { key }, h('td', null, t(`usage.details.${key}`)), h('td', null, stats.n), ...['p50', 'p90', 'p99'].map(x => h('td', { key: x }, format(stats[x])))))))),
      selectedRow.reasons && Object.keys(selectedRow.reasons).length ? h('p', { className: 'dwb-us-cap' }, Object.entries(selectedRow.reasons).map(([code, n]) => `${code}: ${n}`).join(' · ')) : null) : null)
}

/**
 * 页面入口。数字按范围分别存着，切回看过的范围不再读接口；刷新时扔掉别的范围，只重读当前的。
 */
function UsagePage() {
  const t = usageT
  const [scope, setScope] = useState('all')
  const [view, setView] = useState('overview')
  const [range, setRange] = useState(usageStoredRange)
  const clearPick = useRef(null)
  const [byScope, setByScope] = useState({})
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [balance, setBalance] = useState(null)
  const shown = useRef(undefined)
  const ticket = useRef(0)
  const alive = useRef(true)
  const monitorRef = useRef(null), jumpToMonitor = useRef(false)
  useEffect(() => {
    if (view === 'overview' && jumpToMonitor.current) { jumpToMonitor.current = false; monitorRef.current?.scrollIntoView({ block: 'start' }) }
  }, [view])
  const load = useCallback(async (target) => {
    const mine = ++ticket.current
    setLoading(true)
    setFailed(false)
    try {
      const data = await usageFetchJson(`${USAGE_OVERVIEW_PATH}?group=${target}`)
      if (target === 'all') usageCardSink?.(data)
      if (!alive.current) return
      setByScope(current => ({ ...current, [target]: data }))
      if (mine === ticket.current) setLoading(false)
    } catch {
      // 读失败时留着已有的数字，页面上给出重试；只有没有任何数字时才整页显示错误。
      if (alive.current && mine === ticket.current) {
        setLoading(false)
        setFailed(true)
      }
    }
  }, [])
  const loadBalance = useCallback(async (fresh) => {
    const block = await usageFetchBalance(fresh)
    if (alive.current) setBalance(block)
  }, [])
  useEffect(() => {
    alive.current = true
    void load('all')
    void loadBalance(false)
    return () => { alive.current = false }
  }, [load, loadBalance])
  const choose = (next) => {
    setScope(next)
    if (byScope[next] === undefined) void load(next)
  }
  const chooseRange = (next) => {
    clearPick.current?.()
    setRange(next)
    usageStoreRange(next)
  }
  const refresh = () => {
    setByScope(current => (current[scope] === undefined ? {} : { [scope]: current[scope] }))
    void load(scope)
    void loadBalance(true)
  }
  const data = byScope[scope] ?? shown.current
  if (data !== undefined) shown.current = data
  if (data === undefined) {
    return h('div', { className: 'dwb-us-page' },
      h('div', { className: 'dwb-us-pg' },
        h('div', { className: 'dwb-us-top' }, h('h4', null, t('usage.title'))),
        failed
          ? h('div', { className: 'dwb-us-state' },
            h('span', null, t('usage.error')),
            h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void load(scope) } }, t('usage.retry')))
          : h('div', { className: 'dwb-us-state' }, t('usage.loading'))))
  }
  const verdict = usageVerdict(data.vitals)
  const scopes = data.groupsAvailable.filter(group => group.id === 'all' || group.sessions > 0)
  const notes = [
    data.unreadable > 0 ? t('usage.note.unreadable', { n: data.unreadable }) : null,
    data.priceMissing.length > 0 ? t('usage.note.priceMissing', { models: data.priceMissing.join('、') }) : null,
  ].filter(note => note !== null)
  const empty = data.life.tokens === 0
  return h('div', { className: 'dwb-us-page' },
    h('div', { className: 'dwb-us-pg' },
      h('div', { className: 'dwb-us-top' },
        h('h4', null, t('usage.title')),
        h('span', { className: 'dwb-us-grow' }),
        empty ? null : h('button', {
          type: 'button',
          className: 'dwb-us-verdict',
          onClick: () => { if (view === 'overview') monitorRef.current?.scrollIntoView({ block: 'start' }); else { jumpToMonitor.current = true; setView('overview') } },
        },
        verdict.bad > 0 ? h(Fragment, null,
          h('i', { className: 'dwb-us-dot', style: { background: verdict.serious ? 'var(--dwb-us-serious)' : 'var(--dwb-us-warn)' } }),
          h('b', null, t('usage.verdict.bad', { n: verdict.bad })),
          ' · ') : null,
        t('usage.verdict.ok', { n: verdict.ok })),
        scopes.length > 2 ? h(UsageSegment, {
          id: 'dwb-us-scope',
          panelId: 'dwb-us-body',
          label: t('usage.scope'),
          value: scope,
          onChange: choose,
          options: scopes.map(group => ({ value: group.id, label: t(`usage.scope.${group.id}`) })),
        }) : null,
        h('button', { type: 'button', className: 'dwb-us-refresh', 'aria-label': t('usage.refresh'), disabled: loading, onClick: refresh },
          h(ui.IconRefreshOutlineRegular, null),
          h('span', null, loading ? t('usage.loading') : data.nowHm))),
      h('div', { className: 'dwb-us-views-scroll' }, h(UsageSegment, { id: 'dwb-us-views', panelId: 'dwb-us-view-body', label: t('usage.tabs'), value: view, onChange: setView, options: ['overview', 'sessions', 'models', 'tools', 'providers'].map(value => ({ value, label: value === 'overview' ? t('usage.tabs.overview') : t('usage.tabs.count', { name: t(`usage.tabs.${value}`), n: data.breakdown?.[value]?.length ?? 0 }) })) })),
      failed ? h('div', { className: 'dwb-us-cap' },
        t('usage.error'), ' ',
        h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void load(scope) } }, t('usage.retry'))) : null,
      notes.map(note => h('div', { className: 'dwb-us-cap', key: note }, note)),
      h('div', { id: 'dwb-us-view-body', role: 'tabpanel', 'aria-labelledby': `dwb-us-views-${view}` }, view !== 'overview' ? h(UsageDetailTable, { key: view, data, view }) : empty
        ? h('div', { className: 'dwb-us-state' }, h('b', null, t('usage.empty.title')))
        : h('div', { className: 'dwb-us-cols', id: 'dwb-us-body', role: 'tabpanel', 'aria-labelledby': `dwb-us-scope-${scope}` },
          h(UsageSide, { data, balance, range, onRange: chooseRange }),
          h('main', { className: 'dwb-us-main' },
            h(UsageCharts, { data, t, range, onRange: chooseRange, clearRef: clearPick, isPageActive: usageIsPageActive }),
            h(UsageMonitor, { data, sectionRef: monitorRef }),
            h(UsageSessions, { data }),
            h(UsageProviders, { data }),
            h(UsageCostPanels, { data }),
            h(UsageDistribution, { data }),
            h(UsageMonths, { data }))))))
}

/** 卡片常驻的记录在这台机器上，读不到时不常驻。 */
function usageCardLoadPinned() {
  try {
    return window.localStorage.getItem(USAGE_CARD_PINNED_KEY) === '1'
  } catch {
    // 存储被禁用时（隐私模式）localStorage 会抛错，不常驻是默认样子。
    return false
  }
}

function usageCardSavePinned(pinned) {
  try {
    window.localStorage.setItem(USAGE_CARD_PINNED_KEY, pinned ? '1' : '0')
  } catch {
    // 存储被禁用时这次会话里照样能常驻，只是下次不记得。
  }
}

/**
 * 展开后那几行的文字和数字。
 * @param {{today: object | null, extra: {block: object | null, official: number | null} | null, period: {peak: boolean, until: number | null} | undefined, queried: string | undefined}} facts 卡片的数据。
 * @returns {Array<{key: string, label: string, value?: string, tone?: string, gap?: boolean}>} 每行一个对象。
 */
function usageCardRows({ today, extra, period, queried }) {
  const t = usageT
  const rows = []
  if (today !== null) {
    if (today.bad > 0) rows.push({ key: 'bad', label: t('usage.verdict.bad', { n: today.bad }), tone: 'warn' })
    rows.push({ key: 'requests', label: t('usage.card.requests'), value: usageCount(today.requests) })
    rows.push({ key: 'cost', label: t('usage.card.cost'), value: usageMoney(today.cost) })
  }
  const block = extra?.block ?? null
  if (block !== null) {
    let gap = true
    const add = row => { rows.push({ ...row, gap }); gap = false }
    block.balances.forEach((balance, index) => {
      add({ key: `balance-${balance.currency}`, label: index === 0 ? t('usage.balance.deepseek') : balance.currency, value: usageBalanceText(balance) })
    })
    if (block.balances.length > 0 && extra.official > 0) add({ key: 'official', label: t('usage.card.official'), value: usageMoney(extra.official) })
    if (block.balances.length > 0 && period !== undefined && period.until !== null) {
      const time = usageResetTime(new Date(period.until).toISOString())
      add({ key: 'peak', label: t(period.peak ? 'usage.card.peak' : 'usage.card.offPeak', { time }) })
    }
    for (const plan of usageCardPlans(block.plans)) {
      const windowName = USAGE_QUOTA_LABELS[plan.key] === undefined ? plan.key : t(USAGE_QUOTA_LABELS[plan.key])
      add({ key: `plan-${plan.id}`, label: `${plan.name} ${windowName}`, value: `${plan.percent.toFixed(0)}%`, tone: plan.percent >= USAGE_QUOTA_HOT_PERCENT ? 'value-warn' : undefined })
    }
    for (const problem of block.problems) {
      add({
        key: `problem-${problem.id}`,
        label: t(problem.stale ? 'usage.quota.stale' : 'usage.quota.problem', { name: problem.name, state: t(`usage.quota.state.${problem.state}`), time: usageLocalTime(problem.queriedAt) }),
      })
    }
  }
  if (queried !== undefined) rows.push({ key: 'queried', label: t('usage.balance.queried', { time: queried }), gap: true })
  return rows
}

/**
 * 侧边栏底部的速览卡片，也是用量主页唯一的入口。默认一行今日用量；鼠标停上去展开，移开收回；右边的按钮让它常驻，
 * 再点一下、按 Esc 收回，收回后鼠标移开之前不再因为悬停展开。点卡片打开用量主页，已经打开时回到会话。
 * 没有定时器：挂载、窗口回到前台、有会话结束、展开时才考虑读，判断见 usageCardShouldRead。悬停展开的延迟也由 CSS 动画做，
 * 动画开始（鼠标真的停住了）才读。余额只在展开时读，宿主有 5 分钟缓存。
 * @param {{wide: boolean}} props 侧边栏是不是展开状态；收成图标栏时只留一个图标入口，不读数据。
 * @returns {object} 卡片。
 */
function UsageCard({ wide }) {
  const t = usageT
  const [pinned, setPinned] = useState(usageCardLoadPinned)
  const [hover, setHover] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const [overview, setOverview] = useState(null)
  const [extra, setExtra] = useState(null)
  const subscribePanel = useCallback(listener => usageCtx.layout.panelInfo.subscribe(listener), [])
  const active = React.useSyncExternalStore(subscribePanel, () => usageCtx.layout.panelInfo.getSnapshot().activePanelId === USAGE_PANEL_ID)
  const open = pinned || (hover && !quiet)
  const sync = useRef({ readAt: null, extraAt: null, dirty: false, busy: false, open, hover: false, alive: false })
  sync.current.open = open
  const readExtra = useCallback(async (force) => {
    const state = sync.current
    const now = Date.now()
    if (!force && state.extraAt !== null && now - state.extraAt < USAGE_CARD_MIN_GAP_MS) return
    state.extraAt = now
    const block = await usageFetchBalance(false)
    let official = null
    if (block !== null && block.balances.length > 0) {
      try {
        const cost = await usageFetchJson(`${USAGE_COST_PATH}?providers=deepseek-official&since=${usageLocalMidnight(now)}`)
        official = cost.c
      } catch {
        // 本机估算读不到：只少「今日费用」这一行。
      }
    }
    if (state.alive) setExtra({ block, official })
  }, [])
  const read = useCallback(async () => {
    const state = sync.current
    if (state.busy) return
    state.busy = true
    state.dirty = false
    try {
      const data = await usageFetchJson(`${USAGE_OVERVIEW_PATH}?group=all`)
      state.readAt = Date.now()
      if (state.alive) setOverview(data)
    } catch {
      // 读失败时留着上次的数字，窗口下次回到前台再读。
      state.dirty = true
    }
    state.busy = false
    if (state.open && state.alive) void readExtra(true)
  }, [readExtra])
  const consider = useCallback(() => {
    const state = sync.current
    const focused = document.visibilityState === 'visible' && document.hasFocus()
    if (usageCardShouldRead({ readAt: state.readAt, dirty: state.dirty, focused, now: Date.now() })) void read()
  }, [read])
  const collapse = useCallback(() => {
    usageCardSavePinned(false)
    setPinned(false)
    setQuiet(sync.current.hover)
  }, [])
  useEffect(() => {
    if (!wide) return undefined
    const state = sync.current
    state.alive = true
    const status = usageCtx.uiSession.sessionStatus
    let before = status.getSnapshot()
    const offStatus = status.subscribe(() => {
      const after = status.getSnapshot()
      const finished = usageSessionFinished(before, after)
      before = after
      if (finished) {
        state.dirty = true
        consider()
      }
    })
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const action = usageCardEscapeAction({
        open: state.open,
        pageActive: usageIsPageActive(),
        hovering: state.hover,
        typing: usageCardTyping(event.target),
        blocked: document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]') !== null,
      })
      if (action === 'collapse') collapse()
      else if (action === 'close-page') usageCtx.layout.selectPanel(null)
    }
    window.addEventListener('focus', consider)
    document.addEventListener('visibilitychange', consider)
    document.addEventListener('keydown', onKey)
    usageCardSink = data => {
      state.readAt = Date.now()
      state.dirty = false
      setOverview(data)
      if (state.open) void readExtra(true)
    }
    consider()
    if (state.open) void readExtra(false)
    return () => {
      state.alive = false
      usageCardSink = null
      offStatus()
      window.removeEventListener('focus', consider)
      document.removeEventListener('visibilitychange', consider)
      document.removeEventListener('keydown', onKey)
    }
  }, [wide, consider, readExtra, collapse])
  const go = () => { usageCtx.layout.selectPanel(active ? null : USAGE_PANEL_ID) }
  if (!wide) {
    return h(ui.Tooltip, { label: t('usage.panel'), delayMs: 500 },
      h('button', {
        type: 'button',
        className: 'dwb-us-glance-rail',
        'aria-label': t('usage.panel'),
        'aria-current': active ? 'page' : undefined,
        onClick: go,
      }, h(ui.IconDataOutlineRegular, null)))
  }
  const reveal = () => {
    void readExtra(false)
    consider()
  }
  const toggle = () => {
    if (pinned) {
      collapse()
      return
    }
    usageCardSavePinned(true)
    setPinned(true)
    setQuiet(false)
    reveal()
  }
  const today = overview === null ? null : usageCardToday(overview)
  const value = today === null ? '—' : `${usageTokens(today.tokens)} ${t('usage.hero.unit')}`
  const rows = open ? usageCardRows({ today, extra, period: overview?.period, queried: overview?.nowHm }) : []
  const spoken = [t('usage.card.open'), t('usage.card.today'), value, ...rows.map(row => [row.label, row.value].filter(Boolean).join(' '))]
  return h('div', {
    className: 'dwb-us-glance',
    onMouseEnter: () => {
      sync.current.hover = true
      setHover(true)
    },
    onMouseLeave: () => {
      sync.current.hover = false
      setHover(false)
      setQuiet(false)
    },
  },
  h('button', {
    type: 'button',
    className: 'dwb-us-glance-main',
    'aria-label': spoken.join('，'),
    'aria-current': active ? 'page' : undefined,
    onClick: go,
  },
  h('div', { className: 'dwb-us-glance-head' },
    h(ui.IconDataOutlineRegular, null),
    h('span', null, t('usage.card.today')),
    today !== null && today.bad > 0 ? h('i', { className: 'dwb-us-dot', style: { background: today.serious ? 'var(--dwb-us-serious)' : 'var(--dwb-us-warn)' } }) : null,
    h('b', null, value)),
  open ? h('div', {
    className: 'dwb-us-glance-body',
    'data-reveal': pinned ? undefined : 'true',
    onAnimationStart: reveal,
  }, rows.map(row => h('div', {
    className: 'dwb-us-glance-row',
    key: row.key,
    'data-tone': row.tone === 'warn' ? 'warn' : undefined,
    'data-gap': row.gap ? 'true' : undefined,
  },
  h('span', null, row.label),
  row.value === undefined ? null : h('b', { 'data-tone': row.tone === 'value-warn' ? 'warn' : undefined }, row.value)))) : null),
  h('button', {
    type: 'button',
    className: 'dwb-us-glance-toggle',
    'aria-label': t(pinned ? 'usage.card.collapse' : 'usage.card.expand'),
    'aria-expanded': pinned,
    onClick: toggle,
  }, h(pinned ? ui.IconChevronDownOutlineRegular : ui.IconChevronUpOutlineRegular, null)))
}

/**
 * 挂载用量主页（插件页里这一行开着时调用）：侧边栏卡片和主区页面。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数，这一行关掉时撤掉全部。
 */
export function applyUsage(app) {
  const { ctx } = app
  usageCtx = ctx
  usageStore = app.store
  usageT = app.t
  const disposers = [mountModuleStyle('dsh-workbench-usage', USAGE_CSS)]
  disposers.push(ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: USAGE_CARD_ID,
    locale: '@miint-sunny/dsh-workbench',
  }, UsageCard)), '@miint-sunny/dsh-workbench/usage: sidebar card'))
  disposers.push(ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: USAGE_PANEL_ID,
      locale: '@miint-sunny/dsh-workbench',
      children: { [USAGE_PALETTE_SLOT]: { kind: 'list', scope: 'root' } },
    }, UsagePage)
    yield ctx.slots.register({
      name: USAGE_PALETTE_SLOT,
      id: USAGE_PANEL_ID,
      label: () => app.t('usage.paletteLabel'),
    }, () => null)
  }), '@miint-sunny/dsh-workbench/usage: page'))
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    usageCtx = undefined
    usageStore = undefined
    usageT = undefined
  }
}

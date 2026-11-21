/**
 * 用量页最上面的图：第一张（六个范围，热力图或柱状图）、第二张（详情）和每张图下面的数字。
 * 范围由页面持有（左侧汇总跟着它），存在这台机器上；详情开关同样存着，指标和选中在 UsageCharts 里不存。计算在 usage-charts.js。
 * 点一格或一根柱子时，没开详情的话数字留在第一张下面，开了详情的话第二张的图和数字跟过去。
 */
import { usageTokens, usageMoney, usageCount, usagePercent, usageMonthDay, usageHeatLevel } from './usage-model.js'
import { USAGE_RANGES, USAGE_SMALL_RANGES, USAGE_DEFAULT_RANGE, usageIsSmallRange, usageHeatGridOf, usageHeatTracks, usageHeatCuts, usageHeatMove, usageRangeStats, usageBarMove, usageBarView, usageBarAxis, usageBarGeometry, usageSigned, usageViewStats, usageHourStats, usagePickStats } from './usage-charts.js'

const USAGE_RANGE_KEY = 'dsh-workbench.usage.range'
const USAGE_DETAILS_KEY = 'dsh-workbench.usage.details'
const USAGE_METRICS = [['tokens', 'usage.metric.tokens'], ['c', 'usage.metric.cost'], ['n', 'usage.metric.requests']]
const USAGE_HEAT_KEYS_ID = 'dwb-us-heat-keys'
/** 30 天和 1 年边长相同，宽度刚好放下 30 列。38px 是纵轴，2px 是格子间距。 */
const USAGE_CELL_SAME = 'clamp(10px,calc((100cqw - 38px) / 30 - 2px),22px)'

function usageChartRead(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // 存储被禁用时（隐私模式）localStorage 会抛错，用默认值。
    return null
  }
}

function usageChartWrite(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 存储被禁用时这次照样能切，只是下次不记得。
  }
}

/** @returns {string} 上次选的范围；没存过或存的值不认识时是默认范围。 */
export function usageStoredRange() {
  const stored = usageChartRead(USAGE_RANGE_KEY)
  return USAGE_RANGES.includes(stored) ? stored : USAGE_DEFAULT_RANGE
}

/** @param {string} range 要记住的范围。 */
export function usageStoreRange(range) {
  usageChartWrite(USAGE_RANGE_KEY, range)
}

/**
 * 范围的分段标签。页面里有两个实例（窄布局放在左侧汇总上面，宽布局放在图的控制行里），共用同一个状态，各自的 id 不同。
 * @param {{t: Function, id: string, value: string, onChange: (range: string) => void, className?: string}} props 当前范围和选择回调。
 * @returns {object} 分段标签。
 */
export function UsageRangeTabs({ t, id, value, onChange, className }) {
  return h(UsageSegment, {
    id,
    panelId: 'dwb-us-chart-panel',
    className,
    label: t('usage.range.label'),
    value,
    onChange,
    options: USAGE_RANGES.map(range => ({ value: range, label: t(`usage.range.${range}`) })),
  })
}

/**
 * 按键的目标是不是在打字。
 * @param {EventTarget | null} target 事件目标。
 * @returns {boolean} 焦点在输入框里时是真。
 */
export function usageCardTyping(target) {
  return target instanceof Element && target.closest('input,textarea,[contenteditable="true"]') !== null
}

/**
 * DSH 的分段标签，字号和高度压到数据页的密度（样式在 .dwb-us-seg）。
 * `value` 不在选项里时一个都不选中，这时加 `dwb-us-seg-none` 把滑块藏起来。
 */
export function UsageSegment({ id, label, value, onChange, options, panelId, className = '' }) {
  const none = options.every(option => option.value !== value)
  return h(ui.SegmentedTabs, {
    className: `dwb-us-seg ${className}${none ? ' dwb-us-seg-none' : ''}`,
    size: 'sm',
    label,
    value,
    onChange,
    items: options.map(option => ({ ...option, id: `${id}-${option.value}`, panelId })),
  })
}

function usageChartTotal(t, use, metric) {
  if (metric === 'tokens') return t('usage.chart.totalTokens', { value: usageTokens(use.tokens) })
  return metric === 'c' ? usageMoney(use.c) : t('usage.chart.totalRequests', { value: usageCount(use.n) })
}

function usageChartTick(value, metric) {
  if (metric === 'tokens') return usageTokens(value)
  if (metric === 'c') return usageMoney(value, value >= 0.1 ? 2 : value >= 0.01 ? 3 : 4)
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function usageChartAria(t, label, use) {
  return t('usage.chart.cell', { label, tokens: usageTokens(use.tokens), cost: usageMoney(use.c), n: usageCount(use.n) })
}

const usageHourLabel = (t, slot) => `${usageMonthDay(slot.day)} ${t('usage.chart.hour', { hour: slot.hour })}`
/** 「数值 · 日期」：窄的时候在点后面换行，日期不断开。 */
const usageValueAt = (value, at) => h(Fragment, null, `${value} · `, h('i', null, at))
const usagePeakHour = (t, peak) => (peak === null ? '—' : usageValueAt(usageTokens(peak.use.tokens), t('usage.chart.hour', { hour: String(peak.hour).padStart(2, '0') })))

export function usageRangeFacts(t, data, range) {
  const stats = usageRangeStats(data, range)
  return [
    [t('usage.life.active'), stats.activeDays],
    [t('usage.life.streak'), t('usage.life.days', { n: stats.streak })],
    [t('usage.life.longest'), t('usage.life.days', { n: stats.longest })],
    [t('usage.life.median'), usageTokens(stats.median)],
    [t('usage.life.peak'), stats.peakDay === null ? '—' : usageValueAt(usageTokens(stats.peakTokens), usageMonthDay(stats.peakDay))],
    [t('usage.life.busy'), stats.busyWd == null ? '—' : t('usage.life.busyAt', { weekday: t(`usage.weekday.${stats.busyWd}`), hour: String(stats.busyHour).padStart(2, '0') })],
  ]
}

/**
 * 柱状图下面没有选中时的数字。
 * @param {Function} t 翻译函数。
 * @param {object} view `usageBarView` 的结果。
 * @param {boolean} [trim] 为真时去掉左侧汇总已经写出的合计 token、费用和模型请求（第一张图）；第二张图不去。
 * @returns {Array<[string, any]>} 名称和值。
 */
export function usageViewFacts(t, view, trim = false) {
  const stats = usageViewStats(view)
  const total = [
    [t('usage.metric.cost'), usageMoney(stats.cost)],
    [t('usage.metric.requests'), usageCount(stats.requests)],
  ]
  if (!stats.lines) {
    return [
      [t('usage.life.active'), stats.activeDays],
      [t('usage.chart.activeHours'), stats.activeHours],
      [t('usage.chart.medianHour'), usageTokens(stats.medianHour)],
      [t('usage.chart.peakHour'), stats.peak === null ? '—' : usageValueAt(usageTokens(stats.peak.use.tokens), usageHourLabel(t, stats.peak))],
      ...(trim ? [] : total),
    ]
  }
  return [
    ...(trim ? [] : [[t('usage.chart.cumulative'), usageTokens(stats.tokens)]]),
    [t('usage.chart.vsMedian'), usageSigned(stats.vsMedian)],
    ...(trim ? [] : total),
    [t('usage.chart.activeHours'), stats.activeHours],
    [t('usage.chart.peakHour'), usagePeakHour(t, stats.peak)],
  ]
}

function usageHourFacts(t, view, index) {
  const stats = usageHourStats(view, index)
  return [
    [t('usage.metric.tokens'), usageTokens(stats.tokens)],
    [t('usage.metric.cost'), usageMoney(stats.cost)],
    [t('usage.metric.requests'), usageCount(stats.requests)],
    ...(stats.cum === null ? [] : [[t('usage.chart.cumulative'), usageTokens(stats.cum)]]),
    [t('usage.chart.shareOfWindow'), usagePercent(stats.share, 0)],
  ]
}

function usagePickFacts(t, data, pick, range) {
  const stats = usagePickStats(data, pick, range)
  const common = [
    [t('usage.metric.tokens'), usageTokens(stats.tokens)],
    [t('usage.metric.cost'), usageMoney(stats.cost)],
    [t('usage.metric.requests'), usageCount(stats.requests)],
  ]
  if (stats.whole) {
    return [
      ...common,
      [t('usage.chart.activeHours'), stats.activeHours ?? '—'],
      [t('usage.chart.peakHour'), usagePeakHour(t, stats.peak)],
      [t('usage.chart.vsActiveMedian'), usageSigned(stats.vsActiveMedian)],
    ]
  }
  return [
    ...common,
    [t('usage.chart.shareOfDay'), usagePercent(stats.shareOfDay, 0)],
    [t('usage.chart.dayTotal'), usageTokens(stats.dayTokens)],
    [t('usage.chart.dayVsMedian'), usageSigned(stats.dayVsMedian)],
  ]
}

/** `fit` 为真时列数跟着项数走（3 项三列、4 项四列，窄的时候 4 项两列），不留空格。 */
function UsageFacts({ label, items, fit = false }) {
  return h('div', { className: 'dwb-us-facts', 'aria-live': 'polite' },
    label ? h('div', { className: 'dwb-us-factlabel' }, label) : null,
    h('div', { className: 'dwb-us-hstats', 'data-fit': fit ? items.length : undefined }, items.map(([name, value]) => h('div', { key: name }, h('span', null, name), h('b', null, value)))))
}

/**
 * 热力图。方格是正方形，放不下时往左滚动，打开时停在最右边，选中格子不改变滚动位置。`fitAll` 时按列数缩放，尽量一屏放下。
 * 键盘只有一个停靠点（默认是最后一格，也就是现在），方向键在格子之间走。
 */
function UsageHeatMap({ t, grid, metric, selected, onPick, ariaLabel, fitAll }) {
  const scroller = useRef(null)
  const [focus, setFocus] = useState(null)
  React.useLayoutEffect(() => {
    scroller.current.scrollLeft = scroller.current.scrollWidth
  }, [grid])
  const { template, lineOf } = useMemo(() => usageHeatTracks(grid), [grid])
  const cuts = useMemo(() => usageHeatCuts(grid.cells.map(cell => cell.use[metric])), [grid, metric])
  const head = grid.kind === 'days' ? 2 : 1
  const allRows = `1 / span ${grid.rows + head}`
  const tabStop = grid.cells[focus] === undefined ? grid.cells.length - 1 : focus
  const monthNames = t('usage.heat.months').split(',')
  const cellLabel = cell => (cell.size === 24 ? usageMonthDay(cell.day) : `${usageMonthDay(cell.day)} ${t('usage.chart.hours', { from: cell.from, to: cell.from + cell.size })}`)
  const onClick = (event) => {
    const button = event.target.closest('[data-index]')
    if (button === null) return
    const index = Number(button.dataset.index)
    setFocus(index)
    onPick(grid.cells[index], index, cellLabel(grid.cells[index]))
  }
  const onKeyDown = (event) => {
    const index = Number(event.target.dataset?.index)
    if (Number.isNaN(index)) return
    const next = usageHeatMove(grid.cells, index, event.key)
    if (next === null) return
    event.preventDefault()
    setFocus(next)
    event.currentTarget.querySelector(`[data-index="${next}"]`)?.focus()
  }
  const cellSize = fitAll ? `clamp(8px,calc((100cqw - 38px) / ${grid.cols} - 2px),22px)` : USAGE_CELL_SAME
  return h(Fragment, null,
    h('p', { id: USAGE_HEAT_KEYS_ID, hidden: true }, t('usage.heat.keyboard')),
    h('div', { className: 'dwb-us-hscroll', ref: scroller },
      h('div', {
        className: 'dwb-us-hgrid',
        role: 'group',
        'aria-label': ariaLabel,
        'aria-describedby': USAGE_HEAT_KEYS_ID,
        style: { '--cell': cellSize, gridTemplateColumns: template, gridTemplateRows: `18px ${head === 2 ? '16px ' : ''}repeat(${grid.rows},var(--cell))` },
        onClick,
        onKeyDown,
      },
      h('i', { className: 'dwb-us-axbg', style: { gridColumn: 1, gridRow: allRows } }),
      grid.rules.map(col => h('i', { key: col, className: 'dwb-us-rule', style: { gridColumn: lineOf[col] - 1, gridRow: allRows } })),
      grid.months.map(span => h('span', {
        key: span.from,
        className: `dwb-us-month${span.end ? ' end' : ''}`,
        style: { gridColumn: `${lineOf[span.from]} / ${lineOf[span.to] + 1}`, gridRow: 1 },
      }, h('b', null, monthNames[span.month - 1]))),
      grid.kind === 'days' ? grid.dayLabels.map(day => h('span', {
        key: day.col,
        className: `dwb-us-dn${day.minor ? ' minor' : ''}${day.today ? ' today' : ''}`,
        style: { gridColumn: lineOf[day.col], gridRow: 2 },
      }, day.date)) : null,
      grid.rowLabels.map(row => h('span', {
        key: row.row,
        className: 'dwb-us-yl',
        style: { gridColumn: 1, gridRow: `${row.row + head + 1} / span ${row.span}` },
      }, grid.kind === 'days' ? t('usage.chart.hour', { hour: row.hour }) : t(`usage.weekday.${row.weekday}`))),
      grid.cells.map((cell, index) => h('button', {
        key: index,
        type: 'button',
        className: `dwb-us-cell dwb-us-l${usageHeatLevel(cell.use[metric], cuts)}${cell.now ? ' now' : ''}${selected === index ? ' sel' : ''}`,
        'data-index': index,
        tabIndex: index === tabStop ? 0 : -1,
        'aria-pressed': selected === index,
        'aria-label': usageChartAria(t, cellLabel(cell), cell.use),
        style: { gridColumn: lineOf[cell.col], gridRow: cell.row + head + 1 },
      })))),
    h('div', { className: 'dwb-us-hfoot' },
      h('span', { className: 'dwb-us-hl' },
        t('usage.heat.less'), ' ',
        [0, 1, 2, 3, 4].map(level => h('i', { key: level, style: { background: `var(--dwb-us-h${level})` } })),
        ' ', t('usage.heat.more'))))
}

/**
 * 柱状图。柱子和线单位相同，共用一条高轴。今日、24 小时和某一天有线，线是重点，柱子用灰色；7 天只有柱子，用蓝色。
 * @param {{warn: boolean, baselineDays: number, today: string}} props 今天的 token 反常时线变成黄色。
 */
function UsageBarChart({ t, view, selected, lit, onBar, warn, baselineDays, today }) {
  const [focus, setFocus] = useState(null)
  const geometry = useMemo(() => usageBarGeometry(view), [view])
  const axis = useMemo(() => usageBarAxis(view), [view])
  const count = view.slots.length
  const at = index => `${(index / count * 100).toFixed(3)}%`
  const tabStop = focus !== null && focus <= view.last ? focus : (selected ?? view.last)
  const lineColor = warn ? 'var(--dwb-us-warn)' : 'var(--dwb-us-accent)'
  const onClick = (event) => {
    const button = event.target.closest('[data-index]')
    if (button === null || button.disabled) return
    const index = Number(button.dataset.index)
    setFocus(index)
    onBar(view.slots[index], index)
  }
  const onKeyDown = (event) => {
    const index = Number(event.target.dataset?.index)
    if (Number.isNaN(index)) return
    const next = usageBarMove(view.last, index, event.key)
    if (next === null) return
    event.preventDefault()
    setFocus(next)
    event.currentTarget.querySelector(`[data-index="${next}"]`)?.focus()
  }
  return h(Fragment, null,
    h('div', { className: 'dwb-us-rchart' },
      h('div', { className: 'dwb-us-ry', 'aria-hidden': true },
        view.empty ? null : h('span', { style: { top: 0 } }, usageChartTick(view.top, view.metric)),
        view.empty ? null : h('span', { style: { top: '50%' } }, usageChartTick(view.top / 2, view.metric)),
        h('span', { style: { top: '100%' } }, '0')),
      h('div', { className: 'dwb-us-rplot' },
        h('i', { className: 'dwb-us-gl', style: { top: 0 } }),
        h('i', { className: 'dwb-us-gl', style: { top: '50%' } }),
        h('i', { className: 'dwb-us-gl base', style: { top: '100%' } }),
        axis.seps.map(index => h('i', { key: index, className: 'dwb-us-ds', style: { left: at(index) } })),
        geometry.band === null ? null : h('svg', { className: 'dwb-us-rlay', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true }, h('path', { className: 'band', d: geometry.band })),
        h('div', {
          className: `dwb-us-rbars${view.lines ? '' : ' blue'}`,
          style: { '--n': count, '--g': count > 48 ? '1px' : '2px' },
          onClick,
          onKeyDown,
        }, view.slots.map((slot, index) => {
          const label = usageHourLabel(t, slot)
          return h('button', {
            key: index,
            type: 'button',
            className: `dwb-us-rcol${lit(slot) ? ' inbin' : ''}${selected === index ? ' sel' : ''}`,
            'data-index': index,
            disabled: slot.future,
            tabIndex: index === tabStop ? 0 : -1,
            'aria-pressed': selected === index,
            'aria-label': slot.future ? label : usageChartAria(t, label, slot.use),
          }, geometry.heights[index] > 0 ? h('i', { style: { height: `max(1px,${geometry.heights[index].toFixed(2)}%)` } }) : null)
        })),
        view.lines ? h('svg', { className: 'dwb-us-rlay', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true },
          geometry.median === null ? null : h('path', { className: 'med', d: geometry.median }),
          h('path', { className: 'cum', d: geometry.cum, style: { stroke: lineColor } })) : null,
        view.lines ? h('i', { className: 'dwb-us-rdot', style: { left: `${geometry.dot.left}%`, top: `${geometry.dot.top}%`, background: lineColor } }) : null),
      h('div', { className: 'dwb-us-rx', 'aria-hidden': true }, axis.labels.map((label, order) => h('span', {
        key: label.index,
        // 窄到放不下时，7 天隔一天写日期，24 小时不写紧跟在日期后面的那个时刻（样式 .alt）。
        className: `${label.kind}${(view.kind === '7d' && label.index % 48 === 24) || axis.labels[order - 1]?.kind === 'date' && view.kind === '24h' ? ' alt' : ''}`,
        style: { left: at(label.index) },
      }, label.kind === 'date' ? usageMonthDay(label.day) : t('usage.chart.hour', { hour: label.hour }))))),
    view.lines ? h('div', { className: 'dwb-us-hfoot' },
      h('span', { className: 'dwb-us-lg' },
        h('span', null, h('i', { className: 'ln', style: { background: lineColor } }), t(view.end === today && view.kind !== '24h' ? 'usage.chart.today' : 'usage.chart.cumulative')),
        view.base === null ? null : h('span', null, h('i', { className: 'ln dash' }), t('usage.chart.median')),
        view.base === null ? null : h('span', null, h('i', { className: 'ar' }), t('usage.chart.band', { n: baselineDays })),
        h('span', null, h('i', { className: 'bar' }), t('usage.chart.perHour')))) : null)
}

/**
 * 用量页最上面这一块。
 * @param {{data: object, t: Function, range: string, onRange: (range: string) => void, clearRef: {current: (() => void) | null}, isPageActive: () => boolean}} props `range` 是页面持有的范围；`clearRef` 由页面给，这里把清掉选中的函数放进去，页面换范围时在同一个事件里先调用它，所以新范围的第一次渲染没有旧的选中；`isPageActive` 判断用量页是不是当前页面，不是时 Esc 不归这里。
 * @returns {object} 一张或两张图。
 */
export function UsageCharts({ data, t, range, onRange, clearRef, isPageActive }) {
  const [metric, setMetric] = useState('tokens')
  const [details, setDetails] = useState(() => usageChartRead(USAGE_DETAILS_KEY) === '1')
  const [recent, setRecent] = useState('today')
  const [pick, setPick] = useState(null)
  const [bar, setBar] = useState(null)
  const clear = useCallback(() => {
    setPick(null)
    setBar(null)
  }, [])
  clearRef.current = clear
  useEffect(() => { clear() }, [data, clear])
  const selecting = pick !== null || bar !== null
  useEffect(() => {
    if (!selecting) return undefined
    // 捕获阶段先拿到 Esc，取消选中后标记已处理，今日用量卡片的 Esc 就不再收卡片或关页面。
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isPageActive()) return
      if (usageCardTyping(event.target) || document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]') !== null) return
      event.preventDefault()
      clear()
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [selecting, clear, isPageActive])

  const small = usageIsSmallRange(range)
  const pickDay = pick?.day ?? null
  const topView = useMemo(() => (small ? usageBarView(data, range, data.today, metric) : null), [data, range, metric, small])
  const grid = useMemo(() => (small ? null : usageHeatGridOf(data, range)), [data, range, small])
  const detailView = useMemo(() => {
    if (!details) return null
    return pickDay === null ? usageBarView(data, recent, data.today, metric) : usageBarView(data, 'day', pickDay, metric)
  }, [data, details, pickDay, recent, metric])

  const chooseRecent = (next) => {
    setRecent(next)
    clear()
  }
  const toggleDetails = () => {
    usageChartWrite(USAGE_DETAILS_KEY, details ? '0' : '1')
    setDetails(!details)
    setBar(null)
  }
  const pickCell = (cell, index, label) => {
    setBar(null)
    setPick(current => (current?.source === 'cell' && current.index === index ? null : { source: 'cell', index, day: cell.day, from: cell.from, size: cell.size, use: cell.use, label }))
  }
  const pickBar = (slot, index) => {
    setBar(null)
    setPick(current => (current?.source === 'bar' && current.index === index ? null : { source: 'bar', index, day: slot.day, from: slot.hour, size: 1, use: slot.use, label: usageHourLabel(t, slot) }))
  }

  const tokenAnomaly = data.vitals.find(vital => vital.key === 'token')?.anomaly === true
  const warnOf = view => tokenAnomaly && metric === 'tokens' && view.end === data.today && view.kind !== '24h'
  const title = range === 'all' ? t('usage.chart.title.all', { day: data.life.first }) : t(`usage.chart.title.${range}`)
  const pickHere = pick !== null && !details
  const lit = slot => pick !== null && pick.size < 24 && slot.day === pick.day && slot.hour >= pick.from && slot.hour < pick.from + pick.size
  const noHours = pick !== null && pick.size === 24 && pick.use.tokens > 0 && detailView?.total.tokens === 0

  return h(Fragment, null,
    h('section', { className: 'dwb-us-sec dwb-us-chart', 'aria-label': title },
      h('div', { className: 'dwb-us-ctl' },
        h(UsageRangeTabs, { t, id: 'dwb-us-chart-range', value: range, onChange: onRange, className: 'dwb-us-seg-range dwb-us-seg-wide' }),
        h('span', { className: 'dwb-us-grow' }),
        h(UsageSegment, {
          id: 'dwb-us-chart-metric',
          panelId: 'dwb-us-chart-panel',
          label: t('usage.chart.metric'),
          value: metric,
          onChange: setMetric,
          options: USAGE_METRICS.map(([value, key]) => ({ value, label: t(key) })),
        }),
        h(ui.Button, { variant: 'outline', size: 'sm', className: 'dwb-us-chart-toggle', 'aria-pressed': details, onClick: toggleDetails }, t('usage.chart.details'))),
      h('div', { className: 'dwb-us-chartbody', id: 'dwb-us-chart-panel', role: 'tabpanel', 'aria-labelledby': `dwb-us-chart-range-${range}` },
        small
          ? h(UsageBarChart, { key: range, t, view: topView, selected: pick?.source === 'bar' ? pick.index : null, lit: () => false, onBar: pickBar, warn: warnOf(topView), baselineDays: data.baselineDays, today: data.today })
          : h(UsageHeatMap, { key: range, t, grid, metric, selected: pick?.source === 'cell' ? pick.index : null, onPick: pickCell, ariaLabel: t('usage.chart.aria', { title, n: usageRangeStats(data, range).activeDays }), fitAll: range === 'all' })),
      h(UsageFacts, pickHere
        ? { label: pick.label, items: usagePickFacts(t, data, pick, range) }
        : { label: null, fit: true, items: small ? usageViewFacts(t, topView, true) : usageRangeFacts(t, data, range) })),
    details ? h('section', { className: 'dwb-us-sec dwb-us-chart' },
      h('header', { className: 'dwb-us-sh dwb-us-sh-inline' },
        h('h5', null,
          pick === null ? t(`usage.chart.title.${recent}`) : pick.day === data.today ? t('usage.chart.title.today') : usageMonthDay(pick.day),
          ' ',
          h('span', null, usageChartTotal(t, pick?.size === 24 ? pick.use : detailView.total, metric))),
        h(UsageSegment, {
          id: 'dwb-us-detail-range',
          panelId: 'dwb-us-detail-panel',
          label: t('usage.chart.recent'),
          value: pick === null ? recent : null,
          onChange: chooseRecent,
          options: USAGE_SMALL_RANGES.map(value => ({ value, label: t(`usage.range.${value}`) })),
        })),
      h('div', { className: 'dwb-us-chartbody', id: 'dwb-us-detail-panel', role: 'tabpanel', 'aria-labelledby': `dwb-us-detail-range-${recent}` },
        noHours ? h('p', { className: 'dwb-us-cap' }, t('usage.chart.noHours')) : null,
        h(UsageBarChart, {
          key: pickDay ?? recent,
          t,
          view: detailView,
          selected: bar,
          lit,
          onBar: (slot, index) => { setBar(current => (current === index ? null : index)) },
          warn: warnOf(detailView),
          baselineDays: data.baselineDays,
          today: data.today,
        })),
      h(UsageFacts, bar !== null
        ? { label: usageHourLabel(t, detailView.slots[bar]), items: usageHourFacts(t, detailView, bar) }
        : pick !== null
          ? { label: pick.label, items: usagePickFacts(t, data, pick, range) }
          : { label: null, items: usageViewFacts(t, detailView) })) : null)
}

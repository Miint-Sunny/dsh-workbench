/** 紧凑的上下文页：用量、按会话的压缩下拉、构成表；/context 与原生 guide 共享入口，兼容 better-sidebar。 */
import { mountModuleStyle } from './style.js'
const CONTEXT_INJECT = ['sidebarRight', 'resources', 'commandUi', 'uiSession']
const CONTEXT_TAB = 'dsh-workbench-context',
  CONTEXT_PROTOCOL = 'wbcontext',
  CONTEXT_PREFIX = 'dsh-resource://wbcontext/'
const CONTEXT_STYLE = `
.dwb-ctx {
  --ctx-line: var(--dsw-alias-border-l2);
  --ctx-muted: var(--dsw-alias-label-tertiary);
  --ctx-second: var(--dsw-alias-label-secondary);
  --ctx-blue: #3987e5;
  --ctx-g1: color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent);
  --ctx-g2: color-mix(in srgb, var(--dsw-alias-label-primary) 32%, transparent);
  --ctx-res: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  --ctx-track: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  height: 100%;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  padding: 12px 14px;
  box-sizing: border-box;
}
.dwb-ctx * {
  box-sizing: border-box;
  min-width: 0;
}
.dwb-ctx > * {
  max-width: 560px;
}
.dwb-ctx p,
.dwb-ctx h3 {
  margin: 0;
}
.dwb-ctx-use {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--ctx-second);
}
.dwb-ctx-use b {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
  font-size: 14px;
}
.dwb-ctx-use > span:last-child {
  color: var(--ctx-muted);
  white-space: nowrap;
}
.dwb-ctx-meter {
  position: relative;
  height: 5px;
  border-radius: 999px;
  background: var(--ctx-track);
  margin: 8px 0;
  overflow: hidden;
}
.dwb-ctx-fill {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 1px;
}
.dwb-ctx-meter i {
  display: block;
  height: 100%;
  min-width: 2px;
}
.dwb-ctx-meter .dwb-ctx-reserved {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  background: var(--ctx-res);
}
.dwb-ctx-meter .dwb-ctx-tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ctx-muted);
  z-index: 1;
}
.dwb-ctx .is-blue {
  background: var(--ctx-blue);
}
.dwb-ctx .is-g1 {
  background: var(--ctx-g1);
}
.dwb-ctx .is-g2 {
  background: var(--ctx-g2);
}
.dwb-ctx .is-dim {
  background: var(--ctx-res);
  box-shadow: inset 0 0 0 1px var(--ctx-line);
}
.dwb-ctx .is-hollow {
  box-shadow: inset 0 0 0 1px var(--ctx-muted);
}
.dwb-ctx-pick {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
}
.dwb-ctx-pick > span:first-child {
  color: var(--ctx-second);
}
.dwb-ctx-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 4px 0 8px;
  font: inherit;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  cursor: pointer;
}
.dwb-ctx-value {
  color: var(--ctx-second);
  white-space: nowrap;
}
.dwb-ctx-trigger:focus-visible,
.dwb-ctx-row:focus-visible,
.dwb-ctx-link:focus-visible,
.dwb-ctx-icon:focus-visible,
.dwb-ctx-state button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dwb-ctx-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dwb-ctx-opt.is-dimmed > span:first-child {
  color: var(--dsw-alias-label-tertiary);
}
.dwb-ctx-opt small {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.35;
}
.dwb-ctx-pill {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
}
.dwb-ctx-cap {
  margin-top: 4px !important;
  font-size: 12px;
  color: var(--ctx-muted);
  line-height: 1.5;
}
.dwb-ctx-cap.is-warn {
  color: var(--dsw-alias-state-warn-primary);
}
.dwb-ctx-link {
  min-height: 0;
  height: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  cursor: pointer;
}
.dwb-ctx-table {
  margin-top: 10px;
}
.dwb-ctx-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto 46px;
  column-gap: 6px;
  align-items: center;
  width: 100%;
  min-height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
button.dwb-ctx-row {
  cursor: pointer;
}
button.dwb-ctx-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dwb-ctx-sw {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: block;
}
.dwb-ctx-name {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
  color: var(--ctx-second);
}
.dwb-ctx-name > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dwb-ctx-chev {
  flex: none;
  color: var(--ctx-muted);
  display: inline-flex;
}
[aria-expanded='true'] > .dwb-ctx-name .dwb-ctx-chev,
[aria-expanded='true'] > .dwb-ctx-chev {
  transform: rotate(90deg);
}
.dwb-ctx-num {
  text-align: right;
  white-space: nowrap;
}
.dwb-ctx-per {
  text-align: right;
  color: var(--ctx-muted);
  font-size: 12px;
}
.dwb-ctx-note {
  margin: 0 0 2px 20px !important;
  font-size: 12px;
  line-height: 1.4;
}
.dwb-ctx-tail {
  margin-top: 8px;
}
.dwb-ctx-tail .dwb-ctx-name {
  color: var(--ctx-muted);
}
.dwb-ctx-tail .dwb-ctx-num {
  color: var(--ctx-second);
}
.dwb-ctx-kids {
  margin: 0 0 4px 20px;
  display: grid;
}
.dwb-ctx-kid-head {
  margin: 2px 0 !important;
  font-size: 12px;
  color: var(--ctx-muted);
}
.dwb-ctx-kid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  font-size: 12px;
  color: var(--ctx-second);
}
.dwb-ctx-kid > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dwb-ctx-kid small {
  color: var(--ctx-muted);
  font-size: 12px;
  white-space: nowrap;
}
.dwb-ctx-kid .dwb-ctx-num {
  margin-left: auto;
  padding-right: 52px;
}
.dwb-ctx-life {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  min-height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ctx-muted);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dwb-ctx-life .dwb-ctx-chev {
  margin-top: 3px;
}
.dwb-ctx-life + .dwb-ctx-kids .dwb-ctx-num {
  padding-right: 0;
}
.dwb-ctx-group {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ctx-second);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dwb-ctx-group small {
  margin-left: auto;
  padding-right: 52px;
  color: var(--ctx-muted);
  font-size: 12px;
}
.dwb-ctx-spark {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 44px;
  margin: 4px 52px 4px 0;
}
.dwb-ctx-spark i {
  flex: 1;
  min-width: 1px;
  background: var(--ctx-blue);
}
.dwb-ctx-foot {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--ctx-muted);
  font-size: 12px;
  line-height: 1.5;
}
.dwb-ctx-foot p {
  overflow-wrap: anywhere;
}
.dwb-ctx-icon {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--ctx-muted);
  cursor: pointer;
}
.dwb-ctx-icon:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dwb-ctx-state {
  padding: 18px 0 8px;
  display: grid;
  gap: 6px;
  justify-items: start;
  color: var(--ctx-muted);
}
.dwb-ctx-state h3 {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
}
.dwb-cs {
  padding: 16px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dwb-cs-body {
  display: grid;
  gap: 24px;
  max-width: 640px;
}
.dwb-cs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.dwb-cs h2,
.dwb-cs h3,
.dwb-cs p {
  margin: 0;
}
.dwb-cs h2,
.dwb-cs h3 {
  font-size: 14px;
  font-weight: 500;
}
.dwb-cs section {
  display: grid;
  gap: 10px;
}
.dwb-cs-note {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dwb-cs-notice {
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
}
.dwb-cs textarea {
  width: 100%;
  min-height: 240px;
  resize: vertical;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  padding: 8px;
  box-sizing: border-box;
}
.dwb-cs-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dwb-cs-actions span {
  margin-left: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
`
const CONTEXT_BLUE = ['res', 'reas', 'msg', 'comp', 'sub', 'other'],
  CONTEXT_TOOLS = ['mcp', 'builtin'],
  CONTEXT_FIXED = ['sys', 'mem', 'skill', 'rt']
const contextTokens = (value) => {
  if (value === null || value === undefined) return '—'
  const n = Math.round(value)
  const scaled = (c) => (c >= 100 ? String(Math.round(c)) : String(Math.round(c * 10) / 10))
  if (Math.abs(n) < 1e3) return String(n)
  if (Math.abs(n) < 1e6) return `${scaled(n / 1e3)}K`
  return `${scaled(n / 1e6)}M`
}
const contextPercent = (value, window) => (window ? `${((value / window) * 100).toFixed(1)}%` : '')
const contextYuan = (value) =>
  value < 0.005 ? '<¥0.01' : `¥${value < 10 ? value.toFixed(2) : value.toFixed(1)}`
const contextHourMinute = (time) => {
  const date = new Date(time)
  return [date.getHours(), date.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':')
}
/** 缓存还在和过期时压一次的钱。摘要按 2000 token、新内容按 600 token 算。 */
const contextCompactCost = (used, prices) =>
  prices
    ? {
        warm: (used * prices.hit + 600 * prices.miss + 2000 * prices.out) / 1e6,
        cold: (used * prices.miss + 2000 * prices.out) / 1e6,
      }
    : null
/** 只解析本功能的会话资源；guide 页由所在会话决定。 */
export function contextAddressSession(address, fallback) {
  if (!address?.startsWith(CONTEXT_PREFIX)) return fallback
  try {
    const id = decodeURIComponent(address.slice(CONTEXT_PREFIX.length))
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}
/** 右对齐的小下拉，官方 ui.Menu。不能改时只显示值，不画箭头。 */
function ContextSelect({ label, value, valueLabel, options, onChange, disabled = false }) {
  const [open, setOpen] = useState(false)
  const id = React.useId()
  if (disabled) return h('div', { className: 'dwb-ctx-pick' }, h('span', null, label), h('span', { className: 'dwb-ctx-value' }, valueLabel))
  return h(
    'div',
    { className: 'dwb-ctx-pick' },
    h('span', { id }, label),
    h(ui.Menu, {
      open,
      onClose: () => setOpen(false),
      items: options,
      selectedId: value,
      onSelect: (next) => {
        setOpen(false)
        onChange(next)
      },
      portal: true,
      autoFocus: true,
      align: 'end',
      anchor: h(
        'button',
        {
          type: 'button',
          className: 'dwb-ctx-trigger',
          'aria-labelledby': id,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen((current) => !current),
        },
        h('span', null, valueLabel),
        h(ui.IconChevronDownOutlineRegular, { size: 14 }),
      ),
    }),
  )
}
function contextOption(id, label, { hint, rec, dimmed, pc, t } = {}) {
  return {
    id,
    label: h(
      'span',
      { className: `dwb-ctx-opt${dimmed ? ' is-dimmed' : ''}` },
      h('span', null, label),
      pc ? h('small', null, pc) : null,
      rec ? h('span', { className: 'dwb-ctx-pill' }, t('context.rec')) : null,
      hint ? h('small', null, hint) : null,
    ),
  }
}
/** 可以点开的一块。Esc 收起。 */
function ContextDisclosure({ button, children, startOpen = false }) {
  const [open, setOpen] = useState(startOpen)
  return h(
    Fragment,
    null,
    button({
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
      onKeyDown: (event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
        }
      },
    }),
    open ? children : null,
  )
}
const contextChevron = () =>
  h(
    'span',
    { className: 'dwb-ctx-chev', 'aria-hidden': true },
    h(ui.IconChevronRightOutlineRegular, { size: 12 }),
  )
function ContextRow({ swatch, label, value, window, note, kids }) {
  const cells = (extra) => [
    h('span', { className: `dwb-ctx-sw${swatch ? ` is-${swatch}` : ''}`, key: 's' }),
    h(
      'span',
      { className: 'dwb-ctx-name', key: 'n' },
      h('span', null, label),
      extra ? contextChevron() : null,
    ),
    h('span', { className: 'dwb-ctx-num', key: 'v' }, contextTokens(value)),
    h('span', { className: 'dwb-ctx-per', key: 'p' }, window ? contextPercent(value, window) : '—'),
  ]
  const noteLine = note ? h('p', { className: 'dwb-ctx-note' }, note) : null
  if (!kids) return h(Fragment, null, h('div', { className: 'dwb-ctx-row' }, ...cells(false)), noteLine)
  return h(
    ContextDisclosure,
    {
      button: (props) =>
        h(
          Fragment,
          null,
          h('button', { type: 'button', className: 'dwb-ctx-row', ...props }, ...cells(true)),
          noteLine,
        ),
    },
    h('div', { className: 'dwb-ctx-kids' }, kids),
  )
}
const contextKid = (label, value, small) =>
  h(
    'div',
    { className: 'dwb-ctx-kid', key: label },
    h('span', null, label),
    small ? h('small', null, small) : null,
    value === undefined ? null : h('span', { className: 'dwb-ctx-num' }, value),
  )
function contextExpansion(key, data, t) {
  const calls = (n) => (n === 0 ? t('context.never') : t('context.calls', { n }))
  // 子行是原始估算，按这一行的比例换算，加起来才和这一行对得上。
  const scaled = (n) => contextTokens(Math.round(n * data.display.ratio))
  if (key === 'res' && data.results.rows.length)
    return [
      h('p', { className: 'dwb-ctx-kid-head', key: 'h' }, t('context.shown', { n: data.results.rows.length, t: data.results.total })),
      ...data.results.rows.map((row) => h('div', { className: 'dwb-ctx-kid', key: row.seq }, h('span', null, row.tool ?? '—'), h('span', { className: 'dwb-ctx-num' }, scaled(row.tokens)))),
    ]
  if (key === 'mcp' && data.groups.mcp.length)
    return data.groups.mcp.map((group) =>
      h(
        ContextDisclosure,
        {
          key: group.server,
          button: (props) =>
            h(
              'button',
              { type: 'button', className: 'dwb-ctx-group', ...props },
              contextChevron(),
              h('span', null, group.server),
              h('small', null, `${t('context.toolCount', { n: group.tools })} · ${scaled(group.tokens)}`),
            ),
        },
        h(
          'div',
          { className: 'dwb-ctx-kids' },
          group.rows.map((row) => contextKid(row.name.split('__').slice(2).join('__') || row.name, scaled(row.tokens), calls(row.calls))),
        ),
      ),
    )
  if (key === 'builtin' && data.groups.builtin.length)
    return data.groups.builtin.map((row) => contextKid(row.name, scaled(row.tokens), calls(row.calls)))
  if (key === 'skill' && (data.groups.skills.catalog || data.groups.skills.loaded.length))
    return [
      h('p', { className: 'dwb-ctx-kid-head', key: 'h' }, t('context.catalog', { n: data.groups.skills.catalog })),
      ...(data.groups.skills.loaded.length ? [h('p', { className: 'dwb-ctx-kid-head', key: 'l' }, t('context.loaded')), ...data.groups.skills.loaded.map((name) => contextKid(name))] : []),
    ]
  if (key === 'mem' && data.groups.memory.length)
    return data.groups.memory.map((path) => contextKid(path.split(/[\\/]/).slice(-2).join('/')))
  return null
}
function contextCaption({ comp, data, reducible, after, cost, status, t, onCancel }) {
  const lines = []
  const add = (text, warn, action) =>
    lines.push(
      h(
        'p',
        { className: `dwb-ctx-cap${warn ? ' is-warn' : ''}`, key: lines.length },
        text,
        action ? ' ' : null,
        action ? h('button', { type: 'button', className: 'dwb-ctx-link', onClick: action.run }, action.label) : null,
      ),
    )
  const runtime = comp?.runtime
  const settings = comp?.settings
  if (comp) {
    const state = runtime?.state
    const inactive = comp.live === false
    if (status?.pendingInteraction?.kind === 'approval') add(t('context.capApproval'))
    else if (status?.pendingInteraction?.kind === 'question') add(t('context.capAnswer'))
    else if (status?.pendingInteraction?.kind === 'plan-review') add(t('context.capPlan'))
    else if (state === 'running' || status?.running) add(t('context.capRunning'))
    else if (state === 'compacting') add(t('context.compacting'), false, { label: t('context.cancel'), run: onCancel })
    else if (state === 'queued') add(t('context.capQueued'))
    else if (state === 'armed') {
      const at = contextHourMinute(runtime.dueAt)
      const minutes = settings.idleMinutes
      if (cost && comp.life?.goneAfter != null && minutes >= comp.life.goneAfter)
        add(t('context.capArmedCold', { at, c: contextYuan(cost.cold), x: Math.max(2, Math.round(cost.cold / cost.warm)) }), true)
      else if (cost) add(t('context.capArmed', { r: contextTokens(reducible), a: contextTokens(after), at, c: contextYuan(cost.warm) }))
      else add(t('context.capArmedPlain', { r: contextTokens(reducible), a: contextTokens(after), at }))
    } else if (state === 'done') add(t('context.capDone', { at: contextHourMinute(runtime.at), b: contextTokens(runtime.before), a: contextTokens(runtime.after) }))
    else if (state === 'failed') add(t('context.capFailed', { why: t(runtime.code === 'rate' ? 'context.whyRate' : runtime.code === 'timeout' ? 'context.whyTimeout' : 'context.whyError'), at: contextHourMinute(runtime.at) }), true)
    else if (state === 'stale') add(t('context.capStale'))
    else if (state === 'cancelled') add(t('context.capCancelled'))
    else if (state === 'cooldown') add(t('context.capCooldown'))
    else if (state === 'turn-failed') add(t('context.capTurnFailed'))
    else if (state === 'activity') add(t('context.capJob'))
    else if (state === 'small') add(t('context.capSmall', { r: contextTokens(reducible) }))
    else if (state === 'never') add(t('context.capNever', { w: contextTokens(settings.work) }))
    else if (state === 'below') add(t('context.capBelow', { t: contextTokens(settings.idle) }))
    else if (state === 'excluded' || comp.excluded) add(t('context.capExcluded'))
    else if (state === 'subagent' || comp.subagent) add(t('context.capSub'))
    else if (inactive && settings.idle !== null) add(t('context.capInactive'))
    else add(t('context.capOff'))
  }
  if (data.pressure.window == null) add(t('context.capNoWindow'))
  if (data.lastRequest?.calibration === 'divergent') add(t('context.capDivergent'))
  if (data.current.unknownMedia) add(t('context.capMedia', { n: data.current.unknownMedia }))
  if (data.baseline.available && data.baseline.anomaly)
    add(t('context.capBaseline', { days: data.baseline.days, median: contextTokens(data.baseline.median), z: data.baseline.z == null ? '—' : data.baseline.z.toFixed(1) }), true)
  return lines
}
function ContextPanel({ sessionId, useTabInfo, app }) {
  const { tab } = useTabInfo(),
    t = app.t
  const addressed = contextAddressSession(tab.contentId, sessionId)
  const [snapshot, setData] = useState(null),
    [comp, setComp] = useState(null),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [revision, refresh] = useState(0),
    [readAt, setReadAt] = useState(null),
    [status, setStatus] = useState(null),
    [saveFailed, setSaveFailed] = useState(false)
  const data = snapshot?.sessionId === addressed ? snapshot : null
  const provider = data?.provider ?? data?.lastRequest?.provider
  const query = useCallback(
    (id, route) => `/api/dsh-workbench.compaction?sessionId=${encodeURIComponent(id)}${route ? `&provider=${encodeURIComponent(route)}` : ''}`,
    [],
  )
  useEffect(() => {
    if (tab.visible === false) return
    if (!addressed) {
      setError(true)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    let current = true
    fetch(`/api/dsh-workbench.context?sessionId=${encodeURIComponent(addressed)}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('context read')
        return r.json()
      })
      .then(async (value) => {
        if (!current) return
        setData(value)
        setReadAt(Date.now())
        // 这一行关掉时路由是 404：下拉不出现，表还在。
        const response = await fetch(query(addressed, value.provider ?? value.lastRequest?.provider), { signal: controller.signal })
        if (current) setComp(response.ok ? await response.json() : null)
      })
      .catch(() => {
        if (current && !controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
      controller.abort()
    }
  }, [addressed, revision, tab.visible, query])
  // 这个会话从运行变空闲时刷新一次。不轮询。
  useEffect(() => {
    const source = app.ctx.uiSession?.sessionStatus
    if (!source || !addressed) return
    let running = source.getSnapshot().get(addressed)?.running === true
    setStatus(source.getSnapshot().get(addressed) ?? null)
    return source.subscribe(() => {
      const next = source.getSnapshot().get(addressed) ?? null
      setStatus(next)
      const nextRunning = next?.running === true
      if (running && !nextRunning) refresh((x) => x + 1)
      running = nextRunning
    })
  }, [addressed, app])
  // 等着压或正在压时，只在这两种状态下接着读：到点读，压的时候隔 2 秒读，结束或读失败就停。
  // 依赖 comp 本身：每读回一次都是新对象，状态没变也会按它再安排下一次。
  const runtimeState = comp?.runtime?.state
  const dueAt = comp?.runtime?.dueAt
  useEffect(() => {
    if (tab.visible === false || !addressed) return
    const waiting = runtimeState === 'compacting' || runtimeState === 'queued'
    if (!waiting && runtimeState !== 'armed') return
    let live = true
    const delay = waiting ? 2000 : Math.max(1000, dueAt - Date.now() + 1000)
    const timer = setTimeout(async () => {
      const response = await fetch(query(addressed, provider)).catch(() => null)
      if (!live || !response?.ok) return
      const next = await response.json()
      if (!live) return
      setComp(next)
      if (next.runtime?.state === 'done') refresh((x) => x + 1)
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [comp, addressed, provider, tab.visible, query])
  const post = async (body) => {
    const response = await fetch('/api/dsh-workbench.compaction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: addressed, ...(provider ? { provider } : {}), ...body }),
    }).catch(() => null)
    setSaveFailed(!response?.ok)
    if (response?.ok) setComp(await response.json())
  }
  const foot = (route) =>
    h(
      'footer',
      { className: 'dwb-ctx-foot' },
      h(
        'div',
        null,
        route ? h('p', null, route) : null,
        h('p', null, status?.running ? t('context.runningFoot') : readAt ? t('context.updated', { at: contextHourMinute(readAt) }) : ''),
      ),
      h(
        'button',
        { type: 'button', className: 'dwb-ctx-icon', 'aria-label': t('context.refresh'), disabled: loading, onClick: () => refresh((x) => x + 1) },
        h(ui.IconRefreshOutlineRegular, { size: 14 }),
      ),
    )
  let body
  if (error)
    body = h(
      'div',
      { className: 'dwb-ctx-state', role: 'alert' },
      h('p', null, t('context.error')),
      h(ui.Button, { variant: 'secondary', onClick: () => refresh((x) => x + 1) }, t('context.retry')),
    )
  else if (!data) body = h('p', { role: 'status' }, t('context.loading'))
  else {
    const window = data.pressure.window
    const used = data.pressure.used ?? 0
    const parts = data.display.parts
    const allowed = comp ? comp.allowed ?? comp.presets.includes(data.preset ?? comp.defaultPreset) : false
    const subagent = comp ? (comp.root === null ? data.origin === 'subagent' : !comp.root) : false
    const compView = comp ? { ...comp, excluded: !allowed && !subagent, subagent } : null
    const line = comp?.official?.official ?? data.threshold.tokens
    const reserve = comp?.official?.output ?? data.maxOutput
    const headroom = comp?.official?.headroom ?? null
    const settings = comp?.settings
    const reducible = data.display.reducible
    const after = Math.max(0, used - reducible) + 2000
    const cost = contextCompactCost(used, data.prices)
    const blue = CONTEXT_BLUE.reduce((n, k) => n + parts[k], 0) + data.display.since
    const g1 = CONTEXT_TOOLS.reduce((n, k) => n + parts[k], 0)
    const g2 = CONTEXT_FIXED.reduce((n, k) => n + parts[k], 0)
    const width = (value) => `${window ? ((value / window) * 100).toFixed(2) : 0}%`
    const meter = window
      ? h(
          'div',
          { className: 'dwb-ctx-meter', 'aria-hidden': true },
          line !== null && line !== undefined ? h('span', { className: 'dwb-ctx-reserved', style: { left: width(line) } }) : null,
          settings?.idle ? h('span', { className: 'dwb-ctx-tick', style: { left: width(settings.idle) } }) : null,
          h(
            'span',
            { className: 'dwb-ctx-fill' },
            blue > 0 ? h('i', { className: 'is-blue', style: { width: width(blue) } }) : null,
            g1 > 0 ? h('i', { className: 'is-g1', style: { width: width(g1) } }) : null,
            g2 > 0 ? h('i', { className: 'is-g2', style: { width: width(g2) } }) : null,
          ),
        )
      : null
    const pickers = (() => {
      if (!comp || subagent) return null
      const disabled = !allowed
      const { tiers, selected: workSelected } = workLineChoices({ work: settings.work, official: line ?? null, min: comp.tiers.min, step: comp.tiers.step, max: 700_000 })
      const running = status?.running === true
      const workOptions = [
        ...tiers.map((tier) => contextOption(String(tier), contextTokens(tier), { t, rec: tier === 400_000, dimmed: tier <= used, hint: tier <= used ? t(running ? 'context.next' : 'context.now') : undefined })),
        contextOption(CONTEXT_OFFICIAL_CHOICE, t('context.official'), { t, hint: line ? contextTokens(line) : undefined }),
      ]
      const idleOptions = [
        contextOption('off', t('context.off'), { t }),
        ...tiers.map((tier) => {
          const never = settings.work !== null && tier >= settings.work
          return contextOption(String(tier), contextTokens(tier), { t, rec: tier === 300_000 && !never, dimmed: never, pc: window ? `${Math.round((tier / window) * 100)}%` : undefined, hint: never ? t('context.idleNever') : undefined })
        }),
      ]
      const life = comp.life
      const timeHint = (minutes) => {
        if (!life?.known) return {}
        if (life.goneAfter !== null && minutes >= life.goneAfter) return { dimmed: true, hint: cost ? t('context.cold', { c: contextYuan(cost.cold) }) : undefined }
        if (life.warmAtLeast !== null && minutes <= life.warmAtLeast) return { hint: t('context.warm') }
        return {}
      }
      const minutesLabel = (minutes) => (minutes < 60 ? t('context.minutes', { n: minutes }) : t('context.hours', { n: minutes / 60 }))
      const timeOptions = comp.idleMinutes.map((minutes) => contextOption(String(minutes), minutesLabel(minutes), { t, rec: minutes === 30, ...timeHint(minutes) }))
      const set = (key) => (next) => post({ set: { [key]: next === 'off' ? null : Number(next) } })
      const lifeLine = (() => {
        if (settings.idle === null) return null
        const note = comp.note ? t(`context.lifeNote.${comp.note}`) : ''
        if (!life?.known) return h('p', { className: 'dwb-ctx-cap' }, `${t('context.lifeUnknown')}${note}`)
        const text =
          life.warmUntil !== null && life.goneAfter !== null
            ? t('context.lifeRange', { a: life.warmUntil, b: life.goneAfter })
            : life.warmUntil !== null
              ? t('context.lifeWarm', { a: life.warmUntil })
              : t('context.lifeAtLeast', { a: life.warmAtLeast })
        return h(
          ContextDisclosure,
          {
            button: (props) =>
              h('button', { type: 'button', className: 'dwb-ctx-life', ...props }, contextChevron(), h('span', null, text)),
          },
          h(
            'div',
            { className: 'dwb-ctx-kids' },
            h('p', { className: 'dwb-ctx-kid-head' }, t('context.lifeHead', { n: life.n.toLocaleString() })),
            life.bins.map((bin) =>
              contextKid(
                bin.from === 0 ? t('context.lifeBinUnder', { b: bin.to }) : bin.to === null ? t('context.lifeBinOver', { a: bin.from }) : t('context.lifeBin', { a: bin.from, b: bin.to }),
                `${bin.hit} / ${bin.n}`,
              ),
            ),
          ),
        )
      })()
      return h(
        Fragment,
        null,
        h(ContextSelect, {
          label: t('context.work'),
          value: workSelected,
          valueLabel: workSelected !== CONTEXT_OFFICIAL_CHOICE ? contextTokens(settings.work) : line ? t('context.officialAt', { n: contextTokens(line) }) : t('context.official'),
          options: workOptions,
          onChange: set('work'),
          disabled: disabled || !window,
        }),
        h(ContextSelect, {
          label: t('context.idle'),
          value: settings.idle === null ? 'off' : String(settings.idle),
          valueLabel: settings.idle === null ? t('context.off') : contextTokens(settings.idle),
          options: idleOptions,
          onChange: set('idle'),
          disabled,
        }),
        settings.idle === null
          ? null
          : h(ContextSelect, {
              label: t('context.time'),
              value: String(settings.idleMinutes),
              valueLabel: minutesLabel(settings.idleMinutes),
              options: timeOptions,
              onChange: set('idleMinutes'),
              disabled,
            }),
        lifeLine,
        settings.overridden
          ? h(
              'p',
              { className: 'dwb-ctx-cap' },
              t('context.scopeLine'),
              ' ',
              h('button', { type: 'button', className: 'dwb-ctx-link', onClick: () => post({ reset: true }) }, t('context.restoreDefault')),
            )
          : null,
      )
    })()
    const captions = contextCaption({ comp: compView, data, reducible, after, cost, status, t, onCancel: () => post({ cancel: true }) })
    const rows = Object.entries(parts)
      .filter(([, value]) => value > 0.5)
      .sort((a, b) => b[1] - a[1])
    const swatchOf = (key) => (CONTEXT_BLUE.includes(key) ? 'blue' : CONTEXT_TOOLS.includes(key) ? 'g1' : 'g2')
    const noteOf = (key) => {
      if (key === 'res' && data.findings.resultsPriority) {
        const top = data.results.rows.slice(0, 3).reduce((n, row) => n + row.tokens, 0)
        return t('context.resNote', { p: `${Math.round((parts.res / Math.max(1, used)) * 100)}%`, t: contextTokens(Math.round(top * data.display.ratio)) })
      }
      if ((key === 'mcp' || (key === 'builtin' && !parts.mcp)) && data.findings.toolsPriority && data.display.unused[key].n > 0)
        return t('context.toolsNote', { n: data.display.unused[key].n, t: contextTokens(data.display.unused[key].tokens) })
      return null
    }
    const free = window ? Math.max(0, window - used - (reserve ?? 0) - (headroom ?? 65536)) : null
    const maxHistory = Math.max(1, ...data.history.map((x) => x.input))
    const table = h(
      'div',
      { className: 'dwb-ctx-table' },
      rows.map(([key, value]) =>
        h(ContextRow, { key, swatch: swatchOf(key), label: t(`context.${key}`), value, window, note: noteOf(key), kids: contextExpansion(key, data, t) }),
      ),
      data.display.since > 0 ? h(ContextRow, { key: 'since', swatch: 'blue', label: t('context.since'), value: data.display.since, window }) : null,
      data.display.gap !== null ? h(ContextRow, { key: 'gap', swatch: 'hollow', label: t('context.gap'), value: data.display.gap, window }) : null,
      window
        ? h(
            'div',
            { className: 'dwb-ctx-tail' },
            reserve ? h(ContextRow, { swatch: 'dim', label: t('context.reserve'), value: reserve, window }) : null,
            h(ContextRow, { swatch: 'dim', label: t('context.headroom'), value: headroom ?? 65536, window }),
            h(ContextRow, { label: t('context.free'), value: free, window }),
          )
        : null,
    )
    const empty = !data.lastRequest && data.current.raw === 0
    body = h(
      Fragment,
      null,
      h(
        'div',
        { className: 'dwb-ctx-use' },
        data.pressure.percent === null ? h('b', null, `~${contextTokens(used)}`) : h('span', null, h('b', null, `${data.pressure.percent}%`), ` ${t('context.used')}`),
        window ? h('span', null, `~${contextTokens(used)} / ${contextTokens(window)}`) : null,
      ),
      meter,
      pickers,
      saveFailed ? h('p', { className: 'dwb-ctx-cap is-warn', role: 'alert' }, t('compaction.saveError')) : null,
      captions,
      empty
        ? h('div', { className: 'dwb-ctx-state' }, h('h3', null, t('context.empty')))
        : table,
      data.history.length
        ? h(
            ContextDisclosure,
            {
              button: (props) =>
                h('button', { type: 'button', className: 'dwb-ctx-group', ...props }, contextChevron(), h('span', null, t('context.recent')), h('small', null, data.history.length)),
            },
            h(
              'div',
              { className: 'dwb-ctx-kids' },
              h('p', { className: 'dwb-ctx-kid-head' }, t('context.recentNote', { n: data.history.length, t: data.historyTotal })),
              h('div', { className: 'dwb-ctx-spark', 'aria-hidden': true }, data.history.map((x) => h('i', { key: x.seq, style: { height: `${(x.input / maxHistory) * 100}%` } }))),
            ),
          )
        : null,
      data.records.length
        ? h(
            ContextDisclosure,
            {
              button: (props) =>
                h('button', { type: 'button', className: 'dwb-ctx-group', ...props }, contextChevron(), h('span', null, t('context.records')), h('small', null, data.records.length)),
            },
            h(
              'div',
              { className: 'dwb-ctx-kids' },
              data.records.map((record, i) =>
                h(
                  'div',
                  { className: 'dwb-ctx-kid', key: i },
                  h('span', null, workbenchClock(record.at, app.clock)),
                  h('small', null, record.ok ? t(`context.kind.${record.kind}`) : `${t(`context.kind.${record.kind}`)} · ${t('context.recordFailed')}`),
                  h('span', { className: 'dwb-ctx-num' }, [record.before != null && record.after != null ? `${contextTokens(record.before)} → ${contextTokens(record.after)}` : null, record.cost != null ? contextYuan(record.cost) : null].filter(Boolean).join(' · ') || '—'),
                ),
              ),
            ),
          )
        : null,
      foot([data.provider, data.model].filter(Boolean).join(' / ')),
    )
  }
  return h('div', { className: 'dwb-ctx', 'aria-busy': loading }, body)
}
/** 设置里的「压缩」：压缩提示词（默认官方原文，可以改全文）和新会话的默认。 */
function CompactionSettings({ app }) {
  const t = app.t
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [draft, setDraft] = useState(''),
    [saved, setSaved] = useState(false),
    [revision, reload] = useState(0)
  const locale = t('compaction.title') === 'Compaction' ? 'en' : 'zh'
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/dsh-workbench.compaction.settings', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('read')
        return r.json()
      })
      .then((value) => {
        setData(value)
        setDraft(value.prompt.custom || value.seven[locale])
        setError(null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t('compaction.loadError'))
      })
    return () => controller.abort()
  }, [revision, locale, t])
  const save = async (body) => {
    setSaved(false)
    const response = await fetch('/api/dsh-workbench.compaction.settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    if (!response?.ok) {
      setError(t('compaction.saveError'))
      return false
    }
    setData(await response.json())
    setError(null)
    return true
  }
  const head = h('header', { className: 'dwb-cs-head' }, h(ui.IconCompactOutlineRegular, { size: 16 }), h('h2', null, t('compaction.title')))
  if (!data)
    return h(
      'div',
      { className: 'dwb-cs' },
      head,
      error
        ? h('div', { role: 'alert' }, h('p', { className: 'dwb-cs-notice' }, error), h(ui.Button, { variant: 'secondary', onClick: () => reload((x) => x + 1) }, t('context.retry')))
        : h('p', { role: 'status' }, t('compaction.loading')),
    )
  const selection = data.prompt.selection
  const tiers = []
  for (let tier = data.tiers.min; tier <= 700_000; tier += data.tiers.step) tiers.push(tier)
  const tierOptions = (rec) => tiers.map((tier) => contextOption(String(tier), contextTokens(tier), { t, rec: tier === rec }))
  const minutesLabel = (minutes) => (minutes < 60 ? t('context.minutes', { n: minutes }) : t('context.hours', { n: minutes / 60 }))
  const trimmed = draft.trim()
  const dirty = draft !== data.prompt.custom
  const defaults = data.defaults
  const setDefault = (key) => (next) => save({ defaults: { [key]: next === 'off' ? null : Number(next) } })
  return h(
    'div',
    { className: 'dwb-cs' },
    head,
    h(
      'div',
      { className: 'dwb-cs-body' },
      data.reason === 'corrupt' ? h('p', { className: 'dwb-cs-notice', role: 'status' }, t('compaction.corrupt')) : null,
      error ? h('p', { className: 'dwb-cs-notice', role: 'alert' }, error) : null,
      h(
        'section',
        null,
        h(WorkbenchSelect, {
          label: t('compaction.prompt'),
          value: selection,
          options: [
            { id: 'official', label: t('compaction.promptOfficial') },
            contextOption('seven', t('compaction.promptSeven'), { t, hint: t('compaction.promptSevenHint') }),
            { id: 'custom', label: t('compaction.promptCustom') },
          ],
          onChange: (next) => {
            setSaved(false)
            save({ prompt: { selection: next, custom: next === 'custom' ? draft : data.prompt.custom, locale } })
          },
        }),
        h('p', { className: 'dwb-cs-note' }, t('compaction.promptNote')),
        selection === 'custom'
          ? h(
              Fragment,
              null,
              h('textarea', {
                'aria-label': t('compaction.prompt'),
                value: draft,
                onChange: (event) => {
                  setDraft(event.target.value)
                  setSaved(false)
                },
              }),
              h(
                'div',
                { className: 'dwb-cs-actions' },
                h(
                  ui.Button,
                  {
                    variant: 'secondary',
                    disabled: !dirty || trimmed === '',
                    onClick: async () => {
                      if (await save({ prompt: { selection: 'custom', custom: draft, locale } })) setSaved(true)
                    },
                  },
                  t('compaction.save'),
                ),
                h(
                  ui.Button,
                  {
                    variant: 'ghost',
                    onClick: () => {
                      setDraft(data.seven[locale])
                      setSaved(false)
                    },
                  },
                  t('compaction.promptRestore'),
                ),
                trimmed === '' ? h('span', null, t('compaction.customEmpty')) : saved ? h('span', { role: 'status' }, t('compaction.saved')) : null,
              ),
            )
          : null,
      ),
      h(
        'section',
        null,
        h('h3', null, t('compaction.defaults')),
        h('p', { className: 'dwb-cs-note' }, t('compaction.defaultsNote')),
        h(WorkbenchSelect, { label: t('context.work'), value: defaults.work === null ? 'off' : String(defaults.work), options: [...tierOptions(400_000), { id: CONTEXT_OFFICIAL_CHOICE, label: t('context.official') }], onChange: setDefault('work') }),
        h(WorkbenchSelect, { label: t('context.idle'), value: defaults.idle === null ? 'off' : String(defaults.idle), options: [{ id: 'off', label: t('context.off') }, ...tierOptions(300_000)], onChange: setDefault('idle') }),
        h(WorkbenchSelect, {
          label: t('context.time'),
          value: String(defaults.idleMinutes),
          options: data.idleMinutes.map((minutes) => contextOption(String(minutes), minutesLabel(minutes), { t, rec: minutes === 30 })),
          onChange: setDefault('idleMinutes'),
        }),
      ),
    ),
  )
}
/** 这一行（dsh-workbench-compaction）开着时才有的设置页。 */
function applyCompactionSettings(app) {
  const { ctx, t } = app,
    disposers = [],
    keep = (d) => disposers.push(d)
  keep(
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'dsh-workbench-compaction', order: 25, label: () => t('compaction.title'), locale: '@miint-sunny/dsh-workbench' },
        (props) => h(CompactionSettings, { ...props, app }),
      ),
    ),
  )
  keep(
    ctx.slots.inject('settings.section.icon', () =>
      ctx.slots.register({ name: 'settings.section.icon', id: 'dsh-workbench-compaction' }, (props) => h(ui.IconCompactOutlineRegular, props)),
    ),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
function applyContext(app) {
  const { ctx, t } = app,
    disposers = [],
    keep = (d) => disposers.push(d)
  keep(mountModuleStyle('dsh-workbench-context', CONTEXT_STYLE))
  keep(
    ctx.effect(
      () =>
        ctx.resources.register({
          protocol: CONTEXT_PROTOCOL,
          async *open(address, { signal }) {
            if (!contextAddressSession(address)) throw new Error('Invalid context address')
            yield { ok: true, value: { address } }
            if (!signal.aborted)
              await new Promise((resolve) =>
                signal.addEventListener('abort', resolve, { once: true }),
              )
          },
        }),
      'workbench context resource',
    ),
  )
  keep(
    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: CONTEXT_TAB,
          kind: CONTEXT_PROTOCOL,
          patterns: [CONTEXT_PREFIX + '**'],
          priority: 'extension',
          title: () => t('context.title'),
          guide: [
            {
              id: 'context',
              order: 55,
              title: () => t('context.title'),
              description: () => t('context.guide'),
              icon: (props) => h(ui.IconContextInjectionOutlineRegular, props),
            },
          ],
        }),
      'workbench context tab',
    ),
  )
  keep(
    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: CONTEXT_TAB, locale: '@miint-sunny/dsh-workbench' },
            (props) => h(ContextPanel, { ...props, app }),
          ),
        ),
      'workbench context pane',
    ),
  )
  keep(
    ctx.commandUi.register({
      name: 'context',
      label: () => t('context.title'),
      description: () => t('context.guide'),
      available: () => true,
      ui: {
        kind: 'action',
        run: (session) =>
          ctx.sidebarRight.openResource(CONTEXT_PREFIX + encodeURIComponent(session.sessionId)),
      },
    }),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

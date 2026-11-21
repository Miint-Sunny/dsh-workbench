/**
 * 切换 Agent 预设（feat#162）：会话开始以后，在会话顶栏的 Agent 预设标签上切换标准模式、代码模式和全开模式。
 *
 * 入口：用官方页头标签（@deepseek-ai/dsh-client-ui-agent-preset 的 AgentPresetLabel）同一个槽位、同一个 id 换掉它。
 * conversation.session.header.actions 是列表槽位；App 0.2.2-rc.3 的 SlotRegistry（dsh-web-frontend 打包源码核对）
 * 按 priority、再按 order 排，同 id 只显示 priority 最小的那个，同 id 同 priority 后注册的抛错。官方的 priority 是默认的 0，
 * 这里用 -1（工作台盖住官方条目的惯例：任务条、选区回复都是 -1），order 和官方一样是 -10，页头上的位置不变。
 * 关掉这一行时注销，官方标签回来（隔离宿主实测）。SlotRegistry 在条目报错且判定让位（abdicate）时改显示同 id 的下一个条目，
 * 也就是官方标签（读源码所得，没实测）。空白会话的选择器（conversation.hero.agentPreset）不动。
 *
 * 标签和官方一样：IconAgentPresetOutlineRegular 14、预设名，样式照 AgentPresetLabel.module.css。宿主说能切换时后面多一个
 * 下拉箭头，点开是 DSH 的菜单（ui.Menu，挂到 body 上：页头会裁掉溢出的部分）。和官方不同的两处：不写 title（工作台不做
 * 悬停弹出）；官方在标题行窄于 540px 时藏起标签（那时它只是说明），这里是控件，窄的时候名字截断、不藏（常用布局下
 * 中间栏约 422px）。
 *
 * 选了别的预设：先取预览；工具和系统提示词都没有变化时直接切换，否则弹确认框（ui.Modal，照官方「确认启用完全权限？」）。
 * 确认后按勾选先压缩上下文再切换，两步各发一次 POST；进行中不能取消；失败写在框里，按钮变「重试」；压缩成功、切换失败
 * 以后重试只切换。两步的 POST 都带 expectedFrom（用户这次看到的预览里的 from）；宿主回 stale-preview（别的窗口先切了）时
 * 不写错误，重新取预览，按新的差异决定弹框还是直接切换（presetSwitchAfterStale），压缩已经成功的不再压缩。成功后关框，标签跟着日志投影换成新预设。确认框和菜单都是 DSH 的弹层（role=dialog aria-modal、role=menu：
 * 在 ui.modalSelector 里，也在 next-step.js 的 OPEN_OVERLAYS 里），开着时 ⌘↵ 不执行「推荐的下一步」。
 */
import { mountModuleStyle } from './style.js'
import { PRESET_SWITCH_ROUTE, presetSwitchAfterStale, presetSwitchErrorText, presetSwitchLabelKind, presetSwitchMenuEntries, presetSwitchMenuOf, presetSwitchNameOf, presetSwitchPreviewOf, presetSwitchPromptText, presetSwitchSteps, presetSwitchToolsText, presetSwitchTokens } from './preset-switch-model.js'

export const PRESET_SWITCH_INJECT = ['slots', 'locale', 'remote.agentPresets']

/** 官方页头标签所在的槽位。 */
const PRESET_SWITCH_SLOT = 'conversation.session.header.actions'
/** 官方 Agent 预设界面的词典（内置预设的名字）。 */
const PRESET_SWITCH_OFFICIAL_NS = 'settings.agentPreset'

/**
 * 样式。标签照官方 AgentPresetLabel.module.css（22px 高、12px 字、第三级文字色）。官方写的半透明底色变量
 * （fill-tsp-secondary）在 rc.3 的 app.asar 里没有声明，实际是透明底，这里照实际写 transparent。
 * 能点时加下拉箭头和悬停、展开时的底色（DSH 按钮的 interactive-bg-hover）。菜单项照官方新会话选择器的两行（名字、说明）。
 * 确认框照官方完全权限确认框的宽度，各栏、勾选和说明照样稿；各栏和 DSH 框里的说明、勾选、按钮一样用 14px，
 * 全框四种字号（标题 16、缓存未命中 15、正文 14、说明 12）。勾选下面的说明对齐勾选的文字（DSH 的复选框 16px 加 6px 间距）。
 */
export const PRESET_SWITCH_CSS = `
.dwb-pswitch-anchor{display:inline-flex;min-width:0;max-width:100%}
.dwb-pswitch-label{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;max-width:180px;height:22px;margin:0;padding:0 2px 0 0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;font:inherit;font-size:12px;line-height:22px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden}
.dwb-pswitch-label>svg{flex:none}
.dwb-pswitch-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
button.dwb-pswitch-label{padding-right:4px;cursor:pointer}
button.dwb-pswitch-label[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){button.dwb-pswitch-label:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
button.dwb-pswitch-label:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dwb-pswitch-chevron{color:var(--dsw-alias-label-caption)}
.dwb-pswitch-item{display:flex;flex-direction:column;gap:2px;max-width:280px;white-space:normal}
.dwb-pswitch-item-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dwb-pswitch-item-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption)}
.dwb-pswitch-dialog{width:min(440px,100%)}
.dwb-pswitch-rows{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px;margin:0;padding:12px 0;border-block:.5px solid var(--dsw-alias-border-l3);font-size:14px;line-height:22px}
.dwb-pswitch-rows>dt{margin:0;color:var(--dsw-alias-label-secondary)}
.dwb-pswitch-rows>dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary)}
.dwb-pswitch-rows>dd.dwb-pswitch-big{font-size:15px;font-weight:600}
.dwb-pswitch-more{margin-left:6px;padding:0;border:none;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-link);cursor:pointer}
.dwb-pswitch-names{display:block;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dwb-pswitch-compact{display:grid;gap:2px;margin-top:14px}
.dwb-pswitch-hint{margin:0 0 0 22px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-pswitch-note{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-pswitch-error{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dwb-pswitch-spin{animation:dwb-pswitch-spin 1s linear infinite}
@keyframes dwb-pswitch-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dwb-pswitch-spin{animation:none}}
`

/** DSH 的预设名单（页面里读一次，重连时重读），给不在宿主可选项里的预设取名字。 */
let presetSwitchRoster

/**
 * 读 DSH 的预设名单。
 * @param {object} ctx 客户端上下文。
 * @param {boolean} [fresh] 重读。
 * @returns {Promise<{id: string, name?: string}[]>} 名单；读不到时空数组。
 */
function presetSwitchRosterOf(ctx, fresh = false) {
  if (!fresh && presetSwitchRoster !== undefined) return presetSwitchRoster
  presetSwitchRoster = (async () => {
    try {
      const roster = await ctx.remote?.agentPresets?.list?.()
      return roster?.ok === true && Array.isArray(roster.value?.presets) ? roster.value.presets : []
    } catch {
      return []
    }
  })()
  return presetSwitchRoster
}

/**
 * 请求宿主的路由。
 * @param {string} path 相对路径。
 * @param {RequestInit} [init] 请求。
 * @returns {Promise<unknown>} 回答的 JSON；网络错误、不是 JSON 时 undefined。
 */
async function presetSwitchFetch(path, init = {}) {
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * 确认框：标题、说明、工具（可展开名字）、系统提示词、缓存未命中、「先压缩上下文」、子智能体、错误，底部「取消」和主按钮。
 * @param {{t: Function, flow: object, names: {current: string, target: string}, onCancel: () => void, onConfirm: () => void, onCompact: (value: boolean) => void}} props 确认框的状态和回调。
 * @returns {object} ui.Modal。
 */
function PresetSwitchDialog({ t, flow, names, onCancel, onConfirm, onCompact }) {
  const [expanded, setExpanded] = useState(false)
  const { preview, phase } = flow
  const progress = phase === 'compacting' || phase === 'switching'
  const [toolsKey, toolsParams] = presetSwitchToolsText(preview.tools)
  const toolCount = preview.tools === null ? 0 : preview.tools.added.length + preview.tools.removed.length
  const separator = t('pswitch.confirm.listSeparator')
  const toolNames = expanded && preview.tools !== null
    ? [
      preview.tools.added.length > 0 ? h('span', { key: 'added', className: 'dwb-pswitch-names' }, t('pswitch.confirm.toolsAddedNames', { names: preview.tools.added.join(separator) })) : null,
      preview.tools.removed.length > 0 ? h('span', { key: 'removed', className: 'dwb-pswitch-names' }, t('pswitch.confirm.toolsRemovedNames', { names: preview.tools.removed.join(separator) })) : null,
    ]
    : null
  const primary = phase === 'compacting' ? t('pswitch.confirm.compacting')
    : phase === 'switching' ? t('pswitch.confirm.switching')
      : phase === 'failed' ? t('pswitch.confirm.retry')
        : t('pswitch.confirm.switch', { name: names.target })
  const [errorKey, errorParams] = flow.error === null ? [] : presetSwitchErrorText(flow.error, names)
  return h(ui.Modal, {
    open: true,
    onClose: onCancel,
    title: t('pswitch.confirm.title', { name: names.target }),
    closeLabel: t('pswitch.confirm.close'),
    description: t('pswitch.confirm.description'),
    className: 'dwb-pswitch-dialog',
    footer: h(Fragment, null,
      h(ui.Button, { variant: 'outline', className: 'dwb-pswitch-cancel', disabled: progress, onClick: onCancel }, t('pswitch.confirm.cancel')),
      h(ui.Button, {
        variant: 'primary', className: 'dwb-pswitch-confirm', disabled: progress, onClick: onConfirm,
        icon: progress ? h(ui.IconLoadingOutlineRegular, { size: 14, className: 'dwb-pswitch-spin' }) : undefined,
      }, primary)),
  },
  h('dl', { className: 'dwb-pswitch-rows' },
    h('dt', null, t('pswitch.confirm.tools')),
    h('dd', null,
      h('span', null, t(toolsKey, toolsParams)),
      toolCount > 0
        ? h('button', { type: 'button', className: 'dwb-pswitch-more', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) },
          t(expanded ? 'pswitch.confirm.collapse' : 'pswitch.confirm.expand'))
        : null,
      toolNames),
    h('dt', null, t('pswitch.confirm.systemPrompt')),
    h('dd', null, t(presetSwitchPromptText(preview.systemPrompt))),
    h('dt', null, t('pswitch.confirm.cacheMiss')),
    preview.uncachedTokens === null
      ? h('dd', null, t('pswitch.confirm.unknown'))
      : h('dd', { className: 'dwb-pswitch-big' }, t('pswitch.confirm.tokens', { tokens: presetSwitchTokens(preview.uncachedTokens, t) }))),
  h('div', { className: 'dwb-pswitch-compact' },
    h(ui.Checkbox, { checked: flow.compact, disabled: progress || flow.compacted, label: t('pswitch.confirm.compact'), onChange: onCompact }),
    h('p', { className: 'dwb-pswitch-hint' }, t('pswitch.confirm.compactHint'))),
  preview.runningSubagents === null ? h('p', { className: 'dwb-pswitch-note' }, t('pswitch.confirm.subagentsUnknown'))
    : preview.runningSubagents > 0 ? h('p', { className: 'dwb-pswitch-note' }, t('pswitch.confirm.subagents', { count: preview.runningSubagents })) : null,
  flow.error === null ? null : h('p', { className: 'dwb-pswitch-error', role: 'alert' }, t(errorKey, errorParams)))
}

/**
 * 会话顶栏的 Agent 预设标签（conversation.session.header.actions 的条目）。
 * @param {{app: object, sessionId: string, useSessions: Function, useSession: Function, useSessionStatus: Function}} props 入口上下文和 DSH 给会话槽位的标准属性。
 * @returns {object | null} 标签和确认框；会话没有记录预设时 null。
 */
export function PresetSwitchHeader({ app, sessionId, useSessions, useSession, useSessionStatus }) {
  const { ctx, t } = app
  // 和官方标签读同一个值：日志投影里最后一次的 agent-preset/selected（没有时是创建头里的）。
  const preset = useSessions((state) => {
    const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const running = useSession(session => session?.running === true)
  const pending = useSessionStatus(statuses => statuses?.get?.(sessionId)?.pendingInteraction != null)
  const [menu, setMenu] = useState(undefined)
  const [roster, setRoster] = useState([])
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(false)
  const [flow, setFlow] = useState(null)
  const live = useRef(true)
  const choosing = useRef(false)
  const flowRef = useRef(null)
  flowRef.current = flow
  const official = useMemo(() => {
    try {
      return ctx.locale?.bind?.(PRESET_SWITCH_OFFICIAL_NS)
    } catch {
      return undefined
    }
  }, [ctx])

  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  // 重连以后宿主可能换了（重启、插件页开关这一行），名单和菜单都重读。
  useEffect(() => ctx.on?.('connection/reset', () => {
    presetSwitchRosterOf(ctx, true)
    setReload(count => count + 1)
  }), [ctx])
  // 宿主刷新了预设名单（换界面语言、预设的定义变了），名字和说明跟着重读；照官方预设标签听的同一个事件。
  useEffect(() => ctx.remote?.$on?.('settings/document-updated', (ns) => {
    if (ns !== 'agent-preset-registry') return
    presetSwitchRosterOf(ctx, true)
    setReload(count => count + 1)
  }), [ctx])
  useEffect(() => {
    let current = true
    void presetSwitchRosterOf(ctx).then((list) => { if (current) setRoster(list) })
    return () => { current = false }
  }, [ctx, reload])
  // 菜单数据：预设变了、一轮开始和结束（会话开始以后才能切换）、切换以后、重连以后重读。
  useEffect(() => {
    if (preset === undefined) return undefined
    let current = true
    void presetSwitchFetch(`${PRESET_SWITCH_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`).then((body) => {
      if (current) setMenu(presetSwitchMenuOf(body))
    })
    return () => { current = false }
  }, [sessionId, preset, running, reload])

  const kind = presetSwitchLabelKind(preset, menu)
  useEffect(() => {
    if (kind !== 'menu' && open) setOpen(false)
  }, [kind, open])
  const sources = { targets: menu?.targets ?? [], roster, official }
  const nameOf = id => presetSwitchNameOf(id, sources)
  const busy = running || pending

  /** 按顺序发 compact、switch；任何一步失败就停下，把错误写进框里；预览过期（stale-preview）时按新预览重走。 */
  const runFlow = async (start) => {
    let current = { ...start, error: null }
    for (const step of presetSwitchSteps(start)) {
      current = { ...current, phase: step === 'compact' ? 'compacting' : 'switching' }
      setFlow(current)
      const answer = await presetSwitchFetch(PRESET_SWITCH_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, agentPreset: current.target, step, expectedFrom: current.expectedFrom }),
      })
      if (!live.current) return
      if (answer?.ok !== true) {
        const error = answer?.error !== null && typeof answer?.error === 'object' ? answer.error : {}
        if (error.code === 'stale-preview') {
          await refreshStale(current, error)
          return
        }
        // 压缩这一步没回答（网络错误）时，照压缩失败写：没有切换。
        setFlow({ ...current, phase: 'failed', hidden: false, error: step === 'compact' && typeof error.code !== 'string' ? { ...error, code: 'compact-failed' } : error })
        return
      }
      if (step === 'compact') current = { ...current, compacted: true }
    }
    setFlow(null)
    setReload(count => count + 1)
  }

  /**
   * 宿主回了 stale-preview：用户看到的预览过期了（同一个会话在别的窗口先切了）。重新取预览：取不到写「切换失败」；
   * 会话已经是目标预设就关框；没有变化直接切换（上一次用户操作以后只自动重发一次）；有变化弹框请用户确认。
   * 压缩已经成功的保持 compacted，确认以后只切换；用户动过勾选的照用户的，没动过的照新预览的建议。
   */
  const refreshStale = async (current, error) => {
    const body = await presetSwitchFetch(`${PRESET_SWITCH_ROUTE}/preview?sessionId=${encodeURIComponent(sessionId)}&agentPreset=${encodeURIComponent(current.target)}`)
    if (!live.current) return
    const preview = presetSwitchPreviewOf(body)
    const next = presetSwitchAfterStale(preview, { target: current.target, retried: current.retried === true })
    if (next === 'failed') {
      setFlow({ ...current, phase: 'failed', hidden: false, error: { code: 'switch-failed', current: error.current } })
      return
    }
    if (next === 'done') {
      setFlow(null)
      setReload(count => count + 1)
      return
    }
    const fresh = { ...current, preview, expectedFrom: preview.from ?? error.current ?? current.expectedFrom, error: null }
    if (next === 'switch') {
      await runFlow({ ...fresh, compact: current.compacted === true, hidden: true, retried: true })
      return
    }
    const compact = current.compacted === true || (current.compactTouched === true ? current.compact : preview.compactSuggested)
    setFlow({ ...fresh, compact, phase: 'confirm', hidden: false, retried: false })
  }

  /** 菜单里选了一项：当前这一项、不能切换、正在切换时不做事；否则取预览，没有变化直接切换，有变化弹确认框。 */
  const choose = async (id) => {
    setOpen(false)
    if (id === preset || busy || flowRef.current !== null || choosing.current) return
    choosing.current = true
    try {
      const body = await presetSwitchFetch(`${PRESET_SWITCH_ROUTE}/preview?sessionId=${encodeURIComponent(sessionId)}&agentPreset=${encodeURIComponent(id)}`)
      if (!live.current) return
      const preview = presetSwitchPreviewOf(body)
      // 用户这次看到的来源预设：预览里的 from；预览取不到时是用户选的时候标签上显示的预设。
      const expectedFrom = preview.from ?? preset
      if (!preview.changes) {
        // 直接切换时不弹框；失败了才把框打开，写出错误。
        await runFlow({ target: id, preview, expectedFrom, compact: false, compacted: false, hidden: true })
        return
      }
      setFlow({ target: id, preview, expectedFrom, compact: preview.compactSuggested, compactTouched: false, compacted: false, phase: 'confirm', hidden: false, error: null })
    } finally {
      choosing.current = false
    }
  }

  if (kind === 'hidden') return null
  const progress = flow !== null && (flow.phase === 'compacting' || flow.phase === 'switching')
  const cancel = () => { if (!progress) setFlow(null) }
  const confirm = () => { if (flow !== null && !progress) void runFlow({ ...flow, retried: false }) }
  const compact = (value) => {
    setFlow(current => (current === null || current.compacted || current.phase === 'compacting' || current.phase === 'switching'
      ? current
      : { ...current, compact: value === true, compactTouched: true }))
  }
  const name = nameOf(preset)
  const icon = h(ui.IconAgentPresetOutlineRegular, { size: 14 })
  const text = h('span', { className: 'dwb-pswitch-name' }, name)
  const label = kind === 'static'
    ? h('span', { className: 'dwb-pswitch-label' }, icon, text)
    : h(ui.Menu, {
      open,
      onClose: () => setOpen(false),
      items: presetSwitchMenuEntries({
        targets: menu.targets,
        busy,
        busyText: t('pswitch.menu.busy'),
        label: target => h('span', { className: 'dwb-pswitch-item' },
          h('span', { className: 'dwb-pswitch-item-name' }, target.name),
          target.description === '' ? null : h('span', { className: 'dwb-pswitch-item-desc' }, target.description)),
      }),
      selectedId: preset,
      onSelect: (id) => { void choose(id) },
      align: 'start',
      portal: true,
      autoFocus: true,
      className: 'dwb-pswitch-anchor',
      anchor: h('button', {
        type: 'button',
        className: 'dwb-pswitch-label',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-label': t('pswitch.label.aria', { name }),
        onClick: () => setOpen(value => !value),
      }, icon, text, h(ui.IconChevronDownOutlineRegular, { size: 14, className: 'dwb-pswitch-chevron' })),
    })
  const errorPreset = flow?.error?.current
  return h(Fragment, null,
    label,
    flow !== null && !flow.hidden
      ? h(PresetSwitchDialog, {
        t, flow, onCancel: cancel, onConfirm: confirm, onCompact: compact,
        names: { current: nameOf(typeof errorPreset === 'string' && errorPreset !== '' ? errorPreset : preset), target: nameOf(flow.target) },
      })
      : null)
}

/**
 * 挂这一行：样式和会话顶栏的标签（换掉官方的）。
 * @param {{ctx: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数（插件页关掉这一行时入口调用；官方标签回来）。
 */
export function applyPresetSwitch(app) {
  const { ctx } = app
  const removeStyle = mountModuleStyle('dsh-workbench-preset-switch', PRESET_SWITCH_CSS)
  const disposeLabel = ctx.slots.inject(PRESET_SWITCH_SLOT, () => ctx.slots.register({
    name: PRESET_SWITCH_SLOT,
    id: 'agent-preset',
    order: -10,
    priority: -1,
    locale: '@miint-sunny/dsh-workbench',
  }, props => h(PresetSwitchHeader, { ...props, app })))
  return () => {
    disposeLabel?.()
    removeStyle()
  }
}

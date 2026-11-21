/**
 * 新会话卡片（dsh-workbench/session-cards 的网页部分，feat#160）：模型调 propose_session 后，
 * 这一轮末尾（conversation.chat.turnTail，收尾框之前）出一张卡片。样子跟 feat#166 的收尾框
 * 一致：题目是主要文字、说明是次要文字（超过三行收起）；按钮左对齐，「开始」是推荐项（标
 * ⌘↵，规则见 next-step.js），「在当前会话处理」是次要按钮；右上角「关闭」；「选项」展开工作区、
 * 工作树、Agent 预设、模型、推理等级、权限。选项默认值和宿主用同一个函数算（lib/session-cards-state.js
 * 的 cardDefaults）：模型定的照它的，没定模型时第一次用当前会话的、以后用上一次选的（它已不在
 * 模型目录里时用当前会话的），其余和当前会话一样（当前会话的权限、预设、工作区不在可选里时
 * 换成可选的一项）。在选项里选「完全权限」时照官方弹出确认；要用完全权限而当前会话不是时，
 * 点「开始」或按 ⌘↵ 也先弹这个确认，确认了才开（同一张卡确认过一次就不再问）。
 *
 * 开始以后卡片收成一行状态（进行中、等待回答……，取 DSH 的会话状态，停下来的结果取宿主的
 * 回报），右上角换成「查看会话」。在当前会话处理、关闭以后卡片只留题目和一句说明。卡片和
 * 决定都在投影 workbenchSessionCards 里，动作走宿主的 /api/dsh-workbench.session-cards.act。
 * 卡片 A（ask: true，问要不要另开会话）也挂在这一轮末尾，待处理时的样子、Esc 和设置在 session-ask.js。
 */

const SESSION_CARDS_INJECT = ['uiWorkspace', 'uiSession', 'remote.agentPresets']

const SESSION_CARDS_ZH = {
  'scard.head': '新会话',
  'scard.close': '关闭',
  'scard.open': '查看会话',
  'scard.start': '开始',
  'scard.starting': '开始创建…',
  'scard.here': '在当前会话处理',
  'scard.options': '选项',
  'scard.more': '展开',
  'scard.less': '收起',
  'scard.workspace': '工作区',
  'scard.worktree': '工作树',
  'scard.worktree.none': '不使用工作树',
  'scard.worktree.new': '新建工作树',
  'scard.preset': 'Agent 预设',
  'scard.model': '模型',
  'scard.effort': '推理等级',
  'scard.permission': '权限',
  'scard.permission.read-only': '仅可查看',
  'scard.permission.workspace-write': '工作区内修改',
  'scard.permission.danger-full-access': '完全权限',
  'scard.loading': '正在加载选项…',
  'scard.loadFailed': '未能加载选项：{reason}',
  'scard.state.running': '进行中',
  'scard.state.waiting': '等待回答',
  'scard.state.approval': '等待审批',
  'scard.state.plan': '计划待审',
  'scard.state.done': '已完成',
  'scard.state.error': '错误',
  'scard.state.stopped': '已停止',
  'scard.lastLine': '最后一句：{text}',
  'scard.hereNote': '已选择在当前会话处理。',
  'scard.hereMessage': '在当前会话处理：{title}',
  'scard.defaultWorkspace': '默认工作区',
  'scard.presetName.standard': '标准模式',
  'scard.presetName.ptc': 'PTC 模式',
  'scard.presetName.minimal': '极简模式',
  'scard.presetName.cordis': '创造模式',
  'scard.dismissedNote': '已关闭，未开新会话。',
  'scard.failed': '操作未完成：{reason}',
  'scard.error.invalid-options': '选项「{field}」已不可用，请重新选择。',
  'scard.error.card-decided': '这张卡片已经处理过。',
  'scard.error.busy': '这张卡片正在处理中。',
  'scard.error.card-not-found': '找不到这张卡片，请刷新后重试。',
  'scard.error.session-unavailable': '当前会话不可用。',
  'scard.error.send-failed': '消息没有发出。',
  'scard.error.start-failed': '新建会话失败。',
  'scard.error.record-pending': '已经处理，但没能写进会话记录。再选一次同样的操作会补上记录，不会重复处理。',
  'scard.error.worktreeLeft': '新建会话失败；新建的工作树未能删除，仍在 {path}。',
  'scard.error.unknown': '和 DSH 的连接出错',
  'scard.error.other': '请刷新后重试。',
  'scard.field.workspace': '工作区',
  'scard.field.worktree': '工作树',
  'scard.field.preset': 'Agent 预设',
  'scard.field.model': '模型',
  'scard.field.effort': '推理等级',
  'scard.field.permission': '权限',
  'scard.confirm.title': '确认启用完全权限？',
  'scard.confirm.description': '启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
  'scard.confirm.acknowledge': '我已了解风险，并愿意继续',
  'scard.confirm.cancel': '取消',
  'scard.confirm.enable': '启用完全权限',
  'scard.toolRow': '提议新会话',
  'ask.question': '要另开一个会话吗？',
  'ask.new': '新建会话',
  'ask.dontAsk': '不再询问',
  'ask.alwaysNew': '总是新建会话',
  'ask.alwaysHere': '总是在当前会话处理',
  'ask.settings': '设置',
  'ask.notSaved': '「总是……」没有保存，以后仍按原来的设置处理。',
  'ask.error.notInheritable': '没有新建：新会话不能原样沿用当前会话的设置（{reason}）。',
  'ask.reason.options': '有选项已不可用',
  'ask.reason.workspace': '工作区不一致',
  'ask.reason.permission': '权限不能原样沿用',
  'ask.settingsUnavailable': '打不开插件页：请在「插件」的「已安装插件」里打开它，到「新会话卡片」一行里改。',
  'ask.row.asking': '询问是否另开会话',
  'ask.row.new': '已新建会话',
  'ask.row.here': '已选择在当前会话处理',
  'ask.row.hereSetting': '按设置在当前会话处理',
  'ask.row.hereOther': '在当前会话处理',
  'ask.setting.label': '模型提议另开会话时',
  'ask.setting.ask': '询问',
  'ask.setting.always-new': '总是新建会话',
  'ask.setting.always-here': '总是在当前会话处理',
  'ask.setting.summary': '模型提议另开会话时怎么办：询问、总是新建会话或总是在当前会话处理。',
  'ask.setting.loadFailed': '未能读取设置。',
  'ask.setting.saveFailed': '设置没有保存，请再试一次。',
}

const SESSION_CARDS_EN = {
  'scard.head': 'New session',
  'scard.close': 'Close',
  'scard.open': 'Open session',
  'scard.start': 'Start',
  'scard.starting': 'Starting…',
  'scard.here': 'Handle in this session',
  'scard.options': 'Options',
  'scard.more': 'Show more',
  'scard.less': 'Show less',
  'scard.workspace': 'Workspace',
  'scard.worktree': 'Worktree',
  'scard.worktree.none': 'No worktree',
  'scard.worktree.new': 'New worktree',
  'scard.preset': 'Agent preset',
  'scard.model': 'Model',
  'scard.effort': 'Effort',
  'scard.permission': 'Permission',
  'scard.permission.read-only': 'Read Only',
  'scard.permission.workspace-write': 'Workspace Write',
  'scard.permission.danger-full-access': 'Full access',
  'scard.loading': 'Loading options…',
  'scard.loadFailed': 'Could not load options: {reason}',
  'scard.state.running': 'In progress',
  'scard.state.waiting': 'Waiting for answer',
  'scard.state.approval': 'Waiting for approval',
  'scard.state.plan': 'Plan review',
  'scard.state.done': 'Completed',
  'scard.state.error': 'Error',
  'scard.state.stopped': 'Stopped',
  'scard.lastLine': 'Last sentence: {text}',
  'scard.hereNote': 'Chose to handle it in this session.',
  'scard.hereMessage': 'Handle it in this session: {title}',
  'scard.defaultWorkspace': 'Default workspace',
  'scard.presetName.standard': 'Standard mode',
  'scard.presetName.ptc': 'PTC mode',
  'scard.presetName.minimal': 'Minimal mode',
  'scard.presetName.cordis': 'Creator mode',
  'scard.dismissedNote': 'Closed; no session was started.',
  'scard.failed': 'Not done: {reason}',
  'scard.error.invalid-options': 'The option "{field}" is no longer available. Choose again.',
  'scard.error.card-decided': 'This card has already been handled.',
  'scard.error.busy': 'This card is being handled.',
  'scard.error.card-not-found': 'This card was not found. Refresh and try again.',
  'scard.error.session-unavailable': 'This session is unavailable.',
  'scard.error.send-failed': 'The message was not sent.',
  'scard.error.start-failed': 'New session failed.',
  'scard.error.record-pending': 'It was handled, but the session record was not updated. Choose the same action again to record it; it will not run twice.',
  'scard.error.worktreeLeft': 'New session failed; the new worktree could not be removed and is still at {path}.',
  'scard.error.unknown': 'the connection to DSH failed',
  'scard.error.other': 'Refresh and try again.',
  'scard.field.workspace': 'Workspace',
  'scard.field.worktree': 'Worktree',
  'scard.field.preset': 'Agent preset',
  'scard.field.model': 'Model',
  'scard.field.effort': 'Effort',
  'scard.field.permission': 'Permission',
  'scard.confirm.title': 'Enable Full access?',
  'scard.confirm.description': 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
  'scard.confirm.acknowledge': 'I understand the risks and want to continue',
  'scard.confirm.cancel': 'Cancel',
  'scard.confirm.enable': 'Enable Full access',
  'scard.toolRow': 'Propose a new session',
  'ask.question': 'Start this in its own session?',
  'ask.new': 'New session',
  'ask.dontAsk': "Don't ask again",
  'ask.alwaysNew': 'Always create a new session',
  'ask.alwaysHere': 'Always handle in this session',
  'ask.settings': 'Settings',
  'ask.notSaved': 'The "always" choice was not saved; later proposals follow your previous setting.',
  'ask.error.notInheritable': 'Not started: the new session cannot reuse this session\'s settings as they are ({reason}).',
  'ask.reason.options': 'an option is no longer available',
  'ask.reason.workspace': 'the workspace does not match',
  'ask.reason.permission': 'the permission cannot be reused as it is',
  'ask.settingsUnavailable': 'Could not open the plugin page. In Plugins, open it under Installed plugins and change the New session cards row.',
  'ask.row.asking': 'Asking about a new session',
  'ask.row.new': 'Started a new session',
  'ask.row.here': 'Chose to handle it in this session',
  'ask.row.hereSetting': 'Handled in this session by your setting',
  'ask.row.hereOther': 'Handled in this session',
  'ask.setting.label': 'When the model offers a new session',
  'ask.setting.ask': 'Ask',
  'ask.setting.always-new': 'Always create a new session',
  'ask.setting.always-here': 'Always handle in this session',
  'ask.setting.summary': 'When the model offers a new session: ask, always create one, or always handle it in this session.',
  'ask.setting.loadFailed': 'Could not load the setting.',
  'ask.setting.saveFailed': 'The setting was not saved. Try again.',
}

/** DSH 内置的几个 Agent 预设（界面按 id 取名字）。 */
const BUILTIN_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

/** 完全权限的取值（官方选它时要确认）。 */
const FULL_ACCESS = 'danger-full-access'

/**
 * 点「开始」（或按 ⌘↵）前要不要先确认完全权限：要用的是完全权限，而当前会话不是。纯函数。
 * @param {string | undefined} permission 卡片要用的权限。
 * @param {string | undefined} currentPermission 当前会话的权限（custom、取不到时是 undefined）。
 * @returns {boolean} 要先确认。
 */
export function needsFullAccessConfirm(permission, currentPermission) {
  return permission === FULL_ACCESS && currentPermission !== FULL_ACCESS
}

/**
 * 开始以后卡片上写什么状态：DSH 看到的会话状态优先（进行中、等待回答……），不在运行时
 * 用宿主的回报（做完、出错、被停止）。纯函数。
 * @param {{running?: boolean, pendingInteraction?: {kind?: string}} | undefined} status 新会话在 DSH 里的状态。
 * @param {{state: string} | undefined} report 宿主最近一次回报。
 * @returns {'running'|'waiting'|'approval'|'plan'|'done'|'error'|'stopped'} 状态。
 */
export function startedStateOf(status, report) {
  const kind = status?.pendingInteraction?.kind
  if (kind === 'question') return 'waiting'
  if (kind === 'approval') return 'approval'
  if (kind === 'plan-review') return 'plan'
  if (status?.running === true) return 'running'
  const reported = report?.state
  if (status === undefined) {
    // DSH 还没给出这个会话的状态（刚开、或没加载）：有回报照回报，没有就当在跑。
    return ['done', 'waiting', 'approval', 'plan', 'error', 'stopped'].includes(reported) ? reported : 'running'
  }
  // 不在运行、也没有待处理的交互：停下来了。回报说在等的那一问已经处理过，按停下来算。
  return ['done', 'error', 'stopped'].includes(reported) ? reported : 'done'
}

/** 状态对应的 DSH 状态点。 */
function dotOf(state) {
  if (state === 'running') return 'ongoing'
  if (state === 'done') return 'done'
  if (state === 'error') return 'error'
  if (state === 'stopped') return 'idle'
  return 'warning'
}

/**
 * 卡片上一行的选项摘要：工作区 · 预设 · 模型 · 推理等级 X · 权限。纯函数。
 * @param {object} options 选项（cardDefaults 的形状）。
 * @param {object} names 各项的显示名查找函数。
 * @returns {string} 摘要。
 */
export function cardSummaryOf(options, names) {
  if (options === undefined) return ''
  return [
    names.workspace(options.workspaceId),
    options.worktree ? names.worktree() : undefined,
    names.preset(options.agentPreset),
    options.model === undefined ? undefined : names.model(options.model),
    options.reasoningEffort === undefined ? undefined : names.effort(options.model, options.reasoningEffort),
    options.permission === undefined ? undefined : names.permission(options.permission),
  ].filter(part => typeof part === 'string' && part !== '').join(' · ')
}

/** 各会话的选项资料（宿主的 context 路由）和预设名：sessionId → { at, promise }。 */
const cardContexts = new Map()
/** 资料多久重读一次。 */
const CARD_CONTEXT_TTL = 15_000

/** 读这个会话的选项资料（当前会话的选项、上一次选的模型、能选的）。宿主答错误时抛出的错误带宿主的 error.code。 */
function loadCardContext(app, sessionId, fresh = false) {
  const cached = cardContexts.get(sessionId)
  if (!fresh && cached !== undefined && Date.now() - cached.at < CARD_CONTEXT_TTL) return cached.promise
  const promise = (async () => {
    const response = await fetch(`api/dsh-workbench.session-cards.context?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
    const body = await response.json()
    if (!body?.ok) throw Object.assign(new Error(`session-cards context: HTTP ${response.status}`), { code: body?.error?.code ?? `http-${response.status}` })
    let presetNames = {}
    try {
      const roster = await app.ctx.remote.agentPresets?.list?.()
      if (roster?.ok) presetNames = Object.fromEntries(roster.value.presets.map(preset => [preset.id, preset.name ?? preset.id]))
    } catch {
      // 拿不到 DSH 的预设名就用宿主给的名字或 id。
    }
    return { ...body.value, presetNames }
  })()
  cardContexts.set(sessionId, { at: Date.now(), promise })
  promise.catch(() => { if (cardContexts.get(sessionId)?.promise === promise) cardContexts.delete(sessionId) })
  return promise
}

/** 显示名查找：工作区、预设、模型、推理等级、权限。 */
function cardNamesOf(app, context) {
  const t = app.t
  const choices = context?.choices
  return {
    workspace: id => {
      const workspace = choices?.workspaces.find(item => item.id === id)
      // DSH 的默认工作区存的名字是 default-workspace，界面上叫「默认工作区」（照 workspaceDisplayTitle）。
      if (workspace?.title === 'default-workspace') return t('scard.defaultWorkspace')
      return workspace?.title || (workspace?.path ?? '').split(/[\\/]/u).filter(Boolean).at(-1) || id
    },
    worktree: () => t('scard.worktree.new'),
    // 内置预设的名字由 DSH 界面按 id 查词典（照 presetDisplayText），这里一样；自定义预设用它自己的名字。
    preset: id => (BUILTIN_PRESETS.includes(id) ? t(`scard.presetName.${id}`) : context?.presetNames?.[id] ?? choices?.presets.find(item => item.id === id)?.name ?? id),
    model: model => choices?.models.find(item => item.provider === model.provider && item.model === model.model)?.name ?? model.model,
    effort: (model, effort) => {
      const name = choices?.models.find(item => item.provider === model?.provider && item.model === model?.model)?.efforts?.find(item => item.id === effort)?.name ?? effort
      return `${t('scard.effort')} ${name}`
    },
    permission: value => {
      const known = ['read-only', 'workspace-write', FULL_ACCESS].includes(value)
      return known ? t(`scard.permission.${value}`) : choices?.permissions.find(item => item.value === value)?.name ?? value
    },
  }
}

/** 卡片有自己一句话的宿主错误码（scard.error.<码>）。 */
const CARD_ERROR_CODES = ['card-decided', 'busy', 'card-not-found', 'session-unavailable', 'send-failed', 'start-failed', 'record-pending']

/**
 * 宿主回答的错误码换成给人看的一句话，错误码本身不显示：认得的码用 scard.error.<码>，
 * 不认得的用通用的 scard.error.other，没有码（没连上 DSH、回答不是 JSON）用 scard.error.unknown。
 * 读选项失败和卡片动作失败共用。
 * @param {(key: string) => string} t 词典。
 * @param {unknown} code 宿主回答里的 error.code。
 * @returns {string} 原因。
 */
function cardErrorText(t, code) {
  if (typeof code !== 'string') return t('scard.error.unknown')
  return CARD_ERROR_CODES.includes(code) ? t(`scard.error.${code}`) : t('scard.error.other')
}

/** 宿主动作。返回 undefined 是成功，否则是给人看的原因。 */
async function sessionCardAct(app, body) {
  try {
    const response = await fetch('api/dsh-workbench.session-cards.act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (result?.ok) return undefined
    const code = result?.error?.code
    if (code === 'invalid-options') return app.t('scard.error.invalid-options', { field: app.t(`scard.field.${result.error.field ?? 'workspace'}`) })
    if (code === 'start-failed' && typeof result.error.worktree === 'string') return app.t('scard.error.worktreeLeft', { path: result.error.worktree })
    return cardErrorText(app.t, code)
  } catch {
    return app.t('scard.error.unknown')
  }
}

/** 选「完全权限」时的确认（照官方权限选择器的确认框）。 */
function FullAccessConfirm({ app, onCancel, onConfirm }) {
  const t = app.t
  const [acknowledged, setAcknowledged] = useState(false)
  return h(ui.Modal, { open: true, onClose: onCancel, title: t('scard.confirm.title'), closeLabel: t('scard.confirm.cancel'), className: 'dwb-scard-confirm' },
    h('div', { className: 'dwb-scard-confirm-body' },
      h('p', null, t('scard.confirm.description')),
      h(ui.Checkbox, { checked: acknowledged, label: t('scard.confirm.acknowledge'), onChange: () => setAcknowledged(current => !current) }),
      h('div', { className: 'dwb-scard-confirm-btns' },
        h(ui.Button, { variant: 'ghost', className: 'dwb-wrapup-btn', 'data-tone': 'secondary', onClick: onCancel }, t('scard.confirm.cancel')),
        h(ui.Button, { variant: 'primary', className: 'dwb-wrapup-btn', disabled: !acknowledged, onClick: onConfirm }, t('scard.confirm.enable')))))
}

/** 展开后的选项。改成完全权限要先确认：交给卡片弹确认框（onFullAccess），确认过的直接改。 */
function SessionCardOptions({ app, context, options, onChange, onFullAccess, acknowledged, disabled }) {
  const t = app.t
  const choices = context.choices
  const names = cardNamesOf(app, context)
  const model = choices.models.find(item => item.provider === options.model?.provider && item.model === options.model?.model)
  const modelId = item => `${item.provider}/${item.model}`
  return h('div', { className: 'dwb-scard-opts' },
    h(WorkbenchSelect, {
      label: t('scard.workspace'), value: options.workspaceId, disabled,
      options: choices.workspaces.map(item => ({ id: item.id, label: names.workspace(item.id) })),
      onChange: id => onChange({ workspaceId: id }),
    }),
    choices.worktree ? h('div', { className: 'dwb-select-field' },
      h('span', null, t('scard.worktree')),
      h(ui.SegmentedControl, {
        label: t('scard.worktree'), value: options.worktree ? 'new' : 'none', disabled,
        options: [{ value: 'none', label: t('scard.worktree.none') }, { value: 'new', label: t('scard.worktree.new') }],
        onChange: next => onChange({ worktree: next === 'new' }),
      })) : null,
    h(WorkbenchSelect, {
      label: t('scard.preset'), value: options.agentPreset, disabled,
      options: choices.presets.map(item => ({ id: item.id, label: names.preset(item.id) })),
      onChange: id => onChange({ agentPreset: id }),
    }),
    h(WorkbenchSelect, {
      label: t('scard.model'), value: options.model === undefined ? undefined : modelId(options.model), disabled,
      options: choices.models.map(item => ({ id: modelId(item), label: item.name ?? item.model })),
      onChange: (id) => {
        const next = choices.models.find(item => modelId(item) === id)
        if (next !== undefined) onChange({ model: { provider: next.provider, model: next.model }, reasoningEffort: fitEffort(options.reasoningEffort, next) })
      },
    }),
    (model?.efforts?.length ?? 0) > 0 ? h(WorkbenchSelect, {
      label: t('scard.effort'), value: options.reasoningEffort, disabled,
      options: model.efforts.map(item => ({ id: item.id, label: item.name ?? item.id })),
      onChange: id => onChange({ reasoningEffort: id }),
    }) : null,
    choices.permissions.length > 0 ? h(WorkbenchSelect, {
      label: t('scard.permission'), value: options.permission, disabled,
      options: choices.permissions.map(item => ({ id: item.value, label: names.permission(item.value) })),
      onChange: (value) => {
        if (value === FULL_ACCESS && options.permission !== FULL_ACCESS && !acknowledged) onFullAccess()
        else onChange({ permission: value })
      },
    }) : null)
}

/** 说明：超过三行收起，带「展开」「收起」。 */
function SessionCardBrief({ app, text }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (node === null || open) return undefined
    const measure = () => { setOverflows(node.scrollHeight > node.clientHeight + 1) }
    measure()
    // 中间栏变窄（打开右侧栏、缩窗口）以后说明可能就超过三行了，要跟着宽度重新量。
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [text, open])
  return h(Fragment, null,
    h('p', { ref, className: 'dwb-scard-brief', 'data-open': open ? '' : undefined }, text),
    overflows || open ? h('button', { type: 'button', className: 'dwb-linklike dwb-scard-more', onClick: () => setOpen(!open) }, app.t(open ? 'scard.less' : 'scard.more')) : null)
}

/** 一张卡。 */
function SessionCard({ app, card, sessionId, latestTurn, useSessionStatus }) {
  const t = app.t
  const pending = card.state === 'pending'
  const [context, setContext] = useState(undefined)
  const [loadError, setLoadError] = useState(undefined)
  const [edits, setEdits] = useState({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  // 正在做的动作：'start'、'here' 或 'dismiss'；没在做是 undefined。「开始创建…」只给 start。
  const [busy, setBusy] = useState(undefined)
  const idle = busy === undefined
  const [failure, setFailure] = useState(undefined)
  // 完全权限的确认框开着：'select' 是在选项里改成完全权限，'start' 是点「开始」或按 ⌘↵。
  const [confirming, setConfirming] = useState(undefined)
  // 这张卡已经确认过完全权限（改回别的权限就作废）。
  const [acknowledged, setAcknowledged] = useState(false)
  const childStatus = useSessionStatus(map => (card.childId === undefined ? undefined : map.get(card.childId)))
  // 待处理的卡要算默认选项，开始以后的卡要把用到的选项写成名字；其余两种不用读。
  const needsContext = pending || card.state === 'started'
  useEffect(() => {
    if (!needsContext) return undefined
    let live = true
    loadCardContext(app, sessionId).then((value) => { if (live) { setContext(value); setLoadError(undefined) } }, (error) => { if (live) setLoadError(cardErrorText(app.t, error?.code)) })
    return () => { live = false }
  }, [sessionId, needsContext])
  const defaults = context === undefined ? undefined
    : cardDefaults({ proposed: card.options, current: context.current, lastModel: context.lastModel ?? undefined, choices: context.choices })
  const options = defaults === undefined ? undefined : { ...defaults, ...edits }
  const act = async (verb) => {
    setBusy(verb)
    setFailure(undefined)
    const reason = await sessionCardAct(app, { sessionId, cardId: card.id, verb, ...(verb === 'start' ? { options } : {}), ...(verb === 'here' ? { text: t('scard.hereMessage', { title: card.title }) } : {}) })
    setBusy(undefined)
    if (reason !== undefined) setFailure(reason)
    else if (verb === 'start') cardContexts.delete(sessionId)
  }
  /**
   * 点「开始」或按 ⌘↵：要用完全权限而当前会话不是、这张卡又没确认过时，先弹确认。卡片等待时当前会话的
   * 权限可能在官方的权限菜单里改过，所以按重读到的权限判断；读不到就不开始，写明原因。
   */
  const requestStart = async () => {
    if (options === undefined || !idle) return
    setBusy('start')
    setFailure(undefined)
    let permission
    try {
      permission = (await loadCardContext(app, sessionId, true)).current?.permission
    } catch (error) {
      setFailure(cardErrorText(t, error?.code))
      return
    } finally {
      setBusy(undefined)
    }
    if (!acknowledged && needsFullAccessConfirm(options.permission, permission)) setConfirming('start')
    else void act('start')
  }
  const confirmFullAccess = () => {
    const reason = confirming
    setConfirming(undefined)
    setAcknowledged(true)
    if (reason === 'select') setEdits(current => ({ ...current, permission: FULL_ACCESS }))
    else void act('start')
  }
  const editOptions = (patch) => {
    if (patch.permission !== undefined && patch.permission !== FULL_ACCESS) setAcknowledged(false)
    setEdits(current => ({ ...current, ...patch }))
  }
  const nextKey = `card:${card.id}`
  useOfferNextStep(sessionId, nextKey, pending && card.turn === latestTurn && options !== undefined && idle
    ? { kind: 'card', order: card.order, run: requestStart }
    : undefined)
  const isNext = useIsNextStep(sessionId, nextKey)
  const names = cardNamesOf(app, context)
  if (!pending) {
    const started = card.state === 'started'
    const state = started ? startedStateOf(childStatus, card.report) : undefined
    return h('section', { className: 'dwb-scard', 'data-testid': 'dwb-session-card', 'data-state': card.state, 'aria-label': t('scard.head') },
      h('div', { className: 'dwb-scard-head' },
        started
          ? h('span', { className: 'dwb-scard-state', 'data-state': state },
            h('span', { className: 'dwb-scard-dot', 'aria-hidden': true }, h(ui.StateDot, { state: dotOf(state) })),
            t(`scard.state.${state}`))
          : h('span', null, t('scard.head')),
        started && card.childId !== undefined
          ? h(ui.Button, { variant: 'ghost', className: 'dwb-wrapup-close', 'aria-label': t('scard.open'), title: t('scard.open'), onClick: () => app.ctx.uiWorkspace.openSession(card.childId) },
            h(ui.IconRightUpOutlineRegular, { size: 16 }))
          : null),
      h('p', { className: 'dwb-scard-title' }, card.title),
      started && context !== undefined && card.started !== undefined ? h('p', { className: 'dwb-scard-summary' }, cardSummaryOf(card.started, names)) : null,
      started && card.report?.last ? h('p', { className: 'dwb-scard-report' }, t('scard.lastLine', { text: card.report.last })) : null,
      card.state === 'here' ? h('p', { className: 'dwb-scard-note' }, t('scard.hereNote')) : null,
      card.state === 'dismissed' ? h('p', { className: 'dwb-scard-note' }, t('scard.dismissedNote')) : null)
  }
  return h('section', { className: 'dwb-scard', 'data-testid': 'dwb-session-card', 'data-state': 'pending', 'aria-label': t('scard.head') },
    h('div', { className: 'dwb-scard-head' },
      h('span', null, t('scard.head')),
      h(ui.Button, { variant: 'ghost', className: 'dwb-wrapup-close', 'aria-label': t('scard.close'), disabled: !idle, onClick: () => { void act('dismiss') } },
        h(ui.IconCloseOutlineRegular, { size: 16 }))),
    h('p', { className: 'dwb-scard-title' }, card.title),
    h(SessionCardBrief, { app, text: card.brief }),
    options === undefined
      ? h('p', { className: 'dwb-scard-summary' }, loadError === undefined ? t('scard.loading') : t('scard.loadFailed', { reason: loadError }))
      : optionsOpen
        ? h(SessionCardOptions, { app, context, options, acknowledged, disabled: !idle, onChange: editOptions, onFullAccess: () => setConfirming('select') })
        : h('p', { className: 'dwb-scard-summary' }, cardSummaryOf(options, names)),
    h('div', { className: 'dwb-wrapup-btns' },
      h(ui.Button, { variant: 'primary', className: 'dwb-wrapup-btn', disabled: !idle || options === undefined, onClick: requestStart },
        h('span', null, t(busy === 'start' ? 'scard.starting' : 'scard.start')), isNext && idle ? h(NextStepKeys, { app }) : null),
      h(ui.Button, { variant: 'ghost', className: 'dwb-wrapup-btn', 'data-tone': 'secondary', disabled: !idle, onClick: () => { void act('here') } },
        h('span', null, t('scard.here'))),
      h('span', { className: 'dwb-scard-spacer' }),
      h(ui.Button, { variant: 'ghost', className: 'dwb-scard-toggle', 'aria-expanded': optionsOpen, disabled: options === undefined, onClick: () => setOptionsOpen(!optionsOpen) },
        h('span', null, t('scard.options')),
        optionsOpen ? h(ui.IconChevronUpOutlineRegular, { size: 16 }) : h(ui.IconChevronDownOutlineRegular, { size: 16 }))),
    failure !== undefined ? h('p', { className: 'dwb-wrapup-note', 'data-tone': 'error', role: 'alert' }, t('scard.failed', { reason: failure })) : null,
    confirming !== undefined ? h(FullAccessConfirm, { app, onCancel: () => setConfirming(undefined), onConfirm: confirmFullAccess }) : null)
}

/** 这一轮末尾的卡片。 */
function SessionCards(props) {
  const { app, turn, useProjection, sessionId, useSessionStatus } = props
  const view = useProjection('workbenchSessionCards')
  const number = typeof turn?.turn === 'number' ? turn.turn : undefined
  // 卡片 A 也挂在这里；按设置在当前会话处理的不出卡（askCardShown，session-ask.js）。
  const cards = view === undefined || view === null || number === undefined ? [] : view.cards.filter(card => card.turn === number && askCardShown(card))
  if (cards.length === 0) return null
  return h('div', { className: 'dwb-scards' }, cards.map(card => h(card.kind === 'ask' ? AskTurnCard : SessionCard, { key: card.id, app, card, sessionId, latestTurn: view.lastTurn, useSessionStatus })))
}

/**
 * 工具行标题的键。DSH 给工具行三个阶段（rc.3 dsh-client-ui-tool 的 ToolCallViewProps）：preparing 参数
 * 还没写完；start 已经发出、在等结果，参数里 ask 为 true 就是卡片 A 正在问；result 只看结果里的卡是不是
 * 卡片 A。被拒、出错，或者选了新建会话却退回出卡（结果是卡片 B 的卡）的，写卡片 B 的「提议新会话」。结果标成
 * 出错的先算出错：包在工具外面的插件可以把成功改成错误、meta 留着成功的样子（rc.3 dsh-tools 的 pipeline.ts）。
 * @param {string} phase 工具行的阶段。
 * @param {{argsRaw?: string, meta?: unknown} | undefined} block 这一阶段的节点。
 * @returns {string} 文字的键。
 */
function sessionCardRowKey(phase, block) {
  if (phase === 'result') return block?.isError !== true && block?.meta?.ok === true && block.meta.card?.kind === 'ask' ? `ask.row.${askRowStateOf(block.meta)}` : 'scard.toolRow'
  if (phase !== 'start') return 'scard.toolRow'
  try {
    return JSON.parse(block?.argsRaw ?? '')?.ask === true ? 'ask.row.asking' : 'scard.toolRow'
  } catch {
    return 'scard.toolRow'
  }
}

/**
 * propose_session 的工具调用行：收成一行，摘要是题目。标题：卡片 B 是「提议新会话」；卡片 A 写
 * 「询问是否另开会话」「已新建会话」「已选择在当前会话处理」。
 */
function SessionCardToolRow(props) {
  const { app, phase, block } = props
  const title = phase === 'preparing' ? undefined : block?.args?.text('title')
  return h(ui.DisclosureRow, {
    icon: h(ui.IconNewChatOutlineRegular, { size: 14 }),
    title: app.t(sessionCardRowKey(phase, block)),
    open: false,
    expandable: false,
    onToggle: () => {},
    collapsedContent: toolRowSummary(title),
  })
}

/** 卡片的样式（跟收尾框同一套：.dwb-wrapup-btn、.dwb-wrapup-close、.dwb-next-keys 在 style.js）。 */
const SESSION_CARDS_CSS = `
.dwb-scards{display:grid;gap:12px;min-width:0}
.dwb-scard{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px 18px;display:grid;gap:10px;min-width:0}
.dwb-scard-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:22px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-scard-state{display:inline-flex;align-items:center;gap:6px}
.dwb-scard-dot{display:inline-grid;place-items:center;width:12px;height:12px}
.dwb-scard-dot>*{width:12px;height:12px}
.dwb-scard-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dwb-scard-brief{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dwb-scard-brief[data-open]{display:block;-webkit-line-clamp:unset;overflow:visible}
.dwb-scard-more{justify-self:start;font-size:12px;line-height:18px;margin-top:-6px}
.dwb-scard-summary,.dwb-scard-note,.dwb-scard-report{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dwb-scard-report{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dwb-scard-spacer{flex:1 1 auto}
.dwb-wrapup-btns .dwb-scard-toggle{gap:4px;padding:0 8px;color:var(--dsw-alias-label-secondary)}
.dwb-scard-opts{display:grid;gap:8px;padding-top:4px;min-width:0}
.dwb-scard-opts .dwb-select-field{grid-template-columns:84px minmax(0,1fr);align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dwb-scard-opts .dwb-select-trigger{min-height:32px;padding:0 10px;font-size:13px}
.dwb-scard-confirm-body{display:grid;gap:14px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dwb-scard-confirm-body>p{margin:0}
.dwb-scard-confirm-btns{display:flex;gap:8px;justify-content:flex-end}
`

/**
 * 挂卡片、工具行和 ⌘↵；返回撤销函数（这一行在插件页里关掉时，入口用它撤掉这些界面）。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数。
 */
function applySessionCards(app) {
  const { ctx } = app
  const disposers = [
    mountModuleStyle('dsh-workbench-session-cards', SESSION_CARDS_CSS),
    mountNextStepKeys(app),
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
      { name: 'conversation.chat.turnTail', id: 'dsh-workbench-session-cards', order: 15 },
      (props) => h(SessionCards, { app, ...props }))),
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key: 'propose_session' },
      (props) => h(SessionCardToolRow, { app, ...props }))),
    applySessionAsk(app),
  ]
  return () => {
    cardContexts.clear()
    for (const dispose of disposers.reverse()) dispose()
  }
}

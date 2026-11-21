/**
 * 卡片 A（feat#160 的另一半，dsh-workbench/session-cards 行的网页部分）：模型调 propose_session 并填
 * ask: true 时，宿主在这一轮末尾出一张待处理的卡片 A（投影 workbenchSessionCards 里 kind 是 ask），
 * 这一轮照常结束。卡片和卡片 B 一样挂在这一轮末尾（session-cards.js 的 SessionCards），输入框一直能用。
 *
 * 卡片：问句占顶上一条；题目；「选项」后面是「不再询问」下拉菜单，菜单里是「总是新建会话」「总是在
 * 当前会话处理」和「设置」（打开插件页的工作台）；按钮靠右：「在当前会话处理」（Esc）、「新建会话」
 * （⌘↵，推荐）。动作走宿主的 /api/dsh-workbench.session-cards.act：新建会话是 start，宿主用当前会话的
 * 设置，网页不传选项；在当前会话处理是 here，和卡片 B 一样以用户的名义发一句；「总是……」带上 remember。
 *
 * 键：⌘↵ 走下一步框的推荐动作（next-step.js），和卡片 B 的「开始」一样。Esc 只认最新一轮的待处理卡片 A：
 * 焦点在页面上（不在输入框和别的可编辑区域里）、没有弹窗菜单弹层、会话没在运行、没有待处理的交互。
 * DSH 在会话运行时连按两下 Esc 停止这一轮（rc.3 dsh-client-ui-conversation 的 stop-shortcut.ts），焦点多半在
 * 输入框里；输入框里的 Esc 不算，这一轮刚好停下时，停止的那一下就不会替用户选「在当前会话处理」。按钮上的
 * Esc 也只在焦点在页面上时标出。Esc 挂在冒泡阶段，轮次预览、查找条这些上层收起了东西（defaultPrevented）
 * 的那一下不算。
 *
 * 处理以后：开了会话的、用户在卡片上选了在当前会话处理的，显示同卡片 B 的已处理卡；按设置处理的不出卡。
 * 插件页那一行的设置（plugins.row.config）读写宿主的 /api/dsh-workbench.session-cards.prefs。
 */

/**
 * 这一行在插件页里的键（包名#行 id）。要写成一整个字面量：单装包构建（scripts/build-packs.mjs 的
 * clientBundle）只替换引号里的「整包名#」，拼出来的键换不到。
 */
const SESSION_CARDS_ROW = '@miint-sunny/dsh-workbench#dsh-workbench-session-cards'
/** 工作台在插件页里的包名（「设置」打开它）：取自上面的键，单装包里跟着换成小包名。 */
const WORKBENCH_PACKAGE = SESSION_CARDS_ROW.slice(0, SESSION_CARDS_ROW.indexOf('#'))
/** 设置的路由。 */
const ASK_PREFS_PATH = 'api/dsh-workbench.session-cards.prefs'
/** 新建会话带不过去时宿主给的原因（scard 的 notStartedReasons 同名）。 */
const ASK_REASONS = ['options', 'workspace', 'permission']

/**
 * 这张卡要不要挂在这一轮末尾：卡片 B 都挂；卡片 A 里，按设置处理的，以及上一版在通用界面里回答的
 * （没有人在卡片上选），在当前会话处理以后不出卡。纯函数。
 * @param {{kind?: string, state: string, ask?: {auto?: string, custom?: string}}} card 投影里的卡。
 * @returns {boolean} 挂不挂。
 */
export function askCardShown(card) {
  if (card.kind !== 'ask' || card.state !== 'here') return true
  return card.ask?.auto === undefined && card.ask?.custom === undefined
}

/**
 * 这次按键是不是卡片 A 的 Esc：带修饰键、按住不放的重复、输入法组字都不算。纯函数。
 * @param {{key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, repeat?: boolean, isComposing?: boolean} | undefined} event 键盘事件。
 * @returns {boolean} 是不是。
 */
export function askEscOf(event) {
  if (event?.key !== 'Escape') return false
  return !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing)
}

/**
 * Esc 这一下要不要回答卡片 A（在当前会话处理）。规矩同 next-step.js 的 shouldRunNextStep，只是焦点只认页面：
 * 空的输入框也不算（见文件开头）。纯函数。
 * @param {{focus: string, modal: string | null | undefined, overlay?: boolean, running?: boolean, pending?: boolean}} input
 *   焦点（focusKindOf 的结果）、最上面一层弹窗、有没有开着的菜单／候选列表／弹层、会话在不在运行、有没有待处理的交互。
 * @returns {boolean} 要不要。
 */
export function askEscAnswers({ focus, modal, overlay = false, running = false, pending = false }) {
  if (overlay || running || pending) return false
  // DSH 把焦点在侧边栏也记成 modal 'sidebar'，那不是弹窗。
  if (modal !== null && modal !== undefined && modal !== 'sidebar') return false
  return focus === 'page'
}

/**
 * 焦点在不在页面上（focusKindOf 是 page）：按钮上的 Esc 只在这时标出。随 focusin、focusout 更新。
 * @param {boolean} enabled 这张卡接不接 Esc；不接时不装监听，返回 false。
 * @returns {boolean} 在页面上。
 */
function usePageFocus(enabled) {
  // 网页测试的环境里可能没有 document，按焦点在页面上算。
  const read = () => focusKindOf(typeof document === 'undefined' ? null : document.activeElement, () => false) === 'page'
  const [page, setPage] = useState(() => enabled && read())
  useEffect(() => {
    if (!enabled) return undefined
    const update = () => { setPage(read()) }
    update()
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    return () => {
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
    }
  }, [enabled])
  return enabled && page
}

/**
 * 工具行上写什么：还在问（运行中，或者卡片待处理）；开了会话；用户在卡片上选了在当前会话处理；按设置
 * 在当前会话处理；上一版里没有人选（没有界面能回答，或者用户在通用界面里自己打字回复）。纯函数。
 * @param {unknown} meta 工具结果的 meta（{ ok, card }）；还没有结果时 undefined。
 * @returns {'asking' | 'new' | 'here' | 'hereSetting' | 'hereOther'} 工具行的状态。
 */
export function askRowStateOf(meta) {
  const ask = meta?.ok === true ? meta.card?.ask : undefined
  if (ask?.choice === 'new' && typeof meta.card.started?.childId === 'string') return 'new'
  if (ask?.choice !== 'here') return 'asking'
  if (ask.auto === 'setting') return 'hereSetting'
  return ask.auto === undefined && ask.custom === undefined ? 'here' : 'hereOther'
}

/**
 * 各会话最新一轮的待处理卡片 A：sessionId → 选择函数，按挂上的先后排。同一会话可能同时开着几张（复制
 * 出来的侧栏标签），是同一张卡；Esc 交给最后挂上、还在的那张，关掉其中一张不影响别的。
 */
const askCards = new Map()

/** Esc 在这台设备上的写法（DSH 的 describeBinding）；拿不到就写 Esc。 */
function escKeys(shortcuts) {
  try {
    const keys = shortcuts?.describeBinding?.({ code: 'Escape', modifiers: [] })?.keys
    if (Array.isArray(keys) && keys.length > 0) return keys
  } catch {
    // 拿不到就用下面的默认写法。
  }
  return ['Esc']
}

/** 打开插件页里的工作台（「设置」）。打不开返回 false。 */
function openWorkbenchSettings(app) {
  const navigation = app.ctx.get?.('pluginNavigation')
  if (typeof navigation?.openBundle !== 'function') return false
  navigation.openBundle(WORKBENCH_PACKAGE)
  return true
}

/**
 * 卡片 A 的动作（宿主的 /act）。
 * @param {object} app 入口准备的上下文。
 * @param {{sessionId: string, cardId: string, verb: 'start' | 'here', text?: string, remember?: 'always-new' | 'always-here'}} body 请求体。
 * @returns {Promise<{reason?: string, notSaved?: boolean}>} reason 是失败时给人看的原因；notSaved 是「总是……」的设置没存上。
 */
async function askCardAct(app, body) {
  const t = app.t
  try {
    const response = await fetch('api/dsh-workbench.session-cards.act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (result?.ok) return { notSaved: result.notSaved === true }
    const code = result?.error?.code
    if (code === 'ask-not-inheritable') {
      const reason = ASK_REASONS.includes(result.error.reason) ? result.error.reason : 'options'
      return { reason: t('ask.error.notInheritable', { reason: t(`ask.reason.${reason}`) }) }
    }
    if (code === 'start-failed' && typeof result.error.worktree === 'string') return { reason: t('scard.error.worktreeLeft', { path: result.error.worktree }) }
    return { reason: cardErrorText(t, code) }
  } catch {
    return { reason: t('scard.error.unknown') }
  }
}

/**
 * 这一轮末尾的卡片 A。待处理时是问句、题目、「不再询问」菜单和两个按钮；处理以后同卡片 B 的已处理卡
 * （SessionCard），「总是……」的设置没存上时在下面写一句。属性同 SessionCard。
 */
function AskTurnCard(props) {
  const { app, card, sessionId, latestTurn } = props
  const t = app.t
  const pending = card.state === 'pending'
  // 正在做的动作：'start' 或 'here'；没在做是 undefined。「开始创建…」只给 start。
  const [busy, setBusy] = useState(undefined)
  const [failure, setFailure] = useState(undefined)
  const [note, setNote] = useState(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const act = async (choice) => {
    if (busy !== undefined || !pending) return
    const verb = choice === 'new' || choice === 'always-new' ? 'start' : 'here'
    const remember = choice === 'always-new' || choice === 'always-here' ? choice : undefined
    setBusy(verb)
    setFailure(undefined)
    setNote(undefined)
    const result = await askCardAct(app, {
      sessionId, cardId: card.id, verb,
      ...(verb === 'start' ? {} : { text: t('scard.hereMessage', { title: card.title }) }),
      ...(remember === undefined ? {} : { remember }),
    })
    if (!live.current) return
    setBusy(undefined)
    if (result.reason !== undefined) setFailure(result.reason)
    else if (result.notSaved) setNote(t('ask.notSaved'))
  }
  const actRef = useRef(act)
  actRef.current = act
  // 键只给最新一轮的待处理卡：⌘↵ 走下一步框的推荐动作，Esc 走 installAskKeys。
  const offered = pending && card.turn === latestTurn
  useEffect(() => {
    if (!offered || sessionId === undefined) return undefined
    const run = () => { void actRef.current('here') }
    askCards.set(sessionId, [...askCards.get(sessionId) ?? [], run])
    return () => {
      const rest = (askCards.get(sessionId) ?? []).filter(item => item !== run)
      if (rest.length === 0) askCards.delete(sessionId)
      else askCards.set(sessionId, rest)
    }
  }, [sessionId, offered])
  const idle = busy === undefined
  const nextKey = `card:${card.id}`
  useOfferNextStep(sessionId, nextKey, offered && idle ? { kind: 'card', order: card.order, run: () => { void actRef.current('new') } } : undefined)
  const isNext = useIsNextStep(sessionId, nextKey)
  const escShown = usePageFocus(offered)
  if (!pending) {
    return h(Fragment, null, h(SessionCard, props), note === undefined ? null : h('p', { className: 'dwb-wrapup-note', role: 'status' }, note))
  }
  const items = [
    { id: 'always-new', label: t('ask.alwaysNew') },
    { id: 'always-here', label: t('ask.alwaysHere') },
    { id: 'settings', label: t('ask.settings'), separatorBefore: true },
  ]
  const onMenu = (id) => {
    setMenuOpen(false)
    if (id !== 'settings') void act(id)
    else if (!openWorkbenchSettings(app)) setFailure(t('ask.settingsUnavailable'))
  }
  const open = menuOpen && idle
  return h('section', { className: 'dwb-ask', 'data-testid': 'dwb-ask-card', 'data-state': 'pending', 'aria-label': t('ask.question') },
    h('div', { className: 'dwb-ask-q' }, t('ask.question')),
    h('div', { className: 'dwb-ask-body' },
      h('p', { className: 'dwb-ask-title' }, card.title),
      h('div', { className: 'dwb-ask-opts' },
        h('span', null, t('scard.options')),
        h(ui.Menu, {
          open,
          onClose: () => setMenuOpen(false),
          items,
          onSelect: onMenu,
          align: 'start',
          portal: true,
          autoFocus: true,
          anchor: h('button', {
            type: 'button',
            className: 'dwb-ask-select',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            disabled: !idle,
            onClick: () => setMenuOpen(current => !current),
          },
          h('span', null, t('ask.dontAsk')),
          open ? h(ui.IconChevronUpOutlineRegular, { size: 14 }) : h(ui.IconChevronDownOutlineRegular, { size: 14 })),
        })),
      h('div', { className: 'dwb-ask-btns' },
        h(ui.Button, { variant: 'ghost', className: 'dwb-wrapup-btn', 'data-tone': 'secondary', disabled: !idle, onClick: () => { void act('here') } },
          h('span', null, t('scard.here')), escShown && idle ? h(ui.ShortcutKeys, { keys: escKeys(app.ctx.shortcuts), className: 'dwb-next-keys' }) : null),
        h(ui.Button, { variant: 'primary', className: 'dwb-wrapup-btn', disabled: !idle, onClick: () => { void act('new') } },
          h('span', null, t(busy === 'start' ? 'scard.starting' : 'ask.new')), isNext && idle ? h(NextStepKeys, { app }) : null)),
      failure === undefined ? null : h('p', { className: 'dwb-wrapup-note', 'data-tone': 'error', role: 'alert' }, failure)))
}

/** 装上 Esc 的监听（冒泡阶段，见文件开头）；返回撤销函数。 */
function installAskKeys(app) {
  const { ctx } = app
  const onKeyDown = (event) => {
    if (!askEscOf(event) || event.defaultPrevented) return
    const element = keyTargetOf(event)
    const sessionId = element?.closest?.('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? mainViewSession(ctx)
    const run = sessionId === undefined ? undefined : askCards.get(sessionId)?.at(-1)
    if (run === undefined) return
    const binding = ctx.sessions?.binding?.(sessionId)
    const focus = focusKindOf(element, () => {
      try {
        return composerIsEmpty(ctx.conversation?.input?.for(binding.ctx)?.state?.getSnapshot())
      } catch {
        return false
      }
    })
    const running = binding?.session?.getSnapshot?.()?.running === true
    if (!askEscAnswers({ focus, modal: topModal(), overlay: overlayOpen(), running, pending: pendingInteractionOf(ctx, sessionId) })) return
    event.preventDefault()
    event.stopPropagation()
    run()
  }
  window.addEventListener('keydown', onKeyDown)
  return () => { window.removeEventListener('keydown', onKeyDown) }
}

/** 读设置；读不到时抛错。 */
async function loadAskPrefs() {
  const response = await fetch(ASK_PREFS_PATH, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return ownSessionPrefsOf(await response.json())
}

/** 存设置；存不进时抛错。 */
async function saveAskPrefs(ownSession) {
  const response = await fetch(ASK_PREFS_PATH, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownSession }),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body?.ok !== true) throw new Error(body?.message ?? `HTTP ${response.status}`)
  return ownSessionPrefsOf(body.config)
}

/** 插件页里这一行的设置：「模型提议另开会话时」，选了就存。 */
function AskPrefsPage({ app }) {
  const t = app.t
  const [prefs, setPrefs] = useState(undefined)
  const [failure, setFailure] = useState(undefined)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let live = true
    loadAskPrefs().then((value) => { if (live) setPrefs(value) }, () => { if (live) setFailure(t('ask.setting.loadFailed')) })
    return () => { live = false }
  }, [])
  if (prefs === undefined) return failure === undefined ? null : h('p', { className: 'dwb-wrapup-note', 'data-tone': 'error', role: 'alert' }, failure)
  const change = async (next) => {
    if (next === prefs.ownSession) return
    setSaving(true)
    setFailure(undefined)
    try {
      setPrefs(await saveAskPrefs(next))
    } catch {
      setFailure(t('ask.setting.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  return h('div', { className: 'dwb-ask-prefs' },
    h(WorkbenchSelect, {
      label: t('ask.setting.label'),
      value: prefs.ownSession,
      disabled: saving,
      options: OWN_SESSION_MODES.map(mode => ({ id: mode, label: t(`ask.setting.${mode}`) })),
      onChange: (next) => { void change(next) },
    }),
    failure === undefined ? null : h('p', { className: 'dwb-wrapup-note', 'data-tone': 'error', role: 'alert' }, failure))
}

/** 插件页这一行：收起时一句说明，展开时是设置。 */
function AskPrefsEntry(props) {
  const { app, view } = props
  return view === 'summary' ? app.t('ask.setting.summary') : h(AskPrefsPage, { app })
}

/**
 * 卡片 A 的样式：外框同卡片 B（.dwb-scard），宽度跟着这一轮末尾的卡片区（.dwb-scards）；问句一条用
 * 第二层底色，按钮靠右、换行时也靠右。
 */
const SESSION_ASK_CSS = `
.dwb-ask{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0;overflow:visible}
.dwb-ask-q{padding:9px 16px;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dwb-ask-body{display:grid;gap:12px;padding:12px 16px 14px;min-width:0}
.dwb-ask-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dwb-ask-opts{display:flex;align-items:center;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dwb-ask-select{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dwb-ask-select>svg{display:block;flex:none}
.dwb-ask-select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwb-ask-select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dwb-ask-btns{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.dwb-ask-prefs{display:grid;gap:8px;min-width:0}
`

/**
 * 挂卡片 A：样式、Esc、插件页那一行的设置；返回撤销函数（session-cards 行关掉时调）。卡片本身由
 * SessionCards 挂在这一轮末尾。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数。
 */
function applySessionAsk(app) {
  const { ctx } = app
  const disposers = [
    mountModuleStyle('dsh-workbench-session-ask', SESSION_ASK_CSS),
    installAskKeys(app),
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
      { name: 'plugins.row.config', key: SESSION_CARDS_ROW, locale: '@miint-sunny/dsh-workbench' },
      (props) => h(AskPrefsEntry, { app, ...props }))),
  ]
  return () => {
    askCards.clear()
    for (const dispose of disposers.reverse()) dispose()
  }
}

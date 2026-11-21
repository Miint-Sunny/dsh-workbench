/**
 * 推荐的下一步和 ⌘↵（feat#166 收尾框、feat#160 新会话卡片共用）。收尾框的第一个按钮、
 * 新会话卡片的「开始」登记成所在会话「推荐的下一步」；⌘↵（Ctrl+↵）执行其中一个，只有
 * 会被执行的那个按钮标出键位。
 *
 * DSH 里 ⌘↵ 原来的用途（App 0.2.2-rc.3 源码核实，ui-conversation 的 keymap 和
 * view-binding）：输入框里是「加速回车」——空闲时和回车一样发送草稿；运行中用和回车
 * 互补的方式（排队↔插话）发送；运行中草稿是空的，把排队的消息插进这一轮。快捷键登记
 * 里它是固定按键 fixed.complementary；⌥⌘↵ 另有用途（右侧栏窗格全屏）。所以：
 * - 会话运行中不执行（收尾框的按钮这时本来就收起了，⌘↵ 留给 DSH 的排队／插话）；
 * - 会话有待处理的交互（等待回答、审批、计划审阅，rc.3 的 uiSession.sessionStatus 里的
 *   pendingInteraction）时不执行，输入框这时归审阅面板；
 * - 焦点不在任何输入框里，或者在这个会话的输入框里且输入框是空的（没有文字、附件、引用），
 *   才执行推荐项；输入框里有内容就照常发送；
 * - 别的输入框（编辑重发、评论框、查找条、任何 contenteditable，含 plaintext-only）、终端、
 *   弹窗里一概不管；页面上开着菜单、候选列表或弹层（输入框的「+」候选、下拉菜单、右键菜单、
 *   锚在按钮上的面板，工作台自己的视口尺寸面板等）时也不管，按键留给它们；
 * - 收尾框有按钮时执行它的推荐项，没有就执行最新一轮第一张待处理的新会话卡片的「开始」。
 * 监听挂在 window 的捕获阶段：要在输入框（Lexical）处理回车之前看草稿是不是空的——
 * 它发送以后草稿就清空了，冒泡阶段分不出来。执行时拦下这个按键，输入框不再收到。
 */

/** 能编辑的元素（照 DSH 快捷键分区的判据，加上 plaintext-only；元素的 isContentEditable 也算）。 */
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'

/**
 * 开着时 ⌘↵ 留给它们的菜单、候选列表和弹层（rc.3 核对）：DSH 的下拉菜单、右键菜单（role=menu，
 * ui.modalSelector 也算它）；输入框的「+」候选、命令参数候选、时间选择（role=listbox，不在
 * ui.modalSelector 里）；锚在按钮上的面板（role=dialog 而不 aria-modal，比如本轮用量、上下文
 * 用量、子智能体树、审批的风险说明）；DSH 菜单的外层（data-menu-material），命令参数菜单正在读取或读取失败、
 * 只有提示和「重试」按钮时靠它认出；工作台自己的弹层：视口尺寸面板、重新运行的编辑框、回复卡片。
 */
const OPEN_OVERLAYS = '[role="menu"], [role="listbox"], [role="dialog"], [data-menu-material], .dwb-bv-menu, .dwb-rr-pop, .dwb-reply-surface'

/**
 * 这次按键是不是 ⌘↵／Ctrl+↵。DSH 输入框把 Ctrl 和 ⌘ 都当加速键，这里跟它一样；多按了
 * ⇧、⌥ 或两个一起按的不算（⌥⌘↵ 是窗格全屏），按住不放的重复和输入法组字也不算。纯函数。
 * @param {{code: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, repeat: boolean, isComposing: boolean} | undefined} event 键盘事件。
 * @returns {boolean} 是不是。
 */
export function isNextStepChord(event) {
  if (event === undefined || event === null) return false
  if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return false
  if (event.metaKey === event.ctrlKey) return false
  if (event.altKey || event.shiftKey || event.repeat || event.isComposing) return false
  return true
}

/**
 * ⌘↵ 该不该执行推荐的下一步。纯函数，规则见文件头。
 * @param {{chord: boolean, focus: 'page'|'composer-empty'|'composer-filled'|'editable'|'terminal', modal: string|null|undefined, overlay?: boolean, pending?: boolean, running: boolean, hasTarget: boolean}} input
 *   按键和焦点、最上面一层弹窗、有没有开着的菜单／候选列表／弹层、会话有没有待处理的交互、是否在运行、有没有推荐项。
 * @returns {boolean} 执行就是 true。
 */
export function shouldRunNextStep({ chord, focus, modal, overlay = false, pending = false, running, hasTarget }) {
  if (!chord || !hasTarget || running || pending || overlay) return false
  // DSH 把焦点在侧边栏也记成 modal 'sidebar'，那不是弹窗。
  if (modal !== null && modal !== undefined && modal !== 'sidebar') return false
  return focus === 'page' || focus === 'composer-empty'
}

/**
 * 焦点在哪儿。会话由同一个元素往上找，所以找到的输入框就是这个会话的。
 * @param {{closest(selector: string): unknown, isContentEditable?: boolean} | null | undefined} element 按键时的焦点元素。
 * @param {() => boolean} composerEmpty 只在焦点是输入框时才问：这个会话的输入框是不是空的。
 * @returns {'page'|'composer-empty'|'composer-filled'|'editable'|'terminal'} 焦点的种类。
 */
export function focusKindOf(element, composerEmpty) {
  if (element === null || element === undefined || typeof element.closest !== 'function') return 'page'
  if (element.closest('.xterm')) return 'terminal'
  if (!element.closest(EDITABLE) && element.isContentEditable !== true) return 'page'
  if (element.closest('[data-input-scroll]')) return composerEmpty() ? 'composer-empty' : 'composer-filled'
  return 'editable'
}

/**
 * 输入框是不是空的：普通状态（不在发送、不在跑命令），没有文字、附件和引用。只有空格也算有字。
 * @param {{phase: string, draft: string, attachmentIds: unknown[], occurrences: unknown[]} | undefined} snapshot DSH 输入框的状态。
 * @returns {boolean} 是空的。
 */
export function composerIsEmpty(snapshot) {
  if (snapshot === undefined || snapshot === null) return false
  return snapshot.phase === 'plain' && snapshot.draft === ''
    && (snapshot.attachmentIds?.length ?? 0) === 0 && (snapshot.occurrences?.length ?? 0) === 0
}

/**
 * 一个会话里登记的推荐项里挑一个：收尾框优先，其次 order 最小的新会话卡片。纯函数。
 * @param {Array<{key: string, kind: 'wrapup'|'card', order: number}>} candidates 登记的推荐项。
 * @returns {string | undefined} 选中的 key；没有就是 undefined。
 */
export function pickNextStep(candidates) {
  let best
  for (const candidate of candidates) {
    if (best === undefined) { best = candidate; continue }
    const rank = item => (item.kind === 'wrapup' ? 0 : 1)
    if (rank(candidate) < rank(best) || (rank(candidate) === rank(best) && candidate.order < best.order)) best = candidate
  }
  return best?.key
}

/**
 * 各会话登记的推荐项：sessionId → Map(key → [{ key, kind, order, run }])。同一会话可能同时开着几份
 * （复制出来的侧栏标签），同一个推荐项每份各登记一条，按登记的先后排；关掉一份只撤它自己那条。
 */
const nextSteps = new Map()
/** 推荐项变了要通知的组件。 */
const nextStepWatchers = new Set()

/** 通知所有在看推荐项的组件。 */
function announceNextSteps() {
  for (const watcher of [...nextStepWatchers]) watcher()
}

/**
 * 登记一个推荐项；返回撤销函数（按钮不能点了、组件卸载时调用）。
 * @param {string} sessionId 会话。
 * @param {string} key 推荐项的 key，同一会话里唯一。
 * @param {{kind: 'wrapup'|'card', order: number, run: () => void}} step 推荐项。
 * @returns {() => void} 撤销函数。
 */
export function offerNextStep(sessionId, key, step) {
  let entries = nextSteps.get(sessionId)
  if (entries === undefined) { entries = new Map(); nextSteps.set(sessionId, entries) }
  const entry = { key, ...step }
  entries.set(key, [...entries.get(key) ?? [], entry])
  announceNextSteps()
  return () => {
    const current = nextSteps.get(sessionId)
    const list = current?.get(key)
    if (list === undefined || !list.includes(entry)) return
    const rest = list.filter(item => item !== entry)
    if (rest.length > 0) current.set(key, rest)
    else current.delete(key)
    if (current.size === 0) nextSteps.delete(sessionId)
    announceNextSteps()
  }
}

/**
 * 这个会话 ⌘↵ 会执行的推荐项。
 * @param {string | undefined} sessionId 会话。
 * @returns {string | undefined} 推荐项的 key。
 */
export function nextStepOf(sessionId) {
  const entries = sessionId === undefined ? undefined : nextSteps.get(sessionId)
  return entries === undefined ? undefined : pickNextStep([...entries.values()].map(list => list.at(-1)))
}

/**
 * 执行这个会话的推荐项（⌘↵ 落到这里）：同一个推荐项开着几份时，交给最后登记、还在的那份。
 * @param {string | undefined} sessionId 会话。
 * @returns {boolean} 有推荐项并执行了。
 */
export function runNextStep(sessionId) {
  const key = nextStepOf(sessionId)
  const entry = key === undefined ? undefined : nextSteps.get(sessionId)?.get(key)?.at(-1)
  if (entry === undefined) return false
  entry.run()
  return true
}

/** 组件里登记推荐项：step 是 undefined 时不登记（按钮不能点）。run 总是调最新一次渲染给的。 */
function useOfferNextStep(sessionId, key, step) {
  const runRef = useRef(undefined)
  runRef.current = step?.run
  const live = step !== undefined
  const kind = step?.kind
  const order = step?.order
  useEffect(() => {
    if (!live || sessionId === undefined) return undefined
    return offerNextStep(sessionId, key, { kind, order, run: () => { runRef.current?.() } })
  }, [sessionId, key, live, kind, order])
}

/** 组件里看：⌘↵ 现在会不会执行这个 key（会就在按钮上标出键位）。 */
function useIsNextStep(sessionId, key) {
  const [current, setCurrent] = useState(() => nextStepOf(sessionId))
  useEffect(() => {
    const update = () => { setCurrent(nextStepOf(sessionId)) }
    update()
    nextStepWatchers.add(update)
    return () => { nextStepWatchers.delete(update) }
  }, [sessionId])
  return current === key
}

/** ⌘↵ 在这台设备上的写法（DSH 的 describeBinding）；拿不到就按苹果的写。 */
function nextStepKeys(shortcuts) {
  try {
    const keys = shortcuts?.describeBinding?.({ code: 'Enter', modifiers: ['primary'] })?.keys
    if (Array.isArray(keys) && keys.length > 0) return keys
  } catch {
    // 拿不到就用下面的默认写法。
  }
  return ['⌘', '↵']
}

/** 推荐按钮里的键位标识（DSH 的 ShortcutKeys）。 */
function NextStepKeys({ app }) {
  return h(ui.ShortcutKeys, { keys: nextStepKeys(app.ctx.shortcuts), className: 'dwb-next-keys' })
}

/** 主对话区的会话（面板页没有对话时没有）。 */
function mainViewSession(ctx) {
  if (ctx.layout?.panelInfo?.getSnapshot?.()?.activePanelId != null) return undefined
  return ctx.uiSession?.adapter?.current?.getSnapshot?.()?.key
}

/** 按键时的焦点元素：事件路径上的第一个元素，没有就用 activeElement。 */
function keyTargetOf(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  return path.find(node => node instanceof Element) ?? document.activeElement
}

/** 最上面一层弹窗的名字（照 DSH 快捷键的做法）；没有弹窗是 null。 */
function topModal() {
  const dialogs = document.querySelectorAll(ui.modalSelector)
  const top = dialogs[dialogs.length - 1]
  return top === undefined ? null : top.dataset?.shortcutModal ?? 'other'
}

/**
 * 页面上有没有开着、看得见的菜单、候选列表或弹层（OPEN_OVERLAYS）。要把 `visibility: hidden` 算作看不见：
 * rc.3 在窄窗口里把左侧导航做成 role="dialog" 的抽屉，收起时就是这样留在 DOM 里，不带这个选项的
 * checkVisibility 会把它当成开着。
 */
function overlayOpen() {
  return [...document.querySelectorAll(OPEN_OVERLAYS)].some(node => typeof node.checkVisibility !== 'function'
    || node.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }))
}

/** 这个会话有没有待处理的交互（等待回答、审批、计划审阅）。 */
function pendingInteractionOf(ctx, sessionId) {
  try {
    const pending = ctx.uiSession?.sessionStatus?.getSnapshot?.()?.get?.(sessionId)?.pendingInteraction
    return pending !== undefined && pending !== null
  } catch {
    return false
  }
}

/** 装上 ⌘↵ 的监听和快捷键表里的一行；返回撤销函数。 */
function installNextStepKeys(app) {
  const { ctx, t } = app
  const disposers = []
  if (typeof ctx.shortcuts?.registerFixed === 'function') {
    try {
      // 固定按键只是在 DSH 和命令面板的快捷键表里列出来，按键由下面的监听处理。
      disposers.push(ctx.shortcuts.registerFixed({
        id: 'dsh-workbench.next-step',
        label: () => t('next.shortcut'),
        keys: nextStepKeys(ctx.shortcuts),
        bindings: [{ code: 'Enter', modifiers: ['meta'] }, { code: 'Enter', modifiers: ['control'] }],
        group: 'input',
      }))
    } catch (error) {
      ctx.logger?.warn?.(`dsh-workbench: next-step shortcut row: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const onKeyDown = (event) => {
    if (!isNextStepChord(event)) return
    const element = keyTargetOf(event)
    const sessionId = element?.closest?.('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? mainViewSession(ctx)
    const key = nextStepOf(sessionId)
    if (key === undefined) return
    const binding = ctx.sessions?.binding(sessionId)
    const running = binding?.session?.getSnapshot?.()?.running === true
    const focus = focusKindOf(element, () => {
      try {
        return composerIsEmpty(ctx.conversation?.input?.for(binding.ctx)?.state?.getSnapshot())
      } catch {
        return false
      }
    })
    const pending = pendingInteractionOf(ctx, sessionId)
    if (!shouldRunNextStep({ chord: true, focus, modal: topModal(), overlay: overlayOpen(), pending, running, hasTarget: true })) return
    event.preventDefault()
    event.stopPropagation()
    runNextStep(sessionId)
  }
  window.addEventListener('keydown', onKeyDown, true)
  disposers.push(() => { window.removeEventListener('keydown', onKeyDown, true) })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** 收尾框和新会话卡片两行都可能开着：监听只装一份，最后一个撤走时才拆。 */
let nextStepMounts = 0
let nextStepUnmount

/**
 * 挂上 ⌘↵（引用计数）。各行挂载时调用，返回自己的撤销函数。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数（重复调用无害）。
 */
export function mountNextStepKeys(app) {
  nextStepMounts += 1
  if (nextStepMounts === 1) nextStepUnmount = installNextStepKeys(app)
  let released = false
  return () => {
    if (released) return
    released = true
    nextStepMounts -= 1
    if (nextStepMounts === 0) {
      nextStepUnmount?.()
      nextStepUnmount = undefined
    }
  }
}

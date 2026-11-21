/**
 * 选中文字回复。选中回答里的文字，官方「引用文本」旁边多一个「回复」；
 * 点了出回复框，Enter 把引用和回复一起添加到输入框，可以攒好几段再发；⌘Enter 直接发这一段，不动输入框里的草稿。
 * 计划待审时回复等于要求修改，输入框被审阅面板占着：「添加到输入框」不显示，回车也不做添加，只留「发送回复」。
 * 消息使用普通 Markdown 引用；已发引用显示为灰色竖线块，关闭本行恢复官方展示。
 *
 * 做法是盖住官方的选区按钮：`conversation.chat.text-interaction` 的 key `quote`，priority -1。官方的判断
 * （哪些选区能用、哪些会话能用）、Esc 和点别处收起由 DSH 管理。回复卡片和菜单整体按会话可见范围定位，
 * 随尺寸、滚动和缩放更新；焦点进入回复框后用 CSS Highlight 保留选区。界面卸载时移除覆盖与监听。
 */
import { mountModuleStyle } from './style.js'
import { clientPlatform } from './features.js'

/** 本功能的中文界面文字。 */
export const REPLY_ZH = {
  'reply.action': '回复',
  'reply.quote': '引用文本',
  'reply.placeholder': '写下回复',
  'reply.add': '添加到输入框',
  'reply.send': '发送回复',
  'reply.addFailed': '输入框暂时无法添加引用，请稍后重试',
  'reply.disconnected': '和 DSH 的连接已断开',
  'reply.sending': '发送中…',
  'reply.textFailed': '回复暂时无法添加到输入框，请稍后重试',
  'reply.reviewQueued': '回复已排队，模型尚未收到。请重新发送，或点击「要求修改」发送',
  'reply.reviewBlocked': '当前计划无法通过回复要求修改，回复未发送',
}

/** 本功能的英文界面文字，键和 REPLY_ZH 一一对应。 */
export const REPLY_EN = {
  'reply.action': 'Reply',
  'reply.quote': 'Quote text',
  'reply.placeholder': 'Write a reply',
  'reply.add': 'Add to input',
  'reply.send': 'Send reply',
  'reply.addFailed': 'The input cannot accept a reference right now. Try again shortly.',
  'reply.disconnected': 'The connection to DSH is lost',
  'reply.sending': 'Sending…',
  'reply.textFailed': 'The reply could not be added to the input. Try again.',
  'reply.reviewQueued': 'Reply queued, but the model has not received it. Send again or choose “Request changes” to deliver it.',
  'reply.reviewBlocked': 'This plan cannot accept a reply as a change request right now. The reply was not sent.',
}

const REPLY_HIGHLIGHT = 'dwb-reply'
const REPLY_CSS = `
.dwb-reply-bar{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel)}
.dwb-reply-bar button{all:unset;padding:3px 10px;border-radius:999px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);white-space:nowrap;cursor:pointer}
.dwb-reply-bar button:focus-visible{background:var(--dsw-alias-button-floating-hover)}
.dwb-reply-surface{position:fixed;z-index:20;width:404px;box-sizing:border-box;overflow:visible;overscroll-behavior:contain;padding:12px}
.dwb-reply-card{position:relative;box-sizing:border-box;width:100%;max-width:100%;padding:10px 8px 8px 12px;border-radius:14px;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.dwb-reply-quote{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0 4px 6px 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2);font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dwb-reply-row{display:flex;align-items:flex-end;gap:8px}
.dwb-reply-input{all:unset;flex:1 1 auto;min-width:0;min-height:22px;max-height:132px;field-sizing:content;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;padding-bottom:3px}
.dwb-reply-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dwb-reply-icon{all:unset;display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px;border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dwb-reply-icon:not(:disabled){background:var(--dsw-alias-button-floating-hover)}
.dwb-reply-icon svg{width:16px;height:16px}
.dwb-reply-icon:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dwb-reply-menu{width:max-content;max-width:100%;margin:0 8px 4px auto;display:grid;gap:1px;padding:4px;border-radius:10px;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel)}
.dwb-reply-menu button{all:unset;display:flex;justify-content:space-between;gap:20px;padding:2px 8px;border-radius:6px;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dwb-reply-menu kbd{font:inherit;color:var(--dsw-alias-label-tertiary)}
.dwb-reply-menu button:focus-visible{background:var(--dsw-alias-button-floating-hover)}
.dwb-reply-error{margin:6px 4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
@media (hover:hover){.dwb-reply-bar button:hover,.dwb-reply-menu button:hover,.dwb-reply-icon:hover{background:var(--dsw-alias-button-floating-hover)}}
.dwb-reply-icon:disabled,.dwb-reply-menu button:disabled{opacity:.5;cursor:default}
.dwb-reply-bar button:focus-visible,.dwb-reply-menu button:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dwb-reply-sent-quote{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;padding-inline-start:10px;border-inline-start:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}
::highlight(dwb-reply){background-color:var(--dsw-alias-text-selection-background,Highlight)}
@media(max-width:600px){.dwb-reply-input{font-size:16px}}
`

let replyApp

/**
 * 回复发出去的消息文字：引用的每一行前面加 `> `，空一行，再是回复。和官方输入框提交引用时的写法一样。
 * @param {string} quote 选中的文字。
 * @param {string} body 回复。
 * @returns {string} 消息文字。
 */
export function replyMessageText(quote, body) {
  const quoted = quote.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')
  return `${quoted}\n\n${body.trim()}`
}

/**
 * 回复框里按键的含义。输入法组词时的 Enter 不算；Shift+Enter 留给换行。计划待审时输入框被
 * 审阅面板占着，回车不做添加（添加了也看不见），⌘Enter 的发送保留。
 * @param {{key: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, isComposing?: boolean, keyCode?: number}} event 按键。
 * @param {{reviewing?: boolean}} [state] 这个会话是不是正在等计划审阅。
 * @returns {'add' | 'send' | null} 添加到输入框、发送，或者不管。
 */
export function replyKeyAction({ key, metaKey, ctrlKey, shiftKey, isComposing, keyCode }, { reviewing = false } = {}) {
  if (key !== 'Enter' || isComposing === true || keyCode === 229 || shiftKey === true) return null
  if (metaKey === true || ctrlKey === true) return 'send'
  return reviewing ? null : 'add'
}

/**
 * 回复框的菜单给哪几项。待审时「添加到输入框」看不见也不该做，只剩「发送回复」。
 * @param {boolean} [reviewing] 这个会话是不是正在等计划审阅。
 * @returns {{add: boolean, send: boolean}} add 要不要显示「添加到输入框」；send 要不要显示「发送回复」。
 */
export function replyMenuOf(reviewing = false) {
  return { add: !reviewing, send: true }
}

/**
 * 菜单里「发送回复」旁边标的键。replyKeyAction 两种修饰键都认，这里只标这个平台习惯的那个。
 * @param {'macos' | 'windows' | 'linux'} platform clientPlatform() 的结果。
 * @returns {string} Mac 上是 ⌘ ⏎，其余平台是 Ctrl ⏎。
 */
export function replySendKey(platform) {
  return platform === 'macos' ? '⌘ ⏎' : 'Ctrl ⏎'
}

/** 空白越界可收回到原消息，真实的跨来源内容保持不变。@param {object} facts 选区来源与越界片段的可见内容。@returns {boolean} 是否收拢。 */
export function shouldClampReplySelection({ startsInSource, endsInSource, gapText }) {
  return startsInSource && !endsInSource && !/[^\s\u200b\ufeff]/u.test(gapText)
}

/**
 * 这个会话等待中的计划审阅。sessionStatus 里的 pendingInteraction 就是官方待审面板自己用的对象（kind、dismissal、dismiss），只属于这个会话，分屏里别的会话的审阅碰不到。
 * @param {{pendingInteraction?: {kind?: string}} | undefined} status ctx.uiSession.sessionStatus 里这个会话的状态。
 * @returns {object | undefined} 计划审阅；不在审阅（或者在等审批、普通提问）时 undefined。
 */
export function pendingPlanReview(status) {
  const pending = status?.pendingInteraction
  return pending?.kind === 'plan-review' ? pending : undefined
}

/**
 * 发送回复。不是待审：只排队，和以前一样。待审：先把回复排队（不打扰等待中的 exit_plan_mode），再调官方「要求修改」按钮调的同一个 dismiss——取消时排队的消息和取消说明合成同一条 user 消息送达（docs/spikes/2026-11-07-计划待审时的排队和取消.md）；反过来模型会先收到光秃秃的取消说明。排队后没取消成功时消息看着已发出、模型其实没收到，所以单独报 queued，再发只重试取消。
 * @param {object} request 发送参数。
 * @param {{dismissal: string, dismiss: () => Promise<void>} | undefined} request.review 等待中的计划审阅，见 pendingPlanReview。
 * @param {boolean} request.alreadyQueued 这条回复上一次已经排上队了。
 * @param {() => Promise<string | undefined>} request.queue 排队这条回复；失败时返回原因。
 * @returns {Promise<{state: 'sent'} | {state: 'unsent', reason: string} | {state: 'queued'} | {state: 'blocked'}>} sent 发出了；unsent 没发出，没有排队；queued 排上队了但模型没收到；blocked 这个审阅取消不了，什么都没做。
 */
export async function sendReply({ review, alreadyQueued, queue }) {
  // dismissal 'hide' 的面板关掉只是收起，等待还在：排了队也送不到模型，所以一步都不做。
  if (review !== undefined && review.dismissal !== 'cancel') return { state: 'blocked' }
  if (!alreadyQueued) {
    const failed = await queue()
    if (failed !== undefined) return { state: 'unsent', reason: failed }
  }
  if (review === undefined) return { state: 'sent' }
  try {
    await review.dismiss()
  } catch {
    return { state: 'queued' }
  }
  return { state: 'sent' }
}

function replyVisibleGapText(range) {
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue
    let visible = true
    for (let e = node.parentElement; e; e = e.parentElement) {
      const style = getComputedStyle(e)
      if (e.hidden || e.inert || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { visible = false; break }
    }
    if (visible) text += node.textContent.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : node.length)
  }
  return text
}

function clampReplySelection() {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement
  const source = element?.closest('[data-text-interaction-source]')
  if (!source?.closest('[data-slot="conversation.chat.node"]') || source.contains(range.endContainer)) return
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
  let last
  for (let text = walker.nextNode(); text; text = walker.nextNode()) last = text
  if (!last) return
  const gap = document.createRange()
  gap.setStart(last, last.length)
  gap.setEnd(range.endContainer, range.endOffset)
  if (!shouldClampReplySelection({ startsInSource: true, endsInSource: false, gapText: replyVisibleGapText(gap) })) return
  const backward = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset
  if (backward) selection.setBaseAndExtent(last, last.length, range.startContainer, range.startOffset)
  else selection.setBaseAndExtent(range.startContainer, range.startOffset, last, last.length)
}

/** 将卡片与菜单作为一个整体放在可见会话范围内。@param {object} anchor 选区矩形。@param {object} size 浮层尺寸。@param {object} bounds 可见区域。@returns {object} 固定定位与尺寸上限。 */
export function placeReplySurface(anchor, size, bounds) {
  const width = Math.max(0, Math.min(size.width, bounds.right - bounds.left - 16))
  const maxHeight = Math.max(0, bounds.bottom - bounds.top - 16)
  const height = Math.min(size.height, maxHeight)
  const above = anchor.top - height - 8
  const preferred = above >= bounds.top + 8 ? above : anchor.bottom + 8
  return { width, maxHeight, left: Math.max(bounds.left + 8, Math.min((anchor.left + anchor.right - width) / 2, bounds.right - width - 8)), top: Math.max(bounds.top + 8, Math.min(preferred, bounds.bottom - height - 8)) }
}

/** 添加引用与回复；引用已接受而文字未接受时，重试只插入文字。@param {object} actions DSH 输入框动作。@param {string} quote 引用。@param {string} body 回复。@param {boolean} quoteInserted 是否已插入引用。@returns {object} 接受状态。 */
export function addReplyToInput(actions, quote, body, quoteInserted = false) {
  if (!body.trim()) return { ok: false, quoteInserted }
  if (!quoteInserted && !actions.insertQuote(quote)) return { ok: false, quoteInserted: false }
  return { ok: actions.insertText(`${body.trim()}\n`, actions.captureInsertion()), quoteInserted: true }
}

function replyHoldHighlight(range) {
  if (range && window.CSS?.highlights && window.Highlight) window.CSS.highlights.set(REPLY_HIGHLIGHT, new window.Highlight(range))
}

function replyBounds(range) {
  const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  for (let e = range.startContainer.parentElement; e && e !== document.body; e = e.parentElement) {
    const style = getComputedStyle(e), r = e.getBoundingClientRect()
    if (/hidden|auto|scroll|clip/.test(style.overflowY) && r.height) { bounds.top = Math.max(bounds.top, r.top); bounds.bottom = Math.min(bounds.bottom, r.bottom) }
    if (/hidden|auto|scroll|clip/.test(style.overflowX) && r.width) { bounds.left = Math.max(bounds.left, r.left); bounds.right = Math.min(bounds.right, r.right) }
  }
  return bounds
}

function replyReleaseHighlight() {
  window.CSS?.highlights?.delete(REPLY_HIGHLIGHT)
}

/**
 * 这个会话里能不能回复：会话还在，并且是主会话或可以续写的子智能体会话。照 0.2.2-rc.2 官方引用按钮
 * （dsh-message-quotes 的 QuoteSelection）的判断；rc.2 的会话快照里 subagent 只有 address。
 * @param {{removed: boolean, subagent: {address: {mode: 'one-shot' | 'continuable' | 'unknown'}} | null}} session DSH 的会话快照。
 * @returns {boolean} 能回复时 true。
 */
export function replyEnabled(session) {
  return !session.removed && (session.subagent === null || session.subagent.address.mode === 'continuable')
}

/**
 * 选区上的浮层：先是「回复」和「引用文本」两个按钮，点「回复」变成回复框。
 * @param {object} props 插槽的属性：trigger、readText、dismiss、clearSelection，加 DSH 给的 inputActions、useSession、useSessionStatus、sessionId。
 * @returns {object | null} 浮层内容。
 */
function ReplySelection({ dismiss, readText, clearSelection, inputActions, useSession, useSessionStatus, sessionId }) {
  const app = replyApp
  const { t } = app
  const enabled = useSession(replyEnabled)
  // 待审时回复等于要求修改，输入框被审阅面板占着：添加项不显示、回车不做添加，只留「发送回复」。
  const reviewing = useSessionStatus(map => map.get(sessionId)?.pendingInteraction?.kind === 'plan-review')
  const menu = replyMenuOf(reviewing)
  const [quote, setQuote] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  // 这条回复已经排上队、只差取消等待：文字不能再改，也不能再加进输入框，不然模型会收到两份。
  const [queued, setQueued] = useState(false)
  const alive = useRef(true), range = useRef(null), surface = useRef(null), inserted = useRef(false), composing = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  React.useLayoutEffect(() => {
    if (quote === null || !surface.current || !range.current) return
    const element = surface.current
    const place = () => {
      if (!range.current.startContainer.isConnected) { dismiss(); return }
      const bounds = replyBounds(range.current)
      element.style.width = `${Math.min(404, Math.max(0, bounds.right - bounds.left - 16))}px`
      const result = placeReplySurface(range.current.getBoundingClientRect(), element.getBoundingClientRect(), bounds)
      Object.assign(element.style, { left: `${result.left}px`, top: `${result.top}px`, maxHeight: `${result.maxHeight}px` })
      element.style.overflowY = element.scrollHeight > result.maxHeight ? 'auto' : 'visible'
    }
    const observer = new ResizeObserver(place)
    observer.observe(element); window.addEventListener('resize', place); document.addEventListener('scroll', place, true)
    place()
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [quote, dismiss])
  useEffect(() => {
    if (!enabled) dismiss()
  }, [enabled, dismiss])
  useEffect(() => replyReleaseHighlight, [])
  if (!enabled) return null
  const finish = () => {
    clearSelection()
    dismiss()
  }
  if (quote === null) {
    const quoteOnly = () => {
      const text = readText()
      if (text === null) {
        dismiss()
        return
      }
      if (inputActions.insertQuote(text)) finish()
    }
    const startReply = () => {
      const text = readText()
      if (text === null) {
        dismiss()
        return
      }
      const selection = document.getSelection()
      range.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
      replyHoldHighlight(range.current)
      setQuote(text)
    }
    return h('div', { className: 'dwb-reply-bar', onPointerDown: event => { event.preventDefault() } },
      h('button', { type: 'button', onClick: startReply }, t('reply.action')),
      h('button', { type: 'button', onClick: quoteOnly }, t('reply.quote')))
  }
  const add = () => {
    if (busy || queued || reviewing || !draft.trim()) return
    if (!inserted.current) {
      const editor = range.current?.startContainer.parentElement?.closest('[data-conversation-scroll]')?.querySelector('[data-composer-seat] [contenteditable="true"]')
      if (!editor) { setError(t('reply.addFailed')); return }
      editor.focus({ preventScroll: true })
      const tail = document.createRange()
      tail.selectNodeContents(editor); tail.collapse(false)
      const selection = document.getSelection()
      selection.removeAllRanges(); selection.addRange(tail)
      document.dispatchEvent(new Event('selectionchange'))
    }
    const result = addReplyToInput(inputActions, quote, draft, inserted.current)
    inserted.current = result.quoteInserted
    if (result.ok) dismiss()
    else setError(t(result.quoteInserted ? 'reply.textFailed' : 'reply.addFailed'))
  }
  const send = async () => {
    if (draft.trim() === '' || sending.current) return
    sending.current = true
    setBusy(true)
    const result = await sendReply({
      review: pendingPlanReview(app.ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)),
      alreadyQueued: queued,
      queue: () => sendUserMessage(app, sessionId, replyMessageText(quote, draft), 'reply.disconnected'),
    })
    if (!alive.current) return
    sending.current = false
    setBusy(false)
    if (result.state === 'sent') finish()
    else if (result.state === 'unsent') setError(result.reason)
    else if (result.state === 'blocked') setError(t('reply.reviewBlocked'))
    else {
      setQueued(true)
      setError(t('reply.reviewQueued'))
    }
  }
  const onKeyDown = (event) => {
    const action = replyKeyAction({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing || composing.current, keyCode: event.keyCode }, { reviewing })
    if (action === null) return
    event.preventDefault()
    if (action === 'add') add()
    else void send()
  }
  const keepFocus = event => { event.preventDefault() }
  const sendKey = replySendKey(clientPlatform())
  return h('div', { ref: surface, className: 'dwb-reply-surface', 'aria-busy': busy },
    draft.trim() === '' ? null : h('div', { className: 'dwb-reply-menu', onPointerDown: keepFocus },
      menu.add ? h('button', { type: 'button', disabled: busy || queued, onClick: add }, h('span', null, t('reply.add')), h('kbd', null, '⏎')) : null,
      h('button', { type: 'button', disabled: busy, onClick: () => { void send() } }, h('span', null, t('reply.send')), h('kbd', null, sendKey))),
    h('div', { className: 'dwb-reply-card' },
    h('p', { className: 'dwb-reply-quote' }, quote),
    h('div', { className: 'dwb-reply-row' },
      h('textarea', {
        className: 'dwb-reply-input',
        rows: 1,
        disabled: busy || queued,
        onCompositionStart: () => { composing.current = true },
        onCompositionEnd: () => { composing.current = false },
        autoFocus: true,
        value: draft,
        placeholder: t('reply.placeholder'),
        'aria-label': t('reply.action'),
        onChange: (event) => {
          setDraft(event.target.value)
          setError(null)
        },
        onKeyDown,
      }),
      menu.add
        ? h('button', { type: 'button', className: 'dwb-reply-icon', disabled: busy || queued || !draft.trim(), 'aria-label': t('reply.add'), onPointerDown: keepFocus, onClick: add },
          h(ui.IconNewChatOutlineRegular, null))
        : null),
    h('span', { role: 'status' }, busy ? t('reply.sending') : ''),
    error === null ? null : h('p', { className: 'dwb-reply-error', role: 'alert' }, error)))
}

/**
 * 挂载这一行（插件页里开着时调用）。
 * @param {{ctx: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数；撤销后官方的「引用文本」按钮回来。
 */
export function applyReply(app) {
  const { ctx } = app
  replyApp = app
  const removeStyle = mountModuleStyle('dsh-workbench-reply', REPLY_CSS)
  window.addEventListener('pointerup', clampReplySelection, true)
  const dispose = ctx.effect(() => ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
    name: 'conversation.chat.text-interaction',
    key: 'quote',
    priority: -1,
    locale: '@miint-sunny/dsh-workbench',
  }, ReplySelection)), '@miint-sunny/dsh-workbench/reply: selection surface')
  const disposeQuote = ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: 'quote', priority: -1 }, ({ node }) => h('span', { className: 'dwb-reply-sent-quote' }, node.data.text))), '@miint-sunny/dsh-workbench/reply: sent quote')
  return () => {
    disposeQuote()
    dispose()
    window.removeEventListener('pointerup', clampReplySelection, true)
    removeStyle()
    replyReleaseHighlight()
    replyApp = undefined
  }
}

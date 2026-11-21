/**
 * 收尾框（dsh-workbench/tasks 的网页部分）：画在轮次末尾（conversation.chat.turnTail，
 * 官方改动卡片之后、复制和分支那排图标上面）。投影 workbenchWrapUp 给出每一轮的
 * 总结和「最新一次还没被回答」。
 *
 * 样子照 Claude App 的下一步框（feat#166）：总结是次要文字；问题是主要文字，单独一段；
 * 按钮左对齐，第一个是推荐项（主按钮，标出 ⌘↵，见 next-step.js），其余是次要按钮；右上角
 * 「关闭」只收起这个框——问题和按钮收掉，留下总结，不发消息。往上翻旧轮次也只有总结。
 * 按钮把按钮上的字作为用户消息发出；点过之后显示「已回复：…」，发送失败在框里写原因和
 * 「重试」（重试重发上一次点的那句话）。wrap_up 的工具调用行本身收成一行，不重复显示总结。
 */

/** 各会话最近一次点了哪个按钮（`sessionId` → `{ turn, text }`）：点了按钮到新一轮开始之间的「已回复」显示。窗口刷新就没了，旧框照旧只显示总结。 */
const answered = new Map()

/** 浏览器本地记下各会话关掉的收尾框是哪一轮（只是这台浏览器的偏好，存不了也不影响使用）。 */
const WRAPUP_CLOSED_STORAGE = 'dsh-workbench.wrapup.closed'
/** 最多记多少个会话，多了丢最早记下的。 */
const WRAPUP_CLOSED_LIMIT = 200

/**
 * 按轮次位置找这一轮的收尾条目，并决定按钮显不显示。纯函数。
 * @param {{entries: Array<{turn: number, recap: string, ask?: string, actions?: string[]}>, buttonsLive: boolean} | null | undefined} state 投影状态。
 * @param {{turn: number} | undefined} location turnTail 传进来的 TurnLocation；轮次号在 .turn。
 * @param {number | undefined} closedTurn 这个会话关掉的收尾框在第几轮；关掉的那一轮只显示总结。
 * @returns {{entry: object, showButtons: boolean} | undefined} 条目和问题、按钮显不显示；这一轮没有收尾时 undefined。
 */
export function wrapUpViewOf(state, location, closedTurn) {
  if (state === null || state === undefined) return undefined
  const number = typeof location?.turn === 'number' ? location.turn : undefined
  if (number === undefined) return undefined
  const entry = state.entries.find(item => item.turn === number)
  if (entry === undefined) return undefined
  const isLatest = state.entries[state.entries.length - 1] === entry
  return { entry, showButtons: isLatest && state.buttonsLive && closedTurn !== number }
}

/** 读浏览器本地记下的「关掉的收尾框」；坏的、读不到的都当没有。 */
function readClosedWrapUps(storage) {
  const value = JSON.parse(storage().getItem(WRAPUP_CLOSED_STORAGE) ?? '{}')
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/**
 * 这个会话关掉的收尾框在第几轮。
 * @param {string} sessionId 会话。
 * @param {() => Storage} storage 浏览器存储（测试换成假的）。
 * @returns {number | undefined} 轮次；没关过或读不到时 undefined。
 */
export function closedWrapUpTurn(sessionId, storage = () => globalThis.localStorage) {
  try {
    const turn = readClosedWrapUps(storage)[sessionId]
    return Number.isInteger(turn) ? turn : undefined
  } catch {
    return undefined
  }
}

/**
 * 记下这个会话关掉了第几轮的收尾框；存不了就算了（框照样收起，只是刷新后会再出现）。
 * @param {string} sessionId 会话。
 * @param {number} turn 轮次。
 * @param {() => Storage} storage 浏览器存储（测试换成假的）。
 */
export function rememberClosedWrapUp(sessionId, turn, storage = () => globalThis.localStorage) {
  try {
    let all
    try {
      all = readClosedWrapUps(storage)
    } catch {
      all = {}
    }
    delete all[sessionId]
    all[sessionId] = turn
    const ids = Object.keys(all)
    for (const id of ids.slice(0, Math.max(0, ids.length - WRAPUP_CLOSED_LIMIT))) delete all[id]
    storage().setItem(WRAPUP_CLOSED_STORAGE, JSON.stringify(all))
  } catch {
    // 存不了：这个窗口里照样收起。
  }
}

/** 轮次末尾的收尾框。 */
function WrapUpBox(props) {
  const { app, turn, useProjection, sessionId } = props
  const turnNumber = turn.turn
  const [closedTurn, setClosedTurn] = useState(() => closedWrapUpTurn(sessionId))
  const view = wrapUpViewOf(useProjection('workbenchWrapUp'), turn, closedTurn)
  const [replied, setReplied] = useState(undefined)
  const [failure, setFailure] = useState(undefined)
  const [lastText, setLastText] = useState(undefined)
  const [sending, setSending] = useState(false)
  useEffect(() => {
    const record = answered.get(sessionId)
    setReplied(record !== undefined && record.turn === turnNumber ? record.text : undefined)
    setFailure(undefined)
    setLastText(undefined)
    setSending(false)
    setClosedTurn(closedWrapUpTurn(sessionId))
  }, [sessionId, turnNumber])
  const answer = async (text) => {
    setSending(true)
    setLastText(text)
    const reason = await sendUserMessage(app, sessionId, text, 'wrap.disconnected')
    setSending(false)
    if (reason === undefined) {
      answered.set(sessionId, { turn: turnNumber, text })
      setReplied(text)
    } else {
      setFailure(reason)
    }
  }
  const entry = view?.entry
  const showButtons = view?.showButtons === true
  const choosing = showButtons && replied === undefined && failure === undefined && entry?.actions !== undefined
  const nextKey = `wrap:${turnNumber}`
  useOfferNextStep(sessionId, nextKey, choosing && !sending
    ? { kind: 'wrapup', order: 0, run: () => { void answer(entry.actions[0]) } }
    : undefined)
  const isNext = useIsNextStep(sessionId, nextKey)
  if (view === undefined) return null
  const close = () => {
    rememberClosedWrapUp(sessionId, turnNumber)
    setClosedTurn(turnNumber)
  }
  const closable = showButtons && replied === undefined && (entry.ask !== undefined || entry.actions !== undefined)
  return h('section', { className: 'dwb-wrapup', 'data-testid': 'dwb-wrapup-box', 'data-open': showButtons ? '' : undefined },
    h('div', { className: 'dwb-wrapup-head' },
      h('p', { className: 'dwb-wrapup-recap' }, entry.recap),
      closable
        ? h(ui.Button, { variant: 'ghost', className: 'dwb-wrapup-close', 'aria-label': app.t('wrap.close'), onClick: close },
          h(ui.IconCloseOutlineRegular, { size: 16 }))
        : null),
    showButtons && entry.ask !== undefined ? h('p', { className: 'dwb-wrapup-ask' }, entry.ask) : null,
    choosing
      ? h('div', { className: 'dwb-wrapup-btns' },
        entry.actions.map((label, at) => h(ui.Button, {
          key: label,
          variant: at === 0 ? 'primary' : 'ghost',
          className: 'dwb-wrapup-btn',
          'data-tone': at === 0 ? undefined : 'secondary',
          disabled: sending,
          onClick: () => { void answer(label) },
        }, h('span', null, label), at === 0 && isNext ? h(NextStepKeys, { app }) : null)))
      : null,
    showButtons && replied !== undefined ? h('p', { className: 'dwb-wrapup-note' }, app.t('wrap.replied', { text: replied })) : null,
    showButtons && failure !== undefined ? h('p', { className: 'dwb-wrapup-note', 'data-tone': 'error', role: 'alert' },
      h('span', null, app.t('wrap.sendFailed', { reason: failure })),
      h('button', { type: 'button', className: 'dwb-linklike', disabled: sending, onClick: () => { setFailure(undefined); if (lastText !== undefined) void answer(lastText) } }, app.t('wrap.retry'))) : null)
}

/** wrap_up 工具调用的折叠行：收成一行，标题「收尾」，摘要取总结的第一行。 */
function WrapUpToolRow(props) {
  const { app, phase, block } = props
  const recap = phase === 'preparing' ? undefined : block?.args?.text('recap')
  return h(ui.DisclosureRow, {
    icon: h(ui.IconChecklistOutlineRegular, { size: 14 }),
    title: app.t('wrap.toolRow'),
    open: false,
    expandable: false,
    onToggle: () => {},
    collapsedContent: toolRowSummary(recap === undefined ? undefined : firstLine(recap)),
  })
}

/** 总结的第一行（工具行摘要用），超长截断。 */
function firstLine(text) {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/**
 * 挂收尾框、工具行和 ⌘↵；返回撤销函数（那一行在插件页里关掉时，入口用它撤掉这些界面）。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数。
 */
function applyWrapUp(app) {
  const { ctx } = app
  const disposers = [
    mountNextStepKeys(app),
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
      { name: 'conversation.chat.turnTail', id: 'dsh-workbench-wrapup', order: 20 },
      (props) => h(WrapUpBox, { app, ...props }))),
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key: 'wrap_up' },
      (props) => h(WrapUpToolRow, { app, ...props }))),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

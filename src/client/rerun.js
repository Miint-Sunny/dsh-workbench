/**
 * 重新生成和编辑重发（dsh-workbench/rerun 的网页部分，计划第 6 项，样稿「重新生成和
 * 编辑重发」A–F）。往 conversation.chat.assistant-actions 注册一个条目（order 20，官方
 * 点赞点踩是 10，「在新对话中分支」是内置按钮在插槽条目后面）：回答下方的图标排多
 * 「重新生成」「编辑消息」两个按钮，都是从这一轮提问之前分叉出新会话再发，主对话区
 * 切过去，原会话保持原样。
 *
 * 分叉点取 turn.start.seq - 1：始终是一个真实事件（第一轮开始之前也有权限、沙箱等
 * 事件，所以第一轮也能重新生成；已装的第三方「编辑并重发」取提问事件的 seq - 1，
 * 子会话末尾会多一个空轮次头，不照搬）。日志里提问先以 agent/inbox/spliced 入队，紧接着
 * 才是 turn/start，所以这个分叉点正好是那条入队事件，子会话带着这条还没被领走的原提问
 * （2026-11-06 在真实模型上测出：同一问跑了两遍）。重发前先把继承来的排队消息删掉
 * （clearInheritedQueue）。
 *
 * 中途插过话的轮次（聊天节点里 kind 是 'steering'，见 ui-chat 的 conversation-nodes/
 * message.ts：提问是 'user'，插话是 'steering'，注入的上下文是 'context'）重发会悄悄
 * 丢掉插话，置灰并写原因；提问带图片、文件、@ 引用或技能的也置灰（重发带不上它们）。
 *
 * prompt 一被接受就返回 ok；模型那边出错不会让 prompt 返回不 ok，而是子会话里出现一
 * 个失败的轮次，那不算发送失败（调研 02 第 4 节）。
 */
import { mountModuleStyle } from './style.js'
import { settingsFormLabels } from './copy.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重）。 */
const RERUN_INJECT = ['uiWorkspace']

/** 本功能的中文界面文字；键以 `rerun.` 开头，原话照第二批样稿。 */
const RERUN_ZH = {
  'rerun.action.regenerate': '重新生成',
  'rerun.action.edit': '编辑消息',
  'rerun.regenerate': '重新生成：分叉出新会话并重发此消息',
  'rerun.edit': '编辑消息：编辑后在分叉出的新会话中重发',
  'rerun.working': '正在分叉…',
  'rerun.reason.running': '会话进行中，结束后才能重发',
  'rerun.reason.attachments': '此轮消息包含图片、文件、@ 引用或技能，无法重发',
  'rerun.reason.steered': '此轮中途插入过消息，无法重发',
  'rerun.reason.noFork': '当前会话不支持分叉，无法重发',
  'rerun.forkFailed': '分叉失败：{reason}',
  'rerun.retry': '重试',
  'rerun.notice.sendFailed': '消息未发送：{reason}。原文已恢复到输入框。',
  'rerun.notice.forked': '已从「{title}」第 {turn} 轮之前分叉，原会话保留。',
  'rerun.notice.forkedNoTitle': '已从第 {turn} 轮之前分叉，原会话保留。',
  'rerun.disconnected': '和 DSH 的连接已断开',
  'rerun.editor.label': '编辑消息',
  'rerun.editor.hint': '从此消息之前分叉出新会话并在其中发送；原会话保留。',
  'rerun.editor.cancel': '取消',
  'rerun.editor.send': '发送消息',
  'rerun.page.summary': '「重新生成」和「编辑消息」均分叉出新会话。',
  'rerun.page.after': '分叉会话',
  'rerun.page.archive': '分叉后归档原会话',
  'rerun.page.archiveHint': '重新生成或编辑重发成功后归档原会话；可在侧边栏取消归档。',
  'rerun.form.unavailable': '重新生成设置暂不可用',
}

/** 本功能的英文界面文字，键和 RERUN_ZH 一一对应。 */
const RERUN_EN = {
  'rerun.action.regenerate': 'Regenerate',
  'rerun.action.edit': 'Edit message',
  'rerun.regenerate': 'Regenerate: fork a new session and resend this message',
  'rerun.edit': 'Edit message: resend in the forked session after editing',
  'rerun.working': 'Forking…',
  'rerun.reason.running': 'The session is running. Resend after it finishes.',
  'rerun.reason.attachments': "This turn's message has images, files, @ references or skills, so it cannot be resent",
  'rerun.reason.steered': 'This turn has messages sent mid-turn, so it cannot be resent',
  'rerun.reason.noFork': 'This session does not support forking, so it cannot be resent',
  'rerun.forkFailed': 'Fork failed: {reason}',
  'rerun.retry': 'Retry',
  'rerun.notice.sendFailed': 'The message was not sent: {reason}. The original text was restored to the input box.',
  'rerun.notice.forked': 'Forked from before turn {turn} of "{title}". The original session is kept.',
  'rerun.notice.forkedNoTitle': 'Forked from before turn {turn}. The original session is kept.',
  'rerun.disconnected': 'the connection to DSH is down',
  'rerun.editor.label': 'Edit message',
  'rerun.editor.hint': 'Forks a new session from before this message and sends there; the original session is kept.',
  'rerun.editor.cancel': 'Cancel',
  'rerun.editor.send': 'Send message',
  'rerun.page.summary': 'Regenerate and Edit message both fork a new session.',
  'rerun.page.after': 'Fork session',
  'rerun.page.archive': 'Archive the original session after forking',
  'rerun.page.archiveHint': 'Archives the original session after a successful regenerate or edit-and-resend; it can be unarchived from the sidebar.',
  'rerun.form.unavailable': 'Regenerate settings are unavailable',
}

// ---------- 纯函数：找这一轮和它的提问 ----------

/**
 * 从内容块里拼提问文字：全部是 text 块才是纯文本提问；有别的块（图片、文件等）重发
 * 带不上，返回 undefined。
 * @param {unknown} content 聊天节点 data.content（ContentBlock[]）。
 * @returns {string | undefined} 拼好的文字；不是纯文本时 undefined。
 */
function rerunTextOf(content) {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

/**
 * 这一轮里人写的消息节点（提问 kind 'user'、中途插话 kind 'steering'；注入的上下文是
 * 'context'，不算）。按节点在轮次里的顺序。
 * @param {object} snapshot useChat 的 ChatSnapshot。
 * @param {number} turnNumber 轮次号。
 * @returns {{kind: string, data: object}[]} 人写的消息节点。
 */
function rerunHumanInputsOf(snapshot, turnNumber) {
  const keys = snapshot.locations?.getTurn?.(turnNumber)
  if (!Array.isArray(keys)) return []
  const humans = []
  for (const key of keys) {
    const node = snapshot.nodes?.get?.(key)
    if (node?.kind === 'user' || node?.kind === 'steering') humans.push({ kind: node.kind, data: node.data })
  }
  return humans
}

/**
 * 找一条已完成的助手消息属于哪一轮、这一轮的提问是什么、从哪里分叉。官方「分支」就
 * 用 turn-tail 的 closing.finalNode.messageId 找轮次（ui-chat/src/client/apply.ts）。
 * 纯函数。
 * @param {object | null | undefined} snapshot useChat 的 ChatSnapshot。
 * @param {string} messageId 这一条助手消息的 id。
 * @returns {{ok: true, turn: object, forkAtSeq: number, text: string} | {ok: false, reason: 'notFound' | 'steered' | 'attachments'}} 结果；notFound 时不渲染按钮。
 */
export function rerunTarget(snapshot, messageId) {
  const miss = reason => ({ ok: false, reason })
  if (typeof messageId !== 'string' || messageId === '') return miss('notFound')
  const turns = snapshot?.timeline?.turns
  if (!(turns instanceof Map)) return miss('notFound')
  let turn
  for (const candidate of turns.values()) {
    if (candidate?.data?.get?.('turn-tail')?.closing?.finalNode?.messageId === messageId) {
      turn = candidate
      break
    }
  }
  if (turn === undefined) return miss('notFound')
  const startSeq = turn.start?.seq
  if (!Number.isSafeInteger(startSeq)) return miss('notFound')
  const forkAtSeq = startSeq - 1
  if (forkAtSeq < 0) return miss('notFound')
  const humans = rerunHumanInputsOf(snapshot, turn.turn)
  const questions = humans.filter(node => node.kind === 'user')
  if (questions.length === 0) return miss('notFound')
  if (questions.length > 1 || humans.some(node => node.kind === 'steering')) return miss('steered')
  const question = questions[0].data
  if ((question.referenceLabels?.length ?? 0) > 0 || (question.skillNames?.length ?? 0) > 0) return miss('attachments')
  const text = rerunTextOf(question.content)
  if (text === undefined) return miss('attachments')
  if (text.trim() === '') return miss('notFound')
  return { ok: true, turn, forkAtSeq, text }
}

/**
 * useChat 的比较函数：只比会变的字段，快照重发布不触发重渲染。
 * @param {object} a 上一次 rerunTarget 的结果。
 * @param {object} b 这一次的结果。
 * @returns {boolean} 相同是 true。
 */
function rerunSameTarget(a, b) {
  if (a === b) return true
  if (a?.ok !== b?.ok) return false
  if (a.ok === false) return a.reason === b.reason
  return (a.forkAtSeq === b.forkAtSeq && a.text === b.text)
    && (a.turn === b.turn
      || (a.turn?.turn === b.turn?.turn && a.turn?.start?.seq === b.turn?.start?.seq))
}

/**
 * 把快照查出来的目标和会话状态（useSession、useAccess 读的）合起来，决定这一轮能不能
 * 重发。轮次本身的原因（插过话、带附件）先于环境原因（分叉权限、运行中）：等会话结束
 * 也救不了前两种，悬停提示要写救不了的那一个。纯函数。
 * @param {object} target rerunTarget 的结果。
 * @param {{running: boolean, forkAllowed: boolean}} session 会话状态。
 * @returns {{ok: true, turn: object, forkAtSeq: number, text: string} | {ok: false, reason: string}} 合并后的结果。
 */
export function mergeRerunAvailability(target, { running, forkAllowed }) {
  if (target.ok === false) return target
  if (forkAllowed === false) return { ok: false, reason: 'noFork' }
  if (running === true) return { ok: false, reason: 'running' }
  return target
}

// ---------- 分叉再发送 ----------

/** 等子会话的 inbox 投影载入的最长毫秒数；载入前它读出来是 undefined。分叉后不重发的功能（回到某条消息之前）也用它，所以导出。 */
export const INBOX_WAIT_MS = 3000

/**
 * 读子会话「下一轮」队列里排着的消息。inbox 投影还没载入（读出 undefined）时等它第一次
 * 有值，超过 waitMs 还没有就当队列是空的。
 * @param {object} session 子会话的 ISession。
 * @param {number} waitMs 最长等待毫秒数。
 * @returns {Promise<{id: string, source: {kind: string}}[]>} 排着的消息。
 */
function readNextTurnQueue(session, waitMs) {
  const face = session.projections.faceOf('inbox')
  const read = () => face.getSnapshot()?.['next-turn']
  const now = read()
  if (now !== undefined) return Promise.resolve(now)
  return new Promise(resolve => {
    let unsubscribe = () => {}
    let timer
    const finish = rows => {
      clearTimeout(timer)
      unsubscribe()
      resolve(rows)
    }
    unsubscribe = face.subscribe(() => {
      const rows = read()
      if (rows !== undefined) finish(rows)
    })
    timer = setTimeout(() => { finish([]) }, waitMs)
  })
}

/**
 * 删掉子会话从源会话继承来的、来源是用户的排队消息。分叉点 turn.start.seq - 1 是这一轮提问
 * 入队的 agent/inbox/spliced 事件（日志里提问先入队，下一个事件才是 turn/start），子会话因此
 * 带着这条还没被领走的原提问；不删的话，重发的那条之外原提问还会再跑一轮（编辑重发还会先
 * 把没改的原文跑一遍）。别的来源的排队消息（系统注入）留着。
 * @param {object} session 子会话的 ISession。
 * @param {number} waitMs 等 inbox 投影载入的最长毫秒数。
 * @returns {Promise<void>} 删完时。
 * @throws {Error} 宿主不让删时（带宿主给的原因）；调用方当作提问没发出去。
 */
export async function clearInheritedQueue(session, waitMs) {
  for (const row of await readNextTurnQueue(session, waitMs)) {
    if (row.source?.kind !== 'user') continue
    const result = await session.updateQueue(row.id, { kind: 'remove' })
    if (result?.ok !== true) throw new Error(result?.error?.message ?? 'session/queue-remove-failed')
  }
}

/**
 * 分叉出新会话、切过去、把提问发出去。依赖全部注入，测试用假的。分叉失败抛出（调用方
 * 写在图标排下面）；发送失败不抛：子会话已经建好并切过去了，不回头删，原文放回子会话
 * 的输入框并在那里提示。
 * @param {object} deps 依赖：fork、using、openSession、archiveSession、inputFor、titleOf、t、warn；可选 inboxWaitMs（等 inbox 投影的最长毫秒数）。
 * @param {{sessionId: string, atSeq: number, turn: number, text: string, archiveOriginal: boolean}} request 坐标和要发的文字（turn 是轮次号，提示文字里用）。
 * @returns {Promise<{outcome: 'sent' | 'send-failed', childId: string}>} 发送的结局。
 * @throws {Error} 分叉失败（fork 或持有子会话失败）时。
 */
export async function forkAndResend(deps, request) {
  const text = String(request.text ?? '')
  if (text.trim() === '') throw new Error('rerun text must not be empty')
  const childId = await deps.fork({ sessionId: request.sessionId, atSeq: request.atSeq, increaseTitle: true })
  return deps.using(childId, { source: 'workbenchRerun' }, async reference => {
    await reference.ready
    deps.openSession(childId)
    let result
    try {
      await clearInheritedQueue(reference.binding.session, deps.inboxWaitMs ?? INBOX_WAIT_MS)
      result = await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
    } catch (error) {
      result = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
    const input = deps.inputFor(reference.binding.ctx)
    if (result.ok !== true) {
      const reason = result.error?.message ?? deps.t('rerun.disconnected')
      try {
        input?.setDraft(text)
        input?.notify('error', deps.t('rerun.notice.sendFailed', { reason }))
      } catch (error) {
        // 输入框放不回去（conversation 服务没装上之类）：子会话已经打开，没有别的界面可用。
        deps.warn?.(`dsh-workbench/rerun: 把原文放回输入框失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return { outcome: 'send-failed', childId }
    }
    const title = deps.titleOf?.(request.sessionId)
    const params = { turn: String(request.turn) }
    const notice = typeof title === 'string' && title !== ''
      ? deps.t('rerun.notice.forked', { ...params, title })
      : deps.t('rerun.notice.forkedNoTitle', params)
    try {
      input?.notify('info', notice)
    } catch (error) {
      // 提示发不出去不影响结果：会话已经切过去、提问已经重发。
      deps.warn?.(`dsh-workbench/rerun: 显示分叉提示失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (request.archiveOriginal) {
      try {
        await deps.archiveSession(request.sessionId)
      } catch (error) {
        // 归档失败只记日志：提问已经重发，原会话留着也一样。
        deps.warn?.(`dsh-workbench/rerun: 归档原会话失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { outcome: 'sent', childId }
  })
}

/** 从入口上下文拼 forkAndResend 的依赖（测试注入假的）；检查点的 checkpointsForkSession 也用它。 */
export function rerunDepsOf(app) {
  const { ctx } = app
  return {
    fork: request => ctx.sessions.fork(request),
    using: (id, options, operation) => ctx.sessions.using(id, options, operation),
    openSession: childId => { ctx.uiWorkspace?.openSession(childId) },
    archiveSession: id => ctx.uiWorkspace?.archiveSession(id),
    inputFor: actx => ctx.get('conversation')?.input?.for(actx),
    titleOf: id => ctx.sessions?.list?.getSnapshot?.().byId[id]?.displayTitle,
    t: app.t,
    warn: message => { console.warn(message) },
  }
}

// ---------- 行配置（宿主是真身，这里缓存） ----------

/** 客户端起手的默认配置（和宿主 lib/rerun-state.js 的 defaultRerunConfig 一致，改的时候一起改）。 */
function defaultRerunClientConfig() {
  return { archiveOriginal: false }
}

/** 行配置的读取器：宿主是真身，这里只是缓存；每次重发前 load 一次。 */
function createRerunConfig() {
  let config = defaultRerunClientConfig()
  const load = async () => {
    try {
      const response = await fetch('api/dsh-workbench.rerun.config', { credentials: 'same-origin' })
      if (response.ok) {
        const body = await response.json()
        config = typeof body?.archiveOriginal === 'boolean' ? { archiveOriginal: body.archiveOriginal } : config
      }
    } catch {
      // 读不到就按默认值重发（开关只管归档，不该拦着重发）。
    }
    return config
  }
  return { load, get: () => config }
}

// ---------- 界面 ----------

/** 浮层和图标排之间留的空隙、浮层和对话容器边之间留的边距。 */
const RERUN_POPOVER_GAP = 8
const RERUN_POPOVER_INSET = 12

/**
 * 算编辑框／错误行浮层的位置：按对话容器定位，不被输入框盖住、不超出对话栏。纯函数。
 * 宽度 min(560, 容器宽 - 24)；水平夹在容器内；容器里图标排上方放得下就放上方，放不下
 * 才放下方；最大高度不超过那一侧的可用空间（再被视口高度压一道）。
 * @param {{left: number, top: number, bottom: number}} anchorRect 图标排的矩形。
 * @param {{left: number, top: number, bottom: number, width: number}} containerRect 对话容器（`[data-conversation-session]`）的矩形。
 * @param {{height: number}} viewport 视口。
 * @param {{height: number}} size 浮层量出来的自然高度。
 * @returns {{left: number, top: number, width: number, maxHeight: number, placement: 'above' | 'below'}} 位置。
 */
export function placeRerunPopover(anchorRect, containerRect, viewport, size) {
  const inset = Math.min(RERUN_POPOVER_INSET * 2, containerRect.width)
  const width = Math.min(560, containerRect.width - inset)
  const minLeft = containerRect.left + RERUN_POPOVER_INSET
  const maxLeft = containerRect.left + containerRect.width - RERUN_POPOVER_INSET - width
  const left = Math.min(Math.max(anchorRect.left, minLeft), Math.max(minLeft, maxLeft))
  const roomAbove = anchorRect.top - containerRect.top - RERUN_POPOVER_GAP
  const roomBelow = containerRect.bottom - anchorRect.bottom - RERUN_POPOVER_GAP
  const fitsAbove = size.height <= roomAbove
  const maxHeight = Math.max(0, Math.min(fitsAbove ? roomAbove : roomBelow, viewport.height - 24))
  const top = fitsAbove
    ? anchorRect.top - RERUN_POPOVER_GAP - Math.min(size.height, maxHeight)
    : anchorRect.bottom + RERUN_POPOVER_GAP
  return {
    left: Math.round(left), top: Math.round(top), width: Math.round(width),
    maxHeight: Math.round(maxHeight), placement: fitsAbove ? 'above' : 'below',
  }
}

/** 两个位置结果是否相同（setPlace 的收敛判断，避免每次渲染都触发重渲染）。 */
function rerunSamePlace(a, b) {
  return a !== undefined && b !== undefined
    && a.left === b.left && a.top === b.top && a.width === b.width
    && a.maxHeight === b.maxHeight && a.placement === b.placement
}

/** 图标排条目：两个按钮，编辑框和错误行是按对话容器定位的 fixed 浮层。 */
function RerunActions(props) {
  const { app, sessionId, messageId, useChat, useSession, useAccess } = props
  const t = app.t
  const target = useChat(snapshot => rerunTarget(snapshot, messageId), rerunSameTarget)
  const running = useSession(session => session.running === true || session.removed === true)
  const forkAllowed = useAccess('session/fork')
  const view = mergeRerunAvailability(target, { running, forkAllowed })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(undefined)
  const [lastText, setLastText] = useState(undefined)
  const [place, setPlace] = useState(undefined)
  const anchorRef = useRef(null)
  const popRef = useRef(null)
  if (!view.ok && view.reason === 'notFound') return null
  const blocked = !view.ok
  const disabled = blocked || busy
  const open = editing || failure !== undefined
  const blockedText = blocked ? t(`rerun.reason.${view.reason}`) : undefined
  /** 按图标排和对话容器的当前矩形重算浮层位置；找不到容器就按视口当容器。 */
  const remeasure = useCallback(() => {
    const anchor = anchorRef.current
    const pop = popRef.current
    if (anchor === null || pop === null) return
    const host = anchor.closest('[data-conversation-session]')
    const container = host ?? document.documentElement
    const next = placeRerunPopover(
      anchor.getBoundingClientRect(),
      container.getBoundingClientRect(),
      { height: window.innerHeight },
      { height: pop.offsetHeight },
    )
    setPlace(prev => (rerunSamePlace(prev, next) ? prev : next))
  }, [])
  React.useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined)
      return undefined
    }
    remeasure()
    // 窗口缩放、对话区滚动（scroll 不冒泡，用捕获在 window 上听）都重算位置。
    window.addEventListener('resize', remeasure)
    window.addEventListener('scroll', remeasure, true)
    return () => {
      window.removeEventListener('resize', remeasure)
      window.removeEventListener('scroll', remeasure, true)
    }
  }, [open, remeasure])
  // 打开着的时候每次渲染都重摆（打字把浮层撑高、错误行出现这类变化）。
  React.useLayoutEffect(() => {
    if (open) remeasure()
  })
  const run = async text => {
    if (disabled) return
    setBusy(true)
    setFailure(undefined)
    setLastText(text)
    try {
      const config = await app.rerunConfig.load()
      await forkAndResend(rerunDepsOf(app), {
        sessionId, atSeq: view.forkAtSeq, turn: view.turn.turn, text,
        archiveOriginal: config.archiveOriginal === true,
      })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const startEdit = () => {
    setDraft(view.text)
    setEditing(true)
  }
  const cancelEdit = () => {
    if (busy) return
    setEditing(false)
  }
  const canSend = !disabled && draft.trim() !== ''
  const icon = name => busy
    ? h(ui.IconLoadingOutlineRegular, { size: 14 })
    : h(name, { size: 14 })
  return h('span', { className: 'dwb-rr', ref: anchorRef },
    h(ui.Tooltip, { label: busy ? t('rerun.working') : (blocked ? blockedText : t('rerun.regenerate')), side: 'bottom' },
      h('button', {
        type: 'button', className: 'dwb-rr-act', 'aria-label': t('rerun.action.regenerate'),
        'aria-disabled': disabled || undefined, 'aria-busy': busy || undefined,
        'data-unavailable': blocked || undefined, onClick: blocked ? undefined : () => { void run(view.text) },
      }, icon(ui.IconRefreshOutlineRegular))),
    h(ui.Tooltip, { label: busy ? t('rerun.working') : (blocked ? blockedText : t('rerun.edit')), side: 'bottom' },
      h('button', {
        type: 'button', className: 'dwb-rr-act', 'aria-label': t('rerun.action.edit'),
        'aria-disabled': disabled || undefined, 'aria-expanded': editing || undefined,
        'data-unavailable': blocked || undefined, onClick: blocked ? undefined : startEdit,
      }, icon(ui.IconEditOutlineRegular))),
    open ? h('span', {
      className: 'dwb-rr-pop', ref: popRef, role: 'group', 'aria-label': t('rerun.editor.label'),
      style: {
        left: place === undefined ? undefined : place.left,
        top: place === undefined ? undefined : place.top,
        width: place === undefined ? undefined : place.width,
        maxHeight: place === undefined ? undefined : place.maxHeight,
        visibility: place === undefined ? 'hidden' : 'visible',
      },
    },
      editing ? h('div', { className: 'dwb-rr-editor', 'data-testid': 'dwb-rerun-editor' },
        h('div', { className: 'dwb-rr-lab' }, t('rerun.editor.label')),
        h('textarea', {
          className: 'dwb-rr-ta', value: draft, autoFocus: true, readOnly: busy,
          'aria-label': t('rerun.editor.label'),
          onFocus: event => { event.target.setSelectionRange(event.target.value.length, event.target.value.length) },
          onChange: event => { setDraft(event.target.value) },
          onKeyDown: event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelEdit()
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (canSend) void run(draft)
            }
          },
        }),
        h('div', { className: 'dwb-rr-editor-row' },
          h('span', { className: 'dwb-rr-hint' }, t('rerun.editor.hint')),
          h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: cancelEdit }, t('rerun.editor.cancel')),
          h(ui.Button, {
            variant: 'primary', size: 'sm', disabled: !canSend, onClick: () => { void run(draft) },
          }, busy ? t('rerun.working') : t('rerun.editor.send')))) : null,
      failure !== undefined ? h('div', { className: 'dwb-rr-error', role: 'alert' },
        h(ui.IconWarningOutlineRegular, { size: 14 }),
        h('span', null, t('rerun.forkFailed', { reason: failure })),
        h(ui.Button, {
          variant: 'outline', size: 'sm', disabled: busy,
          onClick: () => { void run(editing ? draft : lastText) },
        }, t('rerun.retry'))) : null) : null)
}

// ---------- 行配置页（插件页 → 工作台 → 重新生成和编辑重发 → 配置） ----------

/** 行配置页：一个「分叉后归档原会话」开关（样稿 F）。 */
function RerunConfigPage(props) {
  const { app } = props
  const [loaded, setLoaded] = useState(undefined)
  const [draft, setDraft] = useState(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(undefined)
  useEffect(() => {
    void app.rerunConfig.load().then(config => {
      setLoaded(config)
      setDraft(config)
    })
  }, [])
  if (draft === undefined) return null
  const t = app.t
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded)
  const toggle = () => { setDraft(current => ({ archiveOriginal: !current.archiveOriginal })); setFailed(undefined) }
  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch('api/dsh-workbench.rerun.config', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body?.ok !== true) throw new Error(body?.message ?? `HTTP ${response.status}`)
      const config = typeof body.config?.archiveOriginal === 'boolean' ? { archiveOriginal: body.config.archiveOriginal } : draft
      setLoaded(config)
      setDraft(config)
      setFailed(undefined)
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return h('div', { className: 'dwb-notify-page' },
    h('p', { className: 'dwb-notify-hint' }, t('rerun.page.summary')),
    h('div', { className: 'dwb-notify-group' },
      h('h4', null, t('rerun.page.after')),
      h('div', null,
        h(ui.Checkbox, { checked: draft.archiveOriginal, label: t('rerun.page.archive'), onChange: toggle }),
        h('p', { className: 'dwb-notify-hint' }, t('rerun.page.archiveHint')))),
    h(ui.SettingsForm, {
      labels: settingsFormLabels(t, failed, 'rerun.form.unavailable'),
      state: { available: true, writable: true, dirty, invalid: false, saving, failed: failed !== undefined },
      onSave: () => { void save() },
      onDiscard: () => { setDraft(loaded); setFailed(undefined) },
    }))
}

/** plugins.row.config 的条目：summary 一句话，page 是配置页。 */
function RerunConfigEntry(props) {
  const { app, view } = props
  return view === 'summary' ? app.t('rerun.page.summary') : h(RerunConfigPage, { app })
}

// ---------- 挂载 ----------

/** 本功能自己的样式（style.js 是共用文件，别的分支同时在改，不往里加）。 */
const RERUN_CSS = `
.dwb-rr{display:inline-flex;gap:2px;align-items:center}
.dwb-rr-act{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dwb-rr-act svg{width:17px;height:17px}
.dwb-rr-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dwb-rr-act[aria-disabled=true]{cursor:default;opacity:.4}
.dwb-rr-act[aria-disabled=true]:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
.dwb-rr-pop{position:fixed;z-index:40;display:flex;flex-direction:column;gap:8px;width:480px;box-sizing:border-box}
.dwb-rr-editor{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0;max-height:100%;overflow:hidden}
.dwb-rr-lab{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-rr-ta{box-sizing:border-box;width:100%;flex:1 1 auto;min-height:48px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;resize:none;overflow-y:auto}
.dwb-rr-ta:focus{outline:none;border-color:var(--dsw-alias-link);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-link) 16%,transparent)}
.dwb-rr-editor-row{flex:none;display:flex;gap:8px;align-items:center}
.dwb-rr-editor-row>button{flex:none;white-space:nowrap}
.dwb-rr-hint{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-rr-error{display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;box-shadow:var(--dsw-elevation-panel)}
.dwb-rr-error>span{flex:1 1 auto}
`

/**
 * 挂载本功能的界面：图标排条目、行配置页、样式；返回撤销函数（这一行关掉时调用）。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
export function applyRerun(app) {
  const { ctx } = app
  app.rerunConfig = createRerunConfig()
  const disposeStyle = mountModuleStyle('dsh-workbench-rerun', RERUN_CSS)
  const disposers = [
    ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'dsh-workbench-rerun', order: 20, locale: '@miint-sunny/dsh-workbench' },
      (props) => h(RerunActions, { app, ...props }))),
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
      { name: 'plugins.row.config', key: '@miint-sunny/dsh-workbench#dsh-workbench-rerun', locale: '@miint-sunny/dsh-workbench' },
      (props) => h(RerunConfigEntry, { app, ...props }))),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    disposeStyle()
  }
}

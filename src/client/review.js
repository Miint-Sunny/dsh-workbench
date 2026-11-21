/**
 * 改动审阅和审阅面板共用的帮手：官方「第 N 轮改动」地址的解析、改动处的显示行、已查看存取、攒评论、回退清单的
 * 去重、读 JSON 路由和调改动审阅的回退、撤销路由、往输入框插文字。页面在 review-panel.js（审阅面板接管
 * `dsh-resource://changes-review/**`，把官方卡片打开的地址换成本会话的审阅标签）。
 */

/** 改动审阅地址的前缀（和官方 ui-deliverables 的地址一个拼法）。 */
const REVIEW_ADDRESS_PREFIX = 'dsh-resource://changes-review/session/'

/**
 * 读出审阅页地址里的坐标。纯函数。
 * @param {string} address 资源地址。
 * @returns {{sessionId: string, seq: number, turn: number} | undefined} 会话、事件序号和轮次；不是这个地址就 undefined。
 */
export function parseReviewAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(REVIEW_ADDRESS_PREFIX)) return undefined
  const parts = address.slice(REVIEW_ADDRESS_PREFIX.length).split('/')
  if (parts.length !== 3) return undefined
  const [sessionId, seq, turn] = parts
  if (sessionId === '' || !/^\d+$/.test(seq) || !/^[1-9]\d*$/.test(turn)) return undefined
  try {
    return { sessionId: decodeURIComponent(sessionId), seq: Number(seq), turn: Number(turn) }
  } catch {
    // 百分号序列坏了：不是这个体系发出去的地址。
    return undefined
  }
}

/**
 * 点行号后的选中状态：再点同一行取消选中，点别的行换成那一行。
 * @param {{fileIndex: number, line: number} | undefined} current 当前选中的行。
 * @param {number} fileIndex 点的行所在的文件下标。
 * @param {number} line 点的行的新行号。
 * @returns {{fileIndex: number, line: number} | undefined} 新的选中状态。
 */
export function toggleLineSelection(current, fileIndex, line) {
  if (current !== undefined && current.fileIndex === fileIndex && current.line === line) return undefined
  return { fileIndex, line }
}

/** 统一差异格式的行首：加号是加的行，减号是删的行，其余（空格）是上下文。 */
const REVIEW_ADDED_LINE = /^\+/
const REVIEW_REMOVED_LINE = /^-/

/**
 * 一个改动处拆成显示行：`-` 行带旧行号，`+` 行带新行号，上下文行两个都带。
 * 纯函数。@param {{oldStart: number, newStart: number, lines: string[]}} hunk 改动处。
 * @returns {{old: number | undefined, cur: number | undefined, mark: string, text: string}[]} 显示行。
 */
export function hunkRows(hunk) {
  const rows = []
  let oldLine = hunk.oldStart
  let curLine = hunk.newStart
  for (const raw of hunk.lines) {
    const mark = raw[0]
    const text = raw.slice(1)
    if (REVIEW_REMOVED_LINE.test(raw)) rows.push({ old: oldLine++, cur: undefined, mark, text })
    else if (REVIEW_ADDED_LINE.test(raw)) rows.push({ old: undefined, cur: curLine++, mark, text })
    else rows.push({ old: oldLine++, cur: curLine++, mark: ' ', text })
  }
  return rows
}

/** 官方改动卡片点某个文件时 navigation.params 里的 index。纯函数。 */
export function navigatedFileIndex(params) {
  const index = params?.index
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : undefined
}

/** 已查看文件的存取（浏览器 localStorage，按会话和序号一轮一存）。 */
const SEEN_STORE = 'dsh-workbench-review-seen'

/**
 * 读一轮的已查看文件下标。纯函数（读写都收在参数上）。
 * @param {string} key 一轮的键（`${sessionId}/${seq}`）。
 * @param {Storage | undefined} storage 存储器，测试注入。
 * @returns {Set<number>} 已查看的文件下标。
 */
export function loadSeen(key, storage) {
  try {
    const raw = storage === undefined ? undefined : storage.getItem(`${SEEN_STORE}:${key}`)
    const list = raw === null || raw === undefined ? [] : JSON.parse(raw)
    return new Set(Array.isArray(list) ? list.filter(at => Number.isSafeInteger(at)) : [])
  } catch {
    // 坏了当没有看过。
    return new Set()
  }
}

/**
 * 写一轮的已查看文件下标。
 * @param {string} key 一轮的键。
 * @param {Set<number>} seen 已查看的文件下标。
 * @param {Storage | undefined} storage 存储器，测试注入。
 */
export function saveSeen(key, seen, storage) {
  try {
    storage?.setItem(`${SEEN_STORE}:${key}`, JSON.stringify([...seen]))
  } catch {
    // 存不进去就算了：已查看只是这一轮的显示状态。
  }
}

/** 评论和未保存的草稿按范围保存在当前浏览器标签页，重新加载页面后仍可编辑。 */
const roundCommentStore = 'dsh-workbench-review-comments'
const emptyRoundComments = { comments: [], composer: undefined, sending: false }
const commentsByRound = new Map()
const roundCommentListeners = new Map()
const roundCommentDrafts = new Map()
let commentSeq = 0

function validRoundCommentTarget(target) {
  return target !== null && typeof target === 'object'
    && (Number.isSafeInteger(target.fileIndex) || typeof target.fileIndex === 'string')
    && Number.isSafeInteger(target.line) && target.line > 0
    && typeof target.display === 'string' && typeof target.snippet === 'string'
}

export function roundCommentState(key) {
  if (commentsByRound.has(key)) return commentsByRound.get(key)
  let state = emptyRoundComments
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(`${roundCommentStore}:${key}`))
    if (Array.isArray(saved?.comments)) {
      const comments = saved.comments.filter(item => validRoundCommentTarget(item) && Number.isSafeInteger(item.id) && typeof item.text === 'string')
      const composer = validRoundCommentTarget(saved.composer?.target) && typeof saved.composer.draft === 'string' ? saved.composer : undefined
      state = { ...emptyRoundComments, comments, composer: composer?.target }
      if (composer !== undefined) roundCommentDrafts.set(key, composer.draft)
      for (const comment of comments) commentSeq = Math.max(commentSeq, comment.id)
    }
  } catch {
    // 存储被禁用或草稿无法读取时，评论仍可在本次打开中编辑和发送。
    state = emptyRoundComments
  }
  commentsByRound.set(key, state)
  return state
}

export function subscribeRoundComments(key, listener) {
  const listeners = roundCommentListeners.get(key) ?? new Set()
  listeners.add(listener)
  roundCommentListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) roundCommentListeners.delete(key)
  }
}

function persistRoundCommentState(key, state) {
  try {
    const storage = window.sessionStorage
    const slot = `${roundCommentStore}:${key}`
    const { comments, composer } = state
    if (comments.length === 0 && composer === undefined) storage.removeItem(slot)
    else storage.setItem(slot, JSON.stringify({ comments, composer: composer === undefined ? undefined : { target: composer, draft: roundCommentDraft(key) } }))
  } catch {
    // 存储被禁用或空间已满时，保留内存里的评论。
  }
}

export function updateRoundCommentState(key, patch, draft = '') {
  const state = { ...roundCommentState(key), ...patch }
  commentsByRound.set(key, state)
  if (Object.hasOwn(patch, 'composer')) {
    if (state.composer === undefined) roundCommentDrafts.delete(key)
    else roundCommentDrafts.set(key, draft)
  }
  if (Object.hasOwn(patch, 'comments') || Object.hasOwn(patch, 'composer')) persistRoundCommentState(key, state)
  for (const listener of roundCommentListeners.get(key) ?? []) listener()
}

export function roundCommentDraft(key) {
  return roundCommentDrafts.get(key) ?? ''
}

/** 输入时只更新编辑框，避免重新绘制差异里的所有行。 */
export function updateRoundCommentDraft(key, target, draft) {
  const state = roundCommentState(key)
  if (state.composer !== target) return
  roundCommentDrafts.set(key, draft)
  persistRoundCommentState(key, state)
}

/**
 * 读一轮攒着的评论（发消息的素材按文件和行号排好）。
 * @param {string} key 一轮的键。
 * @returns {{id: number, fileIndex: number, display: string, line: number, snippet: string, text: string}[]} 评论。
 */
export function roundComments(key) {
  return roundCommentState(key).comments
}

/**
 * 在同一位置添加评论会更新原评论。用 id 编辑位置已失效的评论。
 * @param {string} key 一轮的键。
 * @param {{id?: number, fileIndex: number | string, display: string, line: number, side?: string, anchor?: string, scopeText?: string, snippet: string, text: string}} comment 评论。
 * @returns {void}
 */
export function addRoundComment(key, comment) {
  const list = [...roundComments(key)]
  const at = list.findIndex(item => comment.id === undefined
    ? item.fileIndex === comment.fileIndex && item.line === comment.line && item.side === comment.side
      && item.anchor === comment.anchor && item.scopeText === comment.scopeText
    : item.id === comment.id)
  if (at >= 0) list[at] = { ...list[at], ...comment }
  else list.push({ ...comment, id: ++commentSeq })
  updateRoundCommentState(key, { comments: list, composer: undefined })
}

/**
 * 删一条评论。
 * @param {string} key 一轮的键。
 * @param {number | string} fileIndex 文件下标或路径。
 * @param {number} line 行号。
 * @param {number} [id] 评论编号。同一行的旧版和新版评论可以分别删除。
 * @returns {void}
 */
export function removeRoundComment(key, fileIndex, line, id) {
  const state = roundCommentState(key)
  const comments = state.comments.filter(item => (id === undefined ? item.fileIndex !== fileIndex || item.line !== line : item.id !== id))
  updateRoundCommentState(key, state.composer?.id === id && id !== undefined ? { comments, composer: undefined } : { comments })
}

/**
 * 发出以后只删和发出时一模一样的评论：等回答期间新写的、改过的（同一条线改了文字）都留着。
 * @param {string} key 一轮的键。
 * @param {{id: number, text: string}[]} sent 拼进消息的那些评论。
 * @returns {void}
 */
export function clearSentRoundComments(key, sent) {
  const left = roundComments(key).filter(item => !sent.some(done => done.id === item.id && done.text === item.text))
  updateRoundCommentState(key, { comments: left })
}

/** 这一轮已经发给模型的回退：坐标键 → 那条回退（要带显示名和指代说法）。窗口里攒着，消息只带还没报过的。 */
export const sentRevertsByRound = new Map()

/**
 * 一条已回退记录的坐标键。纯函数。
 * @param {{fileIndex: number, hunkIndex: number | null}} revert state 路由回答的一条回退。
 * @returns {string} 坐标键（`${fileIndex}:${hunkIndex ?? 'w'}`）。
 */
export function revertCoordKey(revert) {
  return `${revert.fileIndex}:${revert.hunkIndex ?? 'w'}`
}

/**
 * 一轮当前全部回退的坐标键和条目（发送成功后覆盖式记下：既含这次报的，也含以前报过还在的）。
 * 纯函数。 @param {{fileIndex: number, hunkIndex: number | null, display: string, description: string}[]} reverts 全部回退。
 * @returns {Map<string, object>} 坐标键 → 那条回退。
 */
export function sentRevertsOf(reverts) {
  return new Map(reverts.map(item => [revertCoordKey(item), item]))
}

/**
 * 这次发送要告诉模型的回退变化，由当前回退清单和「已报」表比出来，不改参数。纯函数。
 * 新回退的：清单里有、已报表里没有；报过又撤销的：已报表里有、清单里没有。撤销后又重新
 * 回退、中间没发过消息的，两样都不算（模型知道的就是现在的样子）。这一轮的回退清单还没从
 * 宿主读到时（页面刚打开、读失败）两样都是空的，免得把已报的回退当成撤销了。
 * @param {{fileIndex: number, hunkIndex: number | null, display: string, description: string}[]} reverts state 路由回答的全部回退。
 * @param {Map<string, object>} sent 已报的表：坐标键 → 报的时候那条回退。
 * @param {boolean} loaded 这一轮的回退清单是否已经从宿主读到过。
 * @returns {{pending: object[], undone: object[]}} 新回退的和报过又撤销的。
 */
export function revertNews(reverts, sent, loaded) {
  if (!loaded) return { pending: [], undone: [] }
  const present = new Set(reverts.map(revertCoordKey))
  return {
    pending: reverts.filter(item => !sent.has(revertCoordKey(item))),
    undone: [...sent].filter(([key]) => !present.has(key)).map(([, item]) => item),
  }
}

/** 带登录 cookie 读一个 JSON 路由；回答状态码和解析好的内容。 */
export async function fetchJson(path) {
  const response = await fetch(path, { credentials: 'same-origin' })
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, ok: response.ok, body }
}

/**
 * 调改动审阅的回退或撤销路由（照 lib/review/routes.js 的坐标）。
 * @param {string} path 路由（api/dsh-workbench.review.revert 或 .undo）。
 * @param {{sessionId: string, seq: number, fileIndex: number, hunkIndex: number | null}} coordinate 回退的坐标。
 * @returns {Promise<{ok: true} | {ok: false, message: string | undefined}>} 结果；失败时带宿主给的原因，连不上时 message 是 undefined。
 */
export async function postReviewAction(path, coordinate) {
  try {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(coordinate),
    })
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (response.ok && body?.ok === true) return { ok: true }
    return { ok: false, message: body?.message ?? `HTTP ${response.status}` }
  } catch {
    return { ok: false, message: undefined }
  }
}

/**
 * 把一段文字插进会话输入框的光标处。rc.5 的 `inputActions.insertText(text, span)` 要先用
 * `captureInsertion()` 取到带草稿版本号的选区；输入框正在提交或草稿刚被改过时它拒绝插入。
 * @param {{captureInsertion: () => unknown, insertText: (text: string, span: unknown) => boolean} | undefined} inputActions 会话插槽给的输入框动作。
 * @param {string} text 要插入的文字。
 * @returns {boolean} 插进去了是 true；没有输入框动作或被拒绝是 false。
 */
export function insertIntoDraft(inputActions, text) {
  if (inputActions === undefined) return false
  return inputActions.insertText(text, inputActions.captureInsertion())
}

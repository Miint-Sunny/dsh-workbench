/**
 * wrap_up 的参数校验和 workbenchWrapUp 投影的折叠——纯函数，不 import 任何
 * @deepseek-ai 包，`node --test` 直接可跑（注册路径在临时 DSH 演练里验，见
 * test/host-smoke.mjs 和 docs/spikes/）。投影不追加新的会话事件类型：wrap_up 的
 * 调用本身记在会话日志的 tool/call 事件里，折叠只读它。
 */

/** recap 的长度上限（字符）。 */
export const MAX_RECAP_CHARS = 600
/** ask 的长度上限（字符）。 */
export const MAX_ASK_CHARS = 200
/** 每个按钮文字的长度上限（字符）。 */
export const MAX_ACTION_CHARS = 24
/** 投影里保留最近多少轮的收尾（往上翻旧轮次还能看到总结）。 */
export const MAX_ENTRIES = 50

/**
 * 校验并规范化 wrap_up 的参数。参数已经过工具注册表的 JSON Schema 检查，这里补
 * schema 表达不了的约束：去空白、长度、ask 和 actions 的搭配。
 * @param {unknown} raw 模型给的参数。
 * @returns {{recap: string, ask?: string, actions?: string[]}} 规范化后的参数。
 * @throws {Error} 参数不合法时，消息给模型看。
 */
export function wrapUpArgsOf(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('wrap_up requires an object')
  const { recap, ask, actions } = raw
  const recapText = textOf(recap, 'recap', MAX_RECAP_CHARS, true)
  let askText
  if (ask !== undefined) askText = textOf(ask, 'ask', MAX_ASK_CHARS, true)
  let actionList
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 2) {
      throw new Error('wrap_up actions must be 1 or 2 buttons')
    }
    actionList = actions.map((action, at) => textOf(action, `actions[${at}]`, MAX_ACTION_CHARS, true))
    if (actionList[0] === actionList[1]) throw new Error('wrap_up actions must differ')
  }
  if (actionList !== undefined && askText === undefined) {
    throw new Error('wrap_up actions need ask: write the question the buttons answer')
  }
  return actionList === undefined
    ? askText === undefined ? { recap: recapText } : { recap: recapText, ask: askText }
    : { recap: recapText, ask: askText, actions: actionList }
}

/** 一个字符串参数的规范化；required 为假时 undefined 原样通过。 */
function textOf(value, name, max, required) {
  if (value === undefined) {
    if (required) throw new Error(`wrap_up ${name} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`wrap_up ${name} must be a string`)
  const text = value.trim()
  if (text === '') throw new Error(`wrap_up ${name} must not be blank`)
  if (text.length > max) throw new Error(`wrap_up ${name} must be at most ${max} characters`)
  return text
}

/** 投影的空状态。 */
export function wrapUpInit() {
  return { entries: [], buttonsLive: false }
}

/**
 * workbenchWrapUp 投影的折叠：tool/call 里名字是 wrap_up 的调用记进所在轮次（同一
 * 轮多次调用以最后一次为准），下一次 turn/start 把按钮收起（总结留着）。参数不是
 * 合法的 wrap_up 参数（模型给错会被工具拒绝）就跳过，不影响投影。
 * @param {{entries: Array<{turn: number, recap: string, ask?: string, actions?: string[]}>, buttonsLive: boolean}} state 当前状态。
 * @param {{type: string, data: unknown}} event 会话事件。
 * @returns {object} 新状态。
 */
export function wrapUpFold(state, event) {
  if (event.type === 'turn/start') {
    return state.buttonsLive ? { ...state, buttonsLive: false } : state
  }
  if (event.type !== 'tool/call') return state
  const data = event.data
  if (data.name !== 'wrap_up') return state
  let args
  try {
    args = wrapUpArgsOf(JSON.parse(data.arguments))
  } catch {
    // 模型给错参数：这次调用会被工具拒绝，不进投影。
    return state
  }
  const entry = { turn: data.turn, ...args }
  const entries = [...state.entries.filter(item => item.turn !== data.turn), entry]
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  return { entries, buttonsLive: true }
}

/**
 * 校验持久化的投影状态（检查点文件里的 JSON 是文件边界，要校验）。
 * @param {unknown} value 存档里的值。
 * @returns {object} 规范化后的状态。
 * @throws {Error} 形状不对时（这一轮的检查点作废，从空状态重放）。
 */
export function parseWrapUpState(value) {
  if (typeof value !== 'object' || value === null) throw new Error('workbenchWrapUp state must be an object')
  if (typeof value.buttonsLive !== 'boolean') throw new Error('workbenchWrapUp state.buttonsLive must be a boolean')
  if (!Array.isArray(value.entries)) throw new Error('workbenchWrapUp state.entries must be an array')
  const entries = value.entries.map((entry) => {
    if (typeof entry?.turn !== 'number' || !Number.isInteger(entry.turn)) {
      throw new Error('workbenchWrapUp entry.turn must be an integer')
    }
    return { turn: entry.turn, ...wrapUpArgsOf(entry) }
  })
  return { entries, buttonsLive: value.buttonsLive }
}

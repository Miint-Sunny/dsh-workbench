/**
 * 新会话卡片（feat#160，dsh-workbench/session-cards 行）的纯函数：propose_session 的参数
 * 校验、一轮三张和不重复的规矩、用户原话的核对、开始时的默认选项、workbenchSessionCards
 * 投影的折叠。不 import 任何 @deepseek-ai 包，`node --test` 直接可跑；网页端也拼进同一份，
 * 默认选项的算法两边一致。
 *
 * 投影只读会话日志里已有的东西：propose_session 的 tool/call 和 tool/result（结果的 meta
 * 带着宿主核对、解析过的卡片）、工作台的插件记录 plugin:dsh-workbench/session-card（开始、
 * 在当前会话处理、关闭），以及来源是 workbench-session-report 的回报消息。
 */

/** 模型提议新会话的工具。 */
export const PROPOSE_TOOL = 'propose_session'
/** 卡片决定（开始、在当前会话处理、关闭）的插件记录类型。 */
export const CARD_RECORD = 'plugin:dsh-workbench/session-card'
/** 新会话回报父会话时消息的来源种类。 */
export const REPORT_SOURCE = 'workbench-session-report'
/** 题目的长度上限（字符）。 */
export const MAX_TITLE_CHARS = 80
/** 说明的长度上限（字符）：说明就是新会话的第一条消息。 */
export const MAX_BRIEF_CHARS = 4000
/** 每个选项文字的长度上限。 */
export const MAX_OPTION_CHARS = 200
/** 用户原话摘录的长度上限。 */
export const MAX_QUOTE_CHARS = 200
/** 一轮最多几张卡。 */
export const MAX_CARDS_PER_TURN = 3
/** 投影里最多留几张卡。 */
export const MAX_CARDS = 50
/** 这一轮用户的话最多留多少字（核对原话用）。 */
export const MAX_TURN_TEXT = 4000
/** 回报里「最后一句」最多多少字。 */
export const MAX_REPORT_LAST = 300

/** 模型可以在提议时定的选项。 */
const OPTION_KEYS = ['workspace', 'worktree', 'agentPreset', 'model', 'reasoningEffort', 'permission']
/** 卡片的几种状态。 */
const CARD_STATES = ['pending', 'started', 'here', 'dismissed']
/** 插件记录里的动作。 */
const RECORD_ACTIONS = { start: 'started', here: 'here', dismiss: 'dismissed' }
/** 回报的几种状态：做完、等待回答（含等待审批、计划待审）、出错、被停止。 */
const REPORT_STATES = ['done', 'waiting', 'approval', 'plan', 'error', 'stopped']

/** 一个字符串参数的规范化：去空白、不许空、不许超长。 */
function textOf(value, name, max) {
  if (value === undefined || value === null) throw new Error(`propose_session ${name} is required`)
  if (typeof value !== 'string') throw new Error(`propose_session ${name} must be a string`)
  const text = value.trim()
  if (text === '') throw new Error(`propose_session ${name} must not be blank`)
  if (text.length > max) throw new Error(`propose_session ${name} must be at most ${max} characters`)
  return text
}

/** 选项的规范化：只认 OPTION_KEYS；null 当没给。 */
function optionsOf(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('propose_session options must be an object')
  const options = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!OPTION_KEYS.includes(key)) throw new Error(`propose_session options.${key} is not an option; use ${OPTION_KEYS.join(', ')}`)
    if (value === undefined || value === null) continue
    if (key === 'worktree') {
      if (typeof value !== 'boolean') throw new Error('propose_session options.worktree must be true or false')
      options.worktree = value
    } else {
      options[key] = textOf(value, `options.${key}`, MAX_OPTION_CHARS)
    }
  }
  return options
}

/**
 * 校验并规范化 propose_session 的参数（JSON Schema 之外的约束）。
 * @param {unknown} raw 模型给的参数。
 * @returns {{title: string, brief: string, options: object, userQuote?: string, ask?: true}} 规范化后的参数。
 * @throws {Error} 参数不合法时，消息给模型看。
 */
export function proposalArgsOf(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('propose_session requires an object')
  if (raw.ask !== undefined && raw.ask !== null && typeof raw.ask !== 'boolean') {
    throw new Error('propose_session ask must be true or false')
  }
  const title = textOf(raw.title, 'title', MAX_TITLE_CHARS)
  const brief = textOf(raw.brief, 'brief', MAX_BRIEF_CHARS)
  if (raw.ask === true) {
    if ((raw.options !== undefined && raw.options !== null) || (raw.userQuote !== undefined && raw.userQuote !== null)) {
      const error = new Error('With ask, leave out options and userQuote: the new session uses this session\'s settings. When the user asked for a separate session in their own words, do not ask; start it with userQuote.')
      error.code = 'ask-args'
      throw error
    }
    return { title, brief, options: {}, ask: true }
  }
  const options = optionsOf(raw.options)
  if (raw.userQuote === undefined || raw.userQuote === null) return { title, brief, options }
  return { title, brief, options, userQuote: textOf(raw.userQuote, 'userQuote', MAX_QUOTE_CHARS) }
}

/**
 * 判断「同一件事」用的题目键：全半角、大小写、空白和句末标点不算差别。
 * @param {string} title 题目。
 * @returns {string} 键。
 */
export function titleKey(title) {
  return String(title).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')
    .replace(/[\s。.!！?？…]+$/u, '').trim()
}

/**
 * 宿主在出卡前查的规矩：新会话不能提卡；卡片 A 一轮最多问一次；一轮最多三张；同一件事不管上一张怎样了都不再提。
 * @param {{cards: Array<{turn: number, title: string, state: string, kind?: string}>, turn: number, title: string, isChild: boolean, ask?: boolean, accepted?: Array<{turn: number, key: string, ask?: boolean}>}} input
 *   投影里的卡、这一轮的轮次、新卡的题目、调用的会话是不是从卡片开出来的、是不是卡片 A，以及已经放行、日志里还没有的卡。
 * @returns {{ok: true} | {ok: false, code: 'child'|'ask-limit'|'limit'|'duplicate', state?: string}} 结论。
 */
export function checkProposal({ cards, turn, title, isChild, ask = false, accepted = [] }) {
  if (isChild) return { ok: false, code: 'child' }
  if (ask && (cards.some(card => card.turn === turn && card.kind === 'ask') || accepted.some(item => item.turn === turn && item.ask === true))) {
    return { ok: false, code: 'ask-limit' }
  }
  const inTurn = cards.filter(card => card.turn === turn).length + accepted.filter(item => item.turn === turn).length
  if (inTurn >= MAX_CARDS_PER_TURN) return { ok: false, code: 'limit' }
  const key = titleKey(title)
  const same = cards.find(card => titleKey(card.title) === key)
  if (same !== undefined) return { ok: false, code: 'duplicate', state: same.state }
  if (accepted.some(item => item.key === key)) return { ok: false, code: 'duplicate', state: 'pending' }
  return { ok: true }
}

/** 中日文字和全角标点（它们旁边的空白不算差别）。 */
const CJK = '\\u2e80-\\u9fff\\u3000-\\u303f\\uff00-\\uffef'

/** 比较原话用：全半角、大小写统一，空白折成一个空格，中文旁边的空白去掉。 */
function squash(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
    .replace(new RegExp(` (?=[${CJK}])|(?<=[${CJK}]) `, 'gu'), '')
}

/**
 * 要求另开会话的说法：要有动作，也要有会话。中文是「另开／新开／新建／单独开／再开……（一个）
 * 会话」「开（一）个新的／单独的会话」；英文是 open/start/create… 加 new/separate… session。
 * 只提到「会话」或 session 这个词的不算。
 */
const ASK_FOR_SESSION = [
  /(?:另|新|单独|再|重新)(?:开|建|起)(?:一个|一|个)?(?:新的?|单独的?|独立的?)?会话/gu,
  /开(?:一个|一|个)?(?:新的?|单独的?|独立的?|另一个|另外一个)会话/gu,
  /\b(?:open|start|create|launch|begin|spin up|kick off)\s+(?:up\s+)?(?:(?:a|an|one)\s+)?(?:brand\s+)?(?:new|separate|fresh|different|dedicated|another)\s+session\b/gu,
]
/** 同一小句里写在要求前面、表示不要的词（「不如」这类不算）。 */
const REFUSAL = /不要|不用|不必|不需要|无需|没必要|别|勿|不想|不准|不许|不该|不应该|先不|暂时不|暂不|而不是|不(?:再|能|会|愿意|打算|考虑|允许)?\s*$|禁止|\b(?:don['’]?t|doesn['’]?t|won['’]?t|can['’]?t|shouldn['’]?t|wouldn['’]?t|mustn['’]?t|cannot|no need|not|never|without|instead of|rather than)\b/u
/** 介绍按钮、说明或假设时，命令的字样只是被提及。 */
const MENTION = /文案|字样|示例|假如|假设|如果|说过|写着|说明(?:里|上|中)?(?:写|说)|\b(?:if|unless|how to|for example|the phrase|instructions? (?:say|says|said)|button (?:labeled|labelled))\b/u
const LABEL_AFTER_ASK = /^\s*(?:这(?:几个字|句话)|(?:是|指的是|作为).{0,32}(?:文案|标签|字样|名称)|(?:is|was)\s+(?:(?:the|a|an)\s+)?(?:label|phrase|text|wording)\b)/u
/** 引号或代码里的文字可能是界面名称、文档或他人原话，改由用户在卡片上确认。 */
const QUOTED_TEXT = /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|«[^»]*»|"[^"]*"|\x60[^\x60]*\x60|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu

/** text[at] 是不是小句的分隔：句号、逗号、分号、问号、叹号（全角的经 NFKC 已是半角），英文句点要后面是空白或结尾。 */
function breaksAt(text, at) {
  const char = text[at]
  if ('。!?;,'.includes(char)) return true
  return char === '.' && (at + 1 >= text.length || text[at + 1] === ' ')
}

/**
 * 这一处要求在它的小句里是不是真的要求：前面没有「不要」之类，小句也不是问句（问号结束或以「吗」「么」「呢」结尾）。
 * @param {string} text 规范化以后的整段话。
 * @param {number} start 要求的起点。
 * @param {number} end 要求的终点。
 * @returns {boolean} 是。
 */
function plainAsk(text, start, end) {
  let from = start
  while (from > 0 && !breaksAt(text, from - 1)) from -= 1
  const prefix = text.slice(from, start)
  if (REFUSAL.test(prefix) || MENTION.test(prefix)) return false
  for (const segment of text.matchAll(QUOTED_TEXT)) {
    if (segment.index < start && end <= segment.index + segment[0].length) return false
  }
  let to = end
  while (to < text.length && !breaksAt(text, to)) to += 1
  const suffix = text.slice(end, to).trim()
  return text[to] !== '?' && !/[吗么呢]$/u.test(suffix) && !LABEL_AFTER_ASK.test(suffix)
}

/**
 * 模型说「用户这一轮亲口要求另开会话」时，核对它摘录的原话：逐字出现在这一轮用户自己发的
 * 话里（不计大小写、全半角和空白的差别），并且摘录里有一处真的是要求另开会话（有动作也有会话，
 * 前面没有「不要」之类，也不是在问要不要开）。核对不过就只能出卡。
 * @param {string} quote 模型摘录的原话。
 * @param {string} turnText 这一轮用户发的话（投影里记的）。
 * @returns {boolean} 核对通过。
 */
export function quoteFromUser(quote, turnText) {
  const words = squash(quote)
  const text = squash(turnText)
  if (words.length < 2) return false
  const spans = []
  for (let at = text.indexOf(words); at >= 0; at = text.indexOf(words, at + 1)) spans.push([at, at + words.length])
  if (spans.length === 0) return false
  for (const pattern of ASK_FOR_SESSION) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      const end = start + match[0].length
      if (spans.some(([from, to]) => start >= from && end <= to) && plainAsk(text, start, end)) return true
    }
  }
  return false
}

/** 三种权限从低到高。 */
const PERMISSION_ORDER = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 权限的高低：仅可查看 < 工作区内修改 < 完全权限；custom、取不到的按仅可查看算。
 * @param {string | undefined} permission 权限的取值。
 * @returns {number} 越大越高。
 */
export function permissionRank(permission) {
  return Math.max(0, PERMISSION_ORDER.indexOf(permission))
}

/**
 * 不出卡、直接开会话还要满足的：工作区和当前会话相同，权限不高于当前会话（按当前会话实际的
 * 权限比，custom 或取不到的按仅可查看算）。模型、Agent 预设、推理等级、工作树不限。
 * @param {{workspaceId?: string, permission?: string}} chosen 要用的选项（cardDefaults 加核对以后）。
 * @param {{workspaceId?: string, permission?: string}} current 当前会话的选项（currentOf，不带回退）。
 * @param {(permission: string) => {sandbox: string, approval: string}} [resolvePermission] 宿主目录中的实际沙箱和审批规则。
 * @returns {'workspace' | 'permission' | undefined} 不能直接开的原因；能开是 undefined。
 */
export function directStartBlock(chosen, current, resolvePermission) {
  if (current.workspaceId === undefined || chosen.workspaceId !== current.workspaceId) return 'workspace'
  // 未知的父权限按只读比较；未知的目标（包括没有可设置的权限）必须留给用户确认。
  if (!PERMISSION_ORDER.includes(chosen.permission)) return 'permission'
  if (permissionRank(chosen.permission) > permissionRank(current.permission)) return 'permission'
  if (resolvePermission !== undefined) {
    try {
      const target = resolvePermission(chosen.permission)
      const source = PERMISSION_ORDER.includes(current.permission) ? resolvePermission(current.permission) : undefined
      if (!PERMISSION_ORDER.includes(target?.sandbox) || !['ask', 'never'].includes(target.approval)) return 'permission'
      const targetRank = permissionRank(target.sandbox)
      const sourceRank = permissionRank(source?.sandbox)
      if (targetRank > sourceRank) return 'permission'
      // rc.3 的 never 自动拒绝每个审批请求。改成 ask 以后原先被拒的请求可能获批。
      // 从官方完全权限降到真正的受限模式是约定的降级，其余交叉变化留给用户确认。
      if (target.approval === 'ask' && source?.approval !== 'ask') {
        const fromFullAccess = current.permission === 'danger-full-access' && source?.sandbox === 'danger-full-access' && source.approval === 'never'
        if (!fromFullAccess || chosen.permission !== target.sandbox || targetRank >= sourceRank) return 'permission'
      }
    } catch {
      return 'permission'
    }
  }
  return undefined
}

/**
 * 模型给的推理等级在这个模型上不能用时换成模型的默认等级；模型没有推理等级就不带。
 * @param {string | undefined} effort 想用的推理等级。
 * @param {{efforts?: Array<{id: string}>, defaultEffort?: string} | undefined} info 模型目录里的这一项；不知道是哪个模型时 undefined。
 * @returns {string | undefined} 能用的推理等级。
 */
export function fitEffort(effort, info) {
  if (info === undefined) return effort
  const efforts = (info.efforts ?? []).map(item => item.id)
  if (efforts.length === 0) return undefined
  return effort !== undefined && efforts.includes(effort) ? effort : info.defaultEffort ?? efforts[0]
}

/** 当前会话的权限是 custom、取不到或不在可选里时，依次换成这几种（绝不换成完全权限）。 */
const FALLBACK_PERMISSIONS = ['workspace-write', 'read-only']
/** 当前会话的 Agent 预设不在可选里时先换成它（标准模式），没有就换成第一项。 */
const FALLBACK_PRESET = 'standard'

/**
 * 开始时用的选项（11-17 定的规则）：模型在提议时定了的照它的（用户在对话里说过的，模型照用户说的定）；
 * 模型没定模型时，第一次用当前会话的模型，以后用上一次选的模型（它已不在模型目录里时用当前会话的）；
 * 其余没定的和当前会话一样。
 * 工作树默认不用。给了 choices 时，当前会话的权限（custom、取不到）、Agent 预设、工作区不在可选
 * 里的，换成可选的一项，默认选项总能直接开始：权限换成工作区内修改，没有就仅可查看，绝不换成
 * 完全权限；预设换成标准模式，没有就第一项；工作区换成当前会话所在的那个，没有就第一项。
 * @param {{proposed?: object, current?: object, lastModel?: {provider: string, model: string}, models?: Array<object>, choices?: object}} input
 *   模型定的选项（已解析成标准值）、当前会话的选项、上一次选的模型、模型目录（默认取 choices.models）、宿主现在能选的。
 * @returns {{workspaceId?: string, worktree: boolean, agentPreset?: string, model?: {provider: string, model: string}, reasoningEffort?: string, permission?: string}} 选项。
 */
export function cardDefaults({ proposed = {}, current = {}, lastModel, models = undefined, choices = undefined }) {
  const catalog = models ?? choices?.models ?? []
  /** 模型目录里的这一项；不在目录里（比如已被移除）是 undefined。 */
  const infoOf = model => model === undefined ? undefined : catalog.find(item => item.provider === model.provider && item.model === model.model)
  const model = proposed.model ?? (infoOf(lastModel) !== undefined ? lastModel : current.model)
  const info = infoOf(model)
  let workspaceId = proposed.workspaceId ?? current.workspaceId
  let agentPreset = proposed.agentPreset ?? current.agentPreset
  let permission = proposed.permission ?? current.permission
  if (choices !== undefined) {
    /** 依次取第一个可选的。 */
    const pick = (allowed, ...candidates) => candidates.find(value => value !== undefined && allowed.includes(value))
    const workspaces = choices.workspaces.map(item => item.id)
    workspaceId = pick(workspaces, proposed.workspaceId, current.workspaceId) ?? workspaces[0]
    const presets = choices.presets.map(item => item.id)
    agentPreset = pick(presets, proposed.agentPreset, current.agentPreset, FALLBACK_PRESET) ?? presets[0]
    const permissions = choices.permissions.map(item => item.value)
    permission = permissions.length === 0 ? undefined : pick(permissions, proposed.permission, current.permission, ...FALLBACK_PERMISSIONS)
  }
  return {
    workspaceId,
    worktree: proposed.worktree ?? false,
    agentPreset,
    model,
    reasoningEffort: fitEffort(proposed.reasoningEffort ?? current.reasoningEffort, info),
    permission,
  }
}

/** 比较名字用：全半角、大小写、首尾空白不算差别。 */
function foldName(text) {
  return String(text ?? '').normalize('NFKC').trim().toLowerCase()
}

/** 路径比较用：再去掉末尾的斜杠。 */
function foldPath(text) {
  return foldName(text).replace(/[\\/]+$/u, '')
}

/** 路径的最后一段。 */
function lastSegment(path) {
  return foldPath(path).split(/[\\/]/u).at(-1) ?? ''
}

/** 三种权限的官方叫法（DSH 权限选择器的中英文），模型照界面上的叫法说也认得。 */
const PERMISSION_LABELS = {
  'read-only': ['仅可查看', 'read only'],
  'workspace-write': ['工作区内修改', 'workspace write'],
  'danger-full-access': ['完全权限', 'full access'],
}

/** 认不出时给模型的话：哪个选项、给了什么、能选什么。 */
function unknownOption(name, value, allowed) {
  return new Error(`propose_session options.${name} "${value}" is not available; choose one of: ${allowed.join(', ')}`)
}

/**
 * 把模型在提议时给的选项解析成 DSH 用的标准值：工作区认 id、名字、路径和路径末段，预设认
 * id 和名字，模型认「提供方/模型」、模型 id 和显示名，推理等级认 id 和名字，权限认取值、名字
 * 和界面上的叫法。认不出就报错并列出能选的，模型据此改。
 * @param {object} options proposalArgsOf 规范化后的 options。
 * @param {{workspaces: Array<{id: string, title?: string, path?: string}>, presets: Array<{id: string, name?: string}>, models: Array<object>, permissions: Array<{value: string, name?: string}>, worktree: boolean}} choices 宿主现在能选的。
 * @returns {{workspaceId?: string, worktree?: boolean, agentPreset?: string, model?: {provider: string, model: string}, reasoningEffort?: string, permission?: string}} 标准值。
 * @throws {Error} 有认不出的选项时。
 */
export function resolveProposedOptions(options, choices) {
  const resolved = {}
  if (options.workspace !== undefined) {
    const want = foldPath(options.workspace)
    const hit = choices.workspaces.find(item => foldName(item.id) === want || foldName(item.title) === want
      || (item.path !== undefined && (foldPath(item.path) === want || lastSegment(item.path) === want)))
    if (hit === undefined) throw unknownOption('workspace', options.workspace, choices.workspaces.map(item => item.title || item.path || item.id))
    resolved.workspaceId = hit.id
  }
  if (options.worktree !== undefined) {
    if (options.worktree && !choices.worktree) throw new Error('propose_session options.worktree is not available: this DSH has no worktree support (the official change requests and worktrees bundle)')
    resolved.worktree = options.worktree
  }
  if (options.agentPreset !== undefined) {
    const want = foldName(options.agentPreset)
    const hit = choices.presets.find(item => foldName(item.id) === want || foldName(item.name) === want)
    if (hit === undefined) throw unknownOption('agentPreset', options.agentPreset, choices.presets.map(item => item.id))
    resolved.agentPreset = hit.id
  }
  let modelInfo
  if (options.model !== undefined) {
    const want = foldName(options.model)
    modelInfo = choices.models.find(item => foldName(`${item.provider}/${item.model}`) === want)
      ?? choices.models.find(item => foldName(item.model) === want)
      ?? choices.models.find(item => foldName(item.name) === want)
    if (modelInfo === undefined) throw unknownOption('model', options.model, choices.models.map(item => `${item.provider}/${item.model}`))
    resolved.model = { provider: modelInfo.provider, model: modelInfo.model }
  }
  if (options.reasoningEffort !== undefined) {
    const efforts = modelInfo !== undefined ? modelInfo.efforts ?? []
      : [...new Map(choices.models.flatMap(item => item.efforts ?? []).map(item => [item.id, item])).values()]
    const want = foldName(options.reasoningEffort)
    const hit = efforts.find(item => foldName(item.id) === want || foldName(item.name) === want)
    if (hit === undefined) throw unknownOption('reasoningEffort', options.reasoningEffort, efforts.map(item => item.id))
    resolved.reasoningEffort = hit.id
  }
  if (options.permission !== undefined) {
    const want = foldName(options.permission)
    const hit = choices.permissions.find(item => foldName(item.value) === want || foldName(item.name) === want
      || (PERMISSION_LABELS[item.value] ?? []).some(label => foldName(label) === want))
    if (hit === undefined) throw unknownOption('permission', options.permission, choices.permissions.map(item => item.value))
    resolved.permission = hit.value
  }
  return resolved
}

/** 开始时选项不对：带着是哪一项，网页按它报错。 */
function invalidStart(field) {
  const error = new Error(`invalid ${field}`)
  error.code = 'invalid-options'
  error.field = field
  return error
}

/**
 * 开始时核对网页送来的选项：都还在、互相配得上（推理等级是这个模型有的；没有推理等级的模型不带）。
 * @param {unknown} options 网页送来的选项。
 * @param {object} choices 宿主现在能选的（同 resolveProposedOptions）。
 * @returns {{workspaceId: string, worktree: boolean, agentPreset: string, model: {provider: string, model: string}, reasoningEffort?: string, permission?: string}} 核对过的选项。
 * @throws {Error} 有一项不对时，error.field 说是哪一项。
 */
export function validateStartOptions(options, choices) {
  if (!isRecord(options)) throw invalidStart('options')
  const { workspaceId, worktree, agentPreset, model, reasoningEffort, permission } = options
  if (!choices.workspaces.some(item => item.id === workspaceId)) throw invalidStart('workspace')
  if (typeof worktree !== 'boolean' || (worktree && !choices.worktree)) throw invalidStart('worktree')
  if (!choices.presets.some(item => item.id === agentPreset)) throw invalidStart('preset')
  const info = isRecord(model) ? choices.models.find(item => item.provider === model.provider && item.model === model.model) : undefined
  if (info === undefined) throw invalidStart('model')
  const efforts = (info.efforts ?? []).map(item => item.id)
  if (efforts.length === 0 ? reasoningEffort !== undefined && reasoningEffort !== null : !efforts.includes(reasoningEffort)) throw invalidStart('effort')
  if (choices.permissions.length > 0 ? !choices.permissions.some(item => item.value === permission) : permission !== undefined && permission !== null) throw invalidStart('permission')
  return {
    workspaceId, worktree, agentPreset, model: { provider: info.provider, model: info.model },
    reasoningEffort: efforts.length === 0 ? undefined : reasoningEffort,
    permission: choices.permissions.length === 0 ? undefined : permission,
  }
}

/** 投影的空状态。turnText 是这一轮用户发的话（核对原话用，不发给网页）。 */
export function cardsInit() {
  return { lastTurn: 0, turnText: '', calls: {}, cards: [] }
}

/** 消息里的文字。 */
function textOfContent(content) {
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''
}

/** 普通对象（不是数组、不是 null）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 卡片 A 在 meta 和投影里带的 ask 记录校验。 */
function isAskRecord(value) {
  if (!isRecord(value) || (value.choice !== 'new' && value.choice !== 'here')) return false
  // 按设置自动处理、记住这次的选择、使用自填文字是三种互斥的出处。
  const { choice, auto, remember, custom } = value
  if (auto !== undefined) {
    return remember === undefined && custom === undefined && (auto === 'setting' || (auto === 'no-answer' && choice === 'here'))
  }
  if (remember !== undefined) return custom === undefined && remember === (choice === 'new' ? 'always-new' : 'always-here')
  return custom === undefined || (choice === 'here' && typeof custom === 'string')
}

/** 卡片 A 选择另开时，日志和检查点都要记下实际子会话和启动选项。 */
function hasAskStart(childId, options) {
  return typeof childId === 'string' && childId.trim() !== '' && isRecord(options)
}

/** 从 meta.card.ask 复制干净的字段；形状不对返回 undefined。 */
function askMetaOf(value) {
  if (!isAskRecord(value)) return undefined
  return {
    choice: value.choice,
    ...(value.auto === undefined ? {} : { auto: value.auto }),
    ...(value.remember === undefined ? {} : { remember: value.remember }),
    ...(value.custom === undefined ? {} : { custom: value.custom }),
  }
}

/** 结果 meta 里的卡片；形状不对就当没有。 */
function cardOfMeta(meta) {
  const card = isRecord(meta) && meta.ok === true ? meta.card : undefined
  if (!isRecord(card) || typeof card.title !== 'string' || typeof card.brief !== 'string') return undefined
  const options = isRecord(card.options) ? card.options : {}
  const started = isRecord(card.started) && typeof card.started.childId === 'string' ? card.started : undefined
  if (card.kind === undefined) return card.ask === undefined ? { title: card.title, brief: card.brief, options, started } : undefined
  if (card.kind !== 'ask') return undefined
  if (card.ask === undefined) return card.started === undefined ? { title: card.title, brief: card.brief, options, kind: 'ask' } : undefined
  const ask = askMetaOf(card.ask)
  if (ask === undefined) return undefined
  if (ask.choice === 'new' ? !hasAskStart(started?.childId, started?.options) : card.started !== undefined) return undefined
  return { title: card.title, brief: card.brief, options, kind: 'ask', ask, started }
}

/**
 * workbenchSessionCards 投影的折叠。认不出的事件、形状不对的记录都跳过（抛错会让这个
 * 会话以后每次读都失败）。
 * @param {object} state 当前状态。
 * @param {{type: string, data: any, ignorable?: boolean}} event 会话事件。
 * @returns {object} 新状态。
 */
export function cardsFold(state, event) {
  const data = event.data
  switch (event.type) {
    case 'turn/start':
      return typeof data?.turn === 'number' ? { ...state, lastTurn: data.turn, turnText: '' } : state
    case 'user/message': {
      const source = data?.source
      if (source?.kind === 'user') {
        const text = textOfContent(data.content)
        if (text === '') return state
        return { ...state, turnText: `${state.turnText}\n${text}`.slice(-MAX_TURN_TEXT) }
      }
      if (source?.kind !== REPORT_SOURCE || !REPORT_STATES.includes(source.state)) return state
      const at = state.cards.findIndex(card => card.id === source.cardId)
      if (at < 0) return state
      const last = typeof source.last === 'string' ? source.last.slice(0, MAX_REPORT_LAST) : ''
      const cards = state.cards.slice()
      cards[at] = { ...cards[at], report: { state: source.state, last } }
      return { ...state, cards }
    }
    case 'tool/call':
      if (data?.name !== PROPOSE_TOOL || typeof data.callId !== 'string') return state
      return { ...state, calls: { ...state.calls, [data.callId]: { turn: data.turn } } }
    case 'tool/result': {
      const callId = data?.message?.toolCallId ?? data?.message?.source?.callId
      if (typeof callId !== 'string' || !Object.hasOwn(state.calls, callId)) return state
      const { turn } = state.calls[callId]
      const calls = { ...state.calls }
      delete calls[callId]
      const meta = data.message?.isError === true ? undefined : cardOfMeta(data.meta)
      if (meta === undefined) return { ...state, calls }
      const order = state.cards.filter(card => card.turn === turn).length
      const isAsk = meta.kind === 'ask'
      const card = {
        id: callId, turn, order, title: meta.title, brief: meta.brief, options: meta.options,
        ...(isAsk ? { kind: 'ask' } : {}),
        ...(meta.ask === undefined ? {} : { ask: meta.ask }),
        state: meta.started !== undefined ? 'started' : meta.ask !== undefined ? 'here' : 'pending',
        ...(meta.started === undefined ? {} : { childId: meta.started.childId, started: isRecord(meta.started.options) ? meta.started.options : {} }),
      }
      const cards = [...state.cards, card]
      if (cards.length > MAX_CARDS) cards.splice(0, cards.length - MAX_CARDS)
      return { ...state, calls, cards }
    }
    default: {
      if (event.type !== CARD_RECORD || event.ignorable !== true || !isRecord(data)) return state
      const at = state.cards.findIndex(card => card.id === data.cardId)
      if (at < 0) return state
      const target = state.cards[at]
      if (target.kind === 'ask') {
        if (target.state !== 'pending') return state
        if (data.action === 'start') {
          if (!hasAskStart(data.childId, data.options)) return state
          if (data.remember !== undefined && data.remember !== 'always-new') return state
          const ask = data.remember === 'always-new' ? { choice: 'new', remember: 'always-new' } : { choice: 'new' }
          const cards = state.cards.slice()
          cards[at] = { ...target, state: 'started', childId: data.childId, started: data.options, ask }
          return { ...state, cards }
        }
        if (data.action !== 'here' || (data.remember !== undefined && data.remember !== 'always-here')) return state
        const ask = data.remember === 'always-here' ? { choice: 'here', remember: 'always-here' } : { choice: 'here' }
        const cards = state.cards.slice()
        cards[at] = { ...target, state: 'here', ask }
        return { ...state, cards }
      }
      // 只认 RECORD_ACTIONS 自己的键：toString 这类原型上的名字、['dismiss'] 这类数组都不算。
      const next = typeof data.action === 'string' && Object.hasOwn(RECORD_ACTIONS, data.action) ? RECORD_ACTIONS[data.action] : undefined
      if (next === undefined || (next === 'started' && typeof data.childId !== 'string')) return state
      const cards = state.cards.slice()
      cards[at] = next === 'started'
        ? { ...target, state: next, childId: data.childId, started: isRecord(data.options) ? data.options : {} }
        : { ...target, state: next }
      return { ...state, cards }
    }
  }
}

/**
 * 发给网页的部分：轮次和卡片（这一轮用户的话只留在宿主）。
 * @param {object} state 投影状态。
 * @returns {{lastTurn: number, cards: Array<object>}} 视图。
 */
export function cardsViewOf(state) {
  return { lastTurn: state.lastTurn, cards: state.cards }
}

/** 校验一张卡的形状。 */
function parseCard(card) {
  if (!isRecord(card) || typeof card.id !== 'string' || !Number.isInteger(card.turn) || !Number.isInteger(card.order)
    || typeof card.title !== 'string' || typeof card.brief !== 'string' || !isRecord(card.options) || !CARD_STATES.includes(card.state)) {
    throw new Error('workbenchSessionCards card is malformed')
  }
  if (card.kind === undefined && card.ask === undefined) return card
  if (card.kind === 'ask') {
    if (card.state === 'pending' && card.ask === undefined && card.childId === undefined && card.started === undefined) return card
    if (isAskRecord(card.ask)) {
      if (card.ask.choice === 'new' && card.state === 'started' && hasAskStart(card.childId, card.started)) return card
      if (card.ask.choice === 'here' && card.state === 'here' && card.childId === undefined && card.started === undefined) return card
    }
  }
  throw new Error('workbenchSessionCards card is malformed')
}

/**
 * 校验持久化的投影状态（检查点文件里的 JSON 是文件边界）。
 * @param {unknown} value 存档里的值。
 * @returns {object} 状态。
 * @throws {Error} 形状不对时（检查点作废，从空状态重放）。
 */
export function parseCardsState(value) {
  if (!isRecord(value) || !Number.isInteger(value.lastTurn) || typeof value.turnText !== 'string' || !isRecord(value.calls) || !Array.isArray(value.cards)) {
    throw new Error('workbenchSessionCards state is malformed')
  }
  return { lastTurn: value.lastTurn, turnText: value.turnText, calls: value.calls, cards: value.cards.map(parseCard) }
}

/**
 * 校验发给网页的视图。
 * @param {unknown} value 视图。
 * @returns {{lastTurn: number, cards: Array<object>}} 视图。
 */
export function parseCardsView(value) {
  if (!isRecord(value) || !Number.isInteger(value.lastTurn) || !Array.isArray(value.cards)) throw new Error('workbenchSessionCards view is malformed')
  return { lastTurn: value.lastTurn, cards: value.cards.map(parseCard) }
}

/** 「模型提议另开会话时」这项设置的三个值：询问（默认）、总是新建会话、总是在当前会话处理。 */
export const OWN_SESSION_MODES = ['ask', 'always-new', 'always-here']

/** 默认设置：每次询问。 */
export function defaultOwnSessionPrefs() {
  return { ownSession: 'ask' }
}

/**
 * 校验这项设置：存档文件和网页送来的值都要过这一道。
 * @param {unknown} value 读到的值。
 * @returns {{ownSession: 'ask' | 'always-new' | 'always-here'}} 设置。
 * @throws {Error} ownSession 不是这三个值之一时。
 */
export function ownSessionPrefsOf(value) {
  if (!isRecord(value) || !OWN_SESSION_MODES.includes(value.ownSession)) {
    throw new Error(`ownSession must be one of ${OWN_SESSION_MODES.join(', ')}`)
  }
  return { ownSession: value.ownSession }
}

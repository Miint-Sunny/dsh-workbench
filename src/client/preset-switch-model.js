/**
 * 切换 Agent 预设（feat#162）网页部分的纯函数：宿主回答的整理、标签显示成什么、预设的显示名、菜单项、
 * 确认框各栏的文字、两步的顺序、错误文字、缓存未命中的数。不碰 DOM 和 React，测试可以直接 import。
 *
 * 和宿主的约定（宿主由这一行的 lib/preset-switch*.js 实现）：
 * - GET  api/dsh-workbench.preset-switch?sessionId=        → { ok, value: { current, switchable, targets: [{ id, name, description }] } }
 * - GET  api/dsh-workbench.preset-switch/preview?sessionId=&agentPreset=
 *        → { ok, value: { changes, tools: { added, removed }, systemPrompt, uncachedTokens, compactSuggested, runningSubagents } }，
 *          算不出来的字段是 null；
 * - POST api/dsh-workbench.preset-switch { sessionId, agentPreset, step: 'compact' | 'switch', expectedFrom }
 *        → { ok: true } 或 { ok: false, error: { code, current } }。expectedFrom 是用户这次看到的预览里的 from（防旧预览：
 *        同一个会话开在两个窗口里、别的窗口先切了的时候，宿主回 stale-preview，网页按新预览重走一遍）。
 */

/** 宿主的路由（相对 DSH 网页端的文档地址：和 DSH 同源，带登录 cookie）。 */
export const PRESET_SWITCH_ROUTE = 'api/dsh-workbench.preset-switch'

/** 内置预设的名字在官方词典（settings.agentPreset）里的键，照 dsh-agent-preset-registry/display 的 BUILT_IN_PRESET_KEYS。 */
const PRESET_SWITCH_BUILTIN_NAMES = { standard: 'presetStandardName', ptc: 'presetPtcName', minimal: 'presetMinimalName', cordis: 'presetCordisName' }

/** 系统提示词怎么变：宿主给的三种值各对应一句。 */
const PRESET_SWITCH_PROMPTS = { unchanged: 'pswitch.confirm.unchanged', replaced: 'pswitch.confirm.prompt.replaced', appended: 'pswitch.confirm.prompt.appended' }

/**
 * 宿主 GET 菜单数据的回答。
 * @param {unknown} body 回答的 JSON（取不到时 undefined）。
 * @returns {{current: string, switchable: boolean, targets: {id: string, name: string, description: string}[]} | null} 认不出来时 null。
 */
export function presetSwitchMenuOf(body) {
  const value = body !== null && typeof body === 'object' && body.ok === true ? body.value : undefined
  if (value === null || typeof value !== 'object' || typeof value.current !== 'string' || !Array.isArray(value.targets)) return null
  const targets = value.targets
    .filter(target => target !== null && typeof target === 'object' && typeof target.id === 'string' && target.id !== '')
    .map(target => ({
      id: target.id,
      name: typeof target.name === 'string' && target.name !== '' ? target.name : target.id,
      description: typeof target.description === 'string' ? target.description : '',
    }))
  return { current: value.current, switchable: value.switchable === true, targets }
}

/**
 * 标签显示成什么：会话没有记录预设时不显示；宿主说能切换、说的正是日志投影里这个预设、能选的不止一项时是菜单按钮；
 * 其余（还没回答、回答不对、不能切换、和投影对不上）照官方显示，不能点。
 * @param {string | undefined} preset 日志投影里的预设（官方标签读的同一个值）。
 * @param {{current: string, switchable: boolean, targets: unknown[]} | null | undefined} menu 宿主的菜单数据。
 * @returns {'hidden' | 'static' | 'menu'} 显示方式。
 */
export function presetSwitchLabelKind(preset, menu) {
  if (preset === undefined) return 'hidden'
  if (menu === null || menu === undefined || !menu.switchable || menu.current !== preset || menu.targets.length < 2) return 'static'
  return 'menu'
}

/**
 * 预设的显示名：宿主给的名字；没有就照官方的 presetDisplayText：内置预设（名单里没有自己名字的）查官方词典，
 * 其余用名单里的名字；都没有时用 id（官方标签在名单读到之前也显示 id）。
 * @param {string} id 预设 id。
 * @param {{targets?: {id: string, name: string}[], roster?: {id: string, name?: string}[], official?: (key: string) => string}} sources 宿主的可选项、DSH 的预设名单、官方词典。
 * @returns {string} 显示名。
 */
export function presetSwitchNameOf(id, { targets = [], roster = [], official } = {}) {
  const target = targets.find(item => item.id === id)
  if (target !== undefined) return target.name
  const row = roster.find(item => item?.id === id)
  const key = PRESET_SWITCH_BUILTIN_NAMES[id]
  if (key !== undefined && typeof row?.name !== 'string' && typeof official === 'function') {
    const name = official(key)
    if (typeof name === 'string' && name !== '' && name !== key) return name
  }
  if (typeof row?.name === 'string' && row.name !== '') return row.name
  return id
}

/**
 * 菜单项：宿主给的每个可选项一行（名字和说明由 label 画）；会话运行中或有待处理的交互时都不能选，顶上一行说明。
 * @param {{targets: {id: string}[], busy: boolean, busyText: string, label: (target: object) => unknown}} input 可选项、是否不能切换、说明、画一行的函数。
 * @returns {object[]} ui.Menu 的 items。
 */
export function presetSwitchMenuEntries({ targets, busy, busyText, label }) {
  const items = targets.map(target => (busy ? { id: target.id, label: label(target), disabled: true } : { id: target.id, label: label(target) }))
  return busy ? [{ type: 'label', id: 'busy', text: busyText }, ...items] : items
}

/**
 * 宿主预览的回答。取不到预览时按「都算不出来」处理：照样弹确认框，各栏写「无法估算」。
 * @param {unknown} body 回答的 JSON（取不到时 undefined）。
 * @returns {{available: boolean, from: string | null, changes: boolean, tools: {added: string[], removed: string[]} | null, systemPrompt: 'unchanged' | 'replaced' | 'appended' | null, uncachedTokens: number | null, compactSuggested: boolean, runningSubagents: number | null}} 预览；available 是取到了宿主的预览，from 是预览时会话实际的预设，runningSubagents 是 null 时数不清。
 */
export function presetSwitchPreviewOf(body) {
  const available = body !== null && typeof body === 'object' && body.ok === true && body.value !== null && typeof body.value === 'object'
  const value = available ? body.value : {}
  const names = list => (Array.isArray(list) ? list.filter(name => typeof name === 'string') : null)
  const added = names(value.tools?.added)
  const removed = names(value.tools?.removed)
  return {
    available,
    from: typeof value.from === 'string' && value.from !== '' ? value.from : null,
    changes: value.changes !== false,
    tools: added === null || removed === null ? null : { added, removed },
    systemPrompt: Object.hasOwn(PRESET_SWITCH_PROMPTS, value.systemPrompt ?? '') ? value.systemPrompt : null,
    uncachedTokens: Number.isFinite(value.uncachedTokens) && value.uncachedTokens >= 0 ? Math.round(value.uncachedTokens) : null,
    compactSuggested: value.compactSuggested === true,
    runningSubagents: Number.isInteger(value.runningSubagents) && value.runningSubagents >= 0 ? value.runningSubagents : null,
  }
}

/**
 * 「工具」一栏：增加、移除各几个（照 DSH 的「新增 {added} 个，移除 {removed} 个」）。
 * @param {{added: string[], removed: string[]} | null} tools 预览的工具增减；null 是算不出来。
 * @returns {[string, object?]} 词典键和参数。
 */
export function presetSwitchToolsText(tools) {
  if (tools === null) return ['pswitch.confirm.unknown']
  const added = tools.added.length
  const removed = tools.removed.length
  if (added > 0 && removed > 0) return ['pswitch.confirm.toolsChanged', { added, removed }]
  if (added > 0) return ['pswitch.confirm.toolsAdded', { count: added }]
  if (removed > 0) return ['pswitch.confirm.toolsRemoved', { count: removed }]
  return ['pswitch.confirm.unchanged']
}

/**
 * 「系统提示词」一栏。
 * @param {'unchanged' | 'replaced' | 'appended' | null} systemPrompt 预览的系统提示词变化；null 是算不出来。
 * @returns {string} 词典键。
 */
export function presetSwitchPromptText(systemPrompt) {
  return systemPrompt === null ? 'pswitch.confirm.unknown' : PRESET_SWITCH_PROMPTS[systemPrompt]
}

/**
 * token 数的简写，照 DSH 的 formatTokens（ui-chat token-format、ui-conversation ContextMeter）：不到一千照写，
 * 千和百万缩成 K、M，一百以下留一位小数。
 * @param {number} value 非负的 token 数。
 * @param {(key: string, params?: object) => string} t 词典。
 * @returns {string} 简写。
 */
export function presetSwitchTokens(value, t) {
  const scaled = candidate => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('pswitch.number.thousand', { value: scaled(value / 1_000) })
  return t('pswitch.number.million', { value: scaled(value / 1_000_000) })
}

/**
 * 这一次要发的步骤：勾了「先压缩上下文」且还没压缩过时先压缩，再切换；压缩成功、切换失败以后重试只切换。
 * @param {{compact: boolean, compacted: boolean}} flow 确认框的状态。
 * @returns {('compact' | 'switch')[]} 步骤。
 */
export function presetSwitchSteps({ compact, compacted }) {
  return compact && !compacted ? ['compact', 'switch'] : ['switch']
}

/**
 * 宿主回 stale-preview（同一个会话在别的窗口先切了，用户看到的预览已经过期）以后，重新取到的预览怎么处理：
 * 取不到 → 'failed'（写「切换失败，当前会话仍为{预设}」）；会话已经是要切换到的预设 → 'done'（关框，不再切换）；
 * 没有变化且这一次还没自动重发过 → 'switch'（照不弹框的规矩直接切换）；其余 → 'confirm'（按新的差异弹框请用户确认）。
 * 没有用户操作、连着第二次过期时也弹框，不来回自动重发。
 * @param {{available: boolean, from: string | null, changes: boolean}} preview 重新取到的预览。
 * @param {{target: string, retried: boolean}} context 要切换到的预设；上一次用户操作以后是否已经自动重发过一次。
 * @returns {'failed' | 'done' | 'switch' | 'confirm'} 下一步。
 */
export function presetSwitchAfterStale(preview, { target, retried }) {
  if (!preview.available) return 'failed'
  if (preview.from === target) return 'done'
  if (!preview.changes && !retried) return 'switch'
  return 'confirm'
}

/**
 * 失败时写在确认框里的文字（宿主只回代码）：压缩失败、会话已开始新的一轮、正在切换、预设不可用各写各的；
 * 其余（切换失败、记录失败、不认识的代码、网络错误）写「切换失败」和会话实际的预设。
 * @param {{code?: string}} error 宿主回答的错误；网络错误时是空对象。
 * @param {{current: string, target: string}} names 会话实际的预设、要切换到的预设的显示名。
 * @returns {[string, object?]} 词典键和参数。
 */
export function presetSwitchErrorText(error, names) {
  switch (error?.code) {
    case 'compact-failed': return ['pswitch.error.compact-failed', { name: names.current }]
    case 'not-idle': return ['pswitch.error.not-idle']
    case 'busy': return ['pswitch.error.busy']
    case 'unsupported': return ['pswitch.error.unsupported', { name: names.target }]
    default: return ['pswitch.error.failed', { name: names.current }]
  }
}

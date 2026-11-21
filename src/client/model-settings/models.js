/** 模型目录的草稿、校验和路径操作；规则照 DSH 0.2.1-rc.5 内置模型页（MIT，见 NOTICE 和 README「第三方来源」）。 */

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 }

/**
 * 读容量：可以写 256K、1M。
 * @param {string} text 输入框文字。
 * @returns {number | undefined} token 数；空白时 undefined（用默认值），写错时 NaN。
 */
export function parseCapacity(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scaled = Number(match[1]) * (suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1)
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/**
 * 把存储的容量写回最短的写法。
 * @param {number} value token 数。
 * @returns {string} 输入框文字。
 */
export function formatCapacity(value) {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`
  if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`
  return String(value)
}

/**
 * 把设置里的 `models` 转成可编辑的行，保留编辑器不认识的字段。
 * @param {unknown} value `models` 的值。
 * @returns {Record<string, unknown>[]} 行。
 */
export function modelDrafts(value) {
  if (!Array.isArray(value)) return []
  return value.map(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {})
}

/**
 * 适配器会拒绝、但设置 schema 表达不了的情况，按行报出第一处。
 * @param {unknown} value 草稿里的 `models`；继承时为 undefined。
 * @returns {{ index: number, key: string } | undefined} 出错的行和文案键。
 */
export function validateModels(value) {
  if (value === undefined) return undefined
  const seen = new Set()
  for (const [index, model] of modelDrafts(value).entries()) {
    const id = typeof model.id === 'string' ? model.id.trim() : undefined
    if (id === undefined || id.length === 0) return { index, key: 'modelIdRequired' }
    if (seen.has(id)) return { index, key: 'modelIdDuplicate' }
    seen.add(id)
    if (model.name !== undefined && (typeof model.name !== 'string' || model.name.length === 0)) return { index, key: 'modelNameInvalid' }
    for (const [field, key] of [['contextWindow', 'modelContextInvalid'], ['maxTokens', 'modelMaxTokensInvalid']]) {
      const count = model[field]
      if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count <= 0)) return { index, key }
    }
  }
  return undefined
}

/**
 * 读一行声明的推理等级，保留表里不认识的档位。
 * @param {Record<string, unknown>} model 模型行。
 * @returns {[string, unknown][] | undefined} 档位和参数值；字段不存在或为 false 时 undefined。
 */
export function readEfforts(model) {
  const value = model.reasoningEfforts
  if (value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.entries(value)
}

/**
 * 换掉一行的推理等级，其余字段不动。
 * @param {Record<string, unknown>} model 模型行。
 * @param {[string, unknown][] | undefined} entries 新的档位；undefined 表示关闭推理等级。
 * @returns {Record<string, unknown>} 新的行。
 */
export function withEfforts(model, entries) {
  const next = { ...model }
  if (entries === undefined) delete next.reasoningEfforts
  else next.reasoningEfforts = Object.fromEntries(entries)
  return next
}

/**
 * 各行的模型 ID，按行的顺序；没有 ID 的行记为空字符串。
 * @param {readonly Record<string, unknown>[]} rows 模型行。
 * @returns {string[]} ID 顺序。
 */
export function rowIds(rows) {
  return rows.map(model => (typeof model?.id === 'string' ? model.id : ''))
}

/**
 * 两组 ID 顺序是否一样。
 * @param {readonly string[]} left 一组。
 * @param {readonly string[]} right 另一组。
 * @returns {boolean} 一样时 true。
 */
export function msSameIds(left, right) {
  return left.length === right.length && left.every((id, at) => id === right[at])
}

/**
 * 行从外面换了（在选择器里删目录外的模型、恢复默认、取消）时，把旧行的键按模型 ID 对回新行：
 * ID 非空且新旧两边都只出现一次的模型沿用原来的键，其余拿新键。不按位置对，免得键、展开状态和写到一半的文字落到别的模型上。
 * @param {readonly Record<string, unknown>[]} before 旧行。
 * @param {readonly string[]} keys 旧行的键，和 before 一一对应。
 * @param {readonly Record<string, unknown>[]} after 新行。
 * @param {() => string} fresh 发一个新键。
 * @returns {string[]} 新行的键。
 */
export function alignRowKeys(before, keys, after, fresh) {
  const tally = list => rowIds(list).reduce((counts, id) => counts.set(id, (counts.get(id) ?? 0) + 1), new Map())
  const was = tally(before)
  const now = tally(after)
  const kept = new Map(rowIds(before).flatMap((id, at) => (id !== '' && was.get(id) === 1 && now.get(id) === 1 && keys[at] !== undefined ? [[id, keys[at]]] : [])))
  return rowIds(after).map(id => kept.get(id) ?? fresh())
}

/** 打开推理等级开关时的初始档位。 */
export const INITIAL_EFFORTS = [['off', null], ['low', 'low'], ['medium', 'medium'], ['high', 'high']]

/**
 * 手工声明路由的推理等级是否会被 pi-ai 拒绝。
 * @param {unknown} value 草稿里的 `models`。
 * @param {readonly string[]} [only] 协议只接受的档位（Gemini API），参数值必须和档位同名。
 * @returns {{ index: number, key: string } | undefined} 出错的行和文案键。
 */
export function validateReasoningEfforts(value, only) {
  for (const [index, model] of modelDrafts(value).entries()) {
    const entries = readEfforts(model)
    if (entries === undefined) continue
    // 协议只收某几档、参数值和档位同名（Gemini API）：先报这一条，照官方 rc.2 ModelReasoningEfforts.tsx:91-104。
    if (only !== undefined && !entries.every(([level, wire]) => only.includes(level) && wire === level)) return { index, key: 'modelReasoningLevelsOnly' }
    const accepted = ([level, wire]) => typeof wire === 'string' ? wire.length > 0 : wire === null && level === 'off'
    if (!entries.every(accepted)) return { index, key: 'modelReasoningValueRequired' }
    if (!entries.some(([level]) => level !== 'off')) return { index, key: 'modelReasoningNeedsLevel' }
  }
  return undefined
}

/**
 * 每行按它自己能用的档位校验推理等级：目录外的模型挂在各自协议的伴随条目上，同一列里可能有 Gemini API 的行。
 * @param {unknown} value 草稿里的 `models`。
 * @param {(model: Record<string, unknown>) => { levels: readonly string[], levelsOnly: boolean }} levelsFor 一行能用的档位；levelsOnly 时参数值必须和档位同名。
 * @returns {{ index: number, key: string } | undefined} 出错的行和文案键；没有档位的行不校验。
 */
export function validateReasoningByRow(value, levelsFor) {
  for (const [index, model] of modelDrafts(value).entries()) {
    const { levels, levelsOnly } = levelsFor(model)
    if (levels.length === 0) continue
    const failure = validateReasoningEfforts([model], levelsOnly ? levels : undefined)
    if (failure !== undefined) return { index, key: failure.key }
  }
  return undefined
}

/** 按模型 ID 认出的专用模型：深度研究、图像、语音、实时、嵌入、电脑操作等，发一句话检查连接会被拒绝或很贵。 */
const SPECIAL_MODEL = /(^|[-_./\s])(deep-research|embedding|embed|tts|speech|audio|transcribe|whisper|image|imagen|veo|video|live|realtime|moderation|rerank|search|computer-use|customtools|codex)(?=$|[-_./\s\d])/i
/** 轻量档的模型名。前后必须是分隔符，MiniMax、Gemini 里的 mini 不算。 */
const LIGHT_MODEL = /(^|[-_./\s])(lite|nano|mini|haiku|small|tiny|air)(?=$|[-_./\s\d])/i
/** 快速档的模型名。 */
const FAST_MODEL = /(^|[-_./\s])(flash|fast|turbo|instant)(?=$|[-_./\s\d])/i

/**
 * 挑「检查连接」用的模型：默认模型在这一家时用它；否则跳过专用模型，先挑轻量档，再挑快速档，最后才是其余模型。同一档里优先带 latest 的别名，没有就取列表里最后一个（目录按 ID 排序时是最新的版本）。
 * @param {readonly string[]} ids 这一家的模型 ID，按目录顺序。
 * @param {string | undefined} defaultModel 默认模型在这一家时的模型 ID。
 * @returns {string | undefined} 挑中的模型 ID；一个模型都没有时为 undefined。
 */
export function pickCheckModel(ids, defaultModel) {
  if (defaultModel !== undefined) return defaultModel
  const usable = ids.filter(id => !SPECIAL_MODEL.test(id))
  for (const tier of [LIGHT_MODEL, FAST_MODEL, undefined]) {
    const matched = tier === undefined ? usable : usable.filter(id => tier.test(id))
    if (matched.length > 0) return matched.find(id => /latest/i.test(id)) ?? matched[matched.length - 1]
  }
  return ids[0]
}

/**
 * 「获取可用模型」的候选写成一行，带上提供商公布的容量和输入类型。
 * @param {{ id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }} candidate 候选。
 * @param {'pi-ai' | 'deepseek'} family 适配器家族，决定输入类型写在哪个字段。
 * @returns {Record<string, unknown>} 模型行。
 */
export function adoptCandidate(candidate, family) {
  return {
    id: candidate.id,
    ...candidate.name === undefined ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...candidate.inputModalities === undefined ? {} : { [inputField(family)]: [...candidate.inputModalities] },
  }
}

/**
 * 模型选择器的行：提供商公布的模型按原顺序（重复的 ID 只留第一个），后面接列表里有、提供商没公布的自定义模型。
 * @param {readonly { id: string, name?: string }[]} candidates 提供商公布的模型。
 * @param {readonly Record<string, unknown>[]} rows 目录里现在的行（草稿）；ID 为空的行还没填完，不算。
 * @returns {{ id: string, name: string | undefined, added: boolean, candidate?: object }[]} 每行带「是否已在列表里」；自定义模型没有 candidate。
 */
export function modelPickerEntries(candidates, rows) {
  const inList = new Set(rows.flatMap(row => typeof row.id === 'string' && row.id.length > 0 ? [row.id] : []))
  const seen = new Set()
  const entries = []
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    entries.push({ id: candidate.id, name: candidate.name, added: inList.has(candidate.id), candidate })
  }
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) continue
    seen.add(row.id)
    entries.push({ id: row.id, name: typeof row.name === 'string' ? row.name : undefined, added: true })
  }
  return entries
}

/**
 * 选择器当前看到的行和各标签页的数量。搜索先过滤，标签页的数量就是搜索结果里各类的个数。
 * @param {{ id: string, name?: string, added: boolean }[]} entries modelPickerEntries 的结果。
 * @param {{ tab: 'all' | 'added' | 'notAdded', query: string }} state 当前标签页和搜索词；搜索忽略大小写和首尾空白，匹配 ID 和名称。
 * @returns {{ visible: object[], counts: { all: number, added: number, notAdded: number } }} 当前标签页里的行和三个数量。
 */
export function modelPickerView(entries, { tab, query }) {
  const needle = query.trim().toLowerCase()
  const matched = needle.length === 0 ? entries
    : entries.filter(entry => entry.id.toLowerCase().includes(needle) || entry.name?.toLowerCase().includes(needle) === true)
  const added = matched.filter(entry => entry.added)
  const notAdded = matched.filter(entry => !entry.added)
  return { visible: tab === 'added' ? added : tab === 'notAdded' ? notAdded : matched, counts: { all: matched.length, added: added.length, notAdded: notAdded.length } }
}

/**
 * 打开选择器时先看哪个标签页：打开它多半是为了加还没加的模型，所以有没加的就看「未添加」，都加了就看「全部」。
 * @param {{ added: boolean }[]} entries modelPickerEntries 的结果。
 * @returns {'all' | 'notAdded'} 标签页。
 */
export function defaultModelPickerTab(entries) {
  return entries.some(entry => !entry.added) ? 'notAdded' : 'all'
}

/**
 * 把选择器里的行加进目录：只加还没加过、提供商公布了的，接在现有行后面，带上提供商公布的容量和输入类型；已有的行不动。
 * @param {readonly Record<string, unknown>[]} rows 目录里现在的行。
 * @param {readonly { added: boolean, candidate?: object }[]} entries 要加的行。
 * @param {'pi-ai' | 'deepseek'} family 适配器家族。
 * @returns {Record<string, unknown>[]} 新的行；没有要加的就是原来的数组。
 */
export function addPickedModels(rows, entries, family) {
  const fresh = entries.filter(entry => !entry.added && entry.candidate !== undefined)
  return fresh.length === 0 ? rows : [...rows, ...fresh.map(entry => adoptCandidate(entry.candidate, family))]
}

/**
 * 按 ID 从目录里删掉模型。
 * @param {readonly Record<string, unknown>[]} rows 目录里现在的行。
 * @param {ReadonlySet<string>} ids 要删的模型 ID。
 * @returns {Record<string, unknown>[]} 剩下的行。
 */
export function removeModelsById(rows, ids) {
  return rows.filter(row => !ids.has(row.id))
}

/**
 * 改一行的若干字段；值为 undefined 或空串的字段从行里去掉，不写成 schema 会拒绝的值。
 * @param {Record<string, unknown>} model 模型行。
 * @param {Record<string, unknown>} next 要改的字段。
 * @returns {Record<string, unknown>} 新的行。
 */
export function patchModel(model, next) {
  const cleared = new Set(Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key))
  return Object.fromEntries(Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)))
}

/**
 * 输入类型存在哪个字段：DeepSeek 用 `inputModalities`，pi-ai 用 `input`。
 * @param {'pi-ai' | 'deepseek'} family 适配器家族。
 * @returns {string} 字段名。
 */
export function inputField(family) {
  return family === 'deepseek' ? 'inputModalities' : 'input'
}

/**
 * 一行显示的输入类型：行里写了就用行里的，否则用安装目录给的，再否则只有文本。
 * @param {Record<string, unknown>} model 模型行。
 * @param {'pi-ai' | 'deepseek'} family 适配器家族。
 * @param {readonly string[] | undefined} fallback 安装目录给的输入类型。
 * @returns {string[]} 输入类型。
 */
export function inputTypesOf(model, family, fallback) {
  const own = model[inputField(family)]
  if (Array.isArray(own) && own.length > 0) return own.filter(type => typeof type === 'string')
  return fallback !== undefined && fallback.length > 0 ? [...fallback] : ['text']
}

/**
 * 改一行的输入类型；DeepSeek 去掉图片时一并去掉图片的上限字段，适配器在没有图片输入时会拒绝它们。
 * @param {Record<string, unknown>} model 模型行。
 * @param {'pi-ai' | 'deepseek'} family 适配器家族。
 * @param {readonly string[]} types 至少一种输入类型。
 * @returns {Record<string, unknown>} 新的行。
 */
export function withInputTypes(model, family, types) {
  const next = { ...model, [inputField(family)]: [...types] }
  if (family === 'deepseek' && !types.includes('image')) {
    delete next.imagePixelBudget
    delete next.imageMaxBytes
  }
  return next
}

/**
 * 「获取可用模型」失败时的原因：把 DSH 给的英文原文归成几类，好写成能照着修的中文。
 * @param {string} message DSH 模型发现接口的错误原文。
 * @returns {{ key: string, vars?: Record<string, string | number> }} 文案键和变量。
 */
export function discoveryFailure(message) {
  const answered = /answered (\d{3})\b/.exec(message)
  const status = answered === null ? undefined : Number(answered[1])
  if (status === 401 || status === 403) return { key: 'fetchAuth', vars: { status } }
  if (status === 404) return { key: 'fetchNotFound' }
  const reach = /could not reach (\S+)/.exec(message)
  if (reach !== null) {
    let host = reach[1]
    try {
      host = new URL(reach[1]).host
    } catch {
      // 原文里的地址读不出来时照原样写。
    }
    return { key: 'fetchUnreachable', vars: { host } }
  }
  if (/has no model listing/.test(message)) return { key: 'fetchUnsupported' }
  if (/did not answer with JSON/.test(message)) return { key: 'fetchNotJson' }
  return { key: 'fetchFailed', vars: { message } }
}

const msIsRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 把编辑后的子树写成最少的路径操作。两边都是对象时逐字段往下比，只写改过的叶子，没改的继承字段保持继承（照官方 rc.2 ProviderEditor.tsx:142-159）；数组和其他值整个写。
 * @param {readonly string[]} base 子树在用户层里的路径。
 * @param {unknown} before 原来的子树。
 * @param {Record<string, unknown>} after 编辑后的子树。
 * @returns {{ op: 'set' | 'unset', path: string[], value?: unknown }[]} 路径操作，没有改动时为空。
 */
export function pathOps(base, before, after) {
  const previous = msIsRecord(before) ? before : {}
  const ops = []
  for (const [key, value] of Object.entries(after)) {
    const prior = previous[key]
    if (JSON.stringify(prior) === JSON.stringify(value)) continue
    if (msIsRecord(value) && (prior === undefined || msIsRecord(prior)) && prior !== undefined) ops.push(...pathOps([...base, key], prior, value))
    else ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  return ops
}

/**
 * 把一行移到另一个位置；越界时贴到头或尾。
 * @param {readonly object[]} rows 模型行。
 * @param {number} from 原位置。
 * @param {number} to 新位置。
 * @returns {object[]} 新的行。
 */
export function moveModel(rows, from, to) {
  const target = Math.max(0, Math.min(rows.length - 1, to))
  if (from === target || from < 0 || from >= rows.length) return [...rows]
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * 协议混合的提供商（OpenCode Go、OpenRouter 等）的目录外模型：每种协议一个「伴随条目」，用 DSH 本来就支持的自定义模型 API 配置。
 * DSH 对目录外的模型只能用整家共同的协议（dsh-llm-pi-ai catalog.ts:917-924），单个模型又不能写协议（catalog.ts:604-620），
 * 给整家写 api、baseURL 会连目录里的模型一起改掉，所以把这些模型放进 Provider ID 为 `<原提供商>--<协议简称>` 的条目里。
 * 宿主端和页面（构建时拼进 lib/client.js）共用这一份。
 */
import { deriveKeyRef } from './key-ref.js'

/** 协议到 Provider ID 里的简称。 */
const COMPANION_SLUGS = { 'openai-completions': 'openai', 'openai-responses': 'responses', 'anthropic-messages': 'anthropic', 'google-generative-ai': 'gemini' }

/** 获取列表时用的协议，推不出协议时也用它。 */
const LISTING_API = 'openai-completions'

/**
 * 伴随条目的 Provider ID。
 * @param {string} origin 原提供商的 Provider ID。
 * @param {string} api 协议。
 * @returns {string | undefined} Provider ID；这种协议不支持时 undefined。
 */
export function companionRoute(origin, api) {
  const slug = COMPANION_SLUGS[api]
  return slug === undefined ? undefined : `${origin}--${slug}`
}

/**
 * 认出伴随条目属于哪一家、哪种协议。
 * @param {string} route Provider ID。
 * @param {(origin: string) => boolean} [isCatalog] 原提供商是不是目录里的提供商；给了就要求是。
 * @returns {{ origin: string, api: string } | undefined} 原提供商和协议；不是伴随条目时 undefined。
 */
export function parseCompanion(route, isCatalog) {
  const match = /^(.+)--([a-z]+)$/.exec(route)
  if (match === null) return undefined
  const api = Object.keys(COMPANION_SLUGS).find(key => COMPANION_SLUGS[key] === match[2])
  if (api === undefined) return undefined
  if (isCatalog !== undefined && !isCatalog(match[1])) return undefined
  return { origin: match[1], api }
}

/** 协议名：伴随条目的显示名以「（协议名）」结尾，和页面上的协议名是同一份（src/client/model-settings/copy.js 的 protocol.*，中英文相同）。 */
export const COMPANION_LABELS = { 'openai-completions': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages', 'google-generative-ai': 'Gemini API' }

/**
 * 认出插件自己建的伴随条目。ID 形状之外还要核对写入时一定带的两样：`api` 是 ID 里的协议，显示名以「（协议名）」或「 (协议名)」结尾；
 * 原提供商必须是目录里的提供商。用户手写的同形条目（例如指向自己中转站的 `openrouter--openai`）对不上就不认：不藏、不改、不跟着删。
 * @param {string} route Provider ID。
 * @param {unknown} profile 这个条目的配置。
 * @param {(origin: string) => boolean} isCatalog 原提供商是不是目录里的提供商。
 * @returns {{ origin: string, api: string } | undefined} 原提供商和协议；不是我们建的时 undefined。
 */
export function ownCompanion(route, profile, isCatalog) {
  const parsed = parseCompanion(route, isCatalog)
  if (parsed === undefined || typeof profile !== 'object' || profile === null || profile.api !== parsed.api) return undefined
  const name = typeof profile.displayName === 'string' ? profile.displayName.trim() : ''
  const label = COMPANION_LABELS[parsed.api]
  return name.endsWith(`（${label}）`) || name.endsWith(` (${label})`) ? parsed : undefined
}

/**
 * 模型 ID 的家族：第一个 `-`、`/`、`.` 之前的部分，小写。
 * @param {string} id 模型 ID。
 * @returns {string} 家族。
 */
export function modelFamily(id) {
  return id.toLowerCase().split(/[-/.]/)[0] ?? ''
}

/**
 * 目录外的模型要用哪种协议：目录里这一家同一家族的模型都用同一种协议就用它，否则用获取列表时的 OpenAI Chat Completions。
 * @param {string} id 模型 ID。
 * @param {readonly { id: string, api: string }[]} catalog 这一家的安装包目录。
 * @returns {string} 协议。
 */
export function inferApi(id, catalog) {
  const family = modelFamily(id)
  const apis = new Set(catalog.filter(model => modelFamily(model.id) === family).map(model => model.api))
  return apis.size === 1 && COMPANION_SLUGS[[...apis][0]] !== undefined ? [...apis][0] : LISTING_API
}

/**
 * 插件认为 DSH 允许写在条目上的兼容开关。这份清单是照 DSH 0.2.2-rc.2 抄的（dsh-llm-pi-ai catalog.ts 的
 * COMPLETIONS/RESPONSES/ANTHROPIC_COMPAT_GATE 里标 offer 的；标 withhold 的是 pi-ai 按厂商自己设的，写了 DSH 不认），
 * 不是运行时从 DSH 读的：DSH 改了允许的字段时要跟着改这里，package.json 里 engines.dsh 的上限（<0.3.0）就是为此兜底。Gemini API 没有兼容开关。
 */
const OFFERED_COMPAT = {
  'openai-completions': ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField',
    'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
    'chatTemplateKwargs', 'chatTemplateArgs', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField', 'vllmPriority', 'supportsStrictMode', 'cacheControlFormat',
    'supportsLongCacheRetention'],
  'openai-responses': ['supportsDeveloperRole', 'supportsMaxOutputTokens', 'supportsStrictMode', 'supportsLongCacheRetention'],
  'anthropic-messages': ['supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking',
    'allowEmptySignature', 'supportsStrictTools'],
}

/**
 * 每种协议能不能给目录外的模型用，能用时的地址和兼容开关。
 * - 地址：目录里这种协议的模型地址都相同、是普通的 http(s) 地址才用。地址里带 `{…}` 的要由 pi-ai 从环境变量拼出（Cloudflare AI Gateway），
 *   没有地址的要从环境变量来（Azure），伴随条目都拼不出，不能用。
 * - 模型带专用请求头的（GitHub Copilot 的编辑器头，它还要 pi-ai 自己的登录换令牌）伴随条目带不全，不能用。
 * - 兼容开关：这种协议的目录模型全都一样、在上面那份清单里的才带上；按模型不同的不带。
 * @param {readonly { api: string, baseUrl?: string, compat?: Record<string, unknown>, headers?: Record<string, string> }[]} catalog 安装包目录。
 * @returns {{ usable: Record<string, { base: string, compat: Record<string, unknown> }>, unusable: Record<string, 'template' | 'noBase' | 'headers'> }} 结果。
 */
export function protocolInfo(catalog) {
  const byApi = {}
  for (const model of catalog) if (COMPANION_SLUGS[model.api] !== undefined) (byApi[model.api] ??= []).push(model)
  const usable = {}
  const unusable = {}
  for (const [api, models] of Object.entries(byApi)) {
    const urls = [...new Set(models.map(model => model.baseUrl))]
    if (models.some(model => model.headers !== undefined && Object.keys(model.headers).length > 0)) unusable[api] = 'headers'
    else if (urls.some(url => typeof url === 'string' && url.includes('{'))) unusable[api] = 'template'
    else if (urls.length !== 1 || typeof urls[0] !== 'string' || !/^https?:\/\//.test(urls[0])) unusable[api] = 'noBase'
    else usable[api] = { base: urls[0], compat: sharedCompat(api, models) }
  }
  return { usable, unusable }
}

/** 这种协议的目录模型都一样的、在 OFFERED_COMPAT 清单里的兼容开关，按字段名排序。 */
function sharedCompat(api, models) {
  const shared = {}
  for (const field of [...OFFERED_COMPAT[api] ?? []].sort()) {
    const values = new Set(models.map(model => JSON.stringify(model.compat?.[field])))
    const [value] = values
    if (values.size === 1 && value !== undefined) shared[field] = JSON.parse(value)
  }
  return shared
}

/**
 * 伴随条目的地址能选哪几个：原提供商在自定义设置里写的地址（DSH 对目录里的模型也整体换成它，catalog.ts:924），目录里这种协议的地址。
 * 原提供商的自定义地址只对一种协议对（例如以 /v1 结尾时 Anthropic Messages 会变成 /v1/v1/messages），所以两个都给，页面上能选。
 * @param {string | undefined} override 原提供商的自定义地址。
 * @param {string | undefined} catalogBase 目录里这种协议的地址。
 * @returns {string[]} 可选的地址，先自定义地址。
 */
export function addressChoices(override, catalogBase) {
  return [...new Set([override, catalogBase].filter(url => typeof url === 'string' && url.trim().length > 0).map(url => url.trim()))]
}

/**
 * 伴随条目该用的地址：存着的是可选地址之一就保留（用户选过的），否则算过时（例如原提供商删掉了自定义地址），换成第一个。
 * @param {string | undefined} stored 条目里存的地址。
 * @param {readonly string[]} choices 可选的地址。
 * @returns {string | undefined} 该用的地址；没有可选的时 undefined。
 */
export function settledAddress(stored, choices) {
  return typeof stored === 'string' && choices.includes(stored) ? stored : choices[0]
}

/**
 * 伴随条目用的凭据名：原提供商实际在用的那一个，不复制密钥。配置点名的优先；没点名时原提供商走环境变量，用目录里以 `_API_KEY` 结尾的名字；都没有就用派生名。
 * @param {string} origin 原提供商的 Provider ID。
 * @param {Record<string, unknown> | undefined} profile 原提供商（保存后）的配置。
 * @param {readonly string[] | undefined} nativeEnv 目录里的环境变量名。
 * @returns {string} 凭据名。
 */
export function companionKeyRef(origin, profile, nativeEnv) {
  const named = profile?.apiKeyEnv
  if (typeof named === 'string' && named.length > 0) return named
  return (nativeEnv ?? []).find(ref => /_API_KEY$/.test(ref)) ?? deriveKeyRef(origin)
}

/**
 * 把「每种协议要有哪些目录外模型」写成对 llm-pi-ai 的路径操作：新协议建条目；改了的模型、凭据名、地址只写那一项；没有模型的协议删掉条目。
 * @param {{ origin: string, current: Record<string, Record<string, unknown>>, wanted: Record<string, object[]>, keyRef: string, entries: Record<string, { baseURL: string, compat?: Record<string, unknown> }>, nameFor: (api: string) => string }} input
 *   current 是现有伴随条目的用户层配置（按 Provider ID）；wanted 是保存后每种协议的模型；entries 是每种协议该用的地址和兼容开关（没有的协议不写，也不沿用旧地址）；
 *   nameFor 给新条目起显示名：原提供商名接协议名，对话的模型选择器里就显示这个名字；
 *   taken 是被别的条目（手写的、或显示名被改掉的）占着的 Provider ID：DSH 的 set 是整值替换，绝不写它们。
 * @returns {{ op: 'set' | 'unset', path: string[], value?: unknown }[]} 路径操作。
 */
export function companionPlan({ origin, current, wanted, keyRef, entries, nameFor, taken = [] }) {
  const ops = []
  const apis = new Set([...Object.keys(wanted), ...Object.keys(current).flatMap(route => parseCompanion(route)?.api ?? [])])
  for (const api of apis) {
    const route = companionRoute(origin, api)
    if (route === undefined || (current[route] === undefined && taken.includes(route))) continue
    const models = wanted[api] ?? []
    const existing = current[route]
    if (models.length === 0) {
      if (existing !== undefined) ops.push({ op: 'unset', path: ['providers', route] })
      continue
    }
    const entry = entries[api]
    if (entry === undefined || typeof entry.baseURL !== 'string') continue
    const { baseURL } = entry
    const compat = entry.compat ?? {}
    const hasCompat = Object.keys(compat).length > 0
    if (existing === undefined) {
      ops.push({ op: 'set', path: ['providers', route], value: { displayName: nameFor(api), api, baseURL, apiKeyEnv: keyRef, ...hasCompat ? { compat } : {}, models } })
      continue
    }
    if (JSON.stringify(existing.models) !== JSON.stringify(models)) ops.push({ op: 'set', path: ['providers', route, 'models'], value: models })
    if (existing.apiKeyEnv !== keyRef) ops.push({ op: 'set', path: ['providers', route, 'apiKeyEnv'], value: keyRef })
    if (existing.baseURL !== baseURL) ops.push({ op: 'set', path: ['providers', route, 'baseURL'], value: baseURL })
    if (JSON.stringify(existing.compat ?? {}) !== JSON.stringify(compat)) {
      ops.push(hasCompat ? { op: 'set', path: ['providers', route, 'compat'], value: compat } : { op: 'unset', path: ['providers', route, 'compat'] })
    }
  }
  return ops
}

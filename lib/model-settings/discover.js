/**
 * 「获取可用模型」对目录里的提供商也真的请求一次。
 *
 * DSH 的 discoverModels 对目录里有的提供商只回答安装包目录，不发请求；官方留的唯一口子是请求里不带 provider、
 * 自己带上地址、协议和密钥。浏览器端拿不到已存的密钥，所以这一步放在宿主端：
 *
 * - 页面只传 Provider ID。地址、协议、凭据名都由这里从这一家已保存的配置和 DSH 的提供商目录里取，
 *   不接受页面传来的，否则能调这个接口的页面就能让宿主端把某个密钥发到任意地址。
 * - 密钥用 DSH 的凭据服务读，只在这一次调用里用，用完即弃：不返回给页面，不写日志，报错原文里出现就换成「•••」。
 * - 请求仍走 DSH 自己的 discoverModels，不另写请求。
 */

import { deriveKeyRef } from './key-ref.js'
import { companionKeyRef, protocolInfo } from './companion.js'

/** 等待上限，秒，和「检查连接」一样。 */
export const DISCOVER_TIMEOUT_SECONDS = 20

/** 能读模型列表的协议，和 DSH 的 discovery.ts 一致。 */
const LISTABLE = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'])

/**
 * 校验页面发来的请求体：只收 Provider ID。
 * @param {unknown} body 解析后的 JSON。
 * @returns {{ provider: string } | undefined} 合法时返回 Provider ID。
 */
export function discoverRequestOf(body) {
  if (typeof body !== 'object' || body === null) return undefined
  const { provider } = body
  if (typeof provider !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(provider) || provider.startsWith('.')) return undefined
  return { provider }
}

/**
 * 实际请求的地址，只用来告诉用户「列表从哪来」，算法照 DSH discovery.ts 的 listingUrl（去掉分页参数）。
 * @param {string} baseURL API 地址。
 * @param {string} api 协议。
 * @returns {string} 地址。
 */
export function listingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  return `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/models`
}

/**
 * 这一家用哪种协议问。配置写了就用配置的；没写时用安装包目录里这一家模型共同的协议；不统一时，OpenAI 两种协议的列表接口相同，按 OpenAI 问。
 * @param {string | undefined} configured 配置里的 `api`。
 * @param {{ api?: string, shared: boolean, apis?: string[] } | undefined} catalog 目录里的协议。
 * @returns {{ api: string, acceptsUnlisted: boolean } | undefined} 协议，以及能不能往这一家加目录外的模型；问不了时 undefined。
 */
function protocolFor(configured, catalog) {
  if (configured !== undefined) return LISTABLE.has(configured) ? { api: configured, acceptsUnlisted: true } : undefined
  if (catalog === undefined || catalog === null || catalog.missing === true) return undefined
  if (catalog.shared && catalog.api !== undefined) return LISTABLE.has(catalog.api) ? { api: catalog.api, acceptsUnlisted: true } : undefined
  const apis = catalog.apis ?? []
  // 目录里协议不统一、但有 OpenAI 兼容协议的（OpenRouter、Fireworks、OpenCode 等）：按 OpenAI Chat Completions 问，
  // DSH 的 discovery.ts 对它走 `GET {baseURL}/models` 加 Bearer（discovery.ts:126-129、:376-380）。两种 OpenAI 协议的列表接口相同。
  // 目录外的模型 DSH 只能用「目录里共同的协议」，没有共同协议时它会报「needs an api」，整家配置出错（catalog.ts:688-692、:917-922）；
  // 模型配置又不能给单个模型写协议（PiAiModelProfile 只有 id、name、容量、input、reasoningEfforts、compat，catalog.ts:604-620），所以这些行只列出、不能添加。
  if (apis.some(api => api === 'openai-completions' || api === 'openai-responses')) return { api: 'openai-completions', acceptsUnlisted: false }
  return undefined
}

/**
 * 按 DSH 的报错归类。DSH 的原文形如「<url> answered 401; check the API key」「could not reach <url>」。
 * @param {unknown} error 抛出的错误。
 * @param {{ host: string, timedOut: boolean, secret: string }} context 主机名、是否超时、要从原文里去掉的密钥。
 * @returns {object} 失败结果。
 */
function classify(error, { host, timedOut, secret }) {
  const raw = error instanceof Error ? error.message : String(error)
  const message = secret.length > 0 ? raw.split(secret).join('•••') : raw
  const code = typeof error === 'object' && error !== null ? error.code ?? error.failure?.code : undefined
  if (timedOut || code === 'ABORTED') return { ok: false, reason: 'timeout', seconds: DISCOVER_TIMEOUT_SECONDS }
  if (code === 'DISCOVERY_UNSUPPORTED') return { ok: false, reason: 'unsupported' }
  if (code === 'INVALID_CREDENTIAL') return { ok: false, reason: 'badKey' }
  const answered = / answered (\d{3})\b/.exec(message)
  if (answered !== null) {
    const status = Number(answered[1])
    return status === 401 || status === 403 ? { ok: false, reason: 'auth', status } : { ok: false, reason: 'status', status }
  }
  if (/could not reach/i.test(message)) return { ok: false, reason: 'network', host }
  return { ok: false, reason: 'other', message: message.slice(0, 300) }
}

/**
 * 配置里没点名凭据时，能当 API 密钥发出去的凭据名：页面存密钥用的派生名，再加目录里以 `_API_KEY` 结尾的名字。
 * DSH 目录里的 `nativeAuth.env` 是「这条路由的认证会读哪些环境变量」（dsh-llm types.ts:286-289），Anthropic 那一串里有令牌、组织 ID、令牌文件路径，
 * 这些不是 API 密钥，当成 `x-api-key` 发出去既无用又会泄露，所以一概不读。
 * @param {string} provider Provider ID。
 * @param {readonly string[] | undefined} env 目录里的环境变量名。
 * @returns {string[]} 凭据名，按读的顺序。
 */
export function apiKeyRefsOf(provider, env) {
  return [...new Set([deriveKeyRef(provider), ...(env ?? []).filter(ref => /_API_KEY$/.test(ref))])]
}

/**
 * 问一次。
 * @param {object} deps DSH 的服务：describeSettings、listDirectory、resolveCredential（凭据服务不可用时缺省）、discoverModels、catalogApi、now。
 * @param {{ provider: string }} request 合法的请求。
 * @param {{ timedOut?: () => boolean }} [options] 测试用：替换超时判断。
 * @returns {Promise<object>} `{ ok: true, models, url, at, acceptsUnlisted }`，或 `{ ok: false, reason, ... }`。
 */
export async function runDiscover(deps, request, options = {}) {
  const entry = deps.listDirectory().find(candidate => candidate.provider === request.provider && candidate.settingsNs === 'llm-pi-ai')
  // 自定义的提供商本来就向它请求，浏览器端已经能做，这里只管目录里的。
  if (entry === undefined || entry.declared === true) return { ok: false, reason: 'unknownProvider' }
  const namespace = deps.describeSettings().find(view => view.ns === 'llm-pi-ai')
  const stored = namespace?.value?.providers?.[request.provider]
  const profile = typeof stored === 'object' && stored !== null ? stored : {}
  const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
  const configuredApi = text(profile.api)
  const catalog = configuredApi === undefined ? await deps.catalogApi(request.provider) : undefined
  // 读不到安装包的模型目录，和「这一家的协议不提供模型列表」是两回事，分开说。
  if (catalog?.missing === true) return { ok: false, reason: 'noCatalog' }
  const protocol = protocolFor(configuredApi, catalog)
  if (protocol === undefined) return { ok: false, reason: 'unsupported' }
  // 地址：用户在自定义设置里写的优先；目录协议混合时用目录里 OpenAI 兼容模型自己的地址（OpenRouter 的是 /api/v1，另有一组 Anthropic 模型在 /api）；再退回提供商的默认地址。
  const mixedOpenAi = configuredApi === undefined && catalog?.shared === false ? text(catalog.openaiBaseUrl) : undefined
  const baseURL = text(profile.baseURL) ?? mixedOpenAi ?? text(entry.defaultBaseURL)
  if (baseURL === undefined) return { ok: false, reason: 'noBaseUrl' }
  // 配置文件里手写的地址可能不合法：说清楚，不抛异常。
  let host
  try {
    host = new URL(baseURL).hostname
  } catch {
    return { ok: false, reason: 'badBaseUrl' }
  }
  if (deps.resolveCredential === undefined) return { ok: false, reason: 'noCredentials' }
  const named = text(profile.apiKeyEnv)
  const refs = named !== undefined ? [named] : apiKeyRefsOf(request.provider, entry.nativeAuth?.env)
  let apiKey
  for (const ref of refs) {
    let value
    try {
      value = await deps.resolveCredential(ref)
    } catch {
      return { ok: false, reason: 'noCredentials' }
    }
    if (typeof value === 'string' && value.length > 0) {
      apiKey = value
      break
    }
  }
  if (apiKey === undefined) return { ok: false, reason: 'noKey' }
  const signal = AbortSignal.timeout(DISCOVER_TIMEOUT_SECONDS * 1000)
  try {
    const models = await deps.discoverModels('llm-pi-ai', { baseURL, api: protocol.api, apiKey }, signal)
    return { ok: true, models: [...models], url: listingUrl(baseURL, protocol.api), at: deps.now(), acceptsUnlisted: protocol.acceptsUnlisted }
  } catch (error) {
    return classify(error, { host, timedOut: options.timedOut?.() ?? signal.aborted, secret: apiKey })
  } finally {
    // 用完即弃：只在这个函数的局部变量里，不进任何返回值或日志。
    apiKey = undefined
  }
}

/** 默认的依赖：真的去 DSH 的安装里找。测试换成假的。 */
const LOOKUP = {
  llmUrl: () => import.meta.resolve('@deepseek-ai/dsh-llm'),
  findPackageJSON: async (specifier, base) => (await import('node:module')).findPackageJSON?.(specifier, base),
  readFile: async path => (await import('node:fs/promises')).readFile(path, 'utf8'),
}

/**
 * 找到 DSH 安装的 pi-ai 目录模块。插件是 link 进来的，不能直接 import DSH 内部的包（不是插件的 peer，会报 ERR_MODULE_NOT_FOUND）。
 * pi-ai 是 `@deepseek-ai/dsh-llm-pi-ai` 的依赖，所以先从插件能 resolve 的 peer `@deepseek-ai/dsh-llm` 的位置找到 dsh-llm-pi-ai，
 * 再从 dsh-llm-pi-ai 的位置找 pi-ai 的 package.json，按 pi-ai 自己 exports 里 `./providers/*` 的 import 路径拼出文件；不靠它恰好被提升安装。
 * 2026-11-13 在本机 App 0.2.2-rc.2 的 app.asar 里只读地解析过：两步都找得到，落在 dsh/node_modules/@earendil-works/pi-ai（1.3.0）。
 * @param {typeof LOOKUP} [deps] 依赖。
 * @returns {Promise<string | undefined>} 模块的 file URL；任何一步找不到时 undefined。
 */
export async function piAiCatalogUrl(deps = LOOKUP) {
  try {
    const { pathToFileURL } = await import('node:url')
    const adapterPackage = await deps.findPackageJSON('@deepseek-ai/dsh-llm-pi-ai', deps.llmUrl())
    if (typeof adapterPackage !== 'string') return undefined
    const catalogPackage = await deps.findPackageJSON('@earendil-works/pi-ai', pathToFileURL(adapterPackage).href)
    if (typeof catalogPackage !== 'string') return undefined
    const manifest = JSON.parse(await deps.readFile(catalogPackage))
    const pattern = manifest.exports?.['./providers/*']
    const target = typeof pattern === 'string' ? pattern : pattern?.import ?? pattern?.default
    if (typeof target !== 'string') return undefined
    return new URL(target.replace('*', 'all'), pathToFileURL(catalogPackage)).href
  } catch {
    return undefined
  }
}

/**
 * 读 DSH 安装的 pi-ai 目录里这一家模型的协议。目录是 DSH 自带的包，这里只读，不发请求。
 * @param {string} provider Provider ID。
 * @param {{ locate: () => Promise<string | undefined>, load: (url: string) => Promise<object> }} [deps] 依赖：找目录模块、载入它。
 * @returns {Promise<{ api?: string, shared: boolean, apis: string[] } | { missing: true } | undefined>} 协议；目录读不到时 `{ missing: true }`；这一家不在目录里时 undefined。
 */
export async function catalogApiOf(provider, deps = { locate: () => piAiCatalogUrl(), load: url => import(url) }) {
  const models = await catalogModelsOf(provider, deps)
  if (!Array.isArray(models)) return models
  const apis = [...new Set((models ?? []).map(model => model.api).filter(api => typeof api === 'string'))]
  if (apis.length === 0) return undefined
  if (apis.length === 1) return { api: apis[0], shared: true, apis }
  // 协议混合时，OpenAI 兼容的那些模型都在同一个地址上才带出这个地址，用来问列表。
  const openaiUrls = [...new Set((models ?? []).filter(model => model.api === 'openai-completions' || model.api === 'openai-responses').map(model => model.baseUrl).filter(url => typeof url === 'string' && url.length > 0))]
  return { shared: false, apis, ...openaiUrls.length === 1 ? { openaiBaseUrl: openaiUrls[0] } : {} }
}

/**
 * 读安装包目录里这一家的模型：ID、协议、地址、兼容开关、有没有专用请求头。只读 DSH 自带的包，不发请求。
 * @param {string} provider Provider ID。
 * @param {{ locate: () => Promise<string | undefined>, load: (url: string) => Promise<object> }} [deps] 依赖。
 * @returns {Promise<{ id?: string, api: string, baseUrl?: string, compat?: object, headers?: object }[] | { missing: true }>} 模型；目录读不到时 `{ missing: true }`。
 */
export async function catalogModelsOf(provider, deps = { locate: () => piAiCatalogUrl(), load: url => import(url) }) {
  try {
    const url = await deps.locate()
    if (url === undefined) return { missing: true }
    const catalog = await deps.load(url)
    if (typeof catalog.getBuiltinModels !== 'function') return { missing: true }
    const record = value => typeof value === 'object' && value !== null && !Array.isArray(value)
    return (catalog.getBuiltinModels(provider) ?? []).flatMap(model => (typeof model?.api === 'string'
      ? [{
          ...typeof model.id === 'string' ? { id: model.id } : {}, api: model.api, ...typeof model.baseUrl === 'string' ? { baseUrl: model.baseUrl } : {},
          ...record(model.compat) ? { compat: model.compat } : {},
          // 请求头只看有没有，值不带出宿主端。
          ...record(model.headers) && Object.keys(model.headers).length > 0 ? { headers: Object.fromEntries(Object.keys(model.headers).map(key => [key, ''])) } : {},
        }] : []))
  } catch {
    return { missing: true }
  }
}

/**
 * 「目录协议」：协议混合的提供商加目录外模型时要知道的事。读安装包目录，不向提供商发请求。
 * @param {{ describeSettings: () => object[], listDirectory: () => object[], catalogModels: (provider: string) => Promise<object> }} deps DSH 的服务。
 * @param {{ provider: string }} request 合法的请求（只收 Provider ID）。
 * @returns {Promise<object>} `{ ok: true, mixed, keyRef, protocols, unusable, models }`：是否协议混合、伴随条目用的凭据名、能用的协议（目录地址和兼容开关）、
 *   不能用的协议和原因、目录里每个模型的协议；或 `{ ok: false, reason }`。
 */
export async function runCatalogProtocols(deps, request) {
  const entry = deps.listDirectory().find(candidate => candidate.provider === request.provider && candidate.settingsNs === 'llm-pi-ai')
  if (entry === undefined || entry.declared === true) return { ok: false, reason: 'unknownProvider' }
  const stored = deps.describeSettings().find(view => view.ns === 'llm-pi-ai')?.value?.providers?.[request.provider]
  const profile = typeof stored === 'object' && stored !== null ? stored : {}
  const models = await deps.catalogModels(request.provider)
  if (!Array.isArray(models)) return { ok: false, reason: 'noCatalog' }
  const mixed = new Set(models.map(model => model.api)).size > 1
  // 地址给目录本身的；原提供商在自定义设置里写的地址由页面套上（它可能这次刚改）。
  const { usable, unusable } = protocolInfo(models)
  return { ok: true, mixed, keyRef: companionKeyRef(request.provider, profile, entry.nativeAuth?.env), protocols: usable, unusable, models: models.filter(model => typeof model.id === 'string').map(model => ({ id: model.id, api: model.api })) }
}

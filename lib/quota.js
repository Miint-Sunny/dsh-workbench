/**
 * dsh-workbench/quota 行的宿主端：余额与额度（第五批第 4 项的第一步，只做宿主端，页面
 * 以后由 Claude 做）。提供 GET /api/dsh-workbench.quota.overview（可选 ?refresh=1），
 * 按适配器（lib/quota-adapters.js，第一批三家）向各家自己的地址查一次，答余额或套餐窗口；
 * 没配密钥的提供方不列出。只在收到请求时查，不设定时器、不监听事件；结果按 cacheSeconds
 * 缓存（refresh=1 绕过），同一家的并发请求只发一次，查询失败答上次成功的值（stale）。
 * DeepSeek 的 CNY 余额下降累计成 spend（上升算充值），上次成功的值和 spend 存
 * `$DSH_HOME/dsh-workbench/quota-state.json`（原子写、权限 0600、不含密钥，损坏从头开始）。
 * 密钥只在宿主进程用（经官方 credentials 服务解析，写法改写自 @linxin666/dsh-usage
 * 0.4.15 的 src/host/usage-service.ts，Apache-2.0，声明见 README「第三方来源」），不进响应、
 * 不进日志、不进状态文件；出站请求 redirect: 'error'。state 只用代码（ok、auth-failed、
 * rate-limited、unreachable、unexpected），界面文字由页面写。
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { registerFeature } from './features.js'
import { workbenchDataDir } from './data-dir.js'
import { readQuotaConfig } from './quota-config.js'
import { QUOTA_ADAPTERS } from './quota-adapters.js'

export const name = '@miint-sunny/dsh-workbench/quota'

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const error = (code, status) => json({ error: { code } }, status)

/**
 * 尽力读一个服务的引用：服务不在（或取的时候抛错）答 undefined，不拦着调用方。
 * @param {object} ctx 带有 get 的上下文。
 * @param {string} name 服务名。
 * @returns {object | undefined} 服务实例。
 */
const serviceOf = (ctx, name) => {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Cordis 的观测值（带 get 方法）层层解包成普通对象，设置快照才能安全读。 */
function unwrapVolatiles(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') return unwrapVolatiles(value.get())
  if (Array.isArray(value)) return value.map(unwrapVolatiles)
  const result = {}
  for (const [key, entry] of Object.entries(value)) result[key] = unwrapVolatiles(entry)
  return result
}

/** 设置命名空间的别名：llm-pi-ai 曾叫 llm，llm-deepseek 的密钥段曾是单独的插件。 */
const namespaceAliases = ns => ns === 'llm-pi-ai' ? ['llm'] : ns === 'llm-deepseek' ? ['llm-deepseek-api-key'] : []

/** settings.describe / loader / configEditor 里的一条，是不是要读的那个命名空间。 */
function matchesNamespace(id, name, ns) {
  if (id === ns) return true
  if (typeof name === 'string' && (name === `@deepseek-ai/dsh-${ns}` || name.endsWith(`/${ns}`))) return true
  return namespaceAliases(ns).includes(id) || (typeof name === 'string' && namespaceAliases(ns).some(alias => name === `@deepseek-ai/dsh-${alias}`))
}

/**
 * 读另一个插件的配置段（llm-pi-ai 的 providers、llm-deepseek 的 apiKeyEnv）：依次试
 * settings 服务（get、describe）、loader 的 entry 配置、configEditor，都读不到答
 * undefined，凭据解析退回派生的默认引用名。写法改写自 dsh-usage 的 readNamespace。
 * @param {object} ctx 插件作用域（用到 get、root.loader）。
 * @param {string} ns 命名空间（如 'llm-pi-ai'）。
 * @returns {object | undefined} 配置段。
 */
export function readEntryConfig(ctx, ns) {
  try {
    const settings = serviceOf(ctx, 'settings')
    if (settings !== undefined) {
      if (typeof settings.get === 'function') {
        const value = settings.get(ns)
        if (value !== undefined) return unwrapVolatiles(value)
      }
      if (typeof settings.describe === 'function') {
        const rows = settings.describe({ redactSecrets: true })
        if (Array.isArray(rows)) {
          const hit = rows.find(row => matchesNamespace(row.ns, undefined, ns))
          if (hit !== undefined && hit.value !== undefined) return unwrapVolatiles(hit.value)
        }
      }
    }
  } catch {
    // settings 不在或读不了：试下一层
  }
  try {
    const loader = ctx.root?.loader ?? ctx.loader
    if (loader !== undefined && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        const options = entry.options ?? {}
        if (matchesNamespace(options.id, options.name, ns) && entry.fiber?.config !== undefined) {
          return unwrapVolatiles(entry.fiber.config)
        }
      }
    }
  } catch {
    // loader 不在：试下一层
  }
  try {
    const editor = serviceOf(ctx, 'configEditor')
    if (editor !== undefined && typeof editor.configuration === 'function') {
      const row = editor.configuration().find(item => matchesNamespace(item.entry.options.id, item.entry.options.name, ns))
      if (row !== undefined) {
        if (row.entry.fiber?.config !== undefined) return unwrapVolatiles(row.entry.fiber.config)
        return unwrapVolatiles({ ...row.inherited, ...row.override })
      }
    }
  } catch {
    // configEditor 不在：答没有
  }
  return undefined
}

/** 派生的默认凭据引用名（照 dsh-model-settings 的规则：opencode-go → OPENCODE_GO_API_KEY）。 */
const derivedRef = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

/**
 * 解析一家提供方的密钥：llm-pi-ai 的 api-key 记录优先，其次 profile 配置的 apiKeyEnv
 * 引用（没配用派生名），deepseek-official 另有 llm-deepseek 的兜底（默认
 * DEEPSEEK_API_KEY）。都解析不到答 undefined（这家不列出）。
 * @param {object} credentials credentials 服务。
 * @param {string} provider LLM 路由 id。
 * @param {(ns: string) => object | undefined} readConfig 配置段读取（readEntryConfig 包好的）。
 * @returns {Promise<string | undefined>} 密钥。
 */
export async function resolveQuotaCredential(credentials, provider, readConfig) {
  if (credentials === undefined) return undefined
  try {
    const record = await credentials.readRecord(`llm-pi-ai/${provider}`)
    if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') return record.key
  } catch {
    // 记录读不了按没有处理
  }
  const refs = []
  const profile = readConfig('llm-pi-ai')?.providers?.[provider]
  if (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') refs.push(profile.apiKeyEnv)
  else refs.push(derivedRef(provider))
  if (provider === 'deepseek-official') {
    const section = readConfig('llm-deepseek')
    refs.push(typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv !== '' ? section.apiKeyEnv : 'DEEPSEEK_API_KEY')
  }
  for (const ref of refs) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved?.value !== undefined && resolved.value !== '') return resolved.value
    } catch {
      // 坏引用按没有处理
    }
  }
  return undefined
}

/** HTTP 状态码到 state 代码。 */
const stateOf = status => (status === 401 || status === 403 ? 'auth-failed' : status === 429 ? 'rate-limited' : 'unexpected')

/** 状态文件里的 facts 是自己写的，但文件可能被改过（durable 边界），读回来要核形状。 */
function validFacts(value) {
  if (typeof value !== 'object' || value === null) return false
  if (value.balances !== undefined) {
    if (!Array.isArray(value.balances)) return false
    for (const entry of value.balances) {
      if (typeof entry?.currency !== 'string' || typeof entry.total !== 'string') return false
    }
  }
  if (value.plan !== undefined && typeof value.plan !== 'string') return false
  if (value.windows !== undefined) {
    if (!Array.isArray(value.windows)) return false
    for (const entry of value.windows) {
      if (typeof entry?.key !== 'string') return false
      if (entry.percent !== undefined && !Number.isFinite(entry.percent)) return false
      if (entry.resetsAt !== undefined && typeof entry.resetsAt !== 'string') return false
    }
  }
  return value.balances !== undefined || value.windows !== undefined
}

/** 状态文件里 spend 的形状。 */
function validSpend(value) {
  return typeof value === 'object' && value !== null && Number.isFinite(value.cny) && value.cny >= 0
    && Number.isFinite(value.since) && (value.lastCny === undefined || Number.isFinite(value.lastCny))
}

/**
 * 建余额与额度的查询服务。不 import @deepseek-ai 包，凭据解析和出网都靠注入，测试给假的。
 * @param {object} options 注入项。
 * @param {object[]} [options.adapters] 适配器列表（默认第一批三家）。
 * @param {Function} [options.fetcher] 出网函数 `(url, init) => Promise<Response>`。
 * @param {Function} options.resolveKey 凭据解析 `(adapter) => Promise<string | undefined>`。
 * @param {() => object} options.getConfig 已校验配置（timeoutSeconds、cacheSeconds）。
 * @param {string} options.dir 数据目录（quota-state.json 放这里）。
 * @param {() => number} [options.now] 时间戳，测试注入固定的。
 * @param {{warn?: Function}} [options.logger] 日志。
 * @returns {{overview: (options?: {refresh?: boolean}) => Promise<object>}} 查询服务。
 */
export function createQuotaService(options) {
  const { adapters = QUOTA_ADAPTERS, resolveKey, getConfig, dir, now = Date.now, logger = console } = options
  const fetcher = options.fetcher ?? ((url, init) => globalThis.fetch(url, init))
  const stateFile = join(dir, 'quota-state.json')
  /** 上次成功的值：id → { facts, queriedAt }。 */
  const facts = new Map()
  /** 同一家正在进行的查询，并发只发一次。 */
  const inflight = new Map()
  let spend
  let loadPromise
  let dirty = false
  let tempCounter = 0

  const load = () => {
    if (loadPromise === undefined) {
      loadPromise = (async () => {
        try {
          const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
          if (typeof parsed === 'object' && parsed !== null && parsed.version === 1) {
            if (typeof parsed.providers === 'object' && parsed.providers !== null) {
              for (const [id, entry] of Object.entries(parsed.providers)) {
                if (typeof entry === 'object' && entry !== null && validFacts(entry.facts) && Number.isFinite(entry.queriedAt)) {
                  facts.set(id, { facts: entry.facts, queriedAt: entry.queriedAt })
                }
              }
            }
            if (validSpend(parsed.spend)) spend = { cny: parsed.spend.cny, since: parsed.spend.since, ...('lastCny' in parsed.spend ? { lastCny: parsed.spend.lastCny } : {}) }
          }
        } catch {
          // 文件还没有或损坏：从头开始
        }
      })()
    }
    return loadPromise
  }

  const viewOf = (adapter, value, queriedAt, stale, state) => ({
    id: adapter.id,
    name: adapter.name,
    state,
    ...(value.balances !== undefined ? { balances: value.balances.map(entry => ({ ...entry })) } : {}),
    ...(value.plan !== undefined ? { plan: value.plan } : {}),
    ...(value.windows !== undefined ? { windows: value.windows.map(entry => ({ ...entry })) } : {}),
    queriedAt,
    stale,
  })

  /** 查询失败：有上次成功的值就答它（stale），state 是这次失败的原因。 */
  const failed = (adapter, state) => {
    const cached = facts.get(adapter.id)
    if (cached === undefined) return { id: adapter.id, name: adapter.name, state, queriedAt: now(), stale: false }
    return viewOf(adapter, cached.facts, cached.queriedAt, true, state)
  }

  /** CNY 读数的下降累计成 spend（上升算充值）；USD 和别的币种不计。 */
  const accrue = parsed => {
    const cny = Array.isArray(parsed.balances)
      ? parsed.balances.find(entry => typeof entry.currency === 'string' && entry.currency.toUpperCase() === 'CNY')
      : undefined
    if (cny === undefined) return
    const value = Number(cny.total)
    if (!Number.isFinite(value)) return
    const watch = spend ?? { cny: 0, since: now(), lastCny: undefined }
    if (watch.lastCny !== undefined && value < watch.lastCny) watch.cny += watch.lastCny - value
    watch.lastCny = value
    spend = watch
    dirty = true
  }

  const probe = async (adapter, key, config) => {
    try {
      const response = await fetcher(adapter.url, {
        headers: { ...adapter.headers(key), 'accept-encoding': 'identity' },
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok) return failed(adapter, stateOf(response.status))
      const parsed = adapter.parse(response.status, body)
      if (parsed === undefined) return failed(adapter, 'unexpected')
      const queriedAt = now()
      facts.set(adapter.id, { facts: parsed, queriedAt })
      dirty = true
      if (adapter.kind === 'balance') accrue(parsed)
      return viewOf(adapter, parsed, queriedAt, false, 'ok')
    } catch {
      // 网络错误、超时、被拒绝的重定向
      return failed(adapter, 'unreachable')
    }
  }

  /** 缓存有效直接答；同一家的并发查询共用一次出网。 */
  const ensure = (adapter, key, refresh, config) => {
    const cached = facts.get(adapter.id)
    if (!refresh && cached !== undefined && now() - cached.queriedAt < config.cacheSeconds * 1000) {
      return Promise.resolve(viewOf(adapter, cached.facts, cached.queriedAt, false, 'ok'))
    }
    const running = inflight.get(adapter.id)
    if (running !== undefined) return running
    const once = probe(adapter, key, config)
    inflight.set(adapter.id, once)
    const clear = () => { if (inflight.get(adapter.id) === once) inflight.delete(adapter.id) }
    once.then(clear, clear)
    return once
  }

  const persist = async () => {
    const document = { version: 1, providers: Object.fromEntries([...facts].map(([id, entry]) => [id, { facts: entry.facts, queriedAt: entry.queriedAt }])), ...(spend !== undefined ? { spend } : {}) }
    const temp = `${stateFile}.${process.pid}-${tempCounter++}.tmp`
    await mkdir(dir, { recursive: true })
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 1)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, stateFile)
  }

  const persistIfDirty = async () => {
    if (!dirty) return
    dirty = false
    try {
      await persist()
    } catch (error_) {
      logger.warn?.(`dsh-workbench/quota: 状态没存上：${String(error_?.stack ?? error_)}`)
    }
  }

  return {
    /**
     * 查一次全部配了密钥的提供方。
     * @param {{refresh?: boolean}} [query] refresh 绕过缓存。
     * @returns {Promise<{queriedAt: number, providers: object[], spend: object | null}>} 总览。
     */
    async overview({ refresh = false } = {}) {
      const config = getConfig()
      await load()
      const keyed = []
      for (const adapter of adapters) {
        let key
        try {
          key = await resolveKey(adapter)
        } catch {
          // 密钥解析失败按没有处理：这家不列出
        }
        keyed.push([adapter, key])
      }
      const providers = await Promise.all(keyed.map(([adapter, key]) =>
        key === undefined || key === '' ? Promise.resolve(undefined) : ensure(adapter, key, refresh, config)))
      await persistIfDirty()
      return { queriedAt: now(), providers: providers.filter(entry => entry !== undefined), spend: spend === undefined ? null : { ...spend } }
    },
  }
}

/**
 * 注册 overview 路由（`/api` 通道，进来前已过 Host、Origin、登录 cookie，只放本人）。
 * @param {object} scope 带有 connection 服务的插件作用域。
 * @param {{service: object}} parts 查询服务。
 * @returns {() => void} 注销函数。
 */
export function applyQuotaRoutes(scope, { service }) {
  return scope.connection.fetch.register({
    path: '/api/dsh-workbench.quota.overview',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const params = new URL(request.url).searchParams
        let refresh = false
        const seen = new Set()
        for (const key of params.keys()) {
          if (key !== 'refresh' || seen.has(key) || params.get(key) !== '1') return error('invalid-query', 400)
          seen.add(key)
          refresh = true
        }
        return json(await service.overview(refresh ? { refresh: true } : {}))
      } catch {
        return error('quota-failed', 500)
      }
    },
  })
}

/**
 * 注册 quota 行。配置（quota.json）在启动时读一次，配置错了这行起不来。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} [options] 可选的数据目录覆盖（测试用）。
 */
export function apply(ctx, options = {}) {
  const dir = options.dir ?? workbenchDataDir(process.env)
  readQuotaConfig(dir)
  ctx.effect(() => registerFeature('quota'), '@miint-sunny/dsh-workbench/quota: feature registration')
  ctx.inject(['connection', 'credentials'], scope => {
    const service = createQuotaService({
      dir,
      resolveKey: adapter => resolveQuotaCredential(scope.credentials, adapter.id, ns => readEntryConfig(scope, ns)),
      getConfig: () => readQuotaConfig(dir),
      logger: scope.logger,
    })
    scope.effect(() => applyQuotaRoutes(scope, { service }), '@miint-sunny/dsh-workbench/quota: overview route')
  })
}

/** 页面数据：提供商目录、设置命名空间、凭据状态和模型目录拼成一份快照，再加上这次打开设置后的检查结果。读取顺序照 DSH 内置模型页（MIT，见 NOTICE 和 README「第三方来源」）。 */

/**
 * 建一份页面数据。所有读写都走 DSH 自己的接口，插件不另存任何东西。
 * @param {object} ctx 客户端上下文（需要 remote、configForms、settingsSchema）。
 * @returns {object} 快照、订阅、刷新和写入操作。
 */
function createModelsStore(ctx) {
  const schema = ctx.settingsSchema
  const describe = ctx.configForms.describe()
  let state = { status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(), catalog: undefined, checks: new Map() }
  const listeners = new Set()
  const publish = (patch) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  let generation = 0
  let pending = []

  const fail = message => publish({ status: 'error', error: message })
  const settle = (current, finish) => {
    if (current !== generation) return
    const waiting = pending
    pending = []
    for (const load of waiting) finish(load)
  }

  async function read(current) {
    if (state.status !== 'ready') publish({ status: 'loading', error: null })
    const [registered, declared] = await Promise.all([ctx.remote.llm.listProviders(), ctx.remote.llm.listConfigurableProviders(), describe.ensure()])
    if (current !== generation) return
    if (!registered.ok) return fail(registered.error.message)
    if (!declared.ok) return fail(declared.error.message)
    const mirrored = describe.getSnapshot()
    if (mirrored.view === undefined) return fail(mirrored.error ?? 'settings unavailable')
    const namespaces = new Map(mirrored.view.namespaces.map(view => [view.ns, view]))
    let rows = joinDirectory(registered.value, declared.value).map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const profile = namespace === undefined ? undefined : schema.getPath(namespace.value, entry.settingsPath)
      const ref = entry.provider === 'deepseek-account' || typeof profile !== 'object' || profile === null ? undefined : profile.apiKeyEnv
      const baseURL = typeof profile === 'object' && profile !== null && typeof profile.baseURL === 'string' ? profile.baseURL : undefined
      const api = typeof profile === 'object' && profile !== null && typeof profile.api === 'string' ? profile.api : undefined
      return {
        // 手工声明的路由没有目录给的默认地址，卡片的域名从它自己的 API 地址来。
        entry: baseURL === undefined || entry.defaultBaseURL !== undefined ? entry : { ...entry, defaultBaseURL: baseURL },
        configured: namespace !== undefined && (entry.settingsPath.length === 0 || profile !== undefined),
        removable: namespace !== undefined && entry.settingsPath.length > 0
          && schema.hasPath(namespace.user, entry.settingsPath) && !schema.hasPath(namespace.base, entry.settingsPath),
        apiKeyEnv: typeof ref === 'string' && ref.length > 0 ? ref : undefined,
        // 协议：Gemini API 没有密钥不能用，列表状态要按它判断。
        ...api === undefined ? {} : { api },
      }
    })
    // 协议混合的提供商的伴随条目：列表上并进原提供商，凭据名的判断视同原提供商。
    const piAi = namespaces.get('llm-pi-ai')
    rows = markCompanions(rows, route => (piAi === undefined ? undefined : schema.getPath(piAi.value, ['providers', route])))
    const catalogAnswer = await ctx.remote.session.modelCatalog()
    if (current !== generation) return
    const catalog = catalogAnswer.ok ? catalogAnswer.value : undefined
    const accountAvailable = catalog !== undefined && catalog.groups.some(group => group.id === 'deepseek-account' && group.models.length > 0)
    rows = rows.map(row => row.entry.provider === 'deepseek-account' ? { ...row, accountAvailable } : row)
    const refs = [...new Set(rows.filter(row => row.entry.provider !== 'deepseek-account').flatMap(row =>
      row.apiKeyEnv === undefined ? [deriveKeyRef(row.entry.provider), ...row.entry.nativeAuth?.env ?? []] : [row.apiKeyEnv]))]
    const credentials = {}
    let credentialError = null
    for (let index = 0; index < refs.length; index += 64) {
      const response = await ctx.remote.credentials.describe(refs.slice(index, index + 64))
      if (response.ok) Object.assign(credentials, response.value)
      else { credentialError = response.error.message; break }
    }
    if (current !== generation) return
    rows = rows.filter(row => row.entry.provider !== 'deepseek-account' || row.accountAvailable === true).map((row) => {
      if (row.entry.provider === 'deepseek-account') return row
      const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
      const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
      const checked = row.apiKeyEnv === undefined ? row.entry.nativeAuth?.env ?? [] : [row.apiKeyEnv]
      return {
        ...row,
        ...named === undefined ? {} : { credential: named },
        ...derived === undefined ? {} : { derivedCredential: derived },
        ...credentialError === null ? { credentialChecks: Object.fromEntries(checked.flatMap(ref => credentials[ref] === undefined ? [] : [[ref, credentials[ref]]])) } : {},
      }
    })
    publish({ status: 'ready', error: null, credentialError, writable: mirrored.view.writable, rows, namespaces, catalog })
  }

  /** 刷新一次；同时在等的调用都在最新一次读完后结束。 */
  function load() {
    const current = ++generation
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject })
      read(current).then(() => settle(current, load => load.resolve()), error => {
        if (current === generation) fail(error instanceof Error ? error.message : String(error))
        settle(current, load => load.resolve())
      })
    })
  }

  const message = error => error instanceof Error ? error.message : String(error)
  /** 调插件宿主端的接口；回答不是 JSON 时按「其他」报。 */
  const post = async (name, body) => {
    try {
      const response = await fetch(`api/dsh-workbench.model-settings.${name}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const answer = await response.json()
      return typeof answer === 'object' && answer !== null ? answer : { ok: false, reason: 'other', message: `HTTP ${response.status}` }
    } catch (error) { return { ok: false, reason: 'other', message: message(error) } }
  }
  const operations = {
    async describeCredentials(refs) {
      if (refs.length === 0) return { ok: true, value: {} }
      try {
        const response = await ctx.remote.credentials.describe(refs)
        return response.ok ? { ok: true, value: response.value } : { ok: false, message: response.error.message }
      } catch (error) { return { ok: false, message: message(error) } }
    },
    async storeCredential(ref, value) {
      try {
        const response = await ctx.remote.credentials.set(ref, value)
        return response.ok ? undefined : response.error.message
      } catch (error) { return message(error) }
    },
    async removeCredential(ref) {
      try {
        const response = await ctx.remote.credentials.unset(ref)
        return response.ok ? undefined : response.error.message
      } catch (error) { return message(error) }
    },
    async writeSettings(ns, ops, revision) {
      try {
        const response = await ctx.remote.settings.mutate(ns, ops, revision)
        if (response.ok) return { kind: 'written', view: response.value }
        return response.error.code === 'settings/conflict'
          ? { kind: 'conflict', message: response.error.message }
          : { kind: 'refused', message: response.error.message }
      } catch (error) { return { kind: 'refused', message: message(error) } }
    },
    async discoverModels(ns, request) {
      try {
        const response = await ctx.remote.llm.discoverModels(ns, request)
        return response.ok ? { kind: 'found', models: response.value } : { kind: 'refused', message: response.error.message }
      } catch (error) { return { kind: 'refused', message: message(error) } }
    },
    check: (provider, model) => post('check', { provider, model }),
    /** 目录里的提供商向提供商请求一次模型列表。只传 Provider ID：地址、协议和密钥都由宿主端从已保存的配置和凭据里取，密钥不到浏览器。 */
    discoverLive: provider => post('discover', { provider }),
    /** 设为默认模型：宿主端调用 DSH 自己的 agentDefaultModel.saveSelection。 */
    setDefaultModel: (provider, model) => post('default-model', { provider, model }),
    /** 协议混合的提供商加目录外模型要的目录信息：宿主端只读安装包目录，不读密钥、不发请求。 */
    catalogProtocols: provider => post('catalog-protocols', { provider }),
  }

  return {
    schema,
    operations,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load,
    /** 这次打开设置后再刷新时才读；还没打开过的页面不因为后台变动去读。 */
    refreshIfLoaded() {
      if (state.status !== 'idle') void load()
    },
    setCheck(provider, result) {
      const checks = new Map(state.checks)
      if (result === undefined) checks.delete(provider)
      else checks.set(provider, { ...result, at: Date.now() })
      publish({ checks })
    },
  }
}

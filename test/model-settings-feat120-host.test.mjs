/** 模型设置 feat#120 的宿主端（从 dsh-model-settings 的 test/feat120-host.test.mjs 搬来，feat#217）：「获取可用模型」对目录里的提供商真的请求一次、「设为默认模型」。DSH 的服务全是假的，密钥是编的。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverRequestOf, runDiscover } from '../lib/model-settings/discover.js'
import { defaultModelRequestOf, setDefaultModel } from '../lib/model-settings/default-model.js'

const KEY = 'fixture-api-key'

/** 假的 DSH：一个 pi-ai 命名空间、提供商目录、凭据服务、discoverModels 和 pi-ai 目录。 */
/** 和 DSH 0.2.2-rc.2 的真实目录一致（dsh-llm-pi-ai/src/provider-data.generated.ts）：env 是「认证会读哪些环境变量」，不全是 API 密钥。 */
const NATIVE_ENV = {
  google: ['GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID'],
}

function fakeDeps({ provider = 'google', profile = {}, entry = {}, credentials = { GOOGLE_API_KEY: KEY }, answer, catalogApi = { api: 'google-generative-ai', shared: true }, noCredentials = false } = {}) {
  const calls = []
  return {
    calls,
    deps: {
      describeSettings: () => [{ ns: 'llm-pi-ai', value: { providers: { [provider]: profile } } }],
      listDirectory: () => [{ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta', nativeAuth: { env: NATIVE_ENV[provider], oauth: false }, ...entry }],
      ...noCredentials ? {} : { resolveCredential: async (ref) => { calls.push(['resolve', ref]); return credentials[ref] } },
      async discoverModels(ns, request, signal) {
        calls.push(['discover', ns, { ...request, apiKey: request.apiKey === undefined ? undefined : '(key)' }, signal instanceof AbortSignal])
        if (answer instanceof Error) throw answer
        return answer ?? [{ id: 'gemini-x', name: 'Gemini X', contextWindow: 100 }]
      },
      catalogApi: async () => catalogApi,
      now: () => Date.UTC(2026, 10, 13, 6, 40),
    },
  }
}

test('请求体只收 Provider ID：地址、协议、凭据名一概不收', () => {
  assert.deepEqual(discoverRequestOf({ provider: 'google', baseURL: 'https://evil.example', apiKeyEnv: 'OTHER' }), { provider: 'google' })
  assert.equal(discoverRequestOf({ provider: '../etc' }), undefined)
  assert.equal(discoverRequestOf(null), undefined)
})

test('目录里的提供商：用已存的密钥、目录的地址和协议，不带 provider 调一次 discoverModels', async () => {
  const { deps, calls } = fakeDeps()
  const result = await runDiscover(deps, { provider: 'google' })
  assert.deepEqual(result, { ok: true, models: [{ id: 'gemini-x', name: 'Gemini X', contextWindow: 100 }], url: 'https://generativelanguage.googleapis.com/v1beta/models', at: Date.UTC(2026, 10, 13, 6, 40), acceptsUnlisted: true })
  // 先读页面存密钥用的派生名，再读目录里以 _API_KEY 结尾的名字；读到就停。
  assert.deepEqual(calls, [
    ['resolve', 'GOOGLE_API_KEY'],
    ['discover', 'llm-pi-ai', { baseURL: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', apiKey: '(key)' }, true],
  ])
  assert.equal(JSON.stringify(result).includes(KEY), false)
})

test('配置里写了地址、协议和凭据名就用配置的', async () => {
  const { deps, calls } = fakeDeps({ profile: { baseURL: 'http://127.0.0.1:3493/v1beta', api: 'openai-completions', apiKeyEnv: 'MY_KEY' }, credentials: { MY_KEY: KEY } })
  const result = await runDiscover(deps, { provider: 'google' })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'http://127.0.0.1:3493/v1beta/models')
  assert.deepEqual(calls.map(c => c[0] === 'discover' ? c[2] : c), [['resolve', 'MY_KEY'], { baseURL: 'http://127.0.0.1:3493/v1beta', api: 'openai-completions', apiKey: '(key)' }])
})

test('没有密钥、凭据服务不可用、不认识的提供商、自定义的提供商：不发请求，说明原因', async () => {
  const none = fakeDeps({ credentials: {} })
  assert.deepEqual(await runDiscover(none.deps, { provider: 'google' }), { ok: false, reason: 'noKey' })
  assert.equal(none.calls.some(c => c[0] === 'discover'), false)
  assert.deepEqual(await runDiscover(fakeDeps({ noCredentials: true }).deps, { provider: 'google' }), { ok: false, reason: 'noCredentials' })
  assert.deepEqual(await runDiscover(fakeDeps().deps, { provider: 'nope' }), { ok: false, reason: 'unknownProvider' })
  assert.deepEqual(await runDiscover(fakeDeps({ entry: { declared: true } }).deps, { provider: 'google' }), { ok: false, reason: 'unknownProvider' })
  assert.deepEqual(await runDiscover(fakeDeps({ entry: { defaultBaseURL: undefined } }).deps, { provider: 'google' }), { ok: false, reason: 'noBaseUrl' })
})

test('没点名凭据时只读 API 密钥类的名字：Anthropic 的令牌、组织 ID、令牌文件一概不读、不发', async () => {
  for (const [name, value] of [['ANTHROPIC_AUTH_TOKEN', 'token-x'], ['ANTHROPIC_ORGANIZATION_ID', 'org-123'], ['ANTHROPIC_IDENTITY_TOKEN_FILE', '/tmp/token']]) {
    const { deps, calls } = fakeDeps({ provider: 'anthropic', credentials: { [name]: value }, catalogApi: { api: 'anthropic-messages', shared: true } })
    assert.deepEqual(await runDiscover(deps, { provider: 'anthropic' }), { ok: false, reason: 'noKey' }, name)
    assert.deepEqual(calls.filter(call => call[0] === 'resolve').map(call => call[1]), ['ANTHROPIC_API_KEY'], name)
    assert.equal(calls.some(call => call[0] === 'discover'), false, name)
  }
  const { deps, calls } = fakeDeps({ provider: 'anthropic', credentials: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: 'token-x' }, catalogApi: { api: 'anthropic-messages', shared: true } })
  assert.equal((await runDiscover(deps, { provider: 'anthropic' })).ok, true)
  assert.deepEqual(calls.at(-1)[2], { baseURL: 'https://generativelanguage.googleapis.com/v1beta', api: 'anthropic-messages', apiKey: '(key)' })
})

test('协议：目录不统一时 OpenAI 两种按 OpenAI 问，但不收目录外的模型；别的不统一或读不到目录就不问', async () => {
  const mixed = await runDiscover(fakeDeps({ catalogApi: { api: undefined, shared: false, apis: ['openai-responses', 'openai-completions'] } }).deps, { provider: 'google' })
  assert.equal(mixed.ok, true)
  assert.equal(mixed.acceptsUnlisted, false)
  assert.deepEqual(await runDiscover(fakeDeps({ catalogApi: { api: undefined, shared: false, apis: ['anthropic-messages', 'google-generative-ai'] } }).deps, { provider: 'google' }), { ok: false, reason: 'unsupported' })
  assert.deepEqual(await runDiscover(fakeDeps({ catalogApi: null }).deps, { provider: 'google' }), { ok: false, reason: 'unsupported' })
  assert.deepEqual(await runDiscover(fakeDeps({ catalogApi: { api: 'bedrock-converse-stream', shared: true } }).deps, { provider: 'google' }), { ok: false, reason: 'unsupported' })
})

test('OpenRouter（pi-ai 1.3.0 的真实组合：Anthropic Messages 15 个在 /api，OpenAI Chat Completions 381 个在 /api/v1）：按 OpenAI 兼容协议向 /api/v1 问一次，不收目录外的模型', async () => {
  const catalogApi = { shared: false, apis: ['anthropic-messages', 'openai-completions'], openaiBaseUrl: 'https://openrouter.ai/api/v1' }
  const { deps, calls } = fakeDeps({ provider: 'openrouter', credentials: { OPENROUTER_API_KEY: KEY }, catalogApi, entry: { defaultBaseURL: 'https://openrouter.ai/api/v1', nativeAuth: { env: ['OPENROUTER_API_KEY'], oauth: false } } })
  const result = await runDiscover(deps, { provider: 'openrouter' })
  assert.equal(result.ok, true)
  assert.equal(result.acceptsUnlisted, false)
  assert.equal(result.url, 'https://openrouter.ai/api/v1/models')
  assert.deepEqual(calls.filter(call => call[0] === 'discover').map(call => call[2]), [{ baseURL: 'https://openrouter.ai/api/v1', api: 'openai-completions', apiKey: '(key)' }])
  // 目录的提供商默认地址不是 OpenAI 兼容模型的地址时，用 OpenAI 兼容模型自己的地址问。
  const other = fakeDeps({ provider: 'openrouter', credentials: { OPENROUTER_API_KEY: KEY }, catalogApi, entry: { defaultBaseURL: 'https://openrouter.ai/api', nativeAuth: { env: ['OPENROUTER_API_KEY'], oauth: false } } })
  assert.equal((await runDiscover(other.deps, { provider: 'openrouter' })).url, 'https://openrouter.ai/api/v1/models')
  // 用户在自定义设置里改过地址，就用用户的。
  const custom = fakeDeps({ provider: 'openrouter', profile: { baseURL: 'http://127.0.0.1:3493/v1' }, credentials: { OPENROUTER_API_KEY: KEY }, catalogApi })
  assert.equal((await runDiscover(custom.deps, { provider: 'openrouter' })).url, 'http://127.0.0.1:3493/v1/models')
})

test('请求失败按原因归类，原文里的密钥去掉', async () => {
  const failing = message => fakeDeps({ answer: new Error(message) }).deps
  assert.deepEqual(await runDiscover(failing('https://g.example/models answered 401; check the API key'), { provider: 'google' }), { ok: false, reason: 'auth', status: 401 })
  assert.deepEqual(await runDiscover(failing('could not reach https://g.example/models'), { provider: 'google' }), { ok: false, reason: 'network', host: 'generativelanguage.googleapis.com' })
  assert.deepEqual(await runDiscover(failing('https://g.example/models answered 500'), { provider: 'google' }), { ok: false, reason: 'status', status: 500 })
  const leaky = await runDiscover(failing(`weird ${KEY} failure`), { provider: 'google' })
  assert.deepEqual(leaky, { ok: false, reason: 'other', message: 'weird ••• failure' })
  const timeout = Object.assign(new Error('model discovery aborted by caller'), { code: 'ABORTED' })
  assert.deepEqual(await runDiscover({ ...failing('x'), discoverModels: async () => { throw timeout } }, { provider: 'google' }, { timedOut: () => true }), { ok: false, reason: 'timeout', seconds: 20 })
})

test('设为默认模型：先确认 DSH 认得这个模型，再用 DSH 自己的方法保存', async () => {
  assert.deepEqual(defaultModelRequestOf({ provider: 'google', model: 'gemini-x', extra: 1 }), { provider: 'google', model: 'gemini-x' })
  assert.equal(defaultModelRequestOf({ provider: 'google' }), undefined)
  const saved = []
  let current = { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }
  const deps = {
    canSave: () => true,
    currentSelection: () => current,
    resolveCallConfig: async config => { if (config.model === 'missing') throw new Error('unknown model'); return config },
    saveSelection: async (selection) => { saved.push(selection); current = selection },
  }
  assert.deepEqual(await setDefaultModel(deps, { provider: 'google', model: 'gemini-x' }), { ok: true })
  assert.deepEqual(saved, [{ provider: 'google', model: 'gemini-x' }])
  assert.deepEqual(await setDefaultModel(deps, { provider: 'google', model: 'missing' }), { ok: false, reason: 'unknownModel' })
  assert.deepEqual(await setDefaultModel({ ...deps, canSave: () => false }, { provider: 'google', model: 'gemini-y' }), { ok: false, reason: 'notSavable' })
  // DSH 的 saveSelection 在服务不是从配置项加载时直接返回、不报错：读回来没变就不能说成功。
  const silent = { ...deps, currentSelection: () => ({ provider: 'deepseek', model: 'v4' }), saveSelection: async () => {} }
  assert.deepEqual(await setDefaultModel(silent, { provider: 'google', model: 'gemini-z' }), { ok: false, reason: 'notSavable' })
  current = { provider: 'google', model: 'gemini-x', reasoningEffort: 'low' }
  assert.deepEqual(await setDefaultModel(deps, { provider: 'google', model: 'gemini-x' }), { ok: true })
  assert.equal(saved.length, 1)
})

// ---- 审查第 3、4、6 条和凭据名规则只留一份 ----
import { catalogApiOf, piAiCatalogUrl } from '../lib/model-settings/discover.js'
import { registerRoutes } from '../lib/model-settings/routes.js'
import { deriveKeyRef as hostDeriveKeyRef } from '../lib/model-settings/key-ref.js'

test('找 pi-ai 目录：先从 dsh-llm 找到 dsh-llm-pi-ai，再从它的位置找 pi-ai，按 pi-ai 自己的 exports 拼文件', async () => {
  const asked = []
  const packages = {
    '@deepseek-ai/dsh-llm-pi-ai': '/app/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json',
    '@earendil-works/pi-ai': '/app/node_modules/@earendil-works/pi-ai/package.json',
  }
  const deps = {
    llmUrl: () => 'file:///app/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    findPackageJSON: (specifier, base) => { asked.push([specifier, String(base)]); return packages[specifier] },
    readFile: async () => JSON.stringify({ exports: { './providers/*': { types: './dist/providers/*.d.ts', import: './dist/providers/*.js' } } }),
  }
  assert.equal(await piAiCatalogUrl(deps), 'file:///app/node_modules/@earendil-works/pi-ai/dist/providers/all.js')
  assert.deepEqual(asked, [
    ['@deepseek-ai/dsh-llm-pi-ai', 'file:///app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'],
    ['@earendil-works/pi-ai', 'file:///app/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'],
  ])
  assert.equal(await piAiCatalogUrl({ ...deps, findPackageJSON: () => undefined }), undefined)
  assert.equal(await piAiCatalogUrl({ ...deps, readFile: async () => '{}' }), undefined)
  assert.equal(await piAiCatalogUrl({ ...deps, llmUrl: () => { throw new Error('ERR_MODULE_NOT_FOUND') } }), undefined)
})

test('读目录里的协议：统一、不统一、这一家不在目录里、目录读不到', async () => {
  const load = models => ({ locate: async () => 'file:///catalog.js', load: async () => ({ getBuiltinModels: provider => models[provider] ?? [] }) })
  const deps = load({ google: [{ api: 'google-generative-ai' }, { api: 'google-generative-ai' }], openai: [{ api: 'openai-responses' }, { api: 'openai-completions' }] })
  assert.deepEqual(await catalogApiOf('google', deps), { api: 'google-generative-ai', shared: true, apis: ['google-generative-ai'] })
  assert.deepEqual(await catalogApiOf('openai', deps), { shared: false, apis: ['openai-responses', 'openai-completions'] })
  // 混合协议时带上 OpenAI 兼容模型的地址（都相同时），用来问列表。
  const router = load({ openrouter: [{ api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api' }, { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' }, { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' }] })
  assert.deepEqual(await catalogApiOf('openrouter', router), { shared: false, apis: ['anthropic-messages', 'openai-completions'], openaiBaseUrl: 'https://openrouter.ai/api/v1' })
  assert.equal(await catalogApiOf('nope', deps), undefined)
  assert.deepEqual(await catalogApiOf('google', { locate: async () => undefined, load: async () => ({}) }), { missing: true })
  assert.deepEqual(await catalogApiOf('google', { locate: async () => 'file:///x.js', load: async () => { throw new Error('boom') } }), { missing: true })
})

test('读不到安装包目录：单独的原因 noCatalog，不并进「协议不提供模型列表」；配置写了协议就不用目录', async () => {
  assert.deepEqual(await runDiscover(fakeDeps({ catalogApi: { missing: true } }).deps, { provider: 'google' }), { ok: false, reason: 'noCatalog' })
  assert.equal((await runDiscover(fakeDeps({ catalogApi: { missing: true }, profile: { api: 'google-generative-ai' } }).deps, { provider: 'google' })).ok, true)
})

test('配置里手写了不合法的 API 地址：回答 badBaseUrl，不抛异常、不发请求', async () => {
  const { deps, calls } = fakeDeps({ profile: { baseURL: 'not a url' } })
  assert.deepEqual(await runDiscover(deps, { provider: 'google' }), { ok: false, reason: 'badBaseUrl' })
  assert.equal(calls.some(call => call[0] === 'discover' || call[0] === 'resolve'), false)
})

/** 假的插件上下文：记下注册的路由，按名字取出 handler。 */
function fakeContext(services) {
  const routes = new Map()
  const scope = {
    effect: register => register(),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } },
  }
  return { routes, ctx: { inject: (names, callback) => callback(scope), get: name => services[name] } }
}
const post = (route, body) => route.fetch(new Request('http://x/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

test('宿主端接口：四个路由都注册；凭据按 credentials.resolve(ref).value 取；凭据服务缺省时回答 noCredentials', async () => {
  const resolved = []
  const discovered = []
  const llm = {
    listConfigurableProviders: () => [{ provider: 'google', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'google'], defaultBaseURL: 'https://g.example/v1beta', nativeAuth: { env: ['GEMINI_API_KEY'], oauth: false } }],
    discoverModels: async (ns, request) => { discovered.push(request.apiKey); return [{ id: 'm' }] },
  }
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { google: { api: 'google-generative-ai' } } } }] }
  const credentials = { resolve: async (ref) => { resolved.push(ref); return ref === 'GOOGLE_API_KEY' ? { value: KEY, source: 'file' } : undefined } }
  const { routes, ctx } = fakeContext({ llm, settings, credentials })
  registerRoutes(ctx, {})
  assert.deepEqual([...routes.keys()].sort(), ['/api/dsh-workbench.model-settings.catalog-protocols', '/api/dsh-workbench.model-settings.check', '/api/dsh-workbench.model-settings.default-model', '/api/dsh-workbench.model-settings.discover'])
  const answer = await (await post(routes.get('/api/dsh-workbench.model-settings.discover'), { provider: 'google' })).json()
  assert.equal(answer.ok, true)
  assert.deepEqual(resolved, ['GOOGLE_API_KEY'])
  assert.deepEqual(discovered, [KEY])
  assert.equal(JSON.stringify(answer).includes(KEY), false)
  const bare = fakeContext({ llm, settings })
  registerRoutes(bare.ctx, {})
  assert.deepEqual(await (await post(bare.routes.get('/api/dsh-workbench.model-settings.discover'), { provider: 'google' })).json(), { ok: false, reason: 'noCredentials' })
})

test('宿主端接口在任何输入下都回答 JSON：坏请求体、不合法的地址、DSH 抛异常', async () => {
  const llm = {
    listConfigurableProviders: () => { throw new Error('directory exploded') },
    discoverModels: async () => [],
  }
  const { routes, ctx } = fakeContext({ llm, settings: { describe: () => [] }, credentials: { resolve: async () => undefined } })
  registerRoutes(ctx, {})
  const route = routes.get('/api/dsh-workbench.model-settings.discover')
  for (const body of ['not json', { provider: '../x' }, { provider: 'google' }]) {
    const response = await post(route, body)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const answer = await response.json()
    assert.equal(answer.ok, false, JSON.stringify(body))
  }
})

test('凭据名的规则：路由名大写、非字母数字换成下划线，再加 _API_KEY（media look 按这个名字找密钥）', () => {
  assert.equal(hostDeriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
})

/** 模型设置（从 dsh-model-settings 的 test/feat120-companion.test.mjs 搬来，feat#217）。 feat#120：协议混合的提供商（OpenCode Go、OpenRouter）也能加目录外的模型：每种协议一个伴随条目。目录数据是 pi-ai 1.3.0 的真实数据（test/fixtures/model-settings-mixed-catalogs.json）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COMPANION_LABELS, addressChoices, companionKeyRef, companionPlan, companionRoute, inferApi, ownCompanion, parseCompanion, protocolInfo, settledAddress } from '../lib/model-settings/companion.js'
import { MODEL_SETTINGS_ZH as ZH_COPY, MODEL_SETTINGS_EN as EN_COPY } from '../src/client/model-settings/copy.js'
import { runCatalogProtocols } from '../lib/model-settings/discover.js'
import { opencodeSessionHeader } from '../lib/model-settings/opencode-session.js'
import { credentialNamedBy, credentialUsers, markCompanions } from '../src/client/model-settings/status.js'
import { loadClient, textOf } from './react-harness.mjs'

const CATALOGS = JSON.parse(readFileSync(new URL('./fixtures/model-settings-mixed-catalogs.json', import.meta.url), 'utf8'))
const GO = CATALOGS['opencode-go']
const ROUTER = CATALOGS.openrouter
const ZEN = CATALOGS.opencode

test('伴随条目的 Provider ID：<原提供商>--<协议简称>，能认回原提供商和协议；别的 ID 不认', () => {
  assert.equal(companionRoute('opencode-go', 'openai-completions'), 'opencode-go--openai')
  assert.equal(companionRoute('opencode-go', 'openai-responses'), 'opencode-go--responses')
  assert.equal(companionRoute('opencode-go', 'anthropic-messages'), 'opencode-go--anthropic')
  assert.equal(companionRoute('opencode-go', 'google-generative-ai'), 'opencode-go--gemini')
  assert.equal(companionRoute('opencode-go', 'bedrock-converse-stream'), undefined)
  assert.deepEqual(parseCompanion('opencode-go--anthropic'), { origin: 'opencode-go', api: 'anthropic-messages' })
  assert.equal(parseCompanion('opencode-go'), undefined)
  assert.equal(parseCompanion('my--relay'), undefined)
})

test('协议按目录里同类模型推出来（OpenCode Go 真实目录）；推不出时用 OpenAI Chat Completions', () => {
  assert.equal(inferApi('minimax-m3.1-flash', GO), 'anthropic-messages')
  assert.equal(inferApi('qwen3.9-max', GO), 'anthropic-messages')
  assert.equal(inferApi('gemini-4-argon', GO), 'google-generative-ai')
  assert.equal(inferApi('gpt-6.1-luna', GO), 'openai-responses')
  assert.equal(inferApi('kimi-k3.1-pro', GO), 'openai-completions')
  assert.equal(inferApi('hy4', GO), 'openai-completions')
  assert.equal(inferApi('brand-new-model', GO), 'openai-completions')
  // OpenCode同样按家族推。
  assert.equal(inferApi('claude-fable-6', ZEN), 'anthropic-messages')
  assert.equal(inferApi('gemini-4-argon', ZEN), 'google-generative-ai')
  assert.equal(inferApi('gpt-7', ZEN), 'openai-responses')
  assert.equal(inferApi('kimi-k3.1-pro', ZEN), 'openai-completions')
  // OpenCode 的 qwen3 两种协议都有：推不出，按获取列表的协议。
  assert.equal(inferApi('qwen3.9-coder', ZEN), 'openai-completions')
  // OpenRouter 的 anthropic/* 两种协议都有：推不出，按获取列表的协议。
  assert.equal(inferApi('anthropic/claude-new', ROUTER), 'openai-completions')
})

test('只认我们建的伴随条目：原提供商是目录里的提供商，api 和 ID 里的协议一致，显示名以「（协议名）」结尾；手写的同形条目不认', () => {
  const isCatalog = origin => ['openrouter', 'opencode-go'].includes(origin)
  const ours = { displayName: 'OpenRouter（OpenAI Chat Completions）', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', models: [] }
  assert.deepEqual(ownCompanion('openrouter--openai', ours, isCatalog), { origin: 'openrouter', api: 'openai-completions' })
  assert.deepEqual(ownCompanion('openrouter--openai', { ...ours, displayName: 'OpenRouter (OpenAI Chat Completions)' }, isCatalog), { origin: 'openrouter', api: 'openai-completions' })
  // 手写的中转站条目：名字、协议对不上就不是我们的。
  assert.equal(ownCompanion('openrouter--openai', { ...ours, displayName: 'My relay' }, isCatalog), undefined)
  assert.equal(ownCompanion('openrouter--openai', { ...ours, api: 'anthropic-messages' }, isCatalog), undefined)
  assert.equal(ownCompanion('openrouter--openai', { ...ours, displayName: 'OpenRouter（Anthropic Messages）' }, isCatalog), undefined)
  // 原提供商不是目录里的（自定义的 foo）：不认。
  assert.equal(ownCompanion('foo--openai', { ...ours, displayName: 'foo（OpenAI Chat Completions）' }, isCatalog), undefined)
  assert.equal(ownCompanion('openrouter--openai', undefined, isCatalog), undefined)
  // 协议名和页面文案是同一份：中英文都一样。
  for (const [api, label] of Object.entries(COMPANION_LABELS)) {
    assert.equal(ZH_COPY[`protocol.${api}`], label)
    assert.equal(EN_COPY[`protocol.${api}`], label)
  }
})

test('每种协议能不能用：地址统一才用；地址要从环境变量拼（Cloudflare）、没有地址（Azure）、模型带专用请求头（Copilot）的协议不能用，并说出原因', () => {
  const go = protocolInfo(GO)
  assert.deepEqual(Object.fromEntries(Object.entries(go.usable).map(([api, info]) => [api, info.base])), {
    'anthropic-messages': 'https://opencode.ai/inference/go',
    'google-generative-ai': 'https://opencode.ai/inference/go/v1',
    'openai-completions': 'https://opencode.ai/inference/go/v1',
    'openai-responses': 'https://opencode.ai/inference/go/v1',
  })
  assert.deepEqual(go.unusable, {})
  assert.equal(protocolInfo(ZEN).usable['anthropic-messages'].base, 'https://opencode.ai/inference')
  assert.deepEqual(Object.keys(protocolInfo(ROUTER).usable).sort(), ['anthropic-messages', 'openai-completions'])
  assert.deepEqual(protocolInfo(CATALOGS['cloudflare-ai-gateway']), { usable: {}, unusable: { 'anthropic-messages': 'template', 'openai-completions': 'template', 'openai-responses': 'template' } })
  assert.deepEqual(protocolInfo(CATALOGS.azure).usable, {})
  assert.equal(protocolInfo(CATALOGS.azure).unusable['openai-completions'], 'noBase')
  assert.deepEqual(protocolInfo(CATALOGS['github-copilot']), { usable: {}, unusable: { 'anthropic-messages': 'headers', 'openai-completions': 'headers', 'openai-responses': 'headers' } })
  assert.equal(protocolInfo([{ id: 'a', api: 'openai-completions', baseUrl: 'https://x/v1' }, { id: 'b', api: 'openai-completions', baseUrl: 'https://y/v1' }]).unusable['openai-completions'], 'noBase')
})

test('目录模型的兼容开关：同一协议的目录模型全都一样、DSH 允许写在条目上的才带上（OpenCode Go、OpenRouter 真实目录）', () => {
  const go = protocolInfo(GO).usable
  assert.deepEqual(go['openai-completions'].compat, { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: true })
  // Responses 的 sessionAffinityFormat 是 DSH 不让写的（withhold），不带。
  assert.deepEqual(go['openai-responses'].compat, {})
  // Anthropic Messages：只有一个模型带 forceAdaptiveThinking，不统一，不带。
  assert.deepEqual(go['anthropic-messages'].compat, {})
  assert.deepEqual(go['google-generative-ai'].compat, {})
  const router = protocolInfo(ROUTER).usable['openai-completions'].compat
  assert.equal(router.thinkingFormat, 'openrouter')
  assert.equal(router.supportsStrictMode, true)
  assert.equal('sendSessionAffinityHeaders' in router, false)
})

test('伴随条目的地址只在两个里选：原提供商在自定义设置里写的地址、目录里这种协议的地址；存的不是其中之一就算过时，改成第一个', () => {
  assert.deepEqual(addressChoices('http://relay/router/v1', 'https://openrouter.ai/api'), ['http://relay/router/v1', 'https://openrouter.ai/api'])
  assert.deepEqual(addressChoices(undefined, 'https://openrouter.ai/api'), ['https://openrouter.ai/api'])
  assert.deepEqual(addressChoices('https://openrouter.ai/api', 'https://openrouter.ai/api'), ['https://openrouter.ai/api'])
  assert.deepEqual(addressChoices(undefined, undefined), [])
  // 用户选过目录地址：保留。
  assert.equal(settledAddress('https://openrouter.ai/api', ['http://relay/router/v1', 'https://openrouter.ai/api']), 'https://openrouter.ai/api')
  // 原提供商删掉了中转地址：存着的旧中转地址过时，改回目录地址。
  assert.equal(settledAddress('http://relay/router/v1', ['https://openrouter.ai/api']), 'https://openrouter.ai/api')
  // 新建：没有存的，用第一个。
  assert.equal(settledAddress(undefined, ['http://relay/router/v1', 'https://openrouter.ai/api']), 'http://relay/router/v1')
  assert.equal(settledAddress('http://old', []), undefined)
})

test('伴随条目用原提供商实际在用的凭据名，不复制密钥', () => {
  assert.equal(companionKeyRef('opencode-go', { apiKeyEnv: 'MY_KEY' }, ['OPENCODE_API_KEY']), 'MY_KEY')
  assert.equal(companionKeyRef('opencode-go', {}, ['OPENCODE_API_KEY']), 'OPENCODE_API_KEY')
  assert.equal(companionKeyRef('opencode-go', {}, ['SOME_TOKEN']), 'OPENCODE_GO_API_KEY')
})

const INFO = protocolInfo(GO).usable
const ENTRIES = Object.fromEntries(Object.entries(INFO).map(([api, info]) => [api, { baseURL: info.base, compat: info.compat }]))
/** 显示名 = 原提供商名接协议名。 */
const LABELS = { 'openai-completions': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages', 'google-generative-ai': 'Gemini API' }
const nameFor = api => `OpenCode Go（${LABELS[api]}）`
const plan = (current, wanted, keyRef = 'OPENCODE_API_KEY') => companionPlan({ origin: 'opencode-go', current, wanted, keyRef, entries: ENTRIES, nameFor })

test('写入：新协议建条目；改模型、换凭据名只写改了的；删掉最后一个模型删条目', () => {
  assert.deepEqual(plan({}, { 'anthropic-messages': [{ id: 'minimax-m3.1-flash' }] }), [
    { op: 'set', path: ['providers', 'opencode-go--anthropic'], value: { displayName: 'OpenCode Go（Anthropic Messages）', api: 'anthropic-messages', baseURL: 'https://opencode.ai/inference/go', apiKeyEnv: 'OPENCODE_API_KEY', models: [{ id: 'minimax-m3.1-flash' }] } },
  ])
  const GO_COMPAT = { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: true }
  assert.deepEqual(plan({}, { 'openai-completions': [{ id: 'kimi-k3.1-pro' }] })[0].value.compat, GO_COMPAT)
  const current = { 'opencode-go--openai': { displayName: 'OpenCode Go（OpenAI Chat Completions）', api: 'openai-completions', baseURL: 'https://opencode.ai/inference/go/v1', apiKeyEnv: 'OPENCODE_API_KEY', compat: GO_COMPAT, models: [{ id: 'kimi-k3.1-pro' }] } }
  // 早先建的条目没有兼容开关：补上。
  const { compat: _, ...noCompat } = current['opencode-go--openai']
  assert.deepEqual(plan({ 'opencode-go--openai': noCompat }, { 'openai-completions': [{ id: 'kimi-k3.1-pro' }] }), [
    { op: 'set', path: ['providers', 'opencode-go--openai', 'compat'], value: GO_COMPAT },
  ])
  // 地址改了（例如原提供商删掉了自定义地址）：只写地址。
  assert.deepEqual(companionPlan({ origin: 'opencode-go', current, wanted: { 'openai-completions': [{ id: 'kimi-k3.1-pro' }] }, keyRef: 'OPENCODE_API_KEY', entries: { 'openai-completions': { baseURL: 'http://relay/v1', compat: GO_COMPAT } }, nameFor }), [
    { op: 'set', path: ['providers', 'opencode-go--openai', 'baseURL'], value: 'http://relay/v1' },
  ])
  assert.deepEqual(plan(current, { 'openai-completions': [{ id: 'kimi-k3.1-pro' }] }), [])
  assert.deepEqual(plan(current, { 'openai-completions': [{ id: 'kimi-k3.1-pro' }, { id: 'hy4' }] }), [
    { op: 'set', path: ['providers', 'opencode-go--openai', 'models'], value: [{ id: 'kimi-k3.1-pro' }, { id: 'hy4' }] },
  ])
  assert.deepEqual(plan(current, { 'openai-completions': [{ id: 'kimi-k3.1-pro' }] }, 'OPENCODE_GO_API_KEY'), [
    { op: 'set', path: ['providers', 'opencode-go--openai', 'apiKeyEnv'], value: 'OPENCODE_GO_API_KEY' },
  ])
  assert.deepEqual(plan(current, {}), [{ op: 'unset', path: ['providers', 'opencode-go--openai'] }])
  // 没有这种协议的地址时不建条目、不沿用旧地址（页面上这时不让保存）。
  assert.deepEqual(companionPlan({ origin: 'x', current: {}, wanted: { 'anthropic-messages': [{ id: 'a' }] }, keyRef: 'K', entries: {}, nameFor: () => 'X' }), [])
  assert.deepEqual(companionPlan({ origin: 'opencode-go', current, wanted: { 'openai-completions': [{ id: 'kimi-k3.1-pro' }] }, keyRef: 'OPENCODE_GO_API_KEY', entries: {}, nameFor }), [])
})

test('OpenCode 的会话头：只给我们建的 opencode、opencode-go 伴随条目补 x-opencode-session，值是这次请求的会话 ID；已有的不改；手写的同形条目不补', () => {
  const ours = api => ({ displayName: `OpenCode Go（${COMPANION_LABELS[api]}）`, api })
  const providers = {
    'opencode-go--anthropic': ours('anthropic-messages'),
    'opencode--openai': { displayName: 'OpenCode Zen（OpenAI Chat Completions）', api: 'openai-completions' },
    'opencode-go--openai': ours('openai-completions'),
    'openrouter--openai': { displayName: 'OpenRouter（OpenAI Chat Completions）', api: 'openai-completions' },
    'opencode--responses': { displayName: 'my relay', api: 'openai-responses' },
  }
  const hook = opencodeSessionHeader(route => providers[route])
  const run = (request, preset = {}) => {
    const headers = new Headers(preset)
    let nextCalled = false
    const out = hook(request, headers, () => { nextCalled = true; return headers })
    assert.equal(nextCalled, true)
    return out.get('x-opencode-session')
  }
  assert.equal(run({ provider: 'opencode-go--anthropic', sessionId: 'session-1', model: 'm', baseURL: 'u' }), 'session-1')
  assert.equal(run({ provider: 'opencode--openai', sessionId: 'session-2', model: 'm', baseURL: 'u' }), 'session-2')
  assert.equal(run({ provider: 'openrouter--openai', sessionId: 'session-3', model: 'm', baseURL: 'u' }), null)
  assert.equal(run({ provider: 'opencode-go', sessionId: 'session-4', model: 'm', baseURL: 'u' }), null)
  assert.equal(run({ provider: 'opencode-go--openai', model: 'm', baseURL: 'u' }), null)
  assert.equal(run({ provider: 'opencode-go--openai', sessionId: 's', model: 'm', baseURL: 'u' }, { 'X-OpenCode-Session': 'keep' }), 'keep')
  // 手写的 opencode--responses（名字不是我们写的）：不补。
  assert.equal(run({ provider: 'opencode--responses', sessionId: 'session-5', model: 'm', baseURL: 'u' }), null)
  // 设置读不到：不补。
  assert.equal(opencodeSessionHeader(() => undefined)({ provider: 'opencode-go--anthropic', sessionId: 's' }, new Headers(), () => new Headers()).get('x-opencode-session'), null)
})

test('补会话头是单独的一行插件：apply 把监听注册到 llm-pi-ai/request-headers，从 DSH 的设置读条目', async () => {
  const mod = await import('../lib/model-settings/opencode-session.js')
  const seen = []
  const ctx = {
    on(event, listener) { seen.push([event, listener]) },
    get(name) { return name === 'settings' ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go--anthropic': { displayName: 'OpenCode Go（Anthropic Messages）', api: 'anthropic-messages' } } } }] } : undefined },
  }
  mod.apply(ctx)
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'llm-pi-ai/request-headers')
  const headers = new Headers()
  seen[0][1]({ provider: 'opencode-go--anthropic', sessionId: 'abc' }, headers, () => headers)
  assert.equal(headers.get('x-opencode-session'), 'abc')
  // 模型设置那一行（lib/model-settings/index.js 要 import DSH 的包，测试里加载不了）不注册这个监听；两行都在工作台的 cordis.patch.yml 里，各自能开关。
  assert.equal(readFileSync(new URL('../lib/model-settings/index.js', import.meta.url), 'utf8').includes('request-headers'), false)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: '@miint-sunny\/dsh-workbench\/model-settings'\n/)
  assert.match(patch, /name: '@miint-sunny\/dsh-workbench\/opencode-session'\n/)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./opencode-session'].default, './lib/model-settings/opencode-session.js')
})

test('宿主端「目录协议」：读安装包目录给出每个模型的协议和每种协议的地址，不发请求', async () => {
  const deps = {
    describeSettings: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {} } } }],
    listDirectory: () => [{ provider: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], defaultBaseURL: 'https://opencode.ai/inference/go/v1', nativeAuth: { env: ['OPENCODE_API_KEY'], oauth: false } }],
    catalogModels: async provider => (provider === 'opencode-go' ? GO : undefined),
  }
  const answer = await runCatalogProtocols(deps, { provider: 'opencode-go' })
  assert.equal(answer.ok, true)
  assert.equal(answer.mixed, true)
  assert.equal(answer.keyRef, 'OPENCODE_API_KEY')
  assert.equal(answer.protocols['anthropic-messages'].base, 'https://opencode.ai/inference/go')
  assert.equal(answer.protocols['openai-completions'].compat.maxTokensField, 'max_tokens')
  assert.deepEqual(answer.unusable, {})
  assert.equal(answer.models.find(m => m.id === 'minimax-m3').api, 'anthropic-messages')
  assert.deepEqual(await runCatalogProtocols({ ...deps, catalogModels: async () => ({ missing: true }) }, { provider: 'opencode-go' }), { ok: false, reason: 'noCatalog' })
  assert.deepEqual(await runCatalogProtocols(deps, { provider: 'nope' }), { ok: false, reason: 'unknownProvider' })
})

test('拼行时标出伴随条目：只有我们建的、原提供商是目录里的且已配置时才标；原提供商不在了的照常算一家', () => {
  const entry = (provider, declared = false) => ({ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared })
  const profiles = {
    'opencode-go--openai': { displayName: 'OpenCode Go（OpenAI Chat Completions）', api: 'openai-completions' },
    'openrouter--openai': { displayName: 'OpenRouter（OpenAI Chat Completions）', api: 'openai-completions' },
    'opencode--openai': { displayName: 'My relay', api: 'openai-completions' },
  }
  const rows = markCompanions([
    { entry: entry('opencode-go'), configured: true },
    { entry: entry('openrouter'), configured: false },
    { entry: entry('opencode'), configured: true },
    { entry: entry('opencode-go--openai', true), configured: true },
    { entry: entry('openrouter--openai', true), configured: true },
    { entry: entry('opencode--openai', true), configured: true },
  ], route => profiles[route])
  assert.deepEqual(rows.map(row => row.companionOf?.origin ?? null), [null, null, null, 'opencode-go', null, null])
})

test('凭据名：从原提供商继承凭据名的伴随条目视同原提供商，不算「别人点名在用」（OpenCode Go 的伴随条目点名 OPENCODE_API_KEY 时照样能加 OpenCode）', () => {
  const go = { entry: { provider: 'opencode-go', nativeAuth: { env: ['OPENCODE_API_KEY'] } }, configured: true }
  const companion = { entry: { provider: 'opencode-go--openai', declared: true }, configured: true, apiKeyEnv: 'OPENCODE_API_KEY', companionOf: { origin: 'opencode-go', api: 'openai-completions' } }
  const zen = { entry: { provider: 'opencode', nativeAuth: { env: ['OPENCODE_API_KEY'] } }, configured: false }
  const rows = [go, companion, zen]
  assert.deepEqual(credentialNamedBy(rows, 'OPENCODE_API_KEY', 'opencode'), [])
  // 用的人里只算 OpenCode Go 一家（目录给的环境变量名），不单列它的伴随条目。
  assert.deepEqual(credentialUsers(rows, 'OPENCODE_API_KEY', 'opencode'), ['opencode-go'])
  // 伴随条目的凭据名被手改成别的：按它自己算。
  const edited = { ...companion, apiKeyEnv: 'OPENCODE_API_KEY', companionOf: companion.companionOf }
  const goNamed = { ...go, apiKeyEnv: 'OPENCODE_GO_API_KEY' }
  assert.deepEqual(credentialNamedBy([goNamed, edited, zen], 'OPENCODE_API_KEY', 'opencode'), ['opencode-go--openai'])
})

test('已添加：手写的同形条目、原提供商不在了的伴随条目都照常各占一行', async (t0) => {
  const orphan = { entry: { provider: 'openrouter--openai', displayName: 'OpenRouter（OpenAI Chat Completions）', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter--openai'], active: true, declared: true }, configured: true, removable: true, apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions' }
  const ours = { entry: { provider: 'opencode-go--openai', displayName: 'OpenCode Go（OpenAI Chat Completions）', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go--openai'], active: true, declared: true }, configured: true, removable: true, apiKeyEnv: 'OPENCODE_API_KEY', api: 'openai-completions', companionOf: { origin: 'opencode-go', api: 'openai-completions' } }
  const go = { entry: { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], active: true }, configured: true, removable: true }
  const router = { entry: { provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'], active: true }, configured: false, removable: false }
  const snapshot = { status: 'ready', writable: true, checks: new Map(), rows: [go, router, orphan, ours], catalog: { groups: [] }, namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai' }]]) }
  const client = loadClient(new URL('../lib/client.js', import.meta.url))
  const react = client.react
  const app = { t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`), ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } }, ops: {}, store: { async load() {}, getSnapshot: () => snapshot } }
  react.mount(react.React.createElement(client.get('ListPage'), { app, snapshot, go() {} }))
  t0.after(() => react.unmount())
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-cat' && textOf(node).startsWith('catadded'), '「已添加」'), 'onClick')
  await react.settle()
  const cards = react.all(node => node.type === 'li' && node.props.className === 'dms-pv').map(textOf)
  assert.equal(cards.length, 2)
  assert.ok(cards.some(text => text.includes('OpenRouter（OpenAI Chat Completions）')), cards.join(' / '))
})

// ---- 页面 ----
const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
const getPath = (value, path) => path.reduce((at, key) => (typeof at === 'object' && at !== null ? at[key] : undefined), value)
const schema = { rehydrate: value => value, nodeAtPath: () => undefined, getPath, validate: () => undefined }

function goRow() {
  return {
    entry: { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], active: true, defaultBaseURL: 'https://opencode.ai/inference/go/v1', nativeAuth: { env: ['OPENCODE_API_KEY'], oauth: false } },
    configured: true, removable: true, apiKeyEnv: 'OPENCODE_GO_API_KEY', credential: { configured: true, writable: true, source: 'file', masked: 'sk-ab•••••9f3a' },
  }
}
/** 我们建的伴随条目：显示名以「（协议名）」结尾，地址、兼容开关取自真实目录。 */
function companionProfile(api, models, extra = {}) {
  const compat = INFO[api].compat
  return { displayName: `OpenCode Go（${LABELS[api]}）`, api, baseURL: INFO[api].base, apiKeyEnv: 'OPENCODE_GO_API_KEY', ...Object.keys(compat).length > 0 ? { compat } : {}, models, ...extra }
}
function companionRow(api, models) {
  const provider = companionRoute('opencode-go', api)
  return { entry: { provider, displayName: `OpenCode Go（${LABELS[api]}）`, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], active: true, declared: true }, configured: true, removable: true, apiKeyEnv: 'OPENCODE_GO_API_KEY', api, models, companionOf: { origin: 'opencode-go', api } }
}
function snapshotOf(providers, extraRows = [], revision = 3) {
  return {
    status: 'ready', writable: true, checks: new Map(), rows: [goRow(), ...extraRows], catalog: { groups: [], default: { provider: 'opencode-go--openai', model: 'kimi-k3.1-pro' } },
    namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision, schema: {}, value: { providers }, user: { providers }, base: {} }]]),
  }
}
const PROTOCOLS = { ok: true, mixed: true, keyRef: 'OPENCODE_GO_API_KEY', protocols: INFO, unusable: {}, models: GO }
function open(t0, snapshot, { ops = {}, row = snapshot.rows[0], fresh, go = () => {}, schemaOps = schema } = {}) {
  const client = loadClient(CLIENT)
  const calls = []
  const app = {
    t, schema: schemaOps, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } },
    ops: {
      async writeSettings(ns, writeOps, revision) { calls.push(['write', writeOps, revision]); return { kind: 'written', view: { revision: 4, user: { providers: {} } } } },
      async storeCredential(ref) { calls.push(['store', ref]) },
      async removeCredential(ref) { calls.push(['remove', ref]) },
      async discoverModels() { return { kind: 'found', models: GO.map(m => ({ id: m.id, name: m.id })) } },
      async discoverLive() { calls.push(['live']); return { ok: true, models: [...GO.map(m => ({ id: m.id })), { id: 'kimi-k3.1-pro' }, { id: 'minimax-m3.1-flash' }], url: 'https://opencode.ai/inference/go/v1/models', at: 0, acceptsUnlisted: false } },
      async catalogProtocols() { calls.push(['protocols']); return PROTOCOLS },
      async setDefaultModel(provider, model) { calls.push(['default', provider, model]); return { ok: true } },
      async check() { return { ok: true, model: 'm', ms: 1 } },
      ...ops,
    },
    store: { async load() { calls.push(['load']) }, setCheck() {}, getSnapshot: () => fresh ?? snapshot },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get('ProviderDetail'), { app, go, snapshot, row, namespace: snapshot.namespaces.get('llm-pi-ai') }))
  t0.after(() => react.unmount())
  return { react, calls, client }
}
/** 页面上所有文字（顶层节点的文字连在一起）。 */
const pageText = react => react.all(node => node.parent === undefined || node.parent === null).map(textOf).join('|')
/** 右键一行（按模型 ID 找），返回菜单里的项。 */
async function menuOf(react, id) {
  const row = react.all(node => (node.props?.className === 'dms-mrow' || node.props?.className === 'dms-module') && textOf(node).includes(id))[0]
  react.fire(row, 'onContextMenu', { clientX: 1, clientY: 1 })
  await react.settle()
  return react.one(node => node.type === 'ui.Menu', '右键菜单').props.items
}
const button = (react, label) => react.one(node => node.type === 'ui.Button' && textOf(node) === label, `「${label}」按钮`)

test('页面：协议混合的提供商，「仅提供商返回」的行写出要用的协议，「+」和「添加全部」可用；保存时在同一次写入里建伴随条目', async (t0) => {
  const { react, calls } = open(t0, snapshotOf({ 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }))
  await react.settle()
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  const rows = react.all(node => node.type === 'li' && /^(kimi-k3\.1-pro|minimax-m3\.1-flash)/.test(textOf(node)))
  assert.equal(rows.length, 2)
  assert.match(textOf(rows.find(row => textOf(row).startsWith('minimax'))), /onlyFromProviderVia \{"protocol":"anthropic-messages"\}/)
  const addAll = button(react, 'pickAddAll')
  assert.equal(addAll.props.disabled, false)
  addAll.props.onClick()
  await react.settle()
  react.one(node => node.type === 'ui.Modal' && node.props.title === 'fetchTitle', '选择模型').props.onClose()
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const writes = calls.filter(call => call[0] === 'write')
  assert.equal(writes.length, 1)
  const paths = writes[0][1].map(op => `${op.op} ${op.path.join('.')}`)
  assert.ok(paths.includes('set providers.opencode-go--openai'), paths.join(', '))
  assert.ok(paths.includes('set providers.opencode-go--anthropic'), paths.join(', '))
  assert.equal(paths.some(path => /providers\.opencode-go\.(api|baseURL)$/.test(path)), false)
  const anthropic = writes[0][1].find(op => op.path.join('.') === 'providers.opencode-go--anthropic').value
  assert.deepEqual({ api: anthropic.api, baseURL: anthropic.baseURL, apiKeyEnv: anthropic.apiKeyEnv, ids: anthropic.models.map(m => m.id) },
    { api: 'anthropic-messages', baseURL: 'https://opencode.ai/inference/go', apiKeyEnv: 'OPENCODE_GO_API_KEY', ids: ['minimax-m3.1-flash'] })
  // 显示名：原提供商名接协议名（页面用 companionName 文案拼，替身 t 原样回显键和参数）。
  assert.equal(anthropic.displayName, 'companionName {"provider":"OpenCode Go","protocol":"anthropic-messages"}')
})

test('已添加：一家一行，模型数加上目录外的模型，默认模型在伴随条目里时也写在原提供商的那一行', async (t0) => {
  const companion = companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])
  const snapshot = { ...snapshotOf({}, [companion]), catalog: {
    default: { provider: 'opencode-go--openai', model: 'kimi-k3.1-pro' },
    groups: [{ id: 'opencode-go', models: [{ id: 'kimi-k3' }, { id: 'glm-5.3' }] }, { id: 'opencode-go--openai', models: [{ id: 'kimi-k3.1-pro' }] }],
  } }
  const client = loadClient(CLIENT)
  const react = client.react
  const app = { t, schema, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } }, ops: {}, store: { async load() {}, getSnapshot: () => snapshot } }
  react.mount(react.React.createElement(client.get('ListPage'), { app, snapshot, go() {} }))
  t0.after(() => react.unmount())
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-cat' && textOf(node).startsWith('catadded'), '「已添加」'), 'onClick')
  await react.settle()
  const cards = react.all(node => node.type === 'li' && node.props.className === 'dms-pv')
  assert.equal(cards.length, 1)
  assert.match(textOf(cards[0]), /metaModels \{"count":3\}/)
  assert.match(textOf(cards[0]), /metaDefault \{"model":"kimi-k3.1-pro"\}/)
})

test('页面：目录外的模型在原提供商详情页里列出、能删；删掉最后一个时删掉条目；删除确认框写明会一起删', async (t0) => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  assert.ok(react.all(node => node.props?.className === 'dms-sec' && textOf(node).startsWith('companionModels')).length === 1)
  const row = react.one(node => node.props?.className === 'dms-mrow' && textOf(node).startsWith('kimi-k3.1-pro'), '目录外模型的行')
  assert.match(textOf(row), /defaultModel/)
  // 删除原提供商的确认框写明伴随条目也一起删。
  const modal = react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框')
  assert.match(modal.props.description, /deleteDescriptionWithCompanions/)
  react.fire(react.one(node => node.type === 'button' && node.props['aria-label'] === 'removeModel kimi-k3.1-pro', '删除'), 'onClick')
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1], [{ op: 'unset', path: ['providers', 'opencode-go--openai'] }])
})

test('页面：删除原提供商时连同伴随条目一起删', async (t0) => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go--anthropic': companionProfile('anthropic-messages', [{ id: 'minimax-m3.1-flash' }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('anthropic-messages', [{ id: 'minimax-m3.1-flash' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  const modal = react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框')
  modal.props.footer.props.children[1].props.onClick()
  await react.settle()
  const ops = calls.find(call => call[0] === 'write')[1].map(op => `${op.op} ${op.path.join('.')}`)
  assert.deepEqual(ops, ['unset providers.opencode-go', 'unset providers.opencode-go--anthropic'])
})

test('页面：清除原提供商的密钥时，伴随条目的凭据名在同一次写入里跟着改', async (t0) => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && textOf(node) === 'keyClear', '清除'), 'onClick')
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const ops = calls.find(call => call[0] === 'write')[1].map(op => `${op.op} ${op.path.join('.')}${op.value === undefined ? '' : `=${JSON.stringify(op.value)}`}`)
  assert.deepEqual(ops, ['unset providers.opencode-go.apiKeyEnv', 'set providers.opencode-go--openai.apiKeyEnv="OPENCODE_API_KEY"'])
})

test('页面：目录外模型的协议能改（下拉）；保存时连同字段搬到那种协议的条目，__api 不写进配置；默认模型跟着搬过去', async (t0) => {
  const moved = { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', contextWindow: 200000, input: ['text'] }
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go--openai': companionProfile('openai-completions', [moved, { id: 'kimi-k3.1-pro' }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [moved, { id: 'kimi-k3.1-pro' }])])
  snapshot.catalog.default = { provider: 'opencode-go--openai', model: 'minimax-m3.1-flash' }
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  const rowButton = react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith('minimax-m3.1-flash'), '行')
  react.fire(rowButton, 'onClick')
  await react.settle()
  const select = react.one(node => node.type === 'select' && node.props['aria-label'] === 'protocol minimax-m3.1-flash', '协议下拉')
  assert.deepEqual(select.children.map(option => option.props.value), ['anthropic-messages', 'google-generative-ai', 'openai-completions', 'openai-responses'])
  react.fire(select, 'onChange', { target: { value: 'anthropic-messages' } })
  await react.settle()
  // 协议改了还没保存：右键菜单的「设为默认模型」不可点，并写明要先保存。
  const item = (await menuOf(react, 'minimax-m3.1-flash')).find(entry => entry.id === 'default')
  assert.equal(item.disabled, true)
  assert.equal(item.label, 'setDefaultProtocolPending')
  react.one(node => node.type === 'ui.Menu', '右键菜单').props.onClose()
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const write = calls.find(call => call[0] === 'write')[1]
  const ops = write.map(op => `${op.op} ${op.path.join('.')}`)
  assert.deepEqual(ops.sort(), ['set providers.opencode-go--anthropic', 'set providers.opencode-go--openai.models'])
  assert.deepEqual(write.find(op => op.path.join('.') === 'providers.opencode-go--anthropic').value.models, [moved])
  assert.equal(JSON.stringify(write).includes('__'), false)
  // 默认模型原来在 opencode-go--openai 下：写入后改到 opencode-go--anthropic。
  assert.deepEqual(calls.filter(call => call[0] === 'default'), [['default', 'opencode-go--anthropic', 'minimax-m3.1-flash']])
})

test('页面：默认模型按「条目 + 模型 ID」认；别的条目里同名的模型不标默认', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]) }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  // DSH 的默认模型指向一个已经不存在的条目里的同名模型。
  snapshot.catalog.default = { provider: 'opencode-go--anthropic', model: 'kimi-k3.1-pro' }
  const { react } = open(t0, snapshot)
  await react.settle()
  const row = react.one(node => node.props?.className === 'dms-mrow' && textOf(node).startsWith('kimi-k3.1-pro'), '目录外模型的行')
  assert.doesNotMatch(textOf(row), /defaultModel/)
  assert.equal((await menuOf(react, 'kimi-k3.1-pro')).find(entry => entry.id === 'default').disabled, false)
})

test('页面：自定义的提供商不认伴随条目；目录里的提供商下手写的同形条目不列出、不改、不跟着删', async (t0) => {
  const relay = { displayName: 'My relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY', models: [{ id: 'x' }] }
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': relay }
  const snapshot = snapshotOf(providers)
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  // 协议混合的提供商总有「目录外的模型」这一块（fix#205 起手动「添加模型」在这里），但手写的同形条目不列进来：这一块是空的。
  const sections = react.all(node => node.props?.className === 'dms-sec' && textOf(node).startsWith('companionModels'))
  assert.equal(sections.length, 1)
  assert.match(textOf(sections[0]), /companionModelsEmpty/)
  react.fire(react.one(node => node.type === 'button' && textOf(node) === 'keyClear', '清除'), 'onClick')
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1].map(op => op.path.join('.')), ['providers.opencode-go.apiKeyEnv'])
  const modal = react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框')
  assert.doesNotMatch(modal.props.description, /deleteDescriptionWithCompanions/)
})

test('页面：自定义的提供商 foo 的详情页不把 foo--openai 当成自己的', async (t0) => {
  const foo = { entry: { provider: 'foo', displayName: 'foo', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'foo'], active: true, declared: true }, configured: true, removable: true, apiKeyEnv: 'FOO_API_KEY', api: 'openai-completions' }
  const providers = { foo: { displayName: 'foo', api: 'openai-completions', baseURL: 'https://foo.example/v1', apiKeyEnv: 'FOO_API_KEY', models: [{ id: 'a' }] }, 'foo--openai': { displayName: 'foo（OpenAI Chat Completions）', api: 'openai-completions', baseURL: 'https://other.example/v1', apiKeyEnv: 'OTHER', models: [{ id: 'b' }] } }
  const snapshot = { ...snapshotOf(providers), rows: [foo] }
  const { react, calls } = open(t0, snapshot, { row: foo })
  await react.settle()
  assert.equal(react.all(node => node.props?.className === 'dms-sec' && textOf(node).startsWith('companionModels')).length, 0)
  react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框').props.footer.props.children[1].props.onClick()
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1].map(op => `${op.op} ${op.path.join('.')}`), ['unset providers.foo'])
})

test('页面：删除原提供商时按最新的配置找伴随条目，带上 revision', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }
  const snapshot = snapshotOf(providers)
  // 打开页面之后，别处又建了一个伴随条目。
  const fresh = snapshotOf({ ...providers, 'opencode-go--anthropic': companionProfile('anthropic-messages', [{ id: 'minimax-m3.1-flash' }]) }, [], 9)
  const { react, calls } = open(t0, snapshot, { fresh })
  await react.settle()
  react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框').props.footer.props.children[1].props.onClick()
  await react.settle()
  const write = calls.find(call => call[0] === 'write')
  assert.deepEqual(write[1].map(op => `${op.op} ${op.path.join('.')}`), ['unset providers.opencode-go', 'unset providers.opencode-go--anthropic'])
  assert.equal(write[2], 9)
})

test('页面：伴随条目的地址看得见；存的不是可选地址（原提供商删了自定义地址）时算待保存，保存时改成目录地址', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--anthropic': companionProfile('anthropic-messages', [{ id: 'minimax-m3.1-flash' }], { baseURL: 'http://old-relay.example/go' }) }
  const snapshot = snapshotOf(providers, [companionRow('anthropic-messages', [{ id: 'minimax-m3.1-flash' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  const page = pageText(react)
  assert.match(page, /companionAddressStale \{"old":"http:\/\/old-relay.example\/go","url":"https:\/\/opencode.ai\/inference\/go"/)
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1], [{ op: 'set', path: ['providers', 'opencode-go--anthropic', 'baseURL'], value: 'https://opencode.ai/inference/go' }])
})

test('页面：原提供商写了自定义地址时，伴随条目的地址能在它和目录地址之间选，并写明为什么', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: 'http://relay.example/go/v1' }, 'opencode-go--anthropic': companionProfile('anthropic-messages', [{ id: 'minimax-m3.1-flash' }], { baseURL: 'http://relay.example/go/v1' }) }
  const snapshot = snapshotOf(providers, [companionRow('anthropic-messages', [{ id: 'minimax-m3.1-flash' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  assert.match(pageText(react), /companionAddressNote/)
  const select = react.one(node => node.type === 'select' && node.props['aria-label'] === 'companionAddress {"protocol":"anthropic-messages"}', '地址下拉')
  assert.deepEqual(select.children.map(option => option.props.value), ['http://relay.example/go/v1', 'https://opencode.ai/inference/go'])
  assert.equal(select.props.value, 'http://relay.example/go/v1')
  react.fire(select, 'onChange', { target: { value: 'https://opencode.ai/inference/go' } })
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1], [{ op: 'set', path: ['providers', 'opencode-go--anthropic', 'baseURL'], value: 'https://opencode.ai/inference/go' }])
})

test('页面：读不到安装包目录时写明，不沿用旧地址，有伴随条目时不让保存', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]) }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react } = open(t0, snapshot, { ops: { async catalogProtocols() { return { ok: false, reason: 'noCatalog' } } } })
  await react.settle()
  assert.match(pageText(react), /companionCatalogMissing/)
  react.fire(react.one(node => node.type === 'button' && textOf(node) === 'keyClear', '清除'), 'onClick')
  await react.settle()
  assert.equal(button(react, 'save').props.disabled, true)
})

test('页面：目录外模型的行有错时「保存」不可点', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]) }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react, client } = open(t0, snapshot)
  await react.settle()
  const editor = react.instancesOf(client.get('ModelsEditor')).find(item => item.props.heading === 'companionModels')
  editor.props.onChange([{ id: '', __api: 'openai-completions', __from: 'opencode-go--openai' }])
  await react.settle()
  assert.equal(button(react, 'save').props.disabled, true)
})

test('页面：选择器里「移除全部」只选中目录外的模型时，不把原提供商的目录固定下来', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]) }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  react.one(node => node.type === 'ui.SegmentedControl' && node.props.label === 'fetchTitle', '标签页').props.onChange('added')
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-candidate-search', '搜索框'), 'onChange', { target: { value: 'kimi-k3.1-pro' } })
  await react.settle()
  button(react, 'pickRemoveAll').props.onClick()
  await react.settle()
  react.one(node => node.type === 'ui.Modal' && node.props.title === 'fetchTitle', '选择模型').props.onClose()
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1], [{ op: 'unset', path: ['providers', 'opencode-go--openai'] }])
})

test('选择器：这种协议不能用时，「仅提供商返回」的行写明原因（Cloudflare 的地址要从环境变量拼、Copilot 要专用请求头）', async (t0) => {
  const providers = { 'opencode-go': {} }
  const snapshot = snapshotOf(providers)
  const { react } = open(t0, snapshot, { ops: { async catalogProtocols() { return { ...PROTOCOLS, protocols: {}, unusable: { 'openai-completions': 'template', 'anthropic-messages': 'headers' } } } } })
  await react.settle()
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  const rows = react.all(node => node.type === 'li' && /^(kimi-k3\.1-pro|minimax-m3\.1-flash)/.test(textOf(node)))
  assert.match(textOf(rows.find(row => textOf(row).startsWith('kimi'))), /onlyFromProviderUnusabletemplate \{"protocol":"openai-completions"\}/)
  assert.match(textOf(rows.find(row => textOf(row).startsWith('minimax'))), /onlyFromProviderUnusableheaders \{"protocol":"anthropic-messages"\}/)
})

test('凭据被占用的提示里写用户在列表上看得到的名字：伴随条目写它的原提供商', () => {
  const client = loadClient(CLIENT)
  const keyRefTakenText = client.get('keyRefTakenText')
  const go = goRow()
  const companion = { ...companionRow('openai-completions', []), apiKeyEnv: 'HAND_EDITED_KEY' }
  const text = keyRefTakenText({ t }, { rows: [go, companion] }, 'HAND_EDITED_KEY', ['opencode-go--openai'], 'keyRefTakenSave')
  assert.equal(text, 'keyRefTakenSave {"ref":"HAND_EDITED_KEY","provider":"OpenCode Go"}')
})

test('页面：在这一页给原提供商写上自定义地址时，用着默认地址的伴随条目跟过去；用户选过目录地址的不动', async (t0) => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go--anthropic': companionProfile('anthropic-messages', [{ id: 'minimax-m3.1-flash' }]),
    'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('anthropic-messages', [{ id: 'minimax-m3.1-flash' }]), companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-disc', '自定义设置'), 'onClick')
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-url-opencode-go', 'API 地址'), 'onChange', { target: { value: 'http://relay.example/go/v1' } })
  await react.settle()
  // Anthropic Messages 的选回目录地址。
  react.fire(react.one(node => node.type === 'select' && node.props['aria-label'] === 'companionAddress {"protocol":"anthropic-messages"}', '地址下拉'), 'onChange', { target: { value: 'https://opencode.ai/inference/go' } })
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1], [
    { op: 'set', path: ['providers', 'opencode-go', 'baseURL'], value: 'http://relay.example/go/v1' },
    { op: 'set', path: ['providers', 'opencode-go--openai', 'baseURL'], value: 'http://relay.example/go/v1' },
  ])
})

// ---- 第二轮复核：A 占用的路由、B 搬默认、C 兼容开关、D 删除顺序 ----
const relayProfile = { displayName: 'My relay', api: 'anthropic-messages', baseURL: 'https://relay.example', apiKeyEnv: 'RELAY_KEY', models: [{ id: 'relay-model' }] }
const relayRow = { entry: { provider: 'opencode-go--anthropic', displayName: 'My relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go--anthropic'], active: true, declared: true }, configured: true, removable: true, apiKeyEnv: 'RELAY_KEY', api: 'anthropic-messages' }

test('写入计划：被别的条目占着的路由不写（不建、不改、不删）', () => {
  const ops = companionPlan({ origin: 'opencode-go', current: {}, wanted: { 'anthropic-messages': [{ id: 'minimax-m3.1-flash' }] }, keyRef: 'K', entries: ENTRIES, nameFor, taken: ['opencode-go--anthropic'] })
  assert.deepEqual(ops, [])
})

test('A：路由被手写条目占着时，选择器里那种协议的行不能加，写明被哪个条目占着；保存不碰那个条目', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--anthropic': relayProfile }
  const snapshot = snapshotOf(providers, [relayRow])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  const minimax = react.all(node => node.type === 'li' && textOf(node).startsWith('minimax-m3.1-flash'))[0]
  assert.match(textOf(minimax), /onlyFromProviderOccupied \{"protocol":"anthropic-messages","name":"My relay"\}/)
  assert.equal(react.all(node => node.type === 'button' && node.props['aria-label'] === 'addModel minimax-m3.1-flash')[0].props.disabled, true)
  button(react, 'pickAddAll').props.onClick()
  await react.settle()
  react.one(node => node.type === 'ui.Modal' && node.props.title === 'fetchTitle', '选择模型').props.onClose()
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const write = calls.find(call => call[0] === 'write')[1]
  assert.equal(write.some(op => op.path[1] === 'opencode-go--anthropic'), false)
})

test('A：把模型的协议改到被占着的路由：下拉里那一项不可选并写明原因；硬改了「保存」禁用、写明原因', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'minimax-m3.1-flash' }]), 'opencode-go--anthropic': relayProfile }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'minimax-m3.1-flash' }]), relayRow])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith('minimax-m3.1-flash'), '行'), 'onClick')
  await react.settle()
  const select = react.one(node => node.type === 'select' && node.props['aria-label'] === 'protocol minimax-m3.1-flash', '协议下拉')
  const option = select.children.find(item => item.props.value === 'anthropic-messages')
  assert.equal(option.props.disabled, true)
  assert.match(textOf(option), /protocolOccupied \{"protocol":"anthropic-messages","name":"My relay"\}/)
  react.fire(select, 'onChange', { target: { value: 'anthropic-messages' } })
  await react.settle()
  assert.match(pageText(react), /companionOccupied \{"protocol":"anthropic-messages","name":"My relay"\}/)
  assert.equal(button(react, 'save').props.disabled, true)
  assert.equal(calls.some(call => call[0] === 'write'), false)
})

test('B：存密钥失败也照样把默认模型搬过去，页面写存密钥失败', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'minimax-m3.1-flash' }, { id: 'kimi-k3.1-pro' }]) }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'minimax-m3.1-flash' }, { id: 'kimi-k3.1-pro' }])])
  snapshot.catalog.default = { provider: 'opencode-go--openai', model: 'minimax-m3.1-flash' }
  const { react, calls } = open(t0, snapshot, { ops: { async storeCredential() { calls.push(['store']); return 'keychain locked' } } })
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-key-opencode-go', '密钥框'), 'onChange', { target: { value: 'sk-new-key-0001' } })
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith('minimax-m3.1-flash'), '行'), 'onClick')
  await react.settle()
  react.fire(react.one(node => node.type === 'select' && node.props['aria-label'] === 'protocol minimax-m3.1-flash', '协议下拉'), 'onChange', { target: { value: 'anthropic-messages' } })
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.filter(call => call[0] === 'default'), [['default', 'opencode-go--anthropic', 'minimax-m3.1-flash']])
  assert.match(pageText(react), /saveFailed/)
})

test('B：默认模型还在已经删掉的条目下、这个模型现在在别的条目里：写明，点一下改过去', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'minimax-m3.1-flash' }]) }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'minimax-m3.1-flash' }])])
  snapshot.catalog.default = { provider: 'opencode-go--anthropic', model: 'minimax-m3.1-flash' }
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  assert.match(pageText(react), /defaultDangling \{"model":"minimax-m3.1-flash","name":"companionName/)
  calls.length = 0
  react.fire(button(react, 'defaultRepair'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.filter(call => call[0] === 'default'), [['default', 'opencode-go--openai', 'minimax-m3.1-flash']])
})

test('C：伴随条目的兼容开关和现在的目录算出来的不一样：计入待保存，写明保存后改为什么', async (t0) => {
  const stale = companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro' }], { compat: { supportsStore: false, thinkingFormat: 'zai' } })
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': stale }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'kimi-k3.1-pro' }])])
  const { react, calls } = open(t0, snapshot)
  await react.settle()
  assert.match(pageText(react), /companionCompatStale \{"protocol":"openai-completions","compat":"maxTokensField: max_tokens, supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: true"\}/)
  assert.equal(button(react, 'save').props.disabled, false)
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write')[1], [{ op: 'set', path: ['providers', 'opencode-go--openai', 'compat'], value: INFO['openai-completions'].compat }])
})

test('D：删除原提供商先写配置，成功后才删凭据；写配置冲突时凭据原样保留', async (t0) => {
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }
  const snapshot = snapshotOf(providers)
  const conflict = open(t0, snapshot, { ops: { async writeSettings(ns, ops, revision) { conflict.calls.push(['write', ops, revision]); return { kind: 'conflict' } } } })
  await conflict.react.settle()
  conflict.react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框').props.footer.props.children[1].props.onClick()
  await conflict.react.settle()
  assert.equal(conflict.calls.some(call => call[0] === 'remove'), false)
  conflict.react.unmount()
  const ok = open(t0, snapshot)
  await ok.react.settle()
  ok.react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框').props.footer.props.children[1].props.onClick()
  await ok.react.settle()
  const order = ok.calls.filter(call => call[0] === 'write' || call[0] === 'remove').map(call => call[0])
  assert.deepEqual(order, ['write', 'remove'])
})

test('B：默认模型设在一个还存在的条目上（手写的同形条目），我们的条目里有同 ID 的模型：不说「在已删除的条目下」，不给按钮', async (t0) => {
  const relay = { ...relayProfile, models: [{ id: 'minimax-m3.1-flash' }] }
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': companionProfile('openai-completions', [{ id: 'minimax-m3.1-flash' }]), 'opencode-go--anthropic': relay }
  const snapshot = snapshotOf(providers, [companionRow('openai-completions', [{ id: 'minimax-m3.1-flash' }]), relayRow])
  snapshot.catalog.default = { provider: 'opencode-go--anthropic', model: 'minimax-m3.1-flash' }
  const { react } = open(t0, snapshot)
  await react.settle()
  assert.doesNotMatch(pageText(react), /defaultDangling/)
  assert.equal(react.all(node => node.type === 'ui.Button' && textOf(node) === 'defaultRepair').length, 0)
})

test('删除时配置已删、凭据没能删除：回到列表页，带着写明凭据名的提示', async (t0) => {
  const gone = []
  const providers = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }
  const snapshot = snapshotOf(providers)
  const { react } = open(t0, snapshot, { ops: { async removeCredential() { return 'keychain locked' } }, go: next => gone.push(next) })
  await react.settle()
  react.one(node => node.type === 'ui.Modal' && /^deleteTitle/.test(node.props.title), '删除确认框').props.footer.props.children[1].props.onClick()
  await react.settle()
  assert.equal(gone.length, 1)
  assert.equal(gone[0].page, 'list')
  assert.equal(gone[0].notice, 'deleteCredentialLeft {"ref":"OPENCODE_GO_API_KEY","message":"keychain locked"}')
  // 列表页把这条提示显示出来。
  const client = loadClient(CLIENT)
  const list = client.react
  const app = { t, schema, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } }, ops: {}, store: { async load() {}, getSnapshot: () => snapshot } }
  list.mount(list.React.createElement(client.get('ListPage'), { app, snapshot, go() {}, notice: gone[0].notice }))
  t0.after(() => list.unmount())
  await list.settle()
  assert.match(list.all(node => node.parent === undefined || node.parent === null).map(textOf).join('|'), /deleteCredentialLeft \{"ref":"OPENCODE_GO_API_KEY"/)
})

// ---- fix#147：目录外的模型也能设推理等级 ----
/** pi-ai 的 schema 里 reasoningEfforts 是 `false | { [档位]: 参数值 }`；dict 分支的键列出全部档位（官方 store.ts reasoningLevelChoices 读的就是这里）。 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const levelSchema = { ...schema, nodeAtPath: (_root, path) => (path.at(-1) === 'reasoningEfforts'
  ? { type: 'union', list: [{ type: 'const', value: false }, { type: 'dict', sKey: { type: 'union', list: LEVELS.map(value => ({ type: 'const', value })) } }] }
  : undefined) }
const openRow = async (react, id) => {
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith(id), `${id} 的行`), 'onClick')
  await react.settle()
}
const reasoningSwitch = react => react.all(node => node.type === 'ui.Switch' && node.props.label === 'modelReasoning')

test('fix#147 页面：目录外的模型（伴随条目）能打开推理等级，保存时写进那种协议的条目；目录里的模型照官方不给控件', async (t0) => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'kimi-k3' }] },
    'opencode-go--anthropic': companionProfile('anthropic-messages', [{ id: 'minimax-m3.1-flash' }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('anthropic-messages', [{ id: 'minimax-m3.1-flash' }])])
  const { react, calls } = open(t0, snapshot, { schemaOps: levelSchema })
  await react.settle()
  // 目录里的提供商自己的模型：展开了也没有推理等级。
  await openRow(react, 'kimi-k3')
  assert.equal(reasoningSwitch(react).length, 0)
  // 目录外的模型：有开关，打开后是 off、low、medium、high 四行。
  await openRow(react, 'minimax-m3.1-flash')
  const toggle = reasoningSwitch(react)
  assert.equal(toggle.length, 1)
  toggle[0].props.onChange(true)
  await react.settle()
  const levels = react.all(node => node.type === 'select' && node.props['aria-label'] === 'modelReasoningLevel').map(node => node.props.value)
  assert.deepEqual(levels, ['off', 'low', 'medium', 'high'])
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const write = calls.find(call => call[0] === 'write')[1]
  const models = write.find(op => op.path.join('.').startsWith('providers.opencode-go--anthropic')).value
  const saved = Array.isArray(models) ? models : models.models
  assert.deepEqual(saved.find(model => model.id === 'minimax-m3.1-flash').reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.equal(JSON.stringify(write).includes('__'), false)
})

test('fix#147 页面：Gemini API 的目录外模型只给 minimal、low、medium、high，参数值等于档位名；只剩 Off 时不让保存', async (t0) => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'opencode-go--gemini': companionProfile('google-generative-ai', [{ id: 'gemini-x-preview' }]),
    'opencode-go--openai': companionProfile('openai-completions', [{ id: 'kimi-k3.1-pro', reasoningEfforts: { off: null } }]),
  }
  const snapshot = snapshotOf(providers, [companionRow('google-generative-ai', [{ id: 'gemini-x-preview' }]), companionRow('openai-completions', [{ id: 'kimi-k3.1-pro', reasoningEfforts: { off: null } }])])
  const { react } = open(t0, snapshot, { schemaOps: levelSchema })
  await react.settle()
  await openRow(react, 'gemini-x-preview')
  reasoningSwitch(react)[0].props.onChange(true)
  await react.settle()
  const selects = react.all(node => node.type === 'select' && node.props['aria-label'] === 'modelReasoningLevel')
  assert.deepEqual(selects.map(node => node.props.value), ['low', 'medium', 'high'])
  assert.deepEqual(selects[0].children.map(option => option.props.value), ['low', 'minimal'])
  // 另一行（OpenAI Chat Completions）只写了 Off：报「至少一个 Off 以外的档位」，保存不可点。
  assert.match(pageText(react), /modelReasoningNeedsLevel/)
  assert.equal(button(react, 'save').props.disabled, true)
})

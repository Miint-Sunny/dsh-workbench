/** 模型设置的网页端和逻辑（从 dsh-model-settings 的 test/logic.test.mjs 搬来，feat#217）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiKeyFailure, requestUrlPreview, routeIdFailure, routeIdFromName } from '../src/client/model-settings/keys.js'
import { deriveKeyRef } from '../lib/model-settings/key-ref.js'
import { adoptCandidate, discoveryFailure, formatCapacity, inputTypesOf, parseCapacity, patchModel, pathOps, pickCheckModel, validateModels, validateReasoningEfforts, withInputTypes } from '../src/client/model-settings/models.js'
import { FAMILIES, entriesIn, pickerEntries, routeMeta, searchEntries } from '../src/client/model-settings/catalog.js'
import { catalogFactsOf, joinDirectory, keyRefOf, providerUsable, rowStatus } from '../src/client/model-settings/status.js'
import { MODEL_SETTINGS_EN as en, MODEL_SETTINGS_ZH as zh } from '../src/client/model-settings/copy.js'
import { addPickedModels, defaultModelPickerTab, modelPickerEntries, modelPickerView, removeModelsById } from '../src/client/model-settings/models.js'

test('凭据名照内置页的规则派生，media look 依赖这几个名字', () => {
  assert.equal(deriveKeyRef('google'), 'GOOGLE_API_KEY')
  assert.equal(deriveKeyRef('xiaomi'), 'XIAOMI_API_KEY')
  assert.equal(deriveKeyRef('openai'), 'OPENAI_API_KEY')
  assert.equal(deriveKeyRef('moss'), 'MOSS_API_KEY')
  assert.equal(deriveKeyRef('zai-coding-cn'), 'ZAI_CODING_CN_API_KEY')
})

test('API 密钥格式：空输入表示保持，粘贴的环境变量行和带引号的都算错', () => {
  assert.equal(apiKeyFailure(''), undefined)
  assert.equal(apiKeyFailure('   '), 'keyBlank')
  assert.equal(apiKeyFailure('sk-abc123'), undefined)
  assert.equal(apiKeyFailure('  sk-abc123\n'), undefined)
  assert.equal(apiKeyFailure('OPENAI_API_KEY=sk-abc'), 'keyIllegalCharacters')
  assert.equal(apiKeyFailure('"sk-abc"'), 'keyIllegalCharacters')
  assert.equal(apiKeyFailure('sk abc'), 'keyIllegalCharacters')
  assert.equal(apiKeyFailure('密钥'), 'keyIllegalCharacters')
  assert.equal(apiKeyFailure('ABCD=='), undefined)
})

test('Provider ID：按显示名称生成建议值，检查格式和重复', () => {
  assert.equal(routeIdFromName('MOSS Pro'), 'moss-pro')
  assert.equal(routeIdFromName('我的中转站'), '')
  assert.equal(routeIdFromName('2x Relay!'), 'x-relay')
  assert.equal(routeIdFromName('  OpenAI 兼容  '), 'openai')
  assert.equal(routeIdFailure('', []), undefined)
  assert.equal(routeIdFailure('moss', ['opencode-go']), undefined)
  assert.equal(routeIdFailure('Moss', []), 'customRouteInvalid')
  assert.equal(routeIdFailure('1moss', []), 'customRouteInvalid')
  assert.equal(routeIdFailure('moss--pro', []), 'customRouteInvalid')
  assert.equal(routeIdFailure('opencode-go', ['opencode-go']), 'customRouteTaken')
})

test('实际请求地址按协议补路径，地址无效时不预览', () => {
  assert.equal(requestUrlPreview('https://gateway.example/v1/', 'openai-completions'), 'https://gateway.example/v1/chat/completions')
  assert.equal(requestUrlPreview('https://gateway.example/v1', 'openai-responses'), 'https://gateway.example/v1/responses')
  assert.equal(requestUrlPreview('https://gateway.example', 'anthropic-messages'), 'https://gateway.example/v1/messages')
  assert.equal(requestUrlPreview('gateway.example', 'openai-completions'), undefined)
  assert.equal(requestUrlPreview('https://gateway.example', 'google-generative-ai'), undefined)
})

test('容量可以写 256K、1M，写回时用最短的写法', () => {
  assert.equal(parseCapacity('256K'), 256_000)
  assert.equal(parseCapacity('1m'), 1_000_000)
  assert.equal(parseCapacity('2.3M'), 2_300_000)
  assert.equal(parseCapacity(' '), undefined)
  assert.ok(Number.isNaN(parseCapacity('lots')))
  assert.equal(formatCapacity(128_000), '128K')
  assert.equal(formatCapacity(1_000_000), '1M')
  assert.equal(formatCapacity(131_072), '131072')
})

test('模型校验按行报出第一处错误', () => {
  assert.equal(validateModels(undefined), undefined)
  assert.deepEqual(validateModels([{ id: 'a' }, { id: ' ' }]), { index: 1, key: 'modelIdRequired' })
  assert.deepEqual(validateModels([{ id: 'a' }, { id: 'a ' }]), { index: 1, key: 'modelIdDuplicate' })
  assert.deepEqual(validateModels([{ id: 'a', name: '' }]), { index: 0, key: 'modelNameInvalid' })
  assert.deepEqual(validateModels([{ id: 'a', contextWindow: Number.NaN }]), { index: 0, key: 'modelContextInvalid' })
  assert.deepEqual(validateModels([{ id: 'a', maxTokens: 1.5 }]), { index: 0, key: 'modelMaxTokensInvalid' })
  assert.equal(validateModels([{ id: 'a', contextWindow: 1_000_000, maxTokens: 128_000 }]), undefined)
})

test('推理等级：Off 以外要有参数值，至少一个 Off 以外的档位', () => {
  assert.equal(validateReasoningEfforts([{ id: 'a' }]), undefined)
  assert.equal(validateReasoningEfforts([{ id: 'a', reasoningEfforts: { off: null, high: 'high' } }]), undefined)
  assert.deepEqual(validateReasoningEfforts([{ id: 'a', reasoningEfforts: { off: null } }]), { index: 0, key: 'modelReasoningNeedsLevel' })
  assert.deepEqual(validateReasoningEfforts([{ id: 'a', reasoningEfforts: { high: '' } }]), { index: 0, key: 'modelReasoningValueRequired' })
  assert.deepEqual(validateReasoningEfforts([{ id: 'a', reasoningEfforts: null }]), { index: 0, key: 'modelReasoningNeedsLevel' })
})

test('输入类型：pi-ai 写 input，DeepSeek 写 inputModalities，去掉图片时连图片上限一起去掉', () => {
  assert.deepEqual(adoptCandidate({ id: 'm', inputModalities: ['text', 'image'] }, 'pi-ai'), { id: 'm', input: ['text', 'image'] })
  assert.deepEqual(inputTypesOf({ id: 'm' }, 'pi-ai', ['text', 'image']), ['text', 'image'])
  assert.deepEqual(inputTypesOf({ id: 'm' }, 'pi-ai', undefined), ['text'])
  assert.deepEqual(inputTypesOf({ id: 'm', input: ['text'] }, 'pi-ai', ['text', 'image']), ['text'])
  assert.deepEqual(withInputTypes({ id: 'd', inputModalities: ['text', 'image'], imagePixelBudget: 1, imageMaxBytes: 2 }, 'deepseek', ['text']), { id: 'd', inputModalities: ['text'] })
  assert.deepEqual(patchModel({ id: 'a', name: 'A', maxTokens: 5 }, { name: '', maxTokens: undefined, contextWindow: 9 }), { id: 'a', contextWindow: 9 })
})

test('获取可用模型失败：DSH 的英文原文归成能照着修的几类', () => {
  assert.deepEqual(discoveryFailure('http://127.0.0.1:3393/v1/models answered 401; check the API key'), { key: 'fetchAuth', vars: { status: 401 } })
  assert.deepEqual(discoveryFailure('https://x.example/v1/models answered 404'), { key: 'fetchNotFound' })
  assert.deepEqual(discoveryFailure('could not reach https://gateway.example/v1/models'), { key: 'fetchUnreachable', vars: { host: 'gateway.example' } })
  assert.deepEqual(discoveryFailure('pi-ai protocol "google-generative-ai" has no model listing this build can read; enter this provider\'s models by hand'), { key: 'fetchUnsupported' })
  assert.deepEqual(discoveryFailure('https://x.example/v1/models did not answer with JSON'), { key: 'fetchNotJson' })
  assert.deepEqual(discoveryFailure('something else'), { key: 'fetchFailed', vars: { message: 'something else' } })
})

test('路径操作只写改过的字段', () => {
  assert.deepEqual(pathOps(['providers', 'x'], { baseURL: 'a', models: [1] }, { baseURL: 'b', models: [1], apiKeyEnv: 'X_API_KEY' }), [
    { op: 'set', path: ['providers', 'x', 'baseURL'], value: 'b' },
    { op: 'set', path: ['providers', 'x', 'apiKeyEnv'], value: 'X_API_KEY' },
  ])
  assert.deepEqual(pathOps([], { models: [1] }, {}), [{ op: 'unset', path: ['models'] }])
  assert.deepEqual(pathOps([], undefined, {}), [])
})

test('产品名表：路由不重复，变体都有域名', () => {
  const routes = FAMILIES.flatMap(family => family.variants.map(variant => variant.route))
  assert.equal(new Set(routes).size, routes.length)
  for (const family of FAMILIES) for (const variant of family.variants) assert.ok(variant.domain, variant.route)
  assert.deepEqual([routeMeta('zai-coding-cn').name, routeMeta('zai-coding-cn').tag], ['智谱 GLM Coding Plan', '国内'])
  assert.equal(routeMeta('opencode-go').name, 'OpenCode Go')
  assert.equal(routeMeta('opencode-go').tag, undefined)
  assert.equal(routeMeta('deepseek-official').name, 'DeepSeek')
  const unknown = routeMeta('moss', { displayName: 'MOSS Pro', defaultBaseURL: 'https://gateway.example/v1' })
  assert.deepEqual([unknown.name, unknown.domain, unknown.known, unknown.initials], ['MOSS Pro', 'gateway.example', false, 'MP'])
})

test('添加页：同一家的变体合成一行，已添加的标出来，表外的路由也能加', () => {
  const rows = [
    { provider: 'zai-coding-cn', configured: true }, { provider: 'zai', configured: false },
    { provider: 'google', configured: false }, { provider: 'google-vertex', configured: false },
    { provider: 'brand-new', configured: false, displayName: 'brand-new' },
  ]
  const entries = pickerEntries(rows)
  const zhipu = entries.find(entry => entry.family.id === 'zhipu')
  assert.deepEqual(zhipu.variants.map(variant => [variant.route, variant.added]), [['zai-coding-cn', true], ['zai', false]])
  assert.equal(zhipu.allAdded, false)
  assert.ok(entries.some(entry => entry.family.id === 'brand-new' && entry.category === 'other'))
  assert.equal(entries.some(entry => entry.family.id === 'kimi'), false)
  assert.deepEqual(searchEntries(entries, 'gem').map(entry => entry.family.id), ['google', 'vertex'])
  assert.deepEqual(searchEntries(entries, '智谱').map(entry => entry.family.id), ['zhipu'])
  assert.deepEqual(searchEntries(entries, 'bigmodel').map(entry => entry.family.id), ['zhipu'])
  assert.deepEqual(searchEntries(entries, 'zzz'), [])
  // 常用照定好的顺序（feat#190）；火山方舟是预设，不看目录里有没有。
  assert.deepEqual(entriesIn(entries, 'common').map(entry => entry.family.id), ['zhipu', 'ark', 'google'])
  assert.deepEqual(entriesIn(entries, 'cloud').map(entry => entry.family.id), ['vertex'])
})

test('目录拼接：DeepSeek 账号和 DeepSeek 在前，未声明的路由补在后面', () => {
  const directory = [
    { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  ]
  const rows = joinDirectory([{ id: 'opencode-go', name: 'opencode-go' }, { id: 'deepseek-account', name: 'DeepSeek Account' }], directory)
  assert.deepEqual(rows.map(row => [row.provider, row.active]), [['deepseek-account', true], ['deepseek-official', false], ['opencode-go', true]])
})

test('状态：检查失败 > 已登录 > 目录出错 > 密钥', () => {
  const base = { entry: { provider: 'google', active: true, nativeAuth: { env: ['GEMINI_API_KEY'], oauth: false } } }
  assert.deepEqual(rowStatus({ ...base, apiKeyEnv: 'GOOGLE_API_KEY', credential: { configured: true, source: 'file', writable: true } }), { tone: 'ok', key: 'statusKeyConfigured' })
  assert.deepEqual(rowStatus({ ...base, apiKeyEnv: 'GOOGLE_API_KEY', credential: { configured: true, source: 'env', writable: true } }), { tone: 'ok', key: 'statusEnv', vars: { name: 'GOOGLE_API_KEY' } })
  assert.deepEqual(rowStatus({ ...base, apiKeyEnv: 'GOOGLE_API_KEY', credential: { configured: false, writable: true } }), { tone: 'warn', key: 'statusKeyMissing' })
  assert.deepEqual(rowStatus({ ...base, apiKeyEnv: 'GOOGLE_API_KEY', credential: { configured: true, source: 'file', writable: true } }, { check: { ok: false, reason: 'auth', status: 401 } }), { tone: 'err', key: 'statusCheckFailed' })
  assert.deepEqual(rowStatus({ ...base, credentialChecks: { GEMINI_API_KEY: { configured: true, source: 'env', writable: true } } }), { tone: 'ok', key: 'statusEnv', vars: { name: 'GEMINI_API_KEY' } })
  assert.deepEqual(rowStatus({ ...base, credentialChecks: {} }), { tone: 'warn', key: 'statusKeyMissing' })
  assert.deepEqual(rowStatus({ entry: { provider: 'openai-codex', active: true, nativeAuth: { env: [], oauth: true } } }), { tone: 'ok', key: 'statusNoKeyNeeded' })
  assert.deepEqual(rowStatus({ entry: { provider: 'deepseek-account', active: true } }), { tone: 'ok', key: 'statusSignedIn' })
  assert.deepEqual(rowStatus({ ...base, apiKeyEnv: 'X', credential: { configured: true, writable: true } }, { catalogFailure: 'boom' }), { tone: 'err', key: 'statusCatalogError', vars: { message: 'boom' } })
  assert.equal(keyRefOf({ ...base }), 'GOOGLE_API_KEY')
  assert.equal(providerUsable({ ...base, apiKeyEnv: 'GOOGLE_API_KEY', credential: { configured: false } }), false)
  assert.equal(providerUsable({ entry: { provider: 'opencode-go', active: true } }), true)
})

test('模型目录给卡片的数字：模型数、默认模型、目录出错', () => {
  const catalog = { default: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, groups: [{ id: 'opencode-go', models: [{ id: 'a' }, { id: 'b' }] }], failures: [{ id: 'zai', message: 'HTTP 500' }] }
  assert.deepEqual(catalogFactsOf('opencode-go', catalog), { count: 2, defaultModel: 'deepseek-v4.1-flash' })
  assert.deepEqual(catalogFactsOf('zai', catalog), { failure: 'HTTP 500' })
  assert.deepEqual(catalogFactsOf('x', undefined), {})
  // 协议混合的提供商：伴随条目的模型算进原提供商，默认模型在伴随条目里时也算原提供商的。
  const mixed = { default: { provider: 'opencode-go--openai', model: 'kimi-k3.1-pro' }, groups: [{ id: 'opencode-go', models: [{ id: 'a' }] }, { id: 'opencode-go--openai', models: [{ id: 'kimi-k3.1-pro' }] }] }
  assert.deepEqual(catalogFactsOf('opencode-go', mixed, ['opencode-go--openai']), { count: 2, defaultModel: 'kimi-k3.1-pro' })
  assert.deepEqual(catalogFactsOf('opencode-go', mixed), { count: 1 })
})

test('中英文案的键一一对应', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('检查连接挑模型：默认模型在这一家就用它，否则跳过专用模型，先挑轻量档再挑快速档', () => {
  assert.equal(pickCheckModel(['gemini-2.5-pro', 'gemini-2.5-flash'], 'gemini-2.5-pro'), 'gemini-2.5-pro')
  const gemini = ['deep-research-max-preview-04-2026', 'deep-research-preview-04-2026', 'gemini-2.5-computer-use-preview-10-2025', 'gemini-2.5-flash',
    'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-live-preview', 'gemini-3.5-flash-lite', 'gemini-flash-latest',
    'gemini-flash-lite-latest', 'gemma-4-31b-it']
  assert.equal(pickCheckModel(gemini, undefined), 'gemini-flash-lite-latest')
  assert.equal(pickCheckModel(gemini.filter(id => !id.includes('latest')), undefined), 'gemini-3.5-flash-lite')
  assert.equal(pickCheckModel(['gemini-2.5-pro', 'gemini-2.5-flash', 'deep-research-preview-04-2026'], undefined), 'gemini-2.5-flash')
  assert.equal(pickCheckModel(['claude-opus-4-5', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-4-5'], undefined), 'claude-haiku-5-5')
  assert.equal(pickCheckModel(['gpt-5', 'gpt-5-mini', 'gpt-4o-mini-tts', 'text-embedding-3-small', 'gpt-image-1'], undefined), 'gpt-5-mini')
  assert.equal(pickCheckModel(['moss-pro-2', 'moss-pro-2-thinking', 'moss-lite-2'], undefined), 'moss-lite-2')
  // 词中间的 mini 不算轻量档：MiniMax、Gemini 都不是 mini 模型。
  assert.equal(pickCheckModel(['minimax-m2', 'gemini-pro'], undefined), 'gemini-pro')
  assert.equal(pickCheckModel(['deep-research-pro'], undefined), 'deep-research-pro')
  assert.equal(pickCheckModel([], undefined), undefined)
})

const pickerCandidates = [
  { id: 'a-flash', name: 'A Flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
  { id: 'b-pro', name: 'B Pro' },
  { id: 'c-lite', name: 'C Lite', inputModalities: ['text'] },
]

test('模型选择器的行：提供商公布的按原顺序，列表里有而提供商没公布的自定义模型排在后面', () => {
  const rows = [{ id: 'b-pro', name: 'B Pro (edited)' }, { id: 'own-x', name: 'Own X' }, { id: '' }, { id: 'a-flash' }]
  const entries = modelPickerEntries([...pickerCandidates, pickerCandidates[0]], rows)
  assert.deepEqual(entries.map(entry => [entry.id, entry.added]), [['a-flash', true], ['b-pro', true], ['c-lite', false], ['own-x', true]])
  assert.equal(entries[1].candidate, pickerCandidates[1])
  assert.equal(entries[3].candidate, undefined)
  assert.equal(entries[3].name, 'Own X')
})

test('选择器的视图：标签页和搜索一起算，数量是搜索结果里各类的个数', () => {
  const entries = modelPickerEntries(pickerCandidates, [{ id: 'b-pro' }])
  assert.deepEqual(modelPickerView(entries, { tab: 'all', query: '' }).counts, { all: 3, added: 1, notAdded: 2 })
  assert.deepEqual(modelPickerView(entries, { tab: 'notAdded', query: '' }).visible.map(entry => entry.id), ['a-flash', 'c-lite'])
  assert.deepEqual(modelPickerView(entries, { tab: 'added', query: '' }).visible.map(entry => entry.id), ['b-pro'])
  const searched = modelPickerView(entries, { tab: 'all', query: '  LITE ' })
  assert.deepEqual(searched.visible.map(entry => entry.id), ['c-lite'])
  assert.deepEqual(searched.counts, { all: 1, added: 0, notAdded: 1 })
  assert.deepEqual(modelPickerView(entries, { tab: 'all', query: 'b pro' }).visible.map(entry => entry.id), ['b-pro'])
  assert.deepEqual(modelPickerView(entries, { tab: 'added', query: 'flash' }).visible, [])
})

test('打开选择器先看哪个标签页：有没加的就看没加的，都加了就看全部', () => {
  assert.equal(defaultModelPickerTab(modelPickerEntries(pickerCandidates, [{ id: 'a-flash' }])), 'notAdded')
  assert.equal(defaultModelPickerTab(modelPickerEntries(pickerCandidates, pickerCandidates.map(candidate => ({ id: candidate.id })))), 'all')
  assert.equal(defaultModelPickerTab(modelPickerEntries(pickerCandidates, [...pickerCandidates.map(candidate => ({ id: candidate.id })), { id: 'own-x' }])), 'all')
})

test('添加只加没加过的、保持原顺序、带上提供商公布的容量和输入类型；删除按 ID，已有的行不动', () => {
  const rows = [{ id: 'b-pro', name: 'edited' }]
  const entries = modelPickerEntries(pickerCandidates, rows)
  const next = addPickedModels(rows, entries, 'pi-ai')
  assert.deepEqual(next.map(row => row.id), ['b-pro', 'a-flash', 'c-lite'])
  assert.equal(next[0].name, 'edited')
  assert.deepEqual(next[1], { id: 'a-flash', name: 'A Flash', contextWindow: 1_000_000, input: ['text', 'image'] })
  assert.equal(addPickedModels(rows, [entries[1]], 'pi-ai'), rows)
  assert.deepEqual(addPickedModels(rows, [entries[2]], 'pi-ai').map(row => row.id), ['b-pro', 'c-lite'])
  assert.deepEqual(removeModelsById(next, new Set(['a-flash', 'nobody'])).map(row => row.id), ['b-pro', 'c-lite'])
  assert.deepEqual(removeModelsById(next, new Set()).map(row => row.id), ['b-pro', 'a-flash', 'c-lite'])
})

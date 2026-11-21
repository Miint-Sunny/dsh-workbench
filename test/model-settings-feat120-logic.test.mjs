/** 模型设置（从 dsh-model-settings 的 test/feat120-logic.test.mjs 搬来，feat#217）。 feat#120：官方 rc.2 并进来的逻辑（逐字段写配置、Gemini 规则、重试策略、目录和提供商列表合并、状态、密钥框）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveModel, pathOps, validateReasoningEfforts } from '../src/client/model-settings/models.js'
import { GEMINI, protocolNeedsKey, protocolProbeOrder, protocolReasoningLevels } from '../src/client/model-settings/protocol.js'
import { retryPolicyDefaults, retryPolicyFailure } from '../src/client/model-settings/retry.js'
import { mergeCandidates, modelDataIncomplete } from '../src/client/model-settings/discovery.js'
import { keyViewOf, rowStatus } from '../src/client/model-settings/status.js'
import { MODEL_SETTINGS_EN as en, MODEL_SETTINGS_ZH as zh } from '../src/client/model-settings/copy.js'

test('写配置逐字段：嵌套对象只写改过的叶子，继承的字段保持继承', () => {
  const before = { baseURL: 'https://a.example', retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 500 } } }
  const after = { baseURL: 'https://a.example', retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 800, maxDelayMs: 9000 } } }
  assert.deepEqual(pathOps(['providers', 'g'], before, after), [
    { op: 'set', path: ['providers', 'g', 'retryPolicy', 'backoff', 'initialDelayMs'], value: 800 },
    { op: 'set', path: ['providers', 'g', 'retryPolicy', 'backoff', 'maxDelayMs'], value: 9000 },
  ])
  assert.deepEqual(pathOps([], { retryPolicy: { mode: 'always' } }, {}), [{ op: 'unset', path: ['retryPolicy'] }])
  assert.deepEqual(pathOps([], { models: [{ id: 'a' }] }, { models: [{ id: 'b' }] }), [{ op: 'set', path: ['models'], value: [{ id: 'b' }] }])
  assert.deepEqual(pathOps([], { retryPolicy: 'x' }, { retryPolicy: { mode: 'normal' } }), [{ op: 'set', path: ['retryPolicy'], value: { mode: 'normal' } }])
})

test('Gemini API：要密钥，推理档位只能是四档、参数值和档位同名', () => {
  assert.equal(GEMINI, 'google-generative-ai')
  assert.equal(protocolNeedsKey(GEMINI), true)
  assert.equal(protocolNeedsKey('openai-completions'), false)
  assert.equal(protocolNeedsKey(undefined), false)
  assert.deepEqual(protocolReasoningLevels(GEMINI, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']), { levels: ['minimal', 'low', 'medium', 'high'], levelsOnly: true })
  assert.deepEqual(protocolReasoningLevels('anthropic-messages', ['off', 'high']), { levels: ['off', 'high'], levelsOnly: false })
  const only = ['minimal', 'low', 'medium', 'high']
  assert.deepEqual(validateReasoningEfforts([{ id: 'm', reasoningEfforts: { low: 'low', xhigh: 'xhigh' } }], only), { index: 0, key: 'modelReasoningLevelsOnly' })
  assert.deepEqual(validateReasoningEfforts([{ id: 'm', reasoningEfforts: { low: 'lo' } }], only), { index: 0, key: 'modelReasoningLevelsOnly' })
  assert.equal(validateReasoningEfforts([{ id: 'm', reasoningEfforts: { low: 'low', high: 'high' } }], only), undefined)
  assert.equal(validateReasoningEfforts([{ id: 'm', reasoningEfforts: { low: 'lo' } }]), undefined)
})

test('自动识别协议的顺序：googleapis 或 /v1beta 先问 Gemini；手动选了就只问那一种', () => {
  const all = ['openai-completions', 'openai-responses', 'anthropic-messages', GEMINI]
  assert.deepEqual(protocolProbeOrder('https://generativelanguage.googleapis.com/v1beta', all), [GEMINI, 'openai-completions', 'anthropic-messages'])
  assert.deepEqual(protocolProbeOrder('https://gateway.example/v1beta', all), [GEMINI, 'openai-completions', 'anthropic-messages'])
  assert.deepEqual(protocolProbeOrder('https://gateway.example/anthropic', all), ['anthropic-messages', 'openai-completions', GEMINI])
  assert.deepEqual(protocolProbeOrder('https://gateway.example/v1', all), ['openai-completions', 'anthropic-messages', GEMINI])
  assert.deepEqual(protocolProbeOrder('https://gateway.example/v1', ['openai-completions', 'anthropic-messages']), ['openai-completions', 'anthropic-messages'])
  assert.deepEqual(protocolProbeOrder('https://gateway.example/v1', all, 'openai-responses'), ['openai-responses'])
})

/** 照 DSH 的重试策略 schema 搭的最小节点：两个模式分支，数字带 min/max/step，错误码数组的元素是 const 加字符串的 union。 */
function retrySchema() {
  const number = (meta = {}) => ({ type: 'number', meta })
  const backoff = { type: 'object', meta: {}, dict: { initialDelayMs: number({ min: Number.MIN_VALUE, max: 60000, default: 500 }), maxDelayMs: number({ min: Number.MIN_VALUE, max: 60000, default: 10000 }), jitterRatio: number({ min: 0, max: 1, default: 0.1 }) } }
  const codes = { type: 'array', meta: { default: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] }, inner: { type: 'union', list: [{ type: 'const', value: 'EMPTY_RESPONSE' }, { type: 'const', value: 'QUOTA' }, { type: 'string' }] } }
  const normal = { type: 'object', meta: {}, dict: { mode: { type: 'const', value: 'normal' }, maxRetries: number({ min: 0, step: 1, default: 5 }), retryableCodes: codes, backoff } }
  const always = { type: 'object', meta: {}, dict: { mode: { type: 'const', value: 'always' }, backoff } }
  return { type: 'union', meta: {}, list: [normal, always] }
}
const schemaOps = {
  getPath: (value, path) => path.reduce((at, key) => (typeof at === 'object' && at !== null ? at[key] : undefined), value),
  nodeAtPath: (node, path) => path.reduce((at, key) => at?.dict?.[key], node),
  validate: (_node, value) => (Array.isArray(value?.retryableCodes) && value.retryableCodes.length === 0 ? '至少一项' : undefined),
}

test('重试策略：默认模式取继承值，没有就取第一个分支；只有声明了模式的分支才算', () => {
  const node = retrySchema()
  const inherited = retryPolicyDefaults(schemaOps, node, { mode: 'always' })
  assert.deepEqual(inherited.modes, ['normal', 'always'])
  assert.equal(inherited.mode, 'always')
  const fresh = retryPolicyDefaults(schemaOps, node, undefined)
  assert.equal(fresh.mode, 'normal')
  assert.equal(fresh.value(fresh.branch('normal'), ['maxRetries']), 5)
  assert.equal(retryPolicyDefaults(schemaOps, node, { backoff: { initialDelayMs: 900 } }).value(fresh.branch('normal'), ['backoff', 'initialDelayMs']), 900)
})

test('重试策略的校验：数字、整数、大于 0、上下限、错误码重复、初始延迟不大于最大延迟', () => {
  const node = retrySchema()
  const defaults = retryPolicyDefaults(schemaOps, node, undefined)
  const t = key => key
  const fail = policy => retryPolicyFailure(schemaOps, node, policy, defaults, t)
  assert.equal(fail(undefined), undefined)
  assert.equal(fail({ mode: 'normal' }), undefined)
  assert.deepEqual(fail({ mode: 'normal', maxRetries: 'abc' }), { message: 'retryValueNumber', path: ['maxRetries'] })
  assert.deepEqual(fail({ mode: 'normal', maxRetries: 1.5 }), { message: 'retryValueInteger', path: ['maxRetries'] })
  assert.deepEqual(fail({ mode: 'normal', backoff: { initialDelayMs: 0 } }), { message: 'retryValuePositive', path: ['backoff', 'initialDelayMs'] })
  assert.deepEqual(fail({ mode: 'normal', backoff: { jitterRatio: 2 } }), { message: 'retryValueMax', path: ['backoff', 'jitterRatio'] })
  assert.deepEqual(fail({ mode: 'normal', retryableCodes: ['QUOTA', 'QUOTA'] }), { message: 'retryCodesDuplicate', path: ['retryableCodes'] })
  assert.deepEqual(fail({ mode: 'always', backoff: { initialDelayMs: 20000 } }), { message: 'retryDelayOrder', path: ['backoff', 'initialDelayMs'] })
  assert.deepEqual(fail({ mode: 'normal', retryableCodes: [] }), { message: '至少一项' })
})

test('获取可用模型的结果：安装包目录和提供商列表合在一起，只在提供商返回里有的标出来', () => {
  const catalog = [{ id: 'a', name: 'A', contextWindow: 1000 }, { id: 'b', name: 'B' }]
  const live = [{ id: 'b', name: 'B live' }, { id: 'c', name: 'c', contextWindow: 2000 }]
  assert.deepEqual(mergeCandidates(catalog, live, true), [
    { id: 'a', name: 'A', contextWindow: 1000, origin: 'catalog' },
    { id: 'b', name: 'B', origin: 'both' },
    { id: 'c', name: 'c', contextWindow: 2000, origin: 'provider' },
  ])
  assert.deepEqual(mergeCandidates(catalog, live, false).at(-1), { id: 'c', name: 'c', contextWindow: 2000, origin: 'provider', blocked: true })
  assert.deepEqual(mergeCandidates(catalog, undefined, true).map(c => c.origin), ['catalog', 'catalog'])
  // 自定义地址没有安装包目录，列表全是向它请求来的，不标「仅提供商返回」。
  assert.deepEqual(mergeCandidates(undefined, live, true).map(c => c.origin), ['endpoint', 'endpoint'])
})

test('「数据不全」：目录里的提供商，目录外的模型缺上下文窗口或最大输出时标出来', () => {
  const catalogIds = new Set(['a'])
  assert.equal(modelDataIncomplete({ id: 'a' }, catalogIds), false)
  assert.equal(modelDataIncomplete({ id: 'c' }, catalogIds), true)
  assert.equal(modelDataIncomplete({ id: 'c', contextWindow: 1, maxTokens: 2 }, catalogIds), false)
  assert.equal(modelDataIncomplete({ id: 'c', contextWindow: 1 }, catalogIds), true)
  assert.equal(modelDataIncomplete({ id: 'c' }, undefined), false)
})

test('模型排序：移到指定位置，越界时贴边', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(moveModel(rows, 2, 0).map(r => r.id), ['c', 'a', 'b'])
  assert.deepEqual(moveModel(rows, 0, 9).map(r => r.id), ['b', 'c', 'a'])
  assert.deepEqual(moveModel(rows, 1, 1).map(r => r.id), ['a', 'b', 'c'])
})

/** 一行提供商，字段照 store.js 拼出来的。 */
const row = (extra = {}) => ({ entry: { provider: 'p', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p'], active: true, ...extra.entry }, configured: true, ...extra, entry: { provider: 'p', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p'], active: true, ...extra.entry } })

test('状态：未运行排在密钥前面；Gemini API 没密钥算缺失', () => {
  assert.deepEqual(rowStatus(row({ entry: { active: false }, apiKeyEnv: 'P_API_KEY', credential: { configured: true } })), { tone: 'err', key: 'statusNotRunning' })
  assert.deepEqual(rowStatus(row({ entry: { active: false, error: 'bad protocol' } })), { tone: 'err', key: 'statusNotRunningWhy', vars: { message: 'bad protocol' } })
  assert.deepEqual(rowStatus(row({ entry: { declared: true }, api: GEMINI })), { tone: 'warn', key: 'statusKeyMissing' })
  assert.deepEqual(rowStatus(row({ entry: { declared: true }, api: 'openai-completions' })), { tone: 'ok', key: 'statusNoKeyNeeded' })
  assert.deepEqual(rowStatus(row({ entry: { provider: 'deepseek-account', active: true } })), { tone: 'ok', key: 'statusSignedIn' })
})

test('密钥框：已保存的显示预览、能清除；不可写或别人在用时不能清除；环境变量和未配置', () => {
  const saved = row({ apiKeyEnv: 'P_API_KEY', credential: { configured: true, writable: true, source: 'file', masked: 'sk-ab••••9f3a' } })
  assert.deepEqual(keyViewOf(saved, []), { state: 'saved', ref: 'P_API_KEY', masked: 'sk-ab••••9f3a', canClear: true })
  assert.equal(keyViewOf({ ...saved, credential: { ...saved.credential, writable: false } }, []).canClear, false)
  assert.equal(keyViewOf(saved, ['other']).canClear, false)
  assert.deepEqual(keyViewOf(row({ apiKeyEnv: 'P_API_KEY', credential: { configured: true, writable: true, source: 'file' } }), []), { state: 'saved', ref: 'P_API_KEY', masked: '', canClear: true })
  assert.deepEqual(keyViewOf(row({ entry: { nativeAuth: { env: ['P_KEY'] } }, credentialChecks: { P_KEY: { configured: true, source: 'env' } } }), []), { state: 'env', ref: 'P_KEY', canClear: false })
  assert.deepEqual(keyViewOf(row({ entry: { nativeAuth: { env: ['P_KEY'] } }, credentialChecks: { P_KEY: { configured: false } } }), []), { state: 'unset', ref: 'P_API_KEY', envHint: 'P_KEY', canClear: false })
  assert.deepEqual(keyViewOf(row({ entry: { nativeAuth: { env: ['P_OAUTH_TOKEN'] } } }), []), { state: 'unset', ref: 'P_API_KEY', canClear: false })
})

test('新加的中英文案键一一对应', () => {
  const keys = ['statusNotRunning', 'statusNotRunningWhy', 'retryPolicy', 'retryModeDefault', 'retryCodeQuota', 'retryDelayOrder', 'keyReplacePending', 'keyRemovePending', 'keyRemovePendingEnv', 'keyRemoveApplied', 'keyClear', 'keyUndo', 'keyCheckPending', 'protocolNeedsKey', 'modelReasoningLevelsOnly', 'customized', 'customizedSummary', 'sourceCatalogAndLive', 'sourceCatalogOnly', 'sourceLive', 'onlyFromProvider', 'onlyFromProviderBlocked', 'dataIncomplete', 'setDefault', 'moveFirst', 'moveLast', 'defaultSaved', 'modelsCustomizedPending', 'modelsEmpty', 'reorderModel']
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh.${key}`)
    assert.equal(typeof en[key], 'string', `en.${key}`)
  }
  assert.equal(zh['protocol.google-generative-ai'], 'Gemini API')
  assert.equal(zh.advanced, undefined)
})

test('协议不统一的提供商里只在提供商返回的行：说明不能添加和原因，不再让人去配置文件里改整家的协议', () => {
  assert.equal(zh.onlyFromProviderBlocked, '仅提供商返回 · 这一家的模型协议不统一，DSH 无法添加目录外的模型')
  assert.doesNotMatch(zh.onlyFromProviderBlocked, /cordis\.patch\.yml/)
  assert.doesNotMatch(en.onlyFromProviderBlocked, /cordis\.patch\.yml/)
})

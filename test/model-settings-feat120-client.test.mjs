/** 模型设置（从 dsh-model-settings 的 test/feat120-client.test.mjs 搬来，feat#217）。 feat#120 的页面行为：在替身 React 里跑构建好的 lib/client.js，DSH 的接口全是假的，密钥是编的。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)

/** 照 DSH 重试策略 schema 搭的最小节点。 */
const number = (meta = {}) => ({ type: 'number', meta })
const backoff = { type: 'object', meta: {}, dict: { initialDelayMs: number({ min: Number.MIN_VALUE, default: 500 }), maxDelayMs: number({ min: Number.MIN_VALUE, default: 10000 }) } }
const retryNode = { type: 'union', meta: {}, list: [
  { type: 'object', meta: {}, dict: { mode: { type: 'const', value: 'normal' }, maxRetries: number({ min: 0, step: 1, default: 5 }), backoff } },
  { type: 'object', meta: {}, dict: { mode: { type: 'const', value: 'always' }, backoff } },
] }
const getPath = (value, path) => path.reduce((at, key) => (typeof at === 'object' && at !== null ? at[key] : undefined), value)
const schema = {
  rehydrate: value => value,
  nodeAtPath: (_, path) => (path.at(-1) === 'retryPolicy' ? retryNode : path.at(-1) === 'api' ? { type: 'union', list: [{ value: 'openai-completions' }, { value: 'anthropic-messages' }, { value: 'google-generative-ai' }] } : undefined),
  getPath,
  // 照 DSH 的重试策略 schema 真的拒绝非法值：错误码至少一项（retry-policy.ts 的 retryableCodes.min(1)）。
  validate: (node, value) => (node === retryNode && Array.isArray(value?.retryableCodes) && value.retryableCodes.length === 0 ? 'retryableCodes: 至少需要 1 项' : undefined),
}

/** 一家目录里的提供商 google，带已保存的密钥（凭据文件里的，带打码预览）。 */
function googleRow({ masked = 'AIzaS••••••••k9Qw', apiKeyEnv = 'GOOGLE_API_KEY' } = {}) {
  return {
    entry: { provider: 'google', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'google'], active: true, defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta', nativeAuth: { env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], oauth: false } },
    configured: true, removable: true, apiKeyEnv,
    credential: { configured: true, writable: true, source: 'file', masked },
  }
}
function snapshotOf(rows, providers) {
  return {
    status: 'ready', writable: true, checks: new Map(), rows, catalog: { groups: [], default: { provider: 'google', model: 'gemini-a' } },
    namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision: 3, schema: {}, value: { providers }, user: { providers }, base: {} }]]),
  }
}

function open(t0, component, props, ops = {}) {
  const client = loadClient(CLIENT)
  const calls = []
  const app = {
    t, schema, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } },
    ops: {
      async writeSettings(ns, written) { calls.push(['write', written.map(op => `${op.op} ${op.path.join('.')}`)]); return ops.write?.() ?? { kind: 'written', view: { revision: 4, user: props.snapshot.namespaces.get('llm-pi-ai').user } } },
      async storeCredential(ref) { calls.push(['store', ref]); return undefined },
      async removeCredential(ref) { calls.push(['remove', ref]); return undefined },
      async discoverModels(ns, request) { calls.push(['discover', request]); return { kind: 'found', models: [{ id: 'gemini-a', name: 'Gemini A' }, { id: 'gemini-b', name: 'Gemini B' }] } },
      async discoverLive(provider) { calls.push(['live', provider]); return ops.live ?? { ok: true, models: [{ id: 'gemini-b' }, { id: 'gemini-new' }], url: 'https://generativelanguage.googleapis.com/v1beta/models', at: 0, acceptsUnlisted: true } },
      async setDefaultModel(provider, model) { calls.push(['default', provider, model]); return { ok: true } },
      async check() { calls.push(['check']); return { ok: true, model: 'gemini-a', ms: 10 } },
    },
    store: { async load() { calls.push(['load']) }, setCheck() {}, getSnapshot: () => props.snapshot },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get(component), { app, go() {}, back() {}, ...props }))
  t0.after(() => react.unmount())
  return { client, react, calls }
}
const button = (react, label) => react.one(node => node.type === 'ui.Button' && textOf(node) === label, `「${label}」按钮`)
const keyInput = react => react.one(node => node.type === 'input' && node.props.className === 'dms-keyinput', '密钥输入')
const detail = (t0, row, ops) => {
  const snapshot = snapshotOf([row], { google: { apiKeyEnv: row.apiKeyEnv } })
  return open(t0, 'ProviderDetail', { snapshot, row, namespace: snapshot.namespaces.get('llm-pi-ai') }, ops)
}

test('已保存的密钥只显示打码预览；点「清除」后检查连接禁用，保存时先删凭据、再去掉派生的凭据名', async (t0) => {
  const { react, calls } = detail(t0, googleRow())
  await react.settle()
  assert.equal(keyInput(react).props.placeholder, 'AIzaS••••••••k9Qw')
  assert.equal(keyInput(react).props.value, '')
  assert.equal(button(react, 'check').props.disabled, false)
  react.fire(react.one(node => node.type === 'button' && textOf(node) === 'keyClear', '「清除」'), 'onClick')
  await react.settle()
  assert.equal(keyInput(react).props.disabled, true)
  assert.equal(button(react, 'check').props.disabled, true)
  assert.ok(react.all(node => textOf(node) === 'keyCheckPending').length > 0)
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.filter(call => call[0] !== 'load'), [['remove', 'GOOGLE_API_KEY'], ['write', ['unset providers.google.apiKeyEnv']]])
})

test('清除后写配置失败：说明凭据已清除，再点「保存」只补写配置', async (t0) => {
  let fail = true
  const { react, calls } = detail(t0, googleRow(), { write: () => (fail ? { kind: 'refused', message: 'disk full' } : undefined) })
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && textOf(node) === 'keyClear', '「清除」'), 'onClick')
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.ok(react.all(node => node.props?.role === 'alert' && textOf(node) === 'keyRemoveApplied').length > 0)
  assert.equal(button(react, 'close').props.disabled, false)
  fail = false
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.equal(calls.some(call => call[0] === 'remove'), false)
  assert.deepEqual(calls.find(call => call[0] === 'write'), ['write', ['unset providers.google.apiKeyEnv']])
})

test('输入新密钥是替换：检查连接禁用，保存只存凭据', async (t0) => {
  const { react, calls } = detail(t0, googleRow())
  await react.settle()
  react.fire(keyInput(react), 'onChange', { target: { value: 'AIza-new-key' } })
  await react.settle()
  assert.ok(react.all(node => textOf(node) === 'keyReplacePending').length > 0)
  assert.equal(button(react, 'check').props.disabled, true)
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.filter(call => call[0] !== 'load'), [['store', 'GOOGLE_API_KEY']])
})

test('目录里的提供商：打开页面不向提供商请求；点「获取可用模型」才请求一次，结果和目录合在一起', async (t0) => {
  const { react, calls } = detail(t0, googleRow())
  await react.settle()
  assert.deepEqual(calls.filter(call => call[0] === 'live'), [])
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.filter(call => call[0] === 'live'), [['live', 'google']])
  const modal = react.one(node => node.type === 'ui.Modal' && node.props.title === 'fetchTitle', '选择模型')
  assert.match(modal.props.description, /^sourceCatalogAndLive /)
  assert.match(modal.props.description, /"catalog":2/)
  assert.match(modal.props.description, /"live":2/)
  assert.ok(react.all(node => node.props?.className === 'dms-meta' && textOf(node) === 'onlyFromProvider').length === 1)
  // 切标签页不再请求。
  react.one(node => node.type === 'ui.SegmentedControl' && node.props.label === 'fetchTitle', '标签页').props.onChange('all')
  await react.settle()
  assert.equal(calls.filter(call => call[0] === 'live').length, 1)
})

test('目录里的提供商：密钥或 API 地址有没保存的改动时，「获取可用模型」禁用并说明（宿主端只用已保存的）', async (t0) => {
  const { react, calls } = detail(t0, googleRow())
  await react.settle()
  assert.equal(button(react, 'fetchModels').props.disabled, false)
  react.fire(keyInput(react), 'onChange', { target: { value: 'AIza-new-key' } })
  await react.settle()
  assert.equal(button(react, 'fetchModels').props.disabled, true)
  assert.ok(react.all(node => node.props?.className === 'dms-hint' && textOf(node) === 'fetchNeedsSave').length > 0)
  react.fire(keyInput(react), 'onChange', { target: { value: '' } })
  await react.settle()
  assert.equal(button(react, 'fetchModels').props.disabled, false)
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-disc', '自定义设置'), 'onClick')
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-url-google', 'API 地址'), 'onChange', { target: { value: 'http://127.0.0.1:3493/v1beta' } })
  await react.settle()
  assert.equal(button(react, 'fetchModels').props.disabled, true)
  assert.equal(calls.some(call => call[0] === 'live'), false)
})

test('向提供商请求失败：照样列出目录，第一行写明原因', async (t0) => {
  const { react } = detail(t0, googleRow(), { live: { ok: false, reason: 'auth', status: 401 } })
  await react.settle()
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  const modal = react.one(node => node.type === 'ui.Modal' && node.props.title === 'fetchTitle', '选择模型')
  assert.match(modal.props.description, /^sourceCatalogOnly /)
  assert.match(modal.props.description, /liveauth/)
})

test('右键模型行：设为默认模型走宿主端接口；移到最前改顺序', async (t0) => {
  const row = googleRow()
  const snapshot = snapshotOf([row], { google: { apiKeyEnv: 'GOOGLE_API_KEY', models: [{ id: 'gemini-a' }, { id: 'gemini-b' }] } })
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row, namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  const rowB = () => react.all(node => node.props?.className === 'dms-mrow')[1]
  react.fire(rowB(), 'onContextMenu', { clientX: 10, clientY: 20 })
  await react.settle()
  const menu = react.one(node => node.type === 'ui.Menu', '右键菜单')
  assert.deepEqual(menu.props.items.map(item => item.id), ['default', 'sep-default', 'first', 'last', 'sep-remove', 'remove'])
  assert.equal(menu.props.items[0].disabled, false)
  menu.props.onSelect('default')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'default'), ['default', 'google', 'gemini-b'])
  react.fire(rowB(), 'onContextMenu', { clientX: 10, clientY: 20 })
  await react.settle()
  react.one(node => node.type === 'ui.Menu', '右键菜单').props.onSelect('first')
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write'), ['write', ['set providers.google.models']])
})

test('重试策略：改一个退避字段只写那一个叶子', async (t0) => {
  const row = googleRow()
  const snapshot = snapshotOf([row], { google: { apiKeyEnv: 'GOOGLE_API_KEY', retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 500 } } } })
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row, namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-disc', '自定义设置'), 'onClick')
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-retry-google-backoff-maxDelayMs', '最大延迟'), 'onChange', { target: { value: '8000' } })
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.find(call => call[0] === 'write'), ['write', ['set providers.google.retryPolicy.backoff.maxDelayMs']])
})

test('自定义模型 API：地址以 /v1beta 结尾先按 Gemini API 问；Gemini 没有密钥不能创建', async (t0) => {
  const snapshot = snapshotOf([], {})
  const { react, client, calls } = open(t0, 'CustomStep', { snapshot, initialName: 'Moss' })
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-custom-url', 'API 地址'), 'onChange', { target: { value: 'https://gateway.example/v1beta' } })
  await react.settle()
  react.instancesOf(client.get('ModelsEditor'))[0].props.onChange([{ id: 'gemini-x' }])
  await react.settle()
  assert.ok(react.all(node => textOf(node) === 'protocolNeedsKey').length > 0)
  assert.equal(button(react, 'create').props.disabled, true)
  assert.equal(button(react, 'fetchModels').props.disabled, true)
  react.fire(keyInput(react), 'onChange', { target: { value: 'sk-test' } })
  await react.settle()
  assert.equal(button(react, 'create').props.disabled, false)
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  assert.equal(calls.find(call => call[0] === 'discover')[1].api, 'google-generative-ai')
})

test('重试策略的整体校验：已保存的策略被 DSH 的 schema 拒绝时写出原因，「保存」不可用', async (t0) => {
  const row = googleRow()
  const snapshot = snapshotOf([row], { google: { apiKeyEnv: 'GOOGLE_API_KEY', retryPolicy: { mode: 'normal', retryableCodes: [] } } })
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row, namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  assert.ok(react.all(node => node.props?.role === 'alert' && textOf(node) === 'retryableCodes: 至少需要 1 项').length > 0)
  react.fire(keyInput(react), 'onChange', { target: { value: 'AIza-new-key' } })
  await react.settle()
  assert.equal(button(react, 'save').props.disabled, true)
  assert.equal(calls.some(call => call[0] === 'write' || call[0] === 'store'), false)
})

test('目录里的提供商：宿主端读不到安装包目录或地址不合法时，来源一行写清原因', async (t0) => {
  for (const [reason, key] of [['noCatalog', 'livenoCatalog'], ['badBaseUrl', 'livebadBaseUrl']]) {
    const { react } = detail(t0, googleRow(), { live: { ok: false, reason } })
    await react.settle()
    react.fire(button(react, 'fetchModels'), 'onClick')
    await react.settle()
    const modal = react.one(node => node.type === 'ui.Modal' && node.props.title === 'fetchTitle', '选择模型')
    assert.match(modal.props.description, new RegExp(`"reason":"${key}`), reason)
    react.unmount()
  }
})

test('目录协议不统一的提供商：只在提供商返回的行写明不能添加，「+」禁用，「添加全部」不出现', async (t0) => {
  const { react } = detail(t0, googleRow(), { live: { ok: true, models: [{ id: 'gemini-b' }, { id: 'gemini-new' }], url: 'https://openrouter.ai/api/v1/models', at: 0, acceptsUnlisted: false } })
  await react.settle()
  react.fire(button(react, 'fetchModels'), 'onClick')
  await react.settle()
  const row = react.one(node => node.type === 'li' && textOf(node).startsWith('gemini-new'), '仅提供商返回的行')
  assert.match(textOf(row), /onlyFromProviderBlocked/)
  const plus = react.all(node => node.type === 'button' && node.props['aria-label'] === 'addModel gemini-new')
  assert.equal(plus.length, 1)
  assert.equal(plus[0].props.disabled, true)
  assert.equal(react.all(node => node.type === 'ui.Button' && textOf(node) === 'pickAddAll').length, 0)
})

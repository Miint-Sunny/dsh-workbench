/** 模型设置（从 dsh-model-settings 的 test/fix205-client.test.mjs 搬来，feat#217）。
 * fix#205：协议混合的提供商（OpenCode Go）手动添加的模型放进「目录外的模型」，每行选协议，保存进那种协议的伴随条目；
 * 这一家自己的目录里出现安装包目录没有的 ID 时先在页面上写明怎么改、不让保存；DSH 退回「缺协议」时换成中文说明。
 * 目录数据是 test/fixtures/model-settings-mixed-catalogs.json 里 OpenCode Go 的真实目录（四种协议都能放目录外的模型）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { protocolInfo } from '../lib/model-settings/companion.js'
import { loadClient, textOf } from './react-harness.mjs'

const GO = JSON.parse(readFileSync(new URL('./fixtures/model-settings-mixed-catalogs.json', import.meta.url), 'utf8'))['opencode-go']
const INFO = protocolInfo(GO).usable
const MIXED = { ok: true, mixed: true, keyRef: 'OPENCODE_GO_API_KEY', protocols: INFO, unusable: {}, models: GO }
const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
const getPath = (value, path) => path.reduce((at, key) => (typeof at === 'object' && at !== null ? at[key] : undefined), value)
const schema = { rehydrate: value => value, nodeAtPath: () => undefined, getPath, validate: () => undefined }
const NEEDS_API = 'llm-pi-ai: provider "opencode-go" model "test-model-abc" needs an api; the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks'

function goRow() {
  return {
    entry: { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], active: true, defaultBaseURL: 'https://opencode.ai/inference/go/v1', nativeAuth: { env: ['OPENCODE_API_KEY'], oauth: false } },
    configured: true, removable: true, apiKeyEnv: 'OPENCODE_GO_API_KEY', credential: { configured: true, writable: true, source: 'file', masked: 'sk-ab•••••9f3a' },
  }
}

/** 挂上 OpenCode Go 的详情页。protocols 是宿主端「目录协议」的回答；writeSettings 默认写成功。 */
function open(t0, providers, { protocols = MIXED, written = { kind: 'written', view: { revision: 4, user: { providers: {} } } } } = {}) {
  const snapshot = {
    status: 'ready', writable: true, checks: new Map(), rows: [goRow()], catalog: { groups: [] },
    namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision: 3, schema: {}, value: { providers }, user: { providers }, base: {} }]]),
  }
  const client = loadClient(CLIENT)
  const calls = []
  const app = {
    t, schema, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } },
    ops: {
      async writeSettings(ns, ops, revision) { calls.push(['write', ops, revision]); return written },
      async storeCredential(ref) { calls.push(['store', ref]) },
      async removeCredential(ref) { calls.push(['remove', ref]) },
      async discoverModels() { return { kind: 'found', models: GO.map(model => ({ id: model.id, name: model.id })) } },
      async discoverLive() { return { ok: false, reason: 'network' } },
      async catalogProtocols() { return protocols },
      async setDefaultModel() { return { ok: true } },
      async check() { return { ok: true, model: 'm', ms: 1 } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snapshot },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get('ProviderDetail'), { app, go() {}, snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') }))
  t0.after(() => react.unmount())
  return { react, calls }
}
const buttons = (react, label) => react.all(node => node.type === 'ui.Button' && textOf(node) === label)
const button = (react, label) => react.one(node => node.type === 'ui.Button' && textOf(node) === label, `「${label}」按钮`)
const companionSections = react => react.all(node => node.props?.className === 'dms-sec' && textOf(node).startsWith('companionModels'))
const pageText = react => react.all(node => node.parent === undefined || node.parent === null).map(textOf).join('|')
const writesOf = calls => calls.filter(call => call[0] === 'write').map(call => call[1].map(op => `${op.op} ${op.path.join('.')}`))

/** 点「目录外的模型」里的「添加模型」，填上模型 ID；protocol 给了就先改协议。 */
async function addOutside(react, id, protocol) {
  react.fire(button(react, 'addModel'), 'onClick')
  await react.settle()
  if (protocol !== undefined) {
    react.one(node => node.type === 'select' && node.props.id === 'dms-model-0-api', '新行的协议').props.onChange({ target: { value: protocol } })
    await react.settle()
  }
  react.one(node => node.props?.id === 'dms-model-0-id', '新行的模型 ID').props.onChange({ target: { value: id } })
  await react.settle()
}

test('协议混合的提供商：「添加模型」只在「目录外的模型」里，新行默认 OpenAI Chat Completions，保存进伴随条目，不写进这一家自己的目录', async (t0) => {
  const { react, calls } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } })
  await react.settle()
  assert.equal(buttons(react, 'addModel').length, 1)
  assert.equal(buttons(react, 'fetchModels').length, 1)
  const sections = companionSections(react)
  assert.equal(sections.length, 1)
  assert.match(textOf(sections[0]), /companionModelsEmpty/)
  react.fire(button(react, 'addModel'), 'onClick')
  await react.settle()
  assert.equal(react.one(node => node.type === 'select' && node.props.id === 'dms-model-0-api', '新行的协议').props.value, 'openai-completions')
  react.one(node => node.props?.id === 'dms-model-0-id', '新行的模型 ID').props.onChange({ target: { value: 'test-model-abc' } })
  await react.settle()
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const write = calls.find(call => call[0] === 'write')
  assert.deepEqual(writesOf(calls), [['set providers.opencode-go--openai']])
  const entry = write[1][0].value
  assert.deepEqual({ api: entry.api, baseURL: entry.baseURL, apiKeyEnv: entry.apiKeyEnv, ids: entry.models.map(model => model.id) },
    { api: 'openai-completions', baseURL: INFO['openai-completions'].base, apiKeyEnv: 'OPENCODE_GO_API_KEY', ids: ['test-model-abc'] })
})

test('协议混合的提供商：新行改成别的协议，就存进那种协议的伴随条目', async (t0) => {
  const { react, calls } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } })
  await react.settle()
  await addOutside(react, 'test-model-abc', 'anthropic-messages')
  calls.length = 0
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(writesOf(calls), [['set providers.opencode-go--anthropic']])
  const entry = calls.find(call => call[0] === 'write')[1][0].value
  assert.deepEqual({ api: entry.api, baseURL: entry.baseURL, ids: entry.models.map(model => model.id) },
    { api: 'anthropic-messages', baseURL: INFO['anthropic-messages'].base, ids: ['test-model-abc'] })
})

test('协议混合的提供商：OpenAI Chat Completions 的条目被手写的同形条目占着时，新行用下一个能用的协议', async (t0) => {
  const relay = { displayName: 'My relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY', models: [{ id: 'x' }] }
  const { react } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, 'opencode-go--openai': relay })
  await react.settle()
  react.fire(button(react, 'addModel'), 'onClick')
  await react.settle()
  assert.equal(react.one(node => node.type === 'select' && node.props.id === 'dms-model-0-api', '新行的协议').props.value, 'anthropic-messages')
})

test('协议混合的提供商：这一家自己的目录里改出安装包目录没有的 ID 时，写明怎么改，「保存」不可点', async (t0) => {
  const own = GO.slice(0, 2).map(model => ({ id: model.id }))
  const { react, calls } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: own } })
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith(own[0].id), '第一行'), 'onClick')
  await react.settle()
  react.one(node => node.props?.id === 'dms-model-0-id', '第一行的模型 ID').props.onChange({ target: { value: 'test-model-abc' } })
  await react.settle()
  assert.match(pageText(react), /modelOutsideCatalog \{"ids":"test-model-abc","provider":"OpenCode Go"\}/)
  assert.equal(button(react, 'save').props.disabled, true)
  // 绕过禁用直接调保存：保存里自己也先查这一条，不发写入。
  calls.length = 0
  button(react, 'save').props.onClick()
  await react.settle()
  assert.deepEqual(writesOf(calls), [])
  assert.match(pageText(react), /modelOutsideCatalog/)
})

test('协议混合的提供商：目录外的模型里填了安装包目录本来就有的 ID，提示改用「获取可用模型」，照样能保存', async (t0) => {
  const { react } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } })
  await react.settle()
  await addOutside(react, GO[0].id)
  assert.match(pageText(react), new RegExp(`modelInCatalog \\{"id":"${GO[0].id.replaceAll('.', '\\.')}"\\}`))
  assert.equal(button(react, 'save').props.disabled, false)
})

test('协议统一的提供商照旧：「添加模型」在这一家自己的目录里，没有「目录外的模型」这一块', async (t0) => {
  const { react } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }, { protocols: { ...MIXED, mixed: false } })
  await react.settle()
  assert.equal(buttons(react, 'addModel').length, 1)
  assert.equal(companionSections(react).length, 0)
})

test('DSH 退回「缺协议」时换成中文说明，不显示原始英文', async (t0) => {
  // 读不到安装包目录时页面不知道协议混合，这时「添加模型」还在这一家自己的目录里，保存由 DSH 拒绝。
  const { react } = open(t0, { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }, { protocols: { ok: false }, written: { kind: 'error', message: NEEDS_API } })
  await react.settle()
  assert.equal(companionSections(react).length, 0)
  react.fire(button(react, 'addModel'), 'onClick')
  await react.settle()
  react.one(node => node.props?.id === `dms-model-${GO.length}-id`, '新行的模型 ID').props.onChange({ target: { value: 'test-model-abc' } })
  await react.settle()
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const text = pageText(react)
  assert.match(text, /saveNeedsApi \{"model":"test-model-abc","provider":"OpenCode Go"\}/)
  assert.doesNotMatch(text, /needs an api/)
})

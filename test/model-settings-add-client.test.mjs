/** 模型设置（从 dsh-model-settings 的 test/add-client.test.mjs 搬来，feat#217）。 添加自定义提供商（CustomStep）：写配置成功、存密钥失败后，页面因设置推送重读，新建的提供商出现在列表里，这时还要能重试保存密钥。在替身 React 里跑构建好的 lib/client.js。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)

/** 页面快照：pi-ai 命名空间可写，rows 里是已经有的提供商。 */
const snapshot = (providers, revision = 7) => ({
  status: 'ready', writable: true, checks: new Map(),
  rows: providers.map(provider => ({ entry: { provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] }, configured: true })),
  namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision, schema: {}, value: {}, user: {}, base: {} }]]),
})

function openCustom(t, { name, stored }) {
  const client = loadClient(CLIENT)
  const calls = []
  const goes = []
  const app = {
    t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    // 协议选项从 schema 的 union 读；推理档位读不到时为空。
    schema: { rehydrate: value => value, nodeAtPath: (_, path) => (path.at(-1) === 'api' ? { type: 'union', list: [{ value: 'openai-completions' }, { value: 'anthropic-messages' }] } : undefined) },
    ops: {
      async writeSettings(ns, ops, revision) {
        calls.push(['write', ns, ops[0].path.join('.'), revision])
        return { kind: 'written', view: {} }
      },
      async storeCredential(ref, value) {
        calls.push(['store', ref, value])
        return stored.shift()
      },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() { calls.push(['load']) } },
    ctx: {},
  }
  const react = client.react
  const CustomStep = client.get('CustomStep')
  const render = providers => react.React.createElement(CustomStep, { app, snapshot: snapshot(providers), initialName: name, back() {}, go: next => goes.push(next) })
  react.mount(render(['deepseek']))
  t.after(() => react.unmount())
  const input = id => react.one(node => node.type === 'input' && node.props.id === id, `输入框 ${id}`)
  return {
    calls,
    goes,
    /** 设置推送后页面重读：快照换成 providers。 */
    async reload(providers) {
      react.update(render(providers))
      await react.settle()
    },
    async fill({ url, key, models }) {
      react.fire(input('dms-custom-url'), 'onChange', { target: { value: url } })
      react.fire(react.one(node => node.type === 'input' && node.props.className === 'dms-keyinput', '密钥输入'), 'onChange', { target: { value: key } })
      await react.settle()
      react.instancesOf(client.get('ModelsEditor'))[0].props.onChange(models)
      await react.settle()
    },
    create: () => react.one(node => node.type === 'ui.Button' && ['create', 'creating'].includes(textOf(node)), '「创建」按钮'),
    async clickCreate() {
      react.fire(this.create(), 'onClick')
      await react.settle()
    },
    alerts: () => react.all(node => node.props.role === 'alert').map(textOf),
  }
}

test('S-005 写好配置、存密钥失败后页面重读，按钮仍能点，重试只补存密钥', async (t) => {
  const ui = openCustom(t, { name: 'My Relay', stored: ['keychain locked', undefined] })
  await ui.fill({ url: 'https://relay.example/v1', key: 'sk-test', models: [{ id: 'relay-chat' }] })
  await ui.clickCreate()
  assert.deepEqual(ui.alerts(), ['saveFailed {"message":"keychain locked"}'])
  await ui.reload(['deepseek', 'my-relay'])
  assert.deepEqual(ui.alerts(), ['saveFailed {"message":"keychain locked"}'], '不把自己刚建的提供商当成重复 ID')
  assert.equal(ui.create().props.disabled, false)
  await ui.clickCreate()
  assert.deepEqual(ui.calls, [
    ['write', 'llm-pi-ai', 'providers.my-relay', 7],
    ['store', 'MY_RELAY_API_KEY', 'sk-test'],
    ['store', 'MY_RELAY_API_KEY', 'sk-test'],
    ['load'],
  ])
  assert.deepEqual(ui.goes, [{ page: 'detail', provider: 'my-relay', saved: 'my-relay' }])
})

test('S-005 还没创建时，和已有提供商重名的 ID 照旧报错、不能创建', async (t) => {
  const ui = openCustom(t, { name: 'DeepSeek', stored: [] })
  await ui.fill({ url: 'https://relay.example/v1', key: 'sk-test', models: [{ id: 'relay-chat' }] })
  assert.deepEqual(ui.alerts(), ['customRouteTaken'])
  assert.equal(ui.create().props.disabled, true)
})

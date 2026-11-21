/**
 * 模型设置并进工作台后的网页端（feat#217）：功能清单里有 model-settings 时，FEATURE_UI 在子 fiber 里注入模型设置独有的服务，
 * 跑原来独立插件的入口；撤下这一行就 dispose 子 fiber，设置页、样式、导航去重和推送刷新的监听一起撤掉。
 * 在替身 React 里跑构建好的 lib/client.js；下面的假客户端上下文照 cordis 的 effect / inject 写：
 * 每个作用域记下自己登记的东西，inject 开一个子作用域（依赖不全时不调用回调），子作用域的 dispose 撤掉它登记的全部东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClient } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const EXCLUSIVE = ['configForms', 'settingsSchema', 'remote.llm', 'remote.settings', 'remote.credentials']

/** 浏览器替身：样式表挂在 head 下，MutationObserver 记下 observe 和 disconnect。 */
function browser() {
  const head = []
  const observers = []
  const document = {
    head: { appendChild(element) { head.push(element) } },
    body: {},
    createElement: tag => {
      const element = { tag, dataset: {}, remove() { head.splice(head.indexOf(element), 1) } }
      return element
    },
    querySelector: () => null,
  }
  class MutationObserver {
    constructor() { this.observing = false; observers.push(this) }
    observe() { this.observing = true }
    disconnect() { this.observing = false }
  }
  const globals = {
    document, MutationObserver,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    location: { origin: 'http://localhost:5174' },
    navigator: { clipboard: { writeText: async () => {} } },
  }
  return { head, observers, globals }
}

/** 假的客户端上下文。available 是能注入的服务名；listeners、remote 记下各事件的监听，sections 记下槽位注册。 */
function fakeClient(available) {
  const listeners = new Map()
  const remote = new Map()
  const sections = []
  const add = (map, name, fn) => {
    if (!map.has(name)) map.set(name, new Set())
    map.get(name).add(fn)
    return () => { map.get(name).delete(fn) }
  }
  const count = (map, name) => map.get(name)?.size ?? 0
  const scope = () => {
    const disposers = []
    const self = {
      effect(body) {
        const dispose = body()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      on: (name, fn) => add(listeners, name, fn),
      inject(deps, mount) {
        const child = scope()
        if (deps.every(name => available.has(name))) mount(child)
        const fiber = { dispose: () => child.disposeAll() }
        disposers.push(fiber.dispose)
        return fiber
      },
      locale: { register: () => () => {}, bind: () => key => key, getSnapshot: () => ({ active: 'zh', revision: 1 }), subscribe: () => () => {} },
      slots: {
        inject: (_name, make) => self.effect(make),
        register(info, render) {
          const entry = { info, render, disposed: false }
          sections.push(entry)
          return () => { entry.disposed = true }
        },
      },
      remote: { $on: (name, fn) => add(remote, name, fn) },
      configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({}), subscribe: () => () => {} }) },
      settingsSchema: { getPath: () => undefined, hasPath: () => false },
      disposeAll() { for (const dispose of disposers.splice(0).reverse()) dispose() },
    }
    return self
  }
  return { root: scope(), sections, listenerCount: name => count(listeners, name), remoteCount: name => count(remote, name) }
}

const PUSHED = ['settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated', 'llm/adapters-updated']

test('功能清单有 model-settings 时挂上设置页：id models、priority -1、order 10，盖住 DSH 自带的模型页', () => {
  const { globals } = browser()
  const client = loadClient(CLIENT, globals)
  const fake = fakeClient(new Set(client.get('MODEL_SETTINGS_INJECT')))
  const dispose = client.get('FEATURE_UI')['model-settings']({ ctx: fake.root })
  const sections = fake.sections.filter(entry => entry.info.name === 'settings.section')
  assert.equal(sections.length, 1)
  assert.deepEqual({ id: sections[0].info.id, priority: sections[0].info.priority, order: sections[0].info.order }, { id: 'models', priority: -1, order: 10 })
  dispose()
})

test('撤下这一行：设置页注销、样式表移除、导航去重的 MutationObserver 断开，四个推送刷新和 connection/reset 的监听都撤掉', () => {
  const { head, observers, globals } = browser()
  const client = loadClient(CLIENT, globals)
  const fake = fakeClient(new Set(client.get('MODEL_SETTINGS_INJECT')))
  const dispose = client.get('FEATURE_UI')['model-settings']({ ctx: fake.root })
  assert.deepEqual(head.map(element => element.dataset.plugin), ['dsh-workbench-model-settings'])
  assert.ok(observers.length > 0 && observers.every(observer => observer.observing))
  for (const name of PUSHED) assert.equal(fake.remoteCount(name), 1, name)
  assert.equal(fake.listenerCount('connection/reset'), 1)
  assert.equal(fake.sections.every(entry => !entry.disposed), true)
  dispose()
  assert.equal(fake.sections.every(entry => entry.disposed), true)
  assert.deepEqual(head, [])
  assert.ok(observers.every(observer => !observer.observing))
  for (const name of PUSHED) assert.equal(fake.remoteCount(name), 0, name)
  assert.equal(fake.listenerCount('connection/reset'), 0)
})

test('模型设置独有的服务只进这一行的子 fiber，不进工作台共用的 INJECT：DSH 改了其中一个，只影响这一行', () => {
  const client = loadClient(CLIENT)
  const shared = client.get('INJECT')
  const own = client.get('MODEL_SETTINGS_INJECT')
  assert.deepEqual(EXCLUSIVE.filter(name => shared.includes(name)), [])
  assert.deepEqual(EXCLUSIVE.filter(name => !own.includes(name)), [])
  // 依赖不全（比如 DSH 没有 configForms）时子 fiber 不挂，撤销也照常。
  const fake = fakeClient(new Set(own.filter(name => name !== 'configForms')))
  const dispose = client.get('FEATURE_UI')['model-settings']({ ctx: fake.root })
  assert.equal(fake.sections.length, 0)
  dispose()
})

test('页面的接口调用走 /api/dsh-workbench.model-settings.*，凭据名的规则在网页包里只有一份（lib/model-settings/key-ref.js）', async () => {
  const urls = []
  const fetch = async (url) => { urls.push(url); return { status: 200, json: async () => ({ ok: true }) } }
  const client = loadClient(CLIENT, { fetch })
  const fake = fakeClient(new Set())
  const store = client.get('createModelsStore')(fake.root)
  await store.operations.check('google', 'gemini-x')
  await store.operations.discoverLive('google')
  await store.operations.catalogProtocols('opencode-go')
  await store.operations.setDefaultModel('google', 'gemini-x')
  assert.deepEqual(urls, ['check', 'discover', 'catalog-protocols', 'default-model'].map(name => `api/dsh-workbench.model-settings.${name}`))
  const bundle = readFileSync(CLIENT, 'utf8')
  assert.equal(bundle.match(/function deriveKeyRef\(/g)?.length, 1)
  const at = bundle.indexOf('function deriveKeyRef(')
  assert.equal(bundle.lastIndexOf('  // ---- ', at), bundle.indexOf('  // ---- lib/model-settings/key-ref.js ----'))
  const { deriveKeyRef } = await import('../lib/model-settings/key-ref.js')
  assert.equal(deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
  assert.equal(client.get('deriveKeyRef')('minimax-cn'), 'MINIMAX_CN_API_KEY')
})

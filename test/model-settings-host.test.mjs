/**
 * 模型设置并进工作台后的宿主端（feat#217）：model-settings 这一行向功能登记处报到、撤下时除名；
 * 四个接口挂在工作台的路由前缀 /api/dsh-workbench.model-settings.* 下，不再注册独立插件的 /api/dsh-model-settings.*；
 * OpenCode 会话 ID 是单独的一行 @miint-sunny/dsh-workbench/opencode-session。
 * lib/model-settings/index.js 依赖的 DSH 包（@deepseek-ai/dsh-llm 的消息构造和流累积）用 module.registerHooks 换成替身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const STUBS = {
  '@deepseek-ai/dsh-llm': 'export const createUserMessage = message => message; export class BlockAssembler {}',
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, format: 'module', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const modelSettings = await import('../lib/model-settings/index.js')
const opencodeSession = await import('../lib/model-settings/opencode-session.js')
const { apply: applyRoot } = await import('../lib/index.js')
const { enabledFeatures } = await import('../lib/features.js')

const ROUTES = ['catalog-protocols', 'check', 'default-model', 'discover']

/** 假的插件上下文：effect 收下注销函数，inject 直接给出带 connection 的作用域；disposeAll 对应插件页关掉这一行。 */
function fakeContext(services = {}) {
  const disposers = []
  const routes = new Map()
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
    },
    effect(body) {
      const dispose = body()
      disposers.push(dispose)
      return dispose
    },
    inject(_names, mount) { return mount(ctx) },
    get: name => services[name],
    disposeAll() { for (const dispose of disposers.splice(0).reverse()) dispose() },
  }
  return { ctx, routes }
}

const featureIds = () => enabledFeatures().map(feature => feature.id)

test('模型设置这一行：apply 后 /api/dsh-workbench.features 列出 model-settings，撤下这一行后不再列出', async () => {
  const root = fakeContext()
  applyRoot(root.ctx)
  const row = fakeContext()
  modelSettings.apply(row.ctx)
  const listed = async () => (await (await root.routes.get('/api/dsh-workbench.features').fetch(new Request('http://x/api/dsh-workbench.features'))).json()).features.map(feature => feature.id)
  assert.ok(featureIds().includes('model-settings'))
  assert.ok((await listed()).includes('model-settings'))
  row.ctx.disposeAll()
  assert.equal(featureIds().includes('model-settings'), false)
  assert.equal((await listed()).includes('model-settings'), false)
  root.ctx.disposeAll()
})

test('模型设置的四个接口挂在 /api/dsh-workbench.model-settings.* 下，独立插件的 /api/dsh-model-settings.* 不再注册；撤下这一行时一起撤掉', async () => {
  const { ctx, routes } = fakeContext({ llm: undefined })
  modelSettings.apply(ctx)
  assert.deepEqual([...routes.keys()].sort(), ROUTES.map(name => `/api/dsh-workbench.model-settings.${name}`))
  assert.equal([...routes.keys()].some(path => path.startsWith('/api/dsh-model-settings.')), false)
  for (const name of ROUTES) assert.deepEqual(routes.get(`/api/dsh-workbench.model-settings.${name}`).methods, ['POST'])
  // DSH 的模型服务不在时照样回答 JSON，说明原因。
  const answer = await routes.get('/api/dsh-workbench.model-settings.check').fetch(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ provider: 'google', model: 'm' }) }))
  assert.equal(answer.status, 503)
  assert.equal((await answer.json()).ok, false)
  ctx.disposeAll()
  assert.equal(routes.size, 0)
})

test('两行的包内名字：模型设置 @miint-sunny/dsh-workbench/model-settings，OpenCode 会话 ID @miint-sunny/dsh-workbench/opencode-session', () => {
  assert.equal(modelSettings.name, '@miint-sunny/dsh-workbench/model-settings')
  assert.equal(opencodeSession.name, '@miint-sunny/dsh-workbench/opencode-session')
})

test('OpenCode 会话 ID 这一行不报到：没有界面，网页端不按功能清单挂它（照 git-commands）', () => {
  const seen = []
  opencodeSession.apply({ on: (event, listener) => seen.push([event, listener]), get: () => undefined })
  assert.deepEqual(seen.map(([event]) => event), ['llm-pi-ai/request-headers'])
  assert.equal(featureIds().includes('opencode-session'), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyRoot } from '../lib/index.js'
import { FEATURE_META, registerFeature, enabledFeatures } from '../lib/features.js'

/**
 * 假的 cordis 上下文：只实现根行用到的 effect 和 inject。effect 收下注销函数，
 * disposeAll 按挂载的相反顺序全部执行，对应插件行卸载。
 */
function fakeContext() {
  const disposers = []
  return {
    connection: {
      fetch: {
        routes: [],
        register(route) {
          this.routes.push(route)
          return () => { this.routes.splice(this.routes.indexOf(route), 1) }
        },
      },
    },
    effect(body) {
      const dispose = body()
      disposers.push(dispose)
      return () => { const at = disposers.indexOf(dispose); if (at >= 0) disposers.splice(at, 1) }
    },
    inject(_names, mount) {
      return mount(this)
    },
    disposeAll() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

test('feature registry: register reports the row with its catalog meta, unregister removes it', () => {
  assert.deepEqual(enabledFeatures(), [])
  const dispose = registerFeature('tasks')
  assert.deepEqual(enabledFeatures(), [{ id: 'tasks', ...FEATURE_META.tasks }])
  dispose()
  assert.deepEqual(enabledFeatures(), [])
})

test('feature registry: unknown feature ids fail loud', () => {
  assert.throws(() => registerFeature('nope'), /unknown dsh-workbench feature/)
})

test('feature registry: snapshot copies entries so later edits do not mutate past answers', () => {
  const dispose = registerFeature('tasks')
  const snapshot = enabledFeatures()
  dispose()
  assert.deepEqual(snapshot, [{ id: 'tasks', ...FEATURE_META.tasks }])
  assert.deepEqual(enabledFeatures(), [])
})

test('root row serves the registry through GET /api/dsh-workbench.features', async () => {
  const ctx = fakeContext()
  applyRoot(ctx)
  const dispose = registerFeature('notify')
  try {
    assert.equal(ctx.connection.fetch.routes.length, 1)
    const route = ctx.connection.fetch.routes[0]
    assert.equal(route.path, '/api/dsh-workbench.features')
    assert.deepEqual(route.methods, ['GET'])
    const response = route.fetch()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await response.json()
    assert.deepEqual(body.features, [{ id: 'notify', ...FEATURE_META.notify }])
  } finally {
    dispose()
    ctx.disposeAll()
  }
  assert.deepEqual(enabledFeatures(), [])
})

test('a row enabled then disabled answers with one fewer feature, disabling the root row removes the route', () => {
  const ctx = fakeContext()
  applyRoot(ctx)
  const disposeTasks = registerFeature('tasks')
  const disposeNotify = registerFeature('notify')
  assert.deepEqual(enabledFeatures().map(f => f.id), ['tasks', 'notify'])
  disposeNotify()
  assert.deepEqual(enabledFeatures().map(f => f.id), ['tasks'])
  disposeTasks()
  assert.deepEqual(enabledFeatures(), [])
  ctx.disposeAll()
  assert.equal(ctx.connection.fetch.routes.length, 0)
})

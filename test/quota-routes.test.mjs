/** 余额与额度的路由（lib/quota.js 的 applyQuotaRoutes）：requestBody、参数校验、错误响应不带路径。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyQuotaRoutes } from '../lib/quota.js'

const URL_BASE = 'https://dsh/api/dsh-workbench.quota.overview'

/** 假的已鉴权 connection 作用域，收集注册的路由。 */
function makeScope() {
  const routes = []
  const scope = { connection: { fetch: { register: route => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } } } }
  return { scope, routes }
}

test('quota routes: 注册形状（GET、requestBody buffered），注销撤销', () => {
  const { scope, routes } = makeScope()
  const service = { overview: async () => ({ queriedAt: 0, providers: [], spend: null }) }
  const dispose = applyQuotaRoutes(scope, { service })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/dsh-workbench.quota.overview')
  assert.deepEqual(routes[0].methods, ['GET'])
  assert.equal(routes[0].requestBody, 'buffered')
  dispose()
  assert.equal(routes.length, 0)
})

test('quota routes: 不带参数 200，refresh=1 透传，别的参数 400', async () => {
  const { scope, routes } = makeScope()
  const calls = []
  const service = { overview: async options => { calls.push(options); return { queriedAt: 1, providers: [], spend: null } } }
  applyQuotaRoutes(scope, { service })
  const route = routes[0]

  const ok = await route.fetch(new Request(URL_BASE))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await ok.json(), { queriedAt: 1, providers: [], spend: null })
  assert.deepEqual(calls, [{}])

  const refresh = await route.fetch(new Request(`${URL_BASE}?refresh=1`))
  assert.equal(refresh.status, 200)
  assert.deepEqual(calls, [{}, { refresh: true }])

  for (const query of ['?refresh=2', '?refresh=', '?refresh=0', '?refresh=true', '?refresh=1&refresh=1', '?foo=1', '?refresh=1&foo=2']) {
    const bad = await route.fetch(new Request(URL_BASE + query))
    assert.equal(bad.status, 400, query)
    const body = await bad.json()
    assert.deepEqual(Object.keys(body), ['error'])
    assert.deepEqual(Object.keys(body.error), ['code'])
    assert.equal(typeof body.error.code, 'string')
    assert.doesNotMatch(JSON.stringify(body), /api\//, '错误响应不带路径')
  }
})

test('quota routes: 服务自己出错答 500 错误码', async () => {
  const { scope, routes } = makeScope()
  const service = { overview: async () => { throw new Error('boom') } }
  applyQuotaRoutes(scope, { service })
  const response = await routes[0].fetch(new Request(URL_BASE))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: { code: 'quota-failed' } })
})

/** 路由的测试：参数只收会话、序号和下标（带文件路径一律拒绝）、类型不对拒绝、越界和运行中按服务的结果回状态码；已回退状态的 GET 路由同样校验；另有一趟从 Request 到真文件的全链路。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerReviewRoutes } from '../lib/review/routes.js'
import { createReviewService } from '../lib/review/service.js'
import { createRevertStore } from '../lib/review/store.js'
import { tempDir } from './helpers/temp-dir.mjs'

/** 假的插件上下文：记下注册进来的路由。 */
function fakeCtx() {
  const routes = new Map()
  const disposers = []
  const scope = {
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    effect: (register) => {
      disposers.push(register())
      return () => {}
    },
  }
  return { ctx: { inject: (deps, body) => body(scope) }, routes, disposers }
}

const post = (path, body) =>
  new Request(`http://127.0.0.1:1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const call = async (route, body) => {
  const response = await route.fetch(post(route.path, body))
  return { status: response.status, body: await response.json() }
}

/** GET 已回退状态，query 拼在地址上。 */
const callState = async (route, query) => {
  const response = await route.fetch(new Request(`http://127.0.0.1:1${route.path}${query}`, { method: 'GET' }))
  return { status: response.status, body: await response.json() }
}

/** 什么都成功的服务桩，记下收到的坐标。 */
const okService = () => {
  const calls = []
  return {
    calls,
    revert: async (coordinate) => { calls.push(['revert', coordinate]); return { ok: true, display: 'a.ts', description: '第 1–3 行这一处' } },
    undo: async (coordinate) => { calls.push(['undo', coordinate]); return { ok: true, display: 'a.ts', description: '第 1–3 行这一处' } },
    state: async (coordinate) => { calls.push(['state', coordinate]); return { ok: true, reverts: [] } },
  }
}

test('注册三个路由：回退和撤销是 POST，已回退状态是 GET，都在 /api/dsh-workbench.review.* 下', () => {
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, okService())
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/dsh-workbench.review.revert',
    '/api/dsh-workbench.review.state',
    '/api/dsh-workbench.review.undo',
  ])
  assert.deepEqual(routes.get('/api/dsh-workbench.review.revert').methods, ['POST'])
  assert.deepEqual(routes.get('/api/dsh-workbench.review.undo').methods, ['POST'])
  assert.deepEqual(routes.get('/api/dsh-workbench.review.state').methods, ['GET'])
  for (const [path, route] of routes) {
    assert.equal(route.requestBody, 'buffered', path)
  }
})

test('合法坐标：改动处下标缺省是 null（整个文件），服务拿到解析好的坐标，响应带回指代说法', async () => {
  const service = okService()
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, service)
  const revert = await call(routes.get('/api/dsh-workbench.review.revert'), { sessionId: 'abc-123', seq: 3, fileIndex: 0 })
  assert.deepEqual(revert, { status: 200, body: { ok: true, display: 'a.ts', description: '第 1–3 行这一处' } })
  const undo = await call(routes.get('/api/dsh-workbench.review.undo'), { sessionId: 'abc-123', seq: 3, fileIndex: 0, hunkIndex: 2 })
  assert.equal(undo.status, 200)
  assert.deepEqual(service.calls, [
    ['revert', { sessionId: 'abc-123', seq: 3, fileIndex: 0, hunkIndex: null }],
    ['undo', { sessionId: 'abc-123', seq: 3, fileIndex: 0, hunkIndex: 2 }],
  ])
})

test('已回退状态：GET 的 query 只收 sessionId 和 seq，多余的和路径字段都拒绝', async () => {
  const service = okService()
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, service)
  const route = routes.get('/api/dsh-workbench.review.state')
  const ok = await callState(route, '?sessionId=abc-123&seq=3')
  assert.deepEqual(ok, { status: 200, body: { ok: true, reverts: [] } })
  assert.deepEqual(service.calls, [['state', { sessionId: 'abc-123', seq: 3 }]])
  const cases = [
    ['?seq=3', '会话 ID 不合法。'],
    ['?sessionId=abc-123', '改动事件的序号不合法。'],
    ['?sessionId=abc-123&seq=', '改动事件的序号不合法。'],
    ['?sessionId=abc-123&seq=3.5', '改动事件的序号不合法。'],
    ['?sessionId=../..&seq=3', '会话 ID 不合法。'],
    ['?sessionId=abc-123&seq=3&path=a.ts', '不接受文件路径，仅接受会话、序号和下标。'],
    ['?sessionId=abc-123&seq=3&foo=1', '未知参数：foo。'],
  ]
  for (const [query, message] of cases) {
    const result = await callState(route, query)
    assert.equal(result.status, 400, query)
    assert.equal(result.body.reason, 'invalid-query', query)
    assert.equal(result.body.message, message, query)
  }
})

test('拒绝文件路径：path、filePath、file、target 都不收，给一句直话', async () => {
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, okService())
  for (const key of ['path', 'filePath', 'file', 'target']) {
    const result = await call(routes.get('/api/dsh-workbench.review.revert'), { sessionId: 's1', seq: 1, fileIndex: 0, hunkIndex: 0, [key]: 'a.ts' })
    assert.equal(result.status, 400)
    assert.equal(result.body.reason, 'invalid-body')
    assert.equal(result.body.message, '不接受文件路径，仅接受会话、序号和下标。')
  }
})

test('拒绝多余字段、坏类型和非 JSON 请求体', async () => {
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, okService())
  const route = routes.get('/api/dsh-workbench.review.revert')
  const cases = [
    [{ sessionId: 's1', seq: 1, fileIndex: 0, foo: 1 }, '未知参数：foo。'],
    [{ sessionId: '../..', seq: 1, fileIndex: 0 }, '会话 ID 不合法。'],
    [{ sessionId: 's/1', seq: 1, fileIndex: 0 }, '会话 ID 不合法。'],
    [{ seq: 1, fileIndex: 0 }, '会话 ID 不合法。'],
    [{ sessionId: 's1', seq: '3', fileIndex: 0 }, '改动事件的序号不合法。'],
    [{ sessionId: 's1', seq: -1, fileIndex: 0 }, '改动事件的序号不合法。'],
    [{ sessionId: 's1', seq: 1.5, fileIndex: 0 }, '改动事件的序号不合法。'],
    [{ sessionId: 's1', seq: 1 }, '文件下标不合法。'],
    [{ sessionId: 's1', seq: 1, fileIndex: -1 }, '文件下标不合法。'],
    [{ sessionId: 's1', seq: 1, fileIndex: 0, hunkIndex: -2 }, '改动处下标不合法。'],
    [{ sessionId: 's1', seq: 1, fileIndex: 0, hunkIndex: '一' }, '改动处下标不合法。'],
    [['s1', 1, 0], '请求体不是 JSON 对象。'],
    [null, '请求体不是 JSON 对象。'],
  ]
  for (const [body, message] of cases) {
    const result = await call(route, body)
    assert.equal(result.status, 400, JSON.stringify(body))
    assert.equal(result.body.reason, 'invalid-body')
    assert.equal(result.body.message, message, JSON.stringify(body))
  }
  const notJson = await call(route, '不是 JSON')
  assert.equal(notJson.status, 400)
  assert.equal(notJson.body.message, '请求体不是 JSON。')
})

test('服务的拒绝按状态码回：越界下标 404、会话运行中 409', async () => {
  const service = {
    revert: async () => ({ ok: false, status: 404, reason: 'file-index', message: '文件下标超出这一轮改动的范围。' }),
    undo: async () => ({ ok: false, status: 409, reason: 'running', message: '会话进行中，结束后才能撤销。' }),
    state: async () => ({ ok: true, reverts: [] }),
  }
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, service)
  const revert = await call(routes.get('/api/dsh-workbench.review.revert'), { sessionId: 's1', seq: 1, fileIndex: 99 })
  assert.equal(revert.status, 404)
  assert.deepEqual(revert.body, { ok: false, reason: 'file-index', message: '文件下标超出这一轮改动的范围。' })
  const undo = await call(routes.get('/api/dsh-workbench.review.undo'), { sessionId: 's1', seq: 1, fileIndex: 0 })
  assert.equal(undo.status, 409)
  assert.equal(undo.body.reason, 'running')
})

test('服务抛了异常：回 500，不把异常漏给调用方', async () => {
  const service = {
    revert: async () => { throw new Error('炸了') },
    undo: async () => { throw new Error('炸了') },
    state: async () => { throw new Error('炸了') },
  }
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, service)
  const result = await call(routes.get('/api/dsh-workbench.review.revert'), { sessionId: 's1', seq: 1, fileIndex: 0 })
  assert.equal(result.status, 500)
  assert.equal(result.body.reason, 'error')
})

test('处置：插件的 effect 撤掉后路由不再注册', async () => {
  const { ctx, routes, disposers } = fakeCtx()
  registerReviewRoutes(ctx, okService())
  assert.equal(routes.size, 3)
  for (const dispose of disposers) await dispose()
  assert.equal(routes.size, 0)
})

test('全链路：Request 进、真文件回退和撤销，已回退状态跟着变', async () => {
  const workspace = await tempDir('dsh-workbench-ws-')
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  const changes = {
    summary: () => ({ turn: 3, cwd: workspace, files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 }),
    diff: async () => ({
      kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+L2', ' l3'] }],
    }),
  }
  const service = createReviewService({
    changes,
    isRunning: () => false,
    store: createRevertStore(await tempDir('dsh-workbench-store-')),
  })
  const { ctx, routes } = fakeCtx()
  registerReviewRoutes(ctx, service)
  const coord = { sessionId: 'sess-1', seq: 3, fileIndex: 0, hunkIndex: 0 }
  const revert = await call(routes.get('/api/dsh-workbench.review.revert'), coord)
  assert.equal(revert.status, 200)
  assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\n')
  const state = await callState(routes.get('/api/dsh-workbench.review.state'), '?sessionId=sess-1&seq=3')
  assert.deepEqual(state.body.reverts, [{ fileIndex: 0, hunkIndex: 0, display: 'a.ts', description: '第 1–3 行这一处' }])
  const undo = await call(routes.get('/api/dsh-workbench.review.undo'), coord)
  assert.equal(undo.status, 200)
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3\n')
})

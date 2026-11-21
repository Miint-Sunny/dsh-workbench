/** 行入口的纯函数测试：keepDays 的校验（配错了行加载失败）、记录目录跟着 DSH_HOME 走。环境变量注入假的，不读本机。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { keepDaysOf, reviewDataDir } from '../lib/review/index.js'

test('keepDays：缺省 30，给了就必须是正整数，否则报错（行加载失败）', () => {
  assert.equal(keepDaysOf(undefined), 30)
  assert.equal(keepDaysOf(1), 1)
  assert.equal(keepDaysOf(365), 365)
  for (const bad of [0, -1, 1.5, '30', null]) {
    assert.throws(() => keepDaysOf(bad), /keepDays 要是正整数/, JSON.stringify(bad))
  }
})

test('记录目录：配置的 dataDir 优先；否则跟着注入的 DSH_HOME；没设或空串时在 ~/.dsh 下（和 lib/data-dir.js 一套）', () => {
  assert.equal(reviewDataDir({ dataDir: '/tmp/rr' }, { DSH_HOME: '/tmp/h' }), '/tmp/rr')
  assert.equal(reviewDataDir({}, { DSH_HOME: '/tmp/h' }), join('/tmp/h', 'dsh-workbench', 'review'))
  for (const unset of [undefined, '']) {
    const fallback = reviewDataDir({}, { DSH_HOME: unset })
    assert.ok(fallback.endsWith(join('.dsh', 'dsh-workbench', 'review')), fallback)
  }
})

// ---- 行接线（applyReview）：功能登记之外，路由和按天清理一起装上，撤销时全收走 ----

import { readFile, writeFile } from 'node:fs/promises'
import { apply, applyReview } from '../lib/review/index.js'
import { enabledFeatures, registerFeature } from '../lib/features.js'
import { tempDir } from './helpers/temp-dir.mjs'

/** 假的 cordis 上下文：inject 直接用同一个对象，effect 收下清理函数；改动记录服务可换。 */
function fakeContext(changes) {
  const disposers = []
  const routes = new Map()
  const ctx = {
    effect(body) {
      const dispose = body()
      if (dispose !== undefined) disposers.push(dispose)
      return () => {}
    },
    inject(_names, mount) { return mount(ctx) },
    workspaceChanges: changes ?? { summary: () => undefined, diff: async () => undefined },
    agents: { get: () => undefined },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } },
  }
  return { ctx, disposers, routes }
}

test('applyReview：注册三个路由，state 能答；撤销时路由收走、清理计时器停掉', async () => {
  const dataDir = await tempDir('dsh-workbench-review-row-')
  const { ctx, disposers, routes } = fakeContext()
  try {
    applyReview(ctx, { dataDir })
    assert.deepEqual([...routes.keys()].sort(), [
      '/api/dsh-workbench.review.revert',
      '/api/dsh-workbench.review.state',
      '/api/dsh-workbench.review.undo',
    ])
    const state = routes.get('/api/dsh-workbench.review.state')
    const response = await state.fetch(new Request('http://127.0.0.1:1/api/dsh-workbench.review.state?sessionId=s1&seq=3', { method: 'GET' }))
    assert.deepEqual(await response.json(), { ok: true, reverts: [] })
    // 撤销改动记录不在（DSH 重启过）也拒绝得有原因。
    const revert = routes.get('/api/dsh-workbench.review.revert')
    const refused = await revert.fetch(new Request('http://127.0.0.1:1/api/dsh-workbench.review.revert', {
      method: 'POST', body: JSON.stringify({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: null }),
    }))
    assert.equal(refused.status, 404)
  } finally {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') await dispose()
      else await dispose
    }
  }
  assert.equal(routes.size, 0)
})

test('功能登记：review 报到后 features 回答里有它', () => {
  const dispose = registerFeature('review')
  try {
    assert.ok(enabledFeatures().some(feature => feature.id === 'review' && feature.title === '改动审阅'))
  } finally {
    dispose()
  }
})


test('apply(ctx, config)：行配置传进去——keepDays 不是正整数就报错（登记过的功能跟着收走）', async () => {
  const { ctx, disposers } = fakeContext()
  try {
    assert.throws(() => apply(ctx, { keepDays: 0 }), /keepDays 要是正整数/)
  } finally {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') await dispose()
      else await dispose
    }
  }
  assert.equal(enabledFeatures().some(feature => feature.id === 'review'), false)
})

test('apply(ctx, config)：给了 dataDir，回退记录就写到那里', async () => {
  const dataDir = await tempDir('dsh-workbench-review-config-')
  const workspace = await tempDir('dsh-workbench-review-ws-')
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  const changes = {
    summary: () => ({ turn: 3, cwd: workspace, files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 }),
    diff: async () => ({
      kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+L2', ' l3'] }],
    }),
  }
  const { ctx, disposers, routes } = fakeContext(changes)
  let feature
  try {
    apply(ctx, { dataDir })
    const response = await routes.get('/api/dsh-workbench.review.revert').fetch(new Request('http://127.0.0.1:1/api/dsh-workbench.review.revert', {
      method: 'POST', body: JSON.stringify({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 0 }),
    }))
    assert.equal(response.status, 200)
    assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\n')
    feature = await readFile(join(dataDir, 's1', '3.0.0.json'), 'utf8')
    assert.ok(feature.includes('\"description\": \"第 1–3 行这一处\"'))
  } finally {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') await dispose()
      else await dispose
    }
  }
})

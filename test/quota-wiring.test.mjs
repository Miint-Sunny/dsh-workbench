/** quota 行的接线（lib/quota.js 的 apply）：报到功能登记处、注册路由、配置错了启动就报错。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/quota.js'
import { enabledFeatures } from '../lib/features.js'

/** 假 ctx：effect 收注销函数、inject 直接挂载（照 checkpoints-wiring 的写法）。 */
function makeCtx() {
  const book = { effects: [], routes: [] }
  const effect = fn => { const dispose = fn(); book.effects.push(dispose); return dispose }
  const scope = {
    credentials: { readRecord: async () => undefined, resolve: async () => undefined },
    connection: { fetch: { register: route => { book.routes.push(route); return () => book.routes.splice(book.routes.indexOf(route), 1) } } },
    effect,
    get: () => undefined,
  }
  const ctx = {
    effect,
    inject(_deps, mount) { return mount(scope) },
  }
  return {
    ctx, book,
    disposeAll() { for (const dispose of book.effects.splice(0)) dispose() },
  }
}

test('quota wiring: apply 报到登记处并注册路由，卸载撤销', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-quota-wire-'))
  const made = makeCtx()
  try {
    apply(made.ctx, { dir })
    assert.deepEqual(enabledFeatures().map(f => f.id), ['quota'])
    assert.equal(made.book.routes.length, 1)
    assert.equal(made.book.routes[0].path, '/api/dsh-workbench.quota.overview')
    // 凭据都解析不到：回答空清单，200
    const response = await made.book.routes[0].fetch(new Request('https://dsh/api/dsh-workbench.quota.overview'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.providers, [])
    assert.equal(body.spend, null)
    made.disposeAll()
    assert.deepEqual(enabledFeatures(), [])
    assert.equal(made.book.routes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quota wiring: 配置错了启动就报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-quota-wire-'))
  try {
    writeFileSync(join(dir, 'quota.json'), JSON.stringify({ timeoutSeconds: 0 }))
    assert.throws(() => apply(makeCtx().ctx, { dir }), /timeoutSeconds/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

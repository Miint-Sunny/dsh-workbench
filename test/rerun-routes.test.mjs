/** rerun 行的路由：GET 答存着的配置，POST 校验后保存，坏的请求体答 400（照 notify 的写法）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRerunRoutes, defaultRerunConfig, readRerunConfig } from '../lib/rerun-state.js'

test('rerun routes: GET serves defaults, POST validates and saves, bad bodies answer 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-rerun-routes-'))
  const routes = []
  const scope = {
    connection: { fetch: { register: route => { routes.push(route); return () => routes.pop() } } },
  }
  try {
    const dispose = applyRerunRoutes(scope, { dir })
    assert.equal(routes.length, 1)
    const route = routes[0]
    assert.equal(route.path, '/api/dsh-workbench.rerun.config')
    assert.deepEqual(route.methods, ['GET', 'POST'])
    assert.deepEqual((await (await route.fetch(new Request('http://dsh/api'))).json()), defaultRerunConfig())

    const saved = { archiveOriginal: true }
    const post = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify(saved) }))
    assert.equal(post.status, 200)
    assert.deepEqual((await post.json()), { ok: true, config: saved })
    assert.deepEqual(readRerunConfig(dir), saved)

    const bad = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: '{nope' }))
    assert.equal(bad.status, 400)
    const invalid = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ archiveOriginal: 'x' }) }))
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).message, /archiveOriginal/)
    // 保存失败以后文件里还是上一次存的
    assert.deepEqual(readRerunConfig(dir), saved)

    dispose()
    assert.equal(routes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

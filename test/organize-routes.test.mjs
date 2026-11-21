/** organize 行的路由：GET 答当前状态（损坏文件答默认状态加 reason），POST 校验后保存，坏的请求体答 400（照 notify/rerun 的写法）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOrganizeRoutes, defaultOrganizeState } from '../lib/organize-state.js'

test('organize routes: GET serves state, POST applies ops, bad bodies answer 400, corrupt files answer reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-organize-routes-'))
  const routes = []
  const scope = {
    connection: { fetch: { register: route => { routes.push(route); return () => routes.pop() } } },
  }
  try {
    const dispose = applyOrganizeRoutes(scope, { dir })
    assert.equal(routes.length, 1)
    const route = routes[0]
    assert.equal(route.path, '/api/dsh-workbench.organize')
    assert.deepEqual(route.methods, ['GET', 'POST'])

    // 文件还不存在：GET 答默认状态。
    assert.deepEqual(await (await route.fetch(new Request('http://dsh/api'))).json(), {
      ok: true, state: defaultOrganizeState(),
    })

    // POST 打标签、标未读、改名：都答新状态，文件跟着变。
    const post = async body => route.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify(body) }))
    const labeled = await (await post({ op: 'setLabel', sessionIds: ['s1'], labelId: 'red' })).json()
    assert.equal(labeled.ok, true)
    assert.deepEqual(labeled.state.assignments, { s1: 'red' })
    const unread = await (await post({ op: 'setUnread', sessionIds: ['s2'], unread: true })).json()
    assert.deepEqual(unread.state.unread, ['s2'])
    const renamed = await (await post({ op: 'renameLabel', labelId: 'red', name: '待回复' })).json()
    assert.deepEqual(renamed.state.labels[0], { id: 'red', name: '待回复' })
    assert.deepEqual((await (await route.fetch(new Request('http://dsh/api'))).json()).state, renamed.state)

    // 坏请求体、不认识的操作、校验失败：400 加 code 和 message，文件保持上一次的。
    const bad = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: '{nope' }))
    assert.equal(bad.status, 400)
    for (const [body, code] of [
      [{ op: 'nope' }, 'op.bad'],
      [{ op: 'setLabel', sessionIds: [], labelId: 'red' }, 'sessionIds.empty'],
      [{ op: 'setLabel', sessionIds: ['s1'], labelId: 'scarlet' }, 'labelId.bad'],
      [{ op: 'renameLabel', labelId: 'red', name: '蓝色' }, 'name.duplicate'],
      [{ op: 'setUnread', sessionIds: ['s1'], unread: 1 }, 'unread.bad'],
    ]) {
      const response = await post(body)
      assert.equal(response.status, 400, JSON.stringify(body))
      const answered = await response.json()
      assert.equal(answered.ok, false)
      assert.equal(answered.code, code)
      assert.ok(typeof answered.message === 'string' && answered.message !== '')
    }
    assert.deepEqual((await (await route.fetch(new Request('http://dsh/api'))).json()).state, renamed.state)

    // 文件损坏：GET 答默认状态加 reason，第一个 POST 先备份再写。
    writeFileSync(join(dir, 'organize.json'), 'not json')
    const corrupt = await (await route.fetch(new Request('http://dsh/api'))).json()
    assert.equal(corrupt.ok, false)
    assert.equal(corrupt.reason, 'corrupt')
    assert.deepEqual(corrupt.state, defaultOrganizeState())
    const saved = await (await post({ op: 'setLabel', sessionIds: ['s9'], labelId: 'green' })).json()
    assert.equal(saved.ok, true)
    assert.equal(readFileSync(join(dir, 'organize.json.bad'), 'utf8'), 'not json')
    assert.deepEqual((await (await route.fetch(new Request('http://dsh/api'))).json()).state, saved.state)

    dispose()
    assert.equal(routes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

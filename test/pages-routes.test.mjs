/** 网页发布的路由：list/html（含 HEAD 和响应头）、delete/restore、publish 的工作区包含检查
 * （../ 越界、绝对路径、符号链接逃出都被拒——这是路由收路径的唯一例外，README 写明）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPagesRoutes } from '../lib/pages-routes.js'
import { createPagesStore } from '../lib/pages-store.js'

const dirOf = () => mkdtempSync(join(tmpdir(), 'dwb-pages-routes-'))

/** 按插件里的写法组一个路由测试台：注册进假的 connection，工作区根由 roots 回答。 */
function harness(roots) {
  const dir = dirOf()
  const store = createPagesStore(join(dir, 'pages'))
  const routes = new Map()
  const scope = {
    connection: {
      fetch: {
        register: (route) => {
          if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  const dispose = applyPagesRoutes(scope, { store, workspaceRootOf: async (sessionId) => roots[sessionId] })
  return {
    dir,
    store,
    route: (name) => {
      const route = routes.get(`/api/dsh-workbench.pages.${name}`)
      assert.ok(route, `路由 ${name} 必须注册`)
      return route
    },
    dispose: () => {
      dispose()
      assert.equal(routes.size, 0)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('publish：发布、同源加版；坏的请求体 400', async () => {
  const work = dirOf()
  const h = harness({ s1: work })
  try {
    writeFileSync(join(work, 'index.html'), '<html><head><title>看板</title></head></html>')
    const publish = h.route('publish')
    const first = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'index.html' }) }))
    assert.equal(first.status, 200)
    const body = await first.json()
    assert.equal(body.ok, true)
    assert.equal(body.page.title, '看板')
    assert.equal(body.page.n, 1)

    const second = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: './index.html' }) }))
    const secondBody = await second.json()
    assert.equal(secondBody.page.id, body.page.id)
    assert.equal(secondBody.page.n, 2)

    // 坏的请求体
    const notJson = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: '{nope' }))
    assert.equal(notJson.status, 400)
    const badSession = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: '../x', path: 'index.html' }) }))
    assert.equal(badSession.status, 400)
    const unknown = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: 'gone', path: 'index.html' }) }))
    assert.equal(unknown.status, 404)
    assert.match((await unknown.json()).message, /不存在/)
    const extra = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'index.html', evil: 1 }) }))
    assert.equal(extra.status, 400)
  } finally {
    h.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

test('publish 的路径例外：越界、绝对路径、符号链接逃出、非 HTML 都被拒，不读文件', async () => {
  const work = dirOf()
  const outside = dirOf()
  const h = harness({ s1: work })
  try {
    writeFileSync(join(work, 'index.html'), '<html></html>')
    writeFileSync(join(work, 'notes.txt'), 'x')
    writeFileSync(join(outside, 'secret.html'), '<p>s</p>')
    symlinkSync(join(outside, 'secret.html'), join(work, 'link.html'))
    const publish = h.route('publish')
    const post = async (payload) => {
      const response = await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify(payload) }))
      const text = await response.text()
      return { status: response.status, text }
    }
    // ../ 越界（真的有这个文件也拒）
    writeFileSync(join(work, '..', 'dwb-route-escape.html'), '<p>e</p>')
    for (const [payload, pattern] of [
      [{ sessionId: 's1', path: '../dwb-route-escape.html' }, /工作区之外/],
      [{ sessionId: 's1', path: '/etc/passwd' }, /相对路径/],
      [{ sessionId: 's1', path: 'link.html' }, /不是普通文件/],
      [{ sessionId: 's1', path: 'notes.txt' }, /不是 HTML/],
      [{ sessionId: 's1', path: 'gone.html' }, /不存在/],
    ]) {
      const result = await post(payload)
      assert.equal(result.status, payload.path === 'gone.html' ? 404 : 400, `${payload.path}：${result.text}`)
      assert.match(result.text, pattern)
    }
    rmSync(join(work, '..', 'dwb-route-escape.html'))
    // 全部被拒：一个页面都没建
    assert.deepEqual(h.store.listPages(), { pages: [] })
    rmSync(outside, { recursive: true, force: true })
  } finally {
    h.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

test('html：带 CSP 和 nosniff 的响应头，HEAD 答 200 空 body，坏参数 400，不存在 404', async () => {
  const work = dirOf()
  const h = harness({ s1: work })
  try {
    writeFileSync(join(work, 'index.html'), '<html><head><title>看板</title></head><body>hi</body></html>')
    const publish = h.route('publish')
    const { page } = await (await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'index.html' }) }))).json()

    const htmlRoute = h.route('html')
    const url = `http://dsh/api/dsh-workbench.pages.html?page=${page.id}&v=1`
    const get = await htmlRoute.fetch(new Request(url))
    assert.equal(get.status, 200)
    assert.equal(get.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(get.headers.get('content-security-policy'), 'sandbox')
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(get.headers.get('x-dns-prefetch-control'), 'off')
    assert.match(await get.text(), /看板/)
    const head = await htmlRoute.fetch(new Request(url, { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    assert.equal(head.headers.get('content-security-policy'), 'sandbox')
    assert.equal(head.headers.get('x-dns-prefetch-control'), 'off')

    assert.equal((await htmlRoute.fetch(new Request('http://dsh/api/dsh-workbench.pages.html?page=../x&v=1'))).status, 400)
    assert.equal((await htmlRoute.fetch(new Request('http://dsh/api/dsh-workbench.pages.html?page=a-1&v=0'))).status, 400)
    assert.equal((await htmlRoute.fetch(new Request(`http://dsh/api/dsh-workbench.pages.html?page=${page.id}&v=9`))).status, 404)
    assert.equal((await htmlRoute.fetch(new Request('http://dsh/api/dsh-workbench.pages.html?page=gone-1&v=1'))).status, 404)
  } finally {
    h.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

test('list 和 delete/restore：列表答全部字段，删除后 404，恢复回来又能读', async () => {
  const work = dirOf()
  const h = harness({ s1: work })
  try {
    writeFileSync(join(work, 'index.html'), '<html><head><title>看板</title></head></html>')
    const publish = h.route('publish')
    const { page } = await (await publish.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'index.html' }) }))).json()

    const list = h.route('list')
    const listed = await (await list.fetch(new Request('http://dsh/api/dsh-workbench.pages.list'))).json()
    assert.equal(listed.pages.length, 1)
    assert.equal(listed.pages[0].id, page.id)
    assert.equal(listed.pages[0].source.path, 'index.html')
    assert.equal(typeof listed.pages[0].dir, 'string')
    assert.equal(listed.pages[0].corrupt, false)

    const del = h.route('delete')
    const bad = await del.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ page: '../x' }) }))
    assert.equal(bad.status, 400)
    const gone = await del.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ page: 'gone-1' }) }))
    assert.equal(gone.status, 404)
    const ok = await del.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ page: page.id }) }))
    assert.equal(ok.status, 200)
    assert.equal((await h.route('html').fetch(new Request(`http://dsh/api/dsh-workbench.pages.html?page=${page.id}&v=1`))).status, 404)

    const restore = h.route('restore')
    const restored = await restore.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ page: page.id }) }))
    assert.equal(restored.status, 200)
    assert.equal((await h.route('html').fetch(new Request(`http://dsh/api/dsh-workbench.pages.html?page=${page.id}&v=1`))).status, 200)
    const again = await restore.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ page: page.id }) }))
    assert.equal(again.status, 404)
  } finally {
    h.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

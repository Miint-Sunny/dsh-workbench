/** 工作区信任（feat#121）的信任记录和两条路由。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32, posix } from 'node:path'
import { createTrustStore, TRUST_FILE } from '../lib/workspace-trust-store.js'
import { applyWorkspaceTrustRoutes, trustRefusal } from '../lib/workspace-trust.js'
import { enabledFeatures } from '../lib/features.js'

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-trust-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('默认一个都不信任；信任、去重、撤销', (t) => {
  const dir = temp(t)
  let now = Date.parse('2026-11-13T03:20:00Z')
  const store = createTrustStore(dir, { clock: () => now })
  assert.deepEqual(store.list(), [])
  assert.equal(store.isTrusted('/w/a'), false)
  store.trust('/w/a')
  now += 1000
  store.trust('/w/a')
  store.trust('/w/b')
  assert.deepEqual(store.list(), [
    { path: '/w/a', trustedAt: '2026-11-13T03:20:00.000Z' },
    { path: '/w/b', trustedAt: '2026-11-13T03:20:01.000Z' },
  ])
  assert.equal(store.isTrusted('/w/a'), true)
  assert.equal(store.isTrusted('/w/a/sub'), false, '信任不向下继承到别的工作区路径')
  assert.equal(store.isTrusted('/w'), false)
  assert.equal(store.revoke('/w/a'), true)
  assert.equal(store.revoke('/w/a'), false)
  assert.deepEqual(store.list().map(entry => entry.path), ['/w/b'])
  const saved = JSON.parse(readFileSync(join(dir, TRUST_FILE), 'utf8'))
  assert.deepEqual(saved, { version: 1, workspaces: [{ path: '/w/b', trustedAt: '2026-11-13T03:20:01.000Z' }] })
})

test('文件坏了或形状不对时按全部没信任处理，不写回', (t) => {
  const dir = temp(t)
  const store = createTrustStore(dir)
  for (const bad of ['{', '[]', '{"version":2,"workspaces":[]}', '{"version":1,"workspaces":[{"path":"relative","trustedAt":"x"}]}', '{"version":1,"workspaces":"/"}']) {
    writeFileSync(join(dir, TRUST_FILE), bad)
    assert.deepEqual(store.list(), [], bad)
    assert.equal(store.isTrusted('/'), false)
    assert.equal(readFileSync(join(dir, TRUST_FILE), 'utf8'), bad)
  }
})

test('每次判断都重读文件，别处撤销立即生效', (t) => {
  const dir = temp(t)
  const first = createTrustStore(dir), second = createTrustStore(dir)
  first.trust('/w/a')
  assert.equal(second.isTrusted('/w/a'), true)
  second.revoke('/w/a')
  assert.equal(first.isTrusted('/w/a'), false)
})

test('根目录和主目录不能设为信任', () => {
  assert.equal(trustRefusal('/', '/Users/me'), 'too-broad')
  assert.equal(trustRefusal('/Users/me', '/Users/me'), 'too-broad')
  assert.equal(trustRefusal('/Users/me/', '/Users/me'), 'too-broad')
  assert.equal(trustRefusal('/Users/me/code', '/Users/me'), undefined)
  assert.equal(trustRefusal('/Users', '/Users/me'), 'too-broad', '主目录的上级同样太宽')
})

test('「是不是根」在 Windows 上也成立：任何盘符的根、UNC 共享的根都拒绝', () => {
  const home = 'C:\\Users\\me'
  for (const root of ['C:\\', 'D:\\', 'd:\\', 'E:\\', '\\\\server\\share\\', '\\\\server\\share']) {
    assert.equal(trustRefusal(root, home, win32), 'too-broad', root)
  }
  assert.equal(trustRefusal('C:\\Users', home, win32), 'too-broad', '主目录的上级')
  assert.equal(trustRefusal('c:\\users\\ME', home, win32), 'too-broad', 'Windows 路径不分大小写')
  assert.equal(trustRefusal('D:\\code\\proj', home, win32), undefined)
  assert.equal(trustRefusal('\\\\server\\share\\proj', home, win32), undefined)
})

test('主目录下的「下载」「桌面」「文稿」三个目录本身不能信任，它们下面的子目录可以', () => {
  for (const name of ['Downloads', 'Desktop', 'Documents']) {
    assert.equal(trustRefusal(`/Users/me/${name}`, '/Users/me', posix), 'too-broad', name)
    assert.equal(trustRefusal(`/Users/me/${name}/site`, '/Users/me', posix), undefined, `${name}/site`)
    assert.equal(trustRefusal(`C:\\Users\\me\\${name.toLowerCase()}`, 'C:\\Users\\me', win32), 'too-broad', `win ${name}`)
  }
  assert.equal(trustRefusal('/Users/me/Downloads2', '/Users/me', posix), undefined)
})

/** 顶层页面先 GET 列表拿到的令牌；改信任记录和读资源的 POST 都要带上。 */
async function tokenOf(routes) {
  const response = await routes.get('/api/dsh-workbench.workspace-trust').fetch(new Request('http://127.0.0.1/api/dsh-workbench.workspace-trust', { method: 'GET' }))
  return (await response.json()).token
}

/** 照顶层页面的写法发 POST：JSON 正文加令牌。 */
async function postAs(routes, path, body) {
  return routes.get(path).fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-dsh-workbench-trust': await tokenOf(routes) } }))
}

/** 路由测试台：假的 connection，工作区根由 roots 回答。 */
function harness(t, roots) {
  const base = temp(t)
  const dataDir = join(base, 'data')
  const routes = new Map()
  const scope = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  const dispose = applyWorkspaceTrustRoutes(scope, { dataDir, home: base, workspaceRootOf: async id => roots(base)[id] })
  const call = async (path, body, method = 'POST', headers) => {
    const route = routes.get(path)
    assert.ok(route, path)
    assert.ok(route.methods.includes(method), `${path} ${method}`)
    const sent = headers ?? { 'content-type': 'application/json', 'x-dsh-workbench-trust': await tokenOf(routes) }
    const response = await route.fetch(new Request(`http://127.0.0.1${path}`, method === 'GET' ? { method } : { method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: sent }))
    return response
  }
  return { base, dataDir, routes, dispose, call, json: async (...args) => { const r = await call(...args); return { status: r.status, body: await r.json() } } }
}

function workspace(base) {
  const ws = join(base, 'proj')
  mkdirSync(join(ws, 'img'), { recursive: true })
  writeFileSync(join(ws, 'index.html'), '<p>')
  writeFileSync(join(ws, 'style.css'), 'p{}')
  writeFileSync(join(ws, '.env'), 'TOKEN=1')
  return ws
}

test('status、trust、revoke 和列表', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'proj'), HOME: base }))
  const ws = workspace(h.base)
  const real = realpathSync(ws)
  assert.deepEqual((await h.json('/api/dsh-workbench.workspace-trust', { action: 'status', sessionId: 'S1' })).body,
    { ok: true, root: ws, realRoot: real, display: '~/proj', trusted: false, documentInside: false })
  const trusted = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })
  assert.equal(trusted.status, 200)
  assert.deepEqual(trusted.body.workspaces.map(entry => [entry.path, entry.display]), [[real, '~/proj']])
  assert.equal((await h.json('/api/dsh-workbench.workspace-trust', { action: 'status', sessionId: 'S1' })).body.trusted, true)
  assert.deepEqual((await h.json('/api/dsh-workbench.workspace-trust', null, 'GET')).body.workspaces.map(entry => entry.path), [real])
  const revoked = await h.json('/api/dsh-workbench.workspace-trust', { action: 'revoke', path: real })
  assert.deepEqual(revoked.body.workspaces, [])
  h.dispose()
  assert.equal(h.routes.size, 0)
})

test('文档状态由宿主按真实路径判断：符号链接外跳、缺失文档不在工作区内', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'proj'), S2: join(base, 'other') }))
  t.after(h.dispose)
  const ws = workspace(h.base)
  mkdirSync(join(h.base, 'other'))
  writeFileSync(join(h.base, 'other', 'page.html'), '<script>globalThis.ran = true</script>')
  symlinkSync(join(h.base, 'other', 'page.html'), join(ws, 'linked.html'))
  await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })
  for (const [sessionId, documentPath, expected] of [
    ['S1', join(ws, 'index.html'), true],
    ['S1', join(ws, 'linked.html'), false],
    ['S1', join(ws, 'gone.html'), false],
    ['S1', join(ws, '..', 'other', 'page.html'), false],
    ['S2', join(ws, 'index.html'), false],
    ['S1', undefined, false],
  ]) {
    const result = await h.json('/api/dsh-workbench.workspace-trust', { action: 'status', sessionId, documentPath })
    assert.equal(result.status, 200)
    assert.equal(result.body.documentInside, expected, `${sessionId}: ${documentPath}`)
  }
})

test('文档状态保留点目录 HTML、主目录缩写和工作区别名的预览', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'alias') }))
  t.after(h.dispose)
  const ws = workspace(h.base)
  mkdirSync(join(ws, '.hidden'))
  writeFileSync(join(ws, '.hidden', 'page.html'), '<script>globalThis.ran = true</script>')
  symlinkSync(ws, join(h.base, 'alias'))
  for (const documentPath of [join(ws, '.hidden', 'page.html'), '~/proj/.hidden/page.html', join(h.base, 'alias', 'index.html'), join(realpathSync(ws), 'index.html')]) {
    const result = await h.json('/api/dsh-workbench.workspace-trust', { action: 'status', sessionId: 'S1', documentPath })
    assert.equal(result.body.documentInside, true, documentPath)
  }
})

test('文档预检拒绝非路径 JSON，信任写入仍只接受会话', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'proj') }))
  t.after(h.dispose)
  workspace(h.base)
  for (const documentPath of [null, 42, {}, '', 'relative.html', '/w/a\0.html']) {
    assert.equal((await h.json('/api/dsh-workbench.workspace-trust', { action: 'status', sessionId: 'S1', documentPath })).status, 400)
  }
})

test('trust 只收会话 id，不收路径；主目录拒绝；未知会话和坏请求回 400', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'proj'), HOME: base }))
  workspace(h.base)
  const byPath = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', path: '/' })
  assert.equal(byPath.status, 400)
  const home = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'HOME' })
  assert.deepEqual([home.status, home.body.reason], [400, 'too-broad'])
  const unknown = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'nope' })
  assert.deepEqual([unknown.status, unknown.body.reason], [400, 'no-workspace'])
  assert.equal((await h.json('/api/dsh-workbench.workspace-trust', '{')).status, 400)
  assert.equal((await h.json('/api/dsh-workbench.workspace-trust', { action: 'delete' })).status, 400)
  assert.deepEqual((await h.json('/api/dsh-workbench.workspace-trust', null, 'GET')).body.workspaces, [])
})

test('资源路由：没信任 403；信任后回字节和自己定的类型；越界回原因', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'proj') }))
  const ws = workspace(h.base)
  const doc = `S1${ws}/index.html`
  const resource = (name) => h.call('/api/dsh-workbench.workspace-trust.resource', { document: doc, resource: `S1${ws}/${name}` })
  let response = await resource('style.css')
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { ok: false, reason: 'untrusted', display: 'style.css' })
  await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })
  response = await resource('style.css')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/css')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), 'p{}')
  response = await resource('.env')
  assert.equal(response.status, 403)
  assert.equal((await response.json()).reason, 'hidden')
  response = await h.call('/api/dsh-workbench.workspace-trust.resource', { document: doc, resource: `S2${ws}/style.css` })
  assert.equal((await response.json()).reason, 'other-session')
  response = await h.call('/api/dsh-workbench.workspace-trust.resource', { document: 'garbage', resource: `S1${ws}/style.css` })
  assert.equal(response.status, 400)
})

test('这一行报到功能登记处，卸载时除名', async () => {
  const { apply } = await import('../lib/workspace-trust.js')
  const effects = []
  const ctx = { effect: (fn) => { effects.push(fn()) }, inject: () => {} }
  apply(ctx)
  assert.ok(enabledFeatures().some(feature => feature.id === 'workspace-trust'))
  for (const dispose of effects) dispose?.()
  assert.ok(!enabledFeatures().some(feature => feature.id === 'workspace-trust'))
})

test('会话 cwd 是符号链接时，状态里显示的是会记下的真实路径', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'link') }))
  const ws = workspace(h.base)
  symlinkSync(ws, join(h.base, 'link'))
  const status = await h.json('/api/dsh-workbench.workspace-trust', { action: 'status', sessionId: 'S1' })
  assert.equal(status.body.realRoot, realpathSync(ws))
  assert.equal(status.body.display, '~/proj')
})

test('主目录下的下载目录本身不能信任，拒绝时给出原因', async (t) => {
  const h = harness(t, base => ({ DL: join(base, 'Downloads'), SUB: join(base, 'Downloads', 'site') }))
  mkdirSync(join(h.base, 'Downloads', 'site'), { recursive: true })
  const refused = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'DL' })
  assert.deepEqual([refused.status, refused.body.reason], [400, 'too-broad'])
  const sub = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'SUB' })
  assert.equal(sub.status, 200)
})

test('符号链接写法的工作区根按真实路径记', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'link') }))
  const ws = workspace(h.base)
  symlinkSync(ws, join(h.base, 'link'))
  const trusted = await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })
  assert.deepEqual(trusted.body.workspaces.map(entry => entry.path), [realpathSync(ws)])
})

test('宿主端读文件的闸门：同时最多 N 个在读，排队满了直接拒绝', async () => {
  const { createReadGate } = await import('../lib/workspace-trust.js')
  const gate = createReadGate({ maxActive: 2, maxQueued: 3 })
  let active = 0, peak = 0
  const holds = []
  const task = () => gate.run(async () => { active++; peak = Math.max(peak, active); await new Promise(r => holds.push(r)); active-- })
  const runs = Array.from({ length: 7 }, task)
  const settled = Promise.allSettled(runs)
  await new Promise(r => setImmediate(r))
  assert.equal(peak, 2)
  while (holds.length || active) { holds.shift()?.(); await new Promise(r => setImmediate(r)) }
  const outcome = await settled
  assert.equal(outcome.filter(r => r.status === 'fulfilled').length, 5)
  assert.ok(outcome.filter(r => r.status === 'rejected').every(r => r.reason.code === 'limit'))
})

test('宿主端每个文档有数量和字节上限，别的文档不受影响', async (t) => {
  const base = temp(t)
  const ws = workspace(base)
  writeFileSync(join(ws, 'other.html'), '<p>')
  const routes = new Map()
  const scope = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  applyWorkspaceTrustRoutes(scope, { dataDir: join(base, 'data'), home: base, workspaceRootOf: async () => ws, limits: { maxResources: 2, maxBytes: 1000 } })
  const post = (path, body) => postAs(routes, path, body)
  await post('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })
  const get = (doc, name) => post('/api/dsh-workbench.workspace-trust.resource', { document: `S1${ws}/${doc}`, resource: `S1${ws}/${name}` })
  assert.equal((await get('index.html', 'style.css')).status, 200)
  assert.equal((await get('index.html', 'style.css')).status, 200)
  const third = await get('index.html', 'style.css')
  assert.deepEqual([third.status, (await third.json()).reason], [429, 'limit'])
  assert.equal((await get('other.html', 'style.css')).status, 200, '另一个文档有自己的额度')
})

test('资源路由接在闸门上：同一时刻的大量请求，超出在读和排队名额的立刻回 429', async (t) => {
  const base = temp(t)
  const ws = workspace(base)
  const routes = new Map()
  const scope = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  applyWorkspaceTrustRoutes(scope, { dataDir: join(base, 'data'), home: base, workspaceRootOf: async () => ws, limits: { maxActive: 2, maxQueued: 3 } })
  const post = (path, body) => postAs(routes, path, body)
  await post('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/api/dsh-workbench.workspace-trust.resource', { document: `S1${ws}/index.html`, resource: `S1${ws}/style.css?v=${i}`.replace('?', '%3F') })))
  const ok = answers.filter(r => r.status === 200 || r.status === 403).length
  const limited = answers.filter(r => r.status === 429).length
  assert.ok(ok <= 5, `进入闸门的 ${ok}`)
  assert.equal(ok + limited, 20)
})

test('改信任记录和读资源只认顶层页面：要 JSON 正文，也要带 GET 才拿得到的令牌', async (t) => {
  const h = harness(t, base => ({ S1: join(base, 'proj') }))
  const ws = workspace(h.base)
  const list = await h.json('/api/dsh-workbench.workspace-trust', null, 'GET')
  assert.match(list.body.token, /^[A-Za-z0-9_-]{40,}$/)
  const body = JSON.stringify({ action: 'trust', sessionId: 'S1' })
  for (const headers of [
    { 'content-type': 'application/json' },
    { 'content-type': 'application/json', 'x-dsh-workbench-trust': 'guess' },
    { 'content-type': 'text/plain', 'x-dsh-workbench-trust': list.body.token },
    {},
  ]) {
    const refused = await h.call('/api/dsh-workbench.workspace-trust', body, 'POST', headers)
    assert.deepEqual([refused.status, (await refused.json()).reason], [403, 'forbidden'], JSON.stringify(headers))
  }
  const resource = await h.call('/api/dsh-workbench.workspace-trust.resource', { document: `S1${ws}/index.html`, resource: `S1${ws}/style.css` }, 'POST', { 'content-type': 'application/json' })
  assert.deepEqual([resource.status, (await resource.json()).reason], [403, 'forbidden'])
  assert.deepEqual((await h.json('/api/dsh-workbench.workspace-trust', null, 'GET')).body.workspaces, [], '被拒的请求没有改动信任记录')
  assert.equal((await h.json('/api/dsh-workbench.workspace-trust', { action: 'trust', sessionId: 'S1' })).status, 200)
})

test('令牌每个宿主进程各不相同', async (t) => {
  const a = harness(t, () => ({})), b = harness(t, () => ({}))
  const tokenA = (await a.json('/api/dsh-workbench.workspace-trust', null, 'GET')).body.token
  const tokenB = (await b.json('/api/dsh-workbench.workspace-trust', null, 'GET')).body.token
  assert.notEqual(tokenA, tokenB)
})

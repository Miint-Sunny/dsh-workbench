/**
 * 工作区文件夹和权限（feat#159）的宿主端：可写目录的登记同步和对话框用的路由。
 * - 存下来的设置在会话加载时（agent/created，含重启后恢复的会话）重新登记；
 * - 设置改了以后，开着的会话马上跟着变，每次请求前（agent/pre-step）再对一遍，文件夹不见了就撤掉；
 * - 路由：GET 带令牌回答列表；POST 只认 JSON 加令牌；添加前在宿主端重新分类。
 * - 返工（审查第 3、4、9 条）：外部文件夹拒绝范围太大的目录（添加时和登记时）；组装系统提示词时排在官方沙箱说明前面先对一遍；
 *   挂载时对已加载的会话各对一遍；对话框和登记用同一个判据（符号链接显示失效）。
 * 官方的 registerWritableRoot、工作区登记表、路由注册、系统提示词登记都用替身；文件夹用真的临时目录（分类和登记要解析真实路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWorkspaceFolders, createRootSync, FOLDERS_TOKEN_HEADER } from '../lib/workspace-folders.js'
import { createFoldersStore, FOLDERS_FILE } from '../lib/workspace-folders-store.js'

/** 临时目录：main、main/sub、ext、other，数据目录，和当 DSH_HOME 用的 srv/dsh。 */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dwb-wf-host-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['main/sub', 'main/inner', 'ext', 'other', 'data', 'srv/dsh']) mkdirSync(join(root, dir), { recursive: true })
  symlinkSync(join(root, 'ext'), join(root, 'ext-link'))
  return {
    root,
    main: join(root, 'main'), sub: join(root, 'main', 'sub'), inner: join(root, 'main', 'inner'),
    ext: join(root, 'ext'), other: join(root, 'other'), data: join(root, 'data'), dsh: join(root, 'srv', 'dsh'),
  }
}

/** rc.3 dsh-system-prompt 的 context 排位（getContextOrder）。 */
const CONTEXT_ORDERS = { WORKING_DIRECTORY: 100, SANDBOX_POLICY: 110, APPROVAL_POLICY: 115 }

/** 宿主作用域的替身：事件、沙箱策略、工作区登记表、路由、已加载的会话、系统提示词的 context。 */
function fakeScope(paths) {
  const handlers = new Map()
  const registered = []
  const routes = new Map()
  const loaded = []
  const contexts = new Map()
  const workspaces = [
    { id: 'w-main', path: paths.main, title: 'main' },
    { id: 'w-sub', path: paths.sub, title: 'sub' },
  ]
  return {
    registered,
    workspaces,
    loaded,
    contexts,
    agents: { list: () => [...loaded], get: id => loaded.find(agent => agent.id === id) },
    systemPrompt: {
      getContextOrder: name => CONTEXT_ORDERS[name],
      context(entry) {
        if (contexts.has(entry.name)) throw new Error(`prompt context "${entry.name}" is already registered`)
        contexts.set(entry.name, entry)
        return () => contexts.delete(entry.name)
      },
    },
    /** 照 rc.3 的 assemble 求 context：按 order 排好，依次同步求值，空串不出现在说明里。 */
    assemble: agent => [...contexts.values()].sort((a, b) => a.order - b.order)
      .map(entry => (typeof entry.text === 'function' ? entry.text({ agent, scope: agent }) : entry.text))
      .filter(text => text.length > 0),
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    emit(name, payload, next) {
      if (name === 'agent/created' && !loaded.includes(payload.agent)) loaded.push(payload.agent)
      if (name === 'agent/disposed' && loaded.includes(payload.agent)) loaded.splice(loaded.indexOf(payload.agent), 1)
      return handlers.get(name)?.(payload, next)
    },
    sandboxPolicy: {
      registerWritableRoot(session, dir) {
        const entry = { session: session.id, dir, live: true }
        registered.push(entry)
        return () => { entry.live = false }
      },
    },
    workspaceRegistry: { list: () => workspaces },
    connection: { fetch: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } } },
    route: path => routes.get(path),
    live: session => registered.filter(entry => entry.live && entry.session === session).map(entry => entry.dir),
  }
}

const agentAt = (id, cwd) => ({ id, session: { id, header: { cwd } } })

test('登记同步：按要的目录登记，少了的撤掉，多了的补上；会话结束全部撤掉；登记抛错不影响别的目录', () => {
  const calls = []
  let want = ['/a', '/b']
  const sync = createRootSync({
    register(session, dir) {
      if (dir === '/bad') throw new Error('bad dir')
      calls.push(`+${dir}`)
      return () => calls.push(`-${dir}`)
    },
    rootsFor: () => want,
  })
  const agent = agentAt('s1', '/w')
  sync.sync(agent)
  assert.deepEqual(calls, ['+/a', '+/b'])
  want = ['/b', '/c', '/bad']
  sync.sync(agent)
  assert.deepEqual(calls, ['+/a', '+/b', '-/a', '+/c'])
  assert.deepEqual(sync.registered(agent), ['/b', '/c'])
  sync.drop(agent)
  assert.deepEqual(calls.slice(-2).sort(), ['-/b', '-/c'])
  assert.deepEqual(sync.registered(agent), [])
})

test('存下来的设置在会话加载时重新登记（重启后恢复的会话一样）', (t) => {
  const paths = fixture(t)
  const store = createFoldersStore(paths.data)
  store.addExternal('w-main', paths.ext)
  store.setWritable('w-main', 'w-sub', true)
  // 第一次启动
  const first = fakeScope(paths)
  const stop = applyWorkspaceFolders(first, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  first.emit('agent/created', { agent: agentAt('main-1', paths.main), source: 'fresh' })
  first.emit('agent/created', { agent: agentAt('sub-1', paths.sub), source: 'fresh' })
  assert.deepEqual(first.live('main-1'), [paths.ext])
  assert.deepEqual(first.live('sub-1'), [paths.main])
  stop()
  assert.deepEqual(first.live('main-1'), [], '这一行卸载时撤掉自己的登记')
  // 「重启」：新的宿主作用域，同一个数据目录，恢复同一个会话
  const second = fakeScope(paths)
  applyWorkspaceFolders(second, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  second.emit('agent/created', { agent: agentAt('main-1', paths.main), source: 'resume' })
  assert.deepEqual(second.live('main-1'), [paths.ext])
})

test('子智能体（会话头 cwd 是父会话的工作区）也按同一个工作区登记', (t) => {
  const paths = fixture(t)
  createFoldersStore(paths.data).addExternal('w-main', paths.ext)
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  scope.emit('agent/created', { agent: agentAt('child', paths.main), source: 'fresh' })
  assert.deepEqual(scope.live('child'), [paths.ext])
})

test('每次请求前对一遍：外部文件夹不见了就撤掉，回来了再登记；之后照常往下走', async (t) => {
  const paths = fixture(t)
  createFoldersStore(paths.data).addExternal('w-main', paths.ext)
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  const agent = agentAt('main-1', paths.main)
  scope.emit('agent/created', { agent, source: 'fresh' })
  rmSync(paths.ext, { recursive: true })
  const decision = await scope.emit('agent/pre-step', { agent }, async () => ({ kind: 'continue' }))
  assert.deepEqual(decision, { kind: 'continue' })
  assert.deepEqual(scope.live('main-1'), [])
  mkdirSync(paths.ext)
  await scope.emit('agent/pre-step', { agent }, async () => ({ kind: 'continue' }))
  assert.deepEqual(scope.live('main-1'), [paths.ext])
  scope.emit('agent/disposed', { agent })
  assert.deepEqual(scope.live('main-1'), [])
})

/** 调路由：GET 拿令牌，POST 带上。 */
async function client(scope, workspaceId) {
  const def = scope.route('/api/dsh-workbench.workspace-folders')
  const get = async (id = workspaceId) => {
    const response = await def.fetch(new Request(`http://h/api/dsh-workbench.workspace-folders?workspaceId=${encodeURIComponent(id)}`))
    return { status: response.status, body: await response.json() }
  }
  const { body } = await get()
  const post = async (payload, headers = { 'content-type': 'application/json', [FOLDERS_TOKEN_HEADER]: body.token }) => {
    const response = await def.fetch(new Request('http://h/api/dsh-workbench.workspace-folders', { method: 'POST', headers, body: JSON.stringify(payload) }))
    return { status: response.status, body: await response.json() }
  }
  return { get, post, token: body.token }
}

test('路由 GET：主文件夹、嵌在里面的已登记工作区、外部文件夹，路径带显示用的写法；不认识的工作区 404', async (t) => {
  const paths = fixture(t)
  createFoldersStore(paths.data).addExternal('w-main', paths.ext)
  createFoldersStore(paths.data).addExternal('w-main', join(paths.root, 'gone'))
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  const { get, token } = await client(scope, 'w-main')
  assert.equal(typeof token, 'string')
  const { status, body } = await get()
  assert.equal(status, 200)
  assert.deepEqual(body.workspace, { id: 'w-main', title: 'main', path: paths.main, display: '~/main/', missing: false })
  assert.deepEqual(body.subfolders, [{ id: 'w-sub', title: 'sub', path: paths.sub, display: '~/main/sub/', writable: false, missing: false }])
  assert.deepEqual(body.externals, [
    { path: paths.ext, display: '~/ext/', missing: false },
    { path: join(paths.root, 'gone'), display: '~/gone/', missing: true },
  ])
  assert.equal((await get('w-nope')).status, 404)
})

test('路由 POST：没有令牌、令牌不对、不是 JSON 的一律 403，不改设置', async (t) => {
  const paths = fixture(t)
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  const { post, token } = await client(scope, 'w-main')
  const payload = { action: 'add-external', workspaceId: 'w-main', path: paths.ext }
  assert.equal((await post(payload, { 'content-type': 'application/json' })).status, 403)
  assert.equal((await post(payload, { 'content-type': 'application/json', [FOLDERS_TOKEN_HEADER]: 'nope' })).status, 403)
  assert.equal((await post(payload, { 'content-type': 'text/plain', [FOLDERS_TOKEN_HEADER]: token })).status, 403)
  assert.deepEqual(createFoldersStore(paths.data).read(), {})
})

test('路由 classify：子文件夹、外部文件夹（含符号链接解析）、上级目录、重复、找不到', async (t) => {
  const paths = fixture(t)
  createFoldersStore(paths.data).addExternal('w-main', paths.ext)
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  const { post } = await client(scope, 'w-main')
  const classify = async path => (await post({ action: 'classify', workspaceId: 'w-main', path })).body
  assert.deepEqual(await classify(paths.inner), { ok: true, kind: 'subfolder', path: paths.inner, display: '~/main/inner/' })
  assert.deepEqual(await classify(paths.other), { ok: true, kind: 'external', path: paths.other, display: '~/other/' })
  assert.deepEqual(await classify(paths.root), { ok: false, reason: 'ancestor', path: paths.root, display: '~/' })
  assert.deepEqual(await classify(paths.sub), { ok: false, reason: 'duplicate', path: paths.sub, display: '~/main/sub/' })
  assert.deepEqual(await classify(join(paths.root, 'ext-link')), { ok: false, reason: 'duplicate', path: paths.ext, display: '~/ext/' })
  assert.deepEqual(await classify(paths.main), { ok: false, reason: 'duplicate', path: paths.main, display: '~/main/' })
  assert.deepEqual(await classify(join(paths.root, 'gone')), { ok: false, reason: 'missing' })
})

test('路由 add-external：宿主端重新分类，只收外部文件夹；收下后开着的会话马上登记', async (t) => {
  const paths = fixture(t)
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  scope.emit('agent/created', { agent: agentAt('main-1', paths.main), source: 'fresh' })
  const { post } = await client(scope, 'w-main')
  const refused = await post({ action: 'add-external', workspaceId: 'w-main', path: paths.inner })
  assert.deepEqual([refused.status, refused.body.ok, refused.body.reason], [200, false, 'not-external'])
  const added = await post({ action: 'add-external', workspaceId: 'w-main', path: paths.other })
  assert.equal(added.body.ok, true)
  assert.deepEqual(added.body.externals.map(row => row.path), [paths.other])
  assert.deepEqual(scope.live('main-1'), [paths.other])
  const removed = await post({ action: 'remove-external', workspaceId: 'w-main', path: paths.other })
  assert.deepEqual(removed.body.externals, [])
  assert.deepEqual(scope.live('main-1'), [])
})

test('路由 set-writable：「只读 / 可写」切换后子文件夹的会话马上跟着变；不是嵌在里面的工作区不收', async (t) => {
  const paths = fixture(t)
  const scope = fakeScope(paths)
  scope.workspaces.push({ id: 'w-other', path: paths.other, title: 'other' })
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  scope.emit('agent/created', { agent: agentAt('sub-1', paths.sub), source: 'fresh' })
  assert.deepEqual(scope.live('sub-1'), [])
  const { post } = await client(scope, 'w-main')
  const on = await post({ action: 'set-writable', workspaceId: 'w-main', subfolderId: 'w-sub', writable: true })
  assert.equal(on.body.subfolders[0].writable, true)
  assert.deepEqual(scope.live('sub-1'), [paths.main])
  await post({ action: 'set-writable', workspaceId: 'w-main', subfolderId: 'w-sub', writable: false })
  assert.deepEqual(scope.live('sub-1'), [])
  const wrong = await post({ action: 'set-writable', workspaceId: 'w-main', subfolderId: 'w-other', writable: true })
  assert.deepEqual([wrong.status, wrong.body.reason], [400, 'not-subfolder'])
  const malformed = await post({ action: 'set-writable', workspaceId: 'w-main', subfolderId: 'w-sub', writable: 'yes' })
  assert.equal(malformed.status, 400)
})

test('组装系统提示词时，排在官方沙箱说明前面的 context 先对一遍：外部文件夹刚删掉的那次请求，说明里就不再列它', (t) => {
  const paths = fixture(t)
  createFoldersStore(paths.data).addExternal('w-main', paths.ext)
  const scope = fakeScope(paths)
  // 官方的沙箱说明（rc.3 dsh-sandbox-policy 的 sandbox:policy）：按这个会话此刻登记的目录写，比这一行先注册。
  scope.systemPrompt.context({
    name: 'sandbox:policy', order: CONTEXT_ORDERS.SANDBOX_POLICY,
    text: ({ agent }) => `writable ${JSON.stringify(scope.live(agent.session.id))}`,
  })
  const stop = applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  const agent = agentAt('main-1', paths.main)
  scope.emit('agent/created', { agent, source: 'fresh' })
  assert.deepEqual(scope.assemble(agent), [`writable ${JSON.stringify([paths.ext])}`])
  rmSync(paths.ext, { recursive: true })
  assert.deepEqual(scope.assemble(agent), ['writable []'], '这一行的 context 不出文字，只在官方说明之前把登记对好')
  mkdirSync(paths.ext)
  assert.deepEqual(scope.assemble(agent), [`writable ${JSON.stringify([paths.ext])}`])
  stop()
  assert.deepEqual([...scope.contexts.keys()], ['sandbox:policy'], '卸载这一行时撤掉它的 context')
})

test('挂载这一行时，已经加载的会话各对一遍（插件页里启用这一行，开着的会话不用等下一次请求）', (t) => {
  const paths = fixture(t)
  const store = createFoldersStore(paths.data)
  store.addExternal('w-main', paths.ext)
  store.setWritable('w-main', 'w-sub', true)
  const scope = fakeScope(paths)
  scope.loaded.push(agentAt('main-1', paths.main), agentAt('sub-1', paths.sub))
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  assert.deepEqual(scope.live('main-1'), [paths.ext])
  assert.deepEqual(scope.live('sub-1'), [paths.main])
})

test('路由 classify / add-external：主目录、DSH 的数据目录、它里面的目录、它的上级都不能作为外部文件夹，也不存', async (t) => {
  const paths = fixture(t)
  const home = join(paths.root, 'home')
  mkdirSync(join(home, 'code'), { recursive: true })
  mkdirSync(join(paths.dsh, 'dsh-workbench'), { recursive: true })
  symlinkSync(paths.dsh, join(paths.root, 'dsh-link'))
  const scope = fakeScope(paths)
  // DSH_HOME 写成符号链接时，也认得出它的真实路径。
  applyWorkspaceFolders(scope, { dataDir: paths.data, home, dshHome: join(paths.root, 'dsh-link') })
  const { post } = await client(scope, 'w-main')
  const classify = async target => (await post({ action: 'classify', workspaceId: 'w-main', path: target })).body
  assert.deepEqual(await classify(home), { ok: false, reason: 'too-broad', path: home, display: '~/' })
  assert.deepEqual(await classify(paths.dsh), { ok: false, reason: 'dsh-data', path: paths.dsh, display: `${paths.dsh}/` })
  assert.deepEqual((await classify(join(paths.dsh, 'dsh-workbench'))).reason, 'dsh-data')
  assert.deepEqual((await classify(join(paths.root, 'srv'))).reason, 'dsh-data')
  assert.deepEqual(await classify(join(home, 'code')), { ok: true, kind: 'external', path: join(home, 'code'), display: '~/code/' })
  const added = await post({ action: 'add-external', workspaceId: 'w-main', path: home })
  assert.deepEqual([added.body.ok, added.body.reason], [false, 'too-broad'])
  assert.deepEqual(createFoldersStore(paths.data).read(), {})
})

test('设置文件被手改过：范围太大的目录和 DSH 的数据目录不登记，对话框里那一行标成失效、带原因', async (t) => {
  const paths = fixture(t)
  const home = join(paths.root, 'home')
  mkdirSync(home)
  writeFileSync(join(paths.data, FOLDERS_FILE), JSON.stringify({ version: 1, workspaces: { 'w-main': { externals: [home, paths.dsh, paths.ext] } } }))
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home, dshHome: paths.dsh })
  scope.emit('agent/created', { agent: agentAt('main-1', paths.main), source: 'fresh' })
  assert.deepEqual(scope.live('main-1'), [paths.ext])
  const { get } = await client(scope, 'w-main')
  assert.deepEqual((await get()).body.externals, [
    { path: home, display: '~/', missing: false, refused: 'too-broad' },
    { path: paths.dsh, display: `${paths.dsh}/`, missing: false, refused: 'dsh-data' },
    { path: paths.ext, display: `${paths.ext}/`, missing: false },
  ])
})

test('路由 GET：外部文件夹、子文件夹被换成符号链接以后显示失效，和登记用同一个判据', async (t) => {
  const paths = fixture(t)
  createFoldersStore(paths.data).addExternal('w-main', paths.other)
  const scope = fakeScope(paths)
  applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  rmSync(paths.other, { recursive: true })
  symlinkSync(paths.ext, paths.other)
  rmSync(paths.sub, { recursive: true })
  symlinkSync(paths.inner, paths.sub)
  const { get } = await client(scope, 'w-main')
  const { body } = await get()
  assert.deepEqual(body.externals, [{ path: paths.other, display: '~/other/', missing: true }])
  assert.equal(body.subfolders[0].missing, true)
  scope.emit('agent/created', { agent: agentAt('main-1', paths.main), source: 'fresh' })
  assert.deepEqual(scope.live('main-1'), [], '宿主也不登记它')
})

test('a read-only preview Agent never acquires or retains workspace writable roots', async t => {
  const paths = fixture(t)
  const store = createFoldersStore(paths.data)
  const scope = fakeScope(paths)
  const stop = applyWorkspaceFolders(scope, { dataDir: paths.data, home: paths.root, dshHome: paths.dsh })
  t.after(stop)
  const live = agentAt('main-1', paths.main)
  scope.emit('agent/created', { agent: live, source: 'fresh' })
  // A preview before there are roots must not become a future syncAll target either.
  const early = agentAt('preview-before', paths.main)
  scope.assemble(early)
  const { post } = await client(scope, 'w-main')
  const result = await post({ action: 'add-external', workspaceId: 'w-main', path: paths.ext })
  assert.equal(result.status, 200)
  scope.assemble(agentAt('preview-after', paths.main))
  assert.deepEqual(scope.registered.map(entry => entry.session), [live.session.id])
  assert.deepEqual(store.read()['w-main'].externals, [paths.ext])
})

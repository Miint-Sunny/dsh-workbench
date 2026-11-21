/**
 * 工作区文件夹和权限（feat#159）的网页端：右键菜单项、选文件夹、和宿主路由说话（令牌）、对话框的各个状态和操作。
 * 对话框的测试接真的宿主路由（lib/workspace-folders.js，工作区登记表和沙箱策略用替身），文件夹用真的临时目录。
 * 真实的样子（深浅色、窄宽度、官方组件的外观）要在浏览器里看，这里只锁行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClient, textOf } from './react-harness.mjs'
import { applyWorkspaceFolders } from '../lib/workspace-folders.js'
import { createFoldersStore } from '../lib/workspace-folders-store.js'
import { createFoldersClient, foldersMenu, pickDirectory, WORKSPACE_FOLDERS_INJECT } from '../src/client/workspace-folders.js'
import { WORKSPACE_FOLDERS_EN, WORKSPACE_FOLDERS_ZH } from '../src/client/workspace-folders-copy.js'

const CLIENT = new URL('../lib/client.js', import.meta.url)

test('右键菜单项：「工作区设置…」带图标，点了按这一行的工作区打开对话框', () => {
  const opened = []
  const resolve = foldersMenu({ t: key => `t:${key}`, open: target => opened.push(target) })
  const items = resolve({ workspaceId: 'w-main', path: '/w/main', displayTitle: 'main' })
  assert.equal(items.length, 1)
  assert.equal(items[0].label, 't:folders.menu')
  assert.equal(items[0].icon.key, 'dsh-workbench.workspace-folders')
  items[0].run()
  assert.deepEqual(opened, [{ workspaceId: 'w-main', displayTitle: 'main' }])
})

test('选文件夹：桌面端用它的选择文件夹窗口，浏览器里请宿主打开', async () => {
  const ctx = { uiWorkspace: { pickDirectory: async () => '/from/host' } }
  assert.equal(await pickDirectory(ctx, { pick: async () => '/from/desktop' }), '/from/desktop')
  assert.equal(await pickDirectory(ctx, undefined), '/from/host')
  assert.equal(await pickDirectory({ uiWorkspace: { pickDirectory: async () => null } }, undefined), null)
})

test('要的 DSH 服务：右键菜单、工作区、选文件夹', () => {
  for (const name of ['contextMenus', 'workspaces', 'uiWorkspace']) assert.ok(WORKSPACE_FOLDERS_INJECT.includes(name), name)
})

test('文案：中英文的键一样，用语照 DSH（重新选择、重命名、已存在名为……的工作区）', () => {
  assert.deepEqual(Object.keys(WORKSPACE_FOLDERS_EN).sort(), Object.keys(WORKSPACE_FOLDERS_ZH).sort())
  assert.equal(WORKSPACE_FOLDERS_ZH['folders.menu'], '工作区设置…')
  assert.equal(WORKSPACE_FOLDERS_ZH['folders.rechoose'], '重新选择')
  assert.equal(WORKSPACE_FOLDERS_ZH['folders.error.ancestor'], '不能添加主文件夹的上级目录。')
  assert.equal(WORKSPACE_FOLDERS_ZH['folders.error.duplicate'], '此文件夹已在列表中。')
  assert.equal(WORKSPACE_FOLDERS_ZH['folders.renameConflict'], '已存在名为“{name}”的工作区。')
  assert.equal(WORKSPACE_FOLDERS_EN['folders.renameConflict'], 'A workspace named “{name}” already exists.')
})

/**
 * 真的宿主路由：替身工作区登记表，临时目录里的 main、main/sub、ext、other，和当 DSH_HOME 用的 srv/dsh。
 * 主目录默认是临时目录本身；`home: 'home'` 时换成里面的 home（主目录不再是主文件夹的上级，才测得到「范围太大」）。
 */
function host(t, { home: homeName } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dwb-wf-client-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['main/sub', 'main/new', 'ext', 'other', 'data', 'srv/dsh']) mkdirSync(join(root, dir), { recursive: true })
  const home = homeName === undefined ? root : join(root, homeName)
  mkdirSync(home, { recursive: true })
  const paths = { root, home, main: join(root, 'main'), sub: join(root, 'main', 'sub'), fresh: join(root, 'main', 'new'), ext: join(root, 'ext'), other: join(root, 'other'), data: join(root, 'data'), dsh: join(root, 'srv', 'dsh') }
  const workspaces = [{ id: 'w-main', path: paths.main, title: 'main' }, { id: 'w-sub', path: paths.sub, title: 'sub' }]
  let route
  const handlers = new Map()
  const registered = []
  const scope = {
    on: (name, handler) => { handlers.set(name, handler); return () => {} },
    sandboxPolicy: { registerWritableRoot: (session, dir) => { const entry = { session: session.id, dir, live: true }; registered.push(entry); return () => { entry.live = false } } },
    workspaceRegistry: { list: () => workspaces },
    connection: { fetch: { register: (def) => { route = def; return () => {} } } },
    agents: { list: () => [] },
    systemPrompt: { getContextOrder: () => 110, context: () => () => {} },
  }
  applyWorkspaceFolders(scope, { dataDir: paths.data, home, dshHome: paths.dsh })
  const requests = []
  const request = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return route.fetch(new Request(`http://h/${url}`, init))
  }
  const live = session => registered.filter(entry => entry.live && entry.session === session).map(entry => entry.dir)
  return { paths, workspaces, request, requests, handlers, live }
}

test('和宿主路由说话：先 GET 拿令牌，POST 带上；宿主重启换了令牌时重新拿一次再发', async (t) => {
  const server = host(t)
  let token = 'stale'
  const request = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'POST') {
      const sent = new Headers(init.headers).get('x-dsh-workbench-folders')
      if (sent === 'stale') return new Response(JSON.stringify({ ok: false, reason: 'forbidden' }), { status: 403 })
    }
    const response = await server.request(url, init)
    if ((init.method ?? 'GET') === 'GET' && token === 'stale') { token = 'fresh'; const body = await response.json(); return new Response(JSON.stringify({ ...body, token: 'stale' }), { status: 200 }) }
    return response
  }
  const client = createFoldersClient(request)
  const list = await client.load('w-main')
  assert.equal(list.workspace.id, 'w-main')
  const result = await client.classify('w-main', server.paths.other)
  assert.deepEqual([result.ok, result.kind], [true, 'external'])
  assert.deepEqual(server.requests.map(r => r.method), ['GET', 'GET', 'POST'])
})

/** 装上对话框：真的路由，替身 ctx（工作区、选文件夹）。 */
function setup(server, { picks = [] } = {}) {
  const globals = { document: { baseURI: 'http://127.0.0.1:1/', head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) } }
  const client = loadClient(CLIENT, globals)
  const { React } = client.react
  const calls = []
  const ctx = {
    uiWorkspace: { pickDirectory: async () => { calls.push('pick'); return picks.shift() ?? null } },
    workspaces: {
      list: { getSnapshot: () => ({ items: server.workspaces.map(w => ({ workspaceId: w.id, path: w.path, title: w.title })) }), subscribe: () => () => {} },
      async create({ path }) { calls.push(`create ${path}`); const view = { id: `w-${server.workspaces.length}`, path, title: path.split('/').at(-1) }; server.workspaces.push(view); return { workspaceId: view.id, ...view } },
      async delete(id) { calls.push(`delete ${id}`); server.workspaces.splice(server.workspaces.findIndex(w => w.id === id), 1) },
      async rename(id, title) { calls.push(`rename ${id} ${title}`); server.workspaces.find(w => w.id === id).title = title; return { workspaceId: id, title } },
    },
  }
  const zh = client.get('WORKSPACE_FOLDERS_ZH')
  const t = (key, params = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
  const app = { ctx, t }
  const closed = []
  const Dialog = client.get('WorkspaceFoldersDialog')
  const foldersClient = client.get('createFoldersClient')(server.request)
  client.react.mount(React.createElement(Dialog, { app, target: { workspaceId: 'w-main', displayTitle: 'main' }, client: foldersClient, close: () => closed.push('close') }))
  const react = client.react
  const text = () => react.all(node => node.type === 'ui.Modal').map(textOf).join('|')
  const button = label => react.one(node => (node.type === 'ui.Button' || node.type === 'button') && (textOf(node) === label || node.props['aria-label'] === label), label)
  return { react, calls, closed, text, button, ctx }
}

test('对话框：主文件夹、子文件夹（默认只读）、外部文件夹、找不到的外部文件夹，最后一行「添加文件夹」', async (t) => {
  const server = host(t)
  const store = createFoldersStore(server.paths.data)
  store.addExternal('w-main', server.paths.ext)
  store.addExternal('w-main', join(server.paths.root, 'gone'))
  const { react, text } = setup(server)
  await react.settle()
  const shown = text()
  for (const part of ['main', '管理此工作区的文件夹，以及工作区的会话可写入哪些文件夹。', '文件夹', '~/main/', '主文件夹', '跟随会话权限',
    '~/main/sub/', '子文件夹，单独的工作区。该工作区的会话里，主文件夹：', '~/ext/', '外部文件夹，和主文件夹同一档',
    '~/gone/', '未找到此文件夹，工作区的会话暂时无法写入', '添加文件夹']) assert.ok(shown.includes(part), part)
  const seg = react.one(node => node.type === 'ui.SegmentedControl', '只读 / 可写')
  assert.equal(seg.props.value, 'read-only')
  assert.deepEqual(seg.props.options.map(option => option.label), ['只读', '可写'])
  // 主文件夹没有移除按钮；子文件夹、外部文件夹各有一个，名字写在无障碍标签里。
  const removes = react.all(node => node.type === 'button' && /^移除 /.test(node.props['aria-label'] ?? ''))
  assert.deepEqual(removes.map(node => node.props['aria-label']), ['移除 sub', '移除 ext', '移除 gone'])
})

test('「只读 / 可写」切换：存到宿主，开着的子文件夹会话马上能写主文件夹', async (t) => {
  const server = host(t)
  server.handlers.get('agent/created')({ agent: { id: 'sub-1', session: { id: 'sub-1', header: { cwd: server.paths.sub } } } })
  const { react } = setup(server)
  await react.settle()
  react.one(node => node.type === 'ui.SegmentedControl', '切换').props.onChange('writable')
  await react.settle()
  assert.equal(react.one(node => node.type === 'ui.SegmentedControl', '切换后').props.value, 'writable')
  assert.deepEqual(server.live('sub-1'), [server.paths.main])
  react.one(node => node.type === 'ui.SegmentedControl', '切回').props.onChange('read-only')
  await react.settle()
  assert.deepEqual(server.live('sub-1'), [])
})

test('添加外部文件夹：先选，写明会添加成什么，点「添加」才存；列表多一行', async (t) => {
  const server = host(t)
  const { react, text, button, calls } = setup(server, { picks: [null, server.paths.other] })
  await react.settle()
  react.fire(button('添加文件夹'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, ['pick'], '取消了就什么也不做')
  assert.ok(!text().includes('已选择'))
  react.fire(button('添加文件夹'), 'onClick')
  await react.settle()
  assert.ok(text().includes('已选择'))
  assert.ok(text().includes('~/other/'))
  assert.ok(text().includes('在主文件夹外面，会添加为外部文件夹'))
  assert.deepEqual(createFoldersStore(server.paths.data).read(), {}, '还没点「添加」')
  react.fire(button('添加'), 'onClick')
  await react.settle()
  assert.deepEqual(createFoldersStore(server.paths.data).read()['w-main'].externals, [server.paths.other])
  assert.ok(!text().includes('已选择'))
  assert.ok(text().includes('外部文件夹，和主文件夹同一档'))
})

test('添加子文件夹：用官方的 workspaces.create 登记成工作区，列表里出现、默认只读', async (t) => {
  const server = host(t)
  const { react, text, button, calls } = setup(server, { picks: [server.paths.fresh] })
  await react.settle()
  react.fire(button('添加文件夹'), 'onClick')
  await react.settle()
  assert.ok(text().includes('在主文件夹里面，会添加为子文件夹'))
  react.fire(button('添加'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, ['pick', `create ${server.paths.fresh}`])
  assert.ok(text().includes('~/main/new/'))
  const segs = react.all(node => node.type === 'ui.SegmentedControl')
  assert.deepEqual(segs.map(seg => seg.props.value), ['read-only', 'read-only'])
})

test('添加时的两种拒绝：选了上级目录、选了已经在列表里的，只给「重新选择」', async (t) => {
  const server = host(t)
  const { react, text, button } = setup(server, { picks: [server.paths.root, server.paths.sub] })
  await react.settle()
  react.fire(button('添加文件夹'), 'onClick')
  await react.settle()
  assert.ok(text().includes('不能添加主文件夹的上级目录。'))
  assert.equal(react.all(node => node.type === 'ui.Button' && textOf(node) === '添加').length, 0)
  react.fire(button('重新选择'), 'onClick')
  await react.settle()
  assert.ok(text().includes('此文件夹已在列表中。'))
  assert.ok(!text().includes('不能添加主文件夹的上级目录。'))
})

test('移除外部文件夹：马上移除；移除子文件夹：先确认（照官方删除工作区的说明），确认后用 workspaces.delete', async (t) => {
  const server = host(t)
  createFoldersStore(server.paths.data).addExternal('w-main', server.paths.ext)
  const { react, text, button, calls } = setup(server)
  await react.settle()
  react.fire(button('移除 ext'), 'onClick')
  await react.settle()
  assert.equal(createFoldersStore(server.paths.data).read()['w-main'], undefined)
  assert.ok(!text().includes('~/ext/'))
  react.fire(button('移除 sub'), 'onClick')
  await react.settle()
  assert.ok(text().includes('将把“sub”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。'))
  assert.deepEqual(calls, [])
  react.fire(button('取消'), 'onClick')
  await react.settle()
  assert.ok(!text().includes('将把“sub”'))
  react.fire(button('移除 sub'), 'onClick')
  await react.settle()
  react.fire(button('移除'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, ['delete w-sub'])
  assert.ok(!text().includes('~/main/sub/'))
})

test('改名：点铅笔就地改，回车用官方的 workspaces.rename；和别的工作区重名时就地提示，不发请求', async (t) => {
  const server = host(t)
  const { react, text, button, calls } = setup(server)
  await react.settle()
  react.fire(button('重命名'), 'onClick')
  await react.settle()
  const editor = () => react.one(node => node.type === 'ui.InlineEditor', '改名输入框')
  editor().props.onChange('sub')
  await react.settle()
  editor().props.onSave()
  await react.settle()
  assert.ok(text().includes('已存在名为“sub”的工作区。'))
  assert.deepEqual(calls, [])
  editor().props.onChange('主项目')
  await react.settle()
  editor().props.onSave()
  await react.settle()
  assert.deepEqual(calls, ['rename w-main 主项目'])
  assert.ok(text().includes('主项目'))
  assert.equal(react.all(node => node.type === 'ui.InlineEditor').length, 0)
})

test('改名时按 Esc 只取消改名，不关对话框', async (t) => {
  const server = host(t)
  const { react, button, closed } = setup(server)
  await react.settle()
  react.fire(button('重命名'), 'onClick')
  await react.settle()
  const editor = react.one(node => node.type === 'ui.InlineEditor', '改名输入框')
  const event = react.fire(editor, 'onKeyDown', { key: 'Escape' })
  assert.equal(event.defaultPrevented, true, 'Esc 被这里接住，官方对话框看到 defaultPrevented 就不关')
  editor.props.onCancel()
  await react.settle()
  assert.equal(react.all(node => node.type === 'ui.InlineEditor').length, 0)
  assert.deepEqual(closed, [])
})

test('挂载和撤销：菜单项挂在工作区目标上（排在重命名后面）、菜单图标、对话框层、迁移提示层（feat#187）；撤销时都收回', () => {
  const client = loadClient(CLIENT, { document: { head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) } })
  const log = { menus: [], slots: [], disposed: [] }
  const ctx = {
    contextMenus: { register(def) { log.menus.push(def); return () => log.disposed.push('menu') } },
    slots: {
      inject: (name, make) => { const result = make(); const all = typeof result?.[Symbol.iterator] === 'function' ? [...result] : [result]; return () => { for (const dispose of all) dispose?.(); log.disposed.push(name) } },
      register: (info) => { log.slots.push(info.name); return () => {} },
    },
    locale: {},
  }
  const dispose = client.get('applyWorkspaceFolderSettings')({ ctx, t: key => key })
  assert.equal(log.menus.length, 1)
  assert.equal(log.menus[0].target, 'workspace')
  assert.ok(log.menus[0].order > 100 && log.menus[0].order < 200, '在官方的重命名（100）和在文件夹显示（200）之间')
  assert.deepEqual(log.slots.sort(), ['contextMenu.icon', 'shell.overlay', 'shell.overlay'])
  dispose()
  assert.deepEqual(log.disposed.sort(), ['contextMenu.icon', 'menu', 'shell.overlay', 'shell.overlay'])
})

test('添加时还拒绝两种：用户主目录这类范围太大的目录、DSH 的数据目录；只给「重新选择」，不存', async (t) => {
  const server = host(t, { home: 'home' })
  const { react, text, button } = setup(server, { picks: [server.paths.home, server.paths.dsh] })
  await react.settle()
  react.fire(button('添加文件夹'), 'onClick')
  await react.settle()
  assert.ok(text().includes('不能添加根目录、用户主目录或包含用户主目录的文件夹。'))
  assert.equal(react.all(node => node.type === 'ui.Button' && textOf(node) === '添加').length, 0)
  react.fire(button('重新选择'), 'onClick')
  await react.settle()
  assert.ok(text().includes('不能添加 DSH 的数据目录（$DSH_HOME）、数据目录内的文件夹或包含数据目录的文件夹。'))
  assert.deepEqual(createFoldersStore(server.paths.data).read(), {})
})

test('设置文件被手改过：范围太大、DSH 数据目录的外部文件夹那一行显示失效，写明原因', async (t) => {
  const server = host(t, { home: 'home' })
  writeFileSync(join(server.paths.data, 'workspace-folders.json'), JSON.stringify({ version: 1, workspaces: { 'w-main': { externals: [server.paths.home, server.paths.dsh] } } }))
  const { react, text } = setup(server)
  await react.settle()
  const shown = text()
  assert.ok(shown.includes('此文件夹范围过大，工作区的会话无法写入'))
  assert.ok(shown.includes('此文件夹与 DSH 的数据目录重叠，工作区的会话无法写入'))
  assert.equal(shown.split('跟随会话权限').length - 1, 1, '只有主文件夹那一行写「跟随会话权限」')
})

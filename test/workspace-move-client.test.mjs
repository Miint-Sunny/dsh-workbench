/**
 * 更换工作区文件夹（feat#187）的网页端：文案拼法（阻碍、预览、结果），工作区设置里的迁移面板和记录那一行，
 * 对话框外的结果提示、撤销确认和恢复对话框。对话框的测试接真的宿主路由（lib/workspace-folders.js、lib/workspace-move-route.js），
 * 用 App 自己的代码造 DSH_HOME（没有 App 时跳过）；起小进程用替身（写下请求文件、记下参数），进度由测试写进 status.json。
 * 真实的样子（深浅色、窄宽度、官方组件的外观）要在浏览器里看，这里只锁行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createWindow, loadClient, textOf } from './react-harness.mjs'
import { applyWorkspaceFolders } from '../lib/workspace-folders.js'
import { requestsDir } from '../lib/workspace-move-launch.js'
import { applyWorkspaceMoveRoute } from '../lib/workspace-move-route.js'
import { applyWorkspaceMove, planWorkspaceMove } from '../lib/workspace-move.js'
import { moveBlockerText, moveKindText, moveResultNotice, moveSummaryLines } from '../src/client/workspace-move.js'
import { WORKSPACE_FOLDERS_ZH } from '../src/client/workspace-folders-copy.js'
import { WORKSPACE_MOVE_EN, WORKSPACE_MOVE_ZH } from '../src/client/workspace-move-copy.js'
import { NEEDS_APP, seedHome } from './helpers/dsh-app.mjs'
import { crashMove, done, NOT_RUNNING, setup } from './helpers/workspace-move-fixture.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const ZH = { ...WORKSPACE_FOLDERS_ZH, ...WORKSPACE_MOVE_ZH }
const t = (key, params = {}) => (ZH[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
const DESKTOP = { pid: 101, ppid: 100, execPath: '/A/DSH.app/Contents/Resources/runtime/bin/node', execArgv: [], argv: ['node', '/x/dsh-desktop-host/lib/index.js'], cwd: '/', ipc: true, tty: false, parentExecutable: '/A/DSH.app/Contents/MacOS/DSH' }

test('文案：中英文的键一样', () => {
  assert.deepEqual(Object.keys(WORKSPACE_MOVE_EN).sort(), Object.keys(WORKSPACE_MOVE_ZH).sort())
})

test('阻碍：有会话标题时写标题，找不到时写「1 个会话」；登记表的几种合成一句；不认识的照原样写出', () => {
  const titleOf = id => ({ 'session-a': '整理课程资料' })[id]
  assert.equal(moveBlockerText(t, { code: 'open-turn', sessionId: 'session-a' }, titleOf), '会话“整理课程资料”正在运行，结束后可迁移。')
  assert.equal(moveBlockerText(t, { code: 'open-turn', sessionId: 'x' }, titleOf), '1 个会话正在运行，结束后可迁移。')
  assert.equal(moveBlockerText(t, { code: 'open-job', sessionId: 'session-a' }, titleOf), '会话“整理课程资料”中有后台任务正在运行，结束后可迁移。')
  assert.equal(moveBlockerText(t, { code: 'registry-pending' }, titleOf), '无法读取工作区登记表，暂时无法迁移。')
  assert.equal(moveBlockerText(t, { code: 'log-format', sessionId: 'x' }, titleOf), '无法读取会话“x”的记录。')
  assert.equal(moveBlockerText(t, { code: 'new-code' }, titleOf), '无法迁移：new-code')
})

const PREVIEW = {
  source: { workspaceId: 'w1', title: 'dsh_work', display: '~/Documents/dsh_work/' },
  target: { kind: 'folder', title: 'work', display: '~/Documents/work/', sessions: 0 },
  result: { title: 'work' },
  counts: { sessions: 5, forks: 1, subagents: 1, archived: 1 },
  carries: ['checkpoints', 'memory', 'trust'],
  untouched: ['mcp', 'rules', 'pages'],
  blockers: [],
  warnings: [],
}

test('预览的第一句：改用新文件夹（名字跟着改时写出新名字）、并入已有工作区', () => {
  assert.equal(moveKindText(t, PREVIEW), '此文件夹尚未添加为工作区。工作区 dsh_work 将改用此文件夹，名称随之改为 work。')
  assert.equal(moveKindText(t, { ...PREVIEW, result: { title: 'dsh_work' } }), '此文件夹尚未添加为工作区。工作区 dsh_work 将改用此文件夹。')
  assert.equal(moveKindText(t, { ...PREVIEW, target: { kind: 'workspace', title: 'work', display: '~/Documents/work/', sessions: 1 } }),
    '此文件夹已是工作区“work”（1 个会话）。dsh_work 的会话将并入 work，两组各自的会话顺序保留。dsh_work 将从侧边栏移除，其文件夹设置合并到 work。')
})

test('迁移的内容和不迁移的内容：和样稿一样的几行；没有的项不写', () => {
  assert.deepEqual(moveSummaryLines(t, PREVIEW), {
    moves: ['5 个会话，其中已归档 1 个、分叉会话 1 个', '1 个子智能体会话', '工作台的检查点、项目记忆和工作区信任设置'],
    stays: ['MCP 项目规则、放行规则和网页发布仍指向原文件夹，需要时在迁移后手动修改'],
    tips: [],
  })
  const bare = moveSummaryLines(t, { ...PREVIEW, counts: { sessions: 2, forks: 0, subagents: 0, archived: 0 }, carries: [], untouched: [], warnings: [{ code: 'subfolder-sessions', count: 3 }, { code: 'memory-conflict' }] })
  assert.deepEqual(bare, { moves: ['2 个会话'], stays: ['3 个会话位于原文件夹的子文件夹中，不迁移'], tips: ['新位置已有项目记忆，原记忆不合并。'] })
})

test('结果：迁移成功带撤销；校验失败、出错、中断带在文件夹显示；撤销和恢复被拒绝的文字不同；不认识的结果按失败', () => {
  const where = { source: { title: 'dsh_work', display: '~/Documents/dsh_work/' }, target: { display: '~/Documents/work/' }, sessions: 6 }
  assert.deepEqual(moveResultNotice(t, { action: 'move', outcome: 'moved', moveId: 'm1', ...where }), { text: 'dsh_work 已迁移到 ~/Documents/work/，共 6 个会话。', tone: 'success', undo: 'm1' })
  assert.deepEqual(moveResultNotice(t, { action: 'undo', outcome: 'undone', ...where }), { text: '已撤销迁移，dsh_work 已回到 ~/Documents/dsh_work/。', tone: 'success' })
  assert.equal(moveResultNotice(t, { action: 'move', outcome: 'not-quit' }).text, '未迁移：等待 DSH 退出超时。')
  assert.equal(moveResultNotice(t, { action: 'undo', outcome: 'not-quit' }).text, '未撤销：等待 DSH 退出超时。')
  assert.deepEqual(moveResultNotice(t, { action: 'move', outcome: 'check-failed-undone' }), { text: '迁移失败：迁移后的会话内容校验未通过，已自动撤销，工作区保持原状。', tone: 'warning', reveal: true })
  assert.equal(moveResultNotice(t, { action: 'undo', outcome: 'refused' }).text, '未撤销：迁移后会话数据、工作区登记或工作台数据有改动。')
  assert.equal(moveResultNotice(t, { action: 'recover', outcome: 'refused' }).text, '未恢复：中断后会话数据、工作区登记或工作台数据有改动。迁移记录已保留。')
  assert.deepEqual(moveResultNotice(t, { action: 'move', outcome: 'interrupted' }), { text: '迁移中断，完成情况请查看迁移记录。', tone: 'warning', reveal: true })
  assert.deepEqual(moveResultNotice(t, { action: 'recover', outcome: 'something-new' }), { text: '恢复失败，详细信息见迁移记录。', tone: 'warning', reveal: true })
})

/**
 * 真路由：工作区登记表读造好的 DSH_HOME，起小进程用替身（写下请求文件，记下参数），访达用替身。
 * 网页端的 fetch 按路径分给两条路由。
 */
function host(home) {
  const registry = () => Object.entries(JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).tables.workspaces)
    .map(([id, item]) => ({ id, path: item.path, title: item.title ?? item.path.split('/').at(-1) }))
  const routes = new Map()
  const scope = {
    on: () => () => {},
    sandboxPolicy: { registerWritableRoot: () => () => {} },
    workspaceRegistry: { list: registry },
    connection: { fetch: { register: (def) => { routes.set(def.path, def); return () => {} } } },
    agents: { list: () => [] },
    systemPrompt: { getContextOrder: () => 110, context: () => () => {} },
  }
  applyWorkspaceFolders(scope, { dataDir: join(home, 'dsh-workbench'), home: '/nonexistent-home', dshHome: home })
  const started = []
  const revealed = []
  applyWorkspaceMoveRoute(scope, {
    dshHome: home, homes: [], undoDays: 30, facts: () => DESKTOP, bundleIdOf: async () => 'com.example.dsh',
    start: async (options) => {
      const requestId = `20261119T100000-${String(started.length + 1).padStart(8, '0')}`
      const dir = join(requestsDir(home), requestId)
      mkdirSync(dir, { recursive: true })
      const { wait, quit, relaunch, appBinary, ...rest } = options
      writeFileSync(join(dir, 'request.json'), JSON.stringify({ version: 1, requestId, ...rest, wait, quit, relaunch, appBinary }))
      started.push({ requestId, ...options })
      return { requestId, dir, pid: process.pid }
    },
    reveal: async (path) => { revealed.push(path) },
  })
  const request = async (url, init = {}) => {
    const path = `/${String(url).split('?')[0]}`
    return routes.get(path).fetch(new Request(`http://h/${url}`, init))
  }
  const status = (requestId, value) => writeFileSync(join(requestsDir(home), requestId, 'status.json'), JSON.stringify(value))
  return { registry, request, started, revealed, status }
}

/** 装上网页端：真路由，替身 ctx（选文件夹、会话列表）。 */
function client(server, { picks = [], restarted = false } = {}) {
  const loaded = loadClient(CLIENT, { document: { baseURI: 'http://127.0.0.1:1/', head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) } })
  const { React } = loaded.react
  const ctx = {
    uiWorkspace: { pickDirectory: async () => picks.shift() ?? null },
    workspaces: { list: { getSnapshot: () => ({ items: server.registry().map(w => ({ workspaceId: w.id, path: w.path, title: w.title })) }), subscribe: () => () => {} } },
    sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': { title: '整理课程资料' } } }) } },
  }
  const app = { ctx, t }
  // restarted：查进度的回答换一个宿主编号，当作 DSH 已经重开
  const request = !restarted ? server.request : async (url, init) => {
    const response = await server.request(url, init)
    if (!String(url).includes('requestId=')) return response
    const body = await response.json()
    return new Response(JSON.stringify({ ...body, hostId: 'after-restart' }), { status: response.status })
  }
  const moveClient = loaded.get('createMoveClient')(request)
  const notices = loaded.get('createMoveNotices')(app, moveClient)
  const moves = { client: moveClient, notices, titleOf: loaded.get('moveTitles')(ctx) }
  const react = loaded.react
  const closed = []
  const openDialog = (workspaceId) => {
    react.mount(React.createElement(loaded.get('WorkspaceFoldersDialog'), {
      app, target: { workspaceId, displayTitle: 'x' }, client: loaded.get('createFoldersClient')(server.request), moves, close: () => closed.push('close'),
    }))
  }
  const openNotices = () => { react.mount(React.createElement(notices.Overlay)) }
  const text = () => react.all(node => node.type === 'ui.Modal' || node.type === 'ui.Toast')
    .map(node => (node.type === 'ui.Toast' ? node.props.text : `${node.props.title ?? ''}${textOf(node)}`)).join('|')
  /** 元素和它下面的元素（没渲染的，比如对话框的 footer 属性）。 */
  const elementsIn = value => (Array.isArray(value) ? value.flatMap(elementsIn) : value !== null && typeof value === 'object' && value.props !== undefined ? [value, ...elementsIn(value.props.children)] : [])
  const labelOf = element => [element.props.children].flat().filter(child => typeof child === 'string').join('')
  const button = (label) => {
    const shown = react.all(node => (node.type === 'ui.Button' || node.type === 'button') && textOf(node) === label)
    if (shown.length === 1) return shown[0]
    const footers = react.all(node => node.type === 'ui.Modal').flatMap(node => elementsIn(node.props.footer))
    const found = footers.filter(element => element.type === react.ui.Button && labelOf(element) === label)
    assert.equal(shown.length + found.length, 1, `按钮「${label}」`)
    return found[0]
  }
  const until = async (check, ms = 8000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      await react.settle()
      if (check()) return
      await sleep(100)
    }
    throw new Error(`等不到：${text()}`)
  }
  return { react, notices, closed, openDialog, openNotices, text, button, until }
}

test('更换文件夹：选好新位置后预览（和样稿一样的几行），点「退出并迁移」起小进程（AppleScript 退出），DSH 没退出、放弃时面板里显示结果', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup()
  const server = host(home)
  const ui = client(server, { picks: [work] })
  t.after(() => { ui.react.unmount() })
  ui.openDialog(id)
  await ui.until(() => ui.text().includes('更换文件夹…'))
  ui.button('更换文件夹…').props.onClick()
  await ui.until(() => ui.text().includes('迁移的内容'))
  const shown = ui.text()
  for (const part of ['已选择', '此文件夹尚未添加为工作区。工作区 old 将改用此文件夹，名称随之改为 work。', '3 个会话，其中已归档 1 个、分叉会话 1 个', '1 个子智能体会话',
    '工作台的检查点、项目记忆和工作区信任设置', '会话记录中的原路径不会更新', '迁移需要退出 DSH：DSH 关闭后开始迁移，完成后自动重新打开。']) assert.ok(shown.includes(part), part)
  assert.equal(ui.text().includes('不迁移的内容'), false)
  ui.button('退出并迁移').props.onClick()
  await ui.until(() => ui.text().includes('正在退出 DSH…'))
  assert.equal(server.started.length, 1)
  assert.deepEqual([server.started[0].action, server.started[0].quit.kind, server.started[0].quit.bundleId, server.started[0].plan.sessions.length], ['move', 'applescript', 'com.example.dsh', 4])
  server.status(server.started[0].requestId, { phase: 'gave-up', outcome: 'not-quit' })
  await ui.until(() => ui.text().includes('未迁移：等待 DSH 退出超时。'))
  await ui.until(() => existsSync(join(requestsDir(home), server.started[0].requestId, 'ack.json')))
  const next = await server.request('api/dsh-workbench.workspace-move').then(response => response.json())
  assert.deepEqual(next.results, [], '面板里显示过，下次打开不再提示')
})

test('DSH 重开过（宿主编号变了）：面板里照样显示结果，但不标记为已提示，留给下次打开时的提示条', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup()
  const server = host(home)
  const ui = client(server, { picks: [work], restarted: true })
  t.after(() => { ui.react.unmount() })
  ui.openDialog(id)
  await ui.until(() => ui.text().includes('更换文件夹…'))
  ui.button('更换文件夹…').props.onClick()
  await ui.until(() => ui.text().includes('迁移的内容'))
  ui.button('退出并迁移').props.onClick()
  await ui.until(() => ui.text().includes('正在退出 DSH…'))
  server.status(server.started[0].requestId, { phase: 'finished', outcome: 'moved', moveId: '20261119T100001-bbbbbbbb' })
  await ui.until(() => ui.text().includes('已迁移到'))
  await sleep(300)
  assert.equal(existsSync(join(requestsDir(home), server.started[0].requestId, 'ack.json')), false)
})

test('撤销确认：迁移后会话里新写了内容时，写明一起保留', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  seedHome(home, { appends: [{ id: 'session-c', events: done(2) }] })
  const ui = client(host(home))
  t.after(() => { ui.react.unmount() })
  ui.notices.open({ type: 'undo', target: { moveId, sessions: 4 } })
  ui.openNotices()
  await ui.until(() => ui.text().includes('将退出 DSH，把 4 个会话'))
  assert.ok(ui.text().includes('迁移后会话里新写的内容一起保留，随会话回到原位置。'))
})

test('撤销被拒绝：会话没有标题时写数量，不写会话编号', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  // 改写（截掉最后一个字节），不是在末尾追加
  const dir = join(home, plan.sessions.find(item => item.id === 'session-c').to)
  const log = join(dir, readdirSync(dir).find(name => name.endsWith('.zstd')))
  writeFileSync(log, readFileSync(log).subarray(0, -1))
  const ui = client(host(home))
  t.after(() => { ui.react.unmount() })
  ui.notices.open({ type: 'undo', target: { moveId, sessions: 4 } })
  ui.openNotices()
  await ui.until(() => ui.text().includes('无法撤销此次迁移'))
  assert.ok(ui.text().includes('1 个会话的数据在迁移后有改动，无法撤销。'))
  assert.equal(ui.text().includes('session-c'), false)
})

test('有进行中的轮次：面板写「暂时无法迁移」和会话标题，「退出并迁移」停用，可以「重新检查」', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup({ openTurn: true })
  const server = host(home)
  const ui = client(server, { picks: [work] })
  t.after(() => { ui.react.unmount() })
  ui.openDialog(id)
  await ui.until(() => ui.text().includes('更换文件夹…'))
  ui.button('更换文件夹…').props.onClick()
  await ui.until(() => ui.text().includes('暂时无法迁移'))
  assert.ok(ui.text().includes('会话“整理课程资料”正在运行，结束后可迁移。'))
  assert.equal(ui.button('退出并迁移').props.disabled, true)
  assert.ok(ui.button('重新检查'))
  assert.deepEqual(server.started, [])
})

test('主文件夹不存在：写「此文件夹不存在，可能已被移动或删除。」，「更换文件夹…」是主按钮', { skip: NEEDS_APP }, async (t) => {
  const { home, id, old } = await setup()
  rmSync(old, { recursive: true, force: true })
  const ui = client(host(home))
  t.after(() => { ui.react.unmount() })
  ui.openDialog(id)
  await ui.until(() => ui.text().includes('此文件夹不存在，可能已被移动或删除。'))
  assert.equal(ui.button('更换文件夹…').props.variant, 'primary')
})

test('迁移记录那一行：写时间和原位置，点「撤销」关掉工作区设置、开撤销确认；确认后起小进程撤销', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const server = host(home)
  const ui = client(server)
  t.after(() => { ui.react.unmount() })
  ui.openDialog(plan.result.workspaceId)
  await ui.until(() => ui.text().includes('迁移自'))
  ui.button('撤销').props.onClick()
  assert.deepEqual(ui.closed, ['close'])
  ui.openNotices()
  await ui.until(() => ui.text().includes('将退出 DSH，把 4 个会话移回原位置'))
  assert.ok(ui.text().includes('撤销此次迁移？'))
  ui.button('退出并撤销').props.onClick()
  await ui.until(() => ui.text().includes('正在退出 DSH…'))
  assert.deepEqual([server.started[0].action, server.started[0].moveId], ['undo', moveId])
})

test('DSH 打开时：上次迁移成功的结果用提示条显示（带「撤销」）并标记为已提示；点「撤销」开撤销确认', { skip: NEEDS_APP }, async (t) => {
  const { home, id, work } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const dir = join(requestsDir(home), '20261119T090000-aaaaaaaa')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ version: 1, requestId: '20261119T090000-aaaaaaaa', action: 'move', plan }))
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'finished', outcome: 'moved', moveId }))
  const ui = client(host(home))
  t.after(() => { ui.react.unmount() })
  ui.openNotices()
  await ui.notices.start()
  await ui.until(() => ui.text().includes('已迁移到'))
  const toast = ui.react.one(node => node.type === 'ui.Toast', 'toast')
  assert.match(toast.props.text, /^old 已迁移到 .*work\/，共 4 个会话。$/)
  assert.equal(toast.props.tone, 'success')
  assert.deepEqual(toast.props.actions.map(item => item.label), ['撤销'])
  await ui.until(() => existsSync(join(dir, 'ack.json')))
  toast.props.actions[0].onClick()
  await ui.until(() => ui.text().includes('撤销此次迁移？'))
})

test('DSH 打开时：迁移停在中途就弹恢复对话框（中断那条请求不另提示），确认后起小进程恢复', { skip: NEEDS_APP }, async (t) => {
  const fixture = await setup()
  const stuck = await crashMove(fixture, 'commit-rename:2')
  // 那次迁移的请求：小进程搬到一半就没了（pid 已不存在）
  const dir = join(requestsDir(fixture.home), '20261119T090000-aaaaaaaa')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ version: 1, requestId: '20261119T090000-aaaaaaaa', action: 'move' }))
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'moving', pid: 2 ** 22 + 12345, moveId: stuck.moveId }))
  const server = host(fixture.home)
  const ui = client(server)
  t.after(() => { ui.react.unmount() })
  ui.openNotices()
  await ui.notices.start()
  await ui.until(() => ui.text().includes('上次迁移未完成'))
  assert.ok(ui.text().includes('迁移到'))
  assert.ok(ui.text().includes('部分会话可能已在新位置'))
  ui.button('退出并恢复').props.onClick()
  await ui.until(() => ui.text().includes('正在退出 DSH…'))
  assert.equal(ui.react.all(node => node.type === 'ui.Toast').length, 0)
  assert.ok(existsSync(join(dir, 'ack.json')), '中断那条请求标记为已提示，下次打开不再列出')
  assert.deepEqual([server.started[0].action, server.started[0].moveId], ['recover', stuck.moveId])
})

/** 只驱动界面的定时器；请求和 React 的渲染队列照常独立推进。 */
function timedClient(globals = {}) {
  const timers = new Map()
  const loaded = loadClient(CLIENT, {
    ...globals,
    setTimeout(fn, delay) {
      const id = Symbol('timer')
      timers.set(id, { fn, delay })
      return id
    },
    clearTimeout: id => timers.delete(id),
  })
  const advance = async (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue
      timers.delete(id)
      timer.fn()
    }
    await loaded.react.settle()
  }
  const mount = (name, props) => loaded.react.mount(loaded.react.React.createElement(loaded.get(name), props))
  return { ...loaded, mount, advance }
}

const pendingMove = { moveId: 'm1', workspaceId: 'w1', source: { title: 'old' }, target: { display: '/new/' } }
const startupStatus = { kind: 'desktop', results: [], interrupted: [], runningRequests: [] }

test('等待退出：查询不返回时仍在十秒后提示手动退出，卸载后不再处理该请求', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  const progress = Promise.withResolvers()
  const finished = []
  ui.mount('MoveWait', { t, client: { progress: () => progress.promise }, requestId: 'r1', hostId: 'h1', kind: 'desktop', action: 'move', onResult: (...args) => finished.push(args) })
  await ui.advance(10000)
  assert.match(textOf(ui.react.one(n => n.props.role === 'status')), /⌘Q/)
  ui.react.unmount()
  progress.resolve({ running: false, outcome: 'moved', hostId: 'h1' })
  await ui.react.settle()
  assert.deepEqual(finished, [])
})

test('等待退出：命令启动的 web 宿主未退出时提示退出宿主进程，不提示退出浏览器', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  ui.mount('MoveWait', { t, client: { progress: async () => ({ running: true, quitError: true }) }, requestId: 'r1', kind: 'command', action: 'move', onResult() {} })
  await ui.react.settle()
  assert.match(textOf(ui.react.one(n => n.props.role === 'status')), /终端/)
})

test('等待结果：宿主明确返回请求不存在时结束轮询，不提示退出也不确认结果', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  let reads = 0
  const acknowledgments = []
  const client = ui.get('createMoveClient')(async (_url, init) => {
    if (init.method === 'POST') acknowledgments.push(init.body)
    reads++
    return Response.json({ ok: false, reason: 'no-request' }, { status: 404 })
  })
  ui.mount('MoveRecoverDialog', { t, client: { ...client, recover: async () => ({ ok: true, requestId: 'r1', kind: 'desktop', hostId: 'h1' }) }, target: pendingMove, kind: 'desktop', close() {} })
  const modal = () => ui.react.one(n => n.type === 'ui.Modal')
  modal().props.footer.props.children.find(b => b.props.children === '退出并恢复').props.onClick()
  await ui.react.settle()
  assert.match(textOf(modal()), /找不到.*请求|请求.*不存在/)
  await ui.advance(1000)
  assert.equal(reads, 1)
  assert.deepEqual(acknowledgments, [])
})

test('恢复确认：终端需要手动重开，暂存阶段中断时不声称会话已经移动', () => {
  const ui = timedClient()
  try {
    for (const [copy, manual, certain] of [[WORKSPACE_MOVE_ZH, /重新启动 DSH/, /部分会话已/], [WORKSPACE_MOVE_EN, /start DSH again/i, /some sessions are already/]]) {
      const translate = (key, params = {}) => copy[key]?.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
      ui.mount('MoveRecoverDialog', { t: translate, client: {}, kind: 'terminal', target: pendingMove, close() {} })
      const text = textOf(ui.react.one(n => n.type === 'ui.Modal'))
      assert.match(text, manual)
      assert.doesNotMatch(text, certain)
    }
  } finally {
    ui.react.unmount()
  }
})

test('启动时小进程仍在重开：待请求结束后显示一次结果并确认', async (ctx) => {
  const ui = timedClient()
  const acks = []
  let status = { ...startupStatus, runningRequests: ['r1'] }
  const notices = ui.get('createMoveNotices')({ ctx: {}, t }, { status: async () => status, ack: async id => acks.push(id) })
  ctx.after(() => { notices.dispose(); ui.react.unmount() })
  ui.react.mount(ui.react.React.createElement(notices.Overlay))
  await notices.start()
  status = { ...startupStatus, results: [{ requestId: 'r1', outcome: 'moved', source: { title: 'old' }, target: { display: '/new/' } }] }
  await ui.advance(1000)
  assert.match(ui.react.one(n => n.type === 'ui.Toast').props.text, /已迁移到/)
  assert.deepEqual(acks, ['r1'])
})

test('启动恢复只确认对应记录，其他结果等对话框关闭再显示和确认', async (ctx) => {
  const ui = timedClient()
  const acks = []
  const status = {
    ...startupStatus, interrupted: [pendingMove],
    results: [{ requestId: 'related', moveId: 'm1', outcome: 'interrupted' }, { requestId: 'other', outcome: 'interrupted' }, { requestId: 'success', outcome: 'moved' }],
  }
  const notices = ui.get('createMoveNotices')({ ctx: {}, t }, { status: async () => status, ack: async id => acks.push(id) })
  ctx.after(() => { notices.dispose(); ui.react.unmount() })
  await notices.start()
  assert.deepEqual(acks, [], '实际显示前没有确认任何结果')
  ui.react.mount(ui.react.React.createElement(notices.Overlay))
  await ui.react.settle()
  assert.deepEqual(acks, ['related'])
  assert.equal(ui.react.all(n => n.type === 'ui.Toast').length, 0)
  ui.react.one(n => n.type === 'ui.Modal').props.onClose()
  await ui.react.settle()
  const toast = ui.react.one(n => n.type === 'ui.Toast')
  assert.match(toast.props.text, /中断/)
  assert.doesNotMatch(toast.props.text, /开始前/)
  assert.deepEqual(acks, ['related', 'other'])
  toast.props.onDone()
  await ui.react.settle()
  assert.deepEqual(acks, ['related', 'other', 'success'])
})

test('撤销或恢复完成但核对失败、迁移完成但重开失败：区分操作结果和后续失败', () => {
  for (const [copy, check, restart] of [[WORKSPACE_MOVE_ZH, /校验未通过/, /手动.*DSH/], [WORKSPACE_MOVE_EN, /check failed/i, /open DSH manually/i]]) {
    const translate = (key, params = {}) => copy[key]?.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
    for (const outcome of ['undone', 'recovered']) {
      const notice = moveResultNotice(translate, { outcome, checked: false })
      assert.equal(notice.tone, 'warning')
      assert.equal(notice.reveal, true)
      assert.match(notice.text, check)
    }
    const notice = moveResultNotice(translate, { outcome: 'moved', moveId: 'm1', relaunched: 'failed: exit 1' })
    assert.equal(notice.undo, 'm1')
    assert.equal(notice.tone, 'warning')
    assert.match(notice.text, restart)
  }
})

test('源数据无法确认时以两种界面语言说明原因和下一步', () => {
  const ui = timedClient()
  try {
    for (const [copy, explanation] of [[WORKSPACE_MOVE_ZH, /检查.*数据/], [WORKSPACE_MOVE_EN, /check.*data/i]]) {
      ui.mount('MovePanel', { t: key => copy[key] ?? key, move: { error: 'data-format' } })
      const message = textOf(ui.react.one(n => n.props.role === 'alert'))
      assert.match(message, explanation)
      assert.doesNotMatch(message, /data-format|move\.error/)
    }
  } finally {
    ui.react.unmount()
  }
})

test('原网页连到已重开的宿主时不再要求退出 DSH', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  ui.mount('MoveWait', { t, client: { progress: async () => ({ hostId: 'h2', running: true, phase: 'relaunching' }) }, requestId: 'r1', hostId: 'h1', kind: 'desktop', action: 'move', onResult() {} })
  await ui.react.settle()
  await ui.advance(10000)
  assert.match(textOf(ui.react.one(n => n.props.role === 'status')), /结果/)
})

test('宿主持续没有响应时停止查询，提示稍后查看结果，卸载会取消未完成的读取', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  let readSignal
  let reads = 0
  const loaded = []
  const client = ui.get('createMoveClient')(async (_url, init) => {
    reads++
    readSignal = init.signal
    return new Promise(() => {})
  })
  ui.mount('MoveWait', { t, client, requestId: 'r1', hostId: 'h1', kind: 'desktop', action: 'move', onResult: view => loaded.push(moveResultNotice(t, view)) })
  await ui.advance(120000)
  assert.equal(loaded.length, 1)
  assert.match(loaded[0].text, /无法读取.*结果/)
  ui.react.unmount()
  assert.equal(readSignal?.aborted, true)
  await ui.advance(1000)
  assert.equal(reads, 1)
})

test('键盘更换文件夹后，焦点进入预览；关闭结果后回到更换文件夹按钮', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  const app = { ctx: { uiWorkspace: { pickDirectory: async () => '/new/' } }, t }
  const folders = { load: async () => ({ workspace: { title: 'old', display: '/old/' }, subfolders: [], externals: [] }) }
  const moves = {
    titleOf: () => undefined,
    client: {
      status: async () => startupStatus,
      plan: async () => ({ ok: true, preview: PREVIEW, planId: 'p1', kind: 'desktop' }),
      start: async () => ({ ok: true, requestId: 'r1', hostId: 'h1', kind: 'desktop' }),
      progress: async () => ({ requestId: 'r1', hostId: 'h1', outcome: 'not-quit', running: false }),
      ack: async () => {},
    },
  }
  ui.mount('WorkspaceFoldersDialog', { app, target: { workspaceId: 'w1', displayTitle: 'old' }, client: folders, moves, close() {} })
  const button = label => ui.react.one(n => n.type === 'ui.Button' && textOf(n) === label)
  await ui.react.settle()
  button('更换文件夹…').focus()
  button('更换文件夹…').props.onClick()
  await ui.react.settle()
  const focusInPreview = ui.react.focused !== null && ui.react.one(n => n.props.className === 'dwb-wf-panel').contains(ui.react.focused)
  button('退出并迁移').props.onClick()
  await ui.react.settle()
  button('关闭').props.onClick()
  await ui.react.settle()
  assert.deepEqual([focusInPreview, ui.react.focused === button('更换文件夹…')], [true, true])
})

test('无法从标题区分的活动会话按实际数量显示，后台任务按有任务的会话计数', () => {
  const ui = timedClient()
  const blockers = [
    { code: 'open-turn', sessionId: 'a' }, { code: 'open-turn', sessionId: 'b' },
    { code: 'open-job', sessionId: 'a' }, { code: 'open-job', sessionId: 'b' },
  ]
  try {
    ui.mount('MovePanel', { t, move: { preview: { ...PREVIEW, blockers } }, titleOf: () => undefined })
    const message = textOf(ui.react.one(n => n.props.role === 'alert'))
    assert.match(message, /2 个会话正在运行/)
    assert.match(message, /2 个会话中有后台任务/)
  } finally {
    ui.react.unmount()
  }
})

test('撤销检查发现会话数据有改动时向读屏报告拒绝，不断言日志已被改写', async (ctx) => {
  const ui = timedClient()
  ctx.after(() => ui.react.unmount())
  const client = { undoCheck: async () => ({ ok: true, undoable: false, reason: 'changed-since-move', sessions: ['a'] }) }
  ui.mount('MoveUndoDialog', { t, titleOf: () => '旧会话', target: { moveId: 'm1' }, client, close() {} })
  await ui.react.settle()
  const modal = ui.react.one(n => n.type === 'ui.Modal')
  assert.match(textOf(modal), /旧会话.*数据.*改动/)
  assert.ok(ui.react.all(n => n.props.role === 'status' || n.props.role === 'alert').some(n => textOf(n).includes('无法撤销')))
})

const lostSessionScope = "Uncaught Error: scope 'session-maybe' rendered without an installed adapter"

function webRecovery({ kind = 'command', ok = true, progress } = {}) {
  const window = createWindow()
  let reloads = 0
  window.location = { href: 'http://localhost:5000/', reload() { reloads++ } }
  const root = { childElementCount: 1, textContent: 'DSH' }
  const document = { getElementById: id => id === 'root' ? root : null, body: { innerText: 'DSH' } }
  window.document = document
  const ui = timedClient({ window, document })
  const reads = []
  let action
  const client = ui.get('createMoveClient')(async (url, init) => {
    if (init.method === 'POST') {
      const { action: posted } = JSON.parse(init.body)
      action = posted === 'start' ? 'move' : posted
      return Response.json({ ok, reason: ok ? undefined : 'busy', kind, requestId: 'r1', hostId: 'original' })
    }
    if (!url.includes('requestId=')) return Response.json({ ok: true, token: 'test' })
    reads.push(url)
    const request = { requestId: 'r1', action, phase: 'finished', running: false, outcome: { move: 'moved', undo: 'undone', recover: 'recovered' }[action] }
    return Response.json(await (progress?.(request, init.signal) ?? { ok: true, hostId: 'reopened', request }))
  })
  const blank = () => { root.childElementCount = 0; root.textContent = ''; document.body.innerText = '' }
  const error = (message = lostSessionScope) => window.dispatchEvent({ type: 'error', message })
  return { ...ui, root, document, client, reads, blank, error, reloads: () => reloads }
}

test('命令行启动的网页迁移、撤销或恢复后页面因会话组件错误变空：核实新宿主的结果后只刷新一次', async () => {
  for (const launch of ['start', 'undo', 'recover']) {
    const page = webRecovery()
    await page.client[launch]('plan-or-move')
    assert.deepEqual(page.reads, [], '正常运行时不轮询网页是否需要刷新')
    page.error()
    page.blank()
    await page.advance(0)
    await page.advance(1000)
    assert.equal(page.reloads(), 1, launch)
    assert.deepEqual(page.reads, ['api/dsh-workbench.workspace-move?requestId=r1'])
    page.error()
    await page.advance(1000)
    assert.equal(page.reloads(), 1)
    assert.equal(page.window.listenerCount('error'), 0)
  }
})

test('网页恢复只适用于原页面中已确认的命令行操作、指定错误和同一请求的新宿主结果', async () => {
  for (const scenario of ['working', 'other-error', 'navigate', 'pagehide', 'expired', 'desktop', 'rejected', 'plan', 'old-host', 'different-action', 'different-request']) {
    const page = webRecovery({
      kind: scenario === 'desktop' ? 'desktop' : 'command', ok: scenario !== 'rejected',
      progress: request => ({ ok: true, hostId: scenario === 'old-host' ? 'original' : 'new', request: { ...request, ...scenario === 'different-action' ? { action: 'undo' } : {}, ...scenario === 'different-request' ? { requestId: 'r2' } : {} } }),
    })
    if (scenario === 'plan') await page.client.plan('w1', '/folder')
    else await page.client.start('p1')
    if (scenario === 'expired') await page.advance(120000)
    if (scenario === 'pagehide') page.window.dispatchEvent({ type: 'pagehide' })
    if (scenario === 'navigate') page.window.location.href += '#other'
    if (scenario !== 'working') page.blank()
    page.error(scenario === 'other-error' ? 'Uncaught TypeError: elsewhere' : lostSessionScope)
    await page.advance(0)
    await page.advance(1000)
    assert.equal(page.reloads(), 0, scenario)
    if (['pagehide', 'expired', 'desktop', 'rejected', 'plan', 'navigate', 'working', 'other-error'].includes(scenario)) assert.deepEqual(page.reads, [], scenario)
  }
})

test('等待新宿主的网页在回复到达前离开或自行恢复时，不再刷新', async () => {
  for (const state of ['pagehide', 'working']) {
    const reply = Promise.withResolvers()
    const page = webRecovery({ progress: () => reply.promise })
    await page.client.start('p1')
    page.blank()
    page.error()
    await page.advance(0)
    await page.advance(1000)
    assert.equal(page.reads.length, 1)
    if (state === 'pagehide') page.window.dispatchEvent({ type: 'pagehide' })
    else { page.root.childElementCount = 1; page.document.body.innerText = 'DSH' }
    reply.resolve({ ok: true, hostId: 'reopened', request: { requestId: 'r1', action: 'move', phase: 'finished', outcome: 'moved', running: false } })
    await page.react.settle()
    assert.equal(page.reloads(), 0)
  }
})

test('页面恢复容许短暂断线，等待同一请求结束后才刷新', async () => {
  let attempts = 0
  const page = webRecovery({ progress: request => {
    attempts++
    if (attempts === 1) throw new Error('offline')
    if (attempts === 2) return { ok: true, hostId: 'reopened', request: { ...request, running: true, phase: 'relaunching' } }
    return { ok: true, hostId: 'reopened', request }
  } })
  await page.client.undo('m1')
  page.blank()
  page.error()
  await page.advance(0)
  assert.equal(page.reloads(), 0)
  await page.advance(1000)
  assert.equal(page.reloads(), 0)
  await page.advance(1000)
  assert.equal(page.reloads(), 1)
})

test('撤销前检查和退出后的结果都说明冲突，中英文显示新增会话数量', async ctx => {
  for (const [copy, path, count, busy] of [[WORKSPACE_MOVE_ZH, /文件夹.*(又|再次)/, /2 个会话/, /原位置.*占用/],
    [WORKSPACE_MOVE_EN, /folder.*changed/i, /sessions.*2/i, /original location.*occupied/i]]) {
    const translate = (key, params = {}) => copy[key]?.replace(/\{(\w+)\}/g, (_, k) => String(params[k]))
    for (const [code, pattern] of [['path-changed', path], ['new-sessions', count], ['original-occupied', busy]]) {
      const conflict = { code, count: 2 }, ui = timedClient()
      ctx.after(() => ui.react.unmount())
      const client = { undoCheck: async () => ({ ok: true, undoable: false, reason: 'changed-since-move', sessions: [], conflict }) }
      ui.mount('MoveUndoDialog', { t: translate, titleOf: () => undefined, target: { moveId: 'm' }, client, close() {} })
      await ui.react.settle()
      assert.match(textOf(ui.react.one(n => n.type === 'ui.Modal')), pattern)
      assert.match(moveResultNotice(translate, { action: 'undo', outcome: 'refused', conflict }).text, pattern)
    }
  }
})

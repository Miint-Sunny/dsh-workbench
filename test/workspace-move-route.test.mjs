/**
 * 会话迁移（feat#187）的路由：令牌、预览给界面看的部分、开始只认宿主里留着的预览、小进程的参数、结果的列出和已读、
 * 撤销前检查、在访达里显示。用到真会话的测试用 App 自己的代码造 DSH_HOME（没有 App 时跳过）；起小进程和访达用替身。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { requestsDir } from '../lib/workspace-move-launch.js'
import { applyWorkspaceMoveRoute, helperOptions, planView, untouchedKind } from '../lib/workspace-move-route.js'
import { applyWorkspaceMove, planWorkspaceMove } from '../lib/workspace-move.js'
import { NEEDS_APP, seedHome } from './helpers/dsh-app.mjs'
import { emptyWorkspace } from './helpers/workspace-move-empty.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import { done, NOT_RUNNING, setup } from './helpers/workspace-move-fixture.mjs'

const DESKTOP = { pid: 101, ppid: 100, execPath: '/Applications/DSH.app/Contents/Resources/runtime/bin/node', execArgv: [], argv: ['node', '/x/dsh-desktop-host/lib/index.js'], cwd: '/', ipc: true, tty: false, parentExecutable: '/Applications/DSH.app/Contents/MacOS/DSH' }
const WEB = { pid: 201, ppid: 1, execPath: '/Applications/DSH.app/Contents/MacOS/DSH', execArgv: [], argv: ['/Applications/DSH.app/Contents/MacOS/DSH', '/x/dsh', '--profile', 'web'], cwd: '/srv', ipc: false, tty: false }

/** 装上路由：替身工作区登记表、替身起小进程（记下参数）、替身访达。 */
function route(home, { facts = WEB, workspaces = [], bundleId = 'com.example.dsh', start } = {}) {
  let def
  const started = []
  const revealed = []
  const scope = { connection: { fetch: { register: (value) => { def = value; return () => {} } } }, workspaceRegistry: { list: () => workspaces } }
  applyWorkspaceMoveRoute(scope, {
    dshHome: home, homes: [], undoDays: 30, facts: () => facts, bundleIdOf: async () => bundleId,
    start: start ?? (async (options) => { started.push(options); return { requestId: `20261119T090000-${String(started.length).padStart(8, '0')}`, dir: '', pid: undefined } }),
    reveal: async (path) => { revealed.push(path) },
  })
  let token
  const get = async (query = '') => {
    const value = await (await def.fetch(new Request(`http://h/api/dsh-workbench.workspace-move${query}`))).json()
    if (typeof value.token === 'string') token = value.token
    return value
  }
  const post = async (body, headers = {}) => {
    if (token === undefined) await get()
    const response = await def.fetch(new Request('http://h/api/dsh-workbench.workspace-move', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-workbench-move': token, ...headers }, body: JSON.stringify(body),
    }))
    return { status: response.status, ...(await response.json()) }
  }
  return { get, post, started, revealed }
}

/** 写一条请求和它的状态，当作小进程已经走完。 */
function request(home, requestId, req, status) {
  const dir = join(requestsDir(home), requestId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ version: 1, requestId, ...req }))
  if (status !== undefined) writeFileSync(join(dir, 'status.json'), JSON.stringify(status))
  return dir
}

test('没有令牌、令牌不对或不是 JSON 正文的 POST 一律 403；没有这个动作 400', async () => {
  const home = await tempDir('dwb-move-route-')
  const server = route(home)
  await server.get()
  assert.equal((await server.post({ action: 'ack', requestId: 'x' }, { 'x-dsh-workbench-move': 'wrong' })).status, 403)
  assert.equal((await server.post({ action: 'ack', requestId: 'x' }, { 'content-type': 'text/plain' })).status, 403)
  assert.equal((await server.post({ action: 'nope' })).status, 400)
  assert.equal((await server.post({ action: 'toString' })).status, 400)
})

test('请求号、迁移号只收字母数字和连字符：带路径的一律 400，不碰文件', async () => {
  const home = await tempDir('dwb-move-route-')
  const server = route(home)
  for (const body of [{ action: 'ack', requestId: '../x' }, { action: 'reveal', requestId: 'a/b' }, { action: 'undo-check', moveId: '..' }, { action: 'undo', moveId: '' }, { action: 'recover', moveId: 'a\\b' }]) {
    assert.equal((await server.post(body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await server.get('?requestId=../../etc')).reason, 'bad-request')
  assert.deepEqual(server.revealed, [])
})

test('没做过迁移时：GET 回答令牌、DSH 的运行方式，结果、中断、记录都是空的；宿主编号每次启动不同', async () => {
  const home = await tempDir('dwb-move-route-')
  const status = await route(home, { facts: DESKTOP }).get()
  assert.equal(typeof status.token, 'string')
  assert.equal(typeof status.hostId, 'string')
  assert.notEqual((await route(home).get()).hostId, status.hostId)
  assert.equal(status.kind, 'desktop')
  assert.deepEqual([status.results, status.interrupted, status.records], [[], [], []])
})

test('小进程的参数：桌面 App 用 AppleScript 请它退出、等宿主和 App 主进程、open -a 重开、用 App 的可执行文件核对', async () => {
  const desktop = await helperOptions(DESKTOP, async app => (app === '/Applications/DSH.app' ? 'com.example.dsh' : undefined))
  assert.deepEqual(desktop.quit, { kind: 'applescript', bundleId: 'com.example.dsh' })
  assert.deepEqual(desktop.wait.pids, [101, 100])
  assert.deepEqual(desktop.relaunch, { kind: 'open-app', app: '/Applications/DSH.app' })
  assert.equal(desktop.appBinary, '/Applications/DSH.app/Contents/MacOS/DSH')
  const noBundle = await helperOptions(DESKTOP, async () => undefined)
  assert.deepEqual(noBundle.quit, { kind: 'none' })
  const web = await helperOptions(WEB, async () => 'unused')
  assert.deepEqual(web.quit, { kind: 'signal', pid: 201, signal: 'SIGINT' })
  assert.equal(web.appBinary, '/Applications/DSH.app/Contents/MacOS/DSH')
  const source = await helperOptions({ ...WEB, execPath: '/usr/local/bin/node' }, async () => 'unused')
  assert.equal(source.appBinary, null)
})

test('预览给界面看的部分：App 在运行不算阻碍；没改的工作台数据按功能归类；只显示用户能据此做决定的提醒', () => {
  const plan = {
    source: { workspaceId: 'w1', title: 'dsh_work', path: '/u/dsh_work' }, target: { kind: 'workspace', title: 'work', path: '/u/work' },
    result: { title: 'work', sessionIds: ['s-old', 'a', 'b'] }, sessions: [{ id: 'a' }, { id: 'b' }], counts: { sessions: 2, forks: 0, subagents: 0, archived: 1 },
    workbench: { checkpoints: [{}], memory: { action: 'conflict' }, trust: { action: 'replace' }, folders: { action: 'none' }, untouched: [{ file: 'approval-rules.json' }, { file: 'pages/p1/meta.json' }, { file: 'pages/p2/meta.json' }, { file: 'mcp-visibility.json' }] },
    blockers: [{ code: 'app-running', message: 'x' }, { code: 'open-turn', message: 'y', sessionId: 'a' }],
    warnings: [{ code: 'old-paths-in-history' }, { code: 'memory-conflict' }, { code: 'subfolder-sessions', count: 2 }, { code: 'unmatched-accounted', count: 1 }],
  }
  const view = planView(plan, ['/u'])
  assert.deepEqual(view.blockers, [{ code: 'open-turn', sessionId: 'a' }])
  assert.deepEqual(view.carries, ['checkpoints', 'trust'])
  assert.deepEqual(view.untouched, ['rules', 'pages', 'mcp'])
  assert.deepEqual(view.warnings, [{ code: 'memory-conflict' }, { code: 'subfolder-sessions', count: 2 }])
  assert.deepEqual(view.target, { kind: 'workspace', title: 'work', display: '~/work/', sessions: 1 })
  assert.equal(view.source.display, '~/dsh_work/')
  assert.equal(untouchedKind('checkpoints/x/meta.json'), 'other')
})

test('预览并开始：开始只认宿主里留着的预览（planId），小进程拿到的是那份预览和 web 的退出、重开方式', { skip: NEEDS_APP }, async () => {
  const { home, id, work } = await setup()
  const server = route(home, { workspaces: [{ id }] })
  const preview = await server.post({ action: 'plan', workspaceId: id, path: work })
  assert.equal(preview.ok, true)
  assert.equal(preview.kind, 'command')
  assert.deepEqual(preview.preview.counts, { sessions: 3, forks: 1, subagents: 1, archived: 1 })
  assert.deepEqual(preview.preview.blockers, [])
  assert.deepEqual(preview.preview.carries, ['checkpoints', 'memory', 'trust'])
  assert.equal(preview.preview.target.kind, 'folder')
  assert.equal((await server.post({ action: 'start', planId: 'made-up' })).reason, 'stale-plan')
  const started = await server.post({ action: 'start', planId: preview.planId, plan: { sessions: [] } })
  assert.deepEqual([started.ok, started.kind], [true, 'command'])
  assert.equal(started.hostId, (await server.get()).hostId)
  assert.equal(server.started.length, 1)
  const options = server.started[0]
  assert.deepEqual([options.action, options.home, options.plan.source.workspaceId, options.plan.sessions.length], ['move', home, id, 4])
  assert.deepEqual(options.quit, { kind: 'signal', pid: 201, signal: 'SIGINT' })
  assert.equal(options.relaunch.kind, 'command')
  assert.equal((await server.post({ action: 'plan', workspaceId: 'not-there', path: work })).status, 404)
  assert.equal((await server.post({ action: 'plan', workspaceId: id, path: join(home, 'gone') })).reason, 'target-missing')
})

test('有进行中的轮次：预览列出阻碍，开始被拒绝，不起小进程', { skip: NEEDS_APP }, async () => {
  const { home, id, work } = await setup({ openTurn: true })
  const server = route(home, { workspaces: [{ id }] })
  const preview = await server.post({ action: 'plan', workspaceId: id, path: work })
  assert.deepEqual(preview.preview.blockers, [{ code: 'open-turn', sessionId: 'session-a' }])
  assert.equal((await server.post({ action: 'start', planId: preview.planId })).reason, 'blocked')
  assert.deepEqual(server.started, [])
})

test('结果：小进程走完、没提示过的列出来（含从哪到哪、几个会话）；标记已读后不再列出；还在跑的不列', async () => {
  const home = await tempDir('dwb-move-route-')
  const plan = { source: { workspaceId: 'w1', title: 'dsh_work', path: '/u/dsh_work' }, target: { path: '/u/work' }, result: { title: 'work' }, sessions: [{ id: 'a' }, { id: 'b' }] }
  request(home, '20261119T090000-aaaaaaaa', { action: 'move', plan }, { phase: 'finished', outcome: 'moved', moveId: '20261119T090001-bbbbbbbb' })
  request(home, '20261119T090100-cccccccc', { action: 'move', plan }, { phase: 'gave-up', outcome: 'not-quit', quitError: 'x' })
  request(home, '20261119T090200-dddddddd', { action: 'move', plan }, { phase: 'waiting', pid: process.pid })
  request(home, '20261119T090300-eeeeeeee', { action: 'move', plan }, { phase: 'waiting', pid: 2 ** 22 + 12345 })
  const server = route(home)
  const listed = (await server.get()).results
  assert.deepEqual(listed.map(item => [item.requestId, item.outcome]), [
    ['20261119T090000-aaaaaaaa', 'moved'], ['20261119T090100-cccccccc', 'not-quit'], ['20261119T090300-eeeeeeee', 'interrupted'],
  ])
  assert.deepEqual([listed[0].source.title, listed[0].target.display, listed[0].sessions, listed[0].moveId], ['dsh_work', '/u/work/', 2, '20261119T090001-bbbbbbbb'])
  assert.equal(listed[1].quitError, true)
  assert.equal((await server.get('?requestId=20261119T090200-dddddddd')).request.running, true)
  assert.equal((await server.post({ action: 'ack', requestId: '20261119T090000-aaaaaaaa' })).ok, true)
  assert.deepEqual((await server.get()).results.map(item => item.requestId), ['20261119T090100-cccccccc', '20261119T090300-eeeeeeee'])
  assert.equal((await server.post({ action: 'ack', requestId: '20261119T099999-ffffffff' })).status, 404)
})

test('撤销前检查和撤销：搬完没动过、只在末尾追加过时可以撤销；日志被改写以后列出会话，不起小进程', { skip: NEEDS_APP }, async () => {
  const { home, id, work } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const server = route(home)
  const records = (await server.get()).records
  assert.deepEqual(records.map(item => [item.moveId, item.workspaceId, item.undoable, item.sessions]), [[moveId, plan.result.workspaceId, true, 4]])
  assert.deepEqual(await server.post({ action: 'undo-check', moveId }), { status: 200, ok: true, undoable: true })
  seedHome(home, { appends: [{ id: 'session-a', events: done(2) }] })
  assert.deepEqual(await server.post({ action: 'undo-check', moveId }), { status: 200, ok: true, undoable: true, appended: ['session-a'] })
  const dir = join(home, plan.sessions.find(item => item.id === 'session-a').to)
  const log = join(dir, readdirSync(dir).find(name => name.endsWith('.zstd')))
  writeFileSync(log, readFileSync(log).subarray(0, -1))
  const check = await server.post({ action: 'undo-check', moveId })
  assert.deepEqual([check.undoable, check.reason, check.sessions, check.others], [false, 'changed-since-move', ['session-a'], false])
  assert.equal((await server.post({ action: 'undo', moveId })).reason, 'changed-since-move')
  assert.deepEqual(server.started, [])
  assert.equal((await server.post({ action: 'undo-check', moveId: '20200101T000000-00000000' })).reason, 'no-move')
})

test('在访达里显示：有迁移记录时显示迁移记录，没有时显示请求目录', { skip: process.platform !== 'darwin' && '只在 macOS' }, async () => {
  const home = await tempDir('dwb-move-route-')
  const moves = join(home, 'dsh-workbench', 'workspace-moves')
  mkdirSync(join(moves, '20261119T090001-bbbbbbbb'), { recursive: true })
  writeFileSync(join(moves, '20261119T090001-bbbbbbbb', 'journal.json'), JSON.stringify({ status: 'done', entries: [] }))
  request(home, '20261119T090000-aaaaaaaa', { action: 'move' }, { phase: 'failed', outcome: 'check-failed-undone', moveId: '20261119T090001-bbbbbbbb' })
  const bare = request(home, '20261119T090100-cccccccc', { action: 'move' }, { phase: 'failed', outcome: 'error' })
  const server = route(home)
  assert.equal((await server.post({ action: 'reveal', requestId: '20261119T090000-aaaaaaaa' })).ok, true)
  assert.equal((await server.post({ action: 'reveal', requestId: '20261119T090100-cccccccc' })).ok, true)
  assert.deepEqual(server.revealed, [join(moves, '20261119T090001-bbbbbbbb'), bare])
  assert.equal(readFileSync(join(bare, 'request.json'), 'utf8').includes('cccccccc'), true)
})

test('同时提交两个开始请求只启动一次；重开的宿主也能看到正在等待的请求', async () => {
  const { home, id, work } = await emptyWorkspace()
  const requestId = '20261119T090000-00000001'
  const start = async options => {
    const dir = request(home, requestId, options, { phase: 'waiting', pid: process.pid })
    return { requestId, dir, pid: process.pid }
  }
  const first = route(home, { workspaces: [{ id }], start })
  const plan = await first.post({ action: 'plan', workspaceId: id, path: work })
  const submit = { action: 'start', planId: plan.planId }
  const replies = await Promise.all([first.post(submit), first.post(submit)])
  assert.deepEqual(replies.map(item => item.ok).sort(), [false, true])
  assert.equal(replies.find(item => !item.ok).reason, 'busy')

  const next = route(home, { workspaces: [{ id }] })
  const preview = await next.post({ action: 'plan', workspaceId: id, path: work })
  assert.deepEqual((await next.get()).runningRequests, [requestId])
  const busy = await next.post({ action: 'start', planId: preview.planId })
  assert.deepEqual([busy.ok, busy.reason, busy.requestId], [false, 'busy', requestId])
})

test('运行中的请求不能标记已读；退出后保留核对和重开的结果', async () => {
  const home = await tempDir('dwb-move-route-')
  const requestId = '20261119T090000-00000001'
  const dir = request(home, requestId, { action: 'undo' }, { phase: 'waiting', pid: process.pid })
  const server = route(home)
  assert.equal((await server.post({ action: 'ack', requestId })).ok, false)
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'finished', outcome: 'undone', checked: false, checkError: 'verification unavailable', relaunched: 'failed: ENOENT' }))
  const [result] = (await server.get()).results
  assert.deepEqual([result.outcome, result.checked, result.checkError, result.relaunched], ['undone', false, 'verification unavailable', 'failed: ENOENT'])
})

test('请求号、迁移号及动作只收字符串', async () => {
  const server = route(await tempDir('dwb-move-route-'))
  for (const action of ['ack', 'reveal', 'undo-check', 'undo', 'recover']) {
    for (const id of [1234, ['record']]) {
      assert.equal((await server.post({ action, requestId: id, moveId: id })).status, 400)
    }
  }
  assert.equal((await server.post({ action: ['ack'], requestId: 'record' })).status, 400)
})

test('超过撤销期限的记录在预检和执行时均被拒绝', async () => {
  const { home, id, work } = await emptyWorkspace()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const { moveDir, moveId: expired } = await applyWorkspaceMove({ home, plan })
  const { utimesSync } = await import('node:fs')
  const oldDate = new Date('2000-01-01T09:00:00Z')
  utimesSync(join(moveDir, 'journal.json'), oldDate, oldDate)
  const server = route(home)
  assert.equal((await server.get()).records[0].undoable, false)
  assert.equal((await server.post({ action: 'undo-check', moveId: expired })).undoable, false)
  assert.equal((await server.post({ action: 'undo', moveId: expired })).ok, false)
  assert.equal(server.started.length, 0)
})

test('重开的宿主拒绝为仍存活的小进程另起一次迁移', async () => {
  const { home, id, work } = await emptyWorkspace()
  const requestId = '20261119T090000-00000001'
  request(home, requestId, { action: 'move' }, { phase: 'waiting', pid: process.pid })
  const server = route(home, { workspaces: [{ id }] })
  const { planId } = await server.post({ action: 'plan', workspaceId: id, path: work })
  const reply = await server.post({ action: 'start', planId })
  assert.deepEqual([reply.ok, reply.reason, reply.requestId], [false, 'busy', requestId])
})

test('旧请求中不可用的迁移号不会用于显示路径', { skip: process.platform !== 'darwin' }, async () => {
  const home = await tempDir('dwb-move-route-')
  const requestId = '20261119T090000-00000001'
  const dir = request(home, requestId, { action: 'undo', moveId: 1234 }, { phase: 'failed', outcome: 'error' })
  const server = route(home)
  const { request: result } = await server.get('?requestId=' + requestId)
  assert.equal(result.moveId, undefined)
  assert.equal((await server.post({ action: 'reveal', requestId })).ok, true)
  assert.deepEqual(server.revealed, [dir])
})

test('只有实际的请求、记录目录能列出和显示；普通文件和目录别名不作为记录', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs')
  const home = await tempDir('dwb-move-route-')
  const id = '20261119T090000-00000001'
  const alias = '20261119T090000-00000002'
  const moves = join(home, 'dsh-workbench', 'workspace-moves')
  const dir = request(home, id, { action: 'move' }, { phase: 'finished', outcome: 'moved', moveId: alias })
  symlinkSync(dir, join(requestsDir(home), alias), 'dir')
  writeFileSync(join(requestsDir(home), 'notes'), 'ordinary file')
  const record = join(home, 'record')
  mkdirSync(record)
  writeFileSync(join(record, 'journal.json'), JSON.stringify({ status: 'done' }))
  symlinkSync(record, join(moves, alias), 'dir')
  const server = route(home)
  assert.deepEqual((await server.get()).results.map(item => item.requestId), [id])
  assert.equal((await server.get('?requestId=' + alias)).reason, 'no-request')
  assert.equal((await server.post({ action: 'ack', requestId: alias })).ok, false)
  if (process.platform === 'darwin') {
    assert.equal((await server.post({ action: 'reveal', requestId: id })).ok, true)
    assert.deepEqual(server.revealed, [dir])
  }
})

test('以前的小进程编号即使已被新进程使用，中断的请求仍能提示', { skip: process.platform === 'win32' }, async () => {
  const home = await tempDir('dwb-move-route-')
  const id = '20261119T090000-00000001'
  request(home, id, { action: 'move' }, { phase: 'waiting', pid: process.pid, updatedAt: '2000-01-01T00:00:00Z' })
  const server = route(home)
  const status = await server.get()
  assert.deepEqual(status.runningRequests, [])
  assert.equal(status.results[0].outcome, 'interrupted')
})

test('撤销检查把新建的会话数交给界面', async () => {
  const { home, work, id } = await emptyWorkspace()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const path = join(home, 'storages', 'workspace.json'), value = JSON.parse(readFileSync(path))
  value.tables.workspaces[id].sessionIds.push('a', 'b')
  writeFileSync(path, JSON.stringify(value))
  const result = await route(home).post({ action: 'undo-check', moveId })
  assert.deepEqual([result.undoable, result.conflict], [false, { code: 'new-sessions', count: 2 }])
})

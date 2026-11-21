import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { dshProcessFacts, pendingWorkspaceMoveRequests, startWorkspaceMoveHelper } from '../lib/workspace-move-launch.js'
import { applyWorkspaceMove, pendingWorkspaceMoves, planWorkspaceMove } from '../lib/workspace-move.js'
import { APP_BINARY, appCheck, NEEDS_APP, seedHome, treeHashes } from './helpers/dsh-app.mjs'
import { emptyWorkspace } from './helpers/workspace-move-empty.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import { undoTree, committedSessions, crashMove, done, MOVES, NOT_RUNNING, setup } from './helpers/workspace-move-fixture.mjs'

const PARENT = new URL('./helpers/workspace-move-helper-parent.mjs', import.meta.url).pathname
/** 小进程的请求目录，「什么都没动」不比它。 */
const REQUESTS = rel => rel.startsWith(join('dsh-workbench', 'workspace-moves', 'requests'))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** 一个假的「DSH 进程」：只是活着，等人结束它。 */
const fakeDsh = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
const statusOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))
  } catch {
    return undefined
  }
}
async function until(check, ms = 60_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}
const finished = dir => until(() => ['finished', 'gave-up', 'failed'].includes(statusOf(dir)?.phase) && statusOf(dir))
const groupsOf = report => Object.fromEntries(report.workspaces.map(item => [item.path, item.sessionIds]))

async function preview(options) {
  const fixture = await setup(options)
  const plan = await planWorkspaceMove({ home: fixture.home, workspaceId: fixture.id, targetPath: fixture.work, appRunning: NOT_RUNNING })
  return { ...fixture, plan }
}

test('小进程：DSH 进程退出之前什么都不动；退出以后才搬，搬完用 App 的代码核对，写下结果', { skip: NEEDS_APP }, async () => {
  const { home, work, plan } = await preview()
  const before = treeHashes(home, MOVES)
  const dsh = fakeDsh()
  try {
    const { dir } = await startWorkspaceMoveHelper({ home, plan, wait: { pids: [dsh.pid], timeoutMs: 30_000 }, quit: { kind: 'none' }, relaunch: { kind: 'none' }, appBinary: APP_BINARY })
    await until(() => statusOf(dir)?.phase === 'waiting')
    await sleep(800)
    assert.equal(statusOf(dir).phase, 'waiting')
    assert.deepEqual(treeHashes(home, MOVES), before)
    dsh.kill('SIGTERM')
    const status = await finished(dir)
    assert.equal(status.outcome, 'moved', status.message)
    assert.equal(status.checked, true)
    assert.equal(groupsOf(appCheck(home))[work].length, 3)
  } finally {
    dsh.kill('SIGKILL')
  }
})

test('小进程：机器上没有 App 时照样搬，结果里不写 checked，表示没用 App 的代码核对', { skip: NEEDS_APP }, async () => {
  const { home, work, plan } = await preview()
  const { dir } = await startWorkspaceMoveHelper({ home, plan, wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' }, relaunch: { kind: 'none' } })
  const status = await finished(dir)
  assert.equal(status.outcome, 'moved', status.message)
  assert.equal('checked' in status, false)
  assert.equal(groupsOf(appCheck(home))[work].length, 3)
})

test('小进程：预览是在 DSH 运行时算的（带着 app-running），退出以后照样搬', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: () => true })
  assert.deepEqual(plan.blockers.map(item => item.code), ['app-running'])
  const { dir } = await startWorkspaceMoveHelper({ home, plan, wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' }, relaunch: { kind: 'none' }, appBinary: APP_BINARY })
  const status = await finished(dir)
  assert.equal(status.outcome, 'moved', status.message)
  assert.equal(groupsOf(appCheck(home))[work].length, 3)
})

test('判断 DSH 是哪一种：桌面宿主等 App 进程树、用 open -a 重开；web 给自己发 SIGINT、按原命令重开；终端里的不自动重开', () => {
  const desktop = dshProcessFacts({ pid: 40, ppid: 30, execPath: '/Apps/DeepSeek Harness.app/Contents/Resources/runtime/bin/node', execArgv: ['--expose-internals'], argv: ['/x/node', '/Apps/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'], cwd: '/w', ipc: true, tty: false, parentExecutable: '/Apps/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' })
  assert.deepEqual(desktop, { kind: 'desktop', wait: { pids: [40, 30], desktopTree: true }, quit: { kind: 'none' }, relaunch: { kind: 'open-app', app: '/Apps/DeepSeek Harness.app' } })
  const web = dshProcessFacts({ pid: 50, ppid: 20, execPath: '/Apps/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', execArgv: ['--expose-internals'], argv: ['/Apps/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', '/cli.js', '--profile', 'web', '--no-open'], cwd: '/w', ipc: false, tty: false })
  assert.deepEqual(web, { kind: 'command', wait: { pids: [50] }, quit: { kind: 'signal', pid: 50, signal: 'SIGINT' }, relaunch: { kind: 'command', file: '/Apps/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', args: ['--expose-internals', '/cli.js', '--profile', 'web', '--no-open'], cwd: '/w' } })
  const terminal = dshProcessFacts({ pid: 60, ppid: 20, execPath: '/n', execArgv: [], argv: ['/n', '/cli.js', '--profile', 'tui'], cwd: '/w', ipc: false, tty: true })
  assert.deepEqual(terminal, { kind: 'terminal', wait: { pids: [60] }, quit: { kind: 'none' }, relaunch: { kind: 'none' } })
})

test('小进程：请 DSH 退出没成功（比如不许控制 App）时记下原因，照样等用户自己退出，退了就搬', { skip: NEEDS_APP }, async () => {
  const { home, plan } = await preview()
  const dsh = fakeDsh()
  try {
    const { dir } = await startWorkspaceMoveHelper({ home, plan, wait: { pids: [dsh.pid], timeoutMs: 30_000 }, quit: { kind: 'signal', pid: dsh.pid, signal: 'SIGNOTREAL' }, relaunch: { kind: 'none' } })
    await until(() => statusOf(dir)?.phase === 'waiting')
    assert.match(statusOf(dir).quitError ?? '', /SIGNOTREAL/)
    assert.equal(alive(dsh.pid), true)
    dsh.kill('SIGTERM')
    const status = await finished(dir)
    assert.deepEqual([status.phase, status.outcome], ['finished', 'moved'])
  } finally {
    if (alive(dsh.pid)) dsh.kill('SIGKILL')
  }
})

test('小进程：等不到 DSH 进程退出就放弃，什么都不改，留下原因，下次打开时列出来', { skip: NEEDS_APP }, async () => {
  const { home, plan } = await preview()
  const before = treeHashes(home, MOVES)
  const dsh = fakeDsh()
  try {
    const { dir, requestId } = await startWorkspaceMoveHelper({ home, plan, wait: { pids: [dsh.pid], timeoutMs: 1500 }, quit: { kind: 'none' }, relaunch: { kind: 'none' }, appBinary: APP_BINARY })
    const status = await finished(dir)
    assert.deepEqual([status.phase, status.outcome], ['gave-up', 'not-quit'])
    assert.equal(alive(dsh.pid), true)
    assert.deepEqual(treeHashes(home, MOVES), before)
    assert.deepEqual((await pendingWorkspaceMoveRequests(home)).map(item => [item.requestId, item.outcome]), [[requestId, 'not-quit']])
  } finally {
    dsh.kill('SIGKILL')
  }
})

test('小进程：起它的进程连同进程组被 Ctrl-C（SIGINT）结束以后，小进程照样等到退出、搬完', { skip: NEEDS_APP }, async () => {
  const { home, work, plan } = await preview()
  const planFile = join(await tempDir('dwb-move-plan-'), 'plan.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(planFile, JSON.stringify(plan))
  const parent = spawn(process.execPath, [PARENT], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, DWB_HOME: home, DWB_PLAN: planFile, DWB_APP_BINARY: APP_BINARY },
  })
  let output = ''
  parent.stdout.on('data', (chunk) => { output += chunk })
  const dir = await until(() => /^dir: (.+)$/m.exec(output)?.[1])
  process.kill(-parent.pid, 'SIGINT')
  await until(() => !alive(parent.pid))
  const status = await finished(dir)
  assert.equal(status.outcome, 'moved', status.message)
  assert.equal(groupsOf(appCheck(home))[work].length, 3)
})

test('小进程：照桌面 App 的样子退出（主进程发 IPC shutdown，宿主退出，主进程再退出），小进程不靠宿主的管道，照样搬完', { skip: NEEDS_APP }, async () => {
  const { home, work, plan } = await preview()
  const planFile = join(await tempDir('dwb-move-plan-'), 'plan.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(planFile, JSON.stringify(plan))
  const main = spawn(process.execPath, [new URL('./helpers/desktop-shape-main.mjs', import.meta.url).pathname], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, DWB_HOME: home, DWB_PLAN: planFile, DWB_APP_BINARY: APP_BINARY },
  })
  let output = ''
  main.stdout.on('data', (chunk) => { output += chunk })
  const dir = await until(() => /^dir: (.+)$/m.exec(output)?.[1])
  await until(() => !alive(main.pid))
  const status = await finished(dir)
  assert.equal(status.outcome, 'moved', status.message)
  assert.equal(groupsOf(appCheck(home))[work].length, 3)
})

test('小进程：下次打开时倒回做到一半的迁移（action recover），回到原样', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const before = treeHashes(fixture.home, MOVES)
  const pending = await crashMove(fixture, 'commit-rename:4')
  const { dir } = await startWorkspaceMoveHelper({ home: fixture.home, action: 'recover', moveId: pending.moveId, wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' }, relaunch: { kind: 'none' }, appBinary: APP_BINARY })
  const status = await finished(dir)
  assert.equal(status.outcome, 'recovered', status.message)
  assert.deepEqual(treeHashes(fixture.home, MOVES), before)
  assert.deepEqual(await pendingWorkspaceMoves(fixture.home), [])
})

test('小进程：倒回时发现搬过去的会话日志被改写过，不倒回，结果是 refused', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const pending = await crashMove(fixture, 'commit-rename:4')
  const [moved] = committedSessions(fixture.home, pending.moveId)
  const sessionDir = readdirSync(join(fixture.home, 'sessions')).map(name => join(fixture.home, 'sessions', name, moved)).find(path => existsSync(path))
  const log = join(sessionDir, readdirSync(sessionDir).find(name => name.endsWith('.zstd')))
  writeFileSync(log, readFileSync(log).subarray(0, -1))
  const halfway = treeHashes(fixture.home, REQUESTS)
  const { dir } = await startWorkspaceMoveHelper({ home: fixture.home, action: 'recover', moveId: pending.moveId, wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' }, relaunch: { kind: 'none' }, appBinary: APP_BINARY })
  const status = await finished(dir)
  assert.deepEqual([status.phase, status.outcome], ['finished', 'refused'], status.message)
  assert.deepEqual(treeHashes(fixture.home, REQUESTS), halfway)
})

test('小进程：撤回一次做完的迁移（action undo），回到搬之前的样子', { skip: NEEDS_APP }, async () => {
  const { home, id, plan } = await preview()
  const before = undoTree(home, id)
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const { dir } = await startWorkspaceMoveHelper({ home, action: 'undo', moveId, wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' }, relaunch: { kind: 'none' }, appBinary: APP_BINARY })
  const status = await finished(dir)
  assert.equal(status.outcome, 'undone', status.message)
  assert.deepEqual(undoTree(home, id), before)
})

test('小进程：搬完按原来的命令重新启动 DSH', { skip: NEEDS_APP }, async () => {
  const { home, plan } = await preview()
  const marker = join(await tempDir('dwb-move-relaunch-'), 'relaunched.txt')
  const { dir } = await startWorkspaceMoveHelper({
    home, plan,
    wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' },
    relaunch: { kind: 'command', file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'up')`], cwd: home },
    appBinary: APP_BINARY,
  })
  const status = await finished(dir)
  assert.deepEqual([status.outcome, status.relaunched], ['moved', 'command'])
  await until(() => existsSync(marker), 10_000)
})

test('小进程：有阻碍（进行中的轮次）时不搬，照样重新启动 DSH，结果写明原因', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup({ openTurn: true })
  const plan = { ...(await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })), blockers: [] }
  const before = treeHashes(home, MOVES)
  const marker = join(await tempDir('dwb-move-relaunch-'), 'relaunched.txt')
  const { dir } = await startWorkspaceMoveHelper({
    home, plan,
    wait: { pids: [], timeoutMs: 5000 }, quit: { kind: 'none' },
    relaunch: { kind: 'command', file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'up')`], cwd: home },
    appBinary: APP_BINARY,
  })
  const status = await finished(dir)
  assert.equal(status.outcome, 'blocked')
  assert.deepEqual(status.blockers.map(item => item.code), ['open-turn'])
  assert.deepEqual(treeHashes(home, MOVES), before)
  await until(() => existsSync(marker), 10_000)
})

const offline = { wait: { pids: [] }, quit: { kind: 'none' }, relaunch: { kind: 'none' } }

test('小进程启动失败直接报错，留下明确的失败结果', async () => {
  const home = await tempDir('dwb-move-launch-')
  await assert.rejects(startWorkspaceMoveHelper({ home, ...offline, nodePath: join(home, 'missing-node') }), { code: 'ENOENT' })
  const [request] = await pendingWorkspaceMoveRequests(home)
  assert.deepEqual([request.phase, request.outcome], ['failed', 'error'])
})

test('重开命令不存在时保留迁移结果，记录启动错误', async () => {
  const { home, id, work } = await emptyWorkspace()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const { dir, pid } = await startWorkspaceMoveHelper({ ...offline, home, plan, relaunch: { kind: 'command', file: join(home, 'missing-command'), cwd: home, args: [] } })
  await until(() => !alive(pid))
  const status = statusOf(dir)
  assert.deepEqual([status.phase, status.outcome], ['finished', 'moved'], status.message)
  assert.match(status.relaunched, /failed:.*ENOENT/)
})

test('插件安装路径包含空格和 # 时，小进程仍能加载并运行核对脚本', async () => {
  const { home, id, work } = await emptyWorkspace()
  const installed = join(home, 'workbench #1')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(installed)
  for (const name of ['workspace-move-launch.js', 'workspace-move-helper.mjs', 'workspace-move-check.js', 'workspace-move-appcheck.mjs']) {
    copyFileSync(fileURLToPath(new URL('../lib/' + name, import.meta.url)), join(installed, name))
  }
  for (const name of ['workspace-move.js', 'workspace-move-processes.js', 'data-dir.js']) {
    symlinkSync(fileURLToPath(new URL('../lib/' + name, import.meta.url)), join(installed, name))
  }
  writeFileSync(join(installed, 'package.json'), '{"type":"module"}')
  const launch = await import(pathToFileURL(join(installed, 'workspace-move-launch.js')))
  const { runAppCheck } = await import(pathToFileURL(join(installed, 'workspace-move-check.js')))
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const { dir, pid } = await launch.startWorkspaceMoveHelper({ ...offline, home, plan })
  await until(() => !alive(pid))
  assert.equal(statusOf(dir)?.outcome, 'moved', readFileSync(join(dir, 'helper.log'), 'utf8'))
  const report = await runAppCheck({ home, appBinary: process.execPath })
  assert.equal(report.ok, false)
  assert.match(report.error, /cordis/)
})

test('迁移后的核对进程退出异常也会撤回，撤销完成后的核对异常保留撤销结果', async () => {
  const { home, id, old, work } = await emptyWorkspace()
  const appBinary = join(home, 'fake-app')
  writeFileSync(appBinary, `#!/usr/bin/env node
const fs = require('node:fs')
const record = JSON.parse(fs.readFileSync(process.env.DWB_MOVE_HOME + '/storages/workspace.json')).tables.workspaces.w1
if (record.path === process.env.DWB_CHECK_FAIL_AT) process.exit(2)
process.stdout.write(JSON.stringify({ ok: true, listed: 0, sessions: {}, workspaces: [{ id: 'w1', ...record }], archived: [], pinned: [], writeOpen: {} }))
`)
  chmodSync(appBinary, 0o700)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const run = async (failAt, options) => {
    const { dir, pid } = await startWorkspaceMoveHelper({ home, ...offline, ...options, appBinary, env: { ...process.env, DWB_CHECK_FAIL_AT: failAt } })
    await until(() => !alive(pid))
    return statusOf(dir)
  }
  const result = await run(work, { plan })
  assert.equal(result.outcome, 'check-failed-undone', result.message)
  const registry = () => JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'))).tables.workspaces.w1
  assert.equal(registry().path, old)
  const { moveId } = await applyWorkspaceMove({ home, plan })
  const undo = await run(old, { action: 'undo', moveId })
  assert.deepEqual([undo.outcome, undo.checked, undo.moveId], ['undone', false, moveId])
  assert.equal(typeof undo.checkError, 'string')
})

test('不同宿主的小进程共享排他权，已有小进程活动时不会再改数据', async () => {
  const { home, id, work, old } = await emptyWorkspace()
  const { requestsDir } = await import('../lib/workspace-move-launch.js')
  const { mkdirSync } = await import('node:fs')
  const other = join(requestsDir(home), '20261119T090000-00000001')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'status.json'), JSON.stringify({ phase: 'waiting', pid: process.pid }))
  writeFileSync(join(other, 'request.json'), JSON.stringify({ action: 'move' }))
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const { dir, pid } = await startWorkspaceMoveHelper({ ...offline, home, plan })
  await until(() => !alive(pid))
  assert.equal(statusOf(dir).outcome, 'blocked')
  const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json')))
  assert.equal(registry.tables.workspaces.w1.path, old)
})

test('重开失败的迁移在下次检查时保留，即使会话已搬好', async () => {
  const home = await tempDir('dwb-move-launch-')
  const { requestsDir } = await import('../lib/workspace-move-launch.js')
  const { mkdirSync } = await import('node:fs')
  const dir = join(requestsDir(home), '20261119T090000-00000001')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'finished', outcome: 'moved', relaunched: 'failed: ENOENT' }))
  const [request] = await pendingWorkspaceMoveRequests(home)
  assert.equal(request?.outcome, 'moved')
  assert.match(request?.relaunched, /failed/)
})

test('从相对 DSH_HOME 启动时，小进程在自己的工作目录也能完成迁移', async () => {
  const { relative } = await import('node:path')
  const { home, id, work } = await emptyWorkspace()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const { dir, pid } = await startWorkspaceMoveHelper({ ...offline, home: relative(process.cwd(), home), plan })
  await until(() => !alive(pid))
  assert.equal(statusOf(dir)?.outcome, 'moved', statusOf(dir)?.message)
})

test('请求目录是别名时不会把请求写到其他位置', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs')
  const { requestsDir } = await import('../lib/workspace-move-launch.js')
  const { dirname } = await import('node:path')
  const { home, id, work } = await emptyWorkspace()
  const other = await tempDir('dwb-empty-records-')
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  mkdirSync(dirname(requestsDir(home)), { recursive: true })
  symlinkSync(other, requestsDir(home), 'dir')
  let launched
  try {
    await assert.rejects(async () => {
      launched = await startWorkspaceMoveHelper({ ...offline, home, plan })
    })
    assert.deepEqual(readdirSync(other), [])
  } finally {
    if (launched) await until(() => !alive(launched.pid))
  }
})

test('一次终态写入失败仍保留已完成的迁移，只执行一次重开', async () => {
  const { home, id, work } = await emptyWorkspace()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work })
  const preload = join(home, 'write-fault.cjs')
  writeFileSync(preload, `const fs = require('node:fs/promises')
const { writeFile } = fs
let failed = false
fs.writeFile = async (file, data, ...rest) => {
  if (!failed && file.endsWith('.tmp') && typeof data === 'string' && data.includes('"phase": "finished"')) {
    failed = true
    throw Error('一次写入失败')
  }
  return writeFile(file, data, ...rest)
}
require('node:module').syncBuiltinESMExports()
`)
  const marker = join(home, 'reopened.txt')
  const { dir, pid } = await startWorkspaceMoveHelper({
    ...offline, home, plan, env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(preload) },
    relaunch: { kind: 'command', file: process.execPath, args: ['-e', "require('node:fs').appendFileSync(process.argv[1], process.pid + '\\n')", marker], cwd: home },
  })
  await until(() => !alive(pid))
  const status = statusOf(dir)
  assert.equal(status.outcome, 'moved', status.message)
  await until(() => existsSync(marker) && readFileSync(marker, 'utf8').includes(String(status.relaunchedPid)))
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), [String(status.relaunchedPid)])
})

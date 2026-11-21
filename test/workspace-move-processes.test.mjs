import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { dshProcessFacts, startWorkspaceMoveHelper } from '../lib/workspace-move-launch.js'
import { applyWorkspaceMove, planWorkspaceMove, undoWorkspaceMove } from '../lib/workspace-move.js'
import { emptyWorkspace } from './helpers/workspace-move-empty.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

const macOS = { skip: process.platform !== 'darwin' && '桌面 App 的进程检查在 macOS 上运行' }
const quitNone = { kind: 'none' }
const stillRunning = 'setTimeout(() => {}, 30_000)'

async function until(check) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(50)) {
    const result = check()
    if (result) return result
  }
  throw new Error('等待测试进程超时')
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function statusOf(dir) {
  const file = join(dir, 'status.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

const finished = dir => until(() => {
  const status = statusOf(dir)
  return ['finished', 'failed', 'gave-up'].includes(status?.phase) && status
})

async function scene(t) {
  const root = await tempDir('dwb-move-processes-')
  const user = join(root, '测试 用户')
  const home = join(user, '.dsh')
  mkdirSync(home, { recursive: true })
  const previous = process.env.HOME
  process.env.HOME = user
  t.after(() => {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  })

  const bundle = join(root, 'DeepSeek Harness.app')
  const executable = join(bundle, 'Contents/MacOS/DeepSeek Harness')
  const hostBinary = bundle + '/Contents/Resources/../MacOS/DeepSeek Harness'
  const entry = join(bundle, 'Contents/Resources/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')
  mkdirSync(dirname(executable), { recursive: true })
  mkdirSync(dirname(entry), { recursive: true })
  symlinkSync(process.execPath, executable)
  const filter = join(root, 'mcp-filter.cjs')
  writeFileSync(filter, stillRunning)
  const pidsFile = join(root, 'tree.json')
  writeFileSync(entry, `
const { spawn } = require('node:child_process')
if (process.env.DWB_FAKE_TREE) {
  const filter = spawn(${JSON.stringify(executable)}, [${JSON.stringify(filter)}], { stdio: 'ignore' })
  const fs = require('node:fs')
  const file = ${JSON.stringify(pidsFile)}
  fs.writeFileSync(file + '.tmp', JSON.stringify({ host: process.pid, filter: filter.pid }))
  fs.renameSync(file + '.tmp', file)
}
${stillRunning}
`)
  const main = join(root, 'main.cjs')
  writeFileSync(main, `
const { spawn } = require('node:child_process')
const { NODE_OPTIONS, ...env } = process.env
const host = spawn(${JSON.stringify(hostBinary)}, [${JSON.stringify(entry)}], {
  stdio: 'ignore', env: { ...env, DWB_FAKE_TREE: '1', ELECTRON_RUN_AS_NODE: '1' },
})
process.on('SIGTERM', () => host.kill())
host.on('exit', () => process.exit())
${stillRunning}
`)

  const env = { HOME: user, DSH_HOME: home }
  const launch = async (binary, args, overrides) => {
    const child = spawn(binary, args, { detached: true, stdio: 'ignore', env: { ...env, ...overrides } })
    const exited = once(child, 'exit')
    t.after(async () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      await exited
    })
    await once(child, 'spawn')
    return child.pid
  }
  const fixture = await emptyWorkspace(home)
  const planOptions = { home, workspaceId: fixture.id, targetPath: fixture.work }
  const plan = await planWorkspaceMove({ ...planOptions, appRunning: () => false })
  const workspacePath = () => JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).tables.workspaces.w1.path
  return {
    ...fixture, plan, planOptions, workspacePath, env, executable, hostBinary, entry,
    launchMain: () => launch(executable, [], { NODE_OPTIONS: '--require ' + JSON.stringify(filter), DSH_HOME: undefined }),
    launchFilter: () => launch(executable, [filter], { ELECTRON_RUN_AS_NODE: '1' }),
    launchHost: (options, binary = executable) => launch(binary, [entry], { ELECTRON_RUN_AS_NODE: '1', ...options }),
    async launchApp() {
      const app = await launch(executable, [], { NODE_OPTIONS: '--require ' + JSON.stringify(main) })
      const { host, filter } = await until(() => existsSync(pidsFile) && JSON.parse(readFileSync(pidsFile, 'utf8')))
      const { wait } = dshProcessFacts({ pid: host, ppid: app, execPath: hostBinary, argv: [hostBinary, entry], ipc: true, parentExecutable: executable })
      return { app, host, filter, wait, quit: { kind: 'signal', pid: app } }
    },
  }
}

for (const action of ['move', 'undo']) {
  test(`小进程 ${action} 等已经退出的桌面宿主留下的 MCP 子进程`, macOS, async t => {
    const { home, old, work, plan, workspacePath, launchApp, env, executable } = await scene(t)
    const { moveId } = action === 'undo' ? await applyWorkspaceMove({ home, plan, appRunning: () => false }) : {}
    const { app, host, filter, wait, quit } = await launchApp()
    const { dir, pid } = await startWorkspaceMoveHelper({
      home, plan, action, moveId, wait: { ...wait, timeoutMs: 6000 }, quit, relaunch: quitNone, nodePath: executable, env,
    })
    await until(() => !alive(app) && !alive(host))
    await sleep(750)
    const status = statusOf(dir)
    assert.equal(status?.phase, 'waiting', status?.message)
    assert.equal(alive(filter), true)
    assert.equal(workspacePath(), action === 'undo' ? work : old)
    process.kill(filter, 'SIGTERM')
    const result = await finished(dir)
    assert.equal(result.outcome, action === 'undo' ? 'undone' : 'moved', result.message)
    await until(() => !alive(pid))
    assert.equal(workspacePath(), action === 'undo' ? old : work)
  })
}

test('独立 MCP 进程和另一 DSH_HOME 的宿主仍在运行时，可预览、迁移并撤销', macOS, async t => {
  const { home, old, planOptions, workspacePath, launchHost, launchFilter } = await scene(t)
  const experimentalHome = join(dirname(home), '实验 数据')
  mkdirSync(experimentalHome)
  const host = await launchHost({ DSH_HOME: experimentalHome })
  const filter = await launchFilter()
  const plan = await planWorkspaceMove(planOptions)
  assert.deepEqual(plan.blockers.map(item => item.code), [])
  const { moveId } = await applyWorkspaceMove({ home, plan })
  await undoWorkspaceMove({ home, moveId })
  assert.equal(alive(host), true)
  assert.equal(alive(filter), true)
  assert.equal(workspacePath(), old)
})

test('使用默认数据目录的 App 主进程和独立宿主各自会阻止迁移', macOS, async t => {
  const { planOptions, launchHost, hostBinary, launchMain } = await scene(t)
  const app = await launchMain()
  const blockers = async () => (await planWorkspaceMove(planOptions)).blockers.map(item => item.code)
  assert.deepEqual(await blockers(), ['app-running'])
  process.kill(app, 'SIGTERM')
  await until(() => !alive(app))
  assert.deepEqual(await blockers(), [])
  await launchHost({}, hostBinary)
  assert.deepEqual(await blockers(), ['app-running'])
})

test('桌面宿主留下的进程退出超时，数据不变，仍执行重开', macOS, async t => {
  const { home, old, plan, workspacePath, launchApp, env } = await scene(t)
  const { filter, wait, quit } = await launchApp()
  const marker = join(home, 'relaunched')
  const { dir, pid } = await startWorkspaceMoveHelper({
    home, plan, wait: { ...wait, timeoutMs: 1500 }, quit, env,
    relaunch: { kind: 'command', file: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'up', { flag: 'wx' })", marker], cwd: home },
  })
  const status = await finished(dir)
  assert.deepEqual([status.phase, status.outcome, status.relaunched], ['gave-up', 'not-quit', 'command'])
  await until(() => !alive(pid) && existsSync(marker))
  assert.equal(alive(filter), true)
  assert.equal(workspacePath(), old)
})

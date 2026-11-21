/**
 * 会话迁移（feat#187）的小进程入口：`node workspace-move-helper.mjs <request.json>`，由
 * lib/workspace-move-launch.js 起。按请求请 DSH 退出，等指定的进程都退干净，再按 action 做事：
 * move（默认）是用 App 自己的代码核对一次、搬、核对第二次（不一致就撤回）；recover 是倒回一次做到一半的迁移；
 * undo 是撤回一次做完的迁移。最后按请求重新打开 DSH。每一步都写 status.json：
 *   phase：started → quitting → waiting → moving → relaunching → finished；放弃是 gave-up，出错是 failed。
 *   outcome：moved（搬好了）、not-quit（等不到退出，什么都没改）、blocked（有阻碍，没搬）、stale（预览过期）、
 *            app-cannot-read（搬前 App 就读不了）、check-failed-undone（搬后核对不过，已撤回）、
 *            recovered（倒回了）、undone（撤回了）、refused（迁移写下的东西之后又变过，不倒回也不撤回）、error。
 *   checked：用 App 自己的代码核对过时写，true 是通过，false 是没通过；机器上没有 App、没核对时不写。
 *   quitError：请 DSH 退出没成功时的原因；小进程照常等用户自己退出。
 * 没搬成的时候也照样重新打开 DSH，免得用户面对一个关掉的 App；结果留在 status.json，下次打开时提示。
 */
import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { anotherMoveHelper, relaunchDsh } from './workspace-move-launch.js'
import { compareAppChecks, runAppCheck } from './workspace-move-check.js'
import { desktopTreeRunning } from './workspace-move-processes.js'
import { applyWorkspaceMove, dshAppRunning, planWorkspaceMove, recoverWorkspaceMove, undoWorkspaceMove } from './workspace-move.js'

const execFileAsync = promisify(execFile)
const EXIT_POLL_MS = 250
const requestFile = process.argv[2]
const dir = dirname(requestFile)
const status = { phase: 'started', pid: process.pid }

async function report(changes) {
  Object.assign(status, changes, { updatedAt: new Date().toISOString() })
  process.stdout.write(`${status.updatedAt} ${status.phase}${status.outcome ? ` ${status.outcome}` : ''}\n`)
  const temp = join(dir, `.status.${process.pid}.tmp`)
  await writeFile(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, join(dir, 'status.json'))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const portOpen = port => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port, timeout: EXIT_POLL_MS })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('timeout', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

/** 请 DSH 退出：发信号，或者让桌面 App 自己退（App 有进行中的任务时会先问用户）。 */
async function askToQuit(quit, timeout) {
  if (quit.kind === 'signal') {
    try {
      process.kill(quit.pid, quit.signal ?? 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error // 已经退了
    }
  } else if (quit.kind === 'applescript') {
    await execFileAsync('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(quit.bundleId)} to quit`], { timeout })
  }
}

/** 等进程退出和端口关闭；超时返回 false。 */
async function waitForExit({ ports = [] }, deadline, processesRunning) {
  while (performance.now() < deadline) {
    const exited = !(await processesRunning()) && !(await Promise.all(ports.map(portOpen))).some(Boolean)
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    if (exited) return true
    await sleep(Math.min(EXIT_POLL_MS, remaining))
  }
  return false
}

/** 搬前那次核对：刚退出的 DSH 可能还没放开写锁，读不了就隔一秒再试，最多 20 次。 */
async function checkBeforeMove(request) {
  let last
  for (let attempt = 0; attempt < 20; attempt++) {
    last = await runAppCheck({ home: request.home, appBinary: request.appBinary })
    if (last === undefined || last.ok) return last
    await sleep(1000)
  }
  return last
}

/** 退出以后的操作和重开各有自己的结果。即使状态写盘需要重试，重开命令也只执行一次。 */
let mayRelaunch = false
let relaunchResult
async function reopen(request) {
  if (!mayRelaunch) return {}
  if (relaunchResult === undefined) {
    try {
      relaunchResult = await relaunchDsh(request.relaunch, { dir })
    } catch (error) {
      relaunchResult = { relaunched: `failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return relaunchResult
}

/** 倒回或撤回以后再用 App 的代码核对一次，结果写进 checked（没有 App 时不写）。 */
async function checkAfter(request, result) {
  const after = await runAppCheck({ home: request.home, appBinary: request.appBinary })
  return after === undefined ? result : { ...result, checked: after.ok, ...after.ok ? {} : { checkError: after.error ?? JSON.stringify(after.writeOpen) } }
}

/** 倒回、撤回：迁移写下的东西之后又变过时不动手，结果是 refused；做完了再用 App 的代码核对。 */
async function rollBack(request, operation, done) {
  try {
    await operation({ home: request.home, moveId: request.moveId })
  } catch (error) {
    if (error.code === 'changed-since-move') return { outcome: 'refused', moveId: request.moveId, message: error.message, conflict: error.details?.conflict }
    throw error
  }
  return checkAfter(request, { moveId: request.moveId, ...done })
}

async function run(request) {
  const { wait, quit, home } = request
  const desktop = wait.desktopTree || request.relaunch.kind === 'open-app'
  const treeRunning = desktop && process.platform === 'darwin' ? desktopTreeRunning(wait.pids) : undefined
  const deadline = performance.now() + (wait.timeoutMs ?? 120_000)
  // 请 App 退出前记下子进程；父进程退出后，系统会给存活的子进程换父进程。
  await treeRunning?.()
  if (quit.kind !== 'none') {
    await report({ phase: 'quitting' })
    try {
      await askToQuit(quit, Math.max(1, Math.ceil(deadline - performance.now())))
    } catch (error) {
      // AppleScript 无权退出 App 时，由用户自己退出。
      await report({ quitError: error instanceof Error ? error.message : String(error) })
    }
  }
  await report({ phase: 'waiting' })
  const processesRunning = treeRunning === undefined
    ? () => (wait.pids ?? []).some(alive)
    : async () => await treeRunning() || await dshAppRunning(home)
  if (!(await waitForExit(wait, deadline, processesRunning))) {
    mayRelaunch = desktop
    return { phase: 'gave-up', outcome: 'not-quit', message: 'DSH 没有在限定时间里退出，什么都没改。' }
  }
  mayRelaunch = true
  await report({ phase: 'moving' })
  if (request.action === 'recover') return rollBack(request, recoverWorkspaceMove, { outcome: 'recovered', message: '做到一半的迁移已经倒回原样。' })
  if (request.action === 'undo') return rollBack(request, undoWorkspaceMove, { outcome: 'undone', message: '已经撤回到搬之前的样子。' })
  return move(request)
}

async function move(request) {
  const { plan, home } = request
  const fresh = await planWorkspaceMove({ home, workspaceId: plan.source.workspaceId, targetPath: plan.target.path })
  if (fresh.blockers.length > 0) return { outcome: 'blocked', blockers: fresh.blockers, message: fresh.blockers[0].message }
  const before = await checkBeforeMove(request)
  if (before !== undefined && !before.ok) return { outcome: 'app-cannot-read', checked: false, message: `搬前 App 就读不了这个 DSH_HOME：${before.error ?? JSON.stringify(before.writeOpen)}` }
  let moved
  try {
    moved = await applyWorkspaceMove({ home, plan })
  } catch (error) {
    if (error.code === 'stale-plan') return { outcome: 'stale', message: error.message }
    throw error
  }
  if (before !== undefined) {
    const problem = compareAppChecks(before, await runAppCheck({ home, appBinary: request.appBinary }), plan.sessions.map(item => item.id), plan)
    if (problem !== undefined) {
      await undoWorkspaceMove({ home, moveId: moved.moveId, failedApply: true })
      return { outcome: 'check-failed-undone', checked: false, moveId: moved.moveId, message: `搬后核对不通过，已撤回：${problem}` }
    }
  }
  return { outcome: 'moved', moveId: moved.moveId, ...before === undefined ? {} : { checked: true }, message: `搬好了，${plan.sessions.length} 个会话。` }
}

let request
try {
  request = JSON.parse(await readFile(requestFile, 'utf8'))
  await report({ phase: 'started', requestId: request.requestId })
  if (await anotherMoveHelper(request.home, request.requestId)) {
    await report({ phase: 'finished', outcome: 'blocked', blockers: [{ code: 'busy' }] })
    process.exit(0)
  }
  const result = await run(request)
  if (result.phase === 'gave-up') {
    await report({ ...result, ...await reopen(request) })
  } else {
    await report({ ...result, phase: 'relaunching' })
    await report({ phase: 'finished', ...await reopen(request) })
  }
  process.exit(0)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    const result = status.outcome === undefined ? { outcome: 'error', message } : {}
    await report({ phase: 'failed', ...result, ...await reopen(request) })
  } catch {
    process.stderr.write(`${message}\n`) // 连 status.json 都写不了时只能留在 helper.log
  }
  process.exit(1)
}

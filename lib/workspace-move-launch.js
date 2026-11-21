/**
 * 会话迁移（feat#187）的小进程：DSH 退出以后由它来搬，搬完把 DSH 重新打开。
 * 宿主在 DSH 运行时调 startWorkspaceMoveHelper：把请求写进
 * `$DSH_HOME/dsh-workbench/workspace-moves/requests/<requestId>/request.json`，再起
 * lib/workspace-move-helper.mjs。小进程单独成一个会话和进程组（detached），标准输入输出写进同目录的
 * helper.log，宿主不等它（unref）。这样 DSH 退出、终端里按 Ctrl-C 给整个进程组发信号，都碰不到它；
 * 桌面 App 退出时只对宿主那一个进程发信号，也不清理宿主起的其他进程（依据见
 * docs/research/2026-11-19-会话迁移设计.md 第 10 节）。小进程每走一步都更新同目录的 status.json。
 * 本模块不 import 任何 @deepseek-ai 包。
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { dataPath } from './workspace-move.js'
import { workbenchDataDir } from './data-dir.js'

const execFileAsync = promisify(execFile)
const HELPER = fileURLToPath(new URL('./workspace-move-helper.mjs', import.meta.url))
const TERMINAL = new Set(['finished', 'gave-up', 'failed'])
const isMissing = error => error?.code === 'ENOENT'

/**
 * 请求目录的上一级：`$DSH_HOME/dsh-workbench/workspace-moves/requests`。
 * @param {string} home DSH_HOME。
 * @returns {string} 目录。
 */
export const requestsDir = home => join(workbenchDataDir({ DSH_HOME: home }), 'workspace-moves', 'requests')

/**
 * 写下请求，起小进程。
 * @param {object} options 参数。
 * @param {string} options.home DSH_HOME。
 * @param {'move' | 'recover' | 'undo'} [options.action] 搬（默认）、倒回做到一半的迁移、撤回做完的迁移。
 * @param {object} [options.plan] 搬的时候：用户确认过的预览（planWorkspaceMove 的结果）。
 * @param {string} [options.moveId] 倒回和撤回的时候：迁移记录。
 * @param {{ pids: number[], desktopTree?: boolean, timeoutMs?: number, ports?: number[] }} options.wait 要等退出的进程、是否等待桌面进程树、最多等多久、要等关掉的端口。
 * @param {{ kind: 'none' } | { kind: 'signal', pid: number, signal?: string } | { kind: 'applescript', bundleId: string }} options.quit 怎么请 DSH 退出。
 * @param {{ kind: 'none' } | { kind: 'open-app', app: string } | { kind: 'command', file: string, args: string[], cwd: string }} options.relaunch 搬完怎么重新打开 DSH。
 * @param {string | null} [options.appBinary] App 的可执行文件，用来按 App 的代码核对；没有时不核对。
 * @param {string} [options.nodePath] 跑小进程的 Node（桌面宿主里是 App 自带的那个）。
 * @param {Record<string, string | undefined>} [options.env] 小进程的环境变量；重新打开 DSH 时也用它，所以不写进请求文件。
 * @returns {Promise<{ requestId: string, dir: string, pid: number | undefined }>} 请求。
 */
export async function startWorkspaceMoveHelper({ home, action = 'move', plan, moveId, wait, quit, relaunch, appBinary = null, nodePath = process.execPath, env = process.env }) {
  home = resolve(home)
  const requestId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${randomUUID().slice(0, 8)}`
  const dir = join(requestsDir(home), requestId)
  await dataPath(home, requestsDir(home), true)
  await mkdir(requestsDir(home), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })
  const request = { version: 1, requestId, launcherPid: process.pid, createdAt: new Date().toISOString(), home, action, ...plan === undefined ? {} : { plan }, ...moveId === undefined ? {} : { moveId }, wait, quit, relaunch, appBinary }
  const writeRequest = async fields => {
    const temp = join(dir, '.launch.tmp')
    await writeFile(temp, `${JSON.stringify({ ...request, ...fields }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, join(dir, 'request.json'))
  }
  const log = await open(join(dir, 'helper.log'), 'a', 0o600)
  try {
    await writeRequest({})
    let child
    try {
      child = spawn(nodePath, [HELPER, join(dir, 'request.json')], { cwd: dir, detached: true, stdio: ['ignore', log.fd, log.fd], env })
      await once(child, 'spawn')
    } catch (error) {
      const temp = join(dir, '.failed.tmp')
      await writeFile(temp, JSON.stringify({ phase: 'failed', outcome: 'error', message: error.message }), { mode: 0o600 })
      await rename(temp, join(dir, 'status.json'))
      throw error
    }
    child.unref()
    await writeRequest({ helperPid: child.pid, helperStartedAt: new Date().toISOString() })
    return { requestId, dir, pid: child.pid }
  } finally {
    await log.close()
  }
}

/** Unix 可复用已退出进程的 pid；状态写下后才启动的同号进程不属于这个请求。 */
export async function helperProcessAlive(pid, observedAt) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error.code === 'EPERM'
  }
  const observed = Date.parse(observedAt)
  if (process.platform === 'win32' || !Number.isFinite(observed)) return true
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } })
    const started = Date.parse(stdout.trim())
    return !Number.isFinite(started) || started <= observed
  } catch (error) {
    return error.code !== 1 // ps 查询前已退出，或平台无法核实启动时间。
  }
}

/** 小进程先公布自己的 pid，再检查同一数据目录内已开始的请求。同一时刻至多一个通过检查。 */
export async function anotherMoveHelper(home, ownId) {
  for (const entry of await readdir(requestsDir(home), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ownId) continue
    try {
      const status = JSON.parse(await readFile(join(requestsDir(home), entry.name, 'status.json'), 'utf8'))
      if (!TERMINAL.has(status.phase) && await helperProcessAlive(status.pid, status.updatedAt)) return true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return false
}

/**
 * 需要用户看一眼的请求：放弃了、出错了、没搬成，或者小进程没走完就没了。下次打开 App 时据此提示。
 * @param {string} home DSH_HOME。
 * @returns {Promise<{ requestId: string, phase: string, outcome?: string, message?: string, helperAlive: boolean }[]>} 按 requestId 排序。
 */
export async function pendingWorkspaceMoveRequests(home) {
  let names
  try {
    names = (await readdir(requestsDir(home), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const pending = []
  for (const requestId of names.sort()) {
    let status
    try {
      status = JSON.parse(await readFile(join(requestsDir(home), requestId, 'status.json'), 'utf8'))
    } catch (error) {
      if (!isMissing(error)) throw error
      status = { phase: 'not-started' }
    }
    const helperAlive = status.pid !== undefined && await helperProcessAlive(status.pid, status.updatedAt)
    const done = TERMINAL.has(status.phase)
    if (done && status.outcome === 'moved' && !status.relaunched?.startsWith('failed')) continue
    if (!done && helperAlive) continue
    pending.push({ requestId, phase: status.phase, outcome: status.outcome, message: status.message, helperAlive, ...status.relaunched === undefined ? {} : { relaunched: status.relaunched } })
  }
  return pending
}

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const APP_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING']

/**
 * 用 open -a 重开桌面 App 时交给 open 的环境变量。App 没在运行时，open 把调用方的环境原样交给新开的 App；
 * 桌面宿主的环境里有 ELECTRON_RUN_AS_NODE，带过去 App 会以 Node 方式启动后立刻退出，宿主的其他变量也不该进 App。
 * 所以只留 launchd 平时给 App 的那几项，PATH 换成 launchd 的值。
 * @param {Record<string, string | undefined>} env 调用方的环境变量。
 * @returns {Record<string, string>} 交给 open 的环境变量；调用方没有或为空的项不带。
 */
export function appLaunchEnv(env) {
  const out = { PATH: LAUNCHD_PATH }
  for (const key of APP_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key] !== '') out[key] = env[key]
  }
  return out
}

/**
 * 搬完重新打开 DSH。open-app 用 open -a 打开桌面 App，环境变量只给 appLaunchEnv 留下的几项；command 按原来的命令
 * 重开，带调用方的全部环境变量（web 和无界面的 DSH 可能由 App 自带的 Electron 以 Node 方式运行，要靠它们），
 * 输出写进 dir 下的 relaunch.log；none 什么都不做。
 * @param {{ kind: 'none' } | { kind: 'open-app', app: string } | { kind: 'command', file: string, args: string[], cwd: string }} target 怎么重开。
 * @param {{ dir: string, env?: Record<string, string | undefined> }} options 请求目录、调用方的环境变量（默认 process.env）。
 * @returns {Promise<{ relaunched: string, relaunchedPid?: number }>} 重开的方式；按命令重开时带新进程的 pid。
 */
export async function relaunchDsh(target, { dir, env = process.env }) {
  if (target.kind === 'open-app') {
    await execFileAsync('/usr/bin/open', ['-a', target.app], { env: appLaunchEnv(env) })
  } else if (target.kind === 'command') {
    const log = await open(join(dir, 'relaunch.log'), 'a', 0o600)
    try {
      const child = spawn(target.file, target.args, { cwd: target.cwd, detached: true, stdio: ['ignore', log.fd, log.fd], env })
      await once(child, 'spawn')
      child.unref()
      return { relaunched: target.kind, relaunchedPid: child.pid }
    } finally {
      await log.close()
    }
  }
  return { relaunched: target.kind }
}

const appBundleOf = (path) => {
  if (typeof path !== 'string') return undefined
  const at = path.indexOf('.app/')
  return at === -1 ? undefined : path.slice(0, at + 4)
}

/**
 * 当前这个进程的事实，给 dshProcessFacts 用。父进程的可执行文件用 `ps -o comm=` 取，只取路径。
 * @returns {object} pid、ppid、execPath、execArgv、argv、cwd、ipc（有没有 IPC 通道）、tty（标准输入是不是终端）、parentExecutable。
 */
export function currentProcessFacts() {
  let parentExecutable
  try {
    parentExecutable = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim()
  } catch {
    parentExecutable = undefined // 取不到时按宿主自己的路径找 App
  }
  return { pid: process.pid, ppid: process.ppid, execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, cwd: process.cwd(), ipc: typeof process.send === 'function', tty: Boolean(process.stdin?.isTTY), parentExecutable }
}

/**
 * 判断起小进程的这个 DSH 是哪一种，给出要等哪些进程退出、怎么请它退出、搬完怎么重开：
 * - 桌面 App 的宿主（有 IPC 通道，入口是 dsh-desktop-host/lib/index.js）：等宿主和 App 主进程的进程树；由用户退出 App
 *   （App 有进行中的任务时会先问）；用 open -a 重开 App。
 * - 终端里交互的命令行或 TUI（标准输入是终端）：等它自己；由用户退出；不自动重开，因为没有终端可接。
 * - 其他（web、无界面的服务）：等它自己；给它发 SIGINT，和在终端里按 Ctrl-C 一样；按原来的命令重开。
 * @param {object} [facts] 进程事实，默认取当前进程（currentProcessFacts）。
 * @returns {{ kind: 'desktop' | 'terminal' | 'command', wait: { pids: number[], desktopTree?: boolean }, quit: object, relaunch: object }} 给 startWorkspaceMoveHelper 的参数。
 */
export function dshProcessFacts(facts = currentProcessFacts()) {
  const desktopEntry = facts.argv.some(arg => arg.replaceAll('\\', '/').endsWith('dsh-desktop-host/lib/index.js'))
  if (facts.ipc && desktopEntry) {
    const app = appBundleOf(facts.parentExecutable) ?? appBundleOf(facts.execPath)
    return { kind: 'desktop', wait: { pids: [facts.pid, facts.ppid], desktopTree: true }, quit: { kind: 'none' }, relaunch: app === undefined ? { kind: 'none' } : { kind: 'open-app', app } }
  }
  if (facts.tty) return { kind: 'terminal', wait: { pids: [facts.pid] }, quit: { kind: 'none' }, relaunch: { kind: 'none' } }
  return {
    kind: 'command',
    wait: { pids: [facts.pid] },
    quit: { kind: 'signal', pid: facts.pid, signal: 'SIGINT' },
    relaunch: { kind: 'command', file: facts.execPath, args: [...facts.execArgv, ...facts.argv.slice(1)], cwd: facts.cwd },
  }
}

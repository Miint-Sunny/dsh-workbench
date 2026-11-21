/** macOS 上使用 DSH 数据目录的进程，以及退出时尚未结束的桌面进程。 */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const queryOptions = { env: { LC_ALL: 'en_US.UTF-8' }, timeout: 2000, maxBuffer: 4 * 1024 * 1024 }
const processLine = /^ *(\d+) +(\d+) +(\S+) +(\w+ +\w+ +\d+ +\d\d:\d\d:\d\d +\d{4}) *(.*)$/
const appExecutable = /\.app\/Contents\/MacOS\/DeepSeek Harness$/
const hostEntry = /^(?:--\S+ +)*\/(?:(?! \/).)*?\/dsh-desktop-host\/lib\/index\.js(?: |$)/

async function listProcesses(withCommand = false) {
  const fields = 'pid=,ppid=,stat=,lstart=' + (withCommand ? ',command=' : '')
  const { stdout } = await exec('/bin/ps', ['-ww', '-x', '-U', String(process.getuid()), '-o', fields], queryOptions)
  const processes = stdout.trimEnd().split('\n').flatMap(line => {
    const match = processLine.exec(line)
    if (match === null) return []
    const [, pid, ppid, state, started, command] = match
    return [{ pid: Number(pid), ppid: Number(ppid), zombie: state.startsWith('Z'), started, command }]
  })
  if (!processes.some(({ pid }) => pid === process.pid)) throw new Error('无法读取桌面 App 的进程表。')
  return processes
}

async function psField(pid, field, withEnv = false) {
  try {
    const { stdout } = await exec('/bin/ps', [withEnv ? 'eww' : '-ww', '-p', String(pid), '-o', field + '='], queryOptions)
    return stdout.trimEnd()
  } catch (error) {
    if (error.code === 1) return undefined // 查询前进程已退出。
    // 查询进程环境时，错误对象也可能带着进程的环境变量。
    throw new Error(`无法检查 DSH 进程 ${pid}。`)
  }
}

async function processHome(pid, fields) {
  const value = name => fields.find(field => field.startsWith(name + '='))?.slice(name.length + 1)
  const userHome = value('HOME') || userInfo().homedir
  const configured = value('DSH_HOME')
  if (!configured?.trim()) return join(userHome, '.dsh')
  if (configured === '~') return userHome
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(userHome, configured.slice(2))
  if (isAbsolute(configured)) return configured
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], queryOptions)
    const cwd = /^n(\/.*)$/m.exec(stdout)?.[1]
    if (cwd !== undefined) return join(cwd, configured)
  } catch (error) {
    if (error.code !== 1) throw error
  }
  // 找不到 cwd 时无法排除它正在用目标目录。
  return undefined
}

async function usesHome({ pid, command }, home) {
  const executable = await psField(pid, 'comm')
  if (executable === undefined || (command !== executable && !command.startsWith(executable + ' '))) return false
  const args = command.slice(executable.length).trimStart()
  const fromApp = appExecutable.test(normalize(executable))
  const host = (fromApp || basename(executable) === 'node') && hostEntry.test(args)
  const main = fromApp && (args === '' || args.startsWith('-')) && !/(?:^| )--type(?:[= ]|$)/.test(args)
  if (!host && !main) return false

  const withEnv = await psField(pid, 'command', true)
  if (withEnv === undefined) return false
  const fields = withEnv.startsWith(command + ' ') ? withEnv.slice(command.length + 1).split(/ (?=[A-Za-z_]\w*=)/) : []
  if (!host && fields.includes('ELECTRON_RUN_AS_NODE=1')) return false

  const root = await processHome(pid, fields)
  if (root === undefined) return true
  try {
    return await realpath(root) === home
  } catch (error) {
    if (error.code === 'ENOENT') return false // 这个进程的数据目录和迁移的目录不同。
    throw error
  }
}

/**
 * 检查桌面 App 主进程和桌面宿主是否使用这个数据目录。只读取当前用户的进程。
 * @param {string} home 已经解析的真实目录。
 * @returns {Promise<boolean>} 至少有一个进程仍在使用它。
 */
export async function desktopUsesHome(home) {
  const candidates = (await listProcesses(true)).filter(({ pid, zombie, command }) =>
    pid !== process.pid && !zombie && (command.includes('/MacOS/DeepSeek Harness') || command.includes('/dsh-desktop-host/lib/index.js')))
  return (await Promise.all(candidates.map(proc => usesHome(proc, home)))).some(Boolean)
}

/**
 * 跟踪桌面 App 和宿主的进程树。从请 App 退出前开始查，已经见过的子进程换了父进程也要等。
 * @param {number[]} [pids] App 和宿主的 PID。
 * @returns {() => Promise<boolean>} 还有活进程时返回 true。小进程本身连同它起的进程不参与等待。
 */
export function desktopTreeRunning(pids = []) {
  const tracked = new Map(pids.map(pid => [pid, undefined]))
  return async () => {
    const processes = await listProcesses()
    const children = new Map()
    const pending = []
    for (const proc of processes) {
      if (tracked.has(proc.pid) && (tracked.get(proc.pid) ?? proc.started) === proc.started) pending.push(proc)
      const siblings = children.get(proc.ppid)
      if (siblings === undefined) children.set(proc.ppid, [proc])
      else siblings.push(proc)
    }
    tracked.clear()
    let running = false
    while (pending.length > 0) {
      const proc = pending.pop()
      if (proc.pid === process.pid || tracked.has(proc.pid)) continue
      tracked.set(proc.pid, proc.started)
      if (!proc.zombie) running = true
      pending.push(...(children.get(proc.pid) ?? []))
    }
    return running
  }
}

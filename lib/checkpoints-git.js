/**
 * 检查点（dsh-workbench/checkpoints）的 git 层：定位仓库、把工作树快照成 tree、算两棵树的
 * 差异、把工作树恢复成某棵 tree。做法照官方 dsh-workspace-changes（docs/research/raw/G-检查点-rc1源码核对.md
 * Q2/Q3，含本机试过的还原算法），但官方包的 exports 不放行它的内部模块，只能照写。
 *
 * 每条 git 命令都带 -c 覆盖，把仓库 .git/config 里会执行代码或往 .git 写文件的设置关掉
 * （钩子指向一个自建的空目录、fsmonitor、splitIndex、untrackedCache、gc.auto），所以 git
 * 只动私有 index 和检查点自己的对象目录，工作树只由 unlink 和 checkout-index 写；仓库自己
 * 的 index、HEAD、refs、对象目录一个字节都不变。内容过滤器（.gitattributes 的 filter=，
 * 包括 lfs）没法用 -c 关掉，仓库里有时由调用方改按 files 种类存（hasFilterAttributes），
 * 快照和恢复都不会跑。跑 git 的 spawn / resolveExecutable 由调用方注入（宿主端给
 * ctx.subprocess，测试给包着 node:child_process 的实现），本模块不 import 任何
 * @deepseek-ai 包，`node --test` 直接可跑。
 */
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** git 子进程收到终止信号后的宽限毫秒数（固定生命周期常量，照官方）。 */
const TERMINATE_GRACE_MS = 2_000

/** stderr 最多收多少字节（诊断用，照官方）。 */
const STDERR_TAIL_BYTES = 16 * 1024

/** macOS 上 /usr/bin/git 是 Xcode 桩时探测 xcode-select 的超时毫秒数（卡住的 CLT 不能拖住整条队列）。 */
const XCODE_PROBE_TIMEOUT_MS = 10_000

/**
 * 每条 git 命令都带的 -c 覆盖（第 40 件 #7）：.git/config 里的钩子、fsmonitor、splitIndex、
 * untrackedCache、gc.auto 都会让快照或恢复执行用户仓库里的代码、或往真的 .git 写文件
 * （sharedindex.*、lfs 对象）。hooksPath 必须指一个真实存在的空目录，不能指 /dev/null。
 * @param {string} hooksDir 自建的空目录。
 * @returns {string[]} 逐个插在子命令前面的参数。
 */
const safetyOverrides = hooksDir => [
  '-c', `core.hooksPath=${hooksDir}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.splitIndex=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0',
]

/** 要从继承环境里逐个删掉的 git 变量（照 dsh-experimental-worktree 的名单，G 文档 Q2）。 */
const SCRUBBED_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
]

/**
 * git 子进程的基础环境：不问终端、不拿可选锁、stderr 固定英文（locateWorkspace 靠它认
 * 「not a git repository」）、不读继承来的 config 键值对；再叠上面那份名单的删除。
 * 值为 undefined 表示从净化后的父环境里删掉这一项（subprocess 本地提供方的语义）。
 * @returns {Record<string, string | undefined>} 环境。
 */
export function gitBaseEnv() {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  for (const name of SCRUBBED_VARS) env[name] = undefined
  env.GIT_CONFIG_COUNT = '0'
  return env
}

/**
 * 解析 git 可执行文件；macOS 上 /usr/bin/git 是 Xcode 桩时先跑 xcode-select -p，退出码
 * 不是 0 就当没有 git（照官方 resolveGit）。探测有 10 秒超时（卡住的 CLT 不能让解析永远
 * 挂着，进而拖住会话队列和恢复路由）。
 * @param {{ resolveExecutable: Function, spawn: Function }} subprocess 注入的 subprocess 服务。
 * @param {AbortSignal | undefined} signal 取消。
 * @param {number} [probeTimeoutMs] xcode-select 探测的毫秒数（默认 10 秒；测试注入短的）。
 * @returns {Promise<string | null>} 可执行文件路径；找不到可用的 git 时 null。
 */
export async function resolveGitExecutable(subprocess, signal, probeTimeoutMs = XCODE_PROBE_TIMEOUT_MS) {
  let executable
  try {
    executable = await subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const timeout = AbortSignal.timeout(probeTimeoutMs)
  const probe = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const outcome = await subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'],
    cwd: '/',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 1_000,
    signal: probe,
  }).done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/**
 * 建一个 git 运行器：每条 git 超时（默认 30 秒）、输出有界（默认 8 MiB）、环境净化、每条
 * 命令带 -c 覆盖关掉仓库配置里的钩子和会写 .git 的设置（见文件头）。hooksDir 是调用方
 * 必须给的空目录（服务传数据目录下固定的 `.no-hooks`，建好不删；测试传临时目录）——运行器
 * 自己不在系统临时目录里建，那会在 App 每次启动时留一个没人清的目录。
 * @param {{ spawn: Function }} subprocess 注入的 subprocess 服务。
 * @param {string} executable git 可执行文件路径。
 * @param {{ timeoutMs?: number, outputMaxBytes?: number, hooksDir: string }} limits 限额；hooksDir 必填。
 * @returns {{ run: (args: string[], options: { cwd: string, env?: Record<string, string>, stdin?: string, maxBytes?: number, signal?: AbortSignal }) => Promise<{ exitCode: number, stdout: string, stderr: string, truncated: boolean }> }} 运行器。
 * @throws limits.hooksDir 没给时。
 */
export function createGitRunner(subprocess, executable, limits = {}) {
  if (typeof limits.hooksDir !== 'string' || limits.hooksDir === '') {
    throw new Error('createGitRunner requires limits.hooksDir (an empty directory for core.hooksPath)')
  }
  const timeoutMs = limits.timeoutMs ?? 30_000
  const outputMaxBytes = limits.outputMaxBytes ?? 8 * 1024 * 1024
  return {
    /**
     * 跑一条 `git <args>` 到结束。
     * @param {string[]} args git 参数，不经 shell 解释。
     * @param {{ cwd: string, env?: Record<string, string>, stdin?: string, maxBytes?: number, signal?: AbortSignal }} options 工作目录、附加环境、标准输入、输出上限、取消。
     * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, truncated: boolean }>} 退出码和收到的输出；退出码是不是 0 由调用方判。
     * @throws 工作目录缺失或无效、超时、被取消或起不来时。
     */
    async run(args, options) {
      if (typeof options?.cwd !== 'string' || options.cwd === '') {
        throw new TypeError('createGitRunner.run requires options.cwd (a non-empty working directory string)')
      }
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
      const handle = subprocess.spawn({
        argv: [executable, ...safetyOverrides(limits.hooksDir), ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? outputMaxBytes },
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal,
        env: { ...gitBaseEnv(), ...options.env },
      })
      const outcome = await handle.done
      if (signal.aborted) {
        throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${timeoutMs}ms` : 'was aborted'}`)
      }
      const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
    },
  }
}

/** 退出码不是 0 时带着 stderr 抛错。 */
function ok(result, what) {
  if (result.exitCode !== 0) throw new Error(`${what} failed: ${result.stderr.trim()}`)
  return result
}

/**
 * 符号链接解析后的路径：还不存在的路径按最近的存在祖先解析（照官方 canonicalPath），
 * 这样经过目录符号链接建出来的文件在存在前后是同一种拼法。
 * @param {string} path 绝对路径。
 * @returns {Promise<string>} git 会报的那种规范拼法。
 */
export async function canonicalPath(path) {
  const missing = []
  let head = path
  while (true) {
    try {
      return join(await realpath(head), ...missing)
    } catch {
      const parent = dirname(head)
      if (parent === head || dirname(parent) === parent) return path
      missing.unshift(basename(head))
      head = parent
    }
  }
}

/** 斜杠分隔的相对路径写法。 */
export function toPosix(path) {
  return path.split(sep).join('/')
}

/** path 是不是 root 本身或在 root 之下。 */
export function isInside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 定位会话工作目录所在的仓库，并准备好这一会话私有的对象目录。仓库自己的对象库只读地
 * 挂成 alternate（快照能读提交过的内容、写不进去）；检查点根目录在仓库工作树内时，整个
 * 根从每一次快照里排除——只排除本会话自己的目录会漏掉别的会话的存储，恢复时会被当成
 * 检查点之后新建的文件删掉（第 40 件 #12）。
 * @param {object} runner createGitRunner 的运行器。
 * @param {string} cwd 会话工作目录（绝对路径）。
 * @param {string} sessionDir 这一会话的检查点目录（objects/ 和临时 index 建在它下面）。
 * @param {string} [checkpointsRoot] 检查点根目录（`…/checkpoints`）；缺省用 sessionDir（只排除它自己）。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<{ root: string, gitDir: string, scratch: string, objects: string, env: object, excludes: string[] } | null>} 仓库定位；目录不在任何仓库里时 null。excludes 非空即检查点目录在仓库里。
 * @throws git 失败（不是「不在仓库里」）时。
 */
export async function locateWorkspace(runner, cwd, sessionDir, checkpointsRoot = sessionDir, signal) {
  const found = await runner.run(
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects', '--git-path', 'info/attributes'],
    { cwd, signal },
  )
  if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return null
  const lines = ok(found, 'git rev-parse').stdout.split('\n').map(line => resolve(cwd, line))
  const [root, gitDir, repositoryObjects, infoAttributes] = lines
  const scratch = await canonicalPath(sessionDir)
  const objects = join(scratch, 'objects')
  await mkdir(objects, { recursive: true })
  const rootCanonical = await canonicalPath(root)
  const storeCanonical = await canonicalPath(checkpointsRoot)
  const excludes = isInside(rootCanonical, storeCanonical) ? [toPosix(relative(root, storeCanonical))] : []
  const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects }
  return { root, gitDir, scratch, objects, env, excludes, infoAttributes }
}

/**
 * 把整个工作树快照成 tree：私有 index 先从仓库 index 复制，`add --all --ignore-errors`
 * 之后 `write-tree`。新 blob 和 tree 落进私有对象目录；被忽略的文件不进树，仓库的 index、
 * 对象库、refs 都不动。退出码 1 是「跳过了读不了的文件」，index 仍完整，接受。
 * @param {object} runner 运行器。
 * @param {{ root: string, gitDir: string, scratch: string, env: object, excludes: string[] }} workspace locateWorkspace 的结果。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<string>} tree 对象 id。
 */
export async function snapshotTree(runner, workspace, signal) {
  const scratch = await mkdtemp(join(workspace.scratch, 'index-'))
  try {
    const index = join(scratch, 'index')
    // 还没有 index 的仓库（刚 git init）从空 index 起步。
    await copyFile(join(workspace.gitDir, 'index'), index).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
    const env = { ...workspace.env, GIT_INDEX_FILE: index }
    const pathspec = workspace.excludes.length === 0 ? [] : ['--', '.', ...workspace.excludes.map(path => `:(exclude)${path}`)]
    const added = await runner.run(['add', '--all', '--ignore-errors', ...pathspec], { cwd: workspace.root, env, signal })
    if (added.exitCode !== 1) ok(added, `git add in ${workspace.root}`)
    return ok(await runner.run(['write-tree'], { cwd: workspace.root, env, signal }), 'git write-tree').stdout.trim()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * 解析 `git diff-tree -r -M -z --numstat` 的输出（照官方 parseNumstat）。改名记录带一个
 * 空路径和旧、新两个路径。
 * @param {string} output 完整 stdout。
 * @returns {{ path: string, oldPath?: string, added: number, deleted: number, binary: boolean }[]} 按输出顺序的记录。
 * @throws 记录不完整（多半是输出被截断）时。
 */
export function parseNumstat(output) {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('numstat output is not NUL-terminated')
  queue.pop()
  const entries = []
  while (queue.length > 0) {
    const record = queue.shift()
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) throw new Error(`malformed numstat record: ${record}`)
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    let target = path
    let oldPath
    if (target === '') {
      oldPath = queue.shift()
      const renamed = queue.shift()
      if (oldPath === undefined || renamed === undefined) throw new Error('malformed numstat rename record')
      target = renamed
    }
    const binary = added === '-'
    entries.push({ path: target, ...(oldPath === undefined ? {} : { oldPath }), added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary })
  }
  return entries
}

/**
 * 两棵树每行的行数（带改名识别），方向 from → to。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string} from 起始 tree id。
 * @param {string} to 目标 tree id。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<object[]>} parseNumstat 的记录。
 */
export async function diffNumstat(runner, workspace, from, to, signal) {
  if (from === to) return []
  const result = ok(await runner.run(['diff-tree', '-r', '-M', '-z', '--numstat', from, to], {
    cwd: workspace.root, env: workspace.env, signal,
  }), 'git diff-tree')
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap')
  return parseNumstat(result.stdout)
}

/**
 * 解析 `git diff-tree -r -z --raw --no-renames --no-abbrev` 的输出：`-z` 下每条两段
 * （`:旧模式 新模式 旧sha 新sha 状态` 和路径）。不带改名识别，改名是一条 D 加一条 A。
 * @param {string} output 完整 stdout。
 * @returns {{ path: string, oldMode: string, newMode: string, oldSha: string, newSha: string, status: string }[]} 按输出顺序。
 * @throws 记录不完整时。
 */
export function parseDiffRaw(output) {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('diff-tree --raw output is not NUL-terminated')
  queue.pop()
  const entries = []
  while (queue.length > 0) {
    const meta = queue.shift()
    const path = queue.shift()
    if (path === undefined) throw new Error(`malformed raw record: ${meta}`)
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(meta)
    if (match === null) throw new Error(`malformed raw record: ${meta}`)
    entries.push({ oldMode: match[1], newMode: match[2], oldSha: match[3], newSha: match[4], status: match[5], path })
  }
  return entries
}

/**
 * 两棵树的操作表（`--no-renames`）：状态 D 是 from 有、to 没有（要删）；A、M、T 是要写；
 * 任一边模式是 160000（gitlink，嵌套仓库 / submodule）整条跳过。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string} from 起始 tree id。
 * @param {string} to 目标 tree id。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<object[]>} parseDiffRaw 的记录。
 */
export async function diffRaw(runner, workspace, from, to, signal) {
  if (from === to) return []
  const result = ok(await runner.run(['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', from, to], {
    cwd: workspace.root, env: workspace.env, signal,
  }), 'git diff-tree')
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap')
  return parseDiffRaw(result.stdout)
}

/** 记录是不是 gitlink（任一边模式 160000）。 */
export const isGitlink = entry => entry.oldMode === '160000' || entry.newMode === '160000'

/**
 * 路径里哪些被仓库忽略（跟踪的文件永远不会算被忽略）。退出码 1 是没有被忽略的。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string[]} paths 相对仓库根、`/` 分隔的路径。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<Set<string>>} 被忽略的那些路径。
 */
export async function ignoredPaths(runner, workspace, paths, signal) {
  if (paths.length === 0) return new Set()
  const result = await runner.run(['check-ignore', '-z', '--stdin'], {
    cwd: workspace.root, env: workspace.env, stdin: `${paths.join('\0')}\0`, signal,
  })
  if (result.exitCode === 1) return new Set()
  return new Set(ok(result, 'git check-ignore').stdout.split('\0').filter(path => path !== ''))
}

/**
 * 一棵 tree 还在不在对象库里（会不会被 gc 清掉）。cwd 传仓库根，env 带上私有对象目录和
 * 仓库的 alternate。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string} tree tree 对象 id。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<boolean>} 在时 true。
 */
export async function treeExists(runner, workspace, tree, signal) {
  const result = await runner.run(['cat-file', '-e', `${tree}^{tree}`], { cwd: workspace.root, env: workspace.env, signal })
  return result.exitCode === 0
}

/**
 * 一棵 tree 是不是完整的：树里的每个对象（子树和 blob）都在对象库里。只查最上层会漏掉
 * 被 gc 清掉一半的树——恢复做到一半才发现缺 blob，会留下半成品（第 40 件 #6）。用
 * `rev-list --objects --quiet`（git 自己查连通性的办法）：沿树走到每个子树和 blob，缺一个
 * 就退出非 0。gitlink（子仓库、submodule）指向的提交不归这个对象库管，不跟进；没有输出，
 * 所以不受运行器输出上限影响（列出整棵树的输出会被截断，漏查尾部）。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string} tree tree 对象 id。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<boolean>} 完整时 true（树本身不在也算不完整）。
 * @throws 超时、被取消或 git 起不来时。
 */
export async function treeComplete(runner, workspace, tree, signal) {
  const result = await runner.run(['rev-list', '--objects', '--quiet', tree], {
    cwd: workspace.root, env: workspace.env, signal,
  })
  return result.exitCode === 0
}

/**
 * 按目标树（检查点）的 .gitignore 规则问哪些路径会被忽略。check-ignore 只认工作树里的
 * .gitignore 文件，所以把目标树里的每个 .gitignore 写到临时目录，用 GIT_DIR + GIT_WORK_TREE
 * 指过去问——不碰用户的工作树，预览和恢复得到同一套规则（第 40 件 #13）。
 * @param {object} runner 运行器。
 * @param {{ root: string, gitDir: string, scratch: string, env: object }} workspace 仓库定位。
 * @param {string} targetTree 检查点的 tree 对象 id。
 * @param {string[]} paths 相对仓库根、`/` 分隔的路径。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<Set<string>>} 按检查点的规则被忽略的路径。
 */
export async function ignoredByTree(runner, workspace, targetTree, paths, signal) {
  if (paths.length === 0) return new Set()
  const scratch = await mkdtemp(join(workspace.scratch, 'ignore-'))
  try {
    // 目标树读进临时 index，ls-files 用 glob 只问 .gitignore 文件：ls-tree 不认 glob，列整棵
    // 树的输出会撞运行器的输出上限，尾部的 .gitignore 读不到，规则缺了就会多删被忽略的文件。
    const indexEnv = { ...workspace.env, GIT_INDEX_FILE: join(scratch, 'index') }
    ok(await runner.run(['read-tree', targetTree], { cwd: workspace.root, env: indexEnv, signal }), 'git read-tree')
    const listing = ok(await runner.run(['ls-files', '-z', '--', ':(glob)**/.gitignore'], {
      cwd: workspace.root, env: indexEnv, signal,
    }), 'git ls-files')
    if (listing.truncated) throw new Error('git ls-files output exceeded the configured cap')
    const gitignores = listing.stdout.split('\0').filter(path => path !== '')
    for (const path of gitignores) {
      const content = ok(await runner.run(['show', `${targetTree}:${path}`], {
        cwd: workspace.root, env: workspace.env, signal,
      }), 'git show')
      await mkdir(dirname(join(scratch, path)), { recursive: true })
      await writeFile(join(scratch, path), content.stdout)
    }
    // --no-index：路径在不在用户仓库的 index 里（已跟踪）不影响规则怎么判，只看检查点的规则。
    const result = await runner.run(['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: scratch,
      env: { ...workspace.env, GIT_DIR: workspace.gitDir, GIT_WORK_TREE: scratch },
      stdin: `${paths.join('\0')}\0`,
      signal,
    })
    if (result.exitCode === 1) return new Set()
    return new Set(ok(result, 'git check-ignore').stdout.split('\0').filter(path => path !== ''))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * 算 git 种类的恢复计划（预览和恢复共用同一个，第 40 件 #13）：哪些路径删、哪些写、哪些
 * 跳过。要删的先按检查点的 .gitignore 规则过滤（原本被忽略的文件保留）；写的目标路径现在
 * 是删不干净的目录时跳过（ignored-inside）；gitlink 整条跳过（submodule）。
 * @param {object} runner 运行器。
 * @param {{ root: string, gitDir: string, scratch: string, env: object, excludes: string[] }} workspace 仓库定位。
 * @param {string} nowTree 现在的 tree id。
 * @param {string} targetTree 检查点的 tree id。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<{ raw: object[], deletes: string[], writes: string[], skipped: { path: string, reason: string }[], gitignoreChanged: boolean }>} 计划。
 */
export async function planGit(runner, workspace, nowTree, targetTree, signal) {
  const raw = await diffRaw(runner, workspace, nowTree, targetTree, signal)
  const skipped = raw.filter(isGitlink).map(entry => ({ path: entry.path, reason: 'submodule' }))
  const deletes = raw.filter(entry => !isGitlink(entry) && entry.status === 'D').map(entry => entry.path)
  const ignored = await ignoredByTree(runner, workspace, targetTree, deletes, signal)
  const deleteSet = new Set(deletes.filter(path => !ignored.has(path)))
  const writes = []
  for (const entry of raw) {
    if (isGitlink(entry) || entry.status === 'D') continue
    const absolute = join(workspace.root, entry.path)
    let stat
    try {
      stat = await lstat(absolute)
    } catch {
      stat = undefined
    }
    if (stat?.isDirectory() === true && await dirNotRemovable(absolute, deleteSet, entry.path)) {
      skipped.push({ path: entry.path, reason: 'ignored-inside' })
      continue
    }
    writes.push(entry.path)
  }
  return {
    raw,
    deletes: [...deleteSet].sort(),
    writes: writes.sort(),
    skipped,
    gitignoreChanged: deletes.concat(writes).some(path => path === '.gitignore' || path.endsWith('/.gitignore')),
  }
}

/**
 * 路径列表里有没有 git 会用它改写内容的过滤器（LFS、.gitattributes 的 filter）。
 * `git check-attr -z filter --stdin` 逐个路径问 filter 属性，值不是 unspecified/unset 的算有。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string[]} paths 相对仓库根、`/` 分隔的路径。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<boolean>} 有过滤器时 true。
 */
export async function hasContentFilters(runner, workspace, paths, signal) {
  if (paths.length === 0) return false
  const result = ok(await runner.run(['check-attr', '-z', 'filter', '--stdin'], {
    cwd: workspace.root, env: workspace.env, stdin: `${paths.join('\0')}\0`, signal,
  }), 'git check-attr').stdout
  // -z 输出按「路径、属性名、值」三段一组，NUL 分隔。
  const fields = result.split('\0')
  for (let index = 2; index < fields.length; index += 3) {
    const value = fields[index]
    if (value !== undefined && value !== '' && value !== 'unspecified' && value !== 'unset') return true
  }
  return false
}

/**
 * git 会不会改写换行（第 40 件 #11）：路径上设了 `text`、`eol` 属性，或仓库配了
 * `core.autocrlf`。这些都会让 CRLF 在恢复时悄悄变 LF、核对照样通过，所以 preview 的
 * notes 用 lfs-or-filters 提示（和内容过滤器同一条说明）。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object }} workspace 仓库定位。
 * @param {string[]} paths 相对仓库根、`/` 分隔的路径。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<boolean>} 会改写换行时 true。
 */
export async function hasLineEndingRewrites(runner, workspace, paths, signal) {
  if (paths.length > 0) {
    const result = ok(await runner.run(['check-attr', '-z', 'text', 'eol', '--stdin'], {
      cwd: workspace.root, env: workspace.env, stdin: `${paths.join('\0')}\0`, signal,
    }), 'git check-attr')
    // -z 输出按「路径、属性名、值」三段一组（每个属性一组），NUL 分隔。
    const fields = result.stdout.split('\0')
    for (let index = 2; index < fields.length; index += 3) {
      const value = fields[index]
      if (value !== undefined && value !== '' && value !== 'unspecified' && value !== 'unset') return true
    }
  }
  const autocrlf = await runner.run(['config', 'core.autocrlf'], { cwd: workspace.root, env: workspace.env, signal })
  const value = autocrlf.stdout.trim()
  return autocrlf.exitCode === 0 && (value === 'true' || value === 'input')
}

/**
 * 一行 .gitattributes（或 info/attributes）里有没有设置 filter 属性：token 是 `filter` 或
 * `filter=名字` 算有（会跑 clean/smudge）；`-filter`、`!filter`（unset）不算。只看 git 自己
 * 会据它跑过滤器的写法，注释和别的属性不认。
 * @param {string} line 一行原文（去掉了换行）。
 * @returns {boolean} 设置了 filter 时 true。
 */
function lineSetsFilter(line) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return false
  const tokens = trimmed.split(/\s+/).slice(1)
  return tokens.some(token => token === 'filter' || (/^filter=.+/.test(token) && !token.includes('!')))
}

/**
 * 仓库里有没有内容过滤器（.gitattributes 或 info/attributes 里的 `filter=` 属性，
 * 包括 lfs）。不递归读工作树（每轮开始都跑，大仓库要几百毫秒、还会进 node_modules 这类
 * 被忽略的目录）：只问 git——`ls-files --cached --others --exclude-standard` 加 glob 尊重
 * .gitignore、不进被忽略的目录、一个进程，再逐个读命中的文件（读不到的跳过，比如 index
 * 里有、工作树里删了）。info/attributes 的路径由 locateWorkspace 用 `--git-path` 解析好
 * （链接 worktree 时指到主仓库的公共目录，不是 .git/worktrees/x 下）。
 * @param {object} runner 运行器。
 * @param {{ root: string, env: object, infoAttributes: string }} workspace locateWorkspace 的结果。
 * @param {AbortSignal | undefined} signal 取消。
 * @returns {Promise<boolean>} 有 filter= 属性时 true。
 */
export async function hasFilterAttributes(runner, workspace, signal) {
  const listed = await runner.run(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.gitattributes'],
    { cwd: workspace.root, env: workspace.env, signal },
  )
  const paths = ok(listed, 'git ls-files').stdout.split('\0').filter(path => path !== '')
  for (const path of paths) {
    let text
    try {
      text = await readFile(join(workspace.root, path), 'utf8')
    } catch {
      continue
    }
    if (text.split('\n').some(line => lineSetsFilter(line))) return true
  }
  try {
    const info = await readFile(workspace.infoAttributes, 'utf8')
    return info.split('\n').some(line => lineSetsFilter(line))
  } catch {
    return false
  }
}

/** 删一个文件或符号链接，不在了就算了。 */
async function removeFile(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * 删完一个文件后沿父目录向上删空目录，遇到非空目录或仓库根就停。keep 里的目录（会话
 * 工作目录和它的祖先）绝不删——清掉会话正开着的目录，之后的文件工具全写不进（第 40 件 #10）。
 * @param {string} root 仓库根。
 * @param {string} path 刚删掉的文件的绝对路径。
 * @param {Set<string>} [keep] 不删的绝对目录。
 */
async function pruneEmptyDirs(root, path, keep) {
  let dir = dirname(path)
  while (true) {
    if (dir === root || dir === dirname(dir)) return
    if (keep?.has(dir) === true) return
    try {
      await rmdir(dir)
    } catch {
      // 目录不空（或还有别的条目）：到这里为止。
      return
    }
    dir = dirname(dir)
  }
}

/**
 * 一个要写成文件的路径现在是不是个删不干净的目录：目录里每个条目都要么本身在待删列表
 * 里、要么是个最终能删空的子目录，否则 rmdir 会失败（典型是里面只剩被忽略的文件）。
 * 恢复和预览都用它（预览是静态判断，恢复是 rmdir 失败后再核对）。
 * @param {string} absolute 相对仓库根拼好的绝对路径。
 * @param {Set<string>} deletes 待删路径（`/` 分隔，相对仓库根）。
 * @param {string} [prefix] 递归时用的当前相对路径。
 * @returns {Promise<boolean>} 删不干净（应跳过、记 ignored-inside）时 true。
 */
export async function dirNotRemovable(absolute, deletes, prefix = '') {
  let entries
  try {
    entries = await readdir(absolute)
  } catch {
    // 读不了就当删不干净，交给恢复后的核对兜底。
    return true
  }
  for (const name of entries) {
    const child = join(absolute, name)
    const childPath = prefix === '' ? name : `${prefix}/${name}`
    let stat
    try {
      stat = await lstat(child)
    } catch {
      return true
    }
    if (stat.isDirectory()) {
      if (await dirNotRemovable(child, deletes, childPath)) return true
    } else if (!deletes.has(childPath)) {
      return true
    }
  }
  return false
}

/**
 * 把工作树恢复成 targetTree：先快照得现在的树，用 planGit 算计划（预览用同一个计划），
 * 先删后写，写用私有 index 里 read-tree 加 checkout-index；keepDirs 里的目录（会话工作
 * 目录和祖先）删空了也不清掉；做到一半失败时把已经动过的路径挂在 error.changedPaths 再
 * 抛出（调用方写进回答）；最后再快照核对，仍有差别的路径记 changed-after，核对得到的
 * afterTree 一并返回（撤销的过期判断用）。仓库自己的 index、HEAD、refs、对象目录不动。
 * @param {object} runner 运行器。
 * @param {{ root: string, gitDir: string, env: object, excludes: string[] }} workspace locateWorkspace 的结果。
 * @param {string} targetTree 要恢复成的 tree id。
 * @param {{ nowTree?: string, plan?: object, keepDirs?: Set<string>, signal?: AbortSignal }} [options] nowTree 传进来就不再快照一次（恢复前检查点已快照过）；plan 传进来就不重算（预览算过的重用）。
 * @returns {Promise<{ nowTree: string, afterTree: string, restored: number, skipped: { path: string, reason: string }[] }>} 现在的树、恢复后的树、写回加删除的文件数、没恢复的路径和原因。
 * @throws 做到一半失败时；error.changedPaths 是已经动过的路径。
 */
export async function restoreTree(runner, workspace, targetTree, options = {}) {
  const { signal } = options
  const nowTree = options.nowTree ?? await snapshotTree(runner, workspace, signal)
  const plan = options.plan ?? await planGit(runner, workspace, nowTree, targetTree, signal)
  const skipped = [...plan.skipped]
  const changed = []

  const scratch = await mkdtemp(join(workspace.scratch, 'restore-'))
  const restoreEnv = { ...workspace.env, GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    ok(await runner.run(['read-tree', targetTree], { cwd: workspace.root, env: restoreEnv, signal }), 'git read-tree')

    // 删除阶段：先删后写，才能还原目录与文件互换。
    for (const path of plan.deletes) {
      await removeFile(join(workspace.root, path))
      changed.push(path)
      await pruneEmptyDirs(workspace.root, join(workspace.root, path), options.keepDirs)
    }

    // 写阶段：目标路径现在是目录的，计划已经核过能删空，删掉再写（绝不能交给
    // checkout-index -f，它会把目录连同里面被忽略的文件一起删掉再建同名文件）。
    const writable = []
    for (const path of plan.writes) {
      const absolute = join(workspace.root, path)
      let stat
      try {
        stat = await lstat(absolute)
      } catch {
        stat = undefined
      }
      if (stat?.isDirectory()) await rmdir(absolute)
      writable.push(path)
    }
    if (writable.length > 0) {
      ok(await runner.run(['checkout-index', '-f', '-z', '--stdin'], {
        cwd: workspace.root, env: restoreEnv, stdin: `${writable.join('\0')}\0`, signal,
      }), 'git checkout-index')
      changed.push(...writable)
    }
  } catch (error) {
    // 做到一半失败：已经动过的路径带上再抛，调用方写进回答、撤销点留在盘上。
    error.changedPaths = changed
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  // 核对：再快照一次，目标树里没有的路径如果还在（或反之），记 changed-after 兜底。
  const afterTree = await snapshotTree(runner, workspace, signal)
  if (afterTree !== targetTree) {
    const remaining = await diffRaw(runner, workspace, afterTree, targetTree, signal)
    const reported = new Set(skipped.map(item => item.path))
    for (const entry of remaining) {
      if (!reported.has(entry.path)) skipped.push({ path: entry.path, reason: 'changed-after' })
    }
  }
  const restored = changed.length
  return { nowTree, afterTree, restored, skipped }
}

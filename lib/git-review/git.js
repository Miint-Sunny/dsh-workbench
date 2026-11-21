/**
 * 审阅面板的 Git 安全执行与路径检查层：
 * - 复用 checkpoints-git.js 的 resolveGitExecutable、createGitRunner（空目录 hooksPath）和 gitBaseEnv；
 * - 所有常规 Git 调用强制 GIT_LITERAL_PATHSPECS=1 与 core.quotePath=false；
 * - 读差异关闭 ext-diff、textconv，并按仓库配置把 filter.*.clean/smudge/process/required 置空；
 * - 仅 commit 单独经 subprocess.spawn 调用，不覆盖 core.hooksPath，让仓库钩子照常执行；
 * - 路径严格校验相对路径且逐段核对符号链接不逃逸出仓库根目录。
 */
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  createGitRunner,
  gitBaseEnv,
  resolveGitExecutable,
} from '../checkpoints-git.js'

const COMMIT_TERMINATE_GRACE_MS = 2_000
const COMMIT_OUTPUT_MAX_BYTES = 64 * 1024

/**
 * 校验仓库内相对路径写法：拒绝空串、绝对路径、盘符、反斜杠、控制字符以及 `.`、`..` 段。
 * @param {unknown} path 待校验路径。
 * @returns {boolean} 合法相对路径为 true。
 */
export function safeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false
  if (/[\x00-\x1f\x7f\\\ufffd]/.test(path)) return false
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return !path.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || /^(?:\.git|git~1)[. ]*$/i.test(segment))
}

/**
 * 核对相对路径的父目录段不经过符号链接且落在仓库根目录之内；可选是否同时拒绝指向仓库外的末端符号链接。
 * @param {string} repoRoot 仓库根目录绝对路径。
 * @param {string} relPath 仓库内相对路径。
 * @param {{ allowEscapingLeafSymlink?: boolean }} [options] 选项。
 * @returns {Promise<{ canonicalRoot: string, absolutePath: string, leafEscapes?: boolean }>} 解析后的根路径与目标绝对路径。
 */
export async function assertPathInsideRepo(repoRoot, relPath, { allowEscapingLeafSymlink = false } = {}) {
  if (!safeRelativePath(relPath)) {
    throw Object.assign(new Error('invalid repository relative path'), { code: 'bad-path' })
  }
  const canonicalRoot = await realpath(repoRoot)
  const segments = relPath.split('/')
  let current = canonicalRoot
  let leafEscapes = false

  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i])
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // 缺失路径的后续段仍在当前规范父目录之下，不会逃逸。
        break
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      if (i < segments.length - 1) {
        throw Object.assign(new Error('path traverses symbolic link directory'), { code: 'bad-path' })
      }
      const target = await realpath(current).catch(error => {
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null
        throw error
      })
      const rel = target === null ? null : relative(canonicalRoot, target).split(sep).join('/')
      if (rel !== '' && !safeRelativePath(rel)) {
        if (!allowEscapingLeafSymlink) {
          throw Object.assign(new Error('symlink target cannot be verified inside repository'), { code: 'bad-path' })
        }
        leafEscapes = true
      }
    } else if (i < segments.length - 1 && !info.isDirectory()) {
      throw Object.assign(new Error('parent path segment is not a directory'), { code: 'bad-path' })
    }
  }

  const absolutePath = resolve(canonicalRoot, relPath)
  if (!safeRelativePath(relative(canonicalRoot, absolutePath).split(sep).join('/'))) {
    throw Object.assign(new Error('path escapes repository root'), { code: 'bad-path' })
  }
  return { canonicalRoot, absolutePath, leafEscapes }
}

/**
 * 创建 Git 审阅面板专用执行器。
 * @param {{ subprocess: { resolveExecutable: Function, spawn: Function }, dataDir: string, timeoutMs: number, maxDiffBytes: number }} options 参数。
 * @returns {object} Git 执行器。
 */
export function createGitReviewGit({ subprocess, dataDir, timeoutMs, maxDiffBytes }) {
  const hooksDir = join(dataDir, '.no-hooks')
  let executableCache
  let runnerCache

  async function resolveExecutable(signal) {
    if (executableCache !== undefined) return executableCache
    const pending = resolveGitExecutable(subprocess, signal)
    const exe = await pending
    if (exe !== null) executableCache = exe
    return exe
  }

  async function getRunner(signal) {
    const exe = await resolveExecutable(signal)
    if (exe === null) return null
    if (!runnerCache) await mkdir(hooksDir, { recursive: true, mode: 0o700 })
    if (!(await lstat(hooksDir)).isDirectory() || (await readdir(hooksDir)).length !== 0) {
      throw Object.assign(new Error('Git 审阅的空钩子目录无效'), { code: 'bad-path' })
    }
    runnerCache ??= createGitRunner(subprocess, exe, {
      hooksDir,
      timeoutMs,
      outputMaxBytes: Math.max(maxDiffBytes + 65536, 8 * 1024 * 1024),
    })
    return runnerCache
  }

  /** 查询仓库配置的 filter 驱动，生成将其全部置空的 `-c` 参数。 */
  async function filterOverrides(cwd, signal) {
    const res = await run(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { signal })
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`git config filter query failed: ${res.stderr.trim()}`)
    }
    if (!res.stdout) return []
    const drivers = [...new Set(
      res.stdout
        .split('\0')
        .filter(Boolean)
        .map(key => key.replace(/\.(clean|smudge|process|required)$/, '')),
    )]
    return drivers.flatMap(key => [
      '-c', `${key}.clean=`,
      '-c', `${key}.smudge=`,
      '-c', `${key}.process=`,
      '-c', `${key}.required=false`,
    ])
  }

  /** 运行带空 hooks 目录、GIT_LITERAL_PATHSPECS=1 与 quotePath=false 的常规 Git 命令。 */
  async function run(cwd, args, options = {}) {
    const runner = await getRunner(options.signal)
    if (runner === null) {
      throw Object.assign(new Error('Git executable is unavailable'), { code: 'git-unavailable' })
    }
    const result = await runner.run(['-c', 'core.quotePath=false', ...args], {
      ...options,
      cwd,
      env: { ...options.env, GIT_LITERAL_PATHSPECS: '1' },
    })
    if (result.truncated && options.maxBytes === undefined) {
      throw Object.assign(new Error('Git output exceeded the configured limit'), { code: 'too-large' })
    }
    return result
  }

  /** 运行禁用了所有内容过滤器的只读命令（如 status、diff-files、diff-index）。 */
  async function runRead(cwd, args, options = {}) {
    const overrides = await filterOverrides(cwd, options.signal)
    return run(cwd, [...overrides, ...args], options)
  }

  /** 运行禁用内容过滤器及外部 diff 驱动的差异命令。 */
  async function runDiff(cwd, args, options = {}) {
    const overrides = await filterOverrides(cwd, options.signal)
    return run(cwd, [
      ...overrides,
      '-c', 'diff.noprefix=false',
      '-c', 'diff.mnemonicPrefix=false',
      args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1),
    ], options)
  }

  /**
   * 单独执行 `git commit`：不覆盖 `core.hooksPath`，让仓库配置的提交钩子照常执行。
   * @param {string} cwd 仓库目录。
   * @param {string} message 提交信息正文。
   * @param {{ signal?: AbortSignal }} [options] 取消信号。
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>} 执行结果。
   */
  async function runCommit(cwd, message, options = {}) {
    const exe = await resolveExecutable(options.signal)
    if (exe === null) {
      throw Object.assign(new Error('Git executable is unavailable'), { code: 'git-unavailable' })
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const handle = subprocess.spawn({
      argv: [exe, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', 'commit', '--cleanup=whitespace', '-F', '-'],
      cwd,
      stdio: {
        stdin: { data: message },
        stdout: { maxBytes: COMMIT_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: COMMIT_OUTPUT_MAX_BYTES },
      },
      graceMs: COMMIT_TERMINATE_GRACE_MS,
      signal,
      env: { ...gitBaseEnv(), GIT_LITERAL_PATHSPECS: '1' },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error(`git commit ${timeout.aborted ? `timed out after ${timeoutMs}ms` : 'was aborted'}`)
    }
    return {
      exitCode: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0)?.text ?? '',
      stderr: handle.collected.stderr?.readFrom(0)?.text ?? '',
    }
  }

  /** 检查 gitDir 下是否存在 `index.lock`。 */
  async function isIndexLocked(gitDir) {
    try {
      await lstat(join(gitDir, 'index.lock'))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /** 解析当前仓库对象格式下的空树 OID（兼容 SHA-1 与 SHA-256 仓库）。 */
  async function emptyTreeOid(cwd, signal) {
    const res = await run(cwd, ['mktree'], { cwd, stdin: '', signal })
    if (res.exitCode !== 0) {
      throw new Error(`git mktree failed: ${res.stderr.trim()}`)
    }
    return res.stdout.trim()
  }

  return {
    hooksDir,
    hasGit: async (signal) => (await resolveExecutable(signal)) !== null,
    run,
    runRead,
    runDiff,
    runCommit,
    isIndexLocked,
    emptyTreeOid,
  }
}

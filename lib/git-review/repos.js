/**
 * 审阅面板的多仓库发现、仓库状态解析、分支列表与基准解析、以及同一提交链检查。
 */
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdtemp, open, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const repoIdFor = canonicalPath => createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

/** 给重名目录补上一级父目录名称以消歧。 */
function assignDisplayNames(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const base = basename(entry.root) || entry.root
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return entries.map((entry) => {
    const base = basename(entry.root) || entry.root
    if ((counts.get(base) ?? 0) <= 1) return { ...entry, name: base }
    const parent = basename(dirname(entry.root))
    return { ...entry, name: parent ? `${parent}/${base}` : base }
  })
}

const badRepoPath = () => Object.assign(new Error('Git metadata does not match the session worktree'), { code: 'bad-path' })

async function linkedWorktreeOwner(gitDir) {
  const file = await open(join(gitDir, 'gitdir'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error.code === 'ENOENT') return null
    throw badRepoPath()
  })
  if (!file) return null
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 65536) throw badRepoPath()
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await file.read(bytes)
    if (bytesRead !== bytes.length) throw badRepoPath()
    return resolve(gitDir, bytes.toString().replace(/\n$/, ''))
  } finally {
    await file.close()
  }
}

async function verifyGitDirectory(git, root, gitDir, signal) {
  if (gitDir !== join(root, '.git')) {
    // Linked worktrees and submodules identify their worktree separately from the common repository.
    const owner = await linkedWorktreeOwner(gitDir)
    if (owner !== null && owner !== join(root, '.git')) throw badRepoPath()
    if (owner === null) {
      const cfg = await git.run(gitDir, ['config', '--local', '--get', 'core.worktree'], { signal })
      const declared = cfg.stdout.replace(/\n$/, '')
      if (cfg.exitCode !== 0 || !declared || await realpath(resolve(gitDir, declared)).catch(() => null) !== root) {
        throw badRepoPath()
      }
    }
  }
  const index = await lstat(join(gitDir, 'index')).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (index && !index.isFile()) throw badRepoPath()
}

/**
 * 从会话关联的文件夹列表中发现 Git 仓库与非 Git 目录，按规范根目录去重。
 * @param {object} git Git 执行器。
 * @param {string[]} folders 文件夹绝对路径列表。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{ id: string, name: string, kind: 'git' | 'not-git', root: string, gitDir?: string }[]>} 仓库列表。
 */
export async function discoverRepos(git, folders, signal) {
  const seen = new Set()
  const repos = []
  if (!await git.hasGit(signal)) throw Object.assign(new Error('Git executable unavailable'), { code: 'git-unavailable' })

  for (const rawFolder of folders) {
    if (typeof rawFolder !== 'string' || rawFolder === '') continue
    let canonicalDir
    try {
      canonicalDir = await realpath(rawFolder)
      if (!(await stat(canonicalDir)).isDirectory()) continue
    } catch {
      continue
    }

    const probe = await git.run(canonicalDir, ['rev-parse', '--show-toplevel'], { signal })
    if (probe.exitCode === 0) {
      const meta = await git.run(canonicalDir, ['rev-parse', '--absolute-git-dir'], { signal })
      if (meta.exitCode !== 0) throw new Error('could not resolve Git directory')
      const canonicalTop = await realpath(probe.stdout.replace(/\n$/, ''))
      const canonicalGitDir = await realpath(meta.stdout.replace(/\n$/, ''))
      const folderPath = relative(canonicalTop, canonicalDir)
      if (folderPath === '..' || folderPath.startsWith('..' + sep) || isAbsolute(folderPath)) {
        throw Object.assign(new Error('worktree does not contain the session folder'), { code: 'bad-path' })
      }
      if (!seen.has(canonicalTop)) {
        await verifyGitDirectory(git, canonicalTop, canonicalGitDir, signal)
        seen.add(canonicalTop)
        repos.push({
          id: repoIdFor(canonicalTop),
          kind: 'git',
          root: canonicalTop,
          gitDir: canonicalGitDir,
        })
      }
      continue
    }

    if (!seen.has(canonicalDir)) {
      seen.add(canonicalDir)
      repos.push({
        id: repoIdFor(canonicalDir),
        kind: 'not-git',
        root: canonicalDir,
      })
    }
  }

  return assignDisplayNames(repos)
}

/** 解析 `git status --porcelain=v2 --branch -z --untracked-files=all` 输出。 */
export function parsePorcelainV2(stdout) {
  const tokens = stdout.split('\0')
  if (tokens.at(-1) === '') tokens.pop()

  let head = null
  let branch = null
  let detached = false
  let upstream = null
  let ahead = 0
  let behind = 0
  let hasAb = false
  let unstaged = 0
  let staged = 0
  let bothXY = false
  const unmergedPaths = []
  const untrackedPaths = []
  const trackedEntries = []

  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]
    if (line.startsWith('# ')) {
      if (line.startsWith('# branch.oid ')) {
        const oid = line.slice('# branch.oid '.length).trim()
        head = oid === '(initial)' ? null : oid.slice(0, 7)
      } else if (line.startsWith('# branch.head ')) {
        const name = line.slice('# branch.head '.length).trim()
        if (name === '(detached)') {
          detached = true
          branch = null
        } else {
          detached = false
          branch = name
        }
      } else if (line.startsWith('# branch.upstream ')) {
        upstream = line.slice('# branch.upstream '.length).trim() || null
      } else if (line.startsWith('# branch.ab ')) {
        hasAb = true
        const match = /^\+(\d+) -(\d+)$/.exec(line.slice('# branch.ab '.length).trim())
        if (match) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }

    if (line.startsWith('1 ')) {
      const xy = line.slice(2, 4)
      const path = line.split(' ').slice(8).join(' ')
      if (xy[0] !== '.') staged++
      if (xy[1] !== '.') unstaged++
      if (xy[0] !== '.' && xy[1] !== '.') bothXY = true
      trackedEntries.push({ xy, path })
    } else if (line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      const path = line.split(' ').slice(9).join(' ')
      const oldPath = tokens[++i]
      if (xy[0] !== '.') staged++
      if (xy[1] !== '.') unstaged++
      if (xy[0] !== '.' && xy[1] !== '.') bothXY = true
      trackedEntries.push({ xy, path, oldPath })
    } else if (line.startsWith('u ')) {
      const path = line.split(' ').slice(10).join(' ')
      unmergedPaths.push(path)
    } else if (line.startsWith('? ')) {
      const path = line.slice(2)
      untrackedPaths.push(path)
      unstaged++
    }
  }

  return {
    branch,
    head,
    detached,
    upstream,
    remoteBranchMissing: !detached && (!upstream || !hasAb),
    ahead,
    behind,
    conflicts: unmergedPaths.length,
    unmergedPaths,
    untrackedPaths,
    trackedEntries,
    unstaged,
    staged,
    bothXY,
    rawLength: stdout.length,
  }
}

/** 工作区重新出现的已取消跟踪路径，按基准树比较；临时 index 保留其它暂存项。 */
export async function runComparisonDiff(git, repo, tree, restoredPaths, args, options) {
  if (restoredPaths.length === 0) return git.runDiff(repo.root, args, options)
  const scratch = await mkdtemp(join(tmpdir(), 'dwb-gr-index-'))
  try {
    const index = join(scratch, 'index')
    try {
      await copyFile(join(repo.gitDir, 'index'), index)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const env = { GIT_INDEX_FILE: index }
    const reset = await git.runRead(repo.root, ['reset', '-q', tree, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env, stdin: restoredPaths.join('\0') + '\0', signal: options.signal,
    })
    if (reset.exitCode !== 0) throw new Error('could not prepare worktree comparison')
    return await git.runDiff(repo.root, args, { ...options, env })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * 采集单个仓库的实时状态、计数与冲突路径集合。
 * @param {object} git Git 执行器。
 * @param {{ id: string, name: string, kind: 'git' | 'not-git', root: string, gitDir?: string }} repo 仓库信息。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<object>} 第 8 节 status 中的仓库条目及内部辅助信息。
 */
export async function inspectRepoStatus(git, repo, signal) {
  if (repo.kind === 'not-git') {
    return {
      id: repo.id,
      name: repo.name,
      kind: 'not-git',
      root: repo.root,
      branch: null,
      head: null,
      detached: false,
      upstream: null,
      remoteBranchMissing: false,
      ahead: 0,
      behind: 0,
      conflicts: 0,
      counts: { unstaged: 0, staged: 0, uncommitted: 0 },
    }
  }

  const res = await git.runRead(repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { signal })
  if (res.exitCode !== 0) {
    throw new Error(`git status failed: ${res.stderr.trim()}`)
  }
  const parsed = parsePorcelainV2(res.stdout)

  let uncommittedTrackedCount = parsed.trackedEntries.length
  // 如果存在同时改动暂存区与工作区的文件（可能互相抵消回 HEAD），用 HEAD diff 精确核对文件数。
  const untracked = new Set(parsed.untrackedPaths)
  const recreated = parsed.trackedEntries.flatMap(e => e.oldPath ?? (e.xy.startsWith('D') ? e.path : []))
    .filter(path => untracked.has(path))
  if (parsed.bothXY || recreated.length) {
    const baseTree = parsed.head === null ? await git.emptyTreeOid(repo.root, signal) : 'HEAD'
    const diffNames = await runComparisonDiff(git, repo, baseTree, recreated, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseTree, '--'], { signal })
    if (diffNames.exitCode === 0) {
      const trackedSet = new Set(diffNames.stdout.split('\0').filter(Boolean))
      for (const conflictPath of parsed.unmergedPaths) trackedSet.delete(conflictPath)
      uncommittedTrackedCount = trackedSet.size
    }
  }

  const uncommitted = uncommittedTrackedCount + parsed.untrackedPaths.length - recreated.length + parsed.unmergedPaths.length

  return {
    id: repo.id,
    name: repo.name,
    kind: 'git',
    root: repo.root,
    branch: parsed.branch,
    head: parsed.head,
    detached: parsed.detached,
    upstream: parsed.upstream,
    remoteBranchMissing: parsed.remoteBranchMissing,
    ahead: parsed.ahead,
    behind: parsed.behind,
    conflicts: parsed.conflicts,
    counts: {
      unstaged: parsed.unstaged + parsed.unmergedPaths.length,
      staged: parsed.staged,
      uncommitted,
    },
    _internal: {
      statusRaw: res.stdout,
      unmergedPaths: parsed.unmergedPaths,
      untrackedPaths: parsed.untrackedPaths,
    },
  }
}

/**
 * 列出本地分支、远程分支（排除 `STAR/HEAD` 符号引用），并按设计说明第 2 节计算默认基准分支。
 * @param {object} git Git 执行器。
 * @param {{ root: string }} repo 仓库信息。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{ defaultBase: string | null, local: string[], remote: string[] }>} 分支清单。
 */
export async function listBranches(git, repo, signal) {
  const res = await git.run(repo.root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { signal })
  if (res.exitCode !== 0) {
    throw new Error(`git for-each-ref failed: ${res.stderr.trim()}`)
  }
  const local = []
  const remote = []
  for (const ref of res.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) {
      local.push(ref.slice('refs/heads/'.length))
    } else if (ref.startsWith('refs/remotes/')) {
      const short = ref.slice('refs/remotes/'.length)
      if (!short.endsWith('/HEAD')) remote.push(short)
    }
  }

  let defaultBase = null
  const sym = await git.run(repo.root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { signal })
  if (sym.exitCode === 0) {
    const target = sym.stdout.trim()
    const remoteName = target.startsWith('refs/remotes/') ? target.slice('refs/remotes/'.length) : target
    if (remote.includes(remoteName)) defaultBase = remoteName
    else if (remoteName.startsWith('origin/') && local.includes(remoteName.slice('origin/'.length))) {
      defaultBase = remoteName.slice('origin/'.length)
    }
  }
  if (defaultBase === null) {
    if (local.includes('main')) defaultBase = 'main'
    else if (local.includes('master')) defaultBase = 'master'
  }

  return { defaultBase, local, remote }
}

/**
 * 按已知本地/远程分支集合安全解析基准分支全名（refs/heads/... 或 refs/remotes/...），拒绝任意 rev 表达式。
 * @param {object} git Git 执行器。
 * @param {{ root: string }} repo 仓库信息。
 * @param {string | undefined} baseName 用户选中的基准分支；省略时使用 defaultBase。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{ name: string, ref: string } | null>} 解析后的基准；找不到或空仓库时 null。
 */
export async function resolveBaseRef(git, repo, baseName, signal) {
  const list = await listBranches(git, repo, signal)
  const target = baseName && baseName.trim() !== '' ? baseName.trim() : list.defaultBase
  if (!target || target.startsWith('-')) return null
  if (list.local.includes(target)) return { name: target, ref: `refs/heads/${target}` }
  if (list.remote.includes(target)) return { name: target, ref: `refs/remotes/${target}` }
  return null
}

/**
 * 列出基准之后分支上的提交，受 maxCommits 上限控制。
 * @param {object} git Git 执行器。
 * @param {{ root: string }} repo 仓库信息。
 * @param {string | undefined} baseName 基准分支。
 * @param {number} maxCommits 最大返回条数。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{ ok: true, commits: object[], truncated: boolean } | { ok: false, code: string, status: number }>} 提交清单。
 */
export async function listCommits(git, repo, baseName, maxCommits, signal) {
  const headRes = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal })
  if (headRes.exitCode !== 0) {
    return { ok: true, commits: [], truncated: false }
  }
  const base = await resolveBaseRef(git, repo, baseName, signal)
  if (base === null) {
    return { ok: false, status: 404, code: 'not-found' }
  }
  const mb = await git.run(repo.root, ['merge-base', base.ref, 'HEAD'], { signal })
  const range = mb.exitCode === 0 ? `${mb.stdout.trim()}..HEAD` : 'HEAD'

  const logRes = await git.run(
    repo.root,
    ['log', `--max-count=${maxCommits + 1}`, '--format=%H%x1f%h%x1f%s%x1f%cI%x1e', range],
    { signal },
  )
  if (logRes.exitCode !== 0) {
    throw new Error(`git log failed: ${logRes.stderr.trim()}`)
  }

  const rows = logRes.stdout
    .split('\x1e')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, short, subject, time] = chunk.split('\x1f')
      return { sha, short, subject, time }
    })

  const truncated = rows.length > maxCommits
  return {
    ok: true,
    commits: truncated ? rows.slice(0, maxCommits) : rows,
    truncated,
  }
}

/** 判断 older 是否严格落在 newer 的第一父链上。 */
async function onFirstParentChain(git, repoRoot, older, newer, signal) {
  const anc = await git.run(repoRoot, ['merge-base', '--is-ancestor', older, newer], { signal })
  if (anc.exitCode !== 0) return false
  const walk = await git.run(repoRoot, ['rev-list', '--first-parent', '--parents', `${older}..${newer}`], { signal })
  if (walk.exitCode !== 0) return false
  const lines = walk.stdout.trim().split('\n').filter(Boolean)
  if (lines.length === 0) return false
  const parts = lines.at(-1).trim().split(' ')
  return parts[1] === older
}

/** 取某个提交的第一个父提交，根提交时返回空树 OID。 */
async function commitCompareBase(git, repoRoot, commitSha, signal) {
  const res = await git.run(repoRoot, ['rev-list', '--max-count=1', '--parents', commitSha], { signal })
  if (res.exitCode !== 0) throw new Error(`git rev-list failed: ${res.stderr.trim()}`)
  const parts = res.stdout.trim().split(' ').filter(Boolean)
  if (parts.length >= 2) return parts[1]
  return git.emptyTreeOid(repoRoot, signal)
}

/**
 * 解析并校验分支范围内选中的单条或连续多条提交。
 * @param {object} git Git 执行器。
 * @param {{ root: string }} repo 仓库信息。
 * @param {{ from?: string, to?: string }} selection 提交号选择。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<{ ok: true, fromParent: string, to: string } | { ok: false, status: number, code: string, detail?: string }>} 比较起止树/提交。
 */
export async function resolveCommitRange(git, repo, { from, to, base, head }, signal) {
  const aInput = from || to
  const bInput = to || from
  if (!SHA_PATTERN.test(aInput) || !SHA_PATTERN.test(bInput)) {
    return { ok: false, status: 400, code: 'bad-request' }
  }
  const verify = async (sha) => {
    const res = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { signal })
    return res.exitCode === 0 ? res.stdout.trim() : null
  }
  const [shaA, shaB] = await Promise.all([verify(aInput), verify(bInput)])
  if (shaA === null || shaB === null) {
    return { ok: false, status: 404, code: 'not-found' }
  }
  for (const sha of new Set([shaA, shaB])) {
    const tip = await git.run(repo.root, ['merge-base', '--is-ancestor', sha, head], { signal })
    const prior = await git.run(repo.root, ['merge-base', '--is-ancestor', sha, base], { signal })
    if (tip.exitCode !== 0 || prior.exitCode !== 1) {
      return { ok: false, status: 409, code: 'conflict', detail: '这些提交不在同一条提交链上或不在所选分支范围' }
    }
  }
  if (shaA === shaB) {
    return { ok: true, fromParent: await commitCompareBase(git, repo.root, shaA, signal), to: shaA }
  }
  if (await onFirstParentChain(git, repo.root, shaA, shaB, signal)) {
    return { ok: true, fromParent: await commitCompareBase(git, repo.root, shaA, signal), to: shaB }
  }
  if (await onFirstParentChain(git, repo.root, shaB, shaA, signal)) {
    return { ok: true, fromParent: await commitCompareBase(git, repo.root, shaB, signal), to: shaA }
  }
  return { ok: false, status: 409, code: 'conflict', detail: '这些提交不在同一条提交链上' }
}

/**
 * 审阅面板宿主端核心服务：
 * - 只读查询：仓库状态、四种范围差异（unstaged / staged / uncommitted / branch）、分支、提交链；
 * - 写操作：暂存、取消暂存、回退、撤销（同仓写锁、version 乐观锁、index.lock 拦截、路径与冲突护栏）；
 * - 未跟踪文件回退移入废纸篓；tracked 回退保存完整原文和权限位到独立备份目录。
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { canonicalPath } from '../checkpoints-git.js'
import {
  gitReviewDataDir,
  gitReviewTrashDir,
} from './config.js'
import { readCommitMessagePrompt } from './commit-message.js'
import {
  buildSingleHunkPatch,
  parseDiffRaw,
  parseUnifiedDiff,
  readUntrackedFileDiff,
  inspectWorktreeFile,
  fingerprintWorktreePath,
  stripInternalFields,
} from './diff.js'
import { assertPathInsideRepo } from './git.js'
import {
  discoverRepos,
  inspectRepoStatus,
  listBranches,
  listCommits,
  resolveBaseRef,
  resolveCommitRange,
  runComparisonDiff,
} from './repos.js'
import {
  captureFileState,
  capturedFingerprint,
  createGitReviewStore,
  moveFileToTrash,
  restoreFileFromTrash,
  restoreFileState,
  replaceFileState,
  trashFingerprint,
  trashPathFor,
  verifyTrashPath,
  sameFileState,
} from './store.js'

const ZERO_OID_RE = /^0+$/

/** 批量查询 Git blob 对象的真实字节大小，避免把超大文件拉进 unified diff 管道。 */
async function queryBlobSizes(git, repoRoot, oids, signal) {
  const unique = [...new Set(oids.filter(oid => oid && !ZERO_OID_RE.test(oid)))]
  const sizes = new Map()
  if (unique.length === 0) return sizes
  const res = await git.run(repoRoot, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
    stdin: `${unique.join('\n')}\n`,
    signal,
  })
  if (res.exitCode !== 0) return sizes
  for (const line of res.stdout.split('\n')) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const oid = line.slice(0, space)
    const size = Number(line.slice(space + 1))
    if (Number.isSafeInteger(size)) sizes.set(oid, size)
  }
  return sizes
}

/** 读取 Git index 文件字节的摘要，若尚无 index（刚 init 的空仓库）返回固定标记。 */
async function hashIndexFile(gitDir) {
  try {
    const bytes = await readFile(join(gitDir, 'index'))
    return createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return 'NO_INDEX'
    throw error
  }
}

/** 判断 Git 报错是否因并发 `index.lock` 引起。 */
const isLockStderr = stderr => /index\.lock|Unable to create '[^']*\.lock'/i.test(stderr ?? '')

const staleMutation = () => Object.assign(new Error('reviewed state changed'), { code: 'stale' })

// Holding Git's index.lock excludes other conforming index writers. All index edits use a
// private copy until their source files, HEAD and the live index have been checked again.
async function withIndexTransaction(git, repo, signal, action) {
  const index = join(repo.gitDir, 'index')
  const lock = index + '.lock'
  const handle = await open(lock, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw Object.assign(new Error('index is locked'), { code: 'locked' })
    throw error
  })
  let scratch
  try {
    await handle.close()
    scratch = await mkdtemp(join(repo.gitDir, 'dwb-review-'))
    const privateIndex = join(scratch, 'index')
    await copyFile(index, privateIndex).catch(error => { if (error.code !== 'ENOENT') throw error })
    const env = { GIT_INDEX_FILE: privateIndex, GIT_DIR: repo.gitDir }
    const run = (args, opts = {}) => git.run(repo.root, args, { signal, ...opts, env: { ...env, ...opts.env } })
    return await action({
      scratch, env, run,
      publish: () => rename(privateIndex, index),
    })
  } finally {
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true })
    } finally {
      await unlink(lock)
    }
  }
}

// Prepare the reviewed files in a private worktree. The final add cannot pick up a
// transient editor save, even when the editor puts the original bytes back immediately.
async function stageWorkingFiles(git, repo, paths, diff, tx, signal) {
  const shadow = join(tx.scratch, 'worktree')
  await mkdir(shadow)
  const attributes = new Set()
  for (const path of paths) {
    let parent = dirname(path)
    while (true) {
      attributes.add(join(parent, '.gitattributes'))
      if (parent === '.') break
      parent = dirname(parent)
    }
  }
  const selected = new Set(paths)
  const toAdd = []
  for (const path of new Set([...paths, ...attributes])) {
    const { absolutePath } = await assertPathInsideRepo(repo.root, path, { allowEscapingLeafSymlink: !selected.has(path) })
    const src = await lstat(absolutePath).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!src && !selected.has(path)) continue
    const dest = join(shadow, path)
    if (src) {
      await mkdir(dirname(dest), { recursive: true })
      if (src.isSymbolicLink()) {
        if (!selected.has(path)) continue
        await symlink(await readlink(absolutePath, { encoding: 'buffer' }), dest)
      } else {
        if (!src.isFile()) throw Object.assign(new Error('unsupported working file'), { code: 'bad-path' })
        const file = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const out = await open(dest, 'wx', 0o600)
        try {
          const opened = await file.stat()
          if (!opened.isFile() || opened.dev !== src.dev || opened.ino !== src.ino) throw staleMutation()
          await pipeline(file.createReadStream(), out.createWriteStream(), { signal })
          await chmod(dest, opened.mode & 0o7777)
        } finally {
          await Promise.all([file.close(), out.close()])
        }
      }
    }
    if (selected.has(path)) {
      // The private symlink may point to a different location, but Git stages its link text.
      if (await fingerprintWorktreePath(shadow, path, signal) !== diff.worktreeFingerprints.get(path)) throw staleMutation()
      if (src || checked(await tx.run(['ls-files', '-z', '--', path]), 'git ls-files')) toAdd.push(path)
    }
  }
  if (!toAdd.length) return false
  checked(await git.run(shadow, ['add', '-f', '-A', '--', ...toAdd], {
    signal, env: { ...tx.env, GIT_WORK_TREE: shadow },
  }), 'git add')
  return true
}

async function refreshIndex(tx) {
  // Other working files can legitimately be modified.
  const res = await tx.run(['update-index', '-q', '--refresh'])
  if (res.exitCode !== 0 && res.exitCode !== 1) checked(res, 'git update-index --refresh')
}

function checked(res, what) {
  if (res.exitCode !== 0) throw Object.assign(new Error(`${what} failed: ${res.stderr.trim()}`), {
    code: isLockStderr(res.stderr) ? 'locked' : 'git-failed',
  })
  return res.stdout
}

async function captureIndexState(git, path, maxBytes, tx, signal) {
  const row = checked(await tx.run(['ls-files', '--stage', '-z', '--', path]), 'git ls-files')
  if (!row) return { kind: 'absent' }
  const match = /^(100644|100755|120000) ([0-9a-f]+) 0\t/.exec(row)
  if (!match || row.slice(row.indexOf('\t') + 1, -1) !== path) throw staleMutation()
  const [, mode, oid] = match
  const size = Number(checked(await tx.run(['cat-file', '-s', oid]), 'git cat-file').trim())
  if (size > maxBytes) throw Object.assign(new Error('staged backup exceeds maxBackupBytes'), { code: 'too-large' })
  // The subprocess collector decodes stdout as text. Git writes the raw blob to a private file.
  const name = checked(await git.run(tx.scratch, ['unpack-file', oid], { env: tx.env, signal }), 'git unpack-file').trim()
  if (!/^\.merge_file_[a-zA-Z0-9]+$/.test(name)) throw new Error('unexpected unpack-file result')
  const bytes = await readFile(join(tx.scratch, name))
  return { kind: 'entry', mode, oid, base64: bytes.toString('base64') }
}

const sameIndexState = (a, b) => a?.kind === b?.kind && (a.kind === 'absent' || (a.oid === b.oid && a.mode === b.mode))

async function restoreIndexState(tx, path, state) {
  if (state.kind === 'absent') {
    checked(await tx.run(['update-index', '--force-remove', '--', path]), 'git update-index')
    return
  }
  const blob = join(tx.scratch, 'blob')
  await writeFile(blob, Buffer.from(state.base64, 'base64'), { mode: 0o600 })
  const oid = checked(await tx.run(['hash-object', '-w', '--no-filters', '--', blob]), 'git hash-object').trim()
  // Old backups passed binary data through a UTF-8 collector. Use the original object
  // while it still exists and refuse to substitute bytes with a different object ID.
  if (oid !== state.oid && (await tx.run(['cat-file', '-e', state.oid + '^{blob}'])).exitCode !== 0) throw staleMutation()
  checked(await tx.run(['update-index', '--add', '--cacheinfo', state.mode + ',' + state.oid + ',' + path]), 'git update-index')
}

/**
 * 创建 Git 审阅面板宿主服务。
 * @param {object} deps 依赖注入。
 * @param {object} deps.config 校验后的行配置。
 * @param {object} deps.git Git 执行器（createGitReviewGit）。
 * @param {object} [deps.store] 回退备份存储（默认使用 gitReviewDataDir）。
 * @param {(sessionId: string) => boolean} deps.isRunning 查询会话是否正在运行一轮。
 * @param {(sessionId: string) => Promise<string[] | undefined>} deps.foldersOf 解析会话的文件夹清单。
 * @param {(sessionId: string) => { provider: string, model: string } | undefined} [deps.resolveModel] 读取当前会话选中的模型。
 * @param {(sessionId: string, onDispose: () => Promise<void>) => (() => void)} [deps.bindParentLifetime] 绑定父会话生命周期。
 * @returns {object} 服务实例。
 */
export function createGitReviewService(deps) {
  const { config, git, isRunning, foldersOf } = deps
  const store = deps.store ?? createGitReviewStore(gitReviewDataDir(config))
  const trashDir = gitReviewTrashDir(config)
  const inFlightRepos = new Set()

  const fail = (status, code, detail) => ({
    ok: false,
    status,
    code,
    ...(detail !== undefined ? { detail } : {}),
  })

  async function discoverSessionRepos(folders, signal) {
    const repos = await discoverRepos(git, folders, signal)
    const privateDirs = await Promise.all([gitReviewDataDir(config), trashDir].map(path => canonicalPath(path)))
    for (const repo of repos) {
      if (repo.kind !== 'git') continue
      for (const dir of privateDirs) {
        const rel = relative(repo.root, dir)
        if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
          throw Object.assign(new Error('备份目录和废纸篓必须位于被审仓库之外。'), { code: 'bad-path' })
        }
      }
    }
    return repos
  }

  async function locateRepo(sessionId, repoId, signal) {
    const folders = await foldersOf(sessionId)
    if (folders === undefined) return fail(404, 'not-found')
    const repos = await discoverSessionRepos(folders, signal)
    const repo = repos.find(item => item.id === repoId)
    if (!repo) return fail(404, 'not-found')
    if (repo.kind === 'not-git') return fail(409, 'not-git')
    return { ok: true, repo }
  }

  /** 同一个仓库同时只做一个写操作，并发进入时直接拒绝返回 `busy`。 */
  async function withRepoLock(repo, fn) {
    if (inFlightRepos.has(repo.root)) {
      return fail(409, 'busy')
    }
    inFlightRepos.add(repo.root)
    try {
      return await fn()
    } finally {
      inFlightRepos.delete(repo.root)
    }
  }

  /**
   * 内部差异计算（同时返回供写操作使用的一手内部 hunk / raw 字段与 version 摘要）。
   */
  async function computeDiffInternal({ sessionId, repo: repoId, scope, base, from, to, includeUncommitted }, signal) {
    if (!['unstaged', 'staged', 'uncommitted', 'branch'].includes(scope)) {
      return fail(400, 'bad-request')
    }
    const located = await locateRepo(sessionId, repoId, signal)
    if (!located.ok) return located
    const { repo } = located
    const statusInfo = await inspectRepoStatus(git, repo, signal)
    const headRes = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal })
    const headOid = headRes.exitCode === 0 ? headRes.stdout.trim() : null

    const unmergedSet = new Set(statusInfo._internal.unmergedPaths)
    let rawArgs = null
    let diffArgs = null
    let includeUntracked = false
    let resolvedBaseName
    let readsWorktree = false
    let readsIndex = false
    let branchKey = ''

    if (scope === 'unstaged') {
      rawArgs = ['diff-files', '--raw', '-z', '--no-abbrev']
      diffArgs = ['diff-files', '-p', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']
      includeUntracked = true
      readsWorktree = true
      readsIndex = true
    } else if (scope === 'staged') {
      const fromTree = headOid ?? await git.emptyTreeOid(repo.root, signal)
      rawArgs = ['diff-index', '--cached', '-M', '--raw', '-z', '--no-abbrev', fromTree]
      diffArgs = ['diff-index', '--cached', '-M', '-p', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', fromTree]
      readsIndex = true
    } else if (scope === 'uncommitted') {
      const fromTree = headOid ?? await git.emptyTreeOid(repo.root, signal)
      rawArgs = ['diff', '--raw', '-M', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', fromTree, '--']
      diffArgs = ['diff', '-M', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', fromTree, '--']
      includeUntracked = true
      readsWorktree = true
      readsIndex = true
    } else {
      const resolvedBase = await resolveBaseRef(git, repo, base, signal)
      resolvedBaseName = resolvedBase?.name ?? null
      if (headOid === null && !from && !to) {
        if (!includeUncommitted) {
          const indexDigest = await hashIndexFile(repo.gitDir)
          const version = createHash('sha256')
            .update(JSON.stringify(['branch', 'EMPTY', resolvedBaseName, indexDigest, statusInfo._internal.statusRaw]))
            .digest('hex')
          return {
            ok: true,
            repo,
            statusInfo,
            headOid,
            scope,
            version,
            ...(resolvedBaseName !== null ? { base: resolvedBaseName } : {}),
            internalFiles: [],
            files: [],
            totals: { files: 0, added: 0, deleted: 0 },
          }
        }
        const fromTree = await git.emptyTreeOid(repo.root, signal)
        rawArgs = ['diff', '--raw', '-M', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', fromTree, '--']
        diffArgs = ['diff', '-M', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', fromTree, '--']
        includeUntracked = true
        readsWorktree = true
        readsIndex = true
        branchKey = `${fromTree}:WORKTREE`
      } else if (from || to) {
        if (!resolvedBase || !headOid) return fail(404, 'not-found')
        const range = await resolveCommitRange(git, repo, { from, to, base: resolvedBase.ref, head: headOid }, signal)
        if (!range.ok) return range
        rawArgs = ['diff', '--raw', '-M', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', range.fromParent, range.to, '--']
        diffArgs = ['diff', '-M', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', range.fromParent, range.to, '--']
        branchKey = `${range.fromParent}:${range.to}`
      } else {
        if (resolvedBase === null) return fail(404, 'not-found')
        const mb = await git.run(repo.root, ['merge-base', resolvedBase.ref, 'HEAD'], { signal })
        const mergeBase = mb.exitCode === 0 ? mb.stdout.trim() : await git.emptyTreeOid(repo.root, signal)
        if (includeUncommitted) {
          rawArgs = ['diff', '--raw', '-M', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', mergeBase, '--']
          diffArgs = ['diff', '-M', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, '--']
          includeUntracked = true
          readsWorktree = true
          readsIndex = true
          branchKey = `${resolvedBase.name}:${mergeBase}:WORKTREE`
        } else {
          rawArgs = ['diff', '--raw', '-M', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', mergeBase, 'HEAD', '--']
          diffArgs = ['diff', '-M', '--unified=3', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, 'HEAD', '--']
          branchKey = `${resolvedBase.name}:${mergeBase}:${headOid}`
        }
      }
    }

    let rawRes = await git.runDiff(repo.root, rawArgs, { signal })
    if (rawRes.exitCode !== 0) {
      throw new Error(`git diff --raw failed: ${rawRes.stderr.trim()}`)
    }
    if (rawRes.truncated) {
      return fail(409, 'too-large')
    }

    let comparisonTree
    let restoredPaths = []
    const untrackedPaths = new Set(statusInfo._internal.untrackedPaths)
    if (includeUntracked && scope !== 'unstaged' && untrackedPaths.size > 0) {
      comparisonTree = rawArgs.at(-2)
      restoredPaths = parseDiffRaw(rawRes.stdout)
        .flatMap(entry => entry.oldPath ?? (entry.status === 'deleted' ? entry.path : []))
        .filter(path => untrackedPaths.has(path))
      if (restoredPaths.length) {
        rawRes = await runComparisonDiff(git, repo, comparisonTree, restoredPaths, rawArgs, { signal })
        if (rawRes.exitCode !== 0) throw new Error('could not compare recreated files')
        if (rawRes.truncated) return fail(409, 'too-large')
        for (const path of restoredPaths) untrackedPaths.delete(path)
      }
    }
    const rawEntries = parseDiffRaw(rawRes.stdout)
      .filter(entry => !unmergedSet.has(entry.path) && !(entry.oldPath && unmergedSet.has(entry.oldPath)))

    const blobOids = rawEntries.flatMap(entry => [entry.oldSha, entry.newSha])
    const blobSizes = await queryBlobSizes(git, repo.root, blobOids, signal)
    const eligibleEntries = []
    const tooLargePaths = new Set()
    const worktreeFingerprints = new Map()

    for (const entry of rawEntries) {
      const oldSize = blobSizes.get(entry.oldSha) ?? 0
      let newSize = blobSizes.get(entry.newSha) ?? 0
      if (readsWorktree) {
        const ws = await inspectWorktreeFile(repo.root, entry.path, signal)
        newSize = ws.size
        worktreeFingerprints.set(entry.path, ws.fingerprint)
        if (entry.oldPath) worktreeFingerprints.set(entry.oldPath, await fingerprintWorktreePath(repo.root, entry.oldPath, signal))
      }
      if (oldSize > config.maxFileBytes || newSize > config.maxFileBytes) {
        tooLargePaths.add(entry.path)
      } else {
        eligibleEntries.push(entry)
      }
    }

    const parsedByPath = new Map()
    let unifiedOutput = ''
    let diffTruncated = false
    if (eligibleEntries.length > 0) {
      const paths = [...new Set(eligibleEntries.flatMap(e => (e.oldPath ? [e.oldPath, e.path] : [e.path])))]
      const sep = diffArgs.at(-1) === '--' ? [] : ['--']
      const patchRes = await runComparisonDiff(git, repo, comparisonTree, restoredPaths, [...diffArgs, ...sep, ...paths], {
        signal,
        maxBytes: config.maxDiffBytes,
      })
      if (patchRes.exitCode !== 0) {
        throw new Error(`git diff failed: ${patchRes.stderr.trim()}`)
      }
      unifiedOutput = patchRes.stdout
      diffTruncated = patchRes.truncated
      const safeText = diffTruncated
        ? unifiedOutput.slice(0, Math.max(0, unifiedOutput.lastIndexOf('\ndiff --git ')))
        : unifiedOutput
      for (const parsedFile of parseUnifiedDiff(safeText, eligibleEntries)) {
        if (parsedFile.path) parsedByPath.set(parsedFile.path, parsedFile)
      }
    }

    const internalFiles = []
    for (const entry of rawEntries) {
      if (tooLargePaths.has(entry.path)) {
        internalFiles.push({ ...entry, binary: false, tooLarge: true, hunks: [] })
        continue
      }
      const parsed = parsedByPath.get(entry.path)
      if (!parsed && diffTruncated) {
        internalFiles.push({ ...entry, binary: false, tooLarge: true, hunks: [] })
        continue
      }
      internalFiles.push({
        ...entry,
        binary: Boolean(parsed?.binary),
        tooLarge: false,
        hunks: parsed?.hunks ?? [],
        ...(parsed?.oldMode ? { oldMode: parsed.oldMode } : {}),
        ...(parsed?.newMode ? { newMode: parsed.newMode } : {}),
      })
    }

    if (readsWorktree) {
      for (const conflictPath of statusInfo._internal.unmergedPaths) {
        internalFiles.push({
          path: conflictPath,
          status: 'conflict',
          binary: false,
          tooLarge: false,
          hunks: [],
        })
      }
    }

    let remainingBytes = Math.max(0, config.maxDiffBytes - Buffer.byteLength(unifiedOutput))
    if (includeUntracked) {
      for (const relPath of untrackedPaths) {
        if (unmergedSet.has(relPath) || relPath.endsWith('/')) continue
        const { file, fingerprint, size } = await readUntrackedFileDiff(repo.root, relPath, Math.min(config.maxFileBytes, remainingBytes), signal)
        if (file.hunks.length) remainingBytes -= size
        internalFiles.push(file)
        worktreeFingerprints.set(relPath, fingerprint)
      }
    }

    internalFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

    const versionHash = createHash('sha256')
    versionHash.update(JSON.stringify([
      scope,
      headOid ?? 'UNBORN',
      branchKey,
      readsIndex ? await hashIndexFile(repo.gitDir) : '',
      readsWorktree || readsIndex ? statusInfo._internal.statusRaw : '',
      rawRes.stdout,
      [...worktreeFingerprints],
    ]))
    versionHash.update('\0')
    versionHash.update(unifiedOutput)
    const version = versionHash.digest('hex')

    const files = internalFiles.map(stripInternalFields)
    const totals = files.reduce(
      (acc, file) => {
        acc.files++
        acc.added += file.added
        acc.deleted += file.deleted
        return acc
      },
      { files: 0, added: 0, deleted: 0 },
    )

    return {
      ok: true,
      repo,
      statusInfo,
      headOid,
      scope,
      version,
      ...(resolvedBaseName !== undefined && resolvedBaseName !== null ? { base: resolvedBaseName } : {}),
      internalFiles,
      worktreeFingerprints,
      files,
      totals,
    }
  }

  /** 将写操作封装在仓库锁与版本核对之中。 */
  async function runGuardedMutation({ sessionId, repo: repoId, scope, version, path, hunk, requireIdle = false }, execute, signal) {
    if (typeof version !== 'string' || version.length === 0) return fail(400, 'bad-request')
    if (requireIdle && isRunning(sessionId)) return fail(409, 'running')
    const located = await locateRepo(sessionId, repoId, signal)
    if (!located.ok) return located
    const { repo } = located

    if (path !== undefined) {
      try {
        await assertPathInsideRepo(repo.root, path)
      } catch {
        return fail(400, 'bad-request')
      }
    }

    return withRepoLock(repo, async () => {
      if (requireIdle && isRunning(sessionId)) return fail(409, 'running')
      if (await git.isIndexLocked(repo.gitDir)) {
        return fail(409, 'locked', '另一个 Git 操作正在进行，稍后重试。')
      }
      const diff = await computeDiffInternal({ sessionId, repo: repoId, scope }, signal)
      if (!diff.ok) return diff
      if (diff.version !== version) return fail(409, 'stale')

      let file = null
      let hunkObj = null
      if (path === undefined) {
        if (diff.statusInfo.conflicts > 0) return fail(409, 'conflict')
      } else {
        file = diff.internalFiles.find(item => item.path === path)
        if (!file) return fail(404, 'not-found')
        if (file.status === 'conflict') return fail(409, 'conflict')
        if (hunk !== undefined) {
          if (file.binary || file.tooLarge) return fail(409, 'too-large')
          hunkObj = file.hunks.find(item => item.id === hunk)
          if (!hunkObj) return fail(404, 'not-found')
        }
      }
      const files = file ? [file] : diff.internalFiles
      const paths = [...new Set(files.flatMap(item => item.oldPath ? [item.oldPath, item.path] : [item.path]))]
      const verify = async () => {
        const now = await computeDiffInternal({ sessionId, repo: repoId, scope }, signal)
        if (!now.ok || now.repo.root !== repo.root || now.version !== version) throw staleMutation()
        if (requireIdle && isRunning(sessionId)) throw Object.assign(new Error('session running'), { code: 'running' })
        signal?.throwIfAborted()
      }
      try {
        for (const p of paths) await assertPathInsideRepo(repo.root, p)
        return await withIndexTransaction(git, repo, signal, tx => execute({ repo, diff, file, hunkObj, files, paths, verify, tx }))
      } catch (error) {
        if (error.code === 'bad-path') return fail(400, 'bad-request')
        if (['locked', 'stale', 'too-large', 'running'].includes(error.code)) return fail(409, error.code)
        throw error
      }
    })
  }

  async function applyWorktreeEntries(repo, entries, undo, publish) {
    const completed = []
    async function apply(entry, reverse) {
      if (entry.kind === 'trashed') {
        return reverse ? restoreFileFromTrash(repo.root, entry) : moveFileToTrash(repo.root, entry)
      }
      const [from, to] = reverse ? [entry.worktreeAfter, entry.worktreeBefore] : [entry.worktreeBefore, entry.worktreeAfter]
      if (!sameFileState(from, to)) await replaceFileState(repo.root, entry.path, from, to)
    }
    // A restored symlink can depend on another file or symlink in this operation.
    // Defer only missing targets, and stop when no further path can be installed.
    async function applyAll(list, reverse, onApplied) {
      let pending = list
      while (pending.length) {
        const waiting = []
        for (const entry of pending) {
          try {
            await apply(entry, reverse)
            onApplied?.(entry)
          } catch (error) {
            if (!error.targetMissing) throw error
            waiting.push(entry)
          }
        }
        if (waiting.length === pending.length) throw staleMutation()
        pending = waiting
      }
    }
    try {
      await applyAll(entries, undo, entry => completed.push(entry))
      await publish()
    } catch (error) {
      try {
        await applyAll(completed.reverse(), !undo)
      } catch (recovery) {
        throw new AggregateError([error, recovery], 'rollback incomplete; original file backups retained')
      }
      throw error
    }
  }

  return {
    async status(sessionId, signal) {
      const folders = await foldersOf(sessionId)
      if (folders === undefined) return fail(404, 'not-found')
      const repos = await discoverSessionRepos(folders, signal)
      const entries = []
      for (const repo of repos) {
        const info = await inspectRepoStatus(git, repo, signal)
        const { _internal: _, ...publicInfo } = info
        const push = info.kind === 'git' && !info.detached && info.branch
          ? await resolvePushTarget(repo.root, info.branch, signal)
          : null
        entries.push({ ...publicInfo, pushTarget: push?.ok ? push.target : null })
      }
      return {
        ok: true,
        running: Boolean(isRunning(sessionId)),
        repos: entries,
      }
    },

    async diff(params, signal) {
      const result = await computeDiffInternal(params, signal)
      if (!result.ok) return result
      return {
        ok: true,
        scope: result.scope,
        version: result.version,
        ...(result.base !== undefined ? { base: result.base } : {}),
        files: result.files,
        totals: result.totals,
      }
    },

    async branches(sessionId, repoId, signal) {
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      return { ok: true, ...(await listBranches(git, located.repo, signal)) }
    },

    async commits(sessionId, repoId, base, signal) {
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      return listCommits(git, located.repo, base, config.maxCommits, signal)
    },

    /**
     * 暂存整个范围、单个文件或单块差异；会话进行中允许暂存。
     */
    async stage({ sessionId, repo, scope, version, path, hunk }, signal) {
      if (!['unstaged', 'uncommitted'].includes(scope)) return fail(400, 'bad-request')
      if (scope === 'uncommitted' && (path === undefined || hunk !== undefined)) return fail(400, 'bad-request')
      if (path === undefined && hunk !== undefined) return fail(400, 'bad-request')

      return runGuardedMutation({ sessionId, repo, scope, version, path, hunk }, async ({ repo: target, diff, file, hunkObj, paths, verify, tx }) => {
        if (paths.length === 0) return { ok: true }
        if (hunkObj) {
          checked(await tx.run(['apply', '--cached', '-'], { stdin: buildSingleHunkPatch(file, hunkObj) }), 'git apply --cached')
        } else {
          if (!await stageWorkingFiles(git, target, paths, diff, tx, signal)) return { ok: true }
          await refreshIndex(tx)
        }
        await verify()
        await tx.publish()
        return { ok: true }
      }, signal)
    },

    /**
     * 取消暂存整个范围、单个文件或单块差异；会话进行中允许取消暂存。
     */
    async unstage({ sessionId, repo, scope, version, path, hunk }, signal) {
      if (scope !== 'staged') return fail(400, 'bad-request')
      if (path === undefined && hunk !== undefined) return fail(400, 'bad-request')

      return runGuardedMutation({ sessionId, repo, scope, version, path, hunk }, async ({ diff, file, hunkObj, paths, verify, tx }) => {
        if (paths.length === 0) return { ok: true }
        if (hunkObj) {
          checked(await tx.run(['apply', '--cached', '--reverse', '-'], { stdin: buildSingleHunkPatch(file, hunkObj) }), 'git apply --cached --reverse')
        } else if (diff.headOid) {
          checked(await tx.run(['reset', '-q', diff.headOid, '--', ...paths]), 'git reset')
        } else {
          checked(await tx.run(['update-index', '--force-remove', '--', ...paths]), 'git update-index')
        }
        await verify()
        await tx.publish()
        return { ok: true }
      }, signal)
    },

    /**
     * 回退整个范围、单个文件或单块差异；会话进行中拒绝。
     * 回退前把完整文件内容和权限位存进独立备份目录；未跟踪文件移入废纸篓。
     */
    async revert({ sessionId, repo, scope, version, path, hunk }, signal) {
      if (!['unstaged', 'uncommitted'].includes(scope)) return fail(400, 'bad-request')
      if (scope === 'uncommitted' && (path === undefined || hunk !== undefined)) return fail(400, 'bad-request')
      if (path === undefined && hunk !== undefined) return fail(400, 'bad-request')

      return runGuardedMutation({ sessionId, repo, scope, version, path, hunk, requireIdle: true }, async ({ repo: target, diff, file, hunkObj, files, paths, verify, tx }) => {
        if (!paths.length) return fail(404, 'not-found')
        const undoId = randomUUID()
        const entries = []
        const shadow = join(tx.scratch, 'worktree')
        await mkdir(shadow)
        const tracked = []
        const untracked = new Set(files.filter(f => f.status === 'untracked').map(f => f.path))
        for (const p of paths) {
          if (untracked.has(p)) {
            const fingerprint = await trashFingerprint(join(target.root, p))
            if (fingerprint !== diff.worktreeFingerprints.get(p)) throw staleMutation()
            entries.push({
              kind: 'trashed', path: p, trashPath: await trashPathFor(target.root, p, trashDir, undoId),
              fingerprint,
            })
            continue
          }
          const entry = { kind: 'file-revert', path: p, worktreeBefore: await captureFileState(target.root, p, config.maxBackupBytes) }
          if (capturedFingerprint(entry.worktreeBefore) !== diff.worktreeFingerprints.get(p)) throw staleMutation()
          if (scope === 'uncommitted') entry.indexBefore = await captureIndexState(git, p, config.maxBackupBytes, tx, signal)
          entries.push(entry)
          tracked.push(entry)
        }
        if (hunkObj && tracked.length) {
          const entry = tracked[0]
          await restoreFileState(shadow, entry.path, entry.worktreeBefore, { privateCopy: true })
          checked(await git.run(shadow, ['apply', '--reverse', '-'], {
            env: { ...tx.env, GIT_WORK_TREE: shadow }, signal, stdin: buildSingleHunkPatch(file, hunkObj),
          }), 'git apply --reverse')
        } else if (tracked.length) {
          if (scope === 'uncommitted') {
            const args = diff.headOid
              ? ['reset', '-q', diff.headOid, '--', ...tracked.map(e => e.path)]
              : ['update-index', '--force-remove', '--', ...tracked.map(e => e.path)]
            checked(await tx.run(args), 'git reset index')
          }
          const checkout = []
          for (const entry of tracked) {
            if (scope === 'uncommitted') entry.indexAfter = await captureIndexState(git, entry.path, config.maxBackupBytes, tx, signal)
            if (entry.indexAfter?.kind !== 'absent') checkout.push(entry.path)
          }
          if (checkout.length) checked(await tx.run(['checkout-index', '--prefix=' + shadow + '/', '--', ...checkout]), 'git checkout-index')
        }
        for (const entry of tracked) {
          entry.worktreeAfter = await captureFileState(shadow, entry.path, config.maxBackupBytes, { privateCopy: true })
        }
        await store.save({ kind: 'git-review-revert', undoId, sessionId, repoId: target.id, repoRoot: target.root, scope, entries })
        try {
          await verify()
          await applyWorktreeEntries(target, entries, false, async () => {
            if (scope === 'uncommitted' && tracked.length) {
              await refreshIndex(tx)
              await tx.publish()
            }
          })
        } catch (error) {
          // A failed compensation keeps the record and any displaced file for recovery.
          if (!(error instanceof AggregateError)) await store.remove(undoId)
          throw error
        }
        return { ok: true, undoId }
      }, signal)
    },

    /**
     * 撤销上一次回退：核对工作区（及 uncommitted 的暂存区）仍为回退后一模一样的字节与权限位，
     * 全部核对通过才恢复，并删除备份记录。
     */
    async undo({ sessionId, repo: repoId, undoId }, signal) {
      if (isRunning(sessionId)) return fail(409, 'running')
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      const { repo } = located
      return withRepoLock(repo, async () => {
        const record = await store.load(undoId)
        if (!record || record.sessionId !== sessionId || record.repoId !== repo.id || record.repoRoot !== repo.root) return fail(404, 'not-found')
        try {
          return await withIndexTransaction(git, repo, signal, async tx => {
            let indexChanged = false
            for (const entry of record.entries) {
              await assertPathInsideRepo(repo.root, entry.path)
              if (entry.kind === 'trashed') {
                await verifyTrashPath(entry, trashDir, undoId)
                if (!entry.fingerprint || await trashFingerprint(entry.trashPath) !== entry.fingerprint) throw staleMutation()
              }
              const state = await captureFileState(repo.root, entry.path, config.maxBackupBytes)
              if (!sameFileState(state, entry.worktreeAfter ?? { kind: 'absent' })) throw staleMutation()
              if (entry.indexBefore !== undefined) {
                const actual = await captureIndexState(git, entry.path, config.maxBackupBytes, tx, signal)
                if (!sameIndexState(actual, entry.indexAfter)) throw staleMutation()
                await restoreIndexState(tx, entry.path, entry.indexBefore)
                indexChanged = true
              }
            }
            if (isRunning(sessionId)) return fail(409, 'running')
            signal?.throwIfAborted()
            await applyWorktreeEntries(repo, record.entries, true, () => { if (indexChanged) return tx.publish() })
            await store.remove(undoId)
            return { ok: true }
          })
        } catch (error) {
          if (error.code === 'bad-path') return fail(400, 'bad-request')
          if (error.code === 'locked') return fail(409, 'locked')
          if (['ENOENT', 'too-large', 'stale'].includes(error.code)) return fail(409, 'stale')
          throw error
        }
      })
    },

    /** 清理超过 keepDays 天的备份记录。 */
    prune(cutoffMs = Date.now() - config.keepDays * 24 * 60 * 60 * 1000) {
      return store.prune(cutoffMs)
    },

    /**
     * 提交已暂存改动（照常跑仓库自己的钩子），勾选 push 时随后执行不强推的推送。
     */
    async commit({ sessionId, repo: repoId, message, push: shouldPush = false }, signal) {
      if (typeof message !== 'string' || message.trim() === '' || message.includes('\0')) {
        return fail(400, 'bad-request')
      }
      if (typeof shouldPush !== 'boolean') {
        return fail(400, 'bad-request')
      }
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      const { repo } = located

      return withRepoLock(repo, async () => {
        const statusInfo = await inspectRepoStatus(git, repo, signal)
        if (statusInfo.detached) return fail(409, 'detached')
        if (statusInfo.conflicts > 0) return fail(409, 'conflict')
        if (await git.isIndexLocked(repo.gitDir)) {
          return fail(409, 'locked', '另一个 Git 操作正在进行，稍后重试。')
        }
        if (statusInfo.counts.staged === 0) return fail(409, 'no-staged')

        const commitRes = await git.runCommit(repo.root, message, { signal })
        if (commitRes.exitCode !== 0) {
          const combined = [commitRes.stdout, commitRes.stderr].filter(Boolean).join('\n')
          if (isLockStderr(combined)) return fail(409, 'locked', '另一个 Git 操作正在进行，稍后重试。')
          if (/nothing to commit/i.test(combined)) return fail(409, 'no-staged')
          return fail(409, 'hook-failed', tailLines(combined, 20))
        }

        const sha = (await git.run(repo.root, ['rev-parse', 'HEAD'], { signal })).stdout.trim()
        if (!shouldPush) return { ok: true, sha }

        const afterStatus = await inspectRepoStatus(git, repo, signal)
        const pushRes = await executePush(repo, afterStatus, signal)
        if (pushRes.ok) return { ok: true, sha, pushed: true }
        return { ok: true, sha, pushed: false, pushError: pushRes.code }
      })
    },

    /**
     * 推送当前分支：已有上游推到上游，没有上游按 pushRemote / pushDefault / 唯一远程 / origin 推并设上游；永不强推。
     */
    async push({ sessionId, repo: repoId }, signal) {
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      const { repo } = located
      return withRepoLock(repo, async () => {
        const statusInfo = await inspectRepoStatus(git, repo, signal)
        return executePush(repo, statusInfo, signal)
      })
    },

    /**
     * 在当前提交（常为游离 HEAD）或空仓库上新建分支并切到该分支；用 `git check-ref-format --branch` 校验名字。
     */
    async createBranch({ sessionId, repo: repoId, name }, signal) {
      if (
        typeof name !== 'string'
        || name.trim() !== name
        || name === ''
        || /[\x00-\x1f\x7f]/.test(name)
        || name.startsWith('-')
        || name === 'HEAD'
        || name === '@'
      ) {
        return fail(400, 'invalid-branch-name')
      }
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      const { repo } = located

      return withRepoLock(repo, async () => {
        const fmtRes = await git.run(repo.root, ['check-ref-format', '--branch', name], { signal })
        if (fmtRes.exitCode !== 0 || fmtRes.stdout.trim() !== name) return fail(400, 'invalid-branch-name')
        const branch = fmtRes.stdout.trim()
        if (await git.isIndexLocked(repo.gitDir)) {
          return fail(409, 'locked', '另一个 Git 操作正在进行，稍后重试。')
        }
        const existsRes = await git.run(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { signal })
        if (existsRes.exitCode === 0) return fail(409, 'conflict', '分支已存在')

        const headRes = await git.run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal })
        if (headRes.exitCode === 0) {
          const sw = await git.run(repo.root, ['switch', '-c', branch], { signal })
          if (sw.exitCode !== 0) {
            if (isLockStderr(sw.stderr)) return fail(409, 'locked', '另一个 Git 操作正在进行，稍后重试。')
            return fail(409, 'conflict', tailLines(sw.stderr, 20))
          }
        } else {
          const sym = await git.run(repo.root, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { signal })
          if (sym.exitCode !== 0) return fail(409, 'conflict', tailLines(sym.stderr, 20))
        }
        return { ok: true, branch }
      })
    },

    /** 启动独立只读提交信息生成作业，立刻返回 requestId。 */
    async generateMessage({ sessionId, repo: repoId }, signal) {
      const cm = deps.commitMessageManager
      if (!cm || cm.closed) return fail(409, 'not-found', 'commit-message generator unavailable')
      const located = await locateRepo(sessionId, repoId, signal)
      if (!located.ok) return located
      const { repo } = located

      const statusInfo = await inspectRepoStatus(git, repo, signal)
      if (statusInfo.conflicts > 0) return fail(409, 'conflict')
      if (statusInfo.counts.staged === 0) return fail(409, 'no-staged')

      const selected = deps.resolveModel?.(sessionId)
      const effectiveModel = config.commitModel && selected?.provider
        ? { ...selected, model: config.commitModel }
        : selected
      if (!effectiveModel?.provider || !effectiveModel?.model) {
        return fail(409, 'not-found', 'no-model')
      }

      const prompt = await readCommitMessagePrompt(git, repo.root, config, signal)
      if (prompt === null) return fail(409, 'no-reviewable-files', '已暂存文件均无法安全用于生成提交信息。')

      if (cm.closed || deps.commitMessageManager !== cm) return fail(409, 'not-found', 'commit-message generator unavailable')
      try {
        const { requestId } = cm.start({
          sessionId, repoId: repo.id, cwd: repo.root, model: effectiveModel, prompt,
          bindParent: handler => deps.bindParentLifetime?.(sessionId, handler),
        })
        return { ok: true, requestId }
      } catch (error) {
        if (error?.code === 'parent-unavailable') return fail(409, 'not-found', 'parent session closed')
        throw error
      }
    },

    /** 取消正在生成的提交信息作业。 */
    async cancelGenerate({ requestId, sessionId, repo }) {
      const cm = deps.commitMessageManager
      if (!cm) return fail(404, 'not-found')
      const found = await cm.cancel(requestId, {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(repo !== undefined ? { repoId: repo } : {}),
      })
      return found ? { ok: true } : fail(404, 'not-found')
    },

    /** 查询提交信息生成作业状态。 */
    generationStatus(requestId) {
      const cm = deps.commitMessageManager
      const st = cm?.status(requestId)
      if (!st) return fail(404, 'not-found')
      return { ok: true, ...st }
    },

    _locateRepo: locateRepo,
    _withRepoLock: withRepoLock,
  }

  /** 按第 3 节规则解析目标远程并执行不强推的 `git push`。 */
  async function executePush(repo, statusInfo, signal) {
    if (statusInfo.detached) return fail(409, 'detached')
    if (statusInfo.head === null || !statusInfo.branch) {
      return fail(409, 'push-failed', '当前分支还没有提交。')
    }
    if (await git.isIndexLocked(repo.gitDir)) return fail(409, 'locked', '另一个 Git 操作正在进行，稍后重试。')
    const branch = statusInfo.branch
    const source = `refs/heads/${branch}`
    try {
      const resolved = await resolvePushTarget(repo.root, branch, signal)
      if (!resolved.ok) return resolved
      const { remote, branch: targetBranch, setUpstream: createdUpstream } = resolved.target
      const target = `refs/heads/${targetBranch}`
      const args = ['-c', `remote.${remote}.mirror=false`, 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no']
      if (createdUpstream) args.push('--set-upstream')
      args.push('--', remote, `${source}:${target}`)
      const result = await git.run(repo.root, args, { signal })
      if (result.exitCode !== 0) {
        // 仅判断 porcelain 的引用状态；stderr 和远端诊断可能含凭据或带认证的 URL。
        const rejected = result.stdout.split('\n').find(line => line.startsWith('!\t'))
        if (rejected) {
          const detail = /\((?:fetch first|non-fast-forward)\)/.test(rejected)
            ? '远程有新的提交，无法快进推送，请先检查并拉取。'
            : '远程拒绝更新该分支，请检查分支状态和远程规则。'
          return fail(409, 'push-rejected', detail)
        }
        return fail(409, 'push-failed', 'Git 无法完成推送，请检查连接与凭据。')
      }
      return { ok: true, remote, branch, createdUpstream }
    } catch (error) {
      if (signal?.aborted) throw error
      return fail(409, 'push-failed', 'Git 无法完成推送。')
    }
  }

  /** 状态预览和推送共用配置校验，预览也支持尚未提交的分支。 */
  async function resolvePushTarget(repoRoot, branch, signal) {
    try {
      const [upstream, merge, listed] = await Promise.all([
        git.run(repoRoot, ['config', '--get', `branch.${branch}.remote`], { signal }),
        git.run(repoRoot, ['config', '--get', `branch.${branch}.merge`], { signal }),
        git.run(repoRoot, ['remote'], { signal }),
      ])
      if (listed.exitCode !== 0 || ![0, 1].includes(upstream.exitCode) || ![0, 1].includes(merge.exitCode)) {
        return fail(409, 'push-failed', '无法读取推送配置。')
      }
      const remotes = listed.stdout.trim().split('\n').filter(Boolean)
      const setUpstream = upstream.exitCode !== 0 || merge.exitCode !== 0
      const remote = setUpstream ? await resolvePushRemote(repoRoot, branch, remotes, signal) : upstream.stdout.trim()
      if (!remote || (!remotes.includes(remote) && !(remote === '.' && !setUpstream))) {
        return fail(409, 'push-failed', '推送目标不是已配置的远程仓库。')
      }
      const target = setUpstream ? `refs/heads/${branch}` : merge.stdout.trim()
      if (!target.startsWith('refs/heads/') || (await git.run(repoRoot, ['check-ref-format', target], { signal })).exitCode !== 0) {
        return fail(409, 'push-failed', '上游分支配置无效。')
      }
      return { ok: true, target: { remote, branch: target.slice('refs/heads/'.length), setUpstream } }
    } catch (error) {
      if (signal?.aborted) throw error
      return fail(409, 'push-failed', '无法读取推送配置。')
    }
  }

  async function resolvePushRemote(repoRoot, branch, remotes, signal) {
    if (remotes.length === 0) return null
    for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault']) {
      const configured = await git.run(repoRoot, ['config', '--get', key], { signal })
      if (configured.exitCode === 0) return configured.stdout.trim()
      if (configured.exitCode !== 1) return null
    }
    if (remotes.length === 1) return remotes[0]
    return remotes.includes('origin') ? 'origin' : null
  }
}

/** 提取文本最后 N 行非空尾部，供钩子或推送失败时返回详细说明。 */
function tailLines(text, maxLines) {
  const lines = String(text ?? '').split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines.slice(-maxLines).join('\n')
}

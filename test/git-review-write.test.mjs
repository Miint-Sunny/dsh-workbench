/**
 * 审阅面板宿主（写操作与安全护栏）测试：
 * - 按块、按文件、按整个范围的暂存与取消暂存（含未跟踪、无末尾换行、重命名、删除、空仓库）
 * - 按块、按文件、按整个范围的回退与撤销（含权限位保留、未跟踪移进废纸篓与取回、uncommitted 还原暂存区和工作区）
 * - 第 7 节安全护栏：过时 version、index.lock、并发 busy、会话运行中拒绝回退放行暂存、冲突文件、越界路径/符号链接、备份隔离与修剪、钩子不执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import { parseGitReviewConfig } from '../lib/git-review/config.js'
import { createGitReviewGit } from '../lib/git-review/git.js'
import { createGitReviewStore } from '../lib/git-review/store.js'
import { createGitReviewService } from '../lib/git-review/service.js'

const write = (path, content) => writeFile(path, content, typeof content === 'string' ? 'utf8' : undefined)

async function mustGit(cwd, args, options) {
  const result = await runGit(cwd, args, options)
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

async function commitAll(repo, msg) {
  await mustGit(repo, ['add', '-A'])
  await mustGit(repo, [...COMMIT_IDENTITY, 'commit', '-qm', msg])
  return (await mustGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
}

async function setupWriteEnv(overrides = {}) {
  const root = await tempDir('dwb-gr-write-')
  const dataDir = join(root, 'dsh-workbench', 'git-review')
  const reviewDir = join(root, 'dsh-workbench', 'review')
  const trashDir = join(root, 'trash')
  const home = join(root, 'git-home')
  await mkdir(home, { recursive: true })
  await mkdir(reviewDir, { recursive: true })
  const subprocess = createLocalSubprocess({ home })
  let running = false
  const foldersMap = new Map()
  const config = parseGitReviewConfig({
    gitReviewDataDir: dataDir,
    trashDir,
    ...overrides,
  })
  const git = createGitReviewGit({
    subprocess,
    dataDir,
    timeoutMs: config.gitTimeoutMs,
    maxDiffBytes: config.maxDiffBytes,
  })
  const store = createGitReviewStore(dataDir)
  const service = createGitReviewService({
    config,
    git,
    store,
    isRunning: () => running,
    foldersOf: async (sessionId) => foldersMap.get(sessionId),
  })
  return {
    root,
    dataDir,
    reviewDir,
    trashDir,
    git,
    store,
    service,
    setRunning: (val) => { running = val },
    setFolders: (id, dirs) => foldersMap.set(id, dirs),
  }
}

test('stage 与 unstage：按块、按文件、整个范围（含多块、未跟踪无末尾换行、重命名、空仓库）', async () => {
  const { root, service, setFolders } = await setupWriteEnv()
  const repo = join(root, 'repo')
  const empty = join(root, 'empty')
  await mkdir(repo, { recursive: true })
  await mkdir(empty, { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])
  await mustGit(empty, ['init', '-b', 'main'])

  const baseLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
  await write(join(repo, 'multi.txt'), baseLines)
  await write(join(repo, 'old.txt'), 'row1\nrow2\nrow3\nrow4\nrow5\nrow6\n')
  await commitAll(repo, 'init')

  // multi.txt 改两处（分开成为 2 个 hunk）
  const editedLines = baseLines
    .replace('line-2\n', 'line-2-changed\n')
    .replace('line-18\n', 'line-18-changed\n')
  await write(join(repo, 'multi.txt'), editedLines)
  // 未跟踪且无末尾换行
  await write(join(repo, 'noeol.txt'), 'alpha\nbeta')

  setFolders('s1', [repo, empty])
  const st = await service.status('s1')
  const repoId = st.repos[0].id
  const emptyId = st.repos[1].id

  // 1. 按块暂存 multi.txt 的第 1 块
  let uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  const multi = uDiff.files.find(f => f.path === 'multi.txt')
  assert.equal(multi.hunks.length, 2)
  const resH0 = await service.stage({
    sessionId: 's1',
    repo: repoId,
    scope: 'unstaged',
    version: uDiff.version,
    path: 'multi.txt',
    hunk: multi.hunks[0].id,
  })
  assert.deepEqual(resH0, { ok: true })

  let sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(sDiff.files.find(f => f.path === 'multi.txt').hunks.length, 1)
  assert.ok(sDiff.files[0].hunks[0].lines.some(l => l.text === 'line-2-changed'))

  uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  assert.equal(uDiff.files.find(f => f.path === 'multi.txt').hunks.length, 1)
  assert.ok(uDiff.files.find(f => f.path === 'multi.txt').hunks[0].lines.some(l => l.text === 'line-18-changed'))

  // 2. 按块暂存未跟踪且无末尾换行的文件 noeol.txt
  const resUntrackedHunk = await service.stage({
    sessionId: 's1',
    repo: repoId,
    scope: 'unstaged',
    version: uDiff.version,
    path: 'noeol.txt',
    hunk: 'h0',
  })
  assert.deepEqual(resUntrackedHunk, { ok: true })
  sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(sDiff.files.find(f => f.path === 'noeol.txt').status, 'added')

  // 3. 按块取消暂存新加文件 noeol.txt（staged -> h0）
  const resUnstageNew = await service.unstage({
    sessionId: 's1',
    repo: repoId,
    scope: 'staged',
    version: sDiff.version,
    path: 'noeol.txt',
    hunk: 'h0',
  })
  assert.deepEqual(resUnstageNew, { ok: true })
  uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  assert.equal(uDiff.files.find(f => f.path === 'noeol.txt').status, 'untracked')

  // 4. 整个范围全部暂存 & 全部取消暂存
  const stageAll = await service.stage({
    sessionId: 's1',
    repo: repoId,
    scope: 'unstaged',
    version: uDiff.version,
  })
  assert.deepEqual(stageAll, { ok: true })
  uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  assert.equal(uDiff.files.length, 0)

  sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(sDiff.files.length, 2)
  const unstageAll = await service.unstage({
    sessionId: 's1',
    repo: repoId,
    scope: 'staged',
    version: sDiff.version,
  })
  assert.deepEqual(unstageAll, { ok: true })
  sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(sDiff.files.length, 0)

  // 5. 重命名+修改后，按块取消暂存只回退修改部分保留重命名；按文件取消暂存则还原整个重命名
  await mustGit(repo, ['mv', 'old.txt', 'renamed.txt'])
  await write(join(repo, 'renamed.txt'), 'row1\nrow2-edited\nrow3\nrow4\nrow5\nrow6\n')
  await mustGit(repo, ['add', 'renamed.txt'])
  sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  const ren = sDiff.files.find(f => f.path === 'renamed.txt')
  assert.equal(ren.status, 'renamed')
  assert.equal(ren.hunks.length, 1)
  const unstageRenHunk = await service.unstage({
    sessionId: 's1',
    repo: repoId,
    scope: 'staged',
    version: sDiff.version,
    path: 'renamed.txt',
    hunk: ren.hunks[0].id,
  })
  assert.deepEqual(unstageRenHunk, { ok: true })
  sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(sDiff.files.find(f => f.path === 'renamed.txt').status, 'renamed')
  assert.equal(sDiff.files.find(f => f.path === 'renamed.txt').hunks.length, 0)

  const unstageRenFile = await service.unstage({
    sessionId: 's1',
    repo: repoId,
    scope: 'staged',
    version: sDiff.version,
    path: 'renamed.txt',
  })
  assert.deepEqual(unstageRenFile, { ok: true })
  sDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(sDiff.files.some(f => f.path === 'renamed.txt'), false)

  // 6. 空仓库取消暂存（按文件与整个范围）
  await write(join(empty, 'first.txt'), 'one\n')
  let eUnstaged = await service.diff({ sessionId: 's1', repo: emptyId, scope: 'unstaged' })
  assert.deepEqual(await service.stage({ sessionId: 's1', repo: emptyId, scope: 'unstaged', version: eUnstaged.version, path: 'first.txt' }), { ok: true })
  let eStaged = await service.diff({ sessionId: 's1', repo: emptyId, scope: 'staged' })
  assert.equal(eStaged.files.length, 1)
  assert.deepEqual(await service.unstage({ sessionId: 's1', repo: emptyId, scope: 'staged', version: eStaged.version, path: 'first.txt' }), { ok: true })
  eStaged = await service.diff({ sessionId: 's1', repo: emptyId, scope: 'staged' })
  assert.equal(eStaged.files.length, 0)
})

test('revert 与 undo：按块、按文件、整个范围、权限位、未跟踪移入废纸篓、uncommitted 还原暂存区和工作区', async () => {
  const { root, dataDir, reviewDir, trashDir, store, service, setFolders } = await setupWriteEnv()
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])

  const baseLines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
  await write(join(repo, 'script.sh'), baseLines)
  await chmod(join(repo, 'script.sh'), 0o755)
  await write(join(repo, 'mix.txt'), 'a\nb\n')
  await commitAll(repo, 'init')

  // 在 review/ 放一个文件确认 Git 审阅修剪不会碰它
  await write(join(reviewDir, 'unrelated.json'), '{"keep":true}\n')

  setFolders('s1', [repo])
  const st = await service.status('s1')
  const repoId = st.repos[0].id

  // 1. 按块回退并撤销（同时改了 0o755 文件的两处，只回退一处再撤销）
  const modContent = baseLines.replace('l2\n', 'L2\n').replace('l18\n', 'L18\n')
  await write(join(repo, 'script.sh'), modContent)
  let uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  const revH0 = await service.revert({
    sessionId: 's1',
    repo: repoId,
    scope: 'unstaged',
    version: uDiff.version,
    path: 'script.sh',
    hunk: 'h0',
  })
  assert.equal(revH0.ok, true)
  assert.ok(revH0.undoId)
  assert.equal(await readFile(join(repo, 'script.sh'), 'utf8'), baseLines.replace('l18\n', 'L18\n'))

  // 回退后若人为修改过文件，undo 必须因内容对不上而拒绝（stale）
  await write(join(repo, 'script.sh'), baseLines.replace('l18\n', 'L18-dirty\n'))
  const badUndo = await service.undo({ sessionId: 's1', repo: repoId, undoId: revH0.undoId })
  assert.equal(badUndo.ok, false)
  assert.equal(badUndo.code, 'stale')

  // 恢复回退后一模一样的内容，undo 成功并保留 0o755 权限
  await write(join(repo, 'script.sh'), baseLines.replace('l18\n', 'L18\n'))
  const okUndo = await service.undo({ sessionId: 's1', repo: repoId, undoId: revH0.undoId })
  assert.deepEqual(okUndo, { ok: true })
  assert.equal(await readFile(join(repo, 'script.sh'), 'utf8'), modContent)
  assert.equal((await stat(join(repo, 'script.sh'))).mode & 0o777, 0o755)

  // 2. 未跟踪文件回退 -> 移入废纸篓（不直接删除），撤销 -> 取回
  await write(join(repo, 'scratch.txt'), 'keep me safe\n')
  uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  const revUntracked = await service.revert({
    sessionId: 's1',
    repo: repoId,
    scope: 'unstaged',
    version: uDiff.version,
    path: 'scratch.txt',
  })
  assert.equal(revUntracked.ok, true)
  assert.equal(existsSync(join(repo, 'scratch.txt')), false)
  const trashedItems = await readdir(trashDir)
  assert.equal(trashedItems.length, 1)
  assert.equal(await readFile(join(trashDir, trashedItems[0]), 'utf8'), 'keep me safe\n')

  assert.deepEqual(await service.undo({ sessionId: 's1', repo: repoId, undoId: revUntracked.undoId }), { ok: true })
  assert.equal(await readFile(join(repo, 'scratch.txt'), 'utf8'), 'keep me safe\n')
  assert.equal((await readdir(trashDir)).length, 0)

  // 3. 整个 unstaged 范围回退（同时包含 tracked 与 untracked）并撤销
  uDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  const revAll = await service.revert({
    sessionId: 's1',
    repo: repoId,
    scope: 'unstaged',
    version: uDiff.version,
  })
  assert.equal(revAll.ok, true)
  assert.equal(await readFile(join(repo, 'script.sh'), 'utf8'), baseLines)
  assert.equal(existsSync(join(repo, 'scratch.txt')), false)
  assert.deepEqual(await service.undo({ sessionId: 's1', repo: repoId, undoId: revAll.undoId }), { ok: true })
  assert.equal(await readFile(join(repo, 'script.sh'), 'utf8'), modContent)
  assert.equal(await readFile(join(repo, 'scratch.txt'), 'utf8'), 'keep me safe\n')

  // 4. uncommitted 整文件回退回到 HEAD（暂存区 + 工作区一起回退），撤销时连暂存区状态一并恢复
  await write(join(repo, 'mix.txt'), 'a\nb-staged\n')
  await mustGit(repo, ['add', 'mix.txt'])
  await write(join(repo, 'mix.txt'), 'a\nb-worktree\n')
  const cDiff = await service.diff({ sessionId: 's1', repo: repoId, scope: 'uncommitted' })
  const revMixed = await service.revert({
    sessionId: 's1',
    repo: repoId,
    scope: 'uncommitted',
    version: cDiff.version,
    path: 'mix.txt',
  })
  assert.equal(revMixed.ok, true)
  assert.equal(await readFile(join(repo, 'mix.txt'), 'utf8'), 'a\nb\n')
  assert.equal((await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })).files.length, 0)
  assert.equal((await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })).files.some(f => f.path === 'mix.txt'), false)

  assert.deepEqual(await service.undo({ sessionId: 's1', repo: repoId, undoId: revMixed.undoId }), { ok: true })
  assert.equal(await readFile(join(repo, 'mix.txt'), 'utf8'), 'a\nb-worktree\n')
  const restoredStaged = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(restoredStaged.files.length, 1)
  assert.ok(restoredStaged.files[0].hunks[0].lines.some(l => l.text === 'b-staged'))

  // 5. 备份存储独立性与按天修剪（不碰 review/ 目录）
  await write(join(dataDir, 'corrupt.json'), '{bad json')
  await store.save({
    kind: 'git-review-revert',
    undoId: '00000000-0000-4000-8000-000000000001',
    sessionId: 's1',
    repoId,
    repoRoot: repo,
    scope: 'unstaged',
    entries: [],
  })
  await store.prune(Date.now() + 1000)
  assert.equal(existsSync(join(dataDir, 'corrupt.json')), true)
  assert.equal(existsSync(join(dataDir, '00000000-0000-4000-8000-000000000001.json')), false)
  assert.equal(existsSync(join(reviewDir, 'unrelated.json')), true)
})

async function writeFixture(options = {}) {
  const env = await setupWriteEnv(options)
  const repo = join(env.root, 'repo')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await write(join(repo, 'a.txt'), 'one\n')
  await commitAll(repo, 'base')
  await write(join(repo, 'a.txt'), 'two\n')
  env.setFolders('s1', [repo])
  const repoId = (await env.service.status('s1')).repos[0].id
  const base = { sessionId: 's1', repo: repoId }
  async function params(scope = 'unstaged', path = 'a.txt') {
    const { version } = await env.service.diff({ ...base, scope })
    return { ...base, scope, path, version }
  }
  return { ...env, repo, base, params }
}

test('a stale version preserves the working file and the index', async () => {
  const { service, repo, params } = await writeFixture()
  const observed = await params()
  await write(join(repo, 'a.txt'), 'later\n')
  for (const op of ['stage', 'revert']) {
    assert.equal((await service[op](observed)).code, 'stale')
  }
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'later\n')
  assert.equal((await mustGit(repo, ['show', ':a.txt'])).stdout, 'one\n')
})

test('index.lock is reported and remains owned by its creator', async () => {
  const { service, repo, params } = await writeFixture()
  const observed = await params()
  const lock = join(repo, '.git', 'index.lock')
  await write(lock, 'owner')
  assert.equal((await service.stage(observed)).code, 'locked')
  assert.equal(await readFile(lock, 'utf8'), 'owner')
})

test('an active turn allows index edits and refuses revert and undo', async () => {
  const { service, setRunning, base, params, repo } = await writeFixture()
  const reverted = await service.revert(await params())
  setRunning(true)
  assert.equal((await service.undo({ ...base, undoId: reverted.undoId })).code, 'running')
  await write(join(repo, 'a.txt'), 'edited\n')
  const observed = await params()
  assert.equal((await service.revert(observed)).code, 'running')
  assert.equal((await service.stage(observed)).ok, true)
  assert.equal((await service.unstage(await params('staged'))).ok, true)
})

test('overlapping writes to one repository return busy', async () => {
  const { service, params } = await writeFixture()
  const observed = await params()
  const pair = await Promise.all([service.stage(observed), service.stage(observed)])
  assert.deepEqual(pair.map(r => r.ok ? 'ok' : r.code).sort(), ['busy', 'ok'])
})

test('a conflicting path blocks file and scope mutations', async () => {
  const { service, repo, params } = await writeFixture()
  await mustGit(repo, ['checkout', '-b', 'side'])
  await commitAll(repo, 'side')
  await mustGit(repo, ['checkout', 'main'])
  await write(join(repo, 'a.txt'), 'three\n')
  await commitAll(repo, 'main')
  assert.notEqual((await runGit(repo, ['merge', 'side'])).exitCode, 0)
  const observed = await params()
  assert.equal((await service.stage(observed)).code, 'conflict')
  assert.equal((await service.revert({ ...observed, path: undefined })).code, 'conflict')
})

test('a file outside the displayed diff cannot be selected', async () => {
  const { service, params } = await writeFixture()
  assert.equal((await service.stage(await params('unstaged', 'other.txt'))).code, 'not-found')
})

test('invalid repository paths are rejected before selection', async () => {
  const { service, params } = await writeFixture()
  const observed = await params()
  for (const path of ['../other', 'sub/../../other', '/other', 'a\\b']) {
    assert.equal((await service.stage({ ...observed, path })).code, 'bad-request')
  }
})

test('outward and dangling symlinks are rejected for individual and whole-scope writes', async () => {
  const { service, repo, params, root } = await writeFixture()
  const outside = join(root, 'unrelated.txt')
  await write(outside, 'independent\n')
  await symlink(outside, join(repo, 'first-link'))
  await symlink(join(root, 'missing'), join(repo, 'missing-link'))
  const observed = await params()
  for (const path of ['first-link', 'missing-link', undefined]) {
    assert.equal((await service.stage({ ...observed, path })).code, 'bad-request')
  }
  assert.equal((await mustGit(repo, ['show', ':a.txt'])).stdout, 'one\n')
})

test('revert leaves the working file intact when its backup would exceed the limit', async () => {
  const { service, repo, params } = await writeFixture({ maxBackupBytes: 4 })
  await write(join(repo, 'a.txt'), 'too long')
  assert.equal((await service.revert(await params())).code, 'too-large')
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'too long')
})

test('non-commit writes leave repository hooks disabled', async () => {
  const { service, repo, root, params, base } = await writeFixture()
  const hook = join(repo, '.git', 'hooks', 'post-index-change')
  const marker = join(root, 'index-hook')
  await write(hook, '#!/bin/sh\ntouch "' + marker + '"\n')
  await chmod(hook, 0o755)
  assert.equal((await service.stage(await params())).ok, true)
  assert.equal((await service.unstage(await params('staged'))).ok, true)
  const { undoId } = await service.revert(await params())
  assert.equal((await service.undo({ ...base, undoId })).ok, true)
  assert.equal(existsSync(marker), false)
  await mustGit(repo, ['add', '--', 'a.txt'])
  assert.equal(existsSync(marker), true, 'plain Git invokes this repository hook')
})

test('revert preflights the restored file size before replacing working content', async () => {
  const { service, repo, params } = await writeFixture({ maxBackupBytes: 4 })
  await write(join(repo, 'a.txt'), 'large committed version\n')
  await commitAll(repo, 'larger')
  await write(join(repo, 'a.txt'), 'new\n')
  assert.equal((await service.revert(await params())).code, 'too-large')
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'new\n')
})

test('the working edit survives a failure to persist the undo record', async () => {
  const { service, store, repo, params } = await writeFixture()
  store.save = async () => { throw new Error('storage unavailable') }
  await assert.rejects(service.revert(await params()), /storage unavailable/)
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'two\n')
})

test('an edit made while the backup is saved survives revert', async () => {
  const { service, store, repo, params } = await writeFixture()
  const save = store.save.bind(store)
  store.save = async record => {
    await save(record)
    await write(join(repo, 'a.txt'), 'later\n')
  }
  assert.equal((await service.revert(await params())).code, 'stale')
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'later\n')
})

test('a concurrent edit during git add is never published to the index', async () => {
  const { git, service, repo, params } = await writeFixture()
  const observed = await params()
  const run = git.run.bind(git)
  git.run = async (cwd, args, options) => {
    if (args.includes('add')) await write(join(repo, 'a.txt'), 'later\n')
    return run(cwd, args, options)
  }
  assert.equal((await service.stage(observed)).code, 'stale')
  assert.equal((await mustGit(repo, ['show', ':a.txt'])).stdout, 'one\n')
})

test('undo backs up arbitrary staged blob bytes without UTF-8 transcoding', async () => {
  const { store, service, repo, params, base } = await writeFixture()
  const original = Buffer.from([0, 0xff, 0x80, 0x62])
  await write(join(repo, 'a.txt'), original)
  await mustGit(repo, ['add', 'a.txt'])
  const before = (await mustGit(repo, ['rev-parse', ':a.txt'])).stdout.trim()
  await write(join(repo, 'a.txt'), 'working\n')
  const { undoId } = await service.revert(await params('uncommitted'))
  assert.deepEqual(Buffer.from((await store.load(undoId)).entries[0].indexBefore.base64, 'base64'), original)
  await mustGit(repo, ['prune', '--expire=now'])
  assert.equal((await service.undo({ ...base, undoId })).ok, true)
  assert.equal((await mustGit(repo, ['rev-parse', ':a.txt'])).stdout.trim(), before)
})

test('undo refuses an edited trash item', async () => {
  const { service, repo, params, base, trashDir } = await writeFixture()
  await write(join(repo, 'note'), 'keep')
  const { undoId } = await service.revert(await params('unstaged', 'note'))
  await write(join(trashDir, (await readdir(trashDir))[0]), 'changed')
  assert.equal((await service.undo({ ...base, undoId })).code, 'stale')
  assert.equal(existsSync(join(repo, 'note')), false)
})

test('an unborn index entry can be unstaged after the working copy has changed', async () => {
  const env = await setupWriteEnv()
  const repo = join(env.root, 'unborn')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await write(join(repo, 'note'), 'first')
  await mustGit(repo, ['add', 'note'])
  await write(join(repo, 'note'), 'second')
  env.setFolders('s1', [repo])
  const base = { sessionId: 's1', repo: (await env.service.status('s1')).repos[0].id, scope: 'staged' }
  const { version } = await env.service.diff(base)
  assert.equal((await env.service.unstage({ ...base, version, path: 'note' })).ok, true)
  assert.equal(await readFile(join(repo, 'note'), 'utf8'), 'second')
})

test('an undo record belongs to its file name and recorded root', async () => {
  const { service, store, base, params, dataDir } = await writeFixture()
  const { undoId } = await service.revert(await params())
  const record = await store.load(undoId)
  await write(join(dataDir, undoId + '.json'), JSON.stringify({ ...record, undoId: '00000000-0000-4000-8000-000000000456' }))
  assert.equal(await store.load(undoId), undefined)
  await store.save({ ...record, repoRoot: 'retired worktree' })
  assert.equal((await service.undo({ ...base, undoId })).code, 'not-found')
})

test('undo leaves all files in place when a later restore cannot proceed', async () => {
  const { service, repo, base, params, git } = await writeFixture()
  await write(join(repo, 'a.txt'), 'staged')
  await mustGit(repo, ['add', 'a.txt'])
  await write(join(repo, 'a.txt'), 'work')
  const { undoId } = await service.revert(await params('uncommitted'))
  const run = git.run.bind(git)
  git.run = async (cwd, args, options) => {
    if (args.includes('update-index')) throw new Error('index unavailable')
    return run(cwd, args, options)
  }
  await assert.rejects(service.undo({ ...base, undoId }), /index unavailable/)
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\n')
  git.run = run
  assert.equal((await service.undo({ ...base, undoId })).ok, true)
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'work')
})

test('prune reserves unrelated JSON files in a shared data directory', async () => {
  const { dataDir, store } = await setupWriteEnv()
  await mkdir(dataDir, { recursive: true })
  await write(join(dataDir, 'preferences.json'), '{incomplete')
  await store.prune(Date.now())
  assert.equal(await readFile(join(dataDir, 'preferences.json'), 'utf8'), '{incomplete')
})

test('undo preserves a legacy trash item without an identity fingerprint', async () => {
  const { service, repo, base, params, store, trashDir } = await writeFixture()
  await write(join(repo, 'note'), 'keep')
  const { undoId } = await service.revert(await params('unstaged', 'note'))
  const record = await store.load(undoId)
  delete record.entries[0].fingerprint
  await store.save(record)
  assert.equal((await service.undo({ ...base, undoId })).code, 'stale')
  assert.equal(existsSync(join(repo, 'note')), false)
  assert.equal(await readFile(join(trashDir, (await readdir(trashDir))[0]), 'utf8'), 'keep')
})

test('staging publishes only reviewed bytes when an editor rewrites then restores a file', async () => {
  const { git, service, repo, params } = await writeFixture()
  const observed = await params()
  const run = git.run.bind(git)
  git.run = async (cwd, args, options) => {
    if (!args.includes('add')) return run(cwd, args, options)
    await write(join(repo, 'a.txt'), 'transient\n')
    const result = await run(cwd, args, options)
    await write(join(repo, 'a.txt'), 'two\n')
    return result
  }
  const result = await service.stage(observed)
  const staged = (await mustGit(repo, ['show', ':a.txt'])).stdout
  assert.ok(result.ok ? staged === 'two\n' : result.code === 'stale' && staged === 'one\n')
})

test('a checked-out internal symlink is validated against its real repository', async () => {
  const { service, repo, base, params } = await writeFixture()
  await write(join(repo, 'neighbor'), 'neighbor bytes')
  await symlink('neighbor', join(repo, 'alias'))
  await commitAll(repo, 'internal link')
  await (await import('node:fs/promises')).rename(join(repo, 'alias'), join(repo, 'other-alias'))
  await write(join(repo, 'alias'), 'edited')
  const reverted = await service.revert(await params('unstaged', 'alias'))
  assert.equal(reverted.ok, true)
  assert.equal((await lstat(join(repo, 'alias'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(repo, 'alias'), 'utf8'), 'neighbor bytes')
  assert.equal((await service.undo({ ...base, undoId: reverted.undoId })).ok, true)
  assert.equal(await readFile(join(repo, 'alias'), 'utf8'), 'edited')
})

test('undo restores all saved permission bits on a tracked file', { skip: process.platform === 'win32' }, async () => {
  const { service, repo, params, base } = await writeFixture()
  await chmod(join(repo, 'a.txt'), 0o1755)
  const { undoId } = await service.revert(await params())
  assert.equal((await service.undo({ ...base, undoId })).ok, true)
  assert.equal((await stat(join(repo, 'a.txt'))).mode & 0o7777, 0o1755)
})

test('scope revert and undo keep an untracked internal link together with its target', async () => {
  const { service, repo, base, params } = await writeFixture()
  await write(join(repo, 'b-target'), 'neighbor')
  await symlink('b-target', join(repo, 'z-link'))
  const reverted = await service.revert({ ...await params(), path: undefined })
  assert.equal(reverted.ok, true)
  assert.equal(existsSync(join(repo, 'b-target')), false)
  assert.equal((await service.undo({ ...base, undoId: reverted.undoId })).ok, true)
  assert.equal((await lstat(join(repo, 'z-link'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(repo, 'z-link'), 'utf8'), 'neighbor')
})

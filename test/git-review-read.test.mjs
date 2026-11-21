/**
 * 审阅面板宿主（只读部分）测试：配置校验、差异解析、多仓库发现、分支与提交链查询、
 * 四种 Git 范围（unstaged / staged / uncommitted / branch）及空仓库、未跟踪、重命名、
 * 二进制、超大文件、内容过滤器/外部 diff/钩子不执行、version 变化检测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import {
  DEFAULT_GIT_REVIEW_CONFIG,
  gitReviewDataDir,
  gitReviewTrashDir,
  parseGitReviewConfig,
} from '../lib/git-review/config.js'
import { assertPathInsideRepo, createGitReviewGit, safeRelativePath } from '../lib/git-review/git.js'
import { parseDiffRaw, parseUnifiedDiff, readUntrackedFileDiff, stripInternalFields } from '../lib/git-review/diff.js'
import { discoverRepos } from '../lib/git-review/repos.js'
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
  const head = await mustGit(repo, ['rev-parse', 'HEAD'])
  return head.stdout.trim()
}

async function setupService(overrides = {}) {
  const root = await tempDir('dwb-gr-read-')
  const dataDir = join(root, 'git-review-data')
  const trashDir = join(root, 'trash')
  const home = join(root, 'git-home')
  await mkdir(home, { recursive: true })
  const subprocess = createLocalSubprocess({ home })
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
  const service = createGitReviewService({
    config,
    git,
    isRunning: () => false,
    foldersOf: async (sessionId) => foldersMap.get(sessionId),
  })
  return { root, dataDir, trashDir, git, service, setFolders: (id, dirs) => foldersMap.set(id, dirs) }
}

test('config：默认值与合法配置通过，未知字段或非法值拒绝加载', () => {
  const def = parseGitReviewConfig()
  assert.equal(def.keepDays, DEFAULT_GIT_REVIEW_CONFIG.keepDays)
  assert.equal(def.maxFileBytes, DEFAULT_GIT_REVIEW_CONFIG.maxFileBytes)
  assert.equal(def.maxDiffBytes, DEFAULT_GIT_REVIEW_CONFIG.maxDiffBytes)
  assert.equal(def.maxBackupBytes, DEFAULT_GIT_REVIEW_CONFIG.maxBackupBytes)
  assert.equal(def.maxCommitDiffBytes, DEFAULT_GIT_REVIEW_CONFIG.maxCommitDiffBytes)
  assert.equal(def.maxCommits, DEFAULT_GIT_REVIEW_CONFIG.maxCommits)
  assert.equal(def.gitTimeoutMs, DEFAULT_GIT_REVIEW_CONFIG.gitTimeoutMs)
  assert.equal(def.commitModel, null)

  const custom = parseGitReviewConfig({
    keepDays: 7,
    maxFileBytes: 1024,
    maxDiffBytes: 4096,
    maxBackupBytes: 8192,
    maxCommitDiffBytes: 2048,
    maxCommits: 50,
    gitTimeoutMs: 5000,
    commitModel: 'deepseek-chat',
    locale: 'en',
  })
  assert.equal(custom.keepDays, 7)
  assert.equal(custom.commitModel, 'deepseek-chat')
  assert.equal(custom.locale, 'en')

  for (const bad of [
    null,
    [],
    'str',
    { unknownField: 1 },
    { maxFileBytes: 0 },
    { maxFileBytes: -1 },
    { maxFileBytes: 1.5 },
    { maxDiffBytes: '100' },
    { maxBackupBytes: 0 },
    { maxCommitDiffBytes: 0 },
    { maxCommits: 0 },
    { gitTimeoutMs: -5 },
    { keepDays: 0 },
    { commitModel: '' },
    { commitModel: '   ' },
    { commitModel: 'x'.repeat(129) },
    { locale: 'fr' },
  ]) {
    assert.throws(() => parseGitReviewConfig(bad), JSON.stringify(bad))
  }

  assert.equal(gitReviewDataDir({ gitReviewDataDir: '/tmp/custom-gr' }, { DSH_HOME: '/tmp/h' }), '/tmp/custom-gr')
  assert.equal(gitReviewDataDir({}, { DSH_HOME: '/tmp/h' }), join('/tmp/h', 'dsh-workbench', 'git-review'))
  assert.equal(gitReviewDataDir({ dataDir: '/tmp/h/review' }, {}), join('/tmp/h', 'git-review'))
  assert.equal(gitReviewTrashDir({ trashDir: '/tmp/my-trash' }), '/tmp/my-trash')
})

test('diff 解析：raw 与 unified diff（含内容似 diff 头、无末尾换行、单行省略计数、二进制）', () => {
  const raw = [
    ':100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0src/a.js\0',
    ':100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100\0old name.js\0new name.js\0',
    ':000000 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 A\0added.txt\0',
    ':100644 000000 4444444444444444444444444444444444444444 0000000000000000000000000000000000000000 D\0gone.txt\0',
  ].join('')
  assert.deepEqual(parseDiffRaw(raw), [
    { oldMode: '100644', newMode: '100644', oldSha: '1111111111111111111111111111111111111111', newSha: '2222222222222222222222222222222222222222', status: 'modified', path: 'src/a.js' },
    { oldMode: '100644', newMode: '100644', oldSha: '1111111111111111111111111111111111111111', newSha: '2222222222222222222222222222222222222222', status: 'renamed', oldPath: 'old name.js', path: 'new name.js' },
    { oldMode: '000000', newMode: '100644', oldSha: '0000000000000000000000000000000000000000', newSha: '3333333333333333333333333333333333333333', status: 'added', path: 'added.txt' },
    { oldMode: '100644', newMode: '000000', oldSha: '4444444444444444444444444444444444444444', newSha: '0000000000000000000000000000000000000000', status: 'deleted', path: 'gone.txt' },
  ])

  // 文件内容本身包含 "@@ " 或 "diff --git " 开头的行时，解析器必须按 hunk 行数计数，不能被正文里的伪头打断。
  const patch = [
    'diff --git a/tricky.md b/tricky.md',
    'index 1111111..2222222 100644',
    '--- a/tricky.md',
    '+++ b/tricky.md',
    '@@ -1 +1,3 @@',
    '-old',
    '+diff --git a/fake b/fake',
    '+@@ -99 +99 @@',
    '+end',
    '\\ No newline at end of file',
    'diff --git a/img.bin b/img.bin',
    'new file mode 100644',
    'index 0000000..abcdef1',
    'Binary files /dev/null and b/img.bin differ',
    '',
  ].join('\n')

  const parsed = parseUnifiedDiff(patch)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].path, 'tricky.md')
  assert.equal(parsed[0].hunks.length, 1)
  assert.equal(parsed[0].hunks[0].oldStart, 1)
  assert.equal(parsed[0].hunks[0].oldLines, 1)
  assert.equal(parsed[0].hunks[0].newStart, 1)
  assert.equal(parsed[0].hunks[0].newLines, 3)
  assert.deepEqual(parsed[0].hunks[0].lines, [
    { kind: 'delete', old: 1, text: 'old' },
    { kind: 'add', new: 1, text: 'diff --git a/fake b/fake' },
    { kind: 'add', new: 2, text: '@@ -99 +99 @@' },
    { kind: 'add', new: 3, text: 'end' },
  ])
  const clean = stripInternalFields({ ...parsed[0], status: 'modified', tooLarge: false })
  assert.deepEqual(Object.keys(clean).sort(), ['added', 'binary', 'deleted', 'hunks', 'path', 'status', 'tooLarge'])
  assert.equal(clean.added, 3)
  assert.equal(clean.deleted, 1)
  assert.equal(parsed[1].binary, true)
  assert.deepEqual(parsed[1].hunks, [])
})

test('多仓库发现与状态：git 仓库、非 git 目录、同仓库去重、重名区分、游离 HEAD、空仓库、冲突与计数', async () => {
  const { root, service, setFolders } = await setupService()
  const repoA = join(root, 'repos-one', 'app')
  const repoB = join(root, 'repos-two', 'app')
  const nonGit = join(root, 'notes')
  const bare = join(root, 'remote.git')
  await mkdir(join(repoA, 'sub'), { recursive: true })
  await mkdir(repoB, { recursive: true })
  await mkdir(nonGit, { recursive: true })
  await mustGit(root, ['init', '--bare', bare])
  await mustGit(repoA, ['init', '-b', 'main'])
  await mustGit(repoB, ['init', '-b', 'main'])

  // repoB 刚 init，空仓库还没有提交
  setFolders('s-multi', [repoA, join(repoA, 'sub'), repoB, nonGit])

  await write(join(repoA, 'a.txt'), 'one\n')
  await commitAll(repoA, 'init a')
  await mustGit(repoA, ['remote', 'add', 'origin', bare])
  await mustGit(repoA, ['push', '-u', 'origin', 'main'])
  // 本地再领先 1 个提交
  await write(join(repoA, 'a.txt'), 'two\n')
  const sha2 = await commitAll(repoA, 'ahead commit')
  // repoA 再加已暂存 + 未暂存 + 未跟踪，且一个文件在暂存区和工作区互相抵消（staged 后改回 HEAD）
  await write(join(repoA, 'staged.txt'), 's\n')
  await mustGit(repoA, ['add', 'staged.txt'])
  await write(join(repoA, 'a.txt'), 'three\n')
  await mustGit(repoA, ['add', 'a.txt'])
  await write(join(repoA, 'a.txt'), 'two\n') // 工作区改回 HEAD，所以 uncommitted 里不含 a.txt！
  await write(join(repoA, 'untracked.txt'), 'u\n')

  const st = await service.status('s-multi')
  assert.equal(st.ok, true)
  assert.equal(st.running, false)
  // repoA 与 repoA/sub 属于同一个仓库，应该去重为 1 个；加上 repoB 和 nonGit 共 3 个
  assert.equal(st.repos.length, 3)

  const aInfo = st.repos[0]
  const bInfo = st.repos[1]
  const nInfo = st.repos[2]

  assert.equal(aInfo.kind, 'git')
  assert.equal(aInfo.branch, 'main')
  assert.equal(aInfo.head, sha2.slice(0, 7))
  assert.equal(aInfo.detached, false)
  assert.equal(aInfo.upstream, 'origin/main')
  assert.equal(aInfo.remoteBranchMissing, false)
  assert.equal(aInfo.ahead, 1)
  assert.equal(aInfo.behind, 0)
  assert.equal(aInfo.conflicts, 0)
  assert.deepEqual(aInfo.counts, { unstaged: 2, staged: 2, uncommitted: 2 })
  assert.notEqual(aInfo.name, bInfo.name) // 同名 app 目录应有父级区分

  assert.equal(bInfo.kind, 'git')
  assert.equal(bInfo.branch, 'main')
  assert.equal(bInfo.head, null)
  assert.equal(bInfo.detached, false)
  assert.equal(bInfo.remoteBranchMissing, true)

  assert.equal(nInfo.kind, 'not-git')
  assert.equal(nInfo.branch, null)
  assert.equal(nInfo.head, null)

  // 游离 HEAD 检查
  await mustGit(repoA, ['reset', '--hard', 'HEAD'])
  await mustGit(repoA, ['clean', '-fd'])
  await mustGit(repoA, ['checkout', '--detach', 'HEAD'])
  const stDetached = await service.status('s-multi')
  assert.equal(stDetached.repos[0].detached, true)
  assert.equal(stDetached.repos[0].branch, null)
  assert.equal(stDetached.repos[0].remoteBranchMissing, false)
})

test('审阅状态公布实际推送目标，包括首次提交、远程优先级和不同名的上游', async () => {
  const { root, service, setFolders } = await setupService()
  const repo = join(root, 'project')
  await mkdir(repo)
  await mustGit(repo, ['init', '-qb', 'main'])
  setFolders('s-push', [repo])
  const target = async () => (await service.status('s-push')).repos[0].pushTarget

  assert.equal(await target(), null)
  await mustGit(repo, ['remote', 'add', 'backup', join(root, 'backup.git')])
  assert.deepEqual(await target(), { remote: 'backup', branch: 'main', setUpstream: true })
  await mustGit(repo, ['remote', 'add', 'publish', join(root, 'publish.git')])
  assert.equal(await target(), null)
  await mustGit(repo, ['config', 'remote.pushDefault', 'publish'])
  assert.deepEqual(await target(), { remote: 'publish', branch: 'main', setUpstream: true })
  await mustGit(repo, ['config', 'branch.main.pushRemote', 'backup'])
  assert.deepEqual(await target(), { remote: 'backup', branch: 'main', setUpstream: true })
  await mustGit(repo, ['config', 'branch.main.pushRemote', 'missing'])
  assert.equal(await target(), null)

  await write(join(repo, 'first.txt'), 'first\n')
  await commitAll(repo, 'initial')
  await mustGit(repo, ['config', 'branch.main.remote', 'publish'])
  await mustGit(repo, ['config', 'branch.main.merge', 'refs/heads/release/main'])
  assert.deepEqual(await target(), { remote: 'publish', branch: 'release/main', setUpstream: false })
  await mustGit(repo, ['checkout', '--detach', 'HEAD'])
  assert.equal(await target(), null)
})

test('四种范围差异：unstaged / staged / uncommitted / branch（含未跟踪、重命名、二进制、过大、空仓库、冲突、分支提交链）', async () => {
  const { root, service, setFolders } = await setupService({ maxFileBytes: 128, maxCommits: 2 })
  const repo = join(root, 'proj')
  const emptyRepo = join(root, 'empty')
  const bare = join(root, 'origin.git')
  await mkdir(repo, { recursive: true })
  await mkdir(emptyRepo, { recursive: true })
  await mustGit(root, ['init', '--bare', bare])
  await mustGit(repo, ['init', '-b', 'main'])
  await mustGit(emptyRepo, ['init', '-b', 'main'])

  await write(join(repo, 'keep.txt'), 'line1\nline2\n')
  await write(join(repo, 'rename-me.txt'), 'alpha\nbeta\ngamma\ndelta\n')
  await write(join(repo, 'drop.txt'), 'to delete\n')
  await commitAll(repo, 'initial')
  await mustGit(repo, ['remote', 'add', 'origin', bare])
  await mustGit(repo, ['push', '-u', 'origin', 'main'])
  await mustGit(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await mustGit(repo, ['fetch', 'origin'])
  await mustGit(repo, ['remote', 'set-head', 'origin', 'main'])

  // 切到 feature 分支，做 3 个提交（测试 maxCommits=2 截断）
  await mustGit(repo, ['checkout', '-b', 'feature'])
  await write(join(repo, 'keep.txt'), 'line1\nline2-c1\n')
  const c1 = await commitAll(repo, 'feat one')
  await write(join(repo, 'c2.txt'), 'c2\n')
  const c2 = await commitAll(repo, 'feat two')
  await write(join(repo, 'c3.txt'), 'c3\n')
  const c3 = await commitAll(repo, 'feat three')

  // 同时在旁支建一个不在第一父链上的提交
  await mustGit(repo, ['checkout', '-b', 'side', c1])
  await write(join(repo, 'side.txt'), 'side\n')
  const sideSha = await commitAll(repo, 'side commit')
  await mustGit(repo, ['checkout', 'feature'])

  // 工作区和暂存区改动：
  // 1) 重命名 rename-me.txt -> moved.txt 并暂存
  await mustGit(repo, ['mv', 'rename-me.txt', 'moved.txt'])
  // 2) 删除 drop.txt 并暂存
  await mustGit(repo, ['rm', 'drop.txt'])
  // 3) 修改 keep.txt 并暂存，然后在工作区继续修改
  await write(join(repo, 'keep.txt'), 'line1\nline2-staged\n')
  await mustGit(repo, ['add', 'keep.txt'])
  await write(join(repo, 'keep.txt'), 'line1\nline2-worktree\n')
  // 4) 未跟踪：普通文本（无末尾换行）、空文件、二进制、超大文件
  await write(join(repo, 'fresh.txt'), 'hello\nworld')
  await write(join(repo, 'blank.txt'), '')
  await write(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 3, 255]))
  await write(join(repo, 'huge.txt'), 'x'.repeat(256))

  // 空仓库也放一个已暂存文件和未跟踪文件
  await write(join(emptyRepo, 'init-staged.txt'), 'first staged\n')
  await mustGit(emptyRepo, ['add', 'init-staged.txt'])
  await write(join(emptyRepo, 'init-untracked.txt'), 'first untracked\n')

  setFolders('s1', [repo, emptyRepo])
  const st = await service.status('s1')
  const repoId = st.repos[0].id
  const emptyId = st.repos[1].id

  // 1. unstaged
  const dUnstaged = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  assert.equal(dUnstaged.ok, true)
  assert.equal(dUnstaged.scope, 'unstaged')
  assert.match(dUnstaged.version, /^[a-f0-9]{64}$/)
  const uKeep = dUnstaged.files.find(f => f.path === 'keep.txt')
  assert.equal(uKeep.status, 'modified')
  assert.equal(uKeep.hunks[0].lines.some(l => l.kind === 'delete' && l.text === 'line2-staged'), true)
  assert.equal(uKeep.hunks[0].lines.some(l => l.kind === 'add' && l.text === 'line2-worktree'), true)

  const uFresh = dUnstaged.files.find(f => f.path === 'fresh.txt')
  assert.equal(uFresh.status, 'untracked')
  assert.equal(uFresh.added, 2)
  assert.equal(uFresh.hunks.length, 1)

  const uBlank = dUnstaged.files.find(f => f.path === 'blank.txt')
  assert.equal(uBlank.status, 'untracked')
  assert.deepEqual(uBlank.hunks, [])

  const uBin = dUnstaged.files.find(f => f.path === 'pic.bin')
  assert.equal(uBin.status, 'untracked')
  assert.equal(uBin.binary, true)
  assert.equal(uBin.tooLarge, false)
  assert.deepEqual(uBin.hunks, [])

  const uHuge = dUnstaged.files.find(f => f.path === 'huge.txt')
  assert.equal(uHuge.status, 'untracked')
  assert.equal(uHuge.tooLarge, true)
  assert.equal(uHuge.binary, false)
  assert.deepEqual(uHuge.hunks, [])

  // 2. staged（含重命名与删除）
  const dStaged = await service.diff({ sessionId: 's1', repo: repoId, scope: 'staged' })
  assert.equal(dStaged.ok, true)
  const sMoved = dStaged.files.find(f => f.path === 'moved.txt')
  assert.equal(sMoved.status, 'renamed')
  assert.equal(sMoved.oldPath, 'rename-me.txt')
  const sDrop = dStaged.files.find(f => f.path === 'drop.txt')
  assert.equal(sDrop.status, 'deleted')
  assert.equal(sDrop.deleted, 1)

  // 3. uncommitted
  const dUncommitted = await service.diff({ sessionId: 's1', repo: repoId, scope: 'uncommitted' })
  assert.equal(dUncommitted.ok, true)
  const cKeep = dUncommitted.files.find(f => f.path === 'keep.txt')
  assert.equal(cKeep.hunks[0].lines.some(l => l.kind === 'delete' && l.text === 'line2-c1'), true)
  assert.equal(cKeep.hunks[0].lines.some(l => l.kind === 'add' && l.text === 'line2-worktree'), true)
  assert.ok(dUncommitted.files.some(f => f.path === 'huge.txt' && f.tooLarge))

  // 4. branch：默认基准（origin/main）、分支列表、提交列表截断、选提交范围、非同一条提交链拒绝
  const br = await service.branches('s1', repoId)
  assert.equal(br.ok, true)
  assert.equal(br.defaultBase, 'origin/main')
  assert.ok(br.local.includes('main') && br.local.includes('feature'))
  assert.ok(br.remote.includes('origin/main'))
  assert.equal(br.remote.some(r => r.endsWith('/HEAD')), false)

  const cm = await service.commits('s1', repoId, 'main')
  assert.equal(cm.ok, true)
  assert.equal(cm.commits.length, 2)
  assert.equal(cm.truncated, true)
  assert.equal(cm.commits[0].sha, c3)
  assert.equal(cm.commits[0].subject, 'feat three')

  const dBranch = await service.diff({ sessionId: 's1', repo: repoId, scope: 'branch' })
  assert.equal(dBranch.ok, true)
  assert.equal(dBranch.base, 'origin/main')
  assert.ok(dBranch.files.some(f => f.path === 'c2.txt' && f.status === 'added'))
  assert.ok(dBranch.files.some(f => f.path === 'c3.txt' && f.status === 'added'))
  assert.equal(dBranch.files.some(f => f.path === 'fresh.txt'), false)

  const dBranchInc = await service.diff({ sessionId: 's1', repo: repoId, scope: 'branch', base: 'main', includeUncommitted: true })
  assert.equal(dBranchInc.ok, true)
  assert.equal(dBranchInc.base, 'main')
  assert.ok(dBranchInc.files.some(f => f.path === 'fresh.txt' && f.status === 'untracked'))

  const dCommitOne = await service.diff({ sessionId: 's1', repo: repoId, scope: 'branch', from: c2 })
  assert.equal(dCommitOne.ok, true)
  assert.deepEqual(dCommitOne.files.map(f => f.path), ['c2.txt'])

  const dCommitRange = await service.diff({ sessionId: 's1', repo: repoId, scope: 'branch', from: c3, to: c2 })
  assert.equal(dCommitRange.ok, true)
  assert.deepEqual(dCommitRange.files.map(f => f.path).sort(), ['c2.txt', 'c3.txt'])

  const dNotChain = await service.diff({ sessionId: 's1', repo: repoId, scope: 'branch', from: c2, to: sideSha })
  assert.equal(dNotChain.ok, false)
  assert.equal(dNotChain.code, 'conflict')
  assert.match(dNotChain.detail, /不在同一条提交链上/)

  // 5. 空仓库的 staged / unstaged / uncommitted / branch
  const emptyStaged = await service.diff({ sessionId: 's1', repo: emptyId, scope: 'staged' })
  assert.equal(emptyStaged.ok, true)
  assert.deepEqual(emptyStaged.files.map(f => [f.path, f.status]), [['init-staged.txt', 'added']])
  const emptyUncommitted = await service.diff({ sessionId: 's1', repo: emptyId, scope: 'uncommitted' })
  assert.equal(emptyUncommitted.ok, true)
  assert.deepEqual(emptyUncommitted.files.map(f => [f.path, f.status]), [
    ['init-staged.txt', 'added'],
    ['init-untracked.txt', 'untracked'],
  ])
  const emptyBranch = await service.diff({ sessionId: 's1', repo: emptyId, scope: 'branch' })
  assert.equal(emptyBranch.ok, true)
  assert.deepEqual(emptyBranch.files, [])

  // 6. version 一致性 & 变化检测
  const v1 = (await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })).version
  const v2 = (await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })).version
  assert.equal(v1, v2)
  await write(join(repo, 'keep.txt'), 'line1\nline2-worktree-changed\n')
  const v3 = (await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })).version
  assert.notEqual(v1, v3)
  await chmod(join(repo, 'fresh.txt'), 0o755)
  const v4 = (await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })).version
  assert.notEqual(v3, v4)

  // 7. 冲突文件出现在 diff 中标 conflict 且 totals 不崩溃
  await mustGit(repo, ['reset', '--hard', 'HEAD'])
  await mustGit(repo, ['clean', '-fd'])
  await mustGit(repo, ['checkout', '-b', 'conflict-b', c1])
  await write(join(repo, 'c2.txt'), 'branch-b\n')
  await commitAll(repo, 'b change')
  await mustGit(repo, ['checkout', 'feature'])
  const merge = await runGit(repo, ['merge', 'conflict-b'])
  assert.notEqual(merge.exitCode, 0)
  const stConflict = await service.status('s1')
  assert.equal(stConflict.repos[0].conflicts, 1)
  const dConflict = await service.diff({ sessionId: 's1', repo: repoId, scope: 'unstaged' })
  assert.equal(dConflict.ok, true)
  assert.ok(dConflict.files.some(f => f.path === 'c2.txt' && f.status === 'conflict'))
})

test('安全：读取差异与状态不执行仓库内容过滤器、外部 diff、textconv 与钩子', async () => {
  const { root, service, setFolders } = await setupService()
  const repo = join(root, 'unsafe')
  const marker = join(root, 'SHOULD_NOT_EXIST')
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
  await write(join(repo, '.gitattributes'), '*.txt filter=evil diff=ext\n')
  await write(join(repo, 'a.txt'), 'hello\n')
  await mustGit(repo, ['init', '-b', 'main'])
  await commitAll(repo, 'init')

  await mustGit(repo, ['config', 'filter.evil.clean', `touch "${marker}"`])
  await mustGit(repo, ['config', 'filter.evil.smudge', `touch "${marker}"`])
  await mustGit(repo, ['config', 'filter.evil.required', 'true'])
  await mustGit(repo, ['config', 'diff.ext.command', `touch "${marker}"`])
  await mustGit(repo, ['config', 'diff.ext.textconv', `touch "${marker}"`])
  await mustGit(repo, ['config', 'diff.external', `touch "${marker}"`])
  for (const hook of ['post-index-change', 'pre-commit', 'post-checkout']) {
    await write(join(repo, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${marker}"\n`)
    await chmod(join(repo, '.git', 'hooks', hook), 0o755)
  }

  await write(join(repo, 'a.txt'), 'world\n')
  setFolders('s-safe', [repo])
  const st = await service.status('s-safe')
  const repoId = st.repos[0].id
  const diff = await service.diff({ sessionId: 's-safe', repo: repoId, scope: 'unstaged' })
  assert.equal(diff.ok, true)
  assert.ok(diff.files.some(f => f.path === 'a.txt' && f.added === 1 && f.deleted === 1))
  assert.equal(existsSync(marker), false, '不允许执行任何过滤器、外部 diff、textconv 或钩子')
  assert.ok((await stat(join(repo, 'a.txt'))).isFile())
})

async function reviewRepo(config) {
  const { root, service, setFolders } = await setupService(config)
  const repo = join(root, 'project')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  setFolders('reader', [repo])
  const params = { sessionId: 'reader', repo: (await service.status('reader')).repos[0].id }
  return { repo, service, params, diff: (scope, options) => service.diff({ ...params, scope, ...options }) }
}

for (const [label, tracked, size] of [
  ['binary untracked', false, 8], ['oversized untracked', false, 96], ['oversized tracked', true, 96],
]) {
  test(`version hashes bytes for ${label} files with unchanged size and modification time`, async () => {
    const { repo, diff } = await reviewRepo({ maxFileBytes: 32 })
    const path = join(repo, 'sample.bin')
    if (tracked) {
      await write(path, Buffer.alloc(size, 1))
      await commitAll(repo, 'sample')
    }
    const fixed = new Date('2020-01-01T00:00:00Z')
    const versionFor = async (value) => {
      const bytes = Buffer.alloc(size)
      bytes[1] = value
      await write(path, bytes)
      await utimes(path, fixed, fixed)
      return (await diff('unstaged')).version
    }
    assert.notEqual(await versionFor(2), await versionFor(3))
  })
}

test('untracked file contents share the response diff budget', async () => {
  const { repo, diff } = await reviewRepo({ maxDiffBytes: 80 })
  for (const file of ['a', 'b', 'c']) await write(join(repo, file), 'x'.repeat(40) + '\n')
  const result = await diff('unstaged')
  assert.equal(result.totals.files, 3)
  assert.ok(result.files.some(file => file.added === 1))
  assert.ok(result.files.some(file => file.tooLarge && file.hunks.length === 0))
})

test('tracked file names with spaces retain actionable hunks', async () => {
  const { repo, diff } = await reviewRepo()
  await write(join(repo, 'two words'), 'first\n')
  await commitAll(repo, 'sample')
  await write(join(repo, 'two words'), 'second\n')
  assert.equal((await diff('unstaged')).files[0].added, 1)
})

test('a staged deletion and same-name worktree file compare with HEAD once', async () => {
  const { repo, params, service, diff } = await reviewRepo()
  await write(join(repo, 'notes'), 'first\n')
  await commitAll(repo, 'sample')
  await mustGit(repo, ['rm', '--cached', 'notes'])
  let result = await diff('uncommitted')
  assert.deepEqual(result.files, [])
  assert.equal((await service.status(params.sessionId)).repos[0].counts.uncommitted, 0)
  await write(join(repo, 'notes'), 'second\n')
  result = await diff('uncommitted')
  assert.deepEqual(result.files.map(f => [f.path, f.status, f.added, f.deleted]), [['notes', 'modified', 1, 1]])
  assert.equal((await service.status(params.sessionId)).repos[0].counts.uncommitted, 1)
  assert.equal((await diff('staged')).files[0].status, 'deleted')
})

test('branch selection only accepts commits reachable from HEAD after the chosen base', async () => {
  const { repo, diff } = await reviewRepo()
  await write(join(repo, 'history'), 'base\n')
  const base = await commitAll(repo, 'base')
  await mustGit(repo, ['checkout', '-b', 'side'])
  await write(join(repo, 'history'), 'side\n')
  const side = await commitAll(repo, 'side')
  await mustGit(repo, ['checkout', '-b', 'topic', 'main'])
  await write(join(repo, 'history'), 'topic\n')
  const tip = await commitAll(repo, 'topic')
  for (const from of [base, side]) assert.equal((await diff('branch', { base: 'main', from })).code, 'conflict')
  assert.equal((await diff('branch', { base: 'unknown', from: tip })).code, 'not-found')
  assert.equal((await diff('branch', { base: 'main', from: tip })).ok, true)
})

test('Git discovery preserves whitespace in repository roots', async () => {
  const { root, service, setFolders } = await setupService()
  const repo = join(root, 'notes with space ')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  setFolders('whitespace', [repo])
  assert.equal((await service.status('whitespace')).repos[0].name, 'notes with space ')
})

test('discovery requires the Git worktree to contain the session folder', async () => {
  const root = await tempDir('dwb-gr-discovery-')
  const folder = join(root, 'workspace')
  const other = join(root, 'other')
  await mkdir(folder)
  await mkdir(join(other, '.git'), { recursive: true })
  const git = {
    hasGit: async () => true,
    run: async (_cwd, args) => ({
      exitCode: 0,
      stdout: args.includes('--absolute-git-dir') && args.includes('--show-toplevel')
        ? other + '\n' + join(other, '.git') + '\n'
        : (args.includes('--show-toplevel') ? other : join(other, '.git')) + '\n',
    }),
  }
  await assert.rejects(discoverRepos(git, [folder]), { code: 'bad-path' })
})

test('a tracked non-UTF8 change never offers a lossy text hunk', async () => {
  const { repo, diff } = await reviewRepo()
  await write(join(repo, 'raw'), Buffer.from([0xff, 10]))
  await commitAll(repo, 'sample')
  await write(join(repo, 'raw'), Buffer.from([0xfe, 10]))
  const [change] = (await diff('unstaged')).files
  assert.ok(change.binary)
  assert.deepEqual(change.hunks, [])
})

test('Git being unavailable is distinguishable from a non-Git folder', async () => {
  const folder = await tempDir('dwb-gr-discovery-')
  await assert.rejects(discoverRepos({ hasGit: async () => false }, [folder]), { code: 'git-unavailable' })
})

test('file actions exclude Git metadata components', () => {
  for (const path of ['.git/config', 'nested/.GiT/index', '.git./config']) {
    assert.equal(safeRelativePath(path), false)
  }
  assert.equal(safeRelativePath('.gitattributes'), true)
})

test('an unresolved chain of symlinks is ineligible for a write', async () => {
  const root = await tempDir('dwb-gr-link-')
  await symlink('missing', join(root, 'unfinished'))
  await symlink('unfinished', join(root, 'indirect'))
  await assert.rejects(assertPathInsideRepo(root, 'indirect'), { code: 'bad-path' })
  assert.ok((await assertPathInsideRepo(root, 'indirect', { allowEscapingLeafSymlink: true })).leafEscapes)
})

test('a separate metadata directory must identify the worktree that owns it', async () => {
  const root = await tempDir('dwb-gr-metadata-')
  const folder = join(root, 'project')
  const metadata = join(root, 'metadata')
  await mkdir(folder)
  await mkdir(metadata)
  const git = {
    hasGit: async () => true,
    run: async (_cwd, args) => ({ exitCode: args.includes('config') ? 1 : 0,
      stdout: (args.includes('--show-toplevel') ? folder : metadata) + '\n' }),
  }
  await assert.rejects(discoverRepos(git, [folder]), { code: 'bad-path' })
})

test('a registered linked worktree retains its own review index', async () => {
  const { service, setFolders, root } = await setupService()
  const repo = join(root, 'main')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await write(join(repo, 'sample'), 'base\n')
  await commitAll(repo, 'base')
  const linked = join(root, 'linked')
  await mustGit(repo, ['worktree', 'add', '-b', 'topic', linked])
  setFolders('linked', [linked])
  const info = (await service.status('linked')).repos[0]
  assert.equal(info.branch, 'topic')
  assert.equal(info.name, 'linked')
})

test('a non-regular Git index is rejected before repository status is read', async () => {
  const { root, service, setFolders } = await setupService()
  const repo = join(root, 'project')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await mkdir(join(repo, '.git', 'index'))
  setFolders('invalid-index', [repo])
  await assert.rejects(service.status('invalid-index'), { code: 'bad-path' })
})

test('aborted reads stop fingerprinting worktree files', async () => {
  const root = await tempDir('dwb-gr-cancel-')
  await write(join(root, 'sample'), 'sample')
  await assert.rejects(readUntrackedFileDiff(root, 'sample', 10, AbortSignal.abort()), { name: 'AbortError' })
})

test('a linked Git metadata directory must match its specific worktree registration', async () => {
  const root = await tempDir('dwb-gr-owner-')
  const folder = join(root, 'project')
  const metadata = join(root, 'metadata')
  await mkdir(folder)
  await mkdir(metadata)
  await write(join(metadata, 'gitdir'), join(root, 'other', '.git') + '\n')
  const git = {
    hasGit: async () => true,
    run: async (_cwd, args) => {
      if (args[0] === 'worktree') return { exitCode: 0, stdout: 'worktree ' + await realpath(folder) + '\0' }
      return { exitCode: args.includes('config') ? 1 : 0, stdout: (args.includes('--show-toplevel') ? folder : metadata) + '\n' }
    },
  }
  await assert.rejects(discoverRepos(git, [folder]), { code: 'bad-path' })
})

test('private undo data and trash must live outside the reviewed worktree', async () => {
  for (const key of ['gitReviewDataDir', 'trashDir']) {
    const repo = await tempDir('dwb-gr-private-')
    await mustGit(repo, ['init', '-b', 'main'])
    const { service, setFolders } = await setupService({ [key]: join(repo, 'storage') })
    setFolders('private', [repo])
    await assert.rejects(service.status('private'), { code: 'bad-path' })
  }
})

test('Git rejects a nonempty directory configured for disabled hooks', async () => {
  const { root, git } = await setupService()
  await mkdir(git.hooksDir, { recursive: true })
  await write(join(git.hooksDir, 'notes.txt'), 'fixture')
  await assert.rejects(git.run(root, ['--version']), { code: 'bad-path' })
})

test('the two review stores cannot share a backup directory', async () => {
  const root = await tempDir('dwb-gr-stores-')
  assert.throws(() => parseGitReviewConfig({ dataDir: root, gitReviewDataDir: root }), /gitReviewDataDir/)
})

test('a backup directory alias cannot place Git records under the other review store', async () => {
  const root = await tempDir('dwb-gr-stores-')
  const dataDir = join(root, 'review')
  const alias = join(root, 'saved')
  await mkdir(dataDir)
  await symlink(dataDir, alias, 'dir')
  assert.throws(() => parseGitReviewConfig({ dataDir, gitReviewDataDir: join(alias, 'git-records') }), /gitReviewDataDir/)
})

test('status 给出每个仓库和非 Git 目录的根目录（规范路径），网页拿它拼文件的绝对路径去打开', async () => {
  const { root, service, setFolders } = await setupService()
  const repo = join(root, 'roots', 'app')
  const notes = join(root, 'roots', 'notes')
  await mkdir(join(repo, 'sub'), { recursive: true })
  await mkdir(notes, { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])
  setFolders('s-root', [join(repo, 'sub'), notes])
  const st = await service.status('s-root')
  assert.deepEqual(st.repos.map(info => [info.kind, info.root]), [['git', await realpath(repo)], ['not-git', await realpath(notes)]])
})

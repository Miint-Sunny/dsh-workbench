/**
 * 检查点的 git 层（lib/checkpoints-git.js）：在临时目录里用真 git 跑快照、差异和还原，
 * 覆盖删除、新增、改内容、改模式、符号链接、目录与文件互换、被忽略的文件、嵌套仓库、
 * .gitignore 改过、检查点目录在仓库内、对象被 gc 清掉。每个用例前后核对仓库自己的
 * .git/index、HEAD、refs、objects 的哈希没变，并且再快照得到的树和目标树相同。
 * 大小写不敏感卷上仅大小写不同的改名：卷区分大小写时那一条跳过并写明。不碰 ~/code 下任何
 * 仓库的 .git。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readlinkSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGitRunner, diffNumstat, diffRaw, hasContentFilters, hasFilterAttributes, ignoredPaths,
  locateWorkspace, parseDiffRaw, parseNumstat, resolveGitExecutable, restoreTree, snapshotTree,
  treeExists,
} from '../lib/checkpoints-git.js'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

const write = (path, text) => writeFile(path, text, 'utf8')

/** 递归列出目录下所有文件（相对路径），拼内容算一个总哈希。 */
async function dirHash(root) {
  const hash = createHash('sha256')
  const walk = async dir => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name)
      const info = statSync(path)
      if (info.isDirectory()) await walk(path)
      else {
        hash.update(path.slice(root.length))
        hash.update(await readFile(path))
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/**
 * 搭一个测试场景：临时目录里有仓库 repo/、检查点目录 store/s1/、注入的 subprocess。
 * @returns {{ work: string, repo: string, sessionDir: string, runner: object, openWorkspace: () => Promise<object> }} 场景。
 */
async function scenario() {
  const work = mkdtempSync(join(tmpdir(), 'dwb-git-'))
  const repo = join(work, 'repo')
  const sessionDir = join(work, 'store', 's1')
  const subprocess = createLocalSubprocess({ home: join(work, 'home') })
  const executable = await resolveGitExecutable(subprocess, undefined)
  assert.notEqual(executable, null, '这台机器上要有可用的 git')
  const hooksDir = join(work, 'no-hooks')
  await mkdir(hooksDir, { recursive: true })
  const runner = createGitRunner(subprocess, executable, { hooksDir })
  const made = await runGit(work, ['init', repo])
  assert.equal(made.exitCode, 0, made.stderr)
  return {
    work, repo, sessionDir, runner,
    openWorkspace: () => locateWorkspace(runner, repo, sessionDir),
  }
}

test('git 层：删除（检查点之后新建的文件恢复时被删）', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, 'old.txt'), '旧文件\n')
    const target = await snapshotTree(scene.runner, workspace)
    await write(join(scene.repo, 'new.txt'), '新文件\n')
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(result.restored, 1)
    assert.deepEqual(result.skipped, [])
    assert.equal(await readFile(join(scene.repo, 'old.txt'), 'utf8'), '旧文件\n')
    await assert.rejects(readFile(join(scene.repo, 'new.txt')), /ENOENT/)
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：新增（检查点里有的文件被删掉后写回）', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, 'old.txt'), '旧文件\n')
    const target = await snapshotTree(scene.runner, workspace)
    await rm(join(scene.repo, 'old.txt'))
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(result.restored, 1)
    assert.deepEqual(result.skipped, [])
    assert.equal(await readFile(join(scene.repo, 'old.txt'), 'utf8'), '旧文件\n')
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：改内容、改模式（755↔644）', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, 'a.txt'), '第一版\n')
    await write(join(scene.repo, 'run.sh'), '#!/bin/sh\n')
    await chmod(join(scene.repo, 'run.sh'), 0o755)
    const target = await snapshotTree(scene.runner, workspace)
    await write(join(scene.repo, 'a.txt'), '第二版\n')
    await chmod(join(scene.repo, 'run.sh'), 0o644)
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(result.restored, 2)
    assert.equal(await readFile(join(scene.repo, 'a.txt'), 'utf8'), '第一版\n')
    assert.equal(statSync(join(scene.repo, 'run.sh')).mode & 0o777, 0o755)
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：符号链接（目标变化、与普通文件互换）', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, 'one.txt'), '一\n')
    await write(join(scene.repo, 'two.txt'), '二\n')
    await symlink('one.txt', join(scene.repo, 'link'))
    const target = await snapshotTree(scene.runner, workspace)
    // 目标变化：link 改指 two.txt；旁边多个检查点里没有的普通文件。
    await rm(join(scene.repo, 'link'))
    await symlink('two.txt', join(scene.repo, 'link'))
    await write(join(scene.repo, 'plain.txt'), '原来是链接\n')
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(readlinkSync(join(scene.repo, 'link')), 'one.txt')
    await assert.rejects(readFile(join(scene.repo, 'plain.txt')), /ENOENT/)
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    // 链接变普通文件再还原回来。
    await rm(join(scene.repo, 'link'))
    await write(join(scene.repo, 'link'), '现在是文件\n')
    await restoreTree(scene.runner, workspace, target)
    assert.equal(lstatSync(join(scene.repo, 'link')).mode & 0o170000, 0o120000)
    assert.equal(readlinkSync(join(scene.repo, 'link')), 'one.txt')
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
    assert.deepEqual(result.skipped, [])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：目录与文件互换', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await mkdir(join(scene.repo, 'a'))
    await write(join(scene.repo, 'a', 'x.txt'), '目录里的文件\n')
    const target = await snapshotTree(scene.runner, workspace)
    // 目录换成文件。
    await rm(join(scene.repo, 'a'), { recursive: true, force: true })
    await write(join(scene.repo, 'a'), '现在是文件\n')
    let result = await restoreTree(scene.runner, workspace, target)
    assert.ok(statSync(join(scene.repo, 'a')).isDirectory())
    assert.equal(await readFile(join(scene.repo, 'a', 'x.txt'), 'utf8'), '目录里的文件\n')
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    // 文件换成目录再还原。
    await rm(join(scene.repo, 'a'), { recursive: true, force: true })
    await write(join(scene.repo, 'a'), '又变回文件\n')
    await mkdir(join(scene.repo, 'b'))
    await write(join(scene.repo, 'b', 'y.txt'), '新目录\n')
    result = await restoreTree(scene.runner, workspace, target)
    assert.ok(statSync(join(scene.repo, 'a')).isDirectory())
    await assert.rejects(stat(join(scene.repo, 'b')), /ENOENT/)
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
    assert.deepEqual(result.skipped, [])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：被忽略的文件不动', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, '.gitignore'), '*.log\nbuild/\n')
    await write(join(scene.repo, 'tracked.txt'), '跟踪的\n')
    await mkdir(join(scene.repo, 'build'))
    await write(join(scene.repo, 'build', 'out.bin'), '被忽略的产物\n')
    await write(join(scene.repo, 'debug.log'), '被忽略的日志\n')
    const target = await snapshotTree(scene.runner, workspace)
    await write(join(scene.repo, 'tracked.txt'), '改过的\n')
    // 检查点之后又出现的被忽略文件也要留着。
    await write(join(scene.repo, 'build', 'later.bin'), '后来忽略的\n')
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(await readFile(join(scene.repo, 'tracked.txt'), 'utf8'), '跟踪的\n')
    assert.equal(await readFile(join(scene.repo, 'build', 'out.bin'), 'utf8'), '被忽略的产物\n')
    assert.equal(await readFile(join(scene.repo, 'build', 'later.bin'), 'utf8'), '后来忽略的\n')
    assert.equal(await readFile(join(scene.repo, 'debug.log'), 'utf8'), '被忽略的日志\n')
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
    assert.deepEqual(result.skipped, [])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：嵌套仓库（gitlink）整条跳过、内部不动', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const nested = join(scene.repo, 'nested')
    const made = await runGit(scene.work, ['init', nested])
    assert.equal(made.exitCode, 0, made.stderr)
    await write(join(nested, 'inner.txt'), '嵌套仓库里的\n')
    const committed = await runGit(nested, [...COMMIT_IDENTITY, 'add', '-A'])
    assert.equal(committed.exitCode, 0, committed.stderr)
    const nestedCommit = await runGit(nested, [...COMMIT_IDENTITY, 'commit', '-m', 'x'])
    assert.equal(nestedCommit.exitCode, 0, nestedCommit.stderr)
    await write(join(scene.repo, 'top.txt'), '顶层文件\n')
    const workspace = await scene.openWorkspace()
    const target = await snapshotTree(scene.runner, workspace)
    // 检查点之后：顶层改文件、嵌套仓库里也改文件。
    await write(join(scene.repo, 'top.txt'), '改过的顶层\n')
    await write(join(nested, 'inner.txt'), '嵌套仓库里改过的\n')
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(await readFile(join(scene.repo, 'top.txt'), 'utf8'), '顶层文件\n')
    // 嵌套仓库不还原也不删，里面改过的留着。
    assert.equal(await readFile(join(nested, 'inner.txt'), 'utf8'), '嵌套仓库里改过的\n')
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
    assert.deepEqual(result.skipped, [])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：检查点里记录的 gitlink 之后换了提交，预览标 submodule、恢复跳过', async () => {
  const scene = await scenario()
  try {
    const nested = join(scene.repo, 'nested')
    await runGit(scene.work, ['init', nested])
    await write(join(nested, 'inner.txt'), '第一版\n')
    await runGit(nested, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(nested, [...COMMIT_IDENTITY, 'commit', '-m', 'one'])
    await write(join(scene.repo, 'top.txt'), '顶层\n')
    const workspace = await scene.openWorkspace()
    const target = await snapshotTree(scene.runner, workspace)
    // 嵌套仓库前进一个提交：两棵树里 gitlink 的提交号不同。
    await write(join(nested, 'inner.txt'), '第二版\n')
    await runGit(nested, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(nested, [...COMMIT_IDENTITY, 'commit', '-m', 'two'])
    const nowTree = await snapshotTree(scene.runner, workspace)
    const raw = await diffRaw(scene.runner, workspace, nowTree, target)
    assert.ok(raw.some(entry => entry.path === 'nested' && (entry.oldMode === '160000' || entry.newMode === '160000')))
    const result = await restoreTree(scene.runner, workspace, target)
    assert.ok(result.skipped.some(item => item.path === 'nested' && item.reason === 'submodule'))
    assert.equal(await readFile(join(nested, 'inner.txt'), 'utf8'), '第二版\n')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：.gitignore 在检查点之后改过，原本被忽略的文件保留', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, '.gitignore'), 'build/\n')
    await mkdir(join(scene.repo, 'build'))
    await write(join(scene.repo, 'build', 'out.txt'), '被忽略的\n')
    const target = await snapshotTree(scene.runner, workspace)
    // 检查点之后 .gitignore 不再忽略 build/，out.txt 进了快照；恢复到检查点应写回旧
    // .gitignore 并保住 out.txt。
    await write(join(scene.repo, '.gitignore'), '')
    await write(join(scene.repo, 'readme.md'), '新文件\n')
    const result = await restoreTree(scene.runner, workspace, target)
    assert.equal(await readFile(join(scene.repo, '.gitignore'), 'utf8'), 'build/\n')
    assert.equal(await readFile(join(scene.repo, 'build', 'out.txt'), 'utf8'), '被忽略的\n')
    await assert.rejects(readFile(join(scene.repo, 'readme.md')), /ENOENT/)
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
    assert.deepEqual(result.skipped, [])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：目标路径现在是装着被忽略文件的目录，跳过并记 ignored-inside', async () => {
  const scene = await scenario()
  try {
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, 'b'), '检查点里是个文件\n')
    const target = await snapshotTree(scene.runner, workspace)
    // 检查点之后 b 变成目录，里面只剩被 .gitignore 忽略的文件（.gitignore 也是新加的）。
    await rm(join(scene.repo, 'b'))
    await mkdir(join(scene.repo, 'b'))
    await write(join(scene.repo, '.gitignore'), 'b/keep.log\n')
    await write(join(scene.repo, 'b', 'keep.log'), '被忽略的\n')
    const result = await restoreTree(scene.runner, workspace, target)
    assert.ok(statSync(join(scene.repo, 'b')).isDirectory())
    assert.equal(await readFile(join(scene.repo, 'b', 'keep.log'), 'utf8'), '被忽略的\n')
    assert.deepEqual(result.skipped, [
      { path: 'b', reason: 'ignored-inside' },
      // 恢复删掉了新加的 .gitignore，keep.log 不再被忽略、出现在核对差异里，如实报出来。
      { path: 'b/keep.log', reason: 'changed-after' },
    ])
    assert.equal(result.restored, 1) // 只有新加的 .gitignore 被删掉这一件。
    assert.equal(await dirHash(join(scene.repo, '.git')), before)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：检查点目录放在仓库里面时不进快照', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-git-'))
  try {
    const repo = work
    const made = await runGit(work, ['init', repo])
    assert.equal(made.exitCode, 0, made.stderr)
    const subprocess = createLocalSubprocess()
    const runner = createGitRunner(subprocess, await resolveGitExecutable(subprocess, undefined), { hooksDir: join(work, 'no-hooks') })
    await write(join(repo, 'file.txt'), '内容\n')
    const sessionDir = join(repo, '.checkpoints', 's1')
    const workspace = await locateWorkspace(runner, repo, sessionDir)
    const target = await snapshotTree(runner, workspace)
    const listed = await runner.run(['ls-tree', '-z', '--name-only', target], { cwd: repo, env: workspace.env })
    assert.equal(listed.exitCode, 0, listed.stderr)
    assert.deepEqual(listed.stdout.split('\0').filter(name => name !== ''), ['file.txt'])
    // 快照两遍树相同：临时 index 目录没混进树里。
    assert.equal(await snapshotTree(runner, workspace), target)
    // 恢复也照常。
    await rm(join(repo, 'file.txt'))
    const result = await restoreTree(runner, workspace, target)
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), '内容\n')
    assert.deepEqual(result.skipped, [])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('git 层：大小写不敏感卷上仅大小写不同的改名（未跟踪的改回原名；跟踪的快照看不出来）', async t => {
  const scene = await scenario()
  try {
    await write(join(scene.repo, 'probe'), 'x')
    const insensitive = existsSync(join(scene.repo, 'PROBE'))
    await rm(join(scene.repo, 'probe'))
    if (!insensitive) {
      t.skip('这个卷区分大小写，测不了仅大小写不同的改名')
      return
    }
    const before = await dirHash(join(scene.repo, '.git'))
    const workspace = await scene.openWorkspace()
    // 未跟踪的文件：操作表里是一条 D 加一条 A，先删后写，改回检查点时的写法。
    await write(join(scene.repo, 'Readme.md'), 'hello\n')
    const target = await snapshotTree(scene.runner, workspace)
    await rename(join(scene.repo, 'Readme.md'), join(scene.repo, 'tmp-name'))
    await rename(join(scene.repo, 'tmp-name'), join(scene.repo, 'README.md'))
    const result = await restoreTree(scene.runner, workspace, target)
    assert.deepEqual((await readdir(scene.repo)).filter(name => name !== '.git'), ['Readme.md'])
    assert.equal(await readFile(join(scene.repo, 'Readme.md'), 'utf8'), 'hello\n')
    assert.deepEqual(result.skipped, [])
    assert.equal(await snapshotTree(scene.runner, workspace), target)
    assert.equal(await dirHash(join(scene.repo, '.git')), before)

    // 跟踪的文件：core.ignorecase 下私有 index 复制自仓库 index，git 保留 index 里的写法，
    // 快照和检查点相同，恢复什么都不做，名字留在改后的写法（已知限制，README 写明）。
    await runGit(scene.repo, ['add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '-m', 'one'])
    const tracked = await snapshotTree(scene.runner, workspace)
    await rename(join(scene.repo, 'Readme.md'), join(scene.repo, 'tmp-name'))
    await rename(join(scene.repo, 'tmp-name'), join(scene.repo, 'README.md'))
    assert.equal(await snapshotTree(scene.runner, workspace), tracked)
    const trackedResult = await restoreTree(scene.runner, workspace, tracked)
    assert.equal(trackedResult.restored, 0)
    assert.deepEqual((await readdir(scene.repo)).filter(name => name !== '.git'), ['README.md'])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：检查点对象被 git gc --prune=now 清掉后 treeExists 报失效', async () => {
  const scene = await scenario()
  try {
    await write(join(scene.repo, 'a.txt'), '要提交的\n')
    const added = await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    assert.equal(added.exitCode, 0, added.stderr)
    const committed = await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '-m', 'one'])
    assert.equal(committed.exitCode, 0, committed.stderr)
    const workspace = await scene.openWorkspace()
    const target = await snapshotTree(scene.runner, workspace)
    // 快照复用提交里已有的树，对象在仓库里；把历史改掉再 gc，树就没了。
    assert.equal(await treeExists(scene.runner, workspace, target), true)
    await write(join(scene.repo, 'a.txt'), '改过的\n')
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '--amend', '-m', 'two'])
    await runGit(scene.repo, ['reflog', 'expire', '--expire=now', '--all'])
    const gc = await runGit(scene.repo, ['gc', '--prune=now'])
    assert.equal(gc.exitCode, 0, gc.stderr)
    assert.equal(await treeExists(scene.runner, workspace, target), false)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：不在仓库里的目录 locateWorkspace 答 null', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-git-'))
  try {
    const subprocess = createLocalSubprocess({ home: join(work, 'home') })
    const runner = createGitRunner(subprocess, await resolveGitExecutable(subprocess, undefined), { hooksDir: join(work, 'no-hooks') })
    const workspace = await locateWorkspace(runner, work, join(work, 'store', 's1'))
    assert.equal(workspace, null)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('git 层：numstat / raw 输出解析（含改名和二进制）', async () => {
  assert.deepEqual(parseNumstat('2\t1\t.gitignore\0'), [{ path: '.gitignore', added: 2, deleted: 1, binary: false }])
  assert.deepEqual(parseNumstat('-\t-\t\0old\0new\0'), [{ path: 'new', oldPath: 'old', added: 0, deleted: 0, binary: true }])
  assert.throws(() => parseNumstat('2\t1\t.gitignore'), /not NUL-terminated/)
  assert.deepEqual(parseDiffRaw(':100644 100644 abcdefabcdefabcdefabcdefabcdefabcdefabcd 1234567890123456789012345678901234567890 M\0a.txt\0'), [
    { oldMode: '100644', newMode: '100644', oldSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', newSha: '1234567890123456789012345678901234567890', status: 'M', path: 'a.txt' },
  ])
  assert.throws(() => parseDiffRaw(':broken\0'), /malformed raw record/)
})

test('git 层：ignoredPaths 和 hasContentFilters', async () => {
  const scene = await scenario()
  try {
    const workspace = await scene.openWorkspace()
    await write(join(scene.repo, '.gitignore'), '*.log\n')
    await write(join(scene.repo, 'a.log'), 'x\n')
    await write(join(scene.repo, 'b.txt'), 'y\n')
    const ignored = await ignoredPaths(scene.runner, workspace, ['a.log', 'b.txt', '.gitignore'])
    assert.deepEqual([...ignored], ['a.log'])
    assert.deepEqual([...await ignoredPaths(scene.runner, workspace, [])], [])
    assert.equal(await hasContentFilters(scene.runner, workspace, ['a.log', 'b.txt']), false)
    await write(join(scene.repo, '.gitattributes'), '*.bin filter=lfs\n')
    assert.equal(await hasContentFilters(scene.runner, workspace, ['x.bin']), true)
    assert.equal(await hasContentFilters(scene.runner, workspace, ['b.txt']), false)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

// ---- 第 40 件阶段一（记录要安全）的回归测试 ----

test('git 层：快照和恢复不跑仓库里的钩子（-c core.hooksPath 指空目录）', async () => {
  const scene = await scenario()
  try {
    const marker = join(scene.work, 'HOOKMARK')
    await mkdir(join(scene.repo, '.git', 'hooks'), { recursive: true })
    for (const hook of ['post-index-change', 'post-checkout', 'reference-transaction', 'pre-auto-gc', 'post-rewrite', 'post-merge', 'post-commit']) {
      await write(join(scene.repo, '.git', 'hooks', hook), `#!/bin/sh\necho "${hook} $@" >> ${marker}\n`)
      await chmod(join(scene.repo, '.git', 'hooks', hook), 0o755)
    }
    await write(join(scene.repo, 'a.txt'), 'a\n')
    const workspace = await scene.openWorkspace()
    const target = await snapshotTree(scene.runner, workspace)
    await write(join(scene.repo, 'a.txt'), 'b\n')
    await write(join(scene.repo, 'c.txt'), 'c\n')
    await restoreTree(scene.runner, workspace, target)
    assert.equal(existsSync(marker), false, '仓库钩子一个都不该跑（包括指向私有 index 的 post-index-change）')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：core.fsmonitor 不被请教，快照记工作树此刻的内容', async () => {
  const scene = await scenario()
  try {
    const fsmon = join(scene.work, 'fsmon.sh')
    // 钩子每次都答「什么都没变」，git 就会拿缓存的旧状态当快照输入。
    await write(fsmon, '#!/bin/sh\nprintf "/\\0"\n')
    await chmod(fsmon, 0o755)
    await write(join(scene.repo, 'a.txt'), 'committed\n')
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '-m', 'one'])
    await runGit(scene.repo, ['config', 'core.fsmonitor', fsmon])
    // 用户侧跑一次 status，真 index 里存下 fsmonitor 标记。
    await runGit(scene.repo, ['status'])
    await write(join(scene.repo, 'a.txt'), 'EDITED BEFORE THE CHECKPOINT\n')
    const workspace = await scene.openWorkspace()
    const tree = await snapshotTree(scene.runner, workspace)
    const blob = await scene.runner.run(['show', `${tree}:a.txt`], { cwd: scene.repo, env: workspace.env })
    assert.equal(blob.exitCode, 0, blob.stderr)
    assert.equal(blob.stdout, 'EDITED BEFORE THE CHECKPOINT\n')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：core.splitIndex 关掉，快照不往真的 .git 加 sharedindex', async () => {
  const scene = await scenario()
  try {
    for (let index = 0; index < 30; index += 1) await write(join(scene.repo, `f${index}.txt`), `${index}\n`)
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '-m', 'init'])
    await runGit(scene.repo, ['config', 'core.splitIndex', 'true'])
    await runGit(scene.repo, ['update-index', '--split-index'])
    const sharedBefore = (await readdir(join(scene.repo, '.git'))).filter(name => name.startsWith('sharedindex'))
    // 改动超过两成条目，关闭 splitIndex 之前 git 会想再写一个 sharedindex。
    for (let index = 0; index < 15; index += 1) await write(join(scene.repo, `f${index}.txt`), `changed ${index}\n`)
    for (let index = 0; index < 40; index += 1) await write(join(scene.repo, `new${index}.txt`), `${index}\n`)
    const workspace = await scene.openWorkspace()
    await snapshotTree(scene.runner, workspace)
    const sharedAfter = (await readdir(join(scene.repo, '.git'))).filter(name => name.startsWith('sharedindex'))
    assert.deepEqual(sharedAfter, sharedBefore)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：hasFilterAttributes 认 .gitattributes 和 info/attributes 里的 filter=，-filter、被忽略的目录不算', async () => {
  const scene = await scenario()
  try {
    const workspace = await scene.openWorkspace()
    assert.equal(await hasFilterAttributes(scene.runner, workspace), false, '没有 .gitattributes 时没有过滤器')
    await write(join(scene.repo, '.gitattributes'), '# 注释里提到 filter=lfs 不算\n*.txt text\n*.dat filter=evil\n')
    await mkdir(join(scene.repo, '.git', 'info'), { recursive: true })
    await write(join(scene.repo, '.git', 'info', 'attributes'), 'sub/* filter=another\n')
    assert.equal(await hasFilterAttributes(scene.runner, workspace), true, '根 .gitattributes 的 filter=evil 要认出来')
    await write(join(scene.repo, '.gitattributes'), '*.txt text=auto\n*.dat -filter\n')
    await write(join(scene.repo, '.git', 'info', 'attributes'), '')
    assert.equal(await hasFilterAttributes(scene.runner, workspace), false, 'unset（-filter）不是过滤器')
    // 子目录里的 .gitattributes 也认。
    await mkdir(join(scene.repo, 'deep', 'dir'), { recursive: true })
    await write(join(scene.repo, 'deep', 'dir', '.gitattributes'), '*.bin filter=lfs\n')
    assert.equal(await hasFilterAttributes(scene.runner, workspace), true)
    // 被 .gitignore 忽略的目录里的 .gitattributes 不算：git 不读它，我们也不该为它降级。
    await write(join(scene.repo, '.gitattributes'), '')
    await rm(join(scene.repo, 'deep', 'dir', '.gitattributes'))
    await write(join(scene.repo, '.gitignore'), 'node_modules/\n')
    await mkdir(join(scene.repo, 'node_modules', 'pkg'), { recursive: true })
    await write(join(scene.repo, 'node_modules', 'pkg', '.gitattributes'), '*.dat filter=evil\n')
    assert.equal(await hasFilterAttributes(scene.runner, workspace), false, '被忽略的目录里的不算')
    // index 里有、工作树里删了的读不到，跳过不算错。
    await mkdir(join(scene.repo, 'tracked'), { recursive: true })
    await write(join(scene.repo, 'tracked', '.gitattributes'), '*.dat filter=evil\n')
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '-m', 'attrs'])
    await rm(join(scene.repo, 'tracked', '.gitattributes'))
    assert.equal(await hasFilterAttributes(scene.runner, workspace), false, '工作树里删了的跳过')
    await rm(join(scene.repo, 'node_modules'), { recursive: true, force: true })
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('git 层：链接 worktree 里主仓库 .git/info/attributes 的 filter= 也认（--git-path 解析到公共目录）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-git-'))
  try {
    const main = join(work, 'main')
    await runGit(work, ['init', main])
    await write(join(main, 'a.txt'), 'a\n')
    const added = await runGit(main, [...COMMIT_IDENTITY, 'add', '-A'])
    assert.equal(added.exitCode, 0, added.stderr)
    const committed = await runGit(main, [...COMMIT_IDENTITY, 'commit', '-m', 'one'])
    assert.equal(committed.exitCode, 0, committed.stderr)
    // 链接 worktree 的 gitDir 是 .git/worktrees/x；info/attributes 在主仓库的公共目录里。
    await mkdir(join(main, '.git', 'info'), { recursive: true })
    await write(join(main, '.git', 'info', 'attributes'), '*.dat filter=lfs\n')
    const wt = await runGit(main, ['worktree', 'add', join(work, 'wt1')])
    assert.equal(wt.exitCode, 0, wt.stderr)
    const subprocess = createLocalSubprocess({ home: join(work, 'home') })
    const runner = createGitRunner(subprocess, await resolveGitExecutable(subprocess, undefined), { hooksDir: join(work, 'no-hooks') })
    const workspace = await locateWorkspace(runner, join(work, 'wt1'), join(work, 'store', 's1'))
    assert.ok(workspace.gitDir.endsWith(join('.git', 'worktrees', 'wt1')), '链接 worktree 的 gitDir 在 worktrees 下')
    assert.equal(await hasFilterAttributes(runner, workspace), true, '公共目录里 info/attributes 的 filter= 要认出来')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('git 层：locateWorkspace 排除整个 checkpoints 根，别的会话的存储不进快照', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-git-'))
  try {
    const repo = join(work, 'repo')
    await runGit(work, ['init', repo])
    await write(join(repo, 'a.txt'), 'a\n')
    const checkpointsRoot = join(work, 'home', 'dsh-workbench', 'checkpoints')
    // 两个会话的存储都建在 checkpoints 根下面，当前会话的 scratch 是其中一个。
    const sessionDir = join(checkpointsRoot, 's1')
    await mkdir(join(checkpointsRoot, 's2', 'objects'), { recursive: true })
    await write(join(checkpointsRoot, 's2', 'checkpoints.jsonl'), '{"turn":1}\n')
    const subprocess = createLocalSubprocess({ home: join(work, 'git-home') })
    const runner = createGitRunner(subprocess, await resolveGitExecutable(subprocess, undefined), { hooksDir: join(work, 'no-hooks') })
    const workspace = await locateWorkspace(runner, repo, sessionDir, checkpointsRoot)
    assert.equal(workspace.root, await realpath(repo))
    const tree = await snapshotTree(runner, workspace)
    const listing = await runner.run(['ls-tree', '-r', '--name-only', tree], { cwd: repo, env: workspace.env })
    assert.deepEqual(listing.stdout.split('\n').filter(name => name !== ''), ['a.txt'])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('git 层：从根目录探测 macOS 系统 Git', { skip: process.platform !== 'darwin' }, async () => {
  const subprocess = {
    resolveExecutable: async () => '/usr/bin/git',
    spawn({ argv, cwd }) {
      if (typeof cwd !== 'string') throw new TypeError('DSH subprocess requires a string cwd')
      assert.deepEqual(argv, ['/usr/bin/xcode-select', '-p'])
      assert.equal(cwd, '/')
      return { done: Promise.resolve({ exitCode: 0 }) }
    },
  }
  assert.equal(await resolveGitExecutable(subprocess), '/usr/bin/git')
})

test('git 层：未指定工作目录时，运行器在启动前报错', async () => {
  const subprocess = { spawn: () => assert.fail('没有工作目录时不能启动 git') }
  const runner = createGitRunner(subprocess, 'git', { hooksDir: '/no-hooks' })
  await assert.rejects(runner.run(['status']), {
    name: 'TypeError',
    message: /requires options\.cwd/,
  })
})

test('git 层：xcode-select 卡住时 resolveGitExecutable 最多等 10 秒（可注入更短的探测超时）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-git-'))
  try {
    const base = createLocalSubprocess({ home: join(work, 'home') })
    let aborted = false
    // xcode-select 永不退出，但尊重中止信号（DSH 的 subprocess 本地提供方收到 abort 会杀进程）。
    const hung = {
      resolveExecutable: base.resolveExecutable,
      spawn(spec) {
        if (!spec.argv[0].endsWith('xcode-select')) return base.spawn(spec)
        const done = new Promise(resolve => {
          spec.signal?.addEventListener('abort', () => {
            aborted = true
            resolve({ exitCode: null })
          })
        })
        return { done, collected: {} }
      },
    }
    const started = Date.now()
    const resolved = await resolveGitExecutable(hung, undefined, 80)
    assert.equal(resolved, null, '探测超时后当没有 git')
    assert.equal(aborted, true, '超时靠中止信号传给子进程')
    assert.ok(Date.now() - started < 5_000, '不会一直等下去')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

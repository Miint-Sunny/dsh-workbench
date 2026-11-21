/**
 * 第 40 件验收时补的回归测试：
 * - treeComplete 不能把含 gitlink（嵌套仓库、submodule）的树当成不完整；
 * - treeComplete、ignoredByTree 的结果不受运行器输出上限影响（输出和整棵树成正比的做法，
 *   在大树上会漏掉尾部）；
 * - ignoredByTree 只看检查点的忽略规则，路径在不在用户仓库的 index 里不影响；
 * - 含嵌套仓库的仓库，检查点能预览和恢复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService } from '../lib/checkpoints.js'
import {
  createGitRunner, ignoredByTree, locateWorkspace, resolveGitExecutable, snapshotTree, treeComplete,
} from '../lib/checkpoints-git.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid']

/**
 * 搭一个 git 仓库场景，运行器的输出上限可调（模拟大树撞上限）。
 * @param {number} [outputMaxBytes] 运行器的输出上限。
 * @returns {Promise<{ work: string, repo: string, runner: object, openWorkspace: () => Promise<object> }>} 场景。
 */
async function scene(outputMaxBytes) {
  const work = mkdtempSync(join(tmpdir(), 'dwb-fix-'))
  const repo = join(work, 'repo')
  const subprocess = createLocalSubprocess({ home: join(work, 'home') })
  const executable = await resolveGitExecutable(subprocess, undefined)
  assert.notEqual(executable, null, '这台机器上要有可用的 git')
  const hooksDir = join(work, 'no-hooks')
  await mkdir(hooksDir, { recursive: true })
  const runner = createGitRunner(subprocess, executable, {
    ...(outputMaxBytes === undefined ? {} : { outputMaxBytes }),
    hooksDir,
  })
  const made = await runGit(work, ['init', repo])
  assert.equal(made.exitCode, 0, made.stderr)
  return { work, repo, runner, openWorkspace: () => locateWorkspace(runner, repo, join(work, 'store', 's1')) }
}

/** 往 repo 里放一个带一次提交的嵌套仓库。 */
async function addNestedRepo(repo) {
  const nested = join(repo, 'vendor-lib')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'lib.js'), 'lib\n')
  for (const args of [['init'], ['add', '-A'], ['commit', '-m', 'lib']]) {
    const result = await runGit(nested, [...identity, ...args])
    assert.equal(result.exitCode, 0, result.stderr)
  }
}

test('treeComplete：树里有 gitlink（嵌套仓库）时，对象都在就答完整', async () => {
  const s = await scene()
  try {
    await writeFile(join(s.repo, 'a.txt'), 'a\n')
    await addNestedRepo(s.repo)
    const workspace = await s.openWorkspace()
    const tree = await snapshotTree(s.runner, workspace)
    const listing = await s.runner.run(['ls-tree', tree], { cwd: workspace.root, env: workspace.env })
    assert.match(listing.stdout, /160000 commit [0-9a-f]{40}\tvendor-lib/, '检查点树里要有 gitlink 才算测到了这一条')
    assert.equal(await treeComplete(s.runner, workspace, tree), true)
  } finally {
    await rm(s.work, { recursive: true, force: true })
  }
})

test('treeComplete：输出上限很小、树很大时，排在尾部的 blob 丢了也答不完整', async () => {
  const s = await scene(512)
  try {
    for (let index = 0; index < 60; index++) await writeFile(join(s.repo, `file-with-a-long-name-${String(index).padStart(3, '0')}.txt`), 'x\n')
    await mkdir(join(s.repo, 'zzzz'), { recursive: true })
    const tailBody = 'content that only the very last tree entry refers to\n'
    await writeFile(join(s.repo, 'zzzz', 'tail.txt'), tailBody)
    const workspace = await s.openWorkspace()
    const tree = await snapshotTree(s.runner, workspace)
    assert.equal(await treeComplete(s.runner, workspace, tree), true)
    const listing = await s.runner.run(['ls-tree', '-r', '-t', '-z', tree], { cwd: workspace.root, env: workspace.env })
    assert.equal(listing.truncated, true, '这个场景要让整棵树的列表超过输出上限')
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(tailBody)}\0${tailBody}`).digest('hex')
    const loose = join(workspace.objects, sha.slice(0, 2), sha.slice(2))
    assert.equal(existsSync(loose), true)
    await rm(loose)
    assert.equal(await treeComplete(s.runner, workspace, tree), false)
  } finally {
    await rm(s.work, { recursive: true, force: true })
  }
})

test('ignoredByTree：整棵树的列表超过输出上限时，尾部目录里的 .gitignore 仍然生效', async () => {
  const s = await scene(512)
  try {
    for (let index = 0; index < 60; index++) await writeFile(join(s.repo, `file-with-a-long-name-${String(index).padStart(3, '0')}.txt`), 'x\n')
    await mkdir(join(s.repo, 'zzzz'), { recursive: true })
    await writeFile(join(s.repo, 'zzzz', '.gitignore'), '*.log\n')
    await writeFile(join(s.repo, 'zzzz', 'keep.txt'), 'k\n')
    const workspace = await s.openWorkspace()
    const tree = await snapshotTree(s.runner, workspace)
    const listing = await s.runner.run(['ls-tree', '-r', '-z', '--name-only', tree], { cwd: workspace.root, env: workspace.env })
    assert.equal(listing.truncated, true, '这个场景要让整棵树的列表超过输出上限')
    const ignored = await ignoredByTree(s.runner, workspace, tree, ['zzzz/a.log', 'zzzz/keep2.txt'])
    assert.deepEqual([...ignored], ['zzzz/a.log'])
  } finally {
    await rm(s.work, { recursive: true, force: true })
  }
})

test('ignoredByTree：路径在用户仓库的 index 里已跟踪，也按检查点的规则判', async () => {
  const s = await scene()
  try {
    await writeFile(join(s.repo, '.gitignore'), '*.log\n')
    const workspace = await s.openWorkspace()
    const tree = await snapshotTree(s.runner, workspace)
    // 检查点之后：x.log 被强制加进仓库并提交（已跟踪），但检查点的规则把 *.log 忽略。
    await writeFile(join(s.repo, 'x.log'), 'tracked although ignored\n')
    for (const args of [['add', '-f', 'x.log', '.gitignore'], ['commit', '-m', 'track x.log']]) {
      const result = await runGit(s.repo, [...identity, ...args])
      assert.equal(result.exitCode, 0, result.stderr)
    }
    const tracked = await runGit(s.repo, ['ls-files', '--error-unmatch', 'x.log'])
    assert.equal(tracked.exitCode, 0, 'x.log 要是已跟踪的才算测到了这一条')
    const inTree = await s.runner.run(['ls-tree', '--name-only', tree], { cwd: workspace.root, env: workspace.env })
    assert.equal(inTree.stdout.includes('x.log'), false, 'x.log 在检查点之后才有，不在检查点树里')
    const ignored = await ignoredByTree(s.runner, workspace, tree, ['x.log'])
    assert.deepEqual([...ignored], ['x.log'])
  } finally {
    await rm(s.work, { recursive: true, force: true })
  }
})

test('服务层：仓库里有嵌套仓库，检查点能预览也能恢复（不被当成已失效）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-fix-svc-'))
  try {
    const repo = join(work, 'repo')
    const made = await runGit(work, ['init', repo])
    assert.equal(made.exitCode, 0, made.stderr)
    await writeFile(join(repo, 'app.js'), 'v0\n')
    await addNestedRepo(repo)
    const home = join(work, 'dsh-home')
    writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
    const service = createCheckpointsService({
      subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
      fs: { processPath: target => target.path },
      agents: { get: () => undefined },
      dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
      configDir: join(home, 'dsh-workbench'),
      logger: { warn: () => {}, info: () => {} },
    })
    const exec = { agent: { session: { id: 's1' } } }
    const turn = async number => {
      service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: number * 10, data: { turn: number } })
      await service.onPreExecute(exec, () => 'ok')
    }
    await turn(1)
    await writeFile(join(repo, 'app.js'), 'v1 edited by the agent\n')
    await turn(2)
    const preview = await service.preview('s1', 1)
    assert.equal(preview.status, 200)
    assert.deepEqual((await preview.json()).files.map(file => [file.path, file.action]), [['app.js', 'restore']])
    const restore = await service.restore('s1', 1)
    assert.equal(restore.status, 200)
    assert.equal(await readFile(join(repo, 'app.js'), 'utf8'), 'v0\n')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('清理：检查点根目录下的 .no-hooks 不当成「会话不在了」的目录删掉', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-fix-clean-'))
  try {
    const repo = join(work, 'repo')
    const made = await runGit(work, ['init', repo])
    assert.equal(made.exitCode, 0, made.stderr)
    await writeFile(join(repo, 'a.txt'), 'a\n')
    const home = join(work, 'dsh-home')
    const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
    writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
    const service = createCheckpointsService({
      subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
      fs: { processPath: target => target.path },
      agents: { get: () => undefined },
      dataRoot,
      configDir: join(home, 'dsh-workbench'),
      logger: { warn: () => {}, info: () => {} },
      sessionPersistence: { list: async () => [{ header: { id: 's1' } }] },
    })
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
    await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => 'ok')
    assert.equal(existsSync(join(dataRoot, '.no-hooks')), true, '跑过一轮以后运行器的 .no-hooks 在数据目录下')
    await service.cleanup()
    assert.equal(existsSync(join(dataRoot, '.no-hooks')), true)
    assert.equal(existsSync(join(dataRoot, 's1')), true)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

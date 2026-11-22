/**
 * 第 40 件阶段二（恢复要安全）的服务层回归测试（lib/checkpoints.js + git/files 层）：
 * files 种类不跟着目录符号链接写到工作区外（unsafe-path）；超过 maxFileMB 的当前文件
 * 不改不删（oversized）；files 恢复用每条检查点自己的 root；撤销有过期判断（undo-stale）、
 * 撤销自己先存「撤销前」的点；恢复期间新轮次的工具等恢复结束、恢复开始后再查一次运行中；
 * 树里缺对象整个答 410 一个文件不碰、做到一半失败写明改了哪些；不清会话工作目录；
 * 预览和恢复用同一个计划、preview 给 counts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService } from '../lib/checkpoints.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

const write = (path, text) => writeFile(path, text, 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 搭一套服务场景：真 git 或普通目录当工作区、可注入的运行态表。
 * @param {{ cwd?: string, initGit?: boolean, maxFileMB?: number, waitSeconds?: number, slowMs?: number }} [options]
 * @returns 情景。
 */
async function restoreScenario(options = {}) {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rst-'))
  const cwd = options.cwd ?? join(work, 'repo')
  if (options.initGit !== false) {
    const made = await runGit(work, ['init', cwd])
    assert.equal(made.exitCode, 0, made.stderr)
  } else {
    await mkdir(cwd, { recursive: true })
  }
  const home = join(work, 'dsh-home')
  const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), {
    keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: options.waitSeconds ?? 5, maxFileMB: options.maxFileMB ?? 2,
  })
  const base = createLocalSubprocess({ home: join(work, 'git-home') })
  const subprocess = options.slowMs === undefined ? base : {
    resolveExecutable: base.resolveExecutable,
    spawn(spec) {
      const handle = base.spawn(spec)
      return {
        done: (async () => { await sleep(options.slowMs); return handle.done })(),
        collected: handle.collected,
      }
    },
  }
  const running = new Set()
  const warnLog = []
  const service = createCheckpointsService({
    subprocess,
    fs: { processPath: target => target.path },
    agents: { get: id => (running.has(id) ? { status: 'running' } : undefined) },
    dataRoot,
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: message => warnLog.push(message), info: () => {} },
  })
  return { work, cwd, home, dataRoot, service, running, warnLog }
}

/** 起一轮并等检查点存完，返回这一轮的 exec。 */
async function startTurn(service, sessionId, turn, cwd) {
  service.onSessionEvent({ id: sessionId, header: { cwd } }, { type: 'turn/start', seq: turn * 10, data: { turn } })
  const exec = { agent: { session: { id: sessionId } } }
  await service.onPreExecute(exec, () => 'ok')
  return exec
}

/** 文件工具改一个文件：fs 钩子先跑（捕获），放行后才真的改。 */
async function toolWrites(service, exec, path, text) {
  await service.onFsIntent({ path }, exec, async () => 1)
  if (text === null) await rm(path, { force: true })
  else await writeFile(path, text)
}

/**
 * e5、e5b 的场景：第 1 轮文件工具改了 lib/foo.js、新建了 lib/new.js（keep 时还改了工作区里的
 * keep.txt），之后用户把 lib 挪走，原地留一个指向工作区外 OUTSIDE 目录的符号链接。
 * @returns {Promise<{ ws: string, outside: string }>} 工作区和外面的目录。
 */
async function linkLibOutside(scene, { keep = false } = {}) {
  const ws = scene.cwd
  const outside = join(scene.work, 'OUTSIDE')
  await mkdir(join(ws, 'lib'), { recursive: true })
  await mkdir(outside)
  await write(join(ws, 'lib', 'foo.js'), 'workspace copy\n')
  await write(join(outside, 'foo.js'), 'OUTSIDE user data\n')
  await write(join(outside, 'new.js'), 'OUTSIDE new\n')
  if (keep) await write(join(ws, 'keep.txt'), 'v0\n')
  const exec = await startTurn(scene.service, 's1', 1, ws)
  await toolWrites(scene.service, exec, join(ws, 'lib', 'foo.js'), 'edited\n')
  await toolWrites(scene.service, exec, join(ws, 'lib', 'new.js'), 'agent new\n')
  if (keep) await toolWrites(scene.service, exec, join(ws, 'keep.txt'), 'edited\n')
  await rm(join(ws, 'lib'), { recursive: true })
  await symlink(outside, join(ws, 'lib'))
  return { ws, outside }
}

test('恢复：files 种类目录符号链接指到工作区外，跳过并标 unsafe-path（e5）', async () => {
  const scene = await restoreScenario({ initGit: false })
  try {
    const { ws, outside } = await linkLibOutside(scene)

    const preview = await (await scene.service.preview('s1', 1)).json()
    assert.equal(preview.ok, true)
    assert.deepEqual(preview.files.map(file => [file.path, file.action, file.reason]), [
      ['lib/foo.js', 'skip', 'unsafe-path'],
      ['lib/new.js', 'skip', 'unsafe-path'],
    ])
    assert.deepEqual(preview.counts, { restore: 0, delete: 0, skip: 2 })
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    assert.deepEqual(restored.skipped.map(item => [item.path, item.reason]), [['lib/foo.js', 'unsafe-path'], ['lib/new.js', 'unsafe-path']])
    // 外面的文件一个都没动。
    assert.equal(await readFile(join(outside, 'foo.js'), 'utf8'), 'OUTSIDE user data\n')
    assert.equal(existsSync(join(outside, 'new.js')), true)
    // 全部跳过就是没有文件要改，不写撤销点（TC-004）。
    assert.equal(existsSync(join(scene.dataRoot, 's1', 'restore.json')), false, '全部跳过不写撤销点')
    // 工作区里的符号链接原样保留。
    assert.equal(lstatSync(join(ws, 'lib')).isSymbolicLink(), true)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：files 种类同时有要恢复的文件时，撤销点只存工作区里的文件，撤销不碰外面（e5b）', async () => {
  const scene = await restoreScenario({ initGit: false })
  try {
    const { ws, outside } = await linkLibOutside(scene, { keep: true })
    const preview = await (await scene.service.preview('s1', 1)).json()
    assert.deepEqual(preview.counts, { restore: 1, delete: 0, skip: 2 })
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.restored, 1)
    assert.equal(await readFile(join(ws, 'keep.txt'), 'utf8'), 'v0\n')
    const undoPoint = JSON.parse(await readFile(join(scene.dataRoot, 's1', 'restore.json'), 'utf8'))
    assert.deepEqual(Object.keys(undoPoint.captures), ['keep.txt'], '撤销点不存外面的文件')
    const undone = await (await scene.service.undo('s1')).json()
    assert.equal(undone.ok, true)
    assert.equal(await readFile(join(ws, 'keep.txt'), 'utf8'), 'edited\n')
    assert.equal(await readFile(join(outside, 'foo.js'), 'utf8'), 'OUTSIDE user data\n')
    assert.equal(await readFile(join(outside, 'new.js'), 'utf8'), 'OUTSIDE new\n')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：files 种类超过 maxFileMB 的当前文件不改不删，预览同标（e6）', async () => {
  const scene = await restoreScenario({ initGit: false, maxFileMB: 1 })
  try {
    const ws = scene.cwd
    const exec = await startTurn(scene.service, 's1', 1, ws)
    await toolWrites(scene.service, exec, join(ws, 'data.json'), '{"small":true}\n')
    await toolWrites(scene.service, exec, join(ws, 'big-new.log'), null)
    await write(join(ws, 'data.json'), 'x'.repeat(1.5 * 1024 * 1024))
    await write(join(ws, 'big-new.log'), 'y'.repeat(1.5 * 1024 * 1024))

    const preview = await (await scene.service.preview('s1', 1)).json()
    assert.deepEqual(preview.files.map(file => [file.path, file.action, file.reason]), [
      ['big-new.log', 'skip', 'oversized'],
      ['data.json', 'skip', 'oversized'],
    ])
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.restored, 0)
    assert.equal(statSync(join(ws, 'data.json')).size, 1.5 * 1024 * 1024, '改过的当前文件不被覆盖')
    assert.equal(existsSync(join(ws, 'big-new.log')), true, '超限的新文件不被删')
    // 撤销同样不碰它们。
    await scene.service.undo('s1')
    assert.equal(statSync(join(ws, 'data.json')).size, 1.5 * 1024 * 1024)
    assert.equal(existsSync(join(ws, 'big-new.log')), true)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：files 用每条检查点自己的 root，不被后来的轮次改写（e1）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rst-'))
  try {
    const repo = join(work, 'repo')
    const sub = join(repo, 'sub')
    await runGit(work, ['init', repo])
    await mkdir(sub, { recursive: true })
    await write(join(sub, 'a.txt'), 'SUB original a\n')
    await write(join(repo, 'a.txt'), 'REPO-ROOT a\n')
    await write(join(repo, 'b.txt'), 'REPO-ROOT b\n')
    const home = join(work, 'dsh-home')
    const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
    writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
    const quiet = { warn: () => {}, info: () => {} }
    // 第一个服务：没有 git，第 1 轮记 files 种类（root 是 repo/sub）。
    const s1 = createCheckpointsService({
      subprocess: { resolveExecutable: async () => { throw new Error('no git') }, spawn: () => { throw new Error('unused') } },
      fs: { processPath: target => target.path }, agents: { get: () => undefined },
      dataRoot, configDir: join(home, 'dsh-workbench'), logger: quiet,
    })
    const exec = await startTurn(s1, 's1', 1, sub)
    await toolWrites(s1, exec, join(sub, 'a.txt'), 'SUB edited\n')
    await toolWrites(s1, exec, join(sub, 'b.txt'), 'SUB new b\n')
    // 「重启」后有 git：第 2 轮是 git 种类，root 是 repo/。
    const s2 = createCheckpointsService({
      subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
      fs: { processPath: target => target.path }, agents: { get: () => undefined },
      dataRoot, configDir: join(home, 'dsh-workbench'), logger: quiet,
    })
    await startTurn(s2, 's1', 2, sub)
    // 恢复第 1 轮：只用第 1 轮自己的 root（repo/sub），仓库根的文件不动。
    const preview = await (await s2.preview('s1', 1)).json()
    assert.equal(preview.kind, 'files')
    assert.equal(preview.root, await realpath(sub))
    const restored = await (await s2.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    assert.equal(await readFile(join(sub, 'a.txt'), 'utf8'), 'SUB original a\n')
    assert.equal(existsSync(join(sub, 'b.txt')), false)
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'REPO-ROOT a\n', '仓库根的别的文件不动')
    assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'REPO-ROOT b\n')
    // 撤销也用条目自己的 root。
    await s2.undo('s1')
    assert.equal(await readFile(join(sub, 'a.txt'), 'utf8'), 'SUB edited\n')
    assert.equal(existsSync(join(sub, 'b.txt')), true)
    assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'REPO-ROOT b\n')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('恢复：树里缺对象整个答 410，一个文件不碰（e15）', async () => {
  const scene = await restoreScenario({})
  try {
    const g = (...args) => runGit(scene.cwd, [...COMMIT_IDENTITY, ...args])
    await write(join(scene.cwd, 'keep.txt'), 'K1 committed\n')
    await g('add', '-A')
    await g('commit', '-m', 'one')
    await write(join(scene.cwd, 'pending.txt'), 'P1 untracked\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    // 改历史再 gc：检查点树还引用的 blob 被清掉。
    await write(join(scene.cwd, 'keep.txt'), 'K2 amended\n')
    await g('add', '-A')
    await g('commit', '--amend', '-m', 'one-amended')
    await g('reflog', 'expire', '--expire=now', '--all')
    await g('gc', '--prune=now')
    await write(join(scene.cwd, 'later.txt'), 'created after\n')
    await write(join(scene.cwd, 'pending.txt'), 'P2 edited\n')
    for (const method of ['preview', 'restore']) {
      const response = await scene.service[method]('s1', 1)
      assert.equal(response.status, 410, `${method} 答 410 不是 500`)
      assert.equal((await response.json()).reason, 'expired')
    }
    assert.equal(await readFile(join(scene.cwd, 'later.txt'), 'utf8'), 'created after\n', '一个文件都不碰')
    assert.equal(await readFile(join(scene.cwd, 'pending.txt'), 'utf8'), 'P2 edited\n')
    assert.equal(await readFile(join(scene.cwd, 'keep.txt'), 'utf8'), 'K2 amended\n')
    assert.equal(existsSync(join(scene.dataRoot, 's1', 'restore.json')), false, '没有写撤销点')
    const listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.undo, null)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：做到一半失败写明已经改了哪些，撤销点留着能用', async () => {
  const scene = await restoreScenario({})
  try {
    // 检查点时仓库是空的；之后建 a.txt 和 locked/x.txt，再把 locked 目录改成不可写。
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'a.txt'), '新建的 a\n')
    await mkdir(join(scene.cwd, 'locked'))
    await write(join(scene.cwd, 'locked', 'x.txt'), 'locked file\n')
    await chmod(join(scene.cwd, 'locked'), 0o500)
    let response
    try {
      response = await scene.service.restore('s1', 1)
    } finally {
      await chmod(join(scene.cwd, 'locked'), 0o755)
    }
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.reason, 'failed')
    // 宿主只给原因码和数据（chore#106）：是恢复、已经改了哪些、系统的原始报错；句子由网页端按界面语言写。
    assert.equal(body.operation, 'restore')
    assert.deepEqual(body.changed, ['a.txt'])
    assert.match(body.detail, /locked\/x\.txt/u)
    assert.match(body.detail, /EACCES|permission denied/iu)
    assert.doesNotMatch(body.detail, /中途失败|已修改|撤销点/u, '原始报错里没有宿主拼的中文')
    assert.equal(existsSync(join(scene.cwd, 'a.txt')), false, 'a.txt 已经删掉')
    assert.equal(await readFile(join(scene.cwd, 'locked', 'x.txt'), 'utf8'), 'locked file\n', '删不动的还在')
    // 撤销点保留：撤销能把 a.txt 写回来。
    assert.equal(existsSync(join(scene.dataRoot, 's1', 'restore.json')), true)
    const undone = await (await scene.service.undo('s1')).json()
    assert.equal(undone.ok, true)
    assert.equal(await readFile(join(scene.cwd, 'a.txt'), 'utf8'), '新建的 a\n')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：恢复期间新的一轮的工具等恢复结束，不抢着写（e22）', async () => {
  // 每条 git 200 ms，整次恢复约 2 秒，远超 waitSeconds：旧代码会在 1 秒超时放行第一个工具。
  const scene = await restoreScenario({ slowMs: 200, waitSeconds: 1 })
  try {
    await write(join(scene.cwd, 'a.txt'), 'v0\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'a.txt'), 'v1\n')
    const started = Date.now()
    let restoreDone = 0
    const restoring = scene.service.restore('s1', 1).then(async response => {
      restoreDone = Date.now() - started
      return response.json()
    })
    await sleep(250)
    // 用户在恢复进行中发了新消息：新的一轮开始，第一个工具要等恢复做完。
    const exec = { agent: { session: { id: 's1' } } }
    scene.service.onSessionEvent({ id: 's1', header: { cwd: scene.cwd } }, { type: 'turn/start', seq: 20, data: { turn: 2 } })
    await scene.service.onPreExecute(exec, () => 'ok')
    const released = Date.now() - started
    // 工具放行后立刻写一笔。
    await write(join(scene.cwd, 'a.txt'), 'v2 (new turn)\n')
    const restored = await restoring
    assert.equal(restored.ok, true)
    assert.ok(released >= restoreDone - 50, `第一个工具在恢复结束后才放行（放行 ${released} ms，恢复完成 ${restoreDone} ms）`)
    assert.equal(await readFile(join(scene.cwd, 'a.txt'), 'utf8'), 'v2 (new turn)\n', '恢复没有覆盖新的一轮写的文件')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：恢复开始后再查一次运行中，新的一轮让恢复放弃（不碰文件）', async () => {
  const scene = await restoreScenario({ slowMs: 150 })
  try {
    await write(join(scene.cwd, 'a.txt'), 'v0\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'a.txt'), 'v1\n')
    // 第 2 轮的检查点先排上（每条 git 150 ms），恢复排在它后面。
    scene.service.onSessionEvent({ id: 's1', header: { cwd: scene.cwd } }, { type: 'turn/start', seq: 20, data: { turn: 2 } })
    const restoring = scene.service.restore('s1', 1)
    await sleep(250)
    // 恢复还在排队，用户这时发了新消息：会话变成运行中。
    scene.running.add('s1')
    const response = await restoring
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'running')
    assert.equal(await readFile(join(scene.cwd, 'a.txt'), 'utf8'), 'v1\n', '恢复没碰文件')
    assert.equal(existsSync(join(scene.dataRoot, 's1', 'restore.json')), false, '没写撤销点')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('恢复：不清会话工作目录和它的祖先（e3）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rst-'))
  try {
    const repo = join(work, 'repo')
    await runGit(work, ['init', repo])
    const cwd = join(repo, 'newpkg', 'src')
    await write(join(repo, 'README.md'), 'x\n')
    await mkdir(cwd, { recursive: true })
    const home = join(work, 'dsh-home')
    const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
    writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
    const service = createCheckpointsService({
      subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
      fs: { processPath: target => target.path },
      agents: { get: () => undefined },
      dataRoot, configDir: join(home, 'dsh-workbench'),
      logger: { warn: () => {}, info: () => {} },
    })
    await startTurn(service, 's1', 1, cwd)
    await write(join(cwd, 'index.js'), 'agent made this\n')
    const restored = await (await service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    assert.equal(existsSync(join(cwd, 'index.js')), false)
    assert.equal(existsSync(cwd), true, '会话工作目录还在')
    assert.equal(existsSync(join(repo, 'newpkg')), true, '祖先目录还在')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('恢复：预览和恢复用同一个计划（.gitignore 改过，e16）', async () => {
  const scene = await restoreScenario({})
  try {
    await write(join(scene.cwd, '.gitignore'), 'keep.log\n')
    await write(join(scene.cwd, 'b'), 'b was a file\n')
    await write(join(scene.cwd, 'x.txt'), 'x\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    // 之后：b 变成装着被忽略文件的目录，.gitignore 清空。
    await rm(join(scene.cwd, 'b'))
    await mkdir(join(scene.cwd, 'b'))
    await write(join(scene.cwd, 'b', 'keep.log'), 'user log\n')
    await write(join(scene.cwd, '.gitignore'), '')

    const preview = await (await scene.service.preview('s1', 1)).json()
    assert.equal(preview.ok, true)
    const actions = preview.files.map(file => [file.path, file.action, file.reason ?? ''])
    assert.deepEqual(actions, [
      ['.gitignore', 'restore', ''],
      ['b', 'skip', 'ignored-inside'],
    ])
    assert.deepEqual(preview.counts, { restore: 1, delete: 0, skip: 1 })
    // 预览说 b/keep.log 不会动：不在列表里，恢复也不动它。
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.restored, 1)
    assert.deepEqual(restored.skipped, [{ path: 'b', reason: 'ignored-inside' }])
    assert.equal(await readFile(join(scene.cwd, '.gitignore'), 'utf8'), 'keep.log\n')
    assert.equal(await readFile(join(scene.cwd, 'b', 'keep.log'), 'utf8'), 'user log\n', '被忽略的文件保留')
    assert.equal(existsSync(join(scene.cwd, 'x.txt')), true)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('撤销：恢复之后工作区又改过，list 答 null、undo 答 409 undo-stale（e2）', async () => {
  const scene = await restoreScenario({})
  try {
    await write(join(scene.cwd, 'app.js'), 'v0\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'app.js'), 'v1\n')
    await startTurn(scene.service, 's1', 2, scene.cwd)
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    assert.equal(await readFile(join(scene.cwd, 'app.js'), 'utf8'), 'v0\n')
    // 用户接着干：新的一轮跑了，写了不少新东西。
    await startTurn(scene.service, 's1', 3, scene.cwd)
    await write(join(scene.cwd, 'app.js'), 'v2 NEW WORK\n')
    await write(join(scene.cwd, 'new-module.js'), 'brand new\n')
    let listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.undo, null, '过期的撤销不再提供')
    const response = await scene.service.undo('s1')
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'undo-stale')
    assert.equal(await readFile(join(scene.cwd, 'app.js'), 'utf8'), 'v2 NEW WORK\n', '新工作没有被撤销掉')
    assert.equal(existsSync(join(scene.cwd, 'new-module.js')), true)
    // 撤销点还在（没有清掉），但一直答过期。
    listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.undo, null)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('撤销：files 种类恢复之后文件被手改，undo 答 409（真核对，不靠内存标记）', async () => {
  const scene = await restoreScenario({ initGit: false })
  try {
    const ws = join(scene.work, 'workspace')
    await mkdir(ws, { recursive: true })
    const service = createCheckpointsService({
      subprocess: createLocalSubprocess({ home: join(scene.work, 'git-home') }),
      fs: { processPath: target => target.path },
      agents: { get: () => undefined },
      dataRoot: scene.dataRoot,
      configDir: join(scene.home, 'dsh-workbench'),
      logger: { warn: () => {}, info: () => {} },
    })
    const exec = await startTurn(service, 's1', 1, ws)
    await toolWrites(service, exec, join(ws, 'a.txt'), '改了\n')
    await (await service.restore('s1', 1)).json()
    // 不经过任何工具，直接手改。list 只看盘上的检查点时间（第 42 件），手改看不出来，
    // undo 还列着；undo 路由里 afterCaptures 的真核对兜底，点了才答过期。
    await write(join(ws, 'a.txt'), '手工改的\n')
    let listed = await (await service.list('s1')).json()
    assert.notEqual(listed.undo, null, '没有新检查点，list 的 undo 还在（手改由 undo 路由核对）')
    const response = await service.undo('s1')
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'undo-stale')
    assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), '手工改的\n')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('撤销：成功后撤销点清掉，list 的 undo 回到 null，再撤销答 404', async () => {
  const scene = await restoreScenario({})
  try {
    await write(join(scene.cwd, 'app.js'), 'v0\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'app.js'), 'v1\n')
    await startTurn(scene.service, 's1', 2, scene.cwd)
    await (await scene.service.restore('s1', 1)).json()
    assert.equal(await readFile(join(scene.cwd, 'app.js'), 'utf8'), 'v0\n')
    const undone = await (await scene.service.undo('s1')).json()
    assert.equal(undone.ok, true)
    assert.equal(await readFile(join(scene.cwd, 'app.js'), 'utf8'), 'v1\n')
    const listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.undo, null)
    const again = await scene.service.undo('s1')
    assert.equal(again.status, 404)
    assert.equal((await again.json()).reason, 'no-checkpoint')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('撤销：做到一半失败时答 500 failed，撤销点还在', { skip: process.getuid?.() === 0 }, async () => {
  const scene = await restoreScenario({})
  try {
    await write(join(scene.cwd, 'app.js'), 'v0\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'app.js'), 'v1\n')
    await startTurn(scene.service, 's1', 2, scene.cwd)
    await (await scene.service.restore('s1', 1)).json()
    // 仓库根目录变成只读：撤销要把 app.js 写回 v1，写不进去。
    await chmod(scene.cwd, 0o555)
    try {
      const failed = await scene.service.undo('s1')
      assert.equal(failed.status, 500)
      const body = await failed.json()
      assert.equal(body.reason, 'failed')
      // 写回中途失败（chore#106）：是撤销、还没改动任何文件、git 的原始报错。
      assert.equal(body.operation, 'undo')
      assert.deepEqual(body.changed, [])
      assert.match(body.detail, /checkout-index/u)
    } finally {
      await chmod(scene.cwd, 0o755)
    }
    assert.equal(await readFile(join(scene.cwd, 'app.js'), 'utf8'), 'v0\n')
    const listed = await (await scene.service.list('s1')).json()
    assert.notEqual(listed.undo, null, '失败时撤销点留在盘上')
  } finally {
    await chmod(scene.cwd, 0o755).catch(() => {})
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('chore#106 预览、恢复、撤销：工作目录已不在 git 仓库中时答 409 not-in-repo，带上工作目录，一个文件都不碰', async () => {
  const scene = await restoreScenario({})
  try {
    await write(join(scene.cwd, 'app.js'), 'v0\n')
    await startTurn(scene.service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'app.js'), 'v1\n')
    await startTurn(scene.service, 's1', 2, scene.cwd)
    assert.equal((await (await scene.service.restore('s1', 1)).json()).ok, true)
    // 仓库被删掉（.git 不在了），工作目录还在：git rev-parse 答 not a git repository。
    await rm(join(scene.cwd, '.git'), { recursive: true, force: true })
    for (const [name, call] of [['preview', () => scene.service.preview('s1', 1)], ['restore', () => scene.service.restore('s1', 1)], ['undo', () => scene.service.undo('s1')]]) {
      const response = await call()
      assert.equal(response.status, 409, name)
      const body = await response.json()
      assert.equal(body.reason, 'not-in-repo', name)
      assert.equal(body.cwd, scene.cwd, name)
    }
    assert.equal(await readFile(join(scene.cwd, 'app.js'), 'utf8'), 'v0\n', '没有写回')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})


test('TW-001 Git undo retains the original target tree after a failed write and can retry', { skip: process.getuid?.() === 0 }, async t => {
  const scene = await restoreScenario({})
  t.after(async () => { await chmod(scene.cwd, 0o755); await scene.service.dispose(); await rm(scene.work, { recursive: true, force: true }) })
  const path = join(scene.cwd, 'app.js'), recordPath = join(scene.dataRoot, 's1', 'restore.json')
  await write(path, 'checkpoint\n')
  await startTurn(scene.service, 's1', 1, scene.cwd)
  await write(path, 'before restore\n')
  await scene.service.restore('s1', 1)
  const target = JSON.parse(await readFile(recordPath, 'utf8')).tree
  await chmod(scene.cwd, 0o555)
  assert.equal((await scene.service.undo('s1')).status, 500)
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).tree, target)
  await chmod(scene.cwd, 0o755)
  assert.equal((await scene.service.undo('s1')).status, 200)
  assert.equal(await readFile(path, 'utf8'), 'before restore\n')
})

test('TW-001 Git undo keeps skipped targets retryable without deleting ignored files', async t => {
  const scene = await restoreScenario({})
  t.after(async () => { await scene.service.dispose(); await rm(scene.work, { recursive: true, force: true }) })
  const path = join(scene.cwd, 'shape'), recordPath = join(scene.dataRoot, 's1', 'restore.json')
  await write(join(scene.cwd, '.gitignore'), 'shape/\n')
  await startTurn(scene.service, 's1', 1, scene.cwd)
  await write(path, 'before restore\n')
  assert.equal((await scene.service.restore('s1', 1)).status, 200)
  const target = JSON.parse(await readFile(recordPath, 'utf8')).tree
  await mkdir(path)
  await write(join(path, 'keep.txt'), 'ignored fixture\n')
  const failed = await scene.service.undo('s1')
  assert.equal(failed.status, 500)
  assert.ok((await failed.json()).skipped.some(item => item.path === 'shape'))
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).tree, target)
  assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'ignored fixture\n')
  await rm(path, { recursive: true })
  assert.equal((await scene.service.undo('s1')).status, 200)
  assert.equal(await readFile(path, 'utf8'), 'before restore\n')
})

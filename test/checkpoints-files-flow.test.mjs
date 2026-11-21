/**
 * 检查点 files 种类的整条链路（lib/checkpoints.js）：不在 git 里的目录 turn/start 记 files
 * 种类，fs/*-intent 在提供方改文件之前捕获（先 await next()，intent 原样交回），preview 列出
 * 会变的文件（notes 带 nongit），restore 写回，undo 撤销；git 仓库里的会话不走 files 种类；
 * 工作目录外的路径不记；超过 maxFileMB 的文件记 oversized、预览标 skip。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile, symlink, lstat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService } from '../lib/checkpoints.js'
import { createCheckpointsStore } from '../lib/checkpoints-store.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

/**
 * 搭一套 files 种类的场景：临时目录 work/ 不在任何 git 仓库里（tmpdir 下）。
 * @returns 情景：service、store、目录。
 */
async function filesScenario() {
  const work = mkdtempSync(join(tmpdir(), 'dwb-filesflow-'))
  const cwd = join(work, 'workspace')
  await mkdir(cwd, { recursive: true })
  const home = join(work, 'dsh-home')
  const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 1 })
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    // 假的 fs 服务：文件工具的目标在测试里直接用 { path } 表示。
    fs: { processPath: target => target.path },
    agents: { get: () => undefined },
    dataRoot,
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: () => {}, info: () => {} },
  })
  return { work, cwd, home, dataRoot, service, store: createCheckpointsStore(dataRoot) }
}

test('W-003: restore and undo never capture an external symlink target', async t => {
  const scene = await filesScenario()
  t.after(async () => { await scene.service.dispose(); await rm(scene.work, { recursive: true, force: true }) })
  const file = join(scene.cwd, 'plan.md'), external = join(scene.work, 'private.txt')
  await writeFile(file, 'old\n')
  await writeFile(external, 'private fixture\n')
  const exec = await startTurn(scene.service, 's1', 1, scene.cwd)
  await toolWrites(scene.service, exec, file, 'new\n')
  await rm(file)
  await symlink(external, file)
  const preview = await (await scene.service.preview('s1', 1)).json()
  assert(preview.files.some(row => row.path === 'plan.md' && row.reason === 'unsafe-path'))
  await scene.service.restore('s1', 1)
  await scene.service.undo('s1')
  assert((await lstat(file)).isSymbolicLink())
  assert.equal(await readFile(external, 'utf8'), 'private fixture\n')
})

/** 起一轮并等检查点存完（工具执行前的那一步）。 */
async function startTurn(service, sessionId, turn, cwd) {
  service.onSessionEvent({ id: sessionId, header: { cwd } }, { type: 'turn/start', seq: turn * 10, data: { turn } })
  const exec = { agent: { session: { id: sessionId } } }
  await service.onPreExecute(exec, () => 'allow')
  return exec
}

/**
 * 模拟文件工具改一个文件：fs 钩子先跑（捕获），钩子放行后才真的改，和提供方的顺序一样。
 * @returns {Promise<*>} 钩子交回的 intent。
 */
async function toolWrites(service, exec, path, text, event = 'write') {
  let nextCalls = 0
  const intent = await service.onFsIntent({ path }, exec, async () => {
    nextCalls += 1
    return { version: 7, event }
  })
  assert.equal(nextCalls, 1, 'next 只调一次')
  if (text === null) await rm(path, { force: true })
  else await writeFile(path, text)
  return intent
}

const post = (service, method, body) => service[method](body.sessionId, body.turn)

test('files 种类：存 → 文件工具改 → preview → restore → undo，intent 原样交回', async () => {
  const scene = await filesScenario()
  try {
    await writeFile(join(scene.cwd, 'plan.md'), '一\n二\n')
    const exec1 = await startTurn(scene.service, 's1', 1, scene.cwd)
    // meta 是 files 种类，第 1 轮有一条空捕获的记录。
    const meta = JSON.parse(await readFile(join(scene.dataRoot, 's1', 'meta.json'), 'utf8'))
    assert.equal(meta.kind, 'files')
    let listed = await (await scene.service.list('s1')).json()
    assert.deepEqual(listed.entries.map(entry => [entry.turn, entry.kind]), [[1, 'files']])

    // 第 1 轮：改 plan.md、新建 notes.md；intent 原样交回。
    const intent = await toolWrites(scene.service, exec1, join(scene.cwd, 'plan.md'), '一\n改\n')
    assert.deepEqual(intent, { version: 7, event: 'write' })
    await toolWrites(scene.service, exec1, join(scene.cwd, 'notes.md'), '新文件\n')
    // 同一轮再改 plan.md 不重复捕获（记的是第一次改之前的内容）。
    await toolWrites(scene.service, exec1, join(scene.cwd, 'plan.md'), '一\n再改\n')
    const entries = await scene.store.readEntries('s1')
    assert.deepEqual(Object.keys(entries[0].captures).sort(), ['notes.md', 'plan.md'])
    assert.equal(entries[0].captures['notes.md'].kind, 'absent')

    // 第 2 轮：删 plan.md。
    const exec2 = await startTurn(scene.service, 's1', 2, scene.cwd)
    await toolWrites(scene.service, exec2, join(scene.cwd, 'plan.md'), null, 'delete')

    // preview 第 1 轮：plan.md 写回（现在不存在），notes.md 删除。
    const preview = await (await post(scene.service, 'preview', { sessionId: 's1', turn: 1 })).json()
    assert.equal(preview.ok, true)
    assert.equal(preview.kind, 'files')
    assert.equal(preview.cwdInside, true)
    assert.deepEqual(preview.notes, ['nongit'])
    assert.deepEqual(preview.files.map(file => [file.path, file.action]), [['notes.md', 'delete'], ['plan.md', 'restore']])
    assert.equal(preview.total, 2)
    assert.equal(preview.truncated, false)

    // restore 第 1 轮：回到第 1 轮开始前。
    const restored = await (await post(scene.service, 'restore', { sessionId: 's1', turn: 1 })).json()
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, 2)
    assert.deepEqual(restored.skipped, [])
    assert.equal(await readFile(join(scene.cwd, 'plan.md'), 'utf8'), '一\n二\n')
    assert.equal(existsSync(join(scene.cwd, 'notes.md')), false)
    listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.undo.turn, 1)

    // undo：回到恢复前（plan.md 不存在、notes.md 在）。
    const undone = await (await post(scene.service, 'undo', { sessionId: 's1' })).json()
    assert.equal(undone.ok, true)
    assert.equal(existsSync(join(scene.cwd, 'plan.md')), false)
    assert.equal(await readFile(join(scene.cwd, 'notes.md'), 'utf8'), '新文件\n')
    // 撤销成功后撤销点清掉。
    listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.undo, null)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('files 种类：超过 maxFileMB 的文件记 oversized，预览标 skip、恢复跳过', async () => {
  const scene = await filesScenario()
  try {
    await writeFile(join(scene.cwd, 'logo.png'), Buffer.alloc(1024 * 1024 + 10, 1))
    const exec = await startTurn(scene.service, 's1', 1, scene.cwd)
    await toolWrites(scene.service, exec, join(scene.cwd, 'logo.png'), 'small now')
    const entries = await scene.store.readEntries('s1')
    assert.deepEqual(entries[0].captures['logo.png'], { kind: 'oversized' })
    const preview = await (await post(scene.service, 'preview', { sessionId: 's1', turn: 1 })).json()
    assert.deepEqual(preview.files, [{ path: 'logo.png', action: 'skip', added: 0, deleted: 0, binary: false, reason: 'oversized' }])
    const restored = await (await post(scene.service, 'restore', { sessionId: 's1', turn: 1 })).json()
    assert.equal(restored.restored, 0)
    assert.deepEqual(restored.skipped, [{ path: 'logo.png', reason: 'oversized' }])
    assert.equal(await readFile(join(scene.cwd, 'logo.png'), 'utf8'), 'small now')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('files 种类：工作目录外的路径不记；没登记的 exec 不捕获', async () => {
  const scene = await filesScenario()
  try {
    const exec = await startTurn(scene.service, 's1', 1, scene.cwd)
    const outside = join(scene.work, 'outside.txt')
    await toolWrites(scene.service, exec, outside, '工作目录外\n')
    // 没经过 tools/pre-execute 的 actor：钩子照样交回 intent，什么都不记。
    const intent = await scene.service.onFsIntent({ path: join(scene.cwd, 'x.txt') }, { agent: {} }, async () => 'intent')
    assert.equal(intent, 'intent')
    const entries = await scene.store.readEntries('s1')
    assert.deepEqual(entries[0].captures, {})
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('files 种类：git 仓库里的会话不走 files 种类，fs 钩子不捕获', async () => {
  const scene = await filesScenario()
  try {
    const repo = join(scene.work, 'repo')
    const made = await runGit(scene.work, ['init', repo])
    assert.equal(made.exitCode, 0, made.stderr)
    await writeFile(join(repo, 'a.txt'), 'a\n')
    const exec = await startTurn(scene.service, 'g1', 1, repo)
    await toolWrites(scene.service, exec, join(repo, 'a.txt'), 'changed\n')
    const entries = await scene.store.readEntries('g1')
    assert.deepEqual(entries.map(entry => entry.kind), ['git'])
    assert.equal(existsSync(join(scene.dataRoot, 'g1', 'captures')), false)
    const meta = JSON.parse(await readFile(join(scene.dataRoot, 'g1', 'meta.json'), 'utf8'))
    assert.equal(meta.kind, 'git')
    // 预览走 git 种类：没有 nongit 说明。
    const preview = await (await post(scene.service, 'preview', { sessionId: 'g1', turn: 1 })).json()
    assert.equal(preview.kind, 'git')
    assert.deepEqual(preview.notes, [])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('files 种类：processPath 对非本地目标抛错时，钩子照样交回 intent（第 40 件阶段三）', async () => {
  const scene = await filesScenario()
  try {
    // fs 服务对非本地目标（比如远程会话的 fs）解析不了进程路径，会抛。
    const throwing = {
      processPath: target => {
        if (target.remote === true) throw new Error('no local path for remote target')
        return target.path
      },
    }
    scene.service.dispose()
    const service = createCheckpointsService({
      subprocess: createLocalSubprocess({ home: join(scene.work, 'git-home') }),
      fs: throwing,
      agents: { get: () => undefined },
      dataRoot: scene.dataRoot,
      configDir: join(scene.work, 'dsh-home', 'dsh-workbench'),
      logger: { warn: () => {}, info: () => {} },
    })
    const exec = await startTurn(service, 's1', 1, scene.cwd)
    const intent = await service.onFsIntent({ remote: true }, exec, async () => ({ version: 3 }))
    assert.deepEqual(intent, { version: 3 }, 'intent 原样交回，钩子不抛')
    const entries = await scene.store.readEntries('s1')
    assert.deepEqual(entries[entries.length - 1].captures, {}, '抛错的路径什么都不记')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('files 种类：没有可用的 git 时也记 files 种类', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-filesflow-'))
  try {
    const cwd = join(work, 'workspace')
    await mkdir(cwd, { recursive: true })
    const home = join(work, 'dsh-home')
    writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 1 })
    const service = createCheckpointsService({
      // 找不到 git：resolveExecutable 抛错。
      subprocess: { resolveExecutable: async () => { throw new Error('git not found') }, spawn: () => { throw new Error('unused') } },
      fs: { processPath: target => target.path },
      agents: { get: () => undefined },
      dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
      configDir: join(home, 'dsh-workbench'),
      logger: { warn: () => {}, info: () => {} },
    })
    await writeFile(join(cwd, 'a.txt'), '原来\n')
    const exec = await startTurn(service, 's1', 1, cwd)
    await toolWrites(service, exec, join(cwd, 'a.txt'), '改了\n')
    const restored = await (await service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), '原来\n')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})


for (const partial of [false, true]) {
  test(`TW-001 files undo preserves its target after ${partial ? 'partial' : 'total'} write failure and can retry`, { skip: process.getuid?.() === 0 }, async t => {
    const scene = await filesScenario()
    const blocked = join(scene.cwd, 'blocked')
    await mkdir(blocked)
    t.after(async () => { await chmod(blocked, 0o755); await scene.service.dispose(); await rm(scene.work, { recursive: true, force: true }) })
    const paths = [join(blocked, 'b.txt'), ...(partial ? [join(scene.cwd, 'a.txt')] : [])]
    for (const path of paths) await writeFile(path, 'checkpoint\n')
    const exec = await startTurn(scene.service, 's1', 1, scene.cwd)
    for (const path of paths) await toolWrites(scene.service, exec, path, 'before restore\n')
    assert.equal((await (await scene.service.restore('s1', 1)).json()).ok, true)
    const target = await scene.store.readRestore('s1')
    await chmod(blocked, 0o555)
    const failed = await scene.service.undo('s1')
    assert.equal(failed.status, 500)
    const body = await failed.json()
    assert.equal(body.ok, false)
    assert.equal(body.restored, partial ? 1 : 0)
    assert.deepEqual(body.skipped.map(x => x.path), ['blocked/b.txt'])
    assert.deepEqual((await scene.store.readRestore('s1')).captures, target.captures)
    await chmod(blocked, 0o755)
    const retried = await scene.service.undo('s1')
    assert.equal(retried.status, 200)
    for (const path of paths) assert.equal(await readFile(path, 'utf8'), 'before restore\n')
    assert.equal(await scene.store.readRestore('s1'), undefined)
  })
}

/**
 * 第 42 件的回归测试：撤销入口的「过期」在 App 重启后也成立。list 的 undo 不能只靠内存
 * 标记（重启就丢）：restore.json 的 time 之后有任何一条检查点（轮次开始的时间）就当过期，
 * 只用盘上的数据判断。用同一个数据目录重建服务模拟重启。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService } from '../lib/checkpoints.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

const write = (path, text) => writeFile(path, text, 'utf8')

/**
 * 搭一个场景：临时目录、数据目录、用同一个数据目录建服务（重启后再建一次）。
 * @param {{ initGit?: boolean }} [options] 工作目录是不是 git 仓库。
 * @returns 情景。
 */
async function restartScenario(options = {}) {
  const work = mkdtempSync(join(tmpdir(), 'dwb-restart-'))
  const cwd = join(work, options.initGit === false ? 'workspace' : 'repo')
  if (options.initGit === false) {
    await mkdir(cwd, { recursive: true })
  } else {
    const made = await runGit(work, ['init', cwd])
    assert.equal(made.exitCode, 0, made.stderr)
  }
  const home = join(work, 'dsh-home')
  const configDir = join(home, 'dsh-workbench')
  const dataRoot = join(configDir, 'checkpoints')
  writeCheckpointsConfig(configDir, { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
  const makeService = () => createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    fs: { processPath: target => target.path },
    agents: { get: () => undefined },
    dataRoot,
    configDir,
    logger: { warn: () => {}, info: () => {} },
  })
  return { work, cwd, dataRoot, makeService }
}

/** 起一轮并等检查点存完，返回这一轮的 exec（files 种类捕获用）。 */
async function startTurn(service, sessionId, turn, cwd) {
  service.onSessionEvent({ id: sessionId, header: { cwd } }, { type: 'turn/start', seq: turn * 10, data: { turn } })
  const exec = { agent: { session: { id: sessionId } } }
  await service.onPreExecute(exec, () => 'ok')
  return exec
}

test('重启后过期（git）：恢复之后又存过检查点，重建服务 list 的 undo 为 null', async () => {
  const scene = await restartScenario()
  try {
    const service = scene.makeService()
    await write(join(scene.cwd, 'a.txt'), 'v0\n')
    await startTurn(service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'a.txt'), 'v1\n')
    await startTurn(service, 's1', 2, scene.cwd)
    const restored = await (await service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    // 恢复之后又开了新的一轮（存了检查点），再「重启」。
    await write(join(scene.cwd, 'a.txt'), 'v2\n')
    await startTurn(service, 's1', 3, scene.cwd)
    const restarted = scene.makeService()
    const listed = await (await restarted.list('s1')).json()
    assert.equal(listed.undo, null, '重启后过期的撤销不再出现')
    const response = await restarted.undo('s1')
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'undo-stale')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('重启后不过期（git）：恢复之后没有新检查点，重建服务 undo 还在', async () => {
  const scene = await restartScenario()
  try {
    const service = scene.makeService()
    await write(join(scene.cwd, 'a.txt'), 'v0\n')
    await startTurn(service, 's1', 1, scene.cwd)
    await write(join(scene.cwd, 'a.txt'), 'v1\n')
    await startTurn(service, 's1', 2, scene.cwd)
    const restored = await (await service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    const restarted = scene.makeService()
    const listed = await (await restarted.list('s1')).json()
    assert.notEqual(listed.undo, null, '没有新检查点的撤销点重启后还在')
    assert.equal(listed.undo.turn, 1)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('重启后过期（files）：恢复之后又存过检查点，重建服务 list 的 undo 为 null', async () => {
  const scene = await restartScenario({ initGit: false })
  try {
    const service = scene.makeService()
    const exec = await startTurn(service, 's1', 1, scene.cwd)
    await service.onFsIntent({ path: join(scene.cwd, 'a.txt') }, exec, async () => 1)
    await write(join(scene.cwd, 'a.txt'), '第一次\n')
    await startTurn(service, 's1', 2, scene.cwd)
    const restored = await (await service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    // 恢复之后又开一轮、又碰了文件（存了新检查点），再「重启」。
    const exec3 = await startTurn(service, 's1', 3, scene.cwd)
    await service.onFsIntent({ path: join(scene.cwd, 'a.txt') }, exec3, async () => 1)
    await write(join(scene.cwd, 'a.txt'), '第三次\n')
    const restarted = scene.makeService()
    const listed = await (await restarted.list('s1')).json()
    assert.equal(listed.undo, null, '重启后过期的撤销不再出现')
    const response = await restarted.undo('s1')
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'undo-stale')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('重启后不过期（files）：恢复之后没有新检查点，重建服务 undo 还在', async () => {
  const scene = await restartScenario({ initGit: false })
  try {
    const service = scene.makeService()
    const exec = await startTurn(service, 's1', 1, scene.cwd)
    await service.onFsIntent({ path: join(scene.cwd, 'a.txt') }, exec, async () => 1)
    await write(join(scene.cwd, 'a.txt'), '第一次\n')
    await startTurn(service, 's1', 2, scene.cwd)
    const restored = await (await service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    const restarted = scene.makeService()
    const listed = await (await restarted.list('s1')).json()
    assert.notEqual(listed.undo, null, '没有新检查点的撤销点重启后还在')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

// TC-004：没有文件要改的恢复（「恢复并分叉」不看预览，照样调恢复）不能盖掉此前那次恢复的撤销点。
for (const kind of ['files', 'git']) {
  test(`TC-004 什么都不用改的恢复不覆盖此前的撤销点（${kind}）`, async () => {
    const scene = await restartScenario(kind === 'files' ? { initGit: false } : {})
    try {
      const service = scene.makeService()
      const file = join(scene.cwd, 'a.txt')
      await write(file, 'v0\n')
      const exec = await startTurn(service, 's1', 1, scene.cwd)
      await service.onFsIntent({ path: file }, exec, async () => 1)
      await write(file, 'v1\n')
      await startTurn(service, 's1', 2, scene.cwd)
      const first = await (await service.restore('s1', 1)).json()
      assert.equal(first.ok, true)
      assert.equal(first.restored, 1)
      const before = (await (await service.list('s1')).json()).undo
      // 已经回到第 1 轮开始前了，再恢复一次第 1 轮：没有文件要改。
      const again = await (await service.restore('s1', 1)).json()
      assert.equal(again.ok, true)
      assert.equal(again.restored, 0)
      assert.deepEqual((await (await service.list('s1')).json()).undo, before, '撤销入口还是第一次恢复的')
      const undone = await (await service.undo('s1')).json()
      assert.equal(undone.ok, true)
      assert.equal(await readFile(file, 'utf8'), 'v1\n', '撤销回到第一次恢复之前')
    } finally {
      await rm(scene.work, { recursive: true, force: true })
    }
  })
}

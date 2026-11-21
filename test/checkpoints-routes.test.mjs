/**
 * 检查点的路由和整条链路（lib/checkpoints.js 的 createCheckpointsService + 路由注册）：
 * 真 git 临时仓库里 turn/start 存档 → 改文件 → preview 列差异 → restore 恢复 → undo 撤销，
 * 每一步前后的树对得上；list / config、bad-request、no-checkpoint、not-eligible、
 * running、busy、expired（gc 之后）各按接口文档的状态码答。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService, registerCheckpointsRoutes } from '../lib/checkpoints.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

const write = (path, text) => writeFile(path, text, 'utf8')

/**
 * 搭一套服务场景：临时 DSH_HOME（configDir 是它下面的 dsh-workbench，dataRoot 是
 * dsh-workbench/checkpoints）、真 git 仓库当会话工作目录、五个路由都注册好。
 * @param {{ runningIds?: string[], persistence?: { header: { id: string } }[], clock?: () => number }} [options] 会话运行态和持久清单、时钟。
 * @returns 情景：service、routes、repo、home 等。
 */
async function serviceScenario(options = {}) {
  const work = mkdtempSync(join(tmpdir(), 'dwb-svc-'))
  const repo = join(work, 'repo')
  const made = await runGit(work, ['init', repo])
  assert.equal(made.exitCode, 0, made.stderr)
  const home = join(work, 'dsh-home')
  const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
  const configDir = join(home, 'dsh-workbench')
  writeCheckpointsConfig(configDir, { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 2 })
  const running = new Set(options.runningIds ?? [])
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    agents: { get: id => (running.has(id) ? { status: 'running' } : undefined) },
    sessionPersistence: options.persistence === undefined ? undefined : { list: async () => options.persistence },
    dataRoot,
    configDir,
    clock: options.clock,
    logger: { warn: () => {}, info: () => {} },
  })
  const routes = new Map()
  const scope = {
    effect: fn => { const dispose = fn(); return () => dispose() },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
  }
  registerCheckpointsRoutes(scope, service)
  return { work, repo, home, dataRoot, configDir, service, routes, running }
}

/** 起一轮：turn/start 事件喂给服务。 */
const startTurn = (service, sessionId, turn, cwd, header = {}) =>
  service.onSessionEvent({ id: sessionId, header: { cwd, ...header } }, { type: 'turn/start', seq: turn * 10, data: { turn } })

const post = async (route, body) => route.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify(body) }))

test('routes：整条链路 turn/start 存档、preview 列差异、restore 恢复、undo 撤销', async () => {
  const scene = await serviceScenario()
  try {
    await write(join(scene.repo, 'base.txt'), '底稿\n')
    await startTurn(scene.service, 's1', 1, scene.repo)
    // 等这一轮的检查点存完（pre-execute 等的就是这条队列）。
    await scene.service.onPreExecute({ agent: { session: { id: 's1' } } }, () => 'next-result')

    // list：合格、一条记录、还没有可撤销的恢复。
    let answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=s1'))).json()
    assert.equal(answered.ok, true)
    assert.equal(answered.eligible, true)
    assert.equal(answered.full, false)
    assert.deepEqual(answered.entries.map(entry => ({ turn: entry.turn, kind: entry.kind })), [{ turn: 1, kind: 'git' }])
    assert.equal(answered.undo, null)

    // 改文件再开第二轮，检查点记的是每轮开始前的样子。
    await write(join(scene.repo, 'notes.md'), '这一轮写的\n')
    await write(join(scene.repo, 'base.txt'), '改过的底稿\n')
    await startTurn(scene.service, 's1', 2, scene.repo)
    await scene.service.onPreExecute({ agent: { session: { id: 's1' } } }, () => 'next-result')

    answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=s1'))).json()
    assert.deepEqual(answered.entries.map(entry => entry.turn), [1, 2])

    // preview 第 1 轮：notes.md 是删除（检查点之后新建），base.txt 是写回。
    let preview = await (await post(scene.routes.get('/api/dsh-workbench.checkpoints.preview'), { sessionId: 's1', turn: 1 })).json()
    assert.equal(preview.ok, true)
    assert.equal(preview.kind, 'git')
    assert.equal(preview.cwdInside, true)
    assert.equal(preview.root, await realpath(scene.repo))
    assert.equal(preview.total, 2)
    const byPath = Object.fromEntries(preview.files.map(file => [file.path, file]))
    assert.equal(byPath['notes.md'].action, 'delete')
    assert.equal(byPath['base.txt'].action, 'restore')
    assert.equal(byPath['base.txt'].deleted, 1)

    // restore 第 1 轮：文件回到第 1 轮开始前，list 的 undo 有了。
    let restored = await (await post(scene.routes.get('/api/dsh-workbench.checkpoints.restore'), { sessionId: 's1', turn: 1 })).json()
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, 2)
    assert.deepEqual(restored.skipped, [])
    assert.equal(await readFile(join(scene.repo, 'base.txt'), 'utf8'), '底稿\n')
    await assert.rejects(stat(join(scene.repo, 'notes.md')), /ENOENT/)
    answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=s1'))).json()
    assert.deepEqual(answered.undo, { time: answered.undo.time, turn: 1 })
    assert.ok(Number.isSafeInteger(answered.undo.time))

    // 撤销：文件回到恢复前（第 2 轮开始）的样子。
    let undone = await post(scene.routes.get('/api/dsh-workbench.checkpoints.undo'), { sessionId: 's1' })
    assert.equal(undone.ok, true)
    assert.equal(await readFile(join(scene.repo, 'base.txt'), 'utf8'), '改过的底稿\n')
    assert.equal(await readFile(join(scene.repo, 'notes.md'), 'utf8'), '这一轮写的\n')
    // 撤销成功后撤销点清掉：list 的 undo 回到 null，再 undo 答 404 no-checkpoint。
    answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=s1'))).json()
    assert.equal(answered.undo, null)
    const again = await post(scene.routes.get('/api/dsh-workbench.checkpoints.undo'), { sessionId: 's1' })
    assert.equal(again.status, 404)
    assert.equal((await again.json()).reason, 'no-checkpoint')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('routes：preview 截断到 50 条、notes 带 gitignore-changed', async () => {
  const scene = await serviceScenario()
  try {
    await write(join(scene.repo, '.gitignore'), 'build/\n')
    for (let index = 0; index < 60; index += 1) await write(join(scene.repo, `f${index}.txt`), `${index}\n`)
    await startTurn(scene.service, 's1', 1, scene.repo)
    await scene.service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    for (let index = 0; index < 60; index += 1) await write(join(scene.repo, `f${index}.txt`), '改\n')
    await write(join(scene.repo, '.gitignore'), '')
    const preview = await (await post(scene.routes.get('/api/dsh-workbench.checkpoints.preview'), { sessionId: 's1', turn: 1 })).json()
    assert.equal(preview.total, 61)
    assert.equal(preview.files.length, 50)
    assert.equal(preview.truncated, true)
    assert.deepEqual(preview.notes, ['gitignore-changed'])
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('routes：bad-request、no-checkpoint、not-eligible、running、busy 按状态码答', async () => {
  const scene = await serviceScenario()
  try {
    await write(join(scene.repo, 'a.txt'), 'a\n')
    await startTurn(scene.service, 's1', 1, scene.repo)
    await scene.service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)

    // bad-request：会话 ID 不合法、轮次号不合法、请求体不是 JSON。
    let response = await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=../etc'))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).reason, 'bad-request')
    response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.preview'), { sessionId: 's1', turn: 0 })
    assert.equal(response.status, 400)
    response = await scene.routes.get('/api/dsh-workbench.checkpoints.restore').fetch(new Request('http://dsh/api', { method: 'POST', body: '{nope' }))
    assert.equal(response.status, 400)

    // no-checkpoint：这一轮没有存过。
    response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.preview'), { sessionId: 's1', turn: 9 })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).reason, 'no-checkpoint')
    // 什么都没有的会话也是 no-checkpoint。
    response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.restore'), { sessionId: 's2', turn: 1 })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).reason, 'no-checkpoint')

    // not-eligible：子智能体会话。
    await startTurn(scene.service, 's3', 1, scene.repo, { origin: 'subagent' })
    response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.preview'), { sessionId: 's3', turn: 1 })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).reason, 'not-eligible')

    // running：会话运行中拒绝恢复和撤销。
    scene.running.add('s1')
    response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.restore'), { sessionId: 's1', turn: 1 })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'running')
    response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.undo'), { sessionId: 's1' })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).reason, 'running')
    scene.running.delete('s1')

    // busy：同一个会话并发两次恢复，第二次 409。
    const first = post(scene.routes.get('/api/dsh-workbench.checkpoints.restore'), { sessionId: 's1', turn: 1 })
    const second = await post(scene.routes.get('/api/dsh-workbench.checkpoints.restore'), { sessionId: 's1', turn: 1 })
    assert.equal(second.status, 409)
    assert.equal((await second.json()).reason, 'busy')
    assert.equal((await first).status, 200)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('routes：检查点对象被 gc 清掉后 restore 答 410 expired', async () => {
  const scene = await serviceScenario()
  try {
    await write(join(scene.repo, 'a.txt'), '第一版\n')
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '-m', 'one'])
    await startTurn(scene.service, 's1', 1, scene.repo)
    await scene.service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    // 树在仓库对象库里：改历史再 gc，检查点就失效了。
    await write(join(scene.repo, 'a.txt'), '第二版\n')
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'add', '-A'])
    await runGit(scene.repo, [...COMMIT_IDENTITY, 'commit', '--amend', '-m', 'two'])
    await runGit(scene.repo, ['reflog', 'expire', '--expire=now', '--all'])
    await runGit(scene.repo, ['gc', '--prune=now'])
    const response = await post(scene.routes.get('/api/dsh-workbench.checkpoints.restore'), { sessionId: 's1', turn: 1 })
    assert.equal(response.status, 410)
    assert.equal((await response.json()).reason, 'expired')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('routes：list 按头判合格性（预设被排除、没有工作目录），重启后按 meta', async () => {
  const scene = await serviceScenario({ clock: () => 12345 })
  try {
    await write(join(scene.repo, 'a.txt'), 'a\n')
    // 预设被排除的会话不存。
    await startTurn(scene.service, 'whale-1', 1, scene.repo, { agentPreset: 'whale' })
    await scene.service.onPreExecute({ agent: { session: { id: 'whale-1' } } }, () => undefined)
    let answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=whale-1'))).json()
    assert.equal(answered.eligible, false)
    assert.deepEqual(answered.entries, [])

    // 没有工作目录的会话不存。
    await startTurn(scene.service, 'no-cwd', 1, undefined, {})
    await scene.service.onPreExecute({ agent: { session: { id: 'no-cwd' } } }, () => undefined)
    answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=no-cwd'))).json()
    assert.equal(answered.eligible, false)

    // 正常会话存了以后「重启」（放掉内存状态），list 按 meta 照样答合格、条目还在。
    await startTurn(scene.service, 's1', 1, scene.repo)
    await scene.service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    scene.service.dispose()
    answered = await (await scene.routes.get('/api/dsh-workbench.checkpoints.list').fetch(new Request('http://dsh/api?sessionId=s1'))).json()
    assert.equal(answered.eligible, true)
    assert.deepEqual(answered.entries.map(entry => entry.turn), [1])
    assert.equal(answered.entries[0].time, 12345)
    // 时间是注入的固定值。
    assert.equal(answered.entries[0].time, 12345)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('routes：config 读写（GET 默认、POST 校验保存、坏体 400）', async () => {
  const scene = await serviceScenario()
  try {
    const route = scene.routes.get('/api/dsh-workbench.checkpoints.config')
    let answered = await (await route.fetch(new Request('http://dsh/api'))).json()
    assert.equal(answered.ok, true)
    assert.equal(answered.config.keepDays, 14)
    assert.deepEqual(answered.config.skipPresets, ['whale']) // 情景里写进去的
    answered = await (await post(route, { keepDays: 7, maxStoreMB: 100, skipPresets: ['whale'], waitSeconds: 3, maxFileMB: 4 })).json()
    assert.equal(answered.ok, true)
    assert.deepEqual(answered.config, { keepDays: 7, maxStoreMB: 100, skipPresets: ['whale'], waitSeconds: 3, maxFileMB: 4 })
    answered = await (await route.fetch(new Request('http://dsh/api'))).json()
    assert.deepEqual(answered.config, { keepDays: 7, maxStoreMB: 100, skipPresets: ['whale'], waitSeconds: 3, maxFileMB: 4 })
    // 缺 maxFileMB 也是 400（五个字段都要有）。
    const missing = await post(route, { keepDays: 7, maxStoreMB: 100, skipPresets: [], waitSeconds: 3 })
    assert.equal(missing.status, 400)
    const bad = await post(route, { keepDays: -1, maxStoreMB: 100, skipPresets: [], waitSeconds: 3, maxFileMB: 2 })
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).reason, 'bad-request')
    const notJson = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: 'nope' }))
    assert.equal(notJson.status, 400)
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

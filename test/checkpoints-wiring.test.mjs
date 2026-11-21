/**
 * 检查点的接线（lib/checkpoints.js 的 applyCheckpoints）：假 ctx 上挂钩子和路由，真 git
 * 临时仓库里验证 session/event 触发存档、tools/pre-execute 等队列且不吞 next()、超时放行、
 * 卸载撤掉全部注册；清理（过期、归档满天数、对账 sessionPersistence）和 domain/changed
 * 记归档时间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createCheckpointsService, registerCheckpointsRoutes } from '../lib/checkpoints.js'
import { parseCheckpointsConfig, writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'
import { tempDirSync } from './helpers/temp-dir.mjs'

/**
 * 假 ctx：effect 收注销函数、inject 收依赖和回调、on 收监听器，测试里手动驱动。
 * @param {object} services inject 回调拿到的服务表。
 * @returns 假 ctx 和登记簿。
 */
function makeCtx(services) {
  const book = { effects: [], injects: [], listeners: [] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      book.effects.push(dispose)
      return dispose
    },
    inject(deps, callback) {
      book.injects.push({ deps, callback })
      return {}
    },
  }
  const makeScope = extra => ({
    ...services,
    ...extra,
    on: (event, listener) => {
      book.listeners.push({ event, listener })
    },
    effect: ctx.effect,
    inject: ctx.inject,
    logger: { warn: () => {}, info: () => {} },
  })
  book.runInjects = () => {
    for (const { deps, callback } of book.injects.splice(0)) {
      callback(makeScope({}))
      book.runInjects()
    }
  }
  return { ctx, book }
}

/** 一套假的 DSH 服务。 */
const fakeServices = work => ({
  subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
  fs: {},
  agents: { get: () => undefined },
  sessionPersistence: { list: async () => [] },
  connection: { fetch: { register: () => () => {} } },
})

test('wiring：apply 在假 ctx 上登记功能、挂钩子、注册路由，卸载全撤', async () => {
  // 等这一行的卸载钩子后，测试才释放数据目录。
  const work = tempDirSync('dwb-wire-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(work, 'dsh-home')
  try {
    await runGit(work, ['init', join(work, 'repo')])
    const { ctx, book } = makeCtx(fakeServices(work))
    apply(ctx)
    assert.equal(book.effects.length, 1) // 功能登记
    assert.deepEqual(book.injects.map(item => item.deps), [['subprocess', 'fs', 'agents', 'sessionPersistence']])
    book.runInjects()
    // 钩子挂上了；connection 的 inject 排在队尾也被驱动，路由注册过。
    assert.deepEqual(book.listeners.map(item => item.event).sort(), [
      'domain/changed', 'fs/delete-intent', 'fs/edit-intent', 'fs/write-intent', 'session/disposed', 'session/event', 'tools/pre-execute',
    ])
    // 撤销：全部注销函数跑一遍不抛错。
    for (const dispose of book.effects.splice(0)) await dispose()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(work, { recursive: true, force: true })
  }
})

test('wiring：session/event 存档（合格才存）、tools/pre-execute 等队列不吞 next', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-wire-'))
  const repo = join(work, 'repo')
  await runGit(work, ['init', repo])
  const home = join(work, 'dsh-home')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 }))
  const calls = []
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    agents: { get: () => undefined },
    dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: () => {}, info: () => {} },
  })
  try {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    // 子智能体会话不存；普通会话存。
    service.onSessionEvent({ id: 'sub-1', header: { cwd: repo, origin: 'subagent' } }, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
    // turn/start 之外的会话事件不理会。
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'tool/result', seq: 11 })

    // pre-execute：next() 的返回值原样交回，工具执行前检查点已存完。
    const decision = await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => {
      calls.push('next')
      return 'allowed'
    })
    assert.equal(decision, 'allowed')
    assert.deepEqual(calls, ['next'])
    const raw = await readFile(join(home, 'dsh-workbench', 'checkpoints', 's1', 'checkpoints.jsonl'), 'utf8')
    assert.equal(raw.trim().split('\n').length, 1)
    assert.equal(existsSync(join(home, 'dsh-workbench', 'checkpoints', 'sub-1')), false)
    // 没登记过的会话直接放行。
    assert.equal(await service.onPreExecute({ agent: { session: { id: 'unknown' } } }, () => 'pass'), 'pass')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('wiring：等检查点超过 waitSeconds 秒先放行，检查点之后存完', async t => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-wire-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const repo = join(work, 'repo')
  await runGit(work, ['init', repo])
  const home = join(work, 'dsh-home')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 1, maxFileMB: 2 }))
  const releaseGit = Promise.withResolvers()
  const base = createLocalSubprocess({ home: join(work, 'git-home') })
  const slow = {
    ...base,
    async resolveExecutable(...args) {
      await releaseGit.promise
      return base.resolveExecutable(...args)
    },
  }
  const service = createCheckpointsService({
    subprocess: slow,
    agents: { get: () => undefined },
    dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: () => {}, info: () => {} },
  })
  try {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let allowed = false
    const decision = service.onPreExecute({ agent: { session: { id: 's1' } } }, () => { allowed = true; return 'allowed' })
    t.mock.timers.tick(999)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(allowed, false)
    t.mock.timers.tick(1)
    assert.equal(await decision, 'allowed')
  } finally {
    t.mock.timers.reset()
    releaseGit.resolve()
    await service.dispose()
  }
  const raw = await readFile(join(home, 'dsh-workbench', 'checkpoints', 's1', 'checkpoints.jsonl'), 'utf8')
  assert.ok(raw.includes('"turn":1'), `检查点最终要存上，实际：${raw}`)
})

test('wiring：清理（过期、归档满天数、对账），domain/changed 记归档时间', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-wire-'))
  const home = join(work, 'dsh-home')
  const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
  const DAY = 24 * 60 * 60 * 1000
  let now = 100 * DAY
  const config = parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
  writeCheckpointsConfig(join(home, 'dsh-workbench'), config)
  const persistenceHeaders = [{ header: { id: 's1' } }, { header: { id: 'arch-old' } }, { header: { id: 'arch-new' } }, { header: { id: 'fresh' } }]
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    agents: { get: () => undefined },
    sessionPersistence: { list: async () => persistenceHeaders },
    dataRoot,
    configDir: join(home, 'dsh-workbench'),
    clock: () => now,
    logger: { warn: () => {}, info: () => {} },
  })
  const store = (await import('../lib/checkpoints-store.js')).createCheckpointsStore(dataRoot)
  try {
    // s1：全部检查点都过期（15 天前）、目录也 15 天没动 → 整个删（目录时间也是过期判断的一部分）。
    await store.appendEntry('s1', { turn: 1, seq: 1, time: now - 15 * DAY, kind: 'git', tree: 't' })
    await store.writeMeta('s1', { cwd: '/x', root: '/x', kind: 'git' })
    const stale = new Date(now - 15 * DAY)
    await utimes(join(dataRoot, 's1'), stale, stale)
    // arch-old：归档满 15 天 → 删；arch-new：归档 1 天、检查点新 → 留。
    await store.appendEntry('arch-old', { turn: 1, seq: 1, time: now - 10 * DAY, kind: 'git', tree: 't' })
    await store.appendEntry('arch-new', { turn: 1, seq: 1, time: now - DAY, kind: 'git', tree: 't' })
    await store.writeArchived({ 'arch-old': now - 15 * DAY, 'arch-new': now - DAY })
    // fresh：检查点新、没归档 → 留。gone：不在 sessionPersistence 里 → 删。
    await store.appendEntry('fresh', { turn: 1, seq: 1, time: now - DAY, kind: 'git', tree: 't' })
    await store.appendEntry('gone', { turn: 1, seq: 1, time: now - DAY, kind: 'git', tree: 't' })

    await service.cleanup()
    assert.deepEqual((await store.listSessionIds()).sort(), ['arch-new', 'fresh'])
    // 删掉的会话的归档记号也一起去掉。
    assert.deepEqual(await store.readArchived(), { 'arch-new': now - DAY })

    // domain/changed：新归档的记时间；取消归档的去掉记号（arch-new 一直归着档，全集里有它）。
    await service.onDomainChanged({ domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds: ['arch-new', 'fresh'] } })
    assert.deepEqual(await store.readArchived(), { 'arch-new': now - DAY, fresh: now })
    await service.onDomainChanged({ domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds: [] } })
    assert.deepEqual(await store.readArchived(), {})
    // 别的域、别的表不记。
    await service.onDomainChanged({ domain: 'other', table: '', operation: 'put', value: { archivedSessionIds: ['fresh'] } })
    assert.deepEqual(await store.readArchived(), {})

    // 时间过了 14 天：arch-new 有新的检查点（①不删）但归档满 15 天（②删）；fresh 有
    // 新的检查点、没归档，留着。
    now += 14 * DAY
    await store.appendEntry('arch-new', { turn: 2, seq: 2, time: now - DAY, kind: 'git', tree: 't2' })
    await store.appendEntry('fresh', { turn: 2, seq: 2, time: now - DAY, kind: 'git', tree: 't2' })
    await store.writeArchived({ 'arch-new': now - 15 * DAY })
    await service.cleanup()
    assert.deepEqual(await store.listSessionIds(), ['fresh'])
    assert.deepEqual(await store.readArchived(), {})
  } finally {
    await service.dispose()
    rmSync(work, { recursive: true, force: true })
  }
})

test('wiring：session/disposed 只放内存状态，不删磁盘数据', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-wire-'))
  const repo = join(work, 'repo')
  await runGit(work, ['init', repo])
  const home = join(work, 'dsh-home')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 }))
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    agents: { get: () => undefined },
    dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: () => {}, info: () => {} },
  })
  try {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
    await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    service.onSessionDisposed('s1')
    await service.dispose()
    assert.equal(existsSync(join(home, 'dsh-workbench', 'checkpoints', 's1', 'checkpoints.jsonl')), true)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('wiring：占用满了不再存新的，上限调大后能恢复存', async () => {
  // 上限 1 MB：第一轮存进 1.2 MB 的文件就满，第二轮不存，调大后第三轮又存。
  const work = mkdtempSync(join(tmpdir(), 'dwb-wire-'))
  const repo = join(work, 'repo')
  await runGit(work, ['init', repo])
  const home = join(work, 'dsh-home')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 }))
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    agents: { get: () => undefined },
    dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: () => {}, info: () => {} },
  })
  const store = (await import('../lib/checkpoints-store.js')).createCheckpointsStore(join(home, 'dsh-workbench', 'checkpoints'))
  try {
    // 先存第 1 轮（1.2 MB 的随机内容，git 压缩后仍超过 1 MB 上限）。
    await writeFile(join(repo, 'a.txt'), randomBytes(1_200_000))
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
    await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    // 上限改成 1 MB：第 2 轮不存，list 答已满。
    writeCheckpointsConfig(join(home, 'dsh-workbench'), parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 1, skipPresets: [], waitSeconds: 5, maxFileMB: 2 }))
    await writeFile(join(repo, 'b.txt'), 'b\n')
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 20, data: { turn: 2 } })
    await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    let listed = await (await service.list('s1')).json()
    assert.deepEqual(listed.entries.map(entry => entry.turn), [1])
    assert.equal(listed.full, true, '1.2 MB 的对象超过 1 MB 上限后 list 的 full 是 true')
    // 上限调大后又能存。
    writeCheckpointsConfig(join(home, 'dsh-workbench'), parseCheckpointsConfig({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 }))
    service.onSessionEvent({ id: 's1', header: { cwd: repo } }, { type: 'turn/start', seq: 30, data: { turn: 3 } })
    await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => undefined)
    listed = await (await service.list('s1')).json()
    assert.deepEqual(listed.entries.map(entry => entry.turn), [1, 3])
    assert.equal(listed.full, false)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('checkpoint teardown drains the still-running startup cleanup before releasing the data directory', async () => {
  const work = tempDirSync('dwb-drain-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(work, 'home')
  const entered = Promise.withResolvers(), allow = Promise.withResolvers()
  const services = fakeServices(work)
  services.sessionPersistence.list = async () => { entered.resolve(); await allow.promise; return [] }
  const { ctx, book } = makeCtx(services)
  try {
    apply(ctx)
    book.runInjects()
    await entered.promise
    let finished = false
    const stop = Promise.all(book.effects.splice(0).map(dispose => dispose?.())).then(() => { finished = true })
    await new Promise(resolve => setImmediate(resolve))
    const returnedTooEarly = finished
    allow.resolve()
    await stop
    assert.equal(returnedTooEarly, false)
  } finally {
    allow.resolve()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

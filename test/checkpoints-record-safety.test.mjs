/**
 * 第 40 件阶段一（记录要安全）的服务层回归测试（lib/checkpoints.js）：
 * 有内容过滤器的仓库不存 git 种类；数据目录在仓库里面时整个仓库不存检查点；
 * fs/*-intent 只在 files 种类（或还没分好类）时等、最多等 waitSeconds，迟到的捕获不记错内容；
 * 清理不删正在第一次快照的目录；files 种类 jsonl 增量追加；config 校验 waitSeconds 上限、
 * 写失败答 500。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService } from '../lib/checkpoints.js'
import { createCheckpointsStore } from '../lib/checkpoints-store.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'
import { tempDirSync } from './helpers/temp-dir.mjs'

const write = (path, text) => writeFile(path, text, 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 搭一套服务场景（第 40 件阶段一用）：可指定数据目录、subprocess、waitSeconds。
 * @param {{ home?: string, dataRoot?: string, subprocess?: object, waitSeconds?: number, persistence?: { header: { id: string } }[] }} [options]
 * @returns 情景。
 */
function recordScenario(options = {}) {
  const work = tempDirSync('dwb-rec-')
  const home = options.home ?? join(work, 'dsh-home')
  const dataRoot = options.dataRoot ?? join(home, 'dsh-workbench', 'checkpoints')
  const configDir = join(home, 'dsh-workbench')
  writeCheckpointsConfig(configDir, {
    keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: options.waitSeconds ?? 5, maxFileMB: 2,
  })
  const warnLog = []
  const service = createCheckpointsService({
    subprocess: options.subprocess ?? createLocalSubprocess({ home: join(work, 'git-home') }),
    fs: { processPath: target => target.path },
    agents: { get: () => undefined },
    sessionPersistence: options.persistence === undefined ? undefined : { list: async () => options.persistence },
    dataRoot,
    configDir,
    logger: { warn: message => warnLog.push(message), info: () => {} },
  })
  return { work, home, dataRoot, configDir, service, warnLog, store: createCheckpointsStore(dataRoot) }
}

/** 起一轮：turn/start 加 tools/pre-execute，返回这一轮工具执行用的 exec（fs 意图按它的身份认会话）。 */
async function startTurn(service, sessionId, turn, cwd) {
  service.onSessionEvent({ id: sessionId, header: { cwd } }, { type: 'turn/start', seq: turn * 10, data: { turn } })
  const exec = { agent: { session: { id: sessionId } } }
  await service.onPreExecute(exec, () => 'ok')
  return exec
}

/** 模拟文件工具改一个文件：fs 钩子先跑（捕获），放行后才真的改，和提供方的顺序一样。 */
async function toolWrites(service, exec, path, text) {
  const intent = await service.onFsIntent({ path }, exec, async () => ({ version: 1 }))
  if (text === null) await rm(path, { force: true })
  else await writeFile(path, text)
  return intent
}

test('记录：仓库里有内容过滤器时不存 git 种类，按 files 种类存（clean 过滤器一次都不跑）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const repo = join(work, 'repo')
    await runGit(work, ['init', repo])
    const marker = join(work, 'MARKER')
    await write(join(work, 'clean.sh'), `#!/bin/sh\ntouch ${marker}\ncat\n`)
    await chmod(join(work, 'clean.sh'), 0o755)
    await runGit(repo, ['config', 'filter.evil.clean', join(work, 'clean.sh')])
    await write(join(repo, '.gitattributes'), '*.dat filter=evil\n')
    await write(join(repo, 'a.dat'), 'payload\n')
    const scene = recordScenario({ home: join(work, 'dsh-home') })
    const exec = await startTurn(scene.service, 's1', 1, repo)
    const listed = await (await scene.service.list('s1')).json()
    assert.equal(listed.eligible, true)
    assert.deepEqual(listed.entries.map(entry => entry.kind), ['files'], '有 filter= 属性的仓库按 files 种类存')
    assert.equal(existsSync(marker), false, '快照没跑，clean 过滤器一次都不执行')
    // files 种类照常捕获、恢复。
    await toolWrites(scene.service, exec, join(repo, 'a.dat'), 'changed\n')
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    assert.equal(await readFile(join(repo, 'a.dat'), 'utf8'), 'payload\n')
    assert.equal(existsSync(marker), false, '恢复也没碰 git，过滤器还是没跑')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：数据目录在要快照的仓库里面时，整个仓库不存检查点并写一条警告', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    // 一个本身是 git 仓库的「主目录」，数据目录（.dsh/dsh-workbench/checkpoints）在它里面。
    const fakeHome = join(work, 'fakehome')
    await mkdir(fakeHome)
    await runGit(fakeHome, ['init', '.'])
    await mkdir(join(fakeHome, 'proj1'))
    await write(join(fakeHome, 'proj1', 'a.txt'), 'a\n')
    const home = join(fakeHome, '.dsh')
    const scene = recordScenario({ home, dataRoot: join(home, 'dsh-workbench', 'checkpoints') })
    await startTurn(scene.service, 's1', 1, join(fakeHome, 'proj1'))
    await startTurn(scene.service, 's1', 2, join(fakeHome, 'proj1'))
    const listed = await (await scene.service.list('s1')).json()
    assert.deepEqual(listed.entries, [], '整个仓库不存检查点')
    assert.equal(existsSync(join(scene.dataRoot, 's1', 'meta.json')), false)
    const warned = scene.warnLog.filter(message => message.includes('检查点目录在仓库里面'))
    assert.equal(warned.length, 1, '每个仓库警告一次，不是每轮一次')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：git 种类的会话 fs 意图不等快照', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const repo = join(work, 'repo')
    await runGit(work, ['init', repo])
    await write(join(repo, 'a.txt'), 'a\n')
    const base = createLocalSubprocess({ home: join(work, 'git-home') })
    // git add 要 1.2 秒（大的未跟踪目录、慢盘）。
    const slow = {
      resolveExecutable: base.resolveExecutable,
      spawn(spec) {
        const handle = base.spawn(spec)
        if (!spec.argv.includes('add')) return handle
        return {
          done: (async () => { await sleep(1_200); return handle.done })(),
          collected: handle.collected,
        }
      },
    }
    const scene = recordScenario({ subprocess: slow, waitSeconds: 10 })
    const exec = await startTurn(scene.service, 's1', 1, repo)
    // 检查点已存完，是 git 种类：fs 意图立刻放行，不等任何 git。
    const started = Date.now()
    await toolWrites(scene.service, exec, join(repo, 'a.txt'), 'changed\n')
    assert.ok(Date.now() - started < 400, `git 种类的 fs 意图不等快照（用了 ${Date.now() - started} ms）`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：快照迟迟分不好类时 fs 意图最多等 waitSeconds，迟到的捕获不把改过的内容当「改动前」', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const ws = join(work, 'workspace')
    await mkdir(ws)
    const base = createLocalSubprocess({ home: join(work, 'git-home') })
    // 解析 git 要 2.5 秒（xcode-select 探测慢）：这一轮迟迟定不下来种类。
    const slow = {
      resolveExecutable: async (...args) => {
        await sleep(2_500)
        return base.resolveExecutable(...args)
      },
      spawn: spec => base.spawn(spec),
    }
    const scene = recordScenario({ subprocess: slow, waitSeconds: 1 })
    scene.service.onSessionEvent({ id: 's1', header: { cwd: ws } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
    const exec = { agent: { session: { id: 's1' } } }
    await write(join(ws, 'a.txt'), '原来的\n')
    // 第一个工具的 pre-execute 也等到超时放行（检查点还在排队）。
    await scene.service.onPreExecute(exec, () => 'ok')
    const started = Date.now()
    await toolWrites(scene.service, exec, join(ws, 'a.txt'), '工具改过的\n')
    const waited = Date.now() - started
    assert.ok(waited < 2_000, `fs 意图最多等 waitSeconds（用了 ${waited} ms）`)
    // 等这一轮的检查点存完、排着的捕获也走完（队列走完），再核对记了什么。
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const entries = await scene.store.readEntries('s1')
      if (entries.length > 0 && scene.warnLog.some(message => message.includes('没赶上'))) break
      await sleep(100)
    }
    const entries = await scene.store.readEntries('s1')
    assert.deepEqual(entries[entries.length - 1].captures, {}, '迟到的捕获不记，不把改过的内容当改动前')
    assert.ok(scene.warnLog.some(message => message.includes('没赶上')), '跳过时记一条警告')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：清理不删正在第一次快照的会话目录（e21b）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const repo = join(work, 'repo')
    await runGit(work, ['init', repo])
    await write(join(repo, 'a.txt'), 'a\n')
    const base = createLocalSubprocess({ home: join(work, 'git-home') })
    const slow = {
      resolveExecutable: base.resolveExecutable,
      spawn(spec) {
        const handle = base.spawn(spec)
        if (!spec.argv.includes('add')) return handle
        return {
          done: (async () => { await sleep(1_200); return handle.done })(),
          collected: handle.collected,
        }
      },
    }
    const scene = recordScenario({ subprocess: slow, persistence: [{ header: { id: 'brand-new-session' } }] })
    scene.service.onSessionEvent(
      { id: 'brand-new-session', header: { cwd: repo } },
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
    )
    // 快照进行中：目录在、jsonl 还没写。「列表是空的」不能算过期。目录在假的 add 之前建好，add 至少卡 1.2 秒，
    // 所以等到目录出现再清理，机器忙的时候也落在快照进行中。
    const objects = join(scene.dataRoot, 'brand-new-session', 'objects')
    for (let i = 0; i < 100 && !existsSync(objects); i++) await sleep(20)
    assert.equal(existsSync(objects), true)
    await scene.service.cleanup()
    assert.equal(existsSync(join(scene.dataRoot, 'brand-new-session')), true, '清理不删正在快照的目录')
    await scene.service.onPreExecute({ agent: { session: { id: 'brand-new-session' } } }, () => 'ok')
    const listed = await (await scene.service.list('brand-new-session')).json()
    assert.equal(listed.entries.length, 1, '检查点没悄悄丢')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：残留的旧空目录按目录修改时间清掉', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const scene = recordScenario({ persistence: [{ header: { id: 'old' } }, { header: { id: 'live' } }] })
    // 一个没有条目的老目录（比如很久前崩溃留下的）和一个有新检查点的目录。
    await mkdir(join(scene.dataRoot, 'old', 'objects'), { recursive: true })
    await mkdir(join(scene.dataRoot, 'live', 'objects'), { recursive: true })
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    await utimes(join(scene.dataRoot, 'old'), old, old)
    await scene.store.appendEntry('live', { turn: 1, seq: 10, time: Date.now(), kind: 'git', tree: 't' })
    await scene.service.cleanup()
    assert.equal(existsSync(join(scene.dataRoot, 'old')), false, '旧的空目录清掉')
    assert.equal(existsSync(join(scene.dataRoot, 'live')), true, '有新检查点的目录留着')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：files 种类一轮碰很多文件，jsonl 增量追加不再翻倍（e20）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const ws = join(work, 'workspace')
    await mkdir(ws)
    const scene = recordScenario({})
    const exec = await startTurn(scene.service, 's1', 1, ws)
    await mkdir(join(ws, 'src'), { recursive: true })
    for (let index = 0; index < 100; index += 1) {
      // 先过钩子（捕获时文件还不存在，记 absent），钩子放行后工具才写。
      await scene.service.onFsIntent({ path: join(ws, 'src', `module-${index}.js`) }, exec, async () => 1)
      await write(join(ws, 'src', `module-${index}.js`), `// ${index}\n`)
    }
    const lines = (await readFile(join(scene.dataRoot, 's1', 'checkpoints.jsonl'), 'utf8')).split('\n').filter(line => line !== '')
    assert.equal(lines.length, 101, '一条开头加一百条增量')
    assert.ok(statSync(join(scene.dataRoot, 's1', 'checkpoints.jsonl')).size < 40_000, '不再每个文件抄整张表')
    const entries = await scene.store.readEntries('s1')
    assert.equal(Object.keys(entries[0].captures).length, 100, '读回来合成整张表')
    // 恢复照常能用：回到这一轮开始前，一百个文件都删掉。
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.restored, 100)
    assert.equal(existsSync(join(ws, 'src', 'module-0.js')), false)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：钩子空目录固定在数据目录下，不在系统临时目录里一个个建（第 41 件第 2 项）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const before = readdirSync(tmpdir()).filter(name => name.startsWith('dwb-git-hooks-')).length
    const home = join(work, 'dsh-home')
    const dataRoot = join(home, 'dsh-workbench', 'checkpoints')
    writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
    const repo = join(work, 'repo')
    await runGit(work, ['init', repo])
    await write(join(repo, 'a.txt'), 'a\n')
    for (let round = 0; round < 2; round += 1) {
      const service = createCheckpointsService({
        subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
        agents: { get: () => undefined },
        dataRoot,
        configDir: join(home, 'dsh-workbench'),
        logger: { warn: () => {}, info: () => {} },
      })
      // 真存一轮检查点，逼出 git 运行器（钩子目录在它身上）。
      await startTurn(service, 's1', 1, repo)
      service.dispose()
    }
    const after = readdirSync(tmpdir()).filter(name => name.startsWith('dwb-git-hooks-')).length
    assert.equal(after, before, '服务起两次，系统临时目录里不增加 dwb-git-hooks-*')
    // 钩子目录固定在数据目录下、不删。
    assert.equal(existsSync(join(dataRoot, '.no-hooks')), true)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('记录：config 的 waitSeconds 超出 1–60 答 400，写失败答 500', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-rec-'))
  try {
    const scene = recordScenario({})
    const post = body => scene.service.configFetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify(body) }))
    // 3_000_000 会让 setTimeout 溢出成 1 毫秒，必须答 400。
    let response = await post({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 3_000_000, maxFileMB: 2 })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).reason, 'bad-request')
    response = await post({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 61, maxFileMB: 2 })
    assert.equal(response.status, 400)
    response = await post({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 60, maxFileMB: 2 })
    assert.equal(response.status, 200)
    // 配置目录写不进去（权限）：这是服务器的事，答 500 failed，不是 400。
    await chmod(scene.configDir, 0o500)
    try {
      response = await post({ keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
      assert.equal(response.status, 500)
      assert.equal((await response.json()).reason, 'failed')
    } finally {
      await chmod(scene.configDir, 0o755)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

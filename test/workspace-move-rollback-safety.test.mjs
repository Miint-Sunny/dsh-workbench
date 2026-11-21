import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { createMemoryStore } from '../lib/memory-store.js'
import { projectKey } from '../lib/workspace-move-log.js'
import { applyWorkspaceMove, pendingWorkspaceMoves, planWorkspaceMove, recoverWorkspaceMove, undoWorkspaceMove, workspaceMoveUndoCheck } from '../lib/workspace-move.js'
import { tempDir } from './helpers/temp-dir.mjs'

const stopped = () => false
const log = 'session.v4.jsonl'
const tail = '{"type":"session/end-seed","seq":0,"time":3,"data":{}}\n'
const moduleUrl = new URL('../lib/workspace-move.js', import.meta.url).href

async function fixture({ nested = false } = {}) {
  const home = await realpath(await tempDir('dwb-rollback-'))
  const targetPath = join(home, 'new'), source = join(nested ? targetPath : home, 'old')
  const before = join(home, 'sessions', projectKey(source), 'session-a')
  const after = join(home, 'sessions', projectKey(targetPath), 'session-a')
  const registry = join(home, 'storages', 'workspace.json')
  for (const dir of [source, targetPath, dirname(registry), join(before, 'assets')]) await mkdir(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: source, isSeeded: false, delegationDepth: 0 }) + '\n'
  await writeFile(join(before, log), header)
  await writeFile(join(before, 'assets', 'note'), 'original asset')
  await writeFile(registry, JSON.stringify({
    unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w'], indexed: true },
    tables: { workspaces: { w: { id: 'w', title: 'old', path: source, sessionIds: ['session-a'] } } },
  }))
  const root = join(home, 'dsh-workbench', 'memory')
  await createMemoryStore({ root, maxBytes: 16384 }).write(source, { content: 'remember me', revision: 'empty' })
  if (nested) {
    const dir = join(home, 'dsh-workbench', 'checkpoints', 'session-a')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'checkpoints.jsonl'), JSON.stringify({ root: source }) + '\n')
  }
  const plan = await planWorkspaceMove({ home, workspaceId: 'w', targetPath, appRunning: stopped })
  assert.deepEqual(plan.blockers, [])
  assert.equal(plan.sessions.length, 1)
  return {
    home, plan, before, after, registry, header, memory: join(root, plan.workbench.memory.to),
    move: io => applyWorkspaceMove({ home, plan, appRunning: stopped, io }),
  }
}

// 在真实改名返回后结束临时 Node 进程，模拟进程在两次写盘之间被终止。
function interrupt({ op, from, to, beforeRenameFrom, beforeRenameTo, options }) {
  const script = `
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const spec = JSON.parse(process.argv[1])
    const rename = fs.rename
    fs.rename = async (a, b) => {
      if (a === spec.beforeRenameFrom || b === spec.beforeRenameTo) process.exit(70)
      const result = await rename(a, b)
      if (a === spec.from || b === spec.to) process.exit(70)
      return result
    }
    syncBuiltinESMExports()
    const api = await import(spec.moduleUrl)
    await api[spec.op]({ ...spec.options, appRunning: () => false })
  `
  const stop = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ op, from, to, beforeRenameFrom, beforeRenameTo, options, moduleUrl })], { encoding: 'utf8', timeout: 15000 })
  assert.equal(stop.status, 70, stop.stderr)
}

async function interruptedApply(f) {
  interrupt({ op: 'applyWorkspaceMove', to: f.registry, options: { home: f.home, plan: f.plan } })
  const [pending] = await pendingWorkspaceMoves(f.home)
  return pending.moveId
}

for (const action of ['undo', 'recover']) {
  test(`${action} refuses changes anywhere in the relocated session or memory before restoring the registry`, async () => {
    const f = await fixture()
    const moveId = action === 'undo' ? (await f.move()).moveId : await interruptedApply(f)
    const options = { home: f.home, moveId, appRunning: stopped }
    const cancel = () => action === 'undo' ? undoWorkspaceMove(options) : recoverWorkspaceMove(options)
    const movedRegistry = await readFile(f.registry)
    for (const [file, restore] of [
      [join(f.after, 'assets', 'new'), undefined], [join(f.after, 'assets', 'note'), 'original asset'],
      [join(f.memory, 'new-note'), undefined],
    ]) {
      await writeFile(file, 'edited')
      await assert.rejects(cancel(), { code: 'changed-since-move' })
      assert.equal(await readFile(file, 'utf8'), 'edited')
      assert.deepEqual(await readFile(f.registry), movedRegistry)
      if (restore === undefined) await rm(file)
      else await writeFile(file, restore)
    }
    await rename(f.after, join(f.home, 'relocated'))
    await assert.rejects(cancel(), { code: 'changed-since-move' })
    assert.deepEqual(await readFile(f.registry), movedRegistry)
  })

  test(`${action} resumes after the appended session has left the new project, with exactly one copy of its events`, async () => {
    const f = await fixture()
    const moveId = action === 'undo' ? (await f.move()).moveId : await interruptedApply(f)
    await appendFile(join(f.after, log), tail)
    const options = { home: f.home, moveId }
    interrupt({ op: action === 'undo' ? 'undoWorkspaceMove' : 'recoverWorkspaceMove', from: f.after, options })
    assert.deepEqual((await pendingWorkspaceMoves(f.home)).map(x => x.moveId), [moveId])
    await recoverWorkspaceMove({ ...options, appRunning: stopped })
    assert.equal(await readFile(join(f.before, log), 'utf8'), f.header + tail)
    assert.deepEqual(await pendingWorkspaceMoves(f.home), [])
    await assert.rejects(lstat(f.after), { code: 'ENOENT' })
  })
}

test('undo refuses a damaged parked original or backup before it changes any live data', async () => {
  const f = await fixture()
  const { moveId, moveDir } = await f.move()
  const options = { home: f.home, moveId, appRunning: stopped }
  for (const file of [join(moveDir, 'before', f.plan.sessions[0].from, log), join(moveDir, 'before', 'storages', 'workspace.json')]) {
    const bytes = await readFile(file)
    await writeFile(file, 'damaged backup')
    assert.equal((await workspaceMoveUndoCheck(options)).undoable, false)
    const movedRegistry = await readFile(f.registry)
    await assert.rejects(undoWorkspaceMove(options), { code: 'changed-since-move' })
    assert.deepEqual(await readFile(f.registry), movedRegistry)
    assert.equal((await lstat(f.after)).isDirectory(), true)
    await writeFile(file, bytes)
  }
})

test('undo preserves a newly occupied original session directory and an unrelated session in the target project', async () => {
  const f = await fixture()
  const { moveId } = await f.move()
  await mkdir(f.before, { recursive: true })
  await mkdir(join(dirname(f.after), 'other-session'))
  const options = { home: f.home, moveId, appRunning: stopped }
  const movedRegistry = await readFile(f.registry)
  await assert.rejects(undoWorkspaceMove(options), { code: 'changed-since-move' })
  assert.deepEqual(await readFile(f.registry), movedRegistry)
  await rm(f.before, { recursive: true })
  await undoWorkspaceMove(options)
  assert.equal((await lstat(join(dirname(f.after), 'other-session'))).isDirectory(), true)
  assert.equal(await readFile(join(f.before, log), 'utf8'), f.header)
})

test('a destination memory directory acquired during staging stays in its original location', async () => {
  const f = await fixture()
  let occupied = false
  await assert.rejects(f.move({ async rename(from, to) {
    if (!occupied && to === f.after) {
      occupied = true
      await mkdir(f.memory)
      await writeFile(join(f.memory, 'belongs-to-user'), 'keep')
    }
    return rename(from, to)
  } }))
  assert.equal(occupied, true)
  assert.equal(await readFile(join(f.memory, 'belongs-to-user'), 'utf8'), 'keep')
  assert.equal(await readFile(join(f.before, log), 'utf8'), f.header)
})

test('a temporary tail write interrupted before publish can resume without an unexpected session file', async () => {
  const f = await fixture()
  const { moveId, moveDir } = await f.move()
  await appendFile(join(f.after, log), tail)
  const options = { home: f.home, moveId }
  const parked = join(moveDir, 'before', f.plan.sessions[0].from, log)
  interrupt({ op: 'undoWorkspaceMove', beforeRenameTo: parked, options })
  await recoverWorkspaceMove({ ...options, appRunning: stopped })
  assert.equal(await readFile(join(f.before, log), 'utf8'), f.header + tail)
})

test('an unfinished forward rename leaves later writes at the original location intact', async () => {
  const f = await fixture()
  const options = { home: f.home, plan: f.plan }
  interrupt({ op: 'applyWorkspaceMove', beforeRenameFrom: f.before, options })
  const [pending] = await pendingWorkspaceMoves(f.home)
  await appendFile(join(f.before, log), tail)
  await recoverWorkspaceMove({ home: f.home, moveId: pending.moveId, appRunning: stopped })
  assert.equal(await readFile(join(f.before, log), 'utf8'), f.header + tail)
  assert.deepEqual(await pendingWorkspaceMoves(f.home), [])
})

test('a project already containing an empty destination session acquired during staging is preserved', async () => {
  const f = await fixture()
  let occupied = false
  await assert.rejects(f.move({ async rename(from, to) {
    if (!occupied && from === f.before) {
      occupied = true
      await mkdir(f.after, { recursive: true })
    }
    return rename(from, to)
  } }))
  assert.equal(occupied, true)
  assert.equal((await lstat(f.after)).isDirectory(), true)
  assert.equal(await readFile(join(f.before, log), 'utf8'), f.header)
})

test('an older completed migration uses its recorded post-move digest when both copies of a side file changed', async () => {
  const f = await fixture()
  const { moveId, moveDir } = await f.move()
  const path = join(moveDir, 'journal.json')
  const journal = JSON.parse(await readFile(path))
  for (const entry of journal.entries) {
    if (entry.op === 'move' && entry.from === f.before) delete entry.tree
  }
  await writeFile(path, JSON.stringify(journal))
  for (const dir of [f.after, join(moveDir, 'before', f.plan.sessions[0].from)]) await writeFile(join(dir, 'assets', 'note'), 'restored from a different snapshot')
  assert.equal((await workspaceMoveUndoCheck({ home: f.home, moveId })).undoable, false)
})

test('an original directory replaced by a regular file gives the undo caller the changed path', async () => {
  const f = await fixture()
  const { moveId } = await f.move()
  await mkdir(dirname(f.before), { recursive: true })
  await writeFile(f.before, 'new unrelated file')
  const state = await workspaceMoveUndoCheck({ home: f.home, moveId })
  assert.equal(state.reason, 'changed-since-move')
  assert.ok(state.changed.includes(f.plan.sessions[0].from))
  assert.deepEqual(state.conflict, { code: 'original-occupied' })
  await assert.rejects(undoWorkspaceMove({ home: f.home, moveId, appRunning: stopped }), { code: 'changed-since-move' })
  assert.equal(await readFile(f.before, 'utf8'), 'new unrelated file')
})

for (const earlierTail of [false, true]) {
  test(`recovery after the original session was restored preserves later events (previous append: ${earlierTail})`, async () => {
    const f = await fixture()
    const { moveId, moveDir } = await f.move()
    const options = { home: f.home, moveId }
    if (earlierTail) await appendFile(join(f.after, log), tail)
    // 一个停在放回会话后、记录进度前；另一个停在进度已经记录之后。
    interrupt({ op: 'undoWorkspaceMove', options, ...earlierTail ? { from: join(moveDir, 'staging') } : { to: f.before } })
    const path = join(f.before, log), original = f.header + (earlierTail ? tail : '')
    assert.equal(await readFile(path, 'utf8'), original)
    const resume = () => recoverWorkspaceMove({ ...options, appRunning: stopped })
    await appendFile(path, 'invalid event\n')
    await assert.rejects(resume(), { code: 'changed-since-move' })
    assert.equal(await readFile(path, 'utf8'), original + 'invalid event\n')
    const next = JSON.stringify({ type: 'turn/start', seq: earlierTail ? 1 : 0, time: 4, data: { turn: 1 } }) + '\n'
    await writeFile(path, original + next)
    const asset = join(f.before, 'assets', 'note')
    await writeFile(asset, 'a later edit')
    await assert.rejects(resume(), { code: 'changed-since-move' })
    assert.equal(await readFile(asset, 'utf8'), 'a later edit')
    await writeFile(asset, 'original asset')
    await resume()
    assert.equal(await readFile(path, 'utf8'), original + next)
    assert.deepEqual(await pendingWorkspaceMoves(f.home), [])
  })
}

for (const stopAt of ['registry', 'memory']) test('undo resumes after restoring the ' + stopAt + ' while keeping later writes', async () => {
  const f = await fixture()
  const { moveId } = await f.move()
  const original = join(dirname(f.memory), f.plan.workbench.memory.from)
  await appendFile(join(f.memory, 'MEMORY.md'), 'later\n')
  const options = { home: f.home, moveId }
  interrupt({ op: 'undoWorkspaceMove', to: stopAt === 'registry' ? f.registry : original, options })
  const reg = JSON.parse(await readFile(f.registry))
  assert.equal(reg.tables.workspaces.w.path, f.plan.source.path)
  reg.global.archivedSessionIds = ['session-a']
  await writeFile(f.registry, JSON.stringify(reg))
  await recoverWorkspaceMove({ ...options, appRunning: stopped })
  assert.match(await readFile(join(original, 'MEMORY.md'), 'utf8'), /later\n$/)
  assert.deepEqual(JSON.parse(await readFile(f.registry)), reg)
})

test('recovery reports a second change to the folder after undo has restored the registry', async () => {
  const f = await fixture()
  const { moveId } = await f.move()
  const options = { home: f.home, moveId }
  interrupt({ op: 'undoWorkspaceMove', to: join(dirname(f.memory), f.plan.workbench.memory.from), options })
  const reg = JSON.parse(await readFile(f.registry))
  reg.tables.workspaces.w.path = join(f.home, 'third')
  await writeFile(f.registry, JSON.stringify(reg))
  await assert.rejects(recoverWorkspaceMove({ ...options, appRunning: stopped }), { code: 'changed-since-move' })
  assert.deepEqual(JSON.parse(await readFile(f.registry)), reg)
})

test('recovery of a published checkpoint rewrite keeps restored rows when the old folder is under the new one', async () => {
  const f = await fixture({ nested: true })
  const { moveId } = await f.move()
  const file = join(f.home, 'dsh-workbench', 'checkpoints', 'session-a', 'checkpoints.jsonl')
  const line = root => JSON.stringify({ root }) + '\n'
  const options = { home: f.home, moveId }
  await appendFile(file, line(f.plan.result.path))
  interrupt({ op: 'undoWorkspaceMove', to: file, options })
  await appendFile(file, line(f.plan.result.path))
  await recoverWorkspaceMove({ ...options, appRunning: stopped })
  assert.equal(await readFile(file, 'utf8'), line(f.plan.source.path).repeat(3))
})

test('recovery keeps sessions registered at the original folder before the forward registry rename', async () => {
  const f = await fixture()
  interrupt({ op: 'applyWorkspaceMove', beforeRenameTo: f.registry, options: { home: f.home, plan: f.plan } })
  const [pending] = await pendingWorkspaceMoves(f.home)
  const reg = JSON.parse(await readFile(f.registry))
  reg.tables.workspaces.w.sessionIds.push('later')
  reg.tables.workspaces.w.title = 'Current'
  await writeFile(f.registry, JSON.stringify(reg))
  await recoverWorkspaceMove({ home: f.home, moveId: pending.moveId, appRunning: stopped })
  assert.deepEqual(JSON.parse(await readFile(f.registry)), reg)
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { memoryHeader, createMemoryStore } from '../lib/memory-store.js'
import { projectKey } from '../lib/workspace-move-log.js'
import * as api from '../lib/workspace-move.js'
import { emptyWorkspace } from './helpers/workspace-move-empty.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

const read = async path => JSON.parse(await readFile(path, 'utf8'))
const write = (path, value) => writeFile(path, JSON.stringify(value))
const appRunning = () => false
async function moved({ merge = false, producer = api, checkpointAtDestination = false } = {}) {
  const { home, id, old, work } = await emptyWorkspace()
  const registry = join(home, 'storages', 'workspace.json'), data = join(home, 'dsh-workbench')
  const session = join(home, 'sessions', projectKey(old), 'a'), cp = join(data, 'checkpoints', 'a')
  await mkdir(session, { recursive: true })
  await mkdir(cp, { recursive: true })
  await writeFile(join(session, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4, id: 'a', createdAt: 1, cwd: old }) + '\n')
  const reg = await read(registry)
  reg.tables.workspaces[id].sessionIds = ['a']
  reg.tables.workspaces.other = { title: 'Other', path: join(home, 'other'), sessionIds: [] }
  reg.global.workspaceIds.push('other')
  if (merge) {
    reg.tables.workspaces.dst = { title: 'Dest', path: work, sessionIds: ['existing'] }
    reg.global.workspaceIds.push('dst')
  }
  await write(registry, reg)
  const folders = join(data, 'workspace-folders.json'), trust = join(data, 'workspace-trust.json')
  await write(folders, { version: 1, workspaces: { [id]: { externals: ['old-ext'] }, other: { writableSubfolders: [id] } } })
  await write(trust, { version: 1, workspaces: [{ path: old, trustedAt: '2025-01-01T00:00:00Z' }] })
  const lines = join(cp, 'checkpoints.jsonl')
  await writeFile(lines, JSON.stringify({ turn: 1, root: checkpointAtDestination ? work : old }) + '\n')
  const root = join(data, 'memory')
  await createMemoryStore({ root, maxBytes: 16384 }).write(old, { content: 'first', revision: 'empty' })
  const plan = await producer.planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning })
  const { moveId } = await producer.applyWorkspaceMove({ home, plan, appRunning })
  const options = { home, moveId, appRunning }
  return { home, id, old, work, registry, folders, trust, lines, cp, options,
    sourceMemory: join(root, plan.workbench.memory.from), targetMemory: join(root, plan.workbench.memory.to),
    check: () => api.workspaceMoveUndoCheck(options), undo: () => api.undoWorkspaceMove(options) }
}

async function unrelated(f) {
  const r = await read(f.registry)
  r.tables.workspaces.other.sessionIds.push('later')
  r.tables.workspaces.other.updatedAt = 'later-time'
  r.global.archivedSessionIds = ['later']
  await write(f.registry, r)
  const start = Date.now()
  await f.undo()
  const restored = await read(f.registry)
  assert.deepEqual(restored.tables.workspaces.other, r.tables.workspaces.other)
  assert.deepEqual(restored.global.archivedSessionIds, ['later'])
  assert.equal(restored.tables.workspaces[f.id].path, f.old)
  assert.equal(restored.tables.workspaces[f.id].title, basename(f.old))
  assert.ok(Date.parse(restored.tables.workspaces[f.id].updatedAt) >= start)
}
test('undo keeps unrelated registrations, timestamps and archive membership', async () => unrelated(await moved()))

test('undo reads a migration written by the 98ada82 release with later registry edits', async t => {
  const rev = '98ada8278163c3f8d6ab74caf96b5f2bbc5c0163'
  try { execFileSync('git', ['cat-file', '-e', rev], { stdio: 'ignore' }) }
  catch { return t.skip('baseline Git revision unavailable') }
  const dir = await tempDir('dwb-legacy-release-')
  const archive = execFileSync('git', ['archive', rev, 'package.json', 'lib'], { maxBuffer: 32 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', dir], { input: archive })
  const producer = await import(pathToFileURL(join(dir, 'lib/workspace-move.js')))
  await unrelated(await moved({ producer }))
})

test('undo keeps a title edited after the folder move', async () => {
  const f = await moved(), r = await read(f.registry)
  r.tables.workspaces[f.id].title = 'Renamed'
  await write(f.registry, r)
  await f.undo()
  const row = (await read(f.registry)).tables.workspaces[f.id]
  assert.deepEqual([row.title, row.path], ['Renamed', f.old])
})

for (const [conflict, count] of [['path-changed', 0], ['new-sessions', 2], ['original-occupied', 0]]) {
  test('undo identifies ' + conflict + ' before writing', async () => {
    const f = await moved(), r = await read(f.registry)
    if (conflict === 'path-changed') r.tables.workspaces[f.id].path = join(f.home, 'third')
    if (count) r.tables.workspaces[f.id].sessionIds.push('new1', 'new2')
    if (conflict === 'original-occupied') await mkdir(f.sourceMemory)
    await write(f.registry, r)
    const expected = count ? { code: conflict, count } : { code: conflict }
    assert.deepEqual((await f.check()).conflict, expected)
    await assert.rejects(f.undo(), e => e.code === 'changed-since-move' && e.details.conflict.code === conflict && (!count || e.message.includes(count + ' 个会话')))
    assert.deepEqual(await read(f.registry), r)
  })
}

for (const newDefault of ['dst', 'other']) test('undo merge with a later session and default ' + newDefault, async () => {
  const f = await moved({ merge: true }), r = await read(f.registry)
  r.tables.workspaces.dst.sessionIds.push('unrelated')
  r.global.defaultWorkspaceId = newDefault
  await write(f.registry, r)
  await f.undo()
  const restored = await read(f.registry)
  assert.deepEqual(restored.global.workspaceIds, [f.id, 'other', 'dst'])
  assert.deepEqual(restored.tables.workspaces[f.id].sessionIds, ['a'])
  assert.deepEqual(restored.tables.workspaces.dst.sessionIds, ['existing', 'unrelated'])
  assert.equal(restored.global.defaultWorkspaceId, newDefault === 'dst' ? f.id : newDefault)
})

test('undo restores trust and folder memberships while keeping later workspace settings', async () => {
  const f = await moved({ merge: true })
  const trust = await read(f.trust), folders = await read(f.folders)
  trust.workspaces.push({ path: '/another', trustedAt: 'later' })
  folders.workspaces.dst.externals.push('later')
  folders.workspaces.other.writableSubfolders.push('later')
  folders.workspaces.later = { externals: ['independent'] }
  await write(f.trust, trust)
  await write(f.folders, folders)
  await f.undo()
  assert.deepEqual((await read(f.trust)).workspaces, [{ ...trust.workspaces[0], path: f.old }, trust.workspaces[1]])
  const restored = (await read(f.folders)).workspaces
  assert.deepEqual(restored[f.id].externals, ['old-ext'])
  assert.deepEqual(restored.dst.externals, ['later'])
  assert.deepEqual(restored.other.writableSubfolders, [f.id, 'later'])
  assert.deepEqual(restored.later, folders.workspaces.later)
})

test('undo rewrites an appended checkpoint and a newly created restore file', async () => {
  const f = await moved()
  await appendFile(f.lines, JSON.stringify({ turn: 2, root: join(f.work, 'sub'), note: 'later' }) + '\n')
  await write(join(f.cp, 'restore.json'), { cwd: f.work, value: 'new' })
  await f.undo()
  assert.deepEqual((await readFile(f.lines, 'utf8')).trimEnd().split('\n').map(s => JSON.parse(s)),
    [{ turn: 1, root: f.old }, { turn: 2, root: join(f.old, 'sub'), note: 'later' }])
  assert.deepEqual(await read(join(f.cp, 'restore.json')), { cwd: f.old, value: 'new' })
})

test('undo returns the live memory directory and keeps its new body', async () => {
  const f = await moved(), inode = (await stat(f.targetMemory)).ino
  await writeFile(join(f.targetMemory, 'MEMORY.md'), memoryHeader({ path: f.work, kind: 'workspace' }) + 'replacement\n')
  await f.undo()
  assert.equal((await stat(f.sourceMemory)).ino, inode)
  assert.equal(await readFile(join(f.sourceMemory, 'MEMORY.md'), 'utf8'), memoryHeader({ path: f.old, kind: 'workspace' }) + 'replacement\n')
})

test('undo refuses a relocated checkpoint whose root no longer identifies the moved workspace', async () => {
  const f = await moved()
  const content = JSON.stringify({ turn: 1, root: join(f.home, 'third') }) + '\n'
  await writeFile(f.lines, content)
  assert.equal((await f.check()).undoable, false)
  await assert.rejects(f.undo(), { code: 'changed-since-move' })
  assert.equal(await readFile(f.lines, 'utf8'), content)
})

test('undo keeps checkpoint paths already at the destination before the move and remaps only the later rows', async () => {
  const f = await moved({ checkpointAtDestination: true })
  await appendFile(f.lines, JSON.stringify({ turn: 2, root: f.work }) + '\n')
  await f.undo()
  const rows = (await readFile(f.lines, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.root), [f.work, f.old])
})

test('undo accepts readable checkpoint JSON with new formatting and preserves additional fields', async () => {
  const f = await moved(), path = join(f.cp, 'restore.json')
  await writeFile(path, JSON.stringify({ root: f.work, sequence: 4 }, null, 4))
  await f.undo()
  assert.deepEqual(await read(path), { root: f.old, sequence: 4 })
})

test('unreadable moved checkpoint paths block undo, while an unrelated malformed appended line is preserved', async () => {
  const f = await moved(), movedLine = await readFile(f.lines, 'utf8')
  await writeFile(f.lines, 'broken checkpoint\n')
  assert.equal((await f.check()).conflict?.code, 'checkpoint-changed')
  await writeFile(f.lines, movedLine + 'unrelated broken line\n')
  await f.undo()
  assert.equal(await readFile(f.lines, 'utf8'), JSON.stringify({ turn: 1, root: f.old }) + '\nunrelated broken line\n')
})

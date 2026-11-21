import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative } from 'node:path'
import { test } from 'node:test'
import { applyWorkspaceMove, pendingWorkspaceMoves, planWorkspaceMove, recoverWorkspaceMove, undoWorkspaceMove, workspaceMoveUndoCheck } from '../lib/workspace-move.js'
import { memoryHeader, memoryKey } from '../lib/memory-store.js'
import { projectKey } from '../lib/workspace-move-log.js'
import { tempDir } from './helpers/temp-dir.mjs'

async function fixture() {
  const home = await realpath(await tempDir('dwb-preview-'))
  const source = join(home, 'old')
  const target = join(home, 'new')
  const data = join(home, 'dsh-workbench')
  const log = join(home, 'sessions', projectKey(source), 'session-a', 'session.v4.jsonl')
  await Promise.all([source, target, data, dirname(log), join(home, 'storages')].map(dir => mkdir(dir, { recursive: true })))
  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws'] },
    tables: { workspaces: { ws: { title: 'old', path: source, sessionIds: ['session-a'] } } },
  }
  await writeFile(join(home, 'storages/workspace.json'), JSON.stringify(registry))
  await writeFile(log, JSON.stringify({ type: 'session', version: 4, id: 'session-a', cwd: source, createdAt: 1 }) + '\n')
  const preview = (targetPath = target) => planWorkspaceMove({ home, workspaceId: 'ws', targetPath, appRunning: () => false })
  return { home, source, target, data, log, preview }
}

test('确认后新出现的检查点需要重新预览', async () => {
  const { home, source, data, preview } = await fixture()
  const plan = await preview()
  const dir = join(data, 'checkpoints/session-a')
  await mkdir(dir, { recursive: true })
  const contents = JSON.stringify({ kind: 'files', cwd: source, root: source })
  await writeFile(join(dir, 'meta.json'), contents)
  await assert.rejects(applyWorkspaceMove({ home, plan, appRunning: () => false }), { code: 'stale-plan' })
  assert.equal(await readFile(join(dir, 'meta.json'), 'utf8'), contents)
})

test('目标记忆目录含其他数据时预览明确保留两处记忆目录', async () => {
  const { source, target, data, preview } = await fixture()
  const oldMemory = join(data, 'memory', memoryKey('workspace', source))
  const newMemory = join(data, 'memory', memoryKey('workspace', target))
  await Promise.all([oldMemory, newMemory].map(dir => mkdir(dir, { recursive: true })))
  await writeFile(join(oldMemory, 'MEMORY.md'), memoryHeader({ kind: 'workspace', path: source }) + 'sample')
  await writeFile(join(newMemory, 'notes.txt'), 'existing')
  assert.equal((await preview()).workbench.memory.action, 'conflict')
})

test('无法辨认源工作区的会话头时阻止整组迁移', async () => {
  const { log, preview } = await fixture()
  await writeFile(log, '{"type":"session"')
  assert.ok((await preview()).blockers.some(item => item.code === 'log-format'))
})

test('迁移预览识别目标项目目录和工作台记录中的符号链接', async () => {
  const { home, data, target, preview } = await fixture()
  const snapshots = join(home, 'snapshots')
  await mkdir(snapshots)
  await symlink(snapshots, join(home, 'sessions', projectKey(target)), 'dir')
  await assert.rejects(preview(), { code: 'data-format' })
  await rename(join(home, 'sessions', projectKey(target)), join(home, 'saved-link'))
  await symlink(snapshots, join(data, 'checkpoints'), 'dir')
  await assert.rejects(preview(), { code: 'data-format' })
})

test('迁移预览沿用工作区信任对根目录的限制', async () => {
  const { source, data, preview } = await fixture()
  await writeFile(join(data, 'workspace-trust.json'), JSON.stringify({ version: 1, workspaces: [{ path: source }] }))
  await assert.rejects(preview(parse(process.cwd()).root), { code: 'target-invalid' })
})

test('恢复列表只列迁移目录，忽略访达和用户写入的普通文件', async () => {
  const { home, data } = await fixture()
  const records = join(data, 'workspace-moves')
  await mkdir(records)
  await writeFile(join(records, '.DS_Store'), 'finder')
  await writeFile(join(records, 'README'), 'notes')
  assert.deepEqual(await pendingWorkspaceMoves(home), [])
})

test('直接调用撤销检查和恢复时也要提供有效的迁移号', async () => {
  const { home } = await fixture()
  for (const op of [workspaceMoveUndoCheck, recoverWorkspaceMove]) {
    await assert.rejects(op({ home, moveId: ['unfinished'], appRunning: () => false }), { code: 'bad-request' })
  }
})

test('源记忆中有未完成写入时保留原目录并提醒', async () => {
  const { source, data, preview } = await fixture()
  const dir = join(data, 'memory', memoryKey('workspace', source))
  await mkdir(join(dir, '.write-lock'), { recursive: true })
  await writeFile(join(dir, 'MEMORY.md'), memoryHeader({ kind: 'workspace', path: source }) + 'sample')
  const plan = await preview()
  assert.equal(plan.workbench.memory.action, 'unreadable')
  assert.ok(plan.warnings.some(item => item.code === 'memory-unreadable'))
})

test('用相对数据目录迁移时记录绝对位置，撤销可恢复原目录', async () => {
  const { home, target } = await fixture()
  const relativeHome = relative(process.cwd(), home)
  const plan = await planWorkspaceMove({ home: relativeHome, workspaceId: 'ws', targetPath: target, appRunning: () => false })
  const { moveId } = await applyWorkspaceMove({ home: relativeHome, plan, appRunning: () => false })
  assert.deepEqual(await workspaceMoveUndoCheck({ home, moveId }), { undoable: true })
  assert.deepEqual(await undoWorkspaceMove({ home: relativeHome, moveId, appRunning: () => false }), { status: 'undone' })
})

test('迁移记录本身只允许所有者访问，即使数据目录允许其他用户进入', { skip: process.platform === 'win32' }, async () => {
  const { home, preview } = await fixture()
  const { moveDir } = await applyWorkspaceMove({ home, plan: await preview(), appRunning: () => false })
  assert.equal((await stat(moveDir)).mode & 0o077, 0)
})

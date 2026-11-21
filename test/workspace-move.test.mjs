import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { createCheckpointsStore } from '../lib/checkpoints-store.js'
import { policyHash } from '../lib/policy-scope.js'
import { applyWorkspaceMove, planWorkspaceMove, undoWorkspaceMove, workspaceMoveUndoCheck } from '../lib/workspace-move.js'
import { createFoldersStore } from '../lib/workspace-folders-store.js'
import { createTrustStore } from '../lib/workspace-trust-store.js'
import { appCheck, NEEDS_APP, seedHome, treeHashes } from './helpers/dsh-app.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import { undoTree, done, MEMORY, MOVES, NOT_RUNNING, setup } from './helpers/workspace-move-fixture.mjs'

const groupsOf = report => Object.fromEntries(report.workspaces.map(item => [item.path, { id: item.id, title: item.title, sessionIds: item.sessionIds }]))
const sessionDirs = home => readdirSync(join(home, 'sessions')).sort()

test('预览：列出要搬的会话、分叉、子代理、归档和工作台数据，算出搬后的分组；不改任何文件', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const before = treeHashes(home)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  assert.deepEqual(plan.blockers, [])
  assert.equal(plan.target.kind, 'folder')
  assert.deepEqual(plan.sessions.map(item => [item.id, item.role, item.archived]).sort(), [
    ['session-a', 'session', false], ['session-b', 'fork', false], ['session-c', 'session', true], ['sub-1', 'subagent', false],
  ])
  assert.deepEqual(plan.counts, { sessions: 3, forks: 1, subagents: 1, archived: 1 })
  assert.deepEqual(plan.result, { workspaceId: id, title: 'work', path: work, sessionIds: ['session-c', 'session-b', 'session-a'] })
  assert.deepEqual(plan.workbench.checkpoints, [{ sessionId: 'session-a', files: 2, fields: 3 }])
  assert.equal(plan.workbench.memory.action, 'move')
  assert.equal(plan.workbench.trust.action, 'replace')
  assert.deepEqual(treeHashes(home), before)
})

test('搬到新文件夹：App 启动后只剩新位置一组，会话头目录是新文件夹，事件一条不差，工作台数据跟过去', { skip: NEEDS_APP }, async () => {
  const { home, data, old, work, other, id } = await setup()
  const before = appCheck(home)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const after = appCheck(home)
  assert.equal(after.ok, true, after.error)
  const groups = groupsOf(after)
  assert.deepEqual(groups[work], { id, title: 'work', sessionIds: ['session-c', 'session-b', 'session-a'] })
  assert.equal(groups[old], undefined)
  assert.deepEqual(groups[other], groupsOf(before)[other])
  for (const sid of ['session-a', 'session-b', 'session-c', 'sub-1']) {
    assert.equal(after.sessions[sid].cwd, work, sid)
    assert.deepEqual([after.sessions[sid].events, after.sessions[sid].digest, after.sessions[sid].inherited],
      [before.sessions[sid].events, before.sessions[sid].digest, before.sessions[sid].inherited], sid)
  }
  assert.deepEqual(after.sessions['session-o'], before.sessions['session-o'])
  assert.deepEqual([after.listed, after.archived, after.pinned], [5, ['session-c'], ['session-b']])
  assert.equal(sessionDirs(home).filter(dir => readdirSync(join(home, 'sessions', dir)).includes('session-a')).length, 1)
  assert.equal((await MEMORY(data).view(work)).content, '记住：课程笔记在这个文件夹里\n')
  const checkpoints = createCheckpointsStore(join(data, 'checkpoints'))
  assert.deepEqual(await checkpoints.readMeta('session-a'), { cwd: work, root: work, kind: 'files' })
  assert.deepEqual((await checkpoints.readEntries('session-a')).map(entry => entry.root), [work])
  assert.deepEqual([createTrustStore(data).isTrusted(work), createTrustStore(data).isTrusted(old)], [true, false])
})

test('并进已有的工作区：两组各自的顺序不变，按创建时间交错；旧组的登记删掉', { skip: NEEDS_APP }, async () => {
  const { home, old, work, id, workId } = await setup({ mergeTarget: true })
  const before = appCheck(home)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  assert.equal(plan.target.kind, 'workspace')
  assert.deepEqual(plan.result.sessionIds, ['session-c', 'session-w', 'session-b', 'session-a'])
  await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const after = appCheck(home)
  assert.equal(after.ok, true, after.error)
  const groups = groupsOf(after)
  assert.deepEqual(groups[work], { id: workId, title: 'work', sessionIds: ['session-c', 'session-w', 'session-b', 'session-a'] })
  assert.equal(groups[old], undefined)
  assert.equal(after.workspaces.some(item => item.id === id), false)
  assert.equal(after.listed, 6)
  for (const sid of ['session-a', 'session-b', 'session-c', 'sub-1', 'session-w']) assert.equal(after.sessions[sid].digest, before.sessions[sid].digest, sid)
})

test('并进已有的工作区：旧组的「工作区文件夹」设置并到新组，别的组里引用旧组的地方改成新组', { skip: NEEDS_APP }, async () => {
  const { home, data, other, work, id, workId } = await setup({ mergeTarget: true })
  const extraA = await tempDir('dwb-move-ext-a-')
  const extraB = await tempDir('dwb-move-ext-b-')
  const folders = createFoldersStore(data)
  folders.addExternal(id, extraA)
  folders.addExternal(workId, extraB)
  const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
  const otherId = Object.entries(registry.tables.workspaces).find(([, item]) => item.path === other)[0]
  folders.setWritable(otherId, id, true)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  assert.equal(plan.workbench.folders.action, 'merge')
  await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const settings = folders.read()
  assert.deepEqual(settings[workId].externals.sort(), [extraA, extraB].sort())
  assert.equal(settings[id], undefined)
  assert.deepEqual(settings[otherId].writableSubfolders, [workId])
})

test('预览列出搬了也不会跟过去的工作台文件：提到旧路径或旧路径哈希的，搬的时候不碰', { skip: NEEDS_APP }, async () => {
  const { home, data, old, work, id } = await setup()
  const rules = `${JSON.stringify({ rules: [{ projectPath: old, cwd: `${old}/sub`, projectKey: policyHash(old) }] })}\n`
  writeFileSync(join(data, 'approval-rules.json'), rules)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  assert.deepEqual(plan.workbench.untouched, [{ file: 'approval-rules.json', mentions: 3 }])
  await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  assert.equal(readFileSync(join(data, 'approval-rules.json'), 'utf8'), rules)
})

test('撤回：搬完再撤回，DSH_HOME 里除了迁移记录，只更新被迁移工作区的时间', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const before = undoTree(home, id)
  const dirs = sessionDirs(home)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  assert.notDeepEqual(undoTree(home, id), before)
  await undoWorkspaceMove({ home, moveId, appRunning: NOT_RUNNING })
  assert.deepEqual(undoTree(home, id), before)
  assert.deepEqual(sessionDirs(home), dirs)
  assert.equal(appCheck(home).ok, true)
})

test('做到一半失败（第 3 个会话日志写不进去）：抛出原错误，DSH_HOME 回到原样', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const before = treeHashes(home, MOVES)
  const dirs = sessionDirs(home)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  let logWrites = 0
  const io = {
    writeFile: async (path, data, options) => {
      if (path.includes('.jsonl') && ++logWrites === 3) throw new Error('disk full (test)')
      return writeFile(path, data, options)
    },
  }
  await assert.rejects(applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING, io }), /disk full \(test\)/)
  assert.equal(logWrites, 3)
  assert.deepEqual(treeHashes(home, MOVES), before)
  assert.deepEqual(sessionDirs(home), dirs)
  assert.equal(appCheck(home).ok, true)
})

test('有进行中的轮次：预览列为阻碍，搬的时候拒绝，什么都不改', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup({ openTurn: true })
  const before = treeHashes(home)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  assert.deepEqual(plan.blockers.map(item => [item.code, item.sessionId]), [['open-turn', 'session-a']])
  await assert.rejects(applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING }), /open-turn/)
  assert.deepEqual(treeHashes(home), before)
})

test('App 在运行：预览列为阻碍，搬和撤回都拒绝', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: () => true })
  assert.deepEqual(plan.blockers.map(item => item.code), ['app-running'])
  await assert.rejects(applyWorkspaceMove({ home, plan, appRunning: () => true }), /app-running/)
  const ready = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan: ready, appRunning: NOT_RUNNING })
  const after = treeHashes(home)
  await assert.rejects(undoWorkspaceMove({ home, moveId, appRunning: () => true }), /app-running/)
  assert.deepEqual(treeHashes(home), after)
})

test('搬完以后在新位置接着聊过：撤回时新写的内容跟着回到原位置，会话头还是旧文件夹，别的文件和搬之前一样', { skip: NEEDS_APP }, async () => {
  const { home, work, id, old } = await setup()
  const before = undoTree(home, id)
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  seedHome(home, { appends: [{ id: 'session-a', events: done(2) }] })
  assert.deepEqual(await workspaceMoveUndoCheck({ home, moveId }), { undoable: true, appended: ['session-a'] })
  await undoWorkspaceMove({ home, moveId, appRunning: NOT_RUNNING })
  const report = appCheck(home)
  assert.equal(report.ok, true, report.error)
  assert.equal(report.sessions['session-a'].events, 4)
  assert.deepEqual(Object.fromEntries(report.workspaces.map(item => [item.path, item.sessionIds]))[old], ['session-c', 'session-b', 'session-a'])
  const now = undoTree(home, id)
  const differ = Object.keys({ ...before, ...now }).filter(rel => now[rel] !== before[rel])
  assert.ok(differ.length > 0 && differ.every(rel => rel.split(sep).includes('session-a')), differ.join(', '))
})

test('撤销前检查：没动过、只在末尾追加过的可以撤销；日志被改写、会话目录多了文件就列出会话，撤回拒绝，什么都不改', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  const { moveId } = await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  const dirOf = sessionId => join(home, plan.sessions.find(item => item.id === sessionId).to)
  assert.deepEqual(await workspaceMoveUndoCheck({ home, moveId }), { undoable: true })
  seedHome(home, { appends: [{ id: 'session-b', events: done(3) }] })
  assert.deepEqual(await workspaceMoveUndoCheck({ home, moveId }), { undoable: true, appended: ['session-b'] })
  // 改写：截掉最后一个字节，不是在末尾追加
  const log = join(dirOf('session-a'), readdirSync(dirOf('session-a')).find(name => name.endsWith('.zstd')))
  writeFileSync(log, readFileSync(log).subarray(0, -1))
  writeFileSync(join(dirOf('session-c'), 'extra.bin'), 'x')
  const rewritten = treeHashes(home)
  const check = await workspaceMoveUndoCheck({ home, moveId })
  assert.deepEqual([check.undoable, check.reason, check.sessions], [false, 'changed-since-move', ['session-a', 'session-c']])
  await assert.rejects(undoWorkspaceMove({ home, moveId, appRunning: NOT_RUNNING }), { code: 'changed-since-move' })
  assert.deepEqual(treeHashes(home), rewritten)
})

test('预览之后数据变了（又归档了一个会话）：搬的时候拒绝，要求重新预览，什么都不改', { skip: NEEDS_APP }, async () => {
  const { home, work, id } = await setup()
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  seedHome(home, { archived: ['session-a'] })
  const changed = treeHashes(home)
  await assert.rejects(applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING }), /stale-plan/)
  assert.deepEqual(treeHashes(home), changed)
})

for (const compact of [true, false]) test(`合并文件夹设置后目标组不会引用自己（省略空数组：${compact}）`, { skip: NEEDS_APP }, async () => {
  const { home, data, old, work, id, workId } = await setup({ mergeTarget: true })
  const path = join(data, 'workspace-folders.json')
  await writeFile(path, JSON.stringify({ version: 1, workspaces: {
    [id]: { externals: [old], ...compact ? {} : { writableSubfolders: [] } },
    [workId]: { writableSubfolders: [id], ...compact ? {} : { externals: [] } },
  } }))
  const plan = await planWorkspaceMove({ home, workspaceId: id, targetPath: work, appRunning: NOT_RUNNING })
  await applyWorkspaceMove({ home, plan, appRunning: NOT_RUNNING })
  assert.deepEqual(createFoldersStore(data).read(), { [workId]: { externals: [old], writableSubfolders: [] } })
})

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTrustStore } from '../lib/workspace-trust-store.js'
import { pendingWorkspaceMoves, recoverWorkspaceMove } from '../lib/workspace-move.js'
import { appCheck, NEEDS_APP, seedHome, treeHashes } from './helpers/dsh-app.mjs'
import { committedSessions, crashMove, done, MOVES, NOT_RUNNING, setup } from './helpers/workspace-move-fixture.mjs'

const REGISTRY = join('storages', 'workspace.json')
const sessionDirs = home => readdirSync(join(home, 'sessions')).sort()
const groupsOf = home => Object.fromEntries(appCheck(home).workspaces.map(item => [item.path, item.sessionIds]))
const withoutRegistry = ({ [REGISTRY]: registry, ...rest }) => rest

for (const [crashAt, when] of [['log-write:2', '写第 2 个会话日志时'], ['commit-rename:4', '提交到一半：第 2 个会话的旧目录已挪走、新目录还没挪进来']]) {
  test(`小进程半路被结束（${when}）：App 照样能启动、不会有两份会话；下次打开能倒回原样`, { skip: NEEDS_APP }, async () => {
    const fixture = await setup()
    const before = treeHashes(fixture.home, MOVES)
    const dirs = sessionDirs(fixture.home)
    const pending = await crashMove(fixture, crashAt)
    const report = appCheck(fixture.home)
    assert.equal(report.ok, true, report.error)
    await recoverWorkspaceMove({ home: fixture.home, moveId: pending.moveId, appRunning: NOT_RUNNING })
    assert.deepEqual(treeHashes(fixture.home, MOVES), before)
    assert.deepEqual(sessionDirs(fixture.home), dirs)
    assert.deepEqual(await pendingWorkspaceMoves(fixture.home), [])
  })
}

test('小进程半路被结束后，App 开着时改过登记表里别的组：倒回照样成功，只比这次迁移动过的东西', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const before = treeHashes(fixture.home, MOVES)
  const pending = await crashMove(fixture, 'commit-rename:4')
  seedHome(fixture.home, { pinned: ['session-o'] })
  assert.notEqual(treeHashes(fixture.home, MOVES)[REGISTRY], before[REGISTRY])
  await recoverWorkspaceMove({ home: fixture.home, moveId: pending.moveId, appRunning: NOT_RUNNING })
  assert.deepEqual(withoutRegistry(treeHashes(fixture.home, MOVES)), withoutRegistry(before))
  assert.deepEqual(groupsOf(fixture.home)[fixture.old], ['session-c', 'session-b', 'session-a'])
  assert.deepEqual(await pendingWorkspaceMoves(fixture.home), [])
})

test('小进程半路被结束后，搬过去的会话在新位置又追加过：倒回时新写的内容跟着回到原位置', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const pending = await crashMove(fixture, 'commit-rename:4')
  const [moved] = committedSessions(fixture.home, pending.moveId)
  const events = appCheck(fixture.home).sessions[moved].events
  // 接着上一轮写下一轮（session-b 已经有第 2 轮）：轮次接不上的日志 App 会判为损坏
  seedHome(fixture.home, { appends: [{ id: moved, events: done(moved === 'session-b' ? 3 : 2) }] })
  await recoverWorkspaceMove({ home: fixture.home, moveId: pending.moveId, appRunning: NOT_RUNNING })
  const report = appCheck(fixture.home)
  assert.equal(report.ok, true, report.error)
  assert.equal(report.sessions[moved].events, events + 2)
  assert.deepEqual(groupsOf(fixture.home)[fixture.old], ['session-c', 'session-b', 'session-a'])
  assert.deepEqual(await pendingWorkspaceMoves(fixture.home), [])
})

test('小进程半路被结束后，搬过去的会话日志被改写过：拒绝倒回，什么都不动', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const pending = await crashMove(fixture, 'commit-rename:4')
  const [moved] = committedSessions(fixture.home, pending.moveId)
  const dir = readdirSync(join(fixture.home, 'sessions')).map(name => join(fixture.home, 'sessions', name, moved)).find(path => existsSync(path))
  const log = join(dir, readdirSync(dir).find(name => name.endsWith('.zstd')))
  writeFileSync(log, readFileSync(log).subarray(0, -1))
  const halfway = treeHashes(fixture.home)
  await assert.rejects(recoverWorkspaceMove({ home: fixture.home, moveId: pending.moveId, appRunning: NOT_RUNNING }), { code: 'changed-since-move' })
  assert.deepEqual(treeHashes(fixture.home), halfway)
  assert.deepEqual((await pendingWorkspaceMoves(fixture.home)).map(item => item.moveId), [pending.moveId])
})

test('小进程半路被结束后，迁移涉及的工作区信任又被撤销了：拒绝倒回，不用备份盖掉新改动', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const pending = await crashMove(fixture, 'registry-write:1')
  createTrustStore(fixture.data).revoke(fixture.work)
  const halfway = treeHashes(fixture.home)
  await assert.rejects(recoverWorkspaceMove({ home: fixture.home, moveId: pending.moveId, appRunning: NOT_RUNNING }), { code: 'changed-since-move' })
  assert.deepEqual(treeHashes(fixture.home), halfway)
})

test('登记表写入时中断：倒回后保留另一个工作区新加的信任', { skip: NEEDS_APP }, async () => {
  const fixture = await setup()
  const pending = await crashMove(fixture, 'registry-write:1')
  const trust = createTrustStore(fixture.data)
  trust.trust(fixture.other)
  await recoverWorkspaceMove({ home: fixture.home, moveId: pending.moveId, appRunning: NOT_RUNNING })
  assert.deepEqual([fixture.old, fixture.work, fixture.other].map(path => trust.isTrusted(path)), [true, false, true])
})

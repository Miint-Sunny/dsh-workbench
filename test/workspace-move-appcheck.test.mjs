import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appCheck, NEEDS_APP, seedHome, treeHashes } from './helpers/dsh-app.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

const T0 = 1_700_000_000_000

test('App 代码核对：报出各组的会话、每个会话的事件数和继承数，能以写方式打开，不改任何文件', { skip: NEEDS_APP }, async () => {
  const home = await tempDir('dwb-appcheck-')
  const { folders } = seedHome(home, {
    folders: ['Documents/old'],
    sessions: [
      { id: 'session-s1', folder: 'Documents/old', createdAt: T0, events: [['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: 'completed' }]] },
      { id: 'session-s2', folder: 'Documents/old', createdAt: T0 + 10, parent: 'session-s1', inherit: 2, events: [['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: 'completed' }], ['session/end-seed', { inherited: true }], ['turn/start', { turn: 2 }]] },
      { id: 'sub-1', folder: 'Documents/old', createdAt: T0 + 20, parent: 'session-s1', origin: 'subagent', depth: 1, events: [['turn/start', { turn: 1 }]] },
    ],
    workspaces: [{ folder: 'Documents/old', sessions: ['session-s2', 'session-s1'] }],
  })
  const before = treeHashes(home)
  const report = appCheck(home)
  assert.equal(report.ok, true, report.error)
  assert.deepEqual(report.workspaces.map(({ title, path, sessionIds }) => ({ title, path, sessionIds })),
    [{ title: 'old', path: folders['Documents/old'], sessionIds: ['session-s2', 'session-s1'] }])
  assert.equal(report.listed, 3)
  assert.deepEqual(Object.fromEntries(Object.entries(report.sessions).map(([id, s]) => [id, [s.events, s.inherited, s.cwd]])), {
    'session-s1': [2, 0, folders['Documents/old']],
    'session-s2': [4, 2, folders['Documents/old']],
    'sub-1': [1, 0, folders['Documents/old']],
  })
  assert.deepEqual(report.writeOpen, { 'session-s1': 'ok', 'session-s2': 'ok', 'sub-1': 'ok' })
  assert.deepEqual(treeHashes(home), before)
})

test('App 代码核对：同一个会话出现在两个项目目录时报不通过，并带上 App 的原话', { skip: NEEDS_APP }, async () => {
  const home = await tempDir('dwb-appcheck-dup-')
  seedHome(home, {
    folders: ['Documents/old'],
    sessions: [{ id: 'session-s1', folder: 'Documents/old', createdAt: T0, events: [['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: 'completed' }]] }],
    workspaces: [{ folder: 'Documents/old', sessions: ['session-s1'] }],
  })
  const { cpSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const [project] = readdirSync(join(home, 'sessions'))
  cpSync(join(home, 'sessions', project, 'session-s1'), join(home, 'sessions', '--elsewhere--', 'session-s1'), { recursive: true })
  const report = appCheck(home)
  assert.equal(report.ok, false)
  assert.match(report.error, /session log|duplicate/)
})

test('App 核对目标分组、会话位置，并保留归档、置顶与其他会话', async () => {
  const { compareAppChecks } = await import('../lib/workspace-move-check.js')
  const session = { events: 2, digest: 'abc', inherited: 0, cwd: '/old' }
  const before = {
    ok: true, listed: 2, sessions: { a: session, b: { ...session, cwd: '/other' } }, archived: ['b'], pinned: ['a'],
    workspaces: [{ id: 'w1', title: 'old', path: '/old', sessionIds: ['a'] }, { id: 'w2', title: 'other', path: '/other', sessionIds: ['b'] }],
  }
  const expected = structuredClone(before)
  expected.sessions.a.cwd = '/new'
  Object.assign(expected.workspaces[0], { path: '/new', title: 'new' })
  const plan = { source: { workspaceId: 'w1' }, result: { workspaceId: 'w1', title: 'new', path: '/new', sessionIds: ['a'] } }
  assert.equal(compareAppChecks(before, expected, ['a'], plan), undefined)
  for (const change of [
    report => { report.workspaces[0].sessionIds = [] },
    report => { report.sessions.a.cwd = '/old' },
    report => { report.archived = [] },
    report => { report.pinned = [] },
    report => { delete report.sessions.b; report.listed = 1 },
    report => { report.workspaces[1].sessionIds = [] },
  ]) {
    const after = structuredClone(expected)
    change(after)
    assert.equal(typeof compareAppChecks(before, after, ['a'], plan), 'string')
  }
})

test('App 核对完整输出大型报告，模块目录可包含 #', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const home = await tempDir('dwb-big-report-')
  const appcheck = fileURLToPath(new URL('../lib/workspace-move-appcheck.mjs', import.meta.url))
  const context = `export class Context {
    plugin() {}
    get() { return { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] } }
    sessionPersistence = {
      list: () => Array.from({ length: 6000 }, (_, i) => ({ header: { id: 's' + i } })),
      open: () => ({ header: { cwd: '/fixture' }, inheritedEventCount: 0, read: () => ({ events: [] }), close() {} })
    }
  }`
  for (const name of ['plain', 'suite #2']) {
    const modules = join(home, name)
    for (const pkg of ['cordis', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-session-persistence-jsonl', 'dsh-workspace']) {
      const lib = join(modules, pkg, 'lib')
      mkdirSync(lib, { recursive: true })
      writeFileSync(join(lib, 'index.js'), pkg === 'cordis' ? context : 'export function apply() {}')
    }
    const { stdout } = await promisify(execFile)(process.execPath, [appcheck], { env: { ...process.env, DWB_MOVE_HOME: home, DWB_APP_MODULES: modules }, maxBuffer: 4 * 1024 * 1024 })
    assert.ok(stdout.endsWith('}'), '核对报告未完整写出')
    const report = JSON.parse(stdout)
    assert.equal(report.ok, true, report.error)
    assert.equal(Object.keys(report.sessions).length, 6000)
  }
})

test('核对进程声称成功但缺少会话或工作区记录时，按核对失败处理', async () => {
  const { chmodSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { runAppCheck } = await import('../lib/workspace-move-check.js')
  const home = await tempDir('dwb-check-report-')
  const binary = join(home, 'checker')
  writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, listed: 1, sessions: { a: null }, workspaces: [null], pinned: [], archived: [] }))
`)
  chmodSync(binary, 0o700)
  const report = await runAppCheck({ home, appBinary: binary })
  assert.equal(report.ok, false)
  assert.equal(typeof report.error, 'string')
})

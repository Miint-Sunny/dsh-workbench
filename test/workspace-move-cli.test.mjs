import { undoTree } from './helpers/workspace-move-fixture.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { emptyWorkspace } from './helpers/workspace-move-empty.mjs'
import { join } from 'node:path'
import { test } from 'node:test'
import { NEEDS_APP, seedHome, treeHashes } from './helpers/dsh-app.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

const CLI = new URL('../scripts/workspace-move.mjs', import.meta.url).pathname
const T0 = 1_700_000_000_000
const MOVES = rel => rel.startsWith(join('dsh-workbench', 'workspace-moves'))
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000 })

test('命令行：预览出 JSON；不带 --yes 不动手；搬完用 App 的代码核对；撤回后回到原样', { skip: NEEDS_APP }, async () => {
  const home = await tempDir('dwb-move-cli-')
  const { folders } = seedHome(home, {
    folders: ['Documents/old', 'Documents/work'],
    sessions: [{ id: 'session-a', folder: 'Documents/old', createdAt: T0, events: [['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: 'completed' }]] }],
    workspaces: [{ folder: 'Documents/old', sessions: ['session-a'] }],
  })
  const from = folders['Documents/old']
  const to = folders['Documents/work']
  const before = treeHashes(home, MOVES)
  const id = Object.keys(JSON.parse(await readFile(join(home, 'storages', 'workspace.json'))).tables.workspaces)[0]
  const expected = undoTree(home, id)

  const plan = run('plan', '--home', home, '--from', from, '--to', to, '--json')
  assert.equal(plan.status, 0, plan.stderr)
  assert.deepEqual(JSON.parse(plan.stdout).sessions.map(item => item.id), ['session-a'])

  const refused = run('apply', '--home', home, '--from', from, '--to', to)
  assert.equal(refused.status, 2, refused.stderr)
  assert.deepEqual(treeHashes(home, MOVES), before)

  const applied = run('apply', '--home', home, '--from', from, '--to', to, '--yes')
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  assert.match(applied.stdout, /App 核对通过/)
  const moveId = /moveId: (\S+)/.exec(applied.stdout)?.[1]
  assert.ok(moveId, applied.stdout)

  const undone = run('undo', '--home', home, '--move', moveId, '--yes')
  assert.equal(undone.status, 0, undone.stderr + undone.stdout)
  assert.deepEqual(undoTree(home, id), expected)
})

test('命令行核对发现 App 仍显示原工作区时自动撤销', { skip: process.platform === 'win32' }, async () => {
  const { home, old, work, id } = await emptyWorkspace()
  const app = join(home, 'test.app')
  const bin = join(app, 'Contents/MacOS')
  await mkdir(bin, { recursive: true })
  const report = { ok: true, sessions: {}, listed: 0, archived: [], pinned: [], workspaces: [{ id, title: '旧文件夹', path: old, sessionIds: [] }], writeOpen: {} }
  await writeFile(join(bin, 'DeepSeek Harness'), '#!/bin/sh\ncat "$DWB_MOVE_HOME/report.json"\n', { mode: 0o700 })
  await writeFile(join(home, 'report.json'), JSON.stringify(report))
  const before = treeHashes(home, MOVES)
  const applied = spawnSync(process.execPath, [CLI, 'apply', '--home', home, '--from', id, '--to', work, '--yes'], {
    encoding: 'utf8', env: { ...process.env, DSH_APP: app },
  })
  assert.equal(applied.status, 1, applied.stdout + applied.stderr)
  assert.match(applied.stdout, /已自动撤回/)
  assert.deepEqual(treeHashes(home, MOVES), before)
})

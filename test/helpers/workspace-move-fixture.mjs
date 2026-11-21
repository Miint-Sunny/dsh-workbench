/**
 * 会话迁移测试共用的场景：old 组三个会话（b 是 a 的分叉，c 已归档）加 a 的一个子代理会话，other 组一个不相干的会话；
 * 再用工作台自己的存储写上旧位置的检查点、记忆和信任。用 App 自己的代码造（dsh-app-seed.mjs），没有 App 时用到它的测试应当跳过。
 * 另有 crashMove：搬到一半直接结束执行搬迁的进程，留下做到一半的迁移。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { createCheckpointsStore } from '../../lib/checkpoints-store.js'
import { createMemoryStore } from '../../lib/memory-store.js'
import { pendingWorkspaceMoves } from '../../lib/workspace-move.js'
import { createTrustStore } from '../../lib/workspace-trust-store.js'
import { seedHome, treeHashes } from './dsh-app.mjs'
import { tempDir } from './temp-dir.mjs'

const CRASH_CHILD = new URL('./workspace-move-crash-child.mjs', import.meta.url).pathname

export const T0 = 1_700_000_000_000
export const done = turn => [['turn/start', { turn }], ['turn/end', { turn, reason: 'completed' }]]
export const NOT_RUNNING = () => false
/** 迁移记录（备份、日志）在 dsh-workbench/workspace-moves 下，「和搬之前一样」不比它。 */
export const MOVES = rel => rel.startsWith(join('dsh-workbench', 'workspace-moves'))
export const MEMORY = data => createMemoryStore({ root: join(data, 'memory'), maxBytes: 16_384 })

/** 普通撤销会更新被搬工作区的 updatedAt，其余登记字段和文件都参与比对。 */
export function undoTree(home, id) {
  const path = join('storages', 'workspace.json')
  const registry = JSON.parse(readFileSync(join(home, path)))
  delete registry.tables.workspaces[id].updatedAt
  return { ...treeHashes(home, MOVES), [path]: JSON.stringify(registry) }
}

/** old 组三个会话（b 是 a 的分叉，c 已归档）加 a 的一个子代理会话；other 组一个会话不相干。 */
export function scenario({ mergeTarget = false, openTurn = false } = {}) {
  return {
    folders: ['Documents/old', 'Documents/work', 'Documents/other'],
    sessions: [
      { id: 'session-a', folder: 'Documents/old', createdAt: T0, events: openTurn ? [...done(1), ['turn/start', { turn: 2 }]] : done(1) },
      { id: 'session-b', folder: 'Documents/old', createdAt: T0 + 10, parent: 'session-a', inherit: 2, events: [...done(1), ['session/end-seed', { inherited: true }], ...done(2)] },
      { id: 'session-c', folder: 'Documents/old', createdAt: T0 + 20, events: done(1) },
      { id: 'sub-1', folder: 'Documents/old', createdAt: T0 + 30, parent: 'session-a', origin: 'subagent', depth: 1, events: done(1) },
      { id: 'session-o', folder: 'Documents/other', createdAt: T0 + 5, events: done(1) },
      ...mergeTarget ? [{ id: 'session-w', folder: 'Documents/work', createdAt: T0 + 15, events: done(1) }] : [],
    ],
    workspaces: [
      { folder: 'Documents/old', sessions: ['session-c', 'session-b', 'session-a'] },
      { folder: 'Documents/other', sessions: ['session-o'] },
      ...mergeTarget ? [{ folder: 'Documents/work', sessions: ['session-w'] }] : [],
    ],
    archived: ['session-c'],
    pinned: ['session-b'],
  }
}

/** 造好 DSH_HOME，再用工作台自己的存储写上旧位置的检查点、记忆和信任。 */
export async function setup(options) {
  const home = await tempDir('dwb-move-')
  const { folders } = seedHome(home, scenario(options))
  const old = folders['Documents/old']
  const data = join(home, 'dsh-workbench')
  const checkpoints = createCheckpointsStore(join(data, 'checkpoints'))
  await checkpoints.writeMeta('session-a', { cwd: old, root: old, kind: 'files' })
  await checkpoints.appendEntry('session-a', { turn: 1, seq: 0, time: T0, kind: 'files', root: old, captures: {} })
  await MEMORY(data).write(old, { content: '记住：课程笔记在这个文件夹里', revision: 'empty' })
  createTrustStore(data).trust(old)
  const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
  const idOf = path => Object.entries(registry.tables.workspaces).find(([, item]) => item.path === path)?.[0]
  return { home, data, old, work: folders['Documents/work'], other: folders['Documents/other'], id: idOf(old), workId: idOf(folders['Documents/work']) }
}

/**
 * 照 setup 造的场景搬，到 crashAt 那一步直接结束执行搬迁的进程（写法见 workspace-move-crash-child.mjs）。
 * @param {{ home: string, id: string, work: string }} fixture setup 的结果。
 * @param {string} crashAt 在哪一步结束，比如 commit-rename:4。
 * @returns {Promise<object>} 留下的那条迁移记录（pendingWorkspaceMoves 的一项）。
 */
export async function crashMove({ home, id, work }, crashAt) {
  const child = spawnSync(process.execPath, [CRASH_CHILD], {
    encoding: 'utf8',
    env: { ...process.env, DWB_HOME: home, DWB_WORKSPACE: id, DWB_TARGET: work, DWB_CRASH_AT: crashAt },
  })
  if (child.status !== 70) throw new Error(`执行搬迁的进程没有在 ${crashAt} 结束：退出码 ${child.status}，${child.stderr}`)
  const pending = await pendingWorkspaceMoves(home)
  if (pending.length !== 1 || pending[0].status !== 'applying') throw new Error(`应当留下一条 applying 的迁移记录：${JSON.stringify(pending)}`)
  return pending[0]
}

/**
 * 做到一半的迁移里，已经从暂存挪到新位置的会话目录名。
 * @param {string} home DSH_HOME。
 * @param {string} moveId 迁移记录。
 * @returns {string[]} 目录名。
 */
export function committedSessions(home, moveId) {
  const journal = JSON.parse(readFileSync(join(home, 'dsh-workbench', 'workspace-moves', moveId, 'journal.json'), 'utf8'))
  return journal.entries.filter(entry => entry.op === 'move' && entry.from.includes(`${sep}staging${sep}`) && existsSync(entry.to)).map(entry => basename(entry.to))
}

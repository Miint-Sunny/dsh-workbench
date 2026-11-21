/**
 * 测试夹具：在 App 自带的 Electron 里用官方的会话存储和工作区登记表造一个 DSH_HOME。
 * 环境变量 DWB_SEED_HOME 是 DSH_HOME，DWB_SEED_SPEC 是场景（JSON）：
 *   folders: ["Documents/old", ...]                       建出来的文件夹（相对 DSH_HOME）
 *   sessions: [{ id, folder, createdAt, events: [[type, data], ...],
 *                parent?, inherit?, origin?, depth? }]   会话；cwd 是 folder 的真实路径。分叉会话（有 parent、
 *                                                       没有 origin）的 events 里要自己写上继承部分之后那条
 *                                                       ['session/end-seed', { inherited: true }]，inherit 是继承的事件数
 *   workspaces: [{ folder, sessions: [id, ...] }]         按 sessions 的顺序显示
 *   archived: [id, ...], pinned: [id, ...]
 *   appends: [{ id, events: [[type, data], ...] }]       在已有会话后面接着写（以写方式打开再追加）
 * 输出 { folders: { "Documents/old": 真实路径 } }。
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const R = join(dirname(process.execPath), '../Resources/app.asar/dsh/node_modules/@deepseek-ai')
const load = async (name) => {
  const module = await import(join(R, name, 'lib/index.js'))
  return typeof module.apply === 'function' ? module : module.default
}
const home = process.env.DWB_SEED_HOME
const spec = JSON.parse(process.env.DWB_SEED_SPEC)

const { Context } = await import(join(R, 'cordis/lib/index.js'))
const ctx = new Context()
await ctx.plugin(await load('dsh-storage'), {})
await ctx.plugin(await load('dsh-storage-json'), { root: join(home, 'storages') })
await ctx.plugin(await load('dsh-storage-domain'), { backend: 'json' })
await ctx.plugin(await load('dsh-session-persistence-jsonl'), { root: join(home, 'sessions') })
await ctx.plugin(await load('dsh-workspace'), {})

const folders = {}
for (const folder of spec.folders ?? []) {
  mkdirSync(join(home, folder), { recursive: true })
  folders[folder] = realpathSync(join(home, folder))
}
for (const session of spec.sessions ?? []) {
  const header = {
    version: 4,
    id: session.id,
    createdAt: session.createdAt,
    cwd: folders[session.folder],
    isSeeded: session.parent !== undefined && session.origin === undefined,
    delegationDepth: session.depth ?? 0,
    ...session.parent === undefined ? {} : { parentSession: session.parent },
    ...session.origin === undefined ? {} : { origin: session.origin },
  }
  const handle = await ctx.sessionPersistence.create(header, session.inherit === undefined ? {} : { inheritedEventCount: session.inherit })
  const events = (session.events ?? []).map(([type, data], seq) => ({ type, seq, time: session.createdAt + seq, data }))
  if (events.length > 0) await handle.append(events)
  await handle.flush()
  await handle.close()
}
for (const workspace of spec.workspaces ?? []) {
  const entity = await ctx.workspaceRegistry.create(folders[workspace.folder])
  for (const id of [...workspace.sessions].reverse()) await entity.attachSession(id)
}
for (const { id, events } of spec.appends ?? []) {
  const handle = await ctx.sessionPersistence.open(id, 'write')
  const { events: existing } = await handle.read()
  const next = existing.length
  const time = existing.at(-1)?.time ?? Date.now()
  await handle.append(events.map(([type, data], index) => ({ type, seq: next + index, time: time + index + 1, data })))
  await handle.flush()
  await handle.close()
}
for (const id of spec.archived ?? []) await ctx.workspaceRegistry.archiveSession(id)
for (const id of spec.pinned ?? []) await ctx.workspaceRegistry.pinSession(id)
await ctx.fiber?.dispose?.()
process.stdout.write(JSON.stringify({ folders }))
process.exit(0)

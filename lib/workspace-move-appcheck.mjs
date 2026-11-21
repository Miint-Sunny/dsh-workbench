/**
 * 会话迁移（feat#187）的 App 代码核对。在 DSH App 自带的 Electron 里运行（ELECTRON_RUN_AS_NODE=1，
 * 用 App 的可执行文件跑本文件），用 app.asar 里官方的存储、会话存储和工作区登记表把环境变量
 * DWB_MOVE_HOME 指定的 DSH_HOME 启动一遍，报出 App 启动后看到的东西：
 * 各组的会话（登记表按会话头 cwd 筛过的）、归档和置顶、会话总数，以及每个会话按 App 的读法得到的
 * 事件数、事件内容的 SHA-256、继承事件数，和能不能以写方式打开（拿一次写锁再放掉）。
 * 只读：不建会话、不改登记表。App 正在运行时不要用：两边会抢写锁。
 * 输出一行 JSON：{ ok, error?, workspaces, archived, pinned, listed, sessions, writeOpen }。
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const modules = process.env.DWB_APP_MODULES ?? join(dirname(process.execPath), '../Resources/app.asar/dsh/node_modules/@deepseek-ai')
const load = async (name) => {
  const module = await import(pathToFileURL(join(modules, name, 'lib/index.js')))
  return typeof module.apply === 'function' ? module : module.default
}
const message = error => (error instanceof Error ? error.message : String(error))

async function check(home) {
  const { Context } = await import(pathToFileURL(join(modules, 'cordis/lib/index.js')))
  const ctx = new Context()
  try {
    await ctx.plugin(await load('dsh-storage'), {})
    await ctx.plugin(await load('dsh-storage-json'), { root: join(home, 'storages') })
    await ctx.plugin(await load('dsh-storage-domain'), { backend: 'json' })
    await ctx.plugin(await load('dsh-session-persistence-jsonl'), { root: join(home, 'sessions') })
    let listed
    try {
      listed = await ctx.sessionPersistence.list()
    } catch (error) {
      return { ok: false, error: message(error) }
    }
    await ctx.plugin(await load('dsh-workspace'), {})
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return { ok: false, error: 'workspace registry did not start' }
    const sessions = {}
    const writeOpen = {}
    for (const { header } of listed) {
      const reader = await ctx.sessionPersistence.open(header.id, 'read')
      try {
        const { events } = await reader.read()
        sessions[header.id] = {
          cwd: reader.header.cwd,
          events: events.length,
          inherited: Number(reader.inheritedEventCount),
          digest: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
        }
      } finally {
        await reader.close()
      }
      try {
        const writer = await ctx.sessionPersistence.open(header.id, 'write')
        await writer.close()
        writeOpen[header.id] = 'ok'
      } catch (error) {
        writeOpen[header.id] = message(error)
      }
    }
    return {
      ok: Object.values(writeOpen).every(result => result === 'ok'),
      workspaces: registry.list().map(item => ({ id: item.id, title: item.title, path: item.path, sessionIds: [...item.sessionIds] })),
      archived: [...registry.archivedSessionIds],
      pinned: [...registry.pinnedSessionIds],
      listed: listed.length,
      sessions,
      writeOpen,
    }
  } catch (error) {
    return { ok: false, error: message(error) }
  } finally {
    await ctx.fiber?.dispose?.()
  }
}

const home = process.env.DWB_MOVE_HOME
const report = home ? await check(home) : { ok: false, error: 'DWB_MOVE_HOME is not set' }
await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(report), error => error ? reject(error) : resolve()))
process.exit(0)

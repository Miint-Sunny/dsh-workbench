/**
 * 会话迁移（feat#187）的 App 核对：在 App 的 Electron 里运行 workspace-move-appcheck.mjs，
 * 比较搬前搬后两次报告。命令行和小进程共用。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const APPCHECK = fileURLToPath(new URL('./workspace-move-appcheck.mjs', import.meta.url))

/**
 * 用 App 自己的代码把一个 DSH_HOME 启动一遍（只读）。
 * @param {{ home: string, appBinary?: string | null }} options DSH_HOME 和 App 的可执行文件。
 * @returns {Promise<object | undefined>} 核对报告。没有 App 时返回 undefined，执行或读取报告失败时返回失败原因。
 */
export async function runAppCheck({ home, appBinary }) {
  if (!appBinary || !existsSync(appBinary)) return undefined
  try {
    const { stdout } = await execFileAsync(appBinary, [APPCHECK], {
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DWB_MOVE_HOME: home },
    })
    const report = JSON.parse(stdout)
    if (report?.ok === false) return report
    const sessions = Object.entries(report?.sessions ?? {})
    if (report?.ok !== true || report.listed !== sessions.length || !report.sessions || !report.writeOpen
      || !sessions.every(([id, data]) => typeof data?.digest === 'string' && Number.isInteger(data.events)
        && Number.isInteger(data.inherited) && report.writeOpen[id] === 'ok')
      || !Array.isArray(report.workspaces) || !report.workspaces.every(group => typeof group?.id === 'string' && typeof group.path === 'string' && Array.isArray(group.sessionIds))
      || !Array.isArray(report.archived) || !Array.isArray(report.pinned)) return { ok: false, error: 'App 核对报告不完整。' }
    return report
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * 比较 App 读到的事件、工作区登记和会话位置。
 * @param {object} before 搬前的报告。
 * @param {object | undefined} after 搬后的报告。
 * @param {string[]} ids 被搬的会话。
 * @param {object} [plan] 预览中的工作区和会话顺序。
 * @returns {string | undefined} 核对失败的原因。
 */
export function compareAppChecks(before, after, ids, plan) {
  if (!after?.ok) return `App 读不了搬后的数据：${after?.error ?? JSON.stringify(after?.writeOpen) ?? '没有核对报告'}`
  for (const id of ids) {
    const a = before.sessions[id]
    const b = after.sessions[id]
    if (a === undefined || b === undefined || a.events !== b.events || a.digest !== b.digest || a.inherited !== b.inherited) return `会话 ${id} 搬后按 App 的读法和搬前不一样`
  }
  if (!plan) return undefined
  const moved = new Set(ids)
  if (before.listed !== after.listed || !isDeepStrictEqual(Object.keys(before.sessions).sort(), Object.keys(after.sessions).sort())) return 'App 列出的会话有变化。'
  for (const [id, session] of Object.entries(before.sessions)) {
    if (moved.has(id) ? after.sessions[id].cwd !== plan.result.path : !isDeepStrictEqual(after.sessions[id], session)) return `App 读到的会话 ${id} 和预览不符。`
  }
  if (!isDeepStrictEqual([...before.archived].sort(), [...after.archived].sort())
    || !isDeepStrictEqual([...before.pinned].sort(), [...after.pinned].sort())) return 'App 读到的置顶或归档会话有变化。'

  const { workspaceId, title, path, sessionIds } = plan.result
  const visible = new Set([...ids, ...(before.workspaces.find(item => item.id === workspaceId)?.sessionIds ?? [])])
  const expected = before.workspaces.flatMap(group => {
    if (group.id === workspaceId) return [{ id: workspaceId, title, path, sessionIds: sessionIds.filter(id => visible.has(id)) }]
    return group.id === plan.source.workspaceId ? [] : [group]
  })
  if (!isDeepStrictEqual(after.workspaces, expected)) return 'App 读到的工作区、文件夹或会话顺序和预览不符。'
  return undefined
}

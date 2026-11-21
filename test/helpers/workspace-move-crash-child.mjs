/**
 * 测试夹具：照预览搬，到 DWB_CRASH_AT 指定的那一步直接退出进程（模拟小进程被结束），不做任何收尾。
 * DWB_CRASH_AT 写成「log-write:N」（第 N 次写会话日志之前）、「commit-rename:N」（第 N 次在会话根目录里改名之前）
 * 或「registry-write:N」（第 N 次写登记表的临时文件之前，这时工作台的文件已经改完）。
 */
import { rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { applyWorkspaceMove, planWorkspaceMove } from '../../lib/workspace-move.js'

const { DWB_HOME: home, DWB_WORKSPACE: workspaceId, DWB_TARGET: targetPath, DWB_CRASH_AT: crashAt } = process.env
const [kind, count] = crashAt.split(':')
const sessionsRoot = join(home, 'sessions')
let seen = 0
const io = {
  writeFile: async (path, data, options) => {
    if (kind === 'log-write' && path.includes('.jsonl') && ++seen === Number(count)) process.exit(70)
    if (kind === 'registry-write' && basename(path).startsWith('.workspace.json.') && ++seen === Number(count)) process.exit(70)
    return writeFile(path, data, options)
  },
  rename: async (from, to) => {
    if (kind === 'commit-rename' && (from.startsWith(sessionsRoot) || to.startsWith(sessionsRoot)) && ++seen === Number(count)) process.exit(70)
    return rename(from, to)
  },
}
const plan = await planWorkspaceMove({ home, workspaceId, targetPath, appRunning: () => false })
await applyWorkspaceMove({ home, plan, appRunning: () => false, io })
process.exit(0)

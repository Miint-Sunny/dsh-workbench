/**
 * 测试夹具：扮演 DSH 宿主。起会话迁移的小进程（等的就是自己这个进程），打出请求目录，然后一直活着，
 * 等测试把它连同进程组用 SIGINT 结束（就像在终端里按 Ctrl-C 结束 web DSH）。
 */
import { readFileSync } from 'node:fs'
import { startWorkspaceMoveHelper } from '../../lib/workspace-move-launch.js'

const { DWB_HOME: home, DWB_PLAN: planFile, DWB_APP_BINARY: appBinary } = process.env
const { dir } = await startWorkspaceMoveHelper({
  home,
  plan: JSON.parse(readFileSync(planFile, 'utf8')),
  wait: { pids: [process.pid], timeoutMs: 30_000 },
  quit: { kind: 'none' },
  relaunch: { kind: 'none' },
  appBinary,
})
process.stdout.write(`dir: ${dir}\n`)
setTimeout(() => {}, 120_000)

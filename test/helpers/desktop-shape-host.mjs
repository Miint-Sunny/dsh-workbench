/**
 * 测试夹具：扮演桌面宿主（dsh-desktop-host lib/index.js 的 stop：收到 IPC shutdown 就断开 IPC、process.exit()）。
 * 起会话迁移的小进程时等自己和父进程（App 主进程）都退出。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startWorkspaceMoveHelper } from '../../lib/workspace-move-launch.js'

const { DWB_HOME: home, DWB_PLAN: planFile, DWB_APP_BINARY: appBinary } = process.env
process.on('message', (message) => {
  if (message.type !== 'shutdown') return
  process.disconnect()
  process.exit()
})
const { dir } = await startWorkspaceMoveHelper({
  home,
  plan: JSON.parse(readFileSync(planFile, 'utf8')),
  wait: { pids: [process.pid, process.ppid], desktopTree: true, timeoutMs: 30_000 },
  quit: { kind: 'none' },
  relaunch: { kind: 'none' },
  appBinary,
})
const status = join(dir, 'status.json')
for (const deadline = Date.now() + 10_000; ; await sleep(50)) {
  if (existsSync(status) && JSON.parse(readFileSync(status, 'utf8')).phase === 'waiting') break
  if (Date.now() >= deadline) throw new Error('小进程没有开始等桌面宿主退出')
}
process.send({ type: 'started', dir })
setTimeout(() => {}, 120_000)

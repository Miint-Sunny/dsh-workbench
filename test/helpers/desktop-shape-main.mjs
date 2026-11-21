/**
 * 测试夹具：照桌面 App 主进程起宿主的样子（app.asar lib/main.js 的 DesktopHost.start、stop）：宿主是不 detached 的
 * 子进程，标准输出、错误是管道，另有 IPC 通道。宿主起了会话迁移的小进程以后，主进程发 IPC shutdown，
 * 等宿主退出，自己再退出（就像用户退出 App）。
 */
import { spawn } from 'node:child_process'

const host = spawn(process.execPath, [new URL('./desktop-shape-host.mjs', import.meta.url).pathname], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: process.env,
})
host.stdout.on('data', () => {})
host.stderr.on('data', () => {})
host.on('message', (message) => {
  if (message.type !== 'started') return
  process.stdout.write(`dir: ${message.dir}\n`)
  host.send({ type: 'shutdown' })
})
host.on('exit', () => process.exit(0))

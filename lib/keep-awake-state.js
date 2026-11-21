/** 单个电源断言的事件驱动生命周期；宽限期是唯一的定时器。 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'

/** 校验行配置；graceMs 受 Node 单次定时器的有效范围约束。 */
export function parseKeepAwakeConfig(value = {}) {
  const { graceMs = 60_000, alsoOnBattery = false } = value
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647) throw new Error('keep-awake graceMs must be an integer between 0 and 2147483647')
  if (typeof alsoOnBattery !== 'boolean') throw new Error('keep-awake alsoOnBattery must be a boolean')
  return { graceMs, alsoOnBattery }
}

/** @returns {string[]} 绑定 Host 生命周期的 macOS caffeinate 参数。 */
export function caffeinateArgs(pid, alsoOnBattery) {
  return ['-s', ...(alsoOnBattery ? ['-i'] : []), '-w', String(pid)]
}

/** 启动一个不持有 Node 事件循环的子进程；stop 等待 OS 确认退出。 */
export async function startCaffeinate(pid, alsoOnBattery, onError) {
  const child = spawn('/usr/bin/caffeinate', caffeinateArgs(pid, alsoOnBattery), { stdio: 'ignore' })
  let stopping = false, closed = false
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true
    if (!stopping) onError(new Error(`caffeinate exited (${signal ?? code})`))
    resolve()
  }))
  child.on('error', onError)
  await once(child, 'spawn')
  child.unref()
  return { pid: child.pid, async stop() { stopping = true; if (!closed) child.kill('SIGTERM'); await exited } }
}

/**
 * 汇总独立活动键并串行启动/退出；start 失败只报告，不轮询重试。
 * @param {object} options graceMs、start、onError；schedule/cancel 供确定性时钟使用。
 * @returns {object} set、flush 和等待所有子进程退出的 dispose。
 */
export function createKeepAwake({ graceMs, start, onError, schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer }, cancel = clearTimeout }) {
  const active = new Set()
  let timer, child, wanted = false, disposed = false, queue = Promise.resolve()
  const reconcile = () => {
    queue = queue.then(async () => {
      if (!wanted && child) { const previous = child; child = undefined; await previous.stop() }
      if (wanted && !child) child = await start()
    }).catch(onError)
  }
  const cancelGrace = () => { if (timer !== undefined) { cancel(timer); timer = undefined } }
  return {
    set(key, running) {
      if (disposed || active.has(key) === running) return
      if (running) {
        active.add(key); cancelGrace(); wanted = true; reconcile()
      } else {
        active.delete(key)
        if (active.size === 0) timer = schedule(() => { timer = undefined; wanted = false; reconcile() }, graceMs)
      }
    },
    flush: () => queue,
    async dispose() { disposed = true; active.clear(); cancelGrace(); wanted = false; reconcile(); await queue },
  }
}

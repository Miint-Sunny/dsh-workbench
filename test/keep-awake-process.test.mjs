/** 只替换 OS spawn；真实 EventEmitter 证明启动完成后的 error 不会逃出事件分发。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { startCaffeinate } from '../lib/keep-awake-state.js'

function processFixture(t, start) {
  const child = new EventEmitter()
  Object.assign(child, {
    pid: 123, unref() {},
    kill() { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true },
  })
  t.mock.method(childProcess, 'spawn', () => { queueMicrotask(() => start(child)); return child })
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  syncBuiltinESMExports()
  return child
}

test('caffeinate 启动后连续 error 均报告，停止仍等待 close', async t => {
  const child = processFixture(t, child => child.emit('spawn'))
  const errors = []
  const running = await startCaffeinate(123, false, error => errors.push(error))
  try {
    const first = new Error('late process error'), second = new Error('later process error')
    assert.doesNotThrow(() => child.emit('error', first))
    assert.doesNotThrow(() => child.emit('error', second))
    assert.deepEqual(errors, [first, second])
  } finally { await running.stop() }
})

test('caffeinate 启动错误仍拒绝启动 Promise 并报告原错误', async t => {
  const failure = new Error('spawn failed'), errors = []
  processFixture(t, child => child.emit('error', failure))
  await assert.rejects(startCaffeinate(123, false, error => errors.push(error)), error => error === failure)
  assert.deepEqual(errors, [failure])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKeepAwake, parseKeepAwakeConfig, caffeinateArgs } from '../lib/keep-awake-state.js'

function rig(options = {}) {
  const pending = new Set(), processes = [], errors = []
  const service = createKeepAwake({
    graceMs: 60, ...options,
    schedule(fn, ms) { const timer = { fn, ms }; pending.add(timer); return timer },
    cancel(timer) { pending.delete(timer) },
    async start() { const child = { stopped: false, async stop() { this.stopped = true } }; processes.push(child); return child },
    onError(error) { errors.push(error.message) },
  })
  return { service, pending, processes, errors, fire() { for (const t of [...pending]) { pending.delete(t); t.fn() } } }
}

test('overlapping agents and jobs share one assertion; stopping jobs still count until settlement', async () => {
  const r = rig()
  r.service.set('agent:a', true); r.service.set('agent:child', true); r.service.set('job:x', true)
  await r.service.flush(); assert.equal(r.processes.length, 1)
  r.service.set('agent:a', false); r.service.set('agent:child', false)
  assert.equal(r.pending.size, 0)
  r.service.set('job:x', true); assert.equal(r.pending.size, 0)
  r.service.set('job:x', false); assert.equal(r.pending.size, 1)
  r.service.set('job:x', false); assert.equal(r.pending.size, 1)
  r.fire(); await r.service.flush(); assert.equal(r.processes[0].stopped, true)
  await r.service.dispose()
})

test('new work cancels grace; unloading cancels it and awaits process exit', async () => {
  const r = rig(); r.service.set('a', true); await r.service.flush()
  r.service.set('a', false); r.service.set('b', true)
  assert.equal(r.pending.size, 0); assert.equal(r.processes.length, 1)
  r.service.set('b', false); await r.service.dispose()
  assert.equal(r.pending.size, 0); assert.equal(r.processes[0].stopped, true)
  r.service.set('late', true); await r.service.flush(); assert.equal(r.processes.length, 1)
})

test('resume during process teardown starts its successor only after exit', async () => {
  let release, stops = 0, starts = 0
  const exited = new Promise(resolve => { release = resolve })
  const r = rig()
  const service = createKeepAwake({ graceMs: 0, schedule: fn => { r.pending.add(fn); return fn }, cancel: fn => r.pending.delete(fn), onError: assert.fail,
    async start() { starts++; return { stop() { stops++; return exited } } },
  })
  service.set('a', true); await service.flush(); service.set('a', false)
  for (const fn of r.pending) fn()
  await Promise.resolve(); service.set('b', true)
  assert.equal(starts, 1); release(); await service.flush(); assert.equal(starts, 2)
  await service.dispose(); assert.equal(stops, 2)
})

test('spawn failure is reported without retries or timers while active', async () => {
  const errors = []; let starts = 0
  const service = createKeepAwake({ graceMs: 50, async start() { starts++; throw new Error('ENOENT') }, onError: error => errors.push(error.message) })
  service.set('a', true); await service.flush()
  assert.deepEqual(errors, ['ENOENT']); assert.equal(starts, 1)
  await service.dispose()
})

test('configuration validates deployment choices and battery flag is explicit', () => {
  assert.deepEqual(parseKeepAwakeConfig(), { graceMs: 60_000, alsoOnBattery: false })
  assert.deepEqual(caffeinateArgs(123, false), ['-s', '-w', '123'])
  assert.deepEqual(caffeinateArgs(123, true), ['-s', '-i', '-w', '123'])
  for (const value of [{ graceMs: -1 }, { graceMs: Infinity }, { graceMs: 1.5 }, { alsoOnBattery: 1 }]) assert.throws(() => parseKeepAwakeConfig(value))
})

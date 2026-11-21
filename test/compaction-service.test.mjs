import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompactionService, createPromptSwap } from '../lib/compaction-service.js'
import { createCompactionState } from '../lib/compaction-state.js'
import { parseCompactionConfig } from '../lib/compaction-config.js'
import { OFFICIAL_HEAD } from '../lib/compaction-prompt.js'

const MIN = 60_000
const T0 = 1_800_000_000_000

/** 真的设置文件 + 假的官方服务：测调度行为，不测官方。 */
function setup({ config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-compaction-service-'))
  const clock = { now: T0, timers: new Set() }
  const agents = new Map()
  const calls = []
  const logged = []
  const host = {
    roots: () => [...agents.values()].filter(a => a.root),
    get: id => agents.get(id),
    allowed: a => a.preset !== 'whale',
    root: a => a.root,
    status: a => a.status,
    used: a => a.used,
    inbox: a => a.inbox,
    lastTurn: a => a.lastTurn,
    activity: async a => a.activity,
    measure: a => ({ total: a.used, compactable: a.compactable, nodes: a.nodes, firstIndex: 0, balancedBefore: () => true, window: 1_000_000, output: 384_000, official: 550_464 }),
    prune: a => { calls.push({ op: 'prune', id: a.id }); if (a.afterPrune !== undefined) a.used = a.afterPrune },
    compactNow: (a, signal) => { calls.push({ op: 'now', id: a.id, signal }); return a.onCompact ? a.onCompact(signal) : Promise.resolve({ shadowedTokenCount: 100_000 }) },
    compactRegion: (start, end, a, signal) => { calls.push({ op: 'region', id: a.id, start, end, signal }); return a.onRegion ? a.onRegion() : Promise.resolve({ shadowedTokenCount: 50_000 }) },
  }
  const service = createCompactionService({
    host,
    config: parseCompactionConfig(config),
    state: createCompactionState({ dir }),
    now: () => clock.now,
    schedule: (fn, ms) => { const timer = { fn, at: clock.now + ms }; clock.timers.add(timer); return timer },
    cancel: timer => clock.timers.delete(timer),
    logger: { warn: message => logged.push(message) },
  })
  const add = (id, patch = {}) => {
    const agent = { id, root: true, preset: 'standard', status: 'idle', used: 350_000, inbox: 0, activity: [], compactable: 250_000, nodes: [{ seq: 0, tokens: 100_000 }, { seq: 1, tokens: 100_000 }, { seq: 2, tokens: 100_000 }, { seq: 3, tokens: 50_000 }], lastTurn: { kind: 'completed', at: clock.now }, ...patch }
    agents.set(id, agent)
    return agent
  }
  const advance = async ms => {
    clock.now += ms
    for (const timer of [...clock.timers]) if (timer.at <= clock.now) { clock.timers.delete(timer); timer.fn() }
    await settle()
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return { service, clock, add, advance, settle, calls, logged, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const nowCalls = t => t.calls.filter(c => c.op === 'now')

test('默认都关闭：一轮结束不开定时器，也不压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.status(a, 'idle')
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').runtime.state, 'off')
  await s.advance(60 * MIN)
  assert.equal(nowCalls(s).length, 0)
})

test('这个会话开了 300K：超过就等空闲时长，到点压缩，不带命令 id', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  assert.equal(s.service.view('a').runtime.state, 'armed')
  assert.equal(s.service.view('a').runtime.dueAt, T0 + 30 * MIN)
  await s.advance(29 * MIN)
  assert.equal(nowCalls(s).length, 0)
  a.onCompact = async () => { a.used = 40_000; return { shadowedTokenCount: 310_000 } }
  await s.advance(MIN)
  assert.equal(nowCalls(s).length, 1)
  const runtime = s.service.view('a').runtime
  assert.equal(runtime.state, 'done')
  assert.equal(runtime.before, 350_000)
  assert.equal(runtime.after, 40_000)
})

test('没到阈值不开定时器，页面说没到', t => {
  const s = setup(); t.after(s.cleanup)
  s.add('a', { used: 299_999 })
  s.service.setSession('a', { idle: 300_000 })
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').runtime.state, 'below')
})

test('用户回来发消息：定时器取消，不压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.status = 'running'
  s.service.status(a, 'running')
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').runtime.state, 'running')
  await s.advance(60 * MIN)
  assert.equal(nowCalls(s).length, 0)
})

test('一轮结束时重新算：又超过就从这一轮结束算起', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.status = 'running'
  s.service.status(a, 'running')
  await s.advance(10 * MIN)
  a.status = 'idle'
  a.lastTurn = { kind: 'completed', at: s.clock.now }
  s.service.status(a, 'idle')
  assert.equal(s.service.view('a').runtime.dueAt, s.clock.now + 30 * MIN)
})

test('上一轮出错或被停止不开定时器', t => {
  const s = setup(); t.after(s.cleanup)
  s.add('a', { lastTurn: { kind: 'failed', at: T0 } })
  s.service.setSession('a', { idle: 300_000 })
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').runtime.state, 'turn-failed')
})

test('到点时后台任务在跑：这次跳过，下一轮结束再算', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.activity = [{ kind: 'job' }]
  await s.advance(30 * MIN)
  assert.equal(nowCalls(s).length, 0)
  assert.equal(s.service.view('a').runtime.state, 'activity')
  assert.equal(s.clock.timers.size, 0)
})

test('只排着自动化任务照常压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.activity = [{ kind: 'schedule' }]
  await s.advance(30 * MIN)
  assert.equal(nowCalls(s).length, 1)
})

test('到点时可压缩部分太少不压，页面说明', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { compactable: 19_999 })
  s.service.setSession('a', { idle: 300_000 })
  await s.advance(30 * MIN)
  assert.equal(nowCalls(s).length, 0)
  assert.equal(s.service.view('a').runtime.state, 'small')
})

test('压的时候用户发消息：取消这次，消息马上走，不算失败', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.onCompact = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  await s.advance(30 * MIN)
  assert.equal(s.service.view('a').runtime.state, 'compacting')
  s.service.inboxInserted(a)
  await s.settle()
  assert.equal(nowCalls(s)[0].signal.aborted, true)
  assert.equal(s.service.view('a').runtime.state, 'cancelled')
  assert.equal(s.logged.length, 0)
})

test('点取消也能停下', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.onCompact = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  await s.advance(30 * MIN)
  s.service.cancel('a')
  await s.settle()
  assert.equal(s.service.view('a').runtime.state, 'cancelled')
})

test('2 分钟没结束就放弃，算失败', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.onCompact = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  await s.advance(30 * MIN)
  await s.advance(2 * MIN)
  assert.equal(nowCalls(s)[0].signal.aborted, true)
  const runtime = s.service.view('a').runtime
  assert.equal(runtime.state, 'failed')
  assert.equal(runtime.code, 'timeout')
})

test('失败不重试：同一段空闲不再压，下一轮结束才再算', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.onCompact = async () => { throw new Error('stream idle timeout') }
  await s.advance(30 * MIN)
  assert.equal(s.service.view('a').runtime.state, 'failed')
  assert.equal(s.clock.timers.size, 0)
  await s.advance(60 * MIN)
  assert.equal(nowCalls(s).length, 1)
  a.status = 'running'; s.service.status(a, 'running')
  a.status = 'idle'; a.lastTurn = { kind: 'completed', at: s.clock.now }; a.onCompact = undefined
  s.service.status(a, 'idle')
  await s.advance(30 * MIN)
  assert.equal(nowCalls(s).length, 2)
})

test('429 时全局停 30 分钟，别的会话到点也不压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a'); const b = s.add('b')
  s.service.setSession('a', { idle: 300_000 })
  a.onCompact = async () => { throw Object.assign(new Error('too many'), { status: 429 }) }
  await s.advance(30 * MIN)
  assert.equal(s.service.view('a').runtime.code, 'rate')
  b.lastTurn = { kind: 'completed', at: s.clock.now }
  s.service.setSession('b', { idle: 300_000, idleMinutes: 15 })
  await s.advance(15 * MIN)
  assert.equal(nowCalls(s).length, 1)
  assert.equal(s.service.view('b').runtime.state, 'cooldown')
})

test('几个会话同时到点：一次一个，前一个结束再轮到下一个', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a'); const b = s.add('b')
  let release
  a.onCompact = () => new Promise(resolve => { release = () => resolve({ shadowedTokenCount: 1 }) })
  s.service.setSession('a', { idle: 300_000 })
  s.service.setSession('b', { idle: 300_000 })
  await s.advance(30 * MIN)
  assert.deepEqual(nowCalls(s).map(c => c.id), ['a'])
  assert.equal(s.service.view('b').runtime.state, 'queued')
  release()
  await s.settle()
  assert.deepEqual(nowCalls(s).map(c => c.id), ['a', 'b'])
})

test('电脑休眠后定时器醒来晚了：不压不补', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  await s.advance(36 * MIN)
  assert.equal(nowCalls(s).length, 0)
  assert.equal(s.service.view('a').runtime.state, 'stale')
  void a
})

test('App 重启：没到点的接着等，超过的不压', async t => {
  const s = setup(); t.after(s.cleanup)
  s.service.setSession('a', { idle: 300_000 })
  s.service.setSession('b', { idle: 300_000 })
  const a = s.add('a', { lastTurn: { kind: 'completed', at: T0 - 10 * MIN } })
  const b = s.add('b', { lastTurn: { kind: 'completed', at: T0 - 40 * MIN } })
  s.service.created(a)
  s.service.created(b)
  assert.equal(s.service.view('a').runtime.dueAt, T0 + 20 * MIN)
  assert.equal(s.service.view('b').runtime.state, 'stale')
  await s.advance(20 * MIN)
  assert.deepEqual(nowCalls(s).map(c => c.id), ['a'])
})

test('预设不在名单：默认开着也不压，示例助手就是这样', async t => {
  const s = setup(); t.after(s.cleanup)
  s.service.setDefaults({ idle: 100_000 })
  const whale = s.add('whale-main', { preset: 'whale' })
  s.service.status(whale, 'idle')
  s.service.created(whale)
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('whale-main').runtime.state, 'excluded')
  await s.advance(60 * MIN)
  assert.equal(nowCalls(s).length, 0)
})

test('子代理不压', t => {
  const s = setup(); t.after(s.cleanup)
  s.service.setDefaults({ idle: 100_000 })
  const child = s.add('child', { root: false })
  s.service.status(child, 'idle')
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('child').runtime.state, 'subagent')
})

test('关掉阈值时定时器取消', t => {
  const s = setup(); t.after(s.cleanup)
  s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  assert.equal(s.clock.timers.size, 1)
  s.service.setSession('a', { idle: null })
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').runtime.state, 'off')
})

test('恢复默认时定时器取消', t => {
  const s = setup(); t.after(s.cleanup)
  s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  s.service.resetSession('a')
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').settings.overridden, false)
})

test('空闲时选了比用量低的工作线：马上压，不等', async t => {
  const s = setup(); t.after(s.cleanup)
  s.add('a')
  s.service.setSession('a', { work: 300_000 })
  await s.settle()
  assert.equal(nowCalls(s).length, 1)
})

test('工作线比用量高时选了不压', async t => {
  const s = setup(); t.after(s.cleanup)
  s.add('a')
  s.service.setSession('a', { work: 400_000 })
  await s.settle()
  assert.equal(nowCalls(s).length, 0)
})

test('运行中选了比用量低的工作线：下一步开始前压，留尾部', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', used: 350_000 })
  s.service.setSession('a', { work: 300_000 })
  await s.settle()
  assert.equal(nowCalls(s).length, 0)
  await s.service.preStep(a, new AbortController().signal)
  const region = s.calls.find(c => c.op === 'region')
  assert.deepEqual([region.start, region.end], [0, 1])
})

test('工作线：修剪后已经低于线就不压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', afterPrune: 250_000 })
  s.service.setSession('a', { work: 300_000 })
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.some(c => c.op === 'prune'), true)
  assert.equal(s.calls.some(c => c.op === 'region'), false)
})

test('工作线默认关闭时每步只查一下，不量不压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', measure: () => assert.fail('不该量') })
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.length, 0)
})

test('工作线：这一轮失败一次就不再试，下一轮再说，也不打断这一轮', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running' })
  s.service.setSession('a', { work: 300_000 })
  a.onRegion = async () => { throw new Error('boom') }
  await s.service.preStep(a, new AbortController().signal)
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.filter(c => c.op === 'region').length, 1)
  assert.equal(s.logged.length, 1)
  await s.advance(MIN)
  a.status = 'idle'; a.used = 100_000; a.lastTurn = { kind: 'completed', at: s.clock.now }; s.service.status(a, 'idle')
  a.status = 'running'; a.used = 350_000; s.service.status(a, 'running'); a.onRegion = undefined
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.filter(c => c.op === 'region').length, 2)
})

test('工作线：高于官方线的不管，交给官方', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', used: 620_000 })
  s.service.setSession('a', { work: 600_000 })
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.some(c => c.op === 'region'), false)
})

test('工作线：示例助手和子代理不管', async t => {
  const s = setup(); t.after(s.cleanup)
  s.service.setDefaults({ work: 100_000 })
  const whale = s.add('whale-main', { preset: 'whale', status: 'running' })
  const child = s.add('child', { root: false, status: 'running' })
  await s.service.preStep(whale, new AbortController().signal)
  await s.service.preStep(child, new AbortController().signal)
  assert.equal(s.calls.length, 0)
})

test('卸载时定时器清掉，压到一半的中止', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a'); s.add('b')
  a.onCompact = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  s.service.setSession('a', { idle: 300_000 })
  await s.advance(30 * MIN)
  s.service.setSession('b', { idle: 300_000, idleMinutes: 60 })
  await s.service.dispose()
  assert.equal(nowCalls(s)[0].signal.aborted, true)
  assert.equal(s.clock.timers.size, 0)
})

test('会话关掉时定时器清掉', t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  s.service.disposed(a)
  assert.equal(s.clock.timers.size, 0)
})

function promptSetup(prompt, allowed = true) {
  const sent = []
  const swap = createPromptSwap({ prompt: () => prompt, allowed: () => allowed, extra: () => undefined })
  const official = `${OFFICIAL_HEAD} for this assistant.`
  const request = (text = official) => ({ purpose: 'compaction', sessionId: 's', messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  return { swap, sent, official, request }
}

test('提示词：名单外的预设保持官方原文', () => {
  const p = promptSetup({ selection: 'seven', custom: '' }, false)
  assert.equal(p.swap(p.request()), undefined)
})

test('提示词：自定义文字以官方开头时不会反复替换', () => {
  const custom = `${OFFICIAL_HEAD} 我改过的版本`
  const p = promptSetup({ selection: 'custom', custom })
  const first = p.swap(p.request())
  assert.equal(first.at(-1).content[0].text, custom)
  assert.equal(p.swap({ purpose: 'compaction', sessionId: 's', messages: first }), undefined)
})

test('配置拒绝未知键和不合法的值', () => {
  for (const bad of [{ nope: 1 }, { dir: '' }, { dir: 1 }, { presets: 'standard' }, { presets: [''] }, { minCompactable: 0 }, { timeoutMs: -1 }, { retainRatio: 1 }, { idleChoices: [] }, { idleChoices: [0.5] }, { cacheNotes: { x: 1 } }, null, []]) {
    assert.throws(() => parseCompactionConfig(bad), /compaction config/, JSON.stringify(bad))
  }
  assert.deepEqual(parseCompactionConfig().presets, ['standard', 'dsh-workbench-coding', 'dsh-workbench-full'])
  assert.deepEqual(parseCompactionConfig({ idleChoices: [1] }).idleChoices, [1])
})

test('工作线：能压的太少时不花这次钱，这一轮不再试', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', used: 350_000, nodes: [{ seq: 0, tokens: 1_000 }, { seq: 1, tokens: 1_000 }, { seq: 2, tokens: 348_000 }] })
  s.service.setSession('a', { work: 300_000 })
  await s.service.preStep(a, new AbortController().signal)
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.some(c => c.op === 'region'), false)
})

test('工作线：单条消息比线还大、压完还在线上时，这一轮不再反复压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', used: 350_000 })
  s.service.setSession('a', { work: 300_000 })
  await s.service.preStep(a, new AbortController().signal)
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.filter(c => c.op === 'region').length, 1)
})

test('工作线：压完回到线下时，同一轮后面再到线还能压', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running', used: 350_000 })
  a.onRegion = async () => { a.used = 100_000; return { shadowedTokenCount: 250_000 } }
  s.service.setSession('a', { work: 300_000 })
  await s.service.preStep(a, new AbortController().signal)
  a.used = 350_000
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.filter(c => c.op === 'region').length, 2)
})

test('同一段空闲只试一次：官方又发 idle 事件时不重复压，压完的说明还在', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  a.onCompact = async () => { a.used = 310_000; return { shadowedTokenCount: 40_000 } }
  await s.advance(30 * MIN)
  assert.equal(s.service.view('a').runtime.state, 'done')
  s.service.status(a, 'idle')
  s.service.created(a)
  assert.equal(s.clock.timers.size, 0)
  assert.equal(s.service.view('a').runtime.state, 'done')
  await s.advance(60 * MIN)
  assert.equal(nowCalls(s).length, 1)
})

test('同一段空闲里用户改了设置，按新设置再算', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a')
  s.service.setSession('a', { idle: 300_000 })
  await s.advance(30 * MIN)
  assert.equal(s.service.view('a').runtime.state, 'done')
  s.service.setSession('a', { idle: null })
  assert.equal(s.service.view('a').runtime.state, 'off')
})

test('工作线：失败标记跟着轮次走，下一轮开始时 idle 事件还没到也能再试', async t => {
  const s = setup(); t.after(s.cleanup)
  const a = s.add('a', { status: 'running' })
  s.service.setSession('a', { work: 300_000 })
  a.onRegion = async () => { throw new Error('boom') }
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.filter(c => c.op === 'region').length, 1)
  a.onRegion = undefined
  a.lastTurn = { kind: 'completed', at: T0 + MIN }
  await s.service.preStep(a, new AbortController().signal)
  assert.equal(s.calls.filter(c => c.op === 'region').length, 2)
})

test('W-012 immediate work compaction clears the idle deadline and timer before cancellation', async t => {
  const s = setup(); t.after(s.cleanup); t.after(() => s.service.dispose())
  const a = s.add('a')
  a.onCompact = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  s.service.setSession('a', { idle: 100_000, work: 300_000 })
  assert.equal(s.service.view('a').runtime.state, 'compacting')
  assert.equal(s.service.view('a').runtime.dueAt, undefined)
  assert.equal(s.clock.timers.size, 1, 'only the operation timeout remains')
  s.service.cancel('a')
  await s.settle()
  assert.equal(s.service.view('a').runtime.state, 'cancelled')
  assert.equal(s.service.view('a').runtime.dueAt, undefined)
  assert.equal(s.clock.timers.size, 0)
  await s.advance(60 * MIN)
  assert.equal(nowCalls(s).length, 1)
})

test('W-012 cancelling a queued session removes its deadline and pending request', async t => {
  const s = setup(); t.after(s.cleanup); t.after(() => s.service.dispose())
  const a = s.add('a'); s.add('b')
  let finish
  a.onCompact = signal => new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  s.service.setSession('a', { idle: 100_000 })
  s.service.setSession('b', { idle: 100_000 })
  await s.advance(30 * MIN)
  assert.equal(s.service.view('b').runtime.state, 'queued')
  s.service.cancel('b')
  assert.equal(s.service.view('b').runtime.state, 'cancelled')
  assert.equal(s.service.view('b').runtime.dueAt, undefined)
  finish({ shadowedTokenCount: 1 })
  await s.settle()
  assert.deepEqual(nowCalls(s).map(c => c.id), ['a'])
})

for (const reason of ['cooldown', 'below']) {
  test(`TW-002 a ${reason} queue head does not strand the next session`, async t => {
    const s = setup(); t.after(s.cleanup); t.after(() => s.service.dispose())
    const a = s.add('a'), b = s.add('b'); s.add('c')
    const pending = Promise.withResolvers()
    a.onCompact = signal => { signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true }); return pending.promise }
    for (const id of ['a', 'b', 'c']) s.service.setSession(id, { idle: 100_000 })
    await s.advance(30 * MIN)
    assert.equal(s.service.view('b').runtime.state, 'queued')
    assert.equal(s.service.view('c').runtime.state, 'queued')
    if (reason === 'cooldown') pending.reject(Object.assign(new Error('rate limit'), { status: 429 }))
    else { b.used = 0; pending.resolve({ shadowedTokenCount: 1 }) }
    await s.settle()
    assert.equal(s.service.view('b').runtime.state, reason)
    assert.equal(s.service.view('c').runtime.state, reason === 'cooldown' ? 'cooldown' : 'done')
    assert.deepEqual(nowCalls(s).map(c => c.id), reason === 'cooldown' ? ['a'] : ['a', 'c'])
    assert.equal(s.clock.timers.size, 0)
  })
}

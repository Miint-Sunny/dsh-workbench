import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closedWrapUpTurn, rememberClosedWrapUp, wrapUpViewOf } from '../src/client/wrapup.js'
import { progressText } from '../src/client/dock.js'
import { reconcileFeatures } from '../src/client/features.js'
import { admitUnknownPresets, defaultConfig, notificationsBetween } from '../src/client/notify.js'

// ---------- 收尾框：按轮次找条目、决定按钮显不显示 ----------

/** turnTail 传进来的 TurnLocation 形状（轮次号在 .turn）。 */
const location = (turn) => ({ turn, start: undefined, end: undefined, status: 'closed', steps: [], data: {} })

/** 一个投影状态。 */
const stateOf = (entries, buttonsLive) => ({ entries, buttonsLive })

test('wrapUpViewOf: finds the entry by the turn number inside the TurnLocation object', () => {
  const state = stateOf([{ turn: 3, recap: '总结三' }, { turn: 5, recap: '总结五' }], true)
  assert.deepEqual(wrapUpViewOf(state, location(3)), { entry: state.entries[0], showButtons: false })
  assert.deepEqual(wrapUpViewOf(state, location(5)), { entry: state.entries[1], showButtons: true })
  assert.equal(wrapUpViewOf(state, location(4)), undefined)
})

test('wrapUpViewOf: buttons only on the latest turn while still unanswered', () => {
  const latest = { turn: 5, recap: '总结五', ask: '继续吗？', actions: ['继续'] }
  const state = stateOf([{ turn: 3, recap: '总结三' }, latest], true)
  assert.equal(wrapUpViewOf(state, location(5)).showButtons, true)
  // 下一轮开始后（buttonsLive 收起）：旧轮次的总结还在，按钮没了
  assert.equal(wrapUpViewOf(stateOf(state.entries, false), location(5)).showButtons, false)
  // 再来一轮新的收尾：旧的也不是最新了
  const later = stateOf([...state.entries, { turn: 6, recap: '总结六' }], true)
  assert.equal(wrapUpViewOf(later, location(5)).showButtons, false)
  assert.equal(wrapUpViewOf(later, location(6)).showButtons, true)
})

test('wrapUpViewOf: closing the latest box (feat#166) leaves only its recap, like an older turn', () => {
  const latest = { turn: 5, recap: '总结五', ask: '继续吗？', actions: ['继续', '先不'] }
  const state = stateOf([{ turn: 3, recap: '总结三' }, latest], true)
  assert.equal(wrapUpViewOf(state, location(5), 5).showButtons, false)
  // 关的是别的轮次：这一轮照旧
  assert.equal(wrapUpViewOf(state, location(5), 3).showButtons, true)
  assert.equal(wrapUpViewOf(state, location(5), undefined).showButtons, true)
})

test('closed wrap-up turn: remembered per session; blocked or broken storage only loses the memory', () => {
  const store = new Map()
  const storage = () => ({ getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v) } })
  assert.equal(closedWrapUpTurn('s1', storage), undefined)
  rememberClosedWrapUp('s1', 7, storage)
  assert.equal(closedWrapUpTurn('s1', storage), 7)
  assert.equal(closedWrapUpTurn('s2', storage), undefined)
  store.set([...store.keys()][0], 'not-json{')
  assert.equal(closedWrapUpTurn('s1', storage), undefined)
  const blocked = () => { throw new Error('SecurityError') }
  assert.doesNotThrow(() => rememberClosedWrapUp('s1', 8, blocked))
  assert.equal(closedWrapUpTurn('s1', blocked), undefined)
})

test('wrapUpViewOf: absent state or malformed location yields undefined', () => {
  const state = stateOf([{ turn: 3, recap: '总结三' }], true)
  assert.equal(wrapUpViewOf(undefined, location(3)), undefined)
  assert.equal(wrapUpViewOf(null, location(3)), undefined)
  assert.equal(wrapUpViewOf(state, undefined), undefined)
  assert.equal(wrapUpViewOf(state, {}), undefined)
  assert.equal(wrapUpViewOf(state, { turn: '3' }), undefined)
})

// ---------- 任务条：进度文字 ----------

const T = key => ({ 'todo.progressDone': `全完成 ${JSON.stringify(key)}`, 'todo.doneUnit': '已完成', 'todo.activeUnit': '进行中', 'todo.pendingUnit': '待处理' }[key])
const progressT = (key, params) => (key === 'todo.progressDone' ? `${params.n} 已完成` : T(key))
const todos = statuses => statuses.map(status => ({ status }))

test('progressText: follows DSH wording, omits zero segments, all-done collapses to one', () => {
  assert.equal(progressText([], progressT), '')
  assert.equal(progressText(todos(['completed', 'completed']), progressT), '2 已完成')
  assert.equal(progressText(todos(['completed', 'in_progress', 'pending', 'pending']), progressT), '1 已完成 · 1 进行中 · 2 待处理')
  assert.equal(progressText(todos(['in_progress']), progressT), '1 进行中')
  assert.equal(progressText(todos(['pending']), progressT), '1 待处理')
})

// ---------- 挂载对齐：清单少了就撤、又出现就重挂 ----------

test('reconcileFeatures: mounting follows the list; a dropped row is disposed, a returning row remounts', () => {
  const calls = []
  const seen = []
  const ui = {
    tasks: (app) => { seen.push(app); calls.push('tasks:mount'); return () => calls.push('tasks:dispose') },
    notify: () => { calls.push('notify:mount'); return () => calls.push('notify:dispose') },
  }
  const marker = {}
  const mounted = new Map()
  const has = new Set(['tasks', 'notify'])
  reconcileFeatures(mounted, id => has.has(id), ui, marker)
  assert.deepEqual(calls, ['tasks:mount', 'notify:mount'])
  assert.deepEqual(seen, [marker])
  // 清单从「tasks、notify」变成「notify」：tasks 的撤销函数被调用
  has.delete('tasks')
  reconcileFeatures(mounted, id => has.has(id), ui, marker)
  assert.deepEqual(calls, ['tasks:mount', 'notify:mount', 'tasks:dispose'])
  assert.deepEqual([...mounted.keys()], ['notify'])
  // 撤了又出现：重挂；开着的不重复挂
  has.add('tasks')
  reconcileFeatures(mounted, id => has.has(id), ui, marker)
  assert.deepEqual(calls, ['tasks:mount', 'notify:mount', 'tasks:dispose', 'tasks:mount'])
  reconcileFeatures(mounted, id => has.has(id), ui, marker)
  assert.equal(calls.length, 4)
})

test('reconcileFeatures: a row that throws leaves the rows after it working', (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const calls = []
  const ui = {
    attention: () => { calls.push('attention:mount'); throw new Error('Reserved shortcut default') },
    palette: () => { calls.push('palette:mount'); return () => { calls.push('palette:dispose'); throw new Error('dispose failed') } },
    usage: () => { calls.push('usage:mount'); return () => calls.push('usage:dispose') },
  }
  const mounted = new Map()
  const has = new Set(Object.keys(ui))
  reconcileFeatures(mounted, id => has.has(id), ui, {})
  assert.deepEqual(calls, ['attention:mount', 'palette:mount', 'usage:mount'])
  assert.equal(logged.mock.callCount(), 1)
  // 清单没变：挂载失败的行不重复执行
  reconcileFeatures(mounted, id => has.has(id), ui, {})
  assert.equal(calls.length, 3)
  // 撤销抛错也不挡后面的行；失败的行关掉再打开会再试一次
  has.clear()
  reconcileFeatures(mounted, id => has.has(id), ui, {})
  assert.deepEqual(calls.slice(3), ['palette:dispose', 'usage:dispose'])
  assert.deepEqual([...mounted.keys()], [])
  has.add('attention')
  reconcileFeatures(mounted, id => has.has(id), ui, {})
  assert.equal(calls.at(-1), 'attention:mount')
})

// ---------- 通知：预设未知的先补齐再决定 ----------

/** 全开的配置（按需覆盖）。 */
function configOf(overrides = {}) {
  const config = defaultConfig()
  return { ...config, ...overrides }
}

test('admitUnknownPresets: unknown preset refreshed to an excluded one is dropped', async () => {
  const config = configOf({ excludedPresets: ['whale'] })
  const listSnapshot = new Map() // 列表快照里没有 projectionValues
  const deps = {
    presetOf: (sessionId) => listSnapshot.get(sessionId),
    refreshPresetOf: async (sessionId) => {
      // refreshProjections 之后快照里有了
      listSnapshot.set(sessionId, 'whale')
      return listSnapshot.get(sessionId)
    },
    onUnknownPreset: () => { throw new Error('不该记日志') },
  }
  const admitted = await admitUnknownPresets([{ sessionId: 's1', event: 'completed' }], config, deps)
  assert.deepEqual(admitted, [])
})

test('admitUnknownPresets: refreshed to a non-excluded preset is admitted; still unknown is admitted with a log line', async () => {
  const config = configOf({ excludedPresets: ['whale'] })
  const logged = []
  const deps = {
    presetOf: () => undefined,
    refreshPresetOf: async (sessionId) => (sessionId === 's1' ? 'standard' : undefined),
    onUnknownPreset: (sessionId) => logged.push(sessionId),
  }
  const admitted = await admitUnknownPresets([
    { sessionId: 's1', event: 'completed' },
    { sessionId: 's2', event: 'completed' },
  ], config, deps)
  assert.deepEqual(admitted, [{ sessionId: 's1', event: 'completed' }, { sessionId: 's2', event: 'completed' }])
  assert.deepEqual(logged, ['s2'])
})

test('admitUnknownPresets: known presets pass through without a refresh', async () => {
  const config = configOf({ excludedPresets: ['whale'] })
  let refreshed = 0
  const deps = {
    presetOf: () => 'standard',
    refreshPresetOf: async () => { refreshed += 1; return 'standard' },
    onUnknownPreset: () => {},
  }
  const admitted = await admitUnknownPresets([{ sessionId: 's1', event: 'completed' }], config, deps)
  assert.deepEqual(admitted, [{ sessionId: 's1', event: 'completed' }])
  assert.equal(refreshed, 0)
})

// 两个函数合起来的整条路：列表里没有投影值 → 补齐成 whale → 不发
test('notificationsBetween + admitUnknownPresets together: a session with no cached projection is silenced after refresh', async () => {
  const config = configOf({ excludedPresets: ['whale'] })
  const before = new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
  const after = new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: true }]])
  const listSnapshot = new Map()
  const presetOf = (sessionId) => listSnapshot.get(sessionId)
  const candidates = notificationsBetween(before, after, config, false, presetOf)
  assert.deepEqual(candidates, [{ sessionId: 's1', event: 'completed' }])
  const admitted = await admitUnknownPresets(candidates, config, {
    presetOf,
    refreshPresetOf: async (sessionId) => { listSnapshot.set(sessionId, 'whale'); return 'whale' },
    onUnknownPreset: () => {},
  })
  assert.deepEqual(admitted, [])
})

// ---- 功能清单读取（src/client/features.js 的 createFeatureStore）：只有 200 和 404 更新清单 ----

import { createFeatureStore } from '../src/client/features.js'

/** 临时把全局 fetch 换成假实现，返回还原函数。 */
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => { globalThis.fetch = original }
}

test('feature store: 200 更新清单并通知订阅者；内容没变不重复通知', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ features: [{ id: 'tasks' }, { id: 'review' }] }), { status: 200 }))
  try {
    const store = createFeatureStore({})
    let notified = 0
    store.subscribe(() => { notified += 1 })
    await store.load()
    assert.equal(store.has('tasks'), true)
    assert.equal(store.has('review'), true)
    assert.equal(store.has('notify'), false)
    assert.equal(notified, 1)
    await store.load()
    assert.equal(notified, 1)
  } finally {
    restore()
  }
})

test('feature store: 404（根行关了）按全关处理', async () => {
  const restore = stubFetch(async () => new Response('not found', { status: 404 }))
  try {
    const store = createFeatureStore({})
    await store.load()
    assert.equal(store.has('tasks'), false)
  } finally {
    restore()
  }
})

test('feature store: 网络错误、5xx、格式不对的 200 都保留上一次的清单', async () => {
  let answer = () => new Response(JSON.stringify({ features: [{ id: 'tasks' }] }), { status: 200 })
  const restore = stubFetch(async () => answer())
  try {
    const store = createFeatureStore({})
    await store.load()
    assert.equal(store.has('tasks'), true)
    // 网络错误：保留。
    answer = () => { throw new TypeError('fetch failed') }
    await store.load()
    assert.equal(store.has('tasks'), true)
    // 5xx：保留。
    answer = () => new Response('boom', { status: 502 })
    await store.load()
    assert.equal(store.has('tasks'), true)
    // 格式不对的 200：保留。
    answer = () => new Response('{"features": "nope"}', { status: 200 })
    await store.load()
    assert.equal(store.has('tasks'), true)
    // 恢复以后照样更新。
    answer = () => new Response(JSON.stringify({ features: [{ id: 'notify' }] }), { status: 200 })
    await store.load()
    assert.equal(store.has('tasks'), false)
    assert.equal(store.has('notify'), true)
  } finally {
    restore()
  }
})

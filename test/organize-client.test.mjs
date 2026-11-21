/** organize 客户端的测试：纯函数（分组、筛选、批量、未读清除、时间、菜单动作）、数据层、applyOrganize 的注册和撤销。和侧边对话共用的会话列表、目录名、主会话、状态词在 split-client.test.mjs 里测。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyOrganize, createOrganizeStore, groupByDate, groupByLabel, organizeCounts, organizeDefaultClientState,
  organizeMenuActions, organizeRenameProblem, organizeRows,
  organizeTimeParts, organizeVisible, startOrganizeUnreadWatcher, unreadToClear,
} from '../src/client/organize.js'

// ---------- 「会话」页列表、筛选、分组 ----------

/** 照列表快照条目的真实字段形状造一条。 */
function entry(id, over = {}) {
  return { id, displayTitle: id, running: false, blank: false, updatedAt: 0, cwd: '/w/x', ...over }
}

/** 照 SessionListState 的形状造快照。 */
const list = (...entries) => ({ ids: entries.map(item => item.id), byId: Object.fromEntries(entries.map(item => [item.id, item])) })

test('行对象并上标签和未读；筛选和计数一起算', () => {
  const rows = organizeRows([entry('a'), entry('b'), entry('c')], {
    assignments: { a: 'red', b: 'blue' },
    unread: ['b'],
  })
  assert.deepEqual(rows.map(row => [row.id, row.labelId, row.unread]), [['a', 'red', false], ['b', 'blue', true], ['c', null, false]])
  // 全部。
  assert.equal(organizeVisible(rows).length, 3)
  // 按标签。
  assert.deepEqual(organizeVisible(rows, { filter: { kind: 'label', labelId: 'red' } }).map(row => row.id), ['a'])
  // 未读、无标签。
  assert.deepEqual(organizeVisible(rows, { filter: { kind: 'unread' } }).map(row => row.id), ['b'])
  assert.deepEqual(organizeVisible(rows, { filter: { kind: 'none' } }).map(row => row.id), ['c'])
  // 搜索和 chip 叠着筛；计数按搜索后的集合算。
  assert.deepEqual(organizeVisible(rows, { query: 'b', filter: { kind: 'none' } }).map(row => row.id), [])
  const counts = organizeCounts(organizeVisible(rows, { query: 'a' }).concat(organizeVisible(rows, { query: 'b' })))
  assert.deepEqual(counts, { all: 2, unread: 1, none: 0, red: 1, orange: 0, yellow: 0, green: 0, blue: 1, purple: 0 })
})

test('按日期分组：今天、昨天、本周（周一起）、更早，本地时区', () => {
  // 2026-11-06 是周五；这一周的周一是 11-02。
  const now = new Date(2026, 10, 6, 15, 0, 0).getTime()
  const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour, 0, 0).getTime()
  const entries = [
    entry('today', { updatedAt: at(11, 6, 9) }),
    entry('today-edge', { updatedAt: new Date(2026, 10, 6, 0, 0, 0).getTime() }),
    entry('yesterday', { updatedAt: at(11, 5, 23) }),
    entry('yesterday-edge', { updatedAt: new Date(2026, 10, 5, 0, 0, 0).getTime() }),
    entry('tuesday', { updatedAt: at(11, 3) }),
    entry('monday-start', { updatedAt: new Date(2026, 10, 2, 0, 0, 0).getTime() }),
    entry('sunday-before', { updatedAt: new Date(2026, 10, 1, 23, 59, 59).getTime() }),
    entry('last-month', { updatedAt: at(10, 20) }),
  ]
  const groups = groupByDate(entries, now)
  assert.deepEqual(groups.map(group => [group.key, group.entries.map(item => item.id)]), [
    ['today', ['today', 'today-edge']],
    ['yesterday', ['yesterday', 'yesterday-edge']],
    ['thisWeek', ['tuesday', 'monday-start']],
    ['earlier', ['sunday-before', 'last-month']],
  ])
  // 周一当天：昨天（周日）归「昨天」，虽然按周一起算它也在这一周里。
  const monday = groupByDate([entry('sunday', { updatedAt: at(11, 1) })], new Date(2026, 10, 2, 8, 0, 0).getTime())
  assert.deepEqual(monday.map(group => group.entries.length), [0, 1, 0, 0])
  // 比现在还晚的时间（时钟偏差）也归今天，不把后面的组挤乱。
  assert.equal(groupByDate([entry('future', { updatedAt: now + 60000 })], now)[0].entries.length, 1)
})

test('按标签分组：六个标签各一组加未分组，空组留给页面跳过', () => {
  const labels = organizeDefaultClientState().labels
  const rows = [
    { id: 'a', labelId: 'red' }, { id: 'b', labelId: 'blue' }, { id: 'c', labelId: null }, { id: 'd', labelId: 'red' },
  ]
  assert.deepEqual(groupByLabel(rows, labels).map(group => [group.key, group.entries.map(row => row.id)]), [
    ['red', ['a', 'd']], ['orange', []], ['yellow', []], ['green', []], ['blue', ['b']], ['purple', []], [null, ['c']],
  ])
  // 不认识的 labelId 落不进任何组（防御，不该发生）。
  assert.equal(groupByLabel([{ id: 'x', labelId: 'scarlet' }], labels).reduce((sum, group) => sum + group.entries.length, 0), 0)
})

test('行尾时间：今天 HH:mm，昨天写「昨天」，更早取月日', () => {
  const now = new Date(2026, 10, 6, 15, 0, 0).getTime()
  assert.deepEqual(organizeTimeParts(new Date(2026, 10, 6, 9, 5, 0).getTime(), now), { kind: 'today', hh: '09', mm: '05' })
  assert.deepEqual(organizeTimeParts(new Date(2026, 10, 6, 0, 0, 0).getTime(), now), { kind: 'today', hh: '00', mm: '00' })
  assert.deepEqual(organizeTimeParts(new Date(2026, 10, 5, 23, 0, 0).getTime(), now), { kind: 'yesterday' })
  assert.deepEqual(organizeTimeParts(new Date(2026, 10, 2, 8, 0, 0).getTime(), now), { kind: 'date', month: 11, day: 2 })
  assert.deepEqual(organizeTimeParts(new Date(2025, 2, 9, 8, 0, 0).getTime(), now), { kind: 'date', month: 3, day: 9 })
})

// ---------- 未读清除 ----------

test('unreadToClear：主对话区换到标了未读的会话才返回它', () => {
  const unread = new Set(['a', 'b'])
  // 起步（上一个是 undefined）打开的就是标了的会话：清。
  assert.equal(unreadToClear(undefined, 'a', unread), 'a')
  // 换到标了的会话：清。
  assert.equal(unreadToClear('c', 'b', unread), 'b')
  // 换到没标的会话、没换、没有主会话：都不清。
  assert.equal(unreadToClear('a', 'c', unread), undefined)
  assert.equal(unreadToClear('a', 'a', unread), undefined)
  assert.equal(unreadToClear('a', undefined, unread), undefined)
  assert.equal(unreadToClear(undefined, undefined, unread), undefined)
})

test('未读看守：停满 1 秒才清，期间换走或已清掉就不动；停止函数收走计时器', () => {
  let main = 'a'
  let watcher = undefined
  const unread = new Set(['a'])
  const cleared = []
  const timers = []
  const stop = startOrganizeUnreadWatcher({
    getMainId: () => main,
    getUnreadSet: () => unread,
    subscribe: (listener) => { watcher = listener; return () => { watcher = undefined } },
    clear: (id) => { cleared.push(id); unread.delete(id) },
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: (handle) => { timers[handle - 1] = undefined },
  })
  // 起步：打开的就是标了的会话 a，排一个计时器。
  assert.equal(timers.length, 1)
  // 计时器没走之前换到 c：计时器还在，但走的时候发现主会话已经不是 a，不清。
  main = 'c'
  watcher()
  assert.equal(timers.length, 1)
  timers[0]()
  assert.deepEqual(cleared, [])
  // 换回 a（还没清掉）：排新的计时器；走的时候清掉。
  main = 'a'
  watcher()
  timers.at(-1)()
  assert.deepEqual(cleared, ['a'])
  // 已经清掉之后再看：没有新计时器。
  main = 'c'
  watcher()
  main = 'a'
  watcher()
  assert.equal(timers.length, 2)
  stop()
  // 停止后再触发不再排计时器（停订以后 watcher 没了）。
  assert.equal(watcher, undefined)
  assert.equal(timers.length, 2)
})

// ---------- 改名预检、菜单动作 ----------

test('改名预检：空、超长、重名各返回词典键', () => {
  const labels = organizeDefaultClientState().labels
  assert.equal(organizeRenameProblem(' 待回复 ', labels, 'red'), undefined)
  assert.equal(organizeRenameProblem('', labels, 'red'), 'organize.page.nameEmpty')
  assert.equal(organizeRenameProblem('  ', labels, 'red'), 'organize.page.nameEmpty')
  assert.equal(organizeRenameProblem(42, labels, 'red'), 'organize.page.nameEmpty')
  assert.equal(organizeRenameProblem('x'.repeat(21), labels, 'red'), 'organize.page.nameTooLong')
  assert.equal(organizeRenameProblem('橙色', labels, 'red'), 'organize.page.nameDup')
  // 和自己原来的名字一样不算重名。
  assert.equal(organizeRenameProblem('红色', labels, 'red'), undefined)
})

test('菜单动作：每一项带图标，当前标签在图标上带 current，没标签时「清除标签」置灰', () => {
  const t = key => key
  const applied = []
  const state = { ...organizeDefaultClientState(), assignments: { s1: 'red' }, unread: [] }
  const actions = organizeMenuActions(state, t, 's1', op => { applied.push(op) })
  const [setLabel, markUnread] = actions
  assert.equal(setLabel.id, 'set-label')
  assert.equal(setLabel.label, 'organize.menu.setLabel')
  assert.equal(setLabel.icon.key, 'dsh-workbench.organize.labels')
  assert.equal(setLabel.children.length, 7)
  // 六个颜色：名字用状态里的（可以改过），当前的带 current 元数据，点当前的不发请求。
  const red = setLabel.children[0]
  assert.equal(red.icon.key, 'dsh-workbench.label.red')
  assert.equal(red.icon.current, true)
  red.run()
  assert.deepEqual(applied, [])
  setLabel.children[1].run()
  assert.deepEqual(applied, [{ op: 'setLabel', sessionIds: ['s1'], labelId: 'orange' }])
  const clear = setLabel.children.at(-1)
  assert.equal(clear.separatorBefore, true)
  assert.equal(clear.icon.key, 'dsh-workbench.organize.clear')
  assert.equal('disabled' in clear, false)
  clear.run()
  assert.deepEqual(applied.at(-1), { op: 'setLabel', sessionIds: ['s1'], labelId: null })
  // 「标为未读」：图标、点击后发 setUnread。
  assert.equal(markUnread.label, 'organize.menu.markUnread')
  assert.equal(markUnread.icon.key, 'dsh-workbench.organize.unreadmark')
  markUnread.run()
  assert.deepEqual(applied.at(-1), { op: 'setUnread', sessionIds: ['s1'], unread: true })

  // 没有标签的会话：「清除标签」置灰，子项都不带 current。
  const plain = organizeMenuActions(organizeDefaultClientState(), t, 's2', () => {})
  assert.equal(plain[0].children.at(-1).disabled, true)
  assert.equal(plain[0].children.some(item => item.icon.current === true), false)
  // 标了未读的会话：动作文字换成「取消未读标记」。
  const marked = organizeMenuActions({ ...organizeDefaultClientState(), unread: ['s2'] }, t, 's2', () => {})
  assert.equal(marked[1].label, 'organize.menu.unmarkUnread')
})

// ---------- 数据层 ----------

/** 造一个假的接口调用：按脚本回答，记下发出去的请求。 */
function fakeFetch(script) {
  const calls = []
  const fetchJson = async (path, init) => {
    calls.push({ path, init })
    const step = script[calls.length - 1] ?? { status: 500, body: undefined }
    if (step.throw !== undefined) throw new Error(step.throw)
    return { status: step.status, body: step.body }
  }
  return { fetchJson, calls }
}

test('数据层：读、写、订阅，快照身份稳定', async () => {
  const labeled = { ...organizeDefaultClientState(), assignments: { s1: 'red' } }
  const { fetchJson, calls } = fakeFetch([
    { status: 200, body: { ok: true, state: labeled } },
    { status: 200, body: { ok: true, state: labeled } },
  ])
  const store = createOrganizeStore(fetchJson)
  assert.deepEqual(store.getSnapshot(), { state: organizeDefaultClientState(), error: undefined })
  const heard = []
  store.subscribe(() => { heard.push(store.getSnapshot()) })
  await store.load()
  assert.deepEqual(store.getSnapshot().state, labeled)
  assert.equal(heard.length, 1)
  // 同样的状态再读一遍：快照不换，订阅者不多叫。
  await store.load()
  assert.equal(heard.length, 1)
  assert.ok(store.getSnapshot() === heard[0])
  // 写成功：用回答里的新状态，发的是 POST 加 JSON 体。
  const next = { ...labeled, unread: ['s2'] }
  fetchJson; void calls
  const writer = createOrganizeStore(async (path, init) => ({ status: 200, body: { ok: true, state: next } }))
  const writeResult = await writer.apply({ op: 'setUnread', sessionIds: ['s2'], unread: true })
  assert.deepEqual(writeResult, { ok: true })
  assert.deepEqual(writer.getSnapshot().state.unread, ['s2'])
})

test('数据层：损坏文件、坏回答、断线各自落到 error，状态保留', async () => {
  const { fetchJson } = fakeFetch([
    { status: 200, body: { ok: true, state: { ...organizeDefaultClientState(), assignments: { s1: 'blue' } } } },
    { status: 200, body: { ok: false, reason: 'corrupt', state: organizeDefaultClientState() } },
    { status: 500, body: undefined },
    { throw: '网络断了' },
    { status: 200, body: { ok: true, state: { version: 9 } } },
  ])
  const store = createOrganizeStore(fetchJson)
  await store.load()
  assert.equal(store.getSnapshot().error, undefined)
  // 损坏：换默认状态、带 corrupt。
  await store.load()
  assert.equal(store.getSnapshot().error, 'corrupt')
  assert.deepEqual(store.getSnapshot().state, organizeDefaultClientState())
  // 500、断线、坏形状：保留上一份状态，带 message。
  await store.load()
  assert.equal(store.getSnapshot().error.message, 'HTTP undefined')
  assert.equal(store.getSnapshot().state.assignments.s1, undefined)
  await store.load()
  assert.equal(store.getSnapshot().error.message, '网络断了')
  await store.load()
  assert.match(store.getSnapshot().error.message, /HTTP/)
})

test('数据层：写失败带回 code 或 message，状态不动', async () => {
  const { fetchJson } = fakeFetch([
    { status: 400, body: { ok: false, code: 'name.duplicate', message: 'duplicate' } },
    { status: 500, body: undefined },
  ])
  const store = createOrganizeStore(fetchJson)
  assert.deepEqual(await store.apply({ op: 'renameLabel', labelId: 'red', name: '橙色' }), { ok: false, code: 'name.duplicate', message: 'duplicate' })
  assert.deepEqual(await store.apply({ op: 'renameLabel', labelId: 'red', name: 'x' }), { ok: false, message: 'HTTP 500' })
  assert.deepEqual(store.getSnapshot().state, organizeDefaultClientState())
})

// ---------- applyOrganize：注册和撤销 ----------

/**
 * 造一个假的客户端上下文：effect 立刻执行并记下撤销函数，注册处都记账。
 * @returns {{ctx: object, log: object}} 假上下文和记账。
 */
function fakeCtx() {
  const log = {
    menuActions: [], slotNames: [], slotDefs: [], events: [], disposers: 0, locale: { subscribe: () => () => {} },
  }
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { log.disposers += 1; dispose() } },
    on(event, listener) { log.events.push({ event, listener }); return () => {} },
    contextMenus: { register(def) { log.menuActions.push(def); return () => { log.menuActions.pop() } } },
    slots: {
      inject(name, factory) {
        log.slotNames.push(name)
        const yielded = factory()
        if (yielded && typeof yielded[Symbol.iterator] === 'function') {
          const disposers = [...yielded]
          return () => { for (const dispose of disposers) dispose() }
        }
        return yielded
      },
      register(def) { log.slotDefs.push(def); return () => {} },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    locale: log.locale,
    uiWorkspace: { openSession: () => {} },
  }
  return { ctx, log }
}

test('applyOrganize：注册菜单、图标、行首、悬停、面板和页面，撤销函数把它们都撤掉', async () => {
  const { ctx, log } = fakeCtx()
  const dispose = applyOrganize({ ctx, store: {}, t: key => key })
  try {
    // 等起步的那次读落定（Node 里 fetch 相对地址直接失败，落到 error，不影响注册）。
    await new Promise(resolve => setTimeout(resolve, 10))
    // 会话行菜单：target 'session'、order 320（官方「分叉」300 后面、「复制 Session ID」450 前面）。
    assert.equal(log.menuActions.length, 1)
    const menu = log.menuActions[0]
    assert.equal(menu.id, 'dsh-workbench.organize')
    assert.equal(menu.target, 'session')
    assert.equal(menu.order, 320)
    // observe 带上数据层和 locale，标签或语言变了菜单重算。
    const [observed] = menu.observe({ sessionId: 's1', displayTitle: 's1' })
    assert.equal(typeof observed.getSnapshot, 'function')
    assert.equal(typeof observed.subscribe, 'function')
    assert.ok(menu.observe({ sessionId: 's1' }).includes(log.locale))
    // resolve 给到的动作：形状由 organizeMenuActions 的测试查，这里看它接得上。
    const actions = menu.resolve({ sessionId: 's1', displayTitle: 's1' })
    assert.equal(actions[0].id, 'set-label')
    // 五个插槽：菜单图标、行首、悬停、侧边栏面板按钮、`main` 页面。
    assert.deepEqual(log.slotNames, [
      'contextMenu.icon', 'sidebar.session.row.leading', 'sidebar.session.row.hover', 'sidebar.panellist', 'main',
    ])
    const icons = log.slotDefs.filter(def => def.name === 'contextMenu.icon')
    assert.deepEqual(icons.map(icon => icon.key), [
      'dsh-workbench.label.red', 'dsh-workbench.label.orange', 'dsh-workbench.label.yellow',
      'dsh-workbench.label.green', 'dsh-workbench.label.blue', 'dsh-workbench.label.purple',
      'dsh-workbench.organize.labels', 'dsh-workbench.organize.unreadmark', 'dsh-workbench.organize.clear',
    ])
    const leading = log.slotDefs.filter(def => def.name === 'sidebar.session.row.leading')
    assert.equal(leading.length, 1)
    assert.equal(leading[0].id, 'dsh-workbench-organize')
    assert.equal(leading[0].order, 50)
    const hover = log.slotDefs.filter(def => def.name === 'sidebar.session.row.hover')
    assert.equal(hover.length, 1)
    assert.equal(hover[0].id, 'dsh-workbench-organize')
    const panel = log.slotDefs.filter(def => def.name === 'sidebar.panellist')
    assert.equal(panel.length, 1)
    assert.equal(panel[0].id, 'dsh-workbench-organize')
    assert.equal(panel[0].order, 20)
    assert.equal(panel[0].label(), 'organize.panel')
    const main = log.slotDefs.filter(def => def.name === 'main')
    assert.equal(main.length, 1)
    assert.equal(main[0].key, 'dsh-workbench-organize')
    // 连接重置时重读数据。
    assert.deepEqual(log.events.map(item => item.event), ['connection/reset'])
  } finally {
    dispose()
  }
  assert.equal(log.menuActions.length, 0)
  // 七个 effect 的撤销（菜单、图标、行首、悬停、面板、页面、连接重置）加看守的订阅。
  assert.equal(log.disposers, 8)
})

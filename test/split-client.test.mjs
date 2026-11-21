/** 侧边对话客户端的测试：地址、候选、状态词这些纯函数（候选、目录名、主会话、状态词在 features.js，和会话整理共用），加 applySplit 的注册/撤销和资源迭代器。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySplit, parseSplitAddress, splitAddress } from '../src/client/split.js'
import { listedSessions, mainViewSessionId, sessionStatusKey, sessionWorkspaceName } from '../src/client/features.js'

// ---------- 地址 ----------

test('地址：会话 id 编码进去读得回来，`?` 后面的参数不算 id', () => {
  assert.equal(splitAddress('s1'), 'dsh-resource://wbsplit/session/s1')
  assert.equal(parseSplitAddress(splitAddress('s1')), 's1')
  // `/`、`#`、空格这些在地址里要编码，读回来还原。
  assert.equal(parseSplitAddress(splitAddress('a/b#c d')), 'a/b#c d')
  // 带 `?` 参数的地址（别的入口拼出来的形状）也认，参数丢弃。
  assert.equal(parseSplitAddress('dsh-resource://wbsplit/session/s1?parent=x&mode=y'), 's1')
})

test('地址：别的协议、空 id、非字符串、编码有误都不认', () => {
  for (const bad of [
    'dsh-resource://file/session/s1',     // 别的资源协议
    'dsh-resource://wbsplit/other/s1',    // 前缀不对
    'dsh-resource://wbsplit/session/',    // 空 id
    'dsh-resource://wbsplit/session/%',   // 百分号序列坏了
    'sidebar://guide',
    undefined,
    42,
  ]) {
    assert.equal(parseSplitAddress(bad), undefined, String(bad))
  }
})

// ---------- 工作区目录名 ----------

test('工作区目录名：取最后一段，`/` 和 `\\` 都算分隔，尾部分隔符丢掉', () => {
  assert.equal(sessionWorkspaceName('/Users/u/work/写作'), '写作')
  assert.equal(sessionWorkspaceName('C:\\x\\api-docs'), 'api-docs')
  assert.equal(sessionWorkspaceName('/w/x/'), 'x')
  assert.equal(sessionWorkspaceName('单段'), '单段')
  assert.equal(sessionWorkspaceName(undefined), '')
  assert.equal(sessionWorkspaceName(''), '')
})

// ---------- 当前主对话区的会话 ----------

test('主对话区的会话：retainedBy.mainView 计数大于 0 的那个', () => {
  const byId = {
    a: { id: 'a', retainedBy: {} },
    b: { id: 'b', retainedBy: { mainView: 2 } },
    c: { id: 'c' },
  }
  assert.equal(mainViewSessionId(byId), 'b')
  assert.equal(mainViewSessionId({ a: { id: 'a', retainedBy: { mainView: 0 } } }), undefined)
  assert.equal(mainViewSessionId({}), undefined)
  assert.equal(mainViewSessionId(undefined), undefined)
})

// ---------- 弹层候选 ----------

/** 照列表快照条目的真实字段形状造一条（没有 title 字段，标题在 displayTitle）。 */
function entry(id, over = {}) {
  return { id, displayTitle: id, running: false, blank: false, updatedAt: 0, cwd: '/w/x', ...over }
}

/** 照 SessionListState 的形状造快照。 */
const list = (...entries) => ({ ids: entries.map(item => item.id), byId: Object.fromEntries(entries.map(item => [item.id, item])) })

test('候选：去掉当前会话、已归档、子智能体和空白会话', () => {
  const snapshot = list(
    entry('current'),
    entry('archived'),
    entry('sub', { origin: 'subagent' }),
    entry('blank', { blank: true }),
    entry('plain'),
  )
  const ids = listedSessions(snapshot, { currentId: 'current', archivedIds: ['archived'] }).map(item => item.id)
  assert.deepEqual(ids, ['plain'])
  // 已归档集合也能传 Set。
  assert.deepEqual(
    listedSessions(snapshot, { currentId: 'current', archivedIds: new Set(['archived']) }).map(item => item.id),
    ['plain'],
  )
  // 不给当前会话和已归档集合时只按条目自身过滤。
  assert.deepEqual(
    listedSessions(snapshot, {}).map(item => item.id).sort(),
    ['archived', 'current', 'plain'],
  )
})

test('候选：按 updatedAt 从新到旧，相同时按 id；坏快照给空数组', () => {
  const snapshot = list(
    entry('old', { updatedAt: 1 }),
    entry('new', { updatedAt: 9 }),
    entry('mid-b', { updatedAt: 5 }),
    entry('mid-a', { updatedAt: 5 }),
  )
  assert.deepEqual(listedSessions(snapshot, {}).map(item => item.id), ['new', 'mid-a', 'mid-b', 'old'])
  assert.deepEqual(listedSessions(undefined, {}), [])
  assert.deepEqual(listedSessions({ byId: undefined }, {}), [])
})

test('候选：query 按标题和工作区目录名过滤，不分大小写，前后空白不算', () => {
  const snapshot = list(
    entry('login', { displayTitle: '登录页校验', cwd: '/work/web-app' }),
    entry('doc', { displayTitle: '接口文档整理', cwd: '/work/api-docs' }),
    entry('weekly', { displayTitle: '周报草稿', cwd: '/work/默认工作区' }),
    entry('nocwd', { displayTitle: '没有目录的会话', cwd: undefined }),
  )
  assert.deepEqual(listedSessions(snapshot, { query: '登录' }).map(item => item.id), ['login'])
  assert.deepEqual(listedSessions(snapshot, { query: 'API-DOCS' }).map(item => item.id), ['doc'])
  assert.deepEqual(listedSessions(snapshot, { query: '  周报 ' }).map(item => item.id), ['weekly'])
  assert.deepEqual(listedSessions(snapshot, { query: '没有目录' }).map(item => item.id), ['nocwd'])
  assert.deepEqual(listedSessions(snapshot, { query: '不存在的会话' }), [])
})

// ---------- 状态词 ----------

test('状态词：等待类优先于进行中，进行中回落到条目，已完成不写', () => {
  assert.equal(sessionStatusKey(entry('s'), { pendingInteraction: { kind: 'approval' } }), 'session.status.approval')
  assert.equal(sessionStatusKey(entry('s'), { pendingInteraction: { kind: 'plan-review' } }), 'session.status.planReview')
  assert.equal(sessionStatusKey(entry('s'), { pendingInteraction: { kind: 'question' } }), 'session.status.question')
  // 等待审批时通常也还在跑：只写等待类。
  assert.equal(sessionStatusKey(entry('s'), { running: true, pendingInteraction: { kind: 'approval' } }), 'session.status.approval')
  assert.equal(sessionStatusKey(entry('s'), { running: true }), 'session.status.running')
  assert.equal(sessionStatusKey(entry('s', { running: true }), undefined), 'session.status.running')
  // status 说不在跑就不写（状态快照比条目新鲜）。
  assert.equal(sessionStatusKey(entry('s', { running: true }), { running: false }), undefined)
  assert.equal(sessionStatusKey(entry('s'), undefined), undefined)
  // 别的等待类 kind 不认识，当没有。
  assert.equal(sessionStatusKey(entry('s'), { pendingInteraction: { kind: 'mystery' }, running: false }), undefined)
})

// ---------- applySplit：注册、撤销、资源迭代器 ----------

/**
 * 造一个假的客户端上下文：effect 立刻执行并记下撤销函数，注册处都记账。
 * @param {object} retain sessions.retain 的实现（默认抛错，测试里换）。
 * @param {Record<string, object>} byId 会话列表快照里的 byId（菜单动作的置灰判断读它）。
 * @returns {{ctx: object, log: object}} 假上下文和记账。
 */
function fakeCtx(retain, byId = {}) {
  const log = { resources: [], tabs: [], slotNames: [], slotDefs: [], menuActions: [], menuIcons: [], disposers: 0 }
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { log.disposers += 1; dispose() } },
    resources: { register(def) { log.resources.push(def); return () => { log.resources.pop() } } },
    sidebarRightTabs: { register(def) { log.tabs.push(def); return () => { log.tabs.pop() } } },
    contextMenus: {
      register(def) { log.menuActions.push(def); return () => { log.menuActions.pop() } },
    },
    slots: {
      inject(name, factory) {
        log.slotNames.push(name)
        return factory()
      },
      register(def) { log.slotDefs.push(def); return () => {} },
    },
    sessions: {
      retain,
      list: { getSnapshot: () => ({ byId }) },
    },
    locale: { subscribe: () => () => {} },
    sidebarRight: { openResource: (address) => { log.opened = address } },
  }
  return { ctx, log }
}

test('applySplit：注册资源、标签类型、插槽条目和菜单动作，撤销函数把它们都撤掉', () => {
  const { ctx, log } = fakeCtx(() => { throw new Error('not retained in this test') })
  const dispose = applySplit({ ctx, store: {}, t: key => key })
  try {
    assert.equal(log.resources.length, 1)
    assert.equal(log.resources[0].protocol, 'wbsplit')
    assert.equal(log.tabs.length, 1)
    assert.equal(log.tabs[0].id, 'dsh-workbench/split')
    assert.equal(log.tabs[0].kind, 'wbsplit')
    // 标签标题回退到词典的「会话」，不写死。
    assert.equal(log.tabs[0].title('dsh-resource://wbsplit/session/missing'), 'split.fallbackTitle')
    // 插槽条目：标签内容、会话内容子插槽、菜单图标；不往对话头部加按钮（DSH 头部自己有右侧栏开关）。
    assert.deepEqual(log.slotNames, [
      'sidebar.right.pane.tab',
      'dsh-workbench.split.conversation',
      'contextMenu.icon',
    ])
    const defs = new Map(log.slotDefs.map(def => [def.id ?? def.key, def]))
    assert.equal(defs.get('dsh-workbench/split').key, 'dsh-workbench/split')
    const icon = log.slotDefs.filter(def => def.name === 'contextMenu.icon')
    assert.equal(icon.length, 1)
    assert.equal(icon[0].key, 'dsh-workbench.split')
    assert.equal(log.slotDefs.filter(def => def.name === 'conversation.session.header.utilities').length, 0)
    // 右侧栏「新标签页」开始页里的入口：一个，排在官方文件 10、终端 20、浏览器 30 后面，字都走词典。
    assert.equal(log.tabs[0].guide.length, 1)
    const [entry] = log.tabs[0].guide
    assert.equal(entry.id, 'session')
    assert.equal(entry.order, 40)
    assert.equal(entry.title(), 'split.guide.title')
    assert.equal(entry.description(), 'split.guide.description')
    assert.equal(typeof entry.icon, 'function')
    // 会话菜单动作：target 'session'、order 310（排在官方「分叉」300 后面）。
    assert.equal(log.menuActions.length, 1)
    assert.equal(log.menuActions[0].id, 'dsh-workbench.split')
    assert.equal(log.menuActions[0].target, 'session')
    assert.equal(log.menuActions[0].order, 310)
  } finally {
    dispose()
  }
  assert.equal(log.resources.length, 0)
  assert.equal(log.tabs.length, 0)
  assert.equal(log.menuActions.length, 0)
  assert.equal(log.disposers, 6) // 六个 effect：资源、标签类型、标签内容、子插槽、菜单图标、菜单动作（样式不走 effect，也在同一批撤销里）
})

test('菜单动作的 resolve：当前主对话区的会话置灰，别的会话能点、点了打开', () => {
  const byId = {
    main: { id: 'main', retainedBy: { mainView: 1 } },
    other: { id: 'other' },
  }
  const { ctx, log } = fakeCtx(() => { throw new Error('not retained in this test') }, byId)
  const dispose = applySplit({ ctx, store: {}, t: key => key })
  try {
    const { resolve } = log.menuActions[0]
    // 主对话区的会话：置灰，不带别的说明字段。
    const [grey] = resolve({ sessionId: 'main', displayTitle: '主' })
    assert.equal(grey.id, 'open-in-sidebar')
    assert.equal(grey.label, 'split.openInSidebar')
    assert.equal(grey.disabled, true)
    assert.equal(grey.icon.key, 'dsh-workbench.split')
    // 别的会话：不禁用，run 在右侧栏打开它。
    const [open] = resolve({ sessionId: 'other', displayTitle: '别的' })
    assert.equal('disabled' in open, false)
    open.run()
    assert.equal(log.opened, splitAddress('other'))
  } finally {
    dispose()
  }
})

test('资源的 open：产出引用，信号中止时 release', async () => {
  const released = []
  const { ctx, log } = fakeCtx((id, { source, signal }) => ({ release: () => { released.push(id) } }))
  const dispose = applySplit({ ctx, store: {}, t: key => key })
  try {
    const provider = log.resources[0]
    const controller = new AbortController()
    const stream = provider.open(splitAddress('s1'), { signal: controller.signal })
    const first = await stream.next()
    assert.equal(first.done, false)
    assert.equal(first.value.ok, true)
    assert.equal(first.value.value.address, splitAddress('s1'))
    controller.abort()
    const after = await stream.next()
    assert.equal(after.done, true)
    assert.deepEqual(released, ['s1'])
  } finally {
    dispose()
  }
})

test('资源的 open：retain 抛错时给一帧失败（不抛出迭代器），信号已中止时直接结束', async () => {
  const { ctx, log } = fakeCtx(() => { throw new Error('session not found') })
  const dispose = applySplit({ ctx, store: {}, t: key => key })
  try {
    const provider = log.resources[0]
    const stream = provider.open(splitAddress('gone'), { signal: new AbortController().signal })
    const first = await stream.next()
    assert.equal(first.done, false)
    assert.equal(first.value.ok, false)
    assert.equal(first.value.error.code, 'workbench-split/unavailable')
    const after = await stream.next()
    assert.equal(after.done, true)
    // 信号已中止：不 retain，直接结束。
    const aborted = new AbortController()
    aborted.abort()
    const short = await provider.open(splitAddress('s1'), { signal: aborted.signal }).next()
    assert.equal(short.done, true)
  } finally {
    dispose()
  }
})

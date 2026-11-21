/**
 * 卡片 A 的网页部分（feat#160 改版）：在构建好的 lib/client.js 里挂这一轮末尾的卡片区，宿主的动作路由
 * 用替身。卡片 A 和卡片 B 一样挂在这一轮末尾，按钮和菜单走 /act，⌘↵ 是下一步框的推荐动作，Esc 只在焦点
 * 在页面上时回答「在当前会话处理」；工具行按结果写，插件页那一行的设置选了就存。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const ACT = 'api/dsh-workbench.session-cards.act'

/** 词典替身：带参数时把参数接在键后面，好断言参数也对。 */
const t = (key, params) => (params === undefined ? key : `${key}:${Object.values(params).join(',')}`)

/** 替身元素（照 next-step-keys.test.mjs）：selectors 是它符合的选择器，parent 是上一层。 */
class FakeElement {
  constructor({ selectors = [], attributes = {}, parent = null, editable = false } = {}) {
    this.selectors = new Set(selectors)
    this.attributes = attributes
    this.parent = parent
    this.isContentEditable = editable || (parent?.isContentEditable ?? false)
  }

  matches(selector) {
    return String(selector).split(',').some(part => this.selectors.has(part.trim()))
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parent) if (node.matches(selector)) return node
    return null
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  checkVisibility() {
    return true
  }
}

/** 有 overlays 的 document 替身：querySelectorAll 只返回符合选择器的那几个。 */
function fakeDocument() {
  return { overlays: [], activeElement: null, querySelectorAll(selector) { return this.overlays.filter(node => node.matches(selector)) }, querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null } }
}

/**
 * 宿主替身：动作路由按 replies 依次回答（不给就是 { ok: true }），读选项的路由回会话不可用（已处理的卡
 * 照样写得出题目）。
 */
function fakeHost(replies = []) {
  const requests = []
  const fetch = async (url, init) => {
    if (String(url) === ACT) {
      requests.push(JSON.parse(init.body))
      const reply = replies.shift() ?? { body: { ok: true } }
      return Response.json(reply.body, { status: reply.status ?? 200 })
    }
    return Response.json({ ok: false, error: { code: 'session-unavailable' } }, { status: 404 })
  }
  return { fetch, requests }
}

const base = { turn: 2, order: 0, brief: 'b', options: {} }
const pendingA = { ...base, id: 'a1', title: '整理发布说明', state: 'pending', kind: 'ask' }

/** 挂这一轮末尾的卡片区；view(cards) 给出换一组卡时的新根元素。 */
async function mountTurn(t0, { cards = [pendingA], latestTurn = 2, host = fakeHost(), navigation, document, window } = {}) {
  const globals = { fetch: host.fetch, ...(document === undefined ? {} : { document, Element: FakeElement }), ...(window === undefined ? {} : { window }) }
  const client = loadClient(CLIENT, globals)
  const { react } = client
  const app = { t, ctx: { get: name => (name === 'pluginNavigation' ? navigation : undefined), remote: {}, uiWorkspace: { openSession() {} } } }
  const view = list => react.React.createElement(client.get('SessionCards'), {
    app, turn: { turn: 2 }, sessionId: 's1', useProjection: () => ({ lastTurn: latestTurn, cards: list }), useSessionStatus: () => undefined,
  })
  react.mount(view(cards))
  t0.after(() => react.unmount())
  await react.settle()
  const button = label => react.one(node => node.type === 'ui.Button' && textOf(node).startsWith(label), `「${label}」按钮`)
  const alerts = () => react.all(node => node.props?.role === 'alert').map(textOf)
  return { client, react, app, button, alerts, view, menu: () => react.one(node => node.type === 'ui.Menu', '「不再询问」菜单') }
}

test('卡片 A 和卡片 B 一样挂在这一轮末尾；按设置处理的、上一版没有人选的不挂', async (t0) => {
  const cards = [
    { ...base, id: 'b1', title: 'B 待处理', state: 'pending' },
    { ...pendingA, order: 1 },
    { ...base, id: 'a2', order: 2, title: 'A 在卡片上选了在这里做', state: 'here', kind: 'ask', ask: { choice: 'here' } },
    { ...base, id: 'a3', order: 3, title: 'A 按设置在这里做', state: 'here', kind: 'ask', ask: { choice: 'here', auto: 'setting' } },
    { ...base, id: 'a4', order: 4, title: 'A 上一版自己打字回复', state: 'here', kind: 'ask', ask: { choice: 'here', custom: '先放着' } },
    { ...base, id: 'a5', order: 5, title: 'A 开了会话', state: 'started', kind: 'ask', ask: { choice: 'new' }, childId: 'c1', started: {} },
  ]
  const { react } = await mountTurn(t0, { cards })
  const shown = react.all(node => node.props?.['data-testid'] === 'dwb-session-card' || node.props?.['data-testid'] === 'dwb-ask-card')
    .map(node => [node.props['data-testid'], node.props['data-state']])
  assert.deepEqual(shown, [['dwb-session-card', 'pending'], ['dwb-ask-card', 'pending'], ['dwb-session-card', 'here'], ['dwb-session-card', 'started']])
  assert.equal(textOf(react.one(node => node.props?.className === 'dwb-ask-q', '问句')), 'ask.question')
  assert.equal(textOf(react.one(node => node.props?.className === 'dwb-ask-title', '题目')), '整理发布说明')
})

test('点「新建会话」发 start，不带选项；点「在当前会话处理」发 here 和那一句', async (t0) => {
  const host = fakeHost()
  const { react, button } = await mountTurn(t0, { host })
  react.fire(button('ask.new'), 'onClick')
  await react.settle()
  react.fire(button('scard.here'), 'onClick')
  await react.settle()
  assert.deepEqual(host.requests, [
    { sessionId: 's1', cardId: 'a1', verb: 'start' },
    { sessionId: 's1', cardId: 'a1', verb: 'here', text: 'scard.hereMessage:整理发布说明' },
  ])
})

test('菜单里选「总是……」带上 remember 做对应的动作；「设置」打开插件页的工作台，打不开时写明去哪里改', async (t0) => {
  const host = fakeHost()
  const opened = []
  const { react, menu, alerts } = await mountTurn(t0, { host, navigation: { openBundle: name => opened.push(name) } })
  assert.deepEqual(menu().props.items.map(item => item.id), ['always-new', 'always-here', 'settings'])
  menu().props.onSelect('always-new')
  await react.settle()
  menu().props.onSelect('always-here')
  await react.settle()
  menu().props.onSelect('settings')
  await react.settle()
  assert.deepEqual(host.requests, [
    { sessionId: 's1', cardId: 'a1', verb: 'start', remember: 'always-new' },
    { sessionId: 's1', cardId: 'a1', verb: 'here', text: 'scard.hereMessage:整理发布说明', remember: 'always-here' },
  ])
  assert.deepEqual(opened, ['@miint-sunny/dsh-workbench'])
  assert.deepEqual(alerts(), [])
  react.unmount()

  const second = await mountTurn(t0, { host: fakeHost() })
  second.menu().props.onSelect('settings')
  await second.react.settle()
  assert.deepEqual(second.alerts(), ['ask.settingsUnavailable'])
})

test('没开成时写明原因、按钮恢复可点；「总是……」的设置没存上时，处理以后在卡下面写一句', async (t0) => {
  const host = fakeHost([
    { status: 409, body: { ok: false, error: { code: 'ask-not-inheritable', reason: 'permission' } } },
    { status: 500, body: { ok: false, error: { code: 'send-failed' } } },
    { status: 503, body: { ok: false, error: { code: 'record-pending' } } },
    { body: { ok: true, notSaved: true } },
  ])
  const { react, button, alerts, menu, view } = await mountTurn(t0, { host })
  react.fire(button('ask.new'), 'onClick')
  await react.settle()
  assert.deepEqual(alerts(), ['ask.error.notInheritable:ask.reason.permission'])
  assert.equal(button('ask.new').props.disabled, false)
  react.fire(button('scard.here'), 'onClick')
  await react.settle()
  assert.deepEqual(alerts(), ['scard.error.send-failed'])
  // 宿主已经处理、只是没记进会话：写明再选一次只补记。
  react.fire(button('scard.here'), 'onClick')
  await react.settle()
  assert.deepEqual(alerts(), ['scard.error.record-pending'])
  menu().props.onSelect('always-here')
  await react.settle()
  // 宿主处理完，投影里这张卡变成已处理：同一张卡片 A 换成已处理的样子，那一句留着。
  react.update(view([{ ...pendingA, state: 'here', ask: { choice: 'here', remember: 'always-here' } }]))
  await react.settle()
  assert.equal(react.one(node => node.props?.['data-testid'] === 'dwb-session-card', '已处理的卡').props['data-state'], 'here')
  assert.deepEqual(react.all(node => node.props?.role === 'status').map(textOf), ['ask.notSaved'])
})

test('「总是……」没保存时那一句不说下次还会询问：原来的设置可能就是总是新建会话', () => {
  const client = loadClient(CLIENT)
  const zh = client.get('SESSION_CARDS_ZH')['ask.notSaved']
  const en = client.get('SESSION_CARDS_EN')['ask.notSaved']
  assert.doesNotMatch(zh, /询问/)
  assert.match(zh, /原来的设置/)
  assert.doesNotMatch(en, /asked again/i)
  assert.match(en, /previous setting/)
})

test('「在当前会话处理」等宿主回答时，「新建会话」不写「开始创建…」；点「新建会话」才写', async (t0) => {
  const gates = []
  const requests = []
  const fetch = async (url, init) => {
    requests.push(JSON.parse(init.body))
    const gate = Promise.withResolvers()
    gates.push(gate)
    await gate.promise
    return Response.json({ ok: true })
  }
  const { react, button } = await mountTurn(t0, { host: { fetch, requests } })
  const labels = () => react.all(node => node.type === 'ui.Button').map(textOf)
  react.fire(button('scard.here'), 'onClick')
  await react.settle()
  assert.deepEqual(labels(), ['scard.here', 'ask.new'])
  assert.equal(button('ask.new').props.disabled, true)
  gates.shift().resolve()
  await react.settle()
  react.fire(button('ask.new'), 'onClick')
  await react.settle()
  assert.deepEqual(labels(), ['scard.here', 'scard.starting'])
  gates.shift().resolve()
  await react.settle()
  assert.deepEqual(requests.map(body => body.verb), ['here', 'start'])
})

test('⌘↵：最新一轮的待处理卡片 A 是下一步框的推荐动作（新建会话），按钮上标出键位；旧一轮的不算', async (t0) => {
  const host = fakeHost()
  const { client, react } = await mountTurn(t0, { host })
  assert.equal(client.get('nextStepOf')('s1'), 'card:a1')
  assert.equal(react.all(node => node.type === 'ui.ShortcutKeys').length, 2, 'Esc 和 ⌘↵ 两处键位')
  assert.equal(client.get('runNextStep')('s1'), true)
  await react.settle()
  assert.deepEqual(host.requests, [{ sessionId: 's1', cardId: 'a1', verb: 'start' }])
  react.unmount()

  const older = await mountTurn(t0, { latestTurn: 3 })
  assert.equal(older.client.get('nextStepOf')('s1'), undefined)
  assert.equal(older.react.all(node => node.type === 'ui.ShortcutKeys').length, 0)
})

test('Esc 的规矩：不带修饰键；焦点在页面上（空的输入框也不算），没有弹窗菜单、会话没在运行、没有待处理的交互才算', () => {
  const client = loadClient(CLIENT)
  const escOf = client.get('askEscOf')
  const key = init => ({ key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...init })
  assert.equal(escOf(key()), true)
  for (const init of [{ shiftKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { key: 'Enter' }]) assert.equal(escOf(key(init)), false)
  const answers = client.get('askEscAnswers')
  assert.equal(answers({ focus: 'page', modal: null }), true)
  assert.equal(answers({ focus: 'page', modal: 'sidebar' }), true)
  for (const input of [
    { focus: 'composer-empty', modal: null },
    { focus: 'composer-filled', modal: null },
    { focus: 'editable', modal: null },
    { focus: 'terminal', modal: null },
    { focus: 'page', modal: 'settings' },
    { focus: 'page', modal: null, overlay: true },
    { focus: 'page', modal: null, running: true },
    { focus: 'page', modal: null, pending: true },
  ]) assert.equal(answers(input), false, JSON.stringify(input))
})

/**
 * 分两段派发 keydown 的 window 替身：先跑捕获阶段的监听，再跑 upper（两段之间的别的层：挂在 document 上的
 * 监听、元素自己的 onKeyDown），最后跑冒泡阶段的监听。stopPropagation 以后不再往下派发。
 */
function phasedWindow() {
  const listeners = { capture: new Set(), bubble: new Set() }
  const phaseOf = options => (options === true || options?.capture === true ? 'capture' : 'bubble')
  return {
    addEventListener(type, listener, options) { if (type === 'keydown') listeners[phaseOf(options)].add(listener) },
    removeEventListener(type, listener, options) { if (type === 'keydown') listeners[phaseOf(options)].delete(listener) },
    dispatchEvent() { return true },
    press(event, upper) {
      for (const listener of [...listeners.capture]) {
        listener(event)
        if (event.stopped) return event
      }
      upper?.(event)
      if (!event.stopped) for (const listener of [...listeners.bubble]) listener(event)
      return event
    },
  }
}

/** 键盘事件替身；target 是焦点元素。 */
function keyEvent(target, init) {
  return {
    type: 'keydown', key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false,
    defaultPrevented: false, stopped: false, composedPath: () => [target],
    preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...init,
  }
}

/** installAskKeys 要的上下文：主区是会话 s1，输入框的状态和会话在不在运行由 state 决定。 */
function keysContext(app, state) {
  return {
    ...app,
    ctx: {
      ...app.ctx,
      layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
      uiSession: { adapter: { current: { getSnapshot: () => ({ key: 's1' }) } } },
      sessions: { binding: () => ({ ctx: {}, session: { getSnapshot: () => ({ running: state.running }) } }) },
      conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ phase: 'plain', draft: state.draft, attachmentIds: [], occurrences: [] }) } }) } },
    },
  }
}

test('Esc 在冒泡阶段回答「在当前会话处理」：上层收起了东西、焦点在输入框里（有字没字都算）、菜单开着、会话在运行、别的会话都不管', async (t0) => {
  const host = fakeHost()
  const document = fakeDocument()
  const window = phasedWindow()
  const { client, react, app } = await mountTurn(t0, { host, document, window })
  const state = { running: false, draft: '' }
  t0.after(client.get('installAskKeys')(keysContext(app, state)))
  const conversation = new FakeElement({ selectors: ['[data-conversation-session]'], attributes: { 'data-conversation-session': 's1' } })
  const onPage = new FakeElement({ selectors: ['button'], parent: conversation })
  const composer = new FakeElement({ selectors: ['textarea'], parent: new FakeElement({ selectors: ['[data-input-scroll]'], parent: conversation }) })
  const other = new FakeElement({ selectors: ['button'], parent: new FakeElement({ selectors: ['[data-conversation-session]'], attributes: { 'data-conversation-session': 's2' } }) })
  const esc = { key: 'Escape', code: 'Escape' }
  const press = async (target, upper) => {
    window.press(keyEvent(target, esc), upper)
    await react.settle()
    return host.requests.length
  }
  // 轮次导航挂在 document 上的 Esc：预览开着时收起它，并 preventDefault。
  assert.equal(await press(onPage, event => { event.preventDefault() }), 0, '上层收起了东西')
  state.draft = '还在写'
  assert.equal(await press(composer), 0, '输入框里有字')
  state.draft = ''
  document.overlays = [new FakeElement({ selectors: ['[role="menu"]'] })]
  assert.equal(await press(onPage), 0, '菜单开着')
  document.overlays = []
  state.running = true
  assert.equal(await press(onPage), 0, '会话在运行')
  state.running = false
  assert.equal(await press(other), 0, '别的会话')
  // DSH 连按两下 Esc 停止这一轮，焦点多半在输入框里：这一轮刚好停下时，那一下不能替用户选。
  assert.equal(await press(composer), 0, '空的输入框')
  assert.equal(await press(onPage), 1, '页面上')
  assert.deepEqual(host.requests.map(body => body.verb), ['here'])
})

test('按钮上的 Esc 只在焦点在页面上时标出：焦点进了输入框就收起，回到页面再标出', async (t0) => {
  const document = fakeDocument()
  const conversation = new FakeElement({ selectors: ['[data-conversation-session]'], attributes: { 'data-conversation-session': 's1' } })
  const composer = new FakeElement({ selectors: ['textarea'], parent: new FakeElement({ selectors: ['[data-input-scroll]'], parent: conversation }) })
  document.activeElement = composer
  const { client, react } = await mountTurn(t0, { document })
  const escHints = () => react.all(node => node.type === 'ui.ShortcutKeys' && node.props.keys.includes('Esc')).length
  assert.equal(escHints(), 0, '焦点在输入框里')
  document.activeElement = new FakeElement({ selectors: ['button'], parent: conversation })
  client.window.dispatchEvent({ type: 'focusin' })
  await react.settle()
  assert.equal(escHints(), 1, '焦点回到页面上')
  document.activeElement = composer
  client.window.dispatchEvent({ type: 'focusin' })
  await react.settle()
  assert.equal(escHints(), 0, '又进了输入框')
})

test('同一会话开着两张卡片 A（复制出来的侧栏标签），关掉一张，另一张照样接 Esc', async (t0) => {
  const host = fakeHost()
  const client = loadClient(CLIENT, { fetch: host.fetch, document: fakeDocument(), Element: FakeElement })
  const { react } = client
  const app = { t, ctx: { get: () => undefined } }
  const { createElement, Fragment } = react.React
  const card = () => createElement(client.get('AskTurnCard'), { app, card: pendingA, sessionId: 's1', latestTurn: 2, useSessionStatus: () => undefined })
  // 第二张换成 null 占位：第一张留在原位，不重挂（替身库按位置对应子节点）。
  const cards = second => createElement(Fragment, null, card(), second ? card() : null)
  react.mount(cards(true))
  t0.after(() => react.unmount())
  await react.settle()
  t0.after(client.get('installAskKeys')(keysContext(app, { running: false, draft: '' })))
  react.update(cards(false))
  await react.settle()
  assert.equal(react.instancesOf(client.get('AskTurnCard')).length, 1)
  const conversation = new FakeElement({ selectors: ['[data-conversation-session]'], attributes: { 'data-conversation-session': 's1' } })
  client.window.dispatchEvent(keyEvent(new FakeElement({ selectors: ['button'], parent: conversation }), { key: 'Escape', code: 'Escape' }))
  await react.settle()
  assert.deepEqual(host.requests.map(body => body.verb), ['here'])
})

test('同一会话开着两份卡片 A，关掉后挂上的那份，⌘↵ 仍交给留下的那份，出错也写在它上面', async (t0) => {
  const host = fakeHost([{ status: 500, body: { ok: false, error: { code: 'start-failed' } } }])
  const client = loadClient(CLIENT, { fetch: host.fetch })
  const { react } = client
  const app = { t, ctx: { get: () => undefined } }
  const { createElement, Fragment } = react.React
  const card = () => createElement(client.get('AskTurnCard'), { app, card: pendingA, sessionId: 's1', latestTurn: 2, useSessionStatus: () => undefined })
  // 第二份换成 null 占位：第一份留在原位，不重挂（替身库按位置对应子节点）。
  const cards = second => createElement(Fragment, null, card(), second ? card() : null)
  react.mount(cards(true))
  t0.after(() => react.unmount())
  await react.settle()
  react.update(cards(false))
  await react.settle()
  assert.equal(react.instancesOf(client.get('AskTurnCard')).length, 1)
  assert.equal(client.get('nextStepOf')('s1'), 'card:a1')
  assert.equal(client.get('runNextStep')('s1'), true)
  await react.settle()
  assert.deepEqual(host.requests.map(body => body.verb), ['start'])
  assert.deepEqual(react.all(node => node.props?.role === 'alert').map(textOf), ['scard.error.start-failed'])
})

test('工具行按 DSH 的三个阶段写：运行中、卡片待处理时还在问；开了会话、按设置处理的照结果写；卡片 B 照旧', async (t0) => {
  const client = loadClient(CLIENT)
  const { react } = client
  // 字段照 rc.3 dsh-client-ui-conversation 的 StartedToolCall（argsRaw）和 ToolResultNode（call.argsRaw、isError、meta）。
  const row = (phase, block) => {
    react.mount(react.React.createElement(client.get('SessionCardToolRow'), { app: { t }, phase, block: { args: { text: () => '整理发布说明' }, ...block } }))
    return react.one(node => node.type === 'ui.DisclosureRow', '工具行').props.title
  }
  t0.after(() => react.unmount())
  const asking = JSON.stringify({ title: '整理发布说明', brief: 'b', ask: true })
  const plain = JSON.stringify({ title: '整理发布说明', brief: 'b' })
  assert.equal(row('preparing', {}), 'scard.toolRow')
  assert.equal(row('start', { argsRaw: asking }), 'ask.row.asking')
  assert.equal(row('start', { argsRaw: plain }), 'scard.toolRow')
  assert.equal(row('start', { argsRaw: '{"title":"整理' }), 'scard.toolRow')
  const result = (meta, isError = false) => ({ call: { name: 'propose_session', argsRaw: asking }, isError, ...(meta === undefined ? {} : { meta }) })
  assert.equal(row('result', result({ ok: true, card: { title: '整理发布说明', brief: 'b', options: {}, kind: 'ask' } })), 'ask.row.asking', '卡片待处理')
  assert.equal(row('result', result({ ok: true, card: { kind: 'ask', ask: { choice: 'new', auto: 'setting' }, started: { childId: 'c9' } } })), 'ask.row.new')
  assert.equal(row('result', result({ ok: true, card: { kind: 'ask', ask: { choice: 'here', auto: 'setting' } } })), 'ask.row.hereSetting')
  assert.equal(row('result', result({ ok: true, card: { kind: 'ask', ask: { choice: 'here', custom: '先只对 CHANGELOG' } } })), 'ask.row.hereOther', '上一版自己打字回复')
  assert.equal(row('result', result(undefined, true)), 'scard.toolRow', '被拒或出错')
  assert.equal(row('result', result({ ok: true, card: { kind: 'ask', ask: { choice: 'new', auto: 'setting' }, started: { childId: 'c9' } } }, true)), 'scard.toolRow', '结果标成出错，meta 还是成功的样子')
  assert.equal(row('result', { call: { name: 'propose_session', argsRaw: plain }, isError: false, meta: { ok: true, card: { title: '整理发布说明', brief: 'b', options: {} } } }), 'scard.toolRow')
})

test('设置的下拉按钮，读屏名称是设置名加当前选的值（WorkbenchSelect）', async (t0) => {
  const client = loadClient(CLIENT, { fetch: async () => Response.json({ ownSession: 'always-here' }) })
  const { react } = client
  react.mount(react.React.createElement(client.get('AskPrefsEntry'), { app: { t, ctx: {} }, view: 'page' }))
  t0.after(() => react.unmount())
  await react.settle()
  // 触发按钮是 ui.Menu 的 anchor 属性（替身库不把属性里的元素渲染进树）；设置名的 span 在树里。
  const trigger = react.one(node => node.type === 'ui.Menu', '设置的下拉菜单').props.anchor
  const inTrigger = [trigger.props.children].flat().filter(child => child?.props?.id !== undefined)
  const nameOf = id => {
    const own = inTrigger.find(child => child.props.id === id)
    return own === undefined ? textOf(react.one(node => node.props?.id === id, `id 为 ${id} 的元素`)) : own.props.children
  }
  assert.deepEqual(String(trigger.props['aria-labelledby']).split(/\s+/).map(nameOf), ['ask.setting.label', 'ask.setting.always-here'])
})

test('插件页那一行：读出当前设置，选了就存；读不到、存不进都写明', async (t0) => {
  const posted = []
  let stored = { ownSession: 'ask' }
  let failPost = false
  const fetch = async (url, init) => {
    assert.equal(String(url), 'api/dsh-workbench.session-cards.prefs')
    if (init?.method !== 'POST') return Response.json(stored)
    const body = JSON.parse(init.body)
    posted.push(body)
    if (failPost) return Response.json({ ok: false, message: 'disk full' }, { status: 400 })
    stored = body
    return Response.json({ ok: true, config: body })
  }
  const client = loadClient(CLIENT, { fetch })
  const { react } = client
  const app = { t, ctx: {} }
  react.mount(react.React.createElement(client.get('AskPrefsEntry'), { app, view: 'page' }))
  t0.after(() => react.unmount())
  await react.settle()
  const menu = () => react.one(node => node.type === 'ui.Menu', '设置的下拉菜单')
  assert.equal(menu().props.selectedId, 'ask')
  assert.deepEqual(menu().props.items.map(item => item.id), ['ask', 'always-new', 'always-here'])
  menu().props.onSelect('always-new')
  await react.settle()
  assert.deepEqual(posted, [{ ownSession: 'always-new' }])
  assert.equal(menu().props.selectedId, 'always-new')
  failPost = true
  menu().props.onSelect('always-here')
  await react.settle()
  assert.equal(menu().props.selectedId, 'always-new')
  assert.deepEqual(react.all(node => node.props?.role === 'alert').map(textOf), ['ask.setting.saveFailed'])
  react.unmount()

  const broken = loadClient(CLIENT, { fetch: async () => Response.json({ ownSession: 'sometimes' }) })
  broken.react.mount(broken.react.React.createElement(broken.get('AskPrefsEntry'), { app, view: 'page' }))
  await broken.react.settle()
  assert.deepEqual(broken.react.all(node => node.props?.role === 'alert').map(textOf), ['ask.setting.loadFailed'])
  broken.react.unmount()
})

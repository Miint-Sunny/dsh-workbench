import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPaletteController, paletteCapacity, paletteFilter, paletteGroups, paletteItems, paletteKeyCapture,
  paletteSearchableCommands, paletteShortcutEnabled, paletteShortcutInvocation, paletteShortcutItems,
} from '../src/client/command-palette-model.js'

const bound = Array.from({ length: 8 }, (_, index) => ({
  id: `bound-${index}`, label: `Bound ${index}`, keys: ['⌘', String(index)], aria: `Meta+${index}`, aliases: [],
}))
const unbound = { id: 'unbound', label: 'Unbound search', keys: [], aliases: [] }
const catalog = [unbound, ...bound]
const fixed = { id: 'fixed', label: 'Fixed', keys: ['Enter'], aliases: [] }

test('听按键时 Tab、方向键和 Enter 还能选行，组字放过，其余的键都算查询', () => {
  const type = (event) => paletteKeyCapture(event).type
  for (const key of ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']) {
    assert.equal(type({ key, code: key }), 'pass')
  }
  assert.equal(type({ key: 'Tab', code: 'Tab', shiftKey: true }), 'pass')
  assert.equal(type({ key: 'b', code: 'KeyB', metaKey: true, isComposing: true }), 'pass')
  assert.equal(type({ key: 'Process', code: 'KeyB', metaKey: true, keyCode: 229 }), 'pass')
  assert.deepEqual(paletteKeyCapture({ key: 'b', code: 'KeyB' }), { type: 'binding', binding: { code: 'KeyB', modifiers: [] } })
  assert.deepEqual(paletteKeyCapture({ key: 'k', code: 'KeyK', metaKey: true }),
    { type: 'binding', binding: { code: 'KeyK', modifiers: ['meta'] } })
  assert.deepEqual(paletteKeyCapture({ key: 'b', code: 'KeyB', metaKey: true, altKey: true, shiftKey: true, ctrlKey: true }),
    { type: 'binding', binding: { code: 'KeyB', modifiers: ['control', 'alt', 'shift', 'meta'] } })
  assert.deepEqual(paletteKeyCapture({ key: 'a', code: 'KeyA', metaKey: true }),
    { type: 'binding', binding: { code: 'KeyA', modifiers: ['meta'] } })
  assert.equal(type({ key: 'Enter', code: 'Enter', metaKey: true }), 'binding')
})

test('Esc 退出听按键；单按修饰键报告按着什么，松开后报告还剩什么', () => {
  assert.equal(paletteKeyCapture({ key: 'Escape', code: 'Escape' }).type, 'exit')
  assert.equal(paletteKeyCapture({ key: 'Escape', code: 'Escape', metaKey: true }).type, 'binding')
  assert.deepEqual(paletteKeyCapture({ key: 'Meta', code: 'MetaLeft', metaKey: true }), { type: 'modifier', modifiers: ['meta'] })
  assert.deepEqual(paletteKeyCapture({ key: 'Meta', code: 'MetaLeft' }), { type: 'modifier', modifiers: [] })
  assert.deepEqual(paletteKeyCapture({ key: 'Alt', code: 'AltLeft', altKey: true, metaKey: true }),
    { type: 'modifier', modifiers: ['alt', 'meta'] })
  assert.deepEqual(paletteKeyCapture({ key: 'Control', code: 'ControlRight', ctrlKey: true }), { type: 'modifier', modifiers: ['control'] })
})

test('按键查询打开时，打开命令面板的快捷键不执行，⌘K 留给查询', () => {
  const context = { region: 'editable', modal: 'other', ownDialog: true }
  assert.equal(paletteShortcutEnabled(context, true), true)
  assert.equal(paletteShortcutEnabled(context, true, true), false)
})

test('面板的搜索和官方窗口一样，也匹配英文别名和按键', () => {
  const rows = paletteItems({ hasSession: false, actions: [
    { id: 'browser.open', label: '浏览器', shortcut: { id: 'browser.open', keys: ['⌘', 'T'], aria: 'Meta+T', aliases: ['browser'] } },
    { id: 'sidebar.left', label: '展开 / 收起左侧栏', shortcut: { id: 'sidebar.left', keys: ['⌘', 'B'], aria: 'Meta+B', aliases: [] } },
    { id: 'sidebar.split', label: '分栏', shortcut: { id: 'sidebar.split', keys: ['⌘', '\\'], aria: 'Meta+\\', aliases: [] } },
    { id: 'none', label: '归档', shortcut: { id: 'none', keys: [], aliases: [] } },
  ] })
  const names = (query) => paletteFilter(rows, query, 'action').map((row) => row.name)
  assert.deepEqual(names('b'), ['browser.open', 'sidebar.left'])
  assert.deepEqual(names('browser'), ['browser.open'])
  for (const query of ['⌘b', '⌘+b', 'cmd+b', 'cmdb']) assert.deepEqual(names(query), ['sidebar.left'])
  assert.deepEqual(names('归档'), ['none'])
})

test('快捷键一项列出全部命令和固定按键，有快捷键的在前；按住修饰键只留用它的行，按下组合只留 conflicts 里的', () => {
  const rows = paletteShortcutItems(catalog, [fixed])
  assert.deepEqual(paletteGroups(rows, '', 'shortcut')[0].items.map((row) => row.name),
    [...bound.map((row) => row.id), 'fixed', 'unbound'])
  assert.deepEqual(paletteShortcutItems(catalog, [fixed], { conflicts: ['bound-1', 'fixed', 'removed'] })
    .map((row) => [row.name, row.fixed]), [['bound-1', false], ['fixed', true]])
  assert.deepEqual(paletteShortcutItems(catalog, [fixed], { conflicts: [] }), [])
  assert.deepEqual(paletteShortcutItems(catalog, [fixed], undefined, ['⌘']).map((row) => row.name), bound.map((row) => row.id))
  assert.deepEqual(paletteShortcutItems(catalog, [fixed], { conflicts: ['fixed'] }, ['⌘']).map((row) => row.name), bound.map((row) => row.id))
  assert.deepEqual(paletteShortcutItems(catalog, [fixed], undefined, ['⌥', '⌘']), [])
})

test('全部视图不搜索时不列命令；搜索时列出还没出现在别处的命令', () => {
  const items = paletteItems({ hasSession: false, actions: [{ id: 'bound-0', label: 'Bound 0', shortcut: bound[0] }] })
  const commands = paletteSearchableCommands(catalog, items)
  assert.equal(commands.some((row) => row.name === 'bound-0'), false)
  assert.equal(commands.some((row) => row.name === 'bound-1'), true)
  const rows = [...items, ...commands]
  assert.equal(paletteGroups(rows, '', 'all').some((group) => group.id === 'shortcut'), false)
  assert.deepEqual(paletteGroups(rows, 'unbound', 'all').map((group) => group.id), ['shortcut'])
})

const commands = (n) => Array.from({ length: n }, (_, i) => ({ name: 'command' + i }))
const sessions = (n) => Array.from({ length: n }, (_, i) => ({ id: 's' + i, displayTitle: 'Session ' + i }))
const shape = (groups) => groups.map((group) => [group.id, group.items.length, group.total])

test('单个筛选和 / 查询列出全部结果，不留「显示全部」', () => {
  const rows = paletteItems({ commands: commands(16), sessions: sessions(8) })
  assert.deepEqual(shape(paletteGroups(rows, '', 'command')), [['command', 16, 16]])
  assert.deepEqual(shape(paletteGroups(rows, '', 'session')), [['session', 8, 8]])
  assert.deepEqual(shape(paletteGroups(rows, '/', 'all')), [['command', 16, 16]])
})

test('全部视图有空位时补给还没显示完的组，放不下才留「显示全部」', () => {
  const rows = paletteItems({ commands: commands(8), sessions: sessions(3) })
  assert.deepEqual(shape(paletteGroups(rows, '', 'all')), [['session', 3, 3], ['command', 5, 8]])
  assert.deepEqual(shape(paletteGroups(rows, '', 'all', new Set(), 12)), [['session', 3, 3], ['command', 6, 8]])
  assert.deepEqual(shape(paletteGroups(rows, '', 'all', new Set(), 13)), [['session', 3, 3], ['command', 7, 8]])
  assert.deepEqual(shape(paletteGroups(rows, '', 'all', new Set(), 14)), [['session', 3, 3], ['command', 8, 8]])
  const only = paletteItems({ commands: commands(30) })
  assert.deepEqual(shape(paletteGroups(only, 'command', 'all', new Set(), 12)), [['command', 30, 30]])
})

test('列表容量跟着窗口高度走', () => {
  assert.equal(paletteCapacity(1000), 12)
  assert.equal(paletteCapacity(500), 7)
})

const settle = () => new Promise((resolve) => setImmediate(resolve))
function recorder({ recording = async () => {}, describe = { keys: ['⌘', 'K'], conflicts: ['bound-0', 'fixed'] }, invocation, afterClose } = {}) {
  const calls = []
  let fixedSubscriptions = 0, closeFromWatch
  const controller = createPaletteController({
    target: () => undefined,
    entries: () => ({ shortcuts: catalog }),
    watch: (_refresh, _reload, close) => { closeFromWatch = close; return () => {} },
    recording: async (active) => { calls.push(active); await recording(active) },
    describeBinding: () => describe,
    fixedShortcuts: () => [fixed],
    watchFixedShortcuts: () => {
      fixedSubscriptions++
      return () => { fixedSubscriptions-- }
    },
    shortcutInvocation: invocation,
    afterClose,
  })
  return { controller, calls, subscriptions: () => fixedSubscriptions, disconnect: () => closeFromWatch() }
}

test('快捷键那一行等面板关完才执行，查找框这类自己要焦点的命令才留得住焦点', async () => {
  let finishClosing
  const order = []
  const h = recorder({
    invocation: () => ({ run: () => { order.push('run') } }),
    afterClose: () => new Promise(resolve => { finishClosing = () => { order.push('closed'); resolve() } }),
  })
  const c = h.controller
  await c.open()
  c.setKind('shortcut')
  const chosen = c.choose('shortcut:bound-0')
  await settle()
  assert.equal(c.getSnapshot().open, false)
  assert.deepEqual(order, [])
  finishClosing()
  await chosen
  assert.deepEqual(order, ['closed', 'run'])
})

test('进快捷键一项列出固定按键但不听按键，换走就不再看固定按键', async () => {
  const h = recorder()
  const c = h.controller
  await c.open()
  assert.equal(h.subscriptions(), 0)
  c.setKind('shortcut')
  assert.equal(c.getSnapshot().recording, false)
  assert.deepEqual(c.getSnapshot().fixed, [fixed])
  assert.equal(h.subscriptions(), 1)
  await settle()
  assert.deepEqual(h.calls, [])
  c.setKind('command')
  assert.deepEqual(c.getSnapshot().fixed, [])
  assert.equal(h.subscriptions(), 0)
  c.close()
})

test('点了按钮才听按键，换筛选、再点按钮、关面板和连接重置都停', async () => {
  for (const leave of [
    (h) => h.controller.setKind('command'),
    (h) => h.controller.setRecording(false),
    (h) => h.controller.close(),
    (h) => h.disconnect(),
  ]) {
    const h = recorder()
    const c = h.controller
    await c.open()
    c.setRecording(true)
    assert.equal(c.getSnapshot().recording, false, '别的筛选里不听按键')
    c.setKind('shortcut')
    c.setRecording(true)
    assert.equal(c.getSnapshot().recording, true)
    c.captureBinding({ code: 'KeyK', modifiers: ['meta'] })
    assert.deepEqual(c.getSnapshot().captured.keys, ['⌘', 'K'])
    leave(h)
    assert.equal(c.getSnapshot().recording, false)
    assert.equal(c.getSnapshot().captured, undefined)
    await settle()
    assert.deepEqual(h.calls, [true, false])
    c.close()
    assert.equal(h.subscriptions(), 0)
  }
})

test('按着 ⌘ 就显示 ⌘，按下组合换成组合；松开时留着组合，再按 ⌘ 没按字母又松开回到上一个组合', async () => {
  const h = recorder({ describe: { keys: ['⌘', 'B'], conflicts: ['bound-0'] } })
  const c = h.controller
  await c.open()
  c.setKind('shortcut')
  c.holdModifiers(['meta'])
  assert.equal(c.getSnapshot().held, undefined, '没在听按键时不显示')
  c.setRecording(true)
  c.holdModifiers(['meta'])
  assert.deepEqual(c.getSnapshot().held, ['⌘'])
  c.captureBinding({ code: 'KeyB', modifiers: ['meta'] })
  assert.equal(c.getSnapshot().held, undefined)
  assert.deepEqual(c.getSnapshot().captured.keys, ['⌘', 'B'])
  c.holdModifiers([])
  assert.deepEqual(c.getSnapshot().captured.keys, ['⌘', 'B'])
  c.holdModifiers(['meta'])
  assert.deepEqual(c.getSnapshot().held, ['⌘'])
  c.holdModifiers([])
  assert.equal(c.getSnapshot().held, undefined)
  assert.deepEqual(c.getSnapshot().captured.keys, ['⌘', 'B'])
  c.holdModifiers(['meta'])
  c.setRecording(false)
  assert.equal(c.getSnapshot().held, undefined)
  c.close()
})

test('听按键的请求还在等待时关闭，仍按 true、false 顺序释放', async () => {
  const pending = Promise.withResolvers()
  const h = recorder({ recording: (active) => (active ? pending.promise : undefined) })
  await h.controller.open()
  h.controller.setKind('shortcut')
  h.controller.setRecording(true)
  h.controller.close()
  await settle()
  assert.deepEqual(h.calls, [true])
  pending.resolve()
  await settle()
  assert.deepEqual(h.calls, [true, false])
})

test('听按键被拒绝时提示并释放，文字搜索还能用', async () => {
  const h = recorder({ recording: async (active) => { if (active) throw new Error('recording refused') } })
  await h.controller.open()
  h.controller.setKind('shortcut')
  h.controller.setRecording(true)
  await settle()
  assert.deepEqual(h.calls, [true, false])
  assert.equal(h.controller.getSnapshot().recording, false)
  assert.equal(h.controller.getSnapshot().kind, 'shortcut')
  assert.equal(h.controller.getSnapshot().notice, 'shortcutRecordingFailed')
})

test('⌘/：关着时打开并进快捷键一项，在别的项就切过去，已经在这一项就关闭；不自动听按键', async () => {
  const h = recorder()
  const c = h.controller
  c.showShortcuts()
  await settle()
  assert.equal(c.getSnapshot().open, true)
  assert.equal(c.getSnapshot().kind, 'shortcut')
  assert.equal(c.getSnapshot().recording, false)
  c.setKind('command')
  c.showShortcuts()
  assert.equal(c.getSnapshot().kind, 'shortcut')
  c.showShortcuts()
  assert.equal(c.getSnapshot().open, false)
  await c.open()
  assert.equal(c.getSnapshot().kind, 'all', '⌘K 重开回到默认的全部')
  c.close()
})

test('听按键时按 ⌘/ 也只是查询，面板不关', async () => {
  const h = recorder({ describe: { keys: ['⌘', '/'], conflicts: ['shortcuts.open'] } })
  const c = h.controller
  c.showShortcuts()
  await settle()
  c.setRecording(true)
  c.captureBinding({ code: 'Slash', modifiers: ['meta'] })
  assert.equal(c.getSnapshot().open, true)
  assert.deepEqual(c.getSnapshot().captured.conflicts, ['shortcuts.open'])
  c.close()
})

test('原生菜单调用兼容当前注册表，保留写给人看的拒绝原因', async () => {
  const context = { region: 'editable', modal: null, target: {} }
  const calls = []
  const registry = {
    commands: new Map([
      ['run', { modals: [], resolve: (value) => { assert.equal(value.source, 'menu'); return { status: 'handled' } } }],
      ['blocked', { modals: [], resolve: () => ({ status: 'blocked', reason: 'Open a session first' }) }],
      ['coded', { modals: [], resolve: () => ({ status: 'blocked', reason: 'modal' }) }],
    ]),
    invoke(id, value) { calls.push([this, id, value]) },
  }
  await paletteShortcutInvocation({ registry }, 'run', context).run()
  assert.deepEqual(calls, [[registry, 'run', context]])
  assert.equal(paletteShortcutInvocation({ registry }, 'blocked', context).reason, 'Open a session first')
  assert.equal(paletteShortcutInvocation({ registry }, 'coded', context).reason, undefined)
  assert.equal(paletteShortcutInvocation({ registry }, 'missing', context).run, undefined)
  assert.equal(paletteShortcutInvocation({ registry }, 'run', { ...context, modal: 'other' }).run, undefined)
})

test('选中命令按 Enter：能执行就关面板再执行', async () => {
  const seen = []
  const h = recorder({ invocation: () => ({ run: () => { seen.push(h.controller.getSnapshot().open) } }) })
  await h.controller.open()
  h.controller.setKind('shortcut')
  await h.controller.choose('shortcut:bound-1')
  assert.deepEqual(seen, [false])
})

test('选中命令按 Enter：被拒绝时面板不关，显示原因；换一条提示不留旧原因', async () => {
  const h = recorder({ invocation: () => ({ reason: '请先选择会话' }) })
  const c = h.controller
  await c.open()
  c.setKind('shortcut')
  await c.choose('shortcut:bound-1')
  assert.equal(c.getSnapshot().open, true)
  assert.equal(c.getSnapshot().notice, 'shortcutUnavailable')
  assert.equal(c.getSnapshot().noticeDetail, '请先选择会话')
  await c.choose('shortcut:removed')
  assert.equal(c.getSnapshot().notice, 'unavailable')
  assert.equal(c.getSnapshot().noticeDetail, undefined)
})

test('固定按键只能查，按 Enter 提示去对应界面按', async () => {
  const h = recorder({ invocation: () => assert.fail('fixed keys never run') })
  const c = h.controller
  await c.open()
  c.setKind('shortcut')
  await c.choose('shortcut:fixed')
  assert.equal(c.getSnapshot().open, true)
  assert.equal(c.getSnapshot().notice, 'shortcutFixed')
})

test('全部视图搜到的命令也能执行', async () => {
  const seen = []
  const h = recorder({ invocation: (id) => ({ run: () => { seen.push(id) } }) })
  await h.controller.open()
  await h.controller.choose('shortcut:bound-2')
  assert.deepEqual(seen, ['bound-2'])
})

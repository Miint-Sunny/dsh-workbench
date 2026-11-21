import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { USAGE_PALETTE_SLOT } from '../src/client/features.js'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const settle = () => new Promise(resolve => setImmediate(resolve))

/** Run the built client through its real root mount and capture the overlay controller. */
async function harness({ activePanelId = null, panels = [], pendingCommands = false, commands, overlays = [] } = {}) {
  const feeds = []
  const feed = initial => {
    let value = initial
    const listeners = new Set()
    const result = {
      getSnapshot: () => value,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      set: next => { value = next; for (const listener of [...listeners]) listener() },
      size: () => listeners.size,
    }
    feeds.push(result)
    return result
  }
  const cleanups = [], slots = new Map(), styles = new Set(), requests = [], opened = [], frames = new Map()
  let nextFrame = 0
  const panelInfo = feed({ activePanelId })
  const entry = { id: 'a', displayTitle: '会话 A', blank: false, retainedBy: { mainView: 1 } }
  const binding = { ctx: {}, session: { getSnapshot: () => ({ openState: 'open', running: false }) } }
  const guide = feed([{ id: 'files', providerId: 'native', kind: 'files', title: () => '文件' }])
  const catalog = feed([
    { id: 'session.new', label: '新会话' },
    { id: 'sidebar.left.toggle', label: '侧边栏' },
    { id: 'sidebar.right.toggle', label: '右侧栏' },
  ])
  const changes = feed(null)
  const usagePanels = feed([])
  const recording = []
  const registered = new Map()
  const ctx = {
    effect: callback => {
      const cleanup = callback()
      let live = true
      const dispose = () => { if (live) { live = false; cleanup?.() } }
      cleanups.push(dispose)
      return dispose
    },
    locale: { register: () => () => {}, bind: () => key => key },
    contextMenus: { register: () => () => {} },
    on: () => () => {},
    remote: { $on: (name, listener) => name === 'commands/change' ? changes.subscribe(listener) : () => {} },
    sessions: { list: feed({ byId: { a: entry } }), binding: () => binding, subagentAddress: () => undefined },
    uiSession: { adapter: { current: feed({ key: 'a' }) }, sessionStatus: feed(new Map()) },
    workspaces: { list: feed({ archivedSessionIds: [] }) },
    layout: { panelInfo, selectPanel: id => opened.push(id) },
    uiWorkspace: { startSession: (...args) => opened.push(args) },
    sidebarRightTabs: { guide: () => guide.getSnapshot(), subscribe: guide.subscribe },
    slots: {
      entriesOfSlot: name => name === USAGE_PALETTE_SLOT ? usagePanels.getSnapshot() : name === 'shell.overlay' ? overlays : panels,
      subscribe: (name, listener) => (name === USAGE_PALETTE_SLOT ? usagePanels : changes).subscribe(listener),
      inject: (_name, callback) => callback(),
      register: (options, render) => { slots.set(options.name, render); return () => slots.delete(options.name) },
    },
    shortcuts: { catalog, registry: commands && { commands }, recording: active => { recording.push(active) }, register: command => {
      registered.set(command.id, command)
      return () => registered.delete(command.id)
    } },
    commandUi: { candidates: (_session, { signal }) => {
      const request = { signal }
      requests.push(request)
      return pendingCommands
        ? new Promise(resolve => { request.finish = resolve })
        : Promise.resolve([{ name: 'review' }])
    } },
  }
  const events = { addEventListener() {}, removeEventListener() {} }
  let module
  runInNewContext(client, {
    AbortController, console,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id),
    fetch: async () => ({ ok: true, json: async () => ({ features: [{ id: 'command-palette' }, { id: 'new-tab' }] }) }),
    window: { ...events, __ModuleLoader__: { load: ({ factory }) => {
      module = factory(name => name === 'react' ? { createElement: (type, props) => ({ type, props }) } : {})
    } } },
    document: { ...events,
      createElement: () => { const style = { dataset: {}, remove: () => styles.delete(style) }; return style },
      head: { appendChild: style => styles.add(style) },
    },
  })
  module.apply(ctx)
  await settle()
  const dialog = () => slots.get('shell.overlay')().props
  const controller = dialog().controller
  return {
    controller, dialog, panelInfo, usagePanels, catalog, requests, opened, styles, frames, recording, registered,
    subscriptions: () => feeds.reduce((sum, item) => sum + item.size(), 0),
    unload: () => { for (const dispose of [...cleanups].reverse()) dispose() },
  }
}

test('侧边栏页面遮住保留的主会话时，不读命令或提供右侧栏动作；切回后重新索引', async () => {
  const h = await harness({ activePanelId: 'plugins' })
  try {
    assert.equal(h.subscriptions(), 1, '面板关着时只留 ⌘/ 接管用的目录监听')
    await h.controller.open()
    assert.equal(h.controller.getSnapshot().hasSession, false)
    assert.equal(h.requests.length, 0)
    assert.equal(h.controller.getSnapshot().items.some(row => row.kind === 'right' || row.kind === 'command' || row.requiresSession), false)
    h.panelInfo.set({ activePanelId: null })
    await settle()
    assert.equal(h.requests.length, 1)
    assert.equal(h.controller.getSnapshot().items.some(row => row.kind === 'right'), true)
    h.panelInfo.set({ activePanelId: 'usage' })
    assert.equal(h.controller.getSnapshot().hasSession, false)
    h.controller.close()
    assert.equal(h.subscriptions(), 1)
    h.panelInfo.set({ activePanelId: null })
    assert.equal(h.requests.length, 1)
  } finally { h.unload() }
})

test('侧边栏面板的字符串、函数及缺省标题均可索引和打开', async () => {
  const h = await harness({ panels: [
    { options: { id: 'literal', label: '文字标题' } },
    { options: { id: 'translated', label: () => '本地化标题' } },
    { options: { id: 'fallback' } },
  ] })
  try {
    await h.controller.open()
    const labels = Array.from(h.controller.getSnapshot().items.filter(row => row.kind === 'panel'), row => row.label)
    assert.deepEqual(labels, ['文字标题', '本地化标题', 'fallback'])
    await h.controller.choose('panel:literal')
    assert.deepEqual(h.opened, ['literal'])
  } finally { h.unload() }
})

test('命令面板根据已挂载的主区入口更新索引，不依赖导航包的功能清单', async () => {
  const h = await harness()
  try {
    const id = 'dsh-workbench-usage'
    const result = () => h.controller.getSnapshot().items.find(row => row.id === 'panel:' + id)
    await h.controller.open()
    assert.equal(result(), undefined)
    h.usagePanels.set([{ options: { id, label: () => 'Usage overview' } }])
    assert.equal(result()?.label, 'Usage overview')
    await h.controller.choose('panel:' + id)
    assert.deepEqual(h.opened, [id])
    await h.controller.open()
    h.usagePanels.set([])
    assert.equal(result(), undefined)
  } finally { h.unload() }
})

test('根客户端卸载关闭仍打开的命令面板，取消目录请求并撤销所有订阅和样式', async () => {
  const h = await harness({ pendingCommands: true })
  const opening = h.controller.open()
  assert.ok(h.subscriptions() > 0)
  h.unload()
  assert.equal(h.requests[0].signal.aborted, true)
  assert.equal(h.subscriptions(), 0)
  assert.equal(h.styles.size, 0)
  assert.equal(h.controller.getSnapshot().open, false)
  h.requests[0].finish([{ name: 'late' }])
  await opening
  assert.equal(h.controller.getSnapshot().open, false)
})

test('根客户端卸载释放仍在听按键的快捷键一项', async () => {
  const h = await harness()
  await h.controller.open()
  h.controller.setKind('shortcut')
  h.controller.setRecording(true)
  const registered = h.registered.get('dsh-workbench.command-palette')
  const context = { region: 'page', modal: null, source: 'menu' }
  assert.equal(registered.resolve(context).status, 'pass')
  h.unload()
  await settle()
  assert.deepEqual(h.recording, [true, false])
  assert.equal(h.controller.getSnapshot().recording, false)
  assert.equal(h.subscriptions(), 0)
})

test('⌘/ 进面板的快捷键一项；设置页和官方窗口开着时还是官方的；卸载后原样还回去', async () => {
  const resolve = () => ({ status: 'handled', run: 'official' })
  const command = { modals: ['settings', 'shortcuts'], resolve }
  const h = await harness({ commands: new Map([['shortcuts.open', command]]) })
  const press = modal => command.resolve({ region: 'page', modal })
  assert.equal(press('settings').run, 'official')
  assert.equal(press('shortcuts').run, 'official')
  assert.equal(press('other').run, 'official', '别的对话框开着、面板没开时不抢')
  press(null).run()
  await settle()
  assert.equal(h.controller.getSnapshot().open, true)
  assert.equal(h.controller.getSnapshot().kind, 'shortcut')
  assert.equal(h.controller.getSnapshot().recording, false)
  press('other').run()
  assert.equal(h.controller.getSnapshot().open, false, '面板自己开着时再按一次是关闭')
  h.unload()
  assert.equal(command.resolve, resolve)
  assert.deepEqual(command.modals, ['settings', 'shortcuts'])
})

test('官方命令比插件晚注册或者换了一个时，⌘/ 照样接上，旧的还回去', async () => {
  const commands = new Map()
  const h = await harness({ commands })
  const resolve = () => ({ status: 'handled', run: 'official' })
  const first = { modals: [], resolve }
  commands.set('shortcuts.open', first)
  h.catalog.set([...h.catalog.getSnapshot()])
  const wrapped = first.resolve
  assert.notEqual(wrapped, resolve)
  h.catalog.set([...h.catalog.getSnapshot()])
  assert.equal(first.resolve, wrapped, '目录变化不重复包')
  const second = { modals: [], resolve }
  commands.set('shortcuts.open', second)
  h.catalog.set([...h.catalog.getSnapshot()])
  assert.equal(first.resolve, resolve)
  assert.notEqual(second.resolve, resolve)
  h.unload()
  assert.equal(second.resolve, resolve)
  assert.deepEqual(second.modals, [])
})

test('「打开快捷键」这一行和「编辑快捷键」去官方窗口，从当前行搜起', async () => {
  const calls = []
  const store = { actions: { open: () => calls.push('open'), search: query => calls.push(query) } }
  const commands = new Map([['shortcuts.open', { modals: [], resolve: () => assert.fail('这一行不走 ⌘/ 的路由') }]])
  const h = await harness({ commands, overlays: [{ options: { id: 'shortcuts' }, store: { create: () => store } }] })
  try {
    h.catalog.set([...h.catalog.getSnapshot(), { id: 'shortcuts.open', label: '快捷键', keys: ['⌘', '/'] }])
    await h.controller.open()
    h.controller.setKind('shortcut')
    const chosen = h.controller.choose('shortcut:shortcuts.open')
    // 这一行等面板关完才执行（等两帧）。
    for (let frame = 0; frame < 2; frame += 1) {
      await settle()
      for (const [id, run] of [...h.frames]) { h.frames.delete(id); run() }
    }
    await chosen
    assert.equal(h.controller.getSnapshot().open, false)
    assert.deepEqual(calls, ['open'])
    calls.length = 0
    await h.controller.open()
    h.dialog().editShortcuts('新会话')
    assert.equal(h.controller.getSnapshot().open, false)
    assert.deepEqual(calls, ['open', '新会话'])
  } finally { h.unload() }
})

test('官方窗口不在时没有「编辑快捷键」', async () => {
  const h = await harness()
  try {
    assert.equal(h.dialog().editShortcuts, undefined)
  } finally { h.unload() }
})

test('目录读取期间切到全局页面会取消旧会话请求，迟到的命令不再进入索引', async () => {
  const h = await harness({ pendingCommands: true })
  try {
    const opening = h.controller.open()
    h.panelInfo.set({ activePanelId: 'plugins' })
    assert.equal(h.requests[0].signal.aborted, true)
    h.requests[0].finish([{ name: 'late' }])
    await opening
    assert.equal(h.controller.getSnapshot().items.some(row => row.kind === 'command'), false)
  } finally { h.unload() }
})

test('创建草稿已排到下一帧时根客户端卸载会撤销导航', async () => {
  const h = await harness()
  await h.controller.open()
  h.controller.compose('保留这段文字')
  assert.equal(h.frames.size, 1)
  h.unload()
  assert.equal(h.frames.size, 0)
  assert.deepEqual(h.opened, [])
})

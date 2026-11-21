/**
 * 切换 Agent 预设（feat#162）的网页部分：会话顶栏的 Agent 预设标签、菜单、确认框、两步切换和错误、
 * 确认框开着时的 ⌘↵。组件在替身 React 里跑构建好的 lib/client.js；宿主是照宿主和网页的约定（GET 菜单数据、
 * GET 预览、POST compact／switch，见 src/client/preset-switch-model.js 开头）回答的替身 fetch，POST 先挂起，由测试决定什么时候、怎么回答。看起来对不对（深浅色、宽窄）要在浏览器里看。
 * 文案用替身 t：回键名加参数，断言时看得出是哪条、带了什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const SESSION = 'session-a'
const CODING = 'dsh-workbench-coding'
const FULL = 'dsh-workbench-full'
const TARGETS = [
  { id: 'standard', name: '标准模式', description: '处理代码、文件和资料，适合大多数任务。' },
  { id: CODING, name: '代码模式', description: '标准模式的工具，常用工具直接可用，其他工具按需加载。' },
  { id: FULL, name: '全开模式', description: '标准模式的工具，所有工具定义从一开始加载。' },
]
const MENU = { ok: true, value: { current: 'standard', switchable: true, targets: TARGETS } }
const REMOVED = ['plugin_manager', 'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']
const PREVIEW = {
  ok: true,
  value: {
    from: 'standard', to: CODING, changes: true,
    tools: { added: ['workbench_discover_tools'], removed: REMOVED },
    systemPrompt: 'unchanged', uncachedTokens: 118000, compactSuggested: true, runningSubagents: 2,
  },
}

/** 列表的分隔符是标点，不是文案：照中文词典给「、」，断言里看得出名字。 */
const t = (key, params) => (key === 'pswitch.confirm.listSeparator' ? '、' : params === undefined ? key : `${key}${JSON.stringify(params)}`)

/**
 * 替身宿主：照接口.md 回答三条路由，记下每个请求。GET 按 host.menu、host.preview 回答（undefined 是路由不在：404 且不是 JSON；
 * Error 是网络错误）；POST 挂起，等测试调 host.posts[i].resolve(回答)。
 */
function createHost(options = {}) {
  // 给了 undefined 也算给了（路由不在），所以不用参数默认值。
  const host = { menu: Object.hasOwn(options, 'menu') ? options.menu : MENU, preview: Object.hasOwn(options, 'preview') ? options.preview : PREVIEW, requests: [], posts: [] }
  host.fetch = async (url, init = {}) => {
    const target = new URL(String(url), 'http://dsh.test/')
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    host.requests.push({ method, path: target.pathname, query: Object.fromEntries(target.searchParams), body, contentType: headers['content-type'] })
    let answer
    if (method === 'GET' && target.pathname === '/api/dsh-workbench.preset-switch') answer = host.menu
    else if (method === 'GET' && target.pathname === '/api/dsh-workbench.preset-switch/preview') answer = host.preview
    else if (method === 'POST' && target.pathname === '/api/dsh-workbench.preset-switch') answer = await new Promise(resolve => host.posts.push({ body, resolve }))
    if (answer instanceof Error) throw answer
    if (answer === undefined) return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <') } }
    return { ok: true, status: 200, json: async () => structuredClone(answer) }
  }
  host.gets = path => host.requests.filter(request => request.method === 'GET' && request.path === path)
  return host
}

/** 元素树（没渲染出来的属性里的元素，比如 ui.Menu 的 anchor、ui.Modal 的 footer）里按条件找元素。 */
function findElements(element, predicate, out = []) {
  if (Array.isArray(element)) {
    for (const child of element) findElements(child, predicate, out)
    return out
  }
  if (element === null || typeof element !== 'object' || element.props === undefined) return out
  if (predicate(element)) out.push(element)
  findElements(element.props.children, predicate, out)
  return out
}

/** 元素树里的文字。 */
function elementText(element) {
  if (Array.isArray(element)) return element.map(elementText).join('')
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object' || element.props === undefined) return ''
  return elementText(element.props.children)
}

/**
 * 挂一个会话顶栏的标签。state 是会话的情况（日志投影里的预设、运行中、待处理的交互），改了以后调 rerender。
 * 给了 undefined 也算给了：menu、preview 是 undefined 时路由不在，preset 是 undefined 时会话没有记录预设。
 * @param {{menu?: object, preview?: object, preset?: string, document?: object, Element?: Function}} [options] 替身宿主的回答、会话的预设、替身 DOM。
 */
function setup(options = {}) {
  const { document, Element } = options
  const preset = Object.hasOwn(options, 'preset') ? options.preset : 'standard'
  const host = createHost(options)
  const client = loadClient(CLIENT, { fetch: host.fetch, ...(document === undefined ? {} : { document }), ...(Element === undefined ? {} : { Element }) })
  const { react } = client
  const h = react.React.createElement
  const ui = react.ui
  const Header = client.get('PresetSwitchHeader')
  const state = { preset, running: false, pending: undefined }
  // DSH 的预设名单：内置预设不带名字（由官方词典按 id 给名字，照 presetDisplayText），别的带自己的名字。
  const roster = [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: CODING, name: '代码模式' }, { id: FULL, name: '全开模式' }]
  const official = { presetStandardName: '标准模式', presetPtcName: 'PTC 模式', presetMinimalName: '极简模式' }
  const resets = new Set()
  // 宿主转发来的 settings/document-updated（ns 是哪份设置）。
  const settingsUpdates = new Set()
  const app = {
    t,
    ctx: {
      remote: {
        agentPresets: { list: async () => ({ ok: true, value: { presets: roster } }) },
        $on: (name, listener) => {
          if (name !== 'settings/document-updated') return () => {}
          settingsUpdates.add(listener)
          return () => { settingsUpdates.delete(listener) }
        },
      },
      locale: { bind: namespace => key => (namespace === 'settings.agentPreset' ? official[key] ?? key : key) },
      on: (name, listener) => {
        if (name !== 'connection/reset') return () => {}
        resets.add(listener)
        return () => { resets.delete(listener) }
      },
    },
  }
  const props = () => ({
    app,
    sessionId: SESSION,
    useSessions: select => select({ byId: { [SESSION]: { id: SESSION, projectionValues: state.preset === undefined ? {} : { agentPreset: state.preset } } } }),
    useSession: select => select({ running: state.running }),
    useSessionStatus: select => select(new Map([[SESSION, { running: state.running, pendingInteraction: state.pending }]])),
  })
  const view = {
    client, react, host, state, ui, app, resets,
    /** 宿主发出一份设置更新了。 */
    async settingsUpdated(ns) {
      for (const listener of settingsUpdates) listener(ns, 2)
      await react.settle()
    },
    async mount() {
      react.mount(h(Header, props()))
      await react.settle()
    },
    async rerender() {
      react.update(h(Header, props()))
      await react.settle()
    },
    menu: () => react.all(node => node.type === 'ui.Menu'),
    anchor: () => react.one(node => node.type === 'ui.Menu', '菜单').props.anchor,
    staticLabels: () => react.all(node => node.type === 'span' && String(node.props.className ?? '').split(' ').includes('dwb-pswitch-label')),
    modal: () => react.all(node => node.type === 'ui.Modal'),
    dialog: () => react.one(node => node.type === 'ui.Modal', '确认框'),
    /** 确认框 footer 里的按钮：[取消, 主按钮]。 */
    buttons: () => findElements(view.dialog().props.footer, element => element.type === ui.Button),
    checkbox: () => react.one(node => node.type === 'ui.Checkbox', '「先压缩上下文」'),
    /** 确认框里一栏的内容：dt 文字是 label 的那一栏后面的 dd。 */
    row(label) {
      const list = react.one(node => node.type === 'dl', '确认框的各栏')
      const cells = list.children.filter(child => typeof child !== 'string')
      const at = cells.findIndex(cell => cell.type === 'dt' && textOf(cell) === label)
      assert.ok(at >= 0 && cells[at + 1]?.type === 'dd', `没有「${label}」这一栏`)
      return textOf(cells[at + 1])
    },
    alert: () => react.all(node => node.props?.role === 'alert'),
    async open() {
      view.anchor().props.onClick()
      await react.settle()
    },
    async choose(id) {
      react.one(node => node.type === 'ui.Menu', '菜单').props.onSelect(id)
      await react.settle()
    },
    async press(button) {
      assert.notEqual(button.props.disabled, true, '点的是禁用的按钮')
      button.props.onClick()
      await react.settle()
    },
    async answer(index, value) {
      host.posts[index].resolve(value)
      await react.settle()
    },
  }
  return view
}

// ---------- 标签：能不能点 ----------

test('标签：宿主说能切换时是按钮，点开菜单；和官方一样的图标和预设名，后面多一个下拉箭头', async () => {
  const view = setup()
  await view.mount()
  assert.deepEqual(view.host.gets('/api/dsh-workbench.preset-switch').map(request => request.query), [{ sessionId: SESSION }])
  assert.equal(view.staticLabels().length, 0)
  const anchor = view.anchor()
  assert.equal(anchor.type, 'button')
  assert.equal(anchor.props.type, 'button')
  assert.equal(anchor.props['aria-haspopup'], 'menu')
  assert.equal(anchor.props['aria-expanded'], false)
  assert.equal(anchor.props['aria-label'], 'pswitch.label.aria{"name":"标准模式"}')
  assert.equal(anchor.props.title, undefined, '不做悬停弹出')
  assert.equal(findElements(anchor, element => element.type === view.ui.IconAgentPresetOutlineRegular).length, 1)
  assert.equal(findElements(anchor, element => element.type === view.ui.IconChevronDownOutlineRegular).length, 1)
  assert.match(elementText(anchor), /标准模式/)
  assert.equal(view.menu()[0].props.open, false)
})

test('标签：宿主说不能切换（PTC 模式）时照官方显示，名字取官方词典，不能点、没有箭头', async () => {
  const view = setup({ preset: 'ptc', menu: { ok: true, value: { current: 'ptc', switchable: false, targets: TARGETS } } })
  await view.mount()
  assert.equal(view.menu().length, 0)
  const [label] = view.staticLabels()
  assert.equal(textOf(label), 'PTC 模式')
  assert.equal(label.props.onClick, undefined)
  assert.equal(label.props.title, undefined, '不做悬停弹出')
  assert.equal(view.react.all(node => node.type === 'ui.IconChevronDownOutlineRegular').length, 0)
  assert.equal(view.react.all(node => node.type === 'ui.IconAgentPresetOutlineRegular').length, 1)
})

test('标签：宿主没回答（这一行的路由不在、网络错误、答案不对）时照官方显示，不能点', async () => {
  for (const [what, menu] of [['404', undefined], ['network', new TypeError('Failed to fetch')], ['ok:false', { ok: false, error: { code: 'x' } }], ['no targets', { ok: true, value: { current: 'standard', switchable: true } }]]) {
    const view = setup({ menu })
    await view.mount()
    assert.equal(view.menu().length, 0, what)
    assert.equal(textOf(view.staticLabels()[0]), '标准模式', what)
  }
})

test('标签：会话没有记录预设时什么都不显示；宿主说的预设和日志投影不一致时先不能点', async () => {
  const blank = setup({ preset: undefined })
  await blank.mount()
  assert.equal(blank.react.all(() => true).length, 0)
  assert.equal(blank.host.requests.length, 0)
  const stale = setup({ menu: { ok: true, value: { current: CODING, switchable: true, targets: TARGETS } } })
  await stale.mount()
  assert.equal(stale.menu().length, 0)
  assert.equal(textOf(stale.staticLabels()[0]), '标准模式', '名字跟着日志投影')
})

// ---------- 菜单 ----------

test('菜单：三项写宿主给的名字和说明，当前一项打勾；点外面或按 Esc（Menu 的 onClose）关闭', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  const menu = view.menu()[0]
  assert.equal(menu.props.open, true)
  assert.equal(view.anchor().props['aria-expanded'], true)
  assert.equal(menu.props.portal, true, '页头会裁掉溢出的部分，菜单要挂到 body 上')
  assert.equal(menu.props.selectedId, 'standard')
  assert.deepEqual(menu.props.items.map(item => item.id), ['standard', CODING, FULL])
  assert.deepEqual(menu.props.items.map(item => item.disabled === true), [false, false, false])
  assert.equal(menu.props.items.some(item => item.type === 'label'), false)
  assert.equal(elementText(menu.props.items[1].label), `代码模式${TARGETS[1].description}`)
  menu.props.onClose()
  await view.react.settle()
  assert.equal(view.menu()[0].props.open, false)
})

test('菜单：宿主刷新预设名单（换了界面语言）以后重读，名字和说明跟着换；别的设置更新不重读', async () => {
  const view = setup()
  await view.mount()
  const menuGets = () => view.host.gets('/api/dsh-workbench.preset-switch').length
  const before = menuGets()
  await view.settingsUpdated('locale')
  assert.equal(menuGets(), before, '只有预设名单的更新才重读')
  view.host.menu = { ok: true, value: { ...MENU.value, targets: [
    { id: 'standard', name: 'Standard mode', description: 'Work with code, files, and information.' },
    { id: CODING, name: 'Code mode', description: 'Standard mode tools; others load on demand.' },
    { id: FULL, name: 'Full mode', description: 'Standard mode tools; all load from the start.' },
  ] } }
  await view.settingsUpdated('agent-preset-registry')
  assert.equal(menuGets(), before + 1)
  await view.open()
  assert.equal(elementText(view.menu()[0].props.items[1].label), 'Code modeStandard mode tools; others load on demand.')
})

test('菜单：会话运行中或有待处理的交互时三项都不能选，顶上一行说明', async () => {
  for (const change of [state => { state.running = true }, state => { state.pending = { kind: 'approval' } }, state => { state.pending = { kind: 'question' } }]) {
    const view = setup()
    await view.mount()
    change(view.state)
    await view.rerender()
    await view.open()
    const items = view.menu()[0].props.items
    assert.deepEqual(items[0], { type: 'label', id: 'busy', text: 'pswitch.menu.busy' })
    assert.deepEqual(items.slice(1).map(item => [item.id, item.disabled]), [['standard', true], [CODING, true], [FULL, true]])
    await view.choose(CODING)
    assert.equal(view.host.gets('/api/dsh-workbench.preset-switch/preview').length, 0, '不能选的项点了也不做事')
    assert.equal(view.host.posts.length, 0)
  }
})

test('菜单：选当前这一项什么都不做', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose('standard')
  assert.equal(view.menu()[0].props.open, false)
  assert.equal(view.host.gets('/api/dsh-workbench.preset-switch/preview').length, 0)
  assert.equal(view.host.posts.length, 0)
  assert.equal(view.modal().length, 0)
})

// ---------- 选了别的预设 ----------

test('工具和系统提示词都没有变化（changes 为 false）时不弹框，直接切换', async () => {
  const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, to: FULL, changes: false, tools: { added: [], removed: [] } } } })
  await view.mount()
  await view.open()
  await view.choose(FULL)
  assert.deepEqual(view.host.gets('/api/dsh-workbench.preset-switch/preview').map(request => request.query), [{ sessionId: SESSION, agentPreset: FULL }])
  assert.equal(view.modal().length, 0)
  assert.deepEqual(view.host.posts.map(post => post.body), [{ sessionId: SESSION, agentPreset: FULL, step: 'switch', expectedFrom: 'standard' }], '直接切换也带上用户这次看到的来源预设')
  assert.equal(view.host.requests.at(-1).contentType, 'application/json')
  await view.answer(0, { ok: true, value: { agentPreset: FULL } })
  assert.equal(view.modal().length, 0)
})

test('直接切换失败时打开确认框，写出错误，按钮是「重试」', async () => {
  const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, to: FULL, changes: false, tools: { added: [], removed: [] } } } })
  await view.mount()
  await view.open()
  await view.choose(FULL)
  await view.answer(0, { ok: false, error: { code: 'switch-failed', current: 'standard' } })
  assert.equal(view.dialog().props.title, 'pswitch.confirm.title{"name":"全开模式"}')
  assert.equal(textOf(view.alert()[0]), 'pswitch.error.failed{"name":"标准模式"}')
  assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.retry')
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => post.body.step), ['switch', 'switch'])
})

test('确认框：标题、说明、工具（可展开名字）、系统提示词、缓存未命中、默认勾上的「先压缩上下文」、子智能体、两个按钮', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose(CODING)
  assert.deepEqual(view.host.gets('/api/dsh-workbench.preset-switch/preview').map(request => request.query), [{ sessionId: SESSION, agentPreset: CODING }])
  assert.equal(view.host.posts.length, 0, '确认之前不切换')
  const dialog = view.dialog()
  assert.equal(dialog.props.open, true)
  assert.equal(dialog.props.title, 'pswitch.confirm.title{"name":"代码模式"}')
  assert.equal(dialog.props.description, 'pswitch.confirm.description')
  const text = textOf(dialog)
  assert.match(view.row('pswitch.confirm.tools'), /^pswitch\.confirm\.toolsChanged\{"added":1,"removed":5\}/)
  assert.equal(view.row('pswitch.confirm.systemPrompt'), 'pswitch.confirm.unchanged')
  assert.equal(view.row('pswitch.confirm.cacheMiss'), 'pswitch.confirm.tokens{"tokens":"pswitch.number.thousand{\\"value\\":\\"118\\"}"}')
  assert.match(text, /pswitch\.confirm\.compactHint/)
  assert.match(text, /pswitch\.confirm\.subagents\{"count":2\}/)
  assert.doesNotMatch(text, /workbench_discover_tools/, '名字先收着')
  assert.equal(view.checkbox().props.checked, true, 'compactSuggested：默认勾上')
  assert.equal(view.checkbox().props.label, 'pswitch.confirm.compact')
  assert.deepEqual(view.buttons().map(elementText), ['pswitch.confirm.cancel', 'pswitch.confirm.switch{"name":"代码模式"}'])
  assert.equal(view.buttons()[1].props.variant, 'primary')
  // 展开、收起工具的名字。
  const more = view.react.one(node => node.type === 'button' && textOf(node) === 'pswitch.confirm.expand', '「展开」')
  assert.equal(more.props['aria-expanded'], false)
  view.react.fire(more, 'onClick')
  await view.react.settle()
  const expanded = textOf(view.dialog())
  assert.match(expanded, /pswitch\.confirm\.toolsAddedNames\{"names":"workbench_discover_tools"\}/)
  assert.match(expanded, /pswitch\.confirm\.toolsRemovedNames\{"names":"plugin_manager、schedule_create、schedule_edit、schedule_list、schedule_view"\}/)
  view.react.fire(view.react.one(node => node.type === 'button' && textOf(node) === 'pswitch.confirm.collapse', '「收起」'), 'onClick')
  await view.react.settle()
  assert.doesNotMatch(textOf(view.dialog()), /workbench_discover_tools/)
})

test('确认框：系统提示词三种写法；只增或只减工具；没有子智能体时不写那一行；没建议压缩时不勾', async () => {
  const cases = [
    [{ systemPrompt: 'replaced', tools: { added: ['a'], removed: [] }, runningSubagents: 0, compactSuggested: false }, 'pswitch.confirm.prompt.replaced', 'pswitch.confirm.toolsAdded{"count":1}pswitch.confirm.expand'],
    [{ systemPrompt: 'appended', tools: { added: [], removed: ['b', 'c'] }, runningSubagents: 0, compactSuggested: false }, 'pswitch.confirm.prompt.appended', 'pswitch.confirm.toolsRemoved{"count":2}pswitch.confirm.expand'],
    [{ systemPrompt: 'appended', tools: { added: [], removed: [] }, runningSubagents: 0, compactSuggested: false }, 'pswitch.confirm.prompt.appended', 'pswitch.confirm.unchanged'],
  ]
  for (const [patch, prompt, tools] of cases) {
    const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, uncachedTokens: 14000, ...patch } } })
    await view.mount()
    await view.open()
    await view.choose(FULL)
    assert.equal(view.row('pswitch.confirm.systemPrompt'), prompt)
    assert.equal(view.row('pswitch.confirm.tools'), tools, '工具没有增减时没有「展开」')
    assert.equal(view.row('pswitch.confirm.cacheMiss'), 'pswitch.confirm.tokens{"tokens":"pswitch.number.thousand{\\"value\\":\\"14\\"}"}')
    assert.doesNotMatch(textOf(view.dialog()), /pswitch\.confirm\.subagents/)
    assert.equal(view.checkbox().props.checked, false)
  }
})

test('确认框：宿主算不出来的字段（null）写「无法估算」，子智能体不写个数，仍然可以切换；取不到预览时同样处理', async () => {
  for (const preview of [
    { ok: true, value: { from: 'standard', to: CODING, changes: true, tools: null, systemPrompt: null, uncachedTokens: null, compactSuggested: false, runningSubagents: null } },
    undefined,
  ]) {
    const view = setup({ preview })
    await view.mount()
    await view.open()
    await view.choose(CODING)
    for (const row of ['pswitch.confirm.tools', 'pswitch.confirm.systemPrompt', 'pswitch.confirm.cacheMiss']) assert.equal(view.row(row), 'pswitch.confirm.unknown', row)
    // 数不清有没有运行中的子智能体，就照样提醒它们保持原预设，不写个数，也不当作没有。
    assert.match(textOf(view.dialog()), /pswitch\.confirm\.subagentsUnknown/)
    assert.doesNotMatch(textOf(view.dialog()), /pswitch\.confirm\.subagents\{/)
    assert.equal(view.checkbox().props.checked, false)
    await view.press(view.buttons()[1])
    // 预览取不到时没有 from：用用户选的时候标签上显示的预设。
    assert.deepEqual(view.host.posts.map(post => post.body), [{ sessionId: SESSION, agentPreset: CODING, step: 'switch', expectedFrom: 'standard' }])
  }
})

test('确认框：取消关框，不切换', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose(CODING)
  await view.press(view.buttons()[0])
  assert.equal(view.modal().length, 0)
  assert.equal(view.host.posts.length, 0)
})

// ---------- 两步 ----------

test('两步：勾着「先压缩上下文」先发 compact（「正在压缩上下文…」），成功后发 switch（「切换中…」），进行中不能取消；成功后关框，重读菜单', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose(CODING)
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => post.body), [{ sessionId: SESSION, agentPreset: CODING, step: 'compact', expectedFrom: 'standard' }])
  assert.equal(view.host.requests.at(-1).contentType, 'application/json')
  let [cancel, primary] = view.buttons()
  assert.equal(elementText(primary), 'pswitch.confirm.compacting')
  assert.equal(primary.props.disabled, true)
  assert.equal(cancel.props.disabled, true)
  assert.equal(view.checkbox().props.disabled, true)
  view.dialog().props.onClose()
  await view.react.settle()
  assert.equal(view.modal().length, 1, '进行中按 Esc、点遮罩不关')
  await view.answer(0, { ok: true })
  assert.deepEqual(view.host.posts.map(post => post.body.step), ['compact', 'switch'])
  assert.deepEqual(view.host.posts[1].body, { sessionId: SESSION, agentPreset: CODING, step: 'switch', expectedFrom: 'standard' });
  [cancel, primary] = view.buttons()
  assert.equal(elementText(primary), 'pswitch.confirm.switching')
  assert.equal(primary.props.disabled, true)
  assert.equal(cancel.props.disabled, true)
  const before = view.host.gets('/api/dsh-workbench.preset-switch').length
  await view.answer(1, { ok: true, value: { agentPreset: CODING } })
  assert.equal(view.modal().length, 0)
  assert.ok(view.host.gets('/api/dsh-workbench.preset-switch').length > before, '切换成功后重读菜单')
})

test('两步：没勾「先压缩上下文」只发 switch', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose(CODING)
  view.checkbox().props.onChange(false)
  await view.react.settle()
  assert.equal(view.checkbox().props.checked, false)
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => post.body.step), ['switch'])
  assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.switching')
})

test('切换成功后标签换成新预设（跟着日志投影），菜单按新预设重读', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose(CODING)
  view.checkbox().props.onChange(false)
  await view.react.settle()
  await view.press(view.buttons()[1])
  view.host.menu = { ok: true, value: { current: CODING, switchable: true, targets: TARGETS } }
  await view.answer(0, { ok: true, value: { agentPreset: CODING } })
  view.state.preset = CODING
  await view.rerender()
  assert.equal(view.anchor().props['aria-label'], 'pswitch.label.aria{"name":"代码模式"}')
  assert.equal(view.menu()[0].props.selectedId, CODING)
})

// ---------- 错误 ----------

/** 打开确认框，按 compact 勾不勾选好，点主按钮。 */
async function confirmWith(view, { compact }) {
  await view.mount()
  await view.open()
  await view.choose(CODING)
  view.checkbox().props.onChange(compact)
  await view.react.settle()
  await view.press(view.buttons()[1])
}

test('错误：压缩失败不切换，写明当前会话仍为原预设；重试从压缩开始', async () => {
  const view = setup()
  await confirmWith(view, { compact: true })
  await view.answer(0, { ok: false, error: { code: 'compact-failed', current: 'standard' } })
  assert.deepEqual(view.host.posts.map(post => post.body.step), ['compact'], '压缩失败不发 switch')
  assert.equal(textOf(view.alert()[0]), 'pswitch.error.compact-failed{"name":"标准模式"}')
  const [cancel, primary] = view.buttons()
  assert.equal(elementText(primary), 'pswitch.confirm.retry')
  assert.notEqual(cancel.props.disabled, true)
  await view.press(primary)
  assert.deepEqual(view.host.posts.map(post => post.body.step), ['compact', 'compact'])
  assert.equal(view.alert().length, 0, '重试时先清掉上一次的错误')
})

test('错误：切换这一步的每种代码各写各的文字，按钮变「重试」', async () => {
  const cases = [
    ['not-idle', 'pswitch.error.not-idle'],
    ['busy', 'pswitch.error.busy'],
    ['unsupported', 'pswitch.error.unsupported{"name":"代码模式"}'],
    ['switch-failed', 'pswitch.error.failed{"name":"标准模式"}'],
    ['record-failed', 'pswitch.error.failed{"name":"标准模式"}'],
  ]
  for (const [code, expected] of cases) {
    const view = setup()
    await confirmWith(view, { compact: false })
    await view.answer(0, { ok: false, error: { code, current: 'standard' } })
    assert.equal(textOf(view.alert()[0]), expected, code)
    assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.retry', code)
    assert.equal(view.modal().length, 1, code)
  }
})

test('错误：宿主说失败以后会话实际是别的预设时写那一个；不认识的代码、网络错误照「切换失败」写当前预设', async () => {
  const view = setup()
  await confirmWith(view, { compact: false })
  await view.answer(0, { ok: false, error: { code: 'record-failed', current: FULL } })
  assert.equal(textOf(view.alert()[0]), 'pswitch.error.failed{"name":"全开模式"}')
  const odd = setup()
  await confirmWith(odd, { compact: false })
  await odd.answer(0, { ok: false, error: { code: 'something-new' } })
  assert.equal(textOf(odd.alert()[0]), 'pswitch.error.failed{"name":"标准模式"}')
  const offline = setup()
  await confirmWith(offline, { compact: false })
  await offline.answer(0, new TypeError('Failed to fetch'))
  assert.equal(textOf(offline.alert()[0]), 'pswitch.error.failed{"name":"标准模式"}')
})

test('错误：压缩成功、切换失败时压缩不重做，重试只发 switch，「先压缩上下文」不能再改', async () => {
  const view = setup()
  await confirmWith(view, { compact: true })
  await view.answer(0, { ok: true })
  await view.answer(1, { ok: false, error: { code: 'switch-failed', current: 'standard' } })
  assert.equal(textOf(view.alert()[0]), 'pswitch.error.failed{"name":"标准模式"}')
  assert.equal(view.checkbox().props.checked, true)
  assert.equal(view.checkbox().props.disabled, true)
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => post.body.step), ['compact', 'switch', 'switch'])
  assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.switching')
})

// ---------- 防旧预览（接口.md「第二次补充」）：别的窗口先切了，宿主回 stale-preview ----------

/** 别的窗口把会话切成了全开模式以后，从全开模式到代码模式的预览。 */
const FROM_FULL = { ok: true, value: { from: FULL, to: CODING, changes: true, tools: { added: ['workbench_discover_tools'], removed: ['plugin_manager'] }, systemPrompt: 'replaced', uncachedTokens: 200000, compactSuggested: true, runningSubagents: 0 } }
const STALE = { ok: false, error: { code: 'stale-preview', current: FULL } }
const previews = view => view.host.gets('/api/dsh-workbench.preset-switch/preview')

test('防旧预览：两步的 POST 都带 expectedFrom，取用户这次看到的预览里的 from', async () => {
  const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, from: 'standard' } } })
  await view.mount()
  await view.open()
  await view.choose(CODING)
  await view.press(view.buttons()[1])
  await view.answer(0, { ok: true })
  assert.deepEqual(view.host.posts.map(post => [post.body.step, post.body.expectedFrom]), [['compact', 'standard'], ['switch', 'standard']])
})

test('防旧预览：expectedFrom 跟预览走，不跟标签走：这个窗口的投影还没更新、预览已经说来源是全开模式时，带全开模式', async () => {
  const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, from: FULL } } })
  await confirmWith(view, { compact: false })
  assert.deepEqual(view.host.posts.map(post => post.body.expectedFrom), [FULL])
})

test('防旧预览：收到 stale-preview 不写错误，重新取预览；新的有变化就按新的差异弹框请用户确认，确认后带新的 expectedFrom', async () => {
  const view = setup()
  await confirmWith(view, { compact: false })
  view.host.preview = FROM_FULL
  await view.answer(0, STALE)
  assert.equal(previews(view).length, 2, '重新取了一次预览')
  assert.deepEqual(previews(view)[1].query, { sessionId: SESSION, agentPreset: CODING })
  assert.equal(view.alert().length, 0, 'stale-preview 不单独显示文字')
  assert.equal(view.row('pswitch.confirm.systemPrompt'), 'pswitch.confirm.prompt.replaced', '框里换成新预览的差异')
  assert.equal(view.row('pswitch.confirm.cacheMiss'), 'pswitch.confirm.tokens{"tokens":"pswitch.number.thousand{\\"value\\":\\"200\\"}"}')
  assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.switch{"name":"代码模式"}', '要用户重新确认，不自动发')
  assert.equal(view.host.posts.length, 1)
  assert.equal(view.checkbox().props.checked, false, '用户自己取消过勾选，照用户的')
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => [post.body.step, post.body.expectedFrom]), [['switch', 'standard'], ['switch', FULL]])
})

test('防旧预览：压缩已经成功、切换这一步遇到 stale-preview，只重新确认切换，不再压缩', async () => {
  const view = setup()
  await confirmWith(view, { compact: true })
  await view.answer(0, { ok: true })
  view.host.preview = FROM_FULL
  await view.answer(1, STALE)
  assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.switch{"name":"代码模式"}')
  assert.equal(view.checkbox().props.checked, true)
  assert.equal(view.checkbox().props.disabled, true, '压缩已经做过')
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => [post.body.step, post.body.expectedFrom]), [['compact', 'standard'], ['switch', 'standard'], ['switch', FULL]])
})

test('防旧预览：压缩这一步就遇到 stale-preview（还没压缩）时，用户没动过勾选就照新预览的建议', async () => {
  const view = setup()
  await view.mount()
  await view.open()
  await view.choose(CODING)
  await view.press(view.buttons()[1])
  view.host.preview = { ok: true, value: { ...FROM_FULL.value, compactSuggested: false } }
  await view.answer(0, STALE)
  assert.equal(view.checkbox().props.checked, false)
  assert.notEqual(view.checkbox().props.disabled, true)
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => [post.body.step, post.body.expectedFrom]), [['compact', 'standard'], ['switch', FULL]])
})

test('防旧预览：新预览没有变化时不弹框，带新的 expectedFrom 直接切换', async () => {
  const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, to: FULL, changes: false } } })
  await view.mount()
  await view.open()
  await view.choose(FULL)
  view.host.preview = { ok: true, value: { ...PREVIEW.value, from: CODING, to: FULL, changes: false } }
  await view.answer(0, { ok: false, error: { code: 'stale-preview', current: CODING } })
  assert.equal(view.modal().length, 0)
  assert.deepEqual(view.host.posts.map(post => [post.body.step, post.body.expectedFrom]), [['switch', 'standard'], ['switch', CODING]])
  await view.answer(1, { ok: true, value: { agentPreset: FULL } })
  assert.equal(view.modal().length, 0)
})

test('防旧预览：没有用户操作、连着第二次 stale-preview 时改成弹框，不来回自动重发', async () => {
  const view = setup({ preview: { ok: true, value: { ...PREVIEW.value, to: FULL, changes: false } } })
  await view.mount()
  await view.open()
  await view.choose(FULL)
  view.host.preview = { ok: true, value: { ...PREVIEW.value, from: CODING, to: FULL, changes: false } }
  await view.answer(0, { ok: false, error: { code: 'stale-preview', current: CODING } })
  view.host.preview = { ok: true, value: { ...PREVIEW.value, from: 'standard', to: FULL, changes: false } }
  await view.answer(1, { ok: false, error: { code: 'stale-preview', current: 'standard' } })
  assert.equal(view.host.posts.length, 2, '第二次过期以后不再自动发')
  assert.equal(view.dialog().props.title, 'pswitch.confirm.title{"name":"全开模式"}')
  assert.equal(view.alert().length, 0)
  await view.press(view.buttons()[1])
  assert.deepEqual(view.host.posts.map(post => post.body.expectedFrom), ['standard', CODING, 'standard'])
})

test('防旧预览：会话已经是目标预设（别的窗口切到了同一个）时关框，不再发 switch', async () => {
  const view = setup()
  await confirmWith(view, { compact: false })
  view.host.preview = { ok: true, value: { from: CODING, to: CODING, changes: false, tools: { added: [], removed: [] }, systemPrompt: 'unchanged', uncachedTokens: 0, compactSuggested: false, runningSubagents: 0 } }
  const before = view.host.gets('/api/dsh-workbench.preset-switch').length
  await view.answer(0, { ok: false, error: { code: 'stale-preview', current: CODING } })
  assert.equal(view.modal().length, 0)
  assert.equal(view.host.posts.length, 1)
  assert.ok(view.host.gets('/api/dsh-workbench.preset-switch').length > before, '重读菜单数据')
})

test('防旧预览：新预览取不到时写「切换失败，当前会话仍为{预设}」，预设取宿主说的实际预设', async () => {
  const view = setup()
  await confirmWith(view, { compact: false })
  view.host.preview = undefined
  await view.answer(0, STALE)
  assert.equal(previews(view).length, 2, '先重新取了预览，取不到才写失败')
  assert.equal(textOf(view.alert()[0]), 'pswitch.error.failed{"name":"全开模式"}')
  assert.equal(elementText(view.buttons()[1]), 'pswitch.confirm.retry')
})

// ---------- 确认框、菜单开着时的 ⌘↵ ----------

/** rc.3 的 ui.modalSelector（dsh-web-frontend 打包后的 ab）。替身 ui 里它是空函数，替身 document 按这个值处理。 */
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]'

/** 替身元素：selectors 是它自己符合的选择器，parent 是上一层（照 feat#166 返工的 next-step-keys 测试）。 */
class FakeElement {
  constructor({ selectors = [], attributes = {}, parent = null, editable = false } = {}) {
    this.selectors = new Set(selectors)
    this.attributes = attributes
    this.parent = parent
    this.isContentEditable = editable || (parent?.isContentEditable ?? false)
    this.dataset = {}
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

/**
 * 替身 document：页面上开着的弹层从替身 React 渲染出来的树里取。DSH 的 ui.Modal 渲染成
 * role="dialog" aria-modal="true"，ui.Menu 打开时列表是 role="menu"（rc.3 源码核对）。
 */
function overlayDocument(view) {
  const modal = new FakeElement({ selectors: ['[role="dialog"][aria-modal="true"]', '[role="dialog"]'] })
  const menu = new FakeElement({ selectors: ['[role="menu"]'] })
  return {
    activeElement: null,
    querySelectorAll(selector) {
      const open = [
        ...view.react.all(node => node.type === 'ui.Modal' && node.props.open === true).map(() => modal),
        ...view.react.all(node => node.type === 'ui.Menu' && node.props.open === true).map(() => menu),
      ]
      return open.filter(node => node.matches(typeof selector === 'string' ? selector : MODAL_SELECTOR))
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    },
  }
}

/** 装上 ⌘↵ 和一个「推荐的下一步」（收尾框的第一个按钮），返回按键的方法。 */
function nextStepKeys(t, view) {
  const conversation = new FakeElement({ selectors: ['[data-conversation-session]'], attributes: { 'data-conversation-session': SESSION } })
  const scroll = new FakeElement({ selectors: ['[data-input-scroll]'], parent: conversation })
  const composer = new FakeElement({ selectors: ['[contenteditable="true"]'], parent: scroll, editable: true })
  const page = new FakeElement({ selectors: ['button'], parent: conversation })
  const bindingCtx = {}
  const ctx = {
    sessions: { binding: id => (id === SESSION ? { ctx: bindingCtx, session: { getSnapshot: () => ({ running: false }) } } : undefined) },
    conversation: { input: { for: owner => (owner === bindingCtx ? { state: { getSnapshot: () => ({ phase: 'plain', draft: '', attachmentIds: [], occurrences: [] }) } } : undefined) } },
    uiSession: {
      sessionStatus: { getSnapshot: () => new Map([[SESSION, { running: false, pendingInteraction: undefined }]]) },
      adapter: { current: { getSnapshot: () => ({ key: SESSION }) } },
    },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
  }
  const unmount = view.client.get('mountNextStepKeys')({ ctx, t: key => key })
  const runs = []
  const withdraw = view.client.get('offerNextStep')(SESSION, 'wrap:3', { kind: 'wrapup', order: 0, run: () => { runs.push('wrap:3') } })
  t.after(() => { withdraw(); unmount() })
  const press = (target) => {
    const event = {
      type: 'keydown', code: 'Enter', key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false,
      defaultPrevented: false,
      composedPath: () => [target],
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
    }
    view.client.window.dispatchEvent(event)
    return event.defaultPrevented
  }
  return { press, runs, composer, page }
}

test('⌘↵：确认框开着时不执行别的推荐项（焦点在页面上或空的输入框里都一样），关了框才执行', async (t) => {
  let view
  const document = { querySelectorAll: selector => overlayDocument(view).querySelectorAll(selector), querySelector: selector => overlayDocument(view).querySelector(selector), activeElement: null }
  view = setup({ document, Element: FakeElement })
  const keys = nextStepKeys(t, view)
  await view.mount()
  await view.open()
  await view.choose(CODING)
  assert.equal(view.modal().length, 1)
  assert.equal(keys.press(keys.page), false)
  assert.equal(keys.press(keys.composer), false)
  // 进行中（压缩、切换）也一样。
  await view.press(view.buttons()[1])
  assert.equal(keys.press(keys.page), false)
  await view.answer(0, { ok: false, error: { code: 'compact-failed', current: 'standard' } })
  assert.equal(keys.press(keys.page), false)
  assert.deepEqual(keys.runs, [])
  await view.press(view.buttons()[0])
  assert.equal(view.modal().length, 0)
  assert.equal(keys.press(keys.page), true, '框关了：推荐项照常执行')
  assert.deepEqual(keys.runs, ['wrap:3'])
})

test('⌘↵：菜单开着时也不执行推荐项', async (t) => {
  let view
  const document = { querySelectorAll: selector => overlayDocument(view).querySelectorAll(selector), querySelector: selector => overlayDocument(view).querySelector(selector), activeElement: null }
  view = setup({ document, Element: FakeElement })
  const keys = nextStepKeys(t, view)
  await view.mount()
  await view.open()
  assert.equal(keys.press(keys.page), false)
  assert.deepEqual(keys.runs, [])
})

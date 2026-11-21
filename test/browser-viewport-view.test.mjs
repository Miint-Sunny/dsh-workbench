/**
 * 浏览器视口尺寸（feat#161）的界面：工具栏里的按钮、点开的面板、自定义的输入和错误、关闭面板的几种方式、
 * 工具栏下面的状态行。组件在替身 React 里跑构建好的 lib/client.js；看起来对不对（深浅色、宽窄）要在浏览器里看。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)

/** 替身 document：只记监听，测试用 emit 触发。 */
function createDocument() {
  const listeners = new Map()
  return {
    body: {}, activeElement: null,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    emit(type, event = {}) {
      const seen = { stopped: false, prevented: false, ...event, stopPropagation() { seen.stopped = true }, preventDefault() { seen.prevented = true } }
      for (const listener of [...listeners.get(type) ?? []]) listener(seen)
      return seen
    },
    count: type => listeners.get(type)?.size ?? 0,
  }
}

/** 文案：回键名加参数，断言时看得出是哪条、带了什么。 */
const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)

function setup(state = { preset: 'auto' }) {
  const document = createDocument()
  const client = loadClient(CLIENT, { document })
  const { react } = client
  const calls = []
  const controller = { setState: (key, next) => calls.push([key, next]) }
  const Control = client.get('BrowserViewportControl')
  const make = (next) => ({ id: 'card1', key: 'occurrence:a', toolClass: 'k_tool', host: {}, statusHost: {}, state: next, scale: next.preset === 'auto' ? undefined : 0.5 })
  const mount = async (next = state) => {
    react.mount(react.React.createElement(Control, { card: make(next), controller, t }))
    await react.settle()
  }
  const toggle = () => react.one(node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog', '工具栏按钮')
  const items = () => react.all(node => node.props?.['data-dwb-bv-item'] !== undefined)
  const item = id => react.one(node => node.props?.['data-dwb-bv-item'] === id, `菜单项 ${id}`)
  const menu = () => react.all(node => node.props?.role === 'dialog')
  const click = async (node) => { react.fire(node, 'onClick'); await react.settle() }
  return { client, react, document, calls, mount, toggle, items, item, menu, click, make, Control, controller }
}

test('按钮：借官方按钮的类名，是 button 而不是提交；自动时不亮，固定尺寸时亮；面板没开', async () => {
  const view = setup()
  await view.mount()
  const button = view.toggle()
  assert.equal(button.props.type, 'button', '在官方的 form 里：不能是提交按钮')
  assert.equal(button.props.className, 'k_tool dwb-bv-btn')
  assert.equal(button.props['aria-label'], 'browserViewport.button')
  assert.equal(button.props.title, 'browserViewport.button')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['data-active'], undefined)
  assert.equal(view.menu().length, 0)
  await view.mount({ preset: 'phone', width: 375, height: 812 })
  assert.equal(view.toggle().props['data-active'], '', '选了固定尺寸：按下的样子')
})

test('按钮：借不到官方类名时只用自己的类名', async () => {
  const view = setup()
  const { react } = view
  react.mount(react.React.createElement(view.Control, { card: { ...view.make({ preset: 'auto' }), toolClass: '' }, controller: view.controller, t }))
  await react.settle()
  assert.equal(view.toggle().props.className, 'dwb-bv-btn')
})

test('点按钮打开面板：五项依次是自动、手机、平板、桌面、自定义，选中的打勾；自动时方向灰着', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  assert.equal(view.toggle().props['aria-expanded'], true)
  assert.equal(view.toggle().props['data-active'], '', '面板开着时按钮是按下的样子')
  assert.deepEqual(view.items().map(node => node.props['data-dwb-bv-item']), ['auto', 'phone', 'tablet', 'desktop', 'custom'])
  assert.deepEqual(view.items().filter(node => node.props['aria-checked']).map(node => node.props['data-dwb-bv-item']), ['auto'])
  assert.ok(textOf(view.item('auto')).includes('browserViewport.autoHint'), '自动一项写「卡片大小」')
  assert.ok(textOf(view.item('phone')).includes('browserViewport.size{"width":"375","height":"812"}'))
  assert.ok(textOf(view.item('tablet')).includes('{"width":"768","height":"1024"}'))
  assert.ok(textOf(view.item('desktop')).includes('{"width":"1280","height":"800"}'))
  assert.ok(view.item('auto').children.some(child => typeof child !== 'string' && child.type === 'ui.IconCheckOutlineRegular'), '选中的一项有打勾图标')
  const segments = view.react.all(node => node.type === 'button' && ['radio'].includes(node.props.role) && node.props['data-dwb-bv-item'] === undefined)
  assert.deepEqual(segments.map(node => textOf(node)), ['browserViewport.portrait', 'browserViewport.landscape'])
  assert.ok(segments.every(node => node.props.disabled === true), '选「自动」时方向灰掉')
  assert.equal(view.menu()[0].props['aria-label'], 'browserViewport.button')
  await view.click(view.toggle())
  assert.equal(view.menu().length, 0, '再点按钮就关')
})

test('选预设：交给控制器（按卡片键），面板关闭，焦点回到按钮', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  await view.click(view.item('phone'))
  assert.deepEqual(view.calls, [['occurrence:a', { preset: 'phone', width: 375, height: 812 }]])
  assert.equal(view.menu().length, 0)
  assert.equal(view.react.focused, view.toggle(), '焦点回到工具栏按钮')
  await view.click(view.toggle())
  await view.click(view.item('desktop'))
  assert.deepEqual(view.calls.at(-1), ['occurrence:a', { preset: 'desktop', width: 1280, height: 800 }])
})

test('已经是固定尺寸时选「自动」：交给控制器，选中的是当前的预设', async () => {
  const view = setup({ preset: 'tablet', width: 768, height: 1024 })
  await view.mount()
  await view.click(view.toggle())
  assert.deepEqual(view.items().filter(node => node.props['aria-checked']).map(node => node.props['data-dwb-bv-item']), ['tablet'])
  await view.click(view.item('auto'))
  assert.deepEqual(view.calls, [['occurrence:a', { preset: 'auto' }]])
})

test('方向：固定尺寸时可选，点「横向」宽高对调，面板保持打开；换到当前方向不改', async () => {
  const view = setup({ preset: 'phone', width: 375, height: 812 })
  await view.mount()
  await view.click(view.toggle())
  const [portrait, landscape] = view.react.all(node => node.type === 'button' && node.props.role === 'radio' && node.props['data-dwb-bv-item'] === undefined)
  assert.equal(portrait.props.disabled, false)
  assert.equal(portrait.props['aria-checked'], true)
  assert.equal(landscape.props['aria-checked'], false)
  await view.click(landscape)
  assert.deepEqual(view.calls, [['occurrence:a', { preset: 'phone', width: 812, height: 375 }]])
  assert.equal(view.menu().length, 1, '面板还开着，能接着调')
  await view.click(portrait)
  assert.deepEqual(view.calls.at(-1), ['occurrence:a', { preset: 'phone', width: 375, height: 812 }], '已经竖向的状态下点竖向：原样')
})

test('自定义：点「自定义…」展开宽、高两个输入框和「应用」；先不改尺寸', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  assert.equal(view.react.all(node => node.type === 'input').length, 0, '没点自定义之前不显示输入框')
  await view.click(view.item('custom'))
  assert.deepEqual(view.calls, [])
  const inputs = view.react.all(node => node.type === 'input')
  assert.equal(inputs.length, 2)
  assert.deepEqual(inputs.map(node => node.props['aria-label']), ['browserViewport.widthName', 'browserViewport.heightName'])
  assert.deepEqual(inputs.map(node => node.props.value), ['1280', '800'], '没有当前尺寸时从桌面的 1280 × 800 起')
  assert.ok(inputs.every(node => node.props.inputMode === 'numeric' && node.props.type === 'text'))
  assert.deepEqual(view.items().filter(node => node.props['aria-checked']).map(node => node.props['data-dwb-bv-item']), ['custom'], '样稿 5：编辑自定义时那一项打勾')
  assert.ok(view.react.all(node => node.type === 'ui.Button' && textOf(node) === 'browserViewport.apply').length === 1)
})

test('自定义：输入有误时不改尺寸，错误写在输入框下面并标出是哪个输入框；改对后回车生效', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  await view.click(view.item('custom'))
  const [width, height] = view.react.all(node => node.type === 'input')
  view.react.fire(width, 'onChange', { target: { value: '120' } })
  view.react.fire(height, 'onChange', { target: { value: '900' } })
  await view.react.settle()
  await view.click(view.react.one(node => node.type === 'ui.Button' && textOf(node) === 'browserViewport.apply', '应用按钮'))
  assert.deepEqual(view.calls, [], '范围不对：不改尺寸')
  const alerts = view.react.all(node => node.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(textOf(alerts[0]), 'browserViewport.error.width.range{"min":"240","max":"3840"}')
  const [badWidth, okHeight] = view.react.all(node => node.type === 'input')
  assert.equal(badWidth.props['aria-invalid'], true)
  assert.equal(okHeight.props['aria-invalid'], undefined)
  assert.equal(view.react.focused, badWidth, '焦点回到出错的输入框')
  assert.equal(view.menu().length, 1, '面板不关')
  // 改宽、回车：生效，面板关闭。
  view.react.fire(badWidth, 'onChange', { target: { value: '400' } })
  await view.react.settle()
  assert.equal(view.react.all(node => node.props?.role === 'alert').length, 0, '改了这个输入框，它的错误就清掉')
  view.react.fire(view.react.all(node => node.type === 'input')[0], 'onKeyDown', { key: 'Enter' })
  await view.react.settle()
  assert.deepEqual(view.calls, [['occurrence:a', { preset: 'custom', width: 400, height: 900 }]])
  assert.equal(view.menu().length, 0)
})

test('自定义：高有误、不是整数、两个都有误，各自的错误都写出来', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  await view.click(view.item('custom'))
  const apply = () => view.react.one(node => node.type === 'ui.Button' && textOf(node) === 'browserViewport.apply', '应用按钮')
  const type = async (index, value) => { view.react.fire(view.react.all(node => node.type === 'input')[index], 'onChange', { target: { value } }); await view.react.settle() }
  await type(0, '375.5'); await type(1, '5000')
  await view.click(apply())
  assert.deepEqual(view.react.all(node => node.props?.role === 'alert').map(node => textOf(node)), [
    'browserViewport.error.width.integer{"min":"240","max":"3840"}',
    'browserViewport.error.height.range{"min":"240","max":"3840"}',
  ])
  assert.equal(view.react.focused, view.react.all(node => node.type === 'input')[0], '两个都错：焦点在宽')
  await type(0, '375')
  await view.click(apply())
  assert.deepEqual(view.react.all(node => node.props?.role === 'alert').map(node => textOf(node)), ['browserViewport.error.height.range{"min":"240","max":"3840"}'])
  assert.equal(view.react.focused, view.react.all(node => node.type === 'input')[1], '只有高错：焦点在高')
  assert.deepEqual(view.calls, [])
})

test('自定义：当前就是自定义尺寸时，输入框带着当前的宽高，应用的结果是新的自定义尺寸', async () => {
  const view = setup({ preset: 'custom', width: 600, height: 900 })
  await view.mount()
  await view.click(view.toggle())
  const inputs = view.react.all(node => node.type === 'input')
  assert.deepEqual(inputs.map(node => node.props.value), ['600', '900'])
  view.react.fire(inputs[1], 'onChange', { target: { value: '700' } })
  await view.react.settle()
  await view.click(view.react.one(node => node.type === 'ui.Button' && textOf(node) === 'browserViewport.apply', '应用按钮'))
  assert.deepEqual(view.calls, [['occurrence:a', { preset: 'custom', width: 600, height: 700 }]])
})

test('按 Esc 关面板，焦点回到按钮；Esc 不再往下传', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  const event = view.document.emit('keydown', { key: 'Escape' })
  await view.react.settle()
  assert.equal(event.stopped, true, '不让 DSH 自己的 Esc 处理再动一遍')
  assert.equal(view.menu().length, 0)
  assert.equal(view.react.focused, view.toggle())
})

test('点面板外面关；点按钮自己不由这里关（按钮自己切换）；点面板里面不关', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  view.document.emit('pointerdown', { target: view.toggle() })
  await view.react.settle()
  assert.equal(view.menu().length, 1, '按在按钮上：交给按钮的点击去切换')
  view.document.emit('pointerdown', { target: view.item('phone') })
  await view.react.settle()
  assert.equal(view.menu().length, 1, '按在面板里面：不关')
  view.document.emit('pointerdown', { target: { elsewhere: true } })
  await view.react.settle()
  assert.equal(view.menu().length, 0)
})

test('焦点移到面板外、点进网页（窗口失去焦点）也关；关了以后不再留监听', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  assert.ok(view.document.count('keydown') >= 1 && view.document.count('pointerdown') >= 1)
  view.document.emit('focusin', { target: { elsewhere: true } })
  await view.react.settle()
  assert.equal(view.menu().length, 0)
  assert.equal(view.document.count('keydown'), 0)
  assert.equal(view.document.count('pointerdown'), 0)
  assert.equal(view.document.count('focusin'), 0)
  assert.equal(view.client.window.listenerCount('blur'), 0)
  await view.click(view.toggle())
  assert.equal(view.client.window.listenerCount('blur'), 1)
  view.client.window.dispatchEvent({ type: 'blur' })
  await view.react.settle()
  assert.equal(view.menu().length, 0, '点进 iframe 或 webview 里的网页，窗口失去焦点')
  assert.equal(view.client.window.listenerCount('blur'), 0)
})

test('卸载（这张卡片没了）时面板和监听一起收掉', async () => {
  const view = setup()
  await view.mount()
  await view.click(view.toggle())
  view.react.unmount()
  assert.equal(view.document.count('keydown'), 0)
  assert.equal(view.client.window.listenerCount('blur'), 0)
})

test('状态行：「视口 W × H，缩放 N%」，带宽、高和取整的百分数', async () => {
  const view = setup()
  const { react } = view
  const Status = view.client.get('BrowserViewportStatus')
  react.mount(react.React.createElement(Status, { card: { ...view.make({ preset: 'phone', width: 375, height: 812 }), scale: 584 / 812 }, t }))
  await react.settle()
  const line = react.one(node => node.props?.role === 'status', '状态行')
  assert.equal(line.props.className, 'dwb-bv-status')
  assert.equal(textOf(line), 'browserViewport.status{"width":"375","height":"812","percent":"72"}')
})

test('一张卡片的界面：自动时只有按钮；固定尺寸并量出比例后多一行状态；还没量出比例时不显示', async () => {
  const view = setup()
  const { react } = view
  const Card = view.client.get('BrowserViewportCard')
  const render = async (card) => { react.mount(react.React.createElement(Card, { card, controller: view.controller, t })); await react.settle() }
  const statuses = () => react.all(node => node.props?.role === 'status')
  await render(view.make({ preset: 'auto' }))
  assert.equal(statuses().length, 0)
  assert.equal(react.all(node => node.props?.['aria-haspopup'] === 'dialog').length, 1)
  await render(view.make({ preset: 'tablet', width: 1024, height: 768 }))
  assert.equal(statuses().length, 1)
  await render({ ...view.make({ preset: 'tablet', width: 1024, height: 768 }), scale: undefined })
  assert.equal(statuses().length, 0)
})

test('宿主：跟着控制器的快照给每张卡片画按钮，选了尺寸后状态行出现；撤销后没有残留', async () => {
  const view = setup()
  const { react } = view
  const createController = view.client.get('createBrowserViewportController')
  const Host = view.client.get('BrowserViewportHost')
  const cards = []
  const handle = (key) => {
    const card = {
      key, toolClass: 'tool', host: { id: `host-${key}` }, statusHost: { id: `status-${key}` }, applied: [],
      ensure: () => ({ host: card.host, statusHost: card.statusHost }), size: () => ({ width: 422, height: 600 }),
      apply: layout => card.applied.push(layout), watch: () => () => {}, release() {},
    }
    cards.push(card)
    return card
  }
  const controller = createController({ findCards: () => cards })
  handle('occurrence:a'); handle('occurrence:b')
  controller.scan()
  react.mount(react.React.createElement(Host, { controller, app: { t } }))
  await react.settle()
  assert.equal(react.all(node => node.props?.['aria-haspopup'] === 'dialog').length, 2, '每张卡片一个按钮')
  assert.equal(react.all(node => node.props?.role === 'status').length, 0)
  controller.setState('occurrence:b', { preset: 'phone', width: 375, height: 812 })
  await react.settle()
  const statuses = react.all(node => node.props?.role === 'status')
  assert.equal(statuses.length, 1, '只有选了尺寸的那张卡片有状态行')
  assert.equal(textOf(statuses[0]), 'browserViewport.status{"width":"375","height":"812","percent":"72"}')
  controller.dispose()
  await react.settle()
  assert.equal(react.all(node => node.props?.['aria-haspopup'] === 'dialog').length, 0)
})

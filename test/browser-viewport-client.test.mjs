/**
 * 浏览器视口尺寸（feat#161）的客户端：控制器怎么发现工具栏、每张卡片各记各的、卡片变大小时重新缩放、
 * 官方把注入的节点弄丢时补回而不插重、撤销时全部还原；文案、菜单摆放、行的挂载和撤销。
 * 真实 DOM（官方的类名、webview 和 iframe）要在 DSH 里看，这里用页面替身；组件的交互见 browser-viewport-view.test.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_VIEWPORT_CSS, BROWSER_VIEWPORT_EN, BROWSER_VIEWPORT_INJECT, BROWSER_VIEWPORT_ZH,
  applyBrowserViewport, browserViewportMenuPlace, createBrowserViewportController,
} from '../src/client/browser-viewport.js'
import { browserViewportOrient, browserViewportPreset } from '../src/client/browser-viewport-model.js'

/** 页面替身：现有的官方工具栏，每张是控制器看到的「卡片柄」（和真实 DOM 适配器同一套方法）。 */
function createPage() {
  const present = new Set()
  return {
    adapter: { findCards: () => [...present] },
    add(key, size = { width: 422, height: 600 }) {
      const card = {
        key, toolClass: 'tool', host: { id: `host-${key}` }, statusHost: { id: `status-${key}` }, dimensions: { ...size },
        inserted: 1, attached: true, applied: [], released: 0, stopped: 0, watchers: new Set(),
        ensure() {
          if (!card.attached) { card.attached = true; card.inserted += 1 }
          return { host: card.host, statusHost: card.statusHost }
        },
        size: () => ({ ...card.dimensions }),
        apply: layout => { card.applied.push(layout) },
        watch: callback => { card.watchers.add(callback); return () => { card.watchers.delete(callback); card.stopped += 1 } },
        release: () => { card.released += 1 },
        resize(next) { card.dimensions = next; for (const callback of [...card.watchers]) callback() },
        lose() { card.attached = false },
      }
      present.add(card)
      return card
    },
    remove: card => present.delete(card),
  }
}

const lastLayout = card => card.applied.at(-1)

test('发现官方工具栏：登记成一张卡片，注入的节点交给界面，默认是自动，什么都不套', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  assert.deepEqual(controller.getSnapshot().cards, [])
  const card = page.add('occurrence:a')
  controller.scan()
  const [seen] = controller.getSnapshot().cards
  assert.equal(controller.getSnapshot().cards.length, 1)
  assert.equal(seen.key, 'occurrence:a')
  assert.equal(seen.host, card.host)
  assert.equal(seen.statusHost, card.statusHost)
  assert.equal(seen.toolClass, 'tool')
  assert.deepEqual(seen.state, { preset: 'auto' })
  assert.equal(seen.scale, undefined)
  assert.equal(card.applied.length, 0, '自动：不碰官方的样式')
  assert.equal(card.watchers.size, 1)
})

test('重复扫描不插重：快照不变、只监听一次；官方把注入的节点弄丢后补回一份', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const card = page.add('occurrence:a')
  controller.scan()
  const first = controller.getSnapshot()
  let notified = 0
  controller.subscribe(() => { notified += 1 })
  controller.scan(); controller.scan(); controller.scan()
  assert.equal(controller.getSnapshot(), first, '没变化时快照还是同一个')
  assert.equal(notified, 0)
  assert.equal(card.watchers.size, 1)
  assert.equal(card.inserted, 1)
  card.lose()
  controller.scan()
  assert.equal(card.inserted, 2, '丢了补回一次')
  controller.scan()
  assert.equal(card.inserted, 2, '补回后不再重复插')
  assert.equal(controller.getSnapshot(), first, '宿主节点还是原来那个，界面不用重来')
})

test('选尺寸：按卡片内容区算缩放比例，把样式交给卡片，通知界面；状态跟着卡片的键走', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const card = page.add('occurrence:a')
  controller.scan()
  let notified = 0
  controller.subscribe(() => { notified += 1 })
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  const [seen] = controller.getSnapshot().cards
  assert.deepEqual(seen.state, { preset: 'phone', width: 375, height: 812 })
  assert.ok(Math.abs(seen.scale - 584 / 812) < 1e-9, '高更紧：(600 - 16) / 812')
  const layout = lastLayout(card)
  assert.ok(Math.abs(layout.scale - 584 / 812) < 1e-9)
  assert.equal(layout.frame.width, '375px')
  assert.equal(layout.frame.height, '812px')
  assert.match(layout.frame.transform, /^translate\(-50%, -50%\) scale\(0\.719212\)$/)
  assert.deepEqual(layout.container, { position: 'relative', overflow: 'hidden' })
  assert.ok(notified >= 1)
})

test('回到自动：还原卡片的样式，缩放比例清掉，状态不再留着', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const card = page.add('occurrence:a')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('tablet'))
  controller.setState('occurrence:a', browserViewportPreset('auto'))
  assert.equal(lastLayout(card), undefined, '最后一次是还原')
  assert.equal(card.applied.length, 2)
  const [seen] = controller.getSnapshot().cards
  assert.deepEqual(seen.state, { preset: 'auto' })
  assert.equal(seen.scale, undefined)
})

test('横竖对调：宽高对调后按新的宽高重新缩放', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const card = page.add('occurrence:a')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('tablet'))
  const [portrait] = controller.getSnapshot().cards
  controller.setState('occurrence:a', browserViewportOrient(portrait.state, 'landscape'))
  const [landscape] = controller.getSnapshot().cards
  assert.deepEqual(landscape.state, { preset: 'tablet', width: 1024, height: 768 })
  assert.ok(Math.abs(landscape.scale - 406 / 1024) < 1e-9, '宽更紧')
  assert.equal(lastLayout(card).frame.width, '1024px')
  assert.equal(lastLayout(card).frame.height, '768px')
})

test('卡片大小变了（拖宽侧边栏）：按新大小重新算比例，通知界面刷新百分数', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const card = page.add('occurrence:a')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('desktop'))
  let notified = 0
  controller.subscribe(() => { notified += 1 })
  card.resize({ width: 700, height: 600 })
  assert.ok(Math.abs(controller.getSnapshot().cards[0].scale - 684 / 1280) < 1e-9)
  assert.ok(Math.abs(lastLayout(card).scale - 684 / 1280) < 1e-9)
  assert.equal(notified, 1)
  // 大小没变（只是别的原因触发了监听）：比例不变，不通知。
  card.resize({ width: 700, height: 600 })
  assert.equal(notified, 1)
  // 自动时卡片变大小什么都不做。
  controller.setState('occurrence:a', browserViewportPreset('auto'))
  const applied = card.applied.length
  card.resize({ width: 300, height: 300 })
  assert.equal(card.applied.length, applied)
})

test('卡片大小暂时量不出来（藏着、还没排版）：保持现状，不套 0、不还原成自动', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const card = page.add('occurrence:a')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  const applied = card.applied.length
  const scale = controller.getSnapshot().cards[0].scale
  card.resize({ width: 0, height: 0 })
  assert.equal(card.applied.length, applied)
  assert.equal(controller.getSnapshot().cards[0].scale, scale)
  assert.deepEqual(controller.getSnapshot().cards[0].state, { preset: 'phone', width: 375, height: 812 })
  card.resize({ width: 422, height: 600 })
  assert.equal(card.applied.length, applied + 1, '又有大小了：重新套上')
})

test('每张卡片各记各的：一张选了尺寸，另一张不受影响；新开的卡片从自动开始', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const a = page.add('occurrence:a')
  const b = page.add('occurrence:b')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  const [seenA, seenB] = controller.getSnapshot().cards
  assert.equal(seenA.state.preset, 'phone')
  assert.equal(seenB.state.preset, 'auto')
  assert.equal(b.applied.length, 0)
  assert.equal(a.applied.length, 1)
  const c = page.add('occurrence:c')
  controller.scan()
  assert.equal(controller.getSnapshot().cards.find(card => card.key === 'occurrence:c').state.preset, 'auto')
  assert.equal(c.applied.length, 0)
  controller.setState('occurrence:b', browserViewportPreset('tablet'))
  assert.equal(controller.getSnapshot().cards.find(card => card.key === 'occurrence:a').state.preset, 'phone', 'b 的改动不动 a')
})

test('卡片的页面被卸掉又回来（网页端换标签）：同一个键的状态还在，一出现就套上', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const first = page.add('occurrence:a')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  page.remove(first)
  controller.scan()
  assert.deepEqual(controller.getSnapshot().cards, [])
  assert.equal(first.released, 1, '卸掉时还原样式、移除注入的节点')
  assert.equal(first.stopped, 1, '不再监听')
  const second = page.add('occurrence:a')
  controller.scan()
  const [seen] = controller.getSnapshot().cards
  assert.deepEqual(seen.state, { preset: 'phone', width: 375, height: 812 })
  assert.ok(lastLayout(second), '新的网页框一出现就按这个尺寸排版')
  assert.equal(lastLayout(second).frame.width, '375px')
})

test('回到自动的卡片不再占着状态：卸掉再回来是自动', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const first = page.add('occurrence:a')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  controller.setState('occurrence:a', browserViewportPreset('auto'))
  page.remove(first)
  controller.scan()
  const second = page.add('occurrence:a')
  controller.scan()
  assert.equal(controller.getSnapshot().cards[0].state.preset, 'auto')
  assert.equal(second.applied.length, 0)
})

test('撤销：每张卡片还原、停止监听，快照清空；之后的扫描什么都不做', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  const a = page.add('occurrence:a')
  const b = page.add('occurrence:b')
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  let notified = 0
  controller.subscribe(() => { notified += 1 })
  controller.dispose()
  assert.equal(notified, 1, '撤销时通知一次：还在渲染的界面看到空快照，之后不再通知')
  assert.equal(a.released, 1)
  assert.equal(b.released, 1)
  assert.equal(a.stopped, 1)
  assert.equal(b.stopped, 1)
  assert.deepEqual(controller.getSnapshot().cards, [])
  const c = page.add('occurrence:c')
  controller.scan()
  assert.equal(c.watchers.size, 0)
  assert.deepEqual(controller.getSnapshot().cards, [])
})

test('订阅：可以取消；通知期间有人取消订阅不出错', () => {
  const page = createPage()
  const controller = createBrowserViewportController(page.adapter)
  page.add('occurrence:a')
  let first = 0
  let second = 0
  const stop = controller.subscribe(() => { first += 1; stop() })
  controller.subscribe(() => { second += 1 })
  controller.scan()
  controller.setState('occurrence:a', browserViewportPreset('phone'))
  assert.equal(first, 1)
  assert.ok(second >= 2)
})

test('菜单摆放：右边对齐按钮、在按钮下方；贴着窗口边时挪进来，太低时限制高度', () => {
  const view = { width: 1000, height: 800 }
  assert.deepEqual(browserViewportMenuPlace({ left: 540, right: 568, top: 5, bottom: 33 }, view), { left: 332, top: 37, maxHeight: 755 })
  assert.equal(browserViewportMenuPlace({ left: 60, right: 88, top: 5, bottom: 33 }, view).left, 8, '左边不出窗口')
  assert.equal(browserViewportMenuPlace({ left: 980, right: 1008, top: 5, bottom: 33 }, view).left, 756, '右边不出窗口')
  assert.equal(browserViewportMenuPlace({ left: 540, right: 568, top: 700, bottom: 728 }, view).maxHeight, 120, '至少留 120 像素高')
  assert.ok(browserViewportMenuPlace({ left: 540, right: 568, top: 5, bottom: 33 }, { width: 200, height: 800 }).left >= 0)
})

test('文案：中英文键一致；状态行和错误提示都带参数', () => {
  assert.deepEqual(Object.keys(BROWSER_VIEWPORT_ZH).sort(), Object.keys(BROWSER_VIEWPORT_EN).sort())
  for (const key of ['button', 'auto', 'autoHint', 'phone', 'tablet', 'desktop', 'custom', 'orientation', 'portrait', 'landscape',
    'width', 'widthName', 'height', 'heightName', 'apply', 'status',
    'error.width.range', 'error.height.range', 'error.width.integer', 'error.height.integer']) {
    assert.ok(`browserViewport.${key}` in BROWSER_VIEWPORT_ZH, key)
  }
  assert.equal(BROWSER_VIEWPORT_ZH['browserViewport.button'], '视口尺寸')
  assert.equal(BROWSER_VIEWPORT_EN['browserViewport.button'], 'Viewport size')
  assert.equal(BROWSER_VIEWPORT_ZH['browserViewport.status'], '视口 {width} × {height}，缩放 {percent}%')
  assert.equal(BROWSER_VIEWPORT_ZH['browserViewport.error.width.range'], '宽度需在 {min} 到 {max} 之间')
  assert.equal(BROWSER_VIEWPORT_ZH['browserViewport.error.height.range'], '高度需在 {min} 到 {max} 之间')
  for (const dictionary of [BROWSER_VIEWPORT_ZH, BROWSER_VIEWPORT_EN]) {
    assert.match(dictionary['browserViewport.status'], /\{width\}.*\{height\}.*\{percent\}/)
    assert.match(dictionary['browserViewport.error.width.range'], /\{min\}.*\{max\}/)
  }
  assert.deepEqual(BROWSER_VIEWPORT_INJECT, [])
})

test('样式：按钮、状态行、留白斜纹、菜单都用 DSH 的变量；不做悬停才出现的东西', () => {
  assert.match(BROWSER_VIEWPORT_CSS, /\.dwb-bv-status\b/)
  assert.match(BROWSER_VIEWPORT_CSS, /\.dwb-bv-menu\b/)
  assert.match(BROWSER_VIEWPORT_CSS, /\[data-dwb-bv=fixed\]/)
  assert.match(BROWSER_VIEWPORT_CSS, /repeating-linear-gradient\(45deg/)
  assert.doesNotMatch(BROWSER_VIEWPORT_CSS, /#[0-9a-fA-F]{3,8}\b/, '颜色都走 DSH 的变量，不写死')
  for (const rule of BROWSER_VIEWPORT_CSS.split('}').filter(rule => /:hover/.test(rule))) {
    assert.doesNotMatch(rule, /display\s*:\s*(?!none)|visibility\s*:\s*visible|opacity\s*:\s*1/, `悬停只改底色：${rule.trim()}`)
  }
  assert.doesNotMatch(BROWSER_VIEWPORT_CSS, /font-size:\s*(?:[0-9]|10|11)px/, '不用小于 12px 的字')
  assert.match(BROWSER_VIEWPORT_CSS, /\.dwb-bv-menu\{[^}]*z-index:1100;/, '面板和 DSH 自己的菜单同一层级（真实页面里量得 1100），不被右侧栏盖住')
  const menu = BROWSER_VIEWPORT_CSS.match(/\.dwb-bv-menu\{([^}]*)\}/)[1]
  assert.match(menu, /background:var\(--dsw-alias-bg-layer-2\)/, '面板盖在任意网页上：背景不透明（样稿的 raised），不依赖背后的内容')
  assert.doesNotMatch(menu, /backdrop-filter/, '不用磨砂：背后是浅色网页时整块发灰，次要文字看不清')
  assert.match(BROWSER_VIEWPORT_CSS, /\.dwb-bv-apply\{[^}]*white-space:nowrap/, '「应用」不折行（236 像素宽的面板里曾被挤成两行竖排）')
  assert.match(BROWSER_VIEWPORT_CSS, /\.dwb-bv-input\[aria-invalid=true\]:focus\{outline-color:var\(--dsw-alias-state-error-primary\)/, '出错的输入框聚焦时轮廓也是红的，不被蓝色轮廓盖住')
})

test('挂载和撤销：样式、监听整页变化、界面插槽；撤销时全部收回，卡片还原', (t0) => {
  const log = { styles: [], removed: [], observed: [], disconnected: 0, slots: [], slotDisposed: 0 }
  const forms = []
  globalThis.document = {
    createElement: () => ({ dataset: {}, set textContent(value) { log.styles.push(value) }, remove() { log.removed.push('style') } }),
    head: { appendChild() {} },
    body: { id: 'body' },
    querySelectorAll: selector => { log.observed.push(`query:${selector}`); return forms },
  }
  globalThis.MutationObserver = class {
    constructor(callback) { log.callback = callback }
    observe(target, options) { log.observed.push(['observe', target.id, options]) }
    disconnect() { log.disconnected += 1 }
  }
  t0.after(() => { delete globalThis.document; delete globalThis.MutationObserver })
  const ctx = {
    effect: (fn, name) => { const dispose = fn(); log.slots.push(name); return () => { log.slotDisposed += 1; dispose?.() } },
    slots: { inject: (name, factory) => { log.slotName = name; log.entry = factory(); return () => { log.entryDisposed = true } }, register: (options, component) => ({ options, component }) },
  }
  const dispose = applyBrowserViewport({ ctx, t: key => key })
  assert.deepEqual(log.styles, [BROWSER_VIEWPORT_CSS])
  assert.ok(log.observed.some(item => Array.isArray(item) && item[0] === 'observe' && item[1] === 'body' && item[2].childList === true && item[2].subtree === true), '整页的增删节点：官方重新渲染时补回')
  assert.equal(log.slotName, 'shell.overlay', '界面挂在壳层的插槽里，只渲染一次')
  assert.equal(log.entry.options.id, 'dsh-workbench-browser-viewport')
  assert.equal(typeof log.entry.component, 'function')
  assert.equal(log.disconnected, 0)
  dispose()
  assert.equal(log.disconnected, 1)
  assert.deepEqual(log.removed, ['style'])
  assert.equal(log.entryDisposed, true)
  assert.equal(log.slotDisposed, 1)
})

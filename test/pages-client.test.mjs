/** 网页发布客户端的测试：地址编码、相对路径转换、时间/字节写法、过滤、版本元数据这些纯函数，
 * 加 applyPages 的注册/撤销和资源迭代器、列表读取器，以及预览组件换版本时的状态（替身 React，见 react-harness.mjs）。
 *  */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStorage, loadClient, textOf } from './react-harness.mjs'
import {
  applyPages, createPagesClientStore, pagesAddress, pagesFilterPages, pagesFormatBytes, pagesFormatTime,
  pagesInlineParams, pagesLatestVersion, pagesMergeBlocked, pagesShouldOfferPublish, pagesVersionFile,
  parsePagesAddress,
} from '../src/client/pages.js'

// ---------- 地址 ----------

test('地址：页面 id 和版本编码进去读得回来；? 参数不算', () => {
  assert.equal(pagesAddress('sales-1234', 2), 'dsh-resource://wbpages/page/sales-1234/2')
  assert.deepEqual(parsePagesAddress(pagesAddress('sales-1234', 2)), { pageId: 'sales-1234', version: 2 })
  assert.deepEqual(parsePagesAddress('dsh-resource://wbpages/page/a%2Fb/5?x=1'), { pageId: 'a/b', version: 5 })
})

test('地址：别的协议、坏版本、空 id 都不认', () => {
  for (const bad of [
    'dsh-resource://wbsplit/session/s1',
    'dsh-resource://wbpages/other/x/1',
    'dsh-resource://wbpages/page/x/0',
    'dsh-resource://wbpages/page/x/-1',
    'dsh-resource://wbpages/page//2',
    'dsh-resource://wbpages/page/x/',
    'dsh-resource://wbpages/page/%/2',
    undefined,
    42,
  ]) {
    assert.equal(parsePagesAddress(bad), undefined, String(bad))
  }
})

// ---------- 文件预览的「发布为页面」要不要出现 ----------

test('发布入口：只在工作区里的 .html/.htm 上出现，返回 posix 相对路径', () => {
  assert.equal(pagesShouldOfferPublish('/w/x/index.html', '/w/x'), 'index.html')
  assert.equal(pagesShouldOfferPublish('/w/x/web/REPORT.HTML', '/w/x'), 'web/REPORT.HTML')
  assert.equal(pagesShouldOfferPublish('/w/x/a.htm', '/w/x'), 'a.htm')
  assert.equal(pagesShouldOfferPublish('/w/x/./sub/../a.html', '/w/x'), 'a.html')
  // Windows 写法也吃得下
  assert.equal(pagesShouldOfferPublish('C:\\w\\x\\a.html', 'C:\\w\\x'), 'a.html')
})

test('发布入口：工作区外、别的扩展名、绝对路径参数缺失都不出现', () => {
  assert.equal(pagesShouldOfferPublish('/w/other/a.html', '/w/x'), undefined)
  assert.equal(pagesShouldOfferPublish('/w/x/../../escape.html', '/w/x'), undefined)
  assert.equal(pagesShouldOfferPublish('/w/x/a.md', '/w/x'), undefined)
  assert.equal(pagesShouldOfferPublish('/w/x/html', '/w/x'), undefined)
  assert.equal(pagesShouldOfferPublish(undefined, '/w/x'), undefined)
  assert.equal(pagesShouldOfferPublish('/w/x/a.html', undefined), undefined)
  assert.equal(pagesShouldOfferPublish('/w/x/a.html', ''), undefined)
})

// ---------- 写法 ----------

test('字节数：字节、KB、MiB，和宿主端一个写法', () => {
  assert.equal(pagesFormatBytes(512), '512 字节')
  assert.equal(pagesFormatBytes(182 * 1024), '182 KB')
  assert.equal(pagesFormatBytes(4 * 1024 * 1024), '4 MiB')
  assert.equal(pagesFormatBytes(6.2 * 1024 * 1024), '6.2 MiB')
  assert.equal(pagesFormatBytes(-1), '0 KB')
})

test('时间：刚刚、HH:mm、昨天、M 月 D 日、带年份', () => {
  const now = new Date('2026-11-06T21:05:00').getTime()
  assert.equal(pagesFormatTime(now - 30 * 1000, now), '刚刚')
  assert.equal(pagesFormatTime(new Date('2026-11-06T08:03:00').getTime(), now), '08:03')
  assert.equal(pagesFormatTime(new Date('2026-11-05T23:00:00').getTime(), now), '昨天')
  assert.equal(pagesFormatTime(new Date('2026-10-31T10:00:00').getTime(), now), '10 月 31 日')
  assert.equal(pagesFormatTime(new Date('2025-12-30T10:00:00').getTime(), now), '2025 年 12 月 30 日')
})

test('内联参数：计数求和判断有没有；版本文件路径拼对', () => {
  assert.deepEqual(pagesInlineParams({ scripts: 2, styles: 1, images: 3 }), { any: true, scripts: 2, styles: 1, images: 3 })
  assert.deepEqual(pagesInlineParams(undefined), { any: false, scripts: 0, styles: 0, images: 0 })
  assert.equal(pagesVersionFile('/data/pages/a-1', 3), '/data/pages/a-1/v3.html')
  assert.equal(pagesVersionFile('/data/pages/a-1/', 3), '/data/pages/a-1/v3.html')
  assert.equal(pagesVersionFile(undefined, 3), undefined)
})

test('最新版本和过滤：列表条目的最后一版；标题不分大小写过滤', () => {
  const page = { id: 'a-1', title: '销售看板', versions: [{ n: 1 }, { n: 2 }] }
  assert.equal(pagesLatestVersion(page).n, 2)
  assert.equal(pagesLatestVersion({}), undefined)
  const pages = [page, { id: 'b-1', title: 'API 文档', versions: [{ n: 1 }] }]
  assert.equal(pagesFilterPages(pages, '销售').length, 1)
  assert.equal(pagesFilterPages(pages, 'api').length, 1)
  assert.equal(pagesFilterPages(pages, '  ').length, 2)
  assert.equal(pagesFilterPages(pages, '没有').length, 0)
})

test('被拦地址去重', () => {
  const first = pagesMergeBlocked([], 'https://a.example/1')
  assert.deepEqual(first, ['https://a.example/1'])
  assert.equal(pagesMergeBlocked(first, 'https://a.example/1'), first)
  assert.deepEqual(pagesMergeBlocked(first, 'https://a.example/2'), ['https://a.example/1', 'https://a.example/2'])
})

// ---------- 列表读取器 ----------

test('列表读取器：load 读 list 接口，失败保留上一份；订阅者收到通知', async () => {
  const store = createPagesClientStore()
  assert.equal(store.get().status, 'loading')
  const pages = [{ id: 'a-1', title: 'A', corrupt: false }]
  let notified = 0
  const unsubscribe = store.subscribe(() => { notified += 1 })
  const okFetch = async () => ({ ok: true, json: async () => ({ pages }) })
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = okFetch
    await store.load()
    assert.equal(store.get().status, 'ready')
    assert.deepEqual(store.get().pages, pages)
    assert.equal(notified, 1)
    // 读了失败：状态还是 ready，内容保留
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
    await store.load()
    assert.equal(store.get().status, 'ready')
    assert.deepEqual(store.get().pages, pages)
    assert.equal(notified, 1)
    // 一直失败且从未成功：status 变 error
    const fresh = createPagesClientStore()
    globalThis.fetch = async () => { throw new Error('offline') }
    await fresh.load()
    assert.equal(fresh.get().status, 'error')
  } finally {
    globalThis.fetch = originalFetch
    unsubscribe()
  }
})

// ---------- applyPages 的注册与撤销 ----------

/** 照 split-client 的写法造一个假 ctx。 */
function fakeCtx() {
  const log = { resources: [], tabs: [], slotNames: [], slotDefs: [], disposers: 0, opened: [] }
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { log.disposers += 1; dispose() } },
    resources: { register(def) { log.resources.push(def); return () => { log.resources.pop() } } },
    sidebarRightTabs: { register(def) { log.tabs.push(def); return () => { log.tabs.pop() } } },
    slots: {
      inject(name, factory) {
        log.slotNames.push(name)
        return factory()
      },
      register(def) { log.slotDefs.push(def); return () => {} },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    layout: { selectPanel() { log.selectPanel = true } },
    sidebarRight: { openResource: (address) => { log.opened.push(address) } },
    remote: { session: { openWorkspacePath: async () => ({ ok: true }) } },
  }
  return { ctx, log }
}

test('applyPages：注册资源、标签类型、标签内容、面板按钮、面板页、工具行、文件预览按钮，撤销全撤', () => {
  const { ctx, log } = fakeCtx()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ pages: [] }) })
  try {
    const dispose = applyPages({ ctx, store: {}, t: key => key })
    try {
      assert.equal(log.resources.length, 1)
      assert.equal(log.resources[0].protocol, 'wbpages')
      assert.equal(log.tabs.length, 1)
      assert.equal(log.tabs[0].id, 'dsh-workbench/pages')
      assert.equal(log.tabs[0].kind, 'wbpages')
      assert.equal(log.tabs[0].canOpen(pagesAddress('a-1', 2)), true)
      assert.equal(log.tabs[0].canOpen('dsh-resource://file/session/s1/x.html'), false)
      // 标题回退到词典的「页面」，不写死
      assert.equal(log.tabs[0].title('dsh-resource://wbpages/page/missing-1/1'), 'pages.tab.fallback')
      assert.deepEqual(log.slotNames, [
        'sidebar.right.pane.tab',
        'sidebar.panellist',
        'main',
        'tool.call.toolview',
        'sidebar.right.tab.document.actions',
      ])
      const keys = log.slotDefs.map(def => def.key ?? def.id)
      assert.ok(keys.includes('dsh-workbench/pages'))
      assert.ok(keys.includes('dsh-workbench-pages'))
      assert.ok(keys.includes('publish_page'))
      // 面板按钮的 order 照任务单 21，label 走词典
      const panellist = log.slotDefs.find(def => def.name === 'sidebar.panellist')
      assert.equal(panellist.order, 21)
      assert.equal(panellist.label(), 'pages.panel')
    } finally {
      dispose()
    }
    assert.equal(log.disposers, 7)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('资源的 open：给一帧 { address }，坏地址抛错，信号中止后结束', async () => {
  const { ctx, log } = fakeCtx()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ pages: [] }) })
  try {
    const dispose = applyPages({ ctx, store: {}, t: key => key })
    try {
      const provider = log.resources[0]
      const controller = new AbortController()
      const stream = provider.open(pagesAddress('a-1', 2), { signal: controller.signal })
      const first = await stream.next()
      assert.equal(first.done, false)
      assert.equal(first.value.ok, true)
      assert.equal(first.value.value.address, pagesAddress('a-1', 2))
      controller.abort()
      const after = await stream.next()
      assert.equal(after.done, true)
      await assert.rejects(provider.open('dsh-resource://wbpages/page//1', { signal: new AbortController().signal }).next(), /地址不对/)
    } finally {
      dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pagesMergeBlocked：页面能直接 postMessage，所以只收字符串、最多 20 条、每条最长 300 个字符', () => {
  assert.deepEqual(pagesMergeBlocked([], 42), [])
  assert.deepEqual(pagesMergeBlocked([], ''), [])
  assert.deepEqual(pagesMergeBlocked([], { x: 1 }), [])
  const long = `https://a.example/${'x'.repeat(1000)}`
  const clipped = pagesMergeBlocked([], long)
  assert.equal(clipped.length, 1)
  assert.equal(clipped[0].length, 300)
  let known = []
  for (let i = 0; i < 100; i += 1) known = pagesMergeBlocked(known, `https://a.example/${i}`)
  assert.equal(known.length, 20)
  // 满了以后不再变，也不重新分配
  assert.equal(pagesMergeBlocked(known, 'https://new.example/'), known)
  const started = Date.now()
  let flood = []
  for (let i = 0; i < 80000; i += 1) flood = pagesMergeBlocked(flood, `u${i}`)
  assert.ok(Date.now() - started < 500)
})

// ---------- 预览组件（替身 React 里跑构建好的 lib/client.js） ----------

/** 打开一个有两版的页面的预览：v 版内容是 `<html>v{n}</html>`；copy 为 false 时「复制 HTML」读不到。 */
async function openPreview(t, {
  copy = true, onLoad, html = n => `<html>v${n}</html>`,
  browser = { localStorage: createMemoryStorage() },
  wait, URLClass,
} = {}) {
  const fetch = async (url) => {
    const version = Number(new URL(String(url), 'http://host/').searchParams.get('v'))
    // 组件开始拉某一版时同步调用：测试在这一刻插入旧预览框的上报。
    onLoad?.(version)
    // 测试可以把某一版的回答压住，等别的版本先回来。
    await wait?.(version)
    if (!copy && fetch.loaded.has(version)) return new Response('', { status: 500 })
    fetch.loaded.add(version)
    return new Response(html(version), { status: 200 })
  }
  fetch.loaded = new Set()
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { fetch, globalThis: browser, ...(URLClass ? { URL: URLClass } : {}) })
  const opened = []
  client.set('pagesT', (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`))
  client.set('designApp', { ctx: { contextMenus: { open: target => opened.push(target) } } })
  const page = { id: 'sales-1234', title: 'Sales', dir: '/pages/sales-1234', versions: [{ n: 1, createdAt: 1, assets: [] }, { n: 2, createdAt: 2, assets: [] }] }
  const react = client.react
  react.mount(react.React.createElement(client.get('PagesPreview'), { page, version: 1 }))
  t.after(() => react.unmount())
  await react.settle()
  return {
    react,
    opened,
    async choose(n) {
      react.fire(react.one(node => node.type === 'select', '版本下拉'), 'onChange', { target: { value: String(n) } })
      await react.settle()
    },
    /** 预览框里的页面报告一个被 CSP 拦下的地址。 */
    async block(url) {
      const frame = react.one(node => node.type === 'iframe', '预览框')
      client.window.dispatchEvent({ type: 'message', source: frame.contentWindow, data: { type: 'dwb-csp', blocked: url } })
      await react.settle()
    },
    async click(text) {
      react.fire(react.one(node => node.type === 'button' && textOf(node) === text, `「${text}」按钮`), 'onClick')
      await react.settle()
    },
    frame: () => react.one(node => node.type === 'iframe', '预览框'),
    /** 指定的预览框立刻报一条拦截（不等渲染）。 */
    post(frame, url) {
      client.window.dispatchEvent({ type: 'message', source: frame.contentWindow, data: { type: 'dwb-csp', blocked: url } })
    },
    banner: () => react.all(node => node.props.className === 'dwb-pg-blocked').map(textOf),
    scriptsBar: () => react.all(node => node.props.className === 'dwb-pg-scripts').map(textOf),
    errors: () => react.all(node => node.props.className === 'dwb-pg-error').map(textOf),
    root: () => react.one(node => node.props.className === 'dwb-pg-preview', '预览'),
  }
}

test('C-005 预览切到第 2 版后，右键和菜单键打开设计用的都是第 2 版', async (t) => {
  const ui = await openPreview(t)
  await ui.choose(2)
  ui.react.fire(ui.root(), 'onContextMenu', { clientX: 5, clientY: 6 })
  ui.react.fire(ui.root(), 'onKeyDown', { key: 'ContextMenu' })
  assert.deepEqual(ui.opened, [
    { kind: 'workbench-page', value: { page: 'sales-1234', version: 2 } },
    { kind: 'workbench-page', value: { page: 'sales-1234', version: 2 } },
  ])
})

test('C-005 换版本后，上一版的拦截提示和操作报错都不留下', async (t) => {
  const ui = await openPreview(t, { copy: false })
  await ui.block('https://cdn.example/a.js')
  await ui.click('pages.tab.copy')
  assert.equal(ui.banner().length, 1)
  assert.deepEqual(ui.errors(), ['pages.tab.copyFailed'])
  await ui.choose(2)
  assert.deepEqual(ui.banner(), [])
  assert.deepEqual(ui.errors(), [])
})

test('C-005 上一版点过「知道了」，新版本被拦截时照样提示', async (t) => {
  const ui = await openPreview(t)
  await ui.block('https://cdn.example/a.js')
  await ui.click('pages.tab.blockedClose')
  assert.deepEqual(ui.banner(), [])
  await ui.choose(2)
  await ui.block('https://cdn.example/b.js')
  assert.equal(ui.banner().length, 1)
  assert.match(ui.banner()[0], /b\.js/)
})

test('C-007 发布入口：Windows 路径不分大小写，盘符根、UNC 和 / 做工作区根也认', () => {
  assert.equal(pagesShouldOfferPublish('c:\\work\\index.html', 'C:\\Work'), 'index.html')
  assert.equal(pagesShouldOfferPublish('C:\\Work\\Site\\A.html', 'c:/work'), 'Site/A.html')
  assert.equal(pagesShouldOfferPublish('C:\\index.html', 'C:\\'), 'index.html')
  assert.equal(pagesShouldOfferPublish('C:\\sub\\a.htm', 'C:/'), 'sub/a.htm')
  assert.equal(pagesShouldOfferPublish('\\\\Server\\Share\\proj\\a.html', '\\\\server\\share\\proj'), 'a.html')
  assert.equal(pagesShouldOfferPublish('/index.html', '/'), 'index.html')
  // posix 路径照旧逐字比较；只有盘符没有斜杠的不是绝对路径
  assert.equal(pagesShouldOfferPublish('/W/x/a.html', '/w/x'), undefined)
  assert.equal(pagesShouldOfferPublish('C:\\a.html', 'C:'), undefined)
  assert.equal(pagesShouldOfferPublish('D:\\work\\a.html', 'C:\\work'), undefined)
})

test('C-005 换版本的那一刻旧页面又报了一条拦截，新版本不显示它', async (t) => {
  let late
  const ui = await openPreview(t, { onLoad: (version) => { if (version === 2) late?.() } })
  const old = ui.frame()
  late = () => ui.post(old, 'https://cdn.example/late.js')
  await ui.choose(2)
  assert.notEqual(ui.frame(), old, '第 2 版是新的预览框')
  assert.deepEqual(ui.banner(), [])
  // 第 2 版自己的拦截照常提示。
  await ui.block('https://cdn.example/own.js')
  assert.equal(ui.banner().length, 1)
  assert.match(ui.banner()[0], /own\.js/)
})

// ---------- fix#173：页面里的脚本默认不运行 ----------

/** 页面有一段仅标记本版已加载的脚本。 */
const SCRIPTED = n => `<html><body>v${n}<script>document.body.dataset.version = '${n}'</script></body></html>`

test('fix#173 不带脚本的页面不出「运行脚本」，预览框也不给 allow-scripts', async (t) => {
  const ui = await openPreview(t)
  assert.deepEqual(ui.scriptsBar(), [])
  assert.equal(ui.frame().props.sandbox, '')
})

test('fix#173 带脚本的页面默认不运行；点「运行脚本」后这一版才运行，并记在浏览器存储里', async (t) => {
  const browser = { localStorage: createMemoryStorage() }
  const ui = await openPreview(t, { html: SCRIPTED, browser })
  assert.equal(ui.scriptsBar().length, 1)
  assert.match(ui.scriptsBar()[0], /pages\.tab\.scripts/)
  assert.equal(ui.frame().props.sandbox, '')
  await ui.click('pages.tab.runScripts')
  assert.deepEqual(ui.scriptsBar(), [])
  assert.equal(ui.frame().props.sandbox, 'allow-scripts')
  const reopened = await openPreview(t, { html: SCRIPTED, browser })
  assert.equal(reopened.frame().props.sandbox, 'allow-scripts')
})

test('fix#173 点过的只算那一版：换到第 2 版要重新点，换回第 1 版直接运行', async (t) => {
  const ui = await openPreview(t, { html: SCRIPTED })
  await ui.click('pages.tab.runScripts')
  await ui.choose(2)
  assert.equal(ui.scriptsBar().length, 1)
  assert.equal(ui.frame().props.sandbox, '')
  await ui.choose(1)
  assert.deepEqual(ui.scriptsBar(), [])
  assert.equal(ui.frame().props.sandbox, 'allow-scripts')
})

test('fix#173 浏览器存储不能用时，点「运行脚本」只在这次打开里运行', async (t) => {
  const browser = { get localStorage() { throw new Error('storage denied') } }
  const ui = await openPreview(t, { html: SCRIPTED, browser })
  assert.equal(ui.frame().props.sandbox, '')
  await ui.click('pages.tab.runScripts')
  assert.equal(ui.frame().props.sandbox, 'allow-scripts')
  const reopened = await openPreview(t, { html: SCRIPTED, browser })
  assert.equal(reopened.frame().props.sandbox, '')
})

test('fix#173 预览框里的页面：不运行脚本时没有上报脚本，点「运行脚本」后换成完整的页面', async (t) => {
  const { resolveObjectURL } = await import('node:buffer')
  const { applyPageHardening } = await import('../lib/pages-csp.js')
  const ui = await openPreview(t, { html: n => applyPageHardening(SCRIPTED(n)) })
  const shown = async () => resolveObjectURL(ui.frame().props.src).text()
  assert.doesNotMatch(await shown(), /dwb-csp/)
  await ui.click('pages.tab.runScripts')
  assert.match(await shown(), /dwb-csp/)
  assert.equal(ui.frame().props.sandbox, 'allow-scripts')
})

// ---------- fix#180：fix#173 审查留给网页的几处 ----------

test('fix#180 换了版本以后，上一版晚到的内容不再建预览地址', async (t) => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const made = []
  class CountingURL extends URL {
    static createObjectURL(blob) {
      made.push(blob)
      return URL.createObjectURL(blob)
    }
    static revokeObjectURL(url) { URL.revokeObjectURL(url) }
  }
  const ui = await openPreview(t, { wait: version => (version === 1 ? held : undefined), URLClass: CountingURL })
  await ui.choose(2)
  release()
  await ui.react.settle()
  const shown = await Promise.all(made.map(blob => blob.text()))
  assert.deepEqual(shown.map(text => (text.includes('v1') ? 'v1' : 'v2')), ['v2'])
})

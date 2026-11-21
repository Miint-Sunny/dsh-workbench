/** 设计页网页端：评论的添加、重试和「重新选择」。在替身 React 里跑构建好的 lib/client.js，宿主用内存里的假接口。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { designConfig } from '../lib/design-protocol.js'
import { createMemoryStorage, loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const comment = (id, text, selector) => ({ id, board: 'desktop', selector, tag: 'h1', rect: { x: 10, y: 20, width: 100, height: 30 }, styles: {}, text })

/**
 * 内存里的设计草稿接口，照 lib/design-store.js：修订号对不上回 409 draft-changed。
 * saves 里排好每次保存怎么回：'ok' 正常、'fail' 没保存就失败、'lost' 保存了但回答丢了。
 */
function designServer(comments = [], html = '<html><body><h1>Fixture</h1></body></html>') {
  const server = { revision: 0, comments, saves: [], requests: [], exports: [] }
  server.fetch = async (url, init = {}) => {
    const path = String(url)
    if (path === '/api/dsh-workbench.design.export') {
      server.exports.push(JSON.parse(init.body))
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (path.startsWith('/api/dsh-workbench.design.page?')) {
      return json({
        page: 'p', version: 1, title: 'Fixture', html, fingerprint: 'f1',
        source: { sessionId: 's1', path: 'page.html' }, sourceReady: true, latest: 1, declarations: [],
        draft: { page: 'p', version: 1, revision: server.revision, comments: server.comments, params: {} },
        limits: designConfig({ bridgeReadyMs: 20000 }),
      })
    }
    if (path === '/api/dsh-workbench.design.save') {
      const body = JSON.parse(init.body)
      server.requests.push(body)
      const how = server.saves.shift() ?? 'ok'
      if (how === 'fail') return json({ error: { code: 'read-failed' } }, 500)
      if (body.revision !== server.revision) return json({ error: { code: 'draft-changed' } }, 409)
      server.revision += 1
      server.comments = body.draft.comments
      if (how === 'lost') throw new TypeError('Failed to fetch')
      return json({ page: 'p', version: 1, revision: server.revision, comments: server.comments, params: {} })
    }
    throw new Error(`没准备的请求 ${path}`)
  }
  return server
}

/** 画板页面的 Blob：记下来，测试从里面读出画板的通道号。 */
class TestURL extends URL {
  static blobs = new Map()
  static createObjectURL(blob) {
    const url = `blob:test/${TestURL.blobs.size + 1}`
    TestURL.blobs.set(url, blob)
    return url
  }
  static revokeObjectURL() {}
}

async function openDesign(t, server, localStorage = createMemoryStorage(), globals = {}) {
  const client = loadClient(CLIENT, { fetch: server.fetch, URL: TestURL, globalThis: { localStorage }, ...globals })
  const menus = new Map()
  const app = {
    t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    ctx: {
      contextMenus: {
        register(entry) {
          menus.set(entry.id, entry)
          return () => { if (menus.get(entry.id) === entry) menus.delete(entry.id) }
        },
        open() {},
      },
      layout: { selectPanel() {} },
    },
  }
  client.set('designApp', app)
  client.set('designCurrent', { page: 'p', version: 1 })
  const react = client.react
  react.mount(react.React.createElement(client.get('DesignPanel'), { app }))
  t.after(() => react.unmount())
  await react.settle()
  // 预览对话框一直在树里（只是没打开），按钮只在工具栏和右侧评论栏里找。
  const outsideDialog = (node) => {
    for (let at = node; at; at = at.parent) if (at.type === 'dialog') return false
    return true
  }
  const button = text => react.one(node => node.type === 'button' && textOf(node) === text && outsideDialog(node), `「${text}」按钮`)
  const ui = {
    react,
    button,
    async click(text) {
      react.fire(button(text), 'onClick')
      await react.settle()
    },
    /** 评论表单的提交按钮上写的是「添加」还是「保存」。 */
    submitLabel: () => textOf(react.one(node => node.type === 'button' && /^design\.(add|update)$/.test(textOf(node)), '评论表单的提交按钮')),
    async type(text) {
      react.fire(react.one(node => node.type === 'textarea', '评论输入框'), 'onChange', { target: { value: text } })
      await react.settle()
    },
    /** 位置评论：点画板上 (x, y)。替身视口和画板一样大，缩放 1，画板左上角在 (16, 40)。 */
    async place(x, y) {
      react.fire(react.one(node => node.props.className === 'dwb-design-viewport', '画布'), 'onPointerDown', { clientX: 16 + x, clientY: 40 + y })
      await react.settle()
    },
    /** 画板里点中一个元素：照画板脚本发的选择消息。 */
    async selectInFrame(selector) {
      const frame = react.one(node => node.type === 'iframe' && node.props['data-design-board'] === 'desktop', '桌面画板')
      const nonce = (await TestURL.blobs.get(frame.props.src).text()).match(/data-channel="([^"]+)" data-board="desktop"/)[1]
      client.window.dispatchEvent({
        type: 'message', source: frame.contentWindow,
        data: { type: 'selection', nonce, board: 'desktop', version: 1, selection: { selector, tag: 'p', rect: { x: 1, y: 2, width: 3, height: 4 }, styles: {} } },
      })
      await react.settle()
    },
    async menu(id, item) {
      menus.get('dsh-workbench-design-comments').resolve({ id }).find(entry => entry.id === item).run()
      await react.settle()
    },
    comments: () => react.all(node => node.type === 'article').map(node => textOf(node.children[0])),
    notice: () => react.all(node => node.props.className === 'dwb-design-notice').map(textOf),
    draftText: () => react.one(node => node.type === 'textarea', '评论输入框').props.value,
  }
  return ui
}

test('C-001 添加评论第一次没保存上，再点一次只保存一条', async (t) => {
  const server = designServer()
  const ui = await openDesign(t, server)
  await ui.click('design.position')
  await ui.place(100, 100)
  await ui.type('标题再大一点')
  server.saves.push('fail', 'ok')
  await ui.click('design.add')
  assert.deepEqual(ui.notice(), ['design.read-failed'])
  assert.equal(ui.draftText(), '标题再大一点', '失败后输入的文字还在')
  await ui.click('design.add')
  assert.equal(server.comments.length, 1)
  assert.deepEqual(server.comments.map(c => c.text), ['标题再大一点'])
  assert.deepEqual(ui.comments(), ['1. 标题再大一点'])
})

test('C-001 宿主已保存但回答丢了，再点一次被修订号拒绝，本地也不多出一条', async (t) => {
  const server = designServer()
  const ui = await openDesign(t, server)
  await ui.click('design.position')
  await ui.place(100, 100)
  await ui.type('按钮换成主色')
  server.saves.push('lost', 'ok')
  await ui.click('design.add')
  await ui.click('design.add')
  assert.deepEqual(ui.notice(), ['design.draft-changed'])
  assert.equal(server.revision, 1)
  assert.deepEqual(server.comments.map(c => c.text), ['按钮换成主色'])
  assert.equal(server.requests[1].draft.comments.length, 1, '重试的请求里还是一条')
  assert.deepEqual(ui.comments(), ['1. 按钮换成主色'])
})

test('C-002 正常的重新选择：下一次在画板里点中的元素换给这条评论', async (t) => {
  const server = designServer([comment('a', '甲', '#a'), comment('b', '乙', '#b')])
  const ui = await openDesign(t, server)
  await ui.menu('a', 'reselect')
  await ui.selectInFrame('#new')
  assert.equal(ui.submitLabel(), 'design.update')
  assert.equal(ui.draftText(), '甲')
  await ui.click('design.update')
  assert.deepEqual(server.comments.map(c => [c.id, c.selector, c.text]), [['a', '#new', '甲'], ['b', '#b', '乙']])
})

test('C-002 重新选择后改去编辑另一条再取消，下一次选择新建评论，不覆盖原来那条', async (t) => {
  const server = designServer([comment('a', '甲', '#a'), comment('b', '乙', '#b')])
  const ui = await openDesign(t, server)
  await ui.menu('a', 'reselect')
  ui.react.fire(ui.react.all(node => node.type === 'article')[1], 'onClick')
  await ui.react.settle()
  await ui.click('design.cancel')
  await ui.selectInFrame('#new')
  assert.equal(ui.submitLabel(), 'design.add')
  assert.equal(ui.draftText(), '')
})

test('C-002 重新选择后改加位置评论，之后在画板里选中的元素新建评论', async (t) => {
  const server = designServer([comment('a', '甲', '#a')])
  const ui = await openDesign(t, server)
  await ui.menu('a', 'reselect')
  await ui.click('design.position')
  await ui.place(200, 100)
  await ui.type('这里留白')
  await ui.click('design.add')
  await ui.click('design.select')
  await ui.selectInFrame('#new')
  assert.equal(ui.submitLabel(), 'design.add')
  assert.equal(ui.draftText(), '')
  assert.deepEqual(server.comments.map(c => [c.id, c.selector]).filter(([id]) => id === 'a'), [['a', '#a']])
})

for (const how of ['取消', 'Esc']) {
  test(`C-002 新建评论的表单开着时点了重新选择，又按${how}收起表单，下一次选择新建评论`, async (t) => {
    const server = designServer([comment('a', '甲', '#a')])
    const ui = await openDesign(t, server)
    await ui.selectInFrame('#first')
    await ui.menu('a', 'reselect')
    if (how === '取消') await ui.click('design.cancel')
    else {
      ui.react.fire(ui.react.one(node => node.props.className === 'dwb-design', '设计页'), 'onKeyDown', { key: 'Escape' })
      await ui.react.settle()
    }
    await ui.selectInFrame('#new')
    assert.equal(ui.submitLabel(), 'design.add')
    assert.equal(ui.draftText(), '')
  })
}

// ---------- fix#173：带脚本的页面先点「运行脚本」 ----------

test('fix#173 设计面板打开不带脚本的页面：直接画画板，不问「运行脚本」', async (t) => {
  const ui = await openDesign(t, designServer())
  assert.equal(ui.react.all(node => node.props.className === 'dwb-design-notice dwb-design-scripts').length, 0)
  assert.ok(ui.react.all(node => node.type === 'iframe').length > 0)
})

test('fix#173 设计面板打开带脚本的页面：先问「运行脚本」，点过这一版才画画板', async (t) => {
  const storage = createMemoryStorage()
  const server = designServer([], '<html><body><button onclick="this.disabled=true">Fixture</button></body></html>')
  const ui = await openDesign(t, server, storage)
  assert.equal(ui.react.all(node => node.type === 'iframe').length, 0)
  assert.equal(ui.react.all(node => node.props.className === 'dwb-design-notice dwb-design-scripts').length, 1)
  await ui.click('design.runScripts')
  assert.ok(ui.react.all(node => node.type === 'iframe').length > 0)
  const reopened = await openDesign(t, server, storage)
  assert.ok(reopened.react.all(node => node.type === 'iframe').length > 0)
})

test('fix#173 设计面板：在预览里点过这一版的「运行脚本」，打开时直接画画板', async (t) => {
  const localStorage = createMemoryStorage()
  const html = '<html><body><script>document.title="Fixture"</script></body></html>'
  const preview = loadClient(CLIENT, { fetch: async () => new Response(html), globalThis: { localStorage } })
  preview.set('pagesT', key => key)
  const react = preview.react
  const page = { id: 'p', versions: [{ n: 1, createdAt: 1 }] }
  react.mount(react.React.createElement(preview.get('PagesPreview'), { page, version: 1 }))
  t.after(() => react.unmount())
  await react.settle()
  const run = react.one(node => node.type === 'button' && textOf(node) === 'pages.tab.runScripts')
  react.fire(run, 'onClick')
  await react.settle()

  const ui = await openDesign(t, designServer([], html), localStorage)
  assert.ok(ui.react.all(node => node.type === 'iframe').length > 0)
})

// ---------- fix#180：fix#173 审查留给网页的几处 ----------

/** 带事件属性的页面：设计面板要先问「运行脚本」。 */
const SCRIPTED_DESIGN = '<html><body><button onclick="this.disabled=true">Fixture</button></body></html>'
const zoomText = ui => textOf(ui.react.one(node => node.type === 'output', '缩放比例'))

test('fix#180 带脚本的页面点「运行脚本」后，画板按面板大小适配一次，之后的缩放不再被改', async (t) => {
  const ui = await openDesign(t, designServer([], SCRIPTED_DESIGN))
  await ui.click('design.runScripts')
  // 替身面板和两块画板一样大，适配后是 100%；没适配时停在起始的 45%，手机画板右边被裁掉。
  assert.equal(zoomText(ui), '100%')
  await ui.click('design.out')
  assert.equal(zoomText(ui), '90%')
  await ui.click('design.position')
  assert.equal(zoomText(ui), '90%')
})

test('fix#180 等确认「运行脚本」时也能导出 HTML，导出不放出画板', async (t) => {
  const server = designServer([], SCRIPTED_DESIGN)
  const downloads = []
  const document = {
    body: { appendChild() {} },
    createElement: () => ({ click() { downloads.push(this.download) }, remove() {} }),
  }
  const ui = await openDesign(t, server, createMemoryStorage(), { document })
  assert.equal(ui.react.all(node => node.type === 'iframe').length, 0)
  await ui.click('design.export')
  assert.deepEqual(server.exports, [{ page: 'p', version: 1 }])
  assert.deepEqual(downloads, ['p-v1.html'])
  assert.equal(ui.react.all(node => node.type === 'iframe').length, 0)
  assert.equal(ui.react.all(node => node.props.className === 'dwb-design-notice dwb-design-scripts').length, 1)
})

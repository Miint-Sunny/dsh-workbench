/**
 * 工作区信任（feat#121）的网页端：说明条选哪一种、预览外框什么时候接手、读取函数什么时候发请求，
 * 信任之后预览框按新 key 重新挂载。组件在替身 React 里跑构建好的 lib/client.js。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClient, textOf } from './react-harness.mjs'
import { applyWorkspaceTrustRoutes } from '../lib/workspace-trust.js'
import { previewInlines, previewInteractive, trustNoticeOf, createTrustRecord, displayOfUrl, TRUST_MAX_RESOURCES } from '../src/client/workspace-trust-model.js'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const BASE = 'dsh-app://app/'
const SRC = 'dsh-app://app/sidebar/html/S1/w/proj/index.html'
const at = (name) => new URL(name, SRC).href
/** 真实文件的宿主迟迟不回请求时，测试最多等这么久就报错（只防挂住，不是判断依据）。 */
const HOST_IDLE_LIMIT_MS = 10_000

test('只有沙箱开着、基准是 dsh-app: 时才算内联', () => {
  assert.equal(previewInlines({ sandboxed: true, src: SRC }, BASE), true)
  assert.equal(previewInlines({ sandboxed: false, src: SRC }, BASE), false)
  assert.equal(previewInlines({ sandboxed: true, src: SRC }, 'http://127.0.0.1:3000/'), false)
  assert.equal(previewInlines({ sandboxed: true, src: '' }, BASE), false)
  assert.equal(previewInlines({ sandboxed: true, src: SRC }, 'not a url'), false)
})

test('显示地址：预览路由写文件路径，其他同源地址写路径和查询', () => {
  assert.equal(displayOfUrl(at('img/a%20b.png')), '/w/proj/img/a b.png')
  assert.equal(displayOfUrl('dsh-app://app/api/x?y=1'), '/api/x?y=1')
})

const ready = (trusted, documentInside = true) => ({ state: 'ready', trusted, documentInside, root: '/w/proj', display: '~/proj', revision: 0 })
const record = (...items) => ({ loaded: 0, untrusted: items.filter(i => i.reason === 'untrusted').length, error: 0, items })

test('只有信任了、且文件在工作区里，预览才运行脚本', () => {
  assert.equal(previewInteractive(ready(true), record()), true)
  assert.equal(previewInteractive(ready(false), record()), false)
  assert.equal(previewInteractive(ready(true, false), record()), false)
  assert.equal(previewInteractive({ state: 'error' }, record()), false)
  assert.equal(previewInteractive({ state: 'loading' }, record()), false)
  assert.equal(previewInteractive(undefined, record()), false)
  assert.equal(previewInteractive({ state: 'ready', trusted: true }, record()), false, '宿主没有给文档判定时默认静态')
  assert.equal(previewInteractive(ready(true), record({ reason: 'document-outside' })), false)
  assert.equal(previewInteractive(ready(true), record({ reason: 'untrusted' })), false)
})

test('说明条：状态没回来、已信任且全部加载时不显示', () => {
  assert.equal(trustNoticeOf(undefined, record()), null)
  assert.equal(trustNoticeOf({ state: 'loading' }, record()), null)
  assert.equal(trustNoticeOf(ready(true), { ...record(), loaded: 3 }), null)
})

test('说明条：没信任时一直显示（静态预览，脚本不运行），页面有没有引用本地资源都一样', () => {
  assert.deepEqual(trustNoticeOf(ready(false), record()), { kind: 'untrusted' })
  assert.deepEqual(trustNoticeOf(ready(false), record({ reason: 'untrusted' }, { reason: 'other-route' })), { kind: 'untrusted' })
})

test('说明条：文件不在工作区里、读不到状态时也是静态预览，一直显示', () => {
  assert.deepEqual(trustNoticeOf(ready(false, false), record()), { kind: 'document-outside' })
  assert.deepEqual(trustNoticeOf(ready(true, false), record()), { kind: 'document-outside' })
  assert.deepEqual(trustNoticeOf(ready(true), record({ reason: 'document-outside' })), { kind: 'document-outside' })
  assert.deepEqual(trustNoticeOf({ state: 'error' }, record()), { kind: 'error' })
})

test('说明条：已信任时按原因汇总拦下的，未找到单独计', () => {
  const notice = trustNoticeOf(ready(true), record({ reason: 'missing', display: 'a.css' }, { reason: 'hidden', display: '.env' }, { reason: 'outside', display: '../x' }, { reason: 'outside', display: '/etc/x' }))
  assert.equal(notice.kind, 'blocked')
  assert.equal(notice.blocked, 3)
  assert.equal(notice.missing, 1)
  assert.deepEqual(notice.reasons, [['outside', 2], ['hidden', 1], ['missing', 1]])
  assert.equal(trustNoticeOf({ state: 'error' }, record({ reason: 'error' })).kind, 'error')
})

test('资源记录：名额在发请求前占，用完后不再放行', () => {
  const r = createTrustRecord()
  for (let i = 0; i < TRUST_MAX_RESOURCES; i++) assert.equal(r.reserve(), true)
  assert.equal(r.reserve(), false)
})

/** 内存里的宿主端：记下每个请求，按 trusted 回答。 */
function host({ trusted = false, failStatus = false, documentInside = path => path === "/w/proj/index.html" } = {}) {
  const server = { trusted, requests: [], token: 'token-1' }
  server.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    const headers = new Headers(init.headers)
    server.requests.push({ url: String(url), body, method: init.method ?? 'GET', token: headers.get('x-dsh-workbench-trust') })
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (String(url) === 'api/dsh-workbench.workspace-trust' && init.method === undefined) {
      return json({ ok: true, token: server.token, workspaces: server.trusted ? [{ path: '/w/proj', display: '~/proj', trustedAt: '2026-11-13T03:20:00.000Z' }] : [] })
    }
    // 照宿主端：POST 要 JSON 正文和当前的令牌。
    if (headers.get('content-type') !== 'application/json' || headers.get('x-dsh-workbench-trust') !== server.token) return json({ ok: false, reason: 'forbidden' }, 403)
    if (String(url) === 'api/dsh-workbench.workspace-trust') {
      if (body.action === 'status') return failStatus ? json({ ok: false }, 500) : json({ ok: true, root: '/w/proj', realRoot: '/w/proj', display: '~/proj', trusted: server.trusted, documentInside: documentInside(body.documentPath) })
      if (body.action === 'trust') { server.trusted = true; return json({ ok: true, workspaces: [] }) }
      if (body.action === 'revoke') { server.trusted = false; return json({ ok: true, workspaces: [] }) }
    }
    if (String(url) === 'api/dsh-workbench.workspace-trust.resource') {
      if (!server.trusted) return json({ ok: false, reason: 'untrusted' }, 403)
      if (body.resource.endsWith('/.env')) return json({ ok: false, reason: 'hidden', display: '.env' }, 403)
      return new Response('p{}', { status: 200, headers: { 'content-type': 'text/css' } })
    }
    return json({ ok: false }, 404)
  }
  return server
}

/** 装上这一行（假的 ctx），渲染 better-sidebar 补丁里外壳会渲染的东西：全局组件，带上原来的预览框 Frame。 */
function setup(server) {
  const globals = { document: { baseURI: 'http://127.0.0.1:1/', head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) } }
  const client = loadClient(CLIENT, globals)
  const { React } = client.react
  // 真实文件的宿主（filesystemHost）读文件走线程池，回得快慢不定，而 settle 只等固定几轮宏任务；
  // 所以再等它在途的请求回来、处理完响应，直到没有在途的请求。被测试扣住、还没送进宿主的请求不算在途。
  if (server.idle !== undefined) {
    const settle = client.react.settle
    client.react.settle = async rounds => {
      await settle(rounds)
      while (server.inflight > 0) {
        await server.idle()
        await settle(rounds)
      }
    }
  }
  const registered = []
  const ctx = { slots: { inject: (_, make) => make(), register: (info, render) => { registered.push({ info, render }); return () => {} } } }
  const app = { ctx, t: (key, params = {}) => key + (Object.keys(params).length ? JSON.stringify(params) : ''), clock: key => key }
  const dispose = client.get('applyWorkspaceTrust')(app, { request: server.fetch })
  const frames = []
  // 原来的预览框只在挂载时内联一次（better-sidebar 的 effect 依赖 inline、src、baseUrl），所以这里按挂载计数。
  function OriginalFrame(props) {
    React.useEffect(() => { frames.push(props.fetchInlineResource) }, [])
    return React.createElement('iframe', { ...props, Frame: undefined })
  }
  const TrustFrame = globalThis.__dshWorkbenchHtmlPreviewFrame
  const element = props => React.createElement(TrustFrame, { Frame: OriginalFrame, title: 'index.html', className: 'editorHtml', ...props })
  const render = props => client.react.mount(element(props))
  return { client, react: client.react, React, dispose, frames, render, element, registered, app, TrustFrame }
}

const iframe = (react) => react.one(node => node.type === 'iframe', 'iframe')
const notice = (react) => react.all(node => node.props?.['data-trust-notice'] !== undefined)

test('装上这一行时设全局组件，撤下时删掉', () => {
  const { dispose, TrustFrame, registered } = setup(host())
  assert.equal(typeof TrustFrame, 'function')
  assert.deepEqual(registered.map(entry => entry.info.name), ['settings.section', 'settings.section.icon'])
  dispose()
  assert.equal(globalThis.__dshWorkbenchHtmlPreviewFrame, undefined)
})

test('不内联时原样交给原来的预览框，什么都不加', async () => {
  const server = host()
  const { react, render, dispose } = setup(server)
  render({ src: SRC, sandboxed: false, baseUrl: BASE })
  await react.settle()
  const frame = iframe(react)
  assert.equal(frame.props.className, 'editorHtml')
  assert.equal(frame.props.fetchInlineResource, undefined)
  assert.equal(notice(react).length, 0)
  assert.equal(server.requests.length, 0)
  dispose()
})

test('没信任：读取函数一个资源请求都不发，说明条给出数目和信任按钮', async () => {
  const server = host()
  const { react, render, dispose } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  const read = iframe(react).props.fetchInlineResource
  assert.equal(typeof read, 'function')
  assert.equal(await read(at('style.css')), undefined)
  assert.equal(await read(at('../../../../../api/dsh-workbench.features')), undefined)
  assert.equal(await read('https://cdn.example/x.css'), undefined)
  await react.settle()
  assert.deepEqual(server.requests.filter(r => r.method === 'POST').map(r => r.body?.action ?? r.url), ['status'])
  const [shown] = notice(react)
  assert.equal(shown.props['data-trust-notice'], 'untrusted')
  assert.match(textOf(shown), /trust\.notice\.static/)
  assert.notEqual(iframe(react).props.dshInteractive, true, '没信任时预览框不运行脚本')
  assert.match(textOf(shown), /~\/proj/)
  dispose()
})

test('点「信任此工作区」后预览框换 key 重新挂载，新的读取函数从宿主端取资源', async () => {
  const server = host()
  const { react, render, dispose, frames } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  const before = iframe(react).props.fetchInlineResource
  await before(at('style.css'))
  await react.settle()
  const button = react.one(node => node.type === 'ui.Button' && textOf(node) === 'trust.action.trust', '信任按钮')
  react.fire(button, 'onClick')
  await react.settle()
  assert.ok(server.requests.some(r => r.body?.action === 'trust' && r.body.sessionId === 'S1'))
  const after = iframe(react).props.fetchInlineResource
  assert.notEqual(after, before, '信任后换了一个读取函数')
  assert.equal(frames.length, 2, '预览框重新挂载了一次，才会重新内联')
  assert.equal(frames[1], after)
  assert.equal(iframe(react).props.dshInteractive, true, '信任后预览框才运行脚本')
  const css = await after(at('style.css'))
  assert.equal(css.mediaType, 'text/css')
  assert.equal(Buffer.from(css.bytes).toString(), 'p{}')
  const sent = server.requests.find(r => r.url.endsWith('.resource'))
  assert.deepEqual(sent.body, { document: 'S1/w/proj/index.html', resource: 'S1/w/proj/style.css' })
  await react.settle()
  assert.equal(notice(react).length, 0, '全部加载时不显示说明条')
  dispose()
})

test('已信任：被拦下的写进说明条，展开后逐条列出', async () => {
  const server = host({ trusted: true })
  const { react, render, dispose } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  const read = iframe(react).props.fetchInlineResource
  assert.equal(await read(at('.env')), undefined)
  assert.equal(await read('dsh-app://app/sidebar/html/S2/w/proj/style.css'), undefined)
  assert.ok((await read(at('style.css'))).bytes)
  await react.settle()
  const [shown] = notice(react)
  assert.equal(shown.props['data-trust-notice'], 'blocked')
  assert.match(textOf(shown), /trust\.notice\.blocked\{"count":2\}/)
  assert.match(textOf(shown), /trust\.reason\.hidden 1/)
  assert.ok(!server.requests.some(r => r.body?.resource?.startsWith('S2/')), '其他会话的地址不发给宿主端')
  react.fire(react.one(node => node.props?.className === 'dwb-wt-toggle', '展开按钮'), 'onClick')
  await react.settle()
  assert.match(textOf(notice(react)[0]), /\.env/)
  dispose()
})

test('宿主端说没信任（别处刚撤销）时重读状态，预览重新内联', async () => {
  const server = host({ trusted: true })
  const { react, render, dispose, frames } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  const read = iframe(react).props.fetchInlineResource
  server.trusted = false
  assert.equal(await read(at('style.css')), undefined)
  await react.settle()
  assert.notEqual(iframe(react).props.fetchInlineResource, read)
  assert.equal(frames.length, 2, '状态变了，预览框重新挂载')
  dispose()
})

test('信任状态回来之前不挂预览框（免得先按静态内联一遍再重来）', async () => {
  const server = host({ trusted: true })
  let release
  const plain = server.fetch
  server.fetch = async (url, init) => {
    if (init?.body && JSON.parse(init.body).action === 'status') await new Promise(resolve => { release = resolve })
    return plain(url, init)
  }
  const { react, render, dispose, frames } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  assert.equal(react.all(node => node.type === 'iframe').length, 0)
  release()
  await react.settle()
  assert.equal(frames.length, 1)
  assert.equal(iframe(react).props.dshInteractive, true)
  dispose()
})

test('已信任但文件不在会话的工作区里：仍是静态预览，没有信任按钮', async () => {
  const server = host({ trusted: true })
  const { react, render, dispose } = setup(server)
  render({ src: 'dsh-app://app/sidebar/html/S1/elsewhere/page.html', sandboxed: true, baseUrl: BASE })
  await react.settle()
  assert.notEqual(iframe(react).props.dshInteractive, true)
  assert.equal(notice(react)[0].props['data-trust-notice'], 'document-outside')
  assert.equal(react.all(node => node.type === 'ui.Button' && textOf(node) === 'trust.action.trust').length, 0)
  dispose()
})

test('读不到信任状态时不读资源，说明条给出重试', async () => {
  const server = host({ failStatus: true })
  const { react, render, dispose } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  assert.equal(await iframe(react).props.fetchInlineResource(at('style.css')), undefined)
  await react.settle()
  assert.equal(notice(react)[0].props['data-trust-notice'], 'error')
  assert.ok(!server.requests.some(r => r.url.endsWith('.resource')))
  dispose()
})

test('设置页列出已信任的工作区，撤销后发 revoke', async () => {
  const server = host({ trusted: true })
  const { react, React, registered, dispose, app } = setup(server)
  const section = registered.find(entry => entry.info.name === 'settings.section')
  react.mount(React.createElement(() => section.render({ app })))
  await react.settle()
  assert.match(textOf(react.one(node => node.type === 'ul', '列表')), /~\/proj/)
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'trust.settings.revoke', '撤销按钮'), 'onClick')
  await react.settle()
  assert.ok(server.requests.some(r => r.body?.action === 'revoke' && r.body.path === '/w/proj'))
  assert.equal(react.all(node => node.type === 'p' && textOf(node) === 'trust.settings.empty').length, 1)
  dispose()
})

test('说明条写明信任的后果：页面脚本能读到这些文件并发到外部；拒绝时写明哪些目录不能信任', () => {
  const { client, dispose } = setup(host())
  const zh = client.get('WORKSPACE_TRUST_ZH'), en = client.get('WORKSPACE_TRUST_EN')
  assert.match(zh['trust.notice.untrusted'], /页面里的脚本能读到这些文件的内容，也能把它们发到外部/)
  assert.match(en['trust.notice.untrusted'], /scripts on the page can read these files and send them elsewhere/)
  for (const dict of [zh, en]) assert.match(dict['trust.error.tooBroad'], /Downloads.*Desktop.*Documents/)
  dispose()
})

test('设置页每一条都写出信任的时间', async () => {
  const server = host({ trusted: true })
  const { react, React, registered, dispose, app } = setup(server)
  const section = registered.find(entry => entry.info.name === 'settings.section')
  react.mount(React.createElement(() => section.render({ app })))
  await react.settle()
  assert.match(textOf(react.one(node => node.type === 'ul', '列表')), /trust\.settings\.trustedAt\{"time":"clock\.md/)
  dispose()
})

test('上限在并发下也成立：发请求前就占名额，同一文档最多 4 个请求同时在途', async () => {
  // 宿主端每个请求延迟一点再回答，记下同时在途的最大数。
  let inflight = 0, peak = 0, served = 0
  const server = host({ trusted: true })
  const plain = server.fetch
  server.fetch = async (url, init) => {
    if (!String(url).endsWith('.resource')) return plain(url, init)
    inflight++; peak = Math.max(peak, inflight); served++
    await new Promise(resolve => setTimeout(resolve, 2))
    inflight--
    return new Response('p{}', { status: 200, headers: { 'content-type': 'text/css' } })
  }
  const { react, render, dispose } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  const read = iframe(react).props.fetchInlineResource
  const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => read(at(`big.css?v=${i}`))))
  assert.ok(peak <= 4, `同时在途 ${peak}`)
  assert.equal(served, TRUST_MAX_RESOURCES)
  assert.equal(results.filter(Boolean).length, TRUST_MAX_RESOURCES)
  await react.settle()
  const [shown] = notice(react)
  assert.match(textOf(shown), new RegExp(`trust\\.reason\\.limit ${1000 - TRUST_MAX_RESOURCES}`))
  dispose()
})

test('宿主端重启换了令牌时，重新取一次令牌再发', async () => {
  const server = host()
  const { react, render, dispose } = setup(server)
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  server.token = 'token-2'
  const read = iframe(react).props.fetchInlineResource
  await read(at('style.css'))
  await react.settle()
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'trust.action.trust', '信任按钮'), 'onClick')
  await react.settle()
  assert.equal(server.trusted, true)
  const trustPosts = server.requests.filter(r => r.body?.action === 'trust')
  assert.deepEqual(trustPosts.map(r => r.token), ['token-1', 'token-2'])
  dispose()
})


test('宿主判定文档越界时，客户端即使看见工作区前缀也只给静态预览', async () => {
  const server = host({ trusted: true, documentInside: () => false })
  const { react, render, dispose } = setup(server)
  try {
    render({ src: SRC, sandboxed: true, baseUrl: BASE })
    await react.settle()
    assert.notEqual(iframe(react).props.dshInteractive, true)
    assert.equal(notice(react)[0].props['data-trust-notice'], 'document-outside')
    assert.match(textOf(notice(react)[0]), /trust\.notice\.static/)
    assert.equal(await iframe(react).props.fetchInlineResource(at('style.css')), undefined)
    assert.ok(!server.requests.some(r => r.url.endsWith('.resource')))
  } finally { dispose() }
})

test('宿主判定 Windows 和 UNC 文档在工作区内时，说明条和交互预览都采用宿主结果', async () => {
  for (const src of ['dsh-app://app/sidebar/html/S1/d%3A/work/proj/index.html', 'dsh-app://app/sidebar/html/S1//server/share/proj/index.html']) {
    const server = host({ trusted: true, documentInside: () => true })
    const { react, render, dispose } = setup(server)
    try {
      render({ src, sandboxed: true, baseUrl: BASE })
      await react.settle()
      assert.equal(iframe(react).props.dshInteractive, true, src)
      assert.equal(notice(react).length, 0)
    } finally { dispose() }
  }
})

test('同一会话切换文档会重新预检，不沿用上一份文档的工作区判定', async () => {
  const server = host({ trusted: true })
  const { react, React, render, dispose, TrustFrame } = setup(server)
  try {
    render({ src: SRC, sandboxed: true, baseUrl: BASE })
    await react.settle()
    const Frame = props => React.createElement('iframe', props)
    react.update(React.createElement(TrustFrame, { Frame, src: at('linked.html'), sandboxed: true, baseUrl: BASE }))
    await react.settle()
    assert.notEqual(iframe(react).props.dshInteractive, true)
    assert.equal(notice(react)[0].props['data-trust-notice'], 'document-outside')
    assert.deepEqual(server.requests.filter(r => r.body?.action === 'status').map(r => r.body.documentPath), ['/w/proj/index.html', '/w/proj/linked.html'])
  } finally { dispose() }
})

test('资源接口报告文档越界后，说明条写未运行脚本时预览必须已退回静态', async () => {
  const server = host({ trusted: true })
  const plain = server.fetch
  server.fetch = (url, init) => String(url).endsWith('.resource')
    ? Promise.resolve(new Response(JSON.stringify({ ok: false, reason: 'document-outside' }), { status: 403 }))
    : plain(url, init)
  const { react, render, dispose } = setup(server)
  try {
    render({ src: SRC, sandboxed: true, baseUrl: BASE })
    await react.settle()
    assert.equal(iframe(react).props.dshInteractive, true)
    await iframe(react).props.fetchInlineResource(at('style.css'))
    await react.settle()
    assert.equal(notice(react)[0].props['data-trust-notice'], 'document-outside')
    assert.match(textOf(notice(react)[0]), /trust\.notice\.static/)
    assert.notEqual(iframe(react).props.dshInteractive, true)
  } finally { dispose() }
})

test('运行中停用这一行，不更新外层也立即撤下交互预览和读取函数', async () => {
  const { react, render, dispose, frames } = setup(host({ trusted: true }))
  render({ src: SRC, sandboxed: true, baseUrl: BASE })
  await react.settle()
  assert.equal(iframe(react).props.dshInteractive, true)
  dispose()
  await react.settle()
  assert.equal(iframe(react).props.dshInteractive, undefined)
  assert.equal(iframe(react).props.fetchInlineResource, undefined)
  assert.equal(iframe(react).props.className, 'editorHtml')
  assert.equal(notice(react).length, 0)
  assert.equal(frames.length, 2)
})

test('撤销信任覆盖首次预检仍在途的文档，旧的已信任响应不能恢复交互', async () => {
  const server = host({ trusted: true, documentInside: () => true })
  const plain = server.fetch
  let release
  server.fetch = async (url, init) => {
    const body = init?.body && JSON.parse(init.body)
    const answer = await plain(url, init)
    if (body?.action === 'status' && body.documentPath === '/w/proj/other.html' && release === undefined) {
      await new Promise(resolve => { release = resolve })
    }
    return answer
  }
  const { client, react, React, render, dispose, TrustFrame } = setup(server)
  try {
    render({ src: SRC, sandboxed: true, baseUrl: BASE })
    await react.settle()
    const Frame = props => React.createElement('iframe', props)
    react.update(React.createElement(React.Fragment, null, ...[SRC, at('other.html')].map(src =>
      React.createElement(TrustFrame, { key: src, Frame, src, sandboxed: true, baseUrl: BASE }))))
    await react.settle()
    assert.equal(typeof release, 'function')
    await client.get('workspaceTrustClient').revoke('/w/proj')
    release()
    await react.settle()
    const frames = react.all(node => node.type === 'iframe')
    assert.equal(frames.length, 2)
    assert.ok(frames.every(frame => frame.props.dshInteractive !== true))
    assert.equal(notice(react).filter(node => node.props['data-trust-notice'] === 'untrusted').length, 2)
  } finally { release?.(); dispose() }
})

/** 真实文件与宿主路由；只把浏览器 fetch 接到 connection 的请求处理器。latency 给每个请求多拖几毫秒，模拟宿主忙。 */
function filesystemHost(t, { latency = 0 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dwb-trust-reopen-'))
  const ws = join(base, 'ws'), outside = join(base, 'outside.html'), a = join(ws, 'a.html'), b = join(ws, 'b.html')
  mkdirSync(ws)
  for (const path of [a, b, outside]) writeFileSync(path, '<script>globalThis.ran = true</script>')
  writeFileSync(join(ws, 'style.css'), 'body{}')
  const routes = new Map()
  const dispose = applyWorkspaceTrustRoutes({ connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }, {
    dataDir: join(base, 'data'), home: base, workspaceRootOf: async id => id === 'S1' ? ws : undefined,
  })
  t.after(() => { dispose(); rmSync(base, { recursive: true, force: true }) })
  const requests = []
  // 已经送进宿主、还没回来的请求数。被测试扣在外面、还没送进来的不算。
  let inflight = 0
  const waiters = []
  return {
    a, b, requests,
    src: path => `dsh-app://app/sidebar/html/S1/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
    replaceA: () => { unlinkSync(a); symlinkSync(outside, a) },
    get inflight() { return inflight },
    /** 在途的请求都回来时完成；宿主卡死了就报错，免得测试一直挂着。 */
    idle: () => inflight === 0 ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`在途的请求等了 ${HOST_IDLE_LIMIT_MS} 毫秒还没回来`)), HOST_IDLE_LIMIT_MS)
      waiters.push(() => { clearTimeout(timer); resolve() })
    }),
    async fetch(url, init) {
      inflight++
      try {
        const body = init?.body && JSON.parse(init.body)
        requests.push(body)
        if (latency > 0) await new Promise(resolve => setTimeout(resolve, latency))
        const target = new URL(url, 'http://127.0.0.1/')
        return await routes.get(target.pathname).fetch(new Request(target, init))
      } finally {
        if (--inflight === 0) for (const wake of waiters.splice(0)) wake()
      }
    },
  }
}

test('第二轮：A → B → A，A 被换成外跳符号链接后只显示静态内容和不在工作区内', async t => {
  const server = filesystemHost(t)
  const { client, react, render, element, dispose } = setup(server)
  t.after(dispose)
  await client.get('workspaceTrustClient').trust('S1')
  const props = path => ({ src: server.src(path), sandboxed: true, baseUrl: BASE })
  render(props(server.a))
  await react.settle()
  assert.equal(iframe(react).props.dshInteractive, true)
  react.update(element(props(server.b)))
  await react.settle()
  server.replaceA()
  react.update(element(props(server.a)))
  await react.settle()
  assert.notEqual(iframe(react).props.dshInteractive, true)
  assert.equal(notice(react)[0].props['data-trust-notice'], 'document-outside')
  assert.match(textOf(notice(react)[0]), /trust\.notice\.static/)
  assert.equal(server.requests.filter(body => body?.action === 'status' && body.documentPath === server.a).length, 2)
  assert.ok(!server.requests.some(body => body?.resource), '无本地子资源的 HTML 也要重新预检')
})

for (const opening of ['切回', '关闭后重开']) {
  test(`第二轮：${opening}已缓存文档时，本次预检返回前不挂交互预览`, async t => {
    const server = filesystemHost(t)
    const request = server.fetch
    let hold = false, release
    const paused = new Promise(resolve => { release = resolve })
    server.fetch = async (url, init) => {
      const body = init?.body && JSON.parse(init.body)
      if (hold && body?.action === 'status' && body.documentPath === server.a) await paused
      return request(url, init)
    }
    const { client, react, render, element, dispose } = setup(server)
    try {
      await client.get('workspaceTrustClient').trust('S1')
      const props = path => ({ src: server.src(path), sandboxed: true, baseUrl: BASE })
      render(props(server.a))
      await react.settle()
      assert.equal(iframe(react).props.dshInteractive, true)
      react.update(opening === '切回' ? element(props(server.b)) : null)
      await react.settle()
      hold = true
      react.update(element(props(server.a)))
      await react.settle()
      assert.equal(react.all(node => node.type === 'iframe' && node.props.dshInteractive === true).length, 0)
      release()
      await react.settle()
      assert.equal(iframe(react).props.dshInteractive, true, '本次预检通过后正常运行脚本')
      assert.equal(server.requests.filter(body => body?.action === 'status' && body.documentPath === server.a).length, 2)
    } finally { release(); dispose() }
  })
}

test('第二轮：资源报告 document-outside 时刷新文档状态，切走再切回仍保持静态', async t => {
  const server = filesystemHost(t)
  const { client, react, render, element, dispose } = setup(server)
  t.after(dispose)
  const trust = client.get('workspaceTrustClient')
  await trust.trust('S1')
  const props = path => ({ src: server.src(path), sandboxed: true, baseUrl: BASE })
  render(props(server.a))
  await react.settle()
  server.replaceA()
  const read = iframe(react).props.fetchInlineResource
  assert.equal(await read(new URL('style.css', server.src(server.a)).href), undefined)
  await react.settle()
  assert.equal(trust.status({ sessionId: 'S1', path: server.a }).documentInside, false)
  assert.notEqual(iframe(react).props.dshInteractive, true)
  react.update(element(props(server.b)))
  await react.settle()
  react.update(element(props(server.a)))
  await react.settle()
  assert.equal(notice(react)[0].props['data-trust-notice'], 'document-outside')
  assert.notEqual(iframe(react).props.dshInteractive, true)
})

test('第二轮：宿主响应慢（每个请求多等 4 毫秒）时，settle 要等在途的请求落定；被测试扣住的请求不算在途', async t => {
  const server = filesystemHost(t, { latency: 4 })
  const request = server.fetch
  let hold = false, release
  const paused = new Promise(resolve => { release = resolve })
  server.fetch = async (url, init) => {
    const body = init?.body && JSON.parse(init.body)
    if (hold && body?.action === 'status' && body.documentPath === server.a) await paused
    return request(url, init)
  }
  const { client, react, render, element, dispose } = setup(server)
  try {
    await client.get('workspaceTrustClient').trust('S1')
    const props = path => ({ src: server.src(path), sandboxed: true, baseUrl: BASE })
    render(props(server.a))
    await react.settle()
    assert.equal(iframe(react).props.dshInteractive, true, '首次预检回来之后才算落定')
    react.update(element(props(server.b)))
    await react.settle()
    hold = true
    react.update(element(props(server.a)))
    await react.settle()
    assert.equal(react.all(node => node.type === 'iframe' && node.props.dshInteractive === true).length, 0, '预检被扣住时不挂交互预览，settle 也不能卡在被扣住的请求上')
    release()
    await react.settle()
    assert.equal(iframe(react).props.dshInteractive, true, '放行后本次预检落定，正常运行脚本')
    assert.equal(server.requests.filter(body => body?.action === 'status' && body.documentPath === server.a).length, 2)
  } finally { release(); dispose() }
})

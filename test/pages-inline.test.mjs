/** 网页发布的内联和 CSP：正则替换不碰 <script>/<style> 的正文、限额报哪个文件多大、
 * CSP 插在 head 最前、多 meta 叠加。 */
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { applyPageHardening, cspMetaTag } from '../lib/pages-csp.js'
import { inlineHtml, MAX_ASSETS, MAX_ASSET_BYTES } from '../lib/pages-inline.js'
import { PagesError } from '../lib/pages-error.js'

import { cspPrologCases } from './pages-csp-cases.mjs'

for (const [name, prefix, rest] of cspPrologCases) {
  test(`W-001 rework: HTML5 prolog boundary for ${name}`, () => {
    const content = `${rest}<script id="untrusted">0</script>`
    const output = applyPageHardening(prefix + content)
    assert.ok(output.startsWith(prefix + '<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'), name)
    assert.ok(output.endsWith(content), 'the original content must stay after the policy')
  })
}

test('W-001: CSP precedes short-comment active content', () => {
  for (const start of ['<!-->', '<!--->', '<!-- --!>']) {
    const out = applyPageHardening(`${start}<script id="untrusted">0</script>-->`)
    assert(out.indexOf('Content-Security-Policy') < out.indexOf('id="untrusted"'))
  }
})

/** 照注入的 readAsset 造一个假的：按路径回答字节和 MIME。 */
function fakeAssets(map, reads = []) {
  return {
    readAsset: async (path) => {
      reads.push(path)
      const hit = map[path]
      if (hit === undefined) throw new Error('未找到')
      return hit
    },
    reads,
  }
}

const bytesOf = (text) => new TextEncoder().encode(text)

test('W-002: HTML5 short comments leave active resources and base visible', async () => {
  for (const start of ['<!-->', '<!--->', '<!-- --!>']) {
    const assets = fakeAssets({ 'a.js': { bytes: bytesOf('active()'), mime: 'text/javascript' } })
    const result = await inlineHtml(`${start}<script src="a.js"></script>-->`, assets.readAsset)
    assert.deepEqual(result.assets.scripts, ['a.js'], start)
    assert(result.html.includes('<script>active()</script>'))
    const base = await inlineHtml(`${start}<base href="/other/">--><script src="a.js"></script>`, assets.readAsset)
    assert(base.warnings.some(w => w.includes('base href')), start)
    assert.deepEqual(base.assets.scripts, [])
  }
})

test('内联：相对路径的脚本、样式表、图片都换进去，URL 属性、大小写、空白都吃得下', async () => {
  const { readAsset } = fakeAssets({
    'app.js': { bytes: bytesOf('console.log(1)'), mime: 'text/javascript' },
    'style/main.css': { bytes: bytesOf('body{color:red}'), mime: 'text/css' },
    'img/a.png': { bytes: bytesOf('png'), mime: 'image/png' },
  })
  const html = [
    '<html><head>',
    "<link rel=\"stylesheet\" href = 'style/main.css' >",
    '<script src=app.js defer></script>',
    '</head><body>',
    '<img alt="a" src="img/a.png">',
    '</body></html>',
  ].join('')
  const { html: out, assets, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(warnings, [])
  assert.match(out, /<style>body\{color:red\}<\/style>/)
  assert.match(out, /<script>console\.log\(1\)<\/script>/)
  assert.match(out, /src="data:image\/png;base64,/)
  // 原来的引用没了
  assert.doesNotMatch(out, /src=app\.js|href = 'style\/main\.css'|src="img\/a\.png"/)
  assert.deepEqual(assets, { scripts: ['app.js'], styles: ['style/main.css'], images: ['img/a.png'] })
})

test('内联：<script> 正文里的 "<img src=…>" 字符串不当标签；<style> 正文里的 url() 也内联', async () => {
  const { readAsset } = fakeAssets({
    'b.png': { bytes: bytesOf('png'), mime: 'image/png' },
    'a.js': { bytes: bytesOf('var s = "<img src=\\"photo.png\\">"'), mime: 'text/javascript' },
  })
  const html = '<script src="a.js"></script><style>div{background:url(  "b.png" )}</style>'
  const { html: out, assets } = await inlineHtml(html, readAsset)
  assert.match(out, /var s = "<img src=\\"photo\.png\\">"/)
  assert.match(out, /<style>div\{background:url\("data:image\/png;base64,/)
  assert.deepEqual(assets, { scripts: ['a.js'], styles: [], images: [] })
})

test('内联：绝对地址原样保留；相对路径越界、不认识的扩展名给警告', async () => {
  const { readAsset, reads } = fakeAssets({})
  const html = [
    '<script src="https://cdn.example.com/a.js"></script>',
    '<link rel="stylesheet" href="data:text/css,body{}">',
    '<img src="//cdn.example.com/b.png">',
    '<img src="../outside.png">',
    '<img src="photo.avif">',
  ].join('')
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.equal(out, html)
  assert.deepEqual(reads, [])
  assert.equal(warnings.filter(w => w.includes('outside.png')).length, 1)
  assert.equal(warnings.filter(w => w.includes('photo.avif')).length, 1)
})

test('内联：<base href> 时整版不内联，给一条警告', async () => {
  const { readAsset, reads } = fakeAssets({ 'a.js': { bytes: bytesOf('x'), mime: 'text/javascript' } })
  const html = '<base href="/x/"><script src="a.js"></script>'
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.equal(out, html)
  assert.deepEqual(reads, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /base href/)
})

test('内联：同一个资源引用两次只读一次；hash、query 不内联', async () => {
  const { readAsset, reads } = fakeAssets({ 'a.js': { bytes: bytesOf('x'), mime: 'text/javascript' } })
  const html = '<script src="a.js?v=2"></script><script src="a.js"></script>'
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(reads, ['a.js'])
  // 带 query 的那个保留（页面上多半是缓存破坏写法，沙箱里加载不了，给警告），第二个内联了
  assert.match(out, /src="a\.js\?v=2"/)
  assert.match(out, /<script>x<\/script>/)
  assert.equal(warnings.length, 1)
})

test('内联：单个资源超 4 MiB 抛错，写明哪个文件、多大；读不到给警告', async () => {
  const big = { bytes: new Uint8Array(MAX_ASSET_BYTES + 1), mime: 'image/png' }
  const { readAsset } = fakeAssets({ 'big.png': big })
  await assert.rejects(inlineHtml('<img src="big.png">', readAsset), (error) => {
    assert.ok(error instanceof PagesError)
    assert.equal(error.code, 'asset-too-large')
    assert.match(error.message, /big\.png/)
    assert.match(error.message, /4 MiB/)
    return true
  })
  const missing = fakeAssets({}).readAsset
  const { warnings } = await inlineHtml('<img src="gone.png">', missing)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /gone\.png/)
})

test('内联：超过 64 个资源抛错，写明是哪一个', async () => {
  const map = {}
  const html = []
  for (let i = 0; i < MAX_ASSETS + 1; i++) {
    map[`f${i}.js`] = { bytes: bytesOf('x'), mime: 'text/javascript' }
    html.push(`<script src="f${i}.js"></script>`)
  }
  const { readAsset } = fakeAssets(map)
  await assert.rejects(inlineHtml(html.join(''), readAsset), (error) => {
    assert.ok(error instanceof PagesError)
    assert.equal(error.code, 'too-many-assets')
    assert.match(error.message, /f64\.js/)
    return true
  })
})

test('内联：一版资源总量超 16 MiB 抛错，写明添上哪个文件会超', async () => {
  const quarter = new Uint8Array(MAX_ASSET_BYTES)
  const map = {}
  const html = []
  for (let i = 0; i < 5; i++) {
    map[`p${i}.png`] = { bytes: quarter, mime: 'image/png' }
    html.push(`<img src="p${i}.png">`)
  }
  const { readAsset } = fakeAssets(map)
  await assert.rejects(inlineHtml(html.join(''), readAsset), (error) => {
    assert.ok(error instanceof PagesError)
    assert.equal(error.code, 'assets-too-large')
    assert.match(error.message, /p4\.png/)
    assert.match(error.message, /16 MiB/)
    return true
  })
})

test('CSP：自己的 head 插在文档最开头（charset、CSP meta、上报脚本）；范围和计划一致', () => {
  const out = applyPageHardening('<html><head><meta charset="utf8"><title>t</title></head><body></body></html>')
  assert.match(out, /^<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content=".*"><script>.*<\/script><\/head><html><head><meta charset="utf8">/s)
  const content = /content="([^"]*)"/.exec(out)[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"')
  for (const piece of [
    "default-src 'none'",
    "script-src 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net unpkg.com",
    "style-src 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net unpkg.com fonts.googleapis.com",
    'font-src data: fonts.gstatic.com',
    'img-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
  ]) assert.ok(content.includes(piece), piece)
  // 上报脚本报 dwb-csp 和被拦地址，去重
  assert.match(out, /type:"dwb-csp"/)
  assert.match(out, /securitypolicyviolation/)
})

test('CSP：已有 CSP 的页面再叠一个 meta；doctype、BOM、注释之后插；没有 head、没有 html 也一样', () => {
  const own = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src &quot;x&quot;"><title>t</title></head></html>'
  const out = applyPageHardening(own)
  // 用户自己的 meta 原样留着（更严的赢是浏览器逐条叠加的结果，这里只看两个都在，我们的在前）
  assert.match(out, /script-src &quot;x&quot;/)
  assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('script-src &quot;x&quot;'))
  // doctype 保持在最前（插在它前面页面会进怪异模式）
  const doctype = applyPageHardening('<!DOCTYPE html>\n<html><body>x</body></html>')
  assert.match(doctype, /^<!DOCTYPE html>\n<head><meta charset="utf-8">/)
  const bom = applyPageHardening('\uFEFF<!doctype html><body>x</body>')
  assert.match(bom, /^\uFEFF<!doctype html><head>/)
  const bare = applyPageHardening('hello')
  assert.match(bare, /^<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/)
  assert.ok(bare.endsWith('</head>hello'))
})

test('CSP：不去找页面里的 <head>——注释、脚本字符串、属性值里的 "<head>" 骗不了它，页面脚本也不会先于 CSP', () => {
  const metaAt = (html) => applyPageHardening(html).indexOf('<meta http-equiv="Content-Security-Policy"')
  const firstScriptAt = (html) => applyPageHardening(html).indexOf('fetch(')
  const cases = [
    '<!-- <head> --><script>fetch("https://evil.example/")</script>',
    '<script>var h="<head>";fetch("https://evil.example/")</script><head></head>',
    '<div data-x="<head>"></div><script>fetch("https://evil.example/")</script>',
    '<head data-x=">"><script>fetch("https://evil.example/")</script></head>',
    '<script>fetch("https://evil.example/")</script><head></head>',
  ]
  for (const html of cases) {
    const out = applyPageHardening(html)
    assert.ok(metaAt(html) !== -1 && metaAt(html) < firstScriptAt(html), html)
    // meta 不在注释里：它前面没有没关的注释
    assert.ok(!/<!--(?:(?!-->)[\s\S])*<meta http-equiv="Content-Security-Policy"/.test(out), html)
  }
})

test('拦截上报脚本：读 blockedURI，只报网络地址，同一个地址只报一次（在假的 document 和 parent 里真的跑一遍）', async () => {
  const { cspReportScriptTag } = await import('../lib/pages-csp.js')
  const script = cspReportScriptTag().replace(/^<script>/, '').replace(/<\/script>$/, '')
  const handlers = []
  const posted = []
  runInNewContext(script, {
    document: { addEventListener: (type, handler, capture) => handlers.push({ type, handler, capture }) },
    parent: { postMessage: (data, target) => posted.push({ data, target }) },
  })
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].type, 'securitypolicyviolation')
  assert.equal(handlers[0].capture, true)
  const fire = (blockedURI) => handlers[0].handler({ blockedURI })
  fire('https://example.com/a.png')
  fire('https://example.com/a.png')
  fire('wss://example.org/socket')
  fire('eval')
  fire('inline')
  fire('data')
  fire(undefined)
  // vm 里建的对象原型不是本进程的，先过一遍 JSON 再比。
  assert.deepEqual(posted.map(item => JSON.parse(JSON.stringify(item.data))), [
    { type: 'dwb-csp', blocked: 'https://example.com/a.png' },
    { type: 'dwb-csp', blocked: 'wss://example.org/socket' },
  ])
  assert.ok(posted.every(item => item.target === '*'))
})

test('内联：<style> 在标签引用之前时，编辑按位置排序，页面不被写坏', async () => {
  const { readAsset } = fakeAssets({
    'bg.png': { bytes: bytesOf('bg'), mime: 'image/png' },
    'logo.png': { bytes: bytesOf('logo'), mime: 'image/png' },
  })
  const html = '<head><style>body{background:url(bg.png)}</style></head><body><img src="logo.png"><p>hello</p></body></html>'
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(warnings, [])
  // 一份 <style>、一个 <img>、一个 <p>，没有多出来的尾巴
  assert.equal(out.match(/<style>/g).length, 1)
  assert.equal(out.match(/<\/style>/g).length, 1)
  assert.equal(out.match(/<p>hello<\/p>/g).length, 1)
  assert.match(out, /^<head><style>body\{background:url\("data:image\/png;base64,[^"]+"\)\}<\/style><\/head><body><img src="data:image\/png;base64,[^"]+"><p>hello<\/p><\/body><\/html>$/)
})

test('内联：资源里的 </script、<!--、</style 转义，不会提前结束或跳出', async () => {
  const { readAsset } = fakeAssets({
    'a.js': { bytes: bytesOf('var t="</script><h1 id=pwn>x</h1><script>"; var c="<!--"'), mime: 'text/javascript' },
    's.css': { bytes: bytesOf('a::after{content:"</style><h1 id=pwn2>"}'), mime: 'text/css' },
  })
  const { html: out } = await inlineHtml('<html><head><link rel="stylesheet" href="s.css"></head><body><script src="a.js"></script></body></html>', readAsset)
  // 结束标签只剩我们自己加的那一个：脚本和样式的正文原样（转义后）在它们里面
  assert.equal(out.match(/<\/script>/g).length, 1)
  assert.equal(out.match(/<\/style>/g).length, 1)
  const script = out.slice(out.indexOf('<script>') + '<script>'.length, out.indexOf('</script>'))
  assert.equal(script, 'var t="<\\/script><h1 id=pwn>x</h1><script>"; var c="<\\!--"')
  const style = out.slice(out.indexOf('<style>') + '<style>'.length, out.indexOf('</style>'))
  assert.equal(style, 'a::after{content:"<\\/style><h1 id=pwn2>"}')
})

test('内联：x.constructor、x.__proto__ 这种名字不当图片，也不当脚本资源的类型', async () => {
  const { readAsset, reads } = fakeAssets({
    'x.constructor': { bytes: bytesOf('1'), mime: 'image/png' },
    'x.__proto__': { bytes: bytesOf('1'), mime: 'image/png' },
  })
  const { html: out, warnings } = await inlineHtml('<img src="x.constructor"><img src="x.__proto__">', readAsset)
  assert.deepEqual(reads, [])
  assert.equal(warnings.length, 2)
  assert.equal(out, '<img src="x.constructor"><img src="x.__proto__">')
})

test('内联：大量没有收尾的标签或注释不会让正则按平方级卡住（8 万个 <script  不到 10 秒；旧代码一项就 36 秒，正常不到 1 秒，留足负载高时的余量）', async () => {
  const { readAsset } = fakeAssets({})
  const started = Date.now()
  await inlineHtml('<script '.repeat(80000), readAsset)
  await inlineHtml('<img '.repeat(80000), readAsset)
  await inlineHtml('<base '.repeat(80000), readAsset)
  await inlineHtml('<!-- '.repeat(80000), readAsset)
  assert.ok(Date.now() - started < 10000, `用了 ${Date.now() - started} 毫秒`)
})

test('内联：空白正文的 <script src></script> 照样内联；<base/href=…> 写法也算 base', async () => {
  const { readAsset } = fakeAssets({ 'a.js': { bytes: bytesOf('1'), mime: 'text/javascript' } })
  const spaced = await inlineHtml('<script src="a.js">\n  </script>', readAsset)
  assert.equal(spaced.html, '<script>1</script>')
  const base = await inlineHtml('<base/href="https://x.example/"><script src="a.js"></script>', readAsset)
  assert.equal(base.assets.scripts.length, 0)
  assert.equal(base.warnings.length, 1)
})

test('内联：样式表里的 url() 相对样式表自己的目录，<style> 里的 url() 仍相对 HTML 目录', async () => {
  const { readAsset, reads } = fakeAssets({
    'css/main.css': { bytes: bytesOf('a{background:url(../img/bg.png)}b{background:url(bg.png)}'), mime: 'text/css' },
    'img/bg.png': { bytes: bytesOf('bg-img'), mime: 'image/png' },
    'css/bg.png': { bytes: bytesOf('bg-css'), mime: 'image/png' },
    'bg.png': { bytes: bytesOf('bg-root'), mime: 'image/png' },
  })
  const html = '<head><link rel="stylesheet" href="css/main.css"><style>c{background:url(bg.png)}</style></head>'
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(warnings, [])
  assert.deepEqual(reads, ['css/main.css', 'img/bg.png', 'css/bg.png', 'bg.png'])
  const dataUrlOf = (block) => Buffer.from(/url\("data:image\/png;base64,([^"]+)"\)/.exec(block)[1], 'base64').toString()
  // css/main.css 里两处各自内联成 css 目录解析出的文件：<style> 里那处还是根目录的 bg.png
  assert.equal(dataUrlOf(out), 'bg-img')
  assert.equal(dataUrlOf(out.slice(out.indexOf('b{'))), 'bg-css')
  assert.equal(dataUrlOf(out.slice(out.indexOf('<style>c{'))), 'bg-root')
})

test('内联：@import url(…) 和 @import "…" 都给一条「不支持 @import」的警告，不当图片或悄悄跳过', async () => {
  const { readAsset, reads } = fakeAssets({ 'x.css': { bytes: bytesOf('a{}'), mime: 'text/css' } })
  const html = '<style>@import url(x.css); @import "y.css";</style>'
  const { html: out, assets, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(reads, [])
  assert.equal(assets.styles.length, 0)
  assert.equal(out, html)
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every(w => w.includes('@import') && w.includes('没有内联')), warnings.join('\n'))
})

test('内联：带 defer 的脚本挪到 </body> 之前，按原来的先后顺序；没有 </body> 时放文档末尾', async () => {
  const { readAsset } = fakeAssets({
    'a.js': { bytes: bytesOf('A()'), mime: 'text/javascript' },
    'b.js': { bytes: bytesOf('B()'), mime: 'text/javascript' },
  })
  const withBody = await inlineHtml('<html><head><script src="a.js" defer></script><script src="b.js" defer></script></head><body><p>x</p></body></html>', readAsset)
  assert.ok(withBody.html.endsWith('<p>x</p><script>A()</script><script>B()</script></body></html>'), withBody.html)
  assert.ok(!withBody.html.includes('<head><script>'))
  const noBody = await inlineHtml('<script src="a.js" defer></script><p>x</p>', readAsset)
  assert.equal(noBody.html, '<p>x</p><script>A()</script>')
})

test('内联：type="module" 保留并警告 import 不会被内联；async 去掉，id/class/title/data-* 带过去', async () => {
  const { readAsset } = fakeAssets({
    'm.js': { bytes: bytesOf('export const x = 1'), mime: 'text/javascript' },
    'a.js': { bytes: bytesOf('A()'), mime: 'text/javascript' },
  })
  const html = [
    '<head>',
    '<script type="module" src="m.js"></script>',
    '<script src="a.js" async id="s1" class="c" title="t" data-k="v" integrity="sha" crossorigin="anonymous" nonce="n"></script>',
    '</head>',
  ].join('')
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.match(out, /<script type="module">export const x = 1<\/script>/)
  assert.ok(!out.includes('async'), out)
  assert.match(out, /<script id="s1" class="c" title="t" data-k="v">A\(\)<\/script>/)
  assert.ok(!/integrity|crossorigin|nonce/.test(out), out)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /模块脚本.*import.*不会被内联/)
})

test('内联：<link rel=stylesheet media="print"> 变成 <style media="print">，其余该带的带、该丢的丢', async () => {
  const { readAsset } = fakeAssets({ 's.css': { bytes: bytesOf('a{color:red}'), mime: 'text/css' } })
  const html = '<link rel="stylesheet" href="s.css" media="print" id="l1" class="c" title="t" data-x="1" integrity="sha" crossorigin="anonymous" nonce="n">'
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(warnings, [])
  // 保留的属性按标签里原来的顺序
  assert.equal(out, '<style media="print" id="l1" class="c" title="t" data-x="1">a{color:red}</style>')
})

test('内联：不带引号的 <img src=a.png> 也替换；data-src 不被误写成 data 地址', async () => {
  const { readAsset, reads } = fakeAssets({ 'a.png': { bytes: bytesOf('A'), mime: 'image/png' } })
  const html = '<img src=a.png><img data-src="lazy.png" src="a.png">'
  const { html: out, assets } = await inlineHtml(html, readAsset)
  assert.deepEqual(reads, ['a.png'])
  assert.deepEqual(assets.images, ['a.png', 'a.png'])
  assert.match(out, /^<img src="data:image\/png;base64,[^"]+"><img data-src="lazy.png" src="data:image\/png;base64,[^"]+">$/)
})

test('内联：注释里的引用不读、不计数，也不因超限让发布失败；注释原样保留', async () => {
  const huge = { bytes: new Uint8Array(MAX_ASSET_BYTES + 1), mime: 'image/png' }
  const { readAsset, reads } = fakeAssets({ 'huge.png': huge, 'a.png': { bytes: bytesOf('A'), mime: 'image/png' } })
  const html = '<!-- <img src=huge.png> --><!-- <script src="a.js"></script> --><img src="a.png">'
  const { html: out, assets, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(reads, ['a.png'])
  assert.deepEqual(assets.images, ['a.png'])
  assert.deepEqual(warnings, [])
  assert.ok(out.startsWith('<!-- <img src=huge.png> --><!-- <script src="a.js"></script> -->'), out)
})

test('内联：%20 解码后找文件；%2f、%00、%5c 解码出分隔符或 NUL 的不内联并给警告', async () => {
  const { readAsset, reads } = fakeAssets({
    'my pic.png': { bytes: bytesOf('P'), mime: 'image/png' },
    'a.png': { bytes: bytesOf('A'), mime: 'image/png' },
  })
  const html = [
    '<img src="my%20pic.png">',
    '<img src="a%2fb.png">',
    '<img src="a%00b.png">',
    '<img src="a%5cb.png">',
    '<style>body{background:url(my%20pic.png)}</style>',
  ].join('')
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(reads, ['my pic.png'])
  // img 的 src 和样式里的 url() 都解码后内联成 my pic.png
  assert.equal(out.match(/src="data:image\/png;base64,/g).length, 1)
  assert.match(out, /url\("data:image\/png;base64,/)
  assert.ok(out.includes('src="a%2fb.png"') && out.includes('src="a%00b.png"') && out.includes('src="a%5cb.png"'))
  assert.equal(warnings.length, 3)
  assert.ok(warnings.every(w => w.includes('没有内联')), warnings.join('\n'))
})

test('内联：注释和脚本字符串里的 <base href> 不再让整页不内联', async () => {
  const { readAsset, reads } = fakeAssets({ 'a.js': { bytes: bytesOf('var b = 1;'), mime: 'text/javascript' } })
  const html = [
    '<!-- <base href="/x/"> -->',
    "<script>var s = \"<base href='/y/'>\";</script>",
    '<script src="a.js"></script>',
  ].join('')
  const { html: out, assets, warnings } = await inlineHtml(html, readAsset)
  assert.deepEqual(reads, ['a.js'])
  assert.deepEqual(assets.scripts, ['a.js'])
  assert.deepEqual(warnings, [])
  assert.match(out, /<script>var b = 1;<\/script>/)
})

test('内联：行内样式 url()、srcset、<source src>、poster 暂不内联，各给一条「没有内联」的警告', async () => {
  const { readAsset, reads } = fakeAssets({ 'a.png': { bytes: bytesOf('A'), mime: 'image/png' } })
  const html = [
    '<div style="background:url(a.png)">x</div>',
    '<img src="a.png" srcset="a.png 1x, b.png 2x">',
    '<video poster="p.png" controls><source src="v.mp4" type="video/mp4"></video>',
  ].join('')
  const { html: out, warnings } = await inlineHtml(html, readAsset)
  // img 的 src 照常内联；其余四处引用原样留着，各有一条警告
  assert.deepEqual(reads, ['a.png'])
  assert.match(out, /src="data:image\/png;base64,/)
  assert.ok(out.includes('style="background:url(a.png)"'), out)
  assert.ok(out.includes('srcset="a.png 1x, b.png 2x"'), out)
  assert.ok(out.includes('poster="p.png"'), out)
  assert.ok(out.includes('<source src="v.mp4" type="video/mp4">'), out)
  assert.equal(warnings.length, 4)
  assert.ok(warnings.every(w => w.includes('没有内联')), warnings.join('\n'))
})

test('内联：同一个大资源被引用很多次，整页超过上限时抛 page-too-large，不先拼出一个巨大的字符串', async () => {
  const big = new Uint8Array(3 * 1024 * 1024)
  const { readAsset } = fakeAssets({ 'a.png': { bytes: big, mime: 'image/png' } })
  const html = '<img src="a.png">'.repeat(12)
  await assert.rejects(inlineHtml(html, readAsset), (error) => {
    assert.ok(error instanceof PagesError)
    assert.equal(error.code, 'page-too-large')
    assert.match(error.message, /a\.png/)
    assert.match(error.message, /32 MiB/)
    return true
  })
})

for (const src of ['src="pic.png"', "SRC='pic.png'", 'src=pic.png']) {
  test(`W-013 inline the real ${src} without replacing src text in another attribute`, async () => {
    const { readAsset } = fakeAssets({ 'pic.png': { bytes: bytesOf('png'), mime: 'image/png' } })
    const prefix = '<img alt="example src=foo" title="src=sample" data-src="lazy.png" '
    const result = await inlineHtml(prefix + src + ' class="photo">', readAsset)
    assert.equal(result.html, prefix + 'src="data:image/png;base64,cG5n" class="photo">')
    assert.deepEqual(result.assets.images, ['pic.png'])
  })
}

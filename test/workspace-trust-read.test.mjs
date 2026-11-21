/**
 * 工作区信任（feat#121）的宿主端：/sidebar/html/ 路径解码、浏览器一侧的地址分类、边界检查和读取。
 * 路径边界都在临时目录里用真的文件、符号链接和 `..` 测，不只测字符串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { decodePreviewRoute, classifyPreviewResource } from '../lib/workspace-trust-route.js'
import { readTrustedResource, mediaTypeOf, documentInWorkspace } from '../lib/workspace-trust-read.js'

test('路由路径解码和 better-sidebar 的编码规则一致', () => {
  assert.deepEqual(decodePreviewRoute('S1/Users/me/proj/index.html'), { sessionId: 'S1', path: '/Users/me/proj/index.html' })
  assert.deepEqual(decodePreviewRoute('S1/Users/me/a%20b/x.css'), { sessionId: 'S1', path: '/Users/me/a b/x.css' })
  assert.deepEqual(decodePreviewRoute('S1/~/notes/x.html'), { sessionId: 'S1', path: '~/notes/x.html' })
  assert.deepEqual(decodePreviewRoute('S1//server/share/a.html'), { sessionId: 'S1', path: '//server/share/a.html' })
  assert.deepEqual(decodePreviewRoute('S1/C%3A/work/a.html'), { sessionId: 'S1', path: 'C:/work/a.html' })
  assert.deepEqual(decodePreviewRoute('a%2Fb/Users/x.css'), { sessionId: 'a/b', path: '/Users/x.css' })
})

test('解码不了、缺会话或路径、带 NUL 的都回 null', () => {
  for (const bad of ['', 'S1', 'S1/', '/Users/x', 'S1/a//b', 'S1/%E0%A4%A', 'S1/a%00b.css', 'S1/a/%00', 42, undefined]) {
    assert.equal(decodePreviewRoute(bad), null, String(bad))
  }
})

const DOC = 'dsh-app://app/sidebar/html/S1/Users/me/proj/index.html'
test('同一个会话 /sidebar/html/ 下的同源地址交给宿主端判断', () => {
  assert.deepEqual(classifyPreviewResource('dsh-app://app/sidebar/html/S1/Users/me/proj/style.css', DOC),
    { kind: 'route', document: 'S1/Users/me/proj/index.html', resource: 'S1/Users/me/proj/style.css' })
  // 越界的 ../ 也交给宿主端：浏览器只看前缀，边界由宿主端定。
  assert.equal(classifyPreviewResource(new URL('../../../../../../etc/hosts', DOC).href, DOC).kind, 'other-route')
  assert.equal(classifyPreviewResource(new URL('../../../../etc/hosts', DOC).href, DOC).kind, 'other-session')
  assert.equal(classifyPreviewResource('dsh-app://app/sidebar/html/S1/etc/hosts', DOC).kind, 'route')
  // 带反向代理前缀时，前缀也要一样。
  const proxied = 'https://box.example/dsh/sidebar/html/S1/w/index.html'
  assert.equal(classifyPreviewResource('https://box.example/dsh/sidebar/html/S1/w/a.css', proxied).kind, 'route')
  assert.equal(classifyPreviewResource('https://box.example/sidebar/html/S1/w/a.css', proxied).kind, 'other-route')
})

test('同源的其他接口、其他会话、别的来源分开归类', () => {
  assert.equal(classifyPreviewResource('dsh-app://app/api/dsh-workbench.features', DOC).kind, 'other-route')
  assert.equal(classifyPreviewResource('dsh-app://app/sidebar/api/fs.read', DOC).kind, 'other-route')
  assert.equal(classifyPreviewResource('dsh-app://app/sidebar/html/S2/Users/me/proj/style.css', DOC).kind, 'other-session')
  assert.equal(classifyPreviewResource('dsh-app://app/sidebar/html/S10/Users/me/proj/style.css', DOC).kind, 'other-session')
  assert.equal(classifyPreviewResource('https://cdn.example/x.css', DOC).kind, 'cross-origin')
  assert.equal(classifyPreviewResource('http://127.0.0.1:3000/sidebar/html/S1/Users/me/proj/style.css', DOC).kind, 'cross-origin')
  assert.equal(classifyPreviewResource('not a url', DOC).kind, 'cross-origin')
  assert.equal(classifyPreviewResource('dsh-app://app/sidebar/html/S1/a.css', 'dsh-app://app/api/x').kind, 'other-route')
})

test('类型只认扩展名白名单', () => {
  assert.equal(mediaTypeOf('/a/b/style.CSS'), 'text/css')
  assert.equal(mediaTypeOf('/a/app.mjs'), 'text/javascript')
  assert.equal(mediaTypeOf('/a/f.woff2'), 'font/woff2')
  assert.equal(mediaTypeOf('/a/v.mp4'), 'video/mp4')
  assert.equal(mediaTypeOf('/a/i.svg'), 'image/svg+xml')
  assert.equal(mediaTypeOf('/a/media/sub.VTT'), 'text/vtt')
  for (const bad of ['/a/data.json', '/a/notes.txt', '/a/page.html', '/a/Makefile', '/a/x.constructor', '/a/x.__proto__', '/a/sub.srt']) {
    assert.equal(mediaTypeOf(bad), undefined, bad)
  }
})

/** 临时目录里的工作区：ws 是根，outside 在它外面，ws-link 是指向根的符号链接。 */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dwb-trust-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const ws = join(base, 'ws'), outside = join(base, 'outside')
  for (const dir of [ws, outside, join(ws, 'img'), join(ws, '.git'), join(ws, '.hidden'), join(ws, 'dir.css'), join(ws, 'sub')]) mkdirSync(dir, { recursive: true })
  const files = {
    'ws/index.html': '<link rel=stylesheet href=style.css>', 'ws/style.css': 'body{color:red}', 'ws/app.js': 'void 0',
    'ws/img/a.png': 'PNG', 'ws/.env': 'TOKEN=secret', 'ws/.git/config': '[core]', 'ws/.hidden/x.css': 'hidden{}',
    'ws/notes.txt': 'notes', 'ws/data.json': '{}', 'ws/sub/page.html': '<p>', 'outside/secret.css': 'secret{}', 'outside/secret.txt': 'secret',
    'outside/page.html': '<p>',
  }
  for (const [path, text] of Object.entries(files)) writeFileSync(join(base, path), text)
  symlinkSync(join(outside, 'secret.css'), join(ws, 'link-out.css'))
  symlinkSync(outside, join(ws, 'link-dir'))
  symlinkSync('style.css', join(ws, 'link-in.css'))
  symlinkSync('.env', join(ws, 'link-dot.css'))
  symlinkSync('notes.txt', join(ws, 'disguised.css'))
  symlinkSync('.git', join(ws, 'git-link'))
  symlinkSync(ws, join(base, 'ws-link'))
  const trusted = new Set([realpathSync(ws)])
  const read = (resource, options = {}) => readTrustedResource({
    root: options.root ?? ws, documentPath: options.document ?? join(ws, 'index.html'), resourcePath: resource,
    isTrusted: path => trusted.has(path), home: options.home ?? base, maxBytes: options.maxBytes, onChecked: options.onChecked, onOpened: options.onOpened,
  })
  return { base, ws, outside, trusted, read }
}

test('信任的工作区里的样式、脚本、图片照常读，类型由扩展名定', async (t) => {
  const { ws, read } = fixture(t)
  const css = await read(join(ws, 'style.css'))
  assert.equal(css.ok, true)
  assert.equal(css.mediaType, 'text/css')
  assert.equal(Buffer.from(css.bytes).toString(), 'body{color:red}')
  assert.equal(css.display, 'style.css')
  assert.equal((await read(join(ws, 'app.js'))).mediaType, 'text/javascript')
  assert.equal((await read(join(ws, 'img', 'a.png'))).display, 'img/a.png')
  // 指回工作区内的符号链接可以读，类型看真实文件。
  const linked = await read(join(ws, 'link-in.css'))
  assert.equal(linked.ok, true)
  assert.equal(Buffer.from(linked.bytes).toString(), 'body{color:red}')
})

test('没信任的工作区一个都不读', async (t) => {
  const { ws, trusted, read } = fixture(t)
  trusted.clear()
  assert.deepEqual(await read(join(ws, 'style.css')), { ok: false, reason: 'untrusted', display: 'style.css' })
})

test('../ 和绝对路径带出工作区的都拦下', async (t) => {
  const { ws, outside, read } = fixture(t)
  assert.equal((await read(join(ws, '..', 'outside', 'secret.css'))).reason, 'outside')
  assert.equal((await read(join(ws, 'img', '..', '..', 'outside', 'secret.css'))).reason, 'outside')
  assert.equal((await read(join(outside, 'secret.css'))).reason, 'outside')
  assert.equal((await read('/etc/hosts')).reason, 'outside')
  assert.equal((await read(join(ws, '..', 'ws', 'style.css'))).ok, true, '回到工作区内的 .. 不算越界')
})

test('点文件、点目录，以及指向它们的符号链接都拦下', async (t) => {
  const { ws, read } = fixture(t)
  for (const path of ['.env', '.git/config', '.hidden/x.css', 'link-dot.css', 'git-link/config']) {
    assert.equal((await read(join(ws, path))).reason, 'hidden', path)
  }
})

test('指向工作区外的文件和目录的符号链接都拦下', async (t) => {
  const { ws, read } = fixture(t)
  assert.equal((await read(join(ws, 'link-out.css'))).reason, 'outside')
  assert.equal((await read(join(ws, 'link-dir', 'secret.css'))).reason, 'outside')
})

test('类型不在白名单里的拦下，链接伪装的扩展名也拦下', async (t) => {
  const { ws, read } = fixture(t)
  for (const path of ['notes.txt', 'data.json', 'sub/page.html', 'disguised.css']) {
    assert.equal((await read(join(ws, path))).reason, 'type', path)
  }
})

test('不存在、不是普通文件、超过上限的分别回答', async (t) => {
  const { ws, read } = fixture(t)
  assert.equal((await read(join(ws, 'missing.css'))).reason, 'missing')
  assert.equal((await read(join(ws, 'dir.css'))).reason, 'not-file')
  assert.equal((await read(join(ws, 'style.css'), { maxBytes: 4 })).reason, 'too-large')
})

test('HTML 本身不在工作区内时，信任这个工作区也不读', async (t) => {
  const { ws, outside, read } = fixture(t)
  assert.equal((await read(join(ws, 'style.css'), { document: join(outside, 'page.html') })).reason, 'document-outside')
  assert.equal((await read(join(ws, 'style.css'), { document: join(ws, 'link-dir', 'page.html') })).reason, 'document-outside')
})

test('工作区根和文件路径的写法不同（符号链接、/var 和 /private/var）也认得出同一个工作区', async (t) => {
  const { base, ws, read } = fixture(t)
  const real = realpathSync(ws), link = join(base, 'ws-link')
  // 会话的 cwd 是符号链接写法：用 cwd 写法和真实路径写法的文件都认。
  assert.equal((await read(join(real, 'style.css'), { root: link })).ok, true)
  assert.equal((await read(join(link, 'style.css'), { root: link, document: join(real, 'index.html') })).ok, true)
  assert.equal((await read(join(link, '.env'), { root: link })).reason, 'hidden')
  // 词法上要在会话认的根或真实根之内：经别的别名写的绝对路径，哪怕最后落在工作区里，也按越界拦下。
  assert.equal((await read(join(link, 'style.css'))).reason, 'outside')
})

test('~ 按主目录展开后再判断', async (t) => {
  const { ws, read } = fixture(t)
  assert.equal((await read('~/ws/style.css')).ok, true)
  assert.equal((await read('~/outside/secret.css')).reason, 'outside')
  assert.equal((await read(join(ws, 'style.css'), { document: '~/ws/index.html' })).ok, true)
})

test('工作区根不存在时不读', async (t) => {
  const { base, read } = fixture(t)
  assert.equal((await read(join(base, 'gone', 'a.css'), { root: join(base, 'gone'), document: join(base, 'gone', 'i.html') })).reason, 'no-workspace')
})

test('检查之后、打开之前文件被换成指向外面的链接时不交出内容', async (t) => {
  const { ws, outside, read } = fixture(t)
  const result = await read(join(ws, 'style.css'), {
    onChecked: () => {
      renameSync(join(ws, 'style.css'), join(ws, 'style.old'))
      symlinkSync(join(outside, 'secret.css'), join(ws, 'style.css'))
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'changed')
})

test('工作区外的路径显示时用 ~ 缩写', async (t) => {
  const { base, outside, read } = fixture(t)
  const result = await read(join(outside, 'secret.css'), { home: base })
  assert.equal(result.display, '~/outside/secret.css')
})

test('检查之后、打开之前文件被换成另一个普通文件时也不交出内容', async (t) => {
  const { ws, read } = fixture(t)
  const result = await read(join(ws, 'style.css'), {
    onChecked: () => {
      writeFileSync(join(ws, 'swap.tmp'), 'swapped{}')
      renameSync(join(ws, 'swap.tmp'), join(ws, 'style.css'))
    },
  })
  assert.deepEqual([result.ok, result.reason], [false, 'changed'])
})

test('<track> 的 .vtt 字幕和样式文件一样处理：工作区内能读，点目录、工作区外、超过上限的照样拦下', async (t) => {
  const { ws, outside, read } = fixture(t)
  writeFileSync(join(ws, 'sub.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\n字幕\n')
  writeFileSync(join(ws, '.hidden', 'sub.vtt'), 'WEBVTT\n')
  writeFileSync(join(outside, 'sub.vtt'), 'WEBVTT\n')
  const ok = await read(join(ws, 'sub.vtt'))
  assert.deepEqual([ok.ok, ok.mediaType, ok.display], [true, 'text/vtt', 'sub.vtt'])
  assert.match(Buffer.from(ok.bytes).toString(), /^WEBVTT/)
  assert.equal((await read(join(ws, '.hidden', 'sub.vtt'))).reason, 'hidden')
  assert.equal((await read(join(outside, 'sub.vtt'))).reason, 'outside')
  assert.equal((await read(join(ws, 'sub.vtt'), { maxBytes: 4 })).reason, 'too-large')
})

test('打开之后、读完之前文件变大超过上限时不交出内容（读后的大小复核）', async (t) => {
  const { ws, read } = fixture(t)
  const result = await read(join(ws, 'style.css'), {
    maxBytes: 64,
    onOpened: () => { appendFileSync(join(ws, 'style.css'), 'x'.repeat(200)) },
  })
  assert.deepEqual([result.ok, result.reason], [false, 'too-large'])
})

test('检查之后中间目录被移出工作区、原处换成指过去的链接时不交出内容（读后的 realpath 复核）', async (t) => {
  // 同一个文件被整个目录搬到工作区外：inode 不变，只有读完再 realpath 一次才看得出它已经不在工作区里。
  const { ws, outside, read } = fixture(t)
  mkdirSync(join(ws, 'assets'))
  writeFileSync(join(ws, 'assets', 'a.css'), 'a{}')
  const result = await read(join(ws, 'assets', 'a.css'), {
    onChecked: () => {
      renameSync(join(ws, 'assets'), join(outside, 'assets'))
      symlinkSync(join(outside, 'assets'), join(ws, 'assets'))
    },
  })
  assert.deepEqual([result.ok, result.reason], [false, 'changed'])
})


test('宿主按 path.win32 处理反斜杠、盘符大小写与 UNC；越界和其他盘符、共享不放行', async () => {
  // macOS 没有这些盘符；仅真实文件查询用替身，规范化、包含判定和路由解码都运行宿主代码。
  const cases = [
    ['D:\\work\\proj', 'S1/D%3A/work/proj/index.html', 'D:\\work\\proj\\index.html', true],
    ['D:\\work\\proj', 'S1/d%3A/WORK/PROJ/index.html', 'd:\\WORK\\PROJ\\index.html', true],
    ['D:\\work\\proj', 'S1/D%3A/work/project/index.html', 'D:\\work\\project\\index.html', false],
    ['D:\\work\\proj', 'S1/D%3A/work/proj/../outside/index.html', 'D:\\work\\outside\\index.html', false],
    ['D:\\work\\proj', 'S1/E%3A/work/proj/index.html', 'E:\\work\\proj\\index.html', false],
    ['\\\\server\\share\\proj', 'S1//SERVER/SHARE/proj/index.html', '\\\\SERVER\\SHARE\\proj\\index.html', true],
    ['\\\\server\\share\\proj', 'S1//server/other/proj/index.html', '\\\\server\\other\\proj\\index.html', false],
    ['\\\\server\\share\\proj', 'S1//other/share/proj/index.html', '\\\\other\\share\\proj\\index.html', false],
  ]
  for (const [realRoot, route, canonical, expected] of cases) {
    let queried
    const result = await documentInWorkspace({ realRoot, documentPath: decodePreviewRoute(route).path, home: 'C:\\Users\\me' }, win32, async input => {
      queried = input
      return canonical
    })
    assert.equal(queried, canonical, route)
    assert.equal(result, expected, route)
  }
  assert.equal(await documentInWorkspace({ realRoot: 'C:\\Users\\me\\proj', documentPath: '~/proj/index.html', home: 'C:\\Users\\me' }, win32, async input => {
    assert.equal(input, 'C:\\Users\\me\\proj\\index.html')
    return input
  }), true)
  assert.equal(await documentInWorkspace({ realRoot: 'D:\\work\\proj', documentPath: 'D:/work/proj/link.html', home: 'C:\\Users\\me' }, win32, async () => 'D:\\elsewhere\\page.html'), false, '真实路径在外面的链接仍拒绝')
})

test('点目录里的 HTML 保持可预览，其引用的点段资源仍拒绝', async t => {
  const { ws, read } = fixture(t)
  const document = join(ws, '.hidden', 'page.html')
  writeFileSync(document, '<script>globalThis.ran = true</script>')
  assert.equal((await read(join(ws, 'style.css'), { document })).ok, true)
  assert.equal((await read(join(ws, '.hidden', 'x.css'), { document })).reason, 'hidden')
})

/** 网页发布的读文件和工具：包含检查（越界、符号链接、绝对路径、非普通文件都拒）、
 * 标题来源、工具的注册和参数、发布走工具和路由同一个函数（同源加版）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateWorkspaceFile, readWorkspaceAsset, readWorkspaceHtml, rebaseWorkspacePath, sameSourcePath, titleOfHtml } from '../lib/pages-read.js'
import { publishHtml, publishResultText, PUBLISH_PAGE_DESCRIPTION } from '../lib/pages-publish.js'
import { createPagesStore } from '../lib/pages-store.js'
import { PagesError } from '../lib/pages-error.js'

const dirOf = () => mkdtempSync(join(tmpdir(), 'dwb-pages-tool-'))

test('readWorkspaceHtml：相对路径里的 HTML 读得到，标题从 <title> 来', async () => {
  const dir = dirOf()
  try {
    mkdirSync(join(dir, 'out'))
    writeFileSync(join(dir, 'out', 'index.html'), '<html><head><title>销售 看板</title></head></html>')
    const read = await readWorkspaceHtml('out/index.html', dir)
    assert.equal(read.html, '<html><head><title>销售 看板</title></head></html>')
    // absolutePath 是 realpath（macOS 会把 /var 归一成 /private/var；显示文件位置要的就是它）
    assert.equal(read.absolutePath, realpathSync(join(dir, 'out', 'index.html')))
    assert.equal(titleOfHtml(read.html, 'out/index.html'), '销售 看板')
    assert.equal(titleOfHtml('<html></html>', 'out/report.html'), 'report')
    assert.equal(titleOfHtml('', 'x.tar.gz'), 'x.tar')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('包含检查：../ 越界、绝对路径、file: 协议、不存在的、目录、符号链接逃出都拒', async () => {
  const dir = dirOf()
  try {
    writeFileSync(join(dir, 'index.html'), '<p>x</p>')
    const outside = dirOf()
    writeFileSync(join(outside, 'secret.html'), '<p>s</p>')
    symlinkSync(join(outside, 'secret.html'), join(dir, 'link.html'))
    mkdirSync(join(dir, 'subdir'))
    // 工作区根也建一个符号链接目录，验证根的 realpath 归一
    for (const bad of [
      ['/etc/passwd', /相对路径/],
      ['file:///etc/passwd', /相对路径/],
      ['gone.html', /不存在/],
      ['subdir', /不是普通文件/],
      // 末端符号链接一律不是普通文件（照官方 workspaceFiles 的口径，指回工作区内的也拒）
      ['link.html', /不是普通文件/],
    ]) {
      await assert.rejects(locateWorkspaceFile(bad[0], dir), (error) => {
        assert.ok(error instanceof PagesError)
        assert.match(error.message, bad[1])
        return true
      })
    }
    // ../index.html：工作区根上一层没有这个文件时是不存在；专门造一个越界的来验
    writeFileSync(join(dir, '..', 'dwb-escape.html'), '<p>e</p>')
    await assert.rejects(readWorkspaceHtml('../dwb-escape.html', dir), /工作区之外/)
    rmSync(join(dir, '..', 'dwb-escape.html'))
    rmSync(outside, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readWorkspaceHtml：.txt 拒、二进制拒、末端符号链接拒；路径中间的符号链接不受影响', async () => {
  const dir = dirOf()
  try {
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, 'bin.html'), 'a\u0000b')
    writeFileSync(join(dir, 'real.html'), '<p>r</p>')
    symlinkSync('real.html', join(dir, 'alias.html'))
    await assert.rejects(readWorkspaceHtml('notes.txt', dir), /不是 HTML/)
    await assert.rejects(readWorkspaceHtml('bin.html', dir), /不是 HTML/)
    await assert.rejects(readWorkspaceHtml('alias.html', dir), /不是普通文件/)
    // 中间的符号链接指到工作区里的目录：最终文件 realpath 还在根内，可以读
    mkdirSync(join(dir, 'realdir'))
    writeFileSync(join(dir, 'realdir', 'ok.html'), '<p>ok</p>')
    symlinkSync('realdir', join(dir, 'linkdir'))
    const read = await readWorkspaceHtml('linkdir/ok.html', dir)
    assert.equal(read.html, '<p>ok</p>')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readWorkspaceAsset：类型表覆盖脚本、样式、图片；不认识的扩展名拒', async () => {
  const dir = dirOf()
  try {
    for (const [name, mime] of [['a.js', 'text/javascript'], ['b.css', 'text/css'], ['c.PNG', 'image/png'], ['d.webp', 'image/webp']]) {
      writeFileSync(join(dir, name), 'x')
      assert.equal((await readWorkspaceAsset(name, dir)).mime, mime)
    }
    writeFileSync(join(dir, 'e.mp4'), 'x')
    await assert.rejects(readWorkspaceAsset('e.mp4', dir), /类型不认识/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sameSourcePath：反斜杠、./、多余斜杠都归一；不同文件不匹配', () => {
  assert.equal(sameSourcePath('out/index.html', 'out/index.html'), true)
  assert.equal(sameSourcePath('out\\index.html', './out//index.html'), true)
  assert.equal(sameSourcePath('out/index.html', 'out/other.html'), false)
})

test('publishHtml：发布、内联、加 CSP；同一个来源文件再发布给原页面加版；page 参数指定页面', async () => {
  const dir = dirOf()
  const store = createPagesStore(join(dir, 'pages'))
  try {
    writeFileSync(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="s.css"><title>看板</title></head><body><img src="a.png"></body></html>')
    writeFileSync(join(dir, 's.css'), 'body{background:url("a.png")}')
    writeFileSync(join(dir, 'a.png'), 'png')

    const first = await publishHtml(store, { sessionId: 's1', path: 'index.html', workspaceRoot: dir })
    assert.equal(first.meta.title, '看板')
    assert.equal(first.version.n, 1)
    assert.deepEqual(first.version.assets, { scripts: 0, styles: 1, images: 1 })
    // 存下来的 HTML 已内联并叠了 CSP
    const stored = store.readVersion(first.meta.id, 1)
    assert.match(stored.html, /<style>body\{background:url\("data:image\/png/)
    assert.match(stored.html, /<meta http-equiv="Content-Security-Policy"/)
    assert.match(stored.html, /<script>.*dwb-csp/s)

    // 同一个来源再发布：加版不建新页面，标题跟新的 <title> 走
    writeFileSync(join(dir, 'index.html'), '<html><head><title>看板 v2</title></head><body>2</body></html>')
    const second = await publishHtml(store, { sessionId: 's1', path: './index.html', workspaceRoot: dir })
    assert.equal(second.meta.id, first.meta.id)
    assert.equal(second.version.n, 2)
    assert.equal(second.meta.title, '看板 v2')
    assert.equal(store.listPages().pages.length, 1)

    // 别的会话发不同文件：新页面；再给那个页面显式加版
    writeFileSync(join(dir, 'report.htm'), '<html><head><title>周报</title></head></html>')
    const third = await publishHtml(store, { sessionId: 's2', path: 'report.htm', workspaceRoot: dir })
    assert.notEqual(third.meta.id, first.meta.id)
    const fourth = await publishHtml(store, { sessionId: 's2', path: 'report.htm', workspaceRoot: dir, pageId: third.meta.id })
    assert.equal(fourth.meta.id, third.meta.id)
    assert.equal(fourth.version.n, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishHtml：HTML 在子目录里，资源路径相对 HTML 所在目录，不是工作区根（同名的根目录文件不被误读）', async () => {
  const dir = dirOf()
  const store = createPagesStore(join(dir, 'pages'))
  try {
    mkdirSync(join(dir, 'out', 'img'), { recursive: true })
    writeFileSync(join(dir, 'out', 'index.html'), '<html><head><link rel="stylesheet" href="s.css"><title>子目录</title></head><body><img src="img/a.png"><script src="./app.js"></script></body></html>')
    writeFileSync(join(dir, 'out', 's.css'), 'body{color:red}')
    writeFileSync(join(dir, 'out', 'img', 'a.png'), 'png')
    writeFileSync(join(dir, 'out', 'app.js'), 'window.fromOut = true')
    // 工作区根目录里有同名文件，内容不同：读错目录就会把它内联进来。
    writeFileSync(join(dir, 'app.js'), 'window.fromRoot = true')

    const result = await publishHtml(store, { sessionId: 's1', path: 'out/index.html', workspaceRoot: dir })
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.version.assets, { scripts: 1, styles: 1, images: 1 })
    const stored = store.readVersion(result.meta.id, 1).html
    assert.match(stored, /window\.fromOut = true/)
    assert.doesNotMatch(stored, /fromRoot/)

    // ./ 前缀的写法一样，并且同一个来源给原页面加版
    const again = await publishHtml(store, { sessionId: 's1', path: './out/index.html', workspaceRoot: dir })
    assert.deepEqual(again.warnings, [])
    assert.equal(again.version.n, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishHtml：超限抛 PagesError，写明哪个文件多大', async () => {
  const dir = dirOf()
  const store = createPagesStore(join(dir, 'pages'))
  try {
    writeFileSync(join(dir, 'index.html'), '<img src="big.png">')
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(4 * 1024 * 1024 + 1))
    await assert.rejects(publishHtml(store, { sessionId: 's', path: 'index.html', workspaceRoot: dir }), (error) => {
      assert.ok(error instanceof PagesError)
      assert.equal(error.code, 'asset-too-large')
      assert.match(error.message, /big\.png/)
      assert.match(error.message, /4 MiB/)
      return true
    })
    // 失败的发布不留下半页
    assert.deepEqual(store.listPages(), { pages: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具的说明文字（lib/pages-tool.js 只差 defineTool 包装，那部分在 host-smoke 里跑）', async () => {
  assert.match(PUBLISH_PAGE_DESCRIPTION, /用户要一个能直接看的网页/)
  assert.doesNotMatch(PUBLISH_PAGE_DESCRIPTION, /\u4e3b\u4eba/)
  assert.match(PUBLISH_PAGE_DESCRIPTION, /cdnjs\.cloudflare\.com/)
  assert.match(PUBLISH_PAGE_DESCRIPTION, /unpkg\.com/)
  // fix#173：页面让预览框跳走拦不住，说明不能写「其他请求都会被拦」；要告诉模型脚本默认不运行。
  assert.match(PUBLISH_PAGE_DESCRIPTION, /跳转|跳到/)
  assert.match(PUBLISH_PAGE_DESCRIPTION, /正文.*HTML/)
  assert.match(PUBLISH_PAGE_DESCRIPTION, /默认不运行脚本/)
})

test('readWorkspaceAsset：先按文件大小拒绝再读；x.constructor 这种名字不认；maxBytes 可调', async () => {
  const dir = dirOf()
  try {
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(5 * 1024 * 1024))
    writeFileSync(join(dir, 'ok.png'), Buffer.alloc(1024))
    writeFileSync(join(dir, 'x.constructor'), 'x')
    await assert.rejects(readWorkspaceAsset('big.png', dir), (error) => {
      assert.ok(error instanceof PagesError)
      assert.equal(error.code, 'asset-too-large')
      assert.match(error.message, /big\.png/)
      return true
    })
    assert.equal((await readWorkspaceAsset('ok.png', dir)).mime, 'image/png')
    await assert.rejects(readWorkspaceAsset('ok.png', dir, { maxBytes: 100 }), (error) => error.code === 'asset-too-large')
    await assert.rejects(readWorkspaceAsset('x.constructor', dir), (error) => error.code === 'unknown-asset-type')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishResultText：没有警告就一句话；有警告把每一条带给模型', () => {
  const base = { title: '看板', n: 2, id: 'kanban-1234' }
  assert.equal(publishResultText(base), '已发布页面「看板」第 2 版（页面 id kanban-1234）。用户可以在右侧栏的「页面」标签和侧边栏的「页面」里查看。')
  const text = publishResultText({ ...base, warnings: ['资源 a.js 读取失败（文件 a.js 不存在。），页面在沙箱里可能加载不了它。', '图片 b.bmp 的类型不在内联范围，没有内联。'] })
  const lines = text.split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[1], /有 2 处资源没有内联/)
  assert.match(lines[2], /^- 资源 a\.js 读取失败/)
  assert.match(lines[3], /^- 图片 b\.bmp/)
})

test('rebaseWorkspacePath：path 相对模型当前目录，换成相对工作区根；cd 到根外或 / 不会让工作区变大', () => {
  const root = '/home/u/ws'
  // 当前目录就是根：不动
  assert.equal(rebaseWorkspacePath('out/index.html', root, root), 'out/index.html')
  assert.equal(rebaseWorkspacePath('out/index.html', undefined, root), 'out/index.html')
  // 当前目录在根的子目录里
  assert.equal(rebaseWorkspacePath('index.html', '/home/u/ws/out', root), 'out/index.html')
  assert.equal(rebaseWorkspacePath('../a/index.html', '/home/u/ws/out', root), 'a/index.html')
  // 换算后在根外：拒绝（cd 到 / 以后写 etc/x.html，或者 ../../ 爬出去）
  for (const [path, base] of [['etc/x.html', '/'], ['../../x.html', '/home/u/ws/out'], ['x.html', '/home/u/other']]) {
    assert.throws(() => rebaseWorkspacePath(path, base, root), (error) => error instanceof PagesError && error.code === 'outside-workspace', `${path} 在 ${base}`)
  }
  // 当前目录就是根时不换算，../ 越界由 locateWorkspaceFile 的包含检查拒（上面另有测试）
  assert.equal(rebaseWorkspacePath('../x.html', root, root), '../x.html')
  // 绝对路径、协议、空串原样给 locateWorkspaceFile 报错
  for (const path of ['/etc/hosts', 'file:///etc/hosts', '', '  ']) assert.equal(rebaseWorkspacePath(path, '/home/u/ws/out', root), path)
})

test('publishResultText：警告很多时只列前 10 条，写明还有几条', () => {
  const warnings = Array.from({ length: 80000 }, (_, i) => `资源 a${i}.png 读取失败`)
  const text = publishResultText({ title: 't', n: 1, id: 'p-1', warnings })
  const lines = text.split('\n')
  assert.equal(lines.length, 1 + 1 + 10 + 1)
  assert.match(lines[1], /有 80000 处/)
  assert.match(lines[12], /还有 79990 条/)
  assert.ok(text.length < 2000)
})

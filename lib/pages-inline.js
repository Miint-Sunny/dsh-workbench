/**
 * 网页发布（dsh-workbench/pages）的内联：把 HTML 里相对路径的脚本、样式表、图片内联成一个
 * 自包含的 HTML。照 DSH 自带预览（ui-sidebar-documentpreview 的 html/pack.ts）重写并放宽：
 * 官方只内联脚本和样式，这里图片（img src 和样式里的 url()）也内联成 data: 地址，限额收紧为
 * 单个资源 4 MiB、一版共 16 MiB、最多 64 个（官方是 4/32/64）。
 *
 * 解析不依赖 DOM：先把 <script>/<style> 的正文和 HTML 注释换成同长度的 NUL 占位再找引用
 * （脚本字符串、注释里的标签和引用不算数，正文和注释之后原样放回），找到的引用按区间记成对
 * 原文的编辑，最后统一套用。资源读取由注入的 readAsset 完成（宿主端做工作区包含检查，测试用
 * 假的）。
 *
 * 相对路径的基准：标签上的引用相对 HTML 所在目录；样式表文本里的 url() 相对样式表自己的目录
 * （<style> 正文里的相对 HTML 目录）。引用值先按 %XX 解码再找文件；%2f、%5c、%00 解码后是
 * 路径分隔符或 NUL 的不内联。内联后的标签保留 id、class、title、data-*（脚本另留 type，样式
 * 表另留 media），带 defer 的脚本挪到 </body> 之前保住「等 DOM 出来再跑」的语义；@import 和
 * 暂不内联的引用（行内样式 url()、srcset、<source src>、poster）各给一条警告，不悄悄跳过。
 * <base href> 写在真实标签上（不在注释、脚本正文里）时相对地址不再指着 HTML 所在目录，整个
 * 不做内联。CSP meta 和拦截上报的注入在同目录 pages-csp.js。
 * 本模块不 import 任何 @deepseek-ai 包。
 */
import { PagesError, formatBytes } from './pages-error.js'

/** 单个资源的上限。 */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024

/** 一版里全部资源的总上限。 */
export const MAX_TOTAL_ASSET_BYTES = 16 * 1024 * 1024

/** 一版里最多引用多少个资源。 */
export const MAX_ASSETS = 64

/** 内联完成后整页 HTML 的上限（和读进来的 HTML 上限一致）：同一个资源被引用很多次时，每处都带一份完整的 data: 地址，会比资源总量大得多。 */
export const MAX_PAGE_BYTES = 32 * 1024 * 1024

/** 标签属性串最长扫多长：不加上限时，大量没有 `>` 收尾的 `<script ` 会让正则按平方级回溯，卡住宿主的事件循环。 */
const MAX_TAG_ATTRS = 2000

/** 内联图片的扩展名和 MIME。 */
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
}

/**
 * 图片扩展名对应的 MIME；只认自己的键（`x.constructor`、`x.__proto__` 这类名字不算图片）。
 * @param {string} path 资源路径。
 * @returns {string | undefined} MIME；不是内联范围内的图片时 undefined。
 */
function imageMimeOf(path) {
  const extension = extensionOf(path)
  return Object.hasOwn(IMAGE_MIME, extension) ? IMAGE_MIME[extension] : undefined
}

/**
 * 内联进 `<script>` 的文本：`</script` 和 `<!--` 会让浏览器提前结束脚本或进入脚本数据的注释态，转义成脚本里等价的写法。
 * @param {string} text 脚本文本。
 * @returns {string} 可以放进 `<script>…</script>` 的文本。
 */
function escapeInlineScript(text) {
  return text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

/**
 * 内联进 `<style>` 的文本：`</style` 会提前结束样式。
 * @param {string} text 样式文本。
 * @returns {string} 可以放进 `<style>…</style>` 的文本。
 */
function escapeInlineStyle(text) {
  return text.replace(/<\/(style)/gi, '<\\/$1')
}

/** http(s)、data、协议相对地址不内联，原样保留。 */
function isRemoteUrl(url) {
  return /^(?:https?:|data:|\/\/)/i.test(url)
}

/**
 * 引用值是不是干净：没有引号、尖括号、空白，没有 `#`、`?`（带 query 或 hash 的引用另给警告）。
 * 百分号编码不拦（解码后空白是文件名的一部分，%20 写法照常内联）。
 * @param {string} url 属性值。
 * @returns {boolean} 干净时才走内联。
 */
function isCleanUrl(url) {
  return !/[\s"'<>#?]/.test(url)
}

/** %2f、%5c、%00 的编码：解码后是路径分隔符或 NUL，能让引用越过目录检查，一律不内联。 */
function hasSeparatorEscape(url) {
  return /%(?:2f|5c|00)/i.test(url)
}

/**
 * %XX 解码（坏序列原样保留）：引用里的 %20 是空格，不是文件名里的字面百分号。
 * @param {string} url 引用值。
 * @returns {string} 解码后的引用值。
 */
function decodePercent(url) {
  if (!/%[0-9a-f]/i.test(url)) return url
  try {
    return decodeURIComponent(url)
  } catch {
    // 半截的 %XX（比如 "a%2"）解码不了，当字面字符用。
    return url
  }
}

/**
 * 引用值从 dir 目录解析成资源路径：`..` 越出 HTML 所在目录（dir 的上界）时不算相对资源。
 * @param {string} dir 引用所在的目录（样式表自己的目录，或 "."）。
 * @param {string} url 引用值。
 * @returns {string | undefined} 相对 HTML 所在目录的资源路径；越界或为空时 undefined。
 */
function resolveFrom(dir, url) {
  const out = []
  for (const part of `${dir}/${url}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.length === 0 ? undefined : out.join('/')
}

/**
 * 资源的扩展名（最后一段里最后一个点之后、没有点时为空）。
 * @param {string} path 资源路径。
 * @returns {string} 小写扩展名。
 */
function extensionOf(path) {
  const base = path.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 路径的目录部分（没有 `/` 时是 "."）。 */
function dirOf(path) {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '.' : path.slice(0, cut)
}

/**
 * 标签属性串拆成 [小写名字, 值?]（按出现顺序）：无值的属性（defer、async）值是 undefined。
 * @param {string} attrs `<script>`/`<link>`/`<img>` 开标签里标签名之后的属性串。
 * @returns {[string, string | undefined, number, number][]} 属性列表，含属性在输入串内的起止位置。
 */
function parseAttrs(attrs) {
  const parsed = []
  const attr = /([^\s"'<>=`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = attr.exec(attrs)) !== null) parsed.push([match[1].toLowerCase(), match[2] ?? match[3] ?? match[4], match.index, attr.lastIndex])
  return parsed
}

/**
 * 内联后的标签保留哪些属性：id、class、title、data-* 都带过去，脚本另留 type（module 语义），
 * 样式表另留 media；src、href、rel、integrity、crossorigin、nonce、async、defer 不带（defer
 * 的语义由挪到 </body> 之前接住）。
 * @param {[string, string | undefined][]} parsed 原标签的属性列表。
 * @param {'script' | 'style'} target 内联成的元素。
 * @returns {string} 拼进 `<script…`/`<style…` 的属性串（带前导空格，没有可带的属性时为空）。
 */
function carriedAttrs(parsed, target) {
  const kept = parsed.filter(([name]) => name === 'id' || name === 'class' || name === 'title'
    || name.startsWith('data-') || (target === 'style' && name === 'media') || (target === 'script' && name === 'type'))
  if (kept.length === 0) return ''
  return ` ${kept.map(([name, value]) => value === undefined ? name : `${name}="${value.replaceAll('"', '&quot;')}"`).join(' ')}`
}

/**
 * 收集 HTML 里 <script>/<style> 元素的正文区间（只统计这些标签自己的；正则属性串里
 * 不可能同时出现 `>` 和完整的 `</script`）。
 * @param {string} html 注释已换成 NUL 占位的 HTML。
 * @returns {[number, number, 'script' | 'style'][]} [start, end) 区间和元素名，按出现顺序、不重叠。
 */
function rawTextSpans(html) {
  const spans = []
  const tag = new RegExp(`<(script|style)\\b[^>]{0,${MAX_TAG_ATTRS}}>|<\\/(script|style)\\s*>`, 'gi')
  let match
  let openName
  let openEnd
  while ((match = tag.exec(html)) !== null) {
    if (match[1] !== undefined) {
      openName = match[1].toLowerCase()
      openEnd = match.index + match[0].length
    } else if (openName === (match[2] ?? '').toLowerCase()) {
      spans.push([openEnd, match.index, openName])
      openName = undefined
    }
  }
  return spans
}

/**
 * HTML 注释的区间（含没写完的注释：到文档末尾）。注释里的标签和引用不算数，同 <script> 正文
 * 一样换成 NUL 占位。
 * @param {string} html 原始 HTML。
 * @returns {[number, number][]} [start, end) 区间，按出现顺序、不重叠。
 */
function commentSpans(html) {
  const spans = []
  for (const match of html.matchAll(/<!--(?:>|->|[\s\S]*?(?:--!?>|$))/g)) {
    spans.push([match.index, match.index + match[0].length])
  }
  return spans
}

/**
 * 区间合并成互不重叠的升序序列（注释可以套在 <script>/<style> 的正文区间里）。
 * @param {[number, number][]} ranges 区间列表。
 * @returns {[number, number][]} 合并后的区间。
 */
function mergeRanges(ranges) {
  const merged = []
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * 把区间里的原文换成同长度的 NUL：偏移量和原文一致，扫描时不看这些内容。
 * @param {string} html 原始 HTML。
 * @param {[number, number][]} ranges 升序、互不重叠的区间。
 * @returns {string} 同长度的占位文本。
 */
function blankRanges(html, ranges) {
  const parts = []
  let at = 0
  for (const [start, end] of ranges) {
    parts.push(html.slice(at, start), '\u0000'.repeat(end - start))
    at = end
  }
  parts.push(html.slice(at))
  return parts.join('')
}

/**
 * 对原文的一段编辑：把 [start, end) 换成 text。
 * @typedef {[number, number, string]} Edit
 */

/**
 * 内联 HTML：把相对路径的脚本、样式表、图片读出来内联成一个 HTML。
 *
 * 相对路径的基准按浏览器的规则：标签上的引用相对 HTML 所在目录，样式表文本里的 url() 相对
 * 样式表自己的目录。`<base href>` 写在真实标签上时相对地址不再指着 HTML 所在目录，整个不做
 * 内联（官方预览同判，警告一条）。绝对地址（http(s):、data:、//）原样保留；相对路径逃出
 * HTML 所在目录、带 `?`/`#`、扩展名不认识时保留引用并给警告（页面在离线沙箱里加载不了它们，
 * 用户看得见原因）。单个资源 4 MiB、一版共 16 MiB、最多 64 个资源，超了抛错并写明是哪个
 * 文件、多大。
 *
 * @param {string} html HTML 文本。
 * @param {{ (relativePath: string): { bytes: Uint8Array, mime: string } | Promise<{ bytes: Uint8Array, mime: string }> }} readAsset 按相对路径读资源（宿主端做包含检查）。
 * @param {{ signal?: AbortSignal }} [options] 取消信号。
 * @returns {Promise<{ html: string, assets: { scripts: string[], styles: string[], images: string[] }, warnings: string[] }>} 内联后的 HTML、各类资源的清单和警告。
 * @throws {PagesError} 限额超了（'asset-too-large'、'too-many-assets'、'assets-too-large'）；readAsset 抛的错翻译成警告，不往上抛。
 */
export async function inlineHtml(html, readAsset, options = {}) {
  const warnings = []
  const assets = { scripts: [], styles: [], images: [] }
  /** 内联结果按路径缓存：同一资源被引用两次只读一次，也只计一个名额。 */
  const cache = new Map()
  const totals = { count: 0, bytes: 0, output: 0 }

  /**
   * 记下往页面里放了多少字节；超过整页上限就抛错，不等字符串拼出来。
   * @param {string} path 正在放进页面的资源路径（报错用）。
   * @param {number} length 这一处放进页面的字符数。
   */
  const spend = (path, length) => {
    totals.output += length
    if (totals.output > MAX_PAGE_BYTES) {
      throw new PagesError('page-too-large', `内联以后整页超过 ${formatBytes(MAX_PAGE_BYTES)}（放进 ${path} 时到了 ${formatBytes(totals.output)}）：同一个资源每被引用一次就在页面里放一整份。少引用几次，或把大图改成外链。`)
    }
  }

  /**
   * 读一个资源并记限额。
   * @param {string} path 资源路径。
   * @returns {Promise<{ mime: string, dataUrl: string, text: string } | undefined> 资源内容；读不到时 undefined（警告已给）。
   */
  const load = async (path) => {
    if (cache.has(path)) return cache.get(path)
    let result
    try {
      result = await readAsset(path)
    } catch (error) {
      // 读之前按文件大小拒绝的（readWorkspaceAsset）是限额错误，和读完才发现超限一样要让发布失败，不是警告。
      if (error instanceof PagesError && error.code === 'asset-too-large') throw error
      warnings.push(`资源 ${path} 读取失败（${error instanceof Error ? error.message : String(error)}），页面在沙箱里可能加载不了它。`)
      cache.set(path, undefined)
      return undefined
    }
    const { bytes, mime } = result
    const byteLength = bytes?.byteLength ?? 0
    if (byteLength > MAX_ASSET_BYTES) {
      throw new PagesError('asset-too-large', `资源 ${path} 有 ${formatBytes(byteLength)}，超过单个资源 ${formatBytes(MAX_ASSET_BYTES)} 的上限。压缩它，或改成外链。`, { size: byteLength })
    }
    if (totals.count >= MAX_ASSETS) {
      throw new PagesError('too-many-assets', `这一版引用的资源超过 ${MAX_ASSETS} 个（第 ${MAX_ASSETS + 1} 个是 ${path}）。减少引用的数量再发布。`)
    }
    if (totals.bytes + byteLength > MAX_TOTAL_ASSET_BYTES) {
      throw new PagesError('assets-too-large', `这一版的资源总共超过 ${formatBytes(MAX_TOTAL_ASSET_BYTES)} 的上限（添上 ${path} 的 ${formatBytes(byteLength)} 会到 ${formatBytes(totals.bytes + byteLength)}）。减少或压缩资源再发布。`)
    }
    totals.count += 1
    totals.bytes += byteLength
    const text = new TextDecoder().decode(bytes)
    const entry = { mime, text, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }
    cache.set(path, entry)
    return entry
  }

  /**
   * 样式文本里的 url(…) 内联成 data: 地址（图片扩展名才算；远程地址保留），相对样式表自己的
   * 目录解析；@import 两种写法都不支持，各给一条警告。
   * @param {string} css 样式文本。
   * @param {string} dir 样式文本所在目录（相对 HTML 所在目录）。
   * @returns {Promise<string>} 处理后的样式文本。
   */
  const inlineCss = async (css, dir) => {
    const imports = []
    for (const match of css.matchAll(/@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]*)\3)/gi)) {
      imports.push([match.index, match.index + match[0].length])
      warnings.push(`样式里的 @import（${match[2] ?? match[4] ?? ''}）不支持，没有内联；页面在沙箱里可能加载不了它。`)
    }
    let out = ''
    let at = 0
    for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      // @import url(…) 里的 url() 由 @import 那条警告负责，不当图片处理。
      if (imports.some(([start, end]) => match.index >= start && match.index < end)) continue
      const url = match[2]
      out += css.slice(at, match.index)
      at = match.index + match[0].length
      if (isRemoteUrl(url) || !isCleanUrl(url)) {
        out += match[0]
        continue
      }
      if (hasSeparatorEscape(url)) {
        warnings.push(`样式里的 ${url} 有 %2f、%5c、%00 这类编码（解码后是路径分隔符或 NUL），没有内联；页面在沙箱里加载不了它。`)
        out += match[0]
        continue
      }
      const path = resolveFrom(dir, decodePercent(url))
      const mime = path === undefined ? undefined : imageMimeOf(path)
      if (path === undefined || mime === undefined) {
        warnings.push(`样式里的 ${url} 不是相对路径的图片，没有内联；页面在沙箱里可能加载不了它。`)
        out += match[0]
        continue
      }
      const entry = await load(path)
      if (entry !== undefined) spend(path, entry.dataUrl.length)
      out += entry === undefined ? match[0] : `url("${entry.dataUrl}")`
    }
    return out + css.slice(at)
  }

  /**
   * 一个 src/href 引用的处理决定。
   * @typedef {{ kind: 'script' } | { kind: 'style' } | { kind: 'image', mime: string } | { kind: 'skip' }} RefKind
   */

  /**
   * 按引用值决定内联种类和资源路径；不内联的原因写进警告。
   * @param {string} url 引用值。
   * @param {'script' | 'style' | 'image'} element 引用所在的元素。
   * @returns {RefKind & { path?: string }} 决定。
   */
  const classify = (url, element) => {
    const noun = element === 'script' ? '脚本' : element === 'style' ? '样式表' : '图片'
    if (isRemoteUrl(url)) return { kind: 'skip' }
    if (!isCleanUrl(url)) {
      warnings.push(`${noun} ${url} 的地址带 ? 或 #，没有内联；页面在沙箱里可能加载不了它。`)
      return { kind: 'skip' }
    }
    if (hasSeparatorEscape(url)) {
      warnings.push(`${noun} ${url} 有 %2f、%5c、%00 这类编码（解码后是路径分隔符或 NUL），没有内联；页面在沙箱里加载不了它。`)
      return { kind: 'skip' }
    }
    const path = resolveFrom('.', decodePercent(url))
    if (path === undefined) {
      warnings.push(`${noun} ${url} 在 HTML 所在目录之外，没有内联；页面在沙箱里加载不了它。`)
      return { kind: 'skip' }
    }
    if (element === 'script') return { kind: 'script', path }
    if (element === 'style') return { kind: 'style', path }
    const mime = imageMimeOf(path)
    if (mime === undefined) {
      warnings.push(`图片 ${url} 的类型不在内联范围（png、jpg、gif、svg、webp、ico），没有内联；页面在沙箱里显示不了它。`)
      return { kind: 'skip' }
    }
    return { kind: 'image', mime, path }
  }

  // 注释先换成占位，再在剩下的文本里找 <script>/<style> 的正文区间（注释里的标签不算数）。
  const comments = commentSpans(html)
  const spans = rawTextSpans(blankRanges(html, comments))
  // <script>/<style> 的正文和注释都原样保留：换成同长度占位再找引用，偏移量和原文一致。
  const blank = blankRanges(html, mergeRanges([...comments, ...spans]))

  if (new RegExp(`<base\\b[^>]{0,${MAX_TAG_ATTRS}}[\\s/]href\\s*=`, 'i').test(blank)) {
    return {
      html,
      assets: { scripts: [], styles: [], images: [] },
      warnings: ['页面里有 <base href>，相对路径不按 HTML 所在目录解析，这一版没有内联任何资源；页面在沙箱里可能加载不了它们。'],
    }
  }

  /** 对原文的编辑（引用和正文区间互不重叠，套用前按位置排序）。 */
  const edits = []
  /** 带 defer 的脚本内联后的文本：按原顺序挪到 </body> 之前（inline 脚本不吃 defer）。 */
  const deferred = []
  // 脚本正文是空白时已被换成 NUL 占位，所以空白和 NUL 都算「没有正文」。
  const ref = new RegExp(`<script\\b([^>]{0,${MAX_TAG_ATTRS}})>[\\s\\u0000]*<\\/script\\s*>|<link\\b([^>]{0,${MAX_TAG_ATTRS}})>|<img\\b([^>]{0,${MAX_TAG_ATTRS}})>`, 'gi')
  for (const match of blank.matchAll(ref)) {
    options.signal?.throwIfAborted()
    const parsed = parseAttrs(match[1] ?? match[2] ?? match[3] ?? '')
    const valueOf = (name) => parsed.find(([name_]) => name_ === name)?.[1]
    let url
    let decide
    if (match[1] !== undefined) {
      url = valueOf('src')
      decide = url === undefined ? undefined : classify(url, 'script')
    } else if (match[2] !== undefined) {
      const rel = valueOf('rel')
      if (rel === undefined || rel.toLowerCase() !== 'stylesheet') continue
      url = valueOf('href')
      decide = url === undefined ? undefined : classify(url, 'style')
    } else {
      url = valueOf('src')
      decide = url === undefined ? undefined : classify(url, 'image')
    }
    if (decide === undefined || decide.kind === 'skip') continue
    const entry = await load(decide.path)
    if (entry === undefined) continue
    if (decide.kind === 'script') {
      assets.scripts.push(decide.path)
      spend(decide.path, entry.text.length)
      if ((valueOf('type') ?? '').trim().toLowerCase() === 'module') {
        warnings.push(`模块脚本 ${url}：里面 import 的相对文件不会被内联；页面在沙箱里可能加载不了它们。`)
      }
      const inline = `<script${carriedAttrs(parsed, 'script')}>${escapeInlineScript(entry.text)}</script>`
      if (parsed.some(([name]) => name === 'defer')) {
        edits.push([match.index, match.index + match[0].length, ''])
        deferred.push(inline)
      } else {
        edits.push([match.index, match.index + match[0].length, inline])
      }
    } else if (decide.kind === 'style') {
      assets.styles.push(decide.path)
      const css = await inlineCss(entry.text, dirOf(decide.path))
      spend(decide.path, css.length)
      edits.push([match.index, match.index + match[0].length, `<style${carriedAttrs(parsed, 'style')}>${escapeInlineStyle(css)}</style>`])
    } else {
      assets.images.push(decide.path)
      spend(decide.path, entry.dataUrl.length)
      // Use the parsed attribute span so text inside alt/title cannot match src.
      const [, , start, end] = parsed.find(([name]) => name === 'src')
      edits.push([match.index + 4 + start, match.index + 4 + end, `src="${entry.dataUrl}"`])
    }
  }

  // 暂不内联的引用各给一条「没有内联」的警告，不能悄悄跳过：行内样式里的 url()、srcset、
  // <source src>、poster（都在占位文本上找，注释和脚本正文里的不算数）。
  for (const match of blank.matchAll(/(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    for (const inner of (match[1] ?? match[2] ?? match[3] ?? '').matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      if (!isRemoteUrl(inner[2])) warnings.push(`元素的行内样式里的 ${inner[2]} 没有内联；页面在沙箱里可能加载不了它。`)
    }
  }
  for (const match of blank.matchAll(/(?:^|\s)srcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    warnings.push(`srcset 里的图片（${match[1] ?? match[2] ?? match[3] ?? ''}）没有内联；页面在沙箱里可能显示不了它们。`)
  }
  for (const match of blank.matchAll(new RegExp(`<source\\b[^>]{0,${MAX_TAG_ATTRS}}>`, 'gi'))) {
    const src = parseAttrs(match[0].replace(/^<source/i, '')).find(([name]) => name === 'src')?.[1]
    if (src !== undefined) warnings.push(`source 元素的 src（${src}）没有内联；页面在沙箱里可能加载不了它。`)
  }
  for (const match of blank.matchAll(/(?:^|\s)poster\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    warnings.push(`poster 封面图（${match[1] ?? match[2] ?? match[3] ?? ''}）没有内联；页面在沙箱里可能显示不了它。`)
  }

  // <style> 正文里的 url() 也内联（相对 HTML 目录）；<script> 的正文原样放回。
  for (const [start, end, name] of spans) {
    if (name !== 'style') continue
    const raw = html.slice(start, end)
    const next = await inlineCss(raw, '.')
    if (next !== raw) edits.push([start, end, escapeInlineStyle(next)])
  }

  // 带 defer 的脚本按原来的先后顺序挪到 </body> 之前（占位文本里找最后一个，正文里的不算）；
  // 没有 </body> 就放文档末尾。零长度的插入编辑排在同一位置的其他编辑后面（稳定排序）。
  if (deferred.length > 0) {
    let closeAt = -1
    for (const match of blank.matchAll(/<\/body\s*>/gi)) closeAt = match.index
    const at = closeAt === -1 ? html.length : closeAt
    for (const inline of deferred) edits.push([at, at, inline])
  }
  // 标签引用的编辑先记、样式正文的编辑后记，套用前按位置排：乱序套用会把原文重复一段。
  edits.sort((a, b) => a[0] - b[0])

  let out = ''
  let at = 0
  for (const [start, end, text] of edits) {
    out += html.slice(at, start) + text
    at = end
  }
  return { html: out + html.slice(at), assets, warnings }
}

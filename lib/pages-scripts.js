/**
 * 发布的页面在预览里运行不运行自己的脚本（fix#173，出处：11-10 扫描 W-S01）。
 *
 * 预览框是 `sandbox` 的 Blob iframe，叠了 lib/pages-csp.js 的 CSP：页面自己发的 fetch、表单、外部图片都拦得住，
 * 拦不住的是页面让预览框自己跳到别的网址、把页面里的内容放进网址带走（2026-11-18 在 Chromium 里实测过）。
 * 所以预览默认不给 `allow-scripts`；页面带脚本时预览上方出「运行脚本」，用户点过的那一版记在这台电脑的浏览器存储里。
 * 只记这一版：模型能往用户信过的页面发新版本，新版本要重新点。
 *
 * 设计面板的画板要靠我们自己的定位脚本（lib/design-bridge.js），只能给 `allow-scripts`，
 * 所以带脚本的页面在设计面板里也要先点「运行脚本」；不带脚本的页面直接打开。
 *
 * scripts/build-client.mjs 把本模块拼进 lib/client.js，和别的模块共用一个作用域，顶层名字都带 pagesScripts / PAGES_SCRIPTS。
 */
import { passivePageHtml, withoutPageReporter } from './pages-csp.js'

/** 浏览器存储里记「点过运行脚本的版本」的键。 */
export const PAGES_SCRIPTS_STORAGE = 'dsh-workbench.pages.scriptsAllowed'

/** 最多记的版本数；超出时丢掉最早点的。 */
export const PAGES_SCRIPTS_LIMIT = 500

/**
 * 页面里有没有能自己动起来的内容：脚本、事件属性、`javascript:` 地址、自动刷新跳转、`srcdoc` 内嵌页。
 * 先做保守文本检查，在浏览器中还要检查惰性模板的解析结果，宁可多报：多报只是多出一条「运行脚本」；静态画板另有只允许定位桥运行的 CSP。
 * 发布时叠进页面开头的上报脚本（`cspReportScriptTag()`）是我们自己的，先去掉。
 * @param {string} html 发布后的页面 HTML。
 * @returns {boolean} 有这类内容时为 true。
 */
export function pagesActiveContent(html) {
  const own = withoutPageReporter(html)
  if (/<script[\s/>]/i.test(own) || /[\s"'/]on[a-z]+\s*=/i.test(own) || /[\s"'/]srcdoc\s*=/i.test(own)) return true
  const decoded = pagesScriptsDecode(own)
  if (/<(?:base|embed|object|iframe|animate|set|animatetransform|animatemotion)[\s/>]/i.test(own)
    || /[\s"'/](?:ping|formaction)\s*=/i.test(own)
    || /<link\b[^>]*\b(?:dns-prefetch|preconnect|prefetch|prerender|modulepreload)\b/i.test(decoded)) return true
  return pagesScriptsParsedActive(own) || /<meta\b[^>]*refresh/i.test(decoded) || /(?:java|vb)script:/i.test(decoded.replace(/[\u0000- ]+/g, ''))
}

// Template contents stay detached. Read the names and values produced by the browser,
// including nested template fragments and foreign namespaces; never mount the inspected nodes.
function pagesScriptsParsedActive(html) {
  const doc = globalThis.document
  if (doc === undefined) return false // Non-rendering hosts use the conservative source checks above.
  if (typeof doc?.createTreeWalker !== 'function') return true
  try {
    const template = doc.createElement('template')
    template.innerHTML = html
    const roots = [template.content]
    while (roots.length) {
      const tree = doc.createTreeWalker(roots.pop(), 1 /* SHOW_ELEMENT */)
      for (let node = tree.nextNode(); node; node = tree.nextNode()) {
        const tag = node.localName.toLowerCase()
        if (tag === 'template' && node.content) roots.push(node.content)
        if (['script', 'base', 'embed', 'object', 'iframe', 'animate', 'set', 'animatetransform', 'animatemotion'].includes(tag)) return true
        if (tag === 'link' && [...node.relList].some(rel => /^(?:dns-prefetch|preconnect|prefetch|prerender|modulepreload)$/i.test(rel))) return true
        if (tag === 'meta' && node.hasAttribute('http-equiv')) {
          const header = node.getAttribute('http-equiv').trim().toLowerCase()
          if (!['content-type', 'content-security-policy', 'default-style'].includes(header)
            && !(header === 'x-dns-prefetch-control' && node.getAttribute('content')?.trim().toLowerCase() === 'off')) return true
        }
        for (const attr of node.attributes) {
          const name = attr.localName.toLowerCase()
          if (name.startsWith('on') || ['srcdoc', 'ping', 'formaction'].includes(name)) return true
          if (['href', 'src', 'action', 'data'].includes(name)
            && /^(?:java|vb)script:/i.test(attr.value.replace(/[\u0000- ]+/g, ''))) return true
        }
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * 把数字字符引用和几个能拼进地址的命名引用换成字符，`&#106;avascript:`、`java&Tab;script&colon;` 这类写法也查得出来。
 * 解析器认不带分号的数字引用，这里也认。
 * @param {string} text 页面文本。
 * @returns {string} 换过的文本，只用来查找。
 */
function pagesScriptsDecode(text) {
  const named = { colon: ':', tab: '\t', newline: '\n' }
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => pagesScriptsChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => pagesScriptsChar(Number.parseInt(dec, 10)))
    .replace(/&(colon|tab|newline);/gi, (_, name) => named[name.toLowerCase()])
}

/**
 * 码点换成字符；超出范围的引用换成空串（解析器换成替换字符，同样拼不出关键字）。
 * @param {number} code 码点。
 * @returns {string} 字符。
 */
function pagesScriptsChar(code) {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/**
 * 一版的键：`页面 id@版本号`。页面 id 不含分隔符，版本号是正的安全整数。
 * @param {string} pageId 页面 id。
 * @param {number} version 版本号。
 * @returns {string} 键。
 */
export function pagesScriptsKey(pageId, version) {
  return `${pageId}@${version}`
}

function pagesScriptsValidKey(key) {
  const match = typeof key === 'string' && /^[a-z0-9][a-z0-9-]{0,63}@([1-9]\d{0,15})$/.exec(key)
  return !!match && Number.isSafeInteger(Number(match[1]))
}

/**
 * 读点过「运行脚本」的版本。存储不能用或内容坏了时当作一版都没点过。
 * @param {() => Storage} [storage] 拿浏览器存储的函数（测试注入）。
 * @returns {string[]} 键的列表，最早点的在前，最多 `PAGES_SCRIPTS_LIMIT` 个。
 */
export function readPagesScriptsAllowed(storage = () => globalThis.localStorage) {
  let list
  try {
    list = JSON.parse(storage().getItem(PAGES_SCRIPTS_STORAGE))
  } catch {
    return [] // 存储不能用（隐私窗口、被禁用）或内容不是 JSON：当作一版都没点过，预览照样不运行脚本。
  }
  if (!Array.isArray(list) || !list.every(pagesScriptsValidKey) || new Set(list).size !== list.length) return []
  return list.slice(-PAGES_SCRIPTS_LIMIT)
}

/**
 * 这一版点过「运行脚本」没有。
 * @param {string} pageId 页面 id。
 * @param {number} version 版本号。
 * @param {() => Storage} [storage] 拿浏览器存储的函数（测试注入）。
 * @returns {boolean} 点过时为 true。
 */
export function pagesScriptsAllowed(pageId, version, storage) {
  return readPagesScriptsAllowed(storage).includes(pagesScriptsKey(pageId, version))
}

/**
 * 记下这一版运行脚本：挪到列表最后，超出上限时丢掉最早的。
 * @param {string} pageId 页面 id。
 * @param {number} version 版本号。
 * @param {() => Storage} [storage] 拿浏览器存储的函数（测试注入）。
 * @returns {boolean} 记进存储时为 true；存不进去时为 false，调用方只在这次打开里运行。
 */
export function allowPagesScripts(pageId, version, storage = () => globalThis.localStorage) {
  const key = pagesScriptsKey(pageId, version)
  if (!pagesScriptsValidKey(key)) return false
  const next = [...readPagesScriptsAllowed(storage).filter(item => item !== key), key].slice(-PAGES_SCRIPTS_LIMIT)
  try {
    storage().setItem(PAGES_SCRIPTS_STORAGE, JSON.stringify(next))
  } catch {
    return false // 存储不能用或满了：调用方在内存里记着，这次打开照样运行。
  }
  return true
}

/**
 * 预览框的 sandbox：页面带脚本、而且这一版点过「运行脚本」才给 `allow-scripts`。
 * 不带脚本的页面也不给：带不带脚本只决定出不出「运行脚本」，不决定预览框能做什么。
 * @param {boolean} active 页面带脚本（`pagesActiveContent`）。
 * @param {boolean} allowed 这一版点过「运行脚本」。
 * @returns {'' | 'allow-scripts'} iframe 的 sandbox 属性值。
 */
export function pagesPreviewSandbox(active, allowed) {
  return active && allowed ? 'allow-scripts' : ''
}

/**
 * 放进预览框的页面：不运行脚本时去掉发布时叠进去的上报脚本。它反正不会运行，留着只会让浏览器在控制台报「脚本被沙箱拦下」。
 * @param {string} html 发布后的页面 HTML。
 * @param {'' | 'allow-scripts'} sandbox 预览框的 sandbox（`pagesPreviewSandbox`）。
 * @returns {string} 放进 Blob 的 HTML。
 */
export function pagesPreviewHtml(html, sandbox) {
  return sandbox === '' ? passivePageHtml(html) : html
}

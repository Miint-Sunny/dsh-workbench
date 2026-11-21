/**
 * 网页发布（dsh-workbench/pages）的 CSP：内联后的页面要在沙箱 iframe 里安全地展示，发布时
 * 叠上自己的 CSP meta（default-src 'none'，只放行几个 CDN），再插一小段脚本把被拦的地址
 * postMessage 给父窗口，客户端在预览上方出提示条（样稿 E）。
 *
 * 页面自己的 CSP meta 不动：多个 meta 时 CSP 逐条叠加、都满足才放行，用户页面想拦得更严
 * 随它去；想拦得更松拦不过我们这条。
 * 本模块不 import 任何 @deepseek-ai 包。
 */

/** 我们的 CSP：默认全拒，脚本和样式放行内联加三个 CDN，样式另加 Google Fonts 的 css，
 * 字体放行 data: 和 Google Fonts 的字体文件，图片放行 data: 和 blob:；网络请求和表单全拒。 */
export const PAGES_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net unpkg.com",
  "style-src 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net unpkg.com fonts.googleapis.com",
  'font-src data: fonts.gstatic.com',
  'img-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
].join('; ')

/** 拦截上报脚本的正文：页面加载时（它在 head 最前，肯定先于页面脚本）挂监听，把被拦的
 * 地址发给父窗口。脚本是固定的，不拼用户内容。 */
const CSP_REPORT_SCRIPT = [
  '(function(){',
  'var q=function(e){',
  // 事件的属性叫 blockedURI（大写 URI）；只报网络地址：eval、inline 这类不是「访问的地址」，提示条会写成「页面试图访问 eval」。
  'try{var u=e.blockedURI||"";',
  // 一个地址只报一次：同一个地址被反复请求时不刷屏。
  'if(/^(https?|wss?):/i.test(u)&&!q.k[u]){q.k[u]=1;parent.postMessage({type:"dwb-csp",blocked:u},"*");}}catch(r){}};',
  'q.k={};',
  'document.addEventListener("securitypolicyviolation",q,true);',
  '})();',
].join('')

/**
 * 组装完整的 CSP meta 标签。
 * @returns {string} `<meta http-equiv="Content-Security-Policy" content="…">`，content 转义。
 */
export function cspMetaTag() {
  const content = PAGES_CSP.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return `<meta http-equiv="Content-Security-Policy" content="${content}">`
}

/** 上报脚本的 `<script>…<\/script>` 整体。 */
export function cspReportScriptTag() {
  return `<script>${CSP_REPORT_SCRIPT}</script>`
}

/**
 * 把 CSP meta 和拦截上报脚本插进 HTML 的最开头：至多一个首 BOM、HTML 空白、完整注释和 doctype 之后，用我们自己的
 * `<head>…</head>` 包起来。不去找页面里的 `<head>`：注释、脚本字符串、属性值里的 "<head>"
 * 会把 meta 带进注释里，页面在 `<head>` 之前的脚本也会先于 CSP 运行。页面自己随后的
 * `<head>` 标签被解析器忽略，它的 meta、link、title、style、script 照常归进我们的 head。
 * 第一个 meta 声明 UTF-8（读 HTML 时就是按 UTF-8 解码的）。
 * @param {string} html 内联后的 HTML。
 * @returns {string} 加固后的 HTML。
 */
export function applyPageHardening(html) {
  const inject = `<head><meta charset="utf-8">${cspMetaTag()}${cspReportScriptTag()}</head>`
  return insertPagePrelude(html, inject)
}

/** Preserve the leading HTML whitespace/comments and distinguish the document type. */
function pageProlog(html) {
  return /^\uFEFF?((?:[\t\n\f\r ]|<!--(?:>|->|[\s\S]*?--!?>))*)(<!doctype[^>]*>)?(?:[\t\n\f\r ]|<!--(?:>|->|[\s\S]*?--!?>))*/i.exec(html)
}

/** Insert trusted headers at the document boundary, including in previously stored HTML. */
function insertPagePrelude(html, prelude) {
  const at = pageProlog(html)[0].length
  return html.slice(0, at) + prelude + html.slice(at)
}

/** Only the reporter at the exact position written by the publisher belongs to us. */
export function withoutPageReporter(html) {
  const head = '<head><meta charset="utf-8">' + cspMetaTag()
  const at = pageProlog(html)[0].length
  const tag = cspReportScriptTag()
  if (!html.startsWith(head + tag + '</head>', at)) return html
  const reporter = at + head.length
  return html.slice(0, reporter) + html.slice(reporter + tag.length)
}

/** Add the read-only preview policy. A static design board also authorizes its private bridge nonce. */
export function passivePageHtml(html, bridgeNonce) {
  const scripts = bridgeNonce === undefined ? "'none'" : "'nonce-" + bridgeNonce + "'"
  const policy = "script-src " + scripts + "; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
  const meta = '<meta http-equiv="x-dns-prefetch-control" content="off">' + cspMetaTag()
    + '<meta http-equiv="Content-Security-Policy" content="' + policy + '">'
  // The preview policy is built independently of the stored publishing header. Only a
  // well-formed HTML doctype can precede it; author comments and all other bytes follow.
  const page = withoutPageReporter(html).replace(/^\uFEFF/, '')
  const [, before, declaration = ''] = pageProlog(page)
  const doctype = /^<!doctype[\t\n\f\r ]+html(?:[\t\n\f\r ]+(?:PUBLIC|SYSTEM)[\t\n\f\r ]+(?:"[^"<>]*"|'[^'<>]*')(?:[\t\n\f\r ]+(?:"[^"<>]*"|'[^'<>]*'))?)?[\t\n\f\r ]*>$/i.test(declaration) ? declaration : ''
  return doctype + '<head><meta charset="utf-8">' + meta + '</head>' + before + page.slice(before.length + doctype.length)
}

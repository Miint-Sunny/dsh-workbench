/**
 * 工作区信任（dsh-workbench/workspace-trust）：dsh-better-sidebar 的 HTML 预览路由
 * `/sidebar/html/<会话 id>/<绝对路径>` 的解码，和浏览器一侧对内联资源地址的分类。
 * 宿主端和网页端共用（scripts/build-client.mjs 把它拼进 lib/client.js），所以不 import 任何模块。
 * 解码规则照抄 dsh-better-sidebar 0.32.0 `src/html-route.ts` 的 decodeHtmlUrl：会话 id 和路径各段
 * 分别 decodeURIComponent；第一个路径段为空表示 UNC；`~` 开头保留原样；Windows 盘符段不加前导斜杠。
 */

/** 预览路由的前缀（不含反向代理的目录前缀）。 */
export const PREVIEW_ROUTE_MARK = '/sidebar/html/'

/**
 * 解码路由前缀之后的那一段。
 * @param {unknown} rest 形如 `S1/workspace/project/index.html`。
 * @returns {{ sessionId: string, path: string } | null} 解码不了、缺会话或路径、含 NUL 时为 null。
 */
export function decodePreviewRoute(rest) {
  if (typeof rest !== 'string' || rest === '' || rest.startsWith('/')) return null
  let segments
  try {
    segments = rest.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
  if (segments.some(segment => segment.includes('\0'))) return null
  const [sessionId, ...pathSegments] = segments
  if (sessionId === undefined || sessionId === '') return null
  const unc = pathSegments[0] === ''
  const tail = unc ? pathSegments.slice(1) : pathSegments
  if (tail.length === 0 || tail.some(segment => segment === '')) return null
  if (unc) return { sessionId, path: `//${tail.join('/')}` }
  if (tail[0] === '~' || /^[A-Za-z]:$/.test(tail[0])) return { sessionId, path: tail.join('/') }
  return { sessionId, path: `/${tail.join('/')}` }
}

/** 协议、用户名、密码、主机、端口都相同。`dsh-app:` 这类自定义协议的 URL.origin 是 "null"，不能拿来比。 */
function sameOrigin(a, b) {
  return a.protocol === b.protocol && a.username === b.username && a.password === b.password
    && a.hostname === b.hostname && a.port === b.port
}

/**
 * 内联器要取的一个地址该怎么办。只看地址形状，不判断边界（边界在宿主端）：
 * - `route`：和文档同源、同一个反向代理前缀、同一个会话的 `/sidebar/html/` 地址，交给宿主端；
 * - `other-session`：同一路由下别的会话；
 * - `other-route`：同源的其他路径（`/api/…`、`/sidebar/api/…` 等）；
 * - `cross-origin`：不同源或不是合法地址（内联器本来就不会取）。
 * @param {string} url 内联器解析出的绝对地址。
 * @param {string} documentUrl 预览文档的绝对地址。
 * @returns {{ kind: 'route', document: string, resource: string } | { kind: 'other-session' | 'other-route' | 'cross-origin' }} 分类。
 */
export function classifyPreviewResource(url, documentUrl) {
  let target, doc
  try {
    target = new URL(url)
    doc = new URL(documentUrl)
  } catch {
    return { kind: 'cross-origin' }
  }
  if (!sameOrigin(target, doc)) return { kind: 'cross-origin' }
  const at = doc.pathname.indexOf(PREVIEW_ROUTE_MARK)
  if (at === -1) return { kind: 'other-route' }
  const prefix = doc.pathname.slice(0, at + PREVIEW_ROUTE_MARK.length)
  const documentRest = doc.pathname.slice(prefix.length)
  const session = documentRest.split('/')[0]
  if (!target.pathname.startsWith(prefix)) return { kind: 'other-route' }
  if (session === '' || !target.pathname.startsWith(`${prefix}${session}/`)) return { kind: 'other-session' }
  return { kind: 'route', document: documentRest, resource: target.pathname.slice(prefix.length) }
}

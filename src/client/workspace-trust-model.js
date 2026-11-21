/**
 * 工作区信任（dsh-workbench/workspace-trust）网页端的纯函数：判断预览是否走内联、每个文档的资源记录、
 * 说明条该显示哪一种。不碰 DOM 和 React，测试直接 import。设计见 docs/plans/2026-11-13-工作区信任.md 4.4、5 节。
 */
import { decodePreviewRoute, PREVIEW_ROUTE_MARK } from '../../lib/workspace-trust-route.js'

/** 每个文档最多内联的资源个数和总字节数；超过的按「超过读取上限」拦下。 */
export const TRUST_MAX_RESOURCES = 256
export const TRUST_MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** 每个文档同时在途的资源请求数。内联器用 Promise.all 一次发出全部请求，这里排队。 */
export const TRUST_MAX_INFLIGHT = 4

/**
 * 并发闸门：同时最多 max 个在跑，其余排队（不拒绝；总数由资源记录的名额限住）。
 * @param {number} max 同时在跑的上限。
 * @returns {{ run: <T>(task: () => Promise<T>) => Promise<T> }} 闸门。
 */
export function createConcurrencyGate(max) {
  let active = 0
  const waiting = []
  const next = () => {
    if (active >= max || waiting.length === 0) return
    active++
    const { task, resolve, reject } = waiting.shift()
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next() })
  }
  return { run: task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next() }) }
}

/** 拦下原因在汇总里的先后。 */
export const TRUST_REASON_ORDER = ['outside', 'hidden', 'type', 'other-route', 'other-session', 'too-large', 'limit', 'not-file', 'changed', 'document-outside', 'missing']

/**
 * 和 dsh-better-sidebar 的 HtmlPreviewFrame 同一个条件：沙箱开着，且页面基准是桌面壳的 `dsh-app:`。
 * 只有这时它才在顶层页面里取资源再内联；其余情况 iframe 直接指向路由，和信任无关。
 * @param {{ sandboxed?: boolean, src?: string }} props 预览框的属性。
 * @param {string} baseUrl 页面基准。
 * @returns {boolean} 是否走内联。
 */
export function previewInlines(props, baseUrl) {
  if (props?.sandboxed !== true || typeof props.src !== 'string' || props.src === '') return false
  try {
    return new URL(baseUrl).protocol === 'dsh-app:'
  } catch {
    return false
  }
}

/**
 * 预览文档地址里的会话和路径。
 * @param {string} documentUrl 绝对地址。
 * @returns {{ sessionId: string, path: string } | null} 不是 /sidebar/html/ 地址时 null。
 */
export function previewDocumentOf(documentUrl) {
  let url
  try {
    url = new URL(documentUrl)
  } catch {
    return null
  }
  const at = url.pathname.indexOf(PREVIEW_ROUTE_MARK)
  return at === -1 ? null : decodePreviewRoute(url.pathname.slice(at + PREVIEW_ROUTE_MARK.length))
}

/**
 * 显示用的地址：同源时写路径（解码），不同源时写原地址。
 * @param {string} url 绝对地址。
 * @returns {string} 显示文字。
 */
export function displayOfUrl(url) {
  try {
    const parsed = new URL(url)
    const at = parsed.pathname.indexOf(PREVIEW_ROUTE_MARK)
    const decoded = at === -1 ? null : decodePreviewRoute(parsed.pathname.slice(at + PREVIEW_ROUTE_MARK.length))
    if (decoded !== null) return decoded.path
    return decodeURIComponent(parsed.pathname) + parsed.search
  } catch {
    return url
  }
}

/**
 * 一个文档、一个信任版本的资源记录：内联器每取一个同源地址记一条。可订阅，给说明条用。
 * @returns {{ note: (entry: { reason?: string, display?: string }) => void, reserve: () => boolean, charge: (bytes: number) => boolean, snapshot: () => object, subscribe: (listener: () => void) => () => void }} 记录。
 */
export function createTrustRecord() {
  let state = { loaded: 0, untrusted: 0, error: 0, items: [] }
  let count = 0, total = 0
  const listeners = new Set()
  const publish = (next) => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  return {
    /** 发请求之前占一个名额（同步，并发调用也不会超）；名额用完返回 false。 */
    reserve() {
      if (count >= TRUST_MAX_RESOURCES) return false
      count += 1
      return true
    },
    /** 字节数计入总量；超过总量时返回 false，调用方按 too-large 记。 */
    charge(bytes) {
      if (total + bytes > TRUST_MAX_TOTAL_BYTES) return false
      total += bytes
      return true
    },
    note({ reason, display }) {
      if (reason === undefined) {
        publish({ ...state, loaded: state.loaded + 1 })
        return
      }
      if (reason === 'untrusted') publish({ ...state, untrusted: state.untrusted + 1, items: [...state.items, { reason, display }] })
      else if (reason === 'error') publish({ ...state, error: state.error + 1, items: [...state.items, { reason, display }] })
      else publish({ ...state, items: [...state.items, { reason, display }] })
    },
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 预览是否运行脚本（交互预览）。只有工作区已信任、而且文档在这个工作区里时才是；其余一律按官方的静态预览：
 * sandbox=""，脚本不运行，CSP 只放行 data:（better-sidebar 补丁里的默认）。
 * @param {{ state: string, trusted?: boolean, documentInside?: boolean } | undefined} status 宿主判定的工作区和文档状态。
 * @param {object} record 资源记录；宿主在读取时报告文档越界或撤销信任，也退回静态。
 * @returns {boolean} 是否运行脚本。
 */
export function previewInteractive(status, record) {
  const notice = trustNoticeOf(status, record)
  return status?.state === 'ready' && status.trusted === true && status.documentInside === true
    && (notice === null || notice.kind === 'blocked')
}

/**
 * 说明条显示哪一种。
 * - untrusted：没信任，静态预览，一直显示（带信任按钮）；
 * - document-outside：文件不在会话的工作区里，静态预览，一直显示（没有信任按钮）；
 * - error：读不到信任状态，静态预览，一直显示（带重试）；
 * - blocked：已信任，有资源被拦下或没找到；
 * - null：不显示（状态还没回来；已信任且全部加载）。
 * @param {{ state: 'loading' | 'ready' | 'error', trusted?: boolean, documentInside?: boolean } | undefined} status 宿主判定的工作区和文档状态。
 * @param {{ loaded: number, untrusted: number, error: number, items: { reason: string, display: string }[] }} record 资源记录。
 * @returns {null | { kind: string, count?: number, blocked?: number, missing?: number, reasons?: [string, number][], items?: object[] }} 说明条。
 */
export function trustNoticeOf(status, record) {
  if (status === undefined || status.state === 'loading') return null
  if (status.state === 'error') return { kind: 'error' }
  if (status.documentInside !== true || record.items.some(item => item.reason === 'document-outside')) return { kind: 'document-outside' }
  if (!status.trusted || record.untrusted > 0) return { kind: 'untrusted' }
  const notLoaded = record.items.length
  if (notLoaded === 0) return null
  const tally = new Map()
  for (const item of record.items) tally.set(item.reason, (tally.get(item.reason) ?? 0) + 1)
  const reasons = [...tally].sort((a, b) => rank(a[0]) - rank(b[0]))
  const missing = tally.get('missing') ?? 0
  return { kind: 'blocked', count: notLoaded, blocked: notLoaded - missing, missing, reasons, items: record.items }
}

const rank = reason => {
  const at = TRUST_REASON_ORDER.indexOf(reason)
  return at === -1 ? TRUST_REASON_ORDER.length : at
}

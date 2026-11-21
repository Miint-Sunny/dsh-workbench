/**
 * 网页发布（计划第 8 项）的网页部分：右侧栏的「页面」标签、侧边栏的「页面」整页、
 * 对话里 publish_page 的工具行、文件预览里的「发布为页面」。页面放在
 * `<iframe sandbox>` 里用 Blob 地址加载（和 DSH 不同源，碰不到登录和接口）。页面里的脚本默认不运行：
 * 带脚本的页面上方出「运行脚本」，点过的那一版才给 `allow-scripts`（fix#173，见 lib/pages-scripts.js）；
 * 内容从 GET api/dsh-workbench.pages.html 拿，内联时叠的 CSP 把被拦的地址 postMessage
 * 给父窗口（dwb-csp），预览上方出提示条（样稿 E）。
 *
 * 地址把页面和版本放在里面：`dsh-resource://wbpages/page/<页面 id>/<版本号>`，刷新后标签还在
 * （DSH 刷新后不保留标签的 params）。面板页里 openResource 会抛错（DSH 的行为），预览组件
 * 两处复用，操作都在各自页面里做。
 *
 * 每个功能行一个模块，由 scripts/build-client.mjs 按顺序拼进 lib/client.js：
 * 模块之间共用同一个作用域，所以本模块的顶层名字都带 Pages/PAGES 标记，不能和别的模块重名。
 */
import { workbenchPathBelow } from './features.js'
import { mountModuleStyle } from './style.js'
import { allowPagesScripts, pagesActiveContent, pagesPreviewHtml, pagesPreviewSandbox, pagesScriptsAllowed } from '../../lib/pages-scripts.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重）。remote.session 的 openWorkspacePath
 * 做「显示文件位置」（调研 E 第 8 节，0.2.2-rc.1 的 ui-open-in-app 同款）。 */
const PAGES_INJECT = ['sidebarRight', 'resources', 'layout', 'uiWorkspace', 'remote', 'remote.session', 'sessions']

/** 本功能的中文界面文字；键以 `pages.` 开头，词照 DESIGN.md 和 dsh-terms 查过的 DSH 叫法。 */
const PAGES_ZH = {
  'pages.panel': '页面',
  'pages.tab.fallback': '页面',
  'pages.tab.loading': '加载中…',
  'pages.tab.missing': '此页面已被删除或文件已损坏',
  'pages.tab.copy': '复制 HTML',
  'pages.tab.copied': '已复制',
  'pages.tab.copyFailed': '无法复制 HTML，请重试',
  'pages.tab.reveal': '显示文件位置',
  'pages.tab.revealFailed': '无法显示文件位置，请重试',
  'pages.tab.delete': '删除',
  'pages.tab.undoBar': '已删除页面「{title}」（{n} 个版本）。',
  'pages.tab.undo': '撤销',
  'pages.tab.undoFailed': '撤销失败，请重试',
  'pages.tab.blocked': '已拦截页面对 {blocked} 的访问。页面仅能从 cdnjs、jsDelivr、unpkg 和 Google Fonts 加载内容。',
  'pages.tab.blockedClose': '关闭',
  'pages.tab.scripts': '这个页面带脚本或会自己运行的内容，默认不运行。运行后，页面能跳到别的网址，把页面里的内容带过去。点过的这一版在本机记住，预览和设计面板都直接运行；新版本要再点一次。',
  'pages.tab.runScripts': '运行脚本',
  'pages.version': '第 {n} 版',
  'pages.versionOption': '第 {n} 版 · {time}',
  'pages.inline': '已内联 {scripts} 个脚本、{styles} 个样式表、{images} 张图片',
  'pages.row.title': '网页发布',
  'pages.row.failed': '发布失败：{reason}',
  'pages.row.open': '打开',
  'pages.panel.search': '搜索页面',
  'pages.panel.emptyTitle': '还没有发布过页面',
  'pages.panel.emptyBody': '由模型调用 publish_page 发布，或在文件预览中点击「发布为页面」。',
  'pages.panel.loadFailed': '加载失败',
  'pages.panel.retry': '重试',
  'pages.panel.versions': '第 {n} 版',
  'pages.publish': '发布为页面',
  'pages.publishing': '发布中…',
  'pages.publishFailed': '发布失败：{reason}',
  'pages.networkError': '网络错误，请重试',
}

/** 本功能的英文界面文字，键和 PAGES_ZH 一一对应。 */
const PAGES_EN = {
  'pages.panel': 'Pages',
  'pages.tab.fallback': 'Page',
  'pages.tab.loading': 'Loading…',
  'pages.tab.missing': 'This page was deleted or its files are damaged',
  'pages.tab.copy': 'Copy HTML',
  'pages.tab.copied': 'Copied',
  'pages.tab.copyFailed': 'Could not copy the HTML. Try again',
  'pages.tab.reveal': 'Show file location',
  'pages.tab.revealFailed': 'Could not show the file location. Try again',
  'pages.tab.delete': 'Delete',
  'pages.tab.undoBar': 'Deleted page “{title}” ({n} versions).',
  'pages.tab.undo': 'Undo',
  'pages.tab.undoFailed': 'Undo failed. Try again',
  'pages.tab.blocked': "Blocked the page's request to {blocked}. Pages can load content only from cdnjs, jsDelivr, unpkg and Google Fonts.",
  'pages.tab.blockedClose': 'Close',
  'pages.tab.scripts': 'This page has scripts or other content that runs on its own, which does not run by default. Once it runs, the page can go to another site and take its content with it. The version you run is remembered on this device for both the preview and the design panel; a new version asks again.',
  'pages.tab.runScripts': 'Run scripts',
  'pages.version': 'Version {n}',
  'pages.versionOption': 'Version {n} · {time}',
  'pages.inline': 'inlined {scripts} scripts, {styles} stylesheets, {images} images',
  'pages.row.title': 'Publish page',
  'pages.row.failed': 'Publish failed: {reason}',
  'pages.row.open': 'Open',
  'pages.panel.search': 'Search pages',
  'pages.panel.emptyTitle': 'No pages published yet',
  'pages.panel.emptyBody': 'Publish with the publish_page tool, or click “Publish as page” in a file preview.',
  'pages.panel.loadFailed': 'Failed to load',
  'pages.panel.retry': 'Retry',
  'pages.panel.versions': 'Version {n}',
  'pages.publish': 'Publish as page',
  'pages.publishing': 'Publishing…',
  'pages.publishFailed': 'Publish failed: {reason}',
  'pages.networkError': 'Network error. Try again',
}

/** 资源协议，也是标签类型的 kind。 */
const PAGES_PROTOCOL = 'wbpages'

/** 右侧栏标签类型的 id（全局唯一，也是 `sidebar.right.pane.tab` 的 key）。 */
const PAGES_TAB_ID = 'dsh-workbench/pages'

/** 标签地址前缀。 */
const PAGES_ADDRESS_PREFIX = 'dsh-resource://wbpages/page/'

/** 侧边栏面板的 id（panellist 的 id 和 main 的 key）。 */
const PAGES_PANEL_ID = 'dsh-workbench-pages'

/**
 * 某个页面某一版的标签地址。
 * @param {string} pageId 页面 id。
 * @param {number} version 版本号。
 * @returns {string} 标签地址。
 */
export function pagesAddress(pageId, version) {
  return `${PAGES_ADDRESS_PREFIX}${encodeURIComponent(pageId)}/${version}`
}

/**
 * 从标签地址取页面 id 和版本号。
 * @param {unknown} value 可能是标签地址的值。
 * @returns {{ pageId: string, version: number } | undefined} 页面和版本；不是本功能的地址或编码有误时 undefined。
 */
export function parsePagesAddress(value) {
  if (typeof value !== 'string' || !value.startsWith(PAGES_ADDRESS_PREFIX)) return undefined
  const rest = value.slice(PAGES_ADDRESS_PREFIX.length).split('?')[0]
  const slash = rest.lastIndexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  const n = rest.slice(slash + 1)
  if (!/^\d+$/.test(n) || Number(n) < 1) return undefined
  try {
    const pageId = decodeURIComponent(rest.slice(0, slash))
    if (pageId === '') return undefined
    return { pageId, version: Number(n) }
  } catch {
    return undefined
  }
}

/**
 * 文件预览里的「发布为页面」要不要出现：只在会话工作区里的 .html/.htm 文件上出现。
 * 纯函数（浏览器里没有 node:path，自己算）。
 * @param {string | undefined} absolutePath 文件的绝对路径（document.actions 条目拿到的）。
 * @param {string | undefined} cwd 会话的工作区根（会话列表条目的 cwd）。
 * @returns {string | undefined} 工作区里的相对路径（posix 写法）；不该出现时 undefined。
 */
export function pagesShouldOfferPublish(absolutePath, cwd) {
  if (typeof absolutePath !== 'string' || absolutePath === '' || typeof cwd !== 'string' || cwd === '') return undefined
  const path = absolutePath.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/')
  // 两种都要是绝对路径（posix 或 Windows 盘符，照 DSH 的 isAbsoluteWorkspacePath）
  const isAbsolute = (value) => value.startsWith('/') || /^[a-z]:\//i.test(value)
  if (!isAbsolute(path) || !isAbsolute(root)) return undefined
  if (!path.toLowerCase().endsWith('.html') && !path.toLowerCase().endsWith('.htm')) return undefined
  // 盘符根和 / 也能做工作区根；Windows 路径不分大小写
  const rest = workbenchPathBelow(cwd, absolutePath)
  if (rest === undefined) return undefined
  // 剩下的段照路径解析折起来：`.` 丢掉，`..` 弹一段；折出工作区根就不到这个文件了
  const out = []
  for (const part of rest) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(part)
  }
  if (out.length === 0) return undefined
  return out.join('/')
}

const PAGES_KIB = 1024
const PAGES_MIB = 1024 * 1024

/**
 * 字节数的写法（和宿主端 lib/pages-error.js 的 formatBytes 一致；样稿里的「182 KB」「6.2 MiB」）。
 * @param {number} bytes 字节数。
 * @returns {string} 例如「182 KB」。
 */
export function pagesFormatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB'
  if (bytes < PAGES_KIB) return `${bytes} 字节`
  if (bytes < PAGES_MIB) return `${Math.round(bytes / PAGES_KIB)} KB`
  const mib = bytes / PAGES_MIB
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
}

/**
 * 相对时间的写法：不到一分钟「刚刚」，今天 HH:mm，昨天写「昨天」，今年「M 月 D 日」，更早带年份。
 * @param {number} ts 时间戳（毫秒）。
 * @param {number} now 当前时间（毫秒，测试注入）。
 * @returns {string} 时间文字。
 */
export function pagesFormatTime(ts, now = Date.now()) {
  const date = new Date(ts)
  const current = new Date(now)
  const minutes = Math.floor((now - ts) / 60000)
  if (minutes < 1) return '刚刚'
  const sameDay = date.toDateString() === current.toDateString()
  if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const yesterday = new Date(now - 24 * 60 * 60 * 1000)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  if (date.getFullYear() === current.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/**
 * 面板列表按标题过滤（不分大小写；空串不过滤）。
 * @param {{ id: string, title?: string, corrupt?: boolean }[]} pages 页面列表。
 * @param {string} query 搜索词。
 * @returns {object[]} 过滤后的列表。
 */
export function pagesFilterPages(pages, query) {
  const needle = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : ''
  if (needle === '') return pages
  return pages.filter(page => typeof page.title === 'string' && page.title.toLowerCase().includes(needle))
}

/**
 * 一个页面 meta 的最新版本（列表条目「第 N 版 · 大小 · 时间」用）。
 * @param {{ versions?: { n: number }[] }} page 页面条目。
 * @returns {object | undefined} 最新版本。
 */
export function pagesLatestVersion(page) {
  const versions = Array.isArray(page?.versions) ? page.versions : []
  return versions[versions.length - 1]
}

/**
 * 这一版在磁盘上的文件路径（「显示文件位置」用；宿主在 list 的结果里给出目录）。
 * @param {string | undefined} dir 页面目录（list 结果里的 dir）。
 * @param {number} version 版本号。
 * @returns {string | undefined} v<N>.html 的绝对路径；没有目录时 undefined。
 */
export function pagesVersionFile(dir, version) {
  return typeof dir === 'string' && dir !== '' ? `${dir.replace(/\/+$/, '')}/v${version}.html` : undefined
}

/** 提示条最多记几条被拦的地址、每条最长多少个字符。 */
const PAGES_BLOCKED_MAX = 20
const PAGES_BLOCKED_MAX_LENGTH = 300

/**
 * 收进一条被拦的地址：没见过的添在后面，见过的不重复。
 * @param {string[]} known 已知的被拦地址。
 * @param {string} blocked 新的被拦地址。
 * @returns {string[]} 新列表（known 没变时返回原引用）。
 */
export function pagesMergeBlocked(known, blocked) {
  // 消息来自页面（沙箱里的脚本能直接 postMessage）：只收字符串，最多 20 条、每条最长 300 个字符，
  // 不然一个页面发几万条不同的字符串就能卡住宿主界面。
  if (typeof blocked !== 'string' || blocked === '' || known.length >= PAGES_BLOCKED_MAX) return known
  const clipped = blocked.slice(0, PAGES_BLOCKED_MAX_LENGTH)
  if (known.includes(clipped)) return known
  return [...known, clipped]
}

/**
 * 工具行「内联了什么」的词典参数：没有资源时给 inlineNone 用。
 * @param {{ scripts?: number, styles?: number, images?: number } | undefined} assets 版本的 assets 计数。
 * @returns {{ any: boolean, scripts: number, styles: number, images: number }} 参数。
 */
export function pagesInlineParams(assets) {
  const scripts = assets?.scripts ?? 0
  const styles = assets?.styles ?? 0
  const images = assets?.images ?? 0
  return { any: scripts + styles + images > 0, scripts, styles, images }
}

/** 入口上下文里的 DSH 客户端上下文和词典，applyPages 时记下。 */
let pagesCtx
let pagesT

/** 页面列表的客户端读取器（标签、面板和工具行共用；applyPages 时建）。 */
let pagesStore

/**
 * 建页面列表的读取器：load 读 GET api/dsh-workbench.pages.list；失败保留上一份并记 error。
 * @returns {{ load: () => Promise<void>, get: () => { status: 'loading' | 'ready' | 'error', pages: object[] }, subscribe: (listener: () => void) => () => void }} 读取器。
 */
export function createPagesClientStore() {
  let state = { status: 'loading', pages: [] }
  const listeners = new Set()
  const changed = () => { for (const listener of listeners) listener() }
  const load = async () => {
    let next
    try {
      const response = await fetch('api/dsh-workbench.pages.list', { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      next = { status: 'ready', pages: Array.isArray(body?.pages) ? body.pages : [] }
    } catch {
      // 读失败保留上一份和 error 标记；面板写「加载失败」带重试。
      if (state.status !== 'ready') {
        state = { status: 'error', pages: [] }
        changed()
      }
      return
    }
    state = next
    changed()
  }
  return {
    load,
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** POST pages 的某个动作，把 { ok, … } 答回来；网络错误按 ok: false 处理。 */
async function pagesPost(name, body) {
  const response = await fetch(`api/dsh-workbench.pages.${name}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => ({}))
  if (!response.ok) return { ok: false, message: typeof parsed?.message === 'string' ? parsed.message : `HTTP ${response.status}` }
  return parsed
}

/**
 * 在右侧栏打开一个页面的标签。在面板页里 openResource 会抛错（DSH 的行为），调用前先回对话。
 * @param {string} pageId 页面 id。
 * @param {number} version 版本号。
 * @returns {void}
 */
function pagesOpen(pageId, version) {
  try {
    pagesCtx.layout.selectPanel(null)
  } catch {
    // 不在面板里时也照走：openResource 自己会聚焦或新开标签。
  }
  pagesCtx.sidebarRight.openResource(pagesAddress(pageId, version))
}

/** 等信号中止。 */
function pagesWaitForAbort(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
}

/**
 * 页面预览：上面一排（版本下拉、复制 HTML、显示文件位置、删除），下面 iframe 和提示条；
 * 删除后出撤销条（样稿 B、E）。标签和面板页共用。
 * @param {{ page: object, version: number, onDeleted: () => void, onRestored: () => void }} props 预览属性。
 * @returns {unknown} React 节点。
 */
function PagesPreview({ page, version, onDeleted, onRestored }) {
  const [selected, setSelected] = useState(version)
  const [blobUrl, setBlobUrl] = useState(undefined)
  const [loadFailed, setLoadFailed] = useState(false)
  const [blocked, setBlocked] = useState([])
  const [blockedClosed, setBlockedClosed] = useState(false)
  // 这一版带不带脚本、点过「运行脚本」没有；拉到 HTML 之前都是 false，预览框不运行脚本。
  const [scripts, setScripts] = useState({ active: false, allowed: false })
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState(undefined)
  const [deleted, setDeleted] = useState(false)
  // 删除后不马上重读列表：页面一从列表里消失，这个预览和它的撤销条就跟着卸载了。离开时（换页、关标签）才重读。
  const deletedRef = useRef(false)
  useEffect(() => () => { if (deletedRef.current) onDeleted?.() }, [])
  const frameRef = useRef(null)
  const urlRef = useRef(undefined)
  // 等「运行脚本」时这一版的完整 HTML：点了就用它重新建预览地址；点过、换版本或卸载时清掉。
  const htmlRef = useRef('')

  useEffect(() => {
    setSelected(version)
  }, [version, page.id])

  // 拉这一版的 HTML，建 Blob 地址；换版本和卸载时 revoke。上一版的拦截提示、「知道了」和操作报错不带到这一版。
  useEffect(() => {
    let revoked = false
    setLoadFailed(false)
    setBlocked([])
    setBlockedClosed(false)
    setActionError(undefined)
    setScripts({ active: false, allowed: false })
    ;(async () => {
      try {
        const response = await fetch(`api/dsh-workbench.pages.html?page=${encodeURIComponent(page.id)}&v=${selected}`, { credentials: 'same-origin' })
        if (revoked) return
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const html = await response.text()
        // 已经换了版本或卸载：不再查脚本、不建地址。
        if (revoked) return
        const active = pagesActiveContent(html)
        const allowed = pagesScriptsAllowed(page.id, selected)
        const url = URL.createObjectURL(new Blob([pagesPreviewHtml(html, pagesPreviewSandbox(active, allowed))], { type: 'text/html;charset=utf-8' }))
        htmlRef.current = active && !allowed ? html : ''
        urlRef.current = url
        setScripts({ active, allowed })
        setBlobUrl(url)
      } catch {
        if (!revoked) setLoadFailed(true)
      }
    })()
    return () => {
      revoked = true
      if (urlRef.current !== undefined) URL.revokeObjectURL(urlRef.current)
      urlRef.current = undefined
      htmlRef.current = ''
      setBlobUrl(undefined)
    }
  }, [page.id, selected])

  // 沙箱里叠的 CSP 把被拦的地址 postMessage 出来；只认自己 iframe 发的。换版本时 urlRef 先清空、再换成新地址，
  // 预览框换上新地址之前旧页面发来的上报不算；预览框按地址重建（key），旧页面的窗口跟着旧元素作废。
  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== frameRef.current?.contentWindow || frameRef.current?.src !== urlRef.current) return
      if (event.data?.type !== 'dwb-csp' || typeof event.data.blocked !== 'string') return
      setBlocked(current => pagesMergeBlocked(current, event.data.blocked))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  const revealPath = pagesVersionFile(page.dir, selected)
  const sandbox = pagesPreviewSandbox(scripts.active, scripts.allowed)

  /**
   * 「运行脚本」：记下这一版，换成完整的页面（不运行脚本时去掉了上报脚本）建新地址，预览框按新的 sandbox 重建。
   * 存不进浏览器存储时只在这次打开里运行。
   */
  const runScripts = () => {
    allowPagesScripts(page.id, selected)
    const url = URL.createObjectURL(new Blob([htmlRef.current], { type: 'text/html;charset=utf-8' }))
    htmlRef.current = ''
    if (urlRef.current !== undefined) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setScripts(current => ({ ...current, allowed: true }))
    setBlobUrl(url)
  }

  /** 3 秒后收起「已复制」。 */
  const copyHtml = async () => {
    setActionError(undefined)
    try {
      const response = await fetch(`api/dsh-workbench.pages.html?page=${encodeURIComponent(page.id)}&v=${selected}`, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('http')
      const ok = await ui.writeClipboard(await response.text())
      if (!ok) throw new Error('clipboard')
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 3000)
    } catch {
      setActionError(pagesT('pages.tab.copyFailed'))
    }
  }

  const reveal = async () => {
    setActionError(undefined)
    if (revealPath === undefined) {
      setActionError(pagesT('pages.tab.revealFailed'))
      return
    }
    try {
      const result = await pagesCtx.remote.session.openWorkspacePath({ path: revealPath, action: 'reveal' })
      if (result?.ok !== true) throw new Error('reveal')
    } catch {
      setActionError(pagesT('pages.tab.revealFailed'))
    }
  }

  const remove = async () => {
    setActionError(undefined)
    const result = await pagesPost('delete', { page: page.id })
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    deletedRef.current = true
    setDeleted(true)
  }

  const undo = async () => {
    setActionError(undefined)
    const result = await pagesPost('restore', { page: page.id })
    if (!result.ok) {
      setActionError(pagesT('pages.tab.undoFailed'))
      return
    }
    deletedRef.current = false
    setDeleted(false)
    setBlocked([])
    setBlockedClosed(false)
    onRestored?.()
  }

  if (deleted) {
    // 刚删掉的页面只给撤销条（样稿 E）；「已删除或文件损坏」是页面本来就不在时的说法。
    return h('div', { className: 'dwb-pg-state' },
      h('div', { className: 'dwb-pg-undo' },
        h('span', null, pagesT('pages.tab.undoBar', { title: page.title ?? page.id, n: page.versions?.length ?? 1 })),
        h('button', { type: 'button', className: 'dwb-pg-linkbtn', onClick: undo }, pagesT('pages.tab.undo'))))
  }

  return h('div', { className: 'dwb-pg-preview', 'data-dsh-workbench-pages': page.id, tabIndex: 0, onContextMenu: event => designPageMenu(event,page,selected), onKeyDown: event => designPageMenu(event,page,selected) },
    h('div', { className: 'dwb-pg-tool' },
      h('label', { className: 'dwb-pg-version' },
        h('span', { className: 'dwb-pg-vlabel' }, pagesT('pages.version', { n: selected })),
        h(ui.IconChevronDownOutlineRegular, { size: 12 }),
        h('select', {
          value: String(selected),
          'aria-label': pagesT('pages.version', { n: selected }),
          onChange: (event) => { setSelected(Number(event.target.value)) },
        }, (page.versions ?? []).map(item => h('option', {
          key: item.n,
          value: String(item.n),
        }, pagesT('pages.versionOption', { n: item.n, time: pagesFormatTime(item.createdAt) }))))),
      h('span', { className: 'dwb-pg-grow' }),
      h('button', { type: 'button', className: 'dwb-pg-ghost', onClick: copyHtml },
        h(ui.IconCopyOutlineRegular, { size: 14 }),
        copied ? pagesT('pages.tab.copied') : pagesT('pages.tab.copy')),
      revealPath === undefined ? null : h('button', { type: 'button', className: 'dwb-pg-ghost', onClick: reveal },
        h(ui.IconFolderOpenOutlineRegular, { size: 14 }),
        pagesT('pages.tab.reveal')),
      h('button', { type: 'button', className: 'dwb-pg-ghost', onClick: remove },
        h(ui.IconTrashOutlineRegular, { size: 14 }),
        pagesT('pages.tab.delete'))),
    actionError === undefined ? null : h('div', { className: 'dwb-pg-error', role: 'alert' }, actionError),
    blocked.length > 0 && !blockedClosed
      ? h('div', { className: 'dwb-pg-blocked', role: 'alert' },
        h(ui.IconWarningOutlineRegular, { size: 14 }),
        h('span', { className: 'dwb-pg-blockedtext' }, pagesT('pages.tab.blocked', { blocked: blocked[blocked.length - 1] })),
        h('button', { type: 'button', className: 'dwb-pg-ghost', onClick: () => { setBlockedClosed(true) } }, pagesT('pages.tab.blockedClose')))
      : null,
    scripts.active && !scripts.allowed && blobUrl !== undefined && !loadFailed
      ? h('div', { className: 'dwb-pg-scripts', role: 'status' },
        h(ui.IconShieldOutlineRegular, { size: 14 }),
        h('span', { className: 'dwb-pg-blockedtext' }, pagesT('pages.tab.scripts')),
        h('button', { type: 'button', className: 'dwb-pg-ghost', onClick: runScripts }, pagesT('pages.tab.runScripts')))
      : null,
    loadFailed
      ? h('div', { className: 'dwb-pg-frame dwb-pg-frame-empty' }, pagesT('pages.tab.missing'))
      : blobUrl === undefined
        ? h('div', { className: 'dwb-pg-frame dwb-pg-frame-empty' }, pagesT('pages.tab.loading'))
        : h('iframe', {
          // sandbox 只在加载时生效：点了「运行脚本」要换一个预览框重新加载。
          key: `${blobUrl}#${sandbox}`,
          ref: frameRef,
          className: 'dwb-pg-frame',
          src: blobUrl,
          title: page.title ?? page.id,
          sandbox,
        }))
}

/**
 * 标签内容：按地址里的页面和版本显示预览；页面不在列表里（已删除或损坏）时写明。
 * @param {{ useTabInfo: Function }} props 标签组件属性。
 * @returns {unknown} React 节点。
 */
function PagesTabBody({ useTabInfo }) {
  const { tab } = useTabInfo()
  const parsed = parsePagesAddress(tab.contentId)
  const [snapshot, setSnapshot] = useState(pagesStore?.get())
  useEffect(() => {
    setSnapshot(pagesStore.get())
    return pagesStore.subscribe(() => { setSnapshot(pagesStore.get()) })
  }, [])
  const reload = useCallback(() => { void pagesStore.load() }, [])
  if (parsed === undefined) return h('div', { className: 'dwb-pg-state' }, pagesT('pages.tab.missing'))
  const page = snapshot.pages.find(item => item.id === parsed.pageId && item.corrupt !== true)
  if (page === undefined) return h('div', { className: 'dwb-pg-state' }, pagesT('pages.tab.missing'))
  const version = page.versions?.some(item => item.n === parsed.version) ? parsed.version : (pagesLatestVersion(page)?.n ?? parsed.version)
  return h('div', { className: 'dwb-pg-tab' },
    h(PagesPreview, { page, version, onDeleted: reload, onRestored: reload }))
}

/** 侧边栏面板按钮的图标。 */
function PagesPanelIcon({ size }) {
  return h(ui.IconGlobeOutlineRegular, { size })
}

/**
 * 侧边栏「页面」整页：左边列表（搜索、最近更新在前），右边预览；空状态和读取失败各有说法
 * （样稿 C）。面板页里 openResource 会抛错（DSH 的行为），操作都在页面内做。
 * @returns {unknown} React 节点。
 */
function PagesPanelPage() {
  const [snapshot, setSnapshot] = useState(pagesStore?.get() ?? { status: 'loading', pages: [] })
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(undefined)
  useEffect(() => {
    setSnapshot(pagesStore.get())
    return pagesStore.subscribe(() => { setSnapshot(pagesStore.get()) })
  }, [])
  useEffect(() => {
    void pagesStore.load()
  }, [])
  const pages = pagesFilterPages(snapshot.pages.filter(page => page.corrupt !== true), query)
  const selected = pages.find(page => page.id === selectedId) ?? pages[0]
  return h('div', { className: 'dwb-pg-panel', 'data-dsh-workbench-pages-panel': '' },
    h('div', { className: 'dwb-pg-list' },
      h('div', { className: 'dwb-pg-search' },
        h(ui.IconSearchOutlineRegular, { size: 14 }),
        h('input', {
          type: 'text', value: query,
          placeholder: pagesT('pages.panel.search'), 'aria-label': pagesT('pages.panel.search'),
          onChange: (event) => { setQuery(event.target.value) },
        })),
      snapshot.status === 'error'
        ? h('div', { className: 'dwb-pg-empty' },
          h('div', null, pagesT('pages.panel.loadFailed')),
          h('button', { type: 'button', className: 'dwb-pg-linkbtn', onClick: () => { void pagesStore.load() } }, pagesT('pages.panel.retry')))
        : snapshot.status === 'loading'
          ? h('div', { className: 'dwb-pg-empty' }, pagesT('pages.tab.loading'))
          : pages.length === 0
            ? h('div', { className: 'dwb-pg-empty' },
              h('b', null, pagesT('pages.panel.emptyTitle')),
              h('span', null, pagesT('pages.panel.emptyBody')))
            : h('ul', { className: 'dwb-pg-items' }, pages.map(page => {
              const latest = pagesLatestVersion(page)
              return h('li', { key: page.id },
                h('button', {
                  type: 'button', className: 'dwb-pg-item',
                  onContextMenu: event => designPageMenu(event,page,latest?.n),
                  onKeyDown: event => designPageMenu(event,page,latest?.n),
                  'data-selected': selected?.id === page.id || undefined,
                  'aria-current': selected?.id === page.id ? 'true' : undefined,
                  onClick: () => { setSelectedId(page.id) },
                },
                h('span', { className: 'dwb-pg-itemtitle' }, page.title ?? page.id),
                h('span', { className: 'dwb-pg-itemmeta' }, [
                  latest === undefined ? '' : pagesT('pages.panel.versions', { n: latest.n }),
                  latest === undefined ? '' : pagesFormatBytes(latest.size ?? 0),
                  latest === undefined ? '' : pagesFormatTime(latest.createdAt),
                ].filter(text => text !== '').join(' · '))))
            }))),
    selected === undefined
      ? h('div', { className: 'dwb-pg-main dwb-pg-empty' }, snapshot.status === 'ready' ? pagesT('pages.panel.emptyTitle') : null)
      : h('div', { className: 'dwb-pg-main' },
        h(PagesPreview, {
          key: selected.id,
          page: selected,
          version: pagesLatestVersion(selected)?.n ?? 1,
          onDeleted: () => { void pagesStore.load() },
          onRestored: () => { void pagesStore.load() },
        })))
}

/**
 * 对话里的工具行：成功时一行「已发布页面「标题」第 N 版 · 大小 · 内联了什么」加「打开」，
 * 失败整行变红写原因；展开看参数和结果原文（样稿 A、E）。元数据走工具结果的 meta
 * （presentationMeta，核实过：pipeline 把它记进 block.meta）。
 * @param {{ phase: string, block: object, t: Function }} props 工具行属性。
 * @returns {unknown} React 节点。
 */
function PublishRow({ phase, block }) {
  const [expanded, setExpanded] = useState(false)
  if (phase === 'preparing' || block === undefined || !('kind' in block)) {
    return h('div', { 'data-tool': 'publish_page', 'data-state': 'running' },
      h(ui.DisclosureRow, {
        title: pagesT('pages.row.title'),
        icon: h(ui.IconGlobeOutlineRegular, { size: 14 }),
        open: false,
        expandable: false,
        onToggle: () => {},
        running: true,
      }))
  }
  const meta = block.meta !== undefined && typeof block.meta === 'object' ? block.meta : undefined
  const details = (block.content ?? []).map(item => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n')
  const args = block.call?.argsRaw ?? block.argsRaw ?? ''
  if (block.isError) {
    return h('div', { 'data-tool': 'publish_page', 'data-state': 'error' },
      h(ui.DisclosureRow, {
        title: pagesT('pages.row.title'),
        icon: h(ui.IconWarningOutlineRegular, { size: 14 }),
        open: expanded && details !== '',
        expandable: details !== '',
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        onToggle: () => { setExpanded(value => !value) },
        collapsedContent: toolRowSummary(pagesT('pages.row.failed', { reason: details.split('\n')[0] }), { error: true }),
      }, h('pre', { className: 'dwb-pg-raw' }, details)))
  }
  const inline = pagesInlineParams(meta?.assets)
  const summary = [
    meta === undefined ? '' : pagesT('pages.version', { n: meta.n }),
    meta === undefined ? '' : pagesFormatBytes(meta.size ?? 0),
    meta === undefined ? '' : pagesT('pages.inline', inline),
  ].filter(text => text !== '').join(' · ')
  return h('div', { 'data-tool': 'publish_page', 'data-state': 'ok' },
    h(ui.DisclosureRow, {
      title: meta?.title ?? pagesT('pages.row.title'),
      icon: h(ui.IconGlobeOutlineRegular, { size: 14 }),
      open: expanded && (details !== '' || args !== ''),
      expandable: details !== '' || args !== '',
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: () => { setExpanded(value => !value) },
      collapsedContent: toolRowSummary(summary, {
        suffix: meta === undefined ? undefined : h('button', {
          type: 'button', className: 'dwb-pg-openbtn',
          onClick: (event) => {
            event.stopPropagation()
            pagesOpen(meta.id, meta.n)
          },
        }, pagesT('pages.row.open')),
      }),
    }, h('pre', { className: 'dwb-pg-raw' }, [args, details].filter(text => text !== '').join('\n\n'))))
}

/**
 * 文件预览里的「发布为页面」按钮（样稿 D）：只在会话工作区里的 .html/.htm 上出现；
 * 点了 POST publish（走和工具同一份读文件与内联），成功后在右侧栏打开页面标签。
 * @param {{ absolutePath?: string, sessionId?: string }} props 文件预览插槽属性（条目拿 absolutePath）。
 * @returns {unknown} React 节点。
 */
function PublishPageAction({ absolutePath, sessionId }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const cwd = pagesCtx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  const relative = pagesShouldOfferPublish(absolutePath, cwd)
  if (relative === undefined) return null
  const publish = async () => {
    setBusy(true)
    setError(undefined)
    const result = await pagesPost('publish', { sessionId, path: relative })
      .catch(() => ({ ok: false, message: pagesT('pages.networkError') }))
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    void pagesStore.load()
    pagesOpen(result.page.id, result.page.n)
  }
  return h('span', { className: 'dwb-pg-docaction' },
    h('button', {
      type: 'button', className: 'dwb-pg-publishbtn', disabled: busy,
      onClick: publish,
    }, h(ui.IconGlobeOutlineRegular, { size: 14 }), busy ? pagesT('pages.publishing') : pagesT('pages.publish')),
    error === undefined ? null : h('span', { className: 'dwb-pg-docerror', role: 'alert' }, pagesT('pages.publishFailed', { reason: error })))
}

/** 本模块自己的样式。 */
const PAGES_CSS = `
.dwb-pg-tab{height:100%;min-height:0;display:flex;flex-direction:column}
.dwb-pg-preview{height:100%;min-height:0;display:flex;flex-direction:column}
.dwb-pg-tool{flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dwb-pg-version{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dwb-pg-vlabel{font-size:12px}
.dwb-pg-version select{border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;cursor:pointer;max-width:150px}
.dwb-pg-grow{flex:1 1 auto}
.dwb-pg-ghost{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dwb-pg-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwb-pg-ghost:disabled{opacity:.5;cursor:default}
.dwb-pg-error{flex:none;padding:5px 10px;font-size:12px;color:var(--dsw-alias-state-error-primary);border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dwb-pg-blocked{flex:none;display:flex;align-items:center;gap:8px;margin:8px 8px 0;padding:6px 10px;border-radius:8px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dwb-pg-blocked svg{flex:none;color:var(--dsw-alias-state-warn-primary)}
.dwb-pg-blockedtext{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dwb-pg-scripts{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:8px 8px 0;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dwb-pg-scripts svg{flex:none;color:var(--dsw-alias-label-secondary)}
.dwb-pg-scripts .dwb-pg-blockedtext{flex:1 1 200px}
.dwb-pg-scripts .dwb-pg-ghost{flex:none;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l2)}
.dwb-pg-frame{flex:1 1 auto;min-height:0;width:100%;border:none;background:#fff}
body[data-ds-dark-theme] .dwb-pg-frame{background:#fff}
.dwb-pg-frame-empty{display:grid;place-content:center;justify-items:center;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dwb-pg-state{flex:1 1 auto;display:grid;place-content:center;justify-items:center;gap:8px;padding:16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dwb-pg-undo{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-pg-linkbtn{border:none;background:transparent;color:var(--dsw-alias-link);font-size:12px;cursor:pointer;padding:0}
.dwb-pg-linkbtn:hover{text-decoration:underline}
.dwb-pg-panel{height:100%;min-height:0;display:grid;grid-template-columns:minmax(240px,340px) minmax(0,1fr)}
.dwb-pg-list{min-width:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3)}
.dwb-pg-search{flex:none;display:flex;align-items:center;gap:6px;margin:10px 10px 6px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:9px;color:var(--dsw-alias-label-tertiary)}
.dwb-pg-search input{flex:1 1 auto;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dwb-pg-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dwb-pg-items{flex:1 1 auto;min-height:0;overflow-y:auto;margin:0;padding:4px 6px 10px;list-style:none}
.dwb-pg-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:none;border-radius:9px;background:transparent;text-align:left;cursor:pointer}
.dwb-pg-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-pg-item[data-selected]{background:var(--dsw-alias-interactive-bg-active)}
.dwb-pg-itemtitle{font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-pg-itemmeta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-pg-empty{flex:1 1 auto;display:grid;place-content:center;justify-items:center;gap:6px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dwb-pg-empty>b{font-size:14px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dwb-pg-main{min-width:0;min-height:0;display:flex;flex-direction:column}
.dwb-pg-openbtn{flex:none;display:inline-flex;align-items:center;height:24px;padding:0 10px;border:none;border-radius:7px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.dwb-pg-openbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-pg-raw{margin:0;padding:8px 12px;font:var(--dsw-font-markdown-code-block,12px ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);max-height:280px;overflow-y:auto}
.dwb-pg-docaction{display:inline-flex;align-items:center;gap:8px}
.dwb-pg-publishbtn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dwb-pg-publishbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwb-pg-publishbtn:disabled{opacity:.5;cursor:default}
.dwb-pg-docerror{font-size:12px;color:var(--dsw-alias-state-error-primary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

/**
 * 挂载本功能的界面（插件页里这一行开着时调用）。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数：这一行关掉时调用，撤掉本功能注册的全部界面。
 */
export function applyPages(app) {
  const { ctx } = app
  pagesCtx = ctx
  pagesT = app.t
  pagesStore = pagesStore ?? createPagesClientStore()
  const disposers = [mountModuleStyle('dsh-workbench-pages', PAGES_CSS)]
  const keep = (dispose) => { disposers.push(dispose) }

  keep(ctx.effect(() => ctx.resources.register({
    protocol: PAGES_PROTOCOL,
    // 页面不需要 retain 会话：资源给一帧 { address }，标签按地址自己拉内容。
    async *open(address, { signal }) {
      if (parsePagesAddress(address) === undefined) throw new Error(`dsh-workbench/pages: 地址不对 ${address}`)
      if (signal.aborted) return
      yield { ok: true, value: { address } }
      await pagesWaitForAbort(signal)
    },
  }), '@miint-sunny/dsh-workbench/pages: resources'))

  keep(ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PAGES_TAB_ID,
    kind: PAGES_PROTOCOL,
    patterns: [PAGES_ADDRESS_PREFIX + '**'],
    priority: 'extension',
    multiple: true,
    keepMounted: true,
    canOpen: (address) => parsePagesAddress(address) !== undefined,
    title: (address) => {
      const parsed = parsePagesAddress(address)
      const entry = parsed === undefined ? undefined : pagesStore.get().pages.find(page => page.id === parsed.pageId)
      return entry?.title ?? pagesT('pages.tab.fallback')
    },
  }), '@miint-sunny/dsh-workbench/pages: tab type'))

  keep(ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PAGES_TAB_ID,
    locale: '@miint-sunny/dsh-workbench',
  }, PagesTabBody)), '@miint-sunny/dsh-workbench/pages: tab body'))

  keep(ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PAGES_PANEL_ID,
    order: 21,
    locale: '@miint-sunny/dsh-workbench',
    label: () => pagesT('pages.panel'),
  }, PagesPanelIcon)), '@miint-sunny/dsh-workbench/pages: panel button'))

  keep(ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PAGES_PANEL_ID,
    locale: '@miint-sunny/dsh-workbench',
  }, PagesPanelPage)), '@miint-sunny/dsh-workbench/pages: panel page'))

  keep(ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'publish_page',
    locale: '@miint-sunny/dsh-workbench',
  }, PublishRow)), '@miint-sunny/dsh-workbench/pages: tool row'))

  keep(ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions',
    id: 'dsh-workbench-pages',
    locale: '@miint-sunny/dsh-workbench',
  }, PublishPageAction)), '@miint-sunny/dsh-workbench/pages: document action'))

  void pagesStore.load()

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    pagesCtx = undefined
    pagesT = undefined
  }
}

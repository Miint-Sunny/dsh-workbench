/**
 * 浏览器视口尺寸（dsh-workbench/browser-viewport）：官方浏览器卡片（右侧栏的「浏览器」）工具栏里的「视口尺寸」按钮。
 * 点开选：自动、手机、平板、桌面、自定义，另有竖向、横向；选了固定尺寸后，网页框（桌面端 webview，网页端 iframe）
 * 按这个宽高排版，再缩放进卡片，工具栏下面多一行写着尺寸和缩放比例。每张卡片各记各的。
 *
 * 官方工具栏没有给插件留位置，按钮和状态行是往它的 DOM 里插的节点：MutationObserver 盯着整页，官方重新渲染把节点弄丢时补回，
 * 已经在就不再插。网页端换标签会卸掉卡片的 DOM、回来是新的，所以状态按右侧栏的 occurrence（标签存活期间不变的 id）记，
 * 不按 DOM 节点记。官方的类名带构建哈希前缀（形如 k_IHJa_toolbar），按「_类名」匹配；结构对不上时什么也不做，卡片保持官方的样子。
 * 尺寸怎么算、怎么缩放见 browser-viewport-model.js。
 */
import { mountModuleStyle } from './style.js'
import { BROWSER_VIEWPORT_AUTO, BROWSER_VIEWPORT_CONTAINER_KEYS, BROWSER_VIEWPORT_FRAME_KEYS, BROWSER_VIEWPORT_MAX, BROWSER_VIEWPORT_MIN, browserViewportContainerStyle, browserViewportCustom, browserViewportFit, browserViewportFrameStyle, browserViewportMenuItems, browserViewportOrient, browserViewportOrientation, browserViewportPercent, browserViewportPreset } from './browser-viewport-model.js'

/** 这一行不要 DSH 的别的服务：界面挂在壳层的 shell.overlay 槽位里。 */
export const BROWSER_VIEWPORT_INJECT = []

export const BROWSER_VIEWPORT_ZH = {
  'browserViewport.button': '视口尺寸',
  'browserViewport.auto': '自动',
  'browserViewport.autoHint': '卡片大小',
  'browserViewport.phone': '手机',
  'browserViewport.tablet': '平板',
  'browserViewport.desktop': '桌面',
  'browserViewport.custom': '自定义…',
  'browserViewport.size': '{width} × {height}',
  'browserViewport.orientation': '方向',
  'browserViewport.portrait': '竖向',
  'browserViewport.landscape': '横向',
  'browserViewport.width': '宽',
  'browserViewport.widthName': '宽度',
  'browserViewport.height': '高',
  'browserViewport.heightName': '高度',
  'browserViewport.apply': '应用',
  'browserViewport.status': '视口 {width} × {height}，缩放 {percent}%',
  'browserViewport.error.width.range': '宽度需在 {min} 到 {max} 之间',
  'browserViewport.error.height.range': '高度需在 {min} 到 {max} 之间',
  'browserViewport.error.width.integer': '宽度需为整数',
  'browserViewport.error.height.integer': '高度需为整数',
}

export const BROWSER_VIEWPORT_EN = {
  'browserViewport.button': 'Viewport size',
  'browserViewport.auto': 'Automatic',
  'browserViewport.autoHint': 'Tab size',
  'browserViewport.phone': 'Phone',
  'browserViewport.tablet': 'Tablet',
  'browserViewport.desktop': 'Desktop',
  'browserViewport.custom': 'Custom…',
  'browserViewport.size': '{width} × {height}',
  'browserViewport.orientation': 'Orientation',
  'browserViewport.portrait': 'Portrait',
  'browserViewport.landscape': 'Landscape',
  'browserViewport.width': 'W',
  'browserViewport.widthName': 'Width',
  'browserViewport.height': 'H',
  'browserViewport.heightName': 'Height',
  'browserViewport.apply': 'Apply',
  'browserViewport.status': 'Viewport {width} × {height}, zoom {percent}%',
  'browserViewport.error.width.range': 'Width must be {min} to {max}',
  'browserViewport.error.height.range': 'Height must be {min} to {max}',
  'browserViewport.error.width.integer': 'Width must be a whole number',
  'browserViewport.error.height.integer': 'Height must be a whole number',
}

/**
 * 样式。颜色和圆角都用 DSH 的变量；面板的层级和 DSH 自己的菜单一样（1100）。面板盖在任意网页上，所以背景不透明（样稿的 raised，
 * 即 --dsw-alias-bg-layer-2），不用 DSH 菜单那种磨砂半透明：背后是浅色网页时，半透明会让整块发灰、次要文字看不清。按钮的尺寸、颜色照官方 `.tool`（28 像素、圆角 sm），同时借用官方按钮的类名，
 * 这里的 `:where()` 只是借不到类名时的后备；状态行照样稿：12 像素、次要色、底边一条细线。
 */
export const BROWSER_VIEWPORT_CSS = `
[data-dwb-bv=host],[data-dwb-bv=status]{display:contents}
:where(.dwb-bv-btn){display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
:where(.dwb-bv-btn):hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dwb-bv-btn[data-active]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}
.dwb-bv-btn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dwb-bv-icon{display:block;flex:none}
.dwb-bv-status{flex:0 0 auto;box-sizing:border-box;padding:5px 10px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l3)}
[data-dwb-bv=fixed]{background:repeating-linear-gradient(45deg,transparent 0 6px,color-mix(in srgb,var(--dsw-alias-border-l2) 35%,transparent) 6px 7px)}
[data-dwb-bv=fixed]>[data-sidebar-browser-frame]{box-shadow:0 0 0 calc(1px / var(--dwb-bv-scale,1)) var(--dsw-alias-border-l2)}
.dwb-bv-menu{position:fixed;z-index:1100;box-sizing:border-box;display:grid;gap:2px;width:236px;max-width:calc(100vw - 16px);overflow:auto;padding:4px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-panel),0 8px 24px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dwb-bv-list{display:grid;gap:2px}
.dwb-bv-item{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:30px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dwb-bv-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-bv-item[aria-checked=true]{background:var(--dsw-alias-interactive-bg-active)}
.dwb-bv-item:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dwb-bv-item>svg{flex:none}
.dwb-bv-size{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.dwb-bv-check{flex:none;width:16px;height:16px;margin-left:4px}
.dwb-bv-sep{height:0;margin:4px 0;border-top:.5px solid var(--dsw-alias-border-l3)}
.dwb-bv-label{padding:4px 8px 2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dwb-bv-seg{display:flex;margin:0 8px 6px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dwb-bv-seg button{flex:1;height:26px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dwb-bv-seg button[data-on]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dwb-bv-seg button:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dwb-bv-seg button:disabled{opacity:.55;cursor:default}
.dwb-bv-custom{display:grid;gap:6px;padding:4px 8px 8px}
.dwb-bv-fields{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dwb-bv-fields label{display:flex;align-items:center;gap:4px}
.dwb-bv-input{box-sizing:border-box;width:56px;height:26px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-variant-numeric:tabular-nums}
.dwb-bv-input:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dwb-bv-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dwb-bv-input[aria-invalid=true]:focus{outline-color:var(--dsw-alias-state-error-primary)}
.dwb-bv-apply{flex:none;white-space:nowrap}
.dwb-bv-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
`

// ---------- 控制器（状态、缩放比例、通知界面；DOM 的部分由适配器负责） ----------

/**
 * 控制器：记每张卡片的尺寸状态，卡片大小变了就重新算缩放，把样式交给适配器套上或还原，通知界面刷新。
 * 适配器（见 browserViewportDom）管 DOM：`findCards()` 给出页面上现有的每张官方工具栏，每张是一个「卡片柄」：
 * `key`（跨重新挂载不变的卡片键）、`toolClass`、`ensure()`（把注入的节点插进去，已在就不动，返回 `{ host, statusHost }`）、
 * `size()`（网页框所在容器的大小）、`apply(layout | undefined)`（套上或还原）、`watch(callback)`（容器大小变了、
 * 网页框被换掉时回调；返回停止函数）、`release()`（移除注入的节点并还原）。
 * @param {{ findCards: () => object[] }} adapter DOM 适配器。
 * @returns {{ scan: () => void, setState: (key: string, state: object) => void, subscribe: (listener: () => void) => () => void, getSnapshot: () => { cards: object[] }, dispose: () => void }} 控制器。
 */
export function createBrowserViewportController(adapter) {
  /** 卡片键 → 尺寸状态。只存固定尺寸的，自动不占位。卡片的 DOM 被卸掉再回来时凭它找回。 */
  const states = new Map()
  /** 卡片柄 → 现在页面上这张卡片的记录。 */
  const tracked = new Map()
  const listeners = new Set()
  let snapshot = { cards: [] }
  let serial = 0
  let disposed = false

  const publish = () => {
    snapshot = {
      cards: [...tracked.values()].map(card => ({
        id: card.id, key: card.key, host: card.host, statusHost: card.statusHost, toolClass: card.toolClass, state: card.state, scale: card.scale,
      })),
    }
    for (const listener of [...listeners]) listener()
  }

  /** 按现在的状态和卡片大小套样式。返回缩放比例有没有变（要不要通知界面）。 */
  const relayout = (card) => {
    if (card.state.preset === 'auto') {
      if (card.applied) {
        card.handle.apply(undefined)
        card.applied = false
      }
      const changed = card.scale !== undefined
      card.scale = undefined
      return changed
    }
    const scale = browserViewportFit(card.state, card.handle.size())
    // 卡片暂时没有大小（藏着、还没排版）：保持现状，不套 0，也不还原成自动。
    if (scale === undefined) return false
    card.handle.apply({ scale, frame: browserViewportFrameStyle(card.state, scale), container: browserViewportContainerStyle() })
    card.applied = true
    const changed = scale !== card.scale
    card.scale = scale
    return changed
  }

  const scan = () => {
    if (disposed) return
    const found = adapter.findCards()
    const alive = new Set(found)
    let changed = false
    for (const handle of found) {
      const parts = handle.ensure()
      const existing = tracked.get(handle)
      if (existing === undefined) {
        const card = {
          id: `card${++serial}`, handle, key: handle.key, host: parts.host, statusHost: parts.statusHost, toolClass: handle.toolClass,
          state: states.get(handle.key) ?? BROWSER_VIEWPORT_AUTO, scale: undefined, applied: false, stop: undefined,
        }
        tracked.set(handle, card)
        card.stop = handle.watch(() => { if (relayout(card)) publish() })
        relayout(card)
        changed = true
      } else if (existing.host !== parts.host || existing.statusHost !== parts.statusHost) {
        existing.host = parts.host
        existing.statusHost = parts.statusHost
        changed = true
      }
    }
    for (const [handle, card] of [...tracked]) {
      if (alive.has(handle)) continue
      card.stop?.()
      handle.release()
      tracked.delete(handle)
      changed = true
    }
    if (changed) publish()
  }

  return {
    scan,
    /** 改一张卡片的尺寸（按卡片键）；自动就是不再记。 */
    setState(key, state) {
      if (disposed) return
      if (state.preset === 'auto') states.delete(key)
      else states.set(key, state)
      for (const card of tracked.values()) {
        if (card.key !== key) continue
        card.state = state
        relayout(card)
      }
      publish()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    dispose() {
      disposed = true
      for (const [handle, card] of tracked) {
        card.stop?.()
        handle.release()
      }
      tracked.clear()
      states.clear()
      snapshot = { cards: [] }
      // 还在渲染的界面要看到「没有卡片了」；之后不再通知。
      const pending = [...listeners]
      listeners.clear()
      for (const listener of pending) listener()
    },
  }
}

// ---------- DOM 适配器（官方浏览器卡片的结构） ----------

/** 官方工具栏：BrowserBody 的 `<form class={css.toolbar}>`。 */
const BROWSER_VIEWPORT_TOOLBAR = 'form[class*="_toolbar"]'
/** 工具栏里的地址栏容器；新按钮插在它后面（「在系统浏览器中打开」前面）。 */
const BROWSER_VIEWPORT_ADDRESS = ':scope > [class*="_addressBox"]'
/** 网页框所在的容器：工具栏的上一层里的 content > viewport。 */
const BROWSER_VIEWPORT_CONTAINER = ':scope > [class*="_content"] > [class*="_viewport"]'
/** 网页框：桌面端是 webview，网页端是 iframe，官方都标了这个属性。 */
const BROWSER_VIEWPORT_FRAME = ':scope > [data-sidebar-browser-frame]'
/** 右侧栏给每个标签画的外层：标签 id 和 occurrence（标签存活期间不变，跨会话不重）。 */
const BROWSER_VIEWPORT_OCCURRENCE = '[data-sidebar-right-occurrence]'

/** 一个工具栏里要用的三处：地址栏容器、整张卡片、网页框的容器；结构对不上时 undefined。 */
function browserViewportParts(form) {
  const addressBox = form.querySelector(BROWSER_VIEWPORT_ADDRESS)
  const root = form.parentElement
  const viewport = root?.querySelector(BROWSER_VIEWPORT_CONTAINER)
  if (addressBox === null || viewport === null || viewport === undefined) return undefined
  return { addressBox, root, viewport }
}

/**
 * 给一个官方工具栏做卡片柄（接口见 createBrowserViewportController）。
 * @param {Document} doc 页面。
 * @param {HTMLFormElement} form 官方工具栏。
 * @param {string} key 卡片键。
 * @returns {object} 卡片柄。
 */
function createBrowserViewportHandle(doc, form, key) {
  /** 元素 → 套样式之前它自己的行内值。还原时写回去，不动官方原有的行内样式。 */
  const saved = new WeakMap()
  let host
  let statusHost
  const write = (element, style, keys) => {
    let map = saved.get(element)
    if (map === undefined) {
      map = new Map()
      saved.set(element, map)
    }
    for (const name of keys) {
      if (!map.has(name)) map.set(name, element.style[name])
      element.style[name] = style[name]
    }
  }
  const restore = (element, keys) => {
    const map = saved.get(element)
    if (map === undefined) return
    for (const name of keys) {
      if (!map.has(name)) continue
      element.style[name] = map.get(name)
      map.delete(name)
    }
  }
  /** 最近一次套上样式的网页框容器。还原时直接用它，不再按结构去找：官方结构对不上时也能还原干净。 */
  let styled
  const restoreAll = () => {
    const viewport = styled ?? browserViewportParts(form)?.viewport
    if (viewport === undefined) return
    const frame = viewport.querySelector(BROWSER_VIEWPORT_FRAME)
    if (frame !== null) restore(frame, BROWSER_VIEWPORT_FRAME_KEYS)
    restore(viewport, BROWSER_VIEWPORT_CONTAINER_KEYS)
    viewport.style.removeProperty('--dwb-bv-scale')
    delete viewport.dataset.dwbBv
    styled = undefined
  }
  const apply = (layout) => {
    if (layout === undefined) {
      restoreAll()
      return
    }
    const parts = browserViewportParts(form)
    if (parts === undefined) return
    const frame = parts.viewport.querySelector(BROWSER_VIEWPORT_FRAME)
    write(parts.viewport, layout.container, BROWSER_VIEWPORT_CONTAINER_KEYS)
    parts.viewport.dataset.dwbBv = 'fixed'
    parts.viewport.style.setProperty('--dwb-bv-scale', String(Number(layout.scale.toFixed(6))))
    if (frame !== null) write(frame, layout.frame, BROWSER_VIEWPORT_FRAME_KEYS)
    styled = parts.viewport
  }
  return {
    key,
    get toolClass() { return form.querySelector(':scope > button[type="button"]')?.className ?? '' },
    ensure() {
      const parts = browserViewportParts(form)
      host ??= doc.createElement('span')
      statusHost ??= doc.createElement('div')
      host.dataset.dwbBv = 'host'
      statusHost.dataset.dwbBv = 'status'
      if (parts !== undefined) {
        if (host.parentElement !== form || host.previousElementSibling !== parts.addressBox) parts.addressBox.after(host)
        if (statusHost.parentElement !== form.parentElement || statusHost.previousElementSibling !== form) form.after(statusHost)
      }
      return { host, statusHost }
    },
    size() {
      const viewport = browserViewportParts(form)?.viewport
      return { width: viewport?.clientWidth ?? 0, height: viewport?.clientHeight ?? 0 }
    },
    apply,
    watch(callback) {
      const viewport = browserViewportParts(form)?.viewport
      if (viewport === undefined) return () => {}
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { callback() }) : undefined
      resize?.observe(viewport)
      // 官方换网页框（重新创建 webview、iframe 重新挂载）时，新的框要重新套上。
      const mutation = new MutationObserver(() => { callback() })
      mutation.observe(viewport, { childList: true })
      return () => {
        resize?.disconnect()
        mutation.disconnect()
      }
    },
    release() {
      restoreAll()
      host?.remove()
      statusHost?.remove()
      host = undefined
      statusHost = undefined
    },
  }
}

/**
 * 真实页面的适配器：找页面上的官方工具栏，每个工具栏配一个卡片柄（同一个工具栏始终是同一个柄）。
 * @param {Document} [doc] 页面。
 * @returns {{ findCards: () => object[] }} 适配器。
 */
export function browserViewportDom(doc = globalThis.document) {
  /** 官方工具栏 → 卡片柄。工具栏被卸掉后从这里丢掉。 */
  const handles = new Map()
  /** 没有 occurrence 时的后备：给没有 id 的网页框容器编个号。 */
  const anonymous = new WeakMap()
  let counter = 0
  return {
    findCards() {
      const found = []
      for (const form of doc.querySelectorAll(BROWSER_VIEWPORT_TOOLBAR)) {
        const parts = browserViewportParts(form)
        if (parts === undefined) continue
        let handle = handles.get(form)
        if (handle === undefined) {
          const occurrence = form.closest(BROWSER_VIEWPORT_OCCURRENCE)?.dataset.sidebarRightOccurrence
          if (!anonymous.has(parts.viewport)) anonymous.set(parts.viewport, ++counter)
          const key = occurrence ? `occurrence:${occurrence}` : `viewport:${parts.viewport.id || anonymous.get(parts.viewport)}`
          handle = createBrowserViewportHandle(doc, form, key)
          handles.set(form, handle)
        }
        found.push(handle)
      }
      const present = new Set(found)
      for (const [form, handle] of [...handles]) if (!present.has(handle)) handles.delete(form)
      return found
    },
  }
}

// ---------- 界面 ----------

/**
 * 菜单放在按钮下方、右边和按钮对齐；贴着窗口边时挪进来，太低时限制高度（里面滚动）。
 * @param {{ left: number, right: number, top: number, bottom: number }} anchor 按钮的矩形。
 * @param {{ width: number, height: number }} view 窗口大小。
 * @param {number} [width] 菜单宽度。
 * @returns {{ left: number, top: number, maxHeight: number }} 摆放。
 */
export function browserViewportMenuPlace(anchor, view, width = 236) {
  const gap = 4
  const margin = 8
  const left = Math.max(margin, Math.min(anchor.right - width, view.width - width - margin))
  const top = anchor.bottom + gap
  return { left, top, maxHeight: Math.max(120, view.height - top - margin) }
}

/** 面板现在该放的位置；没有按钮或没有窗口时 undefined。 */
function browserViewportPlaceNow(anchor) {
  const rect = anchor?.getBoundingClientRect?.()
  if (rect === undefined || typeof window === 'undefined') return undefined
  return browserViewportMenuPlace(rect, { width: window.innerWidth ?? 1000, height: window.innerHeight ?? 800 })
}

/**
 * 手机、平板、桌面的图标。DSH 的组件库里没有对应的图标，照它的画法自己画：16 格、1 像素线、圆角连接、跟随文字色。
 * @param {{ kind: 'phone' | 'tablet' | 'desktop' }} props 画哪一个。
 * @returns {object} 图标元素。
 */
function BrowserViewportIcon({ kind }) {
  // dsh-ui-guard: DSH 没有手机、平板、显示器的图标
  return h('svg', { className: 'dwb-bv-icon', viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
    kind === 'desktop'
      ? [h('rect', { key: 'a', x: 1.5, y: 2.5, width: 13, height: 9, rx: 1 }), h('path', { key: 'b', d: 'M8 11.5v2.5M5 14.5h6' })]
      : [h('rect', { key: 'a', x: kind === 'tablet' ? 2.5 : 4.5, y: 1.5, width: kind === 'tablet' ? 11 : 7, height: 13, rx: 1.5 }), h('path', { key: 'b', d: 'M7 12.5h2' })])
}

/** 菜单里每一项左边的图标：自动和自定义用 DSH 的，手机、平板、桌面用自画的。 */
function browserViewportRowIcon(id) {
  if (id === 'auto') return h(ui.IconFullscreenOutlineRegular, { size: 16 })
  if (id === 'custom') return h(ui.IconEditOutlineRegular, { size: 16 })
  return h(BrowserViewportIcon, { kind: id })
}

/**
 * 点开按钮出来的面板：尺寸预设、自定义的宽高、方向。点外面、按 Esc、点进网页、焦点移到别处都会关。
 * @param {object} props anchor 是按钮元素，state 是这张卡片的尺寸；onPick、onOrient、onApply、onClose 由按钮那边接。
 * @returns {object} 面板元素。
 */
function BrowserViewportMenu({ anchor, state, t, onPick, onOrient, onApply, onClose }) {
  const root = useRef(null)
  const widthInput = useRef(null)
  const heightInput = useRef(null)
  const focusInput = useRef(false)
  const fixed = state.preset !== 'auto'
  const orientation = browserViewportOrientation(state)
  const labelId = React.useId()
  const [customOpen, setCustomOpen] = useState(state.preset === 'custom')
  const [draft, setDraft] = useState(() => ({ width: String(fixed ? state.width : 1280), height: String(fixed ? state.height : 800) }))
  const [errors, setErrors] = useState({})
  const [place, setPlace] = useState(() => browserViewportPlaceNow(anchor))

  // 摆放：窗口缩放、页面滚动时重摆。
  useEffect(() => {
    const measure = () => {
      const next = browserViewportPlaceNow(anchor)
      setPlace(previous => (previous !== undefined && next !== undefined && previous.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight ? previous : next))
    }
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, true)
    }
  }, [anchor])

  // 关：点外面（按钮自己除外，它自己会切换）、Esc、焦点移到面板外、窗口失去焦点（点进 iframe 或 webview 里的网页）。
  useEffect(() => {
    const inside = target => root.current?.contains?.(target) === true || anchor?.contains?.(target) === true
    const pressedAway = (event) => { if (!inside(event.target)) onClose(false) }
    const focusedAway = (event) => { if (!inside(event.target)) onClose(false) }
    const windowBlurred = () => { onClose(false) }
    const key = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault?.()
        onClose(true)
        return
      }
      const active = document.activeElement
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || active?.dataset?.dwbBvItem === undefined) return
      const list = [...(root.current?.querySelectorAll?.('[data-dwb-bv-item]') ?? [])]
      if (list.length === 0) return
      event.preventDefault()
      const at = list.indexOf(active)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
      list[next]?.focus?.()
    }
    document.addEventListener('pointerdown', pressedAway, true)
    document.addEventListener('focusin', focusedAway, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', windowBlurred)
    return () => {
      document.removeEventListener('pointerdown', pressedAway, true)
      document.removeEventListener('focusin', focusedAway, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', windowBlurred)
    }
  }, [anchor, onClose])

  // 打开时把焦点放到选中的那一项。
  useEffect(() => {
    const checked = root.current?.querySelector?.('[data-dwb-bv-item][aria-checked="true"]') ?? root.current?.querySelector?.('[data-dwb-bv-item]')
    checked?.focus?.()
  }, [])
  // 点了「自定义…」才把焦点交给宽的输入框。
  useEffect(() => {
    if (customOpen && focusInput.current) widthInput.current?.focus?.()
    focusInput.current = false
  }, [customOpen])
  // 自定义尺寸被横竖对调等改了：输入框跟着，错误提示清掉。
  useEffect(() => {
    if (state.preset === 'custom') setDraft({ width: String(state.width), height: String(state.height) })
    setErrors({})
  }, [state])

  const submit = () => {
    const failed = onApply(draft.width, draft.height)
    if (failed === undefined) return
    setErrors(failed)
    const first = failed.width === undefined ? heightInput : widthInput
    first.current?.focus?.()
  }
  const checkedId = customOpen ? 'custom' : browserViewportMenuItems(state).find(item => item.checked)?.id
  const row = (item) => {
    const checked = item.id === checkedId
    const label = t(`browserViewport.${item.id}`)
    const hint = item.id === 'auto' ? t('browserViewport.autoHint') : item.width === undefined ? undefined : t('browserViewport.size', { width: String(item.width), height: String(item.height) })
    return h('button', {
      key: item.id, type: 'button', role: 'radio', className: 'dwb-bv-item', 'data-dwb-bv-item': item.id, 'aria-checked': checked,
      onClick: () => {
        if (item.id === 'custom') {
          focusInput.current = !customOpen
          setCustomOpen(true)
        } else {
          onPick(item.id)
        }
      },
    },
    browserViewportRowIcon(item.id),
    h('span', null, label),
    hint === undefined ? null : h('span', { className: 'dwb-bv-size' }, hint),
    checked ? h(ui.IconCheckOutlineRegular, { size: 16, className: 'dwb-bv-check' }) : h('span', { className: 'dwb-bv-check', 'aria-hidden': true }))
  }
  const field = (name, input) => h('label', { key: name },
    h('span', { 'aria-hidden': true }, t(`browserViewport.${name}`)),
    h('input', {
      ref: input, type: 'text', inputMode: 'numeric', autoComplete: 'off', spellCheck: false, className: 'dwb-bv-input', value: draft[name],
      'aria-label': t(`browserViewport.${name}Name`), 'aria-invalid': errors[name] === undefined ? undefined : true,
      onChange: (event) => {
        setDraft(previous => ({ ...previous, [name]: event.target.value }))
        setErrors(previous => { const { [name]: _removed, ...rest } = previous; return rest })
      },
      onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } },
    }))
  const range = { min: String(BROWSER_VIEWPORT_MIN), max: String(BROWSER_VIEWPORT_MAX) }
  return h('div', {
    ref: root, className: 'dwb-bv-menu', role: 'dialog', 'aria-label': t('browserViewport.button'),
    style: place === undefined ? undefined : { left: place.left, top: place.top, maxHeight: place.maxHeight },
  },
  h('div', { className: 'dwb-bv-list', role: 'radiogroup', 'aria-label': t('browserViewport.button') }, browserViewportMenuItems(state).map(row)),
  customOpen ? h('div', { className: 'dwb-bv-custom', role: 'group', 'aria-label': t('browserViewport.custom') },
    h('div', { className: 'dwb-bv-fields' }, field('width', widthInput), field('height', heightInput),
      h(ui.Button, { variant: 'outline', size: 'sm', className: 'dwb-bv-apply', onClick: submit }, t('browserViewport.apply'))),
    ['width', 'height'].filter(name => errors[name] !== undefined).map(name => h('div', { key: name, className: 'dwb-bv-error', role: 'alert' }, t(`browserViewport.error.${name}.${errors[name]}`, range)))) : null,
  h('div', { className: 'dwb-bv-sep', role: 'separator' }),
  h('div', { className: 'dwb-bv-label', id: labelId }, t('browserViewport.orientation')),
  h('div', { className: 'dwb-bv-seg', role: 'radiogroup', 'aria-labelledby': labelId, 'aria-disabled': orientation === undefined ? true : undefined },
    ['portrait', 'landscape'].map(kind => h('button', {
      key: kind, type: 'button', role: 'radio', 'aria-checked': orientation === kind, 'data-on': (orientation ?? 'portrait') === kind ? '' : undefined,
      disabled: orientation === undefined, onClick: () => { onOrient(kind) },
    }, t(`browserViewport.${kind}`)))))
}

/**
 * 工具栏里的「视口尺寸」按钮和它的面板。固定尺寸时、面板开着时按钮是按下的样子。
 * @param {object} props card 是这张卡片的记录，controller 是控制器。
 * @returns {object} 按钮（和开着的面板）。
 */
function BrowserViewportControl({ card, controller, t }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  const label = t('browserViewport.button')
  const close = useCallback((restoreFocus) => {
    setOpen(false)
    if (restoreFocus) anchor.current?.focus?.()
  }, [])
  const set = (state) => { controller.setState(card.key, state) }
  return h(Fragment, null,
    h('button', {
      ref: anchor, type: 'button', className: `${card.toolClass} dwb-bv-btn`.trim(), 'aria-label': label, title: label,
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'data-active': open || card.state.preset !== 'auto' ? '' : undefined,
      onClick: () => { setOpen(value => !value) },
    }, h(BrowserViewportIcon, { kind: 'phone' })),
    open && typeof document !== 'undefined'
      ? ReactDOM.createPortal(h(BrowserViewportMenu, {
        anchor: anchor.current, state: card.state, t, onClose: close,
        onPick: (id) => { set(browserViewportPreset(id)); close(true) },
        onOrient: (orientation) => { set(browserViewportOrient(card.state, orientation)) },
        onApply: (widthText, heightText) => {
          const result = browserViewportCustom(widthText, heightText)
          if (!result.ok) return result.errors
          set(result.state)
          close(true)
          return undefined
        },
      }), document.body)
      : null)
}

/** 工具栏下面一行：「视口 375 × 812，缩放 54%」。 */
function BrowserViewportStatus({ card, t }) {
  return h('div', { className: 'dwb-bv-status', role: 'status' },
    t('browserViewport.status', { width: String(card.state.width), height: String(card.state.height), percent: String(browserViewportPercent(card.scale)) }))
}

/** 一张卡片的界面：按钮渲进注入的宿主节点，固定尺寸时状态行渲进状态行的宿主节点。 */
function BrowserViewportCard({ card, controller, t }) {
  return h(Fragment, null,
    ReactDOM.createPortal(h(BrowserViewportControl, { card, controller, t }), card.host),
    card.state.preset === 'auto' || card.scale === undefined ? null : ReactDOM.createPortal(h(BrowserViewportStatus, { card, t }), card.statusHost))
}

/** 壳层里渲染一次的宿主：跟着控制器的快照，给每张卡片渲染界面。 */
function BrowserViewportHost({ controller, app }) {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return h(Fragment, null, snapshot.cards.map(card => h(BrowserViewportCard, { key: card.id, card, controller, t: app.t })))
}

// ---------- 挂载 ----------

/**
 * 挂这一行的界面：样式、整页的变化监听、壳层插槽里的宿主；返回撤销函数（关掉这一行时调用：
 * 每张卡片还原成官方的样子，注入的节点和监听全部收回）。
 * @param {{ ctx: object, t: (key: string, params?: object) => string }} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
export function applyBrowserViewport(app) {
  const { ctx } = app
  const removeStyle = mountModuleStyle('dsh-workbench-browser-viewport', BROWSER_VIEWPORT_CSS)
  const controller = createBrowserViewportController(browserViewportDom(document))
  // 官方重新渲染、网页端换标签都会增删节点：同步扫一遍，补回丢掉的、给新出现的工具栏插上，赶在绘制之前。
  const observer = new MutationObserver(() => { controller.scan() })
  observer.observe(document.body, { childList: true, subtree: true })
  controller.scan()
  const disposeHost = ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-workbench-browser-viewport' }, () => h(BrowserViewportHost, { controller, app }))),
    '@miint-sunny/dsh-workbench/browser-viewport: host',
  )
  return () => {
    disposeHost?.()
    observer.disconnect()
    controller.dispose()
    removeStyle()
  }
}

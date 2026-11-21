/**
 * 轮次导航（dsh-workbench/turn-nav）的纯逻辑：选中 DSH 轮次导航的选择器、窄栏门槛、加载时和打开对话时的自查、
 * 这一行生没生效的状态。不碰 DOM，测试直接 import；读 DOM 的部分在 turn-nav.js。
 *
 * DSH 0.2.2-rc.2 对话页（dsh-client-ui-chat 的 ChatView，结构和样式表与 rc.1 相同）的结构：对话视图最外层的第一个子元素是轮次导航的槽
 * （宽度容器，左右各留 `--dsh-composer-side-clearance` 加 16），槽里是 `nav[aria-label]`；第二个子元素往下两层是
 * `[data-chat-flow]` 对话流。槽内宽不到 900 时 DSH 用容器查询把 nav 藏起来，所以主区域宽过 964 才出。
 */

/** 主区域的插槽；右侧栏里的对话不在里面。 */
const TURN_NAV_MAIN = '[data-slot="main.conversation"]'

/** 对话视图里 DSH 的轮次导航：对话流（`data-chat-flow`）往上三层那个元素的第一个子元素里的 nav。 */
const TURN_NAV_RAIL = ':has(> * > * > [data-chat-flow]) > :first-child > nav[aria-label]'

/**
 * 主区域（`main.conversation` 插槽）对话页里 DSH 的轮次导航。右侧栏里的对话不在这个插槽里，选不中。
 * 只靠插槽名、`data-chat-flow` 和层级，不靠带哈希的类名。
 */
export const TURN_NAV_SELECTOR = `${TURN_NAV_MAIN} ${TURN_NAV_RAIL}`

/**
 * 槽内宽到这个值就显示轮次导航（像素）：主区域 380，减去槽左右各 32 的留白和 DSH 对话区 5 像素的滚动条。
 * 0.2.2-rc.1 实测（rc.2 的轮次导航样式表与它相同）：主区域 422 时槽内宽 353，998 时 929。
 */
export const TURN_NAV_MIN_CONTAINER = 311

/** DSH 轮次导航样式表的 data-plugin-css（dsh-client-ui-chat 加载时插进 head）。 */
export const TURN_NAV_DSH_STYLE = '@deepseek-ai/dsh-client-ui-chat/TurnNavigator.module.css'

/**
 * 加载时查 DSH 的轮次导航样式：这一行的样式要靠槽是宽度容器、窄了用容器查询藏起来这两点，任一处变了就对不上。
 * @param {string | null | undefined} cssText DSH 轮次导航样式表的文字；样式表不在时 null。
 * @returns {boolean} 对得上时 true。
 */
export function turnNavStyleMatches(cssText) {
  if (typeof cssText !== 'string') return false
  const compact = cssText.replace(/\s+/g, '')
  return compact.includes('container-type:inline-size') && /@container\([^)]*\)\{[^{}]*\{[^}]*display:none/.test(compact)
}

/** DSH 写在预览卡片行内样式上的变量：指着的那根刻度的中心，从轨道上边量起（像素，已减去轨道的滚动）。 */
export const TURN_NAV_PREVIEW_CENTER = '--turn-preview-center'

/**
 * 加载时查 DSH 预览卡片的定位：卡片的上边还按 TURN_NAV_PREVIEW_CENTER 算时，这一行才改卡片的定位，对不上就照 DSH 原来的。
 * @param {string | null | undefined} cssText DSH 轮次导航样式表的文字；样式表不在时 null。
 * @returns {boolean} 对得上时 true。
 */
export function turnNavPreviewPlaceMatches(cssText) {
  if (typeof cssText !== 'string') return false
  return new RegExp(`[{;]top:[^;}]*var\\(${TURN_NAV_PREVIEW_CENTER}\\)`).test(cssText.replace(/\s+/g, ''))
}

/**
 * 打开对话时查轮次导航的结构。只查主区域里正在看的会话。
 * @param {{main: boolean, scroll: boolean, flow: boolean, turns: number, label: string, nav: {label: string, container: string, matches: boolean} | null}} seen
 *   页面上读到的：会话在不在 main.conversation 插槽里、找不找得到对话的滚动区（`data-conversation-scroll`）、这一页是不是对话页
 *   （有 `data-chat-flow`）、对话里看得见几轮（`data-chat-turn` 的不同值）、DSH 词典里轮次导航的名字、对话页里的 nav
 *   （aria-label、外层元素的 container-type、选不选得中）。
 * @returns {{state: 'ok'} | {state: 'mismatch', reason: 'slot' | 'nav' | 'container'} | {state: 'none'}} 对得上、对不上（哪一处）、
 *   看不出来（别的页、不到两轮）。
 */
export function turnNavCheck(seen) {
  if (!seen.main || !seen.scroll) return { state: 'mismatch', reason: 'slot' }
  if (!seen.flow) return { state: 'none' }
  const nav = seen.nav
  if (nav === null) return seen.turns >= 2 ? { state: 'mismatch', reason: 'nav' } : { state: 'none' }
  if (nav.label !== seen.label || !nav.matches) return { state: 'mismatch', reason: 'nav' }
  if (nav.container !== 'inline-size') return { state: 'mismatch', reason: 'container' }
  return { state: 'ok' }
}

/**
 * 这一行生没生效：'waiting' 还没查过，'ok' 对得上，'mismatch' 对不上（带哪一处）。看不出来的结果不改状态，结论没变不通知。
 * @returns {{getSnapshot: () => {state: string, reason?: string}, subscribe: (listener: () => void) => () => void, report: (result: {state: string, reason?: string}) => void, reset: () => void}} 状态。
 */
export function createTurnNavStatus() {
  const waiting = { state: 'waiting' }
  let current = waiting
  const listeners = new Set()
  const set = (next) => {
    if (next.state === current.state && next.reason === current.reason) return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    report(result) {
      if (result.state === 'ok') set({ state: 'ok' })
      else if (result.state === 'mismatch') set({ state: 'mismatch', reason: result.reason })
    },
    reset() { set(waiting) },
  }
}

// ---------- 第二步：放大、拖动、键盘 ----------

/** 指着的那根和上下三根的放大倍数（DSH 20 像素的刻度上 26、22、18、14）；DSH 平时 0.6，没加载的 0.4，当前那根 1。 */
export const TURN_NAV_GROW = [1.3, 1.1, 0.9, 0.7]

/** 轨道能滚的一头淡出多高（DSH 的 FADE_PX）；刻度要挪进这一段以里才看得清。 */
export const TURN_NAV_FADE = 24

/** PageUp、PageDown 一次挪几根。 */
export const TURN_NAV_PAGE = 10

/**
 * 一根刻度离指着的那根有多远，只算放大的范围。
 * @param {number} index 刻度的序号（DSH 的 data-index）。
 * @param {number} point 指着的那根；没有时 -1。
 * @returns {number | undefined} 0 到 3；不放大时 undefined。
 */
export function turnNavNear(index, point) {
  if (point < 0) return undefined
  const distance = Math.abs(index - point)
  return distance < TURN_NAV_GROW.length ? distance : undefined
}

/**
 * 从画出来的刻度量出间距和第 0 根的位置。DSH 只画看得见的那些刻度，位置用 transform 摆，所以从量到的矩形算。
 * @param {{index: number, top: number}[]} marks 画出来的刻度：序号和离刻度容器顶部的距离（像素）。
 * @returns {{pitch: number, inset: number} | undefined} 间距和第 0 根离顶部的距离；少于两根或不是等间距时 undefined。
 */
export function turnNavGeometry(marks) {
  if (marks.length < 2) return undefined
  const [first, second] = marks
  if (second.index === first.index) return undefined
  const pitch = (second.top - first.top) / (second.index - first.index)
  if (!(pitch > 0)) return undefined
  const inset = first.top - first.index * pitch
  return marks.every(mark => Math.abs(inset + mark.index * pitch - mark.top) <= 0.5) ? { pitch, inset } : undefined
}

/**
 * 指针在刻度容器里的高度对着第几根；超出两头就是第一根、最后一根。
 * @param {number} y 指针离刻度容器顶部的距离（像素，可以是负数）。
 * @param {{pitch: number, inset: number}} geometry turnNavGeometry 的结果。
 * @param {number} count 刻度总数。
 * @returns {number} 序号。
 */
export function turnNavIndexAt(y, geometry, count) {
  return Math.max(0, Math.min(count - 1, Math.floor((y - geometry.inset) / geometry.pitch)))
}

/**
 * 刻度总数：DSH 的刻度容器高 = 两头各一个 inset 加上每根一个间距。
 * @param {number} height 刻度容器的高度（像素）。
 * @param {{pitch: number, inset: number}} geometry turnNavGeometry 的结果。
 * @returns {number} 刻度总数。
 */
export function turnNavCount(height, geometry) {
  return Math.max(0, Math.round((height - 2 * geometry.inset) / geometry.pitch))
}

/**
 * 把一根刻度挪进轨道里不淡出的那一段，挪得最少（样稿的 reveal）。
 * @param {number} index 刻度序号。
 * @param {{scrollTop: number, height: number, total: number}} view 轨道滚动区现在滚到哪、看得见多高、刻度容器多高。
 * @param {{pitch: number, inset: number}} geometry turnNavGeometry 的结果。
 * @returns {number | undefined} 要滚到的 scrollTop；已经在里面、或者滚不动时 undefined。
 */
export function turnNavReveal(index, view, geometry) {
  const center = geometry.inset + index * geometry.pitch + geometry.pitch / 2
  const { scrollTop, height, total } = view
  if (height <= 0 || (center >= scrollTop + TURN_NAV_FADE && center <= scrollTop + height - TURN_NAV_FADE)) return undefined
  const wanted = center < scrollTop + TURN_NAV_FADE ? center - TURN_NAV_FADE : center - height + TURN_NAV_FADE
  const target = Math.max(0, Math.min(Math.max(0, total - height), wanted))
  return target === scrollTop ? undefined : target
}

/**
 * 焦点在刻度上时按键挪到哪一根：上下方向键一根，Home、End 到两头，PageUp、PageDown 十根。
 * @param {string} key KeyboardEvent.key。
 * @param {number} index 现在聚焦的那根。
 * @param {number} count 刻度总数。
 * @returns {number | undefined} 要聚焦的那根；不是这几个键时 undefined（回车、空格留给 DSH 跳转）。
 */
export function turnNavKeyTarget(key, index, count) {
  const moves = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: count - 1, PageUp: index - TURN_NAV_PAGE, PageDown: index + TURN_NAV_PAGE }
  if (!Object.hasOwn(moves, key)) return undefined
  return Math.max(0, Math.min(count - 1, moves[key]))
}

/**
 * 按 DSH 词典的刻度名字取出轮次号（刻度的 aria-label）。拖动时用「跳转到第 N 轮」认出已加载的轮次，只有它们马上跳过去；
 * 没加载的（「加载并跳转到第 N 轮」）和认不出的只预览，松手才交给 DSH，免得拖一下就加载一串。书签也按这两个名字取轮次号。
 * @param {string} filled 词条填上占位符以后的文字，例如「跳转到第 \u0000 轮」。
 * @param {string} placeholder 填进去的占位符。
 * @returns {(label: string | null) => number | undefined} 取一根刻度的轮次号；名字不是这一类时 undefined，词条里没有占位符时一律 undefined。
 */
export function turnNavTurnMatcher(filled, placeholder) {
  const at = filled.indexOf(placeholder)
  if (at < 0) return () => undefined
  const head = filled.slice(0, at)
  const tail = filled.slice(at + placeholder.length)
  return (label) => {
    if (typeof label !== 'string' || label.length <= head.length + tail.length || !label.startsWith(head) || !label.endsWith(tail)) return undefined
    const digits = label.slice(head.length, label.length - tail.length)
    return /^\d+$/.test(digits) ? Number(digits) : undefined
  }
}

// ---------- 书签 ----------

/**
 * 书签存在 localStorage 里的键，值是 `{ 会话 id: [轮次号] }`，只在这台电脑的这个浏览器里。
 */
export const TURN_NAV_BOOKMARK_KEY = 'dsh-workbench.turn-nav.bookmarks'

// dsh-ui-guard: DSH 没有书签图标。照 DSH 图标的画法自己画（16×16、描边 1、圆角）；空心表示未添加书签，实心表示已添加书签。
const turnNavBookmarkSvg = fill => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M4.5 2.5H11.5C11.7761 2.5 12 2.72386 12 3V13.5L8 10.5L4 13.5V3C4 2.72386 4.22386 2.5 4.5 2.5Z' stroke='currentColor' stroke-width='1' stroke-linejoin='round' fill='${fill}'/></svg>`)}")`

/** 卡片上没加书签时的图标（CSS 的 url()，用作遮罩）。 */
export const TURN_NAV_BOOKMARK_HOLLOW = turnNavBookmarkSvg('none')

/** 卡片上加了书签时的图标（CSS 的 url()，用作遮罩）。 */
export const TURN_NAV_BOOKMARK_FILLED = turnNavBookmarkSvg('currentColor')

/**
 * 读 localStorage 里的书签；不是 `{ 会话 id: [轮次号] }` 的内容（坏的 JSON、别的格式、没有）读成没有书签。
 * 只留正整数，去重、从小到大；没有书签的会话不留。
 * @param {string | null} saved localStorage 里的值。
 * @returns {Record<string, number[]>} 书签。
 */
export function turnNavBookmarksFrom(saved) {
  let value
  try {
    value = JSON.parse(saved)
  } catch {
    // 坏的 JSON 读成没有书签；下一次切换写进好的。
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const bookmarks = {}
  for (const [session, turns] of Object.entries(value)) {
    if (!Array.isArray(turns)) continue
    const kept = [...new Set(turns.filter(turn => Number.isSafeInteger(turn) && turn > 0))].sort((a, b) => a - b)
    if (kept.length > 0) bookmarks[session] = kept
  }
  return bookmarks
}

/**
 * 切换一轮的书签：没加就加上，加了就去掉；会话没有书签了就不留这个会话。不改传进来的对象。
 * @param {Record<string, number[]>} bookmarks 现在的书签。
 * @param {string} session 会话 id。
 * @param {number} turn 轮次号。
 * @returns {Record<string, number[]>} 切换以后的书签。
 */
export function turnNavToggleBookmark(bookmarks, session, turn) {
  const turns = bookmarks[session] ?? []
  const next = turns.includes(turn) ? turns.filter(item => item !== turn) : [...turns, turn].sort((a, b) => a - b)
  const rest = { ...bookmarks }
  delete rest[session]
  return next.length === 0 ? rest : { ...rest, [session]: next }
}

/**
 * 这个浏览器里的书签：切换时写进 localStorage，别的窗口改了用 reload 读回来；存储不可用时只在这个页面里记着。
 * @param {() => Storage} storage 取 localStorage（可能抛错）。
 * @returns {{getSnapshot: () => Record<string, number[]>, subscribe: (listener: () => void) => () => void, has: (session: string, turn: number) => boolean, toggle: (session: string, turn: number) => void, reload: () => void}} 书签。
 */
export function createTurnNavBookmarks(storage) {
  const read = () => {
    try {
      return turnNavBookmarksFrom(storage().getItem(TURN_NAV_BOOKMARK_KEY))
    } catch {
      // 存储不可用（隐私模式之类）：没有存下来的书签。
      return {}
    }
  }
  let bookmarks = read()
  const listeners = new Set()
  const publish = (next) => {
    if (JSON.stringify(next) === JSON.stringify(bookmarks)) return
    bookmarks = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => bookmarks,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    has: (session, turn) => (bookmarks[session] ?? []).includes(turn),
    toggle(session, turn) {
      const next = turnNavToggleBookmark(bookmarks, session, turn)
      try {
        storage().setItem(TURN_NAV_BOOKMARK_KEY, JSON.stringify(next))
      } catch {
        // 存不下：这个页面里照样记着。
      }
      publish(next)
    },
    reload() { publish(read()) },
  }
}

/** CSS 属性选择器里的字符串：加双引号，里面的引号和反斜杠转义。 */
const turnNavQuote = text => `"${String(text).replace(/["\\]/g, '\\$&')}"`

/**
 * 书签的样式表：按会话和刻度的名字选中加了书签的那几根，不给 DSH 的节点加属性（DSH 只画看得见的刻度，节点会重建，样式表不怕重建）。
 * - 刻度平时用 `label-caption`，比别的刻度亮；指着、当前那一轮、预览对着的、键盘焦点所在的，颜色照原来的。长度不变。
 * - 尾端外 2 像素一个 2×2 的圆点，跟着刻度的长度和颜色走：平时的长度照 DSH（已加载 0.6、没加载 0.4、预览对着的 0.9、
 *   当前那一轮 1，写在 `:where()` 里不占优先级），放大的几档由 turn-nav.js 的静态样式给 `--dwb-len`、`--dwb-dot`。
 *   最长放大到 1.3 倍时轨道里放不下 2 像素的空隙，圆点贴着尾端。键盘焦点所在的那根不画圆点：DSH 用同一个伪元素画焦点框。
 * - 预览对着加了书签的那一轮时，卡片右上角的书签是实心的；空心的那个由 turn-nav.js 的静态样式画。
 * @param {Record<string, number[]>} bookmarks 书签。
 * @param {{loaded: (turn: number) => string, unloaded: (turn: number) => string}} labels DSH 词典里刻度的两种名字：「跳转到第 N 轮」「加载并跳转到第 N 轮」。
 * @returns {string} 样式；没有书签时空串。
 */
export function turnNavBookmarkCss(bookmarks, labels) {
  const marks = { loaded: [], unloaded: [] }
  const described = []
  for (const [session, turns] of Object.entries(bookmarks)) {
    const nav = `${TURN_NAV_MAIN} [data-conversation-session=${turnNavQuote(session)}] ${TURN_NAV_RAIL}`
    for (const turn of turns) {
      for (const kind of ['loaded', 'unloaded']) {
        const mark = `button[aria-label=${turnNavQuote(labels[kind](turn))}]`
        marks[kind].push(`${nav} ${mark}`)
        described.push(`${nav}:has(${mark}[aria-describedby])`)
      }
    }
  }
  const all = [...marks.loaded, ...marks.unloaded]
  if (all.length === 0) return ''
  const list = (selectors, suffix) => selectors.map(selector => selector + suffix).join(',')
  return [
    `:where(${list(marks.loaded, '')}){--dwb-len:.6}`,
    `:where(${list(marks.unloaded, '')}){--dwb-len:.4}`,
    `:where(${list(all, '[aria-describedby]')}){--dwb-len:.9;--dwb-dot:var(--dsw-alias-label-tertiary)}`,
    `:where(${list(all, '[aria-current="true"]')}){--dwb-len:1;--dwb-dot:var(--dsw-alias-label-primary)}`,
    `${list(all, ':not([aria-current="true"]):not([aria-describedby]):not(:focus-visible):not(:hover):not([data-dwb-near="0"])::before')}{background:var(--dsw-alias-label-caption)}`,
    `${list(all, ':not(:focus-visible)::after')}{content:"";position:absolute;top:50%;right:min(calc(20px * var(--dwb-len, .6) + 2px), 26px);width:2px;height:2px;border-radius:50%;background:var(--dwb-dot, var(--dsw-alias-label-caption));transform:translateY(-50%);transition:right .14s}`,
    `${list(described, ' > [role="tooltip"]::after')}{background:var(--dsw-alias-label-primary);-webkit-mask-image:${TURN_NAV_BOOKMARK_FILLED};mask-image:${TURN_NAV_BOOKMARK_FILLED}}`,
  ].join('\n')
}

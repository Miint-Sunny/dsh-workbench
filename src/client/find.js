/**
 * 会话里查找（dsh-workbench/find 的网页部分，计划第 7 项，样稿「会话里查找」A–C）。
 * ⌘F（Windows 上 Ctrl+F）给焦点所在的会话打开查找条：搜当前会话对话区里已经显示的文字，
 * 全部匹配淡黄高亮、当前处深黄，回车下一处、⇧回车上一处、Esc 关掉。主对话区和右侧栏嵌入
 * 的会话各挂一份查找条，焦点在哪个会话里就查哪个。
 *
 * 快捷键只声明 desktop:* 的默认键位：DSH 的网页端不接受 Mod+F（dsh-client-shortcuts 的
 * isWebBindingAllowed 只放行少数组合），注册带 web 默认会直接抛错。焦点在哪个会话里照官方
 * 停止快捷键的判据（ui-conversation 的 stop-shortcut）：从触发时的焦点元素往上找
 * [data-conversation-session]；找不到就用主对话区的会话（列表条目的 retainedBy.mainView）。
 *
 * 搜索只遍历 DOM 文字节点（collectSegments），用 CSS Custom Highlight API 高亮
 * （::highlight，不改对话的 DOM）；匹配落在折叠行（hidden="until-found"）里时先派发合成
 * 的 beforematch 事件展开（DSH 的 searchable-hidden 监听它，展开不卸载子树），下一帧重搜
 * 保持位置再滚动。折叠的思考和工具正文没挂载，搜不到（样稿 C 的限制，README 写明）。
 *
 * 每个功能行一个模块，由 scripts/build-client.mjs 按顺序拼进 lib/client.js：模块之间共用
 * 同一个作用域，所以本模块的顶层名字都带 Find/find/FIND 标记，不能和别的模块重名。
 */
import { mountModuleStyle } from './style.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重）；shortcuts 在 0.2.2-rc.1 上验证过存在。 */
const FIND_INJECT = ['shortcuts']

/** 本功能的中文界面文字；键以 `find.` 开头，原话照第三批样稿；无结果、关闭、正在加载…照 DSH 的词典。 */
const FIND_ZH = {
  'find.shortcut': '在会话里查找',
  'find.label': '在会话里查找',
  'find.count': '{current}/{total}',
  'find.countCapped': '{current}/{total}+',
  'find.none': '无结果',
  'find.prev': '上一处',
  'find.next': '下一处',
  'find.close': '关闭',
  'find.older': '更早的轮次未加载，不在搜索范围内',
  'find.loadAll': '加载全部',
  'find.loading': '正在加载…',
}

/** 本功能的英文界面文字，键和 FIND_ZH 一一对应。 */
const FIND_EN = {
  'find.shortcut': 'Find in conversation',
  'find.label': 'Find in conversation',
  'find.count': '{current}/{total}',
  'find.countCapped': '{current}/{total}+',
  'find.none': 'No results',
  'find.prev': 'Previous match',
  'find.next': 'Next match',
  'find.close': 'Close',
  'find.older': 'Earlier turns are not loaded and are not searched',
  'find.loadAll': 'Load all',
  'find.loading': 'Loading…',
}

/** 全部匹配的高亮名（::highlight(dwb-find)）。 */
const FIND_HIGHLIGHT_ALL = 'dwb-find'

/** 当前处的高亮名（::highlight(dwb-find-current)）。 */
const FIND_HIGHLIGHT_CURRENT = 'dwb-find-current'

/** 匹配总数封顶（findMatches 超过后停止并标 capped）。 */
const FIND_MATCH_CAP = 5000

/** 输入后重搜的防抖毫秒数。 */
const FIND_INPUT_DEBOUNCE_MS = 120

/** 对话区内容变化后重搜的防抖毫秒数。 */
const FIND_MUTATION_DEBOUNCE_MS = 150

/** 查找条贴着对话容器右上角的边距（照样稿 A）。 */
const FIND_BAR_RIGHT = 18
const FIND_BAR_TOP = 10

// ---------- 纯函数（测试直接 import；遍历 DOM 的只用 nodeType、nodeValue、childNodes、getAttribute） ----------

/** collectSegments 整棵跳过的元素标签（输入框控件里的字不属于对话正文）。 */
const FIND_SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'])

/**
 * 深度优先收集 root 里的文字节点。跳过 script、style、textarea、input、查找条自己
 * （[data-dwb-find-bar]）和输入区（[data-conversation-region="composer"]）的子树；跳过
 * 隐藏（hidden，hidden="until-found" 除外）和 aria-hidden="true" 的子树；落在
 * hidden="until-found" 祖先里的文字记下那个祖先（跳过去之前要先展开它）。
 * @param {{nodeType: number, nodeValue?: string, childNodes?: object[], tagName?: string, getAttribute?: Function}} root 搜索根（元素或文字节点，测试用假节点树）。
 * @returns {{node: object, text: string, hiddenUntilFound: object | null}[]} 文档顺序的文字段；空文字节点不收。
 */
export function collectSegments(root) {
  const segments = []
  const walk = (node, untilFound) => {
    if (node === null || node === undefined) return
    if (node.nodeType === 3) {
      const text = typeof node.nodeValue === 'string' ? node.nodeValue : ''
      if (text !== '') segments.push({ node, text, hiddenUntilFound: untilFound })
      return
    }
    if (node.nodeType !== 1) return
    const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
    if (FIND_SKIPPED_TAGS.has(tag)) return
    if (typeof node.getAttribute !== 'function') return
    if (node.getAttribute('data-dwb-find-bar') !== null) return
    if (node.getAttribute('data-conversation-region') === 'composer') return
    const hidden = node.getAttribute('hidden')
    if (hidden !== null && hidden !== 'until-found') return
    if (node.getAttribute('aria-hidden') === 'true') return
    const next = hidden === 'until-found' ? node : untilFound
    for (const child of node.childNodes ?? []) walk(child, next)
  }
  walk(root, null)
  return segments
}

/**
 * 一个字符一个字符地小写，记下折叠串里每个位置对应的原串下标：toLowerCase 会把个别字符
 * 折成多个字符（如 İ 折成 i 加组合附点），整串折叠会让匹配下标对不回原文，高亮就挂错地方。
 * @param {string} text 原文。
 * @returns {{folded: string, map: number[]}} 折叠串和折叠位 → 原文下标。
 */
function findFold(text) {
  let folded = ''
  const map = []
  for (let at = 0; at < text.length; at += 1) {
    const lower = text[at].toLowerCase()
    if (lower.length === 1) {
      folded += lower
      map.push(at)
    } else {
      for (const unit of lower) {
        folded += unit
        map.push(at)
      }
    }
  }
  return { folded, map }
}

/**
 * 不分大小写的子串匹配。匹配不跨文字节点（一个词被样式拆成两个节点时搜不到，README 写明）；
 * 每段从左到右取不重叠的匹配；总数到 FIND_MATCH_CAP 停止并标 capped。匹配按文档顺序排列，
 * 带着所在文字节点（pickCurrent 用节点认「原来那一处」）。
 * @param {{node: object, text: string}[]} segments collectSegments 的结果。
 * @param {string} query 查询词。
 * @returns {{matches: {segmentIndex: number, start: number, end: number, node: object}[], capped: boolean}} 匹配和是否封顶；空查询给空匹配。
 */
export function findMatches(segments, query) {
  if (!Array.isArray(segments) || typeof query !== 'string' || query === '') return { matches: [], capped: false }
  const needle = findFold(query).folded
  const matches = []
  let capped = false
  for (let segmentIndex = 0; segmentIndex < segments.length && !capped; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    if (!segment || typeof segment.text !== 'string' || segment.text === '') continue
    const { folded, map } = findFold(segment.text)
    let at = folded.indexOf(needle)
    while (at !== -1) {
      matches.push({ segmentIndex, start: map[at], end: map[at + needle.length - 1] + 1, node: segment.node })
      if (matches.length >= FIND_MATCH_CAP) {
        capped = true
        break
      }
      at = folded.indexOf(needle, at + needle.length)
    }
  }
  return { matches, capped }
}

/**
 * 内容变了（流式输出、展开折叠）重新搜索后，让当前处落在原来那一处附近：同一文字节点同一
 * 偏移的匹配还在就取它；节点还在但偏移变了就取该节点里偏移最近的；节点没了就按文档顺序的
 * 位置（段下标为主、段内偏移为辅）取最近的——matches 本来就按文档顺序排。都没有时取第一处。
 * @param {{segmentIndex: number, start: number, node: object} | null | undefined} prevMatch 上一次的当前处。
 * @param {{segmentIndex: number, start: number, node: object}[]} nextMatches 重搜后的匹配。
 * @returns {object | undefined} 应该作为当前处的匹配；nextMatches 为空时 undefined。
 */
export function pickCurrent(prevMatch, nextMatches) {
  if (!Array.isArray(nextMatches) || nextMatches.length === 0) return undefined
  if (prevMatch === null || prevMatch === undefined) return nextMatches[0]
  for (const match of nextMatches) {
    if (match.node === prevMatch.node && match.start === prevMatch.start) return match
  }
  let inNode
  for (const match of nextMatches) {
    if (match.node !== prevMatch.node) continue
    if (inNode === undefined || Math.abs(match.start - prevMatch.start) < Math.abs(inNode.start - prevMatch.start)) inNode = match
  }
  if (inNode !== undefined) return inNode
  let nearest = nextMatches[0]
  let best = Number.POSITIVE_INFINITY
  for (const match of nextMatches) {
    // 段下标乘一个大数让它主导：段内偏移再大也不该压过一段的差距。
    const distance = Math.abs(match.segmentIndex - prevMatch.segmentIndex) * 1e9
      + Math.abs(match.start - prevMatch.start)
    if (distance < best) {
      best = distance
      nearest = match
    }
  }
  return nearest
}

/**
 * 跳到下一处／上一处的下标，回绕。
 * @param {number} index 当前下标。
 * @param {number} total 匹配总数。
 * @param {number} direction 方向：正数下一处，负数上一处。
 * @returns {number} 下一个下标；没有匹配时 0。
 */
export function stepIndex(index, total, direction) {
  if (!Number.isFinite(total) || total <= 0) return 0
  const base = Number.isFinite(index) ? Math.trunc(index) : 0
  const dir = direction >= 0 ? 1 : -1
  return ((base + dir) % total + total) % total
}

/**
 * 算查找条的位置：贴着对话容器（[data-conversation-session]）的右上角，宽度不超过容器宽
 * 减 24（容器很窄时缩短输入框），最少留 120 保证还能用。
 * @param {{right: number, top: number, width: number}} containerRect 对话容器的矩形。
 * @param {number} viewportWidth 视口宽。
 * @returns {{right: number, top: number, maxWidth: number}} fixed 定位用的 right/top 和最大宽度。
 */
export function placeFindBar(containerRect, viewportWidth) {
  return {
    right: Math.round(Math.max(4, viewportWidth - containerRect.right + FIND_BAR_RIGHT)),
    top: Math.round(Math.max(4, containerRect.top + FIND_BAR_TOP)),
    maxWidth: Math.round(Math.max(120, Math.min(380, containerRect.width - 24))),
  }
}

/**
 * ⌘F 该查哪个会话：焦点在查找条里（portal 挂在 body 上、不在任何会话里）算当前开着查找条
 * 的那个；否则从焦点元素往上找 [data-conversation-session]；找不到用主对话区的会话
 * （列表条目的 retainedBy.mainView 计数大于 0）；都没有（面板页这类没有对话的地方）返回
 * undefined，快捷键放行为 pass。
 * @param {object | null | undefined} target 触发快捷键时的焦点元素。
 * @param {Record<string, {id: string, retainedBy?: {mainView?: number}}>} byId 会话列表快照的 byId。
 * @param {string | undefined} openSessionId 当前开着查找条的会话。
 * @returns {string | undefined} 会话 id；查不了时 undefined。
 */
export function findResolveSession(target, byId, openSessionId) {
  const closest = name => (target && typeof target.closest === 'function' ? target.closest(name) : null)
  if (closest('[data-dwb-find-bar]') !== null && openSessionId !== undefined) return openSessionId
  const host = closest('[data-conversation-session]')
  const id = host === null || host === undefined ? undefined : host.getAttribute?.('data-conversation-session')
  if (typeof id === 'string' && id !== '') return id
  if (typeof byId !== 'object' || byId === null) return undefined
  for (const entry of Object.values(byId)) {
    if (entry && (entry.retainedBy?.mainView ?? 0) > 0) return entry.id
  }
  return undefined
}

// ---------- 打开状态的小 store ----------

/**
 * 「当前打开查找条的会话」的小 store：哪个会话开着查找条、查询词、聚焦令牌（再按 ⌘F 时
 * 已开着的查找条聚焦输入框并全选）。纯对象，不碰 DOM。
 * @returns {{getSnapshot: () => {sessionId: string | undefined, query: string, focus: number}, subscribe: (listener: Function) => () => void, open: (sessionId: string) => void, close: () => void, setQuery: (query: string) => void, reset: () => void}} store。
 */
export function createFindBarStore() {
  let state = { sessionId: undefined, query: '', focus: 0 }
  const listeners = new Set()
  const set = patch => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (state.sessionId === sessionId) set({ focus: state.focus + 1 })
      else set({ sessionId, query: '', focus: state.focus + 1 })
    },
    close() {
      if (state.sessionId === undefined) return
      set({ sessionId: undefined, query: '' })
    },
    setQuery(query) {
      if (typeof query !== 'string' || query === state.query) return
      set({ query })
    },
    reset() {
      set({ sessionId: undefined, query: '', focus: 0 })
    },
  }
}

/** 模块里那一份 store（快捷键的 run 和各会话的查找条共用）。 */
export const findBar = createFindBarStore()

// ---------- 高亮和滚动（DOM 胶水，装进桌面端由 Claude 实测） ----------

/**
 * 浏览器自带的 CSS 对象。bundle 里各模块共用一个作用域，style.js 的顶层 `const CSS`（样式字符串）
 * 会盖住全局的 CSS，所以从 window 上取；没有 window（测试）时 undefined。
 * @returns {{highlights?: Map<string, unknown>} | undefined} 全局 CSS 对象。
 */
function findCssApi() {
  return typeof window === 'undefined' ? undefined : window.CSS
}

/**
 * 把匹配挂成两个 CSS 自定义高亮：全部匹配淡黄、当前处深黄。高亮 API 不可用时静默跳过，
 * 查找和跳转不受影响。
 * @param {{node: object, text: string}[]} segments 文字段。
 * @param {{segmentIndex: number, start: number, end: number}[]} matches 匹配。
 * @param {number} currentIndex 当前处的下标。
 * @returns {void}
 */
function findApplyHighlights(segments, matches, currentIndex) {
  const css = findCssApi()
  if (typeof document === 'undefined' || typeof Highlight === 'undefined' || css === undefined || !css.highlights) return
  const rangesOf = list => {
    const ranges = []
    for (const match of list) {
      const segment = segments[match.segmentIndex]
      if (segment === undefined) continue
      const range = document.createRange()
      try {
        range.setStart(segment.node, match.start)
        range.setEnd(segment.node, match.end)
      } catch {
        // 段的内容在搜索和挂高亮之间变了、偏移越界：这一处跳过，别的照挂。
        continue
      }
      ranges.push(range)
    }
    return ranges
  }
  const current = matches[currentIndex]
  try {
    css.highlights.set(FIND_HIGHLIGHT_ALL, new Highlight(...rangesOf(matches)))
    css.highlights.set(FIND_HIGHLIGHT_CURRENT, new Highlight(...rangesOf(current === undefined ? [] : [current])))
  } catch {
    // 高亮 API 在这个环境里挂不上（数量超限之类）：查找和跳转照常。
  }
}

/** 清掉本功能的两个高亮（关闭、卸载、换会话时调用）。 */
function findClearHighlights() {
  const css = findCssApi()
  if (css === undefined || !css.highlights) return
  try {
    css.highlights.delete(FIND_HIGHLIGHT_ALL)
    css.highlights.delete(FIND_HIGHLIGHT_CURRENT)
  } catch {
    // CSS.highlights 只在极端环境里不可用；没有高亮可清。
  }
}

// ---------- 查找条 ----------

/**
 * 查找条的条目。conversation.input.dock 是会话作用域的（主对话区和右侧栏嵌入的会话里各挂
 * 一份），每个对话各有一个实例，只有 store 里开着的会话等于自己的 sessionId 时才渲染查找条。
 * 查找条 fixed 定位、portal 到 document.body（停靠的输入区自带包含块，fixed 的后代会被它
 * 含住，slot-catalog 在这一条上写明要 portal），按这个会话的 [data-conversation-session]
 * 容器矩形贴右上角。
 * @param {{app: object, sessionId: string, useSession: Function}} props 会话作用域插槽属性加入口上下文。
 * @returns {unknown} React 节点。
 */
function FindDock(props) {
  const { app, sessionId, useSession } = props
  const t = app.t
  const state = React.useSyncExternalStore(findBar.subscribe, findBar.getSnapshot)
  const open = state.sessionId === sessionId
  const hasMore = useSession(value => value.hasMore === true)
  const anchorRef = useRef(null)
  const inputRef = useRef(null)
  const [view, setView] = useState({ total: 0, capped: false })
  const [index, setIndex] = useState(0)
  const [place, setPlace] = useState(undefined)
  const [loadingAll, setLoadingAll] = useState(false)
  const segmentsRef = useRef([])
  const matchesRef = useRef([])
  const indexRef = useRef(0)
  const recomputeRef = useRef(() => {})

  /** 这个会话的搜索根：从停靠条往上找对话区（[data-conversation-region="chat"]，输入区在它里面、被 collectSegments 跳过）。 */
  const chatEl = () => anchorRef.current?.closest?.('[data-conversation-region="chat"]') ?? null

  /** 滚到一处匹配：按 Range 的矩形算进滚动容器的居中偏移；落在折叠行里先派发 beforematch 展开，下一帧重搜（保持位置）再滚。 */
  const jumpToMatch = useCallback((segments, match) => {
    const segment = segments[match.segmentIndex]
    if (segment === undefined) return
    if (segment.hiddenUntilFound !== null && segment.hiddenUntilFound !== undefined) {
      // DSH 的 searchable-hidden 监听 beforematch 展开折叠行（展开不卸载子树，文字节点还在）。
      segment.hiddenUntilFound.dispatchEvent(new Event('beforematch', { cancelable: true }))
      requestAnimationFrame(() => requestAnimationFrame(() => recomputeRef.current({ keepCurrent: true, scroll: true })))
      return
    }
    const chat = chatEl()
    if (chat === null) return
    const scroller = chat.querySelector('[data-conversation-scroll]') ?? chat
    const range = document.createRange()
    try {
      range.setStart(segment.node, match.start)
      range.setEnd(segment.node, match.end)
    } catch {
      // 搜索和滚动之间内容变了：这一处滚不了，等变更观察器触发重搜。
      return
    }
    const rect = range.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    scroller.scrollTop += rect.top + rect.height / 2 - scrollerRect.top - scrollerRect.height / 2
  }, [])

  /** 搜一遍并更新高亮、计数和当前处；keepCurrent 时用 pickCurrent 落在原来那一处附近，scroll 时滚到当前处。 */
  const recompute = useCallback(({ keepCurrent = false, scroll = false } = {}) => {
    const chat = chatEl()
    if (chat === null) return
    const segments = collectSegments(chat)
    const { matches, capped } = findMatches(segments, findBar.getSnapshot().query)
    const previous = keepCurrent ? matchesRef.current[indexRef.current] : undefined
    const kept = previous === undefined ? undefined : pickCurrent(previous, matches)
    const nextIndex = kept === undefined ? 0 : Math.max(0, matches.indexOf(kept))
    segmentsRef.current = segments
    matchesRef.current = matches
    indexRef.current = nextIndex
    setIndex(nextIndex)
    setView({ total: matches.length, capped })
    findApplyHighlights(segments, matches, nextIndex)
    if (scroll && matches[nextIndex] !== undefined) jumpToMatch(segments, matches[nextIndex])
  }, [jumpToMatch])
  useEffect(() => { recomputeRef.current = recompute })

  /** 跳到下标 at 的匹配（goTo 收到的都是算好的下标，这里只夹界）。 */
  const goTo = at => {
    const matches = matchesRef.current
    if (matches.length === 0) return
    const next = Math.max(0, Math.min(matches.length - 1, at))
    indexRef.current = next
    setIndex(next)
    findApplyHighlights(segmentsRef.current, matches, next)
    jumpToMatch(segmentsRef.current, matches[next])
  }
  const step = direction => { goTo(stepIndex(indexRef.current, matchesRef.current.length, direction)) }
  const closeBar = () => { findBar.close() }
  const changeQuery = value => { findBar.setQuery(value) }
  const loadAll = async () => {
    if (loadingAll) return
    setLoadingAll(true)
    try {
      const session = app.ctx.sessions?.binding?.(sessionId)?.session
      await session?.loadThrough?.(0)
    } finally {
      setLoadingAll(false)
      // 加载进来的轮次要等 DOM 挂上；变更观察器也会触发重搜，这里再显式来一遍保险。
      requestAnimationFrame(() => recomputeRef.current({ keepCurrent: true, scroll: true }))
    }
  }

  // 打开着或查询词变了：防抖 120 毫秒重搜，滚到第一处（改查询时）。
  useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(() => recomputeRef.current({ scroll: true }), FIND_INPUT_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [open, state.query])

  // 开着时观察对话区：流式输出、展开折叠（防抖 150 毫秒）重搜，保持当前处；关闭、卸载时清高亮。
  useEffect(() => {
    if (!open) return undefined
    const chat = chatEl()
    if (chat === null) return undefined
    let timer
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => recomputeRef.current({ keepCurrent: true }), FIND_MUTATION_DEBOUNCE_MS)
    })
    observer.observe(chat, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      clearTimeout(timer)
      findClearHighlights()
    }
  }, [open])

  // 打开或再按 ⌘F：聚焦输入框并全选。查找条量好位置前是隐藏的，隐藏的元素拿不到焦点，所以等 place 有值。
  const placed = place !== undefined
  useEffect(() => {
    if (!open || !placed) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, state.focus, placed])

  // 按对话容器矩形摆查找条；窗口缩放、滚动（捕获，滚动不冒泡）时重摆。
  useEffect(() => {
    if (!open) return undefined
    const remeasure = () => {
      const host = anchorRef.current?.closest?.('[data-conversation-session]')
      if (host === null || host === undefined) return
      const next = placeFindBar(host.getBoundingClientRect(), window.innerWidth)
      setPlace(prev => (prev !== undefined && prev.right === next.right && prev.top === next.top && prev.maxWidth === next.maxWidth ? prev : next))
    }
    remeasure()
    window.addEventListener('resize', remeasure)
    window.addEventListener('scroll', remeasure, true)
    return () => {
      window.removeEventListener('resize', remeasure)
      window.removeEventListener('scroll', remeasure, true)
    }
  }, [open])

  const query = open ? state.query : ''
  const count = query === ''
    ? ''
    : view.total === 0
      ? t('find.none')
      : t(view.capped ? 'find.countCapped' : 'find.count', { current: String(index + 1), total: String(view.total) })
  return h(Fragment, null,
    // 停靠条里的锚点：不占版面，只为从这里找到这个会话的对话容器和对话区。
    h('span', { ref: anchorRef, 'aria-hidden': true, style: { display: 'none' }, 'data-dwb-find-anchor': '' }),
    open && typeof document !== 'undefined' ? ReactDOM.createPortal(h('div', {
      className: 'dwb-find', 'data-dwb-find-bar': '', role: 'search', 'aria-label': t('find.label'),
      style: {
        right: place === undefined ? undefined : place.right,
        top: place === undefined ? undefined : place.top,
        maxWidth: place === undefined ? undefined : place.maxWidth,
        visibility: place === undefined ? 'hidden' : 'visible',
      },
    },
    h('div', { className: 'dwb-find-bar' },
      h(ui.IconSearchOutlineRegular, { size: 14, className: 'dwb-find-lead' }),
      h('input', {
        ref: inputRef, type: 'text', value: query, autoFocus: true,
        'aria-label': t('find.label'), spellCheck: false,
        onChange: event => { changeQuery(event.target.value) },
        onKeyDown: event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeBar()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
        },
      }),
      count === '' ? null : h('span', {
        className: 'dwb-find-count', 'data-tone': view.total === 0 ? 'none' : undefined,
        'aria-live': 'polite',
      }, count),
      h('button', {
        type: 'button', className: 'dwb-find-btn', 'aria-label': t('find.prev'),
        disabled: view.total === 0, onClick: () => { step(-1) },
      }, h(ui.IconChevronUpOutlineRegular, { size: 14 })),
      h('button', {
        type: 'button', className: 'dwb-find-btn', 'aria-label': t('find.next'),
        disabled: view.total === 0, onClick: () => { step(1) },
      }, h(ui.IconChevronDownOutlineRegular, { size: 14 })),
      h('button', {
        type: 'button', className: 'dwb-find-btn', 'aria-label': t('find.close'),
        onClick: closeBar,
      }, h(ui.IconCloseOutlineRegular, { size: 14 }))),
    hasMore ? h('div', { className: 'dwb-find-note' },
      h('span', null, t('find.older')),
      loadingAll
        ? h('span', { className: 'dwb-find-loading' }, t('find.loading'))
        : h('button', { type: 'button', className: 'dwb-linklike', onClick: () => { void loadAll() } }, t('find.loadAll'))) : null),
    document.body) : null)
}

// ---------- 样式 ----------

/** 本功能自己的样式（style.js 是共用文件，别的分支同时在改，不往里加）。 */
const FIND_CSS = `
.dwb-find{position:fixed;z-index:50;display:flex;flex-direction:column;align-items:flex-end;gap:6px;box-sizing:border-box}
.dwb-find-bar{display:flex;align-items:center;gap:6px;height:38px;box-sizing:border-box;padding:0 8px 0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:blur(24px) saturate(1.8);box-shadow:var(--dsw-elevation-panel);font-size:13px}
.dwb-find-lead{flex:none;color:var(--dsw-alias-label-tertiary)}
.dwb-find-bar input{flex:1 1 auto;min-width:60px;width:190px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dwb-find-count{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:44px;text-align:right;white-space:nowrap}
.dwb-find-count[data-tone=none]{color:var(--dsw-alias-state-error-primary)}
.dwb-find-btn{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.dwb-find-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dwb-find-btn:disabled{opacity:.4;cursor:default}
.dwb-find-btn:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
.dwb-find-note{display:flex;gap:8px;align-items:center;max-width:100%;box-sizing:border-box;padding:5px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:blur(24px) saturate(1.8);box-shadow:var(--dsw-elevation-panel)}
.dwb-find-note>span:first-child{flex:1 1 auto;min-width:0}
.dwb-find-loading{flex:none;color:var(--dsw-alias-label-secondary)}
.dwb-find-note .dwb-linklike{flex:none;font-size:12px}
::highlight(dwb-find){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent)}
::highlight(dwb-find-current){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 75%,transparent);color:#111}
`

// ---------- 挂载 ----------

/**
 * 挂载本功能的界面：⌘F 快捷键和各会话的查找条；返回撤销函数（这一行关掉时调用，撤掉全部
 * 注册并清掉打开状态）。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
export function applyFind(app) {
  const { ctx } = app
  const t = app.t
  const disposers = [mountModuleStyle('dsh-workbench-find', FIND_CSS)]
  const keep = dispose => { disposers.push(dispose) }
  keep(ctx.effect(() => ctx.shortcuts.register({
    // 只声明 desktop:* 的默认键位：网页端不接受 Mod+F，注册 web 默认会抛错（dsh-client-shortcuts）。
    id: 'dsh-workbench.find',
    label: () => t('find.shortcut'),
    aliases: [],
    defaults: {
      'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
    },
    regions: ['page', 'editable'],
    modals: ['sidebar'],
    resolve: context => {
      const sessionId = findResolveSession(
        context?.target, ctx.sessions?.list?.getSnapshot?.()?.byId, findBar.getSnapshot().sessionId,
      )
      if (sessionId === undefined) return { status: 'pass' }
      return { status: 'handled', run: () => { findBar.open(sessionId) } }
    },
  }), '@miint-sunny/dsh-workbench/find: shortcut'))
  keep(ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'dsh-workbench-find', order: 100, locale: '@miint-sunny/dsh-workbench' },
    props => h(FindDock, { ...props, app }))), '@miint-sunny/dsh-workbench/find: dock entry'))
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    findBar.reset()
  }
}

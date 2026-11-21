/**
 * 轮次导航（dsh-workbench/turn-nav 的网页部分）。DSH 的对话页自己有轮次导航，但主区域宽过 964 才出；
 * 右侧栏开着时主区域常常只有四百来宽，所以从来不出。这里加一条容器查询样式，让它在主区域 380 以上就出；
 * 刻度、预览（指针移到刻度上、键盘聚焦刻度就出）、加载没加载的轮次、跳转都还是 DSH 的，不另画一条。主区域本来就够宽时不出两条。
 *
 * 在 DSH 的轮次轨道上增加以下操作：
 * - 指针在刻度上时，指着的那根最长最亮，上下三根依次变短；指针不在刻度上就不放大。样式按 `:hover` 和相邻的刻度算。
 *   拖动时指针被轨道捕获，刻度不再 `:hover`，改由控制器给拖到的那根和上下三根标 `data-dwb-near`。
 * - 预览能把指针移上去，点预览也跳；Esc 收起预览，指针或焦点到了别的刻度再出；上下方向键、Home、End、PageUp、PageDown 挪焦点。
 * - 按住刻度沿轨道拖，划过的已加载轮次马上跳过去（点 DSH 的刻度按钮），没加载的只预览、松手才加载；拖的时候按 Esc 回到按下前。
 *   已加载没加载照 DSH 词典的刻度名字认（turnNavTurnMatcher），认不出就都当没加载。
 * - 书签：在刻度上右键，DSH 的共享菜单里一项「添加书签」或「移除书签」；焦点在刻度上按 B 也切换；预览卡片右上角的书签
 *   （伪元素，空心没加、实心加了）点了也切换。加了书签的刻度更亮，尾端外一个小圆点。按会话和轮次号存在 localStorage
 *   （turn-nav-model.js 的 TURN_NAV_BOOKMARK_KEY）。不往 DSH 的节点里加东西：刻度和卡片上书签的样子都由按刻度名字生成的样式表画
 *   （turnNavBookmarkCss），点卡片上的书签按坐标判断，走「点卡片也跳」同一条路。
 * 控制器在指针第一次移进轨道、焦点第一次进轨道时接上，不观察整个对话。
 *
 * 自查：挂载时查 DSH 的轮次导航样式表，打开主区域的对话时查那条 nav 和插槽（turn-nav-model.js 的 turnNavCheck）。
 * 对不上就撤掉样式和控制器，什么都不做，并在插件页这一行的配置和控制台里说明没生效；之后再查到对得上就装回来。
 * 检查只在打开会话、会话加载完、一轮结束时各做一次。
 *
 * 每个功能行一个模块，由 scripts/build-client.mjs 按顺序拼进 lib/client.js：模块之间共用同一个作用域，
 * 所以本模块的顶层名字都带 turnNav/TurnNav/TURN_NAV 标记。
 */
import { mountModuleStyle } from './style.js'
import { mainViewSessionId } from './features.js'
import { TURN_NAV_SELECTOR, TURN_NAV_MIN_CONTAINER, TURN_NAV_DSH_STYLE, TURN_NAV_PREVIEW_CENTER, TURN_NAV_GROW, TURN_NAV_BOOKMARK_KEY, TURN_NAV_BOOKMARK_HOLLOW, turnNavStyleMatches, turnNavPreviewPlaceMatches, turnNavCheck, createTurnNavStatus, turnNavNear, turnNavGeometry, turnNavIndexAt, turnNavCount, turnNavReveal, turnNavKeyTarget, turnNavTurnMatcher, createTurnNavBookmarks, turnNavBookmarkCss } from './turn-nav-model.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重）：刻度上的右键菜单用共享菜单。 */
const TURN_NAV_INJECT = ['contextMenus']

/** 本功能的中文界面文字；键以 `turnNav.` 开头。「添加」「移除」照 DSH 的用词；书签用于保存轮次位置。 */
const TURN_NAV_ZH = {
  'turnNav.status.waiting': '未检查：打开包含两轮以上的对话后检查。',
  'turnNav.status.ok': '已生效。',
  'turnNav.status.mismatch': '未生效：{why}。此行当前不起作用，DSH 自带的轮次导航不受影响。',
  'turnNav.why.style': 'DSH 轮次导航的样式已变更',
  'turnNav.why.slot': '未找到主区域的对话',
  'turnNav.why.nav': '对话中未找到 DSH 的轮次导航',
  'turnNav.why.container': '轮次导航不再按宽度显示',
  'turnNav.bookmark.add': '添加书签',
  'turnNav.bookmark.remove': '移除书签',
}

/** 本功能的英文界面文字，键和 TURN_NAV_ZH 一一对应。 */
const TURN_NAV_EN = {
  'turnNav.status.waiting': 'Not checked: checked after a conversation with two or more turns is opened.',
  'turnNav.status.ok': 'In effect.',
  'turnNav.status.mismatch': 'Not in effect: {why}. This row has no effect; DSH’s own turn navigation is not affected.',
  'turnNav.why.style': 'DSH’s turn navigation styles changed',
  'turnNav.why.slot': 'the conversation in the main area was not found',
  'turnNav.why.nav': 'DSH’s turn navigation was not found in the conversation',
  'turnNav.why.container': 'the turn navigation no longer follows the width',
  'turnNav.bookmark.add': 'Add bookmark',
  'turnNav.bookmark.remove': 'Remove bookmark',
}

/**
 * 离指着的那根 near 根远的刻度：指针下的（`:hover`）往前往后数，加上拖动时控制器标的 `data-dwb-near`。
 * @param {number} near 0 是指着的那根，1 到 3 是上下的邻居。
 * @returns {string[]} 选择器。
 */
function turnNavNearSelectors(near) {
  const hover = 'button[data-index]:hover'
  const around = near === 0
    ? [`${TURN_NAV_SELECTOR} ${hover}`]
    : [`${TURN_NAV_SELECTOR} ${[hover, ...Array(near).fill('button')].join('+')}`, `${TURN_NAV_SELECTOR} button:has(+${[...Array(near - 1).fill('button'), hover].join('+')})`]
  return [...around, `${TURN_NAV_SELECTOR} button[data-dwb-near="${near}"]`]
}

/**
 * 卡片右上角书签图标的位置和大小（像素）。`gap` 是第一行字和图标之间的空隙，
 * `cardPadding` 是 DSH 卡片的右内边距，`slop` 是点击判断四周多算的一圈。
 */
const TURN_NAV_ICON = Object.freeze({ top: 13, right: 11, size: 14, gap: 5, cardPadding: 12, slop: 5 })

/**
 * 本功能的样式。第一条：主区域 380 以上就显示 DSH 的轮次导航（选择器比 DSH 藏它的那条规则更具体）。
 * 其余：拖的时候不选中文字；按 Esc 收起的预览藏起来；预览能移上去、点，露着时轨道和预览之间 10 像素的空隙算轨道；
 * 放大按离指着的那根多远取倍数，当前那一轮和键盘焦点所在的那根至少整根（DSH 原来就是整根）；指着的那根用最亮的颜色；
 * 放大的几档也给书签圆点用的 `--dwb-len`、`--dwb-dot`（书签样式表见 turnNavBookmarkCss）；卡片右上角画空心的书签，第一行给它让位置。
 */
const TURN_NAV_CSS = `
@container (min-width:${TURN_NAV_MIN_CONTAINER}px){${TURN_NAV_SELECTOR}{display:block}}
${TURN_NAV_SELECTOR}{user-select:none;-webkit-user-select:none;touch-action:none}
${TURN_NAV_SELECTOR}[data-dwb-dismissed]>[role="tooltip"]{display:none}
${TURN_NAV_SELECTOR}>[role="tooltip"]{pointer-events:auto;cursor:pointer}
${TURN_NAV_SELECTOR}:not([data-dwb-dismissed]):has(>[role="tooltip"])::before{content:"";position:absolute;top:0;bottom:0;right:100%;width:10px}
${TURN_NAV_SELECTOR} button[aria-current="true"],${TURN_NAV_SELECTOR} button:focus-visible{--dwb-floor:1}
${TURN_NAV_GROW.map((grow, near) => `${turnNavNearSelectors(near).join(',')}{--dwb-grow:${grow};--dwb-len:max(var(--dwb-floor,0),${grow})${near === 0 ? ';--dwb-dot:var(--dsw-alias-label-primary)' : ''}}`).join('\n')}
${TURN_NAV_GROW.flatMap((grow, near) => turnNavNearSelectors(near)).map(selector => `${selector}::before`).join(',')}{transform:translateY(-50%) scaleX(max(var(--dwb-floor,0),var(--dwb-grow)))}
${turnNavNearSelectors(0).map(selector => `${selector}:not(:focus-visible)::before`).join(',')}{background:var(--dsw-alias-label-primary)}
${TURN_NAV_SELECTOR}>[role="tooltip"]>:first-child{padding-right:${TURN_NAV_ICON.right + TURN_NAV_ICON.size + TURN_NAV_ICON.gap - TURN_NAV_ICON.cardPadding}px}
${TURN_NAV_SELECTOR}>[role="tooltip"]::after{content:"";position:absolute;top:${TURN_NAV_ICON.top}px;right:${TURN_NAV_ICON.right}px;width:${TURN_NAV_ICON.size}px;height:${TURN_NAV_ICON.size}px;background:var(--dsw-alias-label-tertiary);-webkit-mask:${TURN_NAV_BOOKMARK_HOLLOW} center/contain no-repeat;mask:${TURN_NAV_BOOKMARK_HOLLOW} center/contain no-repeat}
@media (prefers-reduced-motion:reduce){${TURN_NAV_SELECTOR} button::after{transition:none}}
`

/**
 * 预览卡片的定位，DSH 的卡片还按 TURN_NAV_PREVIEW_CENTER 定上边时才挂。DSH 按卡片高 100 把它夹在轨道里，矮的卡片在最下面几根时
 * 盖不住指着的那一行，指针往左移会出轨道。这里把卡片的上下边设成以那根的中心为中点、不出轨道的最长一段，卡片按实际高度在段里居中；
 * 段比卡片短时，浏览器按绝对定位的默认溢出对齐把卡片挪回轨道里，轨道比卡片还矮时贴着轨道上边。上下边照 DSH 原来的上边滑动，时长和缓动用 DSH 的。
 */
const TURN_NAV_PLACE_CSS = `${TURN_NAV_SELECTOR}>[role="tooltip"]{top:max(0px,calc(2 * var(${TURN_NAV_PREVIEW_CENTER}) - 100%));bottom:max(0px,calc(100% - 2 * var(${TURN_NAV_PREVIEW_CENTER})));align-self:center;transition-property:top,bottom}
`

/** 打开会话、加载完、一轮结束后等这么久再查：DSH 排好对话页、放好轮次导航以后。 */
const TURN_NAV_SETTLE_MS = 1200

/** 查到对不上时隔这么久再查一次，两次都对不上才算，免得刚打开时误报。 */
const TURN_NAV_CONFIRM_MS = 1500

/** 滚动轨道以后最多等几帧 DSH 画出要的那根刻度（DSH 只画看得见的刻度）。 */
const TURN_NAV_RENDER_FRAMES = 6

/** 这一行生没生效；插件页这一行的配置页读它。 */
const turnNavStatus = createTurnNavStatus()

/** 这个浏览器里的书签；各条轨道和书签样式表共用。 */
const turnNavBookmarks = createTurnNavBookmarks(() => globalThis.localStorage)

/** 已经在控制台说过的对不上的原因，一个原因只说一次。 */
const turnNavWarned = new Set()

/**
 * 记下一次检查的结论；新出现的对不上在控制台说一次。
 * @param {{state: string, reason?: string}} result turnNavCheck 的结果。
 * @returns {void}
 */
function turnNavReport(result) {
  turnNavStatus.report(result)
  if (result.state !== 'mismatch' || turnNavWarned.has(result.reason)) return
  turnNavWarned.add(result.reason)
  console.warn(`dsh-workbench/turn-nav: not active (${result.reason}); DSH's turn navigation did not match, so this row does nothing.`)
}

/**
 * 从停靠条里的锚点读主区域这个会话的对话页（turnNavCheck 的输入）。
 * @param {Element} anchor 停靠条里本功能的锚点。
 * @param {string} label DSH 词典里轮次导航的名字。
 * @returns {object} turnNavCheck 要的 seen。
 */
function turnNavSeen(anchor, label) {
  const scroll = anchor.closest('[data-conversation-scroll]')
  const flow = scroll?.querySelector('[data-chat-flow]') ?? null
  const turns = flow === null ? 0 : new Set([...flow.querySelectorAll('[data-chat-turn]')].map(row => row.getAttribute('data-chat-turn'))).size
  const nav = flow === null ? undefined : [...scroll.querySelectorAll('nav[aria-label]')].find(item => item.parentElement?.parentElement?.contains(flow))
  return {
    main: anchor.closest('[data-slot="main.conversation"]') !== null,
    scroll: scroll !== null,
    flow: flow !== null,
    turns,
    label,
    nav: nav === undefined ? null : {
      label: nav.getAttribute('aria-label'),
      container: getComputedStyle(nav.parentElement).containerType,
      matches: nav.matches(TURN_NAV_SELECTOR),
    },
  }
}

/**
 * 停靠条里的条目：不占版面，只在主区域正在看的会话里，打开、加载完、一轮结束后查一次轮次导航。
 * conversation.input.dock 是会话作用域的，右侧栏里的对话也会挂一份，那一份不查。
 * @param {{app: object, sessionId: string, useSession: Function}} props 会话作用域插槽属性加入口上下文。
 * @returns {unknown} React 节点。
 */
function TurnNavDock(props) {
  const { app, sessionId, useSession } = props
  const anchorRef = useRef(null)
  const running = useSession(value => value.running === true)
  const openState = useSession(value => value.openState)
  useEffect(() => {
    const check = () => {
      const anchor = anchorRef.current
      if (anchor === null || mainViewSessionId(app.ctx.sessions?.list?.getSnapshot?.()?.byId) !== sessionId) return { state: 'none' }
      return turnNavCheck(turnNavSeen(anchor, app.clock('chat.turnNavigation.label')))
    }
    let timer = setTimeout(() => {
      const first = check()
      if (first.state !== 'mismatch') return turnNavReport(first)
      timer = setTimeout(() => turnNavReport(check()), TURN_NAV_CONFIRM_MS)
    }, TURN_NAV_SETTLE_MS)
    return () => { clearTimeout(timer) }
  }, [sessionId, running, openState])
  return h('span', { ref: anchorRef, 'aria-hidden': true, style: { display: 'none' }, 'data-dwb-turn-nav-anchor': '' })
}

// ---------- 轨道的控制器 ----------

/**
 * 接管一条 DSH 的轨道：拖动、键盘、Esc、预览能移上去和点、书签。DSH 的刻度、预览和跳转都不动：跳转一律点 DSH 的刻度按钮。
 * @param {Element} nav DSH 的轮次导航（TURN_NAV_SELECTOR 选中的那条）。
 * @param {{loaded: (label: string | null) => boolean, turnOf: (label: string | null) => number | undefined, bookmarks: {toggle: (session: string, turn: number) => void}, openMenu: (value: {session: string, turn: number}, point: {x: number, y: number}) => void}} env
 *   怎么认出已加载的轮次、怎么从刻度名字取轮次号、书签、在哪里打开刻度的右键菜单。
 * @returns {{nav: Element, escape: (event: KeyboardEvent) => void, detach: () => void}} 控制器。
 */
function turnNavAttach(nav, env) {
  const rail = nav.firstElementChild
  const marks = rail?.firstElementChild ?? null
  const conversation = nav.closest('[data-conversation-scroll]')
  /** 按 Esc 收起预览时它对着的那根；指针或焦点到了别的刻度再放开。-1 是没收。 */
  let dismissed = -1
  /** 按住刻度：pointerId、现在拖到哪根、拖动过没有、按下时对话滚到哪、刻度的间距和总数。 */
  let drag = null
  /** 这次按下由 pointerup 处理了，紧跟着的指针点击不再交给 DSH。 */
  let pressed = false
  /** 正在替用户点 DSH 的刻度按钮，这次点击放行。 */
  let clicking = false

  const markOf = target => (target instanceof Element ? target.closest('button[data-index]') : null)
  const indexOf = button => Number(button.getAttribute('data-index'))
  const markAt = index => marks?.querySelector(`button[data-index="${index}"]`) ?? null
  const previewOf = () => nav.querySelector(':scope > [role="tooltip"]')
  /** DSH 的预览现在对着哪根（它给那根刻度加 aria-describedby）；没有预览时 -1。 */
  const describedIndex = () => {
    const preview = previewOf()
    const mark = preview === null ? undefined : [...nav.querySelectorAll('button[data-index]')].find(button => button.getAttribute('aria-describedby') === preview.id)
    return mark === undefined ? -1 : indexOf(mark)
  }
  /** 刻度的间距、起点和总数，从画出来的刻度量（turnNavGeometry）；量不出时 undefined。 */
  const measure = () => {
    if (marks === null) return undefined
    const top = marks.getBoundingClientRect().top
    const geometry = turnNavGeometry([...marks.querySelectorAll('button[data-index]')].map(button => ({ index: indexOf(button), top: button.getBoundingClientRect().top - top })))
    return geometry === undefined ? undefined : { geometry, count: turnNavCount(marks.getBoundingClientRect().height, geometry) }
  }
  /** 把一根刻度挪进轨道里不淡出的那一段（直接滚到，DSH 才会马上画出它）。 */
  const reveal = (index, sizes) => {
    if (rail === null || marks === null) return
    const target = turnNavReveal(index, { scrollTop: rail.scrollTop, height: rail.clientHeight, total: marks.getBoundingClientRect().height }, sizes.geometry)
    if (target !== undefined) rail.scrollTop = target
  }
  /** 等 DSH 画出第 index 根再做 fn；几帧都没画出来就算了。 */
  const whenDrawn = (index, fn, frames = TURN_NAV_RENDER_FRAMES) => {
    const button = markAt(index)
    if (button !== null) return fn(button)
    if (frames > 0) requestAnimationFrame(() => whenDrawn(index, fn, frames - 1))
  }
  /** 替用户点 DSH 的刻度按钮：已加载的直接跳过去，没加载的先加载再跳（DSH 的 onNavigate）。 */
  const jump = (button) => {
    clicking = true
    try {
      button.click()
    } finally {
      clicking = false
    }
  }
  /** 拖动时放大：拖到的那根和上下三根标档位；point 为 -1 时全部清掉。 */
  const paintNear = (point) => {
    if (marks === null) return
    for (const button of marks.querySelectorAll('button[data-index]')) {
      const near = turnNavNear(indexOf(button), point)
      if (near === undefined) button.removeAttribute('data-dwb-near')
      else if (button.getAttribute('data-dwb-near') !== String(near)) button.setAttribute('data-dwb-near', String(near))
    }
  }
  /** 按 Esc 收起的预览藏起来；dismissed 为 -1 时露出。 */
  const dismiss = (index) => {
    dismissed = index
    if (index >= 0) nav.setAttribute('data-dwb-dismissed', '')
    else nav.removeAttribute('data-dwb-dismissed')
  }
  /** 这根刻度是哪个会话的第几轮；轮次号取不出来（DSH 的词条变了）时 undefined。 */
  const bookmarkOf = (mark) => {
    const turn = env.turnOf(mark.getAttribute('aria-label'))
    const session = nav.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
    return turn !== undefined && session ? { session, turn } : undefined
  }
  /** 切换这根刻度那一轮的书签；取不出轮次时什么都不做。 */
  const toggleBookmark = (mark) => {
    const target = bookmarkOf(mark)
    if (target !== undefined) env.bookmarks.toggle(target.session, target.turn)
  }
  /** 点在卡片右上角的书签图标上（按 TURN_NAV_ICON 和卡片的位置算，图标是伪元素，没有自己的节点）。 */
  const onIcon = (preview, event) => {
    const box = preview.getBoundingClientRect()
    const right = box.right - TURN_NAV_ICON.right
    const top = box.top + TURN_NAV_ICON.top
    return event.clientX >= right - TURN_NAV_ICON.size - TURN_NAV_ICON.slop && event.clientX <= right + TURN_NAV_ICON.slop
      && event.clientY >= top - TURN_NAV_ICON.slop && event.clientY <= top + TURN_NAV_ICON.size + TURN_NAV_ICON.slop
  }
  /** 指针或焦点到了另一根刻度：按 Esc 收起的预览放开。 */
  const reach = (index) => {
    if (dismissed >= 0 && index !== dismissed) dismiss(-1)
  }

  /** 拖的时候：指针对着的那根放大、预览；已加载的马上跳过去。 */
  function scrub(event) {
    if (drag.sizes === undefined || marks === null) return
    const index = turnNavIndexAt(event.clientY - marks.getBoundingClientRect().top, drag.sizes.geometry, drag.sizes.count)
    if (index === drag.index) return
    drag.index = index
    drag.moved = true
    paintNear(index)
    reveal(index, drag.sizes)
    whenDrawn(index, (button) => {
      if (drag === null || drag.index !== index) return
      // 轨道滚动以后新画出来的刻度也要标档位。
      paintNear(index)
      // 焦点跟着走，DSH 的预览跟焦点；按下时焦点是指针给的，换过去也不显示键盘焦点框。
      button.focus({ preventScroll: true })
      if (env.loaded(button.getAttribute('aria-label'))) jump(button)
    })
  }
  /** 拖的时候按 Esc：对话回到按下前，预览收起，这次按下不再跳。 */
  function cancelDrag() {
    const { id, before, index } = drag
    drag = null
    if (conversation !== null) conversation.scrollTop = before
    if (nav.hasPointerCapture(id)) nav.releasePointerCapture(id)
    paintNear(-1)
    dismiss(index)
  }

  const listeners = {
    pointermove: (event) => {
      if (drag !== null) return scrub(event)
      if (previewOf()?.contains(event.target)) return
      const mark = markOf(event.target)
      if (mark !== null) reach(indexOf(mark))
    },
    mousedown: (event) => {
      // 在预览上按下不挪焦点：焦点一离开刻度，DSH 就把预览收了，点击就落空。
      if (previewOf()?.contains(event.target)) event.preventDefault()
    },
    pointerdown: (event) => {
      pressed = false
      if (event.button !== 0 || previewOf()?.contains(event.target)) return
      const mark = markOf(event.target)
      if (mark === null) return
      // 不拦默认行为：按下照常把焦点给这根刻度，后面用脚本挪焦点才不会显示键盘焦点框。
      pressed = true
      drag = { id: event.pointerId, index: indexOf(mark), moved: false, before: conversation?.scrollTop ?? 0, sizes: measure() }
      nav.setPointerCapture(event.pointerId)
      dismiss(-1)
      paintNear(drag.index)
    },
    pointerup: (event) => {
      if (drag === null || event.pointerId !== drag.id) return
      const { index, moved } = drag
      drag = null
      paintNear(-1)
      const button = markAt(index)
      if (button === null) return
      button.focus({ preventScroll: true })
      // 没拖动就是点了这根；拖动停在没加载的轮次上，松手才加载。已加载的拖动时已经跳过去了。
      if (!moved || !env.loaded(button.getAttribute('aria-label'))) jump(button)
    },
    lostpointercapture: () => {
      if (drag === null) return
      drag = null
      paintNear(-1)
    },
    click: (event) => {
      if (clicking) return
      const preview = previewOf()
      if (preview?.contains(event.target)) {
        event.stopPropagation()
        const target = [...nav.querySelectorAll('button[data-index]')].find(button => button.getAttribute('aria-describedby') === preview.id)
        if (target === undefined) return
        // 点在右上角的书签上就切换书签，不跳转；点别处跳过去。
        if (onIcon(preview, event)) toggleBookmark(target)
        else jump(target)
        return
      }
      // 指针点击已经在 pointerup 里处理了；键盘的回车、空格（detail 为 0）照常交给 DSH 跳转。
      if (pressed && event.detail > 0) {
        pressed = false
        event.stopPropagation()
      }
    },
    contextmenu: (event) => {
      const mark = markOf(event.target)
      const target = mark === null ? undefined : bookmarkOf(mark)
      if (target === undefined) return
      // 刻度上 DSH 没有自己的右键菜单（它只在对话流里接右键）；这里打开 DSH 的共享菜单，不出浏览器自带的那个。
      event.preventDefault()
      event.stopPropagation()
      const box = mark.getBoundingClientRect()
      const keyboard = event.clientX === 0 && event.clientY === 0
      env.openMenu(target, keyboard ? { x: box.left, y: box.bottom } : { x: event.clientX, y: event.clientY })
    },
    focusin: (event) => {
      const mark = markOf(event.target)
      if (mark !== null) reach(indexOf(mark))
    },
    keydown: (event) => {
      const mark = markOf(event.target)
      if (mark === null) return
      if ((event.key === 'b' || event.key === 'B') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
        // 焦点在刻度上按 B 切换这一轮的书签。
        event.preventDefault()
        toggleBookmark(mark)
        return
      }
      if (event.key === 'Escape') {
        if (drag !== null) cancelDrag()
        else if (dismissed < 0 && previewOf() !== null) dismiss(indexOf(mark))
        else return
        // 收起了东西才占用这次 Esc；DSH 的停止快捷键看到 defaultPrevented 就不算这一下。
        event.preventDefault()
        return
      }
      const sizes = measure()
      const index = sizes === undefined ? undefined : turnNavKeyTarget(event.key, indexOf(mark), sizes.count)
      if (index === undefined) return
      event.preventDefault()
      reveal(index, sizes)
      whenDrawn(index, button => button.focus({ preventScroll: true }))
    },
  }
  const capture = new Set(['click'])
  for (const [type, listener] of Object.entries(listeners)) nav.addEventListener(type, listener, capture.has(type))

  return {
    nav,
    /** 焦点不在轨道上时按 Esc：拖着就回到按下前（占用这次 Esc），露着预览就收起（不占用，DSH 的停止照常）。 */
    escape(event) {
      if (drag !== null) {
        cancelDrag()
        event.preventDefault()
        return
      }
      if (dismissed < 0 && previewOf() !== null) dismiss(Math.max(describedIndex(), 0))
    },
    detach() {
      for (const [type, listener] of Object.entries(listeners)) nav.removeEventListener(type, listener, capture.has(type))
      nav.removeAttribute('data-dwb-dismissed')
      paintNear(-1)
    },
  }
}

/** 刻度右键菜单的目标类型，也是菜单项图标的键的前缀。 */
const TURN_NAV_MENU = 'dsh-workbench-turn-nav-mark'

// dsh-ui-guard: DSH 没有书签图标。照 DSH 图标的画法自己画（16×16、描边 1、圆角）；空心表示添加书签，实心表示移除书签。
function TurnNavBookmarkIcon({ filled, size = 16, className }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className },
    h('path', { d: 'M4.5 2.5H11.5C11.7761 2.5 12 2.72386 12 3V13.5L8 10.5L4 13.5V3C4 2.72386 4.22386 2.5 4.5 2.5Z', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round', fill: filled ? 'currentColor' : 'none' }))
}

/**
 * 在整个文档上接轨道：指针或焦点第一次进到主区域的轮次导航时接上控制器；焦点不在轨道上时按 Esc，转给各条轨道。
 * 书签样式表跟着书签重新生成；别的窗口改了书签（storage 事件）就读回来。刻度的右键菜单注册在 DSH 的共享菜单里。
 * @param {{ctx: object, t: Function, clock: Function}} app 入口上下文（clock 是 DSH chat 的词典）。
 * @returns {() => void} 撤销函数：拆掉全部控制器、监听、右键菜单和书签样式表。
 */
function turnNavWire(app) {
  const { ctx, t } = app
  const placeholder = '\u0000'
  const label = (key, turn) => String(app.clock(key, { turn: String(turn) }))
  const loadedTurn = turnNavTurnMatcher(label('chat.turnNavigation.jump', placeholder), placeholder)
  const unloadedTurn = turnNavTurnMatcher(label('chat.turnNavigation.jumpLoad', placeholder), placeholder)
  const env = {
    loaded: name => loadedTurn(name) !== undefined,
    turnOf: name => loadedTurn(name) ?? unloadedTurn(name),
    bookmarks: turnNavBookmarks,
    openMenu: (value, point) => { ctx.contextMenus.open({ kind: TURN_NAV_MENU, value }, point) },
  }
  const menus = [
    ctx.contextMenus.register({
      id: TURN_NAV_MENU, target: TURN_NAV_MENU, order: 100,
      resolve: ({ session, turn }) => {
        const has = turnNavBookmarks.has(session, turn)
        return [{
          id: has ? 'remove' : 'add',
          label: t(has ? 'turnNav.bookmark.remove' : 'turnNav.bookmark.add'),
          icon: { key: `${TURN_NAV_MENU}-${has ? 'remove' : 'add'}` },
          run: () => { turnNavBookmarks.toggle(session, turn) },
        }]
      },
    }),
    ...[['add', false], ['remove', true]].map(([name, filled]) => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register(
      { name: 'contextMenu.icon', key: `${TURN_NAV_MENU}-${name}` },
      props => h(TurnNavBookmarkIcon, { ...props, filled })))),
  ]
  const labels = { loaded: turn => label('chat.turnNavigation.jump', turn), unloaded: turn => label('chat.turnNavigation.jumpLoad', turn) }
  let unsheet = () => {}
  const paintBookmarks = () => {
    unsheet()
    unsheet = mountModuleStyle('dsh-workbench-turn-nav-bookmarks', turnNavBookmarkCss(turnNavBookmarks.getSnapshot(), labels))
  }
  // 这一行关着的时候别的窗口可能改过书签，接上时先读一遍。
  turnNavBookmarks.reload()
  paintBookmarks()
  const unsubscribe = turnNavBookmarks.subscribe(paintBookmarks)
  const storage = (event) => { if (event.key === TURN_NAV_BOOKMARK_KEY) turnNavBookmarks.reload() }
  const attached = new Map()
  const live = () => {
    for (const [nav, controller] of attached) {
      if (nav.isConnected) continue
      controller.detach()
      attached.delete(nav)
    }
    return [...attached.values()]
  }
  const adopt = (event) => {
    const nav = event.target instanceof Element ? event.target.closest('nav[aria-label]') : null
    if (nav === null || attached.has(nav) || !nav.matches(TURN_NAV_SELECTOR)) return
    live()
    attached.set(nav, turnNavAttach(nav, env))
    // 会话打开时停在其他会话页面，停靠条里的检查看不出来，换到对话页也不会再查；第一次接上这条轨道时拿它再查一次。
    turnNavReport(turnNavCheck(turnNavSeen(nav, app.clock('chat.turnNavigation.label'))))
  }
  const escape = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    for (const controller of live()) if (!controller.nav.contains(document.activeElement)) controller.escape(event)
  }
  document.addEventListener('pointerover', adopt, true)
  document.addEventListener('focusin', adopt, true)
  document.addEventListener('keydown', escape)
  window.addEventListener('storage', storage)
  return () => {
    for (const dispose of menus) dispose()
    unsubscribe()
    unsheet()
    document.removeEventListener('pointerover', adopt, true)
    document.removeEventListener('focusin', adopt, true)
    document.removeEventListener('keydown', escape)
    window.removeEventListener('storage', storage)
    for (const controller of attached.values()) controller.detach()
    attached.clear()
  }
}

// ---------- 插件页这一行的配置 ----------

/**
 * 生效状态的一句话。
 * @param {Function} t 词典。
 * @param {{state: string, reason?: string}} status 生效状态。
 * @returns {string} 插件页上显示的话。
 */
function turnNavStatusText(t, status) {
  if (status.state === 'ok') return t('turnNav.status.ok')
  if (status.state === 'mismatch') return t('turnNav.status.mismatch', { why: t(`turnNav.why.${status.reason}`) })
  return t('turnNav.status.waiting')
}

/**
 * plugins.row.config 的条目：summary 和配置页都写这一行生没生效。
 * @param {{app: object, view: string}} props 插槽属性加入口上下文。
 * @returns {unknown} React 节点或文字。
 */
function TurnNavConfigEntry(props) {
  const { app, view } = props
  const status = React.useSyncExternalStore(turnNavStatus.subscribe, turnNavStatus.getSnapshot)
  const line = turnNavStatusText(app.t, status)
  if (view === 'summary') return line
  return h('div', { className: 'dwb-notify-page' },
    h('p', { className: 'dwb-notify-hint', role: 'status' }, line))
}

// ---------- 挂载 ----------

/**
 * 挂载本功能。插件页的配置页总是挂，好说明生没生效。DSH 的样式表对得上才挂停靠条里的检查；样式和轨道的控制器跟着检查的结论走：
 * 没查出对不上就挂着，查出对不上就撤掉，再查到对得上又装回来。卡片的定位只在 DSH 的卡片定位对得上时一起挂，对不上时控制台说一次，别的照常。返回撤销函数。
 * @param {{ctx: object, t: Function, clock: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
export function applyTurnNav(app) {
  const { ctx } = app
  turnNavStatus.reset()
  turnNavWarned.clear()
  const disposers = [ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    { name: 'plugins.row.config', key: '@miint-sunny/dsh-workbench#dsh-workbench-turn-nav', locale: '@miint-sunny/dsh-workbench' },
    (props) => h(TurnNavConfigEntry, { app, ...props })))]
  const dshStyle = typeof document === 'undefined' ? null : document.querySelector(`style[data-plugin-css="${TURN_NAV_DSH_STYLE}"]`)
  if (!turnNavStyleMatches(dshStyle?.textContent ?? null)) {
    turnNavReport({ state: 'mismatch', reason: 'style' })
  } else {
    const css = turnNavPreviewPlaceMatches(dshStyle.textContent) ? TURN_NAV_CSS + TURN_NAV_PLACE_CSS : TURN_NAV_CSS
    if (css === TURN_NAV_CSS) console.warn(`dsh-workbench/turn-nav: DSH's turn preview no longer positions from ${TURN_NAV_PREVIEW_CENTER}; the preview keeps DSH's placement.`)
    disposers.push(ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'dsh-workbench-turn-nav', order: 101, locale: '@miint-sunny/dsh-workbench' },
      props => h(TurnNavDock, { ...props, app }))))
    /** 挂着的样式和控制器的撤销函数；没挂时 null。 */
    let active = null
    const follow = () => {
      const off = turnNavStatus.getSnapshot().state === 'mismatch'
      if (off && active !== null) {
        const dispose = active
        active = null
        dispose()
      } else if (!off && active === null) {
        const unstyle = mountModuleStyle('dsh-workbench-turn-nav', css)
        const unwire = turnNavWire(app)
        active = () => { unwire(); unstyle() }
      }
    }
    follow()
    disposers.push(turnNavStatus.subscribe(follow))
    disposers.push(() => {
      active?.()
      active = null
    })
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

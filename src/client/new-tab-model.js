/** 入口的分组与常用顺序只描述已注册的 kind，不创建或隐藏第三方入口。 */
const NEW_TAB_GROUPS = {
  workspace: ['files', 'git', 'wbreview', 'forge-panel', 'browser', 'terminal'],
  conversation: ['subagent', 'sidechat', 'wbsplit'],
  inspect: ['wbcontext', 'wbdesign', 'session-inspector-log'],
  settings: ['wbmcp', 'wbrules'],
}
const NEW_TAB_LAYOUTS = ['common', 'list', 'columns']
const NEW_TAB_STORAGE = 'dsh-workbench.new-tab.layout.v1'
const LEGACY_LOCAL_REVIEW_PIN = JSON.stringify(['wblocalreview', 'dsh-workbench-local-review', 'local-review'])
const REVIEW_PANEL_PIN = JSON.stringify(['wbreview', 'dsh-workbench-review-panel', 'review'])

export const NEW_TAB_PIN_LIMIT = 8
export const NEW_TAB_DEFAULT_PINS = Object.freeze(['files', 'git', 'browser', 'sidechat'])
export const NEW_TAB_PINS_STORAGE = 'dsh-workbench.new-tab.pins.v1'
/** 官方引导页这种标签的注册 id，官方 README 写明了这个值。 */
export const NEW_TAB_GUIDE_TYPE = '@deepseek-ai/dsh-client-ui-sidebar-right/guide'

/**
 * 新标签页这时该不该关。官方只在格里没有引导页时才画加号，留一个不在最前面的引导页，加号就没了。
 * @param {{visible: boolean, selected: string|null|undefined}} input 标签是否在屏幕上（右侧栏展开、会话在前台），和标签 aria-selected 的值。
 * @returns {boolean} 明确不在最前面才是 true；浮窗的标题栏和看不出来的情况都不动。
 */
export function guideTabShouldClose({ visible, selected }) {
  return visible && selected === 'false'
}

/** The registry owns guide identity even when a provider is absent in this session. */
export function newTabEntryPin(entry) {
  return JSON.stringify([entry.kind, entry.providerId, entry.id])
}

function validNewTabPin(pin) {
  if (NEW_TAB_DEFAULT_PINS.includes(pin)) return true
  if (typeof pin !== 'string') return false
  try {
    const identity = JSON.parse(pin)
    return Array.isArray(identity) && identity.length === 3 &&
      identity.every(part => typeof part === 'string' && part.trim() !== '') &&
      JSON.stringify(identity) === pin
  } catch { return false }
}

/** Pull visible pins out only in Frequent. Absent registrations keep their positions. */
export function groupNewTabEntries(entries, layout = 'common', pins = NEW_TAB_DEFAULT_PINS, isExtension = () => false) {
  const ordered = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const favorites = layout === 'common' ? pins.flatMap(pin => {
    const entry = ordered.find(row => NEW_TAB_DEFAULT_PINS.includes(pin) ? row.kind === pin : newTabEntryPin(row) === pin)
    return entry ? [{ pin, entry }] : []
  }) : []
  const selected = new Set(favorites.map(({ entry }) => entry))
  const groups = [...Object.keys(NEW_TAB_GROUPS), 'other'].map(id => ({ id, entries: [] }))
  for (const entry of ordered) {
    if (selected.has(entry)) continue
    const id = Object.keys(NEW_TAB_GROUPS).find(group => NEW_TAB_GROUPS[group].includes(entry.kind))
      ?? (isExtension(entry.kind) ? 'conversation' : 'other')
    groups.find(group => group.id === id).entries.push(entry)
  }
  return { favorites, hidden: layout === 'common' ? pins.length - favorites.length : 0, groups: groups.filter(group => group.entries.length) }
}

export function addNewTabPin(pins, pin) {
  if (pins.length >= NEW_TAB_PIN_LIMIT || pins.includes(pin) || pins.includes(JSON.parse(pin)[0])) return pins
  return [...pins, pin]
}

export function removeNewTabPin(pins, pin) {
  return pins.includes(pin) ? pins.filter(current => current !== pin) : pins
}

export function moveNewTabPin(pins, pin, target) {
  const from = pins.indexOf(pin), to = pins.indexOf(target)
  if (from < 0 || to < 0 || from === to) return pins
  const next = [...pins]
  next.splice(from, 1)
  next.splice(to, 0, pin)
  return next
}

/** Reject unknown bare keys. Recorded provider/entry identities can be temporarily absent. */
export function readNewTabPins(storage = () => globalThis.localStorage) {
  try {
    const pins = JSON.parse(storage().getItem(NEW_TAB_PINS_STORAGE))
    if (Array.isArray(pins) && pins.length <= NEW_TAB_PIN_LIMIT &&
        pins.every(validNewTabPin) && new Set(pins).size === pins.length) {
      return [...new Set(pins.map(pin => pin === LEGACY_LOCAL_REVIEW_PIN ? REVIEW_PANEL_PIN : pin))]
    }
  } catch { /* A broken or unavailable preference uses the defaults. */ }
  return NEW_TAB_DEFAULT_PINS
}

/** One list for all mounted guides. The current window remains usable if storage is blocked. */
export function createNewTabPinStore(storage = () => globalThis.localStorage) {
  let pins = readNewTabPins(storage)
  const listeners = new Set()
  const publish = (next, persist) => {
    if (next.length === pins.length && next.every((pin, index) => pin === pins[index])) return
    pins = next
    if (persist) {
      try { storage().setItem(NEW_TAB_PINS_STORAGE, JSON.stringify(pins)) } catch { /* Keep the in-memory choice. */ }
    }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => pins,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: change => publish(change(pins), true),
    reload: () => publish(readNewTabPins(storage), false),
  }
}

/** Storage access can itself throw before getItem, including in private windows. */
export function readNewTabLayout(storage = () => globalThis.localStorage) {
  try {
    const value = storage().getItem(NEW_TAB_STORAGE)
    return NEW_TAB_LAYOUTS.includes(value) ? value : 'common'
  } catch { return 'common' }
}

/** The view keeps its current choice when this machine cannot persist it. */
export function writeNewTabLayout(value, storage = () => globalThis.localStorage) {
  try { storage().setItem(NEW_TAB_STORAGE, value) } catch { /* Unavailable browser storage leaves the local view usable. */ }
}

/** A null selector result delegates the entire page to DSH's shipped guide. */
export function readNewTabEntries(tabs) {
  try {
    const entries = tabs.guide()
    return Array.isArray(entries) ? entries : null
  } catch { return null }
}

/**
 * 官方「分栏」按钮的新图标（右侧栏标签条右端，`data-dockkit-split-button`）。官方画的是两栏：方框加中线，
 * 像布局状态，又和旁边的「收起右侧边栏」只差一条线的位置。按钮做的其实是一个动作：把这一栏拆成两栏，
 * 新的一栏开新标签页，最多两栏。所以换成「再开一栏」的画法：官方的框和中线，右上角开口放加号。
 * 16 格、1px 线，框的路径取自官方图标，加号的位置照 DSH 组件库的「新建项目」。
 */
// dsh-ui-guard: DSH 没有再开一栏的图标
export const NEW_TAB_SPLIT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000"><path d="M8 14.5V1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V8.5"/><path d="M12 2V7M9.5 4.5H14.5"/></svg>'

/**
 * 把官方「分栏」按钮的图标换成 NEW_TAB_SPLIT_ICON 的样式。只换图标：按钮、提示、快捷键、置灰和指着时的
 * 底色都是官方的，新图标用 currentColor 画，跟着按钮变；大小照官方按钮里的图标（15px）。
 * 两条规则必须同时在：第一条藏官方图标，第二条画新的，少一条按钮就是空的或者两个图标叠在一起。
 * 官方按钮上的标记没了，两条都不生效，官方图标照常显示。
 * @returns {string} 两条样式规则。
 */
export function newTabSplitCss() {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(NEW_TAB_SPLIT_ICON)}") center/15px 15px no-repeat`
  return `
[data-dockkit-split-button]>svg{display:none}
[data-dockkit-split-button]::before{content:"";flex:none;width:15px;height:15px;background:currentColor;-webkit-mask:${mask};mask:${mask}}
`
}


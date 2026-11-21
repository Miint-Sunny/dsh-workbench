/**
 * 浏览器视口尺寸（dsh-workbench/browser-viewport）的纯逻辑：尺寸预设、横竖对调、自定义的范围检查、
 * 缩放比例，以及套在网页框上的样式。不碰 DOM，`node --test` 直接可跑；DOM 和界面在 browser-viewport.js。
 *
 * 尺寸的状态：`{ preset: 'auto' }`，或 `{ preset: 'phone' | 'tablet' | 'desktop' | 'custom', width, height }`。
 * 固定尺寸里的 width、height 就是网页看到的视口（已经按方向对调过）。
 *
 * 缩放用 `transform: scale()`，不用 webview 的 `setZoomFactor`（2026-11-17 在 Electron 44 上实测，见 feat#161 的结果）：
 * 两种做法点击、滚轮、键盘焦点都对，但 setZoomFactor 会改设备像素比、视口会差 1 像素、系数有 0.25 的下限、
 * 换域名后要重设；transform 对 iframe 和 webview 是同一套，网页视口精确等于设定值。
 */

/** 自定义尺寸的下限和上限（宽、高都适用）。 */
export const BROWSER_VIEWPORT_MIN = 240
export const BROWSER_VIEWPORT_MAX = 3840
/** 网页框四周留的空：宽、高各减掉这么多再算缩放（每边 8 像素）。 */
export const BROWSER_VIEWPORT_MARGIN = 16

/** 尺寸预设：手机和平板是竖向的，桌面是横向的。 */
export const BROWSER_VIEWPORT_PRESETS = Object.freeze([
  Object.freeze({ id: 'phone', width: 375, height: 812 }),
  Object.freeze({ id: 'tablet', width: 768, height: 1024 }),
  Object.freeze({ id: 'desktop', width: 1280, height: 800 }),
])

/** 默认：自动，网页和卡片一样大，一切照官方的样子。 */
export const BROWSER_VIEWPORT_AUTO = Object.freeze({ preset: 'auto' })

/** 套在网页框（webview 或 iframe）上的样式键；还原时逐个清掉，不动官方原有的 display、border 等。 */
export const BROWSER_VIEWPORT_FRAME_KEYS = Object.freeze(['position', 'left', 'top', 'flex', 'width', 'height', 'transform', 'transformOrigin'])
/** 套在网页框外面那层容器上的样式键。 */
export const BROWSER_VIEWPORT_CONTAINER_KEYS = Object.freeze(['position', 'overflow'])

/** 是固定尺寸（有宽高）而不是自动。 */
function browserViewportFixed(state) {
  return state !== undefined && state !== null && state.preset !== 'auto' && Number.isFinite(state.width) && Number.isFinite(state.height)
}

/**
 * 选一个预设，得到它原本方向的尺寸。
 * @param {string} id 'auto'、'phone'、'tablet' 或 'desktop'。
 * @returns {object | undefined} 尺寸状态；自定义要给宽高（browserViewportCustom），未知的名字也没有。
 */
export function browserViewportPreset(id) {
  if (id === 'auto') return BROWSER_VIEWPORT_AUTO
  const preset = BROWSER_VIEWPORT_PRESETS.find(item => item.id === id)
  return preset === undefined ? undefined : { preset: preset.id, width: preset.width, height: preset.height }
}

/**
 * 现在是竖向还是横向：宽大于高是横向，其余（含正方形）是竖向。
 * @param {object} state 尺寸状态。
 * @returns {'portrait' | 'landscape' | undefined} 自动时没有方向。
 */
export function browserViewportOrientation(state) {
  if (!browserViewportFixed(state)) return undefined
  return state.width > state.height ? 'landscape' : 'portrait'
}

/**
 * 横竖对调：不是要的方向就把宽和高互换，预设名不变；已经是那个方向、或者是自动时原样返回。
 * @param {object} state 尺寸状态。
 * @param {'portrait' | 'landscape'} orientation 要的方向。
 * @returns {object} 新状态（没变时就是原对象）。
 */
export function browserViewportOrient(state, orientation) {
  const current = browserViewportOrientation(state)
  if (current === undefined || current === orientation) return state
  return { ...state, width: state.height, height: state.width }
}

/** 一个输入框的内容：只收十进制整数的数字，再看范围。 */
function browserViewportDimension(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return { error: 'integer' }
  const trimmed = String(text).trim()
  if (!/^[0-9]+$/.test(trimmed)) return { error: 'integer' }
  const value = Number(trimmed)
  return value >= BROWSER_VIEWPORT_MIN && value <= BROWSER_VIEWPORT_MAX ? { value } : { error: 'range' }
}

/**
 * 自定义尺寸：宽和高都要是 240 到 3840 的整数。有一个不对就不改尺寸，错误按宽、高分别给出。
 * @param {string} widthText 宽输入框的内容。
 * @param {string} heightText 高输入框的内容。
 * @returns {{ ok: true, state: object } | { ok: false, errors: { width?: 'integer' | 'range', height?: 'integer' | 'range' } }} 结果。
 */
export function browserViewportCustom(widthText, heightText) {
  const width = browserViewportDimension(widthText)
  const height = browserViewportDimension(heightText)
  if (width.error === undefined && height.error === undefined) {
    return { ok: true, state: { preset: 'custom', width: width.value, height: height.value } }
  }
  const errors = {}
  if (width.error !== undefined) errors.width = width.error
  if (height.error !== undefined) errors.height = height.error
  return { ok: false, errors }
}

/**
 * 缩放比例：卡片内容区去掉留白后，把视口放进去所需的比例，取宽、高里更紧的那个，最大 1（不放大）。
 * @param {object} state 尺寸状态。
 * @param {{ width: number, height: number }} container 卡片内容区的大小（CSS 像素）。
 * @param {number} [margin] 留白。
 * @returns {number | undefined} 比例；自动、或卡片还没有大小（藏着、还没排版）时 undefined。
 */
export function browserViewportFit(state, container, margin = BROWSER_VIEWPORT_MARGIN) {
  if (!browserViewportFixed(state)) return undefined
  const availableWidth = Number(container?.width) - margin
  const availableHeight = Number(container?.height) - margin
  if (!(availableWidth > 0) || !(availableHeight > 0)) return undefined
  return Math.min(availableWidth / state.width, availableHeight / state.height, 1)
}

/**
 * 缩放比例写成百分数：四舍五入成整数，最小显示 1%。
 * @param {number} scale 比例。
 * @returns {number} 百分数。
 */
export function browserViewportPercent(scale) {
  return Math.max(1, Math.round(scale * 100))
}

/**
 * 套在网页框上的样式：框按视口的宽高排版，居中，再按比例缩小。元素的排版尺寸就是网页的视口，
 * transform 不改排版，所以网页里的 innerWidth × innerHeight 精确等于设定值，设备像素比也不变。
 * @param {object} state 尺寸状态。
 * @param {number | undefined} scale 缩放比例。
 * @returns {Record<string, string> | undefined} 样式（键见 BROWSER_VIEWPORT_FRAME_KEYS）；自动或没有比例时 undefined。
 */
export function browserViewportFrameStyle(state, scale) {
  if (!browserViewportFixed(state) || !Number.isFinite(scale) || !(scale > 0)) return undefined
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    flex: 'none',
    width: `${state.width}px`,
    height: `${state.height}px`,
    transform: `translate(-50%, -50%) scale(${Number(scale.toFixed(6))})`,
    transformOrigin: 'center',
  }
}

/**
 * 网页框外面那层容器的样式：作绝对定位的参照，并裁掉溢出。
 * @returns {Record<string, string>} 样式（键见 BROWSER_VIEWPORT_CONTAINER_KEYS）。
 */
export function browserViewportContainerStyle() {
  return { position: 'relative', overflow: 'hidden' }
}

/**
 * 「视口尺寸」菜单的各项：自动、手机、平板、桌面、自定义；打勾的是当前的预设（横竖对调后仍是它）。
 * 预设一项带它本来的宽高，不随横竖变。
 * @param {object} state 尺寸状态。
 * @returns {{ id: string, width?: number, height?: number, checked: boolean }[]} 菜单项。
 */
export function browserViewportMenuItems(state) {
  const selected = state?.preset ?? 'auto'
  return [
    { id: 'auto', checked: selected === 'auto' },
    ...BROWSER_VIEWPORT_PRESETS.map(item => ({ id: item.id, width: item.width, height: item.height, checked: selected === item.id })),
    { id: 'custom', checked: selected === 'custom' },
  ]
}

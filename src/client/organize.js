/**
 * 会话整理（dsh-workbench/organize 的网页部分，计划第 9 项，样稿「会话整理」A–D）：
 * 给会话打颜色标签、标为未读，侧边栏多一个「会话」页（按日期或标签分组、筛选、批量打
 * 标签、改标签名字）。数据存宿主（organize.json，路由 /api/dsh-workbench.organize），
 * 这里是缓存加订阅：写走 POST 用回答更新；窗口重新获得焦点、连接重置时重读一次。
 *
 * 会话行菜单用 0.2.2 的 ctx.contextMenus（旧的 sidebar.workspaces.session.menu.item
 * 槽只兼容渲染、不再按 order 插位，不用），order 320 排在官方「分叉」（300）后面、
 * 「复制 Session ID」（450）前面。contextMenus 的动作没有「当前项打勾」的字段，当前
 * 标签的点旁带组件库的勾（放在图标元数据 icon.current 里，图标组件读它）。行首圆点
 * 挂 sidebar.session.row.leading：DSH 在
 * 行上有状态点（进行中、等待审批、完成未读）时自己画状态点、不渲染这个插槽，标签点
 * 自动藏起来（不用处理）；标签名同时写在悬停卡片（sidebar.session.row.hover）里。
 *
 * 「标为未读」是本功能自己的标记（蓝点、外圈高亮）：DSH 没有给插件改「完成未读」的
 * 接口。会话成为主对话区的会话（retainedBy.mainView 大于 0）并且标了未读时，停留
 * 1 秒后清除（unreadToClear 纯函数，判断都在 watcher 里，不在渲染里发请求）。
 *
 * 每个功能行一个模块，由 scripts/build-client.mjs 按顺序拼进 lib/client.js：模块之间
 * 共用同一个作用域，所以本模块的顶层名字都带 Organize/ORGANIZE 标记，不能和别的模块
 * 重名（test/client-bundle.test.mjs 查这一条）。
 */
import { listedSessions, mainViewSessionId, sessionStatusKey, sessionWorkspaceName } from './features.js'
import { mountModuleStyle } from './style.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重）；名字都在 0.2.2-rc.1 上验证过存在。 */
const ORGANIZE_INJECT = ['contextMenus', 'layout', 'uiWorkspace']

/** 本功能的中文界面文字；键以 `organize.` 开头。有 DSH 叫法的照 DSH 写（搜索会话、
 * 未分组、取消全选、无匹配会话、取消筛选、全选、完成、全部），DSH 没有的
 * 写进仓库根目录 ui-guard.json 的 allow.terms 并写原因。状态词在 copy.js（session.status.*），和侧边对话共用。 */
const ORGANIZE_ZH = {
  'organize.panel': '会话',
  'organize.page.search': '搜索会话',
  'organize.page.byDate': '按日期',
  'organize.page.byLabel': '按标签',
  'organize.page.chipAll': '全部',
  'organize.none': '未分组',
  'organize.unread': '未读',
  'organize.selectAll': '全选',
  'organize.page.manage': '管理标签',
  'organize.page.manageDone': '完成',
  'organize.page.manageHint': '仅可修改名称，颜色固定。',
  'organize.page.manageCount': '{n} 个会话',
  'organize.page.nameEmpty': '名称不能为空',
  'organize.page.nameDup': '名称不能重复',
  'organize.page.nameTooLong': '名称最长 20 个字符',
  'organize.page.selected': '已选 {n} 个',
  'organize.page.setLabel': '设置标签',
  'organize.page.clearLabel': '清除标签',
  'organize.page.clearSelection': '取消全选',
  'organize.page.writeFailed': '保存失败：{message}',
  'organize.page.retry': '重试',
  'organize.page.empty': '无匹配会话',
  'organize.page.clearFilter': '取消筛选',
  'organize.page.corrupt': '标签数据读取失败：organize.json 不是有效的 JSON。会话列表不受影响，暂不显示标签。',
  'organize.page.loadFailed': '读取失败：{message}。会话列表不受影响，暂不显示标签。',
  'organize.page.group.today': '今天',
  'organize.page.group.yesterday': '昨天',
  'organize.page.group.thisWeek': '本周',
  'organize.page.group.earlier': '更早',
  'organize.page.rowAria': '打开会话「{name}」',
  'organize.menu.setLabel': '设置标签',
  'organize.menu.clearLabel': '清除标签',
  'organize.menu.markUnread': '标为未读',
  'organize.menu.unmarkUnread': '取消未读标记',
  'organize.hover.label': '标签：{name}',
  'organize.hover.unread': '已标为未读',
  'organize.time.yesterday': '昨天',
  'organize.time.date': '{month} 月 {day} 日',
}

/** 本功能的英文界面文字，键和 ORGANIZE_ZH 一一对应。 */
const ORGANIZE_EN = {
  'organize.panel': 'Sessions',
  'organize.page.search': 'Search sessions',
  'organize.page.byDate': 'By date',
  'organize.page.byLabel': 'By label',
  'organize.page.chipAll': 'All',
  'organize.none': 'Ungrouped',
  'organize.unread': 'Unread',
  'organize.selectAll': 'Select all',
  'organize.page.manage': 'Manage labels',
  'organize.page.manageDone': 'Done',
  'organize.page.manageHint': 'Only names can be changed; colors are fixed.',
  'organize.page.manageCount': '{n} sessions',
  'organize.page.nameEmpty': 'The name cannot be empty',
  'organize.page.nameDup': 'The name must be unique',
  'organize.page.nameTooLong': 'Names are at most 20 characters',
  'organize.page.selected': '{n} selected',
  'organize.page.setLabel': 'Set label',
  'organize.page.clearLabel': 'Clear label',
  'organize.page.clearSelection': 'Deselect all',
  'organize.page.writeFailed': 'Save failed: {message}',
  'organize.page.retry': 'Retry',
  'organize.page.empty': 'No matching sessions',
  'organize.page.clearFilter': 'Clear filter',
  'organize.page.corrupt': 'Label data could not be read: organize.json is not valid JSON. The session list is not affected; labels are hidden.',
  'organize.page.loadFailed': 'Could not read: {message}. The session list is not affected; labels are hidden.',
  'organize.page.group.today': 'Today',
  'organize.page.group.yesterday': 'Yesterday',
  'organize.page.group.thisWeek': 'This week',
  'organize.page.group.earlier': 'Earlier',
  'organize.page.rowAria': 'Open session "{name}"',
  'organize.menu.setLabel': 'Set label',
  'organize.menu.clearLabel': 'Clear label',
  'organize.menu.markUnread': 'Mark as unread',
  'organize.menu.unmarkUnread': 'Clear unread mark',
  'organize.hover.label': 'Label: {name}',
  'organize.hover.unread': 'Marked as unread',
  'organize.time.yesterday': 'Yesterday',
  'organize.time.date': '{month}/{day}',
}

/** 标签 id（和宿主 lib/organize-state.js 的 LABEL_IDS 一致，改的时候一起改）。 */
const ORGANIZE_LABEL_IDS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']

/** 标签的默认名字（和宿主的 DEFAULT_LABEL_NAMES 一致，改的时候一起改）。 */
const ORGANIZE_DEFAULT_NAMES = {
  red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色',
}

/** 标签点和未读点的颜色（照第三批样稿的取色；未读点用蓝）。 */
const ORGANIZE_LABEL_COLORS = {
  red: '#e5484d', orange: '#f5822a', yellow: '#e5b800', green: '#30a46c', blue: '#3b82f6', purple: '#8e4ec6',
}

/** 未读点的外圈高亮颜色。 */
const ORGANIZE_UNREAD_RING = 'color-mix(in srgb,var(--dsw-alias-link) 35%,transparent)'

/** 侧边栏面板的 id，也是 `main` 页面的 key。 */
const ORGANIZE_PANEL_ID = 'dsh-workbench-organize'

/** Optional filters own their views and can disappear independently of the organizer. */
let organizeExtraFilters = []
const organizeFilterListeners = new Set()
const organizeFilterSource = {
  getSnapshot: () => organizeExtraFilters,
  subscribe: listener => { organizeFilterListeners.add(listener); return () => organizeFilterListeners.delete(listener) },
}
export function registerOrganizeFilter(filter) {
  if (organizeExtraFilters.some(item => item.id === filter.id)) throw new Error(`Duplicate session filter: ${filter.id}`)
  const notify = () => { for (const listener of organizeFilterListeners) listener() }
  organizeExtraFilters = [...organizeExtraFilters, filter]; notify()
  return () => { organizeExtraFilters = organizeExtraFilters.filter(item => item !== filter); notify() }
}

// ---------- 纯函数（测试直接 import） ----------

/** 客户端起手的默认状态（真正的状态从宿主读；和宿主 defaultOrganizeState 一致）。 */
export function organizeDefaultClientState() {
  return {
    version: 1,
    labels: ORGANIZE_LABEL_IDS.map(id => ({ id, name: ORGANIZE_DEFAULT_NAMES[id] })),
    assignments: {},
    unread: [],
  }
}

/** 接口回答的状态能不能用（最低限度的形状检查，防版本错位时整页崩掉）。 */
export function organizeStateOk(value) {
  return typeof value === 'object' && value !== null
    && Array.isArray(value.labels) && value.labels.length === ORGANIZE_LABEL_IDS.length
    && typeof value.assignments === 'object' && value.assignments !== null
    && Array.isArray(value.unread)
}

/**
 * 会话条目并上标签和未读（之后分组、筛选、画点都只看行对象）。
 * @param {object[]} entries listedSessions 的结果。
 * @param {{assignments?: Record<string, string>, unread?: string[]}} state organize 状态。
 * @returns {{id: string, labelId: string | null, unread: boolean}[]} 行对象。
 */
export function organizeRows(entries, state) {
  const assignments = state?.assignments ?? {}
  const unread = new Set(state?.unread ?? [])
  return entries.map(entry => ({ ...entry, labelId: assignments[entry.id] ?? null, unread: unread.has(entry.id) }))
}

/**
 * 筛选 chip 的选择。
 * @typedef {{kind: 'all' | 'unread' | 'none'} | {kind: 'label', labelId: string}} OrganizeFilter
 */

/**
 * 搜索词加 chip 之后的可见行。搜索先筛（chip 上的数量按搜索后的集合算），chip 再筛。
 * @param {object[]} rows organizeRows 的结果。
 * @param {{query?: string, filter?: OrganizeFilter}} options 搜索词和 chip 选择。
 * @returns {object[]} 可见行。
 */
export function organizeVisible(rows, { query, filter = { kind: 'all' } } = {}) {
  const needle = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : ''
  return rows.filter(row => {
    if (needle !== '') {
      const title = typeof row.displayTitle === 'string' ? row.displayTitle.toLowerCase() : ''
      if (!title.includes(needle) && !sessionWorkspaceName(row.cwd).toLowerCase().includes(needle)) return false
    }
    if (filter.kind === 'label') return row.labelId === filter.labelId
    if (filter.kind === 'unread') return row.unread === true
    if (filter.kind === 'none') return row.labelId === null
    return true
  })
}

/**
 * 各 chip 的数量（按搜索词筛过、chip 没筛的集合算）：全部、各标签、未读、无标签。
 * @param {object[]} rows organizeRows 的结果。
 * @returns {Record<string, number>} 数量表，键是 'all'、六个标签 id、'unread'、'none'。
 */
export function organizeCounts(rows) {
  const counts = { all: rows.length, unread: 0, none: 0 }
  for (const id of ORGANIZE_LABEL_IDS) counts[id] = 0
  for (const row of rows) {
    if (row.unread) counts.unread += 1
    if (row.labelId === null) counts.none += 1
    else if (counts[row.labelId] !== undefined) counts[row.labelId] += 1
  }
  return counts
}

/**
 * 按日期分组（本地时区）：今天、昨天、本周（周一起）、更早。四个组都返回，空的由
 * 页面跳过；组内保持输入顺序（调用方已按从新到旧排）。
 * @param {object[]} entries 会话条目。
 * @param {number} now 当前时间（毫秒）。
 * @returns {{key: 'today' | 'yesterday' | 'thisWeek' | 'earlier', entries: object[]}[]} 四个组。
 */
export function groupByDate(entries, now) {
  const groups = { today: [], yesterday: [], thisWeek: [], earlier: [] }
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const week = new Date(today)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  const startOfToday = today.getTime()
  const startOfYesterday = yesterday.getTime()
  const startOfWeek = week.getTime()
  for (const entry of entries) {
    const at = typeof entry.updatedAt === 'number' ? entry.updatedAt : Number(entry.updatedAt)
    if (at >= startOfToday) groups.today.push(entry)
    else if (at >= startOfYesterday) groups.yesterday.push(entry)
    else if (at >= startOfWeek) groups.thisWeek.push(entry)
    else groups.earlier.push(entry)
  }
  return [
    { key: 'today', entries: groups.today },
    { key: 'yesterday', entries: groups.yesterday },
    { key: 'thisWeek', entries: groups.thisWeek },
    { key: 'earlier', entries: groups.earlier },
  ]
}

/**
 * 按标签分组：每个标签一组（labels 的顺序），没标签的最后一组。
 * @param {object[]} entries 会话条目（带 labelId 的行对象，或自己带 labelId 字段的对象）。
 * @param {{id: string}[]} labels 状态里的标签。
 * @returns {{key: string | null, entries: object[]}[]} 各组。
 */
export function groupByLabel(entries, labels) {
  const groups = [...(labels ?? []).map(label => ({ key: label.id, entries: [] })), { key: null, entries: [] }]
  const byKey = new Map(groups.map(group => [group.key, group]))
  for (const entry of entries) {
    const group = byKey.get(entry.labelId ?? null)
    if (group !== undefined) group.entries.push(entry)
  }
  return groups
}

/**
 * 行尾时间的各部分：今天写 HH:mm，昨天写「昨天」，更早写「M 月 D 日」（文字由页面过词典）。
 * @param {number} updatedAt 会话的最近活动时间（毫秒）。
 * @param {number} now 当前时间（毫秒）。
 * @returns {{kind: 'today', hh: string, mm: string} | {kind: 'yesterday'} | {kind: 'date', month: number, day: number}} 时间各部分。
 */
export function organizeTimeParts(updatedAt, now) {
  const at = new Date(updatedAt)
  const current = new Date(now)
  const sameDay = at.getFullYear() === current.getFullYear() && at.getMonth() === current.getMonth() && at.getDate() === current.getDate()
  if (sameDay) {
    return { kind: 'today', hh: String(at.getHours()).padStart(2, '0'), mm: String(at.getMinutes()).padStart(2, '0') }
  }
  const yesterday = new Date(current)
  yesterday.setDate(yesterday.getDate() - 1)
  if (at.getFullYear() === yesterday.getFullYear() && at.getMonth() === yesterday.getMonth() && at.getDate() === yesterday.getDate()) {
    return { kind: 'yesterday' }
  }
  return { kind: 'date', month: at.getMonth() + 1, day: at.getDate() }
}

/**
 * 主对话区换会话之后要不要清哪个会话的未读：新的主会话和上一次不同、并且标了未读时
 * 返回它（停满 1 秒由 watcher 把关），否则 undefined。起步时上一个是 undefined，打开
 * 的就是标了未读的会话也会清。
 * @param {string | undefined} prevMainId 上一次的主会话 id。
 * @param {string | undefined} nextMainId 这一次的主会话 id。
 * @param {Set<string>} unreadSet 标了未读的会话集合。
 * @returns {string | undefined} 要清的会话 id。
 */
export function unreadToClear(prevMainId, nextMainId, unreadSet) {
  if (nextMainId === undefined || nextMainId === prevMainId) return undefined
  return unreadSet.has(nextMainId) ? nextMainId : undefined
}

/**
 * 改标签名字的本地预检（宿主还会再校验一遍）：返回失败码或 undefined。
 * @param {unknown} name 输入的名字。
 * @param {{id: string, name: string}[]} labels 状态里的标签。
 * @param {string} labelId 正在改的标签。
 * @returns {'organize.page.nameEmpty' | 'organize.page.nameDup' | 'organize.page.nameTooLong' | undefined} 词典键。
 */
export function organizeRenameProblem(name, labels, labelId) {
  if (typeof name !== 'string') return 'organize.page.nameEmpty'
  const trimmed = name.trim()
  if (trimmed === '') return 'organize.page.nameEmpty'
  if (trimmed.length > 20) return 'organize.page.nameTooLong'
  const clash = (labels ?? []).some(label => label.id !== labelId && label.name === trimmed)
  return clash ? 'organize.page.nameDup' : undefined
}

/**
 * 会话行菜单的动作（纯函数，resolve 只管取状态和调它）：「设置标签」（六个颜色的子菜单
 * 加「清除标签」，当前的标签点旁带组件库的勾、没标签时置灰）和「标为未读」（已标着时写
 * 「取消未读标记」）。每一项都带 icon: { key }，图标组件在 applyOrganize 里给 key 注册。
 * @param {{labels: {id: string, name: string}[], assignments: Record<string, string>, unread: string[]}} state organize 状态。
 * @param {(key: string, params?: object) => string} t 词典。
 * @param {string} sessionId 会话 id。
 * @param {(op: object) => void} apply 往宿主发一个写操作。
 * @returns {object[]} contextMenus 的动作数组。
 */
export function organizeMenuActions(state, t, sessionId, apply) {
  const current = state.assignments[sessionId] ?? null
  const marked = state.unread.includes(sessionId)
  const children = state.labels.map(label => ({
    id: `label-${label.id}`,
    label: label.name,
    icon: { key: `dsh-workbench.label.${label.id}`, ...(label.id === current ? { current: true } : {}) },
    run: () => { if (label.id !== current) apply({ op: 'setLabel', sessionIds: [sessionId], labelId: label.id }) },
  }))
  children.push({
    id: 'clear-label',
    label: t('organize.menu.clearLabel'),
    icon: { key: 'dsh-workbench.organize.clear' },
    separatorBefore: true,
    ...(current === null ? { disabled: true } : {}),
    run: () => { apply({ op: 'setLabel', sessionIds: [sessionId], labelId: null }) },
  })
  return [
    {
      id: 'set-label',
      label: t('organize.menu.setLabel'),
      icon: { key: 'dsh-workbench.organize.labels' },
      children,
    },
    {
      id: 'mark-unread',
      label: t(marked ? 'organize.menu.unmarkUnread' : 'organize.menu.markUnread'),
      icon: { key: 'dsh-workbench.organize.unreadmark' },
      run: () => { apply({ op: 'setUnread', sessionIds: [sessionId], unread: !marked }) },
    },
  ]
}

// ---------- 数据层 ----------

/** 默认的接口调用（测试注入假的替换）。 */
async function organizeFetchJson(path, init) {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => undefined)
  return { status: response.status, body }
}

/**
 * 客户端的数据层：宿主是真身，这里是缓存加订阅。写走 POST、用回答里的新状态更新；
 * 读失败保留上一份状态并带 error（'corrupt' 或 { message }）。快照身份稳定：状态和
 * 错误都没变就不换对象，订阅者不被多叫。
 * @param {(path: string, init?: object) => Promise<{status: number, body: unknown}>} [fetchJson] 接口调用（测试注入）。
 * @returns {{getSnapshot: () => {state: object, error: unknown}, subscribe: (fn: () => void) => () => void, load: () => Promise<void>, apply: (op: object) => Promise<{ok: boolean, code?: string, message?: string}>}} 可观察的存储。
 */
export function createOrganizeStore(fetchJson = organizeFetchJson) {
  let state = organizeDefaultClientState()
  let error = undefined
  let snapshot = { state, error }
  const listeners = new Set()
  const publish = () => {
    const next = { state, error }
    if (next.state === snapshot.state && Object.is(next.error, snapshot.error)) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async load() {
      try {
        const { body } = await fetchJson('api/dsh-workbench.organize', { method: 'GET' })
        if (body?.ok === true && organizeStateOk(body.state)) {
          state = body.state
          error = undefined
        } else if (body?.ok === false && body.reason === 'corrupt' && organizeStateOk(body.state)) {
          state = body.state
          error = 'corrupt'
        } else {
          error = { message: `HTTP ${String(typeof body?.ok)}` }
        }
      } catch (caught) {
        // 网络/断线：保留上一份状态，只换错误。
        error = { message: caught instanceof Error ? caught.message : String(caught) }
      }
      publish()
    },
    async apply(op) {
      try {
        const { status, body } = await fetchJson('api/dsh-workbench.organize', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op),
        })
        if (body?.ok === true && organizeStateOk(body.state)) {
          state = body.state
          error = undefined
          publish()
          return { ok: true }
        }
        return { ok: false, ...(body?.code === undefined ? {} : { code: body.code }), message: body?.message ?? `HTTP ${status}` }
      } catch (caught) {
        return { ok: false, message: caught instanceof Error ? caught.message : String(caught) }
      }
    },
  }
}

/**
 * 标为未读的清除看守：主对话区换到标了未读的会话时停 1 秒再清（期间换走就不清）。
 * 判断在 unreadToClear，请求在这里发，不在渲染里。
 * @param {object} deps 依赖：getMainId、getUnreadSet、subscribe(fn)→停订、clear(id)、delayMs、setTimer、clearTimer（后三个测试注入）。
 * @returns {() => void} 停止函数。
 */
export function startOrganizeUnreadWatcher(deps) {
  const delay = deps.delayMs ?? 1000
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  let prev = undefined
  let pending = undefined
  const check = () => {
    const next = deps.getMainId()
    const target = unreadToClear(prev, next, deps.getUnreadSet())
    prev = next
    if (target === undefined) return
    if (pending !== undefined) clearTimer(pending)
    pending = setTimer(() => {
      pending = undefined
      // 停满 1 秒还在主对话区、还标着未读才清；期间换走了或已清掉就不动。
      if (deps.getMainId() !== target || !deps.getUnreadSet().has(target)) return
      void deps.clear(target)
    }, delay)
  }
  const stop = deps.subscribe(check)
  check()
  return () => {
    stop()
    if (pending !== undefined) clearTimer(pending)
  }
}

// ---------- 界面 ----------

/** 入口上下文里的 DSH 客户端上下文、词典和数据层，applyOrganize 时记下（各处组件用）。 */
let organizeCtx
let organizeT
let organizeStore

/** 用模块级数据层订阅一份快照（行首圆点、悬停卡片、页面共用）。 */
function organizeUseStore() {
  const [snapshot, setSnapshot] = useState(() => organizeStore.getSnapshot())
  useEffect(() => organizeStore.subscribe(() => setSnapshot(organizeStore.getSnapshot())), [])
  return snapshot
}

/** 状态里某个标签的名字（读不到时回退到默认名字）。 */
function organizeLabelName(state, labelId) {
  const label = (state?.labels ?? []).find(item => item.id === labelId)
  return label?.name ?? ORGANIZE_DEFAULT_NAMES[labelId] ?? labelId
}

/** 8 像素的实心圆点（行首、悬停卡片、菜单图标、页面行里共用）。 */
function OrganizeDot({ color }) {
  return h('span', { className: 'dwb-og-dot', style: { background: color }, 'aria-hidden': 'true' })
}

/**
 * 行首圆点（样稿 A）：标了未读画蓝点加外圈高亮，否则有标签画标签色点，都没有不画。
 * DSH 在行上有状态点时自己占这个格子、不渲染本插槽，标签点自动藏起来。
 * @param {{sessionId: string}} props 行首插槽属性。
 * @returns {unknown} React 节点。
 */
function OrganizeRowDot({ sessionId }) {
  const { state } = organizeUseStore()
  if (state.unread.includes(sessionId)) {
    return h('span', { className: 'dwb-og-lead' },
      h('span', { className: 'dwb-og-dot dwb-og-dot-unread' }))
  }
  const labelId = state.assignments[sessionId]
  if (labelId === undefined) return null
  return h('span', { className: 'dwb-og-lead' },
    h(OrganizeDot, { color: ORGANIZE_LABEL_COLORS[labelId] }))
}

/**
 * 悬停卡片里的一两行（样稿 A）：有标签写「标签：红色」（带圆点），标了未读写
 * 「已标为未读」，都没有不画。
 * @param {{sessionId: string}} props 悬停插槽属性。
 * @returns {unknown} React 节点。
 */
function OrganizeRowHover({ sessionId }) {
  const { state } = organizeUseStore()
  const labelId = state.assignments[sessionId]
  const unread = state.unread.includes(sessionId)
  if (labelId === undefined && !unread) return null
  return h(Fragment, null,
    labelId === undefined ? null : h('div', { className: 'dwb-og-hover' },
      h(OrganizeDot, { color: ORGANIZE_LABEL_COLORS[labelId] }),
      h('span', null, organizeT('organize.hover.label', { name: organizeLabelName(state, labelId) }))),
    unread ? h('div', { className: 'dwb-og-hover' }, h('span', null, organizeT('organize.hover.unread'))) : null)
}

/** 侧边栏「会话」面板按钮的图标：组件库的 IconFlatListOutlineRegular（一列会话）。 */
function OrganizePanelIcon(props) {
  return h(ui.IconFlatListOutlineRegular, props)
}

/**
 * 会话行菜单里各标签的图标：标签色的圆点（颜色色板，不是图标库的图形）；当前标签在
 * 点旁加组件库的 IconCheckOutlineRegular（contextMenus 的动作没有「当前项」的字段）。
 * @param {{icon?: {current?: boolean}, color: string}} props 图标元数据和标签色。
 * @returns {unknown} React 节点。
 */
function OrganizeMenuLabelIcon({ icon, color }) {
  return h('span', { className: 'dwb-og-micon' },
    h(OrganizeDot, { color }),
    icon?.current === true ? h(ui.IconCheckOutlineRegular, { size: 10 }) : null)
}

/** 会话行菜单「标为未读」的图标：行首同款的未读蓝点（外圈高亮），和列表里看到的同一个记号。 */
function OrganizeMenuUnreadIcon() {
  return h('span', { className: 'dwb-og-micon' }, h('span', { className: 'dwb-og-dot dwb-og-dot-unread' }))
}

/**
 * 「会话」页（样稿 C、D）。搜索、分组方式、筛选 chip、批量打标签、管理标签；点一行
 * （不点复选框）在主对话区打开这个会话。读取失败只影响标签，会话列表照常显示。
 * @param {object} props `main` 插槽属性（useSessions、useSessionStatus、useWorkspaces 等全局钩子）。
 * @returns {unknown} React 节点。
 */
function OrganizePage({ useSessions, useSessionStatus, useWorkspaces }) {
  const t = organizeT
  const list = useSessions(value => value)
  const statuses = useSessionStatus(value => value)
  const archivedIds = useWorkspaces(value => value.archivedSessionIds)
  const snapshot = organizeUseStore()
  const state = snapshot.state
  const [query, setQuery] = useState('')
  const [by, setBy] = useState('date')
  const [filter, setFilter] = useState({ kind: 'all' })
  const [selected, setSelected] = useState(() => new Set())
  const [managing, setManaging] = useState(false)
  const [drafts, setDrafts] = useState(undefined)
  const [nameProblems, setNameProblems] = useState({})
  const [batchFailed, setBatchFailed] = useState(undefined)
  const [batchRetry, setBatchRetry] = useState(undefined)
  const [labelMenuOpen, setLabelMenuOpen] = useState(false)
  const extraFilters = React.useSyncExternalStore(organizeFilterSource.subscribe, organizeFilterSource.getSnapshot)
  const extraFilter = extraFilters.find(item => filter.kind === 'extension' && item.id === filter.id)
  useEffect(() => { if (filter.kind === 'extension' && !extraFilter) setFilter({ kind: 'all' }) }, [filter, extraFilter])
  const rows = useMemo(
    () => organizeRows(listedSessions(list, { archivedIds }), state),
    [list, archivedIds, state],
  )
  const searched = useMemo(() => organizeVisible(rows, { query }), [rows, query])
  const visible = useMemo(() => organizeVisible(searched, { filter: filter.kind === 'extension' ? { kind: 'all' } : filter }), [searched, filter])
  const counts = useMemo(() => organizeCounts(searched), [searched])
  const groups = useMemo(() => (
    by === 'label' ? groupByLabel(visible, state.labels) : groupByDate(visible, Date.now())
  ), [by, visible, state.labels])
  const openManage = () => {
    setDrafts(Object.fromEntries(state.labels.map(label => [label.id, label.name])))
    setNameProblems({})
    setManaging(true)
  }
  const rename = async (labelId, name) => {
    const problem = organizeRenameProblem(name, state.labels, labelId)
    setNameProblems(current => ({ ...current, [labelId]: problem }))
    if (problem !== undefined) return
    const result = await organizeStore.apply({ op: 'renameLabel', labelId, name })
    if (result.ok !== true) {
      const key = result.code === 'name.empty' ? 'organize.page.nameEmpty'
        : result.code === 'name.duplicate' ? 'organize.page.nameDup'
          : result.code === 'name.tooLong' ? 'organize.page.nameTooLong' : undefined
      setNameProblems(current => ({ ...current, [labelId]: key ?? 'organize.page.writeFailed' }))
      if (key === undefined) console.warn(`dsh-workbench/organize: 改名失败：${result.message}`)
    }
  }
  const runBatch = async (op) => {
    setBatchFailed(undefined)
    setBatchRetry(undefined)
    const result = await organizeStore.apply(op)
    if (result.ok !== true) {
      setBatchFailed(result.message ?? String(result.code))
      setBatchRetry(() => () => { void runBatch(op) })
    }
  }
  const toggle = (id) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const openSession = (id) => {
    organizeCtx.uiWorkspace?.openSession(id)
  }
  const row = (entry) => {
    const labelId = entry.labelId
    const unread = entry.unread
    const statusKey = sessionStatusKey(entry, statuses.get(entry.id))
    const time = organizeTimeParts(entry.updatedAt, Date.now())
    const timeText = time.kind === 'today' ? `${time.hh}:${time.mm}`
      : time.kind === 'yesterday' ? t('organize.time.yesterday')
        : t('organize.time.date', { month: String(time.month), day: String(time.day) })
    return h('div', {
      key: entry.id, className: 'dwb-og-row', role: 'button', tabIndex: 0,
      'aria-label': t('organize.page.rowAria', { name: entry.displayTitle }),
      onClick: () => { openSession(entry.id) },
      onKeyDown: (event) => { if (event.key === 'Enter') openSession(entry.id) },
    },
    h('input', {
      type: 'checkbox', className: 'dwb-og-check', checked: selected.has(entry.id),
      'aria-label': entry.displayTitle, tabIndex: -1,
      onClick: (event) => { event.stopPropagation() },
      onChange: () => { toggle(entry.id); setBatchFailed(undefined) },
    }),
    h('span', { className: 'dwb-og-rowdot' },
      unread ? h('span', { className: 'dwb-og-dot dwb-og-dot-unread' })
        : labelId === null ? null : h(OrganizeDot, { color: ORGANIZE_LABEL_COLORS[labelId] })),
    h('span', { className: 'dwb-og-title' }, entry.displayTitle),
    h('span', { className: 'dwb-og-ws' }, sessionWorkspaceName(entry.cwd)),
    statusKey === undefined ? h('span', { className: 'dwb-og-status' })
      : h('span', { className: 'dwb-og-status', 'data-tone': statusKey === 'session.status.running' ? 'running' : 'pending' }, t(statusKey)),
    h('span', { className: 'dwb-og-time' }, timeText))
  }
  const chip = (kind, labelId, labelNode, count, active) => h('button', {
    key: labelId ?? kind, type: 'button', className: 'dwb-og-chip' + (active ? ' on' : ''),
    'aria-pressed': active, onClick: () => { setFilter(kind === 'label' ? { kind, labelId } : { kind }) },
  }, labelNode, h('span', { className: 'dwb-og-chipn' }, String(count)))
  const labelChips = state.labels
    .filter(label => counts[label.id] > 0 || filter.kind === 'label' && filter.labelId === label.id)
    .map(label => chip('label', label.id, h(Fragment, null,
      h(OrganizeDot, { color: ORGANIZE_LABEL_COLORS[label.id] }),
      h('span', null, label.name)), counts[label.id], filter.kind === 'label' && filter.labelId === label.id))
  const groupTitle = (key) => key === null ? t('organize.none')
    : t(`organize.page.group.${key === 'today' || key === 'yesterday' || key === 'thisWeek' || key === 'earlier' ? key : 'earlier'}`)
  const error = snapshot.error
  if (extraFilter) return h(extraFilter.View, { query, onQueryChange: setQuery, onExit: () => setFilter({ kind: 'all' }) })
  return h('div', { className: 'dwb-og-page' },
    h('div', { className: 'dwb-og-bar' },
      h('h4', null, t('organize.panel')),
      h('span', { className: 'dwb-og-grow' }),
      h('div', { className: 'dwb-og-search' },
        h(ui.IconSearchOutlineRegular, { size: 14 }),
        h('input', {
          type: 'text', value: query, placeholder: t('organize.page.search'), 'aria-label': t('organize.page.search'),
          onChange: (event) => { setQuery(event.target.value) },
        })),
      h('div', { className: 'dwb-og-seg', role: 'group', 'aria-label': t('organize.page.byDate') },
        h('button', { type: 'button', className: by === 'date' ? 'on' : '', 'aria-pressed': by === 'date', onClick: () => { setBy('date') } }, t('organize.page.byDate')),
        h('button', { type: 'button', className: by === 'label' ? 'on' : '', 'aria-pressed': by === 'label', onClick: () => { setBy('label') } }, t('organize.page.byLabel')))),
    managing ? h('div', { className: 'dwb-og-manage' },
      h('div', { className: 'dwb-og-bar' },
        h('h4', null, t('organize.page.manage')),
        h('span', { className: 'dwb-og-grow' }),
        h(ui.Button, { variant: 'primary', size: 'sm', onClick: () => { setManaging(false) } }, t('organize.page.manageDone'))),
      h('div', { className: 'dwb-og-manage-rows' }, state.labels.map(label => h('div', { key: label.id, className: 'dwb-og-manage-row' },
        h(OrganizeDot, { color: ORGANIZE_LABEL_COLORS[label.id] }),
        h('input', {
          type: 'text', className: 'dwb-og-manage-input', value: drafts?.[label.id] ?? label.name,
          'aria-label': label.name,
          onChange: (event) => { setDrafts(current => ({ ...current, [label.id]: event.target.value })) },
          onBlur: (event) => { void rename(label.id, event.target.value) },
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); event.target.blur() } },
        }),
        h('span', { className: 'dwb-og-manage-count' }, t('organize.page.manageCount', { n: String(counts[label.id]) })),
        nameProblems[label.id] === undefined ? null
          : h('span', { className: 'dwb-og-manage-problem', role: 'alert' }, t(nameProblems[label.id], { message: '' }))))),
      h('p', { className: 'dwb-og-hint' }, t('organize.page.manageHint'))) : null,
    !managing ? h('div', { className: 'dwb-og-bar' },
      chip('all', undefined, h('span', null, t('organize.page.chipAll')), counts.all, filter.kind === 'all'),
      ...extraFilters.map(item => h('button', { key: item.id, type: 'button', className: 'dwb-og-chip', 'aria-pressed': false,
        onClick: () => { setSelected(new Set()); setFilter({ kind: 'extension', id: item.id }) } }, h(item.Label))),
      ...labelChips,
      counts.unread > 0 || filter.kind === 'unread' ? chip('unread', undefined, h('span', null, t('organize.unread')), counts.unread, filter.kind === 'unread') : null,
      chip('none', undefined, h('span', null, t('organize.none')), counts.none, filter.kind === 'none'),
      h('span', { className: 'dwb-og-grow' }),
      h(ui.Button, { variant: 'outline', size: 'sm', onClick: openManage }, t('organize.page.manage'))) : null,
    selected.size > 0 && !managing ? h('div', { className: 'dwb-og-batch' },
      h('input', {
        type: 'checkbox', className: 'dwb-og-check', checked: selected.size === visible.length,
        'aria-label': t('organize.selectAll'),
        onChange: (event) => { setSelected(event.target.checked ? new Set(visible.map(entry => entry.id)) : new Set()) },
      }),
      h('span', null, t('organize.page.selected', { n: String(selected.size) })),
      h('span', { className: 'dwb-og-grow' }),
      h('span', { className: 'dwb-og-batch-labels' },
        h(ui.Button, { variant: 'outline', size: 'sm', 'aria-expanded': labelMenuOpen, onClick: () => { setLabelMenuOpen(!labelMenuOpen) } },
          t('organize.page.setLabel'), h(ui.IconChevronDownOutlineRegular, { size: 12 })),
        labelMenuOpen ? h('div', { className: 'dwb-og-labelmenu', role: 'menu' },
          state.labels.map(label => h('button', {
            key: label.id, type: 'button', role: 'menuitem', className: 'dwb-og-labelmenu-item',
            onClick: () => {
              setLabelMenuOpen(false)
              void runBatch({ op: 'setLabel', sessionIds: [...selected], labelId: label.id })
            },
          }, h(OrganizeDot, { color: ORGANIZE_LABEL_COLORS[label.id] }), h('span', null, label.name)))) : null),
      h(ui.Button, {
        variant: 'outline', size: 'sm',
        onClick: () => { void runBatch({ op: 'setLabel', sessionIds: [...selected], labelId: null }) },
      }, t('organize.page.clearLabel')),
      h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => { setSelected(new Set()) } }, t('organize.page.clearSelection')),
      batchFailed === undefined ? null : h('span', { className: 'dwb-og-batch-fail', role: 'alert' },
        t('organize.page.writeFailed', { message: batchFailed }),
        h(ui.Button, { variant: 'ghost', size: 'sm', onClick: batchRetry }, t('organize.page.retry')))) : null,
    error !== undefined ? h('div', { className: 'dwb-og-error', role: 'alert' },
      h(ui.IconWarningOutlineRegular, { size: 14 }),
      h('span', null, error === 'corrupt' ? t('organize.page.corrupt') : t('organize.page.loadFailed', { message: error.message })),
      h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => { void organizeStore.load() } }, t('organize.page.retry'))) : null,
    !managing && visible.length === 0 ? h('div', { className: 'dwb-og-empty' },
      h('b', null, t('organize.page.empty')),
      h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { setQuery(''); setFilter({ kind: 'all' }) } }, t('organize.page.clearFilter'))) : null,
    !managing && visible.length > 0 ? h('div', { className: 'dwb-og-groups' }, groups
      .filter(group => group.entries.length > 0)
      .map(group => h('section', { key: String(group.key), className: 'dwb-og-group' },
        h('div', { className: 'dwb-og-gh' }, groupTitle(group.key),
          h('span', { className: 'dwb-og-ghn' }, String(group.entries.length))),
        ...group.entries.map(row)))) : null)
}

// ---------- 样式 ----------

/** 本模块自己的样式（style.js 是共用文件，别的分支同时在改，不往里加）。 */
const ORGANIZE_CSS = `
.dwb-og-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.dwb-og-dot-unread{background:var(--dsw-alias-link);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-link) 35%,transparent)}
.dwb-og-micon{display:inline-flex;align-items:center;gap:1px}
.dwb-og-lead{display:inline-flex;width:16px;height:20px;align-items:center;justify-content:center}
.dwb-og-hover{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dwb-og-page{display:flex;flex-direction:column;gap:0;height:100%;min-height:0;box-sizing:border-box;padding:16px 20px calc(16px + var(--dsh-frame-leading-clearance, 0px));font-size:13px;color:var(--dsw-alias-label-primary);overflow-y:auto}
.dwb-og-bar{display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap}
.dwb-og-bar h4{margin:0;font-size:14px;font-weight:500}
.dwb-og-grow{flex:1 1 auto}
.dwb-og-search{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:9px;color:var(--dsw-alias-label-tertiary);min-width:200px}
.dwb-og-search input{flex:1 1 auto;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dwb-og-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dwb-og-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;overflow:hidden}
.dwb-og-seg button{border:none;background:transparent;padding:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dwb-og-seg button.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwb-og-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:transparent;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dwb-og-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-og-chip.on{border-color:var(--dsw-alias-link);color:var(--dsw-alias-label-primary)}
.dwb-og-chipn{color:var(--dsw-alias-label-tertiary)}
.dwb-og-batch{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:2px 0;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.dwb-og-batch-labels{position:relative;display:inline-flex}
.dwb-og-labelmenu{position:absolute;top:calc(100% + 4px);left:0;z-index:30;display:grid;gap:2px;min-width:160px;padding:6px;border-radius:10px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:blur(24px) saturate(1.8);box-shadow:var(--dsw-elevation-panel);border:.5px solid var(--dsw-alias-border-l2)}
.dwb-og-labelmenu-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:7px;background:transparent;font-size:13px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.dwb-og-labelmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-og-batch-fail{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dwb-og-error{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dwb-og-error>span{flex:1 1 auto}
.dwb-og-empty{display:grid;justify-items:center;gap:6px;padding:36px 12px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dwb-og-empty>b{font-size:14px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dwb-og-groups{display:grid;gap:14px;padding-top:6px}
.dwb-og-gh{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 0 4px}
.dwb-og-ghn{color:var(--dsw-alias-label-dimmed)}
.dwb-og-row{display:grid;grid-template-columns:auto auto minmax(80px,1.4fr) minmax(60px,.8fr) auto auto;align-items:center;gap:8px;padding:6px 8px;border-radius:9px;cursor:pointer}
.dwb-og-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-og-rowdot{display:inline-flex;width:16px;justify-content:center}
.dwb-og-check{margin:0;accent-color:var(--dsw-alias-link)}
.dwb-og-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dwb-og-ws{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-og-status{font-size:11px;line-height:16px;padding:1px 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap;justify-self:end}
.dwb-og-status[data-tone=pending]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent)}
.dwb-og-status[data-tone=running]{color:var(--dsw-alias-link);border-color:color-mix(in srgb,var(--dsw-alias-link) 40%,transparent)}
.dwb-og-time{font-size:12px;color:var(--dsw-alias-label-tertiary);justify-self:end}
.dwb-og-manage{display:grid;gap:10px;padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3);margin-top:4px}
.dwb-og-manage-rows{display:grid;gap:8px}
.dwb-og-manage-row{display:grid;grid-template-columns:auto minmax(200px,320px) auto 1fr;align-items:center;gap:10px}
.dwb-og-manage-input{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dwb-og-manage-input:focus{border-color:var(--dsw-alias-link)}
.dwb-og-manage-count{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-og-manage-problem{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dwb-og-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
`

/** 窗口重新获得焦点时重读一次数据（另一个窗口可能改了）；返回移除函数。 */
function mountOrganizeFocusReload(reload) {
  if (typeof window === 'undefined') return () => {}
  const onFocus = () => { reload() }
  const onVisible = () => { if (document.visibilityState === 'visible') reload() }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/**
 * 挂载本功能的界面（插件页里这一行开着时调用）：会话行菜单、行首圆点、悬停卡片、
 * 侧边栏「会话」页、未读清除看守；返回撤销函数，这一行关掉时撤掉全部。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
export function applyOrganize(app) {
  const { ctx } = app
  organizeCtx = ctx
  organizeT = app.t
  const store = createOrganizeStore()
  organizeStore = store
  const reload = () => { void store.load() }
  const disposers = [mountModuleStyle('dsh-workbench-organize', ORGANIZE_CSS)]
  const keep = (dispose) => { disposers.push(dispose) }
  keep(ctx.effect(() => ctx.contextMenus.register({
    id: 'dsh-workbench.organize',
    target: 'session',
    // 排在官方「分叉」（300）后面、「复制 Session ID」（450）前面；标签或语言变了重算。
    order: 320,
    observe: () => [store, ctx.locale],
    resolve: ({ sessionId }) => organizeMenuActions(
      store.getSnapshot().state, organizeT, sessionId,
      op => { void store.apply(op) },
    ),
  }), '@miint-sunny/dsh-workbench/organize: session menu'))
  keep(ctx.effect(() => ctx.slots.inject('contextMenu.icon', function* () {
    for (const id of ORGANIZE_LABEL_IDS) {
      yield ctx.slots.register(
        { name: 'contextMenu.icon', key: `dsh-workbench.label.${id}` },
        (props) => h(OrganizeMenuLabelIcon, { ...props, color: ORGANIZE_LABEL_COLORS[id] }))
    }
    // 图标组件在渲染时才取（ui 是拼进 bundle 后才有的全局，测试环境没有）。
    yield ctx.slots.register(
      { name: 'contextMenu.icon', key: 'dsh-workbench.organize.labels' },
      (props) => h(ui.IconChecklistOutlineRegular, props))
    yield ctx.slots.register(
      { name: 'contextMenu.icon', key: 'dsh-workbench.organize.unreadmark' }, OrganizeMenuUnreadIcon)
    yield ctx.slots.register(
      { name: 'contextMenu.icon', key: 'dsh-workbench.organize.clear' },
      (props) => h(ui.IconCloseOutlineRegular, props))
  }), '@miint-sunny/dsh-workbench/organize: menu icons'))
  keep(ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register(
    { name: 'sidebar.session.row.leading', id: 'dsh-workbench-organize', order: 50, locale: '@miint-sunny/dsh-workbench' },
    OrganizeRowDot)), '@miint-sunny/dsh-workbench/organize: row dot'))
  keep(ctx.effect(() => ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register(
    { name: 'sidebar.session.row.hover', id: 'dsh-workbench-organize', order: 50, locale: '@miint-sunny/dsh-workbench' },
    OrganizeRowHover)), '@miint-sunny/dsh-workbench/organize: row hover'))
  keep(ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: ORGANIZE_PANEL_ID, order: 20, locale: '@miint-sunny/dsh-workbench', label: () => organizeT('organize.panel') },
    OrganizePanelIcon)), '@miint-sunny/dsh-workbench/organize: panel button'))
  keep(ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: ORGANIZE_PANEL_ID, locale: '@miint-sunny/dsh-workbench' },
    OrganizePage)), '@miint-sunny/dsh-workbench/organize: sessions page'))
  keep(ctx.effect(() => ctx.on('connection/reset', reload), '@miint-sunny/dsh-workbench/organize: refetch on reconnect'))
  keep(mountOrganizeFocusReload(reload))
  keep(startOrganizeUnreadWatcher({
    getMainId: () => mainViewSessionId(ctx.sessions.list.getSnapshot().byId),
    getUnreadSet: () => new Set(store.getSnapshot().state.unread),
    subscribe: (listener) => ctx.effect(() => ctx.sessions.list.subscribe(listener), '@miint-sunny/dsh-workbench/organize: unread watcher'),
    clear: (id) => { void store.apply({ op: 'setUnread', sessionIds: [id], unread: false }) },
  }))
  void store.load()
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    organizeStore = undefined
    organizeCtx = undefined
    organizeT = undefined
  }
}

/**
 * 侧边对话（计划第 4 项）的网页部分：在右侧栏打开另一个普通会话，整套对话嵌在一个标签里。
 * 做法照官方子智能体标签（ui-subagent/src/client/sidebar-chat），用纯 JS 注册，已在临时 DSH
 * 里验证过（docs/research/02-第二批的扩展点.md 第 4 节）：
 * 资源协议按地址持有会话；标签类型加 `children` 声明的子插槽，标签组件拿到 SessionProvider，
 * 包住 `conversation.content` 的 embedded 变体，得到消息、输入框、审批卡片的完整对话。
 *
 * 两个入口：左栏会话菜单的「在右侧栏打开」（ctx.contextMenus.register，target 'session'、
 * order 310，排在官方「分叉」后面；0.2.2 起官方会话菜单走 contextMenus，旧的
 * sidebar.workspaces.session.menu.item 槽只兼容渲染、不再按 order 插位），和右侧栏「新标签页」
 * 新标签页里的「侧边对话」入口（sidebarRightTabs.register 的 guide，选中后打开本标签类型的
 * 选择页，选一个会话就在同一个标签里换成那个会话）。不往对话头部加按钮：那里已经有 DSH 自己的
 * 右侧栏开关（dsh-ui-guard 的规矩，2026-11-06 头部出现过两个图标一样的按钮）。
 * 列表和状态照 DSH 左栏自己的筛法（ui-workspace 的 tree.ts）：已归档是 workspaces 快照的
 * archivedSessionIds，子智能体是条目的 origin === 'subagent'，当前主对话区的会话是
 * retainedBy.mainView 计数。
 *
 * 每个功能行一个模块，由 scripts/build-client.mjs 按顺序拼进 lib/client.js：
 * 模块之间共用同一个作用域，所以本模块的顶层名字都带 Split/SPLIT 标记，不能和别的模块重名。
 */
import { listedSessions, mainViewSessionId, sessionStatusKey, sessionWorkspaceName } from './features.js'
import { mountModuleStyle } from './style.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重）。 */
const SPLIT_INJECT = ['sidebarRight', 'resources', 'uiWorkspace', 'contextMenus']

/** 本功能的中文界面文字；键以 `split.` 开头。状态词在 copy.js（session.status.*），和会话整理共用。 */
const SPLIT_ZH = {
  'split.openInSidebar': '在右侧栏打开',
  'split.guide.title': '侧边对话',
  'split.guide.description': '在右侧栏打开另一个会话，和当前会话并排',
  'split.searchPlaceholder': '搜索会话',
  'split.recent': '最近更新',
  'split.noMatches': '无匹配会话',
  'split.opening': '正在打开会话…',
  'split.cannotOpenTitle': '无法打开此会话',
  'split.cannotOpenBody': '会话已归档或已移除。请在侧边栏取消归档后重新打开。',
  'split.fallbackTitle': '侧边对话',
  'split.rowAria': '打开会话「{name}」',
}

/** 本功能的英文界面文字，键和 SPLIT_ZH 一一对应。 */
const SPLIT_EN = {
  'split.openInSidebar': 'Open in right sidebar',
  'split.guide.title': 'Side chat',
  'split.guide.description': 'Open another session next to this one in the right sidebar',
  'split.searchPlaceholder': 'Search sessions',
  'split.recent': 'Recently updated',
  'split.noMatches': 'No matching sessions',
  'split.opening': 'Opening session…',
  'split.cannotOpenTitle': 'This session cannot be opened',
  'split.cannotOpenBody': 'The session is archived or removed. Unarchive it in the sidebar, then open it again.',
  'split.fallbackTitle': 'Side chat',
  'split.rowAria': 'Open session “{name}”',
}

/** 资源协议，也是标签类型的 kind。 */
const SPLIT_PROTOCOL = 'wbsplit'

/** 右侧栏标签类型的 id（全局唯一，也是 `sidebar.right.pane.tab` 的 key）。 */
const SPLIT_TAB_ID = 'dsh-workbench/split'

/** 开始页入口的排序：官方文件 10、终端 20、浏览器 30，排在它们后面。 */
const SPLIT_GUIDE_ORDER = 40

/** 标签组件里用 `children` 声明的子插槽，会话内容的组件注册在它上面。 */
const SPLIT_CHILD_SLOT = 'dsh-workbench.split.conversation'

/** 标签地址前缀；地址是前缀加编码过的会话 id。 */
const SPLIT_ADDRESS_PREFIX = 'dsh-resource://wbsplit/session/'

/**
 * 某个会话在右侧栏的标签地址。
 * @param {string} sessionId 会话 id。
 * @returns {string} 标签地址。
 */
export function splitAddress(sessionId) {
  return SPLIT_ADDRESS_PREFIX + encodeURIComponent(sessionId)
}

/**
 * 从标签地址取会话 id。
 * @param {unknown} value 可能是标签地址的值。
 * @returns {string | undefined} 会话 id；不是本功能的地址或编码有误时 undefined。
 */
export function parseSplitAddress(value) {
  if (typeof value !== 'string' || !value.startsWith(SPLIT_ADDRESS_PREFIX)) return undefined
  const id = value.slice(SPLIT_ADDRESS_PREFIX.length).split('?')[0]
  if (id === '') return undefined
  try { return decodeURIComponent(id) } catch { return undefined }
}

/**
 * 等信号中止。
 * @param {AbortSignal} signal 中止信号。
 * @returns {Promise<void>} 信号中止时完成。
 */
function splitWaitForAbort(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
}

/**
 * 固定显示聊天视图（官方 FixedChatConversationView）：嵌入的对话不要顶部的视图切换。
 * @param {{renderSlot: Function}} props 对话视图属性。
 * @returns {unknown} React 节点。
 */
function SplitFixedChatView(props) {
  return h(Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
}

/**
 * 嵌入的会话内容（官方 ConversationSlotPanel，去掉子智能体的判断）：算出对话外壳的阶段，
 * 渲染 `conversation.content` 的 embedded 变体。
 * @param {object} props 子插槽组件属性（会话作用域）。
 * @returns {unknown} React 节点。
 */
function SplitConversationPanel({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId] && state.byId[sessionId].blank)
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views: SplitFixedChatView } })
}

/**
 * 标签内容的状态页：加载中（资源还没给出值）和打不开（retain 失败，或会话被归档、移除）。
 * @param {{tone: 'loading' | 'error'}} props 状态种类。
 * @returns {unknown} React 节点。
 */
function SplitTabState({ tone }) {
  if (tone === 'loading') {
    return h('div', { className: 'dwb-sp-state' }, splitT('split.opening'))
  }
  return h('div', { className: 'dwb-sp-state', role: 'alert' },
    h(ui.IconWarningOutlineRegular, { size: 20 }),
    h('b', null, splitT('split.cannotOpenTitle')),
    h('span', null, splitT('split.cannotOpenBody')))
}

/**
 * 标签内容：标签地址是某个会话的地址时显示那个会话；不是（从开始页的「会话」入口按类型
 * 打开的页）时显示会话选择页。
 * @param {object} props 标签组件属性（`children` 声明后才有 SessionProvider、renderSlot）。
 * @returns {unknown} React 节点。
 */
function SplitTabBody({ useResource, useTabInfo, useSessions, useSessionStatus, useWorkspaces, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo()
  const sessionId = parseSplitAddress(tab.contentId)
  const body = sessionId === undefined
    ? h(SplitPicker, { tab, useSessions, useSessionStatus, useWorkspaces })
    : h(SplitSessionBody, { tab, sessionId, useResource, useSessions, useWorkspaces, SessionProvider, renderSlot })
  return h('div', { 'data-dsh-workbench-split': '', style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' } }, body)
}

/**
 * 嵌入某个会话：按标签地址取资源里持有的会话引用，用 SessionProvider 包住子插槽。资源还没给出
 * 值时显示「正在打开会话…」；retain 失败（资源给出失败帧）或会话已从列表消失、被归档时，
 * 标签留着，显示打不开的那一页（照样稿 D）。
 * @param {object} props 标签、会话 id 和这个标签用的 DSH 钩子。
 * @returns {unknown} React 节点。
 */
function SplitSessionBody({ tab, sessionId, useResource, useSessions, useWorkspaces, SessionProvider, renderSlot }) {
  const resource = useResource(tab.contentId)
  const gone = useSessions(state => state.byId[sessionId] === undefined)
  const archived = useWorkspaces(state => state.archivedSessionIds.includes(sessionId))
  if (resource.status === 'failed' || gone || archived) return h(SplitTabState, { tone: 'error' })
  if (resource.value === undefined) return h(SplitTabState, { tone: 'loading' })
  return h(SessionProvider, { session: resource.value.reference }, renderSlot(SPLIT_CHILD_SLOT, {}))
}

/**
 * 会话选择页（样稿 B 的列表搬进右侧栏的标签里）：搜索框、分组标签「最近更新」、每行标题加
 * 工作区目录名加状态词、底部说明；点一行就在这个标签里换成那个会话。当前主对话区的会话不列。
 * @param {{tab: object, useSessions: Function, useSessionStatus: Function, useWorkspaces: Function}} props 标签和 DSH 钩子。
 * @returns {unknown} React 节点。
 */
function SplitPicker({ tab, useSessions, useSessionStatus, useWorkspaces }) {
  const [query, setQuery] = useState('')
  const searchRef = useRef(null)
  useEffect(() => {
    // 页一打开光标就落在搜索框里。
    searchRef.current?.focus()
  }, [])
  const list = useSessions(state => state)
  const archivedIds = useWorkspaces(state => state.archivedSessionIds)
  const statuses = useSessionStatus(state => state)
  const currentId = mainViewSessionId(list.byId)
  const candidates = useMemo(
    () => listedSessions(list, { currentId, query, archivedIds }),
    [list, currentId, query, archivedIds],
  )
  return h('div', { className: 'dwb-sp-page' },
    h('div', { className: 'dwb-sp-search' },
      h(ui.IconSearchOutlineRegular, { size: 14 }),
      h('input', {
        ref: searchRef, type: 'text', value: query,
        placeholder: splitT('split.searchPlaceholder'), 'aria-label': splitT('split.searchPlaceholder'),
        onChange: (event) => { setQuery(event.target.value) },
      })),
    h('div', { className: 'dwb-sp-label' }, splitT('split.recent')),
    candidates.length === 0
      ? h('div', { className: 'dwb-sp-none' }, splitT('split.noMatches'))
      : h('ul', { className: 'dwb-sp-list' }, candidates.map(entry => {
        const statusKey = sessionStatusKey(entry, statuses.get(entry.id))
        return h('li', { key: entry.id },
          h('button', {
            type: 'button', className: 'dwb-sp-item',
            'aria-label': splitT('split.rowAria', { name: entry.displayTitle }),
            onClick: () => {
              // 选择页让位给会话；会话标签已经开着时只是聚焦它，选择页要自己关掉（照官方开始页的做法）。
              tab.actions.openResource(splitAddress(entry.id), { replaceTab: true })
              tab.actions.close()
            },
          },
          h('span', { className: 'dwb-sp-title' }, entry.displayTitle),
          h('span', { className: 'dwb-sp-grow' }),
          h('span', { className: 'dwb-sp-ws' }, sessionWorkspaceName(entry.cwd)),
          statusKey === undefined ? null : h('span', {
            className: 'dwb-sp-chip',
            'data-tone': statusKey === 'session.status.running' ? 'running' : 'pending',
          }, splitT(statusKey))))
      })))
}

/** 入口上下文里的 DSH 客户端上下文和词典，applySplit 时记下（菜单项和标签内容用）。 */
let splitCtx
let splitT

/**
 * 在右侧栏打开一个会话。资源标签对同一个 (kind, contentId) 默认先找已开的标签并聚焦
 * （openResource 的 revealIfOpened 默认开），所以同一个会话不会开出第二个标签。
 * @param {string} sessionId 要打开的会话 id。
 * @returns {void}
 */
function splitOpen(sessionId) {
  splitCtx.sidebarRight.openResource(splitAddress(sessionId))
}

/** 本模块自己的样式（style.js 是共用文件，分屏的样式从模块里挂）。 */
const SPLIT_CSS = `
.dwb-sp-page{flex:1 1 auto;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:12px 12px 8px}
.dwb-sp-search{display:flex;align-items:center;gap:6px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:9px;color:var(--dsw-alias-label-tertiary)}
.dwb-sp-search input{flex:1 1 auto;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dwb-sp-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dwb-sp-label{padding:4px 8px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-sp-list{flex:1 1 auto;min-height:0;display:grid;align-content:start;gap:2px;overflow-y:auto;margin:0;padding:0 2px 2px;list-style:none}
.dwb-sp-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:8px;background:transparent;text-align:left;cursor:pointer}
.dwb-sp-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-sp-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
.dwb-sp-grow{flex:1 1 auto}
.dwb-sp-ws{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-sp-chip{flex:none;font-size:11px;line-height:16px;padding:1px 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dwb-sp-chip[data-tone=pending]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent)}
.dwb-sp-chip[data-tone=running]{color:var(--dsw-alias-link);border-color:color-mix(in srgb,var(--dsw-alias-link) 40%,transparent)}
.dwb-sp-none{padding:10px 8px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.dwb-sp-state{flex:1 1 auto;display:grid;place-content:center;justify-items:center;gap:8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dwb-sp-state>b{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}
`

/**
 * 挂载本功能的界面（插件页里这一行开着时调用）。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数：这一行关掉时调用，撤掉本功能注册的全部界面。
 */
export function applySplit(app) {
  const { ctx } = app
  splitCtx = ctx
  splitT = app.t
  const disposers = [mountModuleStyle('dsh-workbench-split', SPLIT_CSS)]
  const keep = (dispose) => { disposers.push(dispose) }
  keep(ctx.effect(() => ctx.resources.register({
    protocol: SPLIT_PROTOCOL,
    async *open(address, { signal }) {
      const sessionId = parseSplitAddress(address)
      if (sessionId === undefined) throw new Error(`dsh-workbench/split: 地址不对 ${address}`)
      if (signal.aborted) return
      let reference
      try {
        reference = ctx.sessions.retain(sessionId, { source: 'workbenchSplit', signal })
      } catch (error) {
        // 会话不存在这类 retain 的同步失败按一帧失败交给资源（资源只认失败帧，抛出去会
        // 一直停在加载中），标签内容显示打不开的那一页。
        yield { ok: false, error: { code: 'workbench-split/unavailable', message: error instanceof Error ? error.message : String(error) } }
        return
      }
      try {
        yield { ok: true, value: { address, reference } }
        await splitWaitForAbort(signal)
      } finally {
        reference.release()
      }
    },
  }), '@miint-sunny/dsh-workbench/split: resources'))
  keep(ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SPLIT_TAB_ID,
    kind: SPLIT_PROTOCOL,
    patterns: [SPLIT_ADDRESS_PREFIX + '**'],
    priority: 'extension',
    multiple: true,
    keepMounted: true,
    canOpen: address => parseSplitAddress(address) !== undefined,
    title: (address) => {
      const id = parseSplitAddress(address)
      const entry = id === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[id]
      return (entry && entry.displayTitle) || splitT('split.fallbackTitle')
    },
    // 右侧栏「新标签页」里的入口：选中后按类型打开本标签的选择页（照官方文件、终端、浏览器的写法）。
    guide: [{
      id: 'session',
      order: SPLIT_GUIDE_ORDER,
      title: () => splitT('split.guide.title'),
      description: () => splitT('split.guide.description'),
      // 图标组件在渲染时才取（ui 是拼进 bundle 后才有的全局，测试环境没有）。
      icon: (props) => h(ui.IconQueueOutlineRegular, props),
    }],
  }), '@miint-sunny/dsh-workbench/split: tab type'))
  keep(ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SPLIT_TAB_ID,
    children: { [SPLIT_CHILD_SLOT]: { kind: 'single', scope: 'session' } },
  }, SplitTabBody)), '@miint-sunny/dsh-workbench/split: tab body'))
  keep(ctx.effect(() => ctx.slots.inject(SPLIT_CHILD_SLOT, () => ctx.slots.register({
    name: SPLIT_CHILD_SLOT,
  }, SplitConversationPanel)), '@miint-sunny/dsh-workbench/split: conversation'))
  keep(ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register(
    // 图标组件在渲染时才取（ui 是拼进 bundle 后才有的全局，测试环境没有）。
    { name: 'contextMenu.icon', key: 'dsh-workbench.split' },
    (props) => h(ui.IconQueueOutlineRegular, props))),
  '@miint-sunny/dsh-workbench/split: menu icon'))
  keep(ctx.effect(() => ctx.contextMenus.register({
    id: 'dsh-workbench.split',
    target: 'session',
    // 排在官方「分叉」（order 300）后面；官方各项：置顶 100、重命名 200、分叉 300、复制 Session ID 450、归档 600。
    order: 310,
    observe: () => [ctx.sessions.list, ctx.locale],
    resolve: ({ sessionId }) => {
      // 当前在主对话区的会话置灰（contextMenus 的动作没有「右边写原因」的字段，只置灰）。
      const disabled = mainViewSessionId(ctx.sessions.list.getSnapshot().byId) === sessionId
      return [{
        id: 'open-in-sidebar',
        label: splitT('split.openInSidebar'),
        icon: { key: 'dsh-workbench.split' },
        ...(disabled ? { disabled: true } : {}),
        run: () => { splitOpen(sessionId) },
      }]
    },
  }), '@miint-sunny/dsh-workbench/split: menu action'))
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    splitCtx = undefined
    splitT = undefined
  }
}

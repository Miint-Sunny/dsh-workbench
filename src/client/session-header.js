/**
 * 会话顶栏：把官方的「更多操作」（···）排到顶栏按钮的最左侧；官方「变更请求与工作树」的「本会话的变更请求」按钮
 * 平时收进「更多操作」菜单，变更请求需要处理（按钮带红点）时照样显示在顶栏。只用样式调整官方按钮的顺序和显隐，
 * 不改它们的行为；关掉这一行，顶栏回到官方的样子。
 */
import { mountModuleStyle } from './style.js'

export const SESSION_HEADER_INJECT = ['contextMenus', 'sidebarRight']
export const SESSION_HEADER_ZH = { 'sessionHeader.changeRequests': '本会话的变更请求' }
export const SESSION_HEADER_EN = { 'sessionHeader.changeRequests': 'Change requests of this Session' }

/** 官方变更请求面板在右侧栏的类型（client-ui-forge 的 TAB_KIND）。 */
const CHANGE_REQUESTS_TAB = 'forge-panel'
/** 官方变更请求按钮的标记（client-ui-forge HeaderButton 的 data-forge-header）；按钮只在会话目录是 Git 仓库或绑定过变更请求时渲染。 */
const CHANGE_REQUESTS_BUTTON = '[data-forge-header]'
/** 「更多操作」菜单的目标：ui-conversation 顶栏的 contextMenu.button 用的 target.kind。 */
const MENU_TARGET = 'sessionHeader'
/** 菜单项图标的键（contextMenu.icon 槽位）。 */
const ICON_KEY = 'dwb-session-header-change-requests'

/**
 * 顶栏样式。顶栏工具区（官方类名带构建哈希前缀，如 kiGsTW_headerUtilities，按「_类名」匹配）是横排的 flex，里面先是
 * conversation.session.header.utilities 槽位，再是「更多操作」按钮。DSH 给每个槽位包一层 display:contents 的
 * [data-slot] 锚点（ui-renderer scoped-slots.tsx 的 ANCHOR_STYLE，DSH 说明它就是给样式定位用的），槽位里的按钮直接参与横排。
 * 所以：「更多操作」用 order:-1 排到最前（只认工具区的直接子元素，跳过槽位锚点）；变更请求按钮按它自己的
 * data-forge-header 隐藏，不能去藏槽位锚点——那会连同槽位里的定时任务、共享等按钮一起藏掉，锚点的行内样式也会压过这里。
 * 按钮里有红点（StateDot，data-state="error"）时不隐藏。官方结构或类名变了时规则匹配不上，顶栏保持原样。
 * order 只改视觉顺序：键盘 Tab 仍按 DSH 原来的 DOM 顺序，先到槽位里的按钮，再到「更多操作」。
 */
export const SESSION_HEADER_CSS = `
[class*="_headerUtilities"] > [class*="_headerMenuButton"],
[class*="_headerUtilities"] > :not([data-slot]):has([class*="_headerMenuButton"]) { order: -1; }
[data-slot="conversation.session.header.utilities"] [data-forge-header]:not(:has([class*="_dot"], [data-state="error"])) { display: none; }
`

/**
 * 「更多操作」里的「本会话的变更请求」。只在当前顶栏有官方变更请求按钮时出现（按钮被样式藏起来也算），
 * 点了打开官方的变更请求面板，和官方按钮打开的是同一个。
 * @param {{ t: (key: string) => string, present: () => boolean, open: () => void }} deps 文案、按钮在不在、打开面板。
 * @returns {() => object[]} contextMenus 的 resolve。
 */
export function changeRequestsMenu({ t, present, open }) {
  return () => (present()
    ? [{ id: 'change-requests', label: t('sessionHeader.changeRequests'), icon: { key: ICON_KEY }, run: open }]
    : [])
}

/**
 * 当前页面上有没有官方变更请求按钮。没有 document 的环境（node 里的测试）算没有。
 * 按整个页面找：DSH 0.2.2-rc.3 只有主会话区渲染会话顶栏，侧边对话和子智能体面板用的是不带顶栏的嵌入视图，
 * 所以页面上的按钮就是打开「更多操作」的那个会话的。以后别处也渲染会话顶栏时，这里要改成按会话找。
 * @param {{ querySelector: (selector: string) => unknown } | undefined} root 查找的范围，缺省是整个页面。
 * @returns {boolean} 有按钮时 true。
 */
export function changeRequestsButtonPresent(root = globalThis.document) {
  return root?.querySelector?.(CHANGE_REQUESTS_BUTTON) != null
}

/**
 * 挂会话顶栏这一行：样式、「更多操作」里的菜单项和它的图标。
 * @param {{ ctx: object, t: (key: string) => string }} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
export function applySessionHeader(app) {
  const { ctx, t } = app
  const removeStyle = mountModuleStyle('dsh-workbench-session-header', SESSION_HEADER_CSS)
  const disposeMenu = ctx.contextMenus.register({
    id: 'dsh-workbench.session-header.change-requests', target: MENU_TARGET, order: 10,
    // 切换界面语言时重新取菜单项的文字。
    observe: () => [ctx.locale],
    resolve: changeRequestsMenu({ t, present: () => changeRequestsButtonPresent(), open: () => ctx.sidebarRight.openTab(CHANGE_REQUESTS_TAB) }),
  })
  const disposeIcon = ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, props => h(ui.IconBranchOutlineRegular, props))
  })
  return () => {
    disposeIcon?.()
    disposeMenu?.()
    removeStyle()
  }
}

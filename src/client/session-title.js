/**
 * 会话标题这一行的网页端：侧栏会话菜单里的「重新起名」，加在 DSH 的 ctx.contextMenus 上（target `session`，
 * order 250：DSH 的「重命名」200 和「分叉会话」300 之间）；行上的「⋯」和右键打开的是同一个菜单。
 * 点了经 DSH 的 remote.commands.execute 对打开菜单时的那个会话执行 `/retitle`，标题按首条和最近的对话重算；
 * 命令结果和手打的 `/retitle` 一样记在会话里。宿主拒绝、没有 `/retitle` 或命令报错时 reject，菜单显示 DSH 自己的失败提示。
 * 从独立插件 dsh-session-title-headtail 的 lib/client.js 搬来。
 */

/** 「重新起名」要用的 DSH 服务，只给这一行的子 fiber。 */
const SESSION_TITLE_INJECT = ['slots', 'contextMenus', 'remote', 'remote.commands']

/** 菜单项和它的图标的键。 */
const RETITLE_MENU_ID = 'dsh-workbench.session-title.retitle'
const RETITLE_ICON_KEY = 'dsh-workbench.session-title.retitle'

/**
 * 对一个会话执行 `/retitle`。
 * @param {(sessionId: string, line: string, attachments: unknown[]) => Promise<object>} execute DSH 的 remote.commands.execute。
 * @param {string} sessionId 打开菜单时的会话。
 * @returns {Promise<void>} 命令执行完后结束；宿主拒绝、不认识 `/retitle` 或命令报错时 reject。
 */
async function runRetitle(execute, sessionId) {
  let result
  try {
    result = await execute(sessionId, '/retitle', [])
  } catch (error) {
    console.warn('[dsh-workbench/session-title] /retitle failed', error)
    throw error
  }
  if (!result.ok) {
    console.warn(`[dsh-workbench/session-title] /retitle refused: ${result.error.code}: ${result.error.message}`)
    throw new Error(`/retitle refused: ${result.error.code}`)
  }
  if (result.value === undefined) {
    console.warn('[dsh-workbench/session-title] /retitle is not registered on the host')
    throw new Error('/retitle is not registered on the host')
  }
  if (result.value.result.kind === 'error') {
    console.warn(`[dsh-workbench/session-title] /retitle: ${result.value.result.text}`)
    throw new Error(result.value.result.text)
  }
}

/**
 * 「会话标题」这一行的网页端挂载：在子 fiber 里注册菜单项的图标和菜单项。撤销时 dispose 子 fiber，两样一起撤。
 * @param {{ ctx: object, t: (key: string) => string }} app 工作台网页端的入口上下文。
 * @returns {() => void} 撤销函数。
 */
function applySessionTitle(app) {
  const fiber = app.ctx.inject(SESSION_TITLE_INJECT, (inner) => {
    inner.slots.inject('contextMenu.icon', () => inner.slots.register({ name: 'contextMenu.icon', key: RETITLE_ICON_KEY }, ui.IconRefreshOutlineRegular))
    const execute = (sessionId, line, attachments) => inner.remote.commands.execute(sessionId, line, attachments)
    inner.effect(() => inner.contextMenus.register({
      id: RETITLE_MENU_ID,
      target: 'session',
      order: 250,
      observe: () => [app.ctx.locale],
      resolve: ({ sessionId }) => [{ id: 'retitle', label: app.t('sessionTitle.retitle'), icon: { key: RETITLE_ICON_KEY }, run: () => runRetitle(execute, sessionId) }],
    }), 'dsh-workbench/session-title: session menu')
  })
  return () => { fiber.dispose() }
}

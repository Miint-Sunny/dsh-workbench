/** 网页端怎么知道哪些行开着：问根行的 /api/dsh-workbench.features。只有 200（按回答更新）和 404（根行关了，按全关处理）会更新清单；网络错误、5xx、格式不对的答案都保留上一次的清单——窗口重新获得焦点等时机都会重读，偶发一次失败不该把各功能的界面撤掉、让官方界面跳回来。 */

/** 功能清单接口的文档相对路径（和 DSH 网页端同源，带登录 cookie）。 */
const FEATURES_PATH = 'api/dsh-workbench.features'

/** 用量主页挂载时发布给命令面板的入口。整包和小包共用这个槽位名。 */
export const USAGE_PALETTE_SLOT = 'dsh-workbench.usage.palette'

/**
 * 发一条用户消息到会话（'queue'：会话运行中就排在这一轮后面）。收尾框的按钮和审阅页的「发送消息」共用。
 * @param {{ctx: object, t: Function}} app 入口上下文。
 * @param {string} sessionId 会话 id。
 * @param {string} text 消息文字。
 * @param {string} disconnectedKey 连接断开时用的词典键（各功能自己的「和 DSH 的连接已断开」）。
 * @returns {Promise<string | undefined>} 失败原因；成功时 undefined。
 */
export async function sendUserMessage(app, sessionId, text, disconnectedKey) {
  const session = app.ctx.sessions?.binding(sessionId)?.session
  if (session === undefined) return app.t(disconnectedKey)
  try {
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    return result.ok ? undefined : (result.error?.message ?? app.t(disconnectedKey))
  } catch (error) {
    return error instanceof Error ? error.message : app.t(disconnectedKey)
  }
}

/**
 * 网页所在的操作系统，用 DSH 快捷键的平台名。网页端的平台判断都调它，不另写（test/platform.test.mjs 拦着）。
 * 读浏览器报的平台：DSH 桌面端在页面上标的 data-platform 和它一致，网页端没有那个标记。
 * @param {string} [platform] 浏览器报的平台，比如 MacIntel、Win32；不给时读 navigator.platform，测试里直接传。
 * @returns {'macos' | 'windows' | 'linux'} Mac、Windows 以外都算 linux。
 */
export function clientPlatform(platform = navigator.platform) {
  if (/Mac/.test(platform)) return 'macos'
  if (/Win/.test(platform)) return 'windows'
  return 'linux'
}

/**
 * path 在 root 之下时，给出它相对 root 的各段。`\` 和 `/` 都算分隔符，末尾的分隔符不算一段，所以 `C:\` 和 `/` 这样的根也能比。
 * 两边都是 Windows 写法（盘符或 UNC）时按 Windows 的规矩不分大小写比较，其余逐字比较。只比字符串，不解析 `.`、`..` 和符号链接。
 * 文件预览的「发布为页面」和检查点弹窗的子目录说明共用。
 * @param {string} root 上层目录。
 * @param {string} path 要判断的路径。
 * @returns {string[] | undefined} 相对 root 的各段，path 就是 root 时是空数组；不在 root 之下时 undefined。
 */
export function workbenchPathBelow(root, path) {
  const windows = value => /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(value)
  const fold = windows(root) && windows(path)
  const split = (value) => {
    const parts = value.split(/[\\/]/)
    while (parts.length > 1 && parts.at(-1) === '') parts.pop()
    return parts
  }
  const base = split(root)
  const parts = split(path)
  if (parts.length < base.length) return undefined
  for (let at = 0; at < base.length; at += 1) {
    if (fold ? parts[at].toLowerCase() !== base[at].toLowerCase() : parts[at] !== base[at]) return undefined
  }
  return parts.slice(base.length)
}

/**
 * 工作区目录的显示名（目录路径的最后一段，`/` 和 `\` 都算分隔；照 DSH workspaceTitleOf）。
 * @param {string | undefined} cwd 会话工作区目录。
 * @returns {string} 最后一段；没有目录时空串。
 */
export function sessionWorkspaceName(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const trimmed = cwd.replace(/[/\\]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(at + 1)
}

/**
 * 当前在主对话区打开的会话（DSH ui-workspace 的 mainSessionId 同一个判据：列表条目的
 * retainedBy.mainView 引用计数大于 0）。
 * @param {Record<string, {id: string, retainedBy?: {mainView?: number}}>} byId 会话列表快照的 byId。
 * @returns {string | undefined} 会话 id；没有时 undefined。
 */
export function mainViewSessionId(byId) {
  if (typeof byId !== 'object' || byId === null) return undefined
  for (const entry of Object.values(byId)) {
    if (entry && (entry.retainedBy?.mainView ?? 0) > 0) return entry.id
  }
  return undefined
}

/**
 * 列给用户选的会话（侧边对话的选择页、会话整理的「会话」页）：去掉 currentId 那个（给了时）、
 * 子智能体（origin === 'subagent'）、已归档的和空白的，按最近活动从新到旧（updatedAt 相同按 id，
 * 照 DSH orderByRecency）；query 非空时按标题和工作区目录名过滤，不分大小写。
 * @param {{byId: Record<string, object>}} list 会话列表快照（ctx.sessions.list.getSnapshot()）。
 * @param {{currentId?: string, query?: string, archivedIds?: ReadonlySet<string> | readonly string[]}} options 不列的当前会话、搜索词和已归档集合。
 * @returns {object[]} 会话条目。
 */
export function listedSessions(list, { currentId, query, archivedIds } = {}) {
  if (typeof list !== 'object' || list === null) return []
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? [])
  const needle = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : ''
  const entries = Object.values(list.byId ?? {}).filter(entry => {
    if (!entry || typeof entry !== 'object') return false
    if (currentId !== undefined && entry.id === currentId) return false
    if (entry.origin === 'subagent') return false
    if (entry.blank === true) return false
    if (archived.has(entry.id)) return false
    if (needle === '') return true
    const title = typeof entry.displayTitle === 'string' ? entry.displayTitle.toLowerCase() : ''
    return title.includes(needle) || sessionWorkspaceName(entry.cwd).toLowerCase().includes(needle)
  })
  return entries.sort((a, b) => (a.updatedAt !== b.updatedAt ? b.updatedAt - a.updatedAt : (a.id < b.id ? -1 : 1)))
}

/**
 * 会话一行右侧的状态词键。只用 DSH 的词（进行中、等待审批、等待回答、计划待审）；等待类
 * 优先于进行中，已完成不写。纯函数，词由调用方过词典（词条在 copy.js）。
 * @param {{running?: boolean}} entry 会话列表条目（running 是 status 没有时的后备）。
 * @param {{running?: boolean, pendingInteraction?: {kind?: string}} | undefined} sessionStatus ctx.uiSession.sessionStatus 里这个会话的状态。
 * @returns {'session.status.approval' | 'session.status.planReview' | 'session.status.question' | 'session.status.running' | undefined} 词典键；没有要写的状态时 undefined。
 */
export function sessionStatusKey(entry, sessionStatus) {
  const kind = sessionStatus?.pendingInteraction?.kind
  if (kind === 'approval') return 'session.status.approval'
  if (kind === 'plan-review') return 'session.status.planReview'
  if (kind === 'question') return 'session.status.question'
  if (sessionStatus?.running ?? entry?.running) return 'session.status.running'
  return undefined
}

/** 两个 id 集合是否相同（顺序无关）。 */
function sameIds(left, right) {
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

/**
 * 建一个功能开关的读取器。load 读一次并通知订阅者；内容没变不通知。
 * @param {object} ctx 客户端上下文（未直接使用，留着给调用方和将来排查）。
 * @returns {{load: () => Promise<void>, has: (id: string) => boolean, subscribe: (listener: () => void) => () => void}} 读取器。
 */
export function createFeatureStore(ctx) {
  let ids = new Set()
  const listeners = new Set()
  const changed = () => { for (const listener of listeners) listener() }
  const load = async () => {
    let next
    try {
      const response = await fetch(FEATURES_PATH, { credentials: 'same-origin' })
      if (response.status === 404) {
        // 根行被关了，路由不在：按全关处理。
        next = new Set()
      } else if (response.ok) {
        const body = await response.json()
        if (typeof body !== 'object' || body === null || !Array.isArray(body.features)) return
        next = new Set(body.features
          .map(feature => (typeof feature === 'object' && feature !== null ? feature.id : undefined))
          .filter(id => typeof id === 'string'))
      } else {
        // 5xx 等别的状态：保留上一次的清单。
        return
      }
    } catch {
      // 网络错误：保留上一次的清单。
      return
    }
    if (sameIds(ids, next)) return
    ids = next
    changed()
  }
  return {
    load,
    has: (id) => ids.has(id),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 把已挂的界面对齐当前清单：新出现的行挂上（apply 返回撤销函数），消失的行撤掉，
 * 撤掉又出现的重挂。一行抛错只影响它自己：记到控制台，排在后面的行照常处理。挂载抛错的行
 * 记成已挂（撤销是空操作），清单不变时不重试，免得同一段副作用反复执行。不碰 ctx。
 * @param {Map<string, () => void>} mounted 已挂的行：id → 撤销函数（调用方持有，会被增删）。
 * @param {(id: string) => boolean} has 某行现在开没开。
 * @param {Record<string, (app: object) => () => void>} ui 各行的挂载函数。
 * @param {object} app 传给挂载函数的入口上下文。
 * @returns {void}
 */
export function reconcileFeatures(mounted, has, ui, app) {
  for (const [id, apply] of Object.entries(ui)) {
    if (has(id)) {
      if (mounted.has(id)) continue
      try {
        mounted.set(id, apply(app))
      } catch (error) {
        console.error(`dsh-workbench: ${id} failed to mount`, error)
        mounted.set(id, () => {})
      }
    } else if (mounted.has(id)) {
      const dispose = mounted.get(id)
      mounted.delete(id)
      try {
        dispose()
      } catch (error) {
        console.error(`dsh-workbench: ${id} failed to unmount`, error)
      }
    }
  }
}

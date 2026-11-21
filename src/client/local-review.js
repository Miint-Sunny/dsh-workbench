/**
 * 本地审查这一行的网页部分：内部预设的提示、review_findings 工具卡片和 /review 跑完的入口。审查发现显示在审阅面板
 * （review-panel.js）里，原来的「本地审查」页去掉了；卡片的「打开报告」和 /review 跑完都打开本会话的审阅标签，
 * 带上报告编号，面板按报告审的范围切过去。改动审阅这一行关着时没有审阅面板，不打开。
 */
import { mountModuleStyle } from './style.js'
import { mainViewSessionId } from './features.js'
import { reviewEntryOf, reviewPanelAddress } from './review-panel-model.js'
const LREV_INJECT = ['sidebarRight', 'commandUi']
export const LREV_LEGACY_KIND = 'wblocalreview'
export const LREV_LEGACY_TAB_ID = 'dsh-workbench-local-review'
export const LREV_LEGACY_PREFIX = `dsh-resource://${LREV_LEGACY_KIND}/`
const LREV_STYLE = `
.dwb-lr-preset-notice {
  margin: 8px 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
`

/**
 * 读取旧本地审查地址里的报告编号。
 * @param {string} address 原本地审查标签的资源地址。
 * @returns {string | undefined} 报告编号，地址不符时返回 undefined。
 */
export function parseLocalReviewReportAddress(address) {
  if (!address.startsWith(LREV_LEGACY_PREFIX)) return undefined
  return reviewEntryOf({ reportId: address.slice(LREV_LEGACY_PREFIX.length) }).reportId
}

/**
 * 调本地审查的路由（lib/local-review.js）：list、get 是 GET，其余是带 JSON 正文的 POST。
 * @param {string} action 路由名：list、get、start、stop、state、prepare。
 * @param {object} body 参数。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<object>} 回答；出错时抛出 Error，message 是宿主的错误码。
 */
export async function lrevRequest(action, body, signal) {
  const get = ['list', 'get'].includes(action)
  const response = await fetch(
    '/api/dsh-workbench.local-review.' + action + (get ? '?' + new URLSearchParams(body) : ''),
    {
      method: get ? 'GET' : 'POST',
      ...(get
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal,
    },
  )
  const value = await response.json()
  if (!response.ok) throw new Error(value.error?.code ?? 'review-failed')
  return value
}

/**
 * 本地审查出错的一句话：词典里有这个错误码就用它，没有就说读不到报告。
 * @param {(key: string) => string} t 词典函数。
 * @param {Error} error lrevRequest 抛出的错误。
 * @returns {string} 原因。
 */
export function lrevError(t, error) {
  const key = 'lr.' + error?.message
  return Object.hasOwn(LOCAL_REVIEW_ZH, key) ? t(key) : t('lr.readFailed')
}

/** 右侧栏只会在当前显示的会话中打开标签。 */
function lrevOpenReport(app, sessionId, reportId) {
  if (app.store?.has?.('review') !== true) return
  const { sidebarRight, sessions } = app.ctx
  const visibleSession = sidebarRight.mounted === undefined
    ? mainViewSessionId(sessions.list.getSnapshot().byId)
    : sidebarRight.mounted.getSnapshot()
  if (visibleSession !== sessionId) return
  sidebarRight.openResource(reviewPanelAddress(sessionId), { params: { reportId } })
}

/** 内部预设没有审查报告时，直接在输入框旁说明正确入口。 */
function LocalReviewPresetNotice({ sessionId, useProjection, app }) {
  const preset = useProjection('agentPreset')
  if (preset !== 'dsh-workbench-readonly-review' || reviewEntryOf({ reportId: sessionId }).reportId !== undefined) return null
  return h('p', { className: 'dwb-lr-preset-notice', role: 'status' }, app.t('lr.internalPreset'))
}

/** review_findings 的工具行：几条发现，「打开报告」在审阅面板里显示这份报告。 */
function ReviewFindingsCard({ phase, block, app, sessionId }) {
  const meta = block?.meta
  const reviewOn = React.useSyncExternalStore(app.store.subscribe, () => app.store.has('review'))
  return h(ui.DisclosureRow, {
    title: app.t('lr.found', { n: meta?.count ?? 0 }),
    icon: h(ui.IconSearchOutlineRegular, { size: 14 }),
    running: phase === 'preparing',
    expandable: false,
    open: false,
    onToggle: () => {},
    collapsedContent: toolRowSummary(reviewOn && meta?.reportId
      ? h(
          'button',
          {
            type: 'button',
            className: 'dwb-row-link',
            onClick: () => lrevOpenReport(app, sessionId, meta.reportId),
          },
          app.t('lr.openReport'),
        )
      : undefined),
  })
}

/**
 * 挂本地审查这一行的网页部分。
 * @param {{ctx: object, t: Function, store: object}} app 入口上下文。
 * @returns {() => void} 撤销函数。
 */
function applyLocalReview(app) {
  const { ctx } = app,
    disposers = [],
    keep = (d) => disposers.push(d)
  keep(
    ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'workbench-internal-review',
          order: 1,
          locale: '@miint-sunny/dsh-workbench',
        },
        (props) => h(LocalReviewPresetNotice, { ...props, app }),
      ),
    ),
  )
  keep(mountModuleStyle('dsh-workbench-local-review', LREV_STYLE))
  keep(
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register(
        { name: 'tool.call.toolview', key: 'review_findings', locale: '@miint-sunny/dsh-workbench', inject: sessionId => ({ sessionId }) },
        (props) => h(ReviewFindingsCard, { ...props, app }),
      ),
    ),
  )
  keep(
    ctx.on('command/executed', async (sessionId, name, result) => {
      if (name !== 'review' || result.kind !== 'success') return
      try {
        const { reports } = await lrevRequest('list', { sessionId })
        if (reports[0]) lrevOpenReport(app, sessionId, reports[0].id)
      } catch {
        // 报告清单读不到：不打开审阅面板，/review 的结果照常显示在对话里。
      }
    }),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

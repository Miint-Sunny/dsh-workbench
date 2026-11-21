/**
 * 审阅面板（feat#189，dsh-workbench/review 这一行的网页部分）：右侧栏一个标签「审阅」，一个会话一个，地址
 * `dsh-resource://wbreview/session/<会话>`，入口要的范围走 navigation.params。它合并了原来的改动审阅（接管官方
 * 「第 N 轮改动」页）和本地审查两页：
 * - 范围：未暂存、已暂存、未提交、分支走宿主 /api/dsh-workbench.git-review（设计说明第 8 节）；第 N 轮改动走 DSH 的
 *   api/changes.summary、api/changes.diff 和改动审阅的 /api/dsh-workbench.review.*。轮次从对话快照里官方 deliverables
 *   记下的 workspace/changes 序号列出。
 * - 写操作带上读到的 version，POST 带宿主进程的令牌头；宿主回 403 时重新取令牌再试一次，回 stale 时说明并重读。
 * - 审查发现（本地审查的 /api/dsh-workbench.local-review.*）叠在差异行下面；本地审查这一行关掉时不出审查按钮。
 * - 入口：官方每轮卡片打开的 changes-review 地址和右侧栏新标签页打开的页标签，正文把自己换成本会话的审阅标签
 *   （openResource 同一个地址只会聚焦已开的标签），再关掉自己；会话「更多操作」和 /review 跑完直接开审阅标签。
 * - 刷新时机：打开、换范围、每次操作以后、会话一轮结束、点「刷新变更」；不轮询（生成提交信息的作业状态除外）。
 * - 右键菜单用 DSH 的「文件」目标：打开、复制路径这些项由 DSH 的 open-in-app 给，本面板只加暂存、回退、评论这些项。
 */
import { mountModuleStyle } from './style.js'
import { sendUserMessage } from './features.js'
import { addRoundComment, clearSentRoundComments, fetchJson, hunkRows, insertIntoDraft, loadSeen, navigatedFileIndex, parseReviewAddress, postReviewAction, removeRoundComment, revertNews, roundCommentDraft, roundCommentState, saveSeen, sentRevertsByRound, sentRevertsOf, subscribeRoundComments, updateRoundCommentDraft, updateRoundCommentState } from './review.js'
import { composeReviewMessage } from '../../lib/review/copy.js'
import { LREV_LEGACY_KIND, LREV_LEGACY_PREFIX, LREV_LEGACY_TAB_ID, lrevError, lrevRequest, parseLocalReviewReportAddress } from './local-review.js'
import { REVIEW_PANEL_KIND, REVIEW_PANEL_TAB_ID, commitSelection, composeScopeMessage, fileActions, findingSide, hunkActions, parseReviewPanelAddress, placeFindings, reportFindingLines, reportScope, reviewAgo, reviewEntryOf, reviewErrorKey, reviewPanelAddress, revertAllSummary, scopeActions, scopeKey, scopeMenuEntries, scopeMessageText, severityCounts, splitPath, turnEntriesOf } from './review-panel-model.js'

export const REVIEW_PANEL_INJECT = ['sidebarRight', 'sidebarRightTabs', 'resources', 'contextMenus', 'uiConversation', 'uiWorkspace', 'sessions']

const RP_ROUTE = 'api/dsh-workbench.git-review'
const RP_TOKEN_HEADER = 'x-dsh-workbench-git-review'
/** 生成提交信息时查作业状态的间隔：宿主只回答 GET 查询，生成期间才查，停了或完成就不查。 */
const RP_GENERATE_POLL_MS = 500
/** 右键菜单项和「更多操作」项的图标键（contextMenu.icon 槽位，applyReview 里注册）。 */
const RP_ICON = { panel: 'dwb-rp-panel', stage: 'dwb-rp-stage', unstage: 'dwb-rp-unstage', revert: 'dwb-rp-revert', comment: 'dwb-rp-comment', copy: 'dwb-rp-copy', copyHunk: 'dwb-rp-copy-hunk' }
/** 接管官方「第 N 轮改动」地址的类型 id（沿用改动审阅原来的 id）。 */
const RP_TURN_TAB_ID = 'dsh-workbench-review'
/** 回退后能撤销的记录：会话 id → 记录（最新的在前），窗口里攒着，标签关了再开还在。 */
const rpUndos = new Map()
/** 每个审阅面板一个编号，放进右键菜单的值里，菜单只给打开它的那个面板加项。 */
let rpPanelSeq = 0

/**
 * 读审阅宿主的 GET 路由。
 * @param {Record<string, string>} params 查询参数。
 * @returns {Promise<object>} 宿主的回答；失败时 `{ ok: false, code, detail? }`，连不上是 network。
 */
async function rpGet(params) {
  try {
    const { status, ok, body } = await fetchJson(`${RP_ROUTE}?${new URLSearchParams(params)}`)
    if (ok && body?.ok === true) return body
    return { ok: false, code: typeof body?.code === 'string' ? body.code : `http-${status}`, detail: body?.detail }
  } catch {
    // fetch 本身被拒：和 DSH 的连接断了。
    return { ok: false, code: 'network' }
  }
}

/**
 * 调审阅宿主的 POST 路由：正文是 JSON，带令牌头（设计说明第 7 节）。
 * @param {string} token GET status 给的令牌。
 * @param {object} body 请求正文（action 和它的字段）。
 * @returns {Promise<object>} 宿主的回答；失败时 `{ ok: false, code, detail? }`。
 */
async function rpPost(token, body) {
  try {
    const response = await fetch(RP_ROUTE, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', [RP_TOKEN_HEADER]: token },
      body: JSON.stringify(body),
    })
    let value
    try {
      value = await response.json()
    } catch {
      // 回答不是 JSON（被别的中间层拦了）：按状态码报。
      value = undefined
    }
    if (response.ok && value?.ok === true) return value
    return { ok: false, code: typeof value?.code === 'string' ? value.code : `http-${response.status}`, detail: value?.detail }
  } catch {
    // fetch 本身被拒：和 DSH 的连接断了。
    return { ok: false, code: 'network' }
  }
}

/** 浏览器的 localStorage（测试环境和隐私模式里可能拿不到）。 */
function rpStorage() {
  try {
    return globalThis.localStorage
  } catch {
    // 读 localStorage 会抛（隐私模式、被禁用）：已审阅只在这一次打开里记着。
    return undefined
  }
}

/** 范围的名字：Git 范围照官方「变更」页，轮次写「第 N 轮改动」。 */
function rpScopeName(t, scope) {
  return scope.kind === 'turn' ? t('rp.scope.turn', { turn: scope.turn }) : t(`rp.scope.${scope.kind}`)
}

/** 错误码的一句话；没见过的码把码写进去。 */
function rpErrorText(t, failure, action) {
  const key = reviewErrorKey(failure.code, action, failure.detail)
  return key === 'rp.err.unknown' ? t(key, { code: failure.code }) : t(key)
}

/** 宿主 Git 差异的行转成显示行（和 hunkRows 的结果一样：加的行只有新行号，删的行只有旧行号）。 */
function rpGitRows(hunk) {
  return hunk.lines.map(line => (line.kind === 'add' ? { old: undefined, cur: line.new, text: line.text }
    : line.kind === 'delete' ? { old: line.old, cur: undefined, text: line.text }
      : { old: line.old, cur: line.new, text: line.text }))
}

/** 一处改动的行区间（右栏行号；整段删掉时用左栏）。 */
function rpHunkRange(t, hunk) {
  const range = hunk.newLines > 0 ? { start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 } : { start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 }
  return range.start === range.end ? t('rp.line', { line: range.start }) : t('rp.lines', range)
}

/** 一处改动拼成统一差异格式的文字（「复制这一处的改动」）。 */
function rpHunkText(hunk) {
  const line = row => (row.old === undefined ? `+${row.text}` : row.cur === undefined ? `-${row.text}` : ` ${row.text}`)
  return [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.rows.map(line)].join('\n')
}

// dsh-ui-guard: DSH 没有改动对比图标（文件上一个加号一个减号），审阅的入口用它
function RpDiffIcon({ size = 16, ...rest }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...rest },
    h('path', { d: 'M3.5 2.5C3.5 1.95 3.95 1.5 4.5 1.5H9.5L12.5 4.5V13.5C12.5 14.05 12.05 14.5 11.5 14.5H4.5C3.95 14.5 3.5 14.05 3.5 13.5Z' }),
    h('path', { d: 'M8 5V9M6 7H10M6 11.5H10' }))
}

// dsh-ui-guard: DSH 没有减号图标，取消暂存用它（暂存用 DSH 的加号）
function RpMinusIcon({ size = 16, ...rest }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', 'aria-hidden': true, ...rest },
    h('path', { d: 'M3.5 8H12.5' }))
}

// dsh-ui-guard: DSH 没有回退图标（向回转的箭头），回退这一处、回退整个文件用它
function RpRevertIcon({ size = 16, ...rest }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...rest },
    h('path', { d: 'M4 6.5H10C11.93 6.5 13.5 8.07 13.5 10C13.5 11.93 11.93 13.5 10 13.5H7' }),
    h('path', { d: 'M6.5 4L4 6.5L6.5 9' }))
}

/** 增删行数（绿、红，等宽字）。 */
function RpCounts({ added, deleted }) {
  return h('span', { className: 'dwb-rp-cnt' },
    added > 0 ? h('span', { className: 'dwb-rp-add' }, `+${added}`) : null,
    deleted > 0 ? h('span', { className: 'dwb-rp-del' }, `−${deleted}`) : null)
}

/**
 * 打开一个会话的审阅标签：已经开着就聚焦它，换到 params 要的范围。
 * @param {object} ctx 客户端上下文（要 sidebarRight）。
 * @param {string} sessionId 会话 id。
 * @param {object} params 入口参数（reviewEntryOf 认的字段）。
 * @returns {void}
 */
function openReviewPanel(ctx, sessionId, params) {
  ctx.sidebarRight.openResource(reviewPanelAddress(sessionId), { params })
}

/** 官方轮次、旧报告和新标签页入口都换成当前会话的审阅标签。 */
function ReviewPanelTab(props) {
  const { app, sessionId, useTabInfo } = props
  const { tab } = useTabInfo()
  const targetSession = parseReviewPanelAddress(tab.contentId)
  const own = targetSession === sessionId
  useEffect(() => {
    if (own || tab.visible === false) return
    const turn = parseReviewAddress(tab.contentId)
    const owner = targetSession ?? turn?.sessionId
    if (owner !== undefined && owner !== sessionId) {
      tab.actions.close()
      return
    }
    const reportId = parseLocalReviewReportAddress(tab.contentId)
    const params = tab.navigation?.params
    const index = navigatedFileIndex(params)
    let next = { scope: 'unstaged', ...(params !== null && typeof params === 'object' ? params : {}) }
    if (turn !== undefined) {
      next = { scope: 'turn', seq: turn.seq, turn: turn.turn, ...(index === undefined ? {} : { index }) }
    } else if (reportId !== undefined && app.store.has('local-review')) {
      next = { reportId }
    }
    tab.actions.openResource(reviewPanelAddress(sessionId), { replaceTab: true, params: next })
    // rc.5 聚焦已有标签时会保留原标签，由原标签自己关闭。
    tab.actions.close()
  }, [own, sessionId, tab.visible, tab.contentId, tab.navigation?.revision])
  return own ? h(ReviewPanel, props) : null
}

/** 对话快照里有改动的轮次（官方 deliverables 记的 workspace/changes 序号）。拿不到对话快照时是空的。 */
function useRpTurns(app, sessionId) {
  const store = useMemo(() => {
    const binding = app.ctx.sessions?.binding?.(sessionId)
    return binding === undefined ? undefined : app.ctx.uiConversation?.binding?.(binding)?.target?.('chat')
  }, [sessionId])
  const subscribe = useCallback(listener => (store === undefined ? () => {} : store.subscribe(listener)), [store])
  const snapshot = React.useSyncExternalStore(subscribe, () => store?.getSnapshot())
  const turns = snapshot?.timeline?.turns
  return useMemo(() => turnEntriesOf(turns), [turns])
}

function rpSelectedRepo(repos, choice) {
  return repos.find(item => item.id === choice || (choice?.root !== undefined && item.root === choice.root))
    ?? repos.find(item => item.kind === 'git') ?? repos[0]
}

/** 审阅面板主体：宿主状态、仓库、范围、差异、通知、报告和对话框都在这里，各部分画在下面的组件里。 */
function ReviewPanel(props) {
  const { app, sessionId, useTabInfo, useSessionStatus, inputActions } = props
  const t = app.t
  const { tab } = useTabInfo()
  const sessionRunning = useSessionStatus(map => map.get(sessionId))?.running === true
  const panelId = useMemo(() => `rp${++rpPanelSeq}`, [])
  const reviewOn = app.store?.has?.('local-review') === true
  const turns = useRpTurns(app, sessionId)
  const tokenRef = useRef(undefined)
  const loadSeq = useRef(0)
  const writing = useRef(false)
  const [host, setHost] = useState({ phase: 'loading' })
  const [view, setView] = useState({ scope: { kind: 'unstaged' }, repoChoice: undefined })
  const activeView = useRef(view)
  const { scope, repoChoice } = view
  const [loadedDiff, setDiff] = useState({ phase: 'idle' })
  const [loadedBranches, setBranches] = useState(undefined)
  const [loadedCommits, setCommits] = useState(undefined)
  const [turnData, setTurnData] = useState(undefined)
  const [turnFiles, setTurnFiles] = useState(() => new Map())
  const [notice, setNotice] = useState(undefined)
  const [dialog, setDialog] = useState(undefined)
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [undos, setUndos] = useState(() => rpUndos.get(sessionId) ?? [])
  const [report, setReport] = useState(undefined)
  const [reports, setReports] = useState([])
  const [reviewedLines, setReviewedLines] = useState(undefined)
  const [findingJump, setFindingJump] = useState(undefined)
  const reportRequest = useRef(0)
  const reportListRequest = useRef(0)
  const jumpedReport = useRef(undefined)
  const [reveal, setReveal] = useState(undefined)
  const [openMenu, setOpenMenu] = useState(undefined)
  const menuTrigger = useRef(null)
  const contextTrigger = useRef(null)
  const [, setReviewedTick] = useState(0)

  // 共享菜单的 Tab 会执行聚焦项。审阅菜单的 Tab 只离开菜单，执行用 Enter 或空格。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const menus = app.ctx.contextMenus
    const onTab = (event) => {
      if (event.key !== 'Tab' || !event.target?.closest?.('[data-context-menu]')) return
      if (menus.active?.getSnapshot()?.value.dwbReview?.panel !== panelId) return
      event.stopPropagation()
      menus.close()
      contextTrigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onTab, true)
    return () => document.removeEventListener('keydown', onTab, true)
  }, [app.ctx.contextMenus, panelId])

  function setMenuFrom(event, name) {
    menuTrigger.current = event?.currentTarget
    setOpenMenu(name)
  }

  function leaveMenu(event) {
    if (event.key !== 'Tab' || openMenu === undefined || !event.target?.closest?.('[role="menu"]')) return
    event.stopPropagation()
    setOpenMenu(undefined)
    menuTrigger.current?.focus({ preventScroll: true })
  }

  function openContextMenu(target, point, trigger) {
    contextTrigger.current = trigger
    app.ctx.contextMenus.open(target, point)
  }

  const repos = host.phase === 'ready' ? host.repos : []
  const repo = rpSelectedRepo(repos, repoChoice)
  const git = repo?.kind === 'git'
  const running = sessionRunning || host.running === true
  const branches = loadedBranches?.repo === repo?.id ? loadedBranches : undefined
  const branchBase = scope.kind === 'branch' ? scope.base ?? branches?.defaultBase ?? null : null
  const commits = loadedCommits?.repo === repo?.id && loadedCommits?.base === branchBase ? loadedCommits : undefined
  const menuBase = scope.kind === 'branch' ? branchBase : branches?.defaultBase ?? null
  const diffKey = scopeKey(scope.kind === 'branch' ? { ...scope, base: branchBase } : scope)
  const diff = loadedDiff.repoId === repo?.id && loadedDiff.key === diffKey
    ? loadedDiff : { phase: 'loading' }

  /** POST 一个写操作；令牌过期（403，宿主重启过）时重新取一次令牌再试。 */
  const post = useCallback(async (body) => {
    const loadToken = async () => {
      const status = await rpGet({ sessionId })
      if (status.ok) tokenRef.current = status.token
      return status
    }
    if (tokenRef.current === undefined) await loadToken()
    let result = await rpPost(tokenRef.current ?? '', body)
    if (!result.ok && result.code === 'forbidden') {
      const fresh = await loadToken()
      if (fresh.ok) result = await rpPost(fresh.token, body)
    }
    return result
  }, [sessionId])

  const loadGitDiff = useCallback(async (target, nextScope, base, seq) => {
    const key = scopeKey(nextScope.kind === 'branch' ? { ...nextScope, base } : nextScope)
    const repoId = target.id
    const params = { sessionId, repo: target.id, scope: nextScope.kind }
    if (nextScope.kind === 'branch') {
      if (base !== null && base !== undefined) params.base = base
      if (nextScope.from !== undefined) {
        params.from = nextScope.from
        params.to = nextScope.to
      }
      if (nextScope.includeUncommitted === true) params.includeUncommitted = '1'
    }
    const body = await rpGet(params)
    if (seq !== loadSeq.current) return
    setDiff(body.ok ? { ...body, phase: 'ready', key, repoId } : { phase: 'error', key, repoId, code: body.code, detail: body.detail })
  }, [sessionId])

  const loadTurn = useCallback(async (nextScope, seq) => {
    const params = new URLSearchParams({ sessionId, seq: String(nextScope.seq) })
    setTurnData(current => (current?.seq === nextScope.seq ? current : { seq: nextScope.seq, summary: 'loading', diffs: new Map(), reverts: [], revertsLoaded: false, errors: new Map() }))
    let summary = 'missing'
    try {
      const { ok, body } = await fetchJson(`api/changes.summary?${params}`)
      if (ok && Array.isArray(body?.files)) summary = body
    } catch {
      // 连不上：和 DSH 重启后一样当作这一轮不可用。
      summary = 'missing'
    }
    let reverts
    try {
      const { ok, body } = await fetchJson(`api/dsh-workbench.review.state?${params}`)
      if (ok && body?.ok === true && Array.isArray(body.reverts)) reverts = body.reverts
    } catch {
      // 回退清单读不到：当作没读到，消息里不报回退的变化。
      reverts = undefined
    }
    if (seq !== loadSeq.current) return
    setTurnFiles(current => new Map(current).set(nextScope.seq, summary === 'missing' ? null : summary.files.length))
    setTurnData(current => ({
      seq: nextScope.seq, summary,
      diffs: current?.seq === nextScope.seq ? current.diffs : new Map(),
      reverts: reverts ?? [], revertsLoaded: reverts !== undefined,
      errors: current?.seq === nextScope.seq ? current.errors : new Map(),
    }))
  }, [sessionId])

  /** 只接受最近一次刷新的状态和差异，写操作完成时重读当时显示的范围。 */
  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current
    const { scope: nextScope, repoChoice: nextRepo } = activeView.current
    const status = await rpGet({ sessionId })
    if (seq !== loadSeq.current) return
    if (status.ok) {
      tokenRef.current = status.token
      setHost({ phase: 'ready', repos: status.repos, running: status.running })
    } else {
      setHost({ phase: 'error', code: status.code })
    }
    if (nextScope.kind === 'turn') {
      await loadTurn(nextScope, seq)
      return
    }
    const target = rpSelectedRepo(status.ok ? status.repos : [], nextRepo)
    if (target?.kind !== 'git') {
      setDiff({ phase: 'idle' })
      return
    }
    let base = null
    if (nextScope.kind === 'branch') {
      const body = await rpGet({ sessionId, repo: target.id, branches: '1' })
      if (seq !== loadSeq.current) return
      const defaultBase = body.ok ? body.defaultBase : null
      setBranches({ repo: target.id, defaultBase, local: body.local ?? [], remote: body.remote ?? [], failed: !body.ok })
      base = nextScope.base ?? defaultBase
      if (base == null) {
        setDiff({ phase: 'error', key: scopeKey(nextScope), repoId: target.id, code: body.ok ? 'no-base' : body.code })
        return
      }
      const loadCommits = async () => {
        const listed = await rpGet({ sessionId, repo: target.id, commits: '1', base })
        if (seq !== loadSeq.current) return
        setCommits({ repo: target.id, base, list: listed.commits ?? [], truncated: listed.truncated, failed: !listed.ok })
      }
      await Promise.all([loadCommits(), loadGitDiff(target, nextScope, base, seq)])
      return
    }
    await loadGitDiff(target, nextScope, base, seq)
  }, [loadTurn, loadGitDiff, sessionId])

  // 打开面板时读一次；入口带来的范围、文件和报告在下面的导航里处理。
  useEffect(() => {
    if (tab.navigation?.revision === undefined) void refresh()
    return () => { loadSeq.current += 1 }
  }, [])

  // 入口：同一个标签里换到入口要的范围（不开第二个标签）。
  const navigationRevision = tab.navigation?.revision
  useEffect(() => {
    if (navigationRevision === undefined) return
    const entry = reviewEntryOf(tab.navigation?.params)
    if (entry.reportId !== undefined) void showReport(entry.reportId)
    else changeScope(entry.scope ?? scope)
    if (entry.index !== undefined) setReveal({ index: entry.index, nonce: navigationRevision })
  }, [navigationRevision])

  // 会话一轮结束时刷新（进行中 → 停下）。
  const wasRunning = useRef(sessionRunning)
  useEffect(() => {
    if (wasRunning.current && !sessionRunning) void refresh()
    wasRunning.current = sessionRunning
  }, [sessionRunning])

  const reportId = report?.id
  const reportParent = report?.parentId
  const reportStatus = report?.status
  const sameReviewRepo = git && (report?.projectRoot === undefined || report.projectRoot === repo.root)
  const inReportScope = sameReviewRepo && diffKey === scopeKey(reportScope(report))
  const readyReviewDiff = scope.kind !== 'turn' && diff.phase === 'ready' ? diff : undefined

  // 审查会话的报告也归在发起审查的会话下面。
  const loadReports = useCallback(async () => {
    if (!reviewOn) return
    const request = ++reportListRequest.current
    try {
      const value = await lrevRequest('list', { sessionId: reportParent ?? sessionId })
      if (request === reportListRequest.current) setReports(Array.isArray(value?.reports) ? value.reports : [])
    } catch {
      // 报告清单读不到：菜单里不写份数，「打开报告」打开时再读。
      if (request === reportListRequest.current) setReports([])
    }
  }, [sessionId, reportParent, reviewOn])
  useEffect(() => { void loadReports() }, [loadReports])

  // 事件流同步进度和处置状态。报告是否过时由显式读取核对。
  useEffect(() => {
    if (reportId === undefined || typeof EventSource !== 'function') return undefined
    const stream = new EventSource(`/api/dsh-workbench.local-review.events?sessionId=${encodeURIComponent(reportParent)}`)
    stream.onmessage = (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        // 一条事件读不懂：等下一条。
        return
      }
      const incoming = data.report !== undefined ? [data.report] : Array.isArray(data.reports) ? data.reports : []
      const next = incoming.find(item => item?.id === reportId)
      if (next !== undefined) mergeReport(next)
    }
    return () => { stream.close() }
  }, [reportId, reportParent])

  useEffect(() => {
    if (reportStatus !== 'completed' || readyReviewDiff === undefined) return undefined
    const abort = new AbortController()
    void lrevRequest('get', { id: reportId }, abort.signal).then((value) => {
      if (abort.signal.aborted) return
      mergeReport(value, true)
      if (inReportScope && value.stale !== true) setReviewedLines({ reportId, lines: reportFindingLines(value, readyReviewDiff.files) })
    }, () => {
      // 核对失败时保留最后收到的报告。
    })
    return () => abort.abort()
  }, [reportId, reportStatus, readyReviewDiff, inReportScope])

  function mergeReport(next, inspected = false) {
    setReport((current) => {
      if (current === undefined || current.id !== next.id) return current
      if ((next.revision ?? 0) < (current.revision ?? 0)) return current
      return { ...current, ...next, stale: next.stale === true || (!inspected && current.stale === true) }
    })
  }

  function changeScope(next, nextRepo = activeView.current.repoChoice) {
    const previous = activeView.current
    if (scopeKey(previous.scope) !== scopeKey(next) || previous.repoChoice !== nextRepo) {
      setDiff({ phase: 'loading' })
      setDialog(undefined)
    }
    const nextView = { scope: next, repoChoice: nextRepo }
    activeView.current = nextView
    setView(nextView)
    setNotice(undefined)
    setOpenMenu(undefined)
    void refresh()
  }

  function changeRepo(id) {
    if (repo?.id === id) return
    changeScope(scope.kind === 'branch'
      ? { kind: 'branch', base: null, includeUncommitted: scope.includeUncommitted === true }
      : scope, id)
  }

  function goToReportScope(value) {
    jumpedReport.current = undefined
    setFindingJump(undefined)
    changeScope(reportScope(value), value.projectRoot === undefined ? repos[0]?.id : { root: value.projectRoot })
  }

  function selectReport(value) {
    setReviewedLines(undefined)
    setReport(value)
    goToReportScope(value)
  }

  async function showReport(id) {
    const request = ++reportRequest.current
    try {
      const value = await lrevRequest('get', { id })
      if (request !== reportRequest.current) return
      if (value.parentId !== (reportParent ?? sessionId) && value.id !== sessionId) throw new Error('report-not-found')
      selectReport(value)
    } catch (error) {
      if (request !== reportRequest.current) return
      setNotice({ tone: 'error', text: lrevError(t, error) })
      void refresh()
    }
  }

  async function startReview(input) {
    const request = ++reportRequest.current
    setNotice(undefined)
    try {
      const parentId = reportParent ?? sessionId
      const start = () => lrevRequest('start', { sessionId: parentId, input })
      const value = parentId === sessionId ? await start() : await app.ctx.sessions.using(parentId, { source: 'local-review-start' }, start)
      if (request !== reportRequest.current) return
      selectReport(value)
      void loadReports()
    } catch (error) {
      if (request !== reportRequest.current) return
      setNotice({ tone: 'error', text: lrevError(t, error) })
    }
  }

  /** 写操作的公共部分：清掉旧通知，发请求，失败时写原因（钩子失败带输出），成功或失败之后都重读。 */
  async function act(body, { action = body.action, onOk } = {}) {
    if (repo === undefined || writing.current) return undefined
    writing.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await post({ sessionId, repo: repo.id, ...body })
      if (result.ok) onOk?.(result)
      else setNotice({ tone: 'error', text: rpErrorText(t, result, action), detail: result.code === 'hook-failed' ? result.detail : undefined })
      await refresh()
      return result
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  function pushUndo(record) {
    const next = [record, ...(rpUndos.get(sessionId) ?? [])]
    rpUndos.set(sessionId, next)
    setUndos(next)
  }
  function dropUndo(undoId) {
    const next = (rpUndos.get(sessionId) ?? []).filter(item => item.undoId !== undoId)
    rpUndos.set(sessionId, next)
    setUndos(next)
  }

  const currentFindingFiles = sameReviewRepo && report?.stale !== true ? readyReviewDiff?.files ?? [] : []
  const sourceLines = reviewedLines?.reportId === reportId && report?.stale !== true ? reviewedLines?.lines : undefined
  const placed = useMemo(() => placeFindings(reviewOn ? report : undefined, currentFindingFiles, inReportScope ? undefined : sourceLines ?? new Map()),
    [reviewOn, report, currentFindingFiles, inReportScope, sourceLines])
  const assignedFindings = useMemo(() => new Set([...placed.byFile.values()].flat()), [placed])
  const hiddenFindings = inReportScope && readyReviewDiff !== undefined
    ? (report?.findings ?? []).filter(item => !assignedFindings.has(item)) : []
  const findingOrder = [
    ...currentFindingFiles.flatMap(file => (placed.byFile.get(file.path) ?? []).map(item => ({ id: item.id, path: file.path, status: item.status }))),
    ...hiddenFindings,
  ].filter(item => item.status !== 'ignored')
  const findingView = JSON.stringify([reportId, repo?.id, diffKey])
  const activeFinding = findingJump?.view === findingView && findingOrder.some(item => item.id === findingJump.id) ? findingJump : undefined

  function jumpFinding(step, focus = true) {
    if (findingOrder.length === 0) return
    const current = findingOrder.findIndex(item => item.id === activeFinding?.id)
    const next = findingOrder[current < 0 ? (step > 0 ? 0 : findingOrder.length - 1) : (current + step + findingOrder.length) % findingOrder.length]
    setFindingJump({ id: next.id, path: next.path, view: findingView, focus })
  }

  useEffect(() => {
    if (reportStatus !== 'completed' || (sourceLines === undefined && report.stale !== true) || tab.visible === false
      || findingOrder.length === 0 || jumpedReport.current === reportId) return
    jumpedReport.current = reportId
    jumpFinding(1, false)
  }, [reportId, reportStatus, sourceLines, report?.stale, tab.visible, findingOrder.length])

  const versioned = (action, path, hunk) => ({ action, scope: scope.kind, version: diff.version, ...(path === undefined ? {} : { path }), ...(hunk === undefined ? {} : { hunk }) })
  const controller = {
    t, app, sessionId, panelId, scope, repo, running, busy, split, wrap, reveal, report, reports, openMenu,
    activeFinding, jumpFinding, goToReportScope, sourceLines, canStartReview: repo?.kind === 'git' && repo.id === repos[0]?.id,
    commentRepoRoot: repo?.id !== repos[0]?.id ? repo?.root : undefined,
    setMenuFrom, openContextMenu,
    stage: (path, hunk) => act(versioned('stage', path, hunk)),
    unstage: (path, hunk) => act(versioned('unstage', path, hunk)),
    revert: (path, hunkObject, count) => act(versioned('revert', path, hunkObject?.id), {
      onOk: (result) => {
        if (result.undoId === undefined) return
        const what = path === undefined ? { key: 'rp.reverted.all', params: { n: count } }
          : hunkObject === undefined ? { key: 'rp.reverted.file', params: { path } }
            : { key: 'rp.reverted.hunk', params: { path, range: rpHunkRange(t, hunkObject) } }
        pushUndo({ undoId: result.undoId, repoId: repo.id, scopeKind: scope.kind, ...what })
      },
    }),
    undo: async (record) => {
      const result = await act({ action: 'undo', undoId: record.undoId }, { onOk: () => dropUndo(record.undoId) })
      if (result !== undefined && !result.ok && (result.code === 'stale' || result.code === 'not-found')) dropUndo(record.undoId)
    },
    push: () => act({ action: 'push' }, { onOk: result => setNotice({ tone: 'ok', text: t('rp.pushed', { remote: result.remote }) }) }),
    refresh: () => {
      setNotice(undefined)
      void refresh()
    },
    afterWrite: () => refresh(),
    changeScope, changeRepo, setSplit, setWrap, setDialog, setNotice, setOpenMenu, post, startReview, showReport, mergeReport, loadReports,
    touchReviewed: () => setReviewedTick(value => value + 1),
    /** 打开范围菜单时读一次分支清单，「分支」后面写对比的基准。 */
    loadBranches: async () => {
      if (repo?.kind !== 'git' || (branches !== undefined && !branches.failed)) return
      const seq = loadSeq.current
      const body = await rpGet({ sessionId, repo: repo.id, branches: '1' })
      if (body.ok && seq === loadSeq.current) setBranches({ repo: repo.id, defaultBase: body.defaultBase, local: body.local, remote: body.remote })
    },
    closeReport: () => {
      reportRequest.current += 1
      setReport(undefined)
      setReviewedLines(undefined)
    },
    loadTurnDiff: async (index) => {
      const seqAt = turnData?.seq
      if (seqAt === undefined) return
      setTurnData(current => (current?.seq === seqAt && !current.diffs.has(index) ? { ...current, diffs: new Map(current.diffs).set(index, 'loading') } : current))
      let value = 'missing'
      try {
        const { ok, body } = await fetchJson(`api/changes.diff?${new URLSearchParams({ sessionId, seq: String(seqAt), index: String(index) })}`)
        if (ok) value = body
      } catch {
        // 连不上：这个文件显示不可用。
        value = 'missing'
      }
      setTurnData(current => (current?.seq === seqAt ? { ...current, diffs: new Map(current.diffs).set(index, value) } : current))
    },
    turnAction: async (path, fileIndex, hunkIndex) => {
      const result = await postReviewAction(path, { sessionId, seq: scope.seq, fileIndex, hunkIndex })
      const key = `${fileIndex}:${hunkIndex ?? 'w'}`
      setTurnData((current) => {
        if (current?.seq !== scope.seq) return current
        const errors = new Map(current.errors)
        if (result.ok) errors.delete(key)
        else errors.set(key, result.message ?? t('review.disconnected'))
        return { ...current, errors }
      })
      if (result.ok) await refresh()
    },
  }

  const toolbarFiles = scope.kind === 'turn'
    ? (turnData?.seq === scope.seq && typeof turnData.summary === 'object' ? { files: turnData.summary.files.length, added: turnData.summary.added ?? 0, deleted: turnData.summary.deleted ?? 0 } : undefined)
    : diff.phase === 'ready' && git ? diff.totals : undefined
  return h('div', { className: 'dwb-rp', 'data-testid': 'dwb-review-panel', onKeyDown: leaveMenu },
    h(RpToolbar, { controller, entries: scopeMenuEntries({ repo, base: menuBase, turns, turnFiles }), repos, files: toolbarFiles, reviewOn, turns, turnFiles, setTurnFiles, diff, turnData }),
    host.phase === 'error' ? h(RpHostError, { t, code: host.code, retry: () => controller.refresh() }) : null,
    running ? h('div', { className: 'dwb-rp-banner', role: 'status' }, h(ui.IconWarningOutlineRegular, { size: 16 }), h('span', null, t('review.running'))) : null,
    git && (repo.conflicts ?? 0) > 0 && scope.kind !== 'turn' && scope.kind !== 'branch'
      ? h('div', { className: 'dwb-rp-banner', role: 'status' }, h(ui.IconWarningOutlineRegular, { size: 16 }), h('span', null, t('rp.conflicts', { n: repo.conflicts }))) : null,
    report !== undefined && reviewOn ? h(RpReviewStrip, {
      controller, report, canJump: findingOrder.length > 0,
      outside: inReportScope || (scope.kind !== 'turn' && git && readyReviewDiff === undefined) ? [] : placed.outside,
    }) : null,
    notice !== undefined ? h(RpNotice, { notice }) : null,
    scope.kind === 'turn'
      ? h(RpTurnView, { key: `turn:${scope.seq}`, controller, turnData, inputActions })
      : repo !== undefined && !git
        ? h('div', { className: 'dwb-rp-info' }, t('rp.notGit'))
        : host.phase === 'ready' && repo !== undefined
          ? h(RpGitView, {
            key: `git:${repo.id}`, controller, diff, branches, commits, branchBase, placed, hiddenFindings, inputActions,
            undos: undos.filter(item => item.repoId === repo.id && item.scopeKind === scope.kind),
          })
          : host.phase === 'loading' ? h('p', { className: 'dwb-rp-note' }, t('rp.loading')) : null,
    dialog !== undefined && repo !== undefined ? h(RpDialog, { controller, dialog, diff }) : null)
}

/** 宿主不可用：找不到 Git（503）或连不上。轮次照样能看。 */
function RpHostError({ t, code, retry }) {
  return h('div', { className: 'dwb-rp-notice', 'data-tone': 'error', role: 'alert' },
    h(ui.IconWarningOutlineRegular, { size: 14 }),
    h('span', null, code === 'git-unavailable' ? t('rp.gitUnavailable') : rpErrorText(t, { code })),
    h('span', { className: 'dwb-rp-grow' }),
    h(ui.Button, { variant: 'ghost', size: 'sm', onClick: retry }, t('rp.retry')))
}

/** 一条通知：操作的结果或出错原因；钩子失败时带钩子输出的最后几行。 */
function RpNotice({ notice }) {
  return h('div', { className: 'dwb-rp-notice', 'data-tone': notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' },
    notice.tone === 'ok' ? h(ui.IconCheckOutlineRegular, { size: 14 }) : h(ui.IconWarningOutlineRegular, { size: 14 }),
    notice.detail ? h('div', { className: 'dwb-rp-notice-body' }, h('span', null, notice.text), h('pre', { className: 'dwb-rp-pre' }, notice.detail)) : notice.text)
}

/** 工具栏：范围、仓库、文件数和行数、审查、左右对比、自动换行、刷新（窄时后三个收进「更多视图选项」）。 */
function RpToolbar({ controller, entries, repos, files, reviewOn, turns, turnFiles, setTurnFiles, diff, turnData }) {
  const { t, scope, repo, split, wrap, openMenu, setOpenMenu } = controller
  const scopeId = scope.kind === 'turn' ? `turn:${scope.seq}` : scope.kind
  const loadTurnCounts = () => {
    for (const { seq } of turns) {
      if (turnFiles.has(seq)) continue
      void fetchJson(`api/changes.summary?${new URLSearchParams({ sessionId: controller.sessionId, seq: String(seq) })}`)
        .then(({ ok, body }) => { setTurnFiles(current => new Map(current).set(seq, ok && Array.isArray(body?.files) ? body.files.length : null)) })
        .catch(() => { setTurnFiles(current => new Map(current).set(seq, null)) })
    }
  }
  const sub = entry => (entry.reason === 'not-git' ? t('rp.menu.notGit')
    : entry.unavailable ? t('rp.menu.unavailable')
      : entry.id === 'branch' ? (entry.base ? t('rp.menu.compare', { base: entry.base }) : '')
        : entry.count === undefined ? '' : t('rp.menu.files', { n: entry.count }))
  const scopeItems = entries.map(entry => (entry.separator ? { type: 'separator', id: entry.id } : {
    id: entry.id, disabled: entry.disabled,
    label: h('span', { className: 'dwb-rp-mi' }, h('span', { className: 'dwb-rp-mi-name' }, rpScopeName(t, entry.scope)), h('span', { className: 'dwb-rp-mi-sub' }, sub(entry))),
  }))
  const viewItems = [
    { id: 'split', label: split ? t('rp.unified') : t('rp.split') },
    { id: 'wrap', label: wrap ? t('rp.wrapOff') : t('rp.wrapOn') },
    { id: 'refresh', label: t('rp.refresh') },
  ]
  const onView = (id) => {
    setOpenMenu(undefined)
    if (id === 'split') controller.setSplit(value => !value)
    else if (id === 'wrap') controller.setWrap(value => !value)
    else controller.refresh()
  }
  const close = () => setOpenMenu(undefined)
  return h('div', { className: 'dwb-rp-tool' },
    h(ui.Menu, {
      className: 'dwb-rp-scope-menu', open: openMenu === 'scope', onClose: close, portal: true, autoFocus: true, align: 'start',
      items: scopeItems, selectedId: scopeId,
      onSelect: (id) => {
        close()
        const entry = entries.find(item => item.id === id)
        if (entry === undefined || entry.disabled) return
        controller.changeScope(entry.scope.kind === 'branch' ? { kind: 'branch', base: null, includeUncommitted: false } : entry.scope)
      },
      anchor: h('button', {
        type: 'button', className: 'dwb-rp-scope', 'aria-haspopup': 'menu', 'aria-expanded': openMenu === 'scope', 'aria-label': t('rp.scope.aria', { scope: rpScopeName(t, scope) }),
        onClick: (event) => {
          loadTurnCounts()
          void controller.loadBranches()
          controller.setMenuFrom(event, openMenu === 'scope' ? undefined : 'scope')
        },
      }, h('span', null, rpScopeName(t, scope)), h(ui.IconChevronDownOutlineRegular, { size: 14 })),
    }),
    repos.length > 1 ? h(ui.Menu, {
      className: 'dwb-rp-repo-menu', open: openMenu === 'repo', onClose: close, portal: true, autoFocus: true, align: 'start',
      items: repos.map(item => ({
        id: item.id, disabled: scope.kind !== 'turn' && item.kind !== 'git',
        label: h('span', { className: 'dwb-rp-mi' }, h('span', { className: 'dwb-rp-mi-name' }, item.name),
          h('span', { className: 'dwb-rp-mi-sub' }, item.kind !== 'git' ? t('rp.menu.notGit') : item.counts.uncommitted === 0 ? t('rp.repo.noChanges') : t('rp.menu.files', { n: item.counts.uncommitted }))),
      })),
      selectedId: repo?.id,
      onSelect: (id) => { close(); controller.changeRepo(id) },
      anchor: h('button', {
        type: 'button', className: 'dwb-rp-scope', 'aria-haspopup': 'menu', 'aria-expanded': openMenu === 'repo', disabled: scope.kind === 'turn',
        'aria-label': t('rp.repo.aria', { name: scope.kind === 'turn' ? t('rp.repo.all') : repo?.name ?? '' }),
        onClick: event => controller.setMenuFrom(event, openMenu === 'repo' ? undefined : 'repo'),
      }, h('span', null, scope.kind === 'turn' ? t('rp.repo.all') : repo?.name ?? ''), h(ui.IconChevronDownOutlineRegular, { size: 14 })),
    }) : null,
    files === undefined ? null : h('span', { className: 'dwb-rp-sum' }, t('rp.files', { n: files.files }), h(RpCounts, { added: files.added, deleted: files.deleted })),
    h(RpReviewedProgress, { controller, diff, turnData }),
    h('span', { className: 'dwb-rp-grow' }),
    reviewOn && repo?.kind === 'git' && scope.kind !== 'turn' ? h(RpReviewMenu, { controller }) : null,
    h('button', {
      type: 'button', className: 'dwb-rp-ib dwb-rp-wide', 'aria-pressed': split, 'aria-label': t('rp.toggleSplit'),
      onClick: () => controller.setSplit(value => !value),
    }, h(ui.IconCompareSplitOutlineRegular, { size: 16 })),
    h('button', {
      type: 'button', className: 'dwb-rp-ib dwb-rp-wide', 'aria-pressed': wrap, 'aria-label': t('rp.toggleWrap'),
      onClick: () => controller.setWrap(value => !value),
    }, h(ui.IconWrapLinesOutlineRegular, { size: 16 })),
    h('button', { type: 'button', className: 'dwb-rp-ib dwb-rp-wide', 'aria-label': t('rp.refresh'), onClick: () => controller.refresh() }, h(ui.IconRefreshOutlineRegular, { size: 16 })),
    h(ui.Menu, {
      className: 'dwb-rp-view-menu', open: openMenu === 'view', onClose: close, portal: true, autoFocus: true, align: 'end',
      items: viewItems, onSelect: onView,
      anchor: h('button', {
        type: 'button', className: 'dwb-rp-ib dwb-rp-narrow', 'aria-haspopup': 'menu', 'aria-expanded': openMenu === 'view', 'aria-label': t('rp.view'),
        onClick: event => controller.setMenuFrom(event, openMenu === 'view' ? undefined : 'view'),
      }, h(ui.IconEllipsisOutlineRegular, { size: 16 })),
    }))
}

/** 已审阅的进度（分支范围和轮次）：已审阅 1 / 5。 */
function RpReviewedProgress({ controller, diff, turnData }) {
  const { t, scope, sessionId } = controller
  if (scope.kind === 'turn') {
    const files = turnData?.seq === scope.seq && typeof turnData.summary === 'object' ? turnData.summary.files : []
    if (files.length === 0) return null
    const seen = rpTurnSeen(`${sessionId}/${scope.seq}`)
    return h('span', { className: 'dwb-rp-meta' }, t('rp.reviewedProgress', { viewed: files.filter((_file, index) => seen.has(index)).length, total: files.length }))
  }
  if (scope.kind !== 'branch' || diff.phase !== 'ready' || diff.files.length === 0) return null
  const seen = rpReviewedOf(controller)
  return h('span', { className: 'dwb-rp-meta' }, t('rp.reviewedProgress', { viewed: diff.files.filter(file => seen.has(file.path)).length, total: diff.files.length }))
}

/** 轮次已审阅的文件下标：照改动审阅原来的存法（loadSeen、saveSeen，按会话和轮次），窗口里另缓存一份，存不进浏览器时也记着。 */
const rpTurnSeenCache = new Map()
function rpTurnSeen(roundKey) {
  if (!rpTurnSeenCache.has(roundKey)) rpTurnSeenCache.set(roundKey, loadSeen(roundKey, rpStorage()))
  return rpTurnSeenCache.get(roundKey)
}
function rpSetTurnSeen(roundKey, seen) {
  rpTurnSeenCache.set(roundKey, seen)
  saveSeen(roundKey, seen, rpStorage())
}

/** 分支范围已审阅的文件：浏览器存储里按会话、仓库、范围存路径，窗口里另缓存一份。 */
const RP_REVIEWED_STORE = 'dsh-workbench-review-viewed'
const rpReviewedCache = new Map()
const rpReviewedKey = controller => `${RP_REVIEWED_STORE}:${controller.sessionId}:${controller.repo?.id}:${scopeKey(controller.scope)}`
function rpReviewedOf(controller) {
  const key = rpReviewedKey(controller)
  if (!rpReviewedCache.has(key)) {
    let list = []
    try {
      const raw = rpStorage()?.getItem(key)
      list = raw === null || raw === undefined ? [] : JSON.parse(raw)
    } catch {
      // 存档坏了：当没有审阅过。
      list = []
    }
    rpReviewedCache.set(key, new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : []))
  }
  return rpReviewedCache.get(key)
}
function rpSetReviewed(controller, path, on) {
  const key = rpReviewedKey(controller)
  const next = new Set(rpReviewedOf(controller))
  if (on) next.add(path)
  else next.delete(path)
  rpReviewedCache.set(key, next)
  try {
    rpStorage()?.setItem(key, JSON.stringify([...next]))
  } catch {
    // 存不进去：已审阅只是显示状态，这一次打开里照样记着。
  }
}

/** 工具栏的审查菜单和报告栏的报告列表各自锚定到触发按钮。 */
function RpReviewMenu({ controller, reportsOnly = false }) {
  const { t, openMenu, setOpenMenu, reports, report } = controller
  const now = Date.now()
  const close = () => setOpenMenu(undefined)
  const reportsMenu = reportsOnly ? 'strip-reports' : 'reports'
  const showingReports = openMenu === reportsMenu
  const open = showingReports || (!reportsOnly && openMenu === 'review')
  const canStart = controller.canStartReview
  const reportItems = reports.length === 0 ? [{ type: 'label', id: 'none', text: t('lr.noReports') }] : reports.map((item) => {
    const ago = reviewAgo(new Date(item.created).toISOString(), now)
    const what = item.selection?.mode === 'branch' ? t('rp.review.titleBranch', { base: item.selection.base }) : t('rp.review.titleUncommitted')
    return {
      id: item.id,
      label: h('span', { className: 'dwb-rp-mi' },
        h('span', { className: 'dwb-rp-mi-name' }, t('rp.review.reportItem', { time: ago === undefined ? '' : t(`rp.time.${ago.unit}`, { n: ago.n }), scope: what })),
        h('span', { className: 'dwb-rp-mi-sub' }, item.status === 'completed' ? t('rp.review.reportFindings', { n: item.findings?.length ?? 0 }) : t(`lr.${item.status}`))),
    }
  })
  const anchor = reportsOnly ? h(ui.Button, {
    variant: 'ghost', size: 'sm', 'aria-haspopup': 'menu', 'aria-expanded': open,
    onClick: event => {
      if (!open) void controller.loadReports()
      controller.setMenuFrom(event, open ? undefined : reportsMenu)
    },
  }, t('rp.review.reports')) : h('button', {
    type: 'button', className: 'dwb-rp-ib', 'aria-haspopup': 'menu', 'aria-expanded': open,
    'aria-pressed': report !== undefined, 'aria-label': t('rp.review'),
    onClick: event => controller.setMenuFrom(event, open ? undefined : 'review'),
  }, h(ui.IconInspectOutlineRegular, { size: 16 }))
  return h(ui.Menu, {
    className: reportsOnly ? 'dwb-rp-report-strip-menu' : showingReports ? 'dwb-rp-reports-menu' : 'dwb-rp-review-menu',
    open, onClose: close, portal: true, autoFocus: true, align: 'end',
    items: reportsOnly || showingReports ? reportItems : [
      { id: 'uncommitted', label: t('rp.review.uncommitted'), disabled: !canStart },
      { id: 'branch', label: t('rp.review.branchMenu'), disabled: !canStart },
      ...(canStart ? [] : [{ type: 'label', id: 'primary-only', text: t('rp.review.primaryOnly') }]),
      { type: 'separator', id: 'sep' },
      { id: 'reports', label: h('span', { className: 'dwb-rp-mi' }, h('span', { className: 'dwb-rp-mi-name' }, t('rp.review.reports')), reports.length > 0 ? h('span', { className: 'dwb-rp-mi-sub' }, t('rp.review.reportsCount', { n: reports.length })) : null) },
      ...(report?.childCreated === true ? [{ id: 'session', label: t('lr.openSession') }] : []),
    ],
    selectedId: reportsOnly || showingReports ? report?.id : undefined,
    onSelect: (id) => {
      if (reportsOnly || showingReports) {
        close()
        void controller.showReport(id)
      } else if (id === 'uncommitted' && canStart) {
        close()
        void controller.startReview('uncommitted')
      } else if (id === 'branch' && canStart) {
        close()
        controller.setDialog({ kind: 'review-branch' })
      } else if (id === 'reports') {
        void controller.loadReports()
        setOpenMenu('reports')
      } else if (id === 'session' && report !== undefined) {
        close()
        // 独立的审查会话（完整分析在那里）：先刷新会话列表，它才在侧边栏里。
        void Promise.resolve(controller.app.ctx.sessions?.refresh?.()).then(() => controller.app.ctx.uiWorkspace?.openSession(report.id))
      }
    },
    anchor,
  })
}

/** 审查结果一栏：范围、条数、各等级条数、上一条、下一条、打开报告；不在当前范围的发现写在第二行，「查看」换过去。 */
function RpReviewStrip({ controller, report, canJump, outside }) {
  const { t } = controller
  const title = report.selection?.mode === 'branch' ? t('rp.review.titleBranch', { base: report.selection.base }) : t('rp.review.titleUncommitted')
  const findings = report.findings ?? []
  const shown = findings.filter(finding => finding.status !== 'ignored')
  const target = reportScope(report)
  const working = report.status === 'capturing' || report.status === 'running'
  return h('div', { className: 'dwb-rp-rstrip', role: 'region', 'aria-label': title },
    h('div', { className: 'dwb-rp-r1' },
      h('span', { className: 'dwb-rp-rtext' },
        h(ui.IconInspectOutlineRegular, { size: 14 }),
        h('b', { role: 'status' }, report.status === 'completed' ? `${title} · ${t('rp.review.count', { n: shown.length })}` : `${title} · ${t(`lr.${report.status}`)}`),
        report.status === 'completed' && shown.length > 0 ? h('span', { className: 'dwb-rp-meta' }, t('rp.review.levels', severityCounts(findings))) : null),
      h('span', { className: 'dwb-rp-ract' },
        working ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => { void lrevRequest('stop', { id: report.id }).catch(() => {}) } }, t('lr.stop')) : null,
        report.status === 'completed' && shown.length > 0 ? h(Fragment, null,
          h('button', { type: 'button', className: 'dwb-rp-ib', 'aria-label': t('rp.review.prev'), disabled: !canJump, onClick: () => controller.jumpFinding(-1) }, h(ui.IconChevronUpOutlineRegular, { size: 16 })),
          h('button', { type: 'button', className: 'dwb-rp-ib', 'aria-label': t('rp.review.next'), disabled: !canJump, onClick: () => controller.jumpFinding(1) }, h(ui.IconChevronDownOutlineRegular, { size: 16 }))) : null,
        h(RpReviewMenu, { controller, reportsOnly: true }),
        h('button', { type: 'button', className: 'dwb-rp-ib', 'aria-label': t('rp.review.closeStrip'), onClick: controller.closeReport }, h(ui.IconCloseOutlineRegular, { size: 14 })))),
    report.status === 'completed' && shown.length === 0 ? h('div', { className: 'dwb-rp-r2' }, `${t((report.files?.length ?? 0) > 0 ? 'lr.noFindings' : 'lr.noChanges')} ${t('lr.noGuarantee')}`) : null,
    report.status === 'error' && report.error ? h('div', { className: 'dwb-rp-r2' }, lrevError(t, new Error(report.error))) : null,
    (report.skipped?.length ?? 0) > 0 ? h('div', { className: 'dwb-rp-r2' }, `${t('lr.skipped')}：${report.skipped.map(file => `${file.path}（${t(Object.hasOwn(LOCAL_REVIEW_ZH, `lr.skip.${file.reason}`) ? `lr.skip.${file.reason}` : 'lr.skip.unreadable')}）`).join('、')}`) : null,
    outside.length > 0 ? h('div', { className: 'dwb-rp-r2' },
      h('span', null, t('rp.review.outside', { n: outside.length, scope: rpScopeName(t, target) })),
      h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => controller.goToReportScope(report) }, t('rp.review.show'))) : null)
}

/**
 * 「文件」右键目标上本面板加的项：值里带 dwbReview（打开菜单的面板编号、仓库内路径、这一处）才加，别处的文件菜单不加。
 * 选中了文字时最前面加「复制」。
 * @param {object | undefined} panel 视图登记的回调：编号、范围、文件和各操作。
 * @param {{dwbReview?: {panel: string, path: string, hunk?: string}}} value 右键目标的值。
 * @returns {object[]} 菜单项。
 */
function rpFileMenuItems(panel, value) {
  const mark = value?.dwbReview
  if (panel === undefined || mark === undefined || mark.panel !== panel.id) return []
  const { t, scope, running } = panel
  const file = panel.fileOf(mark.path)
  if (file === undefined) return []
  const items = []
  const selection = typeof globalThis.getSelection === 'function' ? String(globalThis.getSelection() ?? '') : ''
  if (selection !== '') items.push({ id: 'copy', label: t('rp.copy'), icon: { key: RP_ICON.copy }, run: () => { void ui.writeClipboard(selection) } })
  if (mark.hunk === undefined) {
    const actions = fileActions({ scope, file, running })
    if (actions.stage) items.push({ id: 'stage', label: t('rp.stage'), icon: { key: RP_ICON.stage }, run: () => panel.stage(file) })
    if (actions.unstage) items.push({ id: 'unstage', label: t('rp.unstage'), icon: { key: RP_ICON.unstage }, run: () => panel.unstage(file) })
    if (actions.revert) items.push({ id: 'revert', label: t('rp.revertFile'), icon: { key: RP_ICON.revert }, disabled: actions.revert.disabled, run: () => panel.revert(file) })
    return items
  }
  const hunk = Array.isArray(file.hunks) ? file.hunks.find(item => item.id === mark.hunk) : undefined
  if (hunk === undefined) return items
  const actions = hunkActions({ scope, file, running })
  if (actions.stage) items.push({ id: 'stage-hunk', label: t('rp.stageHunk'), icon: { key: RP_ICON.stage }, run: () => panel.stage(file, hunk) })
  if (actions.unstage) items.push({ id: 'unstage-hunk', label: t('rp.unstageHunk'), icon: { key: RP_ICON.unstage }, run: () => panel.unstage(file, hunk) })
  if (actions.revert) items.push({ id: 'revert-hunk', label: t('rp.revertHunk'), icon: { key: RP_ICON.revert }, disabled: actions.revert.disabled, run: () => panel.revert(file, hunk) })
  const row = mark.oldLine !== undefined
    ? hunk.rows.find(item => item.cur === undefined && item.old === mark.oldLine)
    : mark.line !== undefined ? hunk.rows.find(item => item.cur === mark.line)
      : hunk.rows.find(item => item.cur !== undefined) ?? hunk.rows[0]
  if (row !== undefined) items.push({ id: 'comment', label: t('rp.addComment'), icon: { key: RP_ICON.comment }, run: () => panel.comment(file, hunk, row) })
  items.push({ id: 'copy-hunk', label: t('rp.copyHunk'), icon: { key: RP_ICON.copyHunk }, run: () => { void ui.writeClipboard(rpHunkText(hunk)) } })
  return items
}

/** 视图登记「文件」右键目标的加项；回调每次渲染更新（放在 ref 里），登记只做一次。 */
function useRpFileMenu(controller, panelRef) {
  useEffect(() => controller.app.ctx.contextMenus.register({
    id: `dsh-workbench.review-panel.${controller.panelId}`, target: 'file', order: 50,
    resolve: value => rpFileMenuItems(panelRef.current, value),
  }), [])
}

/** Context Menu 和 Shift+F10 和右键打开同一组操作。 */
function rpContextMenuKey(event) {
  return !event.defaultPrevented && !event.repeat && !event.nativeEvent?.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey
    && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
}

const rpCommentLine = row => row.cur ?? row.old
const rpCommentSide = row => (row.cur === undefined ? 'old' : 'new')
const rpCommentAt = (t, item) => t(item.side === 'old' ? 'rp.comment.atOld' : 'review.commentAt', { line: String(item.line) })

/** 只在行号、内容和相邻行一致时把 Git 评论挂回原处。 */
function rpCommentAnchor(hunk, row) {
  const at = hunk.rows.indexOf(row)
  return JSON.stringify([hunk.rows[at - 1], row, hunk.rows[at + 1]].map(item => (item === undefined ? null : [item.old, item.cur, item.text])))
}

function rpFindCommentRow(hunk, target, scopeText) {
  if (target.scopeText !== scopeText) return undefined
  const row = hunk.rows.find(item => rpCommentLine(item) === target.line && rpCommentSide(item) === (target.side ?? 'new'))
  if (row === undefined || (target.anchor !== undefined && rpCommentAnchor(hunk, row) !== target.anchor)) return undefined
  return row
}

/** 当前范围的已保存评论和草稿。切换范围后，异步发送的结果仍更新原范围。 */
function useRpComments(key, scopeText, repoRoot) {
  const subscribe = useCallback(listener => subscribeRoundComments(key, listener), [key])
  const { comments, composer, sending } = React.useSyncExternalStore(subscribe, () => roundCommentState(key))
  const [selected, setSelected] = useState(undefined)
  const focusTarget = useRef(undefined)
  const openComposer = (target, draft = '') => {
    focusTarget.current = target
    updateRoundCommentState(key, { composer: target }, draft)
  }
  return {
    key, comments, selected: selected?.key === key ? selected : undefined, composer, sending, scopeText,
    select: (fileIndex, row) => {
      const line = rpCommentLine(row)
      const side = rpCommentSide(row)
      setSelected(current => current?.key === key && current.fileIndex === fileIndex && current.side === side && current.line === line
        ? undefined : { key, fileIndex, line, side })
    },
    open: (file, hunk, row) => {
      setSelected(undefined)
      const side = rpCommentSide(row)
      const display = side === 'old' ? file.oldPath ?? file.display : file.display
      const target = {
        fileIndex: file.index ?? file.path, display,
        messagePath: repoRoot === undefined ? undefined : `${repoRoot}/${display}`,
        line: rpCommentLine(row), side, snippet: row.text, scopeText,
        anchor: scopeText === undefined ? undefined : rpCommentAnchor(hunk, row),
      }
      openComposer(target)
    },
    edit: item => openComposer(item, item.text),
    focus: (target, input) => {
      if (focusTarget.current !== target) return
      focusTarget.current = undefined
      input?.focus()
    },
    draft: () => roundCommentDraft(key),
    type: (target, draft) => updateRoundCommentDraft(key, target, draft),
    close: () => updateRoundCommentState(key, { composer: undefined }),
    save: (target, text) => addRoundComment(key, { ...target, text }),
    remove: item => removeRoundComment(key, item.fileIndex, item.line, item.id),
  }
}

/** Git 范围：分支那一栏、说明、撤销条、文件和底栏。 */
function RpGitView({ controller, diff, branches, commits, branchBase, undos, placed, hiddenFindings, inputActions }) {
  const { t, scope, repo, sessionId } = controller
  const commentScope = scope.kind === 'branch' ? { ...scope, base: diff.base ?? branchBase } : scope
  const scopeText = scopeMessageText(commentScope, repo.branch ?? null)
  const comment = useRpComments(`git:${sessionId}:${repo.id}:${scopeKey(commentScope)}`, scopeText, controller.commentRepoRoot)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [, bump] = useState(0)
  const files = useMemo(() => (diff.phase === 'ready' ? diff.files : []).map(file => ({
    ...file, display: file.path, hunks: file.hunks.map(hunk => ({ ...hunk, rows: rpGitRows(hunk) })),
  })), [diff])
  const seen = scope.kind === 'branch' ? rpReviewedOf(controller) : undefined
  const activeFinding = controller.activeFinding
  useEffect(() => {
    if (activeFinding === undefined) return
    const path = activeFinding.path
    setCollapsed((current) => {
      if (seen?.has(path)) return current.has(`open:${path}`) ? current : new Set(current).add(`open:${path}`)
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
  }, [activeFinding])
  const panelRef = useRef(undefined)
  panelRef.current = {
    id: controller.panelId, t, scope, running: controller.running,
    fileOf: path => files.find(file => file.path === path),
    stage: (file, hunk) => controller.stage(file.path, hunk?.id),
    unstage: (file, hunk) => controller.unstage(file.path, hunk?.id),
    revert: (file, hunk) => controller.revert(file.path, hunk),
    comment: comment.open,
  }
  useRpFileMenu(controller, panelRef)
  const canPlace = item => files.find(file => file.path === item.fileIndex)?.hunks.some(hunk => rpFindCommentRow(hunk, item, scopeText) !== undefined) === true
  const unplaced = comment.comments.filter(item => !canPlace(item))
  const detachedComposer = comment.composer !== undefined && !canPlace(comment.composer) ? comment.composer : undefined
  const message = composeScopeMessage({
    scopeText,
    comments: comment.comments.map(item => unplaced.includes(item) ? { ...item, detached: true } : item),
  })
  const toggle = key => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  return h(Fragment, null,
    h(RpGitBar, { controller, diff, branches, commits, branchBase }),
    scope.kind === 'branch' && branchBase !== null ? h('div', { className: 'dwb-rp-info' }, t(scope.includeUncommitted === true ? 'rp.branchInfoWorktree' : 'rp.branchInfo', { base: branchBase })) : null,
    repo.detached ? h('div', { className: 'dwb-rp-info' }, t('rp.detachedNote')) : null,
    undos.map(record => h('div', { key: record.undoId, className: 'dwb-rp-strip', role: 'status' },
      h(ui.IconCheckOutlineRegular, { size: 14 }),
      h('span', null, t(record.key, record.params)),
      h('span', { className: 'dwb-rp-grow' }),
      h(ui.Button, { variant: 'ghost', size: 'sm', disabled: controller.running || controller.busy, onClick: () => { void controller.undo(record) } }, t('rp.undo')))),
    diff.phase === 'loading' ? h('p', { className: 'dwb-rp-note' }, t('rp.loading'))
      : diff.phase === 'error' ? h(RpDiffError, { controller, diff })
        : diff.phase === 'ready' && files.length === 0 ? h(RpEmpty, { controller })
          : diff.phase === 'ready' ? h('div', { className: 'dwb-rp-files', 'data-rp-panel': controller.panelId },
            files.map((file) => {
              const reviewed = seen?.has(file.path) === true
              return h(RpFile, {
                key: file.path, controller, comment, file, reviewed,
                collapsed: reviewed ? !collapsed.has(`open:${file.path}`) : collapsed.has(file.path),
                toggle: () => toggle(reviewed ? `open:${file.path}` : file.path),
                setReviewed: (on) => { rpSetReviewed(controller, file.path, on); bump(value => value + 1) },
                findings: placed.byFile.get(file.path) ?? [],
                absolute: repo.root === undefined ? undefined : `${repo.root}/${file.path}`,
              })
            })) : null,
    hiddenFindings.length > 0 ? h('section', { className: 'dwb-rp-unplaced', 'aria-label': t('rp.review.findingsWithoutDiff') },
      h('p', { className: 'dwb-rp-note' }, t('rp.review.findingsWithoutDiff')),
      hiddenFindings.map(finding => h(RpFinding, { key: finding.id, controller, finding, showPath: true }))) : null,
    unplaced.length > 0 || detachedComposer !== undefined ? h('section', { className: 'dwb-rp-unplaced', 'aria-label': t('rp.comment.unplaced') },
      h('p', { className: 'dwb-rp-note' }, t('rp.comment.unplaced')),
      unplaced.map(item => h(RpCommentNote, { key: item.id, t, comment: item, controller: comment, detached: true })),
      detachedComposer === undefined ? null : h(RpComposer, { t, target: detachedComposer, controller: comment, detached: true })) : null,
    h(RpFooter, { key: comment.key, controller, comment, message, inputActions }))
}

/** 读差异出错：选的提交不在一条提交链上用官方原话，其余按错误码说，可以重试。 */
function RpDiffError({ controller, diff }) {
  const { t, scope } = controller
  const commitsPicked = scope.kind === 'branch' && scope.from !== undefined
  const text = diff.code === 'no-base' ? t('rp.base.none') : rpErrorText(t, diff, commitsPicked ? 'commits' : 'diff')
  return h('div', { className: 'dwb-rp-empty', role: 'alert' },
    h('b', null, diff.code === 'no-base' || (commitsPicked && diff.code === 'conflict') ? text : t('rp.loadFailed')),
    diff.code === 'no-base' || (commitsPicked && diff.code === 'conflict') ? null : h('span', null, text),
    h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => controller.refresh() }, t('rp.retry')))
}

/** 空了：没有变更，并指向还有内容的范围。 */
function RpEmpty({ controller }) {
  const { t, scope, repo } = controller
  const other = scope.kind === 'unstaged' ? 'staged' : scope.kind === 'staged' ? 'unstaged' : undefined
  const count = other === undefined ? 0 : repo.counts[other]
  return h('div', { className: 'dwb-rp-empty' },
    h('b', null, t('rp.empty')),
    count > 0 ? h('span', null, t(`rp.emptyHint.${other}`, { n: count })) : null,
    count > 0 ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => controller.changeScope({ kind: other }) }, t(`rp.emptyShow.${other}`)) : null)
}

/** 分支那一栏：Git 范围是分支、领先几个、推送和整个范围的操作；分支范围是基准、提交、包含未提交的修改和创建变更请求。 */
function RpGitBar({ controller, diff, branches, commits, branchBase }) {
  const { t, scope, repo, running, busy } = controller
  const actions = scopeActions({ scope, repo, diff: diff.phase === 'ready' ? diff : { files: [] }, running })
  if (scope.kind === 'branch') {
    return h('div', { className: 'dwb-rp-git' },
      h('span', { className: 'dwb-rp-meta' }, t('rp.base')),
      h(RpBaseMenu, { controller, branches, branchBase }),
      h(RpCommitsMenu, { controller, commits }),
      scope.from === undefined ? h(ui.Checkbox, {
        className: 'dwb-rp-check', checked: scope.includeUncommitted === true, label: t('rp.includeUncommitted'),
        onChange: checked => controller.changeScope({ ...scope, includeUncommitted: checked === true }),
      }) : null,
      h('span', { className: 'dwb-rp-grow' }),
      actions.createChangeRequest ? h(ui.Button, {
        variant: 'outline', size: 'sm', disabled: actions.createChangeRequest.disabled || busy,
        onClick: async () => {
          const reason = await sendUserMessage(controller.app, controller.sessionId, t('rp.changeRequestPrompt'), 'review.disconnected')
          controller.setNotice(reason === undefined ? { tone: 'ok', text: t('rp.changeRequestSent') } : { tone: 'error', text: t('review.sendFailed', { reason }) })
        },
      }, t('rp.createChangeRequest')) : null)
  }
  const canPush = repo.pushTarget != null && !repo.detached && repo.head !== null && (repo.ahead > 0 || repo.remoteBranchMissing)
  return h('div', { className: 'dwb-rp-git' },
    repo.detached
      ? h('span', { className: 'dwb-rp-branch' }, h(ui.IconBranchOutlineRegular, { size: 14 }), h('span', null, t('rp.detached', { head: repo.head ?? '' })))
      : h('span', { className: 'dwb-rp-branch', 'aria-label': t('rp.branchAria', { branch: repo.branch ?? '' }) }, h(ui.IconBranchOutlineRegular, { size: 14 }), h('span', null, repo.branch ?? '')),
    !repo.detached && repo.ahead > 0 ? h('span', { className: 'dwb-rp-ahead', 'aria-label': t('rp.ahead', { n: repo.ahead }) }, `↑${repo.ahead}`) : null,
    !repo.detached && repo.behind > 0 ? h('span', { className: 'dwb-rp-ahead', 'aria-label': t('rp.behind', { n: repo.behind }) }, `↓${repo.behind}`) : null,
    canPush && repo.remoteBranchMissing ? h('span', { className: 'dwb-rp-tag' }, t('rp.noRemoteBranch')) : null,
    !repo.detached && repo.head === null ? h('span', { className: 'dwb-rp-tag' }, t('rp.unborn')) : null,
    canPush ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void controller.push() } }, t('rp.push')) : null,
    repo.detached ? h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => controller.setDialog({ kind: 'branch' }) }, t('rp.createBranch')) : null,
    h('span', { className: 'dwb-rp-grow' }),
    actions.stageAll ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: actions.stageAll.disabled || busy, onClick: () => { void controller.stage() } }, t('rp.stageAll')) : null,
    actions.revertAll ? h(ui.Button, { variant: 'ghost', size: 'sm', disabled: actions.revertAll.disabled || busy, onClick: () => controller.setDialog({ kind: 'revert-all' }) }, t('rp.revertAll')) : null,
    actions.unstageAll ? h(ui.Button, { variant: 'ghost', size: 'sm', disabled: actions.unstageAll.disabled || busy, onClick: () => { void controller.unstage() } }, t('rp.unstageAll')) : null,
    actions.commit ? h(ui.Button, { variant: 'primary', size: 'sm', disabled: actions.commit.disabled || busy, onClick: () => controller.setDialog({ kind: 'commit' }) }, t('rp.commit')) : null)
}

/** 基准分支的菜单（照官方「变更」页：搜索框，本地分支、远程分支两组，默认的标出来）。 */
function RpBaseMenu({ controller, branches, branchBase }) {
  const { t, scope, openMenu, setOpenMenu } = controller
  const [query, setQuery] = useState('')
  const open = openMenu === 'base'
  const match = name => name.toLowerCase().includes(query.trim().toLowerCase())
  const groups = branches === undefined ? [] : [
    { id: 'local', label: t('rp.base.local'), names: branches.local.filter(match) },
    { id: 'remote', label: t('rp.base.remote'), names: branches.remote.filter(match) },
  ].filter(group => group.names.length > 0)
  const pick = (name) => {
    setOpenMenu(undefined)
    setQuery('')
    controller.changeScope({ kind: 'branch', base: name, includeUncommitted: scope.includeUncommitted === true })
  }
  const label = branchBase ?? t('rp.base.none')
  return h(ui.Menu, {
    className: 'dwb-rp-base-menu', open, onClose: () => setOpenMenu(undefined), portal: true, dense: true, align: 'start',
    anchor: h('button', {
      type: 'button', className: 'dwb-rp-picker', 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': t('rp.base.aria', { base: label }),
      onClick: event => controller.setMenuFrom(event, open ? undefined : 'base'),
    }, h('span', { className: 'dwb-rp-mono' }, label), h(ui.IconChevronDownOutlineRegular, { size: 12 })),
    children: h('div', { className: 'dwb-rp-menu-root' },
      h('div', { className: 'dwb-rp-menu-search' }, h(ui.Input, {
        icon: h(ui.IconSearchOutlineRegular, { size: 14 }), value: query, autoFocus: true, 'aria-label': t('rp.base.search'), placeholder: t('rp.base.search'),
        onChange: event => setQuery(event.target.value),
        onKeyDown: event => { if (event.key === 'Home' || event.key === 'End') event.stopPropagation() },
      })),
      branches === undefined ? h('div', { className: 'dwb-rp-menu-note' }, t('rp.base.loading'))
        : groups.length === 0 ? h('div', { className: 'dwb-rp-menu-note' }, t('rp.base.empty'))
          : groups.map(group => h('div', { key: group.id, role: 'group', 'aria-label': group.label },
            h('div', { className: 'dwb-rp-menu-label', role: 'presentation' }, group.label),
            group.names.map(name => h(ui.MenuItemButton, { key: name, icon: h(ui.IconBranchOutlineRegular, { size: 14 }), current: name === branchBase, onSelect: () => pick(name) },
              h('span', { className: 'dwb-rp-mi' }, h('span', { className: 'dwb-rp-mi-name dwb-rp-mi-branch dwb-rp-mono' }, name),
                name === branches.defaultBase ? h('span', { className: 'dwb-rp-mi-sub' }, t('rp.base.default')) : null))))),
      h('div', { className: 'dwb-rp-menu-note' }, t('rp.base.note'))),
  })
}

/** 查看的提交：全部提交，或一个、按住 Shift 连续几个（照官方「变更」页）。 */
function RpCommitsMenu({ controller, commits }) {
  const { t, scope, openMenu, setOpenMenu } = controller
  const open = openMenu === 'commits'
  const list = commits?.list ?? []
  const current = scope.from === undefined ? undefined : { from: scope.from, to: scope.to }
  const short = sha => list.find(commit => commit.sha === sha)?.short ?? sha.slice(0, 7)
  const label = current === undefined ? t('rp.commits.all')
    : current.from === current.to ? short(current.from) : t('rp.commits.range', { from: short(current.from), to: short(current.to) })
  const choose = (sha, shift) => {
    setOpenMenu(undefined)
    const next = commitSelection(list, current, sha, shift)
    controller.changeScope(next === undefined
      ? { kind: 'branch', base: scope.base, includeUncommitted: false }
      : { kind: 'branch', base: scope.base, includeUncommitted: false, ...next })
  }
  const from = current === undefined ? -1 : list.findIndex(commit => commit.sha === current.from)
  const to = current === undefined ? -1 : list.findIndex(commit => commit.sha === current.to)
  const now = Date.now()
  return h(ui.Menu, {
    className: 'dwb-rp-commits-menu', open, onClose: () => setOpenMenu(undefined), portal: true, dense: true, autoFocus: true, align: 'start',
    anchor: h('button', {
      type: 'button', className: 'dwb-rp-picker', 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': t('rp.commits.aria', { commits: label }),
      onClick: event => controller.setMenuFrom(event, open ? undefined : 'commits'),
    }, h('span', { className: current === undefined ? undefined : 'dwb-rp-mono' }, label), h(ui.IconChevronDownOutlineRegular, { size: 12 })),
    children: h('div', { className: 'dwb-rp-menu-root' },
      h(ui.MenuItemButton, { current: current === undefined, onSelect: () => choose(null, false) },
        h('span', { className: 'dwb-rp-mi' }, h('span', { className: 'dwb-rp-mi-name' }, t('rp.commits.all')), h('span', { className: 'dwb-rp-mi-sub' }, t('rp.commits.count', { count: list.length })))),
      commits === undefined ? h('div', { className: 'dwb-rp-menu-note' }, t('rp.commits.loading'))
        : commits.failed ? h('div', { className: 'dwb-rp-menu-note' }, t('rp.commits.failed'))
          : list.map((commit, index) => {
            const ago = reviewAgo(commit.time, now)
            return h(ui.MenuItemButton, {
              key: commit.sha, 'data-commit': commit.sha, current: from >= 0 && to >= 0 && index <= from && index >= to,
              onSelect: event => choose(commit.sha, event?.shiftKey === true),
            }, h('span', { className: 'dwb-rp-mi' },
              h('span', { className: 'dwb-rp-mono dwb-rp-mi-sha' }, commit.short),
              h('span', { className: 'dwb-rp-mi-name' }, commit.subject),
              ago === undefined ? null : h('span', { className: 'dwb-rp-mi-sub' }, t(`rp.time.${ago.unit}`, { n: ago.n }))))
          }),
      commits?.truncated ? h('div', { className: 'dwb-rp-menu-note' }, t('rp.commits.truncated', { count: list.length })) : null,
      h('div', { className: 'dwb-rp-menu-note' }, t('rp.commits.shiftHint'))),
  })
}

/**
 * 一个文件：文件头（收起展开、路径、标签、行数、已审阅、这个范围的按钮、更多操作），再是每一处改动。
 * file 是统一后的样子：path、display、status、binary、tooLarge、added、deleted、oldPath，hunks 里每一处带 rows；
 * 轮次的文件还带 index，hunks 没读到时是 'loading'，读不到是 'missing'。turn 是轮次给的回退、撤销和状态条。
 */
function RpFile({ controller, comment, file, collapsed, toggle, reviewed, setReviewed, findings, absolute, turn }) {
  const { t, scope, running, busy, sessionId, panelId } = controller
  const actions = fileActions({ scope, file, running })
  const { dir, name } = splitPath(file.display)
  const ref = useRef(null)
  const menuButton = useRef(null)
  const hunks = Array.isArray(file.hunks) ? file.hunks : []
  const byHunk = new Map()
  const withoutLine = []
  for (const finding of findings) {
    const source = controller.sourceLines?.get(finding.id)
    const hunk = source === undefined || findingSide(file, finding) !== source.side ? undefined
      : hunks.find(item => rpFindingRow(file, item, finding)?.text === source.text)
    if (hunk === undefined) withoutLine.push(finding)
    else {
      if (!byHunk.has(hunk.id)) byHunk.set(hunk.id, [])
      byHunk.get(hunk.id).push(finding)
    }
  }
  useEffect(() => {
    if (controller.reveal !== undefined && file.index === controller.reveal.index) ref.current?.scrollIntoView?.({ block: 'start' })
  }, [controller.reveal?.nonce])
  const openMenu = (event, point) => {
    event.preventDefault()
    event.stopPropagation()
    const focused = point === undefined && event.target?.closest?.('button, input')
    const trigger = focused || menuButton.current
    const rect = point === undefined ? trigger?.getBoundingClientRect() : undefined
    controller.openContextMenu(
      { kind: 'file', value: { sessionId, path: absolute ?? file.path, dwbReview: { panel: panelId, path: file.path } } },
      point ?? { x: rect?.left ?? 0, y: rect?.bottom ?? 0 },
      trigger,
    )
  }
  const primary = turn !== undefined
    ? (actions.revert ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: actions.revert.disabled || turn.wholeReverted, onClick: () => { void turn.revert(null) } }, t('rp.revertFile')) : null)
    : actions.stage ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: actions.stage.disabled || busy, onClick: () => { void controller.stage(file.path) } }, t('rp.stage'))
      : actions.unstage ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void controller.unstage(file.path) } }, t('rp.unstage')) : null
  const wholeHint = actions.stage ? 'rp.wholeFile.stage' : actions.unstage ? 'rp.wholeFile.unstage' : actions.revert ? 'rp.wholeFile.revert' : undefined
  return h('section', { ref, className: 'dwb-rp-file', 'data-path': file.path, 'data-file-index': file.index },
    h('header', {
      className: 'dwb-rp-fhead', onContextMenu: event => openMenu(event, { x: event.clientX, y: event.clientY }),
      onKeyDown: event => { if (rpContextMenuKey(event)) openMenu(event) },
    },
      h('button', { type: 'button', className: 'dwb-rp-chev', 'aria-expanded': !collapsed, 'aria-label': file.display, onClick: toggle },
        collapsed ? h(ui.IconChevronRightOutlineRegular, { size: 14 }) : h(ui.IconChevronDownOutlineRegular, { size: 14 })),
      h('span', { className: 'dwb-rp-path' }, dir === '' ? null : h('span', { className: 'dwb-rp-dir' }, dir), h('span', { className: 'dwb-rp-fname' }, name)),
      file.status === 'untracked' ? h('span', { className: 'dwb-rp-tag' }, t('rp.untracked')) : null,
      file.status === 'added' ? h('span', { className: 'dwb-rp-tag' }, t('rp.newFile')) : null,
      file.status === 'deleted' ? h('span', { className: 'dwb-rp-tag' }, t('rp.deleted')) : null,
      file.status === 'conflict' ? h('span', { className: 'dwb-rp-tag', 'data-tone': 'warn' }, t('rp.conflict')) : null,
      file.binary ? h('span', { className: 'dwb-rp-tag' }, t('rp.binary')) : null,
      file.binary || file.status === 'conflict' ? null : h(RpCounts, { added: file.added, deleted: file.deleted }),
      h('span', { className: 'dwb-rp-grow' }),
      actions.reviewed ? h(ui.Checkbox, {
        className: 'dwb-rp-check', checked: reviewed, label: t('rp.reviewed'), 'aria-label': t('rp.reviewedAria', { name: file.display }),
        onChange: checked => setReviewed(checked === true),
      }) : null,
      primary,
      h('button', {
        ref: menuButton, type: 'button', className: 'dwb-rp-ib', 'aria-label': t('rp.moreActions', { name: file.display }), 'aria-haspopup': 'menu',
        onClick: event => openMenu(event),
      }, h(ui.IconEllipsisOutlineRegular, { size: 16 }))),
    file.oldPath !== undefined ? h('div', { className: 'dwb-rp-info' }, t('rp.renamed', { from: file.oldPath })) : null,
    turn?.header ?? null,
    collapsed ? null : h(Fragment, null,
      withoutLine.map(finding => h(RpFinding, { key: finding.id, controller, finding })),
      file.binary || file.tooLarge ? h('div', { className: 'dwb-rp-body1' }, wholeHint === undefined ? t(file.binary ? 'rp.binaryBody' : 'rp.tooLargeBody') : `${t(file.binary ? 'rp.binaryBody' : 'rp.tooLargeBody')}${t(wholeHint)}`)
        : file.hunks === 'loading' ? h('p', { className: 'dwb-rp-note' }, t('rp.loading'))
          : file.hunks === 'missing' ? h('p', { className: 'dwb-rp-note' }, t('review.missingTitle'))
            : hunks.map((hunk, at) => h(RpHunk, {
              key: hunk.id, controller, comment, file, hunk, hunkIndex: at, absolute, turn, findings: byHunk.get(hunk.id) ?? [],
            }))))
}

function rpFindingRow(file, hunk, finding) {
  const number = findingSide(file, finding) === 'old' ? 'old' : 'cur'
  return hunk.rows.find(row => row[number] === finding.line)
}

/** 一处改动：行区间和这一处的操作，再是代码；评论、写评论的框和审查发现插在对应的行下面（代码在那里断开）。 */
function RpHunk({ controller, comment, file, hunk, hunkIndex, findings, absolute, turn }) {
  const { t, scope, running, busy, sessionId, panelId, split, wrap } = controller
  const actions = hunkActions({ scope, file, running })
  const fileKey = turn !== undefined ? file.index : file.path
  const reverted = turn?.hunkReverted(hunkIndex)
  const error = turn?.hunkError(hunkIndex)
  const [activeRow, setActiveRow] = useState(0)
  const attachments = new Map()
  const attach = (row, node) => {
    if (!attachments.has(row)) attachments.set(row, [])
    attachments.get(row).push(node)
  }
  for (const item of comment.comments) {
    const row = item.fileIndex === fileKey ? rpFindCommentRow(hunk, item, comment.scopeText) : undefined
    if (row !== undefined) attach(row, h(RpCommentNote, { key: `c${item.id}`, t, comment: item, controller: comment }))
  }
  if (comment.composer?.fileIndex === fileKey) {
    const row = rpFindCommentRow(hunk, comment.composer, comment.scopeText)
    if (row !== undefined) attach(row, h(RpComposer, { key: 'composer', t, target: comment.composer, controller: comment }))
  }
  for (const finding of findings) attach(rpFindingRow(file, hunk, finding), h(RpFinding, { key: finding.id, controller, finding }))
  const code = (key, rows) => h('div', { key, className: 'dwb-rp-code', 'data-split': split ? 'split' : 'unified', 'data-wrap': wrap ? 'wrap' : undefined }, rows)
  const segments = []
  let rows = []
  hunk.rows.forEach((row, at) => {
    rows.push(h(RpRow, {
      key: at, t, row, split,
      tabIndex: at === Math.min(activeRow, hunk.rows.length - 1) ? 0 : -1,
      onFocus: () => setActiveRow(at),
      selected: comment.selected?.fileIndex === fileKey && comment.selected.line === rpCommentLine(row) && comment.selected.side === rpCommentSide(row),
      onSelect: () => comment.select(fileKey, row),
      onComment: () => comment.open(file, hunk, row),
    }))
    const extra = attachments.get(row)
    if (extra !== undefined) {
      segments.push(code(`s${at}`, rows), ...extra)
      rows = []
    }
  })
  if (rows.length > 0) segments.push(code('end', rows))
  const open = (event, keyboard = false) => {
    event.preventDefault()
    event.stopPropagation()
    const picked = Number(event.target?.closest?.('[data-line]')?.dataset?.line)
    const line = Number.isInteger(picked) ? picked : undefined
    const pickedOld = Number(event.target?.closest?.('[data-old-line]')?.dataset?.oldLine)
    const oldLine = Number.isInteger(pickedOld) ? pickedOld : undefined
    const trigger = keyboard ? event.target : event.target?.closest?.('[data-line], [data-old-line]')?.querySelector('.dwb-rp-pick')
      ?? event.currentTarget?.querySelector?.('.dwb-rp-pick[tabindex="0"]')
    const rect = keyboard ? trigger.getBoundingClientRect() : undefined
    controller.openContextMenu(
      { kind: 'file', value: { sessionId, path: absolute ?? file.path, line: line ?? (hunk.newLines > 0 ? hunk.newStart : oldLine ?? hunk.oldStart), dwbReview: { panel: panelId, path: file.path, hunk: hunk.id, line, oldLine } } },
      { x: rect?.left ?? event.clientX, y: rect?.bottom ?? event.clientY },
      trigger,
    )
  }
  const onKeyDown = (event) => {
    if (rpContextMenuKey(event)) {
      open(event, true)
      return
    }
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !event.target?.classList?.contains('dwb-rp-pick')) return
    const key = event.key
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return
    const buttons = Array.from(event.currentTarget.querySelectorAll('.dwb-rp-pick'))
    const index = buttons.indexOf(event.target)
    const next = key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 : index + (key === 'ArrowUp' ? -1 : 1)
    event.preventDefault()
    buttons[next]?.focus()
  }
  return h('div', { className: 'dwb-rp-hunkwrap', 'data-hunk': hunk.id, onContextMenu: event => open(event), onKeyDown },
    reverted !== undefined
      ? h('div', { className: 'dwb-rp-strip' }, h(ui.IconCheckOutlineRegular, { size: 14 }), h('span', null, t('review.revertedStrip', { what: reverted.description })),
        h('span', { className: 'dwb-rp-grow' }), h(ui.Button, { variant: 'ghost', size: 'sm', disabled: running, onClick: () => { void turn.undo(hunkIndex) } }, t('rp.undo')))
      : h('div', { className: 'dwb-rp-hunk' },
        h('span', { className: 'dwb-rp-range' }, rpHunkRange(t, hunk)),
        h('span', { className: 'dwb-rp-grow' }),
        actions.stage ? h(ui.Button, { variant: 'ghost', size: 'sm', disabled: actions.stage.disabled || busy, onClick: () => { void controller.stage(file.path, hunk.id) } }, t('rp.stageHunk')) : null,
        actions.unstage ? h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => { void controller.unstage(file.path, hunk.id) } }, t('rp.unstageHunk')) : null,
        actions.revert ? h(ui.Button, {
          variant: 'ghost', size: 'sm', disabled: actions.revert.disabled || busy || turn?.wholeReverted === true,
          onClick: () => { void (turn !== undefined ? turn.revert(hunkIndex) : controller.revert(file.path, hunk)) },
        }, t('rp.revertHunk')) : null),
    error !== undefined ? h('div', { className: 'dwb-rp-notice', 'data-tone': 'error', role: 'alert' }, h(ui.IconWarningOutlineRegular, { size: 14 }), h('span', null, error)) : null,
    segments)
}

/**
 * 一行代码：单栏是「旧行号 新行号 标记 内容」，左右对比各一栏。标记（加号、减号）由样式按 data-tone 画，复制代码时不带上。
 * 行号可选中这一行。选中后显示添加评论按钮。
 */
function RpRow({ t, row, split, selected, tabIndex, onFocus, onSelect, onComment }) {
  const added = row.old === undefined
  const removed = row.cur === undefined
  const tone = added ? 'add' : removed ? 'del' : undefined
  const no = number => h('span', { className: 'dwb-rp-no' }, number === undefined ? '' : String(number))
  const line = String(rpCommentLine(row))
  const number = h('span', { className: 'dwb-rp-no dwb-rp-gutter' },
    h('button', {
      type: 'button', className: 'dwb-rp-pick', tabIndex, 'aria-pressed': selected === true,
      'aria-label': t(removed ? 'rp.comment.selectOld' : 'review.selectLine', { line }),
      'aria-keyshortcuts': 'ArrowUp ArrowDown Home End Shift+F10', onFocus, onClick: onSelect,
    }, line),
    selected === true ? h('button', { type: 'button', className: 'dwb-rp-plus', 'aria-label': t(removed ? 'rp.comment.addOld' : 'review.commentAria', { line }), onClick: onComment }, h(ui.IconPlusOutlineRegular, { size: 12 })) : null)
  const original = removed ? number : no(row.old)
  const current = removed ? no(row.cur) : number
  const mark = h('span', { className: 'dwb-rp-mk', 'aria-hidden': true })
  const props = { className: 'dwb-rp-ln', 'data-tone': tone, 'data-line': row.cur, 'data-old-line': removed ? row.old : undefined }
  if (split) {
    return h('div', props,
      added ? h('span', { className: 'dwb-rp-cell' }) : h('span', { className: 'dwb-rp-cell', 'data-tone': removed ? 'del' : undefined }, original, mark, h('span', { className: 'dwb-rp-text' }, row.text)),
      removed ? h('span', { className: 'dwb-rp-cell' }) : h('span', { className: 'dwb-rp-cell', 'data-tone': added ? 'add' : undefined }, current, mark, h('span', { className: 'dwb-rp-text' }, row.text)))
  }
  return h('div', props, original, current, mark, h('span', { className: 'dwb-rp-text' }, row.text))
}

/** 已添加的评论（行下面，可编辑、删除）。 */
function RpCommentNote({ t, comment, controller, detached = false }) {
  return h('div', { className: 'dwb-rp-cnote', 'data-testid': 'dwb-review-comment' },
    h('div', { className: 'dwb-rp-cnote-head' },
      h('span', null, detached ? `${comment.display} · ${rpCommentAt(t, comment)}` : rpCommentAt(t, comment)),
      h('span', { className: 'dwb-rp-grow' }),
      h('button', { type: 'button', className: 'dwb-linklike', onClick: () => controller.edit(comment) }, t('review.commentEdit')),
      h('button', { type: 'button', className: 'dwb-linklike', onClick: () => controller.remove(comment) }, t('review.commentDelete'))),
    detached ? h('code', { className: 'dwb-rp-cnote-text' }, comment.snippet) : null,
    h('p', { className: 'dwb-rp-cnote-text' }, comment.text))
}

/** 写评论的框（点了某行的「+」或编辑后出现）。 */
function RpComposer({ t, target, controller, detached = false }) {
  const [draft, setDraft] = useState(controller.draft)
  const input = useRef(null)
  useEffect(() => {
    setDraft(controller.draft())
    controller.focus(target, input.current)
  }, [target])
  const type = (event) => {
    const text = event.target.value
    setDraft(text)
    controller.type(target, text)
  }
  const label = detached ? `${target.display} · ${rpCommentAt(t, target)}` : rpCommentAt(t, target)
  return h('div', { className: 'dwb-rp-cbox', 'data-testid': 'dwb-review-composer' },
    h('div', { className: 'dwb-rp-cnote-head' }, label),
    detached ? h('code', { className: 'dwb-rp-cnote-text' }, target.snippet) : null,
    h('textarea', { ref: input, className: 'dwb-rp-input', value: draft, rows: 2, 'aria-label': label, placeholder: t('review.commentPlaceholder'), onChange: type }),
    h('div', { className: 'dwb-rp-row-end' },
      h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => controller.close() }, t('review.commentCancel')),
      h(ui.Button, { variant: 'primary', size: 'sm', disabled: draft.trim() === '', onClick: () => controller.save(target, draft.trim()) }, t(target.id === undefined ? 'review.commentAdd' : 'review.commentSave'))))
}

/** 一条审查发现：等级、行号、标题和说明，「忽略」「修这一条」；忽略后收成一行能恢复；发过以后标待验证；报告过时换成「重新审查」。 */
function RpFinding({ controller, finding, showPath = false }) {
  const { t, report } = controller
  const [working, setWorking] = useState(false)
  const ref = useRef(null)
  const active = controller.activeFinding?.id === finding.id ? controller.activeFinding : undefined
  const severity = t(`lr.${finding.severity}`)
  const level = h('span', { className: 'dwb-rp-lv', 'data-level': finding.severity }, severity)
  useEffect(() => {
    if (active === undefined) return
    ref.current?.scrollIntoView({ block: 'center' })
    if (active.focus) ref.current?.focus({ preventScroll: true })
  }, [active])
  const change = async (status) => {
    setWorking(true)
    try {
      controller.mergeReport(await lrevRequest('state', { id: report.id, findingId: finding.id, status, revision: report.revision }))
    } catch (error) {
      controller.setNotice({ tone: 'error', text: lrevError(t, error) })
    } finally {
      setWorking(false)
    }
  }
  if (finding.status === 'ignored') {
    return h('div', { className: 'dwb-rp-fnd', 'data-ignored': true, 'data-finding': finding.id },
      h('div', { className: 'dwb-rp-fnd-lab' }, level, h('span', { className: 'dwb-rp-fnd-ign' }, t('rp.review.ignored', { title: finding.title })),
        h('span', { className: 'dwb-rp-grow' }), h(ui.Button, { variant: 'ghost', size: 'sm', disabled: working, onClick: () => { void change('open') } }, t('lr.restore'))))
  }
  const stale = report.stale === true
  const again = () => {
    const selection = report.selection ?? { mode: 'uncommitted', untracked: false }
    void controller.startReview((selection.mode === 'branch' ? `--base ${selection.base}` : 'uncommitted') + (selection.untracked ? ' --untracked' : ''))
  }
  const line = finding.endLine !== undefined && finding.endLine !== finding.line ? t('rp.review.lines', { start: finding.line, end: finding.endLine }) : t('rp.review.line', { line: finding.line })
  return h('div', {
    ref, className: 'dwb-rp-fnd', 'data-finding': finding.id, role: 'group', tabIndex: -1,
    'aria-current': active === undefined ? undefined : 'true',
    'aria-label': `${severity} · ${finding.path} · ${line} · ${finding.title}`,
  },
    h('div', { className: 'dwb-rp-fnd-lab' }, level, h('span', null, showPath ? `${finding.path} · ${line}` : line), finding.status === 'pending' ? h('span', { className: 'dwb-rp-tag' }, t('lr.pending')) : null),
    h('h4', null, finding.title),
    h('p', null, stale ? t('lr.stale') : finding.description),
    finding.status === 'pending' ? null : h('div', { className: 'dwb-rp-row-end' },
      h(ui.Button, { variant: 'ghost', size: 'sm', disabled: working, onClick: () => { void change('ignored') } }, t('lr.ignore')),
      stale ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: !controller.canStartReview, onClick: again }, t('rp.review.again'))
        : h(ui.Button, { variant: 'outline', size: 'sm', disabled: working || report.status !== 'completed', onClick: () => controller.setDialog({ kind: 'fix', finding }) }, t('lr.fix'))))
}

/** 底栏：攒着的评论，「添加到输入框」「发送消息」（进行中写「排队发送」）。发出后只清掉发出去时一模一样的那些。 */
function RpFooter({ controller, comment, message, inputActions, onSent }) {
  const { t, running, app, sessionId } = controller
  const { key, sending } = comment
  const [error, setError] = useState(undefined)
  const send = async () => {
    if (message === undefined || roundCommentState(key).sending) return
    const sent = [...comment.comments]
    updateRoundCommentState(key, { sending: true })
    const reason = await sendUserMessage(app, sessionId, message, 'review.disconnected')
    updateRoundCommentState(key, { sending: false })
    if (reason === undefined) {
      clearSentRoundComments(key, sent)
      onSent?.()
      setError(undefined)
    } else {
      setError(t('review.sendFailed', { reason }))
    }
  }
  return h('footer', { className: 'dwb-rp-foot' },
    h('span', { className: 'dwb-rp-meta' }, t('review.footerComments', { n: comment.comments.length })),
    error !== undefined ? h('span', { className: 'dwb-rp-error', role: 'alert' }, error) : null,
    h('span', { className: 'dwb-rp-grow' }),
    h(ui.Button, {
      variant: 'ghost', size: 'sm', disabled: message === undefined || sending,
      // 末尾带换行（同「回复」）：再添加一段时从新的一行开始，不接在这段后面。
      onClick: () => setError(insertIntoDraft(inputActions, `${message}\n`) ? undefined : t('review.toDraftFailed')),
    }, t('review.toDraft')),
    h(ui.Button, { variant: 'primary', size: 'sm', disabled: message === undefined || sending, onClick: () => { void send() } }, running ? t('review.queueSend') : t('review.send')))
}

/** 第 N 轮改动：DSH 的改动摘要和差异，回退、撤销走改动审阅的路由；评论和回退的变化一起发（照改动审阅原来的做法）。 */
function RpTurnView({ controller, turnData, inputActions }) {
  const { t, scope, sessionId, running } = controller
  const roundKey = `${sessionId}/${scope.seq}`
  const summary = turnData?.seq === scope.seq ? turnData.summary : 'loading'
  const files = typeof summary === 'object' ? summary.files : []
  const comment = useRpComments(roundKey)
  const [seen, setSeen] = useState(() => rpTurnSeen(roundKey))
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [sentReverts, setSentReverts] = useState(() => sentRevertsByRound.get(roundKey) ?? new Map())
  const shown = files.map((file, index) => {
    const raw = turnData?.diffs.get(index)
    return {
      path: file.path, display: file.display, index,
      status: raw?.before === false ? 'added' : raw?.after === false ? 'deleted' : 'modified',
      binary: file.binary === true || raw?.kind === 'binary', tooLarge: file.oversized === true || raw?.kind === 'oversized', added: file.added, deleted: file.deleted,
      hunks: raw === undefined || raw === 'loading' ? 'loading'
        : raw === 'missing' || (raw.kind !== 'text' && raw.kind !== 'binary' && raw.kind !== 'oversized') ? 'missing'
          : raw.kind === 'text' ? raw.hunks.map((hunk, at) => ({ ...hunk, id: `t${at}`, rows: hunkRows(hunk) })) : [],
    }
  })
  const isCollapsed = index => (seen.has(index) ? !collapsed.has(`open:${index}`) : collapsed.has(index))
  useEffect(() => {
    shown.forEach((file) => {
      if (!isCollapsed(file.index) && file.hunks === 'loading' && turnData?.diffs.get(file.index) === undefined && !file.binary && !file.tooLarge) void controller.loadTurnDiff(file.index)
    })
  }, [summary, seen, collapsed])
  const reverts = turnData?.reverts ?? []
  const panelRef = useRef(undefined)
  const turnOf = index => ({
    wholeReverted: reverts.some(item => item.fileIndex === index && item.hunkIndex === null),
    revert: hunkIndex => controller.turnAction('api/dsh-workbench.review.revert', index, hunkIndex),
    undo: hunkIndex => controller.turnAction('api/dsh-workbench.review.undo', index, hunkIndex),
    hunkReverted: hunkIndex => reverts.find(item => item.fileIndex === index && item.hunkIndex === hunkIndex),
    hunkError: hunkIndex => turnData?.errors.get(`${index}:${hunkIndex}`),
  })
  panelRef.current = {
    id: controller.panelId, t, scope, running,
    fileOf: path => shown.find(file => file.path === path),
    revert: (file, hunk) => turnOf(file.index).revert(hunk === undefined ? null : Number(hunk.id.slice(1))),
    comment: comment.open,
  }
  useRpFileMenu(controller, panelRef)
  const news = revertNews(reverts, sentReverts, turnData?.revertsLoaded === true)
  const message = composeReviewMessage({
    turn: scope.turn,
    comments: comment.comments,
    reverts: news.pending.map(item => ({ display: item.display, description: item.description })),
    undoneReverts: news.undone.map(item => ({ display: item.display, description: item.description })),
  })
  const toggleSeen = (index, on) => setSeen((current) => {
    const next = new Set(current)
    if (on) next.add(index)
    else next.delete(index)
    rpSetTurnSeen(roundKey, next)
    return next
  })
  useEffect(() => { controller.touchReviewed() }, [seen])
  if (summary === 'loading') return h('p', { className: 'dwb-rp-note' }, t('review.loading'))
  if (summary === 'missing') return h('div', { className: 'dwb-rp-empty' }, h('b', null, t('review.missingTitle')), h('span', null, t('review.missingBody')))
  return h(Fragment, null,
    h('div', { className: 'dwb-rp-files', 'data-rp-panel': controller.panelId },
      shown.map((file) => {
        const index = file.index
        const whole = reverts.find(item => item.fileIndex === index && item.hunkIndex === null)
        const wholeError = turnData.errors.get(`${index}:w`)
        return h(RpFile, {
          key: `${index}:${file.path}`, controller, comment, file,
          turn: {
            ...turnOf(index),
            header: whole === undefined && wholeError === undefined ? null : h(Fragment, null,
              whole !== undefined ? h('div', { className: 'dwb-rp-strip' }, h(ui.IconCheckOutlineRegular, { size: 14 }), h('span', null, t('review.revertedStrip', { what: whole.description })),
                h('span', { className: 'dwb-rp-grow' }), h(ui.Button, { variant: 'ghost', size: 'sm', disabled: running, onClick: () => { void turnOf(index).undo(null) } }, t('rp.undo'))) : null,
              wholeError !== undefined ? h('div', { className: 'dwb-rp-notice', 'data-tone': 'error', role: 'alert' }, h(ui.IconWarningOutlineRegular, { size: 14 }), h('span', null, wholeError)) : null),
          },
          collapsed: isCollapsed(index),
          toggle: () => setCollapsed((current) => {
            const next = new Set(current)
            const key = seen.has(index) ? `open:${index}` : index
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          }),
          reviewed: seen.has(index), setReviewed: on => toggleSeen(index, on), findings: [],
        })
      })),
    h(RpFooter, {
      controller, comment, message, inputActions,
      onSent: () => {
        // 记下这一轮报过的回退：现在的整份清单就是模型知道的样子；清单还没读到时不动已报表。
        if (turnData?.revertsLoaded !== true) return
        const now = sentRevertsOf(reverts)
        sentRevertsByRound.set(roundKey, now)
        setSentReverts(now)
      },
    }))
}

/** 对话框：全部回退的确认、提交、在此建分支、修这一条、审查与分支的差异。 */
function RpDialog({ controller, dialog, diff }) {
  if (dialog.kind === 'revert-all') return h(RpRevertAllDialog, { controller, diff })
  if (dialog.kind === 'commit') return h(RpCommitDialog, { controller, diff })
  if (dialog.kind === 'branch') return h(RpBranchDialog, { controller })
  if (dialog.kind === 'fix') return h(RpFixDialog, { controller, finding: dialog.finding })
  if (dialog.kind === 'review-branch') return h(RpReviewBranchDialog, { controller })
  return null
}

/** 全部回退：先确认，按钮写清回退几个文件，说明未跟踪的文件移到废纸篓。 */
function RpRevertAllDialog({ controller, diff }) {
  const { t } = controller
  const summary = revertAllSummary(diff.phase === 'ready' ? diff.files : [])
  const close = () => controller.setDialog(undefined)
  return h(ui.Modal, {
    open: true, onClose: close, title: t('rp.revertAll.title'), closeLabel: t('rp.close'), className: 'dwb-rp-dialog',
    footer: h(Fragment, null,
      h(ui.Button, { variant: 'outline', onClick: close }, t('rp.cancel')),
      h(ui.Button, {
        variant: 'primary', className: 'dwb-rp-danger',
        onClick: () => {
          close()
          void controller.revert(undefined, undefined, summary.count)
        },
      }, t('rp.revertAll.confirm', { n: summary.count }))),
  },
  h('p', { className: 'dwb-rp-dlg-p' }, t('rp.revertAll.body', { n: summary.count }),
    summary.untracked.length > 0 ? t('rp.revertAll.untracked', { paths: summary.untracked.join('、') }) : null))
}

/** 提交框显示实际推送目标。钩子失败时保留提交信息并显示输出。 */
function RpCommitDialog({ controller, diff }) {
  const { t, repo, sessionId } = controller
  const [message, setMessage] = useState('')
  const [pushSelected, setPush] = useState(false)
  const pushTarget = repo.pushTarget
  const push = pushTarget != null && pushSelected
  const [phase, setPhase] = useState('idle')
  const [failure, setFailure] = useState(undefined)
  const [generation, setGeneration] = useState(undefined)
  const jobRef = useRef(undefined)
  const finish = (job) => {
    if (jobRef.current !== job) return false
    jobRef.current = undefined
    setPhase('idle')
    return true
  }
  const cancel = async (job) => {
    job.stopped = true
    if (job.requestId === undefined || job.cancelSent) return
    job.cancelSent = true
    const result = await controller.post({ action: 'cancel-generate', requestId: job.requestId, sessionId, repo: repo.id })
    if (!finish(job)) return
    setGeneration(result.ok || result.code === 'not-found'
      ? { tone: 'note', text: t('rp.commit.generateCancelled') }
      : { tone: 'error', text: t('rp.commit.stopFailed', { reason: rpErrorText(t, result, 'cancel-generate') }) })
  }
  useEffect(() => () => {
    const job = jobRef.current
    jobRef.current = undefined
    if (job !== undefined) void cancel(job)
  }, [])
  const close = () => { if (phase !== 'committing') controller.setDialog(undefined) }
  const files = diff.phase === 'ready' ? diff.files.length : 0
  const totals = diff.phase === 'ready' ? diff.totals : { added: 0, deleted: 0 }
  const generate = async () => {
    if (jobRef.current !== undefined || phase !== 'idle') return
    const job = { requestId: undefined, stopped: false, cancelSent: false }
    jobRef.current = job
    setGeneration(undefined)
    setPhase('generating')
    const started = await controller.post({ action: 'generate-message', sessionId, repo: repo.id })
    if (!started.ok) {
      if (finish(job)) setGeneration(job.stopped
        ? { tone: 'note', text: t('rp.commit.generateCancelled') }
        : { tone: 'error', text: t('rp.commit.generateFailed', { reason: rpErrorText(t, started, 'generate-message') }) })
      return
    }
    job.requestId = started.requestId
    if (job.stopped) {
      await cancel(job)
      return
    }
    while (!job.stopped) {
      const state = await rpGet({ requestId: job.requestId })
      if (job.stopped) return
      if (!state.ok || state.status !== 'running') {
        if (!finish(job)) return
        if (state.ok && state.status === 'done' && typeof state.message === 'string') setMessage(state.message)
        else if (state.ok && state.status === 'cancelled') setGeneration({ tone: 'note', text: t('rp.commit.generateCancelled') })
        else setGeneration({ tone: 'error', text: t('rp.commit.generateFailed', { reason: state.ok ? state.reason ?? state.status : rpErrorText(t, state, 'generate-message') }) })
        return
      }
      await new Promise(resolve => setTimeout(resolve, RP_GENERATE_POLL_MS))
    }
  }
  const stop = () => {
    const job = jobRef.current
    if (job === undefined) return
    setPhase('stopping')
    void cancel(job)
  }
  const submit = async () => {
    setPhase('committing')
    setFailure(undefined)
    const result = await controller.post({ action: 'commit', sessionId, repo: repo.id, message, push })
    setPhase('idle')
    if (!result.ok) {
      setFailure(result)
      await controller.afterWrite()
      return
    }
    const sha = String(result.sha ?? '').slice(0, 7)
    controller.setDialog(undefined)
    controller.setNotice(result.pushed === true ? { tone: 'ok', text: t('rp.commit.donePushed', { sha }) }
      : result.pushError !== undefined ? { tone: 'error', text: t('rp.commit.pushFailedAfter', { sha, reason: t(reviewErrorKey(result.pushError)) }) }
        : { tone: 'ok', text: t('rp.commit.done', { sha }) })
    await controller.afterWrite()
  }
  const upstreamNote = push ? t(pushTarget.setUpstream ? 'rp.commit.setUpstream' : 'rp.commit.pushTarget', { target: `${pushTarget.remote}/${pushTarget.branch}` }) : undefined
  const generating = phase === 'generating'
  return h(ui.Modal, {
    open: true, onClose: close, title: t('rp.commit.title', { n: files }), closeLabel: t('rp.close'), className: 'dwb-rp-dialog',
    footer: h(Fragment, null,
      h(ui.Button, { variant: 'outline', disabled: phase === 'committing', onClick: close }, t('rp.cancel')),
      h(ui.Button, { variant: 'primary', disabled: message.trim() === '' || phase !== 'idle', onClick: () => { void submit() } }, push ? t('rp.commit.submitPush') : t('rp.commit.submit'))),
  },
  h('p', { className: 'dwb-rp-dlg-meta' }, h('span', { className: 'dwb-rp-mono' }, repo.branch ?? ''), h(RpCounts, { added: totals.added, deleted: totals.deleted })),
  h('div', { className: 'dwb-rp-dlg-lab' }, h('span', null, t('rp.commit.message')), h('span', { className: 'dwb-rp-grow' }),
    generating
      ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => { void stop() } }, t('rp.commit.stopGenerate'))
      : h(ui.Button, { variant: 'ghost', size: 'sm', icon: h(ui.IconEnhanceOutlineRegular, { size: 14 }), disabled: phase !== 'idle', onClick: () => { void generate() } }, t('rp.commit.generate'))),
  h('textarea', {
    className: 'dwb-rp-input dwb-rp-commit-input', value: message, rows: 5, placeholder: t('rp.commit.placeholder'), 'aria-label': t('rp.commit.message'),
    readOnly: generating, onChange: event => setMessage(event.target.value),
  }),
  generating ? h('p', { className: 'dwb-rp-dlg-small', role: 'status' }, t('rp.commit.generating')) : null,
  phase === 'stopping' ? h('p', { className: 'dwb-rp-dlg-small', role: 'status' }, t('rp.commit.stopping')) : null,
  generation !== undefined ? h('p', { className: 'dwb-rp-dlg-small', 'data-tone': generation.tone, role: generation.tone === 'error' ? 'alert' : 'status' }, generation.text) : null,
  pushTarget != null ? h(ui.Checkbox, { className: 'dwb-rp-check', checked: push, label: t('rp.commit.push'), onChange: checked => setPush(checked === true) }) : null,
  upstreamNote !== undefined ? h('p', { className: 'dwb-rp-dlg-small' }, upstreamNote) : null,
  phase === 'committing' ? h('p', { className: 'dwb-rp-dlg-small', role: 'status' }, t('rp.commit.committing')) : null,
  failure !== undefined ? h('div', { className: 'dwb-rp-dlg-error', role: 'alert' },
    h('p', null, rpErrorText(t, failure, 'commit')),
    failure.code === 'hook-failed' && failure.detail ? h(Fragment, null, h('p', { className: 'dwb-rp-dlg-small' }, t('rp.commit.hookOutput')), h('pre', { className: 'dwb-rp-pre' }, failure.detail)) : null) : null)
}

/** 在此建分支：名字由宿主用 git check-ref-format --branch 校验，不合法时写在框里。 */
function RpBranchDialog({ controller }) {
  const { t, repo, sessionId } = controller
  const [name, setName] = useState('')
  const [failure, setFailure] = useState(undefined)
  const [working, setWorking] = useState(false)
  const close = () => controller.setDialog(undefined)
  const create = async () => {
    setWorking(true)
    const result = await controller.post({ action: 'create-branch', sessionId, repo: repo.id, name: name.trim() })
    setWorking(false)
    if (!result.ok) {
      setFailure(result)
      return
    }
    close()
    controller.setNotice({ tone: 'ok', text: t('rp.branch.created', { branch: result.branch }) })
    await controller.afterWrite()
  }
  return h(ui.Modal, {
    open: true, onClose: close, title: t('rp.branch.title'), closeLabel: t('rp.close'), className: 'dwb-rp-dialog',
    footer: h(Fragment, null,
      h(ui.Button, { variant: 'outline', onClick: close }, t('rp.cancel')),
      h(ui.Button, { variant: 'primary', disabled: name.trim() === '' || working, onClick: () => { void create() } }, t('rp.branch.create'))),
  },
  h('p', { className: 'dwb-rp-dlg-p' }, t('rp.branch.note', { head: repo.head ?? '' })),
  h('label', { className: 'dwb-rp-dlg-field' }, h('span', null, t('rp.branch.name')),
    h('input', {
      className: 'dwb-rp-branch-input', value: name, autoFocus: true, spellCheck: false,
      onChange: (event) => {
        setName(event.target.value)
        setFailure(undefined)
      },
    })),
  failure !== undefined ? h('p', { className: 'dwb-rp-dlg-small', 'data-tone': 'error', role: 'alert' }, rpErrorText(t, failure, 'create-branch')) : null)
}

/** 修这一条：先取宿主准备好的定位（报告修订号加一），显示可编辑的消息，确认后排队发到主会话（照本地审查原来的流程）。 */
function RpFixDialog({ controller, finding }) {
  const { t, app, report } = controller
  const [draft, setDraft] = useState(undefined)
  const [text, setText] = useState('')
  const [error, setError] = useState(undefined)
  const [sending, setSending] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const lock = useRef(false)
  const close = () => { if (!sending) controller.setDialog(undefined) }
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const ready = await app.ctx.sessions.using(report.parentId, { source: 'local-review-preview' },
          () => lrevRequest('prepare', { id: report.id, findingId: finding.id, revision: report.revision }))
        if (!live) return
        controller.mergeReport({ ...report, revision: ready.revision, findings: report.findings.map(item => (item.id === ready.finding.id ? { ...item, ...ready.finding } : item)) })
        setDraft({ ...ready, id: report.id, findingId: finding.id })
        setText(t('lr.draft', {
          data: JSON.stringify({
            workspace: ready.root, snapshot: ready.fingerprint, path: ready.finding.path, line: ready.finding.line, endLine: ready.finding.endLine,
            title: ready.finding.title, description: ready.finding.description, evidence: ready.finding.evidence, validation: ready.finding.validation,
          }, null, 2),
        }))
      } catch (failure) {
        if (live) setError(lrevError(t, failure))
      }
    })()
    return () => { live = false }
  }, [])
  const send = async () => {
    if (lock.current || draft === undefined || text.trim() === '') return
    lock.current = true
    setSending(true)
    setError(undefined)
    try {
      await app.ctx.sessions.using(draft.parentId, { source: 'local-review-fix' }, async (reference) => {
        const next = await lrevRequest('prepare', { id: draft.id, findingId: draft.findingId, revision: draft.revision })
        controller.mergeReport({ ...report, revision: next.revision })
        setDraft(old => ({ ...old, revision: next.revision }))
        setAttempted(true)
        const result = await reference.binding.session.prompt([{ type: 'text', text }], 'queue', undefined, draft.requestId)
        if (!result.ok) throw new Error('send-failed')
      })
      controller.setDialog(undefined)
      controller.setNotice({ tone: 'ok', text: t('lr.sent') })
    } catch (failure) {
      setError(failure?.message === 'send-failed' ? t('lr.sendFailed') : lrevError(t, failure))
    } finally {
      lock.current = false
      setSending(false)
    }
  }
  return h(ui.Modal, {
    open: true, onClose: close, title: t('lr.preview'), closeLabel: t('rp.close'), className: 'dwb-rp-dialog',
    footer: h(Fragment, null,
      h(ui.Button, { variant: 'outline', disabled: sending, onClick: close }, t('lr.cancel')),
      h(ui.Button, { variant: 'primary', disabled: sending || draft === undefined || text.trim() === '', onClick: () => { void send() } }, t('lr.send'))),
  },
  h('label', { className: 'dwb-rp-dlg-field' }, h('span', null, t('lr.message')),
    h('textarea', { className: 'dwb-rp-input dwb-rp-fix-input', value: text, rows: 10, readOnly: attempted, onChange: event => setText(event.target.value) })),
  error !== undefined ? h('p', { className: 'dwb-rp-dlg-small', 'data-tone': 'error', role: 'alert' }, error) : null)
}

/** 审查与分支的差异：选本地分支（本地审查只认本地分支），可选包含未跟踪的文件。 */
function RpReviewBranchDialog({ controller }) {
  const { t, repo, sessionId } = controller
  const [branches, setBranches] = useState(undefined)
  const [base, setBase] = useState(undefined)
  const [untracked, setUntracked] = useState(false)
  useEffect(() => {
    void rpGet({ sessionId, repo: repo.id, branches: '1' }).then((body) => {
      const local = body.ok ? body.local.filter(name => name !== repo.branch) : []
      setBranches(local)
      setBase(local.includes(body.defaultBase) ? body.defaultBase : local[0])
    })
  }, [])
  const close = () => controller.setDialog(undefined)
  return h(ui.Modal, {
    open: true, onClose: close, title: t('rp.review.dialogTitle'), closeLabel: t('rp.close'), className: 'dwb-rp-dialog',
    footer: h(Fragment, null,
      h(ui.Button, { variant: 'outline', onClick: close }, t('rp.cancel')),
      h(ui.Button, {
        variant: 'primary', disabled: base === undefined,
        onClick: () => {
          close()
          void controller.startReview(`--base ${base}${untracked ? ' --untracked' : ''}`)
        },
      }, t('lr.run'))),
  },
  branches === undefined ? h('p', { className: 'dwb-rp-dlg-small' }, t('rp.base.loading'))
    : branches.length === 0 ? h('p', { className: 'dwb-rp-dlg-small' }, t('rp.base.empty'))
      : h(WorkbenchSelect, { label: t('lr.base'), value: base, onChange: setBase, options: branches.map(name => ({ id: name, label: name })) }),
  h(ui.Checkbox, { className: 'dwb-rp-check', checked: untracked, label: t('lr.untracked'), onChange: checked => setUntracked(checked === true) }),
  h('p', { className: 'dwb-rp-dlg-small' }, t('lr.separate')))
}

/** 本面板自己的样式（style.js 是共用文件，面板的样式从模块里挂）。颜色只用 DSH 的 --dsw-alias-* 变量，跟随深浅色。 */
const REVIEW_PANEL_CSS = `
.dwb-rp{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;container:dwb-rp/inline-size;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dwb-rp *{box-sizing:border-box}
.dwb-rp-tool{flex:none;display:flex;align-items:center;gap:8px;min-width:0;padding:8px 10px 8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-tool>*{flex:none}
.dwb-rp-tool>.dwb-rp-grow{flex:1 1 auto}
.dwb-rp-tool>.dwb-rp-sum{flex:0 1 auto}
.dwb-rp-tool>.dwb-rp-scope-menu,.dwb-rp-tool>.dwb-rp-repo-menu{flex:0 1 auto;min-width:32px;max-width:180px}
.dwb-rp-scope{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:180px;min-width:0;padding:0 6px 0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;white-space:nowrap;cursor:pointer}
.dwb-rp-scope-menu>.dwb-rp-scope,.dwb-rp-repo-menu>.dwb-rp-scope{max-width:min(180px,100%)}
.dwb-rp-scope>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dwb-rp-scope>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-scope[aria-expanded=true],.dwb-rp-scope:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwb-rp-scope:disabled{cursor:default;opacity:.6}
.dwb-rp-sum{display:inline-flex;align-items:baseline;gap:8px;min-width:0;overflow:hidden;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dwb-rp-cnt{display:inline-flex;gap:6px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;white-space:nowrap}
.dwb-rp-add{color:var(--dsw-alias-state-success-primary)}
.dwb-rp-del{color:var(--dsw-alias-state-error-primary)}
.dwb-rp-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dwb-rp-grow{flex:1 1 auto}
.dwb-rp-ib{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
.dwb-rp-ib:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-rp-ib[aria-pressed=true],.dwb-rp-ib[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dwb-rp :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dwb-rp-view-menu,.dwb-rp-narrow{display:none}
@container dwb-rp (max-width:479px){.dwb-rp-wide{display:none}.dwb-rp-view-menu,.dwb-rp-narrow{display:inline-grid}}
/* 右侧栏拖到最窄（300）时，分支栏的按钮换到第二行，分支名不被挤成一两个字。 */
@container dwb-rp (max-width:379px){.dwb-rp-git{flex-wrap:wrap;row-gap:4px}}
.dwb-rp-mi{display:flex;align-items:baseline;gap:10px;min-width:0;width:100%}
.dwb-rp-mi-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-rp-mi-sha{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-mi-sub{margin-left:auto;flex:none;padding-left:12px;font-size:12px;color:var(--dsw-alias-label-caption)}
.dwb-rp-menu-root{display:grid;gap:1px;min-width:260px;max-width:340px}
.dwb-rp-menu-search{padding:2px 2px 4px}
.dwb-rp-menu-label{padding:6px 10px 2px;font-size:12px;color:var(--dsw-alias-label-caption)}
.dwb-rp-menu-note{padding:6px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-mi-branch{white-space:normal;overflow-wrap:anywhere}
.dwb-rp-git{flex:none;display:flex;align-items:center;gap:8px;min-width:0;padding:6px 10px 6px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwb-rp-git>*{flex:none}
.dwb-rp-git>.dwb-rp-grow{flex:1 1 auto}
.dwb-rp-git>.dwb-rp-branch{flex:0 1 auto}
.dwb-rp-git>.dwb-rp-base-menu{flex:0 1 auto;min-width:32px;max-width:160px}
.dwb-rp-git>.dwb-rp-commits-menu{max-width:160px}
.dwb-rp-branch{min-width:0;display:inline-flex;align-items:center;gap:6px;overflow:hidden;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwb-rp-branch>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-branch>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-rp-ahead{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dwb-rp-tag{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 6px;white-space:nowrap}
.dwb-rp-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dwb-rp-picker{display:inline-flex;align-items:center;gap:4px;height:26px;max-width:min(160px,100%);min-width:0;padding:0 6px 0 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.dwb-rp-picker>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dwb-rp-picker>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-picker[aria-expanded=true],.dwb-rp-picker:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-rp-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dwb-rp-check{font-size:12px;white-space:nowrap}
.dwb-rp-info{flex:none;padding:6px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-file>.dwb-rp-info{padding-left:38px}
.dwb-rp-banner{flex:none;display:flex;gap:8px;align-items:flex-start;padding:9px 14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-banner>svg{flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.dwb-rp-strip{flex:none;display:flex;align-items:center;gap:8px;min-width:0;min-height:36px;padding:2px 10px 2px 14px;font-size:13px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 6%,transparent);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-strip>svg{flex:none;color:var(--dsw-alias-state-success-primary)}
.dwb-rp-strip>span:not(.dwb-rp-grow){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-rp-notice{flex:none;display:flex;gap:8px;align-items:flex-start;padding:8px 10px 8px 14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-notice>svg{flex:none;margin-top:3px}
.dwb-rp-notice[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 6%,transparent)}
.dwb-rp-notice[data-tone=ok]>svg{color:var(--dsw-alias-state-success-primary)}
.dwb-rp-notice[data-tone=error]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dwb-rp-notice[data-tone=error]>svg{color:var(--dsw-alias-state-error-primary)}
.dwb-rp-notice-body{display:grid;gap:4px;min-width:0}
.dwb-rp-pre{margin:0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto}
.dwb-rp-rstrip{flex:none;display:grid;gap:4px;padding:8px 10px 8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dwb-rp-r1{display:flex;align-items:center;gap:8px;min-width:0}
/* 按钮一组不换行；窄了标题和等级在左边换行。图标挂在左内边距里，换下去的等级和下面几行一样从标题的位置开始。 */
.dwb-rp-rtext{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:2px;padding-left:22px}
.dwb-rp-rtext>svg{flex:none;margin-left:-22px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-rtext>b{font-weight:500;color:var(--dsw-alias-label-primary);font-size:13px;min-width:0}
.dwb-rp-ract{flex:none;display:flex;align-items:center;gap:8px}
.dwb-rp-r2{display:flex;align-items:center;gap:8px;padding-left:22px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.dwb-rp-note{margin:0;padding:10px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-empty{flex:1 1 auto;display:grid;gap:6px;justify-items:center;align-content:start;text-align:center;padding:40px 24px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dwb-rp>.dwb-rp-note{flex:1 1 auto}
.dwb-rp-empty>b{color:var(--dsw-alias-label-primary);font-weight:500;font-size:14px}
.dwb-rp-empty>button{margin-top:6px}
.dwb-rp-files{flex:1 1 auto;min-height:0;overflow-y:auto;scroll-padding-top:36px;display:flex;flex-direction:column}
.dwb-rp-file{display:flex;flex-direction:column;min-width:0}
.dwb-rp-fhead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;min-height:36px;min-width:0;padding:5px 10px 5px 8px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l2);border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px}
.dwb-rp-file:first-child>.dwb-rp-fhead{border-top:none}
.dwb-rp-fhead>*{flex:none}
.dwb-rp-fhead>.dwb-rp-path{flex:0 1 auto;min-width:0}
.dwb-rp-fhead>.dwb-rp-grow{flex:1 1 auto}
/* 放不下时先截目录，文件名最后才截。 */
.dwb-rp-path{display:flex;min-width:0;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
.dwb-rp-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-caption)}
.dwb-rp-fname{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dwb-rp-chev{display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dwb-rp-chev:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-rp-body1{padding:8px 14px 8px 38px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-hunk{display:flex;align-items:center;gap:6px;min-height:30px;padding:2px 10px 2px 14px;font-size:12px;color:var(--dsw-alias-label-caption);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,transparent);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-hunk>*{flex:none}
.dwb-rp-hunk>.dwb-rp-grow{flex:1 1 auto}
.dwb-rp-range{font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.dwb-rp-code{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:20px;overflow-x:auto}
.dwb-rp-ln{display:grid;grid-template-columns:34px 38px 16px minmax(0,1fr);align-items:start;min-width:max-content}
.dwb-rp-code[data-wrap=wrap] .dwb-rp-ln{min-width:0}
.dwb-rp-code[data-split=split] .dwb-rp-ln{grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-width:0}
.dwb-rp-cell{display:grid;grid-template-columns:54px 16px minmax(0,1fr);align-items:start;min-width:0;overflow:hidden}
.dwb-rp-no{text-align:right;padding-right:6px;color:var(--dsw-alias-label-dimmed);user-select:none}
.dwb-rp-mk{text-align:center;color:var(--dsw-alias-label-dimmed);user-select:none}
.dwb-rp-text{white-space:pre;padding-right:10px}
.dwb-rp-code[data-wrap=wrap] .dwb-rp-text,.dwb-rp-code[data-split=split] .dwb-rp-text{white-space:pre-wrap;overflow-wrap:anywhere}
.dwb-rp-ln[data-tone=add],.dwb-rp-cell[data-tone=add]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dwb-rp-ln[data-tone=add] .dwb-rp-no,.dwb-rp-cell[data-tone=add] .dwb-rp-no{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.dwb-rp-ln[data-tone=add] .dwb-rp-mk,.dwb-rp-cell[data-tone=add] .dwb-rp-mk{color:var(--dsw-alias-state-success-primary)}
.dwb-rp-ln[data-tone=del],.dwb-rp-cell[data-tone=del]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dwb-rp-ln[data-tone=del] .dwb-rp-no,.dwb-rp-cell[data-tone=del] .dwb-rp-no{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dwb-rp-ln[data-tone=del] .dwb-rp-mk,.dwb-rp-cell[data-tone=del] .dwb-rp-mk{color:var(--dsw-alias-state-error-primary)}
.dwb-rp-code[data-split=split] .dwb-rp-ln[data-tone]{background:transparent}
.dwb-rp-ln[data-tone=add]>.dwb-rp-mk::before,.dwb-rp-cell[data-tone=add]>.dwb-rp-mk::before{content:"+"}
.dwb-rp-ln[data-tone=del]>.dwb-rp-mk::before,.dwb-rp-cell[data-tone=del]>.dwb-rp-mk::before{content:"−"}
.dwb-rp-gutter{position:relative;display:block;padding-right:0}
.dwb-rp-pick{display:block;width:100%;padding:0 6px 0 0;border:none;background:transparent;color:inherit;font:inherit;text-align:right;cursor:pointer}
.dwb-rp-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-rp-pick[aria-pressed=true]{color:var(--dsw-alias-link);font-weight:600}
.dwb-rp-plus{position:absolute;left:-17px;top:2px;display:inline-grid;place-items:center;width:16px;height:16px;padding:0;border:none;border-radius:4px;background:var(--dsw-alias-link);color:var(--dsw-alias-bg-base,#000);cursor:pointer}
.dwb-rp-code[data-split=unified] .dwb-rp-ln[data-tone=del] .dwb-rp-plus{left:35px}
.dwb-rp-cell .dwb-rp-pick{padding-left:18px}
.dwb-rp-cell .dwb-rp-plus{left:1px}
.dwb-rp-cnote{margin:6px 12px 8px 50px;border-left:2px solid var(--dsw-alias-link);padding:2px 0 2px 10px;display:grid;gap:2px}
.dwb-rp-cnote-head{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-cnote-text{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dwb-rp-cbox{margin:6px 12px 8px 50px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:grid;gap:8px;font-size:13px}
.dwb-rp-input{width:100%;min-height:52px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}
.dwb-rp-input:focus{outline:none;border-color:var(--dsw-alias-link);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-link) 16%,transparent)}
/* 写评论的框只有一层：里面的输入框不另画边框和圆角，聚焦时整个框描边。 */
.dwb-rp-cbox:focus-within{border-color:var(--dsw-alias-link);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-link) 16%,transparent)}
.dwb-rp-cbox>.dwb-rp-input,.dwb-rp-cbox>.dwb-rp-input:focus{min-height:40px;border:none;border-radius:0;padding:0;background:transparent;box-shadow:none}
.dwb-rp-row-end{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dwb-rp-fnd{margin:6px 12px 8px 50px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px 10px;display:grid;gap:4px;scroll-margin:48px}
.dwb-rp-fnd[aria-current=true]{border-color:var(--dsw-alias-link)}
.dwb-rp-unplaced{flex:none;max-height:min(35vh,240px);overflow:auto;border-top:.5px solid var(--dsw-alias-border-l1)}
.dwb-rp-unplaced .dwb-rp-cnote-head>span:first-child{overflow-wrap:anywhere}
.dwb-rp-unplaced .dwb-rp-fnd-lab>span:nth-child(2){overflow-wrap:anywhere}
.dwb-rp-fnd h4{margin:0;font-size:13px;font-weight:500;line-height:20px}
.dwb-rp-fnd p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dwb-rp-fnd[data-ignored]{padding:4px 12px;background:transparent;border-style:dashed}
.dwb-rp-fnd-lab{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-fnd-ign{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-rp-lv{flex:none;font-size:12px;line-height:16px;padding:0 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dwb-rp-lv[data-level=high]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dwb-rp-foot{flex:none;display:flex;align-items:center;gap:8px;min-width:0;padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:13px}
.dwb-rp-foot>*{flex:none}
.dwb-rp-foot>.dwb-rp-grow{flex:1 1 auto}
.dwb-rp-foot>.dwb-rp-error{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-rp-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dwb-rp-dialog{width:min(460px,calc(100vw - 24px))}
.dwb-rp-dialog .dwb-rp-input{min-height:96px}
.dwb-rp-dialog .dwb-rp-fix-input{min-height:200px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px}
.dwb-rp-dlg-p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dwb-rp-dlg-meta{margin:0 0 4px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-dlg-lab{display:flex;align-items:center;gap:8px;margin:8px 0 6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-dlg-small{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-dlg-small[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dwb-rp-dlg-error{margin-top:8px;display:grid;gap:4px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dwb-rp-dlg-error>p{margin:0}
.dwb-rp-dlg-field{display:grid;gap:6px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dwb-rp-dlg-field>input{width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px}
.dwb-rp-dlg-field>input:focus{outline:none;border-color:var(--dsw-alias-link);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-link) 16%,transparent)}
.dwb-rp-dialog .dwb-rp-check{margin-top:10px}
.dwb-rp-danger{background:var(--dsw-alias-state-error-primary) !important;border-color:var(--dsw-alias-state-error-primary) !important}
`

/**
 * 挂审阅面板（改动审阅这一行的网页部分）：审阅标签的类型和资源、接管官方「第 N 轮改动」地址的类型、
 * 两种标签共用的正文、会话「更多操作」里的「审阅」、右键菜单项的图标。返回撤销函数（这一行关掉时调用，
 * 官方「第 N 轮改动」只读页跟着回来）。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数。
 */
function applyReview(app) {
  const { ctx, t } = app
  const disposers = [mountModuleStyle('dsh-workbench-review-panel', REVIEW_PANEL_CSS)]
  const keep = (dispose) => { disposers.push(dispose) }
  for (const [protocol, parseAddress] of [
    [REVIEW_PANEL_KIND, parseReviewPanelAddress],
    [LREV_LEGACY_KIND, parseLocalReviewReportAddress],
  ]) {
    keep(ctx.effect(() => ctx.resources.register({
      protocol,
      async *open(address, { signal }) {
        if (parseAddress(address) === undefined) throw new Error(`dsh-workbench/review: 地址不对 ${address}`)
        yield { ok: true, value: { address } }
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    }), `dsh-workbench: ${protocol} resource`))
  }
  keep(ctx.effect(() => ctx.sidebarRightTabs.register({
    id: REVIEW_PANEL_TAB_ID, kind: REVIEW_PANEL_KIND, patterns: ['dsh-resource://wbreview/**'], priority: 'extension',
    canOpen: address => parseReviewPanelAddress(address) !== undefined,
    title: () => t('rp.title'),
    guide: [{ id: 'review', order: 15, title: () => t('rp.title'), description: () => t('rp.guide'), icon: props => h(RpDiffIcon, props) }],
  }), 'dsh-workbench: review panel tab type'))
  keep(ctx.effect(() => ctx.sidebarRightTabs.register({
    id: RP_TURN_TAB_ID, kind: 'changes-review', patterns: ['dsh-resource://changes-review/**'], priority: 'extension',
    canOpen: address => parseReviewAddress(address) !== undefined,
    title: (address) => {
      const coords = parseReviewAddress(address)
      return coords === undefined ? address : t('rp.scope.turn', { turn: coords.turn })
    },
  }), 'dsh-workbench: changes-review takeover'))
  keep(ctx.effect(() => ctx.sidebarRightTabs.register({
    id: LREV_LEGACY_TAB_ID, kind: LREV_LEGACY_KIND, patterns: [LREV_LEGACY_PREFIX + '**'], priority: 'extension',
    canOpen: address => parseLocalReviewReportAddress(address) !== undefined,
    title: () => t('rp.title'),
  }), 'dsh-workbench: saved local-review tabs'))
  for (const key of [REVIEW_PANEL_TAB_ID, RP_TURN_TAB_ID, LREV_LEGACY_TAB_ID]) {
    keep(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key, locale: '@miint-sunny/dsh-workbench' },
      props => h(ReviewPanelTab, { app, ...props }))))
  }
  keep(ctx.effect(() => ctx.contextMenus.register({
    id: 'dsh-workbench.review.session-header', target: 'sessionHeader', order: 11,
    // 切换界面语言时重新取菜单项的文字。
    observe: () => [ctx.locale],
    resolve: ({ sessionId }) => [{ id: 'review', label: t('rp.title'), icon: { key: RP_ICON.panel }, run: () => openReviewPanel(ctx, sessionId, { scope: 'unstaged' }) }],
  }), 'dsh-workbench: review in the session header menu'))
  keep(ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.panel }, props => h(RpDiffIcon, props))
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.stage }, props => h(ui.IconPlusOutlineRegular, props))
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.unstage }, props => h(RpMinusIcon, props))
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.revert }, props => h(RpRevertIcon, props))
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.comment }, props => h(ui.IconEditOutlineRegular, props))
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.copy }, props => h(ui.IconCopyOutlineRegular, props))
    yield ctx.slots.register({ name: 'contextMenu.icon', key: RP_ICON.copyHunk }, props => h(ui.IconCopyOutlineRegular, props))
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * 更换工作区文件夹（feat#187，dsh-workbench/workspace-folders 行）的网页端，样稿 docs/mocks/2026-11-19-更换工作区文件夹.html。
 * 宿主端见 lib/workspace-move-route.js。
 * - 工作区设置对话框里（src/client/workspace-folders.js 调用）：选好新位置后的迁移面板（MovePanel）、做完的迁移那一行（「撤销」）、
 *   停在中途的迁移的提示（「退出并恢复」）。
 * - 对话框外（createMoveNotices，挂在 shell.overlay）：DSH 打开时提示上次的结果（ui.Toast；迁移成功带「撤销」，失败带「在文件夹显示」）、
 *   上次迁移未完成时的恢复对话框、撤销的确认。
 * 迁移、撤销、恢复都要退出 DSH：宿主起小进程，小进程请 DSH 退出（桌面 App 用 AppleScript），等 DSH 退干净再动手、核对、重新打开。
 * 点了以后 DSH 还开着时（退出确认里点了取消、macOS 不许用 AppleScript 控制 DSH），界面每秒查一次进度，10 秒后请用户自己按 ⌘Q；
 * 小进程等不到退出会放弃（宿主端 120 秒），这里显示结果。
 */
import { mountModuleStyle } from './style.js'

const MOVE_API = 'api/dsh-workbench.workspace-move'
const MOVE_TOKEN_HEADER = 'x-dsh-workbench-move'
/** shell.overlay 里这一层的 id，也是样式的标记。 */
export const MOVE_OVERLAY = 'dsh-workbench-workspace-move'
/** 等 DSH 退出时多久查一次进度。 */
const MOVE_POLL_MS = 1000
/** DSH 过了多久还没退出，就请用户自己退出。 */
const MOVE_MANUAL_AFTER_MS = 10_000
/** 连续多久没有收到宿主的进度后停止等待。 */
const MOVE_UNREACHABLE_MS = 120_000
/** 结果提示停留多久：带按钮、要读路径，比 DSH 归档提示的 6 秒多一点。 */
const MOVE_TOAST_HOLD_MS = 8000

let stopWebMoveRecovery

/** 命令行宿主重开后，DSH 可能因会话组件错误卸载整棵界面。仅在该请求已有结果且原页面仍为空时刷新。 */
function watchWebMoveRecovery(action, { requestId, hostId }, progress) {
  const doc = typeof window === 'undefined' ? undefined : window.document
  const root = doc?.getElementById('root')
  if (!root?.childElementCount || !requestId || !hostId) return
  stopWebMoveRecovery?.()
  const href = window.location.href
  const controller = new AbortController()
  let timer
  const leave = ['pagehide', 'popstate', 'hashchange']
  const blank = () => window.document === doc && window.location.href === href && doc.getElementById('root') === root
    && root.childElementCount === 0 && doc.body.innerText.trim() === ''
  const stop = () => {
    clearTimeout(deadline)
    clearTimeout(timer)
    controller.abort()
    window.removeEventListener('error', onError)
    for (const type of leave) window.removeEventListener(type, stop)
    stopWebMoveRecovery = undefined
  }
  const check = async () => {
    if (!blank()) return stop()
    let view
    try {
      view = await progress(requestId, controller.signal)
    } catch {
      // 原宿主已退出，新宿主的端口可能尚未打开。
    }
    if (controller.signal.aborted) return
    if (!blank() || (view && (view.requestId !== requestId || view.action !== action))) return stop()
    if (view && !view.running && view.outcome !== undefined) {
      stop()
      if (view.hostId && view.hostId !== hostId && ['finished', 'failed'].includes(view.phase)) window.location.reload()
      return
    }
    timer = setTimeout(() => { void check() }, MOVE_POLL_MS)
  }
  const onError = (event) => {
    if (event.message !== "Uncaught Error: scope 'session-maybe' rendered without an installed adapter") return
    window.removeEventListener('error', onError)
    timer = setTimeout(() => { void check() }, 0)
  }
  const deadline = setTimeout(stop, MOVE_UNREACHABLE_MS)
  stopWebMoveRecovery = stop
  for (const type of leave) window.addEventListener(type, stop)
  window.addEventListener('error', onError)
}

/**
 * 和宿主路由说话。POST 要带只由 GET 回答的令牌；宿主重启换了令牌时（403 forbidden）重新拿一次再发。
 * @param {(url: string, init?: object) => Promise<Response>} [request] fetch（测试注入）。
 * @returns {object} status、progress、plan、start、undoCheck、undo、recover、ack、reveal；回答是宿主端的 JSON。
 */
export function createMoveClient(request = (url, init) => fetch(url, init)) {
  let token
  const readJson = async (response) => {
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }
  const status = async (signal) => {
    const response = await request(MOVE_API, { credentials: 'same-origin', signal })
    const value = await readJson(response)
    if (!response.ok || value?.ok !== true) throw new Error(value?.reason ?? `HTTP ${response.status}`)
    token = value.token
    return value
  }
  const progress = async (requestId, signal) => {
    const response = await request(`${MOVE_API}?requestId=${encodeURIComponent(requestId)}`, { credentials: 'same-origin', signal })
    const value = await readJson(response)
    if (response.status === 404 && value?.reason === 'no-request') return { running: false, outcome: 'no-request' }
    if (!response.ok || value?.ok !== true) throw new Error(value?.reason ?? `HTTP ${response.status}`)
    return { ...value.request, hostId: value.hostId }
  }
  const post = async (body) => {
    if (token === undefined) await status()
    const attempt = () => request(MOVE_API, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', [MOVE_TOKEN_HEADER]: token ?? '' }, body: JSON.stringify(body),
    })
    let response = await attempt()
    if (response.status === 403 && (await readJson(response.clone()))?.reason === 'forbidden') {
      await status()
      response = await attempt()
    }
    const value = await readJson(response)
    if (value?.ok !== true && typeof value?.reason !== 'string') throw new Error(`HTTP ${response.status}`)
    return value
  }
  const launch = async (body) => {
    const value = await post(body)
    if (value.ok && value.kind === 'command') watchWebMoveRecovery(body.action === 'start' ? 'move' : body.action, value, progress)
    return value
  }
  return {
    status,
    progress,
    plan: (workspaceId, path) => post({ action: 'plan', workspaceId, path }),
    start: planId => launch({ action: 'start', planId }),
    undoCheck: moveId => post({ action: 'undo-check', moveId }),
    undo: moveId => launch({ action: 'undo', moveId }),
    recover: moveId => launch({ action: 'recover', moveId }),
    ack: requestId => post({ action: 'ack', requestId }),
    reveal: requestId => post({ action: 'reveal', requestId }),
  }
}

/** 错误的文字。 */
const moveReason = error => (error instanceof Error ? error.message : String(error))

/** 几项连成一句：中文「甲、乙和丙」，英文「a, b and c」。 */
function moveJoin(t, items) {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(t('move.listSep'))}${t('move.listLast')}${items.at(-1)}`
}

/** 迁移记录那一行的时间，按系统的日期写法。 */
export const moveTime = at => new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(at))

/**
 * 会话的标题：从 DSH 侧边栏的会话列表里找。
 * @param {object} ctx 客户端上下文。
 * @returns {(id: string) => string | undefined} 找不到或没有标题时 undefined。
 */
export const moveTitles = ctx => (id) => {
  const title = ctx.sessions?.list?.getSnapshot?.()?.byId?.[id]?.title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

/**
 * 一条阻碍的文字。
 * @param {(key: string, params?: object) => string} t 文案。
 * @param {{ code: string, sessionId?: string }} blocker 预览里的阻碍。
 * @param {(id: string) => string | undefined} titleOf 会话标题。
 * @returns {string} 文字。
 */
export function moveBlockerText(t, blocker, titleOf) {
  const title = blocker.sessionId === undefined ? undefined : titleOf(blocker.sessionId)
  const named = title ?? blocker.sessionId
  switch (blocker.code) {
    case 'open-turn':
    case 'open-job':
      return title === undefined ? t(`move.blocker.${blocker.code}.untitled`, { count: 1 }) : t(`move.blocker.${blocker.code}`, { title })
    case 'registry-format':
    case 'registry-pending':
    case 'registry-invalid':
      return t('move.blocker.registry')
    case 'accounted-elsewhere':
    case 'target-session-exists':
      return t(`move.blocker.${blocker.code}`, { title: named })
    case 'session-dir':
    case 'header-mismatch':
    case 'log-format':
      return t('move.blocker.log', { title: named })
    default:
      // 宿主端以后新加的阻碍码：照原样写出，不当成能迁移
      return t('move.blocker.other', { code: blocker.code })
  }
}

/**
 * 预览的第一句：改用新文件夹，或者并入已有工作区。
 * @param {(key: string, params?: object) => string} t 文案。
 * @param {object} preview 宿主端 planView 的结果。
 * @returns {string} 文字。
 */
export function moveKindText(t, preview) {
  if (preview.target.kind === 'workspace') return t('move.kind.workspace', { target: preview.target.title, count: preview.target.sessions, source: preview.source.title })
  if (preview.result.title === preview.source.title) return t('move.kind.folder', { source: preview.source.title })
  return t('move.kind.folderRenamed', { source: preview.source.title, result: preview.result.title })
}

/**
 * 「迁移的内容」「不迁移的内容」两张列表和额外的提醒。
 * @param {(key: string, params?: object) => string} t 文案。
 * @param {object} preview 宿主端 planView 的结果。
 * @returns {{ moves: string[], stays: string[], tips: string[] }} 每项一行。
 */
export function moveSummaryLines(t, preview) {
  const { counts } = preview
  const detail = [
    ...counts.archived > 0 ? [t('move.archived', { count: counts.archived })] : [],
    ...counts.forks > 0 ? [t('move.forks', { count: counts.forks })] : [],
  ]
  const moves = [
    detail.length === 0 ? t('move.sessions', { count: counts.sessions }) : t('move.sessionsDetail', { count: counts.sessions, detail: detail.join(t('move.listSep')) }),
    ...counts.subagents > 0 ? [t('move.subagents', { count: counts.subagents })] : [],
    ...preview.carries.length > 0 ? [t('move.carries', { list: moveJoin(t, preview.carries.map(key => t(`move.carry.${key}`))) })] : [],
  ]
  const subfolder = preview.warnings.find(item => item.code === 'subfolder-sessions')
  const stays = [
    ...preview.untouched.length > 0 ? [t('move.untouched', { list: moveJoin(t, preview.untouched.map(key => t(`move.untouched.${key}`))) })] : [],
    ...subfolder === undefined ? [] : [t('move.subfolderSessions', { count: subfolder.count })],
  ]
  const tips = [
    ...preview.warnings.some(item => item.code === 'memory-conflict') ? [t('move.memoryConflict')] : [],
    ...preview.warnings.some(item => item.code === 'memory-unreadable') ? [t('move.memoryUnreadable')] : [],
  ]
  return { moves, stays, tips }
}

/**
 * 一次请求的结果：文字、成功还是警告、能不能撤销、要不要「在文件夹显示」。
 * @param {(key: string, params?: object) => string} t 文案。
 * @param {object} view 宿主端的请求（GET 列出的 results 或 ?requestId= 的 request）。
 * @returns {{ text: string, tone: 'success' | 'warning', undo?: string, reveal?: boolean }} 提示。
 */
export function moveResultNotice(t, view) {
  const notice = moveOutcomeNotice(t, view)
  if (view.checked === false && ['undone', 'recovered'].includes(view.outcome)) {
    notice.text = t('move.result.checkFailed', { result: notice.text })
    notice.tone = 'warning'
    notice.reveal = true
  }
  if (view.relaunched?.startsWith('failed')) {
    notice.text = t('move.result.reopenFailed', { result: notice.text })
    notice.tone = 'warning'
    notice.reveal = true
  }
  return notice
}

/** 迁移本身的结果；退出后的校验和重开另行报告。 */
function moveOutcomeNotice(t, view) {
  const action = view.action ?? 'move'
  const verb = t(`move.verb.${action}`)
  const source = view.source?.title ?? ''
  switch (view.outcome) {
    case 'moved':
      return { text: t('move.result.moved', { source, target: view.target?.display ?? '', count: view.sessions ?? 0 }), tone: 'success', ...view.moveId === undefined ? {} : { undo: view.moveId } }
    case 'undone':
    case 'recovered':
      return { text: t(`move.result.${view.outcome}`, { source, target: view.source?.display ?? '' }), tone: 'success' }
    case 'not-quit':
      return { text: t('move.result.not-quit', { verb }), tone: 'warning' }
    case 'no-request':
    case 'unreachable':
    case 'stale':
    case 'blocked':
      return { text: t(`move.result.${view.outcome}`), tone: 'warning' }
    case 'app-cannot-read':
    case 'check-failed-undone':
      return { text: t(`move.result.${view.outcome}`), tone: 'warning', reveal: true }
    case 'refused':
      if (view.conflict) return { text: t(`move.conflict.${view.conflict.code}`, view.conflict), tone: 'warning' }
      return { text: t(`move.result.refused.${action === 'recover' ? 'recover' : 'undo'}`), tone: 'warning' }
    case 'interrupted':
      return { text: t('move.result.interrupted', { verb }), tone: 'warning', reveal: true }
    default:
      // error，以及宿主端以后新加的结果：按失败提示，详细原因在迁移记录里
      return { text: t('move.result.error', { verb }), tone: 'warning', reveal: true }
  }
}

/**
 * 点了「退出并迁移」等以后：等 DSH 退出。DSH 还开着时每秒查一次进度，10 秒后（或请退出没成功时）请用户自己退出；
 * 小进程有了结果就交给 onResult，并说明 DSH 是否重开过（宿主编号变了）。DSH 正在退出、重开时查询会失败，照常再查。
 * @param {{ t: Function, client: object, requestId: string, hostId?: string, kind: string, action: 'move' | 'undo' | 'recover', onResult: (view: object, restarted: boolean) => void }} props
 *   hostId 是发起时宿主的编号（start、undo、recover 的回答里带）。
 * @returns {object} React 元素。
 */
function MoveWait({ t, client, requestId, hostId, kind, action, onResult }) {
  const [manual, setManual] = useState(false)
  const [reopened, setReopened] = useState(false)
  const done = useRef(onResult)
  done.current = onResult
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let timer
    let deadline
    const manualTimer = setTimeout(() => setManual(true), MOVE_MANUAL_AFTER_MS)
    const stop = () => {
      clearTimeout(timer)
      clearTimeout(deadline)
      clearTimeout(manualTimer)
      controller.abort()
    }
    const resetDeadline = () => {
      clearTimeout(deadline)
      deadline = setTimeout(() => {
        stop()
        done.current({ outcome: 'unreachable' }, false)
      }, MOVE_UNREACHABLE_MS)
    }
    const tick = async () => {
      let view
      try {
        view = await client.progress(requestId, signal)
      } catch {
        // 宿主重开时端口会暂时关闭。
      }
      if (signal.aborted) return
      if (view !== undefined) {
        const restarted = hostId !== undefined && view.hostId !== undefined && view.hostId !== hostId
        if (!view.running && view.outcome !== undefined) {
          stop()
          done.current(view, restarted)
          return
        }
        if (restarted) setReopened(true)
        if (view.quitError) setManual(true)
        resetDeadline()
      }
      timer = setTimeout(() => { void tick() }, MOVE_POLL_MS)
    }
    resetDeadline()
    void tick()
    return stop
  }, [client, requestId, hostId])
  const verb = t(`move.verb.${action}`)
  let message = 'move.quitting'
  if (reopened) message = 'move.readingResult'
  else if (kind === 'terminal' || (manual && kind === 'command')) message = 'move.quitTerminal'
  else if (manual) message = 'move.quitManual'
  const text = t(message, { verb })
  return h('p', { className: 'dwb-mv-wait', role: 'status' }, text)
}

/**
 * 工作区设置里选好新位置以后的面板：正在检查、出错、预览（含阻碍）、等 DSH 退出、DSH 没退出时的结果。
 * @param {{ t: Function, client: object, titleOf: Function, move: object, busy: boolean, reveal: boolean,
 *   onRechoose: () => void, onRecheck: () => void, onStart: () => void, onResult: (view: object) => void, onClose: () => void }} props
 *   move 是对话框里的迁移状态：{ planning, display } | { error, display } | { preview, planId, kind, display } | 再加 waiting（请求号）| { result }。
 * @returns {object} React 元素。
 */
export function MovePanel({ t, client, titleOf, move, busy, reveal, onRechoose, onRecheck, onStart, onResult, onClose }) {
  const heading = useRef(null)
  React.useLayoutEffect(() => {
    heading.current?.focus()
  }, [move.planning, move.preview, move.error, move.result])
  const focusTarget = { ref: heading, tabIndex: -1 }
  const line = move.display === undefined ? null : h('div', { className: 'dwb-wf-line' }, h('span', null, t('folders.picked')), h('span', { className: 'dwb-wf-dir' }, move.display))
  if (move.planning) return h('div', { className: 'dwb-wf-panel', role: 'status' }, line, h('p', { ...focusTarget, className: 'dwb-wf-kind' }, t('move.planning')))
  if (move.result !== undefined) {
    const notice = moveResultNotice(t, move.result)
    return h('div', { className: 'dwb-wf-panel' },
      h('p', { ...focusTarget, className: notice.tone === 'success' ? 'dwb-wf-kind' : 'dwb-wf-alert', role: 'status' }, notice.text),
      h('div', { className: 'dwb-wf-btns' },
        notice.reveal && reveal ? h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void client.reveal(move.result.requestId).catch(() => {}) } }, t('move.reveal')) : null,
        h(ui.Button, { variant: 'primary', size: 'sm', onClick: onClose }, t('move.close'))))
  }
  if (move.error !== undefined) {
    const known = ['same-folder', 'target-missing', 'target-invalid', 'no-workspace', 'source-unknown', 'data-format', 'stale-plan', 'blocked', 'busy'].includes(move.error)
    return h('div', { className: 'dwb-wf-panel' }, line,
      h('p', { ...focusTarget, className: 'dwb-wf-alert', role: 'alert' }, known ? t(`move.error.${move.error}`) : t('move.error.failed', { reason: move.error })),
      h('div', { className: 'dwb-wf-btns' }, h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: onRechoose }, t('folders.rechoose'))))
  }
  const { preview } = move
  const terminal = move.kind === 'terminal'
  const blockers = []
  const unnamed = new Map()
  for (const item of preview.blockers) {
    if ((item.code === 'open-turn' || item.code === 'open-job') && titleOf(item.sessionId) === undefined) {
      unnamed.set(item.code, (unnamed.get(item.code) ?? 0) + 1)
      continue
    }
    const text = moveBlockerText(t, item, titleOf)
    if (item.sessionId !== undefined || !blockers.includes(text)) blockers.push(text)
  }
  for (const [code, count] of unnamed) blockers.push(t(`move.blocker.${code}.untitled`, { count }))
  const list = items => h('ul', { className: 'dwb-mv-list' }, items.map((text, index) => h('li', { key: index }, text)))
  const buttons = move.waiting !== undefined
    ? h(MoveWait, { t, client, requestId: move.waiting, hostId: move.hostId, kind: move.kind, action: 'move', onResult })
    : h('div', { className: 'dwb-wf-btns' },
      h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: onRechoose }, t('folders.rechoose')),
      blockers.length > 0 ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: onRecheck }, t('move.recheck')) : null,
      h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy || blockers.length > 0, onClick: onStart }, t(terminal ? 'move.start.terminal' : 'move.start')))
  if (blockers.length > 0) {
    return h('div', { className: 'dwb-wf-panel' }, line,
      h('p', { ...focusTarget, className: 'dwb-wf-kind' }, moveKindText(t, preview)),
      h('div', { className: 'dwb-mv-block', role: 'alert' }, h('h4', { className: 'dwb-mv-head' }, t('move.blocked')), list(blockers)),
      buttons)
  }
  const lines = moveSummaryLines(t, preview)
  return h('div', { className: 'dwb-wf-panel' }, line,
    h('p', { ...focusTarget, className: 'dwb-wf-kind' }, moveKindText(t, preview)),
    h('div', null, h('h4', { className: 'dwb-mv-head' }, t('move.moves')), list(lines.moves)),
    lines.stays.length > 0 ? h('div', null, h('h4', { className: 'dwb-mv-head' }, t('move.stays')), list(lines.stays)) : null,
    ...lines.tips.map(text => h('p', { key: text, className: 'dwb-mv-tip' }, text)),
    h('p', { className: 'dwb-mv-tip' }, t('move.oldPaths')),
    h('p', { className: 'dwb-mv-tip' }, t(terminal ? 'move.quitTip.terminal' : 'move.quitTip')),
    buttons)
}

/**
 * 撤销一次做完的迁移：先只读检查（不用等 DSH 退出才知道撤不了），能撤销时确认，确认后等 DSH 退出。
 * @param {{ t: Function, client: object, titleOf: Function, target: { moveId: string, sessions: number }, kind: string, reveal: boolean, close: () => void }} props
 * @returns {object} React 元素。
 */
function MoveUndoDialog({ t, client, titleOf, target, kind, reveal, close }) {
  const [state, setState] = useState({ phase: 'checking' })
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    void client.undoCheck(target.moveId).then((value) => {
      if (!live.current) return
      if (value.ok !== true) setState({ phase: 'error', reason: value.reason })
      else setState(value.undoable ? { phase: 'confirm', keeps: (value.appended ?? []).length > 0 } : { phase: 'refused', check: value })
    }, (reason) => {
      if (live.current) setState({ phase: 'error', reason: moveReason(reason) })
    })
    return () => { live.current = false }
  }, [client, target.moveId])
  const confirm = async () => {
    setState({ phase: 'starting', keeps: state.keeps })
    try {
      const value = await client.undo(target.moveId)
      if (!live.current) return
      if (value.ok === true) setState({ phase: 'waiting', requestId: value.requestId, hostId: value.hostId, kind: value.kind })
      else if (value.reason === 'changed-since-move') setState({ phase: 'refused', check: await client.undoCheck(target.moveId) })
      else setState({ phase: 'error', reason: value.reason })
    } catch (reason) {
      if (live.current) setState({ phase: 'error', reason: moveReason(reason) })
    }
  }
  const finished = (view, restarted) => {
    if (!restarted && view.requestId !== undefined) void client.ack(view.requestId).catch(() => {}) // 已在这里显示过；记不下时下次打开再提示一遍
    if (live.current) setState({ phase: 'result', view })
  }
  const terminal = (state.kind ?? kind) === 'terminal'
  const refusal = (check) => {
    if (check.reason !== 'changed-since-move') return t('move.undoRefused.gone')
    if (check.conflict) return t(`move.conflict.${check.conflict.code}`, check.conflict)
    const title = check.sessions.length === 1 ? titleOf(check.sessions[0]) : undefined
    if (title !== undefined) return t('move.undoRefused.session', { title })
    if (check.sessions.length > 0) return t('move.undoRefused.sessions', { count: check.sessions.length })
    return t('move.undoRefused.others')
  }
  let body
  let buttons
  const closeButton = h(ui.Button, { key: 'close', variant: 'primary', onClick: close }, t('move.close'))
  switch (state.phase) {
    case 'checking':
      body = h('p', { role: 'status' }, t('move.checking'))
      buttons = [h(ui.Button, { key: 'cancel', variant: 'outline', onClick: close }, t('move.cancel'))]
      break
    case 'confirm':
    case 'starting':
      body = h(Fragment, null,
        h('p', null, t(terminal ? 'move.undoBody.terminal' : 'move.undoBody', { count: target.sessions })),
        state.keeps ? h('p', null, t('move.undoKeeps')) : null)
      buttons = [
        h(ui.Button, { key: 'cancel', variant: 'outline', disabled: state.phase === 'starting', onClick: close }, t('move.cancel')),
        h(ui.Button, { key: 'go', variant: 'primary', disabled: state.phase === 'starting', onClick: () => { void confirm() } }, t(terminal ? 'move.undoConfirm.terminal' : 'move.undoConfirm')),
      ]
      break
    case 'waiting':
      body = h(Fragment, null, h('p', null, t(terminal ? 'move.undoBody.terminal' : 'move.undoBody', { count: target.sessions })),
        h(MoveWait, { t, client, requestId: state.requestId, hostId: state.hostId, kind: state.kind ?? kind, action: 'undo', onResult: finished }))
      buttons = [h(ui.Button, { key: 'close', variant: 'outline', onClick: close }, t('move.close'))]
      break
    case 'refused':
      body = h('p', { role: 'status' }, refusal(state.check))
      buttons = [closeButton]
      break
    case 'result': {
      const notice = moveResultNotice(t, state.view)
      body = h('p', { role: 'status' }, notice.text)
      buttons = [
        notice.reveal && reveal ? h(ui.Button, { key: 'reveal', variant: 'outline', onClick: () => { void client.reveal(state.view.requestId).catch(() => {}) } }, t('move.reveal')) : null,
        closeButton,
      ]
      break
    }
    default:
      body = h('p', { className: 'dwb-mv-alert', role: 'alert' }, t('move.error.failed', { reason: state.reason }))
      buttons = [closeButton]
  }
  return h(ui.Modal, {
    open: true, onClose: close, closeLabel: t('move.close'), className: 'dwb-mv-modal',
    title: t(state.phase === 'refused' ? 'move.undoRefusedTitle' : 'move.undoTitle'),
    footer: h('div', { className: 'dwb-mv-foot' }, buttons),
  }, h('div', { className: 'dwb-mv-body' }, body))
}

/**
 * 上次迁移停在中途：说明情况，确认后由小进程在 DSH 退出后恢复。
 * @param {{ t: Function, client: object, target: { moveId: string, source: object, target: object }, kind: string, reveal: boolean, close: () => void, requestIds?: string[] }} props
 * @returns {object} React 元素。
 */
function MoveRecoverDialog({ t, client, target, kind, reveal, close, requestIds }) {
  const [state, setState] = useState({ phase: 'confirm' })
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  useEffect(() => {
    for (const id of requestIds ?? []) void client.ack(id).catch(() => {})
  }, [client, requestIds])
  const terminal = (state.kind ?? kind) === 'terminal'
  const confirm = async () => {
    setState({ phase: 'starting' })
    try {
      const value = await client.recover(target.moveId)
      if (!live.current) return
      setState(value.ok === true ? { phase: 'waiting', requestId: value.requestId, hostId: value.hostId, kind: value.kind } : { phase: 'error', reason: value.reason })
    } catch (reason) {
      if (live.current) setState({ phase: 'error', reason: moveReason(reason) })
    }
  }
  const finished = (view, restarted) => {
    if (!restarted && view.requestId !== undefined) void client.ack(view.requestId).catch(() => {}) // 已在这里显示过；记不下时下次打开再提示一遍
    if (live.current) setState({ phase: 'result', view })
  }
  const text = t(terminal ? 'move.recoverBody.terminal' : 'move.recoverBody', { source: target.source.title, target: target.target.display })
  let body = h('p', null, text)
  let buttons = [
    h(ui.Button, { key: 'later', variant: 'outline', disabled: state.phase === 'starting', onClick: close }, t('move.recoverLater')),
    h(ui.Button, { key: 'go', variant: 'primary', disabled: state.phase === 'starting', onClick: () => { void confirm() } }, t(terminal ? 'move.recoverConfirm.terminal' : 'move.recoverConfirm')),
  ]
  if (state.phase === 'waiting') {
    body = h(Fragment, null, body, h(MoveWait, { t, client, requestId: state.requestId, hostId: state.hostId, kind: state.kind ?? kind, action: 'recover', onResult: finished }))
    buttons = [h(ui.Button, { key: 'close', variant: 'outline', onClick: close }, t('move.close'))]
  } else if (state.phase === 'result') {
    const notice = moveResultNotice(t, state.view)
    body = h('p', { role: 'status' }, notice.text)
    buttons = [
      notice.reveal && reveal ? h(ui.Button, { key: 'reveal', variant: 'outline', onClick: () => { void client.reveal(state.view.requestId).catch(() => {}) } }, t('move.reveal')) : null,
      h(ui.Button, { key: 'close', variant: 'primary', onClick: close }, t('move.close')),
    ]
  } else if (state.phase === 'error') {
    body = h('p', { className: 'dwb-mv-alert', role: 'alert' }, t('move.error.failed', { reason: state.reason }))
    buttons = [h(ui.Button, { key: 'close', variant: 'primary', onClick: close }, t('move.close'))]
  }
  return h(ui.Modal, {
    open: true, onClose: close, closeLabel: t('move.close'), className: 'dwb-mv-modal', title: t('move.recoverTitle'),
    footer: h('div', { className: 'dwb-mv-foot' }, buttons),
  }, h('div', { className: 'dwb-mv-body' }, body))
}

/**
 * 一条结果提示：照 DSH 归档会话后的提示用 ui.Toast。显示时就标记为已提示，下次打开不再列出。
 * @param {{ t: Function, client: object, view: object, reveal: boolean, onUndo: (target: object) => void, onDone: () => void }} props
 * @returns {object} React 元素。
 */
function MoveToast({ t, client, view, reveal, onUndo, onDone }) {
  useEffect(() => {
    void client.ack(view.requestId).catch(() => {}) // 记不下时下次打开再提示一遍，不影响这次
  }, [client, view.requestId])
  const notice = moveResultNotice(t, view)
  const actions = [
    ...notice.undo === undefined ? [] : [{ label: t('move.undo'), onClick: () => { onDone(); onUndo({ moveId: notice.undo, sessions: view.sessions ?? 0 }) } }],
    ...notice.reveal && reveal ? [{ label: t('move.reveal'), onClick: () => { void client.reveal(view.requestId).catch(() => {}) } }] : [],
  ]
  return h(ui.Toast, {
    text: notice.text, onDone, holdMs: MOVE_TOAST_HOLD_MS,
    ...notice.tone === 'success' ? { tone: 'success' } : { icon: h(ui.IconWarningOutlineRegular, {}) },
    ...actions.length > 0 ? { actions } : {},
  })
}

/** 迁移面板、确认框和记录那一行的样式。尺寸照样稿；颜色取 DSH 的深浅色变量，和工作区设置对话框（dwb-wf-）同一套。 */
const WORKSPACE_MOVE_STYLE = `
.dwb-mv-head { margin: 0; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dwb-mv-list { margin: 2px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dwb-mv-block .dwb-mv-list { color: var(--dsw-alias-state-error-primary); }
.dwb-mv-tip { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dwb-mv-wait { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dwb-mv-side { display: inline-flex; align-items: center; gap: 10px; white-space: nowrap; }
.dwb-mv-side button { white-space: nowrap; }
.dwb-wf-row.dwb-mv-attached { border-bottom: none; }
.dwb-mv-record { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 0 12px 10px 38px; margin-top: -4px; border-bottom: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dwb-mv-modal { width: min(400px, calc(100vw - 32px)); max-width: calc(100vw - 32px); }
.dwb-mv-body { display: grid; gap: 10px; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dwb-mv-body p { margin: 0; overflow-wrap: anywhere; }
.dwb-mv-alert { color: var(--dsw-alias-state-error-primary); }
.dwb-mv-foot { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
`

/**
 * 对话框外的提示：DSH 打开时查上次的结果和停在中途的迁移，小进程尚在运行时继续查询；撤销、恢复的对话框也从这里开（结果提示里的「撤销」、
 * 工作区设置里的「撤销」「退出并恢复」）。
 * @param {{ ctx: object, t: (key: string, params?: object) => string }} app 客户端上下文。
 * @param {object} client createMoveClient 的结果。
 * @returns {{ start: () => Promise<void>, open: (dialog: object) => void, Overlay: Function, dispose: () => void }}
 *   start 查询并排好提示；open 开撤销（{ type: 'undo', target }）或恢复（{ type: 'recover', target }）对话框。
 */
export function createMoveNotices(app, client) {
  const { ctx, t } = app
  const titleOf = moveTitles(ctx)
  let state = { toasts: [], seq: 0, dialog: null, kind: 'desktop', reveal: false }
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const source = {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state,
  }
  const open = (dialog) => { set({ dialog }) }
  const close = () => { set({ dialog: null }) }
  const controller = new AbortController()
  const seen = new Set()
  const offeredRecovery = new Set()
  let timer
  let lastReply = Date.now()
  const start = async () => {
    let status
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MOVE_UNREACHABLE_MS)])
      status = await client.status(signal)
    } catch {
      if (!controller.signal.aborted && Date.now() - lastReply < MOVE_UNREACHABLE_MS) {
        timer = setTimeout(() => { void start() }, MOVE_POLL_MS)
      }
      return
    }
    if (controller.signal.aborted) return
    lastReply = Date.now()
    const fresh = status.results.filter(view => !seen.has(view.requestId))
    for (const view of fresh) seen.add(view.requestId)
    const target = state.dialog === null ? status.interrupted.find(item => !offeredRecovery.has(item.moveId)) : undefined
    const matching = new Set()
    if (target !== undefined) {
      offeredRecovery.add(target.moveId)
      for (const view of fresh) {
        if (view.outcome === 'interrupted' && view.moveId === target.moveId) matching.add(view.requestId)
      }
      open({ type: 'recover', target, requestIds: [...matching] })
    }
    set({ kind: status.kind, reveal: status.reveal })
    for (const view of fresh) {
      if (!matching.has(view.requestId)) set({ toasts: [...state.toasts, { ...view, seq: state.seq + 1 }], seq: state.seq + 1 })
    }
    if (status.runningRequests?.length > 0) timer = setTimeout(() => { void start() }, MOVE_POLL_MS)
  }
  const unmountStyle = mountModuleStyle(MOVE_OVERLAY, WORKSPACE_MOVE_STYLE)
  function Overlay() {
    const current = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    const toast = current.toasts[0]
    const dialog = current.dialog
    return h(React.Fragment, null,
      dialog !== null || toast === undefined ? null : h(MoveToast, {
        key: toast.seq, t, client, view: toast, reveal: current.reveal,
        onUndo: target => open({ type: 'undo', target }),
        onDone: () => { set({ toasts: state.toasts.filter(item => item.seq !== toast.seq) }) },
      }),
      dialog?.type === 'undo' ? h(MoveUndoDialog, { key: `undo-${dialog.target.moveId}`, t, client, titleOf, target: dialog.target, kind: current.kind, reveal: current.reveal, close }) : null,
      dialog?.type === 'recover' ? h(MoveRecoverDialog, { key: `recover-${dialog.target.moveId}`, t, client, target: dialog.target, requestIds: dialog.requestIds, kind: current.kind, reveal: current.reveal, close }) : null)
  }
  return {
    start,
    open,
    Overlay,
    dispose() {
      controller.abort()
      clearTimeout(timer)
      close()
      unmountStyle()
    },
  }
}

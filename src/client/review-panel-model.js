/**
 * 审阅面板（feat#189）的纯函数：标签地址和入口参数、范围菜单、各范围能做的操作（设计说明第 3 节的表）、
 * 全部回退的确认、错误码对文案、审查发现挂在哪个文件、评论消息、相对时间、选提交。不碰 DOM 和网络。
 */
import { reviewCommentEntries } from '../../lib/review/copy.js'

/** 审阅标签的 kind（右侧栏新标签页按它分组）和类型 id。 */
export const REVIEW_PANEL_KIND = 'wbreview'
export const REVIEW_PANEL_TAB_ID = 'dsh-workbench-review-panel'
/** 一个会话一个审阅标签：地址里只有会话 id，入口要的范围走 navigation.params。 */
const REVIEW_PANEL_PREFIX = 'dsh-resource://wbreview/session/'
/** 本地审查报告的编号（lib/local-review-state.js 的 validReviewId）。 */
const RP_REPORT_ID = /^wbr-[a-f0-9]{64}-[a-z0-9]{8,12}-[a-f0-9]{32}$/
/** 四种 Git 范围，顺序就是范围菜单的顺序。 */
export const GIT_SCOPES = ['unstaged', 'staged', 'uncommitted', 'branch']

/**
 * 一个会话的审阅标签地址。
 * @param {string} sessionId 会话 id。
 * @returns {string} `dsh-resource://wbreview/session/…`。
 */
export function reviewPanelAddress(sessionId) {
  return `${REVIEW_PANEL_PREFIX}${encodeURIComponent(sessionId)}`
}

/**
 * 读出审阅标签地址里的会话 id。
 * @param {string} address 资源地址。
 * @returns {string | undefined} 会话 id；不是这个地址时 undefined。
 */
export function parseReviewPanelAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(REVIEW_PANEL_PREFIX)) return undefined
  const rest = address.slice(REVIEW_PANEL_PREFIX.length)
  if (rest === '' || rest.includes('/')) return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    // 百分号序列坏了：不是 reviewPanelAddress 拼出来的地址。
    return undefined
  }
}

const rpIsIndex = value => Number.isSafeInteger(value) && value >= 0

/**
 * 入口带来的 navigation.params 整理成面板认得的样子；不合法的项丢掉。
 * @param {unknown} params 打开标签时给的 params：`scope`（unstaged、staged、uncommitted、branch、turn）、
 *   轮次的 `seq` 和 `turn`、分支的 `base` 和 `includeUncommitted`、官方卡片点的文件 `index`、本地审查报告 `reportId`。
 * @returns {{scope?: object, index?: number, reportId?: string}} 入口要的范围、文件下标和报告。
 */
export function reviewEntryOf(params) {
  const entry = {}
  if (params === null || typeof params !== 'object') return entry
  const { scope } = params
  if (scope === 'unstaged' || scope === 'staged' || scope === 'uncommitted') entry.scope = { kind: scope }
  else if (scope === 'branch') {
    entry.scope = { kind: 'branch', base: typeof params.base === 'string' && params.base !== '' ? params.base : null, includeUncommitted: params.includeUncommitted === true }
  } else if (scope === 'turn' && rpIsIndex(params.seq) && Number.isSafeInteger(params.turn) && params.turn >= 1) {
    entry.scope = { kind: 'turn', seq: params.seq, turn: params.turn }
  }
  if (entry.scope !== undefined && rpIsIndex(params.index)) entry.index = params.index
  if (typeof params.reportId === 'string' && RP_REPORT_ID.test(params.reportId)) entry.reportId = params.reportId
  return entry
}

/**
 * 范围的键：评论、已审阅和撤销按它分开存。分支范围连基准、选的提交和是否含未提交的修改一起算。
 * @param {object} scope 范围。
 * @returns {string} 键。
 */
export function scopeKey(scope) {
  if (scope.kind === 'turn') return `turn:${scope.seq}`
  if (scope.kind !== 'branch') return scope.kind
  return ['branch', scope.base ?? '', scope.from ?? '', scope.to ?? '', scope.includeUncommitted === true ? 'w' : ''].join(':')
}

/**
 * 有改动的轮次：官方 deliverables 记在每轮 data 里的 `changes.seq`（来自 workspace/changes 事件），最近的在上面。
 * @param {Map<string, object> | undefined} turns 对话快照的 timeline.turns。
 * @returns {{turn: number, seq: number}[]} 轮次和改动事件的序号。
 */
export function turnEntriesOf(turns) {
  if (!(turns instanceof Map)) return []
  const entries = []
  for (const turn of turns.values()) {
    const seq = turn?.data?.get?.('deliverables')?.changes?.seq
    if (Number.isSafeInteger(turn?.turn) && rpIsIndex(seq)) entries.push({ turn: turn.turn, seq })
  }
  return entries.sort((a, b) => b.turn - a.turn)
}

/**
 * 范围菜单的项：四种 Git 范围带文件数（分支写对比的基准），隔一条线，再是有改动的轮次。
 * 不是 Git 仓库时 Git 范围不能选，原因是 not-git。
 * @param {{repo: object | undefined, base: string | null, turns: {turn: number, seq: number}[], turnFiles: Map<number, number | null | undefined>}} input
 *   repo 是宿主 status 里的仓库；base 是分支范围现在的基准；turnFiles 是各轮的文件数（null 是已不可用，undefined 是还没读到）。
 * @returns {object[]} 菜单项。
 */
export function scopeMenuEntries({ repo, base, turns, turnFiles }) {
  const git = repo?.kind === 'git'
  const disabled = git ? { disabled: false } : { disabled: true, reason: 'not-git' }
  const entries = GIT_SCOPES.map(id => (id === 'branch'
    ? { id, scope: { kind: 'branch' }, base: git ? base : null, ...disabled }
    : { id, scope: { kind: id }, count: git ? repo.counts[id] : undefined, ...disabled }))
  if (turns.length === 0) return entries
  entries.push({ id: 'sep', separator: true })
  for (const { turn, seq } of turns) {
    const count = turnFiles.get(seq)
    entries.push({ id: `turn:${seq}`, scope: { kind: 'turn', seq, turn }, turn, count: count ?? undefined, unavailable: count === null, disabled: count === null })
  }
  return entries
}

const RP_ENABLED = { disabled: false }
const rpBlocked = reason => ({ disabled: true, reason })

/**
 * 整个范围的操作（分支那一栏右边的按钮）。返回的对象只含这个范围有的操作；不能做时带原因。
 * 会话进行中只拦回退；有冲突时整个范围都不能暂存、回退和提交（宿主也这样拒绝）；游离的 HEAD 不能提交。
 * @param {{scope: object, repo: object, diff: {files: object[]} | undefined, running: boolean}} input 范围、仓库状态、差异、会话是否进行中。
 * @returns {{stageAll?: object, revertAll?: object, unstageAll?: object, commit?: object, createChangeRequest?: object}} 操作和是否可用。
 */
export function scopeActions({ scope, repo, diff, running }) {
  const empty = (diff?.files ?? []).every(file => file.status === 'conflict')
  const conflict = (repo?.conflicts ?? 0) > 0
  const gate = (...reasons) => {
    const reason = reasons.find(([when]) => when)?.[1]
    return reason === undefined ? RP_ENABLED : rpBlocked(reason)
  }
  if (scope.kind === 'unstaged') {
    return {
      stageAll: gate([conflict, 'conflict'], [empty, 'empty']),
      revertAll: gate([conflict, 'conflict'], [empty, 'empty'], [running, 'running']),
    }
  }
  if (scope.kind === 'staged') {
    return {
      unstageAll: gate([conflict, 'conflict'], [empty, 'empty']),
      commit: gate([repo?.detached === true, 'detached'], [conflict, 'conflict'], [empty, 'empty']),
    }
  }
  if (scope.kind === 'branch') return { createChangeRequest: gate([empty, 'empty']) }
  return {}
}

/**
 * 一个文件头上的操作（设计说明第 3 节的表）：冲突中的文件只剩「更多操作」里的打开和复制路径。
 * @param {{scope: object, file: object, running: boolean}} input 范围、文件、会话是否进行中。
 * @returns {{stage?: object, unstage?: object, revert?: object, reviewed?: boolean}} 操作和是否可用。
 */
export function fileActions({ scope, file, running }) {
  if (file.status === 'conflict') return {}
  const revert = running ? rpBlocked('running') : RP_ENABLED
  if (scope.kind === 'unstaged' || scope.kind === 'uncommitted') return { stage: RP_ENABLED, revert }
  if (scope.kind === 'staged') return { unstage: RP_ENABLED }
  if (scope.kind === 'branch') return { reviewed: true }
  if (scope.kind === 'turn') return { revert, reviewed: true }
  return {}
}

/**
 * 一处改动上的操作。「未提交」不按块操作（一处可能一半已暂存）；分支只看。
 * @param {{scope: object, file: object, running: boolean}} input 范围、文件、会话是否进行中。
 * @returns {{stage?: object, unstage?: object, revert?: object}} 操作和是否可用。
 */
export function hunkActions({ scope, file, running }) {
  if (file.status === 'conflict') return {}
  const revert = running ? rpBlocked('running') : RP_ENABLED
  if (scope.kind === 'unstaged') return { stage: RP_ENABLED, revert }
  if (scope.kind === 'staged') return { unstage: RP_ENABLED }
  if (scope.kind === 'turn') return { revert }
  return {}
}

/**
 * 全部回退的确认框要说的：回退几个文件、哪几个未跟踪的文件移到废纸篓。冲突中的文件宿主不回退，不算。
 * @param {object[]} files 未暂存范围的文件。
 * @returns {{count: number, untracked: string[]}} 文件数和未跟踪文件的路径。
 */
export function revertAllSummary(files) {
  const list = files.filter(file => file.status !== 'conflict')
  return { count: list.length, untracked: list.filter(file => file.status === 'untracked').map(file => file.path) }
}

/** 错误码 → 文案键。同一个码在几个动作里说法不同的，按动作或 detail 分开。 */
const RP_ERROR_KEYS = {
  stale: 'rp.err.stale',
  running: 'rp.err.running',
  locked: 'rp.err.locked',
  busy: 'rp.err.busy',
  conflict: 'rp.err.conflict',
  'not-git': 'rp.err.notGit',
  'no-staged': 'rp.err.noStaged',
  detached: 'rp.err.detached',
  'hook-failed': 'rp.err.hookFailed',
  'push-rejected': 'rp.err.pushRejected',
  'push-failed': 'rp.err.pushFailed',
  'invalid-branch-name': 'rp.err.invalidBranch',
  'not-found': 'rp.err.notFound',
  'too-large': 'rp.err.tooLarge',
  'bad-path': 'rp.err.badPath',
  'bad-request': 'rp.err.badRequest',
  'git-unavailable': 'rp.err.gitUnavailable',
  'no-reviewable-files': 'rp.err.noReviewableFiles',
  forbidden: 'rp.err.forbidden',
  network: 'rp.err.network',
}

/**
 * 宿主回的错误码对哪句文案（设计说明第 8 节的码，加上宿主补的 bad-path、bad-request、git-unavailable、no-reviewable-files，
 * 和网页自己的 network）。
 * @param {string} code 错误码。
 * @param {string} [action] 出错的动作：commits（读选中提交的差异）、create-branch、generate-message、undo 等。
 * @param {string} [detail] 宿主给的 detail（只用来分辨同一个码的几种情况）。
 * @returns {string} 文案键。
 */
export function reviewErrorKey(code, action, detail) {
  if (code === 'conflict' && action === 'commits') return 'rp.err.notLinear'
  if (code === 'conflict' && action === 'create-branch') return 'rp.err.branchExists'
  if (code === 'not-found' && action === 'generate-message') return detail === 'no-model' ? 'rp.err.noModel' : 'rp.err.generateUnavailable'
  if (code === 'stale' && action === 'undo') return 'rp.err.undoStale'
  return Object.hasOwn(RP_ERROR_KEYS, code) ? RP_ERROR_KEYS[code] : 'rp.err.unknown'
}

function findingFiles(files) {
  const byPath = new Map(files.map(file => [file.path, file]))
  for (const file of files) if (file.oldPath !== undefined && !byPath.has(file.oldPath)) byPath.set(file.oldPath, file)
  return byPath
}

/** @returns {'old' | 'new'} 发现引用的是原文件还是修改后的文件。 */
export function findingSide(file, finding) {
  return file.status === 'deleted' || file.oldPath === finding.path ? 'old' : 'new'
}

function findingLine(file, finding) {
  if (file === undefined || file.binary || file.tooLarge) return undefined
  const side = findingSide(file, finding)
  for (const hunk of file.hunks ?? []) {
    const line = hunk.lines.find(item => item[side] === finding.line)
    if (line !== undefined) return { side, text: line.text }
  }
  return undefined
}

/** 报告范围的差异里能看到的发现行，用来核对其他范围是否显示同一行。 */
export function reportFindingLines(report, files) {
  const byPath = findingFiles(files)
  return new Map(report.findings.map(finding => [finding.id, findingLine(byPath.get(finding.path), finding)]))
}

/**
 * @param {{findings: object[]} | undefined} report 本地审查报告。
 * @param {{path: string}[]} files 当前仓库和范围的文件。
 * @param {Map<string, {side: string, text: string} | undefined>} [sourceLines] 其他范围须核对的报告原文。
 * @returns {{byFile: Map<string, object[]>, outside: object[]}} 文件里的发现，以及在当前范围外、未忽略的发现。
 */
export function placeFindings(report, files, sourceLines) {
  const byFile = new Map()
  const outside = []
  if (report === undefined || report === null) return { byFile, outside }
  const paths = findingFiles(files)
  for (const finding of report.findings ?? []) {
    const file = paths.get(finding.path)
    const source = sourceLines?.get(finding.id)
    const displayed = source === undefined ? undefined : findingLine(file, finding)
    if (file === undefined || (sourceLines !== undefined && (displayed === undefined || displayed.side !== source.side || displayed.text !== source.text))) {
      if (finding.status !== 'ignored') outside.push(finding)
      continue
    }
    if (!byFile.has(file.path)) byFile.set(file.path, [])
    byFile.get(file.path).push(finding)
  }
  return { byFile, outside }
}

/**
 * 报告审的是哪个范围：未提交的审查对「未提交」；和分支比的审查比的是合并基准到工作区，对「分支」并含未提交的修改。
 * @param {{selection: {mode: string, base: string | null}}} report 本地审查报告。
 * @returns {object} 面板的范围。
 */
export function reportScope(report) {
  const selection = report?.selection
  if (selection?.mode === 'branch') return { kind: 'branch', base: selection.base.replace(/^refs\/heads\//, ''), includeUncommitted: true }
  return { kind: 'uncommitted' }
}

/**
 * 顶上一栏的各等级条数：忽略的不算。
 * @param {{severity: string, status: string}[]} findings 发现。
 * @returns {{high: number, medium: number, low: number}} 各等级条数。
 */
export function severityCounts(findings) {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const finding of findings) {
    if (finding.status !== 'ignored' && Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1
  }
  return counts
}

/**
 * Git 范围的评论拼成一条消息（给模型看，中文，句式照 lib/review/copy.js 的 composeReviewMessage）：
 * 开头说是哪个范围的改动，评论按文件和行号排好，每条带那一行的原文。
 * @param {{scopeText: string, comments: {scopeText?: string, display: string, line: number, side?: string, detached?: boolean, snippet: string, text: string}[]}} input
 *   评论保留添加时的比较范围，例如「分支 feat/x 上提交 a1b2c3d 的改动」。
 * @returns {string | undefined} 消息全文；没有评论时 undefined，调用方不该发。
 */
export function composeScopeMessage({ scopeText, comments }) {
  if (comments.length === 0) return undefined
  const byScope = new Map()
  for (const comment of comments) {
    const scope = comment.scopeText ?? scopeText
    if (!byScope.has(scope)) byScope.set(scope, [])
    byScope.get(scope).push(comment)
  }
  return [...byScope].map(([scope, items]) => `请按下面的评论修改${scope}：\n\n${reviewCommentEntries(items)}`).join('\n\n')
}

/**
 * 消息开头说的是哪个范围的改动（给模型看，中文，和 composeReviewMessage 一样不随界面语言变）。
 * @param {object} scope Git 范围。
 * @param {string | null} branch 当前分支名；游离的 HEAD 时 null。
 * @returns {string} 「未暂存的改动」「分支 feat/x 相对 main 的改动」「分支 feat/x 上提交 a1b2c3d 的改动」这样的说法。
 */
export function scopeMessageText(scope, branch) {
  if (scope.kind === 'unstaged') return '未暂存的改动'
  if (scope.kind === 'staged') return '已暂存的改动'
  if (scope.kind === 'uncommitted') return '未提交的改动'
  const where = branch === null ? 'HEAD' : `分支 ${branch}`
  if (scope.from !== undefined && scope.to !== undefined) {
    const short = sha => sha.slice(0, 7)
    const commits = scope.from === scope.to ? short(scope.from) : `${short(scope.from)}…${short(scope.to)}`
    return `${where} 上提交 ${commits} 的改动`
  }
  return `${where} 相对 ${scope.base} 的改动${scope.includeUncommitted === true ? '（含未提交的修改）' : ''}`
}

const RP_MINUTE = 60_000
const RP_HOUR = 60 * RP_MINUTE
const RP_DAY = 24 * RP_HOUR

/**
 * 提交时间的相对说法，单位照官方「变更」页（time.now、minutes、hours、days、months、years）。
 * @param {string} iso 提交时间（ISO 8601）。
 * @param {number} now 现在的毫秒数。
 * @returns {{unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years', n: number} | undefined} 单位和数；读不出时间时 undefined。
 */
export function reviewAgo(iso, now) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const span = Math.max(0, now - at)
  if (span < RP_MINUTE) return { unit: 'now', n: 0 }
  if (span < RP_HOUR) return { unit: 'minutes', n: Math.floor(span / RP_MINUTE) }
  if (span < RP_DAY) return { unit: 'hours', n: Math.floor(span / RP_HOUR) }
  const days = Math.floor(span / RP_DAY)
  if (days < 30) return { unit: 'days', n: days }
  if (days < 365) return { unit: 'months', n: Math.floor(days / 30) }
  return { unit: 'years', n: Math.floor(days / 365) }
}

/**
 * 选提交（照官方「变更」页）：点一个只看这一个；按住 Shift 再点，和已选的那一段的起点连成一段；点「全部提交」（sha 为 null）回到全部。
 * from 是这一段里最早的提交，to 是最新的。是否在同一条提交链上由宿主核对。
 * @param {{sha: string}[]} commits 分支上的提交，新的在前（宿主 commits 的顺序）。
 * @param {{from: string, to: string} | undefined} current 现在选的。
 * @param {string | null} sha 点的提交；null 是「全部提交」。
 * @param {boolean} shift 是否按住 Shift。
 * @returns {{from: string, to: string} | undefined} 新的选择；undefined 是全部提交。
 */
export function commitSelection(commits, current, sha, shift) {
  const at = sha === null ? -1 : commits.findIndex(commit => commit.sha === sha)
  if (at < 0) return undefined
  const from = shift && current !== undefined ? commits.findIndex(commit => commit.sha === current.from) : -1
  const to = shift && current !== undefined ? commits.findIndex(commit => commit.sha === current.to) : -1
  if (from < 0 || to < 0) return { from: sha, to: sha }
  // 下标大的更早：新的一段从三个点里最早的到最新的。
  const oldest = Math.max(from, at)
  const newest = Math.min(to, at)
  return { from: commits[oldest].sha, to: commits[newest].sha }
}

/**
 * 路径拆成目录（带末尾的 /）和文件名，文件头上目录用浅色。
 * @param {string} path 仓库内的相对路径。
 * @returns {{dir: string, name: string}} 目录和文件名。
 */
export function splitPath(path) {
  const at = path.lastIndexOf('/')
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

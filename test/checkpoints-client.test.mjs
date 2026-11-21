/**
 * 回到某条消息之前的网页端测试：找轮次、能不能回到这一轮、弹窗里的文字、弹窗的状态机和
 * 每个状态显示的内容、数据层、
 * 恢复和分叉的请求、条目挂载和撤销。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCheckpoints,
  checkpointAvailability,
  checkpointsConfigDraft,
  checkpointsConfigFromDraft,
  checkpointsConfirmTask,
  checkpointsDialogView,
  checkpointsEntryView,
  checkpointsForkNotice,
  checkpointsForkSession,
  checkpointsQuestionOf,
  checkpointsReasonText,
  checkpointsResultLine,
  checkpointsStoppedSessions,
  checkpointsSubtitle,
  checkpointsTailTarget,
  checkpointsTogglePreset,
  checkpointsTurnOf,
  createCheckpointsApi,
  fileRowView,
  noteLines,
  reduceDialog,
  restoreButtonLabel,
  restoreOptions,
  runCheckpointsTask,
  startCheckpointsRunWatcher,
  summaryOf,
  undoLine,
} from '../src/client/checkpoints.js'

// ---------- 假的 ChatSnapshot（照 0.2.2-rc.1 的 TurnLocation、turn-tail、聊天节点） ----------

/** 一轮：closing 是 undefined 时没有 turn-tail（还在运行），null 时没有最终回答。 */
const turnOf = (number, { startSeq, closing }) => ({
  turn: number,
  start: startSeq === undefined ? undefined : { seq: startSeq, type: 'turn/start' },
  data: { get: key => (key === 'turn-tail' && closing !== undefined ? { turn: number, seq: 99, closing } : undefined) },
})

/** 有最终回答（带 messageId）的 closing。 */
const answered = messageId => ({ finalNode: { messageId, seq: 50 }, blocks: [] })

/** 快照：轮次表、轮次到节点键、节点表。 */
const snapshotOf = (turns, turnKeys = new Map(), nodes = new Map()) => ({
  timeline: { turnOrder: turns.map(turn => turn.turn), turns: new Map(turns.map(turn => [turn.turn, turn])) },
  locations: { getTurn: number => turnKeys.get(number) ?? [] },
  nodes: { get: key => nodes.get(key) },
})

test('checkpointsTurnOf：按 turn-tail 的 messageId 找轮次，取轮次号和 turn/start 的序号', () => {
  const snapshot = snapshotOf([
    turnOf(2, { startSeq: 10, closing: answered('m2') }),
    turnOf(3, { startSeq: 30, closing: answered('m3') }),
  ])
  assert.deepEqual(checkpointsTurnOf(snapshot, 'm3'), { turn: 3, seq: 30 })
  assert.deepEqual(checkpointsTurnOf(snapshot, 'm2'), { turn: 2, seq: 10 })
  assert.equal(checkpointsTurnOf(snapshot, 'nope'), undefined)
  assert.equal(checkpointsTurnOf(snapshot, ''), undefined)
  assert.equal(checkpointsTurnOf(undefined, 'm2'), undefined)
  // 读不到 turn/start 的序号时只给轮次号（宿主的记录里有 seq，入口照样能用）
  assert.deepEqual(checkpointsTurnOf(snapshotOf([turnOf(4, { closing: answered('m4') })]), 'm4'), { turn: 4, seq: undefined })
})

test('checkpointsTailTarget：只给图标排不出现的已结束轮次（没有最终回答，或最终回答没有 messageId）', () => {
  assert.deepEqual(checkpointsTailTarget(turnOf(3, { startSeq: 30, closing: null })), { turn: 3, seq: 30 })
  assert.deepEqual(checkpointsTailTarget(turnOf(3, { startSeq: 30, closing: { finalNode: { seq: 40 }, blocks: [] } })), { turn: 3, seq: 30 })
  // 有最终回答的轮次图标排里已经有入口，不重复
  assert.equal(checkpointsTailTarget(turnOf(3, { startSeq: 30, closing: answered('m3') })), undefined)
  // 还在运行（没有 turn-tail）不出现
  assert.equal(checkpointsTailTarget(turnOf(3, { startSeq: 30 })), undefined)
  assert.equal(checkpointsTailTarget(undefined), undefined)
})

test('checkpointsQuestionOf 和 checkpointsSubtitle：第一条提问的文字块，副标题截到 30 个字', () => {
  const nodes = new Map([
    ['s', { kind: 'steering', data: { content: [{ type: 'text', text: '插话' }] } }],
    ['u', { kind: 'user', data: { content: [{ type: 'image' }, { type: 'text', text: '把登录页的表单校验' }, { type: 'text', text: '改成边输入边提示' }] } }],
  ])
  const snapshot = snapshotOf([turnOf(3, { startSeq: 30, closing: null })], new Map([[3, ['s', 'u']]]), nodes)
  assert.equal(checkpointsQuestionOf(snapshot, 3), '把登录页的表单校验 改成边输入边提示')
  assert.equal(checkpointsQuestionOf(snapshot, 9), '')
  assert.deepEqual(checkpointsSubtitle(3, '把登录页的表单校验改成边输入边提示'),
    { key: 'checkpoints.subtitle', params: { turn: '3', question: '把登录页的表单校验改成边输入边提示' } })
  // 超过 30 个字截断加省略号；按字符数（表情这类代理对算一个字），连续空白并成一个空格
  const long = '一二三四五六七八九十'.repeat(3) + '😀多出来的'
  assert.equal(checkpointsSubtitle(1, long).params.question, `${'一二三四五六七八九十'.repeat(3)}…`)
  assert.equal(checkpointsSubtitle(1, `${'字'.repeat(29)}😀尾`).params.question, `${'字'.repeat(29)}😀…`)
  assert.equal(checkpointsSubtitle(1, '  第一行\n\n第二行  ').params.question, '第一行 第二行')
  assert.deepEqual(checkpointsSubtitle(5, '   '), { key: 'checkpoints.subtitleTurn', params: { turn: '5' } })
})

// ---------- 能不能回到这一轮 ----------

/** list 的回答（接口文档 list 一节）。 */
const listBody = (overrides = {}) => ({
  ok: true,
  eligible: true,
  full: false,
  entries: [{ turn: 1, seq: 5, time: 1000, kind: 'git' }, { turn: 3, seq: 30, time: 3000, kind: 'git' }],
  undo: null,
  ...overrides,
})

test('checkpointAvailability：有记录、会话没在运行就能回到这一轮', () => {
  const result = checkpointAvailability({ ...listBody(), running: false, turn: 3, seq: 30 })
  assert.deepEqual(result, { ok: true, entry: { turn: 3, seq: 30, time: 3000, kind: 'git' } })
  // 不知道 turn/start 的序号时按轮次号对
  assert.equal(checkpointAvailability({ ...listBody(), running: false, turn: 3 }).ok, true)
})

test('checkpointAvailability：轮次本身的原因先于会话进行中（样稿 H）', () => {
  assert.deepEqual(checkpointAvailability({ ...listBody(), running: true, turn: 2, seq: 20 }), { ok: false, reason: 'no-checkpoint' })
  assert.deepEqual(checkpointAvailability({ ...listBody({ eligible: false, entries: [] }), running: true, turn: 3, seq: 30 }), { ok: false, reason: 'no-checkpoint' })
  assert.deepEqual(checkpointAvailability({ ...listBody(), running: true, turn: 3, seq: 30, expired: new Set([3]) }), { ok: false, reason: 'expired' })
  assert.deepEqual(checkpointAvailability({ ...listBody(), running: true, turn: 3, seq: 30 }), { ok: false, reason: 'running' })
  // 记录里的序号对不上（分叉继承来的同号轮次）：算这一轮没有检查点
  assert.deepEqual(checkpointAvailability({ ...listBody(), running: false, turn: 3, seq: 31 }), { ok: false, reason: 'no-checkpoint' })
})

test('checkpointAvailability：已满只影响没有记录的新轮次，存下来的轮次照常能用', () => {
  const full = listBody({ full: true })
  assert.deepEqual(checkpointAvailability({ ...full, running: false, turn: 4, seq: 40 }), { ok: false, reason: 'full' })
  assert.equal(checkpointAvailability({ ...full, running: false, turn: 3, seq: 30 }).ok, true)
  // 中间漏存的旧轮次不是「已满」
  assert.deepEqual(checkpointAvailability({ ...full, running: false, turn: 2, seq: 20 }), { ok: false, reason: 'no-checkpoint' })
  // 一条记录都没有时每一轮都是新轮次
  assert.deepEqual(checkpointAvailability({ ...listBody({ full: true, entries: [] }), running: false, turn: 1, seq: 5 }), { ok: false, reason: 'full' })
})

test('checkpointsEntryView：还没读到是 loading，读失败写原因，读到过就用上一份', () => {
  const target = { turn: 3, seq: 30, running: false }
  assert.deepEqual(checkpointsEntryView(undefined, target), { ok: false, reason: 'loading' })
  assert.deepEqual(checkpointsEntryView({ error: { reason: 'disconnected', message: 'fetch failed' } }, target),
    { ok: false, reason: 'disconnected', message: 'fetch failed' })
  assert.deepEqual(checkpointsEntryView({ error: { reason: 'failed', message: 'HTTP 404' } }, target),
    { ok: false, reason: 'unavailable', message: 'HTTP 404' })
  const { ok, ...value } = listBody()
  const view = checkpointsEntryView({ value, error: { reason: 'disconnected', message: 'x' }, expired: new Set() }, target)
  assert.equal(view.ok, true)
})

test('checkpointsReasonText：认识的原因用词典，其余显示宿主的话', () => {
  assert.deepEqual(checkpointsReasonText({ reason: 'running', message: 'whatever' }), { key: 'checkpoints.reason.running' })
  assert.deepEqual(checkpointsReasonText({ reason: 'not-eligible' }), { key: 'checkpoints.reason.noCheckpoint' })
  assert.deepEqual(checkpointsReasonText({ reason: 'busy' }), { key: 'checkpoints.reason.busy' })
  assert.deepEqual(checkpointsReasonText({ reason: 'git-unavailable' }), { key: 'checkpoints.reason.gitUnavailable' })
  assert.deepEqual(checkpointsReasonText({ reason: 'expired' }), { key: 'checkpoints.reason.expired' })
  assert.deepEqual(checkpointsReasonText({ reason: 'full' }), { key: 'checkpoints.reason.full' })
  assert.deepEqual(checkpointsReasonText({ reason: 'unavailable', message: 'HTTP 404' }), { key: 'checkpoints.reason.unavailable', params: { message: 'HTTP 404' } })
  // bad-request、failed 和不认识的：宿主写的中文原因，句尾的句号去掉（词条自己收尾）
  assert.deepEqual(checkpointsReasonText({ reason: 'bad-request', message: 'turn 必须是正整数。' }), { text: 'turn 必须是正整数' })
  assert.deepEqual(checkpointsReasonText({ reason: 'failed', message: '' }), { text: 'failed' })
  assert.deepEqual(checkpointsReasonText({ reason: 'something-new', message: '新原因' }), { text: '新原因' })
})

// ---------- 弹窗里的文字 ----------

test('restoreOptions 和 restoreButtonLabel：三种做法和主按钮的字（样稿 C）', () => {
  assert.deepEqual(restoreOptions().map(option => [option.id, option.forks, option.restoresFiles]),
    [['files', false, true], ['fork', true, false], ['both', true, true]])
  assert.equal(restoreButtonLabel('files'), 'checkpoints.button.files')
  assert.equal(restoreButtonLabel('fork'), 'checkpoints.button.fork')
  assert.equal(restoreButtonLabel('both'), 'checkpoints.button.both')
})

test('fileRowView：删除、行数、二进制、各种不恢复的原因', () => {
  assert.deepEqual(fileRowView({ path: 'src/a.ts', action: 'restore', added: 42, deleted: 12, binary: false }),
    { path: 'src/a.ts', counts: { added: 42, deleted: 12 } })
  assert.deepEqual(fileRowView({ path: 'src/new.ts', action: 'delete', added: 0, deleted: 30, binary: false }),
    { path: 'src/new.ts', tag: { key: 'checkpoints.tag.delete' } })
  assert.deepEqual(fileRowView({ path: 'logo.png', action: 'restore', added: 0, deleted: 0, binary: true }),
    { path: 'logo.png', tag: { key: 'checkpoints.tag.binary' } })
  assert.deepEqual(fileRowView({ path: 'packages/legacy', action: 'skip', reason: 'submodule' }).tag, { key: 'checkpoints.tag.submodule' })
  assert.deepEqual(fileRowView({ path: 'build/', action: 'skip', reason: 'ignored-inside' }).tag, { key: 'checkpoints.tag.ignoredInside' })
  assert.deepEqual(fileRowView({ path: 'x', action: 'skip', reason: 'changed-after' }).tag, { key: 'checkpoints.tag.changedAfter' })
  assert.deepEqual(fileRowView({ path: 'assets/logo.png', action: 'skip', reason: 'oversized' }, { maxFileMB: 2 }).tag,
    { key: 'checkpoints.tag.oversized', params: { mb: '2' } })
  assert.deepEqual(fileRowView({ path: 'assets/logo.png', action: 'skip', reason: 'oversized' }).tag, { key: 'checkpoints.tag.oversizedNoLimit' })
  assert.deepEqual(fileRowView({ path: 'x', action: 'skip', reason: 'later-reason' }).tag, { key: 'checkpoints.tag.skip' })
  // 行数缺了、是负数都当 0
  assert.deepEqual(fileRowView({ path: 'y', action: 'restore', added: -1 }).counts, { added: 0, deleted: 0 })
})

/** preview 的回答（接口文档 preview 一节），默认是样稿 C 的那一份。 */
const previewBody = (overrides = {}) => ({
  ok: true,
  root: '/Users/me/code/deepseek-harness',
  cwdInside: false,
  kind: 'git',
  files: [
    { path: 'src/pages/login/LoginForm.tsx', action: 'restore', added: 42, deleted: 12, binary: false },
    { path: 'src/pages/login/useValidation.ts', action: 'delete', added: 0, deleted: 0, binary: false },
    { path: 'src/pages/login/LoginForm.test.tsx', action: 'restore', added: 28, deleted: 9, binary: false },
    { path: 'src/styles/form.css', action: 'restore', added: 10, deleted: 6, binary: false },
  ],
  total: 7,
  truncated: true,
  notes: [],
  ...overrides,
})

test('summaryOf：总数、行数合计、没列出来的条数；只列了一部分时不写合计', () => {
  assert.deepEqual(summaryOf(previewBody()), { total: 7, added: 80, deleted: 27, showTotals: false, more: 3 })
  const all = previewBody({
    total: 3,
    truncated: false,
    files: [
      { path: 'notes/plan.md', action: 'restore', added: 14, deleted: 3, binary: false },
      { path: 'scripts/build.sh', action: 'restore', added: 0, deleted: 22, binary: false },
      { path: 'assets/logo.png', action: 'skip', added: 0, deleted: 0, binary: true, reason: 'oversized' },
    ],
  })
  // 样稿 I：「会变的 3 个文件 +14 −25」，不能恢复的那一条算进总数、不算行数
  assert.deepEqual(summaryOf(all), { total: 3, added: 14, deleted: 25, showTotals: true, more: 0 })
  assert.deepEqual(summaryOf(previewBody({ files: [], total: 0, truncated: false })), { total: 0, added: 0, deleted: 0, showTotals: true, more: 0 })
})

test('noteLines：范围、不在 git 里、.gitignore 改过、过滤器；不认识的 notes 忽略', () => {
  assert.deepEqual(noteLines(previewBody(), { cwd: '/Users/me/code/deepseek-harness/packages/web' }),
    [{ key: 'checkpoints.note.scope', params: { repo: 'deepseek-harness', dir: 'packages/web' }, tone: 'info' }])
  assert.deepEqual(noteLines(previewBody(), { cwd: '/elsewhere' }),
    [{ key: 'checkpoints.note.scopeRepo', params: { repo: 'deepseek-harness' }, tone: 'info' }])
  assert.deepEqual(noteLines(previewBody({ cwdInside: true })), [{ key: 'checkpoints.note.ignored', tone: 'info' }])
  assert.deepEqual(noteLines(previewBody({ kind: 'files', cwdInside: true, notes: ['nongit'] })), [{ key: 'checkpoints.note.nongit', tone: 'warning' }])
  assert.deepEqual(noteLines(previewBody({ cwdInside: true, notes: ['gitignore-changed', 'lfs-or-filters', 'from-the-future'] })), [
    { key: 'checkpoints.note.ignored', tone: 'info' },
    { key: 'checkpoints.note.gitignoreChanged', tone: 'info' },
    { key: 'checkpoints.note.lfsOrFilters', tone: 'warning' },
  ])
  // Windows 的路径分隔符也认
  assert.deepEqual(noteLines(previewBody({ root: 'C:\\code\\repo' }), { cwd: 'C:\\code\\repo\\pkg\\a' })[0].params, { repo: 'repo', dir: 'pkg/a' })
})

test('undoLine：今天写时分，昨天写「昨天」，更早写月日；没有可撤销的恢复时不出现', () => {
  const now = new Date(2026, 10, 6, 21, 30).getTime()
  assert.deepEqual(undoLine({ time: new Date(2026, 10, 6, 21, 7).getTime(), turn: 3 }, now), { key: 'checkpoints.undoLine.today', params: { time: '21:07' } })
  assert.deepEqual(undoLine({ time: new Date(2026, 10, 5, 9, 3).getTime(), turn: 3 }, now), { key: 'checkpoints.undoLine.yesterday', params: { time: '09:03' } })
  assert.deepEqual(undoLine({ time: new Date(2026, 10, 1, 8, 0).getTime(), turn: 3 }, now), { key: 'checkpoints.undoLine.date', params: { month: '11', day: '1', time: '08:00' } })
  // 跨年的昨天
  assert.equal(undoLine({ time: new Date(2026, 11, 31, 23, 59).getTime() }, new Date(2027, 0, 1, 0, 5).getTime()).key, 'checkpoints.undoLine.yesterday')
  assert.equal(undoLine(null, now), undefined)
  assert.equal(undoLine(undefined, now), undefined)
  assert.equal(undoLine({ turn: 3 }, now), undefined)
})

test('checkpointsResultLine 和 checkpointsForkNotice：结果句和分叉后的提示（样稿 E、F、G）', () => {
  assert.deepEqual(checkpointsResultLine({ restored: 7, skipped: [] }, 'restore'), { key: 'checkpoints.result.restored', params: { n: '7' } })
  assert.deepEqual(checkpointsResultLine({ restored: 5, skipped: [{ path: 'a', reason: 'submodule' }, { path: 'b', reason: 'ignored-inside' }] }, 'restore'),
    { key: 'checkpoints.result.partial', params: { n: '5', skipped: '2' } })
  assert.deepEqual(checkpointsResultLine({ restored: 7, skipped: [] }, 'undo'), { key: 'checkpoints.result.undone', params: {} })
  assert.deepEqual(checkpointsForkNotice(3, undefined), { key: 'checkpoints.notice.forked', params: { turn: '3' } })
  assert.deepEqual(checkpointsForkNotice(3, { restored: 7, skipped: [] }), { key: 'checkpoints.notice.restoredForked', params: { turn: '3', n: '7' } })
  assert.deepEqual(checkpointsForkNotice(3, { restored: 5, skipped: [{ path: 'a' }] }),
    { key: 'checkpoints.notice.partialForked', params: { turn: '3', n: '5', skipped: '1' } })
})

// ---------- 弹窗的状态机 ----------

const TARGET = { sessionId: 's1', turn: 3 }
const RESTORED = { restored: 7, skipped: [] }

/** 依次派发事件。 */
const run = (events, state = { phase: 'closed' }) => events.reduce(reduceDialog, state)

/** 打开并算好文件列表。 */
const readyState = (preview = previewBody(), forkAllowed = true) => run([
  { type: 'open', token: 1, target: TARGET, forkAllowed },
  { type: 'previewed', token: 1, preview },
])

test('reduceDialog：打开先算文件列表，默认两样都做；不能分叉的会话只能恢复文件', () => {
  const loading = reduceDialog({ phase: 'closed' }, { type: 'open', token: 1, target: TARGET, forkAllowed: true })
  assert.deepEqual(loading, { phase: 'loading', token: 1, target: TARGET, forkAllowed: true, choice: 'both' })
  const ready = reduceDialog(loading, { type: 'previewed', token: 1, preview: previewBody() })
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.preview.total, 7)
  const noFork = reduceDialog({ phase: 'closed' }, { type: 'open', token: 1, target: TARGET, forkAllowed: false })
  assert.equal(noFork.choice, 'files')
  assert.equal(reduceDialog(noFork, { type: 'choose', choice: 'both' }), noFork)
})

test('reduceDialog：旧请求的回答（token 对不上）丢掉；重新打开同一轮保留选的做法', () => {
  const first = run([{ type: 'open', token: 1, target: TARGET, forkAllowed: true }, { type: 'choose', choice: 'files' }])
  const reopened = reduceDialog(first, { type: 'open', token: 2, target: TARGET, forkAllowed: true })
  assert.equal(reopened.choice, 'files')
  assert.equal(reduceDialog(reopened, { type: 'previewed', token: 1, preview: previewBody() }), reopened)
  assert.equal(reduceDialog(reopened, { type: 'previewFailed', token: 1, failure: { reason: 'busy' } }), reopened)
  // 换了一轮打开，回到默认的两样都做
  const other = reduceDialog(first, { type: 'open', token: 3, target: { sessionId: 's1', turn: 4 }, forkAllowed: true })
  assert.equal(other.choice, 'both')
})

test('reduceDialog：算文件列表失败后只能分叉，选别的主按钮置灰；文件列表算完之前也只能分叉', () => {
  const failed = run([
    { type: 'open', token: 1, target: TARGET, forkAllowed: true },
    { type: 'previewFailed', token: 1, failure: { reason: 'expired', message: '检查点已失效' } },
  ])
  assert.deepEqual(failed.error, { step: 'preview', reason: 'expired', message: '检查点已失效' })
  assert.equal(checkpointsConfirmTask(failed), undefined)
  assert.equal(reduceDialog(failed, { type: 'confirm' }), failed)
  const fork = reduceDialog(failed, { type: 'choose', choice: 'fork' })
  assert.equal(checkpointsConfirmTask(fork), 'fork')
  assert.equal(reduceDialog(fork, { type: 'confirm' }).task, 'fork')
  const loading = run([{ type: 'open', token: 1, target: TARGET, forkAllowed: true }])
  assert.equal(checkpointsConfirmTask(loading), undefined)
  assert.equal(checkpointsConfirmTask(reduceDialog(loading, { type: 'choose', choice: 'fork' })), 'fork')
})

test('reduceDialog：只恢复文件——成功进 done，可以撤销一次；撤销完写结果', () => {
  const ready = reduceDialog(readyState(), { type: 'choose', choice: 'files' })
  const working = reduceDialog(ready, { type: 'confirm' })
  assert.equal(working.phase, 'working')
  assert.equal(working.task, 'restore')
  // working 时关不掉、不能换做法、不能再点一次
  assert.equal(reduceDialog(working, { type: 'close' }), working)
  assert.equal(reduceDialog(working, { type: 'choose', choice: 'fork' }), working)
  assert.equal(reduceDialog(working, { type: 'confirm' }), working)
  const done = reduceDialog(working, { type: 'succeeded', token: 1, step: 'restore', result: RESTORED })
  assert.equal(done.phase, 'done')
  assert.deepEqual(done.restored, RESTORED)
  const undoing = reduceDialog(done, { type: 'undo' })
  assert.equal(undoing.task, 'undo')
  const undone = reduceDialog(undoing, { type: 'undone', token: 1, result: { restored: 7, skipped: [] } })
  assert.equal(undone.phase, 'done')
  assert.deepEqual(undone.undone, { restored: 7, skipped: [] })
  assert.equal(reduceDialog(undone, { type: 'undo' }), undone)
  assert.deepEqual(reduceDialog(undone, { type: 'close' }), { phase: 'closed' })
})

test('reduceDialog：没有会变的文件时「只恢复文件」置灰', () => {
  const empty = reduceDialog(readyState(previewBody({ files: [], total: 0, truncated: false })), { type: 'choose', choice: 'files' })
  assert.equal(checkpointsConfirmTask(empty), undefined)
  assert.equal(checkpointsConfirmTask(reduceDialog(empty, { type: 'choose', choice: 'both' })), 'both')
})

test('reduceDialog：恢复失败停在弹窗里、可以重试，不分叉', () => {
  const working = reduceDialog(readyState(), { type: 'confirm' })
  assert.equal(working.task, 'both')
  const failed = reduceDialog(working, { type: 'failed', token: 1, step: 'restore', failure: { reason: 'busy', message: '另一个' } })
  assert.equal(failed.phase, 'error')
  assert.deepEqual(failed.error, { step: 'restore', reason: 'busy', message: '另一个' })
  assert.equal(checkpointsConfirmTask(failed), 'both')
  const retry = reduceDialog(failed, { type: 'confirm' })
  assert.equal(retry.phase, 'working')
  assert.equal(retry.error, undefined)
  // 恢复失败后不能换做法（换做法要重新打开，文件列表要重新算）
  assert.equal(reduceDialog(failed, { type: 'choose', choice: 'fork' }), failed)
})

test('reduceDialog：两样都做——恢复成功后接着分叉，分叉成功关掉；分叉失败重试只分叉', () => {
  const working = reduceDialog(readyState(), { type: 'confirm' })
  const restored = reduceDialog(working, { type: 'succeeded', token: 1, step: 'restore', result: RESTORED })
  assert.equal(restored.phase, 'working')
  assert.deepEqual(restored.restored, RESTORED)
  assert.deepEqual(reduceDialog(restored, { type: 'succeeded', token: 1, step: 'fork' }), { phase: 'closed' })
  const forkFailed = reduceDialog(restored, { type: 'failed', token: 1, step: 'fork', failure: { reason: 'failed', message: 'session/fork denied' } })
  assert.equal(forkFailed.phase, 'error')
  assert.equal(checkpointsConfirmTask(forkFailed), 'fork')
  assert.equal(reduceDialog(forkFailed, { type: 'confirm' }).task, 'fork')
  // 文件已经恢复了，撤销按钮不在这个状态出现（要回到弹窗最上面那一行）
  assert.equal(reduceDialog(forkFailed, { type: 'undo' }), forkFailed)
})

test('reduceDialog：只分叉会话成功就关掉；不认识的事件、选项原样返回', () => {
  const fork = reduceDialog(readyState(), { type: 'choose', choice: 'fork' })
  const working = reduceDialog(fork, { type: 'confirm' })
  assert.equal(working.task, 'fork')
  assert.equal(reduceDialog(working, { type: 'succeeded', token: 1, step: 'restore', result: RESTORED }), working)
  assert.deepEqual(reduceDialog(working, { type: 'succeeded', token: 1, step: 'fork' }), { phase: 'closed' })
  assert.equal(reduceDialog(fork, { type: 'choose', choice: 'nonsense' }), fork)
  assert.equal(reduceDialog(fork, { type: 'who-knows' }), fork)
})

test('reduceDialog：弹窗最上面那一行的撤销——打开着就能撤销，失败可以重试', () => {
  const ready = readyState()
  const undoing = reduceDialog(ready, { type: 'undo' })
  assert.equal(undoing.phase, 'working')
  assert.equal(undoing.task, 'undo')
  const failed = reduceDialog(undoing, { type: 'failed', token: 1, step: 'undo', failure: { reason: 'running', message: '' } })
  assert.equal(failed.error.step, 'undo')
  assert.equal(reduceDialog(failed, { type: 'undo' }).phase, 'working')
  const undone = reduceDialog(undoing, { type: 'undone', token: 1, result: RESTORED })
  assert.equal(undone.phase, 'done')
  // 撤销的回答 token 对不上丢掉
  assert.equal(reduceDialog(undoing, { type: 'undone', token: 9, result: RESTORED }), undoing)
})

// ---------- 每个状态要显示什么 ----------

const NOW = new Date(2026, 10, 6, 21, 30).getTime()
const CONTEXT = { undo: null, now: NOW, cwd: '/Users/me/code/deepseek-harness/packages/web', maxFileMB: 2 }

/** 按钮只看 id、字、动作和置灰。 */
const buttonsOf = view => view.buttons.map(item => [item.id, item.label, item.action, item.disabled])

test('checkpointsDialogView：正在算文件列表（样稿 D）——主按钮置灰，取消随时可点', () => {
  const view = checkpointsDialogView(run([{ type: 'open', token: 1, target: TARGET, forkAllowed: true }, { type: 'choose', choice: 'files' }]), CONTEXT)
  assert.deepEqual(view.options.map(option => [option.id, option.selected, option.disabled]), [['files', true, false], ['fork', false, false], ['both', false, false]])
  assert.deepEqual(view.body, [{ kind: 'loading', text: { key: 'checkpoints.loading' } }])
  assert.equal(view.footerNote, undefined)
  assert.deepEqual(buttonsOf(view), [['cancel', 'checkpoints.button.cancel', 'close', false], ['primary', 'checkpoints.button.files', 'confirm', true]])
})

test('checkpointsDialogView：默认状态（样稿 C）——文件列表、范围说明、底部说明，主按钮写「恢复文件并分叉会话」', () => {
  const view = checkpointsDialogView(readyState(), CONTEXT)
  assert.equal(view.undoLine, undefined)
  assert.equal(view.options.find(option => option.selected).id, 'both')
  const [files, note] = view.body
  assert.equal(files.kind, 'files')
  assert.deepEqual(files.summary, { total: 7, added: 80, deleted: 27, showTotals: false, more: 3 })
  assert.deepEqual(files.rows[1], { path: 'src/pages/login/useValidation.ts', tag: { key: 'checkpoints.tag.delete' } })
  assert.deepEqual(note, { kind: 'note', tone: 'info', text: { key: 'checkpoints.note.scope', params: { repo: 'deepseek-harness', dir: 'packages/web' } } })
  assert.equal(view.footerNote, 'checkpoints.footer')
  assert.deepEqual(buttonsOf(view), [['cancel', 'checkpoints.button.cancel', 'close', false], ['primary', 'checkpoints.button.both', 'confirm', false]])
})

test('checkpointsDialogView：选「只分叉会话」时文件列表、范围说明和底部说明都收起', () => {
  const view = checkpointsDialogView(reduceDialog(readyState(), { type: 'choose', choice: 'fork' }), CONTEXT)
  assert.deepEqual(view.body, [])
  assert.equal(view.footerNote, undefined)
  assert.deepEqual(buttonsOf(view)[1], ['primary', 'checkpoints.button.fork', 'confirm', false])
})

test('checkpointsDialogView：会话不允许分叉时带分叉的两项置灰并写原因', () => {
  const view = checkpointsDialogView(readyState(previewBody(), false), CONTEXT)
  assert.deepEqual(view.options.map(option => [option.id, option.disabled, option.hint]), [
    ['files', false, 'checkpoints.option.filesHint'],
    ['fork', true, 'checkpoints.option.noFork'],
    ['both', true, 'checkpoints.option.noFork'],
  ])
})

test('checkpointsDialogView：有可撤销的恢复时最上面一行「你在 21:07 恢复过一次，撤销」（样稿 E）', () => {
  const undo = { time: new Date(2026, 10, 6, 21, 7).getTime(), turn: 2 }
  const view = checkpointsDialogView(readyState(), { ...CONTEXT, undo })
  assert.deepEqual(view.undoLine, { text: { key: 'checkpoints.undoLine.today', params: { time: '21:07' } }, disabled: false, working: false })
  const undoing = checkpointsDialogView(reduceDialog(readyState(), { type: 'undo' }), { ...CONTEXT, undo })
  assert.deepEqual(undoing.undoLine, { text: { key: 'checkpoints.undoLine.today', params: { time: '21:07' } }, disabled: true, working: true })
  assert.deepEqual(buttonsOf(undoing), [['cancel', 'checkpoints.button.cancel', 'close', true], ['primary', 'checkpoints.working.undo', 'confirm', true]])
})

test('checkpointsDialogView：不在 git 里的目录（样稿 I）——不能恢复的文件标出来，说明写只记文件工具改过的', () => {
  const preview = previewBody({
    root: '/Users/me/notes', cwdInside: true, kind: 'files', total: 3, truncated: false, notes: ['nongit'],
    files: [
      { path: 'notes/plan.md', action: 'restore', added: 14, deleted: 3, binary: false },
      { path: 'scripts/build.sh', action: 'restore', added: 0, deleted: 22, binary: false },
      { path: 'assets/logo.png', action: 'skip', added: 0, deleted: 0, binary: true, reason: 'oversized' },
    ],
  })
  const view = checkpointsDialogView(readyState(preview), CONTEXT)
  assert.deepEqual(view.body[0].summary, { total: 3, added: 14, deleted: 25, showTotals: true, more: 0 })
  assert.deepEqual(view.body[0].rows[2].tag, { key: 'checkpoints.tag.oversized', params: { mb: '2' } })
  assert.deepEqual(view.body[1], { kind: 'note', tone: 'warning', text: { key: 'checkpoints.note.nongit', params: undefined } })
})

test('checkpointsDialogView：工作区和这一轮开始前一样时写一句话，不画空表', () => {
  const view = checkpointsDialogView(readyState(previewBody({ files: [], total: 0, truncated: false, cwdInside: true })), CONTEXT)
  assert.deepEqual(view.body[0], { kind: 'note', tone: 'info', text: { key: 'checkpoints.files.none' } })
})

test('checkpointsDialogView：文件列表算失败——能重试的给「重试」，已失效的不给', () => {
  const open = { type: 'open', token: 1, target: TARGET, forkAllowed: true }
  const busy = checkpointsDialogView(run([open, { type: 'previewFailed', token: 1, failure: { reason: 'busy', message: '' } }]), CONTEXT)
  assert.deepEqual(busy.body, [{ kind: 'result', tone: 'error', text: { key: 'checkpoints.reason.busy' } }])
  assert.deepEqual(buttonsOf(busy)[1], ['retry', 'checkpoints.button.retry', 'retryPreview', false])
  const expired = checkpointsDialogView(run([open, { type: 'previewFailed', token: 1, failure: { reason: 'expired', message: '' } }]), CONTEXT)
  assert.deepEqual(buttonsOf(expired)[1], ['primary', 'checkpoints.button.both', 'confirm', true])
})

test('checkpointsDialogView：只恢复文件完成（样稿 E、F）——结果、没有恢复的、撤销和完成', () => {
  const files = reduceDialog(readyState(), { type: 'choose', choice: 'files' })
  const done = run([{ type: 'confirm' }, { type: 'succeeded', token: 1, step: 'restore', result: RESTORED }], files)
  const view = checkpointsDialogView(done, CONTEXT)
  assert.equal(view.options, undefined)
  assert.deepEqual(view.body, [
    { kind: 'result', tone: 'success', text: { key: 'checkpoints.result.restored', params: { n: '7' } } },
    { kind: 'note', tone: 'info', text: { key: 'checkpoints.result.undoHint' } },
  ])
  assert.deepEqual(buttonsOf(view), [['undo', 'checkpoints.button.undo', 'undo', false], ['done', 'checkpoints.button.done', 'close', false]])
  const partial = run([{ type: 'confirm' }, {
    type: 'succeeded', token: 1, step: 'restore',
    result: { restored: 5, skipped: [{ path: 'packages/legacy', reason: 'submodule' }, { path: 'build/', reason: 'ignored-inside' }] },
  }], files)
  const partialView = checkpointsDialogView(partial, CONTEXT)
  assert.deepEqual(partialView.body[0].text, { key: 'checkpoints.result.partial', params: { n: '5', skipped: '2' } })
  assert.deepEqual(partialView.body[1].rows, [
    { path: 'packages/legacy', tag: { key: 'checkpoints.tag.submodule' } },
    { path: 'build/', tag: { key: 'checkpoints.tag.ignoredInside' } },
  ])
  const undoing = checkpointsDialogView(reduceDialog(done, { type: 'undo' }), CONTEXT)
  assert.deepEqual(buttonsOf(undoing), [['undo', 'checkpoints.working.undo', 'undo', true], ['done', 'checkpoints.button.done', 'close', true]])
  const undone = checkpointsDialogView(run([{ type: 'undo' }, { type: 'undone', token: 1, result: RESTORED }], done), CONTEXT)
  assert.deepEqual(undone.body, [{ kind: 'result', tone: 'success', text: { key: 'checkpoints.result.undone', params: {} } }])
  assert.deepEqual(buttonsOf(undone), [['done', 'checkpoints.button.done', 'close', false]])
})

test('checkpointsDialogView：恢复没成（样稿 F2）——原因、「文件没有改动」、取消和重试', () => {
  const failed = run([{ type: 'confirm' }, { type: 'failed', token: 1, step: 'restore', failure: { reason: 'busy', message: 'x' } }], readyState())
  const view = checkpointsDialogView(failed, CONTEXT)
  assert.deepEqual(view.body, [
    { kind: 'result', tone: 'error', text: { key: 'checkpoints.error.restore', params: { reason: { key: 'checkpoints.reason.busy' } } } },
    { kind: 'note', tone: 'info', text: { key: 'checkpoints.error.untouched' } },
  ])
  assert.deepEqual(buttonsOf(view), [['cancel', 'checkpoints.button.cancel', 'close', false], ['retry', 'checkpoints.button.retry', 'confirm', false]])
  // 检查点已失效时重试也没用，只留关闭
  const expired = run([{ type: 'confirm' }, { type: 'failed', token: 1, step: 'restore', failure: { reason: 'expired', message: '' } }], readyState())
  assert.deepEqual(buttonsOf(checkpointsDialogView(expired, CONTEXT)), [['cancel', 'checkpoints.button.cancel', 'close', false]])
  // 宿主的 500（failed）不能保证文件没动，不写那一句
  const crashed = run([{ type: 'confirm' }, { type: 'failed', token: 1, step: 'restore', failure: { reason: 'failed', message: 'git checkout-index 失败' } }], readyState())
  assert.deepEqual(checkpointsDialogView(crashed, CONTEXT).body, [
    { kind: 'result', tone: 'error', text: { key: 'checkpoints.error.restore', params: { reason: { text: 'git checkout-index 失败' } } } },
  ])
})

test('checkpointsDialogView：两样都做——恢复完正在分叉，分叉失败写原因、重试只分叉', () => {
  const restored = run([{ type: 'confirm' }, { type: 'succeeded', token: 1, step: 'restore', result: RESTORED }], readyState())
  const working = checkpointsDialogView(restored, CONTEXT)
  // 「正在分叉…」只写在按钮上，不在正文里再写一遍
  assert.deepEqual(working.body, [
    { kind: 'result', tone: 'success', text: { key: 'checkpoints.result.restored', params: { n: '7' } } },
  ])
  assert.deepEqual(buttonsOf(working), [['cancel', 'checkpoints.button.done', 'close', true], ['primary', 'checkpoints.working.fork', 'confirm', true]])
  const failed = checkpointsDialogView(reduceDialog(restored, { type: 'failed', token: 1, step: 'fork', failure: { reason: 'failed', message: 'session/fork denied' } }), CONTEXT)
  assert.deepEqual(failed.body[1], { kind: 'result', tone: 'error', text: { key: 'checkpoints.error.fork', params: { reason: { text: 'session/fork denied' } } } })
  assert.deepEqual(buttonsOf(failed), [['cancel', 'checkpoints.button.done', 'close', false], ['retry', 'checkpoints.button.retry', 'confirm', false]])
})

test('checkpointsDialogView：撤销没成写原因，重试再撤销一次；撤销点已经不在时不写「这一轮没有检查点」', () => {
  const failed = run([{ type: 'undo' }, { type: 'failed', token: 1, step: 'undo', failure: { reason: 'running', message: '' } }], readyState())
  const view = checkpointsDialogView(failed, CONTEXT)
  assert.deepEqual(view.body, [
    { kind: 'result', tone: 'error', text: { key: 'checkpoints.error.undo', params: { reason: { key: 'checkpoints.reason.running' } } } },
    { kind: 'note', tone: 'info', text: { key: 'checkpoints.error.untouched' } },
  ])
  assert.deepEqual(buttonsOf(view)[1], ['retry', 'checkpoints.button.retry', 'undo', false])
  const gone = run([{ type: 'undo' }, { type: 'failed', token: 1, step: 'undo', failure: { reason: 'no-checkpoint', message: '没有可撤销的恢复。' } }], readyState())
  const goneView = checkpointsDialogView(gone, CONTEXT)
  assert.deepEqual(goneView.body[0].text, { key: 'checkpoints.error.undo', params: { reason: { key: 'checkpoints.reason.noUndo' } } })
  // 没有撤销点了，重试也没用：只留一个关闭的按钮
  assert.deepEqual(buttonsOf(goneView), [['cancel', 'checkpoints.button.cancel', 'close', false]])
  // 恢复时的 no-checkpoint 照常是「这一轮没有检查点」
  const restoreGone = run([{ type: 'confirm' }, { type: 'failed', token: 1, step: 'restore', failure: { reason: 'no-checkpoint', message: '' } }], readyState())
  assert.deepEqual(checkpointsDialogView(restoreGone, CONTEXT).body[0].text.params.reason, { key: 'checkpoints.reason.noCheckpoint' })
})

// ---------- 数据层 ----------

/** 假 fetch：按路由前缀答，记下每次请求。 */
function fakeFetch(answers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), credentials: init.credentials })
    const route = url.replace('api/dsh-workbench.checkpoints.', '').split('?')[0]
    const answer = typeof answers[route] === 'function' ? answers[route](calls.at(-1)) : answers[route]
    if (answer instanceof Error) throw answer
    if (answer === undefined) return { status: 404, json: async () => { throw new SyntaxError('Unexpected token <') } }
    return { status: answer.status ?? (answer.body.ok ? 200 : 500), json: async () => answer.body }
  }
  return { fetchImpl, calls }
}

test('createCheckpointsApi：成功的回答照接口文档原样交回，路由和请求体一字不差', async () => {
  const { fetchImpl, calls } = fakeFetch({
    list: { body: listBody({ undo: { time: 2000, turn: 1 } }) },
    preview: { body: previewBody() },
    restore: { body: { ok: true, restored: 7, skipped: [] } },
    undo: { body: { ok: true, restored: 7, skipped: [{ path: 'build/', reason: 'changed-after' }] } },
    config: call => ({ body: { ok: true, config: call.method === 'POST' ? call.body : { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 2 } } }),
  })
  const api = createCheckpointsApi(fetchImpl)
  assert.deepEqual(await api.list('s 1'), listBody({ undo: { time: 2000, turn: 1 } }))
  assert.deepEqual(await api.preview('s1', 3), previewBody())
  assert.deepEqual(await api.restore('s1', 3), { ok: true, restored: 7, skipped: [] })
  assert.deepEqual(await api.undo('s1'), { ok: true, restored: 7, skipped: [{ path: 'build/', reason: 'changed-after' }] })
  assert.deepEqual(await api.config.read(), { ok: true, config: { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 2 } })
  assert.deepEqual(api.config.peek(), { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 2 })
  const written = await api.config.write({ keepDays: 7, maxStoreMB: 1024, skipPresets: [], waitSeconds: 5, maxFileMB: 4 })
  assert.deepEqual(written.config, { keepDays: 7, maxStoreMB: 1024, skipPresets: [], waitSeconds: 5, maxFileMB: 4 })
  assert.deepEqual(api.config.peek(), written.config)
  assert.deepEqual(calls.map(call => [call.method, call.url, call.body]), [
    ['GET', 'api/dsh-workbench.checkpoints.list?sessionId=s%201', undefined],
    ['POST', 'api/dsh-workbench.checkpoints.preview', { sessionId: 's1', turn: 3 }],
    ['POST', 'api/dsh-workbench.checkpoints.restore', { sessionId: 's1', turn: 3 }],
    ['POST', 'api/dsh-workbench.checkpoints.undo', { sessionId: 's1' }],
    ['GET', 'api/dsh-workbench.checkpoints.config', undefined],
    ['POST', 'api/dsh-workbench.checkpoints.config', { keepDays: 7, maxStoreMB: 1024, skipPresets: [], waitSeconds: 5, maxFileMB: 4 }],
  ])
  assert.ok(calls.every(call => call.credentials === 'same-origin'))
})

test('createCheckpointsApi：失败统一成 { ok: false, reason, message }——宿主的原因、断网、不是接口里的样子', async () => {
  const reasons = ['running', 'no-checkpoint', 'expired', 'not-eligible', 'git-unavailable', 'busy', 'bad-request', 'failed']
  for (const reason of reasons) {
    const { fetchImpl } = fakeFetch({ restore: { status: 409, body: { ok: false, reason, message: `宿主：${reason}` } } })
    assert.deepEqual(await createCheckpointsApi(fetchImpl).restore('s1', 3), { ok: false, reason, message: `宿主：${reason}` })
  }
  const offline = createCheckpointsApi(fakeFetch({ preview: new TypeError('Failed to fetch') }).fetchImpl)
  assert.deepEqual(await offline.preview('s1', 3), { ok: false, reason: 'disconnected', message: 'Failed to fetch' })
  // 根行关掉后路由不在（DSH 的 404 页，不是 JSON）
  const missing = createCheckpointsApi(fakeFetch({}).fetchImpl)
  assert.deepEqual(await missing.list('s1'), { ok: false, reason: 'failed', message: 'HTTP 404' })
  // ok: true 但字段不对、没写 message 的失败
  const odd = createCheckpointsApi(fakeFetch({
    preview: { status: 200, body: { ok: true, files: 'nope' } },
    undo: { status: 409, body: { ok: false, reason: 'busy' } },
  }).fetchImpl)
  assert.deepEqual(await odd.preview('s1', 3), { ok: false, reason: 'failed', message: 'HTTP 200' })
  assert.deepEqual(await odd.undo('s1'), { ok: false, reason: 'busy', message: 'HTTP 409' })
})

test('createCheckpointsApi：list 里写坏的记录跳过，别的照常', async () => {
  const body = listBody({ entries: [{ turn: 1, seq: 5, time: 1000, kind: 'git' }, { turn: 'x' }, null, { turn: 2, seq: 9, time: 1, kind: 'other' }] })
  const api = createCheckpointsApi(fakeFetch({ list: { body } }).fetchImpl)
  assert.deepEqual((await api.list('s1')).entries, [{ turn: 1, seq: 5, time: 1000, kind: 'git' }])
})

test('createCheckpointsApi：list 缓存 5 秒，同时发的只问一次；作废后重读', async () => {
  let clock = 0
  const { fetchImpl, calls } = fakeFetch({ list: { body: listBody() } })
  const api = createCheckpointsApi(fetchImpl, { now: () => clock })
  await Promise.all([api.list('s1'), api.list('s1')])
  assert.equal(calls.length, 1)
  clock = 4999
  await api.list('s1')
  assert.equal(calls.length, 1)
  clock = 5000
  await api.list('s1')
  assert.equal(calls.length, 2)
  api.invalidate('s1')
  await api.list('s1')
  assert.equal(calls.length, 3)
  await api.list('s2')
  assert.equal(calls.length, 4)
})

test('createCheckpointsApi：快照内容没变不换对象、不通知；读失败保留上一份并带 error', async () => {
  let fail = false
  const { fetchImpl } = fakeFetch({ list: () => (fail ? new TypeError('offline') : { body: listBody() }) })
  let clock = 0
  const api = createCheckpointsApi(fetchImpl, { now: () => clock })
  let notified = 0
  api.subscribe(() => { notified += 1 })
  assert.equal(api.peek('s1'), undefined)
  await api.list('s1')
  const first = api.peek('s1')
  assert.equal(first.value.eligible, true)
  assert.equal(notified, 1)
  clock = 6000
  await api.list('s1')
  assert.equal(api.peek('s1'), first)
  assert.equal(notified, 1)
  fail = true
  clock = 12000
  await api.list('s1')
  assert.deepEqual(api.peek('s1').error, { reason: 'disconnected', message: 'offline' })
  assert.equal(api.peek('s1').value, first.value)
  assert.equal(checkpointsEntryView(api.peek('s1'), { turn: 3, seq: 30, running: false }).ok, true)
})

test('createCheckpointsApi：作废前发出的 list 回答丢掉（可能早于恢复）；有入口挂着的会话作废后马上重读', async () => {
  const resolvers = []
  const fetchImpl = async () => new Promise(resolve => { resolvers.push(resolve) })
  const api = createCheckpointsApi(fetchImpl)
  const stale = api.list('s1')
  api.invalidate('s1')
  // 没人挂着：作废不发请求
  assert.equal(resolvers.length, 1)
  const stop = api.watch('s1')
  assert.equal(resolvers.length, 2)
  resolvers[1]({ status: 200, json: async () => listBody({ undo: { time: 9, turn: 3 } }) })
  await new Promise(resolve => setImmediate(resolve))
  resolvers[0]({ status: 200, json: async () => listBody() })
  await stale
  assert.deepEqual(api.peek('s1').value.undo, { time: 9, turn: 3 })
  stop()
  api.invalidate()
  assert.equal(resolvers.length, 2)
})

test('createCheckpointsApi：restore、undo 之后不论成败都作废那个会话；preview 答已失效时记下这一轮', async () => {
  let expired = true
  const { fetchImpl, calls } = fakeFetch({
    list: { body: listBody() },
    restore: { body: { ok: true, restored: 1, skipped: [] } },
    undo: { status: 409, body: { ok: false, reason: 'busy', message: 'x' } },
    preview: () => (expired ? { status: 410, body: { ok: false, reason: 'expired', message: '检查点已失效' } } : { body: previewBody() }),
  })
  const api = createCheckpointsApi(fetchImpl)
  await api.list('s1')
  await api.list('s1')
  assert.equal(calls.filter(call => call.url.includes('list')).length, 1)
  await api.restore('s1', 3)
  await api.list('s1')
  assert.equal(calls.filter(call => call.url.includes('list')).length, 2)
  // undo 失败也作废（多半是另一个窗口先撤销了，undo 那一行要跟着变）
  await api.undo('s1')
  await api.list('s1')
  assert.equal(calls.filter(call => call.url.includes('list')).length, 3)
  await api.preview('s1', 3)
  assert.deepEqual([...api.peek('s1').expired], [3])
  assert.deepEqual(checkpointsEntryView(api.peek('s1'), { turn: 3, seq: 30, running: false }), { ok: false, reason: 'expired' })
  expired = false
  await api.preview('s1', 3)
  assert.deepEqual([...api.peek('s1').expired], [])
})

test('checkpointsStoppedSessions 和 startCheckpointsRunWatcher：一轮结束（running 由真变假或会话消失）作废那个会话', () => {
  const prev = new Map([['a', { running: true }], ['b', { running: true }], ['c', { running: false }]])
  const next = new Map([['a', { running: false }], ['c', { running: true }]])
  assert.deepEqual(checkpointsStoppedSessions(prev, next), ['a', 'b'])
  assert.deepEqual(checkpointsStoppedSessions(null, next), [])
  let snapshot = new Map([['a', { running: true }]])
  let listener
  const stopped = []
  const stop = startCheckpointsRunWatcher({
    getSnapshot: () => snapshot,
    subscribe: fn => { listener = fn; return () => { listener = undefined } },
    onStopped: id => { stopped.push(id) },
  })
  snapshot = new Map([['a', { running: true }], ['b', { running: true }]])
  listener()
  snapshot = new Map([['a', { running: false }], ['b', { running: true }]])
  listener()
  assert.deepEqual(stopped, ['a'])
  stop()
  assert.equal(listener, undefined)
})

// ---------- 恢复、撤销和分叉 ----------

/** 子会话：inbox 投影里排着继承来的原提问，updateQueue 记下删了哪条。 */
function childSession({ removeOk = true } = {}) {
  const removed = []
  const session = {
    projections: {
      faceOf: () => ({
        getSnapshot: () => ({ 'next-turn': [{ id: 'q-user', source: { kind: 'user' } }, { id: 'q-system', source: { kind: 'system' } }] }),
        subscribe: () => () => {},
      }),
    },
    updateQueue: async (id, action) => {
      removed.push([id, action])
      return removeOk ? { ok: true } : { ok: false, error: { message: 'queue locked' } }
    },
    prompt: async () => { throw new Error('不该重发') },
  }
  return { session, removed }
}

/** checkpointsForkSession 的假依赖。 */
function forkDeps({ forkError, removeOk = true, notifyError } = {}) {
  const calls = { fork: [], open: [], notices: [], warns: [], using: [] }
  const { session, removed } = childSession({ removeOk })
  const deps = {
    fork: async request => {
      calls.fork.push(request)
      if (forkError !== undefined) throw forkError
      return 'child-1'
    },
    using: async (id, options, operation) => {
      calls.using.push([id, options])
      return operation({ ready: Promise.resolve(), binding: { session, ctx: { id: 'actx' } } })
    },
    openSession: id => { calls.open.push(id) },
    inputFor: actx => ({
      notify: (level, text) => {
        if (notifyError !== undefined) throw notifyError
        calls.notices.push([actx.id, level, text])
      },
    }),
    t: (key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}`,
    warn: message => { calls.warns.push(message) },
    inboxWaitMs: 10,
  }
  return { deps, calls, removed }
}

test('checkpointsForkSession：从这一轮之前分叉、切过去、删掉继承来的原提问，不重发，提示写在新会话的输入框上方', async () => {
  const { deps, calls, removed } = forkDeps()
  const result = await checkpointsForkSession(deps, { sessionId: 's1', atSeq: 29, turn: 3, restored: { restored: 7, skipped: [] } })
  assert.deepEqual(result, { outcome: 'forked', childId: 'child-1' })
  assert.deepEqual(calls.fork, [{ sessionId: 's1', atSeq: 29, increaseTitle: true }])
  assert.deepEqual(calls.using, [['child-1', { source: 'workbenchCheckpoints' }]])
  assert.deepEqual(calls.open, ['child-1'])
  assert.deepEqual(removed, [['q-user', { kind: 'remove' }]])
  assert.deepEqual(calls.notices, [['actx', 'info', 'checkpoints.notice.restoredForked{"turn":"3","n":"7"}']])
})

test('checkpointsForkSession：继承来的消息删不掉时报错但不抛（会话已经打开）；分叉失败抛出；提示发不出去只记日志', async () => {
  const stuck = forkDeps({ removeOk: false })
  const result = await checkpointsForkSession(stuck.deps, { sessionId: 's1', atSeq: 29, turn: 3 })
  assert.deepEqual(result, { outcome: 'queue-failed', childId: 'child-1' })
  assert.deepEqual(stuck.calls.notices, [['actx', 'error', 'checkpoints.notice.queueFailed{"turn":"3","reason":"queue locked"}']])
  const denied = forkDeps({ forkError: new Error('session/fork denied') })
  await assert.rejects(checkpointsForkSession(denied.deps, { sessionId: 's1', atSeq: 29, turn: 3 }), /session\/fork denied/)
  assert.deepEqual(denied.calls.open, [])
  const quiet = forkDeps({ notifyError: new Error('conversation 服务不在') })
  assert.deepEqual(await checkpointsForkSession(quiet.deps, { sessionId: 's1', atSeq: 29, turn: 3 }), { outcome: 'forked', childId: 'child-1' })
  assert.match(quiet.calls.warns[0], /显示分叉提示失败：conversation 服务不在/)
})

/** runCheckpointsTask 的假依赖：数据层只答 restore、undo。 */
function taskDeps({ restore = { ok: true, restored: 7, skipped: [] }, undo = { ok: true, restored: 7, skipped: [] }, forkError } = {}) {
  const log = []
  const { deps: fork, calls } = forkDeps({ forkError })
  const api = {
    restore: async (sessionId, turn) => { log.push(['restore', sessionId, turn]); return restore },
    undo: async sessionId => { log.push(['undo', sessionId]); return undo },
  }
  return { deps: { api, fork }, log, calls }
}

const TASK = { token: 4, sessionId: 's1', turn: 3, atSeq: 29 }

test('runCheckpointsTask：两样都做——先恢复，成功后再分叉', async () => {
  const { deps, log, calls } = taskDeps()
  const events = []
  await runCheckpointsTask('both', TASK, deps, event => { events.push(event) })
  assert.deepEqual(log, [['restore', 's1', 3]])
  assert.deepEqual(calls.fork, [{ sessionId: 's1', atSeq: 29, increaseTitle: true }])
  assert.deepEqual(events, [
    { type: 'succeeded', token: 4, step: 'restore', result: { restored: 7, skipped: [] } },
    { type: 'succeeded', token: 4, step: 'fork' },
  ])
})

test('runCheckpointsTask：恢复失败不分叉', async () => {
  const { deps, calls } = taskDeps({ restore: { ok: false, reason: 'busy', message: 'x' } })
  const events = []
  await runCheckpointsTask('both', TASK, deps, event => { events.push(event) })
  assert.deepEqual(calls.fork, [])
  assert.deepEqual(events, [{ type: 'failed', token: 4, step: 'restore', failure: { ok: false, reason: 'busy', message: 'x' } }])
})

test('runCheckpointsTask：只恢复文件、只分叉、分叉失败、已经恢复过时只分叉、撤销', async () => {
  const files = taskDeps()
  const fileEvents = []
  await runCheckpointsTask('restore', TASK, files.deps, event => { fileEvents.push(event) })
  assert.deepEqual(files.calls.fork, [])
  assert.deepEqual(fileEvents, [{ type: 'succeeded', token: 4, step: 'restore', result: { restored: 7, skipped: [] } }])

  const fork = taskDeps()
  const forkEvents = []
  await runCheckpointsTask('fork', TASK, fork.deps, event => { forkEvents.push(event) })
  assert.deepEqual(fork.log, [])
  assert.deepEqual(forkEvents, [{ type: 'succeeded', token: 4, step: 'fork' }])
  assert.match(fork.calls.notices[0][2], /checkpoints\.notice\.forked/)

  const broken = taskDeps({ forkError: new Error('session/fork denied') })
  const brokenEvents = []
  await runCheckpointsTask('fork', TASK, broken.deps, event => { brokenEvents.push(event) })
  assert.deepEqual(brokenEvents, [{ type: 'failed', token: 4, step: 'fork', failure: { reason: 'failed', message: 'session/fork denied' } }])

  const retried = taskDeps()
  const retriedEvents = []
  await runCheckpointsTask('both', { ...TASK, restored: { restored: 5, skipped: [{ path: 'a' }] } }, retried.deps, event => { retriedEvents.push(event) })
  assert.deepEqual(retried.log, [])
  assert.deepEqual(retriedEvents, [{ type: 'succeeded', token: 4, step: 'fork' }])
  assert.match(retried.calls.notices[0][2], /partialForked/)

  const undo = taskDeps()
  const undoEvents = []
  await runCheckpointsTask('undo', TASK, undo.deps, event => { undoEvents.push(event) })
  assert.deepEqual(undoEvents, [{ type: 'undone', token: 4, result: { ok: true, restored: 7, skipped: [] } }])
  const undoFail = taskDeps({ undo: { ok: false, reason: 'no-checkpoint', message: '没有' } })
  const undoFailEvents = []
  await runCheckpointsTask('undo', TASK, undoFail.deps, event => { undoFailEvents.push(event) })
  assert.deepEqual(undoFailEvents, [{ type: 'failed', token: 4, step: 'undo', failure: { ok: false, reason: 'no-checkpoint', message: '没有' } }])
})

test('事件序列走一遍状态机：两样都做的成功和失败，结果和弹窗对得上', async () => {
  for (const [restore, expected] of [
    [{ ok: true, restored: 7, skipped: [] }, 'closed'],
    [{ ok: false, reason: 'running', message: '' }, 'error'],
  ]) {
    const { deps } = taskDeps({ restore })
    let state = reduceDialog(readyState(), { type: 'confirm' })
    await runCheckpointsTask(checkpointsConfirmTask(readyState()), { ...TASK, token: 1 }, deps, event => { state = reduceDialog(state, event) })
    assert.equal(state.phase, expected)
  }
})

// W-O02：撤销有没能写回的项时宿主答 500 failed，带 restored、skipped，撤销点留着（TW-001）。
const UNDO_LEFT = {
  ok: false, reason: 'failed', restored: 2, message: '撤销未完成，撤销点已保留，可在排除失败原因后重试。',
  skipped: [{ path: 'src/locked/config.json', reason: 'changed-after' }],
}

test('W-O02 撤销做了一部分：弹窗写已经撤销了几个，列出没有撤销的项，原因照撤销的说法写，可以重试', async () => {
  // 宿主会给的每一种跳过原因，加一个不认识的。
  const left = [
    { path: 'src/locked/config.json', reason: 'changed-after' },
    { path: 'assets/big.bin', reason: 'oversized' },
    { path: 'lib/link/a.js', reason: 'unsafe-path' },
    { path: 'packages/legacy', reason: 'submodule' },
    { path: 'build/', reason: 'ignored-inside' },
    { path: 'odd.txt', reason: 'something-new' },
  ]
  const api = createCheckpointsApi(fakeFetch({ undo: { status: 500, body: { ...UNDO_LEFT, skipped: [...left, { path: 7 }] } } }).fetchImpl)
  let state = reduceDialog(readyState(), { type: 'undo' })
  await runCheckpointsTask('undo', { ...TASK, token: 1 }, { api, fork: forkDeps().deps }, event => { state = reduceDialog(state, event) })
  const view = checkpointsDialogView(state, CONTEXT)
  assert.deepEqual(view.body, [
    { kind: 'result', tone: 'error', text: { key: 'checkpoints.error.undoPartial', params: { n: '2', skipped: '6' } } },
    {
      kind: 'skipped', title: { key: 'checkpoints.result.notUndoneTitle' }, rows: [
        { path: 'src/locked/config.json', tag: { key: 'checkpoints.undoTag.changedAfter' } },
        { path: 'assets/big.bin', tag: { key: 'checkpoints.undoTag.oversized', params: { mb: '2' } } },
        { path: 'lib/link/a.js', tag: { key: 'checkpoints.undoTag.unsafePath' } },
        { path: 'packages/legacy', tag: { key: 'checkpoints.undoTag.submodule' } },
        { path: 'build/', tag: { key: 'checkpoints.tag.ignoredInside' } },
        { path: 'odd.txt', tag: { key: 'checkpoints.undoTag.skip' } },
      ],
    },
  ])
  assert.deepEqual(buttonsOf(view), [['cancel', 'checkpoints.button.cancel', 'close', false], ['retry', 'checkpoints.button.retry', 'undo', false]])
  // 读不到单个文件的上限时，撤销的那一行同样不写数字。
  assert.deepEqual(fileRowView({ path: 'assets/big.bin', action: 'skip', reason: 'oversized' }, { undo: true }), { path: 'assets/big.bin', tag: { key: 'checkpoints.undoTag.oversizedNoLimit' } })
  // 刚恢复完就在同一个弹窗里撤销：恢复结果的列表照旧写恢复的说法，撤销的列表写撤销的说法。
  const restored = { restored: 5, skipped: [{ path: 'assets/big.bin', reason: 'oversized' }, { path: 'lib/link/a.js', reason: 'unsafe-path' }] }
  let both = run([{ type: 'confirm' }, { type: 'succeeded', token: 1, step: 'restore', result: restored }, { type: 'undo' }], reduceDialog(readyState(), { type: 'choose', choice: 'files' }))
  await runCheckpointsTask('undo', { ...TASK, token: 1 }, { api, fork: forkDeps().deps }, event => { both = reduceDialog(both, event) })
  const lists = checkpointsDialogView(both, CONTEXT).body.filter(block => block.kind === 'skipped')
  assert.deepEqual(lists.map(list => [list.title.key, list.rows.slice(0, 2).map(row => row.tag.key)]), [
    ['checkpoints.result.skippedTitle', ['checkpoints.tag.oversized', 'checkpoints.tag.unsafePath']],
    ['checkpoints.result.notUndoneTitle', ['checkpoints.undoTag.changedAfter', 'checkpoints.undoTag.oversized']],
  ])
})

test('W-O02 撤销一个文件都没动时开头写「没有撤销」；刚恢复完就撤销时先写恢复的结果', () => {
  const blocked = run([{ type: 'undo' }, { type: 'failed', token: 1, step: 'undo', failure: { ...UNDO_LEFT, restored: 0 } }], readyState())
  assert.deepEqual(checkpointsDialogView(blocked, CONTEXT).body[0].text, { key: 'checkpoints.error.undoBlocked', params: { skipped: '1' } })
  const files = reduceDialog(readyState(), { type: 'choose', choice: 'files' })
  const afterRestore = run([
    { type: 'confirm' }, { type: 'succeeded', token: 1, step: 'restore', result: RESTORED },
    { type: 'undo' }, { type: 'failed', token: 1, step: 'undo', failure: UNDO_LEFT },
  ], files)
  const view = checkpointsDialogView(afterRestore, CONTEXT)
  assert.deepEqual(view.body.map(block => block.text?.key ?? block.title.key), ['checkpoints.result.restored', 'checkpoints.error.undoPartial', 'checkpoints.result.notUndoneTitle'])
  assert.deepEqual(buttonsOf(view), [['cancel', 'checkpoints.button.done', 'close', false], ['retry', 'checkpoints.button.retry', 'undo', false]])
})

// ---------- 配置页 ----------

test('配置页的草稿：数字要是正整数，别的字段照读到的带回去；勾选预设', () => {
  // 接口文档 config 一节的整份配置（五个数字字段加 skipPresets）
  const loaded = { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale', 'whale-dream'], waitSeconds: 5, maxFileMB: 2 }
  const draft = checkpointsConfigDraft(loaded)
  assert.deepEqual(draft, { keepDays: '14', maxStoreMB: '2048', maxFileMB: '2', skipPresets: ['whale', 'whale-dream'] })
  assert.deepEqual(checkpointsConfigFromDraft(loaded, draft), { config: loaded, invalid: [] })
  assert.deepEqual(checkpointsConfigFromDraft(loaded, { ...draft, keepDays: ' 30 ' }).config.keepDays, 30)
  assert.deepEqual(checkpointsConfigFromDraft(loaded, { ...draft, maxFileMB: '8' }).config,
    { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale', 'whale-dream'], waitSeconds: 5, maxFileMB: 8 })
  for (const bad of ['0', '-3', '1.5', '', 'abc', '1e3']) {
    assert.deepEqual(checkpointsConfigFromDraft(loaded, { ...draft, maxStoreMB: bad }).invalid, ['maxStoreMB'], bad)
  }
  assert.deepEqual(checkpointsConfigFromDraft(loaded, { ...draft, keepDays: '0', maxFileMB: 'x' }).invalid, ['keepDays', 'maxFileMB'])
  assert.deepEqual(checkpointsTogglePreset(['whale'], 'whale'), [])
  assert.deepEqual(checkpointsTogglePreset(['whale'], 'coder'), ['whale', 'coder'])
  assert.deepEqual(checkpointsConfigDraft({}), { keepDays: '', maxStoreMB: '', maxFileMB: '', skipPresets: [] })
})

test('配置页的草稿：读到的配置里缺 maxFileMB 时输入框是空的，填之前不能保存（宿主缺字段答 400）', () => {
  const loaded = { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5 }
  const draft = checkpointsConfigDraft(loaded)
  assert.equal(draft.maxFileMB, '')
  assert.deepEqual(checkpointsConfigFromDraft(loaded, draft).invalid, ['maxFileMB'])
  assert.deepEqual(checkpointsConfigFromDraft(loaded, { ...draft, maxFileMB: '3' }),
    { config: { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 3 }, invalid: [] })
})

test('配置页保存：读到整份配置、改「每个文件最多保存」，POST 的是带上 maxFileMB 的整份配置', async () => {
  const stored = { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale', 'whale-dream'], waitSeconds: 5, maxFileMB: 2 }
  const { fetchImpl, calls } = fakeFetch({ config: call => ({ body: { ok: true, config: call.method === 'POST' ? call.body : stored } }) })
  const api = createCheckpointsApi(fetchImpl)
  const read = await api.config.read()
  const draft = { ...checkpointsConfigDraft(read.config), maxFileMB: '8', skipPresets: checkpointsTogglePreset(['whale', 'whale-dream'], 'whale-dream') }
  const { config, invalid } = checkpointsConfigFromDraft(read.config, draft)
  assert.deepEqual(invalid, [])
  const written = await api.config.write(config)
  assert.deepEqual(calls.at(-1).body, { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 8 })
  assert.deepEqual(written, { ok: true, config: { keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale'], waitSeconds: 5, maxFileMB: 8 } })
  // 宿主拒绝时（比如数字不是正整数）回答原样交回，配置页把 message 写在保存按钮旁边
  const refuse = createCheckpointsApi(fakeFetch({ config: { status: 400, body: { ok: false, reason: 'bad-request', message: 'checkpoints config maxFileMB must be a positive integer' } } }).fetchImpl)
  assert.deepEqual(await refuse.config.write({ ...config, maxFileMB: 0 }),
    { ok: false, reason: 'bad-request', message: 'checkpoints config maxFileMB must be a positive integer' })
  assert.deepEqual(checkpointsReasonText({ reason: 'bad-request', message: 'checkpoints config maxFileMB must be a positive integer' }),
    { text: 'checkpoints config maxFileMB must be a positive integer' })
})

// ---------- 挂载和撤销 ----------

test('applyCheckpoints：注册图标排条目、轮次末尾条目和行配置，听连接重置和一轮结束；撤销函数全撤', () => {
  const registered = []
  const disposed = []
  const listeners = { reset: 0, status: 0 }
  const ctx = {
    slots: {
      inject: (name, factory) => {
        const inner = factory()
        return () => { inner(); disposed.push(name) }
      },
      register: options => {
        registered.push(options)
        return () => { registered.splice(registered.indexOf(options), 1) }
      },
    },
    effect: (fn) => fn(),
    on: (name) => {
      assert.equal(name, 'connection/reset')
      listeners.reset += 1
      return () => { listeners.reset -= 1 }
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => new Map(),
        subscribe: () => { listeners.status += 1; return () => { listeners.status -= 1 } },
      },
    },
  }
  const dispose = applyCheckpoints({ ctx, t: key => key }, { fetch: async () => { throw new Error('不该在挂载时请求') } })
  const actions = registered.find(options => options.name === 'conversation.chat.assistant-actions')
  assert.deepEqual({ id: actions.id, order: actions.order }, { id: 'dsh-workbench-checkpoints', order: 30 })
  const tail = registered.find(options => options.name === 'conversation.chat.turnTail')
  assert.deepEqual({ id: tail.id, order: tail.order }, { id: 'dsh-workbench-checkpoints', order: 90 })
  const config = registered.find(options => options.name === 'plugins.row.config')
  assert.equal(config.key, '@miint-sunny/dsh-workbench#dsh-workbench-checkpoints')
  assert.equal(registered.length, 3)
  assert.deepEqual(listeners, { reset: 1, status: 1 })
  dispose()
  assert.equal(registered.length, 0)
  assert.deepEqual(disposed.sort(), ['conversation.chat.assistant-actions', 'conversation.chat.turnTail', 'plugins.row.config'])
  assert.deepEqual(listeners, { reset: 0, status: 0 })
})

test('图标排排在「重新生成」「编辑消息」后面：rerun 的条目 order 比本功能小', async () => {
  const { readFileSync } = await import('node:fs')
  const rerun = readFileSync(new URL('../src/client/rerun.js', import.meta.url), 'utf8')
  const order = Number(/id: 'dsh-workbench-rerun', order: (\d+)/.exec(rerun)?.[1])
  assert.ok(order < 30, `rerun 的 order 是 ${order}`)
})

test('C-007 noteLines：Windows 的会话目录和仓库根只差大小写时，照样写出子目录', () => {
  assert.deepEqual(noteLines(previewBody({ root: 'C:/Work/Repo' }), { cwd: 'c:\\work\\repo\\packages\\app' }),
    [{ key: 'checkpoints.note.scope', params: { repo: 'Repo', dir: 'packages/app' }, tone: 'info' }])
  assert.deepEqual(noteLines(previewBody({ root: 'C:\\' }), { cwd: 'C:\\Projects' }),
    [{ key: 'checkpoints.note.scope', params: { repo: 'C:', dir: 'Projects' }, tone: 'info' }])
  assert.deepEqual(noteLines(previewBody({ root: '/Users/me/Repo' }), { cwd: '/Users/me/repo/sub' }),
    [{ key: 'checkpoints.note.scopeRepo', params: { repo: 'Repo' }, tone: 'info' }])
})

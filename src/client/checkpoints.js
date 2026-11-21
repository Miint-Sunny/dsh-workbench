/**
 * 回到某条消息之前（dsh-workbench/checkpoints 的网页部分，计划第 10 项，第四批样稿 A–I）。
 * 宿主端（lib/checkpoints*.js）在每个顶层轮次开始前存工作区检查点；这里只走接口文档
 * docs/plans/2026-11-06-检查点接口.md 里的路由（/api/dsh-workbench.checkpoints.*）。
 *
 * 两个入口共用一个弹窗：回答下方的图标排（conversation.chat.assistant-actions，order 30，
 * 排在「重新生成」「编辑消息」的 20 后面）多一个时钟图标；没有最终回答的已结束轮次
 * （被停止、出错）图标排不出现，在轮次末尾（conversation.chat.turnTail）补一个小按钮。
 * DSH 只在轮次有最终回答而且带 messageId 时渲染图标排（ui-chat 的 TurnTailNodeView），
 * 小按钮按这个条件的补集出现，所以每个已结束的轮次正好有一个入口。
 *
 * 弹窗三选一：只恢复文件、只分叉会话、恢复文件并分叉会话（默认）。分叉点和「重新生成」
 * 一样取 turn.start.seq - 1，分叉后用 rerun.js 的 clearInheritedQueue 清掉继承来的排队
 * 消息，不重发，输入框留空。两样都做时先恢复，恢复成功才分叉。弹窗的状态机是纯函数
 * reduceDialog，要显示什么由纯函数 checkpointsDialogView 算，组件只按结果渲染。
 *
 * 每个功能行一个模块，由 scripts/build-client.mjs 按顺序拼进 lib/client.js：模块之间共用
 * 同一个作用域，所以本模块的顶层名字都带 Checkpoints/CHECKPOINTS 标记（test/client-bundle.test.mjs
 * 查这一条）。拼接时下面的 import 行被去掉，用的是同一个作用域里 rerun.js 的同名导出。
 * 图标和用语的规矩见 ~/code/dsh-plugins/dsh-ui-guard/README.md。
 */
import { clearInheritedQueue, INBOX_WAIT_MS, rerunDepsOf } from './rerun.js'
import { workbenchPathBelow } from './features.js'
import { mountModuleStyle } from './style.js'
import { settingsFormLabels } from './copy.js'

/** 本功能要的 DSH 服务（并进 main.js 的 INJECT，去重；0.2.2-rc.1 的 app.asar 里核实过）。 */
const CHECKPOINTS_INJECT = ['sessions', 'uiWorkspace', 'uiSession', 'remote.agentPresets']

/** 本功能的中文界面文字；键以 `checkpoints.` 开头，原话照第四批样稿。 */
const CHECKPOINTS_ZH = {
  'checkpoints.action': '回到这一轮开始前',
  'checkpoints.reason.running': '会话进行中，结束后才能回到这一轮开始前',
  'checkpoints.reason.noCheckpoint': '此轮没有检查点',
  'checkpoints.reason.expired': '此轮的检查点已失效：仓库中的对应内容已被清理',
  'checkpoints.reason.full': '当前会话的检查点已达上限，不再保存新的轮次',
  'checkpoints.reason.gitUnavailable': '未找到 git，此目录无法使用检查点',
  'checkpoints.reason.busy': '正在处理另一个检查点，请稍后重试',
  'checkpoints.reason.undoStale': '恢复后工作区已有改动，无法撤销',
  'checkpoints.reason.disconnected': '和 DSH 的连接已断开',
  'checkpoints.reason.loading': '正在读取检查点…',
  'checkpoints.reason.noUndo': '没有可撤销的恢复',
  'checkpoints.reason.unavailable': '检查点暂不可用：{message}',
  'checkpoints.subtitle': '第 {turn} 轮 · {question}',
  'checkpoints.subtitleTurn': '第 {turn} 轮',
  'checkpoints.option.files': '只恢复文件',
  'checkpoints.option.filesHint': '将工作区文件恢复到此轮开始前的状态；对话不变。',
  'checkpoints.option.fork': '只分叉会话',
  'checkpoints.option.forkHint': '从此消息之前分叉出新会话；文件不变。',
  'checkpoints.option.both': '恢复文件并分叉会话',
  'checkpoints.option.bothHint': '恢复文件，并在新会话中从此轮之前继续。',
  'checkpoints.option.noFork': '当前会话不支持分叉',
  'checkpoints.button.files': '恢复文件',
  'checkpoints.button.fork': '分叉会话',
  'checkpoints.button.both': '恢复文件并分叉会话',
  'checkpoints.button.cancel': '取消',
  'checkpoints.button.retry': '重试',
  'checkpoints.button.undo': '撤销',
  'checkpoints.button.done': '完成',
  'checkpoints.close': '关闭',
  'checkpoints.working.restore': '正在恢复文件…',
  'checkpoints.working.fork': '正在分叉…',
  'checkpoints.working.undo': '正在撤销…',
  'checkpoints.loading': '正在计算将变更的文件…',
  'checkpoints.files.title': '将变更 {n} 个文件',
  'checkpoints.files.more': '另有 {n} 个文件',
  'checkpoints.files.none': '工作区文件与此轮开始前一致，恢复不会改动文件。',
  'checkpoints.tag.delete': '删除',
  'checkpoints.tag.binary': '二进制',
  'checkpoints.tag.submodule': '子模块，不恢复',
  'checkpoints.tag.ignoredInside': '目录里有被忽略的文件',
  'checkpoints.tag.oversized': '无法恢复：文件超过 {mb} MB',
  'checkpoints.tag.oversizedNoLimit': '无法恢复：文件超过大小上限',
  'checkpoints.tag.unsafePath': '无法恢复：目录符号链接指向工作区外',
  'checkpoints.tag.changedAfter': '恢复后仍与检查点不一致',
  'checkpoints.tag.skip': '不恢复',
  'checkpoints.undoTag.submodule': '子模块，不撤销',
  'checkpoints.undoTag.oversized': '无法撤销：文件超过 {mb} MB',
  'checkpoints.undoTag.oversizedNoLimit': '无法撤销：文件超过大小上限',
  'checkpoints.undoTag.unsafePath': '无法撤销：目录符号链接指向工作区外',
  'checkpoints.undoTag.changedAfter': '撤销后仍与恢复前不一致',
  'checkpoints.undoTag.skip': '不撤销',
  'checkpoints.note.scope': '范围为整个仓库 {repo}（当前会话目录位于 {dir}）。被 .gitignore 忽略的文件不受影响。',
  'checkpoints.note.scopeRepo': '范围为整个仓库 {repo}。被 .gitignore 忽略的文件不受影响。',
  'checkpoints.note.ignored': '被 .gitignore 忽略的文件不受影响。',
  'checkpoints.note.nongit': '此目录不在 git 仓库中：仅能恢复文件工具（写入、编辑、应用补丁、删除）修改的文件，不记录命令行所做的修改。',
  'checkpoints.note.gitignoreChanged': '检查点创建后仓库的 .gitignore 已修改，原先被忽略的文件将保留。',
  'checkpoints.note.lfsOrFilters': '仓库使用了改写文件内容的过滤器（如 Git LFS），恢复后的内容可能与检查点时不完全一致。',
  'checkpoints.footer': '恢复前将当前状态保存为检查点',
  'checkpoints.undoLine.today': '已于 {time} 恢复文件，',
  'checkpoints.undoLine.yesterday': '已于昨天 {time} 恢复文件，',
  'checkpoints.undoLine.date': '已于 {month} 月 {day} 日 {time} 恢复文件，',
  'checkpoints.result.restored': '已恢复 {n} 个文件。',
  'checkpoints.result.partial': '已恢复 {n} 个文件，{skipped} 项没有恢复。',
  'checkpoints.result.undoHint': '恢复前的状态已保存为检查点，可撤销。',
  'checkpoints.result.skippedTitle': '没有恢复的',
  'checkpoints.result.undone': '已撤销。',
  'checkpoints.result.notUndoneTitle': '没有撤销的',
  'checkpoints.error.restore': '未恢复：{reason}。',
  'checkpoints.error.undo': '未撤销：{reason}。',
  'checkpoints.error.undoPartial': '撤销未完成：已撤销 {n} 个文件，{skipped} 项未撤销。请排除下方列出的原因后重试。',
  'checkpoints.error.undoBlocked': '未撤销：{skipped} 项无法撤销。请排除下方列出的原因后重试。',
  'checkpoints.error.fork': '分叉失败：{reason}。',
  'checkpoints.error.untouched': '文件没有改动。',
  'checkpoints.notice.forked': '已从第 {turn} 轮之前分叉，原会话保留。',
  'checkpoints.notice.restoredForked': '已恢复 {n} 个文件，并从第 {turn} 轮之前分叉，原会话保留。',
  'checkpoints.notice.partialForked': '已恢复 {n} 个文件（{skipped} 项没有恢复），并从第 {turn} 轮之前分叉，原会话保留。',
  'checkpoints.notice.queueFailed': '已从第 {turn} 轮之前分叉，但该轮的消息仍在排队消息中（{reason}）；发送新消息前请先删除。',
  'checkpoints.page.summary': '配置检查点的保留时长、存储上限和排除的会话。',
  'checkpoints.page.keepDays': '保留天数',
  'checkpoints.page.keepDaysHint': '超过保留天数的检查点会被清理；已归档会话在归档满此天数后清理。',
  'checkpoints.page.maxStoreMB': '每个会话最多占用（MB）',
  'checkpoints.page.maxStoreMBHint': '达到上限后，新的轮次不再保存检查点。',
  'checkpoints.page.maxFileMB': '每个文件最多保存（MB）',
  'checkpoints.page.maxFileMBHint': '仅用于不在 git 仓库中的目录：超出的文件不保存内容，恢复时跳过。',
  'checkpoints.page.presets': '不保存这些预设的会话',
  'checkpoints.page.positiveInteger': '请输入大于 0 的整数',
  'checkpoints.form.unavailable': '检查点设置暂不可用',
}

/** 本功能的英文界面文字，键和 CHECKPOINTS_ZH 一一对应。 */
const CHECKPOINTS_EN = {
  'checkpoints.action': 'Back to before this turn',
  'checkpoints.reason.running': 'The session is running. You can go back to before this turn after it finishes',
  'checkpoints.reason.noCheckpoint': 'This turn has no checkpoint',
  'checkpoints.reason.expired': "This turn's checkpoint has expired: its contents were removed from the repository",
  'checkpoints.reason.full': "This session's checkpoints have reached the limit; new turns are not saved",
  'checkpoints.reason.gitUnavailable': 'Git not found; checkpoints are unavailable for this directory',
  'checkpoints.reason.busy': 'Another checkpoint is being processed. Try again later',
  'checkpoints.reason.undoStale': 'The workspace changed after the restore; it cannot be undone',
  'checkpoints.reason.disconnected': 'The connection to DSH is down',
  'checkpoints.reason.loading': 'Reading checkpoints…',
  'checkpoints.reason.noUndo': 'There is no restore to undo',
  'checkpoints.reason.unavailable': 'Checkpoints are unavailable: {message}',
  'checkpoints.subtitle': 'Turn {turn} · {question}',
  'checkpoints.subtitleTurn': 'Turn {turn}',
  'checkpoints.option.files': 'Restore files only',
  'checkpoints.option.filesHint': 'Restores workspace files to their state before this turn; the conversation is unchanged.',
  'checkpoints.option.fork': 'Fork session only',
  'checkpoints.option.forkHint': 'Forks a new session from before this message; files are unchanged.',
  'checkpoints.option.both': 'Restore files and fork session',
  'checkpoints.option.bothHint': 'Restores files and continues from before this turn in a new session.',
  'checkpoints.option.noFork': 'This session does not support forking',
  'checkpoints.button.files': 'Restore files',
  'checkpoints.button.fork': 'Fork session',
  'checkpoints.button.both': 'Restore files and fork session',
  'checkpoints.button.cancel': 'Cancel',
  'checkpoints.button.retry': 'Retry',
  'checkpoints.button.undo': 'Undo',
  'checkpoints.button.done': 'Done',
  'checkpoints.close': 'Close',
  'checkpoints.working.restore': 'Restoring files…',
  'checkpoints.working.fork': 'Forking…',
  'checkpoints.working.undo': 'Undoing…',
  'checkpoints.loading': 'Calculating files to change…',
  'checkpoints.files.title': '{n} files will change',
  'checkpoints.files.more': '{n} more files',
  'checkpoints.files.none': 'Workspace files match their state before this turn; restoring changes no files.',
  'checkpoints.tag.delete': 'Delete',
  'checkpoints.tag.binary': 'Binary',
  'checkpoints.tag.submodule': 'Submodule, not restored',
  'checkpoints.tag.ignoredInside': 'Directory contains ignored files',
  'checkpoints.tag.oversized': 'Cannot restore: file exceeds {mb} MB',
  'checkpoints.tag.oversizedNoLimit': 'Cannot restore: file exceeds the size limit',
  'checkpoints.tag.unsafePath': 'Cannot restore: a directory symlink points outside the workspace',
  'checkpoints.tag.changedAfter': 'Still differs from the checkpoint after restoring',
  'checkpoints.tag.skip': 'Not restored',
  'checkpoints.undoTag.submodule': 'Submodule, not undone',
  'checkpoints.undoTag.oversized': 'Cannot undo: file exceeds {mb} MB',
  'checkpoints.undoTag.oversizedNoLimit': 'Cannot undo: file exceeds the size limit',
  'checkpoints.undoTag.unsafePath': 'Cannot undo: a directory symlink points outside the workspace',
  'checkpoints.undoTag.changedAfter': 'Still differs from the pre-restore state after undoing',
  'checkpoints.undoTag.skip': 'Not undone',
  'checkpoints.note.scope': "Scope: the whole repository {repo} (this session's directory is in {dir}). Files ignored by .gitignore are not affected.",
  'checkpoints.note.scopeRepo': 'Scope: the whole repository {repo}. Files ignored by .gitignore are not affected.',
  'checkpoints.note.ignored': 'Files ignored by .gitignore are not affected.',
  'checkpoints.note.nongit': 'This directory is not in a git repository: only files changed by the file tools (write, edit, apply patch, delete) can be restored; command-line changes are not recorded.',
  'checkpoints.note.gitignoreChanged': "The repository's .gitignore changed after the checkpoint; previously ignored files are kept.",
  'checkpoints.note.lfsOrFilters': 'The repository uses filters that rewrite file contents (such as Git LFS); restored contents may not exactly match the checkpoint.',
  'checkpoints.footer': 'The current state is saved as a checkpoint before restoring',
  'checkpoints.undoLine.today': 'Files restored at {time}. ',
  'checkpoints.undoLine.yesterday': 'Files restored yesterday at {time}. ',
  'checkpoints.undoLine.date': 'Files restored on {month}/{day} at {time}. ',
  'checkpoints.result.restored': 'Restored {n} files.',
  'checkpoints.result.partial': 'Restored {n} files; {skipped} items were not restored.',
  'checkpoints.result.undoHint': 'The pre-restore state was saved as a checkpoint and can be undone.',
  'checkpoints.result.skippedTitle': 'Not restored',
  'checkpoints.result.undone': 'Undone.',
  'checkpoints.result.notUndoneTitle': 'Not undone',
  'checkpoints.error.restore': 'Not restored: {reason}.',
  'checkpoints.error.undo': 'Not undone: {reason}.',
  'checkpoints.error.undoPartial': 'Undo is incomplete: {n} files were undone; {skipped} items were not. Resolve the causes listed below and retry.',
  'checkpoints.error.undoBlocked': 'Not undone: {skipped} items could not be undone. Resolve the causes listed below and retry.',
  'checkpoints.error.fork': 'Fork failed: {reason}.',
  'checkpoints.error.untouched': 'No files were changed.',
  'checkpoints.notice.forked': 'Forked from before turn {turn}. The original session is kept.',
  'checkpoints.notice.restoredForked': 'Restored {n} files and forked from before turn {turn}. The original session is kept.',
  'checkpoints.notice.partialForked': 'Restored {n} files ({skipped} items not restored) and forked from before turn {turn}. The original session is kept.',
  'checkpoints.notice.queueFailed': "Forked from before turn {turn}, but that turn's message is still in the queued messages ({reason}). Remove it before sending a new message.",
  'checkpoints.page.summary': 'Configure checkpoint retention, storage limits and excluded sessions.',
  'checkpoints.page.keepDays': 'Days to keep',
  'checkpoints.page.keepDaysHint': 'Checkpoints older than this are cleared; archived sessions are cleared once archived this many days.',
  'checkpoints.page.maxStoreMB': 'Maximum storage per session (MB)',
  'checkpoints.page.maxStoreMBHint': 'Once the limit is reached, new turns no longer save checkpoints.',
  'checkpoints.page.maxFileMB': 'Maximum size per file (MB)',
  'checkpoints.page.maxFileMBHint': 'Only for directories outside git: larger files are not saved and are skipped when restoring.',
  'checkpoints.page.presets': 'Skip checkpoints for sessions on these agent presets',
  'checkpoints.page.positiveInteger': 'Enter a whole number greater than 0',
  'checkpoints.form.unavailable': 'Checkpoint settings are unavailable',
}

// ---------- 纯函数：找轮次 ----------

/**
 * 从 TurnLocation 取检查点要的坐标：轮次号和这一轮 turn/start 事件的序号。
 * @param {object | undefined} turn ChatSnapshot 里的 TurnLocation（ui-conversation 的 timeline.turns 的值）。
 * @returns {{turn: number, seq: number | undefined} | undefined} 坐标；轮次号不是整数时 undefined。
 */
function checkpointsTargetOf(turn) {
  if (!Number.isSafeInteger(turn?.turn)) return undefined
  const seq = turn.start?.seq
  return { turn: turn.turn, seq: Number.isSafeInteger(seq) ? seq : undefined }
}

/**
 * 一条助手消息属于哪一轮（照官方「分支」和 rerunTarget 的办法：turn-tail 的
 * closing.finalNode.messageId）。纯函数。
 * @param {object | null | undefined} snapshot useChat 的 ChatSnapshot。
 * @param {string} messageId 图标排条目收到的助手消息 id。
 * @returns {{turn: number, seq: number | undefined} | undefined} 这一轮的坐标；找不到时 undefined（不渲染图标）。
 */
export function checkpointsTurnOf(snapshot, messageId) {
  if (typeof messageId !== 'string' || messageId === '') return undefined
  const turns = snapshot?.timeline?.turns
  if (!(turns instanceof Map)) return undefined
  for (const turn of turns.values()) {
    if (turn?.data?.get?.('turn-tail')?.closing?.finalNode?.messageId === messageId) return checkpointsTargetOf(turn)
  }
  return undefined
}

/**
 * 轮次末尾的小按钮该不该出现：只对图标排不出现的已结束轮次（没有最终回答，或最终回答没有
 * messageId；DSH 的 TurnTailNodeView 在这两种情况下不渲染 assistant-actions）。纯函数。
 * @param {object | undefined} turn turnTail 条目收到的 TurnLocation。
 * @returns {{turn: number, seq: number | undefined} | undefined} 要出现时是这一轮的坐标，否则 undefined。
 */
export function checkpointsTailTarget(turn) {
  const tail = turn?.data?.get?.('turn-tail')
  if (tail === undefined || tail === null) return undefined
  const closing = tail.closing
  if (closing !== null && closing !== undefined && closing.finalNode?.messageId !== undefined) return undefined
  return checkpointsTargetOf(turn)
}

/**
 * 两个坐标是否相同（useChat 的比较函数，快照重发布时不触发重渲染）。
 * @param {{turn: number, seq?: number} | undefined} a 上一次的坐标。
 * @param {{turn: number, seq?: number} | undefined} b 这一次的坐标。
 * @returns {boolean} 相同是 true。
 */
function checkpointsSameTarget(a, b) {
  if (a === b) return true
  return a !== undefined && b !== undefined && a.turn === b.turn && a.seq === b.seq
}

/**
 * 这一轮的提问文字：轮次里第一个 kind 'user' 的聊天节点里的文字块（图片、文件这类块略过）。
 * @param {object | null | undefined} snapshot useChat 的 ChatSnapshot。
 * @param {number} turnNumber 轮次号。
 * @returns {string} 提问文字；找不到时空串。
 */
export function checkpointsQuestionOf(snapshot, turnNumber) {
  const keys = snapshot?.locations?.getTurn?.(turnNumber)
  if (!Array.isArray(keys)) return ''
  for (const key of keys) {
    const node = snapshot.nodes?.get?.(key)
    if (node?.kind !== 'user') continue
    const content = Array.isArray(node.data?.content) ? node.data.content : []
    return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ')
  }
  return ''
}

/** 弹窗副标题里提问最多显示的字数（样稿：「这一轮提问的前 30 个字」）。 */
const CHECKPOINTS_QUESTION_CHARS = 30

/**
 * 弹窗的副标题：「第 N 轮 · 这一轮提问的前 30 个字」，没有提问文字时只写轮次。纯函数。
 * @param {number} turn 轮次号。
 * @param {string} question 提问文字。
 * @returns {{key: string, params: Record<string, string>}} 词条和参数。
 */
export function checkpointsSubtitle(turn, question) {
  const text = String(question ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return { key: 'checkpoints.subtitleTurn', params: { turn: String(turn) } }
  const chars = Array.from(text)
  const short = chars.length > CHECKPOINTS_QUESTION_CHARS ? `${chars.slice(0, CHECKPOINTS_QUESTION_CHARS).join('')}…` : text
  return { key: 'checkpoints.subtitle', params: { turn: String(turn), question: short } }
}

// ---------- 纯函数：能不能回到这一轮 ----------

/** 最后一条检查点记录的轮次号（没有记录时 undefined）。 */
function checkpointsLastTurn(entries) {
  let last
  for (const entry of entries) if (Number.isSafeInteger(entry?.turn) && (last === undefined || entry.turn > last)) last = entry.turn
  return last
}

/**
 * 这一轮能不能回到开始前。输入是 list 的回答（eligible、full、entries、undo）加会话状态和
 * 这一轮的坐标。轮次本身的原因先于环境原因（样稿 H：先「没有检查点」后「会话进行中」）：
 * 等会话结束也救不了前者，提示要写救不了的那一个。full 只影响没有记录的新轮次（轮次号
 * 大于最后一条记录，或一条记录都没有），原因写成 'full'；expired 是弹窗里 preview 核对出
 * 已失效的轮次。undo 不影响入口（撤销那一行在弹窗里）。纯函数。
 * @param {{entries?: object[], eligible?: boolean, full?: boolean, undo?: object | null, running?: boolean, turn: number, seq?: number, expired?: ReadonlySet<number>}} input list 的回答、会话是否在运行、轮次号、turn/start 的序号（给了就要和记录对上）、已失效的轮次。
 * @returns {{ok: true, entry: object} | {ok: false, reason: 'no-checkpoint' | 'full' | 'expired' | 'running'}} 结果。
 */
export function checkpointAvailability({ entries, eligible, full, running, turn, seq, expired }) {
  if (eligible !== true) return { ok: false, reason: 'no-checkpoint' }
  const list = Array.isArray(entries) ? entries : []
  const entry = list.find(item => item?.turn === turn)
  const seqMismatch = entry !== undefined && Number.isSafeInteger(seq) && entry.seq !== seq
  if (entry === undefined || seqMismatch) {
    const last = checkpointsLastTurn(list)
    if (full === true && (last === undefined || turn > last)) return { ok: false, reason: 'full' }
    return { ok: false, reason: 'no-checkpoint' }
  }
  if (expired?.has?.(turn) === true) return { ok: false, reason: 'expired' }
  if (running === true) return { ok: false, reason: 'running' }
  return { ok: true, entry }
}

/**
 * 入口按钮的状态：数据层这个会话的快照加上这一轮的坐标。还没读到 list 时是 'loading'，
 * 读失败而且没有上一份时是失败原因（断线是 'disconnected'，别的是 'unavailable' 带宿主的话）；
 * 读到了交给 checkpointAvailability（之后再读失败也照旧用上一份）。纯函数。
 * @param {{value?: object, error?: {reason: string, message: string}, expired?: ReadonlySet<number>} | undefined} listState createCheckpointsApi 的 peek 结果。
 * @param {{turn: number, seq?: number, running: boolean}} target 这一轮的坐标和会话是否在运行。
 * @returns {{ok: true, entry: object} | {ok: false, reason: string, message?: string}} 结果。
 */
export function checkpointsEntryView(listState, { turn, seq, running }) {
  if (listState?.value === undefined) {
    if (listState?.error === undefined) return { ok: false, reason: 'loading' }
    const { reason, message } = listState.error
    return reason === 'disconnected' ? { ok: false, reason, message } : { ok: false, reason: 'unavailable', message }
  }
  return checkpointAvailability({ ...listState.value, running, turn, seq, expired: listState.expired })
}

/** 原因 → 词条键（接口文档的 reason 表；not-eligible 和 no-checkpoint 同一句）。 */
const CHECKPOINTS_REASON_KEYS = {
  running: 'checkpoints.reason.running',
  'no-checkpoint': 'checkpoints.reason.noCheckpoint',
  'not-eligible': 'checkpoints.reason.noCheckpoint',
  expired: 'checkpoints.reason.expired',
  full: 'checkpoints.reason.full',
  'git-unavailable': 'checkpoints.reason.gitUnavailable',
  busy: 'checkpoints.reason.busy',
  'undo-stale': 'checkpoints.reason.undoStale',
  disconnected: 'checkpoints.reason.disconnected',
  loading: 'checkpoints.reason.loading',
}

/** 宿主在改文件之前就拒绝的原因：这几种失败时「文件没有改动」一定成立。 */
const CHECKPOINTS_UNTOUCHED_REASONS = new Set(['running', 'busy', 'expired', 'no-checkpoint', 'not-eligible', 'git-unavailable', 'bad-request', 'undo-stale'])

/** 重试也没用的原因（检查点不在了、不存在）：弹窗里不给「重试」。 */
const CHECKPOINTS_FINAL_REASONS = new Set(['expired', 'no-checkpoint', 'not-eligible', 'undo-stale'])

/**
 * 一个失败原因怎么写：认识的 reason 用本功能的词条，'unavailable' 带上宿主的话，其余显示
 * 宿主给的 message（去掉末尾的句号，句子由词条收尾）。纯函数。
 * @param {{reason?: string, message?: string} | undefined} failure 失败（接口的 { reason, message }，或入口的 'loading'、'unavailable'）。
 * @returns {{key: string, params?: Record<string, string>} | {text: string}} 词条和参数，或者直接显示的文字。
 */
export function checkpointsReasonText(failure) {
  const message = String(failure?.message ?? '').trim().replace(/[。.]+$/u, '')
  const key = CHECKPOINTS_REASON_KEYS[failure?.reason]
  if (key !== undefined) return { key }
  if (failure?.reason === 'unavailable') return { key: 'checkpoints.reason.unavailable', params: { message } }
  return { text: message === '' ? String(failure?.reason ?? '') : message }
}

// ---------- 纯函数：弹窗里的文字 ----------

/**
 * 三种做法（样稿 C）：标题、说明和要不要分叉、要不要恢复文件。纯函数，文字由调用方过词典。
 * @returns {{id: 'files' | 'fork' | 'both', label: string, hint: string, forks: boolean, restoresFiles: boolean}[]} 选项，按显示顺序。
 */
export function restoreOptions() {
  return [
    { id: 'files', label: 'checkpoints.option.files', hint: 'checkpoints.option.filesHint', forks: false, restoresFiles: true },
    { id: 'fork', label: 'checkpoints.option.fork', hint: 'checkpoints.option.forkHint', forks: true, restoresFiles: false },
    { id: 'both', label: 'checkpoints.option.both', hint: 'checkpoints.option.bothHint', forks: true, restoresFiles: true },
  ]
}

/**
 * 主按钮的文字（样稿 C：「恢复文件」「分叉会话」「恢复文件并分叉会话」）。纯函数。
 * @param {'files' | 'fork' | 'both'} option 选中的做法。
 * @returns {string} 词条键。
 */
export function restoreButtonLabel(option) {
  if (option === 'files') return 'checkpoints.button.files'
  if (option === 'fork') return 'checkpoints.button.fork'
  return 'checkpoints.button.both'
}

/** 跳过的原因 → 行里的标签：恢复（预览、恢复结果）一套，撤销没写回的列表一套；oversized 另分有没有上限，不认识的原因用 other。 */
const CHECKPOINTS_SKIP_TAGS = {
  restore: {
    reasons: {
      submodule: 'checkpoints.tag.submodule',
      'ignored-inside': 'checkpoints.tag.ignoredInside',
      'changed-after': 'checkpoints.tag.changedAfter',
      'unsafe-path': 'checkpoints.tag.unsafePath',
    },
    oversized: 'checkpoints.tag.oversized',
    oversizedNoLimit: 'checkpoints.tag.oversizedNoLimit',
    other: 'checkpoints.tag.skip',
  },
  // 撤销要回到的是恢复之前的样子，不是检查点：原因照撤销的说法写。目录里有被忽略的文件两边一样。
  undo: {
    reasons: {
      submodule: 'checkpoints.undoTag.submodule',
      'ignored-inside': 'checkpoints.tag.ignoredInside',
      'changed-after': 'checkpoints.undoTag.changedAfter',
      'unsafe-path': 'checkpoints.undoTag.unsafePath',
    },
    oversized: 'checkpoints.undoTag.oversized',
    oversizedNoLimit: 'checkpoints.undoTag.oversizedNoLimit',
    other: 'checkpoints.undoTag.skip',
  },
}

/** 行数：非负整数，别的当 0。 */
function checkpointsCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * 文件列表的一行：action 加 reason 变成行里的标签。delete 写「删除」；skip 写原因
 * （oversized 带上单个文件的上限，配置里读不到时写「大小限制」）；restore 不写标签，
 * 右边是「现在 → 检查点」的行数，二进制文件写「二进制」。纯函数。
 * @param {{path: string, action: string, added?: number, deleted?: number, binary?: boolean, reason?: string}} file preview 的 files 里的一条，或 restore、undo 结果 skipped 里的一条（当作 skip）。
 * @param {{maxFileMB?: number, undo?: boolean}} [options] 宿主配置里单个文件的上限（MB）；undo 为 true 时 skip 的原因照撤销的说法写（撤销没写回的那张列表）。
 * @returns {{path: string, tag?: {key: string, params?: Record<string, string>}, counts?: {added: number, deleted: number}}} 行。
 */
export function fileRowView(file, { maxFileMB, undo = false } = {}) {
  const path = String(file?.path ?? '')
  if (file?.action === 'delete') return { path, tag: { key: 'checkpoints.tag.delete' } }
  if (file?.action === 'restore') {
    if (file.binary === true) return { path, tag: { key: 'checkpoints.tag.binary' } }
    return { path, counts: { added: checkpointsCount(file.added), deleted: checkpointsCount(file.deleted) } }
  }
  const tags = CHECKPOINTS_SKIP_TAGS[undo ? 'undo' : 'restore']
  if (file?.reason === 'oversized') {
    return Number.isFinite(maxFileMB) && maxFileMB > 0
      ? { path, tag: { key: tags.oversized, params: { mb: String(maxFileMB) } } }
      : { path, tag: { key: tags.oversizedNoLimit } }
  }
  return { path, tag: { key: Object.hasOwn(tags.reasons, file?.reason) ? tags.reasons[file.reason] : tags.other } }
}

/**
 * 文件列表的表头（样稿 C、I）：会变的文件总数（含不能恢复的那几条，样稿 I 的「会变的 3 个
 * 文件」）、列出的行数合计、没列出来的条数。只列了前 50 条（truncated）时合计只覆盖列出来的，
 * 不准，所以不显示合计。纯函数。
 * @param {{files: object[], total: number, truncated: boolean}} preview preview 的回答。
 * @returns {{total: number, added: number, deleted: number, showTotals: boolean, more: number}} 表头。
 */
export function summaryOf(preview) {
  const files = Array.isArray(preview?.files) ? preview.files : []
  let added = 0
  let deleted = 0
  for (const file of files) {
    if (file?.action === 'skip' || file?.binary === true) continue
    added += checkpointsCount(file?.added)
    deleted += checkpointsCount(file?.deleted)
  }
  const total = Number.isSafeInteger(preview?.total) && preview.total > 0 ? preview.total : files.length
  const truncated = preview?.truncated === true
  return { total, added, deleted, showTotals: !truncated, more: truncated ? Math.max(0, total - files.length) : 0 }
}

/**
 * 路径最后一段（`/` 和 `\` 都算分隔；结尾的分隔符先去掉）。
 * @param {string} path 路径。
 * @returns {string} 最后一段。
 */
function checkpointsBaseName(path) {
  const trimmed = String(path ?? '').replace(/[/\\]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

/**
 * 会话目录相对仓库根的路径（`/` 分隔）；不在根之内或算不出时 undefined。Windows 路径不分大小写。
 * @param {string} root 仓库根。
 * @param {string | undefined} cwd 会话工作目录。
 * @returns {string | undefined} 相对路径。
 */
function checkpointsRelativeDir(root, cwd) {
  if (typeof cwd !== 'string' || cwd === '' || typeof root !== 'string' || root === '') return undefined
  const rest = workbenchPathBelow(root, cwd)
  return rest === undefined || rest.length === 0 ? undefined : rest.join('/')
}

/**
 * 文件列表下面的说明句（样稿 C、F、I）：git 仓库写范围（会话目录不是仓库根时带上仓库名和
 * 会话目录），不在 git 里写只记文件工具改过的文件；notes 里的 'gitignore-changed'、
 * 'lfs-or-filters' 各一句，不认识的忽略。纯函数。
 * @param {{kind: string, root: string, cwdInside: boolean, notes?: string[]}} preview preview 的回答。
 * @param {{cwd?: string}} [session] 会话列表条目的工作目录（算会话目录在仓库里的相对路径）。
 * @returns {{key: string, params?: Record<string, string>, tone: 'info' | 'warning'}[]} 说明句，按显示顺序。
 */
export function noteLines(preview, { cwd } = {}) {
  const notes = Array.isArray(preview?.notes) ? preview.notes : []
  const lines = []
  if (preview?.kind === 'files' || notes.includes('nongit')) {
    lines.push({ key: 'checkpoints.note.nongit', tone: 'warning' })
  } else if (preview?.cwdInside === false) {
    const repo = checkpointsBaseName(preview.root)
    const dir = checkpointsRelativeDir(preview.root, cwd)
    lines.push(dir === undefined
      ? { key: 'checkpoints.note.scopeRepo', params: { repo }, tone: 'info' }
      : { key: 'checkpoints.note.scope', params: { repo, dir }, tone: 'info' })
  } else {
    lines.push({ key: 'checkpoints.note.ignored', tone: 'info' })
  }
  if (notes.includes('gitignore-changed')) lines.push({ key: 'checkpoints.note.gitignoreChanged', tone: 'info' })
  if (notes.includes('lfs-or-filters')) lines.push({ key: 'checkpoints.note.lfsOrFilters', tone: 'warning' })
  return lines
}

/** 两位数补零。 */
function checkpointsPad(value) {
  return String(value).padStart(2, '0')
}

/** 两个本地时间是不是同一天。 */
function checkpointsSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * 弹窗最上面的撤销那一行（样稿 E：「你在 21:07 恢复过一次，撤销」）：今天写时分，昨天写
 * 「昨天」，更早写月日（检查点默认留 14 天，撤销点可能是几天前的）。按本地时区。纯函数。
 * @param {{time: number, turn?: number} | null | undefined} undo list 的 undo。
 * @param {number} now 现在的毫秒时间戳（测试注入）。
 * @returns {{key: string, params: Record<string, string>} | undefined} 词条和参数；没有可撤销的恢复时 undefined。
 */
export function undoLine(undo, now) {
  if (undo === null || typeof undo !== 'object' || !Number.isFinite(undo.time)) return undefined
  const at = new Date(undo.time)
  const today = new Date(now)
  const time = `${checkpointsPad(at.getHours())}:${checkpointsPad(at.getMinutes())}`
  if (checkpointsSameDay(at, today)) return { key: 'checkpoints.undoLine.today', params: { time } }
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (checkpointsSameDay(at, yesterday)) return { key: 'checkpoints.undoLine.yesterday', params: { time } }
  return { key: 'checkpoints.undoLine.date', params: { month: String(at.getMonth() + 1), day: String(at.getDate()), time } }
}

/**
 * 恢复或撤销结果的那一句（样稿 E、F）。撤销成功只写「已撤销。」：撤销有没写回的项时宿主答失败，弹窗走失败视图。纯函数。
 * @param {{restored: number, skipped: object[]}} result restore、undo 的回答。
 * @param {'restore' | 'undo'} kind 哪一种结果。
 * @returns {{key: string, params: Record<string, string>}} 词条和参数。
 */
export function checkpointsResultLine(result, kind) {
  if (kind === 'undo') return { key: 'checkpoints.result.undone', params: {} }
  const n = String(checkpointsCount(result?.restored))
  const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0
  return skipped === 0 ? { key: 'checkpoints.result.restored', params: { n } } : { key: 'checkpoints.result.partial', params: { n, skipped: String(skipped) } }
}

/**
 * 分叉成功后新会话输入框上方那一行提示（样稿 G）。纯函数。
 * @param {number} turn 轮次号。
 * @param {{restored: number, skipped: object[]} | undefined} restored 先恢复了文件时的结果；只分叉时 undefined。
 * @returns {{key: string, params: Record<string, string>}} 词条和参数。
 */
export function checkpointsForkNotice(turn, restored) {
  const params = { turn: String(turn) }
  if (restored === undefined) return { key: 'checkpoints.notice.forked', params }
  const n = String(checkpointsCount(restored.restored))
  const skipped = Array.isArray(restored.skipped) ? restored.skipped.length : 0
  return skipped === 0
    ? { key: 'checkpoints.notice.restoredForked', params: { ...params, n } }
    : { key: 'checkpoints.notice.partialForked', params: { ...params, n, skipped: String(skipped) } }
}

// ---------- 纯函数：弹窗的状态机 ----------

/** 弹窗关着的状态。 */
const CHECKPOINTS_DIALOG_CLOSED = Object.freeze({ phase: 'closed' })

/** 三种做法的 id。 */
const CHECKPOINTS_CHOICES = ['files', 'fork', 'both']

/**
 * 弹窗现在用哪种布局：'open'（三个选项，正在算、算好了或算失败）、'done'（只恢复文件或撤销
 * 的结果）、'result'（恢复、分叉、撤销失败，和「两样都做」恢复完了正在分叉）。working 用
 * 进入时的布局，按钮换成正在做的样子。纯函数。
 * @param {object} state reduceDialog 的状态。
 * @returns {'open' | 'done' | 'result'} 布局。
 */
function checkpointsLayoutOf(state) {
  const { phase } = state
  if (phase === 'working') return state.from === 'open' && state.restored !== undefined ? 'result' : state.from
  if (phase === 'loading' || phase === 'ready') return 'open'
  if (phase === 'error') return state.error?.step === 'preview' ? 'open' : 'result'
  return 'done'
}

/** 「只恢复文件」有没有东西可恢复（preview 列出了要写回或删除的文件）。 */
function checkpointsPreviewChanges(preview) {
  return summaryOf(preview).total > 0
}

/**
 * 在当前状态点主按钮要做什么。纯函数（reduceDialog 和组件共用，按钮可不可点由它决定）。
 * 正在算文件列表、算失败的时候只能「只分叉会话」（分叉不看文件）；「两样都做」恢复成功、
 * 分叉失败后重试只分叉（再恢复一次会顶掉恢复前存的撤销点）。
 * @param {object} state reduceDialog 的状态。
 * @returns {'restore' | 'fork' | 'both' | undefined} 要做的事；主按钮不可点时 undefined。
 */
export function checkpointsConfirmTask(state) {
  const choice = state?.choice
  switch (state?.phase) {
    case 'ready':
      if (choice === 'files') return checkpointsPreviewChanges(state.preview) ? 'restore' : undefined
      return choice === 'fork' || choice === 'both' ? choice : undefined
    case 'loading':
      return choice === 'fork' ? 'fork' : undefined
    case 'error': {
      const step = state.error?.step
      if (step === 'preview') return choice === 'fork' ? 'fork' : undefined
      if (step === 'restore') return choice === 'files' ? 'restore' : choice === 'both' ? 'both' : undefined
      if (step === 'fork') return 'fork'
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * 现在能不能撤销：弹窗最上面那一行（打开着、还没开始做）、只恢复文件完成后的「撤销」、
 * 撤销失败后的「重试」。撤销那一行出不出现由组件按数据层里的 undo 决定。纯函数。
 * @param {object} state reduceDialog 的状态。
 * @returns {boolean} 能撤销是 true。
 */
function checkpointsCanUndo(state) {
  const { phase } = state ?? {}
  if (phase === 'done') return state.restored !== undefined && state.undone === undefined
  if (phase === 'loading' || phase === 'ready') return true
  return phase === 'error' && (state.error?.step === 'preview' || state.error?.step === 'undo')
}

/** 失败留 reason 和 message（缺了补上）；撤销做了一部分时宿主另带 restored、skipped，也留着，弹窗列出没有撤销的项。 */
function checkpointsFailureOf(failure) {
  const base = {
    reason: typeof failure?.reason === 'string' && failure.reason !== '' ? failure.reason : 'failed',
    message: typeof failure?.message === 'string' ? failure.message : '',
  }
  return Number.isSafeInteger(failure?.restored) && Array.isArray(failure?.skipped)
    ? { ...base, restored: failure.restored, skipped: failure.skipped }
    : base
}

/**
 * 弹窗的状态机（样稿 C–I）。状态：closed、loading（正在算会变的文件）、ready、working、
 * done（只恢复文件的结果、撤销的结果）、error。异步结果（previewed、previewFailed、
 * succeeded、failed、undone）带打开时的 token，和当前的对不上就丢掉（关了又开时旧请求的
 * 回答）。working 时不响应关闭：宿主正在改文件，和 DSH 自己的弹窗一样等它做完。纯函数。
 * @param {object} state 当前状态（closed 用 CHECKPOINTS_DIALOG_CLOSED）。
 * @param {{type: string}} event 事件：open { token, target, forkAllowed }、previewed { token, preview }、
 *   previewFailed { token, failure }、choose { choice }、confirm、succeeded { token, step, result? }、
 *   failed { token, step, failure }、undo、undone { token, result }、close。
 * @returns {object} 新状态（没变时原样返回）。
 */
export function reduceDialog(state, event) {
  const phase = state?.phase ?? 'closed'
  switch (event?.type) {
    case 'open': {
      if (phase === 'working') return state
      const forkAllowed = event.forkAllowed === true
      const sameTarget = phase !== 'closed'
        && state.target?.sessionId === event.target?.sessionId && state.target?.turn === event.target?.turn
      const preferred = sameTarget ? state.choice : 'both'
      return { phase: 'loading', token: event.token, target: event.target, forkAllowed, choice: forkAllowed ? preferred : 'files' }
    }
    case 'previewed':
      if (phase !== 'loading' || event.token !== state.token) return state
      return { ...state, phase: 'ready', preview: event.preview }
    case 'previewFailed':
      if (phase !== 'loading' || event.token !== state.token) return state
      return { ...state, phase: 'error', error: { step: 'preview', ...checkpointsFailureOf(event.failure) } }
    case 'choose': {
      if (!CHECKPOINTS_CHOICES.includes(event.choice) || event.choice === state?.choice) return state
      if (state.forkAllowed !== true && event.choice !== 'files') return state
      return checkpointsLayoutOf(state) === 'open' && phase !== 'working' ? { ...state, choice: event.choice } : state
    }
    case 'confirm': {
      const task = checkpointsConfirmTask(state)
      if (task === undefined) return state
      return { ...state, phase: 'working', task, from: checkpointsLayoutOf(state), error: undefined }
    }
    case 'succeeded':
      if (phase !== 'working' || event.token !== state.token) return state
      if (event.step === 'restore' && (state.task === 'restore' || state.task === 'both')) {
        return state.task === 'both' ? { ...state, restored: event.result } : { ...state, phase: 'done', restored: event.result }
      }
      if (event.step === 'fork' && (state.task === 'fork' || state.task === 'both')) return CHECKPOINTS_DIALOG_CLOSED
      return state
    case 'failed':
      if (phase !== 'working' || event.token !== state.token) return state
      return { ...state, phase: 'error', error: { step: event.step, ...checkpointsFailureOf(event.failure) } }
    case 'undo':
      if (!checkpointsCanUndo(state)) return state
      return { ...state, phase: 'working', task: 'undo', from: checkpointsLayoutOf(state), error: undefined }
    case 'undone':
      if (phase !== 'working' || state.task !== 'undo' || event.token !== state.token) return state
      return { ...state, phase: 'done', undone: event.result }
    case 'close':
      return phase === 'working' ? state : CHECKPOINTS_DIALOG_CLOSED
    default:
      return state
  }
}

/** 正在做某件事时主按钮上的字。 */
function checkpointsBusyLabel(state) {
  if (state.task === 'undo') return 'checkpoints.working.undo'
  if (state.task === 'fork' || (state.task === 'both' && state.restored !== undefined)) return 'checkpoints.working.fork'
  return 'checkpoints.working.restore'
}

/**
 * 弹窗这一刻要显示什么（组件只照着渲染）：撤销那一行、三个选项、正文（正在算、文件列表、
 * 结果、错误、说明）、底部的说明和按钮。按钮的 action 是组件要做的动作：close、confirm、
 * undo、retryPreview（重新打开去算文件列表）。纯函数。
 * @param {object} state reduceDialog 的状态（不是 closed）。
 * @param {{undo?: object | null, now: number, cwd?: string, maxFileMB?: number}} context 数据层里这个会话最新的 undo、现在的时间、会话目录、单个文件的上限。
 * @returns {{undoLine?: object, options?: object[], body: object[], footerNote?: string, buttons: object[]}} 显示用的描述。
 */
export function checkpointsDialogView(state, { undo, now, cwd, maxFileMB } = {}) {
  const working = state.phase === 'working'
  const layout = checkpointsLayoutOf(state)
  const option = restoreOptions().find(item => item.id === state.choice) ?? restoreOptions()[2]
  const view = { undoLine: undefined, options: undefined, body: [], footerNote: undefined, buttons: [] }
  const button = (id, label, variant, action, disabled = false) => ({ id, label, variant, action, disabled })
  const skippedBlock = (skipped, kind) => ({
    kind: 'skipped', title: { key: kind === 'undo' ? 'checkpoints.result.notUndoneTitle' : 'checkpoints.result.skippedTitle' },
    rows: skipped.map(item => fileRowView({ path: item?.path, action: 'skip', reason: item?.reason }, { maxFileMB, undo: kind === 'undo' })),
  })
  const resultBody = (result, kind) => {
    const skipped = Array.isArray(result?.skipped) ? result.skipped : []
    const body = [{ kind: 'result', tone: 'success', text: checkpointsResultLine(result, kind) }]
    if (skipped.length > 0) body.push(skippedBlock(skipped, kind))
    return body
  }

  if (layout === 'open') {
    const line = undoLine(undo, now)
    if (line !== undefined) view.undoLine = { text: line, disabled: working, working: working && state.task === 'undo' }
    view.options = restoreOptions().map(item => {
      const noFork = item.forks && state.forkAllowed !== true
      return {
        id: item.id, label: item.label, selected: item.id === state.choice, disabled: working || noFork,
        hint: noFork ? 'checkpoints.option.noFork' : item.hint,
      }
    })
    if (option.restoresFiles) {
      if (state.phase === 'error') {
        view.body.push({ kind: 'result', tone: 'error', text: checkpointsReasonText(state.error) })
      } else if (state.preview === undefined) {
        view.body.push({ kind: 'loading', text: { key: 'checkpoints.loading' } })
      } else {
        const summary = summaryOf(state.preview)
        const rows = state.preview.files.map(file => fileRowView(file, { maxFileMB }))
        view.body.push(summary.total === 0 && rows.length === 0
          ? { kind: 'note', tone: 'info', text: { key: 'checkpoints.files.none' } }
          : { kind: 'files', summary, rows })
        for (const note of noteLines(state.preview, { cwd })) view.body.push({ kind: 'note', tone: note.tone, text: { key: note.key, params: note.params } })
        view.footerNote = 'checkpoints.footer'
      }
    }
    view.buttons.push(button('cancel', 'checkpoints.button.cancel', 'ghost', 'close', working))
    if (working) {
      view.buttons.push(button('primary', checkpointsBusyLabel(state), 'primary', 'confirm', true))
    } else if (state.phase === 'error' && option.restoresFiles && !CHECKPOINTS_FINAL_REASONS.has(state.error?.reason)) {
      view.buttons.push(button('retry', 'checkpoints.button.retry', 'primary', 'retryPreview'))
    } else {
      view.buttons.push(button('primary', restoreButtonLabel(state.choice), 'primary', 'confirm', checkpointsConfirmTask(state) === undefined))
    }
    return view
  }

  if (layout === 'done') {
    if (state.undone !== undefined) {
      view.body = resultBody(state.undone, 'undo')
      view.buttons.push(button('done', 'checkpoints.button.done', 'primary', 'close'))
      return view
    }
    view.body = [...resultBody(state.restored, 'restore'), { kind: 'note', tone: 'info', text: { key: 'checkpoints.result.undoHint' } }]
    view.buttons.push(button('undo', working ? 'checkpoints.working.undo' : 'checkpoints.button.undo', 'ghost', 'undo', working))
    view.buttons.push(button('done', 'checkpoints.button.done', 'primary', 'close', working))
    return view
  }

  // 'result'：恢复、分叉、撤销失败；「两样都做」恢复完了正在分叉（只在按钮上写「正在分叉…」）。已经恢复了的先写结果。
  if (state.restored !== undefined) view.body.push(...resultBody(state.restored, 'restore'))
  const closeLabel = state.restored === undefined ? 'checkpoints.button.cancel' : 'checkpoints.button.done'
  if (working) {
    view.buttons.push(button('cancel', closeLabel, 'ghost', 'close', true))
    view.buttons.push(button('primary', checkpointsBusyLabel(state), 'primary', 'confirm', true))
    return view
  }
  const step = state.error?.step
  const notUndone = step === 'undo' && Array.isArray(state.error?.skipped) ? state.error.skipped : []
  if (notUndone.length > 0) {
    // 撤销做了一部分（宿主答 failed，带 restored、skipped）：写已经撤销了几个，列出没有撤销的项和原因。撤销点还在，可以重试。
    const n = checkpointsCount(state.error.restored)
    const text = n > 0
      ? { key: 'checkpoints.error.undoPartial', params: { n: String(n), skipped: String(notUndone.length) } }
      : { key: 'checkpoints.error.undoBlocked', params: { skipped: String(notUndone.length) } }
    view.body.push({ kind: 'result', tone: 'error', text }, skippedBlock(notUndone, 'undo'))
  } else {
    const errorKey = step === 'undo' ? 'checkpoints.error.undo' : step === 'fork' ? 'checkpoints.error.fork' : 'checkpoints.error.restore'
    // 撤销时的 no-checkpoint 是「恢复前」检查点不在了（另一个窗口先撤销了），不是这一轮没有检查点。
    const reason = step === 'undo' && state.error?.reason === 'no-checkpoint' ? { key: 'checkpoints.reason.noUndo' } : checkpointsReasonText(state.error)
    view.body.push({ kind: 'result', tone: 'error', text: { key: errorKey, params: { reason } } })
    if (step !== 'fork' && CHECKPOINTS_UNTOUCHED_REASONS.has(state.error?.reason)) {
      view.body.push({ kind: 'note', tone: 'info', text: { key: 'checkpoints.error.untouched' } })
    }
  }
  if (step !== 'fork' && CHECKPOINTS_FINAL_REASONS.has(state.error?.reason)) {
    view.buttons.push(button('cancel', closeLabel, 'primary', 'close'))
    return view
  }
  view.buttons.push(button('cancel', closeLabel, 'ghost', 'close'))
  view.buttons.push(button('retry', 'checkpoints.button.retry', 'primary', step === 'undo' ? 'undo' : 'confirm'))
  return view
}

// ---------- 数据层 ----------

/** list 的缓存时长（毫秒）：同一个会话 5 秒内不重读。 */
const CHECKPOINTS_LIST_TTL_MS = 5000

/** 路由前缀（和 DSH 网页端同源，带登录 cookie；接口文档的路由表）。 */
const CHECKPOINTS_ROUTE = 'api/dsh-workbench.checkpoints.'

/** 异常的文字。 */
function checkpointsErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 是不是普通对象。 */
function checkpointsIsObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** list 的回答里一条记录是否合格（宿主写坏了的跳过，不让整个会话读不出来）。 */
function checkpointsEntryOk(entry) {
  return checkpointsIsObject(entry) && Number.isSafeInteger(entry.turn) && Number.isSafeInteger(entry.seq)
    && Number.isFinite(entry.time) && (entry.kind === 'git' || entry.kind === 'files')
}

/** 各路由成功回答的字段核对（wire 边界）：过了返回整理后的回答，不过返回 undefined。 */
const CHECKPOINTS_ADOPT = {
  list(body) {
    if (typeof body.eligible !== 'boolean' || typeof body.full !== 'boolean' || !Array.isArray(body.entries)) return undefined
    const undo = checkpointsIsObject(body.undo) && Number.isFinite(body.undo.time) ? { time: body.undo.time, turn: body.undo.turn } : null
    return { ok: true, eligible: body.eligible, full: body.full, entries: body.entries.filter(checkpointsEntryOk), undo }
  },
  preview(body) {
    if (typeof body.root !== 'string' || typeof body.cwdInside !== 'boolean' || (body.kind !== 'git' && body.kind !== 'files')) return undefined
    if (!Array.isArray(body.files) || !Number.isSafeInteger(body.total) || typeof body.truncated !== 'boolean') return undefined
    const files = body.files.filter(file => checkpointsIsObject(file) && typeof file.path === 'string' && typeof file.action === 'string')
    const notes = Array.isArray(body.notes) ? body.notes.filter(note => typeof note === 'string') : []
    return { ok: true, root: body.root, cwdInside: body.cwdInside, kind: body.kind, files, total: body.total, truncated: body.truncated, notes }
  },
  restore(body) {
    if (!Number.isSafeInteger(body.restored) || !Array.isArray(body.skipped)) return undefined
    return { ok: true, restored: body.restored, skipped: body.skipped.filter(item => checkpointsIsObject(item) && typeof item.path === 'string') }
  },
  config(body) {
    return checkpointsIsObject(body.config) ? { ok: true, config: body.config } : undefined
  },
}

/**
 * 客户端的数据层：宿主是真身，这里是缓存加订阅。所有调用的失败统一成 { ok: false, reason,
 * message }（接口文档的 reason 表；fetch 抛错是 'disconnected'，回答不是接口里的样子是
 * 'failed' 带 HTTP 状态码）；撤销做了一部分时宿主的失败回答另带 restored、skipped，原样留下。list 每个会话缓存 5 秒；invalidate 作废（不清掉上一份，
 * 入口照旧显示），有入口挂着的会话马上重读，作废前发出的请求的回答丢掉（可能早于恢复）。
 * restore、undo 之后不论成败都作废那个会话（失败多半是另一个窗口先恢复或撤销了，undo
 * 那一行要跟着变）。preview 答 expired 时记下这一轮，入口跟着置灰。
 * @param {(input: string, init?: object) => Promise<{status: number, json: () => Promise<unknown>}>} fetchImpl fetch（测试注入假的）。
 * @param {{now?: () => number, ttlMs?: number}} [options] 时钟和缓存时长（测试注入）。
 * @returns {object} 数据层：list、peek、watch、subscribe、invalidate、preview、restore、undo、config.read/write/peek。
 */
export function createCheckpointsApi(fetchImpl, { now = () => Date.now(), ttlMs = CHECKPOINTS_LIST_TTL_MS } = {}) {
  /** 会话 id → 快照 { value?, error?, expired }：内容变了才换对象，订阅者按身份比较。 */
  const states = new Map()
  /** 会话 id → 上一次 list 的回答（成功或失败）和读到的时间。 */
  const answers = new Map()
  /** 会话 id → 在路上的 list 请求。 */
  const pending = new Map()
  /** 会话 id → 挂着的入口数。 */
  const watchers = new Map()
  const listeners = new Set()
  let configValue
  const setState = (sessionId, patch) => {
    const previous = states.get(sessionId) ?? { value: undefined, error: undefined, expired: new Set() }
    states.set(sessionId, { ...previous, ...patch })
    for (const listener of listeners) listener()
  }

  /** 发一个请求，回答统一成接口里的成功或失败。 */
  const call = async (route, method, body) => {
    let response
    try {
      response = await fetchImpl(CHECKPOINTS_ROUTE + route, {
        method,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
    } catch (error) {
      return { ok: false, reason: 'disconnected', message: checkpointsErrorMessage(error) }
    }
    let parsed
    try {
      parsed = await response.json()
    } catch {
      // 回答不是 JSON（路由不在时 DSH 的 404 页、登录过期的 401 这类）：按下面的 HTTP 状态码报。
      parsed = undefined
    }
    const status = `HTTP ${response.status}`
    if (checkpointsIsObject(parsed) && parsed.ok === false && typeof parsed.reason === 'string' && parsed.reason !== '') {
      const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : status
      // 撤销做了一部分：restored、skipped 和成功回答一样核过再留下。
      const partial = CHECKPOINTS_ADOPT.restore(parsed)
      return partial === undefined
        ? { ok: false, reason: parsed.reason, message }
        : { ok: false, reason: parsed.reason, message, restored: partial.restored, skipped: partial.skipped }
    }
    if (checkpointsIsObject(parsed) && parsed.ok === true) {
      const name = route.split('?')[0]
      const adopted = CHECKPOINTS_ADOPT[name === 'undo' ? 'restore' : name](parsed)
      if (adopted !== undefined) return adopted
    }
    return { ok: false, reason: 'failed', message: status }
  }

  const list = (sessionId) => {
    const answer = answers.get(sessionId)
    if (answer !== undefined && now() - answer.at < ttlMs) return Promise.resolve(answer.result)
    const inFlight = pending.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const request = call(`list?sessionId=${encodeURIComponent(sessionId)}`, 'GET').then(result => {
      // 作废之后（pending 被换掉）才到的回答可能早于那次恢复，丢掉。
      if (pending.get(sessionId) !== request) return result
      pending.delete(sessionId)
      answers.set(sessionId, { at: now(), result })
      const previous = states.get(sessionId)
      if (result.ok) {
        const { ok, ...value } = result
        if (JSON.stringify(previous?.value) !== JSON.stringify(value) || previous?.error !== undefined) setState(sessionId, { value, error: undefined })
      } else if (previous?.error?.reason !== result.reason || previous?.error?.message !== result.message) {
        setState(sessionId, { error: { reason: result.reason, message: result.message } })
      }
      return result
    })
    pending.set(sessionId, request)
    return request
  }

  const invalidate = (sessionId) => {
    const ids = sessionId === undefined ? [...new Set([...answers.keys(), ...pending.keys(), ...watchers.keys()])] : [sessionId]
    for (const id of ids) {
      answers.delete(id)
      pending.delete(id)
      if ((watchers.get(id) ?? 0) > 0) void list(id)
    }
  }

  const markExpired = (sessionId, turn, expired) => {
    const current = states.get(sessionId)?.expired ?? new Set()
    if (current.has(turn) === expired) return
    const next = new Set(current)
    if (expired) next.add(turn)
    else next.delete(turn)
    setState(sessionId, { expired: next })
  }

  return {
    list,
    invalidate,
    /** 这个会话现在的快照（没读过时 undefined）；内容没变时是同一个对象。 */
    peek: (sessionId) => states.get(sessionId),
    /** 有入口挂在这个会话上：缓存过期了就读一次；返回撤销函数。 */
    watch(sessionId) {
      watchers.set(sessionId, (watchers.get(sessionId) ?? 0) + 1)
      void list(sessionId)
      return () => {
        const count = (watchers.get(sessionId) ?? 1) - 1
        if (count > 0) watchers.set(sessionId, count)
        else watchers.delete(sessionId)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async preview(sessionId, turn) {
      const result = await call('preview', 'POST', { sessionId, turn })
      if (result.ok || result.reason === 'expired') markExpired(sessionId, turn, !result.ok)
      return result
    },
    async restore(sessionId, turn) {
      const result = await call('restore', 'POST', { sessionId, turn })
      invalidate(sessionId)
      return result
    },
    async undo(sessionId) {
      const result = await call('undo', 'POST', { sessionId })
      invalidate(sessionId)
      return result
    },
    config: {
      async read() {
        const result = await call('config', 'GET')
        if (result.ok) configValue = result.config
        return result
      },
      async write(config) {
        const result = await call('config', 'POST', config)
        if (result.ok) configValue = result.config
        return result
      },
      /** 上一次读到或写成的配置（没有时 undefined）。 */
      peek: () => configValue,
    },
  }
}

/**
 * sessionStatus 两个快照之间结束了运行的会话（running 由真变假，或从快照里消失）：它们
 * 刚结束一轮，list 要作废重读。纯函数。
 * @param {Map<string, {running?: boolean}> | null | undefined} prev 上一个快照。
 * @param {Map<string, {running?: boolean}>} next 当前快照。
 * @returns {string[]} 会话 id。
 */
export function checkpointsStoppedSessions(prev, next) {
  if (!(prev instanceof Map) || !(next instanceof Map)) return []
  const stopped = []
  for (const [sessionId, status] of prev) if (status?.running === true && next.get(sessionId)?.running !== true) stopped.push(sessionId)
  return stopped
}

/**
 * 看着会话状态，一轮结束就作废那个会话的 list；返回停止函数。
 * @param {{getSnapshot: () => Map<string, object>, subscribe: (listener: () => void) => () => void, onStopped: (sessionId: string) => void}} deps 会话状态（ctx.uiSession.sessionStatus）和回调。
 * @returns {() => void} 停止函数。
 */
export function startCheckpointsRunWatcher(deps) {
  let prev = deps.getSnapshot()
  return deps.subscribe(() => {
    const next = deps.getSnapshot()
    for (const sessionId of checkpointsStoppedSessions(prev, next)) deps.onStopped(sessionId)
    prev = next
  })
}

// ---------- 恢复、撤销和分叉 ----------

/**
 * 分叉出新会话、切过去、清掉继承来的排队消息，不重发（输入框留空），在新会话的输入框上方
 * 提示（样稿 G）。依赖全部注入，测试用假的。分叉失败（fork、持有子会话、等它就绪）抛出，
 * 调用方写在弹窗里；排队消息清不掉不抛：子会话已经打开，在它的输入框上方报错。
 * @param {object} deps 依赖：fork、using、openSession、inputFor、t、warn；可选 inboxWaitMs。
 * @param {{sessionId: string, atSeq: number, turn: number, restored?: {restored: number, skipped: object[]}}} request 源会话、分叉点、轮次号（提示里用）、先恢复了文件时的结果。
 * @returns {Promise<{outcome: 'forked' | 'queue-failed', childId: string}>} 结局。
 * @throws {Error} 分叉失败时。
 */
export async function checkpointsForkSession(deps, request) {
  const childId = await deps.fork({ sessionId: request.sessionId, atSeq: request.atSeq, increaseTitle: true })
  return deps.using(childId, { source: 'workbenchCheckpoints' }, async reference => {
    await reference.ready
    deps.openSession(childId)
    let outcome = 'forked'
    let level = 'info'
    let notice = checkpointsForkNotice(request.turn, request.restored)
    try {
      await clearInheritedQueue(reference.binding.session, deps.inboxWaitMs ?? INBOX_WAIT_MS)
    } catch (error) {
      outcome = 'queue-failed'
      level = 'error'
      notice = { key: 'checkpoints.notice.queueFailed', params: { turn: String(request.turn), reason: checkpointsErrorMessage(error) } }
    }
    try {
      deps.inputFor(reference.binding.ctx)?.notify(level, deps.t(notice.key, notice.params))
    } catch (error) {
      // 提示发不出去（conversation 服务没装上之类）不影响结果：会话已经分叉并切过去。
      deps.warn?.(`dsh-workbench/checkpoints: 显示分叉提示失败：${checkpointsErrorMessage(error)}`)
    }
    return { outcome, childId }
  })
}

/**
 * 点了主按钮或「撤销」之后的那串请求，结果按事件派发给 reduceDialog（组件卸载了派发也无害）。
 * 恢复失败不分叉；「两样都做」恢复成功后先派发 succeeded(restore) 再分叉；已经恢复过
 * （context.restored）时只分叉。
 * @param {'restore' | 'fork' | 'both' | 'undo'} task 要做的事（checkpointsConfirmTask 或 'undo'）。
 * @param {{token: number, sessionId: string, turn: number, atSeq: number, restored?: object}} context 弹窗的 token、坐标、分叉点、已经恢复过时的结果。
 * @param {{api: object, fork: object}} deps 数据层和 checkpointsForkSession 的依赖。
 * @param {(event: object) => void} dispatch 派发事件。
 * @returns {Promise<void>} 做完时。
 */
export async function runCheckpointsTask(task, context, deps, dispatch) {
  const { token, sessionId, turn } = context
  if (task === 'undo') {
    const result = await deps.api.undo(sessionId)
    dispatch(result.ok ? { type: 'undone', token, result } : { type: 'failed', token, step: 'undo', failure: result })
    return
  }
  let restored = context.restored
  if (task === 'restore' || (task === 'both' && restored === undefined)) {
    const result = await deps.api.restore(sessionId, turn)
    if (!result.ok) {
      dispatch({ type: 'failed', token, step: 'restore', failure: result })
      return
    }
    restored = { restored: result.restored, skipped: result.skipped }
    dispatch({ type: 'succeeded', token, step: 'restore', result: restored })
    if (task === 'restore') return
  }
  try {
    await checkpointsForkSession(deps.fork, { sessionId, atSeq: context.atSeq, turn, restored })
  } catch (error) {
    dispatch({ type: 'failed', token, step: 'fork', failure: { reason: 'failed', message: checkpointsErrorMessage(error) } })
    return
  }
  dispatch({ type: 'succeeded', token, step: 'fork' })
}

// ---------- 行配置（宿主是真身） ----------

/** 配置页里能改的数字（接口文档 config 一节；waitSeconds 不在页上，保存时原样带回去）。 */
const CHECKPOINTS_NUMBER_FIELDS = ['keepDays', 'maxStoreMB', 'maxFileMB']

/**
 * 配置 → 配置页的草稿（数字变成输入框里的文字；读到的配置里缺的数字是空串，保存前要填）。纯函数。
 * @param {object} config 宿主的配置。
 * @returns {{keepDays: string, maxStoreMB: string, maxFileMB: string, skipPresets: string[]}} 草稿。
 */
export function checkpointsConfigDraft(config) {
  const draft = { skipPresets: Array.isArray(config?.skipPresets) ? config.skipPresets.filter(item => typeof item === 'string') : [] }
  for (const field of CHECKPOINTS_NUMBER_FIELDS) draft[field] = Number.isFinite(config?.[field]) ? String(config[field]) : ''
  return draft
}

/**
 * 草稿 → 要 POST 的整份配置：数字要是正整数（不合格的列在 invalid 里，不能保存），别的字段
 * 照读到的原样带回去（POST 体是整份配置，宿主缺字段答 400）。纯函数。
 * @param {object} loaded 读到的配置。
 * @param {{keepDays: string, maxStoreMB: string, maxFileMB: string, skipPresets: string[]}} draft 草稿。
 * @returns {{config: object, invalid: string[]}} 整份配置和不合格的字段名。
 */
export function checkpointsConfigFromDraft(loaded, draft) {
  const config = { ...loaded, skipPresets: [...draft.skipPresets] }
  const invalid = []
  for (const field of CHECKPOINTS_NUMBER_FIELDS) {
    const text = String(draft[field] ?? '').trim()
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (Number.isSafeInteger(value) && value > 0) config[field] = value
    else invalid.push(field)
  }
  return { config, invalid }
}

/**
 * 配置页里勾上、取消一个预设。纯函数。
 * @param {string[]} presets 现在勾上的预设。
 * @param {string} id 点的预设。
 * @returns {string[]} 新的勾选。
 */
export function checkpointsTogglePreset(presets, id) {
  return presets.includes(id) ? presets.filter(item => item !== id) : [...presets, id]
}

// ---------- 界面 ----------

/** 把纯函数给的 { key, params } 或 { text } 过词典（参数也可以是 { key } 或 { text }）。 */
function checkpointsSay(t, view) {
  if (view === undefined) return ''
  if ('text' in view) return view.text
  const params = {}
  for (const [name, value] of Object.entries(view.params ?? {})) params[name] = typeof value === 'object' ? checkpointsSay(t, value) : value
  return t(view.key, params)
}

/** 订阅数据层里一个会话的快照，并在挂着时让数据层读它的 list。 */
function useCheckpointsList(api, sessionId) {
  const state = React.useSyncExternalStore(api.subscribe, () => api.peek(sessionId))
  useEffect(() => api.watch(sessionId), [api, sessionId])
  return state
}

/**
 * 一个入口：按钮（图标排里的图标，或轮次末尾的小按钮）加它的弹窗。弹窗状态在这个组件里，
 * 入口置灰也不卸载它；请求的结果按事件派发。分叉会切走主对话区，组件跟着卸载也无害
 * （那时只剩分叉这一步，提示发在新会话里）。
 * @param {object} props app、api、variant（'icon' | 'button'）、会话 id、这一轮的坐标和提问、会话是否在运行、能不能分叉、会话目录。
 * @returns {unknown} React 节点。
 */
function CheckpointsEntry({ app, api, variant, sessionId, target, question, running, forkAllowed, cwd }) {
  const t = app.t
  const listState = useCheckpointsList(api, sessionId)
  const [dialog, dispatch] = React.useReducer(reduceDialog, CHECKPOINTS_DIALOG_CLOSED)
  const tokenRef = useRef(0)
  const availability = checkpointsEntryView(listState, { turn: target.turn, seq: target.seq, running })
  const blocked = !availability.ok
  const label = t('checkpoints.action')
  const forkSeq = target.seq ?? (availability.ok ? availability.entry.seq : undefined)
  const canFork = forkAllowed === true && Number.isSafeInteger(forkSeq) && forkSeq > 0
  const openDialog = () => {
    tokenRef.current += 1
    const token = tokenRef.current
    dispatch({ type: 'open', token, target: { sessionId, turn: target.turn }, forkAllowed: canFork })
    void api.list(sessionId)
    // 文件列表等配置一起到再画：不能恢复的大文件标签要写单个文件的上限（maxFileMB）。config.read 不抛错。
    const configReady = api.config.peek() === undefined ? api.config.read() : undefined
    void Promise.all([api.preview(sessionId, target.turn), configReady]).then(([result]) => {
      dispatch(result.ok ? { type: 'previewed', token, preview: result } : { type: 'previewFailed', token, failure: result })
    })
  }
  const start = (task) => {
    const context = { token: tokenRef.current, sessionId, turn: target.turn, atSeq: forkSeq - 1, restored: dialog.restored }
    void runCheckpointsTask(task, context, { api, fork: rerunDepsOf(app) }, dispatch)
  }
  const act = (action) => {
    if (action === 'close') {
      dispatch({ type: 'close' })
    } else if (action === 'retryPreview') {
      openDialog()
    } else if (action === 'undo') {
      if (reduceDialog(dialog, { type: 'undo' }) === dialog) return
      dispatch({ type: 'undo' })
      start('undo')
    } else if (action === 'confirm') {
      const task = checkpointsConfirmTask(dialog)
      if (task === undefined) return
      dispatch({ type: 'confirm' })
      start(task)
    }
  }
  const tooltip = blocked ? checkpointsSay(t, checkpointsReasonText(availability)) : label
  const onClick = blocked ? undefined : openDialog
  const icon = h(ui.IconClockOutlineRegular, { size: 14 })
  const trigger = variant === 'icon'
    ? h(ui.Tooltip, { label: tooltip, side: 'bottom' },
      h('button', {
        type: 'button', className: 'dwb-cp-act', 'aria-label': label,
        'aria-disabled': blocked || undefined, 'aria-haspopup': 'dialog', onClick,
      }, icon))
    : h(ui.Tooltip, { label: tooltip, side: 'bottom', disabled: !blocked },
      h(ui.Button, {
        variant: 'ghost', size: 'sm', className: 'dwb-cp-tailbtn', icon,
        'aria-disabled': blocked || undefined, 'aria-haspopup': 'dialog', onClick,
      }, label))
  return h(Fragment, null,
    trigger,
    dialog.phase === 'closed' ? null : h(CheckpointsDialog, {
      t, dialog, act, dispatch, subtitle: checkpointsSubtitle(target.turn, question),
      context: { undo: listState?.value?.undo ?? null, now: Date.now(), cwd, maxFileMB: api.config.peek()?.maxFileMB },
    }))
}

/** 弹窗：照 checkpointsDialogView 的描述渲染 ui.Modal（样稿 C–I；ui.Modal 自己 portal 到 body）。 */
function CheckpointsDialog({ t, dialog, act, dispatch, subtitle, context }) {
  const view = checkpointsDialogView(dialog, context)
  const say = value => checkpointsSay(t, value)
  const footer = h('div', { className: 'dwb-cp-foot' },
    h('span', { className: 'dwb-cp-foot-note' }, view.footerNote === undefined ? null : t(view.footerNote)),
    ...view.buttons.map(item => h(ui.Button, {
      key: item.id, variant: item.variant === 'primary' ? 'primary' : 'outline', disabled: item.disabled,
      onClick: () => { act(item.action) },
    }, t(item.label))))
  return h(ui.Modal, {
    open: true, onClose: () => { act('close') }, closeLabel: t('checkpoints.close'),
    title: t('checkpoints.action'), description: say(subtitle), className: 'dwb-cp-modal', footer,
  },
  h('div', { className: 'dwb-cp-body' },
    view.undoLine === undefined ? null : h('div', { className: 'dwb-cp-undo' },
      h(ui.IconInfoOutlineRegular, { size: 14 }),
      h('span', null, say(view.undoLine.text)),
      h('button', {
        type: 'button', className: 'dwb-cp-link', disabled: view.undoLine.disabled, onClick: () => { act('undo') },
      }, t(view.undoLine.working ? 'checkpoints.working.undo' : 'checkpoints.button.undo'))),
    view.options === undefined ? null : h('div', { className: 'dwb-cp-options', role: 'radiogroup', 'aria-label': t('checkpoints.action') },
      view.options.map(option => h('label', {
        key: option.id, className: 'dwb-cp-opt', 'data-on': option.selected || undefined, 'data-disabled': option.disabled || undefined,
      },
      h('input', {
        type: 'radio', name: 'dwb-cp-choice', checked: option.selected, disabled: option.disabled,
        onChange: () => { dispatch({ type: 'choose', choice: option.id }) },
      }),
      h('span', { className: 'dwb-cp-opt-title' }, t(option.label)),
      h('span', { className: 'dwb-cp-opt-hint' }, t(option.hint))))),
    ...view.body.map((block, at) => h(CheckpointsBlock, { key: at, t, block }))))
}

/** 弹窗正文的一块：正在算、文件列表、没有恢复的、结果句、说明句。 */
function CheckpointsBlock({ t, block }) {
  const say = value => checkpointsSay(t, value)
  const counts = ({ added, deleted }) => h('span', { className: 'dwb-cp-counts' },
    h('span', { className: 'dwb-cp-add' }, `+${added}`),
    h('span', { className: 'dwb-cp-del' }, `−${deleted}`))
  if (block.kind === 'loading') {
    return h('div', { className: 'dwb-cp-line', role: 'status' }, h(ui.IconLoadingOutlineRegular, { size: 14 }), h('span', null, say(block.text)))
  }
  if (block.kind === 'files' || block.kind === 'skipped') {
    const head = block.kind === 'files'
      ? h('div', { className: 'dwb-cp-fh' },
        h('span', null, t('checkpoints.files.title', { n: String(block.summary.total) })),
        block.summary.showTotals ? counts(block.summary) : null)
      : h('div', { className: 'dwb-cp-fh' }, h('span', null, say(block.title)))
    return h('div', { className: 'dwb-cp-files' },
      head,
      h('ul', { className: 'dwb-cp-rows' }, block.rows.map((row, at) => h('li', { key: `${at}:${row.path}`, className: 'dwb-cp-row' },
        h(ui.FileTypeIcon, { path: row.path, size: 14 }),
        h(ui.PathLabel, { path: row.path, className: 'dwb-cp-path' }),
        row.tag === undefined ? counts(row.counts) : h('span', { className: 'dwb-cp-tag' }, say(row.tag))))),
      block.kind === 'files' && block.summary.more > 0
        ? h('div', { className: 'dwb-cp-more' }, t('checkpoints.files.more', { n: String(block.summary.more) }))
        : null)
  }
  if (block.kind === 'result') {
    return h('div', { className: 'dwb-cp-result', 'data-tone': block.tone, role: block.tone === 'error' ? 'alert' : 'status' },
      block.tone === 'error' ? h(ui.IconWarningOutlineRegular, { size: 16 }) : h(ui.IconCheckCircleOutlineRegular, { size: 16 }),
      h('span', null, say(block.text)))
  }
  return h('div', { className: 'dwb-cp-line', 'data-tone': block.tone },
    block.tone === 'warning' ? h(ui.IconWarningOutlineRegular, { size: 14 }) : h(ui.IconInfoOutlineRegular, { size: 14 }),
    h('span', null, say(block.text)))
}

/** 图标排条目（样稿 A）：从 messageId 找这一轮，找不到不渲染。钩子都在提前返回之前调用。 */
function CheckpointsAction(props) {
  const { app, api, sessionId, messageId, useChat, useSession, useAccess, useSessions } = props
  const target = useChat(snapshot => checkpointsTurnOf(snapshot, messageId), checkpointsSameTarget)
  const question = useChat(snapshot => (target === undefined ? '' : checkpointsQuestionOf(snapshot, target.turn)), Object.is)
  const running = useSession(session => session.running === true)
  const forkAllowed = useAccess('session/fork')
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  if (target === undefined) return null
  return h(CheckpointsEntry, { app, api, variant: 'icon', sessionId, target, question, running, forkAllowed, cwd })
}

/** 轮次末尾的小按钮（样稿 B）：只给图标排不出现的已结束轮次。钩子都在提前返回之前调用。 */
function CheckpointsTail(props) {
  const { app, api, sessionId, turn, useChat, useSession, useAccess, useSessions } = props
  const target = checkpointsTailTarget(turn)
  const question = useChat(snapshot => (target === undefined ? '' : checkpointsQuestionOf(snapshot, target.turn)), Object.is)
  const running = useSession(session => session.running === true)
  const forkAllowed = useAccess('session/fork')
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  if (target === undefined) return null
  return h('div', { className: 'dwb-cp-tail' },
    h(CheckpointsEntry, { app, api, variant: 'button', sessionId, target, question, running, forkAllowed, cwd }))
}

/** 行配置页（样稿「插件页和配置」）：保留天数、每个会话最多占用、每个文件最多保存（接口文档 config 一节后加的 maxFileMB）、不保存这些预设的会话。 */
function CheckpointsConfigPage({ app, api }) {
  const t = app.t
  const [loaded, setLoaded] = useState(undefined)
  const [draft, setDraft] = useState(undefined)
  const [presets, setPresets] = useState([])
  const [unavailable, setUnavailable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(undefined)
  useEffect(() => {
    let live = true
    void (async () => {
      const result = await api.config.read()
      if (!live) return
      if (!result.ok) {
        setUnavailable(true)
        return
      }
      setLoaded(result.config)
      setDraft(checkpointsConfigDraft(result.config))
      // 预设列表和系统通知的配置页同一个来源（智能体预设注册表）。
      const roster = await app.ctx.remote.agentPresets?.list?.()
      if (live && roster?.ok) setPresets(roster.value.presets)
    })()
    return () => { live = false }
  }, [])
  const labels = settingsFormLabels(t, failed, 'checkpoints.form.unavailable')
  if (unavailable) {
    return h(ui.SettingsForm, {
      labels, onSave: () => {}, onDiscard: () => {},
      state: { available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false },
    })
  }
  if (draft === undefined) return null
  const { config, invalid } = checkpointsConfigFromDraft(loaded, draft)
  const dirty = JSON.stringify(config) !== JSON.stringify(loaded)
  const edit = patch => {
    setDraft(current => ({ ...current, ...patch }))
    setFailed(undefined)
  }
  const save = async () => {
    setSaving(true)
    const result = await api.config.write(config)
    setSaving(false)
    if (!result.ok) {
      setFailed(checkpointsSay(t, checkpointsReasonText(result)))
      return
    }
    setLoaded(result.config)
    setDraft(checkpointsConfigDraft(result.config))
    setFailed(undefined)
  }
  const numberField = (field, labelKey, hintKey) => h(ui.SettingsValueField, {
    id: `dwb-cp-${field}`, label: t(labelKey), hint: t(hintKey), numeric: true, text: draft[field],
    invalid: invalid.includes(field), invalidLabel: t('checkpoints.page.positiveInteger'), disabled: saving,
    onEdit: text => { edit({ [field]: text }) },
  })
  return h('div', { className: 'dwb-notify-page' },
    h('p', { className: 'dwb-notify-hint' }, t('checkpoints.page.summary')),
    h(ui.SettingsForm, {
      labels,
      state: { available: true, writable: true, dirty, invalid: invalid.length > 0, saving, failed: failed !== undefined },
      onSave: () => { void save() },
      onDiscard: () => {
        setDraft(checkpointsConfigDraft(loaded))
        setFailed(undefined)
      },
    },
    numberField('keepDays', 'checkpoints.page.keepDays', 'checkpoints.page.keepDaysHint'),
    numberField('maxStoreMB', 'checkpoints.page.maxStoreMB', 'checkpoints.page.maxStoreMBHint'),
    numberField('maxFileMB', 'checkpoints.page.maxFileMB', 'checkpoints.page.maxFileMBHint'),
    h('div', { className: 'dwb-notify-group' },
      h('h4', null, t('checkpoints.page.presets')),
      ...presets.map(preset => h(ui.Checkbox, {
        key: preset.id, checked: draft.skipPresets.includes(preset.id), label: preset.name ?? preset.id, disabled: saving,
        onChange: () => { edit({ skipPresets: checkpointsTogglePreset(draft.skipPresets, preset.id) }) },
      })))))
}

/** plugins.row.config 的条目：summary 一句话，page 是配置页。 */
function CheckpointsConfigEntry(props) {
  const { app, api, view } = props
  return view === 'summary' ? app.t('checkpoints.page.summary') : h(CheckpointsConfigPage, { app, api })
}

// ---------- 挂载 ----------

/** 本功能自己的样式（style.js 是共用文件，不往里加）。悬停只改底色，不让别的元素出现。 */
const CHECKPOINTS_CSS = `
.dwb-cp-act{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dwb-cp-act svg{width:17px;height:17px}
.dwb-cp-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dwb-cp-act[aria-disabled=true]{cursor:default;opacity:.4}
.dwb-cp-act[aria-disabled=true]:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
.dwb-cp-tail{display:flex;padding:2px 0}
.dwb-cp-tailbtn[aria-disabled=true]{cursor:default;opacity:.45}
.dwb-cp-modal{width:min(520px,calc(100vw - 32px))}
.dwb-cp-body{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px}
.dwb-cp-undo{display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dwb-cp-undo svg{flex:none}
.dwb-cp-link{border:none;padding:0;background:transparent;color:var(--dsw-alias-link);font:inherit;cursor:pointer}
.dwb-cp-link:disabled{cursor:default;opacity:.6}
.dwb-cp-options{display:flex;flex-direction:column;gap:6px}
.dwb-cp-opt{display:grid;grid-template-columns:20px 1fr;gap:1px 8px;padding:9px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;cursor:pointer}
.dwb-cp-opt[data-on]{border-color:var(--dsw-alias-link);background:color-mix(in srgb,var(--dsw-alias-link) 8%,transparent)}
.dwb-cp-opt[data-disabled]{cursor:default;opacity:.55}
.dwb-cp-opt input{margin:4px 0 0;accent-color:var(--dsw-alias-link)}
.dwb-cp-opt-title{font-size:13px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dwb-cp-opt-hint{grid-column:2;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-cp-files{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.dwb-cp-fh{display:flex;justify-content:space-between;gap:8px;padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}
.dwb-cp-rows{margin:0;padding:0;list-style:none;max-height:240px;overflow-y:auto}
.dwb-cp-row{display:flex;align-items:center;gap:8px;padding:5px 12px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dwb-cp-row svg{flex:none}
.dwb-cp-path{flex:1 1 auto;min-width:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}
.dwb-cp-counts{display:flex;gap:6px;flex:none;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}
.dwb-cp-add{color:var(--dsw-alias-state-success-primary)}
.dwb-cp-del{color:var(--dsw-alias-state-error-primary)}
.dwb-cp-tag{flex:none;font-size:12px;line-height:16px;padding:0 6px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dwb-cp-more{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l1)}
.dwb-cp-line{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-cp-line svg{flex:none;margin-top:2px}
.dwb-cp-line[data-tone=warning] svg{color:var(--dsw-alias-state-warn-primary)}
.dwb-cp-result{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dwb-cp-result svg{flex:none}
.dwb-cp-result[data-tone=success] svg{color:var(--dsw-alias-state-success-primary)}
.dwb-cp-result[data-tone=error] svg{color:var(--dsw-alias-state-error-primary)}
.dwb-cp-foot{display:flex;align-items:center;gap:8px;width:100%}
.dwb-cp-foot-note{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-cp-foot>button{flex:none;white-space:nowrap}
`

/** 窗口重新获得焦点时作废 list（另一个窗口可能恢复过）；返回移除函数（没有 window 的环境是 no-op）。 */
function mountCheckpointsFocusReload(reload) {
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
 * 挂载本功能的界面（插件页里这一行开着时调用）：图标排条目、轮次末尾的小按钮、行配置页、
 * 样式，和数据层的作废时机（一轮结束、窗口重新获得焦点、连接重置）。
 * @param {{ctx: object, store: object, t: Function}} app 入口上下文。
 * @param {{fetch?: Function}} [options] 测试注入的 fetch。
 * @returns {() => void} 撤销函数：这一行关掉时调用，撤掉本功能注册的全部界面。
 */
export function applyCheckpoints(app, { fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const { ctx } = app
  const api = createCheckpointsApi(fetchImpl)
  const disposers = [mountModuleStyle('dsh-workbench-checkpoints', CHECKPOINTS_CSS)]
  const keep = (dispose) => { disposers.push(dispose) }
  keep(ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    // 排在「重新生成」「编辑消息」（rerun，order 20）后面；官方点赞点踩是 10。
    { name: 'conversation.chat.assistant-actions', id: 'dsh-workbench-checkpoints', order: 30, locale: '@miint-sunny/dsh-workbench' },
    (props) => h(CheckpointsAction, { app, api, ...props }))))
  keep(ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    // 排在官方交付物、计划、日程、动作卡片（0、20）和收尾框（20）后面。
    { name: 'conversation.chat.turnTail', id: 'dsh-workbench-checkpoints', order: 90, locale: '@miint-sunny/dsh-workbench' },
    (props) => h(CheckpointsTail, { app, api, ...props }))))
  keep(ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    { name: 'plugins.row.config', key: '@miint-sunny/dsh-workbench#dsh-workbench-checkpoints', locale: '@miint-sunny/dsh-workbench' },
    (props) => h(CheckpointsConfigEntry, { app, api, ...props }))))
  keep(ctx.effect(() => ctx.on('connection/reset', () => { api.invalidate() }), '@miint-sunny/dsh-workbench/checkpoints: refetch on reconnect'))
  keep(mountCheckpointsFocusReload(() => { api.invalidate() }))
  keep(ctx.effect(() => startCheckpointsRunWatcher({
    getSnapshot: () => ctx.uiSession.sessionStatus.getSnapshot(),
    subscribe: (listener) => ctx.uiSession.sessionStatus.subscribe(listener),
    onStopped: (sessionId) => { api.invalidate(sessionId) },
  }), '@miint-sunny/dsh-workbench/checkpoints: refetch when a turn ends'))
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

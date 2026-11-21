/**
 * 闲时压缩和工作线的判断。纯函数，不碰定时器和官方服务，结果都带原因，页面和日志用同一个词。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */

const declined = reason => ({ arm: false, reason })
const skipped = reason => ({ go: false, reason })
const held = reason => ({ compact: false, reason })

/**
 * 一轮结束时要不要开定时器。
 * @param {{allowed: boolean, root: boolean, status: string, turnKind: string|null, idle: number|null, work: number|null, used: number|null}} input 会话的当前状态和设置。
 * @returns {{arm: boolean, reason: string}} 原因是 excluded、subagent、off、never、running、turn-failed、below 或 armed。
 */
export function armDecision({ allowed, root, status, turnKind, idle, work, used }) {
  if (!allowed) return declined('excluded')
  if (!root) return declined('subagent')
  if (idle === null) return declined('off')
  if (work !== null && idle >= work) return declined('never')
  if (status !== 'idle') return declined('running')
  if (turnKind !== 'completed') return declined('turn-failed')
  if (used === null || used < idle) return declined('below')
  return { arm: true, reason: 'armed' }
}

/**
 * 定时器到点时要不要压。排队的情况带 wait，由调用方稍后再判断。
 * @param {object} input status、inbox（待处理消息数）、activity（session-activity 的结果）、now、dueAt、lateMs、cooldownUntil、busy、idle、used、compactable、minCompactable。
 * @returns {{go: boolean, reason: string, wait?: boolean}} 原因是 running、inbox、activity、slept、cooldown、queue、below、small 或 go。
 */
export function fireDecision({ status, inbox, activity, now, dueAt, lateMs, cooldownUntil, busy, idle, used, compactable, minCompactable }) {
  if (status !== 'idle') return skipped('running')
  if (inbox > 0) return skipped('inbox')
  if (activity.some(item => item.kind !== 'schedule')) return skipped('activity')
  if (now > dueAt + lateMs) return skipped('slept')
  if (cooldownUntil > now) return skipped('cooldown')
  if (busy) return { go: false, reason: 'queue', wait: true }
  if (used === null || used < idle) return skipped('below')
  if (compactable < minCompactable) return skipped('small')
  return { go: true, reason: 'go' }
}

/**
 * App 重启后怎么接着算。定时器不存盘，按日志里上一轮结束的时间推。
 * @param {{endedAt: number, now: number, idleMinutes: number, lateMs: number}} input 上一轮结束时间、当前时间、空闲时长和迟到容忍。
 * @returns {{action: 'wait'|'fire'|'stale', dueAt?: number}} 没到点等，刚过点照常判断，过久不压。
 */
export function resumeDecision({ endedAt, now, idleMinutes, lateMs }) {
  const dueAt = endedAt + idleMinutes * 60_000
  if (now < dueAt) return { action: 'wait', dueAt }
  if (now <= dueAt + lateMs) return { action: 'fire', dueAt }
  return { action: 'stale' }
}

/**
 * 下一步开始前要不要按工作线压。线不低于官方线时交给官方。
 * @param {{allowed: boolean, root: boolean, line: number|null, official: number|null, used: number|null, failedThisTurn: boolean}} input 会话状态、选的线、官方线和这一轮有没有失败过。
 * @returns {{compact: boolean, reason: string}} 原因是 off、excluded、subagent、official、failed-this-turn、below 或 over。
 */
export function workLineDecision({ allowed, root, line, official, used, failedThisTurn }) {
  if (line === null) return held('off')
  if (!allowed) return held('excluded')
  if (!root) return held('subagent')
  if (official !== null && line >= official) return held('official')
  if (failedThisTurn) return held('failed-this-turn')
  if (used === null || used < line) return held('below')
  return { compact: true, reason: 'over' }
}

/**
 * 官方自动压缩的线，公式和 dsh-compaction-basic 的 resolveCompactSpec 相同。
 * @param {{window: number|null, output: number|null, thresholdRatio: number, headroomTokens: number}} input 窗口、输出预留和官方配置。
 * @returns {number|null} token 数；窗口或输出预留未知时是 null。
 */
export function officialLine({ window, output, thresholdRatio, headroomTokens }) {
  if (window === null || window === undefined || output === null || output === undefined) return null
  return Math.max(0, Math.floor(Math.min(window * thresholdRatio, window - output - headroomTokens)))
}

/**
 * 工作线压缩时留下的尾部。
 * @param {{line: number, window: number|null, output: number|null, ratio: number, divisor: number}} input 线、窗口、输出预留、官方保留比例和线的除数。
 * @returns {number} 留下的 token 数。
 */
export function retainTokens({ line, window, output, ratio, divisor }) {
  const byLine = Math.floor(line / divisor)
  if (window === null || window === undefined || output === null || output === undefined) return byLine
  return Math.min(Math.floor((window - output) * ratio), byLine)
}

/**
 * 下拉里列的档位。有官方线时列到线以下的最后一档，没有时列到 max。
 * @param {{line: number|null, step: number, min: number, max?: number}} input 官方线、一档的大小、最低档和没有官方线时的上限。
 * @returns {number[]} 从小到大的档位。
 */
export function tierOptions({ line, step, min, max }) {
  const tiers = []
  for (let tier = min; line === null ? tier <= max : tier < line; tier += step) tiers.push(tier)
  return tiers
}

/**
 * 选要压的范围，规则和官方 selectCompactableRange 相同：留够尾部，切点不拆工具调用。
 * @param {{nodes: {seq: number, tokens: number}[], firstIndex: number, retain: number, balancedBefore: function(number): boolean}} input 计过价的节点、第一个可压的下标、尾部大小和切点检查。
 * @returns {{start: number, end: number}|null} 要压的第一个和最后一个 seq，压不出东西时是 null。
 */
export function selectRegion({ nodes, firstIndex, retain, balancedBefore }) {
  if (nodes.length === 0) return null
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens
    keepFrom = index
    if (accumulated >= retain) break
  }
  if (keepFrom <= firstIndex) return null
  while (keepFrom > firstIndex && !balancedBefore(nodes[keepFrom].seq)) keepFrom -= 1
  if (keepFrom <= firstIndex) return null
  return { start: nodes[firstIndex].seq, end: nodes[keepFrom - 1].seq }
}

/**
 * 判断压缩失败是不是限流。限流要全局冷却，其它失败只影响这个会话。
 * @param {unknown} error 官方 compactNow 抛出的错误或 compaction/end 带的错误。
 * @returns {'rate'|'other'} 分类。
 */
export function classifyFailure(error) {
  if (error?.status === 429) return 'rate'
  const text = String(error?.message ?? '')
  return /\b429\b|overload|capacity|rate.?limit|too many requests/i.test(text) ? 'rate' : 'other'
}

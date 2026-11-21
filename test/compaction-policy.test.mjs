import test from 'node:test'
import assert from 'node:assert/strict'
import {
  armDecision,
  classifyFailure,
  fireDecision,
  officialLine,
  resumeDecision,
  retainTokens,
  selectRegion,
  tierOptions,
  workLineDecision,
} from '../lib/compaction-policy.js'

const armBase = { allowed: true, root: true, status: 'idle', turnKind: 'completed', idle: 300_000, work: null, used: 350_000 }
const arm = patch => armDecision({ ...armBase, ...patch })

test('一轮正常结束、超过阈值时开定时器', () => {
  assert.deepEqual(arm({}), { arm: true, reason: 'armed' })
})

test('预设不在名单不压', () => {
  assert.deepEqual(arm({ allowed: false }), { arm: false, reason: 'excluded' })
})

test('子代理不压', () => {
  assert.deepEqual(arm({ root: false }), { arm: false, reason: 'subagent' })
})

test('空闲压缩关闭时不开定时器，这是默认', () => {
  assert.deepEqual(arm({ idle: null }), { arm: false, reason: 'off' })
})

test('空闲阈值不低于工作线时不会触发', () => {
  assert.deepEqual(arm({ idle: 300_000, work: 300_000 }), { arm: false, reason: 'never' })
  assert.deepEqual(arm({ idle: 400_000, work: 300_000 }), { arm: false, reason: 'never' })
  assert.deepEqual(arm({ idle: 200_000, work: 300_000 }), { arm: true, reason: 'armed' })
})

test('运行中、等审批、等回答都是 running，不开定时器', () => {
  assert.deepEqual(arm({ status: 'running' }), { arm: false, reason: 'running' })
})

test('上一轮出错或被停止，不开定时器', () => {
  for (const turnKind of ['failed', 'cancelled', 'error', null]) assert.deepEqual(arm({ turnKind }), { arm: false, reason: 'turn-failed' })
})

test('没到阈值不开定时器，刚好到阈值算到了', () => {
  assert.deepEqual(arm({ used: 299_999 }), { arm: false, reason: 'below' })
  assert.deepEqual(arm({ used: 300_000 }), { arm: true, reason: 'armed' })
})

test('用量未知不开定时器', () => {
  assert.deepEqual(arm({ used: null }), { arm: false, reason: 'below' })
})

const NOW = 1_000_000_000
const fireBase = { status: 'idle', inbox: 0, activity: [], now: NOW, dueAt: NOW, lateMs: 300_000, cooldownUntil: 0, busy: false, idle: 300_000, used: 350_000, compactable: 200_000, minCompactable: 20_000 }
const fire = patch => fireDecision({ ...fireBase, ...patch })

test('到点、空闲、够大时压缩', () => {
  assert.deepEqual(fire({}), { go: true, reason: 'go' })
})

test('到点时又在跑或有待处理消息，不压', () => {
  assert.deepEqual(fire({ status: 'running' }), { go: false, reason: 'running' })
  assert.deepEqual(fire({ inbox: 1 }), { go: false, reason: 'inbox' })
})

test('后台任务、子代理在跑算不空闲，只排着的自动化任务不算', () => {
  assert.deepEqual(fire({ activity: [{ kind: 'job' }] }), { go: false, reason: 'activity' })
  assert.deepEqual(fire({ activity: [{ kind: 'subagent' }] }), { go: false, reason: 'activity' })
  assert.deepEqual(fire({ activity: [{ kind: 'turn' }] }), { go: false, reason: 'activity' })
  assert.deepEqual(fire({ activity: [{ kind: 'schedule' }] }), { go: true, reason: 'go' })
})

test('电脑休眠过、定时器醒来晚了，不压不补', () => {
  assert.deepEqual(fire({ now: NOW + 300_001 }), { go: false, reason: 'slept' })
  assert.deepEqual(fire({ now: NOW + 300_000 }), { go: true, reason: 'go' })
})

test('429 冷却期内不压', () => {
  assert.deepEqual(fire({ cooldownUntil: NOW + 1 }), { go: false, reason: 'cooldown' })
  assert.deepEqual(fire({ cooldownUntil: NOW }), { go: true, reason: 'go' })
})

test('别的会话正在压时排队，不算放弃', () => {
  assert.deepEqual(fire({ busy: true }), { go: false, reason: 'queue', wait: true })
})

test('量过之后低于阈值不压，可压缩部分太少也不压', () => {
  assert.deepEqual(fire({ used: 299_000 }), { go: false, reason: 'below' })
  assert.deepEqual(fire({ compactable: 19_999 }), { go: false, reason: 'small' })
  assert.deepEqual(fire({ compactable: 20_000 }), { go: true, reason: 'go' })
})

test('App 重启后：没到点的接着等，超过的不压', () => {
  const minute = 60_000
  assert.deepEqual(resumeDecision({ endedAt: NOW - 10 * minute, now: NOW, idleMinutes: 30, lateMs: 5 * minute }), { action: 'wait', dueAt: NOW + 20 * minute })
  assert.deepEqual(resumeDecision({ endedAt: NOW - 31 * minute, now: NOW, idleMinutes: 30, lateMs: 5 * minute }), { action: 'fire', dueAt: NOW - minute })
  assert.deepEqual(resumeDecision({ endedAt: NOW - 36 * minute, now: NOW, idleMinutes: 30, lateMs: 5 * minute }), { action: 'stale' })
})

const workBase = { allowed: true, root: true, line: 400_000, official: 550_464, used: 410_000, failedThisTurn: false }
const work = patch => workLineDecision({ ...workBase, ...patch })

test('工作线：到线就在下一步前压', () => {
  assert.deepEqual(work({}), { compact: true, reason: 'over' })
  assert.deepEqual(work({ used: 400_000 }), { compact: true, reason: 'over' })
})

test('工作线：关闭、名单外、子代理、没到线都不压', () => {
  assert.equal(work({ line: null }).reason, 'off')
  assert.equal(work({ allowed: false }).reason, 'excluded')
  assert.equal(work({ root: false }).reason, 'subagent')
  assert.equal(work({ used: 399_999 }).reason, 'below')
  assert.equal(work({ used: null }).reason, 'below')
})

test('工作线：高于官方线的交给官方', () => {
  assert.equal(work({ line: 600_000, used: 620_000 }).reason, 'official')
})

test('工作线：这一轮失败过就不再试', () => {
  assert.equal(work({ failedThisTurn: true }).reason, 'failed-this-turn')
})

test('官方线按官方公式算', () => {
  assert.equal(officialLine({ window: 1_000_000, output: 384_000, thresholdRatio: 0.8, headroomTokens: 65_536 }), 550_464)
  assert.equal(officialLine({ window: 1_000_000, output: 256_000, thresholdRatio: 0.8, headroomTokens: 65_536 }), 678_464)
  assert.equal(officialLine({ window: 1_000_000, output: null, thresholdRatio: 0.8, headroomTokens: 65_536 }), null)
  assert.equal(officialLine({ window: null, output: 256_000, thresholdRatio: 0.8, headroomTokens: 65_536 }), null)
})

test('保留量取官方比例和线的五分之一里小的', () => {
  assert.equal(retainTokens({ line: 400_000, window: 1_000_000, output: 384_000, ratio: 0.16, divisor: 5 }), 80_000)
  assert.equal(retainTokens({ line: 800_000, window: 1_000_000, output: 384_000, ratio: 0.16, divisor: 5 }), 98_560)
  assert.equal(retainTokens({ line: 400_000, window: null, output: null, ratio: 0.16, divisor: 5 }), 80_000)
})

test('档位：100K 一档，到线以下的最后一档', () => {
  assert.deepEqual(tierOptions({ line: 550_464, step: 100_000, min: 100_000 }), [100_000, 200_000, 300_000, 400_000, 500_000])
  assert.deepEqual(tierOptions({ line: 678_464, step: 100_000, min: 100_000 }), [100_000, 200_000, 300_000, 400_000, 500_000, 600_000])
  assert.deepEqual(tierOptions({ line: 500_000, step: 100_000, min: 100_000 }), [100_000, 200_000, 300_000, 400_000])
})

test('档位：没有官方线时给固定上限', () => {
  assert.deepEqual(tierOptions({ line: null, step: 100_000, min: 100_000, max: 300_000 }), [100_000, 200_000, 300_000])
})

const nodes = [
  { seq: 0, tokens: 100 },
  { seq: 1, tokens: 500 },
  { seq: 2, tokens: 500 },
  { seq: 3, tokens: 500 },
  { seq: 4, tokens: 500 },
]

test('选范围：留够尾部，不碰开头的系统提示词', () => {
  const region = selectRegion({ nodes, firstIndex: 1, retain: 900, balancedBefore: () => true })
  assert.deepEqual(region, { start: 1, end: 2 })
})

test('选范围：切点不拆工具调用，往前退', () => {
  const region = selectRegion({ nodes, firstIndex: 1, retain: 900, balancedBefore: seq => seq !== 3 })
  assert.deepEqual(region, { start: 1, end: 1 })
})

test('选范围：压不出东西时返回 null', () => {
  assert.equal(selectRegion({ nodes, firstIndex: 1, retain: 5_000, balancedBefore: () => true }), null)
  assert.equal(selectRegion({ nodes, firstIndex: 1, retain: 900, balancedBefore: () => false }), null)
  assert.equal(selectRegion({ nodes: [], firstIndex: 0, retain: 0, balancedBefore: () => true }), null)
})

test('429 和过载算限流，要冷却；其它失败不算', () => {
  assert.equal(classifyFailure({ status: 429 }), 'rate')
  assert.equal(classifyFailure(new Error('the cell is at capacity')), 'rate')
  assert.equal(classifyFailure(new Error('HTTP 429 Too Many Requests')), 'rate')
  assert.equal(classifyFailure(new Error('model overloaded')), 'rate')
  assert.equal(classifyFailure(new Error('stream idle timeout after 300000ms')), 'other')
  assert.equal(classifyFailure(undefined), 'other')
})

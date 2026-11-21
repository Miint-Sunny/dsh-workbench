/**
 * 计划全文行的网页端测试：视图状态（待审/已同意、长文限高）、事件定义（match 认官方
 * submittedPlan 的三种事件、buildViewNode 的位置和可见性）、待审时回复的发送顺序
 * （先排队、后取消，两步都成功才算发出）、取消失败的提示、不是待审时行为不变、
 * 词典和挂载撤销。数据形状照 0.2.2-rc.1 dsh-client-ui-plan 的 submittedPlan
 * （{callId, markdown, title}，title 是首个 # 标题）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_ZH, PLAN_EN, planViewState, planRollupState, planOutcomeOf, applyPlan, submittedPlanOf, planDefinition,
} from '../src/client/plan.js'
import { replyMessageText, sendReply, pendingPlanReview } from '../src/client/reply.js'

const planOf = (over = {}) => ({
  callId: 'call-1', title: '茶室计划', markdown: '# 茶室计划\n\n一、现状\n平整地面。', ...over,
})

// ---------- 计划的结果（照 0.2.2-rc.1 会话日志里真实的 tool/result 文案） ----------

/** 一轮里的节点：locations.getTurn 给键，nodes.get 给节点，和 ChatSnapshot 同形。 */
const chatOf = (turn, nodes) => ({
  locations: { getTurn: number => (number === turn ? nodes.map((_, at) => `k${at}`) : []) },
  nodes: { get: key => nodes[Number(key.slice(1))] },
})
const called = callId => ({ kind: 'tool-call', data: { root: { phase: 'start', callId } } })
const settled = (callId, text, isError = false) => ({
  kind: 'tool-call',
  data: { root: { kind: 'tool-result', callId, isError, content: [{ type: 'text', text }] } },
})
const APPROVED = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const DISMISSED = 'The user dismissed the plan review to reply in their own words; plan mode remains active.'

test('planOutcomeOf：还没有结果是 open，同意是 approved', () => {
  assert.equal(planOutcomeOf(chatOf(3, [called('c1')]), 3, 'c1'), 'open')
  assert.equal(planOutcomeOf(chatOf(3, [settled('c1', APPROVED)]), 3, 'c1'), 'approved')
})

test('planOutcomeOf：要求修改、继续计划、出错、被打断都不算同意，不能显示已批准', () => {
  assert.equal(planOutcomeOf(chatOf(3, [settled('c1', DISMISSED)]), 3, 'c1'), 'closed')
  assert.equal(planOutcomeOf(chatOf(3, [settled('c1', 'The user chose to keep planning; revise the plan and present it again.', true)]), 3, 'c1'), 'closed')
  assert.equal(planOutcomeOf(chatOf(3, [settled('c1', 'Error: unknown tool "exit_plan_mode"', true)]), 3, 'c1'), 'closed')
  const interrupted = { kind: 'tool-call', data: { root: { kind: 'tool-result', callId: 'c1', isError: true, content: [] } } }
  assert.equal(planOutcomeOf(chatOf(3, [interrupted]), 3, 'c1'), 'closed')
})

test('planOutcomeOf：只认这一次调用；同一轮别的工具和别的计划不串', () => {
  const nodes = [{ kind: 'assistant-step', data: {} }, settled('c0', DISMISSED), called('c1')]
  assert.equal(planOutcomeOf(chatOf(3, nodes), 3, 'c1'), 'open')
  assert.equal(planOutcomeOf(chatOf(3, nodes), 3, 'c0'), 'closed')
})

test('planOutcomeOf：这一轮找不到调用时不说待审也不说已批准', () => {
  assert.equal(planOutcomeOf(chatOf(3, []), 3, 'c1'), 'closed')
  assert.equal(planOutcomeOf(chatOf(3, [called('c1')]), 4, 'c1'), 'closed')
})

test('planViewState：待审和已批准有状态，其余没有状态词', () => {
  assert.deepEqual(planViewState('open', true), { key: 'plan.state.pending', tone: 'pending' })
  assert.deepEqual(planViewState('approved', false), { key: 'plan.state.approved', tone: 'approved' })
  assert.equal(planViewState('open', false), undefined, '没在等审阅的未结束调用（比如还在往后走）不写状态')
  assert.equal(planViewState('closed', true), undefined, '上一份被要求修改的计划，新计划待审时也不能跟着显示待审')
  assert.equal(planViewState('closed', false), undefined)
})

test('planRollupState：短计划不收起也没有按钮；长计划先收起，展开后按钮还在', () => {
  assert.deepEqual(planRollupState(404, false), { collapsed: false, showsToggle: false }, '样稿第一节那份短计划不收')
  assert.deepEqual(planRollupState(650, false), { collapsed: true, showsToggle: true }, '样稿第四节那份长计划要收')
  assert.deepEqual(planRollupState(650, true), { collapsed: false, showsToggle: true })
})

test('中英文词典的键一样', () => {
  assert.deepEqual(Object.keys(PLAN_EN).sort(), Object.keys(PLAN_ZH).sort())
})

// ---------- 发送回复（官方 PendingQuestion 的 dismissal、dismiss 同名同义） ----------

/** 假的等待中审阅；dismiss 记下被调用，可以让它失败（官方失败时是 reject）。 */
function reviewOf(calls, { dismissal = 'cancel', fails = false } = {}) {
  return {
    kind: 'plan-review',
    dismissal,
    dismiss: async () => {
      calls.push('dismiss')
      if (fails) throw new Error('no channel accepts a cancellation yet')
    },
  }
}
const queueOf = (calls, failure) => async () => { calls.push('queue'); return failure }

test('pendingPlanReview：只认计划审阅，审批和普通提问不算', () => {
  const review = { kind: 'plan-review' }
  assert.equal(pendingPlanReview({ pendingInteraction: review }), review)
  assert.equal(pendingPlanReview({ pendingInteraction: { kind: 'question' } }), undefined)
  assert.equal(pendingPlanReview({ pendingInteraction: { kind: 'approval' } }), undefined)
  assert.equal(pendingPlanReview({ pendingInteraction: undefined }), undefined)
  assert.equal(pendingPlanReview(undefined), undefined)
})

test('不是待审：行为不变，只排队一次，不碰取消', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: undefined, alreadyQueued: false, queue: queueOf(calls) }), { state: 'sent' })
  assert.deepEqual(calls, ['queue'])
})

test('不是待审时排队失败：把原因带回去', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: undefined, alreadyQueued: false, queue: queueOf(calls, '和 DSH 的连接已断开') }), { state: 'unsent', reason: '和 DSH 的连接已断开' })
})

test('待审：先排队、后取消，两步都成功才算发出', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: reviewOf(calls), alreadyQueued: false, queue: queueOf(calls) }), { state: 'sent' })
  assert.deepEqual(calls, ['queue', 'dismiss'])
})

test('待审时排队失败：不取消，审阅还在，返回排队失败的原因', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: reviewOf(calls), alreadyQueued: false, queue: queueOf(calls, '和 DSH 的连接已断开') }), { state: 'unsent', reason: '和 DSH 的连接已断开' })
  assert.deepEqual(calls, ['queue'])
})

test('取消失败：回复已排队但模型没收到，不能算发出', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: reviewOf(calls, { fails: true }), alreadyQueued: false, queue: queueOf(calls) }), { state: 'queued' })
  assert.deepEqual(calls, ['queue', 'dismiss'])
})

test('取消失败后再发：只重试取消，不再排一遍（不然模型收到两条）', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: reviewOf(calls), alreadyQueued: true, queue: queueOf(calls) }), { state: 'sent' })
  assert.deepEqual(calls, ['dismiss'])
})

test('取消失败后审阅已经结束（用户点了官方按钮）：排着的回复会送达，不再发一遍', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: undefined, alreadyQueued: true, queue: queueOf(calls) }), { state: 'sent' })
  assert.deepEqual(calls, [])
})

test('面板关掉只是收起（dismissal hide）时取消不了：一步都不做，不留一条送不到的消息', async () => {
  const calls = []
  assert.deepEqual(await sendReply({ review: reviewOf(calls, { dismissal: 'hide' }), alreadyQueued: false, queue: queueOf(calls) }), { state: 'blocked' })
  assert.deepEqual(calls, [])
})

test('排队发出去的文字就是引用回复的格式', () => {
  assert.equal(replyMessageText('搭木架子', '换镀锌钢'), '> 搭木架子\n\n换镀锌钢')
})

// ---------- 事件定义（照官方 submittedPlan 认的三种事件；内容走 turnDataSource，不自己解析） ----------

/** 会话日志里的提交计划事件；tool/call 的 arguments 是 JSON 字符串，PTC 的是对象。 */
const callEvent = ({ seq = 12, ...dataOver } = {}) => ({
  type: 'tool/call', seq, data: { name: 'exit_plan_mode', callId: 'call-1', arguments: JSON.stringify({ plan: '# 茶室计划\n\n一、现状' }), ...dataOver },
})
const ptcStartEvent = (over = {}) => ({
  type: 'tool/ptc-dispatch-start', seq: 13,
  data: { rootCallId: 'run-1', parentCallId: 'run-1', subCallId: 'run-1:ptc:1', name: 'exit_plan_mode', arguments: { plan: '# 茶室计划' }, ...over },
})
const ptcSettleEvent = (over = {}) => ({
  type: 'tool/ptc-dispatch', seq: 20,
  data: { ...ptcStartEvent().data, isError: false, content: [{ type: 'text', text: 'Plan approved' }], ...over },
})

test('submittedPlanOf：官方认的三种事件都认，tool/call 的字符串 arguments 也解开', () => {
  assert.deepEqual(submittedPlanOf(callEvent()), { callId: 'call-1', markdown: '# 茶室计划\n\n一、现状', title: '茶室计划' })
  assert.deepEqual(submittedPlanOf(ptcStartEvent()), { callId: 'run-1:ptc:1', markdown: '# 茶室计划', title: '茶室计划' })
  assert.deepEqual(submittedPlanOf(ptcSettleEvent()), { callId: 'run-1:ptc:1', markdown: '# 茶室计划', title: '茶室计划' })
})

test('submittedPlanOf：别的工具、别的类型、坏参数、没有 # 标题的计划都不算', () => {
  assert.equal(submittedPlanOf(callEvent({ name: 'wrap_up', callId: 'c', arguments: '{}' })), undefined)
  assert.equal(submittedPlanOf({ type: 'tool/result', data: {} }), undefined)
  assert.equal(submittedPlanOf(callEvent({ name: 'exit_plan_mode', callId: 'c', arguments: '{坏的' })), undefined)
  assert.equal(submittedPlanOf(callEvent({ name: 'exit_plan_mode', callId: 'c', arguments: JSON.stringify({ plan: '没有标题的计划' }) })), undefined)
  assert.equal(submittedPlanOf(callEvent({ name: 'exit_plan_mode', callId: '', arguments: JSON.stringify({ plan: '# 有' }) })), undefined)
})

test('match：tool/call 和 ptc-dispatch-start 是 start，ptc-dispatch 是 update，别的返回 null', () => {
  assert.deepEqual(planDefinition.match(callEvent()), { id: 'call-1', role: 'start' })
  assert.deepEqual(planDefinition.match(ptcStartEvent()), { id: 'run-1:ptc:1', role: 'start' })
  assert.deepEqual(planDefinition.match(ptcSettleEvent()), { id: 'run-1:ptc:1', role: 'update' })
  assert.equal(planDefinition.match(callEvent({ name: 'wrap_up', callId: 'c', arguments: '{}' })), null)
})

test('match 只认身份，不把计划正文放进状态：start 返回的只有 callId', () => {
  // 引擎给 start/update 的 match 带 event 和 location（conversationMatch 的形状），match() 只返回 id 和角色。
  const event = callEvent()
  const match = { ...planDefinition.match(event), event, location: { kind: 'turn', turn: { turn: 3, status: 'open' } } }
  assert.deepEqual(planDefinition.start({}, match), { callId: 'call-1' })
})

test('buildViewNode：紧跟提交计划事件的位置、可见、站在轮这一级；正文只带 callId', () => {
  const start = { event: callEvent({ seq: 42 }), location: { kind: 'step', turn: { turn: 3, status: 'open' }, step: { step: 2 } } }
  assert.deepEqual(planDefinition.buildViewNode({
    key: 'k1', id: 'call-1', start, matches: [start], state: { callId: 'call-1' },
  }), {
    key: 'k1', id: 'call-1', kind: 'dsh-workbench-plan', target: 'chat',
    anchorSeq: 42, location: start.location, groupTree: 'turn', visibility: 'visible', data: { callId: 'call-1' },
  })
})

test('buildViewNode：还没有 start 时不给节点', () => {
  assert.equal(planDefinition.buildViewNode({ key: 'k1', id: 'call-1', start: undefined, matches: [], state: undefined }), null)
})

// ---------- 挂载与撤销（假的 slots，照 features.test 的路数） ----------

/**
 * 假的 cordis 客户端上下文：收下 inject 的注册和事件定义，登记能查回；effect 收注销函数，
 * disposeAll 全部执行对应这一行在插件页里关掉。
 */
function fakeClientContext() {
  const disposers = []
  const registered = []
  const definitions = []
  return {
    effect(body) {
      const dispose = body()
      disposers.push(dispose)
      return () => { const at = disposers.indexOf(dispose); if (at >= 0) disposers.splice(at, 1) }
    },
    slots: {
      // 真的 inject 返回撤销函数；这里撤销就是从 registered 里拿掉这一项。
      inject(name, mount) {
        const registration = { name, value: mount() }
        registered.push(registration)
        return () => { const at = registered.indexOf(registration); if (at >= 0) registered.splice(at, 1) }
      },
      register(entry, component) {
        return { entry, component }
      },
    },
    uiConversation: {
      events: {
        register(definition) {
          definitions.push(definition)
          return () => { const at = definitions.indexOf(definition); if (at >= 0) definitions.splice(at, 1) }
        },
      },
    },
    document: undefined,
    registered,
    definitions,
    disposeAll() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

test('挂载：事件定义一项、conversation.chat.node 一项（key 和 kind 相同），不再注册 turnTail；撤销后全部撤掉', () => {
  const ctx = fakeClientContext()
  const app = { ctx, t: key => key }
  const dispose = applyPlan(app)
  assert.deepEqual(ctx.definitions, [planDefinition])
  const registrations = ctx.registered.filter(item => item.name === 'conversation.chat.node')
  assert.equal(registrations.length, 1)
  assert.equal(ctx.registered.filter(item => item.name === 'conversation.chat.turnTail').length, 0, 'turnTail 那一项返工时删掉了')
  const { inject, ...entry } = registrations[0].value.entry
  assert.deepEqual(entry, { name: 'conversation.chat.node', key: 'dsh-workbench-plan', locale: '@miint-sunny/dsh-workbench' })
  assert.equal(typeof inject, 'function')
  dispose()
  assert.deepEqual(ctx.registered, [])
  assert.deepEqual(ctx.definitions, [])
})

test('keyedHooks.plans 和官方计划卡片同一个数据源：turnDataSource(轮次号, submitted-plan)；sessionId 也跟着进来', () => {
  const asked = []
  const source = { getSnapshot: () => [planOf()], subscribe: () => () => {} }
  const chat = { getSnapshot: () => ({ nodes: { turnDataSource: (turn, kind) => { asked.push([turn, kind]); return source } } }) }
  const binding = { sessionId: 's1' }
  const ctx = fakeClientContext()
  ctx.sessions = { binding: id => (id === 's1' ? binding : undefined) }
  ctx.uiConversation.binding = owner => ({ target: name => (owner === binding && name === 'chat' ? chat : undefined) })
  applyPlan({ ctx, t: key => key })
  const { inject } = ctx.registered.find(item => item.name === 'conversation.chat.node').value.entry
  const face = inject('s1')
  assert.equal(face.sessionId, 's1')
  assert.equal(face.keyedHooks.plans('3'), source)
  assert.deepEqual(asked, [[3, 'submitted-plan']])
})

test('keyedHooks.plans：聊天快照还没有时不抛错（返回 undefined，行不显示）', () => {
  const binding = { sessionId: 's1' }
  const ctx = fakeClientContext()
  ctx.sessions = { binding: () => binding }
  ctx.uiConversation.binding = () => ({ target: () => ({ getSnapshot: () => undefined }) })
  applyPlan({ ctx, t: key => key })
  const { inject } = ctx.registered.find(item => item.name === 'conversation.chat.node').value.entry
  assert.equal(inject('s1').keyedHooks.plans('1'), undefined)
})

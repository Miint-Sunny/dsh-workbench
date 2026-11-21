/**
 * 重新生成和编辑重发的客户端纯函数测试：找轮次和提问、合并不能重发的原因、分叉再发送
 * 的几种结局、条目挂载和撤销。组件和真实分叉由 Claude 装进桌面端时看（这台机器跑不了
 * 模型对话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRerun, forkAndResend, mergeRerunAvailability, placeRerunPopover, rerunTarget } from '../src/client/rerun.js'

// ---------- 假的 ChatSnapshot（照 rc.5 ChatSnapshot/TurnLocation/聊天节点的形状） ----------

/** 一轮：turn-tail 里带最后一条助手消息的 messageId。 */
const turnOf = (number, { startSeq, tailMessageId }) => ({
  turn: number,
  start: startSeq === undefined ? undefined : { seq: startSeq },
  end: { seq: 99 },
  status: 'closed',
  steps: [],
  data: { get: key => (key === 'turn-tail' ? { closing: { finalNode: { messageId: tailMessageId } } } : undefined) },
})

/** 节点：kind 加 data（user/steering 的 data 是消息节点那几个字段）。 */
const chatNode = (kind, data) => ({ kind, data })

/** 快照：轮次表、轮次到节点键、节点表。 */
const snapshotOf = (turns, turnKeys, nodes) => ({
  timeline: { turnOrder: turns.map(turn => turn.turn), turns: new Map(turns.map(turn => [turn.turn, turn])) },
  locations: { getTurn: number => turnKeys.get(number) ?? [] },
  nodes: { get: key => nodes.get(key) },
})

/** 一个正常的快照：第 1 轮提问「把登录页的表单校验改成边输入边提示」，回答 m1。 */
function plainSnapshot() {
  const turns = [turnOf(1, { startSeq: 5, tailMessageId: 'm1' })]
  const nodes = new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '把登录页的表单校验改成边输入边提示' }] })],
    ['a1', chatNode('assistant-step', { status: 'settled' })],
  ])
  return snapshotOf(turns, new Map([[1, ['u1', 'a1']]]), nodes)
}

// ---------- rerunTarget ----------

test('rerunTarget: finds the turn by turn-tail messageId, forks before turn/start', () => {
  const snapshot = plainSnapshot()
  const found = rerunTarget(snapshot, 'm1')
  assert.equal(found.ok, true)
  assert.equal(found.forkAtSeq, 4)
  assert.equal(found.text, '把登录页的表单校验改成边输入边提示')
  assert.equal(found.turn.turn, 1)
  // 多轮时按 messageId 找对那一轮
  const turns = [turnOf(1, { startSeq: 5, tailMessageId: 'm1' }), turnOf(2, { startSeq: 20, tailMessageId: 'm2' })]
  const nodes = new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '第一轮' }] })],
    ['u2', chatNode('user', { seq: 21, content: [{ type: 'text', text: '第二轮' }] })],
  ])
  const second = rerunTarget(snapshotOf(turns, new Map([[1, ['u1']], [2, ['u2']]]), nodes), 'm2')
  assert.equal(second.ok, true)
  assert.equal(second.forkAtSeq, 19)
  assert.equal(second.text, '第二轮')
})

test('rerunTarget: notFound when the turn, its start, the question or the text is missing', () => {
  assert.deepEqual(rerunTarget(plainSnapshot(), '别的消息'), { ok: false, reason: 'notFound' })
  assert.deepEqual(rerunTarget(plainSnapshot(), ''), { ok: false, reason: 'notFound' })
  assert.deepEqual(rerunTarget(undefined, 'm1'), { ok: false, reason: 'notFound' })
  // 没有 turn.start（还没落定）或 start.seq 是 0（forkAtSeq 成 -1）：没有可用的分叉点
  const noStart = snapshotOf([turnOf(1, { tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '提问' }] })],
  ]))
  assert.deepEqual(rerunTarget(noStart, 'm1'), { ok: false, reason: 'notFound' })
  const zeroStart = snapshotOf([turnOf(1, { startSeq: 0, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '提问' }] })],
  ]))
  assert.deepEqual(rerunTarget(zeroStart, 'm1'), { ok: false, reason: 'notFound' })
  // 这一轮没有人写的提问（比如系统叫醒开的轮次，只有 context）
  const onlyContext = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['c1']]]), new Map([
    ['c1', chatNode('context', { seq: 6, content: [{ type: 'text', text: '醒来' }] })],
  ]))
  assert.deepEqual(rerunTarget(onlyContext, 'm1'), { ok: false, reason: 'notFound' })
  // 提问全是空白
  const blank = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '  \n ' }] })],
  ]))
  assert.deepEqual(rerunTarget(blank, 'm1'), { ok: false, reason: 'notFound' })
})

test('rerunTarget: attachments when the question has non-text blocks, references or skills', () => {
  const withImage = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '看这张图' }, { type: 'image', url: 'x' }] })],
  ]))
  assert.deepEqual(rerunTarget(withImage, 'm1'), { ok: false, reason: 'attachments' })
  const withFile = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'file', name: 'a.pdf' }] })],
  ]))
  assert.deepEqual(rerunTarget(withFile, 'm1'), { ok: false, reason: 'attachments' })
  const withReference = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '改成这样' }], referenceLabels: ['src/a.ts'] })],
  ]))
  assert.deepEqual(rerunTarget(withReference, 'm1'), { ok: false, reason: 'attachments' })
  const withSkill = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '用这个技能' }], skillNames: ['ego-browser'] })],
  ]))
  assert.deepEqual(rerunTarget(withSkill, 'm1'), { ok: false, reason: 'attachments' })
  // 多个 text 块拼在一起，照样是纯文本提问
  const twoTexts = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] })],
  ]))
  assert.equal(rerunTarget(twoTexts, 'm1').text, '第一段第二段')
})

test('rerunTarget: steered when the turn has mid-turn messages or two questions', () => {
  // 中途插过话：同一轮里有 steering 节点（rc.5 里插话是 'steering'，提问是 'user'）
  const steered = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1', 's1']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '提问' }] })],
    ['s1', chatNode('steering', { seq: 8, content: [{ type: 'text', text: '插话' }] })],
  ]))
  assert.deepEqual(rerunTarget(steered, 'm1'), { ok: false, reason: 'steered' })
  // 两个 user 节点（不该出现，出现也不猜着挑一个）
  const twice = snapshotOf([turnOf(1, { startSeq: 5, tailMessageId: 'm1' })], new Map([[1, ['u1', 'u2']]]), new Map([
    ['u1', chatNode('user', { seq: 6, content: [{ type: 'text', text: '提问一' }] })],
    ['u2', chatNode('user', { seq: 7, content: [{ type: 'text', text: '提问二' }] })],
  ]))
  assert.deepEqual(rerunTarget(twice, 'm1'), { ok: false, reason: 'steered' })
})

// ---------- mergeRerunAvailability ----------

test('mergeRerunAvailability: turn reasons beat forking permission, which beats running', () => {
  const ok = { ok: true, turn: { turn: 1 }, forkAtSeq: 4, text: '提问' }
  assert.equal(mergeRerunAvailability(ok, { running: false, forkAllowed: true }), ok)
  assert.deepEqual(mergeRerunAvailability(ok, { running: true, forkAllowed: true }), { ok: false, reason: 'running' })
  assert.deepEqual(mergeRerunAvailability(ok, { running: true, forkAllowed: false }), { ok: false, reason: 'noFork' })
  assert.deepEqual(mergeRerunAvailability(ok, { running: false, forkAllowed: false }), { ok: false, reason: 'noFork' })
  // 轮次本身的原因（插话、附件）等会话结束也救不了，先于环境原因报
  assert.deepEqual(mergeRerunAvailability({ ok: false, reason: 'steered' }, { running: true, forkAllowed: false }), { ok: false, reason: 'steered' })
  assert.deepEqual(mergeRerunAvailability({ ok: false, reason: 'attachments' }, { running: true, forkAllowed: true }), { ok: false, reason: 'attachments' })
  assert.deepEqual(mergeRerunAvailability({ ok: false, reason: 'notFound' }, { running: false, forkAllowed: true }), { ok: false, reason: 'notFound' })
})

// ---------- forkAndResend ----------

/** 子会话继承来的排队消息：一条用户的原提问。 */
const INHERITED_ORIGINAL = { 'next-turn': [{ id: 'q-original', source: { kind: 'user' } }], 'next-step': [] }

/**
 * 假的依赖：记下每个动作，按 overrides 决定成败。
 * inbox 是子会话载入后的 inbox 投影值（默认空队列）；inboxDelayMs 让它过几毫秒才载入
 * （之前读出 undefined）；inboxWaitMs 是 forkAndResend 等它的最长毫秒数。
 */
function rerunDeps(overrides = {}) {
  const calls = { fork: [], using: [], open: [], prompts: [], drafts: [], notices: [], archive: [], warns: [], queueUpdates: [], order: [] }
  const inboxListeners = new Set()
  let inboxValue = overrides.inboxDelayMs === undefined ? (overrides.inbox ?? { 'next-turn': [], 'next-step': [] }) : undefined
  if (overrides.inboxDelayMs !== undefined) {
    setTimeout(() => {
      inboxValue = overrides.inbox
      for (const listener of inboxListeners) listener()
    }, overrides.inboxDelayMs).unref()
  }
  const inboxFace = {
    getSnapshot: () => inboxValue,
    subscribe: listener => {
      inboxListeners.add(listener)
      return () => { inboxListeners.delete(listener) }
    },
  }
  const deps = {
    ...overrides.inboxWaitMs === undefined ? {} : { inboxWaitMs: overrides.inboxWaitMs },
    fork: async request => {
      calls.fork.push(request)
      if (overrides.forkError !== undefined) throw overrides.forkError
      return overrides.childId ?? 'child-1'
    },
    using: async (id, options, operation) => {
      calls.using.push({ id, options })
      const reference = {
        ready: Promise.resolve({}),
        binding: {
          ctx: { tag: 'child-ctx' },
          session: {
            projections: { faceOf: key => (key === 'inbox' ? inboxFace : undefined) },
            updateQueue: async (itemId, action) => {
              calls.queueUpdates.push({ id: itemId, action })
              calls.order.push('remove')
              if (overrides.updateQueueError !== undefined) throw overrides.updateQueueError
              return overrides.updateQueueResult ?? { ok: true }
            },
            prompt: async (content, mode) => {
              calls.prompts.push({ content, mode })
              calls.order.push('prompt')
              if (overrides.promptError !== undefined) throw overrides.promptError
              return overrides.promptResult ?? { ok: true, value: { accepted: true } }
            },
          },
        },
      }
      return operation(reference)
    },
    openSession: id => { calls.open.push(id) },
    archiveSession: async id => {
      calls.archive.push(id)
      if (overrides.archiveError !== undefined) throw overrides.archiveError
    },
    inputFor: () => ({
      setDraft: text => { calls.drafts.push(text) },
      notify: (level, text) => { calls.notices.push({ level, text }) },
    }),
    titleOf: () => overrides.title,
    t: (key, params = {}) => `${key}${Object.keys(params).length === 0 ? '' : `:${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')}`}`,
    warn: message => { calls.warns.push(message) },
  }
  return { deps, calls }
}

const REQUEST = { sessionId: 'source-1', atSeq: 4, turn: 2, text: '改一下提问', archiveOriginal: false }

test('forkAndResend: forks from atSeq with increaseTitle, holds the child, switches, prompts queue', async () => {
  const { deps, calls } = rerunDeps({ title: '登录页校验' })
  const result = await forkAndResend(deps, REQUEST)
  assert.deepEqual(result, { outcome: 'sent', childId: 'child-1' })
  assert.deepEqual(calls.fork, [{ sessionId: 'source-1', atSeq: 4, increaseTitle: true }])
  assert.deepEqual(calls.using, [{ id: 'child-1', options: { source: 'workbenchRerun' } }])
  assert.deepEqual(calls.open, ['child-1'])
  assert.deepEqual(calls.prompts, [{ content: [{ type: 'text', text: '改一下提问' }], mode: 'queue' }])
  // 顺序：先切过去，再发
  assert.ok(calls.open.length === 1 && calls.prompts.length === 1)
  // 成功提示带上标题和轮次号
  assert.deepEqual(calls.notices, [{ level: 'info', text: 'rerun.notice.forked:turn=2,title=登录页校验' }])
  // 没开归档就不动原会话
  assert.deepEqual(calls.archive, [])
  assert.deepEqual(calls.drafts, [])
})

test('forkAndResend: removes the user messages the child inherited in its next-turn queue before prompting', async () => {
  // 分叉点是提问入队的那条事件，子会话带着还没被领走的原提问；不删它，同一问会跑两遍
  const { deps, calls } = rerunDeps({
    inbox: {
      'next-turn': [
        { id: 'q-original', source: { kind: 'user' } },
        { id: 'q-system', source: { kind: 'plugin' } },
        { id: 'q-later', source: { kind: 'user' } },
      ],
      'next-step': [{ id: 'step-1', source: { kind: 'user' } }],
    },
  })
  const result = await forkAndResend(deps, REQUEST)
  assert.deepEqual(result, { outcome: 'sent', childId: 'child-1' })
  // 只删「下一轮」队列里来源是用户的；别的来源和「下一步」队列不动
  assert.deepEqual(calls.queueUpdates, [
    { id: 'q-original', action: { kind: 'remove' } },
    { id: 'q-later', action: { kind: 'remove' } },
  ])
  assert.deepEqual(calls.order, ['remove', 'remove', 'prompt'])
})

test('forkAndResend: waits for the inbox projection to load before looking for inherited messages', async () => {
  const { deps, calls } = rerunDeps({ inbox: INHERITED_ORIGINAL, inboxDelayMs: 5 })
  const result = await forkAndResend(deps, REQUEST)
  assert.equal(result.outcome, 'sent')
  assert.deepEqual(calls.order, ['remove', 'prompt'])
})

test('forkAndResend: an inbox projection that never loads counts as an empty queue', async () => {
  const { deps, calls } = rerunDeps({ inbox: INHERITED_ORIGINAL, inboxDelayMs: 10_000, inboxWaitMs: 10 })
  const result = await forkAndResend(deps, REQUEST)
  assert.equal(result.outcome, 'sent')
  assert.deepEqual(calls.order, ['prompt'])
})

test('forkAndResend: a refused removal sends nothing and puts the text back', async () => {
  const { deps, calls } = rerunDeps({
    inbox: INHERITED_ORIGINAL,
    updateQueueResult: { ok: false, error: { code: 'session/queue-item-not-found', message: '这条消息已经开始发送' } },
  })
  const result = await forkAndResend(deps, { ...REQUEST, archiveOriginal: true })
  assert.deepEqual(result, { outcome: 'send-failed', childId: 'child-1' })
  assert.deepEqual(calls.prompts, [])
  assert.deepEqual(calls.drafts, ['改一下提问'])
  assert.deepEqual(calls.notices, [{ level: 'error', text: 'rerun.notice.sendFailed:reason=这条消息已经开始发送' }])
  assert.deepEqual(calls.archive, [])
})

test('forkAndResend: a removal without a reason, or one that throws, fails the same way', async () => {
  const silent = rerunDeps({ inbox: INHERITED_ORIGINAL, updateQueueResult: { ok: false } })
  assert.deepEqual(await forkAndResend(silent.deps, REQUEST), { outcome: 'send-failed', childId: 'child-1' })
  assert.deepEqual(silent.calls.notices, [{ level: 'error', text: 'rerun.notice.sendFailed:reason=session/queue-remove-failed' }])
  const thrown = rerunDeps({ inbox: INHERITED_ORIGINAL, updateQueueError: new Error('连接断了') })
  assert.deepEqual(await forkAndResend(thrown.deps, REQUEST), { outcome: 'send-failed', childId: 'child-1' })
  assert.deepEqual(thrown.calls.notices, [{ level: 'error', text: 'rerun.notice.sendFailed:reason=连接断了' }])
  assert.deepEqual(thrown.calls.prompts, [])
})

test('forkAndResend: fork failure rejects and nothing else runs', async () => {
  const { deps, calls } = rerunDeps({ forkError: new Error('session/fork-unavailable: 没有这个事件序号') })
  await assert.rejects(
    forkAndResend(deps, REQUEST),
    /session\/fork-unavailable/,
  )
  assert.deepEqual(calls.using, [])
  assert.deepEqual(calls.open, [])
  assert.deepEqual(calls.prompts, [])
})

test('forkAndResend: prompt rejection restores the draft and notifies in the child, keeps it', async () => {
  const { deps, calls } = rerunDeps({ promptResult: { ok: false, error: { message: '当前模型不支持这条消息的内容' } } })
  const result = await forkAndResend(deps, { ...REQUEST, archiveOriginal: true })
  assert.deepEqual(result, { outcome: 'send-failed', childId: 'child-1' })
  assert.deepEqual(calls.drafts, ['改一下提问'])
  assert.deepEqual(calls.notices, [{ level: 'error', text: 'rerun.notice.sendFailed:reason=当前模型不支持这条消息的内容' }])
  // 发送失败不算成功：不归档原会话；子会话也不删（没有这个动作）
  assert.deepEqual(calls.archive, [])
})

test('forkAndResend: a thrown prompt counts as send failure the same way', async () => {
  const { deps, calls } = rerunDeps({ promptError: new Error('网络断了') })
  const result = await forkAndResend(deps, REQUEST)
  assert.deepEqual(result, { outcome: 'send-failed', childId: 'child-1' })
  assert.deepEqual(calls.drafts, ['改一下提问'])
  assert.deepEqual(calls.notices, [{ level: 'error', text: 'rerun.notice.sendFailed:reason=网络断了' }])
})

test('forkAndResend: success without a title uses the no-title notice', async () => {
  const { deps, calls } = rerunDeps({ title: undefined })
  await forkAndResend(deps, REQUEST)
  assert.deepEqual(calls.notices, [{ level: 'info', text: 'rerun.notice.forkedNoTitle:turn=2' }])
  const empty = rerunDeps({ title: '' })
  await forkAndResend(empty.deps, REQUEST)
  assert.deepEqual(empty.calls.notices, [{ level: 'info', text: 'rerun.notice.forkedNoTitle:turn=2' }])
})

test('forkAndResend: archives the original only after a successful send', async () => {
  const { deps, calls } = rerunDeps()
  await forkAndResend(deps, { ...REQUEST, archiveOriginal: true })
  assert.deepEqual(calls.archive, ['source-1'])
})

test('forkAndResend: archive failure only warns, the send still counts', async () => {
  const { deps, calls } = rerunDeps({ archiveError: new Error('workspace/session-active') })
  const result = await forkAndResend(deps, { ...REQUEST, archiveOriginal: true })
  assert.deepEqual(result, { outcome: 'sent', childId: 'child-1' })
  assert.deepEqual(calls.archive, ['source-1'])
  assert.equal(calls.warns.length, 1)
  assert.match(calls.warns[0], /归档原会话失败/)
})

test('forkAndResend: blank text refuses to run', async () => {
  const { deps, calls } = rerunDeps()
  await assert.rejects(forkAndResend(deps, { ...REQUEST, text: '   ' }), /empty/)
  assert.deepEqual(calls.fork, [])
})

// ---------- 挂载和撤销 ----------

test('applyRerun: registers the assistant-actions entry and the row config, dispose removes both', () => {
  const registered = []
  const disposed = []
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
  }
  const app = { ctx, t: key => key }
  const dispose = applyRerun(app)
  assert.ok(app.rerunConfig)
  assert.equal(registered.length, 2)
  const actions = registered.find(options => options.name === 'conversation.chat.assistant-actions')
  assert.deepEqual(
    { id: actions.id, order: actions.order },
    { id: 'dsh-workbench-rerun', order: 20 },
  )
  const config = registered.find(options => options.name === 'plugins.row.config')
  assert.equal(config.key, '@miint-sunny/dsh-workbench#dsh-workbench-rerun')
  dispose()
  assert.equal(registered.length, 0)
  assert.deepEqual(disposed.sort(), ['conversation.chat.assistant-actions', 'plugins.row.config'])
})

// ---------- placeRerunPopover：浮层按对话容器定位 ----------

/** 一个矩形。 */
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })

test('placeRerunPopover: prefers above the icon row when the container has room', () => {
  const placed = placeRerunPopover(
    rect(40, 400, 60, 28),          // 图标排：y 400–428
    rect(0, 0, 800, 900),           // 对话容器
    { height: 900 },
    { height: 200 },                // 浮层自然高度
  )
  assert.deepEqual(placed, { left: 40, top: 192, width: 560, maxHeight: 392, placement: 'above' })
  // maxHeight 是上方那一侧的可用空间（图标排上沿到容器顶，去掉空隙）
  assert.equal(placed.maxHeight, 400 - 8)
})

test('placeRerunPopover: falls below when above does not fit inside the container', () => {
  const placed = placeRerunPopover(
    rect(40, 20, 60, 28),           // 图标排贴着容器顶
    rect(0, 0, 800, 900),
    { height: 900 },
    { height: 200 },
  )
  assert.deepEqual(placed, { left: 40, top: 56, width: 560, maxHeight: 844, placement: 'below' })
  // 下方那一侧的可用空间再被视口高度压一道
  const squeezed = placeRerunPopover(rect(40, 20, 60, 28), rect(0, 0, 800, 900), { height: 400 }, { height: 200 })
  assert.equal(squeezed.placement, 'below')
  assert.equal(squeezed.maxHeight, 400 - 24)
})

test('placeRerunPopover: a narrow pane clamps the width and pins to the container', () => {
  // 右边栏嵌入的窄窗格（约 398 宽）：浮层 374 宽，锚点超出右边也夹回容器内
  const placed = placeRerunPopover(
    rect(900, 400, 60, 28),
    rect(600, 0, 398, 900),
    { height: 900 },
    { height: 200 },
  )
  assert.deepEqual(placed, { left: 612, top: 192, width: 374, maxHeight: 392, placement: 'above' })
  // 锚点在容器左边之外，也夹回容器内
  const leftEdge = placeRerunPopover(rect(50, 400, 60, 28), rect(100, 0, 800, 900), { height: 900 }, { height: 200 })
  assert.equal(leftEdge.left, 112)
})

test('placeRerunPopover: a container narrower than the popover still keeps it inside', () => {
  const placed = placeRerunPopover(
    rect(10, 300, 60, 28),
    rect(0, 0, 100, 600),
    { height: 600 },
    { height: 200 },
  )
  assert.deepEqual(placed, { left: 12, top: 92, width: 76, maxHeight: 292, placement: 'above' })
  // 容器比两道边距还窄：宽度退到 0，不出现负数或 NaN
  const tiny = placeRerunPopover(rect(0, 100, 10, 28), rect(0, 0, 10, 400), { height: 400 }, { height: 200 })
  assert.equal(tiny.width, 0)
  assert.ok(Number.isFinite(tiny.left) && Number.isFinite(tiny.top))
})

/** 新会话卡片（feat#160）的纯函数：参数、规矩、默认选项、投影。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_RECORD, MAX_CARDS, PROPOSE_TOOL, REPORT_SOURCE,
  cardDefaults, cardsFold, cardsInit, cardsViewOf, checkProposal, directStartBlock, fitEffort, parseCardsState, parseCardsView,
  permissionRank, proposalArgsOf, quoteFromUser, resolveProposedOptions, titleKey, validateStartOptions,
} from '../lib/session-cards-state.js'
import { emptyCardsStore, parseCardsStore, withChild, withoutChild } from '../lib/session-cards-store.js'
import { cardSummaryOf, needsFullAccessConfirm, startedStateOf } from '../src/client/session-cards.js'

// ---------- 参数 ----------

test('proposalArgsOf: trims title and brief, keeps known options, drops empty ones', () => {
  assert.deepEqual(proposalArgsOf({ title: ' 更正发布页 ', brief: ' 只改说明 ' }), { title: '更正发布页', brief: '只改说明', options: {} })
  assert.deepEqual(
    proposalArgsOf({ title: 't', brief: 'b', options: { model: ' deepseek-v4-pro ', worktree: true, permission: null }, userQuote: '另开一个会话做' }),
    { title: 't', brief: 'b', options: { model: 'deepseek-v4-pro', worktree: true }, userQuote: '另开一个会话做' })
})

test('proposalArgsOf: missing, blank, over-long and mistyped fields reject with a reason for the model', () => {
  assert.throws(() => proposalArgsOf({ brief: 'b' }), /title/)
  assert.throws(() => proposalArgsOf({ title: 't' }), /brief/)
  assert.throws(() => proposalArgsOf({ title: '  ', brief: 'b' }), /title/)
  assert.throws(() => proposalArgsOf({ title: 'x'.repeat(81), brief: 'b' }), /80/)
  assert.throws(() => proposalArgsOf({ title: 't', brief: 'x'.repeat(4001) }), /4000/)
  assert.throws(() => proposalArgsOf({ title: 't', brief: 'b', options: { color: 'red' } }), /options\.color/)
  assert.throws(() => proposalArgsOf({ title: 't', brief: 'b', options: { worktree: 'yes' } }), /worktree/)
  assert.throws(() => proposalArgsOf({ title: 't', brief: 'b', options: [] }), /options/)
  assert.throws(() => proposalArgsOf('nope'), /object/)
})

test('proposalArgsOf: ask accepts boolean, rejects options or userQuote when ask is true', () => {
  assert.deepEqual(
    proposalArgsOf({ title: ' 整理说明 ', brief: ' 对一遍 ', ask: true }),
    { title: '整理说明', brief: '对一遍', options: {}, ask: true },
  )
  assert.deepEqual(
    proposalArgsOf({ title: 't', brief: 'b', ask: false, options: { worktree: true } }),
    { title: 't', brief: 'b', options: { worktree: true } },
  )
  assert.throws(() => proposalArgsOf({ title: 't', brief: 'b', ask: 'yes' }), /ask/)
  for (const patch of [{ options: { model: 'pro' } }, { options: {} }, { userQuote: '另开一个会话' }]) {
    assert.throws(
      () => proposalArgsOf({ title: 't', brief: 'b', ask: true, ...patch }),
      error => error?.code === 'ask-args',
    )
  }
})

// ---------- 规矩：一轮三张、同一件事不重复、新会话不能提卡 ----------

const card = (patch) => ({ id: 'c', turn: 1, order: 0, title: '甲', brief: 'b', options: {}, state: 'pending', ...patch })

test('checkProposal: at most three cards per turn, counting the ones accepted but not yet in the log', () => {
  const cards = [card({ id: 'a', title: '一' }), card({ id: 'b', title: '二' })]
  assert.deepEqual(checkProposal({ cards, turn: 1, title: '三', isChild: false }), { ok: true })
  assert.equal(checkProposal({ cards, turn: 1, title: '三', isChild: false, accepted: [{ turn: 1, key: titleKey('四') }] }).code, 'limit')
  assert.equal(checkProposal({ cards: [...cards, card({ id: 'd', title: '三' })], turn: 1, title: '五', isChild: false }).code, 'limit')
  // 上一轮的卡不占这一轮的名额。
  assert.deepEqual(checkProposal({ cards: cards.map(c => ({ ...c, turn: 0 })), turn: 1, title: '三', isChild: false, accepted: [{ turn: 1, key: 'x' }] }), { ok: true })
})

test('checkProposal: the same task is not proposed twice, whatever became of the first card', () => {
  for (const state of ['pending', 'started', 'here', 'dismissed']) {
    const result = checkProposal({ cards: [card({ title: '更正 v0.2.1 发布页。', turn: 0, state })], turn: 3, title: '  更正 V0.2.1 发布页 ', isChild: false })
    assert.deepEqual(result, { ok: false, code: 'duplicate', state }, state)
  }
  assert.deepEqual(checkProposal({ cards: [], turn: 3, title: '甲', isChild: false, accepted: [{ turn: 3, key: titleKey('甲') }] }), { ok: false, code: 'duplicate', state: 'pending' })
})

test('checkProposal: a session started from a card cannot propose another one', () => {
  assert.deepEqual(checkProposal({ cards: [], turn: 1, title: '甲', isChild: true }), { ok: false, code: 'child' })
})

test('checkProposal: allows at most one ask per turn, counts ask toward the three-card turn limit and task deduplication', () => {
  const askedPending = card({ id: 'a0', turn: 1, title: '甲', kind: 'ask', state: 'pending' })
  assert.deepEqual(checkProposal({ cards: [askedPending], turn: 1, title: '乙', isChild: false, ask: true }), { ok: false, code: 'ask-limit' })
  assert.deepEqual(checkProposal({ cards: [askedPending], turn: 1, title: '甲', isChild: false }), { ok: false, code: 'duplicate', state: 'pending' })
  const asked = card({ id: 'a1', turn: 1, title: '甲', kind: 'ask', ask: { choice: 'here' }, state: 'here' })
  assert.deepEqual(checkProposal({ cards: [asked], turn: 1, title: '乙', isChild: false, ask: true }), { ok: false, code: 'ask-limit' })
  assert.deepEqual(checkProposal({ cards: [], turn: 1, title: '乙', isChild: false, ask: true, accepted: [{ turn: 1, key: titleKey('甲'), ask: true }] }), { ok: false, code: 'ask-limit' })
  assert.deepEqual(checkProposal({ cards: [asked], turn: 1, title: '乙', isChild: false, ask: false }), { ok: true })
  assert.deepEqual(checkProposal({ cards: [{ ...asked, turn: 0 }], turn: 1, title: '乙', isChild: false, ask: true }), { ok: true })
  assert.deepEqual(checkProposal({ cards: [asked, card({ id: 'b1', title: '乙' }), card({ id: 'b2', title: '丙' })], turn: 1, title: '丁', isChild: false }), { ok: false, code: 'limit' })
  assert.deepEqual(checkProposal({ cards: [asked], turn: 1, title: '甲', isChild: false }), { ok: false, code: 'duplicate', state: 'here' })
})

test('quoteFromUser: only the user\'s own words from this turn that ask for a separate session', () => {
  const turnText = '先把改名做完。发布页那件事另开一个会话做吧，别在这里弄。'
  assert.equal(quoteFromUser('发布页那件事另开一个会话做', turnText), true)
  assert.equal(quoteFromUser('另开一个  会话做', '另开一个 会话做'), true, 'whitespace differences do not matter')
  assert.equal(quoteFromUser('发布页那件事另开', turnText), false, 'must ask for a session')
  assert.equal(quoteFromUser('另开一个会话专门做', turnText), false, 'must be verbatim')
  assert.equal(quoteFromUser('Open a new session for it', 'please open a new session for it'), true)
  assert.equal(quoteFromUser('会', turnText), false)
  assert.equal(quoteFromUser('另开一个会话做', ''), false)
})

test('quoteFromUser: the words must ask for a new session, an action and a session together', () => {
  for (const words of ['另开一个会话做', '新开个会话', '单独开一个会话', '新建一个会话', '开个新会话']) {
    assert.equal(quoteFromUser(words, `先把改名做完。发布页那件事${words}吧。`), true, words)
  }
  for (const words of ['open a new session for this', 'start a separate session']) {
    assert.equal(quoteFromUser(words, `Finish the rename first, then ${words}.`), true, words)
  }
})

test('quoteFromUser: only mentioning a session, refusing one or asking whether to open one does not count', () => {
  assert.equal(quoteFromUser('session.ts', '看看 session.ts'), false)
  assert.equal(quoteFromUser('看看 session.ts', '看看 session.ts'), false)
  assert.equal(quoteFromUser('这个会话里继续', '这个会话里继续'), false)
  assert.equal(quoteFromUser('把会话标题改一下', '把会话标题改一下'), false)
  assert.equal(quoteFromUser('session', 'the session list is slow'), false)
  // 摘录本身是要求，但用户说的是不要
  assert.equal(quoteFromUser('另开一个会话', '不要另开一个会话，就在这里做'), false)
  assert.equal(quoteFromUser('不要另开一个会话', '不要另开一个会话，就在这里做'), false)
  assert.equal(quoteFromUser('别新开会话', '别新开会话'), false)
  assert.equal(quoteFromUser('open a new session', "don't open a new session for this"), false)
  assert.equal(quoteFromUser('start a separate session', 'no need to start a separate session'), false)
  // 问要不要开，不是要求开
  assert.equal(quoteFromUser('另开一个会话', '要另开一个会话吗？'), false)
  assert.equal(quoteFromUser('要不要另开一个会话', '要不要另开一个会话'), false)
  assert.equal(quoteFromUser('open a new session for this', 'should we open a new session for this?'), false)
  // 同一句话前面拒绝过、后面又要求：后面那处算
  assert.equal(quoteFromUser('另开一个会话做', '刚才说不要另开一个会话，现在改主意了：另开一个会话做。'), true)
})

// ---------- 直接开：不越过当前会话 ----------

test('permissionRank: read-only < workspace-write < full access; custom and unknown count as read-only', () => {
  assert.equal(permissionRank('read-only') < permissionRank('workspace-write'), true)
  assert.equal(permissionRank('workspace-write') < permissionRank('danger-full-access'), true)
  assert.equal(permissionRank('custom'), permissionRank('read-only'))
  assert.equal(permissionRank(undefined), permissionRank('read-only'))
})

test('direct start requires a known target permission even when the parent permission is unavailable', () => {
  for (const permission of ['deployment-profile', undefined]) {
    assert.equal(directStartBlock({ workspaceId: 'w1', permission }, { workspaceId: 'w1', permission: 'read-only' }), 'permission')
    assert.equal(directStartBlock({ workspaceId: 'w1', permission }, { workspaceId: 'w1' }), 'permission')
  }
})

test('direct start compares both knobs conservatively and keeps the ordinary full-access downgrade available', () => {
  const choose = (target, source) => directStartBlock(
    { workspaceId: 'w1', permission: target.name }, { workspaceId: 'w1', permission: source.name },
    name => name === target.name ? target : source,
  )
  const read = { name: 'read-only', sandbox: 'read-only', approval: 'never' }
  const write = { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }
  const full = { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' }
  assert.equal(choose(write, full), undefined)
  assert.equal(choose(read, write), undefined)
  assert.equal(choose({ ...read, approval: 'ask' }, { ...write, approval: 'never' }), 'permission')
})

test('negated instructions and cited interface text leave a session proposal pending', () => {
  for (const [quote, message] of [
    ['open a new session', 'Don’t open a new session.'],
    ['另开一个会话', '这次不另开一个会话。'],
    ['另开一个会话', '请把按钮文案「另开一个会话」译成英文。'],
    ['open a new session', 'The instructions say “open a new session”.'],
    ['另开一个会话', '另开一个会话是旧按钮的文案，请改一下。'],
    ['open a new session', 'Open a new session is the label we need to update.'],
  ]) {
    assert.equal(quoteFromUser(quote, message), false, message)
  }
  assert.equal(quoteFromUser('另开一个会话', '请另开一个会话处理按钮文案。'), true)
})

test('directStartBlock: a direct start keeps this session\'s workspace and never goes above its permission', () => {
  const now = { workspaceId: 'w1', permission: 'workspace-write' }
  const chosen = { workspaceId: 'w1', worktree: true, agentPreset: 'minimal', model: { provider: 'q', model: 'plain' }, reasoningEffort: undefined, permission: 'workspace-write' }
  assert.equal(directStartBlock(chosen, now), undefined, 'model, preset, effort and worktree are free')
  assert.equal(directStartBlock({ ...chosen, permission: 'read-only' }, now), undefined)
  assert.equal(directStartBlock({ ...chosen, permission: 'danger-full-access' }, now), 'permission')
  assert.equal(directStartBlock({ ...chosen, workspaceId: 'w2' }, now), 'workspace')
  assert.equal(directStartBlock(chosen, { workspaceId: 'w1' }), 'permission', 'unknown permission counts as read-only')
  assert.equal(directStartBlock(chosen, { workspaceId: 'w1', permission: 'custom' }), 'permission')
  assert.equal(directStartBlock({ ...chosen, permission: 'read-only' }, { workspaceId: 'w1', permission: 'custom' }), undefined)
  assert.equal(directStartBlock({ ...chosen, permission: 'danger-full-access' }, { workspaceId: 'w1', permission: 'danger-full-access' }), undefined)
})

// ---------- 选项默认值 ----------

const models = [
  { provider: 'p', model: 'flash', name: 'Flash', efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
  { provider: 'p', model: 'pro', name: 'Pro', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
  { provider: 'q', model: 'plain', name: 'Plain' },
]
const current = { workspaceId: 'w1', agentPreset: 'standard', model: { provider: 'p', model: 'flash' }, reasoningEffort: 'max', permission: 'workspace-write' }

test('cardDefaults: with no model chosen, the first time uses this session\'s model, later the last one chosen', () => {
  assert.deepEqual(cardDefaults({ proposed: {}, current, lastModel: undefined, models }).model, { provider: 'p', model: 'flash' })
  assert.deepEqual(cardDefaults({ proposed: {}, current, lastModel: { provider: 'p', model: 'pro' }, models }).model, { provider: 'p', model: 'pro' })
})

test('cardDefaults: what the model proposed wins; everything else follows this session', () => {
  const defaults = cardDefaults({ proposed: { model: { provider: 'q', model: 'plain' }, permission: 'read-only' }, current, lastModel: { provider: 'p', model: 'pro' }, models })
  assert.deepEqual(defaults, { workspaceId: 'w1', worktree: false, agentPreset: 'standard', model: { provider: 'q', model: 'plain' }, reasoningEffort: undefined, permission: 'read-only' })
  const same = cardDefaults({ proposed: {}, current, lastModel: undefined, models })
  assert.deepEqual(same, { workspaceId: 'w1', worktree: false, agentPreset: 'standard', model: { provider: 'p', model: 'flash' }, reasoningEffort: 'max', permission: 'workspace-write' })
  assert.equal(cardDefaults({ proposed: { worktree: true, workspaceId: 'w2', agentPreset: 'minimal' }, current, models }).worktree, true)
})

test('fitEffort: keeps a level the model offers, otherwise its default; models without levels get none', () => {
  assert.equal(fitEffort('max', models[0]), 'max')
  assert.equal(fitEffort('max', models[1]), 'high', 'pro has no max')
  assert.equal(fitEffort(undefined, models[1]), 'high')
  assert.equal(fitEffort('high', models[2]), undefined)
  assert.equal(fitEffort('high', undefined), 'high', 'unknown model: keep what we have, the host checks at start')
})

// ---------- 投影 ----------

const call = (turn, callId, args) => ({ type: 'tool/call', seq: 1, data: { turn, step: 1, callId, name: PROPOSE_TOOL, arguments: JSON.stringify(args) } })
const result = (turn, callId, meta, isError = false) => ({ type: 'tool/result', seq: 2, data: { turn, step: 1, message: { id: 'm', role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [], ...(isError ? { isError: true } : {}) }, ...(meta === undefined ? {} : { meta }) } })
const accepted = (title, extra = {}) => ({ ok: true, card: { title, brief: `${title}的说明`, options: {}, ...extra } })
const record = data => ({ type: CARD_RECORD, ignorable: true, seq: 9, data })
const userText = (text, kind = 'user', extra = {}) => ({ type: 'user/message', data: { id: 'u', role: 'user', source: { kind, ...extra }, content: [{ type: 'text', text }] } })

test('cards projection: accepted proposals become cards in their turn, in order; rejected ones never show', () => {
  let state = cardsInit()
  state = cardsFold(state, { type: 'turn/start', data: { turn: 2 } })
  state = cardsFold(state, call(2, 'c1', { title: '甲', brief: 'x' }))
  state = cardsFold(state, call(2, 'c2', { title: '乙', brief: 'x' }))
  state = cardsFold(state, call(2, 'c3', { title: '丙', brief: 'x' }))
  state = cardsFold(state, result(2, 'c1', accepted('甲', { options: { model: { provider: 'p', model: 'pro' } } })))
  state = cardsFold(state, result(2, 'c2', undefined, true))
  state = cardsFold(state, result(2, 'c3', accepted('丙')))
  const view = cardsViewOf(state)
  assert.equal(view.lastTurn, 2)
  assert.deepEqual(view.cards.map(c => [c.id, c.turn, c.order, c.title, c.state]), [['c1', 2, 0, '甲', 'pending'], ['c3', 2, 1, '丙', 'pending']])
  assert.deepEqual(view.cards[0].options, { model: { provider: 'p', model: 'pro' } })
  assert.equal('turnText' in view, false, 'the user text kept for the host check stays off the wire')
})

test('cards projection: start, here and dismiss records move a card; unknown cards and bad records are skipped', () => {
  let state = cardsInit()
  state = cardsFold(state, call(1, 'c1', {}))
  state = cardsFold(state, result(1, 'c1', accepted('甲')))
  state = cardsFold(state, call(1, 'c2', {}))
  state = cardsFold(state, result(1, 'c2', accepted('乙')))
  state = cardsFold(state, call(1, 'c3', {}))
  state = cardsFold(state, result(1, 'c3', accepted('丙')))
  state = cardsFold(state, record({ cardId: 'c1', action: 'start', childId: 'session-child', options: { workspaceId: 'w1', model: { provider: 'p', model: 'pro' } } }))
  state = cardsFold(state, record({ cardId: 'c2', action: 'here' }))
  state = cardsFold(state, record({ cardId: 'c3', action: 'dismiss' }))
  const before = state
  state = cardsFold(state, record({ cardId: 'nope', action: 'dismiss' }))
  state = cardsFold(state, record({ cardId: 'c1', action: 'explode' }))
  state = cardsFold(state, { ...record({ cardId: 'c1', action: 'dismiss' }), ignorable: false })
  assert.equal(state, before)
  const cards = cardsViewOf(state).cards
  assert.deepEqual(cards.map(c => c.state), ['started', 'here', 'dismissed'])
  assert.equal(cards[0].childId, 'session-child')
  assert.deepEqual(cards[0].started, { workspaceId: 'w1', model: { provider: 'p', model: 'pro' } })
})

test('cards projection: card B skips actions that are not its own record names', () => {
  const pending = cardsFold(cardsFold(cardsInit(), call(1, 'b', {})), result(1, 'b', accepted('甲')))
  for (const action of ['toString', 'constructor', ['dismiss'], ['start']]) {
    const replayed = cardsFold(pending, record({ cardId: 'b', action, childId: 'session-child', options: {} }))
    assert.deepEqual(replayed.cards, pending.cards, JSON.stringify(action))
  }
  assert.equal(cardsFold(pending, record({ cardId: 'b', action: 'dismiss' })).cards[0].state, 'dismissed')
})

test('cards projection: a card the host started right away arrives started', () => {
  let state = cardsFold(cardsInit(), call(4, 'c9', {}))
  state = cardsFold(state, result(4, 'c9', accepted('甲', { started: { childId: 'session-x', options: { workspaceId: 'w' } } })))
  const [only] = cardsViewOf(state).cards
  assert.equal(only.state, 'started')
  assert.equal(only.childId, 'session-x')
})

test('cards projection: reports from the started session attach to their card; the user text of the turn is kept for the quote check', () => {
  let state = cardsFold(cardsInit(), { type: 'turn/start', data: { turn: 1 } })
  state = cardsFold(state, userText('发布页那件事另开一个会话做'))
  state = cardsFold(state, userText('这是插件注入的上下文', 'context'))
  assert.equal(state.turnText.includes('另开一个会话做'), true)
  assert.equal(state.turnText.includes('插件注入'), false)
  state = cardsFold(state, call(1, 'c1', {}))
  state = cardsFold(state, result(1, 'c1', accepted('甲', { started: { childId: 'session-x', options: {} } })))
  state = cardsFold(state, userText('【新会话回报】……', REPORT_SOURCE, { form: 'notice', summary: '新会话「甲」：等待回答', cardId: 'c1', senderSessionId: 'session-x', state: 'waiting', last: '全文写好了，等你确认。' }))
  assert.deepEqual(cardsViewOf(state).cards[0].report, { state: 'waiting', last: '全文写好了，等你确认。' })
  state = cardsFold(state, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(state.turnText, '')
})

test('cards projection: keeps the latest 50 cards and round-trips through its checkpoint parser', () => {
  let state = cardsInit()
  for (let turn = 1; turn <= 30; turn++) {
    for (const n of [1, 2]) {
      state = cardsFold(state, call(turn, `c${turn}-${n}`, {}))
      state = cardsFold(state, result(turn, `c${turn}-${n}`, accepted(`卡 ${turn}-${n}`)))
    }
  }
  assert.equal(state.cards.length, MAX_CARDS)
  assert.equal(state.cards[0].id, 'c6-1')
  assert.deepEqual(parseCardsState(JSON.parse(JSON.stringify(state))), state)
  assert.throws(() => parseCardsState({ lastTurn: 'x' }))
  assert.throws(() => parseCardsState({ lastTurn: 1, turnText: '', calls: {}, cards: [{ id: 'a' }] }))
})

test('cards projection: folds pending Card A from tool/result without ask or started, applies start and here records, and ignores dismiss', () => {
  let state = cardsInit()
  state = cardsFold(state, { type: 'turn/start', data: { turn: 1 } })
  state = cardsFold(state, call(1, 'a1', { title: '甲', brief: '说明', ask: true }))
  state = cardsFold(state, result(1, 'a1', accepted('甲', { kind: 'ask' })))
  state = cardsFold(state, call(1, 'a2', { title: '乙', brief: '说明', ask: true }))
  state = cardsFold(state, result(1, 'a2', accepted('乙', { kind: 'ask' })))
  assert.equal(cardsViewOf(state).cards.length, 2)
  assert.deepEqual(cardsViewOf(state).cards[0], {
    id: 'a1', turn: 1, order: 0, title: '甲', brief: '甲的说明', options: {}, kind: 'ask', state: 'pending',
  })
  assert.equal('ask' in cardsViewOf(state).cards[0], false)
  assert.equal('childId' in cardsViewOf(state).cards[0], false)
  assert.equal('started' in cardsViewOf(state).cards[0], false)

  // dismiss 和不合法的 start/here 记录都会被跳过
  const before = state
  state = cardsFold(state, record({ cardId: 'a1', action: 'dismiss' }))
  state = cardsFold(state, record({ cardId: 'a1', action: 'start', childId: 'child-bad', options: {}, remember: 'always-here' }))
  state = cardsFold(state, record({ cardId: 'a1', action: 'start', childId: '   ', options: {} }))
  state = cardsFold(state, record({ cardId: 'a2', action: 'here', remember: 'always-new' }))
  state = cardsFold(state, record({ cardId: 'a2', action: 'here', remember: 'ask' }))
  assert.equal(state, before)

  state = cardsFold(state, record({ cardId: 'a1', action: 'start', childId: 'child-1', options: { workspaceId: 'w1' }, remember: 'always-new' }))
  state = cardsFold(state, record({ cardId: 'a2', action: 'here', remember: 'always-here' }))
  const cards = cardsViewOf(state).cards
  assert.equal(cards[0].state, 'started')
  assert.equal(cards[0].childId, 'child-1')
  assert.deepEqual(cards[0].started, { workspaceId: 'w1' })
  assert.deepEqual(cards[0].ask, { choice: 'new', remember: 'always-new' })
  assert.equal(cards[1].state, 'here')
  assert.deepEqual(cards[1].ask, { choice: 'here', remember: 'always-here' })
  assert.equal('childId' in cards[1], false)
  assert.equal('started' in cards[1], false)

  // 不带 remember 的 start / here
  let plain = cardsFold(cardsFold(cardsInit(), call(1, 'p1', { ask: true })), result(1, 'p1', accepted('丙', { kind: 'ask' })))
  plain = cardsFold(plain, record({ cardId: 'p1', action: 'start', childId: 'child-p', options: {} }))
  assert.deepEqual(plain.cards[0].ask, { choice: 'new' })
  let plainHere = cardsFold(cardsFold(cardsInit(), call(1, 'p2', { ask: true })), result(1, 'p2', accepted('丁', { kind: 'ask' })))
  plainHere = cardsFold(plainHere, record({ cardId: 'p2', action: 'here' }))
  assert.deepEqual(plainHere.cards[0].ask, { choice: 'here' })

  // 已决定的卡片 A 不再接受后续动作记录
  assert.deepEqual(cardsViewOf(cardsFold(state, record({ cardId: 'a1', action: 'here' }))), cardsViewOf(state))
  assert.deepEqual(cardsViewOf(cardsFold(state, record({ cardId: 'a2', action: 'start', childId: 'child-2', options: {} }))), cardsViewOf(state))
  assert.deepEqual(parseCardsState(JSON.parse(JSON.stringify(state))), state)
})

test('cards projection: unknown or non-string actions leave a pending ask available for a later decision', () => {
  const pending = cardsFold(cardsFold(cardsInit(), call(1, 'a', { ask: true })), result(1, 'a', accepted('甲', { kind: 'ask' })))
  for (const action of ['toString', ['here'], ['start'], { toString: null }]) {
    const replayed = cardsFold(pending, record({ cardId: 'a', action, childId: 'wrong', options: {} }))
    assert.deepEqual(replayed.cards, pending.cards, JSON.stringify(action))
    const decided = cardsFold(replayed, record({ cardId: 'a', action: 'here' }))
    assert.equal(decided.cards[0].state, 'here')
  }
})

test('cards projection: an ask start requires its recorded options before it can decide the card', () => {
  const pending = cardsFold(cardsFold(cardsInit(), call(1, 'a', { ask: true })), result(1, 'a', accepted('甲', { kind: 'ask' })))
  for (const fields of [{}, { options: null }, { options: [] }, { options: 'invalid' }]) {
    const replayed = cardsFold(pending, record({ cardId: 'a', action: 'start', childId: 'wrong', ...fields }))
    assert.deepEqual(replayed.cards, pending.cards, JSON.stringify(fields))
    const valid = cardsFold(replayed, record({ cardId: 'a', action: 'start', childId: 'child-1', options: { workspaceId: 'w1' } }))
    assert.equal(valid.cards[0].childId, 'child-1')
    assert.deepEqual(valid.cards[0].started, { workspaceId: 'w1' })
  }
})

test('cards projection: keeps legacy v1 custom and auto: no-answer ask cards readable alongside auto: setting', () => {
  let state = cardsInit()
  state = cardsFold(state, { type: 'turn/start', data: { turn: 1 } })
  state = cardsFold(state, call(1, 'c1', { title: '甲', brief: '说明', ask: true }))
  state = cardsFold(state, result(1, 'c1', accepted('甲', {
    options: { workspaceId: 'w1' },
    kind: 'ask',
    ask: { choice: 'new', auto: 'setting' },
    started: { childId: 'child-1', options: { workspaceId: 'w1' } },
  })))
  state = cardsFold(state, call(1, 'c2', { title: '乙', brief: '说明', ask: true }))
  state = cardsFold(state, result(1, 'c2', accepted('乙', {
    options: { workspaceId: 'w1' },
    kind: 'ask',
    ask: { choice: 'here', custom: '先只对目录' },
  })))
  state = cardsFold(state, call(1, 'c3', { title: '丙', brief: '说明', ask: true }))
  state = cardsFold(state, result(1, 'c3', accepted('丙', {
    options: { workspaceId: 'w1' },
    kind: 'ask',
    ask: { choice: 'here', auto: 'no-answer' },
  })))
  state = cardsFold(state, call(1, 'c4', { title: '丁', brief: '说明', ask: true }))
  state = cardsFold(state, result(1, 'c4', accepted('丁', {
    kind: 'ask',
    ask: { choice: 'here', auto: 'setting' },
  })))
  const { cards } = cardsViewOf(state)
  assert.equal(cards.length, 4)
  assert.equal(cards[0].state, 'started')
  assert.deepEqual(cards[0].ask, { choice: 'new', auto: 'setting' })
  assert.equal(cards[1].state, 'here')
  assert.deepEqual(cards[1].ask, { choice: 'here', custom: '先只对目录' })
  assert.equal(cards[2].state, 'here')
  assert.deepEqual(cards[2].ask, { choice: 'here', auto: 'no-answer' })
  assert.equal(cards[3].state, 'here')
  assert.deepEqual(cards[3].ask, { choice: 'here', auto: 'setting' })
  assert.deepEqual(parseCardsState(JSON.parse(JSON.stringify(state))), state)
  assert.deepEqual(parseCardsView(JSON.parse(JSON.stringify(cardsViewOf(state)))), cardsViewOf(state))
})

test('cards projection: v1 tool results keep both remembered choices through checkpoint and view replay', () => {
  const options = { workspaceId: 'w1', worktree: false, agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, permission: 'workspace-write' }
  const open = { title: '核对说明', brief: '检查新版选项', options, kind: 'ask' }
  const here = { title: 'Check links', brief: 'Verify the release links', options, kind: 'ask' }
  const state = [
    call(1, 'a1', { title: open.title, brief: open.brief, ask: true }),
    result(1, 'a1', { ok: true, card: { ...open, ask: { choice: 'new', remember: 'always-new' }, started: { childId: 'child', options } } }),
    call(2, 'a2', { title: here.title, brief: here.brief, ask: true }),
    result(2, 'a2', { ok: true, askNotSaved: true, card: { ...here, ask: { choice: 'here', remember: 'always-here' } } }),
  ].reduce(cardsFold, cardsInit())

  const expected = [
    { ...open, id: 'a1', turn: 1, order: 0, state: 'started', childId: 'child', started: options, ask: { choice: 'new', remember: 'always-new' } },
    { ...here, id: 'a2', turn: 2, order: 0, state: 'here', ask: { choice: 'here', remember: 'always-here' } },
  ]
  assert.deepEqual(state.cards, expected)
  assert.deepEqual(parseCardsState(JSON.parse(JSON.stringify(state))).cards, expected)
  assert.deepEqual(parseCardsView(JSON.parse(JSON.stringify(cardsViewOf(state)))).cards, expected)
})

test('cards projection: v1 askNotStarted results remain actionable B cards even if saving the preference failed', () => {
  const original = { title: '独立检查', brief: '核对选项', options: {} }
  for (const flags of [{}, { askNotSaved: true }]) {
    const state = [
      call(1, 'fallback', { title: original.title, brief: original.brief, ask: true }),
      result(1, 'fallback', { ok: true, card: original, notStarted: 'permission', askNotStarted: true, ...flags }),
    ].reduce(cardsFold, cardsInit())
    const expected = [{ ...original, id: 'fallback', turn: 1, order: 0, state: 'pending' }]
    assert.deepEqual(state.cards, expected)
    const restored = parseCardsState(JSON.parse(JSON.stringify(state)))
    assert.deepEqual(restored.cards, expected)
    assert.deepEqual(parseCardsView(JSON.parse(JSON.stringify(cardsViewOf(restored)))).cards, expected)
    assert.equal(cardsFold(restored, record({ cardId: 'fallback', action: 'dismiss' })).cards[0].state, 'dismissed')
  }
})

test('cards projection: later action records cannot change an answered ask card', () => {
  const before = cardsFold(cardsFold(cardsInit(), call(1, 'a', { ask: true })), result(1, 'a', accepted('甲', {
    kind: 'ask', ask: { choice: 'here', auto: 'setting' },
  })))
  assert.equal(before.cards[0].state, 'here')
  const after = cardsFold(before, record({ cardId: 'a', action: 'start', childId: 'unrelated', options: {} }))
  assert.deepEqual(cardsViewOf(after), cardsViewOf(before))
})

test('cards projection: ignores contradictory ask results instead of publishing actionable or misleading cards', () => {
  const started = { childId: 'child', options: {} }
  for (const fields of [
    { ask: { choice: 'here' } },
    { kind: 'ask', started },
    { kind: 'ask', started: {} },
    { kind: 'ask', ask: { choice: 'new' } },
    { kind: 'ask', ask: { choice: 'new' }, started: { childId: '', options: {} } },
    { kind: 'ask', ask: { choice: 'here' }, started },
    { kind: 'ask', ask: { choice: 'here' }, started: {} },
    { kind: 'ask', ask: { choice: 'new', auto: 'no-answer' }, started },
    { kind: 'ask', ask: { choice: 'here', remember: 'always-new' } },
    { kind: 'ask', ask: { choice: 'new', custom: '继续' }, started },
    { kind: 'ask', ask: { choice: 'here', auto: 'setting', remember: 'always-here' } },
  ]) {
    const called = cardsFold(cardsInit(), call(1, 'a', { ask: true }))
    const done = cardsFold(called, result(1, 'a', accepted('甲', fields)))
    assert.deepEqual(done.cards, [], JSON.stringify(fields))
    assert.deepEqual(done.calls, {})
  }
})

test('cards checkpoint and view: parseCard accepts only the three valid Card A combinations alongside legacy B cards', () => {
  const legacy = { id: 'b', turn: 1, order: 0, title: '旧卡', brief: '说明', options: {}, state: 'pending' }
  const pendingAsk = { ...legacy, id: 'a0', kind: 'ask', state: 'pending' }
  const newCard = { ...legacy, id: 'a1', kind: 'ask', ask: { choice: 'new' }, state: 'started', childId: 'child', started: {} }
  const here = { ...legacy, id: 'a2', kind: 'ask', ask: { choice: 'here' }, state: 'here' }
  const state = cards => ({ ...cardsInit(), cards })
  for (const parse of [parseCardsState, parseCardsView]) {
    assert.deepEqual(parse(state([legacy, pendingAsk, newCard, here])).cards, [legacy, pendingAsk, newCard, here])
    for (const bad of [
      { ...legacy, kind: 'other' },
      { ...legacy, ask: { choice: 'here' } },
      { ...pendingAsk, state: 'dismissed' },
      { ...pendingAsk, state: 'started' },
      { ...pendingAsk, state: 'here' },
      { ...pendingAsk, ask: { choice: 'here' } },
      { ...pendingAsk, childId: 'child' },
      { ...pendingAsk, started: {} },
      { ...here, state: 'pending' }, { ...here, state: 'dismissed' }, { ...here, state: 'started' },
      { ...here, childId: 'child' }, { ...here, started: {} },
      { ...here, ask: { choice: 'maybe' } },
      { ...here, ask: { choice: 'here', auto: 'magic' } },
      { ...here, ask: { choice: 'here', custom: 123 } },
      { ...newCard, state: 'here' }, { ...newCard, state: 'pending' },
      { ...newCard, childId: undefined }, { ...newCard, started: undefined },
      { ...newCard, ask: { choice: 'new', remember: 'always' } },
      { ...newCard, ask: { choice: 'new', remember: 'always-here' } },
      { ...newCard, ask: { choice: 'new', auto: 'setting', remember: 'always-new' } },
    ]) {
      assert.throws(() => parse(state([bad])), /malformed/, JSON.stringify(bad))
    }
  }
})

// ---------- 选项：模型给的名字解析成标准值；开始时核对网页送来的选项 ----------

const choices = {
  workspaces: [{ id: 'w1', title: 'dsh-nai5-prompting', path: '/work/dsh-nai5-prompting' }, { id: 'w2', title: '默认工作区', path: '/work/default' }],
  presets: [{ id: 'standard', name: '标准模式' }, { id: 'dsh-workbench-coding', name: '代码模式' }],
  models,
  permissions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
  worktree: true,
}

test('resolveProposedOptions: names, paths and display names become the values DSH uses', () => {
  assert.deepEqual(resolveProposedOptions({}, choices), {})
  assert.deepEqual(resolveProposedOptions({ workspace: '/work/dsh-nai5-prompting/', agentPreset: '代码模式', model: 'Pro', reasoningEffort: 'LOW', permission: '工作区内修改', worktree: true }, choices),
    { workspaceId: 'w1', agentPreset: 'dsh-workbench-coding', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'low', permission: 'workspace-write', worktree: true })
  assert.deepEqual(resolveProposedOptions({ workspace: '默认工作区', model: 'p/flash', permission: 'Full access' }, choices),
    { workspaceId: 'w2', model: { provider: 'p', model: 'flash' }, permission: 'danger-full-access' })
})

test('resolveProposedOptions: unknown values reject and list what can be chosen', () => {
  assert.throws(() => resolveProposedOptions({ workspace: 'nowhere' }, choices), /dsh-nai5-prompting/)
  assert.throws(() => resolveProposedOptions({ agentPreset: 'pirate' }, choices), /standard/)
  assert.throws(() => resolveProposedOptions({ model: 'gpt-9' }, choices), /flash/)
  assert.throws(() => resolveProposedOptions({ model: 'pro', reasoningEffort: 'max' }, choices), /low, high/)
  assert.throws(() => resolveProposedOptions({ permission: 'root' }, choices), /workspace-write/)
  assert.throws(() => resolveProposedOptions({ worktree: true }, { ...choices, worktree: false }), /worktree/)
})

test('validateStartOptions: what the card sends at start must still exist and fit together', () => {
  const ok = { workspaceId: 'w1', worktree: false, agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high', permission: 'workspace-write' }
  assert.deepEqual(validateStartOptions(ok, choices), ok)
  assert.deepEqual(validateStartOptions({ ...ok, model: { provider: 'q', model: 'plain' }, reasoningEffort: undefined }, choices), { ...ok, model: { provider: 'q', model: 'plain' }, reasoningEffort: undefined })
  for (const [field, patch] of [['workspace', { workspaceId: 'gone' }], ['preset', { agentPreset: 'gone' }], ['model', { model: { provider: 'p', model: 'gone' } }], ['effort', { reasoningEffort: 'max' }], ['permission', { permission: 'root' }], ['worktree', { worktree: 'yes' }]]) {
    assert.throws(() => validateStartOptions({ ...ok, ...patch }, choices), new RegExp(field), field)
  }
  assert.throws(() => validateStartOptions({ ...ok, worktree: true }, { ...choices, worktree: false }), /worktree/)
})

test('cardDefaults: a custom permission, or a preset or workspace not on offer, falls back so Start works', () => {
  // 当前会话权限是 custom：currentOf 不带 permission（审查第 6 条的复现）
  const custom = { workspaceId: 'w1', agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high' }
  const defaults = cardDefaults({ proposed: {}, current: custom, choices })
  assert.equal(defaults.permission, 'workspace-write')
  assert.doesNotThrow(() => validateStartOptions(defaults, choices))
  assert.equal(cardDefaults({ proposed: {}, current: { ...custom, permission: 'gone' }, choices }).permission, 'workspace-write')
  const noWrite = { ...choices, permissions: choices.permissions.filter(item => item.value !== 'workspace-write') }
  assert.equal(cardDefaults({ proposed: {}, current: custom, choices: noWrite }).permission, 'read-only')
  const onlyFull = { ...choices, permissions: choices.permissions.filter(item => item.value === 'danger-full-access') }
  assert.equal(cardDefaults({ proposed: {}, current: custom, choices: onlyFull }).permission, undefined, 'never falls back to full access')
  assert.equal(cardDefaults({ proposed: { permission: 'danger-full-access' }, current: custom, choices }).permission, 'danger-full-access', 'what the model proposed still wins')
  // 预设：标准模式，没有就第一项
  assert.equal(cardDefaults({ proposed: {}, current: { ...custom, agentPreset: 'dsh-workbench-readonly-review' }, choices }).agentPreset, 'standard')
  const noStandard = { ...choices, presets: [{ id: 'dsh-workbench-coding', name: '代码模式' }, { id: 'minimal' }] }
  assert.equal(cardDefaults({ proposed: {}, current: custom, choices: noStandard }).agentPreset, 'dsh-workbench-coding')
  // 工作区：当前会话所在的那个，没有就第一项
  assert.equal(cardDefaults({ proposed: {}, current: { ...custom, workspaceId: 'w2' }, choices }).workspaceId, 'w2')
  assert.equal(cardDefaults({ proposed: {}, current: { ...custom, workspaceId: 'gone' }, choices }).workspaceId, 'w1')
  assert.equal(cardDefaults({ proposed: {}, current: { ...custom, workspaceId: undefined }, choices: { ...choices, workspaces: [...choices.workspaces].reverse() } }).workspaceId, 'w2')
  for (const current of [custom, { ...custom, agentPreset: 'gone', workspaceId: 'gone' }, {}]) {
    assert.doesNotThrow(() => validateStartOptions(cardDefaults({ proposed: {}, current, lastModel: { provider: 'p', model: 'pro' }, choices }), choices))
  }
})

test('cardDefaults: a remembered model that was removed from the catalog falls back to this session\'s model', () => {
  const removed = { provider: 'p', model: 'gone' }
  const defaults = cardDefaults({ proposed: {}, current, lastModel: removed, choices })
  assert.deepEqual(defaults.model, { provider: 'p', model: 'flash' })
  assert.equal(defaults.reasoningEffort, 'max', 'the effort follows this session\'s model')
  assert.doesNotThrow(() => validateStartOptions(defaults, choices))
})

// ---------- 宿主存档：上一次选的模型、开出来的会话 ----------

test('cards store: parses leniently, keeps the newest children and remembers the last model', () => {
  assert.deepEqual(parseCardsStore(undefined), emptyCardsStore())
  assert.deepEqual(parseCardsStore({ version: 1, lastModel: { provider: 'p' }, children: { a: { parentId: 'x' }, b: 'nope' } }), emptyCardsStore())
  let store = emptyCardsStore()
  for (let at = 0; at < 505; at++) store = withChild(store, `s${at}`, { parentId: 'p', cardId: `c${at}`, title: `t${at}`, startedAt: at })
  assert.equal(Object.keys(store.children).length, 500)
  assert.equal(Object.hasOwn(store.children, 's4'), false)
  assert.equal(Object.hasOwn(store.children, 's504'), true)
  assert.deepEqual(parseCardsStore(JSON.parse(JSON.stringify(store))), store)
})

test('cards store: a session that failed to start is forgotten', () => {
  let store = withChild(emptyCardsStore(), 'a', { parentId: 'p', cardId: 'c1', title: '甲', startedAt: 1 })
  store = withChild(store, 'b', { parentId: 'p', cardId: 'c2', title: '乙', startedAt: 2 })
  assert.deepEqual(Object.keys(withoutChild(store, 'a').children), ['b'])
  assert.equal(withoutChild(store, 'nope'), store)
})

// ---------- 网页：开始以后的状态、选项摘要 ----------

test('startedStateOf: what DSH shows now wins; once idle, the host report says how it ended', () => {
  assert.equal(startedStateOf({ running: true }, { state: 'done' }), 'running')
  assert.equal(startedStateOf({ running: true, pendingInteraction: { kind: 'question' } }, undefined), 'waiting')
  assert.equal(startedStateOf({ running: true, pendingInteraction: { kind: 'approval' } }, undefined), 'approval')
  assert.equal(startedStateOf({ running: false, pendingInteraction: { kind: 'plan-review' } }, undefined), 'plan')
  assert.equal(startedStateOf({ running: false }, { state: 'error' }), 'error')
  assert.equal(startedStateOf({ running: false }, { state: 'stopped' }), 'stopped')
  assert.equal(startedStateOf({ running: false }, { state: 'waiting' }), 'done', 'the question was handled')
  assert.equal(startedStateOf({ running: false }, undefined), 'done')
  assert.equal(startedStateOf(undefined, undefined), 'running', 'just started, DSH has no status yet')
  assert.equal(startedStateOf(undefined, { state: 'waiting' }), 'waiting')
})

test('cardSummaryOf: workspace · worktree · preset · model · effort · permission, skipping what is not set', () => {
  const names = {
    workspace: id => `W(${id})`, worktree: () => '新建工作树', preset: id => `P(${id})`,
    model: m => `M(${m.model})`, effort: (m, e) => `推理等级 ${e}`, permission: v => `R(${v})`,
  }
  assert.equal(cardSummaryOf({ workspaceId: 'w', worktree: false, agentPreset: 's', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high', permission: 'workspace-write' }, names),
    'W(w) · P(s) · M(pro) · 推理等级 high · R(workspace-write)')
  assert.equal(cardSummaryOf({ workspaceId: 'w', worktree: true, agentPreset: 's', model: { provider: 'q', model: 'plain' } }, names), 'W(w) · 新建工作树 · P(s) · M(plain)')
  assert.equal(cardSummaryOf(undefined, names), '')
})

test('needsFullAccessConfirm: Start asks first when it would use full access and this session does not have it', () => {
  assert.equal(needsFullAccessConfirm('danger-full-access', 'workspace-write'), true)
  assert.equal(needsFullAccessConfirm('danger-full-access', undefined), true)
  assert.equal(needsFullAccessConfirm('danger-full-access', 'danger-full-access'), false)
  assert.equal(needsFullAccessConfirm('workspace-write', 'read-only'), false)
  assert.equal(needsFullAccessConfirm(undefined, undefined), false)
})

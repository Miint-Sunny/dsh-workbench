/**
 * 新会话卡片的宿主端（feat#160 返工，审查第 2、5、6 条）：真跑 lib/session-cards.js 的 apply，
 * 宿主换成下面这个最小的替身。它照 rc.3 的几处行为写：同一层里同名提示词段重复登记会抛错，
 * tools.restrict 认不出的全局工具会抛错，提示词段、工具限制、监听都返回撤销函数；行关掉就是
 * 撤掉这一行 ctx 上登记的全部东西，子会话 agent.ctx 上的东西不跟着撤。
 * lib/session-cards.js 依赖的两个 DSH 包（defineTool、appendPluginRecord）用 module.registerHooks 换成替身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const recordSinks = new WeakMap()
globalThis.__dwbSessionCardRecords = recordSinks
const STUBS = {
  '@deepseek-ai/dsh-tools': 'export const defineTool = definition => definition',
  '@deepseek-ai/dsh-session': 'export function appendPluginRecord(session, type, data) { globalThis.__dwbSessionCardRecords.get(session).push({ sessionId: session.id, type, data }) }',
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, format: 'module', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const { apply } = await import('../lib/session-cards.js')
const { cardsFold, cardsInit } = await import('../lib/session-cards-state.js')
const { SESSION_CARDS_HOST, fillCopy } = await import('../lib/session-cards-copy.js')

const PROPOSE = 'propose_session'
const SECTION = 'workbench:session-cards'
const WORKTREE = { path: '/work/repo/.agents/worktrees/dsh-1a2b3c4d-0001', branch: 'dsh-1a2b3c4d-0001', baseCommit: 'a'.repeat(40), repositoryRoot: '/work/repo' }

/** 一轮里的会话事件：轮次开始和用户的话。 */
const turnOf = (turn, text) => [
  { type: 'turn/start', data: { turn } },
  { type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } },
]

/** 一张已经出了的待处理卡。 */
const pendingCard = (turn, callId, title, options = {}) => [
  { type: 'tool/call', data: { turn, step: 1, callId, name: PROPOSE, arguments: '{}' } },
  { type: 'tool/result', data: { turn, step: 1, message: { id: 'm', role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [] }, meta: { ok: true, card: { title, brief: `${title}的说明`, options } } } },
]

/**
 * 替身宿主。
 * @param {{children?: object, failPrompt?: boolean | ((sessionId: string) => boolean), worktrees?: object, lastModel?: object | null, userQuestions?: object, prefs?: object | string}} [options]
 *   存档里已有的新会话、哪些会话的消息发不出去（true 是新会话的第一条消息）、官方工作树服务、存档里记住的上一次选的模型、官方提问服务、卡片 A 设置文件内容。
 */
function createHost({ children = {}, failPrompt = false, worktrees, lastModel = null, userQuestions, prefs } = {}) {
  const records = []
  const home = mkdtempSync(join(tmpdir(), 'dwb-session-cards-'))
  const dataDir = join(home, 'dsh-workbench')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'session-cards.json'), JSON.stringify({ version: 1, lastModel, children }))
  const prefsFile = join(dataDir, 'session-cards-prefs.json')
  if (prefs !== undefined) writeFileSync(prefsFile, typeof prefs === 'string' ? prefs : JSON.stringify(prefs))
  const listeners = []
  const sections = []
  const tools = new Map()
  const restrictions = []
  const routes = new Map()
  const events = new Map()
  const agents = new Map()
  const permissions = new Map()
  const presets = new Map()
  const archived = []
  const created = []
  const selectedModels = []
  const prompts = []
  const waiting = []
  let layers = 0
  let resolveGate
  const workspace = { id: 'w1', title: 'repo', path: '/work/repo', sessionIds: [], async insertSessionBefore() {} }
  const other = { id: 'w2', title: 'other', path: '/work/other', sessionIds: [], async insertSessionBefore() {} }
  const services = {
    permissionPresets: {
      catalog: () => ({ options: ['read-only', 'workspace-write', 'danger-full-access', 'custom'].map(value => ({ value, name: value })) }),
      current: session => permissions.get(session.id),
      set: (session, value) => { permissions.set(session.id, value) },
    },
    ...(worktrees === undefined ? {} : { worktrees }),
    ...(userQuestions === undefined ? {} : { userQuestions }),
  }

  class Scope {
    constructor(layer) {
      this.layer = layer
      this.disposers = []
      this.sessionController = sessionController
      this.agents = agentRegistry
      this.agentPresets = agentPresets
      this.workspaceRegistry = workspaceRegistry
    }

    effect(body) {
      const undo = body()
      let done = false
      const dispose = () => {
        if (done) return
        done = true
        const at = this.disposers.indexOf(dispose)
        if (at >= 0) this.disposers.splice(at, 1)
        if (typeof undo === 'function') return undo()
      }
      this.disposers.push(dispose)
      return dispose
    }

    on(name, listener, options) {
      return this.effect(() => {
        const entry = { scope: this, name, listener }
        if (options?.prepend) listeners.unshift(entry)
        else listeners.push(entry)
        return () => { listeners.splice(listeners.indexOf(entry), 1) }
      })
    }

    get(name) {
      return services[name]
    }

    inject(_names, callback) {
      const child = new Scope(this.layer)
      this.disposers.push(() => child.dispose())
      waiting.push(Promise.resolve().then(() => callback(child)))
    }

    dispose() {
      return Promise.all([...this.disposers].reverse().map(dispose => dispose()))
    }

    get systemPrompt() {
      return {
        section: section => this.effect(() => {
          if (sections.some(item => item.layer === this.layer && item.name === section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`)
          const entry = { layer: this.layer, ...section }
          sections.push(entry)
          return () => { sections.splice(sections.indexOf(entry), 1) }
        }),
      }
    }

    get tools() {
      return {
        register: definition => this.effect(() => {
          tools.set(definition.name, definition)
          return () => { tools.delete(definition.name) }
        }),
        restrict: (filter) => {
          if (this.layer === 'global') throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
          const unknown = (filter.deny ?? []).filter(name => !tools.has(name))
          if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown.join('", "')}"`)
          return this.effect(() => {
            const entry = { layer: this.layer, deny: filter.deny }
            restrictions.push(entry)
            return () => { restrictions.splice(restrictions.indexOf(entry), 1) }
          })
        },
      }
    }

    get connection() {
      return { fetch: { register: route => this.effect(() => { routes.set(route.path, route); return () => { routes.delete(route.path) } }) } }
    }

    get sessionProjections() {
      return { register: async definition => ({ stateOf: session => (events.get(session.id) ?? []).reduce(definition.apply, definition.init()) }) }
    }
  }

  /** 一个 Agent；同一个会话换一个 Agent（清空、压缩）时 layer 也换。 */
  function addAgent(id, { permission = 'workspace-write', preset = 'standard', model = { provider: 'p', model: 'pro', reasoningEffort: 'high' }, home: where = workspace } = {}) {
    const agent = {
      id, status: 'idle', ctx: new Scope(`agent:${id}:${++layers}`), followups: [],
      session: { id, header: { cwd: where.path, origin: 'user' } },
      followup(message) { this.followups.push(message) },
      model: { current: () => model },
    }
    recordSinks.set(agent.session, records)
    agents.set(id, agent)
    permissions.set(id, permission)
    presets.set(id, preset)
    if (!where.sessionIds.includes(id)) where.sessionIds.push(id)
    return agent
  }

  const sessionController = {
    async create(request) {
      const id = `child-${created.length + 1}`
      created.push({ id, request })
      const agent = addAgent(id, { preset: request.agentPreset, home: request.workspaceId === 'w2' ? other : workspace })
      emit('agent/created', { agent })
      return { sessionId: id }
    },
    async resolveAgent(id) {
      if (resolveGate !== undefined) await resolveGate
      cold.delete(id)
      return agents.has(id) ? { agent: agents.get(id) } : { error: 'unknown' }
    },
    async selectModel(request) { selectedModels.push(request) },
    async prompt(request) {
      prompts.push(request)
      const fails = typeof failPrompt === 'function' ? failPrompt(request.sessionId) : failPrompt && request.sessionId.startsWith('child-')
      if (fails) throw new Error('message was not accepted')
      return { accepted: true }
    },
    async modelCatalog() {
      return {
        routableProviders: ['p'],
        groups: [{
          id: 'p',
          models: [
            { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最高' }], defaultEffort: 'high' } },
            { id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } },
          ],
        }],
      }
    },
  }
  /** 没加载的会话。rc.3 的 resolveAgent 正常返回前，已经将恢复的实例发布到 agents。 */
  const cold = new Set()
  const agentRegistry = {
    get: id => (cold.has(id) ? undefined : agents.get(id)),
    list: () => [...agents.keys()].filter(id => !cold.has(id)).map(id => ({ id })),
  }
  const agentPresets = {
    list: async () => [{ id: 'standard', name: '标准模式' }, { id: 'minimal', name: '极简模式' }],
    presetForSession: session => presets.get(session.id),
  }
  const workspaceRegistry = {
    list: () => [workspace, other],
    async archiveSession(id) { archived.push(id) },
  }

  function emit(name, ...args) {
    for (const entry of listeners.filter(item => item.name === name && !item.scope.layer.startsWith('agent:'))) entry.listener(...args)
  }

  return {
    home, prefsFile, services, sections, restrictions, tools, routes, events, archived, created, selectedModels, prompts, records, permissions,
    addAgent,
    emit,
    /** 会话被卸载（还在，没加载）。 */
    unload(agent) {
      cold.add(agent.id)
    },
    /** 打开这一行（插件页里打开），等它的 inject 回调跑完。locale 是这一行配置的宿主语言。 */
    async open(locale = 'zh') {
      const row = new Scope('global')
      process.env.DSH_HOME = home
      apply(row, { locale })
      await Promise.all(waiting.splice(0))
      return row
    },
    /** 新会话问用户（等待回答、审批、计划审阅）：它 agent.ctx 上的 user-questions/request 监听依次处理。 */
    ask(agent, kind) {
      const chain = listeners.filter(item => item.name === 'user-questions/request' && item.scope === agent.ctx)
      const run = at => (at < chain.length ? chain[at].listener({ questions: [{ intent: { kind } }] }, () => run(at + 1)) : 'asked')
      return run(0)
    },
    /** 这个 Agent 上挂着的提示词段、被藏掉的工具。 */
    sectionsOn: agent => sections.filter(item => item.layer === agent.ctx.layer && item.name === SECTION),
    deniedOn: agent => restrictions.filter(item => item.layer === agent.ctx.layer).flatMap(item => item.deny),
    /** 让会话控制器加载 Agent 时等着，返回放行函数。 */
    holdResolve() {
      let release
      resolveGate = new Promise((resolve) => { release = resolve })
      return () => { resolveGate = undefined; release() }
    },
    /** 存档里记着的新会话。 */
    storedChildren: () => JSON.parse(readFileSync(join(home, 'dsh-workbench', 'session-cards.json'), 'utf8')).children,
    /** 存档里记着的上一次选的模型。 */
    storedLastModel: () => JSON.parse(readFileSync(join(home, 'dsh-workbench', 'session-cards.json'), 'utf8')).lastModel,
    /** 调一个 GET 路由。 */
    async get(path) {
      const response = await routes.get(path).fetch(new Request(`http://dsh.test${path}`, { method: 'GET' }))
      return { status: response.status, body: await response.json() }
    },
    /** 调一个 POST 路由。 */
    async post(path, body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      const response = await routes.get(path).fetch(new Request(`http://dsh.test${path}`, { method: 'POST', body: payload }))
      return { status: response.status, body: await response.json() }
    },
    async settle() {
      for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve))
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// ---------- 第 5 条：子会话上挂的东西要能撤 ----------

test('row off and on again: the child keeps one prompt section, no throw, and nothing is reported while the row is off', async (t) => {
  const host = createHost({ children: { 'child-9': { parentId: 'parent', cardId: 'c1', title: '更正发布页', startedAt: 1 } } })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  const child = host.addAgent('child-9')
  let row = await host.open()
  assert.equal(host.sectionsOn(child).length, 1)
  assert.deepEqual(host.deniedOn(child), [PROPOSE])
  host.ask(child, 'question')
  await host.settle()
  assert.equal(parent.followups.length, 1)
  assert.equal(parent.followups[0].source.state, 'waiting')

  row.dispose()
  assert.equal(host.sectionsOn(child).length, 0, 'the child prompt section goes with the row')
  assert.deepEqual(host.deniedOn(child), [], 'so does the tool restriction')
  assert.equal(host.ask(child, 'approval'), 'asked', 'the question still reaches whoever handles it')
  await host.settle()
  assert.equal(parent.followups.length, 1, 'no report while the row is off')

  row = await host.open()
  assert.equal(host.sectionsOn(child).length, 1)
  assert.deepEqual(host.deniedOn(child), [PROPOSE], 'the tool exists again before the child is restricted')
  host.ask(child, 'plan-review')
  await host.settle()
  assert.equal(parent.followups.length, 2)
  assert.equal(parent.followups[1].source.state, 'plan')
  row.dispose()
})

test('the report to the parent session gives the state in the same words as the card summary, in both languages', async (t) => {
  for (const [locale, opening] of [
    ['zh', '【新会话回报】你提议、用户开始的新会话「更正发布页」状态：等待回答。'],
    ['en', '[New session report] State of the new session "更正发布页" that you proposed and the user started: Waiting for answer.'],
  ]) {
    const host = createHost({ children: { 'child-9': { parentId: 'parent', cardId: 'c1', title: '更正发布页', startedAt: 1 } } })
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent')
    const child = host.addAgent('child-9')
    const row = await host.open(locale)
    host.ask(child, 'question')
    await host.settle()
    assert.equal(parent.followups.length, 1)
    const text = parent.followups[0].content[0].text
    assert.ok(text.startsWith(opening), text)
    row.dispose()
  }
})

test('a report already on its way when the row turns off is dropped', async (t) => {
  const host = createHost({ children: { 'child-9': { parentId: 'parent', cardId: 'c1', title: '更正发布页', startedAt: 1 } } })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  const child = host.addAgent('child-9')
  const row = await host.open()
  // 父会话没加载：回报要等会话控制器把它加载起来，这期间这一行被关掉
  host.unload(parent)
  const release = host.holdResolve()
  host.ask(child, 'question')
  row.dispose()
  release()
  await host.settle()
  assert.deepEqual(parent.followups, [])
})

test('a disposed child agent takes its rules with it; the agent that replaces it gets them again', async (t) => {
  const host = createHost({ children: { 'child-9': { parentId: 'parent', cardId: 'c1', title: '更正发布页', startedAt: 1 } } })
  t.after(() => host.cleanup())
  host.addAgent('parent')
  const child = host.addAgent('child-9')
  const row = await host.open()
  assert.equal(host.sectionsOn(child).length, 1)
  host.emit('agent/disposed', { agent: child })
  assert.equal(host.sectionsOn(child).length, 0)
  assert.deepEqual(host.deniedOn(child), [])
  const next = host.addAgent('child-9')
  host.emit('agent/created', { agent: next })
  assert.equal(host.sectionsOn(next).length, 1)
  assert.deepEqual(host.deniedOn(next), [PROPOSE])
  row.dispose()
  assert.equal(host.sectionsOn(next).length, 0)
})

// ---------- 第 5 条：开会话中途失败要收拾干净 ----------

const START_OPTIONS = { workspaceId: 'w1', worktree: false, agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high', permission: 'workspace-write' }

/** 在隔离宿主留一张待开始的卡。 */
async function setupPendingStart(t, cardId, options = {}) {
  const host = createHost(options)
  t.after(() => host.cleanup())
  host.addAgent('parent')
  host.events.set('parent', [...turnOf(1, '核对说明'), ...pendingCard(1, cardId, '核对说明')])
  const row = await host.open()
  t.after(() => row.dispose())
  const start = (overrides = {}) => host.post('/api/dsh-workbench.session-cards.act', {
    sessionId: 'parent', cardId, verb: 'start', options: { ...START_OPTIONS, ...overrides },
  })
  const file = join(host.home, 'dsh-workbench', 'session-cards.json')
  function blockWrites() {
    renameSync(file, file + '.saved')
    mkdirSync(file)
  }
  function allowWrites() {
    renameSync(file, file + '.blocked-directory')
    renameSync(file + '.saved', file)
  }
  return { host, row, start, blockWrites, allowWrites }
}

test('a child whose initial registration cannot be saved is archived before the card can be retried', async t => {
  const { host, start, blockWrites, allowWrites } = await setupPendingStart(t, 'registration-error')
  blockWrites()
  const result = await start()
  allowWrites()
  assert.equal(result.body.error?.code, 'start-failed')
  assert.deepEqual(host.archived, ['child-1'])
  assert.deepEqual(host.storedChildren(), {})
  assert.deepEqual(host.prompts, [])
})

test('a temporary storage failure during rollback still releases child rules and archives the failed child', async t => {
  const { host, row, start, blockWrites, allowWrites } = await setupPendingStart(t, 'rollback-error', {
    failPrompt: () => { blockWrites(); return true },
  })
  const archive = row.workspaceRegistry.archiveSession
  row.workspaceRegistry.archiveSession = async (...args) => {
    await archive(...args)
    allowWrites()
  }
  const result = await start()
  assert.equal(result.body.error?.code, 'start-failed')
  assert.deepEqual(host.archived, ['child-1'])
  assert.deepEqual(host.deniedOn(row.agents.get('child-1')), [])
  assert.deepEqual(host.storedChildren(), {})
})

test('an asynchronous child-rule cleanup failure settles before rollback answers and does not prevent archiving', async t => {
  const { host, row, start } = await setupPendingStart(t, 'rule-cleanup-error', { failPrompt: true })
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const create = row.sessionController.create
  row.sessionController.create = async request => {
    const created = await create(request)
    const agent = row.agents.get(created.sessionId)
    const listen = agent.ctx.on.bind(agent.ctx)
    agent.ctx.on = (...args) => {
      const remove = listen(...args)
      return () => {
        remove()
        entered.resolve()
        const cleanup = finish.promise.then(() => { throw new Error('listener cleanup failed') })
        cleanup.catch(() => {}) // 旧实现会忽略这个 Promise；红测仍应能检查用户收到的结果。
        return cleanup
      }
    }
    return created
  }
  let answered = false
  const action = start().then(result => { answered = true; return result })
  await entered.promise
  try {
    await host.settle()
    assert.equal(answered, false, 'rollback should still own the unfinished cleanup')
  } finally {
    finish.resolve()
    await action
  }
  assert.equal((await action).body.error?.code, 'start-failed')
  assert.deepEqual(host.archived, ['child-1'])
  assert.deepEqual(host.storedChildren(), {})
  assert.deepEqual(host.deniedOn(row.agents.get('child-1')), [])
})

test('when the worktree cleanup service disappears the failed start still reports its unconfirmed worktree', async t => {
  let unavailable = false
  const { host, row, start } = await setupPendingStart(t, 'missing-cleanup-service', {
    worktrees: worktreeService(null),
    failPrompt: () => { unavailable = true; return true },
  })
  const get = row.get.bind(row)
  row.get = name => {
    if (unavailable && name === 'worktrees') throw new Error('service retired')
    return get(name)
  }
  const result = await start({ worktree: true })
  assert.equal(result.body.error?.worktree, WORKTREE.path)
  assert.deepEqual(host.archived, ['child-1'])
})

test('a warning sink that has already shut down cannot interrupt rollback', async t => {
  const { host, row, start, blockWrites, allowWrites } = await setupPendingStart(t, 'cleanup-warning-error', {
    failPrompt: () => { blockWrites(); return true },
  })
  Object.defineProperty(row.constructor.prototype, 'logger', { value: { warn() { throw new Error('logger closed') } } })
  const result = await start()
  allowWrites()
  assert.equal(result.body.error?.code, 'start-failed')
  assert.deepEqual(host.archived, ['child-1'])
  assert.deepEqual(host.deniedOn(row.agents.get('child-1')), [])
})

test('after the first message was accepted a preference write failure still leaves the card started', async t => {
  const { host, start, blockWrites, allowWrites } = await setupPendingStart(t, 'preference-error', {
    failPrompt: () => { blockWrites(); return false },
  })
  const result = await start()
  allowWrites()
  assert.equal(result.body.ok, true)
  assert.equal(result.body.value.childId, 'child-1')
  assert.deepEqual(host.prompts.map(item => item.sessionId), ['child-1'])
  assert.equal(host.records.find(item => item.data.cardId === 'preference-error')?.data.action, 'start')
})

test('two repeated card starts stay busy until the first start completes', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { host, start } = await setupPendingStart(t, 'only-one-start', {
    worktrees: { async create(agent) {
      if (agent.id === 'child-1') {
        entered.resolve()
        await release.promise
      }
      return WORKTREE
    } },
  })
  const first = start({ worktree: true })
  await entered.promise
  try {
    for (let count = 0; count < 2; count++) {
      const busy = await start()
      assert.equal(busy.body.error?.code, 'busy')
    }
  } finally {
    release.resolve()
    await first
  }
  assert.deepEqual(host.prompts.map(request => request.sessionId), ['child-1'])
})

test('a start that fails half way forgets the new session, archives it and leaves the card to retry', async (t) => {
  const host = createHost({ failPrompt: true })
  t.after(() => host.cleanup())
  host.addAgent('parent')
  host.events.set('parent', [...turnOf(1, '改一下发布页'), ...pendingCard(1, 'c1', '更正发布页')])
  const row = await host.open()
  const answer = await host.post('/api/dsh-workbench.session-cards.act', { sessionId: 'parent', cardId: 'c1', verb: 'start', options: START_OPTIONS })
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'start-failed')
  assert.equal(answer.body.error.worktree, undefined)
  assert.deepEqual(host.created.map(item => item.id), ['child-1'])
  assert.deepEqual(host.storedChildren(), {}, 'the failed session is not remembered as started from a card')
  assert.deepEqual(host.archived, ['child-1'])
  assert.equal(host.records.some(item => item.data.action === 'start'), false)
  row.dispose()
})

test('a failed "handle in this session" says the message was not sent, not that a session failed', async (t) => {
  const host = createHost({ failPrompt: id => id === 'parent' })
  t.after(() => host.cleanup())
  host.addAgent('parent')
  host.events.set('parent', [...turnOf(1, '改一下发布页'), ...pendingCard(1, 'c1', '更正发布页')])
  const row = await host.open()
  const answer = await host.post('/api/dsh-workbench.session-cards.act', { sessionId: 'parent', cardId: 'c1', verb: 'here', text: '在当前会话处理：更正发布页' })
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'send-failed')
  assert.deepEqual(host.created, [])
  row.dispose()
})

/** 官方工作树服务的替身：create 返回新建的工作树，归档后的清理结果由 status 定（null 是没有清理，比如设了归档时保留）。 */
function worktreeService(status) {
  const calls = []
  return {
    calls,
    async create(agent) { calls.push(['create', agent.id]); return { ...WORKTREE } },
    async cleanupOf(session, revision) {
      calls.push(['cleanupOf', session.id, revision])
      if (status === null) return null
      return revision === null ? { revision: 7, status: 'scheduled' } : { revision, status }
    },
  }
}

test('a worktree made for a start that failed is cleaned up by the official service, or named in the reason', async (t) => {
  for (const [status, left] of [['removed', false], ['retained', true], ['failed', true], [null, true]]) {
    const worktrees = worktreeService(status)
    const host = createHost({ failPrompt: true, worktrees })
    t.after(() => host.cleanup())
    host.addAgent('parent')
    host.events.set('parent', [...turnOf(1, '改一下发布页'), ...pendingCard(1, 'c1', '更正发布页')])
    const row = await host.open()
    const answer = await host.post('/api/dsh-workbench.session-cards.act', { sessionId: 'parent', cardId: 'c1', verb: 'start', options: { ...START_OPTIONS, worktree: true } })
    assert.equal(answer.body.error.code, 'start-failed', String(status))
    assert.deepEqual(host.archived, ['child-1'], String(status))
    assert.equal(answer.body.error.worktree, left ? WORKTREE.path : undefined, String(status))
    assert.deepEqual(host.storedChildren(), {})
    row.dispose()
  }
})

// ---------- 第 2 条：直接开不能越过当前会话 ----------

/** 调 propose_session。 */
function propose(host, agent, args, callId = 'call-1') {
  return host.tools.get(PROPOSE).execute(args, { agent, callId, signal: AbortSignal.timeout(10_000) })
}

test('direct starts use the effective permission bundle when the local catalog redefines a standard name', async t => {
  const { host, row } = await setupPendingStart(t, 'permission-catalog')
  const service = row.get('permissionPresets')
  const parent = row.agents.get('parent')
  host.events.set(parent.id, turnOf(1, '请另开一个会话核对说明。'))
  const cases = [
    { source: { sandbox: 'workspace-write', approval: 'ask' }, target: { sandbox: 'danger-full-access', approval: 'never' }, blocked: true },
    { source: { sandbox: 'workspace-write', approval: 'never' }, target: { sandbox: 'workspace-write', approval: 'ask' }, blocked: true },
    { source: { sandbox: 'workspace-write', approval: 'ask' }, target: { sandbox: 'workspace-write', approval: 'never' }, blocked: false },
  ]
  for (const [index, { source, target, blocked }] of cases.entries()) {
    service.resolve = name => name === 'read-only' ? target : source
    const result = await propose(host, parent, {
      title: `说明 ${index}`, brief: '核对说明', userQuote: '另开一个会话', options: { permission: 'read-only' },
    }, `check-${index}`)
    if (blocked) assert.equal(result.notStarted, 'permission')
    else assert.equal(result.card.started?.options.permission, 'read-only')
  }
  assert.equal(host.created.length, 1)
})

test('userQuote that only mentions a session shows a card instead of starting one', async (t) => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  host.events.set('parent', turnOf(1, '看看 session.ts'))
  const row = await host.open()
  const args = { title: '看 session.ts', brief: '读一遍 session.ts', userQuote: 'session.ts' }
  const result = await propose(host, parent, args)
  assert.equal(result.ok, true)
  assert.equal(result.card.started, undefined)
  assert.equal(result.notStarted, 'quote')
  assert.deepEqual(host.created, [])
  const said = host.tools.get(PROPOSE).output.render(args, result)[0].text
  assert.match(said, /开始/)
  assert.match(said, /userQuote/)
  row.dispose()
})

test('a direct start that would raise the permission or change the workspace shows a pending card instead', async (t) => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', { permission: 'workspace-write' })
  host.events.set('parent', turnOf(1, '发布页那件事另开一个会话做，用完全权限。'))
  const row = await host.open()
  const full = await propose(host, parent, { title: '更正发布页', brief: '只改说明', userQuote: '另开一个会话做', options: { permission: '完全权限' } }, 'call-1')
  assert.equal(full.notStarted, 'permission')
  assert.equal(full.card.options.permission, 'danger-full-access', 'the card keeps the full access the user asked for, for the user to start')
  const elsewhere = await propose(host, parent, { title: '整理另一个仓库', brief: '整理', userQuote: '另开一个会话做', options: { workspace: 'other' } }, 'call-2')
  assert.equal(elsewhere.notStarted, 'workspace')
  assert.deepEqual(host.created, [])
  row.dispose()
})

test('a custom permission counts as read-only for a direct start, not as the fallback default', async (t) => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', { permission: 'custom' })
  host.events.set('parent', turnOf(1, '发布页那件事另开一个会话做。'))
  const row = await host.open()
  const result = await propose(host, parent, { title: '更正发布页', brief: '只改说明', userQuote: '另开一个会话做' })
  assert.equal(result.notStarted, 'permission')
  const readOnly = await propose(host, parent, { title: '只读一遍发布页', brief: '只读', userQuote: '另开一个会话做', options: { permission: 'read-only' } }, 'call-2')
  assert.equal(readOnly.notStarted, undefined)
  assert.equal(typeof readOnly.card.started.childId, 'string')
  row.dispose()
})

test('a direct start the user asked for, within this session\'s workspace and permission, starts right away', async (t) => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', { permission: 'workspace-write' })
  host.events.set('parent', turnOf(1, '发布页那件事另开一个会话做，用极简模式。'))
  const row = await host.open()
  const result = await propose(host, parent, { title: '更正发布页', brief: '只改说明', userQuote: '另开一个会话做', options: { agentPreset: 'minimal', reasoningEffort: 'max' } })
  assert.equal(result.notStarted, undefined)
  assert.equal(result.card.started.childId, 'child-1')
  assert.deepEqual(result.card.started.options, { workspaceId: 'w1', worktree: false, agentPreset: 'minimal', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'max', permission: 'workspace-write' })
  assert.deepEqual(host.prompts.map(item => [item.sessionId, item.content[0].text]), [['child-1', '只改说明']])
  assert.deepEqual(Object.keys(host.storedChildren()), ['child-1'])
  row.dispose()
})

test('a direct start whose remembered model was removed uses this session\'s model instead of stopping at the options', async (t) => {
  const host = createHost({ lastModel: { provider: 'p', model: 'gone' } })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', { permission: 'workspace-write' })
  host.events.set('parent', turnOf(1, '发布页那件事另开一个会话做。'))
  const row = await host.open()
  const result = await propose(host, parent, { title: '更正发布页', brief: '只改说明', userQuote: '另开一个会话做' })
  assert.equal(result.notStarted, undefined)
  assert.deepEqual(result.card.started.options.model, { provider: 'p', model: 'pro' })
  row.dispose()
})

// ---------- 卡片 A（ask: true）：轮末出卡、三种设置、动作路由、校验和回报 ----------

const renderPropose = (host, args, result) => host.tools.get(PROPOSE).output.render(args, result)[0].text

const askTask = { title: '核对说明', brief: '核对最新选项', ask: true }

/** 一张已经在日志里的待处理卡片 A。 */
const pendingAskCard = (turn, callId, title) => [
  { type: 'tool/call', data: { turn, step: 1, callId, name: PROPOSE, arguments: '{}' } },
  { type: 'tool/result', data: { turn, step: 1, message: { id: 'm', role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [] }, meta: { ok: true, card: { title, brief: `${title}的说明`, options: {}, kind: 'ask' } } } },
]

async function setupAskParent(t, agentOptions = {}, prefs = { ownSession: 'ask' }) {
  const host = createHost({ prefs })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', agentOptions)
  host.events.set(parent.id, [...turnOf(1, '核对说明'), ...pendingAskCard(1, 'a1', '核对说明')])
  const row = await host.open()
  t.after(() => row.dispose())
  const act = (verb, remember) => host.post('/api/dsh-workbench.session-cards.act', {
    sessionId: parent.id, cardId: 'a1', verb, remember,
  })
  return { host, parent, row, act }
}

test('Card A parent lifecycle: cold resume publishes the live agent; stale or archived actions leave preferences and messages alone', async t => {
  for (const condition of ['resumed', 'released at resume', 'archived', 'replaced at resume']) {
    for (const [verb, remember] of [['start', 'always-new'], ['here', 'always-here']]) {
      await t.test(`${condition} / ${verb}`, async t => {
        const { host, parent, row, act } = await setupAskParent(t)
        host.unload(parent)
        const resolve = row.sessionController.resolveAgent.bind(row.sessionController)
        row.sessionController.resolveAgent = async id => {
          const found = await resolve(id)
          if (id === parent.id) {
            if (condition === 'released at resume') host.unload(parent)
            if (condition === 'replaced at resume') host.addAgent(id)
            if (condition === 'archived') row.workspaceRegistry.archivedSessionIds = [id]
          }
          return found
        }
        const response = await act(verb, remember)
        if (condition === 'resumed') {
          assert.equal(response.status, 200)
          assert.equal(host.prompts.length, 1)
        } else {
          assert.equal(response.body.ok, false)
          assert.deepEqual(host.created, [])
          assert.deepEqual(host.prompts, [])
          assert.deepEqual(host.records, [])
          assert.deepEqual(JSON.parse(readFileSync(host.prefsFile)), { ownSession: 'ask' })
        }
      })
    }
  }
})

test('Card A reports the workspace reason when no workspace or session directory can be inherited', async t => {
  const { parent, row, act, host } = await setupAskParent(t)
  parent.session.header.cwd = undefined
  row.workspaceRegistry.list = () => []
  const response = await act('start')
  assert.equal(response.status, 409)
  assert.deepEqual(response.body.error, { code: 'ask-not-inheritable', reason: 'workspace' })
  assert.deepEqual(host.created, [])
})

test('Card A exact inheritance: retired effort, implicit effort and changed permission', async t => {
  for (const condition of ['retired effort', 'implicit effort', 'permission absent from catalog', 'permission raised before delivery']) {
    await t.test(condition, async t => {
      const model = { provider: 'p', model: 'pro', ...(condition === 'implicit effort' ? {} : { reasoningEffort: condition === 'retired effort' ? 'retired' : 'high' }) }
      const { host, parent, row, act } = await setupAskParent(t, { model })
      if (condition === 'permission absent from catalog') {
        row.get('permissionPresets').catalog = () => ({ options: [{ value: 'read-only', name: 'Read only' }] })
      }
      if (condition === 'permission raised before delivery') {
        row.workspaceRegistry.list()[0].insertSessionBefore = async () => { host.permissions.set(parent.id, 'danger-full-access') }
      }
      const response = await act('start')
      if (condition === 'implicit effort') {
        assert.equal(response.status, 200)
        assert.deepEqual(host.selectedModels, [{ sessionId: 'child-1', provider: 'p', model: 'pro' }])
        assert.equal('reasoningEffort' in host.records[0].data.options, false)
      } else {
        assert.deepEqual(response.body, { ok: false, error: { code: 'ask-not-inheritable', reason: condition === 'retired effort' ? 'options' : 'permission' } })
        assert.deepEqual(host.prompts, [])
        assert.deepEqual(host.records, [])
        assert.deepEqual(host.storedChildren(), {})
        if (condition === 'permission raised before delivery') assert.deepEqual(host.archived, ['child-1'])
        else assert.deepEqual(host.created, [])
      }
    })
  }
})

test('Card A parent lifecycle: a cold-resumed parent must still be current before dispatching the first message', async t => {
  for (const condition of ['released', 'replaced', 'archived']) await t.test(condition, async t => {
    const { host, parent, row, act } = await setupAskParent(t)
    host.unload(parent)
    row.workspaceRegistry.list()[0].insertSessionBefore = async () => {
      if (condition === 'released') host.unload(parent)
      if (condition === 'replaced') host.addAgent(parent.id)
      if (condition === 'archived') row.workspaceRegistry.archivedSessionIds = [parent.id]
    }
    assert.equal((await act('start')).body.ok, false)
    assert.deepEqual(host.prompts, [])
    assert.deepEqual(host.records, [])
    assert.deepEqual(host.storedChildren(), {})
    assert.deepEqual(host.archived, ['child-1'])
  })
})

test('Card A directory waits settle on cancellation while a provider remains unresponsive', async t => {
  for (const [setting, stop] of [
    ['always-new', 'turn'], ['always-here', 'dispose agent'], ['act', 'archive'], ['act', 'unload row'],
  ]) await t.test(`${setting} / ${stop}`, async t => {
    const { host, parent, row, act } = await setupAskParent(t, {}, { ownSession: setting === 'act' ? 'ask' : setting })
    if (setting !== 'act') host.events.set(parent.id, turnOf(1, '核对说明'))
    const entered = Promise.withResolvers()
    const provider = Promise.withResolvers()
    const catalog = row.sessionController.modelCatalog
    row.sessionController.modelCatalog = () => { entered.resolve(); return provider.promise }
    const controller = new AbortController()
    const action = setting === 'act' ? act('start') : host.tools.get(PROPOSE).execute(
      { title: '另一个题目', brief: '核对', ask: true }, { agent: parent, callId: 'a2', signal: controller.signal },
    )
    let outcome
    const settled = action.then(response => { outcome = response }, error => { outcome = error })
    try {
      await entered.promise
      if (stop === 'turn') controller.abort()
      if (stop === 'dispose agent') {
        host.unload(parent)
        host.emit('agent/disposed', { agent: parent })
      }
      if (stop === 'archive') {
        row.workspaceRegistry.archivedSessionIds = [parent.id]
        host.emit('workspace/session-archived', { sessionId: parent.id })
      }
      if (stop === 'unload row') row.dispose()
      await host.settle()
      if (setting === 'act') assert.equal(outcome?.body?.ok, false)
      else assert.equal(outcome?.name, 'AbortError')
    } finally {
      provider.resolve(await catalog())
      await settled
    }
    assert.deepEqual(host.created, [])
    assert.deepEqual(host.records, [])
  })
})

test('Card A row teardown waits for a child creation already sent and archives it before finishing', async t => {
  const { host, row, act } = await setupAskParent(t)
  const create = row.sessionController.create.bind(row.sessionController)
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  row.sessionController.create = async request => { started.resolve(); await finish.promise; return create(request) }
  const action = act('start')
  await started.promise
  let unloaded = false
  const disposal = row.dispose().then(() => { unloaded = true })
  try {
    await host.settle()
    assert.equal(unloaded, false)
  } finally {
    finish.resolve()
    await Promise.all([disposal, action])
  }
  assert.deepEqual(host.archived, ['child-1'])
  assert.deepEqual(host.storedChildren(), {})
  assert.deepEqual(host.prompts, [])
  assert.deepEqual(host.records, [])
})

test('Card A in ask mode (default): returns a pending Card A right away without calling userQuestions, renders askPending, and folds to pending', async (t) => {
  for (const locale of ['zh', 'en']) {
    let asked = 0
    const host = createHost({
      userQuestions: {
        async ask() {
          asked += 1
          throw new Error('userQuestions.ask must not be called')
        },
      },
    })
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent')
    const events = turnOf(1, '把发布说明整理一下')
    host.events.set('parent', events)
    const row = await host.open(locale)
    t.after(() => row.dispose())

    const args = { title: '整理发布说明', brief: '核对 CHANGELOG', ask: true }
    const result = await propose(host, parent, args, 'ask-pending-1')
    assert.equal(asked, 0)
    assert.deepEqual(result, { ok: true, card: { title: '整理发布说明', brief: '核对 CHANGELOG', options: {}, kind: 'ask' } })
    assert.equal('ask' in result.card, false)
    assert.equal('started' in result.card, false)
    assert.deepEqual(host.created, [])
    assert.deepEqual(host.prompts, [])
    assert.equal(typeof SESSION_CARDS_HOST[locale].askPending, 'string')
    assert.equal(renderPropose(host, args, result), fillCopy(SESSION_CARDS_HOST[locale].askPending, { title: '整理发布说明' }))

    const folded = [
      ...events,
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'ask-pending-1', name: PROPOSE, arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'm1', role: 'tool', toolCallId: 'ask-pending-1', source: { kind: 'tool', callId: 'ask-pending-1' }, content: [] }, meta: result } },
    ].reduce(cardsFold, cardsInit())
    assert.equal(folded.cards.length, 1)
    assert.deepEqual(folded.cards[0], {
      id: 'ask-pending-1', turn: 1, order: 0, title: '整理发布说明', brief: '核对 CHANGELOG', options: {}, kind: 'ask', state: 'pending',
    })
  }
})

test('ask setting always-new: starts immediately with current session options without asking and preserves lastModel', async (t) => {
  let asked = 0
  const host = createHost({
    lastModel: { provider: 'p', model: 'flash' },
    prefs: { ownSession: 'always-new' },
    userQuestions: {
      async ask() {
        asked += 1
        throw new Error('userQuestions.ask must not be called')
      },
    },
  })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', {
    preset: 'minimal',
    model: { provider: 'p', model: 'pro', reasoningEffort: 'max' },
    permission: 'workspace-write',
  })
  host.events.set('parent', turnOf(1, '把发布说明整理一下'))
  const row = await host.open()
  t.after(() => row.dispose())

  const args = { title: '整理发布说明', brief: '核对 CHANGELOG', ask: true }
  const result = await propose(host, parent, args, 'ask-auto-new')
  assert.equal(asked, 0)
  assert.equal(result.ok, true)
  assert.equal(result.card.kind, 'ask')
  assert.deepEqual(result.card.ask, { choice: 'new', auto: 'setting' })
  assert.equal(result.card.started.childId, 'child-1')
  assert.deepEqual(result.card.started.options, {
    workspaceId: 'w1',
    worktree: false,
    agentPreset: 'minimal',
    model: { provider: 'p', model: 'pro' },
    reasoningEffort: 'max',
    permission: 'workspace-write',
  })
  assert.deepEqual(result.card.options, result.card.started.options)
  assert.deepEqual(host.selectedModels[0], { sessionId: 'child-1', provider: 'p', model: 'pro', reasoningEffort: 'max' })
  assert.deepEqual(host.prompts.map(item => [item.sessionId, item.content[0].text]), [['child-1', '核对 CHANGELOG']])
  assert.deepEqual(host.storedLastModel(), { provider: 'p', model: 'flash' })
  assert.equal(typeof SESSION_CARDS_HOST.zh.askStartedAuto, 'string')
  assert.equal(renderPropose(host, args, result), fillCopy(SESSION_CARDS_HOST.zh.askStartedAuto, { title: '整理发布说明' }))
})

test('ask setting always-new: returns a pending Card A without asking when current session settings cannot be inherited', async (t) => {
  for (const [name, agentOptions, extra] of [
    ['custom permission', { permission: 'custom' }, {}],
    ['removed model', { model: { provider: 'p', model: 'gone' }, permission: 'workspace-write' }, {}],
    ['retired preset', { preset: 'retired' }, {}],
    ['broken preset', {}, { breakStandard: true }],
    ['missing workspace', {}, { clearWorkspace: true }],
    ['permission lowered before prompt', {}, { lowerBeforePrompt: true }],
  ]) await t.test(name, async () => {
    let asked = 0
    const host = createHost({
      prefs: { ownSession: 'always-new' },
      userQuestions: {
        async ask() {
          asked += 1
          throw new Error('userQuestions.ask must not be called')
        },
      },
    })
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent', agentOptions)
    host.events.set('parent', turnOf(1, '整理发布说明'))
    const row = await host.open()
    t.after(() => row.dispose())
    if (extra.breakStandard) {
      const list = row.agentPresets.list.bind(row.agentPresets)
      row.agentPresets.list = async () => (await list()).map(preset =>
        preset.id === 'standard' ? { ...preset, broken: 'provider unavailable' } : preset)
    }
    if (extra.clearWorkspace) {
      for (const ws of row.workspaceRegistry.list()) {
        const at = ws.sessionIds.indexOf(parent.id)
        if (at >= 0) ws.sessionIds.splice(at, 1)
      }
      parent.session.header.cwd = undefined
    }
    if (extra.lowerBeforePrompt) {
      row.workspaceRegistry.list()[0].insertSessionBefore = async () => {
        host.permissions.set(parent.id, 'read-only')
      }
    }

    const args = { title: '整理发布说明', brief: '核对', ask: true }
    const result = await propose(host, parent, args, `fallback-${name}`)
    assert.equal(asked, 0)
    assert.deepEqual(result, { ok: true, card: { title: '整理发布说明', brief: '核对', options: {}, kind: 'ask' } })
    assert.equal(renderPropose(host, args, result), fillCopy(SESSION_CARDS_HOST.zh.askPending, { title: '整理发布说明' }))
    assert.deepEqual(host.prompts, [])
    assert.deepEqual(host.storedChildren(), {})
    if (extra.lowerBeforePrompt) assert.deepEqual(host.archived, ['child-1'])
    else assert.deepEqual(host.created, [])

    const folded = [
      { type: 'tool/call', data: { turn: 1, callId: 'c', name: PROPOSE } },
      { type: 'tool/result', data: { message: { toolCallId: 'c' }, meta: result } },
    ].reduce(cardsFold, cardsInit())
    assert.equal(folded.cards[0].kind, 'ask')
    assert.equal(folded.cards[0].state, 'pending')
    assert.equal('ask' in folded.cards[0], false)
  })
})

test('ask setting always-here: returns handle-here without asking or sending a user message, re-reads prefs, and keeps working if catalog fails', async (t) => {
  let asked = 0
  const host = createHost({
    prefs: { ownSession: 'always-here' },
    userQuestions: {
      async ask() {
        asked += 1
        throw new Error('userQuestions.ask must not be called')
      },
    },
  })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  host.events.set('parent', turnOf(1, '整理发布说明'))
  const row = await host.open()
  t.after(() => row.dispose())

  const args = { title: '整理发布说明', brief: '核对', ask: true }
  const first = await propose(host, parent, args, 'ask-auto-here')
  assert.equal(asked, 0)
  assert.deepEqual(host.created, [])
  assert.deepEqual(host.prompts, [])
  assert.equal(first.card.kind, 'ask')
  assert.deepEqual(first.card.ask, { choice: 'here', auto: 'setting' })
  assert.equal(first.card.started, undefined)
  assert.equal(typeof SESSION_CARDS_HOST.zh.askHereAuto, 'string')
  assert.equal(renderPropose(host, args, first), fillCopy(SESSION_CARDS_HOST.zh.askHereAuto, { title: '整理发布说明' }))

  row.sessionController.modelCatalog = async () => { throw new Error('catalog unavailable') }
  host.events.set('parent', turnOf(2, '再按设置留在这里'))
  const catalogDown = await propose(host, parent, { title: '目录挂了的事', brief: '核对', ask: true }, 'ask-auto-here-no-catalog')
  assert.equal(asked, 0)
  assert.deepEqual(catalogDown.card.ask, { choice: 'here', auto: 'setting' })
  assert.deepEqual(catalogDown.card.options.model, { provider: 'p', model: 'pro' })

  writeFileSync(host.prefsFile, JSON.stringify({ ownSession: 'ask' }))
  host.events.set('parent', turnOf(3, '改回每次询问'))
  const third = await propose(host, parent, { title: '第三件事', brief: '核对', ask: true }, 'ask-reread')
  assert.equal(asked, 0)
  assert.deepEqual(third, { ok: true, card: { title: '第三件事', brief: '核对', options: {}, kind: 'ask' } })
})

test('act route on Card A start: ignores body.options (even danger-full-access), inherits parent settings, preserves lastModel, and records CARD_RECORD', async (t) => {
  const worktrees = worktreeService('removed')
  const host = createHost({ lastModel: { provider: 'p', model: 'flash' }, worktrees })
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent', {
    preset: 'minimal',
    model: { provider: 'p', model: 'pro', reasoningEffort: 'max' },
    permission: 'workspace-write',
  })
  const events = [...turnOf(1, '整理发布说明'), ...pendingAskCard(1, 'ask-1', '整理发布说明')]
  host.events.set('parent', events)
  const row = await host.open()
  t.after(() => row.dispose())

  const answer = await host.post('/api/dsh-workbench.session-cards.act', {
    sessionId: 'parent',
    cardId: 'ask-1',
    verb: 'start',
    options: {
      workspaceId: 'w2',
      worktree: true,
      agentPreset: 'standard',
      model: { provider: 'p', model: 'flash' },
      reasoningEffort: 'high',
      permission: 'danger-full-access',
    },
  })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { ok: true, value: { childId: 'child-1' } })
  assert.deepEqual(worktrees.calls, [])
  assert.equal(host.created.length, 1)
  assert.deepEqual(host.created[0].request, { workspaceId: 'w1', agentPreset: 'minimal' })
  assert.equal(host.permissions.get('child-1'), 'workspace-write')
  assert.deepEqual(host.selectedModels[0], { sessionId: 'child-1', provider: 'p', model: 'pro', reasoningEffort: 'max' })
  assert.deepEqual(host.prompts.map(item => [item.sessionId, item.content[0].text]), [['child-1', '整理发布说明的说明']])
  assert.deepEqual(host.storedLastModel(), { provider: 'p', model: 'flash' })

  const expectedOptions = {
    workspaceId: 'w1',
    worktree: false,
    agentPreset: 'minimal',
    model: { provider: 'p', model: 'pro' },
    reasoningEffort: 'max',
    permission: 'workspace-write',
  }
  assert.equal(host.records.length, 1)
  assert.deepEqual(host.records[0].data, {
    cardId: 'ask-1',
    action: 'start',
    childId: 'child-1',
    options: expectedOptions,
  })
  const folded = [...events, { type: host.records[0].type, ignorable: true, data: host.records[0].data }].reduce(cardsFold, cardsInit())
  assert.equal(folded.cards[0].kind, 'ask')
  assert.equal(folded.cards[0].state, 'started')
  assert.equal(folded.cards[0].childId, 'child-1')
  assert.deepEqual(folded.cards[0].ask, { choice: 'new' })
  assert.deepEqual(folded.cards[0].started, expectedOptions)
})

test('act route on Card A start: returns 409 ask-not-inheritable with reason and starts nothing when parent settings are not inheritable', async (t) => {
  for (const [name, agentOptions, reason, extra] of [
    ['custom permission', { permission: 'custom' }, 'permission', {}],
    ['removed model', { model: { provider: 'p', model: 'gone' } }, 'options', {}],
    ['retired preset', { preset: 'retired' }, 'options', {}],
    ['broken preset', {}, 'options', { breakStandard: true }],
    ['missing workspace', {}, 'workspace', { clearWorkspace: true }],
    ['permission downgraded before prompt', {}, 'permission', { lowerBeforePrompt: true }],
  ]) await t.test(name, async () => {
    const host = createHost()
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent', agentOptions)
    host.events.set('parent', [...turnOf(1, '整理发布说明'), ...pendingAskCard(1, 'ask-ni', '整理发布说明')])
    const row = await host.open()
    t.after(() => row.dispose())
    if (extra.breakStandard) {
      const list = row.agentPresets.list.bind(row.agentPresets)
      row.agentPresets.list = async () => (await list()).map(preset =>
        preset.id === 'standard' ? { ...preset, broken: 'provider unavailable' } : preset)
    }
    if (extra.clearWorkspace) {
      for (const ws of row.workspaceRegistry.list()) {
        const at = ws.sessionIds.indexOf(parent.id)
        if (at >= 0) ws.sessionIds.splice(at, 1)
      }
      parent.session.header.cwd = undefined
    }
    if (extra.lowerBeforePrompt) {
      row.workspaceRegistry.list()[0].insertSessionBefore = async () => {
        host.permissions.set(parent.id, 'read-only')
      }
    }

    const answer = await host.post('/api/dsh-workbench.session-cards.act', {
      sessionId: 'parent',
      cardId: 'ask-ni',
      verb: 'start',
      options: { permission: 'workspace-write' },
    })
    assert.equal(answer.status, 409)
    assert.deepEqual(answer.body, { ok: false, error: { code: 'ask-not-inheritable', reason } })
    assert.deepEqual(host.prompts, [])
    assert.deepEqual(host.records, [])
    assert.deepEqual(host.storedChildren(), {})
    if (extra.lowerBeforePrompt) assert.deepEqual(host.archived, ['child-1'])
    else assert.deepEqual(host.created, [])
  })
})

test('act route on Card A here: sends user message in allowed zh/en wording or host fallback and records CARD_RECORD', async (t) => {
  for (const [label, locale, clientText, expectedText] of [
    ['zh', 'zh', '在当前会话处理：整理发布说明', '在当前会话处理：整理发布说明'],
    ['en from zh host', 'zh', 'Handle it in this session: 整理发布说明', 'Handle it in this session: 整理发布说明'],
    ['arbitrary text falls back to host locale', 'en', 'Do something else entirely', 'Handle it in this session: 整理发布说明'],
  ]) await t.test(label, async () => {
    const host = createHost()
    t.after(() => host.cleanup())
    host.addAgent('parent')
    const events = [...turnOf(1, '整理发布说明'), ...pendingAskCard(1, 'ask-here', '整理发布说明')]
    host.events.set('parent', events)
    const row = await host.open(locale)
    t.after(() => row.dispose())

    const answer = await host.post('/api/dsh-workbench.session-cards.act', {
      sessionId: 'parent',
      cardId: 'ask-here',
      verb: 'here',
      text: clientText,
    })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    assert.deepEqual(host.created, [])
    assert.deepEqual(host.prompts.map(item => [item.sessionId, item.content[0].text]), [['parent', expectedText]])
    assert.deepEqual(host.records.map(r => r.data), [{ cardId: 'ask-here', action: 'here' }])

    const folded = [...events, { type: host.records[0].type, ignorable: true, data: host.records[0].data }].reduce(cardsFold, cardsInit())
    assert.equal(folded.cards[0].kind, 'ask')
    assert.equal(folded.cards[0].state, 'here')
    assert.deepEqual(folded.cards[0].ask, { choice: 'here' })
    assert.equal('childId' in folded.cards[0], false)
  })
})

test('act route on Card A remember and dismiss: validates pairings, saves prefs before acting, and returns notSaved on save failure', async (t) => {
  // 1. 合法配对：always-new + start / always-here + here
  for (const [verb, remember] of [['start', 'always-new'], ['here', 'always-here']]) {
    const host = createHost()
    t.after(() => host.cleanup())
    host.addAgent('parent')
    host.events.set('parent', [...turnOf(1, '整理发布说明'), ...pendingAskCard(1, 'ask-rem', '整理发布说明')])
    const row = await host.open()
    t.after(() => row.dispose())

    const answer = await host.post('/api/dsh-workbench.session-cards.act', {
      sessionId: 'parent',
      cardId: 'ask-rem',
      verb,
      remember,
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal('notSaved' in answer.body, false)
    if (verb === 'start') assert.equal(answer.body.value?.childId, 'child-1')
    assert.deepEqual(JSON.parse(readFileSync(host.prefsFile, 'utf8')), { ownSession: remember })
    assert.equal(host.records[0].data.remember, remember)
  }

  // 2. 先写设置再做动作：start 返回 409 ask-not-inheritable 时，合法的 remember 已写入设置文件
  {
    const host = createHost()
    t.after(() => host.cleanup())
    host.addAgent('parent', { permission: 'custom' })
    host.events.set('parent', [...turnOf(1, '整理发布说明'), ...pendingAskCard(1, 'ask-rem-409', '整理发布说明')])
    const row = await host.open()
    t.after(() => row.dispose())

    const answer = await host.post('/api/dsh-workbench.session-cards.act', {
      sessionId: 'parent',
      cardId: 'ask-rem-409',
      verb: 'start',
      remember: 'always-new',
    })
    assert.equal(answer.status, 409)
    assert.deepEqual(answer.body, { ok: false, error: { code: 'ask-not-inheritable', reason: 'permission' } })
    assert.deepEqual(JSON.parse(readFileSync(host.prefsFile, 'utf8')), { ownSession: 'always-new' })
    assert.deepEqual(host.records, [])
  }

  // 3. 非法配对、dismiss、以及卡片 B 带 remember 一律 400 invalid-input，不动设置也不做动作
  for (const [isCardB, payload] of [
    [false, { verb: 'start', remember: 'always-here' }],
    [false, { verb: 'here', remember: 'always-new' }],
    [false, { verb: 'start', remember: 'ask' }],
    [false, { verb: 'here', remember: 123 }],
    [false, { verb: 'dismiss' }],
    [false, { verb: 'dismiss', remember: 'always-here' }],
    [true, { verb: 'start', options: START_OPTIONS, remember: 'always-new' }],
    [true, { verb: 'here', remember: 'always-here' }],
  ]) {
    const host = createHost({ prefs: { ownSession: 'ask' } })
    t.after(() => host.cleanup())
    host.addAgent('parent')
    host.events.set('parent', [
      ...turnOf(1, '整理发布说明'),
      ...(isCardB ? pendingCard(1, 'card-1', '整理发布说明') : pendingAskCard(1, 'card-1', '整理发布说明')),
    ])
    const row = await host.open()
    t.after(() => row.dispose())

    const answer = await host.post('/api/dsh-workbench.session-cards.act', {
      sessionId: 'parent',
      cardId: 'card-1',
      ...payload,
    })
    assert.equal(answer.status, 400, JSON.stringify(payload))
    assert.deepEqual(answer.body, { ok: false, error: { code: 'invalid-input' } }, JSON.stringify(payload))
    assert.deepEqual(JSON.parse(readFileSync(host.prefsFile, 'utf8')), { ownSession: 'ask' })
    assert.deepEqual(host.created, [])
    assert.deepEqual(host.prompts, [])
    assert.deepEqual(host.records, [])
  }

  // 4. 写设置失败时照样做动作，回答带 top-level notSaved: true
  for (const [verb, remember] of [['start', 'always-new'], ['here', 'always-here']]) {
    const host = createHost()
    t.after(() => host.cleanup())
    mkdirSync(host.prefsFile)
    host.addAgent('parent')
    host.events.set('parent', [...turnOf(1, '整理发布说明'), ...pendingAskCard(1, 'ask-notsaved', '整理发布说明')])
    const row = await host.open()
    t.after(() => row.dispose())

    const answer = await host.post('/api/dsh-workbench.session-cards.act', {
      sessionId: 'parent',
      cardId: 'ask-notsaved',
      verb,
      remember,
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.notSaved, true)
    if (verb === 'start') {
      assert.deepEqual(answer.body.value, { childId: 'child-1' })
      assert.deepEqual(host.prompts.map(p => [p.sessionId, p.content[0].text]), [['child-1', '整理发布说明的说明']])
    } else {
      assert.equal('value' in answer.body, false)
      assert.deepEqual(host.prompts.map(p => [p.sessionId, p.content[0].text]), [['parent', '在当前会话处理：整理发布说明']])
    }
    assert.equal(host.records[0].data.remember, remember)
  }
})

test('Card A retries repair a rejected decision record without delivering either action again', async t => {
  for (const verb of ['here', 'start']) {
    for (const retrySame of [true, false]) await t.test(verb + (retrySame ? ' same action' : ' opposite action after reload'), async () => {
      const host = createHost()
      t.after(() => host.cleanup())
      const parent = host.addAgent('parent')
      host.events.set(parent.id, [...turnOf(1, 'check'), ...pendingAskCard(1, 'receipt', 'Check the docs')])
      const row = await host.open('en')
      t.after(() => row.dispose())
      const route = '/api/dsh-workbench.session-cards.act'
      const remember = verb === 'start' ? 'always-new' : 'always-here'
      const request = { sessionId: parent.id, cardId: 'receipt', verb, remember }
      recordSinks.set(parent.session, { push() { throw new Error('session log unavailable') } })
      const interrupted = await host.post(route, request)
      assert.equal(interrupted.status, 503)
      assert.equal(interrupted.body.error.code, 'record-pending')
      assert.equal(host.prompts.length, 1)
      row.dispose()
      const replacement = await host.open('en')
      t.after(() => replacement.dispose())
      recordSinks.set(parent.session, host.records)
      const retryVerb = retrySame ? verb : verb === 'start' ? 'here' : 'start'
      const retry = await host.post(route, { ...request, verb: retryVerb, remember: retryVerb === 'start' ? 'always-new' : 'always-here' })
      assert.equal(host.prompts.length, 1, 'the first action was already delivered')
      assert.equal(host.created.length, verb === 'start' ? 1 : 0)
      assert.deepEqual(host.records.map(({ data }) => [data.action, data.childId, data.remember]), [[verb, verb === 'start' ? 'child-1' : undefined, remember]])
      assert.deepEqual(JSON.parse(readFileSync(host.prefsFile, 'utf8')), { ownSession: remember })
      assert.equal(retry.status, retrySame ? 200 : 409)
      if (retrySame && verb === 'start') assert.deepEqual(retry.body.value, { childId: 'child-1' })
      if (!retrySame) assert.equal(retry.body.error.code, 'card-decided')
    })
  }
})

test('Card A reload keeps an in-flight delivery locked until its decision is recorded', async t => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  host.events.set(parent.id, [...turnOf(1, 'check'), ...pendingAskCard(1, 'overlap', 'Check the docs')])
  const row = await host.open()
  t.after(() => row.dispose())
  const { promise, resolve } = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const prompt = row.sessionController.prompt
  row.sessionController.prompt = async request => {
    const sent = await prompt(request)
    entered.resolve()
    await promise
    return sent
  }
  const body = { sessionId: parent.id, cardId: 'overlap', verb: 'here' }
  const route = '/api/dsh-workbench.session-cards.act'
  const first = host.post(route, body)
  await entered.promise
  row.dispose()
  const replacement = await host.open()
  t.after(() => replacement.dispose())
  const competing = host.post(route, { ...body, verb: 'start' })
  await host.settle()
  resolve()
  const [answer, second] = await Promise.all([first, competing])
  assert.equal(answer.status, 200)
  assert.equal(second.status, 409)
  assert.equal(host.prompts.length, 1)
  assert.deepEqual(host.created, [])
})

test('act route on Card B: start, here and dismiss keep working unchanged', async (t) => {
  for (const verb of ['start', 'here', 'dismiss']) {
    const host = createHost()
    t.after(() => host.cleanup())
    host.addAgent('parent')
    const events = [...turnOf(1, '改发布页'), ...pendingCard(1, 'b1', '更正发布页')]
    host.events.set('parent', events)
    const row = await host.open()
    t.after(() => row.dispose())

    const body = verb === 'start'
      ? { sessionId: 'parent', cardId: 'b1', verb, options: START_OPTIONS }
      : { sessionId: 'parent', cardId: 'b1', verb }
    const answer = await host.post('/api/dsh-workbench.session-cards.act', body)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(host.records[0].data.action, verb)
  }
})

test('ask: rejects when options or userQuote is passed alongside ask: true', async (t) => {
  for (const locale of ['zh', 'en']) {
    const host = createHost()
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent')
    const row = await host.open(locale)
    t.after(() => row.dispose())
    for (const extra of [{ options: { agentPreset: 'minimal' } }, { options: {} }, { userQuote: '另开一个会话' }]) {
      await assert.rejects(
        () => propose(host, parent, { title: '整理说明', brief: '核对', ask: true, ...extra }),
        (error) => {
          const expected = SESSION_CARDS_HOST[locale].rejectAskArgs
          assert.equal(typeof expected, 'string')
          assert.equal(error.message, expected)
          return true
        },
      )
    }
  }
})

test('ask reservation is released only when its own final result is logged', async t => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  const events = turnOf(1, '整理说明')
  host.events.set(parent.id, events)
  const row = await host.open()
  t.after(() => row.dispose())
  const args = { title: '整理说明', brief: '核对', ask: true }
  const ask = callId => propose(host, parent, args, callId)
  const append = event => {
    events.push(event)
    host.emit('session/event', parent.session, event)
  }
  const [call, result] = pendingCard(1, 'ask-1', args.title)
  append(call)
  assert.equal((await ask('ask-1')).card.kind, 'ask')
  result.data.message.isError = true
  // rc.3 can block a tool in post-execute after its body returned successfully.
  delete result.data.meta
  const unrelated = pendingCard(1, 'other-call', '另一件事')[1]
  append(unrelated)
  await assert.rejects(() => ask('too-early'), error => error.message === SESSION_CARDS_HOST.zh.rejectAskLimit)
  append(result)
  assert.equal((await ask('retry')).card.kind, 'ask')
})

test('ask reservation from a disposed session does not block its reopened session', async t => {
  const host = createHost()
  t.after(() => host.cleanup())
  const parent = host.addAgent('parent')
  host.events.set(parent.id, turnOf(1, '整理说明'))
  const row = await host.open()
  t.after(() => row.dispose())
  const args = { title: '整理说明', brief: '核对', ask: true }
  await propose(host, parent, args, 'unfinished')
  host.emit('session/disposed', parent.session)
  const reopened = host.addAgent(parent.id)
  assert.equal((await propose(host, reopened, args, 'retry')).card.kind, 'ask')
})

test('ask: enforces 1-ask-per-turn (parallel and sequential), 3-cards-per-turn, duplicate title, and subagent rejection', async (t) => {
  // 1. ask 模式同一轮并行/连续调两次（第二次先于日志落盘，以及落盘后）均拒绝；三张上限、同题去重与子智能体拒绝照旧
  {
    const host = createHost()
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent')
    const events = turnOf(1, '整理一下发布说明')
    host.events.set('parent', events)
    const row = await host.open()
    t.after(() => row.dispose())

    const first = propose(host, parent, { title: '整理发布说明', brief: '核对', ask: true }, 'ask-1')
    await assert.rejects(
      () => propose(host, parent, { title: '核对更新日志', brief: '核对', ask: true }, 'ask-2'),
      error => error.message === SESSION_CARDS_HOST.zh.rejectAskLimit,
    )
    const firstResult = await first
    assert.equal(firstResult.card.kind, 'ask')
    assert.equal(firstResult.card.ask, undefined)
    events.push(
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'ask-1', name: PROPOSE, arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'm1', role: 'tool', toolCallId: 'ask-1', source: { kind: 'tool', callId: 'ask-1' }, content: [] }, meta: firstResult } },
    )

    await assert.rejects(
      () => propose(host, parent, { title: '第三件事', brief: '核对', ask: true }, 'ask-3'),
      error => error.message === SESSION_CARDS_HOST.zh.rejectAskLimit,
    )
    await assert.rejects(
      () => propose(host, parent, { title: '整理发布说明', brief: '再提一次' }, 'card-b-dup'),
      error => error.message === SESSION_CARDS_HOST.zh.rejectPending,
    )

    const b1 = await propose(host, parent, { title: '顺便修第二件事', brief: 'b1' }, 'card-b1')
    events.push(...pendingCard(1, 'card-b1', b1.card.title))
    const b2 = await propose(host, parent, { title: '顺便修第三件事', brief: 'b2' }, 'card-b2')
    events.push(...pendingCard(1, 'card-b2', b2.card.title))
    await assert.rejects(
      () => propose(host, parent, { title: '第四件事', brief: 'b3' }, 'card-b3'),
      error => error.message === SESSION_CARDS_HOST.zh.rejectLimit,
    )

    host.events.set('parent', [...events, ...turnOf(2, '下一轮')])
    const nextTurn = await propose(host, parent, { title: '下一轮的事', brief: '核对', ask: true }, 'ask-4')
    assert.equal(nextTurn.card.kind, 'ask')

    const subagent = host.addAgent('sub')
    subagent.session.header.origin = 'subagent'
    await assert.rejects(
      () => propose(host, subagent, { title: '子智能体的事', brief: '核对', ask: true }, 'ask-sub'),
      error => error.message === SESSION_CARDS_HOST.zh.rejectSubagent,
    )
  }

  // 2. always-here 异步读目录卡住期间，并行第二个 ask: true 也必须被 rejectAskLimit 拦下
  {
    const host = createHost({ prefs: { ownSession: 'always-here' } })
    t.after(() => host.cleanup())
    const parent = host.addAgent('parent')
    host.events.set('parent', turnOf(1, '整理一下'))
    const row = await host.open()
    t.after(() => row.dispose())

    const entered = Promise.withResolvers()
    const gate = Promise.withResolvers()
    const catalog = row.sessionController.modelCatalog
    row.sessionController.modelCatalog = () => {
      entered.resolve()
      return gate.promise
    }
    const first = propose(host, parent, { title: '一', brief: '说明', ask: true }, 'p1')
    await entered.promise
    await assert.rejects(
      () => propose(host, parent, { title: '二', brief: '说明', ask: true }, 'p2'),
      error => error.message === SESSION_CARDS_HOST.zh.rejectAskLimit,
    )
    gate.resolve(await catalog())
    const settled = await first
    assert.deepEqual(settled.card.ask, { choice: 'here', auto: 'setting' })
  }
})

test('prefs route: GET defaults to ask when missing or corrupt, POST validates and persists ownSession', async (t) => {
  const host = createHost()
  t.after(() => host.cleanup())
  const row = await host.open()
  t.after(() => row.dispose())

  const path = '/api/dsh-workbench.session-cards.prefs'
  assert.deepEqual(await host.get(path), { status: 200, body: { ownSession: 'ask' } })

  assert.deepEqual(await host.post(path, { ownSession: 'always-new' }), { status: 200, body: { ok: true, config: { ownSession: 'always-new' } } })
  assert.deepEqual(await host.get(path), { status: 200, body: { ownSession: 'always-new' } })
  assert.deepEqual(JSON.parse(readFileSync(host.prefsFile, 'utf8')), { ownSession: 'always-new' })

  const invalid = await host.post(path, { ownSession: 'invalid' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.ok, false)
  assert.match(invalid.body.message, /ownSession/)

  const badJson = await host.post(path, '{broken')
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.ok, false)
  assert.deepEqual(await host.get(path), { status: 200, body: { ownSession: 'always-new' } })

  writeFileSync(host.prefsFile, '{broken')
  assert.deepEqual(await host.get(path), { status: 200, body: { ownSession: 'ask' } })
  writeFileSync(host.prefsFile, '{"ownSession":123}')
  assert.deepEqual(await host.get(path), { status: 200, body: { ownSession: 'ask' } })
})

test('child session started from Card A (always-new and /act start) gets child rules, cannot propose again, and reports back to parent', async (t) => {
  for (const mode of ['always-new', 'act']) {
    for (const [locale, marker] of [['zh', '用户同意以后开的'], ['en', 'its model proposed you and the user agreed']]) {
      const host = createHost({ prefs: mode === 'always-new' ? { ownSession: 'always-new' } : undefined })
      t.after(() => host.cleanup())
      const parent = host.addAgent('parent')
      const events = turnOf(1, '整理发布说明')
      host.events.set('parent', events)
      const row = await host.open(locale)
      t.after(() => row.dispose())

      const result = await propose(host, parent, { title: '整理发布说明', brief: '核对', ask: true }, 'call-a-report')
      events.push(
        { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-a-report', name: PROPOSE, arguments: '{}' } },
        { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'm1', role: 'tool', toolCallId: 'call-a-report', source: { kind: 'tool', callId: 'call-a-report' }, content: [] }, meta: result } },
      )
      if (mode === 'act') {
        const acted = await host.post('/api/dsh-workbench.session-cards.act', { sessionId: 'parent', cardId: 'call-a-report', verb: 'start' })
        assert.equal(acted.status, 200)
        events.push({ type: host.records[0].type, ignorable: true, data: host.records[0].data })
      }

      const child = row.agents.get('child-1')
      assert.equal(host.sectionsOn(child)[0].text.includes(marker), true)
      assert.deepEqual(host.deniedOn(child), [PROPOSE])
      await assert.rejects(
        () => propose(host, child, { title: '孙会话', brief: '核对', ask: true }, 'grandchild'),
        error => error.message === SESSION_CARDS_HOST[locale].rejectChild,
      )

      host.emit('session/event', child.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '发布说明对完了。' }] } } })
      host.emit('session/event', child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
      host.emit('agent/status', { agent: child, status: 'idle' })
      await new Promise(resolve => setTimeout(resolve, 450))
      await host.settle()

      assert.equal(parent.followups.length, 1)
      assert.equal(parent.followups[0].source.kind, 'workbench-session-report')
      assert.equal(parent.followups[0].source.cardId, 'call-a-report')
      assert.equal(parent.followups[0].source.state, 'done')
      assert.equal(parent.followups[0].source.last, '发布说明对完了。')

      const folded = [...events, { type: 'user/message', data: parent.followups[0] }].reduce(cardsFold, cardsInit())
      assert.equal(folded.cards.length, 1)
      assert.equal(folded.cards[0].kind, 'ask')
      assert.equal(folded.cards[0].state, 'started')
      assert.deepEqual(folded.cards[0].report, { state: 'done', last: '发布说明对完了。' })
    }
  }
})

test('copy contract: removed Card A v1 keys are gone and v2 askPending, askParam, toolDescription and prompt match', () => {
  for (const locale of ['zh', 'en']) {
    const text = SESSION_CARDS_HOST[locale]
    for (const removed of ['askQuestion', 'askStarted', 'askHere', 'askHereCustom', 'askHereNoAnswer', 'askNotStarted', 'askNotSaved']) {
      assert.equal(removed in text, false, `${locale}.${removed} should be deleted`)
    }
    assert.equal(typeof text.askPending, 'string')
  }
  assert.equal(
    SESSION_CARDS_HOST.zh.askPending,
    '已在这一轮末尾问用户要不要另开一个会话做「{title}」。用户选之前先不要做这件事：选了新建会话，工作台会开好会话，它停下时以「新会话回报」转告你；选了在当前会话处理，用户会发消息让你接着做。',
  )
  assert.equal(
    SESSION_CARDS_HOST.en.askPending,
    'Asked the user at the end of this turn whether to do "{title}" in its own session. Do not do it until they choose: if they choose a new session, the workbench starts it and passes you a "New session report" when it stops; if they choose to handle it here, they will send a message for you to continue.',
  )
  assert.equal(
    SESSION_CARDS_HOST.zh.askParam,
    '可选。填 true：这件事是用户这一轮交代的，在这一轮末尾问用户要不要另开一个会话做，用户选之前不要做；只填 title 和 brief，新会话用当前会话的工作区、Agent 预设、模型、推理等级和权限。不填：是你自己发现的另一件事，在这一轮末尾出带选项的卡片。',
  )
  assert.equal(
    SESSION_CARDS_HOST.en.askParam,
    "Optional. true: the user gave you this task in this turn; ask at the end of this turn whether to do it in its own session, and do not do it until they choose. Give only title and brief; the new session uses this session's workspace, agent preset, model, reasoning effort and permission. Omit it for another task you found yourself, which gets a card with options at the end of this turn.",
  )
  assert.match(SESSION_CARDS_HOST.zh.toolDescription, /填 ask: true 时改为在这一轮末尾问用户要不要另开会话。$/)
  assert.match(SESSION_CARDS_HOST.en.toolDescription, /With ask: true it asks the user at the end of this turn whether to start it in its own session\.$/)
  assert.match(
    SESSION_CARDS_HOST.zh.prompt,
    /用户这一轮交代的事和这个会话正在做的事无关、适合单独做时，可以调用 propose_session 并填 ask: true，在这一轮末尾问用户要不要另开会话，然后结束这一轮，用户选之前不要做这件事。一轮最多问一次；用户亲口说了要另开会话的，照 userQuote 直接开，不要问。$/,
  )
  assert.match(
    SESSION_CARDS_HOST.en.prompt,
    /When the user's task in this turn is unrelated to what this session is doing and fits its own session, you may call propose_session with ask: true to ask at the end of this turn whether to start it in its own session, then end the turn and do not do the task until they choose\. Ask at most once per turn; when the user asked for a separate session in their own words, start it with userQuote instead of asking\.$/,
  )
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config } from '../lib/preset-switch.js'

const STANDARD = 'standard'
const CODING = 'dsh-workbench-coding'
const FULL = 'dsh-workbench-full'
const endpoint = '/api/dsh-workbench.preset-switch'
function fixture(config = {}) {
  const routes = new Map()
  const calls = []
  const snapshot = { agentPreset: STANDARD, sessionListMetadata: { blank: false }, userQuestions: { active: [] } }
  const boundary = { lastTurn: 1, openTurnStartSeq: null }
  const journal = []
  const agent = { id: 's1', ctx: {}, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: { cwd: '/work' }, append(type, data) {
      calls.push(['append', type, data]); journal.push({ type, data })
      if (type === 'agent-preset/selected') snapshot.agentPreset = data.agentPreset
      return { seq: journal.length }
    } },
    runMaintenance: async work => work(new AbortController().signal) }
  const values = { live: STANDARD, pendingInput: [] }
  const roster = [{ id: STANDARD }, { id: CODING, name: 'Code mode', description: 'Code tools' }, { id: FULL, name: 'Full mode' }]
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, turnBoundaryOf: () => boundary },
    agentPresets: { list: async () => roster, composedPreset: () => values.live, presetForSession: () => snapshot.agentPreset,
      // rc.3 locks started sessions in the official selector; the route must not depend on it.
      select: async () => { calls.push(['select']); throw Object.assign(new Error('already started'), { code: 'agent-preset/locked' }) },
      recompose: async (agentCtx, to) => { assert.equal(agentCtx, agent.ctx); calls.push(['recompose', to]); values.live = to; return { id: to } } },
    sessions: { get: () => undefined },
    sessionQuery: { inspectSession: async (id, read) => read(agent.session) },
    sessionProjections: { snapshot: () => ({ values: snapshot }) },
    sessionController: {
      state: async () => ({ active: true, running: false, queue: [], pendingInput: values.pendingInput }),
      projections: async () => ({ kind: 'sequenced', values: snapshot }),
      resolveAgent: async () => ({ error: new Error('not found') }),
    },
    commands: { execute: async (a, line, items, signal) => {
      assert.equal(a, agent); assert.deepEqual(items, []); assert.ok(signal instanceof AbortSignal)
      calls.push(line); return { result: { kind: 'success' } }
    } },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect: fn => fn(), get: () => undefined,
  }
  apply(ctx, config)
  const req = (path, init) => new Request('http://localhost' + path, init)
  async function post(body, type = 'application/json; charset=utf-8') {
    const response = await routes.get(endpoint).fetch(req(endpoint, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) }))
    return { status: response.status, ...await response.json() }
  }
  async function step(which, fields = {}) {
    const { status, ...body } = await post({ sessionId: agent.id, agentPreset: CODING, step: which, ...fields })
    return body
  }
  return { ctx, agent, routes, snapshot, boundary, values, calls, journal, roster, req, post, step }
}

test('validated settings retain configured order, deduplicate and reject invalid thresholds', () => {
  const parse = value => Config['~standard'].validate(value)
  assert.deepEqual(parse({}).value, { presets: [STANDARD, CODING, FULL], compactFirstAboveTokens: 65536 })
  assert.deepEqual(parse({ presets: [FULL, STANDARD, FULL], compactFirstAboveTokens: 0 }).value,
    { presets: [FULL, STANDARD], compactFirstAboveTokens: 0 })
  for (const invalid of [{ presets: 'standard' }, { presets: [''] }, { compactFirstAboveTokens: -1 }, { compactFirstAboveTokens: 1.5 }]) {
    assert.ok(parse(invalid).issues?.length)
  }
})

test('menu uses recorded current, configured order, actual registration, language and turn state', async () => {
  const f = fixture({ presets: [FULL, CODING, STANDARD] })
  f.roster.find(row => row.id === CODING).broken = 'missing service'
  const read = async () => (await (await f.routes.get(endpoint).fetch(f.req(endpoint + '?sessionId=s1', { headers: { 'accept-language': 'zh-CN' } }))).json()).value
  f.values.live = FULL
  assert.deepEqual((await read()).targets.map(t => [t.id, t.name]), [[FULL, 'Full mode'], [STANDARD, '标准模式']])
  assert.equal((await read()).current, STANDARD)
  assert.equal((await read()).switchable, true)
  f.snapshot.sessionListMetadata.blank = true
  f.boundary.lastTurn = 0
  assert.equal((await read()).switchable, false)
  assert.deepEqual(f.calls, [])
  assert.ok(f.routes.has(endpoint + '/preview'))
})

test('stale preview on either step returns actual preset before sending a command or switching', async () => {
  const f = fixture()
  for (const action of ['compact', 'switch']) {
    assert.deepEqual(await f.step(action, { expectedFrom: FULL }), { ok: false, error: { code: 'stale-preview', current: STANDARD } })
  }
  assert.deepEqual(f.calls, [])
  assert.deepEqual(await f.step('compact'), { ok: true })
  assert.deepEqual(f.calls, ['/compact'])
})

test('validates both ends and disallows a broken, unavailable or unchanged preset', async () => {
  const f = fixture({ presets: [STANDARD, CODING] })
  for (const to of [STANDARD, FULL, 'absent']) assert.equal((await f.step('switch', { agentPreset: to })).error.code, 'unsupported')
  f.roster.find(r => r.id === CODING).broken = 'test'
  assert.equal((await f.step('switch')).error.code, 'unsupported')
  f.snapshot.agentPreset = f.values.live = 'dsh-workbench-readonly-review'
  assert.equal((await f.step('compact', { agentPreset: STANDARD })).error.code, 'unsupported')
  assert.deepEqual(f.calls, [])
})

test('running turn, undrained inbox, pending approval, plan review and question all refuse mutations', async () => {
  for (const block of [
    f => { f.agent.status = 'running' }, f => { f.boundary.openTurnStartSeq = 12 },
    f => { f.agent.inbox.nextTurn.push({}) }, f => { f.agent.inbox.nextStep.push({}) },
    f => { f.values.pendingInput = ['approval'] }, f => { f.values.pendingInput = ['other'] },
    f => { f.snapshot.userQuestions.active.push({ state: 'continued' }) },
  ]) {
    const f = fixture(); block(f)
    for (const action of ['compact', 'switch']) assert.equal((await f.step(action)).error.code, 'not-idle')
    assert.deepEqual(f.calls, [])
  }
})

test('each session rejects overlapping operations and rechecks expectedFrom after compact completes', async () => {
  const f = fixture()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.ctx.commands.execute = async () => { entered.resolve(); await release.promise; return { result: { kind: 'success' } } }
  const first = f.step('compact', { expectedFrom: STANDARD })
  await entered.promise
  assert.equal((await f.step('switch', { expectedFrom: STANDARD })).error.code, 'busy')
  release.resolve()
  assert.deepEqual(await first, { ok: true })
  f.values.live = f.snapshot.agentPreset = FULL
  assert.equal((await f.step('switch', { expectedFrom: STANDARD })).error.code, 'stale-preview')
  assert.deepEqual(f.calls, [])
})

test('official compact result is awaited, and a compact failure never attempts selection', async () => {
  const f = fixture()
  f.ctx.commands.execute = async () => ({ result: { kind: 'error', text: 'could not produce a summary' } })
  assert.deepEqual(await f.step('compact'), { ok: false, error: { code: 'compact-failed', current: STANDARD } })
  assert.deepEqual(f.calls, [])
})

const selected = to => ['append', 'agent-preset/selected', { agentPreset: to }]

test('a started idle session rebinds with recompose, then journals agent-preset/selected', async () => {
  const f = fixture()
  assert.deepEqual(await f.step('switch', { expectedFrom: STANDARD }), { ok: true, value: { agentPreset: CODING } })
  assert.deepEqual(f.calls, [['recompose', CODING], selected(CODING)])
  assert.equal(f.values.live, CODING)
  assert.equal(f.snapshot.agentPreset, CODING)
  f.calls.length = 0
  assert.deepEqual(await f.step('switch', { agentPreset: FULL, expectedFrom: CODING }), { ok: true, value: { agentPreset: FULL } })
  assert.deepEqual(f.calls, [['recompose', FULL], selected(FULL)])
  assert.ok(!f.calls.some(([kind]) => kind === 'select'), 'the official blank-session selector is not used')
})

test('a failed journal append rebinds the source preset and reports it', async () => {
  const f = fixture()
  f.agent.session.append = (type, data) => { f.calls.push(['append', type, data]); throw new Error('journal write failed') }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'record-failed', current: STANDARD } })
  assert.deepEqual(f.calls, [['recompose', CODING], selected(CODING), ['recompose', STANDARD]])
  assert.equal(f.values.live, STANDARD)
  assert.equal(f.snapshot.agentPreset, STANDARD)
})

test('failure to restore reports the preset actually bound after both errors', async () => {
  const f = fixture()
  f.agent.session.append = () => { throw new Error('journal unavailable') }
  f.ctx.agentPresets.recompose = async (_, to) => {
    f.calls.push(['recompose', to])
    if (to === STANDARD) throw new Error('module failed to start')
    f.values.live = to
    return { id: to }
  }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'record-failed', current: CODING } })
  assert.deepEqual(f.calls, [['recompose', CODING], ['recompose', STANDARD]])
  assert.equal(f.snapshot.agentPreset, STANDARD)
})

test('a host that cannot rebind a started session reports unsupported and journals nothing', async () => {
  const f = fixture()
  f.ctx.agentPresets.recompose = async () => { throw Object.assign(new Error('locked'), { code: 'agent-preset/locked' }) }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'unsupported', current: STANDARD } })
  delete f.ctx.agentPresets.recompose
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'unsupported', current: STANDARD } })
  assert.deepEqual(f.journal, [])
  assert.equal(f.snapshot.agentPreset, STANDARD)
})

test('a rebind that lands on another preset is undone and reported as a switch failure', async () => {
  const f = fixture()
  f.ctx.agentPresets.recompose = async (_, to) => { f.calls.push(['recompose', to]); f.values.live = to === CODING ? FULL : to; return { id: f.values.live } }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'switch-failed', current: STANDARD } })
  assert.deepEqual(f.calls, [['recompose', CODING], ['recompose', STANDARD]])
  assert.deepEqual(f.journal, [])
})

test('a turn that starts before the maintenance slot opens refuses the switch without rebinding', async () => {
  for (const runMaintenance of [
    async work => { const c = new AbortController(); c.abort(); return work(c.signal) },
    async () => { throw new Error('turn already running') },
  ]) {
    const f = fixture()
    f.agent.runMaintenance = runMaintenance
    assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'not-idle', current: STANDARD } })
    assert.deepEqual(f.calls, [])
  }
})

test('a turn in progress refuses the switch and the journal keeps the source preset', async () => {
  const f = fixture()
  f.agent.status = 'running'
  f.boundary.openTurnStartSeq = 40
  assert.deepEqual(await f.step('switch', { expectedFrom: STANDARD }), { ok: false, error: { code: 'not-idle', current: STANDARD } })
  assert.deepEqual(f.calls, [])
  assert.equal(f.snapshot.agentPreset, STANDARD)
})

test('a second switch while the first is rebinding is busy and does not journal twice', async () => {
  const f = fixture()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const recompose = f.ctx.agentPresets.recompose
  f.ctx.agentPresets.recompose = async (...args) => { entered.resolve(); await release.promise; return recompose(...args) }
  const first = f.step('switch', { expectedFrom: STANDARD })
  await entered.promise
  assert.deepEqual(await f.step('switch', { agentPreset: FULL, expectedFrom: STANDARD }), { ok: false, error: { code: 'busy', current: STANDARD } })
  release.resolve()
  assert.deepEqual(await first, { ok: true, value: { agentPreset: CODING } })
  assert.deepEqual(f.journal.map(entry => entry.data.agentPreset), [CODING])
})

test('subagents and blank sessions are left to their own preset rules', async () => {
  const child = fixture()
  child.agent.session.header.origin = 'subagent'
  assert.deepEqual(await child.step('switch'), { ok: false, error: { code: 'unsupported', current: STANDARD } })
  const blank = fixture()
  blank.boundary.lastTurn = 0
  assert.deepEqual(await blank.step('switch'), { ok: false, error: { code: 'unsupported', current: STANDARD } })
  assert.deepEqual([...child.calls, ...blank.calls], [])
})

test('routes only accept exact methods, JSON bodies and valid identifiers', async () => {
  const f = fixture()
  assert.deepEqual(new Set(f.routes.keys()), new Set([endpoint, endpoint + '/preview']))
  const body = { sessionId: 's1', agentPreset: CODING, step: 'switch' }
  assert.equal((await f.post(body, 'text/plain')).status, 415)
  for (const bad of [null, { ...body, sessionId: '../bad' }, { ...body, expectedFrom: 0 }, { ...body, step: 'unknown' }]) {
    assert.equal((await f.post(bad)).status, 400)
  }
  assert.deepEqual(f.calls, [])
})

test('a cold preview reads the journal without starting an Agent or any of its MCP processes', async () => {
  const f = fixture()
  f.ctx.agents.get = () => undefined
  let resumes = 0
  f.ctx.sessionController.resolveAgent = () => { resumes++; throw new Error('unexpected resume') }
  const target = endpoint + '/preview?sessionId=s1&agentPreset=' + CODING
  const response = await (await f.routes.get(endpoint + '/preview').fetch(f.req(target))).json()
  assert.equal(resumes, 0)
  assert.equal(response.ok, true)
  assert.equal(response.value.from, STANDARD)
  assert.equal(response.value.to, CODING)
  assert.equal(response.value.tools, null)
  assert.equal(response.value.changes, null)
})

test('expectedFrom is checked again after the asynchronous idle read and prior to a command', async () => {
  for (const step of ['compact', 'switch']) {
    const f = fixture()
    f.ctx.sessionController.state = async () => {
      f.values.live = f.snapshot.agentPreset = FULL
      return { active: true, running: false, queue: [], pendingInput: [] }
    }
    assert.deepEqual(await f.step(step, { expectedFrom: STANDARD }), { ok: false, error: { code: 'stale-preview', current: FULL } })
    assert.deepEqual(f.calls, [])
  }
})

test('an operation on one session does not reserve another session', async () => {
  const f = fixture()
  const second = { ...f.agent, id: 's2', ctx: {} }
  f.ctx.agents.get = id => id === second.id ? second : f.agent
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.ctx.commands.execute = async () => { entered.resolve(); await release.promise; return { result: { kind: 'success' } } }
  const first = f.step('compact')
  await entered.promise
  try {
    const answer = await f.step('switch', { sessionId: second.id, expectedFrom: FULL })
    assert.equal(answer.error.code, 'stale-preview')
  } finally { release.resolve(); await first }
})

test('a missing live binding is reported honestly even if the journal still names a preset', async () => {
  const f = fixture()
  f.values.live = undefined
  const answer = await f.step('switch', { expectedFrom: STANDARD })
  assert.deepEqual(answer, { ok: false, error: { code: 'stale-preview', current: null } })
  assert.deepEqual(f.calls, [])
})

test('a stale POST to a cold session is rejected without resuming its Agent', async () => {
  const f = fixture()
  f.ctx.agents.get = () => undefined
  let resumes = 0
  f.ctx.sessionController.resolveAgent = async () => { resumes++; return { agent: f.agent } }
  for (const operation of ['compact', 'switch']) {
    assert.deepEqual(await f.step(operation, { expectedFrom: FULL }), { ok: false, error: { code: 'stale-preview', current: STANDARD } })
  }
  assert.equal(resumes, 0)
  assert.deepEqual(f.calls, [])
})

test('admission rejects input that arrived while the preset roster was being inspected', async () => {
  for (const step of ['compact', 'switch']) {
    const f = fixture()
    const started = Promise.withResolvers(), finish = Promise.withResolvers()
    f.ctx.agentPresets.list = async () => { started.resolve(); await finish.promise; return f.roster }
    const op = f.step(step, { expectedFrom: STANDARD })
    await started.promise
    await new Promise(resolve => setImmediate(resolve))
    f.agent.inbox.nextTurn.push({ id: 'queued-during-diagnostics' })
    finish.resolve()
    assert.deepEqual(await op, { ok: false, error: { code: 'not-idle', current: STANDARD } })
    assert.deepEqual(f.calls, [])
  }
})

test('a stale refresh can read an already selected target without running an operation', async () => {
  const f = fixture()
  f.snapshot.agentPreset = f.values.live = CODING
  const path = endpoint + '/preview'
  const result = await (await f.routes.get(path).fetch(f.req(path + '?sessionId=s1&agentPreset=' + CODING))).json()
  assert.equal(result.ok, true)
  assert.equal(result.value.from, CODING)
  assert.equal(result.value.to, CODING)
  assert.equal((await f.step('switch', { expectedFrom: CODING })).error.code, 'unsupported')
  assert.deepEqual(f.calls, [])
})

test('a newly forwarded interaction also refuses a command after the passive state sample', async () => {
  const f = fixture()
  const events = []
  f.ctx.get = name => name === 'typertGateway' ? { getPendingRemoteEvents: () => events } : undefined
  f.ctx.sessionController.state = async () => {
    const sample = { active: true, running: false, queue: [], pendingInput: [] }
    events.push({ agentId: f.agent.id, event: 'approval/request' })
    return sample
  }
  assert.equal((await f.step('compact')).error?.code, 'not-idle')
  assert.deepEqual(f.calls, [])
})

test('L01 cold subagent and child sessions are not switchable and preview returns unsupported without waking an Agent', async () => {
  for (const header of [{ cwd: '/work', origin: 'subagent' }, { cwd: '/work', parentSession: 's0' }]) {
    const f = fixture()
    f.ctx.agents.get = () => undefined
    let resumes = 0
    f.ctx.sessionController.resolveAgent = () => { resumes++; throw new Error('unexpected resume') }
    f.ctx.sessions = { get: () => undefined }
    f.ctx.sessionQuery = { inspectSession: async (id, read) => { assert.equal(id, 's1'); return read({ header }) } }
    const menuRes = await (await f.routes.get(endpoint).fetch(f.req(endpoint + '?sessionId=s1'))).json()
    assert.equal(menuRes.ok, true)
    assert.equal(menuRes.value.switchable, false)
    const previewRes = await (await f.routes.get(endpoint + '/preview').fetch(f.req(endpoint + '/preview?sessionId=s1&agentPreset=' + CODING))).json()
    assert.deepEqual(previewRes, { ok: false, error: { code: 'unsupported', current: STANDARD } })
    assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'unsupported', current: STANDARD } })
    assert.equal(resumes, 0)
    assert.deepEqual(f.calls, [])
  }
})

test('L08 transient recompose failure reports switch-failed instead of unsupported when live preset stays unchanged', async () => {
  const f = fixture()
  f.ctx.agentPresets.recompose = async (_, to) => {
    f.calls.push(['recompose', to])
    throw new Error('plugin mount timeout')
  }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'switch-failed', current: STANDARD } })
  assert.deepEqual(f.calls, [['recompose', CODING]])
  for (const code of ['agent-preset/locked', 'agent-preset/not-found', 'agent-preset/invalid']) {
    const g = fixture()
    g.ctx.agentPresets.recompose = async () => { throw Object.assign(new Error(code), { code }) }
    assert.deepEqual(await g.step('switch'), { ok: false, error: { code: 'unsupported', current: STANDARD } })
  }
})

test('feat162 keeps live preset and journal aligned if append succeeds without matching recorded preset', async () => {
  const f = fixture()
  f.ctx.agentPresets.recompose = async (_, to) => {
    f.calls.push(['recompose', to])
    if (to === STANDARD) throw new Error('restore failed')
    f.values.live = to
    return { id: to }
  }
  f.agent.session.append = (type, data) => {
    f.calls.push(['append', type, data])
    f.journal.push({ type, data })
    if (f.calls.filter(([kind]) => kind === 'append').length >= 2) f.snapshot.agentPreset = data.agentPreset
    return { seq: f.journal.length }
  }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'record-failed', current: CODING } })
  assert.equal(f.values.live, CODING)
  assert.equal(f.snapshot.agentPreset, CODING)
  assert.deepEqual(f.calls, [['recompose', CODING], selected(CODING), ['recompose', STANDARD], selected(CODING)])

  const g = fixture()
  let appends = 0
  g.agent.session.append = (type, data) => {
    g.calls.push(['append', type, data])
    appends += 1
    if (appends === 1) {
      g.journal.push({ type, data }, { type, data: { agentPreset: FULL } })
      g.snapshot.agentPreset = FULL
      g.agent.session.seq = g.journal.length
      return { seq: 0 }
    }
    throw new Error('compensating append failed')
  }
  assert.deepEqual(await g.step('switch'), { ok: false, error: { code: 'record-failed', current: FULL } })
  assert.equal(g.values.live, g.journal.at(-1).data.agentPreset)
  assert.deepEqual(g.calls, [['recompose', CODING], selected(CODING), ['recompose', STANDARD], selected(STANDARD), ['recompose', FULL]])
})

test('rebind uses recompose returned preset id and rejects mismatched return values', async () => {
  const f = fixture()
  f.ctx.agentPresets.recompose = async (_, to) => {
    f.calls.push(['recompose', to])
    f.values.live = to
    return { id: to === CODING ? FULL : to }
  }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'switch-failed', current: STANDARD } })
  assert.deepEqual(f.calls, [['recompose', CODING], ['recompose', STANDARD]])
  assert.deepEqual(f.journal, [])
  assert.equal(f.values.live, STANDARD)
})

test('a delayed preset projection cannot leave the journal pointing at the rolled-back target', async () => {
  const f = fixture()
  f.agent.session.append = (type, data) => {
    f.journal.push({ type, data })
    f.agent.session.seq = f.journal.length
    return { seq: f.journal.length - 1 }
  }
  assert.deepEqual(await f.step('switch'), { ok: false, error: { code: 'record-failed', current: STANDARD } })
  assert.equal(f.journal.at(-1).data.agentPreset, f.values.live)

  const g = fixture()
  g.agent.session.append = (type, data) => {
    if (g.journal.length) throw new Error('journal unavailable')
    g.journal.push({ type, data })
    g.agent.session.seq = 1
    return { seq: 0 }
  }
  assert.deepEqual(await g.step('switch'), { ok: false, error: { code: 'record-failed', current: CODING } })
  assert.equal(g.values.live, g.journal.at(-1).data.agentPreset)
})

test('a cold session with no readable header cannot be offered or awakened', async () => {
  const f = fixture()
  f.ctx.agents.get = () => undefined
  delete f.ctx.sessions
  delete f.ctx.sessionQuery
  let resumes = 0
  f.ctx.sessionController.resolveAgent = async () => { resumes++; return { agent: f.agent } }
  const menu = await (await f.routes.get(endpoint).fetch(f.req(endpoint + '?sessionId=s1'))).json()
  assert.equal(menu.value.switchable, false)
  const path = endpoint + '/preview'
  const preview = await (await f.routes.get(path).fetch(f.req(path + '?sessionId=s1&agentPreset=' + CODING))).json()
  assert.equal(preview.error?.code, 'unsupported')
  assert.equal((await f.step('switch')).error?.code, 'unsupported')
  assert.equal(resumes, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewPresetSwitch } from '../lib/preset-switch-preview.js'

const schema = name => ({ name, description: name, parameters: { type: 'object' } })
const source = 'standard', target = 'code'
const route = { provider: 'provider', model: 'model' }
const history = Object.freeze([
  Object.freeze({ seq: 0, type: 'agent-preset/selected', data: Object.freeze({ agentPreset: source }) }),
  { seq: 1, type: 'system/message' }, { seq: 2, type: 'user/message' },
  { seq: 3, type: 'system/message' }, { seq: 4, type: 'assistant/message' },
])
function fixture() {
  const header = Object.freeze({ id: 'live', version: 4, createdAt: 1, agentPreset: 'initial', isSeeded: false })
  const original = { id: 'live', seq: 5, header,
    requestHeader: () => ({ config: route, tools: [schema('list'), schema('read')] }),
    deriveMessages: () => [{ role: 'system', content: [{ type: 'text', text: 'old' }] }],
    requestContext: () => ({ ...route, systemPromptUpdate: 'in-history' }),
    append: () => assert.fail('must not write live session'),
  }
  const agent = { id: 'live', ctx: {}, model: { current: () => route }, session: original }
  const fromScope = { preset: source }, toScope = { preset: target }
  let observations = 0, revisions = 0, scopes = 0, admissions = 0
  const parents = new Map([[agent, fromScope]])
  const ctx = {
    baseUrl: import.meta.url,
    get(name) { return this[name] },
    agentPresets: {
      composedPreset: () => source,
      async acquireScope(id) {
        revisions++
        return { key: id === source ? fromScope : toScope, [Symbol.asyncDispose]() { revisions-- } }
      },
    },
    sessionQuery: {
      async observeSession() {
        observations++
        return { events: history, cursor: 4, header, inheritedEventCount: 0,
          [Symbol.dispose]() { observations-- } }
      },
    },
    sessions: {
      prepare(id, { seed, meta, eventState }) {
        assert.notEqual(id, 'live')
        assert.equal(meta.id, id)
        assert.equal(eventState, 'shared-frozen')
        return { id, seq: seed.length, header: meta, selection: seed.findLast(e => e.type === 'agent-preset/selected')?.data.agentPreset ?? meta.agentPreset,
          append: () => assert.fail('must not write a preview session') }
      },
    },
    loader: { internal: { async import(id) {
      if (id === '@deepseek-ai/dsh-scope') return {
        scopeParentOf: key => parents.get(key),
        createScope(_ctx, subject, { parent }) {
          scopes++
          parents.set(subject, parent)
          return { ctx: { preset: parent.preset }, dispose() { scopes-- } }
        },
      }
      if (id === '@deepseek-ai/dsh-system-prompt') return { renderPrompt: a => a.sections[0].text }
      if (id === '@deepseek-ai/dsh-token-meter/estimate') return { estimateToolsTokens: header => 10 * header.tools.length }
      throw Error('unexpected host API ' + id)
    } } },
    tools: {
      view() { return { visible: new Map() } },
      async resolve({ agent: subject }) {
        assert.notEqual(subject, agent)
        assert.notEqual(subject.session, original)
        assert.equal(subject.ctx.preset, subject.session.selection)
        admissions++
        return { view: () => new Map(), dispose() { admissions-- } }
      },
    },
    systemPrompt: { async assemble({ agent: subject, scope, toolSet, modelSelection }) {
      assert.equal(scope, subject)
      assert.ok(toolSet)
      assert.deepEqual(modelSelection, route)
      const id = subject.session.selection
      return { tools: id === source ? [schema('list'), schema('read')] : [schema('read'), schema('write')],
        sections: [{ text: id === source ? 'old' : 'next' }, { text: '' }] }
    } },
    tokenMeter: {
      measure: () => ({ logRevision: 5, surfaceTokens: 105, nodes: [
        { seq: 1, tokens: 10 }, { seq: 2, tokens: 60 }, { seq: 3, tokens: 5 }, { seq: 4, tokens: 30 },
      ] }),
      estimateMessage: message => message.content[0].text === 'next' ? 12 : 8,
    },
    agents: { get: id => ({ busy: { status: 'running' }, waiting: { status: 'idle' } })[id] },
    subagents: { listDescendants: async () => [
      { kind: 'child', mode: 'continuable', activity: 'running', id: 'waiting' },
      { kind: 'child', mode: 'one-shot', activity: 'running', id: 'busy' },
      { kind: 'child', mode: 'one-shot', activity: 'inactive', id: 'done' },
    ] },
  }
  return { ctx, agent, held: () => [observations, revisions, scopes, admissions] }
}
async function run({ ctx, agent }) {
  return previewPresetSwitch(ctx, agent, { from: source, to: target, compactFirstAboveTokens: 127 })
}
test('assembles the two actual compositions in unpublished scopes, preserves source selection and releases all leases', async () => {
  const host = fixture()
  const value = await run(host)
  assert.deepEqual(value, { from: source, to: target, changes: true,
    tools: { added: ['write'], removed: ['list'] }, systemPrompt: 'appended',
    uncachedTokens: 127, compactSuggested: true, runningSubagents: 1,
  })
  assert.deepEqual(host.held(), [0, 0, 0, 0])
  assert.equal(history[0].data.agentPreset, source)
})

test('a changed model cannot inherit the old route capability', async () => {
  const host = fixture()
  host.agent.session.requestContext = () => ({ ...route, model: 'other', systemPromptUpdate: 'in-history' })
  const value = await run(host)
  assert.deepEqual(value.tools, { added: ['write'], removed: ['list'] })
  assert.equal(value.systemPrompt, null)
  assert.equal(value.changes, true)
  assert.equal(value.uncachedTokens, null)
  assert.equal(value.compactSuggested, null)
})

test('an unavailable target or uninspectable child does not invent a count, difference or price', async () => {
  const host = fixture()
  host.ctx.agentPresets.acquireScope = async () => { throw Error('preset retired') }
  host.ctx.subagents.listDescendants = async () => [{ kind: 'diagnostic', id: 'child' }]
  assert.deepEqual(await run(host), { from: source, to: target, tools: null, systemPrompt: null,
    changes: null, uncachedTokens: null, compactSuggested: null, runningSubagents: null })
  assert.deepEqual(host.held(), [0, 0, 0, 0])
})

test('a failed renderer keeps the tool comparison and releases admissions and revision leases', async () => {
  const host = fixture(), sdkImport = host.ctx.loader.internal.import
  host.ctx.loader.internal.import = async id => id === '@deepseek-ai/dsh-system-prompt'
    ? { renderPrompt: () => { throw Error('unknown variable') } } : sdkImport(id)
  const value = await run(host)
  assert.deepEqual(value.tools, { added: ['write'], removed: ['list'] })
  assert.equal(value.systemPrompt, null)
  assert.equal(value.uncachedTokens, null)
  assert.deepEqual(host.held(), [0, 0, 0, 0])
})

test('a separately mounted, optional token meter can price a changed prompt under Cordis injection', async () => {
  const host = fixture(), meter = host.ctx.tokenMeter, get = host.ctx.get.bind(host.ctx)
  host.ctx.get = name => name === 'tokenMeter' ? meter : get(name)
  Object.defineProperty(host.ctx, 'tokenMeter', { get() { throw Error('cannot get property without inject') } })
  const value = await run(host)
  assert.equal(value.uncachedTokens, 127)
  assert.equal(value.compactSuggested, true)
})

test('a cold parent counts active descendants without loading an Agent or guessing a retained revision', async () => {
  const { ctx } = fixture()
  // A parent may be cold while a local child has its own live handle.
  ctx.sessionController = { resolveAgent: () => assert.fail('a preview must not wake a persisted parent') }
  const value = await previewPresetSwitch(ctx, undefined, { from: source, to: target, sessionId: 'cold' })
  assert.deepEqual(value, { from: source, to: target, changes: null, tools: null, systemPrompt: null,
    uncachedTokens: null, compactSuggested: null, runningSubagents: 1 })
})

test('includes the published file-reference contribution when only the target supplies read', async () => {
  const host = fixture(), sdkImport = host.ctx.loader.internal.import
  class LocalFileReferenceService {}
  const guidance = 'Use the read tool for a path mention.'
  host.ctx.fileReferences = new LocalFileReferenceService()
  host.ctx.loader.internal.import = async id => id === '@deepseek-ai/dsh-file-reference-local'
    ? { LocalFileReferenceService, FILE_REFERENCE_PROMPT: guidance } : sdkImport(id)
  host.ctx.tools.get = (name, subject) => name === 'read' && subject.ctx.preset === target ? schema('read') : undefined
  host.ctx.tokenMeter.estimateMessage = ({ content }) => content[0].text.includes(guidance) ? 54 : 12
  const value = await run(host)
  assert.equal(value.systemPrompt, 'appended')
  assert.equal(value.uncachedTokens, 169)
})

test('an unidentified Agent-owned prompt keeps tools visible but cannot waive confirmation or price the change', async () => {
  const host = fixture()
  host.agent.session.deriveMessages = () => [{ role: 'system', content: [{ type: 'text', text: 'old\n\nPrivate Agent-only section.' }] }]
  const value = await run(host)
  assert.deepEqual(value.tools, { added: ['write'], removed: ['list'] })
  assert.equal(value.changes, true)
  assert.equal(value.systemPrompt, null)
  assert.equal(value.uncachedTokens, null)
})

test('unavailable or unknown route metadata leaves independent tool changes intact', async () => {
  for (const currentContext of [undefined, () => ({ ...route, systemPromptUpdate: 'unknown-mode' })]) {
    const host = fixture()
    host.agent.session.requestContext = currentContext
    const value = await run(host)
    assert.deepEqual(value.tools, { added: ['write'], removed: ['list'] })
    assert.equal(value.changes, true)
    assert.equal(value.systemPrompt, null)
    assert.equal(value.uncachedTokens, null)
  }
})

test('a rewritten conversation since the last request does not promise an in-history update', async () => {
  const host = fixture()
  const observe = host.ctx.sessionQuery.observeSession
  host.agent.session.seq += 2
  host.ctx.sessionQuery.observeSession = async (...args) => {
    const cut = await observe(...args)
    return { ...cut, cursor: 6, events: [...cut.events,
      { seq: 5, type: 'compaction/summary', data: {} },
      { seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, data: {} }] }
  }
  const result = await run(host)
  assert.deepEqual(result.tools, { added: ['write'], removed: ['list'] })
  assert.equal(result.changes, true)
  assert.equal(result.systemPrompt, null)
  assert.equal(result.uncachedTokens, null)
  assert.deepEqual(host.held(), [0, 0, 0, 0])
})

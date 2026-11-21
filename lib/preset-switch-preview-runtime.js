/** Build an isolated, read-only input to the same tool admission and prompt assembly as an Agent step. */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DISCOVERY_TOOL, previewDiscoverySchemas } from './tool-discovery-state.js'

function hostImport(ctx, name) {
  const profile = ctx.get('profileContext')
  return ctx.loader.internal.import(name, profile ? pathToFileURL(profile.installAnchor).href : ctx.baseUrl, {})
}

function previewSession(ctx, observation, preset) {
  const id = randomUUID()
  const meta = Object.freeze({ ...observation.header, id, agentPreset: preset })
  let seed = observation.events
  // Conditional contributions (e.g. project memory) consult the recorded selection.
  // Overlay its most recent value in the borrowed snapshot. Preserve sequence numbers
  // and every other event, including fork and compaction boundaries.
  const last = seed.findLastIndex(event => event.type === 'agent-preset/selected')
  if (last >= 0 && seed[last].data.agentPreset !== preset) {
    seed = [...seed]
    seed[last] = Object.freeze({ ...seed[last], data: Object.freeze({ ...seed[last].data, agentPreset: preset }) })
    Object.freeze(seed)
  }
  // prepare() does not enter the SessionStore. The Host rejects append on this object.
  return ctx.sessions.prepare(id, { meta, seed, inheritedEventCount: observation.inheritedEventCount, eventState: 'shared-frozen' })
}

// An Agent can own additional tools and restrictions outside its registered preset.
// The discovery row has a read-only projection. An unrelated Agent-local change cannot
// be transferred reliably to a different composition.
function mirrorsLiveTools(tools, live, detached) {
  const actual = tools.view(live).visible, projected = tools.view(detached).visible
  const names = new Set([...actual.keys(), ...projected.keys()])
  names.delete(DISCOVERY_TOOL)
  return [...names].every(name => actual.get(name) === projected.get(name))
}

async function assemble(ctx, live, preset, observation, options) {
  const { scopeApi, modelSelection, renderPrompt, signal, current } = options
  const lease = current ? null : await ctx.agentPresets.acquireScope(preset)
  try {
    // The current Agent retains its own revision, even after its declaration is replaced.
    const parent = current ? scopeApi.scopeParentOf(live) : lease.key
    if (!parent) return null
    const session = previewSession(ctx, observation, preset)
    const subject = { id: session.id, session, options: Object.freeze({ ...live.options }), model: { current: () => modelSelection } }
    const scope = scopeApi.createScope(ctx, subject, { parent })
    try {
      subject.ctx = scope.ctx
      if (current && !mirrorsLiveTools(ctx.tools, live, subject)) return null
      const toolSet = await ctx.tools.resolve({ agent: subject, modelSelection, signal })
      try {
        const assembly = await ctx.systemPrompt.assemble({ agent: subject, scope: subject, modelSelection, toolSet, signal })
        let prompt = null, tools = null
        try { prompt = renderPrompt(assembly) } catch { /* A missing variable need not hide the tool diff. */ }
        try { tools = previewDiscoverySchemas(ctx, preset, live.session, assembly.tools, scope.ctx) } catch { /* Disabled during the read. */ }
        // A complete section excludes all other sections. Ordinary Host assemblies always
        // include both deployment persona slots, even when their text is empty.
        const fileRead = assembly.sections.length > 1 && ctx.tools.get?.('read', subject) !== undefined
        return { tools, prompt, fileRead }
      } finally { toolSet.dispose() }
    } finally { await scope.dispose() }
  } finally { await lease?.[Symbol.asyncDispose]() }
}

// file-reference-local installs this section on the published Agent. A separate scope
// cannot inherit it. Use the mounted provider's own guidance and read-tool condition,
// then check the reconstructed source against the last effective, actually sent text.
async function reconcileAgentPrompt(ctx, session, before, after) {
  const systems = session.deriveMessages().filter(message => message.role === 'system')
  const last = systems.findLast(message => message.content.length) ?? systems[0]
  if (!last || last.content.some(block => block.type !== 'text')) return false
  const logged = last.content.map(block => block.text).join('')
  const provider = ctx.get('fileReferences')
  if (!provider) return logged === before.prompt
  const api = await hostImport(ctx, '@deepseek-ai/dsh-file-reference-local')
  if (!(provider instanceof api.LocalFileReferenceService)) return logged === before.prompt && !before.fileRead && !after.fileRead
  const text = api.FILE_REFERENCE_PROMPT
  if (typeof text !== 'string' || !text) return false
  if (before.fileRead) {
    const parts = logged.split('\n\n')
    const index = parts.indexOf(text)
    if (index < 0 || index !== parts.lastIndexOf(text)) return false
    const [contribution] = parts.splice(index, 1)
    if (parts.join('\n\n') !== before.prompt) return false
    before.agentSection = contribution
  } else if (logged !== before.prompt) return false
  if (after.fileRead) after.agentSection = before.agentSection ?? text
  return true
}

function measureHistory(ctx, session, observation, selection) {
  const meter = ctx.get('tokenMeter')
  const measured = meter?.measure(session, { config: { provider: selection.provider, model: selection.model } })
  if (measured?.logRevision !== observation.cursor + 1) return null
  let dialogue = 0, withoutSystems = 0
  for (const [index, node] of measured.nodes.entries()) {
    const event = observation.events[node.seq]
    if (!event || !Number.isSafeInteger(node.tokens) || node.tokens < 0) return null
    const system = event.type === 'system/message'
    if (!(system && index === 0)) dialogue += node.tokens
    if (!system) withoutSystems += node.tokens
  }
  return { dialogue, withoutSystems }
}

// After a history rewrite, a continuing driver starts a new series. A resumed
// driver may already have adopted that surface. Its private generation is not
// in the journal, so do not promise an append until a later request header.
function rewrittenSinceHeader(events, projections) {
  const types = new Set(projections.map(projection => projection.type))
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'request/header') return false
    if (event.surfaceOp?.op === 'replace' || types.has(event.type)) return true
  }
  return false
}

async function optional(read) {
  try { return await read() } catch { return null }
}

/** No model catalog lookup. A changed route has unknown capabilities until its first request. */
export async function readPreviewRequests(ctx, agent, { from, to, signal }) {
  const selection = agent.model.current()
  if (!selection || ctx.agentPresets.composedPreset(agent.ctx) !== from) return {}
  const observation = await ctx.sessionQuery.observeSession(agent.id, { projectionMode: 'none', signal })
  try {
    if (observation.cursor + 1 !== agent.session.seq) return {}
    const [scopeApi, promptApi, meterApi] = await Promise.all([
      hostImport(ctx, '@deepseek-ai/dsh-scope'),
      optional(() => hostImport(ctx, '@deepseek-ai/dsh-system-prompt')),
      optional(() => hostImport(ctx, '@deepseek-ai/dsh-token-meter/estimate')),
    ])
    const options = { scopeApi, modelSelection: selection, renderPrompt: promptApi?.renderPrompt, signal }
    const before = await optional(() => assemble(ctx, agent, from, observation, { ...options, current: true }))
    if (!before) return {}
    const after = await optional(() => assemble(ctx, agent, to, observation, options))
    if (after && !await optional(() => reconcileAgentPrompt(ctx, agent.session, before, after))) {
      // An unrecognized Agent-only section may change independently of the preset.
      before.prompt = null
      after.prompt = null
    }
    const route = await optional(() => agent.session.requestContext())
    let inHistory = null
    if (route?.provider === selection.provider && route?.model === selection.model) {
      if (route.systemPromptUpdate === 'in-history') {
        if (!rewrittenSinceHeader(observation.events, ctx.sessions.messageProjections ?? [])) inHistory = true
      } else if (route.systemPromptUpdate === undefined) inHistory = false
    }
    const history = await optional(() => measureHistory(ctx, agent.session, observation, selection))
    if (agent.session.seq !== observation.cursor + 1) return {}
    return {
      before, after, inHistory, history,
      estimateTools: tools => meterApi.estimateToolsTokens({ tools }),
      estimatePrompt: text => ctx.get('tokenMeter').estimateMessage({ role: 'system', content: text ? [{ type: 'text', text }] : [] }),
    }
  } finally { observation[Symbol.dispose]() }
}

/** The catalog includes cold and external children. Only a live Agent's status distinguishes an active turn from parking. */
export async function countRunningSubagents(ctx, sessionId, signal) {
  const descendants = await ctx.get('subagents').listDescendants(sessionId, signal)
  let count = 0
  for (const child of descendants) {
    if (child.kind !== 'child' || child.mode === 'external') return null
    if (child.activity === 'inactive') continue
    const status = ctx.agents.get(child.id)?.status
    if (status !== 'idle' && status !== 'running') return null
    if (status === 'running') count++
  }
  return count
}

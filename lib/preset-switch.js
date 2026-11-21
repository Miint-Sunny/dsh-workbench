import { registerFeature } from './features.js'
import { presetDisplay, presetDisplayLocale } from './preset-switch-locale.js'

export const name = '@miint-sunny/dsh-workbench/preset-switch'
export const inject = ['connection', 'agents', 'agentPresets', 'sessionProjections', 'sessionController',
  'commands', 'loader', 'sessions', 'sessionQuery', 'tools', 'systemPrompt']

const route = '/api/dsh-workbench.preset-switch'
const modes = ['standard', 'dsh-workbench-coding', 'dsh-workbench-full']
const UNSUPPORTED_CODES = new Set(['agent-preset/locked', 'agent-preset/not-found', 'agent-preset/invalid'])
const sessionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const failure = (code, current) => ({ ok: false, error: { code, current } })
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** Cordis consumes the synchronous Standard Schema contract for row configuration. */
export const Config = {
  '~standard': {
    version: 1, vendor: 'dsh-workbench',
    validate(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { issues: [{ message: 'Expected preset switch settings' }] }
      const { presets = modes, compactFirstAboveTokens = 65536 } = input
      if (!Array.isArray(presets) || !presets.every(nonempty)) return { issues: [{ path: ['presets'], message: 'Expected an array of preset IDs' }] }
      if (!Number.isSafeInteger(compactFirstAboveTokens) || compactFirstAboveTokens < 0) {
        return { issues: [{ path: ['compactFirstAboveTokens'], message: 'Expected a non-negative integer' }] }
      }
      return { value: { presets: [...new Set(presets)], compactFirstAboveTokens } }
    },
  },
}

function validPost(body) {
  return body && typeof body === 'object' && !Array.isArray(body) &&
    typeof body.sessionId === 'string' && sessionIdPattern.test(body.sessionId) && nonempty(body.agentPreset) &&
    (body.step === 'compact' || body.step === 'switch') &&
    (!Object.hasOwn(body, 'expectedFrom') || nonempty(body.expectedFrom))
}

function isRootHeader(header) {
  return Boolean(header) && header.origin !== 'subagent' && header.parentSession === undefined
}

function isRoot(agent) {
  return isRootHeader(agent.session.header)
}

function started(boundary) {
  return boundary != null && (boundary.lastTurn > 0 || boundary.openTurnStartSeq != null)
}

/** Read the same human-interaction state as the official session controller, plus
 * continued questions which can remain in the log after the requester returned. */
function isIdle(ctx, agent, state) {
  // The controller samples forwarded approval, question and plan interactions.
  // Recheck its live source as well: a new request can arrive as that read resolves.
  const forwarded = ctx.get('typertGateway')?.getPendingRemoteEvents?.() ?? []
  for (const event of forwarded) if (String(event.agentId) === agent.id) return false
  const values = ctx.sessionProjections.snapshot(agent.session)?.values
  return state.active && !state.running && state.queue?.length === 0 && state.pendingInput.length === 0 &&
    agent.status === 'idle' && ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq === null &&
    agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0 &&
    !(values?.userQuestions?.active?.length)
}

export function apply(ctx, input = {}) {
  const checked = Config['~standard'].validate(input)
  if (checked.issues) throw new TypeError(checked.issues[0].message)
  const { presets, compactFirstAboveTokens } = checked.value
  const operations = new Map()
  const lifetime = new AbortController()
  ctx.effect(() => registerFeature('preset-switch'), 'workbench preset switch')
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(operations.values())
  })

  const recorded = agent => ctx.agentPresets.presetForSession(agent.session)
  const actual = agent => ctx.agentPresets.composedPreset(agent.ctx) ?? null
  async function roster() {
    const rows = await ctx.agentPresets.list()
    return presets.filter(id => modes.includes(id)).map(id => rows.find(row => row.id === id && row.broken === undefined)).filter(Boolean)
  }
  async function coldRoot(id, signal) {
    const known = ctx.sessions?.get?.(id)
    if (known) return isRootHeader(known.header)
    if (typeof ctx.sessionQuery?.inspectSession !== 'function') return false
    try {
      return isRootHeader(await ctx.sessionQuery.inspectSession(id, session => session.header, signal))
    } catch {
      return false
    }
  }
  async function projected(id, signal) {
    const agent = ctx.agents.get(id)
    if (agent) return { current: recorded(agent), started: isRoot(agent) && started(ctx.agents.turnBoundaryOf(agent.session)) }
    const snapshot = await ctx.sessionController.projections({ sessionId: id }, signal)
    const nonBlank = snapshot?.kind === 'sequenced' && snapshot.values.sessionListMetadata?.blank === false
    return { current: snapshot?.values.agentPreset ?? null,
      started: nonBlank && await coldRoot(id, signal) }
  }
  function hasBothPresets(rows, from, to) {
    return rows.some(row => row.id === from) && rows.some(row => row.id === to)
  }
  async function menu(request, id) {
    const [session, rows] = await Promise.all([projected(id, request.signal), roster()])
    const locale = presetDisplayLocale(ctx, request)
    return reply({ ok: true, value: { current: session.current,
      switchable: Boolean(session.started && rows.length >= 2 && rows.some(row => row.id === session.current)),
      targets: rows.map(row => presetDisplay(row, locale)) } })
  }
  async function preview(request, id, target) {
    const [session, rows] = await Promise.all([projected(id, request.signal), roster()])
    if (!session.started || !hasBothPresets(rows, session.current, target)) return reply(failure('unsupported', session.current))
    // Opening a confirmation must not wake a cold Agent or start its MCP processes.
    const agent = ctx.agents.get(id)
    if (agent && !isRoot(agent)) return reply(failure('unsupported', session.current))
    const from = agent ? actual(agent) : session.current
    if (from !== session.current) return reply(failure('stale-preview', from))
    const { previewPresetSwitch } = await import('./preset-switch-preview.js')
    const value = await previewPresetSwitch(ctx, agent, { sessionId: id, from, to: target, compactFirstAboveTokens, signal: request.signal })
    // A different window may finish a switch while the target is being inspected.
    const latest = ctx.agents.get(id)
    const current = latest ? actual(latest) : (await projected(id, request.signal)).current
    if (current !== from) return reply(failure('stale-preview', current))
    return reply({ ok: true, value })
  }

  // The official selector locks every started session. This row is the caller
  // that owns admission instead: whenEligible has already required a started,
  // idle root Agent whose source is unchanged and whose target is configured.
  // It performs the selector's own two steps without its blank-session check.
  // recompose is documented for blank Agents only; README lists the risk.
  async function rebind(agent, id) {
    const preset = await ctx.agentPresets.recompose(agent.ctx, id)
    return preset?.id ?? null
  }
  async function restore(agent, from) {
    try { await rebind(agent, from) } catch { /* Report the surviving live composition. */ }
  }
  async function select(agent, from, target) {
    if (typeof ctx.agentPresets.recompose !== 'function') return failure('unsupported', from)
    let bound
    try {
      bound = await rebind(agent, target)
    } catch (error) {
      if (actual(agent) === from) return failure(UNSUPPORTED_CODES.has(error?.code) ? 'unsupported' : 'switch-failed', from)
      await restore(agent, from)
      return failure('switch-failed', actual(agent))
    }
    if (bound !== target || actual(agent) !== target) {
      await restore(agent, from)
      return failure('switch-failed', actual(agent))
    }
    let selected
    try {
      selected = agent.session.append('agent-preset/selected', { agentPreset: target })
    } catch {
      await restore(agent, from)
      return failure('record-failed', actual(agent))
    }
    if (recorded(agent) !== target) {
      await restore(agent, from)
      const live = actual(agent)
      if (live) {
        try {
          // The projection may still show the source even though the journal accepted the target.
          agent.session.append('agent-preset/selected', { agentPreset: live })
        } catch {
          // If no later event was accepted, the first selection still owns the journal tail.
          const last = agent.session.seq === selected.seq + 1 ? target : recorded(agent)
          if (last && last !== live) await restore(agent, last)
        }
      }
      return failure('record-failed', actual(agent))
    }
    return { ok: true, value: { agentPreset: target } }
  }

  async function perform(body, signal) {
    const stale = from => body.expectedFrom !== undefined && body.expectedFrom !== from
    let agent = ctx.agents.get(body.sessionId)
    if (!agent) {
      const session = await projected(body.sessionId, signal)
      if (stale(session.current)) return failure('stale-preview', session.current)
      if (!session.started || session.current === body.agentPreset || !hasBothPresets(await roster(), session.current, body.agentPreset)) {
        return failure('unsupported', session.current)
      }
      agent = (await ctx.sessionController.resolveAgent(body.sessionId)).agent
      if (!agent) return failure('unsupported', session.current)
    }
    if (!isRoot(agent)) return failure('unsupported', actual(agent))
    const initial = actual(agent)
    if (stale(initial)) return failure('stale-preview', initial)

    // Invoke the operation synchronously with the final check. A second preview
    // or a new turn must not slip between reading the source and using it.
    async function whenEligible(action) {
      // Roster diagnostics can wait for a plugin to settle while input is queued.
      const rows = await roster()
      const state = await ctx.sessionController.state({ sessionId: agent.id }, signal)
      signal.throwIfAborted()
      const from = actual(agent)
      if (stale(from)) return failure('stale-preview', from)
      if (from !== recorded(agent)) return failure('switch-failed', from)
      if (from === body.agentPreset || !started(ctx.agents.turnBoundaryOf(agent.session)) || !hasBothPresets(rows, from, body.agentPreset)) {
        return failure('unsupported', from)
      }
      return isIdle(ctx, agent, state) ? action(from) : failure('not-idle', from)
    }
    if (body.step === 'compact') {
      // /compact claims the Agent's maintenance slot and journals the command result.
      return whenEligible(async () => {
        const result = await ctx.commands.execute(agent, '/compact', [], signal)
        return result?.result?.kind === 'success' ? { ok: true } : failure('compact-failed', actual(agent))
      })
    }
    let entered = false
    try {
      // Reserve the driver's idle phase. Prompts can queue but cannot start
      // another turn before the registry operation settles.
      return await agent.runMaintenance(maintenance => {
        entered = true
        return whenEligible(from => maintenance.aborted
          ? failure('not-idle', from)
          : select(agent, from, body.agentPreset))
      })
    } catch { return failure(entered ? 'switch-failed' : 'not-idle', actual(agent)) }
  }

  async function post(request) {
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return reply(failure('unsupported', null), 415)
    }
    const body = await request.json().catch(() => null)
    if (!validPost(body)) return reply(failure('unsupported', null), 400)
    const signal = AbortSignal.any([lifetime.signal, request.signal])
    if (operations.has(body.sessionId)) {
      const live = ctx.agents.get(body.sessionId)
      return reply(failure('busy', live ? actual(live) : (await projected(body.sessionId, signal)).current))
    }
    const operation = perform(body, signal)
    operations.set(body.sessionId, operation)
    try { return reply(await operation) }
    catch {
      const live = ctx.agents.get(body.sessionId)
      return reply(failure(body.step === 'compact' ? 'compact-failed' : 'switch-failed', live ? actual(live) : null))
    } finally { operations.delete(body.sessionId) }
  }

  for (const [path, methods] of [[route, ['GET', 'POST']], [route + '/preview', ['GET']]]) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) {
      if (!methods.includes(request.method)) return reply(failure('unsupported', null), 405)
      if (request.method === 'POST') return post(request)
      const query = new URL(request.url).searchParams
      const id = query.get('sessionId')
      if (query.getAll('sessionId').length !== 1 || !sessionIdPattern.test(id ?? '')) return reply(failure('unsupported', null), 400)
      const target = query.get('agentPreset')
      if (path !== route && (query.getAll('agentPreset').length !== 1 || !nonempty(target))) return reply(failure('unsupported', null), 400)
      try { return path === route ? await menu(request, id) : await preview(request, id, target) }
      catch { return reply(failure('unsupported', ctx.agents.get(id) ? actual(ctx.agents.get(id)) : null)) }
    } }), 'workbench preset switch route ' + path)
  }
}

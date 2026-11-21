/** 人工询问层的应答者；没有 tools/pre-execute 监听器，也不修改任何权限预设。 */
import { randomUUID } from 'node:crypto'
import { policyHash, whalePreset } from './policy-scope.js'
import { rulesFail, ruleMatches } from './approval-rules-state.js'
import { createExecutableInspector } from './approval-rules-executable.js'
import { isWorkspaceGuardReason } from './workspace-guard-copy.js'
export function createApprovalRulesManager({ ctx, config, store }) {
  const calls = new Map(),
    asked = new Map(),
    decisions = new Map(),
    pending = new Map(),
    agents = new Map(),
    owned = new Set(),
    lifecycle = new AbortController(),
    inspector = createExecutableInspector(config)
  let closed = false,
    state = { version: 1, revision: 0, rules: [] },
    stateError = null,
    lastIssue = null,
    matches = 0
  const keyOf = (sessionId, callId) => JSON.stringify([sessionId, callId])
  const excluded = (agent) => whalePreset(ctx.agentPresets.presetForSession(agent.session))
  const install = (value) => {
    if (value.revision >= state.revision) state = value
  }
  const track = (promise) => {
    owned.add(promise)
    promise.finally(() => owned.delete(promise)).catch(() => {})
    return promise
  }
  async function readState() {
    try {
      install(await store.read())
      stateError = null
    } catch {
      stateError = 'invalid-state'
    }
    return state
  }
  const rejection = (req) =>
    closed
      ? 'disabled'
      : excluded(req.agent)
        ? 'excluded'
        : ctx.approval.effectivePolicy(req.agent.session) === 'never'
          ? 'never-policy'
          : isWorkspaceGuardReason(req.reason)
            ? 'protected-target'
            : typeof req.reason === 'string' && req.reason.startsWith('Auto review denied tool ')
              ? 'review-denied'
              : null
  function present(record) {
    return (
      !closed &&
      !record.req.signal?.aborted &&
      pending.get(record.key) === record &&
      calls.get(record.key) === record.call
    )
  }
  function live(record) {
    return present(record) && !rejection(record.req)
  }
  async function resolve(record) {
    const reason = rejection(record.req)
    if (reason) rulesFail(reason)
    if (!record.call || record.call.name !== 'bash' || record.req.toolName !== 'bash')
      rulesFail('unsupported-call')
    const signal = AbortSignal.any([
      lifecycle.signal,
      ...(record.req.signal ? [record.req.signal] : []),
    ])
    return inspector.inspect(ctx, record.req, record.call.args, signal)
  }
  async function prepare(record) {
    try {
      const candidate = await track(resolve(record))
      if (record.candidate?.fingerprint !== candidate.fingerprint) {
        record.token = randomUUID()
        record.candidate = candidate
      }
      record.issue = null
    } catch (error) {
      record.candidate = null
      record.issue = record.req.signal?.aborted
        ? 'request-ended'
        : (error.code ?? 'unverified-executable')
    }
    return record
  }
  async function audit(record, kind, rule, revision) {
    try {
      await store.audit({
        kind,
        sessionId: record.req.agent.id,
        callId: record.req.callId,
        approvalId: record.approvalId,
        ruleId: rule?.id ?? null,
        revision,
        projectKey: record.candidate?.project.key,
        cwd: record.candidate?.cwd,
        executable: record.candidate?.executable,
        identity: record.candidate?.identity,
        commandHash: policyHash(record.call.raw),
        sandboxMode: record.candidate?.sandboxMode,
      })
    } catch {
      rulesFail('audit-unavailable')
    }
  }
  async function answer(req, next) {
    if (closed || excluded(req.agent) || req.toolName !== 'bash' || typeof req.callId !== 'string')
      return next()
    const key = keyOf(req.agent.id, req.callId),
      call = calls.get(key)
    if (!call || typeof asked.get(key) !== 'string' || pending.size >= config.maxPending)
      return next()
    const record = {
      key,
      req,
      call,
      approvalId: asked.get(key),
      token: randomUUID(),
      candidate: null,
      issue: null,
    }
    pending.set(key, record)
    try {
      await readState()
      if (!stateError) await prepare(record)
      if (live(record) && !stateError && record.candidate) {
        const rule = state.rules.find((r) => ruleMatches(r, record.candidate))
        if (rule)
          try {
            const revision = state.revision
            await track(audit(record, 'match-attempt', rule, revision))
            const current = await track(resolve(record))
            if (current.fingerprint !== record.candidate.fingerprint) rulesFail('source-changed')
            await readState()
            if (
              live(record) &&
              !stateError &&
              state.revision === revision &&
              state.rules.some((r) => r.id === rule.id && ruleMatches(r, record.candidate))
            ) {
              decisions.set(record.approvalId, {
                sessionId: req.agent.id,
                callId: req.callId,
                ruleId: rule.id,
                revision,
                approvalId: record.approvalId,
              })
              lastIssue = null
              return 'allowed-once'
            }
          } catch (error) {
            if (!req.signal?.aborted) lastIssue = error.code ?? 'source-changed'
          }
      }
      if (req.signal?.aborted) return 'cancelled'
      return await next()
    } finally {
      if (pending.get(key) === record) pending.delete(key)
    }
  }
  function attach(agent) {
    if (closed || agents.has(agent.id)) return
    const stop = agent.ctx.on(
      'approval/request',
      (req, next) => (req.agent === agent ? answer(req, next) : next()),
      { prepend: true },
    )
    agents.set(agent.id, stop)
  }
  return {
    attach,
    detach(agent) {
      agents.get(agent.id)?.()
      agents.delete(agent.id)
      for (const [key, record] of pending) if (record.req.agent === agent) pending.delete(key)
      for (const key of calls.keys())
        if (JSON.parse(key)[0] === agent.id) {
          calls.delete(key)
          asked.delete(key)
        }
    },
    async start() {
      await readState()
      for (const agent of ctx.agents.list()) attach(agent)
    },
    onEvent(session, event) {
      if (closed) return
      if (event.type === 'approval/decided' && decisions.has(event.data.id)) {
        const fact = decisions.get(event.data.id)
        decisions.delete(event.data.id)
        if (event.data.outcome === 'allowed-once') matches++
        track(
          store.audit({ kind: 'automatic-result', ...fact, outcome: event.data.outcome }),
        ).catch(() => {
          lastIssue = 'audit-unavailable'
        })
      }
      const key = keyOf(session.id, event.data.callId ?? event.data.message?.source?.callId)
      if (
        event.type === 'tool/call' &&
        event.data.name === 'bash' &&
        !whalePreset(ctx.agentPresets.presetForSession(session))
      ) {
        if (
          typeof event.data.arguments !== 'string' ||
          event.data.arguments.length > config.maxCommandChars * 4
        )
          return
        try {
          const args = JSON.parse(event.data.arguments)
          calls.set(key, { name: 'bash', args, raw: event.data.arguments })
          while (calls.size > config.maxPending) calls.delete(calls.keys().next().value)
        } catch {}
      }
      if (event.type === 'approval/asked' && event.data.toolName === 'bash') {
        asked.set(key, event.data.id)
        while (asked.size > config.maxPending) asked.delete(asked.keys().next().value)
      }
      if (event.type === 'tool/result') {
        calls.delete(key)
        asked.delete(key)
      }
      if (event.type === 'turn/end') {
        for (const k of calls.keys())
          if (JSON.parse(k)[0] === session.id) {
            calls.delete(k)
            asked.delete(k)
          }
      }
    },
    async list() {
      await readState()
      return { ...state, error: stateError, lastIssue, matches }
    },
    async inspect(sessionId, callId) {
      if (closed) return { eligible: false, reason: 'disabled' }
      const agent = ctx.agents.get(sessionId)
      if (agent && excluded(agent)) return { eligible: false, reason: 'excluded' }
      const record = pending.get(keyOf(sessionId, callId))
      if (!record || !present(record)) return { eligible: false, reason: 'request-ended' }
      const blocked = rejection(record.req)
      if (blocked) return { eligible: false, reason: blocked }
      await readState()
      if (!stateError) await prepare(record)
      if (!live(record)) return { eligible: false, reason: 'request-ended' }
      return {
        eligible: !stateError && !!record.candidate,
        reason: stateError ?? record.issue,
        revision: state.revision,
        token: record.token,
        proposal: record.candidate
          ? {
              project: record.candidate.project,
              cwd: record.candidate.cwd,
              executable: record.candidate.executable,
              programs: record.candidate.programs,
              sandboxMode: record.candidate.sandboxMode,
              pattern: record.candidate.pattern,
            }
          : null,
      }
    },
    async create(body, signal) {
      const record = pending.get(keyOf(body.sessionId, body.callId))
      if (!record || !live(record)) rulesFail('request-ended')
      if (record.token !== body.token || !record.candidate) rulesFail('request-changed')
      const prior = record.candidate.fingerprint
      await prepare(record)
      if (!live(record)) rulesFail('request-ended')
      if (
        !record.candidate ||
        record.candidate.fingerprint !== prior ||
        record.token !== body.token
      )
        rulesFail('source-changed')
      await readState()
      if (stateError) rulesFail(stateError)
      await track(audit(record, 'create-request', null, body.revision))
      const next = await track(
        store.create(
          body.revision,
          record.candidate,
          body.options,
          () => live(record) && !signal?.aborted && record.token === body.token,
        ),
      )
      install(next)
      return {
        revision: next.revision,
        saved: true,
        answerable: live(record) && !signal?.aborted,
        token: record.token,
      }
    },
    async change(body) {
      if (closed) rulesFail('disabled')
      await readState()
      if (stateError) rulesFail(stateError)
      install(await track(store.change(body.revision, body.id, body.action)))
      return this.list()
    },
    async dispose() {
      closed = true
      lifecycle.abort()
      for (const stop of agents.values()) stop()
      agents.clear()
      pending.clear()
      calls.clear()
      asked.clear()
      decisions.clear()
      await Promise.allSettled([...owned])
      await store.dispose()
    },
  }
}

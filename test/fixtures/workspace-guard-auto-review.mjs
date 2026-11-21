// Exercises the two shipped pre-execute listeners in Electron's Node mode.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createWorkspaceGuard } from '../../lib/workspace-guard.js'
import { isWorkspaceGuardReason } from '../../lib/workspace-guard-copy.js'

const [reviewEntry, home] = process.argv.slice(2)
const { apply } = await import(reviewEntry)
const dshHome = join(home, '.dsh')
const args = { file_path: join(dshHome, 'sessions', 'note') }
const step = { turn: 1, step: 1 }
const call = { type: 'tool-call', id: 'c1', name: 'write', arguments: JSON.stringify(args) }
const events = [
  { type: 'step/start', data: step },
  { type: 'assistant/message', data: { ...step, message: { content: [call] } } },
  { type: 'tool/call', data: { ...step, ...call, callId: call.id } },
]
const session = {
  id: 'fixture', header: { origin: 'user', cwd: home }, surface: { nodes: [1] },
  snapshotEvents: () => events,
  requestHeader: () => ({
    config: { provider: 'fixture', model: 'fixture' },
    tools: [{ name: call.name, description: 'Write file', parameters: {} }],
  }),
}
for (const guardFirst of [true, false]) {
  for (const verdict of ['allow', 'deny', 'error']) {
    const listeners = []
    let requests = 0
    const ctx = {
      get(key) { return this[key] },
      on(event, fn, { prepend }) {
        assert.equal(event, 'tools/pre-execute')
        if (prepend) listeners.unshift(fn)
        else listeners.push(fn)
        return () => {}
      },
      effect(install) { Array.from(install()) },
      workspaceRegistry: { list: () => [] },
      permissionPresets: { current: () => 'auto', registerAuto: () => () => {} },
      workingDirectory: { get: () => home, ensure: async () => home },
      approval: { effectivePolicy: () => 'ask', overrideOf: () => 'ask' },
      llm: { async *stream() {
        requests++
        if (verdict === 'error') throw new Error('fixture reviewer unavailable')
        const text = JSON.stringify({ risk: 'medium', decision: verdict })
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
    }
    if (guardFirst) apply(ctx)
    createWorkspaceGuard(ctx, { home, dshHome })
    if (!guardFirst) apply(ctx)
    const exec = { name: call.name, arguments: args, agent: { session }, rootCallId: call.id, callId: call.id, signal: new AbortController().signal }
    let index = 0
    const next = () => listeners[index++]?.(exec, next) ?? { kind: 'allow' }
    const result = await next()
    assert.equal(requests, 1)
    if (verdict === 'error') assert.equal(result.info?.code, 'AUTO_REVIEW_FAILED', result.reason)
    else {
      assert.equal(result.kind, 'ask', result.reason)
      assert.ok(isWorkspaceGuardReason(result.reason))
    }
  }
}

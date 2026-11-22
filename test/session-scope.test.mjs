import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delegatedSession } from '../lib/session-scope.js'

test('delegatedSession: origin subagent or any delegation depth counts as a child, whatever the other field says', () => {
  assert.equal(delegatedSession({ origin: 'subagent' }), true)
  assert.equal(delegatedSession({ origin: 'subagent', delegationDepth: 0 }), true)
  assert.equal(delegatedSession({ delegationDepth: 1 }), true)
  assert.equal(delegatedSession({ delegationDepth: 3 }), true)
})

test('delegatedSession: a header without either marker, or no session at all, is top-level', () => {
  assert.equal(delegatedSession({ delegationDepth: 0 }), false)
  assert.equal(delegatedSession({ origin: 'user', cwd: '/tmp/project' }), false)
  assert.equal(delegatedSession({}), false)
  assert.equal(delegatedSession(undefined), false)
})

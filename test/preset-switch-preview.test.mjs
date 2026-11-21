import assert from 'node:assert/strict'
import { test } from 'node:test'

import { comparePresetRequests } from '../lib/preset-switch-preview.js'

const tool = (name, description) => ({ name, description, parameters: { type: 'object' } })
const a = tool('alpha', 'unchanged'), m = tool('middle', 'old'), z = tool('zeta', 'last')
const initial = { tools: [z, m, a], prompt: 'old' }
const target = { tools: [z, a, tool('middle', 'new'), tool('omega', 'new')], prompt: 'new' }
const estimates = {
  // Distinct readings make a dropped tool, a stray common prefix or the wrong history observable.
  estimateTools: tools => tools.reduce((sum, schema) => sum + { alpha: 1, middle: 2, omega: 4, zeta: 8 }[schema.name], 0),
  estimatePrompt: text => text === 'new' ? 20 : 0,
  history: { dialogue: 107, withoutSystems: 100 },
  compactFirstAboveTokens: 141,
}
function diff(before, after, options) {
  return comparePresetRequests(before, after, { ...estimates, ...options })
}
test('in-history updates price the changed sorted schema suffix, prior prompt copies and new text', () => {
  assert.deepEqual(diff(initial, target, { inHistory: true }), {
    tools: { added: ['omega'], removed: [] }, systemPrompt: 'appended', changes: true,
    uncachedTokens: 141, compactSuggested: true,
  })
  assert.deepEqual(initial.tools, [z, m, a])
})

test('a replacement prices every target tool, the new system and only non-system dialogue', () => {
  assert.deepEqual(diff(initial, target, { inHistory: false }), {
    tools: { added: ['omega'], removed: [] }, systemPrompt: 'replaced', changes: true,
    uncachedTokens: 135, compactSuggested: false,
  })
})

test('a name-stable schema edit changes the request and moves its cache boundary', () => {
  const result = diff(initial, { tools: [a, tool('middle', 'edited'), z], prompt: 'old' })
  assert.deepEqual(result, {
    tools: { added: [], removed: [] }, systemPrompt: 'unchanged', changes: true,
    uncachedTokens: 117, compactSuggested: false,
  })
})

test('same declarations in registry order avoid needless confirmation', () => {
  assert.deepEqual(diff(initial, { tools: [a, m, z], prompt: 'old' }), {
    tools: { added: [], removed: [] }, systemPrompt: 'unchanged', changes: false,
    uncachedTokens: 107, compactSuggested: false,
  })
})

test('removals count only the remaining target suffix, including an empty suffix', () => {
  const result = diff({ tools: [a, m, z], prompt: '' }, { tools: [a, m], prompt: '' })
  assert.deepEqual(result, {
    tools: { added: [], removed: ['zeta'] }, systemPrompt: 'unchanged', changes: true,
    uncachedTokens: 107, compactSuggested: false,
  })
})

test('unavailable inputs stay independent and a known difference still requires confirmation', () => {
  assert.deepEqual(diff(initial, { ...target, tools: null }, { inHistory: null }), {
    tools: null, systemPrompt: null, changes: true, uncachedTokens: null, compactSuggested: null,
  })
  assert.deepEqual(diff(initial, { tools: [a, m, z], prompt: null }), {
    tools: { added: [], removed: [] }, systemPrompt: null, changes: null, uncachedTokens: null, compactSuggested: null,
  })
  assert.deepEqual(diff({ ...initial, tools: null }, target, { inHistory: false }), {
    tools: null, systemPrompt: 'replaced', changes: true, uncachedTokens: 135, compactSuggested: false,
  })
  assert.equal(diff(initial, target, { inHistory: true, history: null }).uncachedTokens, null)
})

test('removing the effective system prompt requires a replacement even on an in-history model', () => {
  const out = diff(initial, { ...target, prompt: '' }, { inHistory: true })
  assert.equal(out.systemPrompt, 'replaced')
  assert.equal(out.uncachedTokens, 115)
})

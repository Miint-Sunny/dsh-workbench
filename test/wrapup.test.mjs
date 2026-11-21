import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapUpArgsOf, wrapUpFold, wrapUpInit, parseWrapUpState } from '../lib/wrapup-state.js'

/** 一次 wrap_up 的 tool/call 事件。 */
function wrapUpCall(turn, args) {
  return { type: 'tool/call', data: { turn, step: 1, callId: `c${turn}`, name: 'wrap_up', arguments: JSON.stringify(args) } }
}

test('wrap_up args: recap alone, recap with ask, recap with ask and actions all canonicalize', () => {
  assert.deepEqual(wrapUpArgsOf({ recap: ' 做完了 ' }), { recap: '做完了' })
  assert.deepEqual(wrapUpArgsOf({ recap: '做完了', ask: '继续吗？' }), { recap: '做完了', ask: '继续吗？' })
  assert.deepEqual(
    wrapUpArgsOf({ recap: '做完了', ask: '继续吗？', actions: ['现在继续', '暂不继续'] }),
    { recap: '做完了', ask: '继续吗？', actions: ['现在继续', '暂不继续'] })
})

test('wrap_up args: blank recap, over-long fields, actions without ask, duplicate actions all reject', () => {
  assert.throws(() => wrapUpArgsOf({ recap: '   ' }), /recap/)
  assert.throws(() => wrapUpArgsOf({}), /recap/)
  assert.throws(() => wrapUpArgsOf({ recap: 'x'.repeat(601) }), /600/)
  assert.throws(() => wrapUpArgsOf({ recap: 'a', ask: 'x'.repeat(201) }), /200/)
  assert.throws(() => wrapUpArgsOf({ recap: 'a', ask: 'q', actions: ['x'.repeat(25)] }), /24/)
  assert.throws(() => wrapUpArgsOf({ recap: 'a', actions: ['继续'] }), /ask/)
  assert.throws(() => wrapUpArgsOf({ recap: 'a', ask: 'q', actions: ['同', '同'] }), /differ/)
  assert.throws(() => wrapUpArgsOf({ recap: 'a', ask: 'q', actions: [] }), /1 or 2/)
  assert.throws(() => wrapUpArgsOf({ recap: 'a', ask: 'q', actions: ['1', '2', '3'] }), /1 or 2/)
  assert.throws(() => wrapUpArgsOf('nope'), /object/)
})

test('wrap_up projection: starts empty, records the call in its turn, replaces within a turn', () => {
  let state = wrapUpInit()
  assert.deepEqual(state, { entries: [], buttonsLive: false })
  state = wrapUpFold(state, wrapUpCall(3, { recap: '第一版总结' }))
  assert.deepEqual(state, { entries: [{ turn: 3, recap: '第一版总结' }], buttonsLive: true })
  state = wrapUpFold(state, wrapUpCall(3, { recap: '第二版总结' }))
  assert.deepEqual(state, { entries: [{ turn: 3, recap: '第二版总结' }], buttonsLive: true })
})

test('wrap_up projection: buttons collapse on the next turn/start, summaries stay', () => {
  let state = wrapUpInit()
  state = wrapUpFold(state, wrapUpCall(3, { recap: '总结三', ask: '要继续吗？', actions: ['继续'] }))
  state = wrapUpFold(state, { type: 'turn/end', data: { turn: 3, reason: 'completed' } })
  assert.equal(state.buttonsLive, true)
  state = wrapUpFold(state, { type: 'turn/start', data: { turn: 4 } })
  assert.deepEqual(state, { entries: [{ turn: 3, recap: '总结三', ask: '要继续吗？', actions: ['继续'] }], buttonsLive: false })
  state = wrapUpFold(state, wrapUpCall(4, { recap: '总结四' }))
  assert.deepEqual(state.entries.map(entry => entry.turn), [3, 4])
  assert.equal(state.buttonsLive, true)
})

test('wrap_up projection: other tools and events leave the state alone', () => {
  let state = wrapUpInit()
  state = wrapUpFold(state, wrapUpCall(1, { recap: '总结' }))
  const unchanged = state
  state = wrapUpFold(state, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'todo_write', arguments: '{}' } })
  state = wrapUpFold(state, { type: 'user/message', data: {} })
  state = wrapUpFold(state, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'wrap_up', arguments: '{bad json' } })
  state = wrapUpFold(state, wrapUpCall(1, { recap: '' }))
  assert.equal(state, unchanged)
})

test('wrap_up projection: invalid model arguments are skipped, valid later call still records', () => {
  let state = wrapUpInit()
  state = wrapUpFold(state, { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c', name: 'wrap_up', arguments: '{"recap":"  "}' } })
  assert.deepEqual(state, { entries: [], buttonsLive: false })
  state = wrapUpFold(state, wrapUpCall(2, { recap: '好的总结' }))
  assert.deepEqual(state, { entries: [{ turn: 2, recap: '好的总结' }], buttonsLive: true })
})

test('wrap_up projection: keeps at most the latest 50 turns', () => {
  let state = wrapUpInit()
  for (let turn = 1; turn <= 55; turn++) state = wrapUpFold(state, wrapUpCall(turn, { recap: `总结 ${turn}` }))
  assert.equal(state.entries.length, 50)
  assert.equal(state.entries[0].turn, 6)
  assert.equal(state.entries[state.entries.length - 1].turn, 55)
})

test('wrap_up state parse: checkpoint values round-trip and malformed ones throw', () => {
  const state = wrapUpFold(wrapUpInit(), wrapUpCall(3, { recap: '总结', ask: '问题', actions: ['甲', '乙'] }))
  assert.deepEqual(parseWrapUpState(JSON.parse(JSON.stringify(state))), state)
  assert.throws(() => parseWrapUpState({ entries: [], buttonsLive: 'yes' }), /buttonsLive/)
  assert.throws(() => parseWrapUpState({ entries: [{ turn: 1 }], buttonsLive: false }), /recap/)
  assert.throws(() => parseWrapUpState({ entries: [{ turn: 1.5, recap: 'a' }], buttonsLive: false }), /turn/)
  assert.throws(() => parseWrapUpState(null), /object/)
})

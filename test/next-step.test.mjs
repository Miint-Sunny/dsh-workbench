/** ⌘↵ 执行推荐的下一步（feat#166）：什么时候执行、执行哪一个。纯函数，不碰 DOM。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerIsEmpty, focusKindOf, isNextStepChord, pickNextStep, shouldRunNextStep } from '../src/client/next-step.js'

/** 一次按键：默认是 macOS 的 ⌘↵。 */
const key = (patch = {}) => ({ code: 'Enter', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...patch })

test('isNextStepChord: ⌘↵ and Ctrl+↵ (DSH treats both as the accelerated Enter), keypad Enter too', () => {
  assert.equal(isNextStepChord(key()), true)
  assert.equal(isNextStepChord(key({ metaKey: false, ctrlKey: true })), true)
  assert.equal(isNextStepChord(key({ code: 'NumpadEnter' })), true)
})

test('isNextStepChord: plain Enter, extra modifiers, held keys and IME composition do not count', () => {
  assert.equal(isNextStepChord(key({ metaKey: false })), false)
  assert.equal(isNextStepChord(key({ ctrlKey: true })), false, '⌃⌘↵')
  assert.equal(isNextStepChord(key({ shiftKey: true })), false, '⇧⌘↵')
  assert.equal(isNextStepChord(key({ altKey: true })), false, '⌥⌘↵ is the DSH fullscreen pane')
  assert.equal(isNextStepChord(key({ repeat: true })), false)
  assert.equal(isNextStepChord(key({ isComposing: true })), false)
  assert.equal(isNextStepChord(key({ code: 'KeyK' })), false)
  assert.equal(isNextStepChord(undefined), false)
})

/** 一个能执行的场景：焦点在页面上、会话空闲、有推荐项。 */
const when = (patch = {}) => ({ chord: true, focus: 'page', modal: null, running: false, hasTarget: true, ...patch })

test('shouldRunNextStep: runs when focus is outside any input, or in this session\'s empty composer', () => {
  assert.equal(shouldRunNextStep(when()), true)
  assert.equal(shouldRunNextStep(when({ focus: 'composer-empty' })), true)
})

test('shouldRunNextStep: a composer with text keeps DSH\'s ⌘↵ (send), other inputs and the terminal keep theirs', () => {
  assert.equal(shouldRunNextStep(when({ focus: 'composer-filled' })), false)
  assert.equal(shouldRunNextStep(when({ focus: 'editable' })), false)
  assert.equal(shouldRunNextStep(when({ focus: 'terminal' })), false)
})

test('shouldRunNextStep: a running session keeps DSH\'s queue/steer ⌘↵; nothing to run, no chord or a dialog also stop it', () => {
  assert.equal(shouldRunNextStep(when({ running: true })), false)
  assert.equal(shouldRunNextStep(when({ running: true, focus: 'composer-empty' })), false)
  assert.equal(shouldRunNextStep(when({ hasTarget: false })), false)
  assert.equal(shouldRunNextStep(when({ chord: false })), false)
  assert.equal(shouldRunNextStep(when({ modal: 'other' })), false)
  assert.equal(shouldRunNextStep(when({ modal: 'settings' })), false)
  // DSH 把焦点在侧边栏也记成 modal 'sidebar'，那不是弹窗。
  assert.equal(shouldRunNextStep(when({ modal: 'sidebar' })), true)
})

test('shouldRunNextStep: an open menu, candidate list or popover, or a pending question keeps ⌘↵ for them', () => {
  assert.equal(shouldRunNextStep(when({ overlay: true })), false)
  assert.equal(shouldRunNextStep(when({ overlay: true, focus: 'composer-empty' })), false)
  assert.equal(shouldRunNextStep(when({ pending: true })), false)
  assert.equal(shouldRunNextStep(when({ overlay: false, pending: false })), true)
})

/** 只认得几个选择器的假元素：closest 的选择器列表里有一项正是给出的，就算命中。 */
const element = (...matches) => ({ closest: selector => (selector.split(',').some(part => matches.includes(part.trim())) ? {} : null) })

test('focusKindOf: page, terminal, composer (empty or not) and other inputs', () => {
  assert.equal(focusKindOf(element(), () => true), 'page')
  assert.equal(focusKindOf(null, () => true), 'page')
  assert.equal(focusKindOf(element('.xterm', 'textarea'), () => true), 'terminal')
  assert.equal(focusKindOf(element('[contenteditable="true"]', '[data-input-scroll]'), () => true), 'composer-empty')
  assert.equal(focusKindOf(element('[contenteditable="true"]', '[data-input-scroll]'), () => false), 'composer-filled')
  assert.equal(focusKindOf(element('textarea'), () => true), 'editable')
  assert.equal(focusKindOf(element('input'), () => true), 'editable')
})

test('focusKindOf: any element the browser says is editable counts, plaintext-only included', () => {
  assert.equal(focusKindOf({ ...element(), isContentEditable: true }, () => true), 'editable')
  assert.equal(focusKindOf(element('[contenteditable="plaintext-only"]'), () => true), 'editable')
})

test('composerIsEmpty: only a plain, blank draft with no attachments or references', () => {
  const plain = { phase: 'plain', draft: '', attachmentIds: [], occurrences: [] }
  assert.equal(composerIsEmpty(plain), true)
  assert.equal(composerIsEmpty({ ...plain, draft: '继续' }), false)
  assert.equal(composerIsEmpty({ ...plain, draft: ' ' }), false, 'whitespace is still a draft the user typed')
  assert.equal(composerIsEmpty({ ...plain, attachmentIds: ['a1'] }), false)
  assert.equal(composerIsEmpty({ ...plain, occurrences: [{}] }), false)
  assert.equal(composerIsEmpty({ ...plain, phase: 'sending' }), false)
  assert.equal(composerIsEmpty(undefined), false)
})

test('pickNextStep: the wrap-up box wins; otherwise the first pending session card', () => {
  assert.equal(pickNextStep([]), undefined)
  assert.equal(pickNextStep([{ key: 'card:b', kind: 'card', order: 2 }, { key: 'card:a', kind: 'card', order: 1 }]), 'card:a')
  assert.equal(pickNextStep([{ key: 'card:a', kind: 'card', order: 1 }, { key: 'wrap', kind: 'wrapup', order: 9 }]), 'wrap')
})

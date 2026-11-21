/**
 * ⌘↵ 执行推荐的下一步（feat#166，审查第 7 条）：在构建好的 lib/client.js 里真的挂上监听
 * （mountNextStepKeys → installNextStepKeys），再往替身 window 上发按键。页面用一个很小的
 * 替身 DOM：元素记着自己符合哪些选择器和上一层，closest、matches、querySelectorAll 按这个找。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './react-harness.mjs'

/**
 * 替身元素：selectors 是它自己符合的选择器，parent 是上一层；visibilityHidden 是 CSS 的
 * `visibility: hidden`，照浏览器的 checkVisibility：只有传了 visibilityProperty（旧名 checkVisibilityCSS）才算看不见。
 */
class FakeElement {
  constructor({ selectors = [], attributes = {}, parent = null, editable = false, visibilityHidden = false } = {}) {
    this.selectors = new Set(selectors)
    this.attributes = attributes
    this.parent = parent
    this.isContentEditable = editable || (parent?.isContentEditable ?? false)
    this.visibilityHidden = visibilityHidden
  }

  matches(selector) {
    return String(selector).split(',').some(part => this.selectors.has(part.trim()))
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parent) if (node.matches(selector)) return node
    return null
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  checkVisibility(options = {}) {
    return !(this.visibilityHidden && (options.visibilityProperty === true || options.checkVisibilityCSS === true))
  }
}

/** 一个会话的页面：会话容器、输入框（Lexical 的 contenteditable）、对话区里的一个按钮。 */
function page(sessionId) {
  const conversation = new FakeElement({ selectors: ['[data-conversation-session]'], attributes: { 'data-conversation-session': sessionId } })
  const scroll = new FakeElement({ selectors: ['[data-input-scroll]'], parent: conversation })
  const composer = new FakeElement({ selectors: ['[contenteditable="true"]'], parent: scroll, editable: true })
  const button = new FakeElement({ selectors: ['button'], parent: conversation })
  const plain = new FakeElement({ selectors: ['[contenteditable="plaintext-only"]'], parent: conversation, editable: true })
  return { conversation, composer, button, plain }
}

/** 替身 document：overlays 是现在开着的弹层。 */
function fakeDocument() {
  return {
    overlays: [],
    activeElement: null,
    querySelectorAll(selector) {
      return this.overlays.filter(node => node.matches(selector))
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    },
  }
}

/** 装好 ⌘↵：会话空闲，输入框的草稿和待处理交互由测试改。 */
function setup(t) {
  const document = fakeDocument()
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { document, Element: FakeElement })
  const sessionId = 'session-a'
  const state = { draft: '', pending: undefined, running: false }
  const bindingCtx = {}
  const ctx = {
    sessions: { binding: id => (id === sessionId ? { ctx: bindingCtx, session: { getSnapshot: () => ({ running: state.running }) } } : undefined) },
    conversation: {
      input: {
        for: owner => (owner === bindingCtx
          ? { state: { getSnapshot: () => ({ phase: 'plain', draft: state.draft, attachmentIds: [], occurrences: [] }) } }
          : undefined),
      },
    },
    uiSession: {
      sessionStatus: { getSnapshot: () => new Map([[sessionId, { running: state.running, pendingInteraction: state.pending, completionUnread: false }]]) },
      adapter: { current: { getSnapshot: () => ({ key: sessionId }) } },
    },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
  }
  const unmount = client.get('mountNextStepKeys')({ ctx, t: key => key })
  const runs = []
  const withdraw = client.get('offerNextStep')(sessionId, 'wrap:3', { kind: 'wrapup', order: 0, run: () => { runs.push('wrap:3') } })
  t.after(() => { withdraw(); unmount() })
  /** 在 target 上按 ⌘↵，返回这次按键有没有被拦下。 */
  const press = (target) => {
    const event = {
      type: 'keydown', code: 'Enter', key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false,
      defaultPrevented: false, propagationStopped: false,
      composedPath: () => (target === null ? [] : [target]),
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
    }
    client.window.dispatchEvent(event)
    return event.defaultPrevented
  }
  return { document, state, runs, press, ...page(sessionId), client }
}

test('a step offered by two open copies of the same session stays after either copy closes', (t) => {
  const client = loadClient(new URL('../lib/client.js', import.meta.url))
  const offer = client.get('offerNextStep')
  const runs = []
  const first = offer('s', 'card:a', { kind: 'card', order: 0, run: () => { runs.push('first') } })
  const second = offer('s', 'card:a', { kind: 'card', order: 0, run: () => { runs.push('second') } })
  const other = offer('s', 'card:b', { kind: 'card', order: 1, run: () => { runs.push('b') } })
  t.after(() => { first(); second(); other() })
  second()
  assert.equal(client.get('nextStepOf')('s'), 'card:a', 'the first copy is still open')
  assert.equal(client.get('runNextStep')('s'), true)
  assert.deepEqual(runs, ['first'])
  second()
  assert.equal(client.get('nextStepOf')('s'), 'card:a', 'closing a copy twice withdraws nothing else')
  first()
  assert.equal(client.get('nextStepOf')('s'), 'card:b')
})

test('⌘↵ in the empty composer runs the recommended step and keeps the key from the composer', (t) => {
  const { press, runs, composer, client } = setup(t)
  assert.equal(client.window.listenerCount('keydown'), 1)
  assert.equal(press(composer), true)
  assert.deepEqual(runs, ['wrap:3'])
})

test('⌘↵ with text in the composer is left to DSH (send)', (t) => {
  const { press, runs, composer, state } = setup(t)
  state.draft = '继续'
  assert.equal(press(composer), false)
  assert.deepEqual(runs, [])
})

test('⌘↵ while a menu, a candidate list or a workbench popover is open is left to it', (t) => {
  const { press, runs, composer, button, document } = setup(t)
  const overlays = {
    'the + candidates of the composer': new FakeElement({ selectors: ['[role="listbox"]'] }),
    'a drop-down or context menu': new FakeElement({ selectors: ['[role="menu"]'] }),
    'an anchored DSH panel': new FakeElement({ selectors: ['[role="dialog"]'] }),
    'the viewport size panel': new FakeElement({ selectors: ['.dwb-bv-menu'] }),
  }
  for (const [what, overlay] of Object.entries(overlays)) {
    document.overlays = [overlay]
    assert.equal(press(composer), false, what)
    assert.equal(press(button), false, what)
  }
  assert.deepEqual(runs, [])
  document.overlays = []
  assert.equal(press(button), true, 'closed again: runs')
  assert.deepEqual(runs, ['wrap:3'])
})

test('⌘↵ on the retry button of a command popup that failed to load is left to the popup', (t) => {
  // rc.3 的命令参数菜单读取失败时只有提示和「重试」按钮，没有 listbox；外层是 DSH 的菜单表面（data-menu-material）。
  const { press, runs, document } = setup(t)
  const surface = new FakeElement({ selectors: ['[data-menu-material]'] })
  const retry = new FakeElement({ selectors: ['button'], parent: surface })
  document.overlays = [surface]
  assert.equal(press(retry), false)
  assert.deepEqual(runs, [])
  document.overlays = [new FakeElement({ selectors: ['[data-menu-material]'], visibilityHidden: true })]
  assert.equal(press(retry), true, 'a hidden surface does not count')
  assert.deepEqual(runs, ['wrap:3'])
})

test('⌘↵ still runs while DSH keeps its navigation drawer hidden off screen in a narrow window', (t) => {
  // rc.3 在窄窗口里把左侧导航渲染成 role="dialog" 的抽屉，收起时是 visibility: hidden，留在 DOM 里。
  const { press, runs, button, document } = setup(t)
  document.overlays = [new FakeElement({ selectors: ['[role="dialog"]'], attributes: { 'aria-label': '导航' }, visibilityHidden: true })]
  assert.equal(press(button), true)
  assert.deepEqual(runs, ['wrap:3'])
})

test('⌘↵ while the session waits for an answer, an approval or a plan review is left alone', (t) => {
  const { press, runs, button, state } = setup(t)
  for (const kind of ['question', 'approval', 'plan-review']) {
    state.pending = { kind }
    assert.equal(press(button), false, kind)
  }
  assert.deepEqual(runs, [])
})

test('⌘↵ in a plaintext-only editor or while the session runs is left alone', (t) => {
  const { press, runs, plain, composer, state } = setup(t)
  assert.equal(press(plain), false)
  state.running = true
  assert.equal(press(composer), false)
  assert.deepEqual(runs, [])
})

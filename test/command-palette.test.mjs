import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paletteItems, paletteFilter, createPaletteController } from '../src/client/command-palette-model.js'
import { apply as applyPalette } from '../lib/command-palette.js'
import { enabledFeatures } from '../lib/features.js'

test('功能行只登记可撤销的界面能力，不接入任何预设的工具或提示词', () => {
  const disposers = []
  const context = new Proxy({ effect: fn => { const dispose = fn(); disposers.push(dispose); return dispose } }, {
    get: (target, key) => { assert(key in target, `unexpected model or preset service: ${String(key)}`); return target[key] },
  })
  applyPalette(context)
  assert(enabledFeatures().some(x => x.id === 'command-palette'))
  for (const dispose of disposers) dispose()
  assert(!enabledFeatures().some(x => x.id === 'command-palette'))
})

const sessions = [
  { id: 'a', displayTitle: '当前项目', cwd: '/work/a', origin: 'user' },
  { id: 'b', displayTitle: '已归档', origin: 'user' },
  { id: 'child', displayTitle: '子智能体', origin: 'subagent' },
]
const commands = [{ name: 'model', label: '模型' }, { name: 'compact' }, { name: 'push' }, { name: 'delete' }, { name: 'unreviewed-plugin-command' }]

test('目录包含全部当前命令与未归档普通会话，搜索也匹配英文命令', () => {
  const rows = paletteItems({ commands, sessions, archivedIds: new Set(['b']), actions: [{ id: 'sessions', label: '会话' }] })
  assert.deepEqual(rows.map(x => x.id), ['command:model', 'command:compact', 'command:push', 'command:delete', 'command:unreviewed-plugin-command', 'session:a', 'action:sessions'])
  assert.deepEqual(paletteFilter(rows, ' MODEL ', 'command').map(x => x.id), ['command:model'])
  assert.deepEqual(paletteFilter(rows, '当前', 'session').map(x => x.id), ['session:a'])
  assert.deepEqual(paletteFilter(rows, 'work/a', 'session').map(x => x.id), ['session:a'])
})

function harness() {
  let target = 'a', running = false, inputState = { draft: '', attachmentIds: [], occurrences: [], draftRev: 1, phase: 'plain' }
  const inserted = [], opened = [], calls = []; let submissions = 0
  let load = async () => commands, focus = (_target, input) => { input.focus(); return true }
  const binding = { id: 'a' }
  const deps = {
    target: () => target === undefined ? undefined : { id: target, binding, running },
    entries: () => ({ sessions, archivedIds: new Set(['b']), actions: [] }),
    commands: (who, signal) => { calls.push(who.id); return load(who, signal) },
    input: () => ({ state: { getSnapshot: () => inputState }, actions: {
      submit: () => { submissions++ },
      setDraft: text => { inserted.push(text) },
      captureInsertion: () => ({ draftRev: inputState.draftRev }),
      insertText: (text, span) => { if (span.draftRev !== inputState.draftRev) return false; inserted.push(text); return true },
    }, focus: () => {} }),
    openSession: id => opened.push(id), openAction: () => {}, focusInput: (...args) => focus(...args), refused: () => {},
  }
  return { controller: createPaletteController(deps), inserted, opened, calls, submissions: () => submissions,
    focus: value => { focus = value }, target: value => { target = value }, running: value => { running = value }, state: value => { inputState = { ...inputState, ...value } }, load: value => { load = value } }
}

test('会话在选择期间开始运行时不插入命令', async () => {
  const h = harness(); await h.controller.open(); h.running(true); await h.controller.choose('command:compact')
  assert.deepEqual(h.inserted, []); assert.equal(h.controller.getSnapshot().notice, 'running')
})

test('选择命令只插入草稿，不执行；选择会话委托官方打开', async () => {
  const h = harness(); await h.controller.open()
  await h.controller.choose('command:model')
  assert.deepEqual(h.inserted, ['/model']); assert.equal(h.controller.getSnapshot().open, false)
  await h.controller.open(); await h.controller.choose('session:a'); assert.deepEqual(h.opened, ['a'])
})

test('文字、附件、引用或被占用的输入框均保留原内容', async () => {
  for (const patch of [{ draft: ' ' }, { attachmentIds: ['image-1'] }, { occurrences: [{}] }, { phase: 'claimed' }]) {
    const h = harness(); h.state(patch); await h.controller.open(); await h.controller.choose('command:model')
    assert.deepEqual(h.inserted, []); assert.equal(h.controller.getSnapshot().notice, 'draft')
  }
})

test('关闭后迟到的目录不会重开；当前会话变化后不能写入旧目标', async () => {
  const h = harness(); let finish; h.load(() => new Promise(resolve => { finish = resolve }))
  const pending = h.controller.open(); h.controller.close(); finish(commands); await pending
  assert.equal(h.controller.getSnapshot().open, false); assert.deepEqual(h.controller.getSnapshot().items, [])
  h.load(async () => commands); await h.controller.open(); h.target('other'); await h.controller.choose('command:model')
  assert.deepEqual(h.inserted, []); assert.equal(h.controller.getSnapshot().notice, 'target')
})

test('重新验证命令期间新增的草稿和撤回的命令都不能被覆盖', async () => {
  const h = harness(); await h.controller.open(); let finish
  h.load(() => new Promise(resolve => { finish = resolve })); const pending = h.controller.choose('command:model')
  h.state({ draft: '后来输入的文字', draftRev: 2 }); finish(commands); await pending
  assert.deepEqual(h.inserted, [])
  h.state({ draft: '' }); h.load(async () => []); await h.controller.choose('command:model')
  assert.deepEqual(h.inserted, []); assert.equal(h.controller.getSnapshot().notice, 'unavailable')
})

test('无当前保留会话不读取命令目录；目录失败时仍可打开会话', async () => {
  const h = harness(); h.target(undefined); await h.controller.open(); assert.deepEqual(h.calls, [])
  assert.ok(h.controller.getSnapshot().items.some(x => x.id === 'session:a'))
  h.target('a'); h.load(async () => { throw new Error('offline') }); await h.controller.open()
  assert.equal(h.controller.getSnapshot().error, true); await h.controller.choose('session:a'); assert.deepEqual(h.opened, ['a'])
})

test('冷会话仅被筛选，不为搜索触发目录加载', async () => {
  const h = harness(); await h.controller.open(); const before = h.calls.length
  const rows = paletteItems({ commands: [], sessions: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), displayTitle: `project ${i}` })), actions: [] })
  assert.equal(paletteFilter(rows, 'project 99', 'session').length, 11)
  assert.equal(h.calls.length, before)
})

test('面板未打开或关闭后，列表变化不触发命令读取', async () => {
  const h = harness()
  for (let i = 0; i < 100; i++) h.controller.refresh()
  assert.deepEqual(h.calls, [])
  await h.controller.open(); h.controller.close()
  for (let i = 0; i < 100; i++) h.controller.refresh()
  assert.deepEqual(h.calls, ['a'])
})

test('弹窗关闭并恢复输入焦点前不写入，期间的新草稿保留', async () => {
  const h = harness(); await h.controller.open(); let resume
  h.focus(() => new Promise(resolve => { resume = resolve }))
  const selection = h.controller.choose('command:model'); await new Promise(resolve => setImmediate(resolve))
  try { assert.deepEqual(h.inserted, []); h.state({ draft: '期间写入' }) } finally { resume(true) }
  await selection; assert.deepEqual(h.inserted, [])
})

test('名单以外的命令只填草稿，用户确认前不执行', async () => {
  const h=harness(); await h.controller.open(); await h.controller.choose('command:unreviewed-plugin-command');
  assert.deepEqual(h.inserted,['/unreviewed-plugin-command']);assert.equal(h.submissions(),0);
})

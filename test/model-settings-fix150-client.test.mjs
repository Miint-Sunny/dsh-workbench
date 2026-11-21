/** 模型设置（从 dsh-model-settings 的 test/fix150-client.test.mjs 搬来，feat#217）。 fix#150（chore#149 审查）：行从外面换掉时键、展开状态和写到一半的文字跟着模型走；动画不因第一次修改跳过；同一条错不报两遍；拖出列表收起插入线。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignRowKeys, rowIds, msSameIds as sameIds } from '../src/client/model-settings/models.js'
import { loadClient, textOf } from './react-harness.mjs'

test('按模型 ID 对回行键：ID 唯一的模型沿用原来的键，没有 ID、ID 重复或新来的拿新键', () => {
  let seq = 0
  const fresh = () => `n${seq++}`
  assert.deepEqual(alignRowKeys([{ id: 'alpha' }, { id: 'bravo' }], ['m0', 'm1'], [{ id: 'bravo' }], fresh), ['m1'])
  assert.deepEqual(alignRowKeys([{ id: 'a' }, { id: '' }, { id: 'b' }], ['k0', 'k1', 'k2'], [{ id: 'b' }, { id: '' }, { id: 'c' }], fresh), ['k2', 'n0', 'n1'])
  assert.deepEqual(alignRowKeys([{ id: 'x' }, { id: 'x' }], ['k0', 'k1'], [{ id: 'x' }], fresh), ['n2'])
  assert.deepEqual(rowIds([{ id: 'a' }, {}, { id: 3 }]), ['a', '', ''])
  assert.equal(sameIds(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameIds(['a', 'b'], ['b', 'a']), false)
})

/** 挂一个受控的 ModelsEditor：行放在外层状态里；setRows 让测试从外面换行（像选择器删伴随行、恢复默认、取消）。 */
function mountEditor(t0, initial, extra = {}) {
  const client = loadClient(new URL('../lib/client.js', import.meta.url))
  const react = client.react
  const { createElement, useState } = react.React
  const app = { t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`), ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } } }
  const handle = {}
  function Host() {
    const [rows, setRows] = useState(initial)
    const [inherited, setInherited] = useState(extra.inherited ?? false)
    handle.setRows = setRows
    handle.rows = rows
    return createElement(client.get('ModelsEditor'), {
      app, family: 'pi-ai', rows, inherited, disabled: false, ...extra,
      onChange: (next) => { setInherited(false); setRows(next) },
    })
  }
  react.mount(createElement(Host))
  t0.after(() => react.unmount())
  return { react, handle }
}
const rowsOf = react => react.all(node => node.props?.className === 'dms-mrow' || node.props?.className === 'dms-module')
const idOfRow = node => textOf(node).match(/^(alpha|bravo|gamma)/)?.[1]

test('外面删掉一行（选择器里删目录外的模型）：剩下的行保留自己的键，不继承被删行的展开状态和写到一半的容量', async (t0) => {
  const { react, handle } = mountEditor(t0, [{ id: 'alpha' }, { id: 'bravo' }])
  await react.settle()
  const keyOf = Object.fromEntries(rowsOf(react).map(node => [idOfRow(node), node.props['data-row-key']]))
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith('alpha'), 'alpha 的行'), 'onClick')
  await react.settle()
  const input = react.one(node => node.props?.id === 'dms-model-0-contextWindow', 'alpha 的上下文窗口')
  input.props.onChange({ target: { value: 'abc' } })
  await react.settle()
  handle.setRows([{ id: 'bravo' }])
  await react.settle()
  const [row] = rowsOf(react)
  assert.equal(idOfRow(row), 'bravo')
  assert.equal(row.props['data-row-key'], keyOf.bravo)
  assert.equal(row.props.className, 'dms-mrow', 'bravo 没有被展开')
})

test('取消、恢复默认把值换回去：写到一半的非法容量不再显示，输入框按现在的值显示', async (t0) => {
  const original = [{ id: 'alpha', contextWindow: 200000 }]
  const { react, handle } = mountEditor(t0, original)
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model', 'alpha 的行'), 'onClick')
  await react.settle()
  react.one(node => node.props?.id === 'dms-model-0-contextWindow', '上下文窗口').props.onChange({ target: { value: 'xyz' } })
  await react.settle()
  assert.equal(react.one(node => node.props?.id === 'dms-model-0-contextWindow', '上下文窗口').props.value, 'xyz')
  handle.setRows(original)
  await react.settle()
  assert.equal(react.one(node => node.props?.id === 'dms-model-0-contextWindow', '上下文窗口').props.value, '200K')
})

test('动画的 resetKey 固定：继承的目录第一次被改时也照常有移动动画', async (t0) => {
  const { react } = mountEditor(t0, [{ id: 'alpha' }, { id: 'bravo' }], { inherited: true })
  await react.settle()
  const list = () => react.one(node => node.type === 'ui.AnimatedRows', '行列表')
  assert.equal(list().props.resetKey, '')
  react.fire(react.one(node => node.type === 'button' && node.props['aria-label'] === 'reorderModel alpha', 'alpha 的把手'), 'onKeyDown', { key: 'ArrowDown' })
  await react.settle()
  assert.deepEqual(rowsOf(react).map(idOfRow), ['bravo', 'alpha'])
  assert.equal(list().props.resetKey, '')
})

test('只收某几档的协议（Gemini API）：同一行的这条错只显示一遍', async (t0) => {
  const gemini = { levels: ['minimal', 'low', 'medium', 'high'], levelsOnly: true }
  const { react } = mountEditor(t0, [{ id: 'alpha', reasoningEfforts: { off: null, high: 'high' } }], { reasoningOf: () => gemini })
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model', 'alpha 的行'), 'onClick')
  await react.settle()
  const alerts = react.all(node => node.props?.role === 'alert' && textOf(node) === 'modelReasoningLevelsOnly')
  assert.equal(alerts.length, 1)
})

test('拖出这一行（不是进到它里面）时收起插入线', async (t0) => {
  const { react } = mountEditor(t0, [{ id: 'alpha' }, { id: 'bravo' }, { id: 'gamma' }])
  await react.settle()
  react.fire(react.one(node => node.type === 'button' && node.props['aria-label'] === 'reorderModel alpha', 'alpha 的把手'), 'onDragStart')
  await react.settle()
  react.fire(rowsOf(react)[2], 'onDragOver')
  await react.settle()
  assert.equal(rowsOf(react)[2].props['data-drop'], 'before')
  react.fire(rowsOf(react)[2], 'onDragLeave', { relatedTarget: null })
  await react.settle()
  assert.deepEqual(rowsOf(react).map(node => node.props['data-drop'] ?? '-'), ['-', '-', '-'])
})

test('打字改模型 ID：这一行和输入框都不重挂（输入框不丢焦点），行键不变，输入框显示刚打的字；清空、改成和别的行重名时也一样（chore#151、chore#155：行键不要改用模型 ID）', async (t0) => {
  const { react, handle } = mountEditor(t0, [{ id: 'alpha' }, { id: 'bravo' }])
  await react.settle()
  const keysBefore = rowsOf(react).map(node => node.props['data-row-key'])
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-model' && textOf(node).startsWith('alpha'), 'alpha 的行'), 'onClick')
  await react.settle()
  // 测试工具按 React key 拼节点路径，key 一变就换一个新的宿主节点，所以「还是同一个节点」就是没有重挂；data-row-key 是另一个字段，只看它不够。
  const row = rowsOf(react)[0]
  const idInput = react.one(node => node.props?.id === 'dms-model-0-id', '第一行的模型 ID')
  for (const value of ['alph', '', 'bravo', 'alpha-2']) {
    idInput.props.onChange({ target: { value } })
    await react.settle()
    assert.equal(rowsOf(react)[0], row, `打到「${value}」时这一行没有重挂`)
    assert.equal(react.one(node => node.props?.id === 'dms-model-0-id', '第一行的模型 ID'), idInput, `打到「${value}」时输入框没有重挂`)
    assert.equal(idInput.props.value, value)
    assert.deepEqual(rowsOf(react).map(node => node.props['data-row-key']), keysBefore, `打到「${value}」时行键没变`)
  }
  assert.deepEqual(handle.rows.map(model => model.id), ['alpha-2', 'bravo'])
  assert.equal(row.props.className, 'dms-module', '第一行仍然展开')
})

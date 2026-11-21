/** 模型设置（从 dsh-model-settings 的 test/fix147-client.test.mjs 搬来，feat#217）。 fix#147：模型页拖动排序的落点和整行预览照官方；行的键跟着模型走（AnimatedRows 靠它做移动动画）；按行校验推理等级。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateReasoningByRow } from '../src/client/model-settings/models.js'
import { protocolReasoningLevels } from '../src/client/model-settings/protocol.js'
import { loadClient, textOf } from './react-harness.mjs'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

test('按行校验推理等级：每行用自己协议的档位，Gemini API 的行只收四档；没有档位的行不校验', () => {
  const levelsFor = model => protocolReasoningLevels(model.api, LEVELS)
  const rows = [
    { id: 'a', api: 'anthropic-messages', reasoningEfforts: { off: null, high: 'high' } },
    { id: 'b', api: 'google-generative-ai', reasoningEfforts: { off: null, high: 'high' } },
  ]
  assert.deepEqual(validateReasoningByRow(rows, levelsFor), { index: 1, key: 'modelReasoningLevelsOnly' })
  assert.equal(validateReasoningByRow([rows[0], { id: 'c', api: 'google-generative-ai', reasoningEfforts: { low: 'low' } }], levelsFor), undefined)
  assert.equal(validateReasoningByRow([{ id: 'd', reasoningEfforts: { off: null } }], () => ({ levels: [], levelsOnly: false })), undefined)
  assert.deepEqual(validateReasoningByRow([{ id: 'e', reasoningEfforts: { high: '' } }], () => ({ levels: LEVELS, levelsOnly: false })), { index: 0, key: 'modelReasoningValueRequired' })
})

/** 挂一个受控的 ModelsEditor：行放在外层状态里，onChange 写回。 */
function mountEditor(t0, initial) {
  const client = loadClient(new URL('../lib/client.js', import.meta.url))
  const preview = { starts: 0, clears: 0 }
  client.set('useRowDragPreview', () => ({ start() { preview.starts++ }, clear() { preview.clears++; return true } }))
  const react = client.react
  const { createElement, useState } = react.React
  const app = { t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`), ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } } }
  function Host() {
    const [rows, setRows] = useState(initial)
    return createElement(client.get('ModelsEditor'), { app, family: 'pi-ai', rows, inherited: false, onChange: setRows, disabled: false })
  }
  react.mount(createElement(Host))
  t0.after(() => react.unmount())
  return { react, preview }
}
const rowNodes = react => react.all(node => node.props?.className === 'dms-mrow')

test('拖动排序：拖起来时整行生成预览，放下后结束；行的键跟着模型走，落点只标在目标行上', async (t0) => {
  const { react, preview } = mountEditor(t0, [{ id: 'alpha' }, { id: 'bravo' }, { id: 'gamma' }])
  await react.settle()
  const before = rowNodes(react).map(node => [textOf(node).slice(0, 5), node.props['data-row-key']])
  assert.deepEqual(before.map(([id]) => id), ['alpha', 'bravo', 'gamma'])
  // 每行都有键，而且各不相同（按位置给的键在移动后会对不上，下面会查出来）。
  assert.equal(new Set(before.map(([, key]) => key).filter(key => typeof key === 'string')).size, 3)
  const keyOf = Object.fromEntries(before)
  // 把 alpha 拖到 gamma 前面（替身事件没有尺寸，落在行的上半）。
  react.fire(react.one(node => node.type === 'button' && node.props['aria-label'] === 'reorderModel alpha', 'alpha 的把手'), 'onDragStart')
  assert.equal(preview.starts, 1)
  await react.settle()
  react.fire(rowNodes(react)[2], 'onDragOver')
  await react.settle()
  assert.deepEqual(rowNodes(react).map(node => node.props['data-drop'] ?? '-'), ['-', '-', 'before'])
  assert.equal(rowNodes(react)[0].props['data-dragging'], 'true')
  react.fire(rowNodes(react)[2], 'onDrop')
  react.fire(react.one(node => node.type === 'button' && node.props['aria-label'] === 'reorderModel alpha', 'alpha 的把手'), 'onDragEnd')
  await react.settle()
  assert.equal(preview.clears, 1)
  const after = rowNodes(react).map(node => [textOf(node).slice(0, 5), node.props['data-row-key']])
  assert.deepEqual(after.map(([id]) => id), ['bravo', 'alpha', 'gamma'])
  // 同一个模型还是原来的键：动画据此把行从原位置滑过去，而不是淡出再淡入。
  for (const [id, key] of after) assert.equal(key, keyOf[id])
  assert.deepEqual(rowNodes(react).map(node => node.props['data-drop'] ?? '-'), ['-', '-', '-'])
})

test('删除一行后，其余行的键不变；新加的行拿新键', async (t0) => {
  const { react } = mountEditor(t0, [{ id: 'alpha' }, { id: 'bravo' }])
  await react.settle()
  const keyOf = Object.fromEntries(rowNodes(react).map(node => [textOf(node).slice(0, 5), node.props['data-row-key']]))
  react.fire(react.one(node => node.type === 'button' && node.props['aria-label'] === 'removeModel alpha', '删除 alpha'), 'onClick')
  await react.settle()
  assert.deepEqual(rowNodes(react).map(node => node.props['data-row-key']), [keyOf.bravo])
})

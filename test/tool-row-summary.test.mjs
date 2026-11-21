/**
 * 工作台的工具行（新会话卡片、收尾、本地审查、项目记忆、发布页面）照 DSH 自己的工具行排：标题后面先是读屏不念的
 * 分隔点，再接摘要；摘要为空时连分隔点也不出（没有分隔点时，工具行的名称和后面的摘要几乎连在一起）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key}:${Object.values(params).join(',')}`)

/**
 * 画出一个工具行，按屏幕上的顺序列出折叠时这一行的几段：标题、分隔点（记成「·」）、摘要、摘要后面的按钮。
 * @param {object} client loadClient 的结果。
 * @param {string} component 包里的组件名。
 * @param {object} props 组件的属性。
 * @returns {{parts: string[], nodes: object[]}} 各段的文字，和标题后面各段的节点。
 */
function rowParts(client, component, props) {
  const { react } = client
  react.mount(react.React.createElement(client.get(component), props))
  const row = react.one(node => node.type === 'ui.DisclosureRow', '工具行')
  const content = row.props.collapsedContent
  if (content === undefined || content === null) return { parts: [row.props.title], nodes: [] }
  react.mount(content)
  const nodes = react.all(node => node.parent === null)
  const parts = nodes.map(node => (node.props['aria-hidden'] === true && textOf(node) === '' ? '·' : textOf(node)))
  return { parts: [row.props.title, ...parts], nodes }
}

test('新会话卡片和收尾的工具行：标题、分隔点、摘要；还在准备或没有摘要时只有标题', (t0) => {
  const client = loadClient(CLIENT)
  t0.after(() => client.react.unmount())
  const args = values => ({ text: key => values[key] })
  const card = rowParts(client, 'SessionCardToolRow', {
    app: { t },
    phase: 'result',
    block: {
      args: args({ title: '整理发布说明' }),
      call: { name: 'propose_session', argsRaw: JSON.stringify({ title: '整理发布说明', brief: 'b' }) },
      isError: false,
      meta: { ok: true, card: { title: '整理发布说明', brief: 'b', options: {} } },
    },
  })
  assert.deepEqual(card.parts, ['scard.toolRow', '·', '整理发布说明'])
  assert.deepEqual(rowParts(client, 'SessionCardToolRow', { app: { t }, phase: 'preparing', block: { args: args({}) } }).parts, ['scard.toolRow'])
  assert.deepEqual(rowParts(client, 'WrapUpToolRow', { app: { t }, phase: 'result', block: { args: args({ recap: '改好了。\n还差截图。' }) } }).parts,
    ['wrap.toolRow', '·', '改好了。'], '摘要取总结的第一行')
  assert.deepEqual(rowParts(client, 'WrapUpToolRow', { app: { t }, phase: 'result', block: { args: args({ recap: '' }) } }).parts, ['wrap.toolRow'])
})

test('本地审查的工具行：分隔点后面是「打开报告」，点了在本会话的审阅标签里显示这份报告；没有报告时只有标题', (t0) => {
  const client = loadClient(CLIENT)
  t0.after(() => client.react.unmount())
  const opened = []
  const app = {
    t,
    ctx: { sidebarRight: { mounted: { getSnapshot: () => 's9' }, openResource: (address, options) => { opened.push([address, options]) } } },
    store: { has: () => true, subscribe: () => () => {} },
  }
  const row = rowParts(client, 'ReviewFindingsCard', { app, sessionId: 's9', phase: 'result', block: { meta: { count: 2, reportId: 'r1' } } })
  assert.deepEqual(row.parts, ['lr.found:2', '·', 'lr.openReport'])
  client.react.fire(client.react.one(node => node.type === 'button', '打开报告按钮'), 'onClick')
  assert.deepEqual(opened, [['dsh-resource://wbreview/session/s9', { params: { reportId: 'r1' } }]])
  assert.deepEqual(rowParts(client, 'ReviewFindingsCard', { app, sessionId: 's9', phase: 'result', block: { meta: { count: 0 } } }).parts, ['lr.found:0'])
})

test('运行中停用改动审阅这一行，报告卡片留下条数并移除不可用的入口', async (t0) => {
  const client = loadClient(CLIENT)
  t0.after(() => client.react.unmount())
  let enabled = true
  const listeners = new Set()
  const store = {
    has: () => enabled,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const props = { app: { t, store }, sessionId: 's9', phase: 'result', block: { meta: { count: 2, reportId: 'r1' } } }
  client.react.mount(client.react.React.createElement(client.get('ReviewFindingsCard'), props))
  const row = () => client.react.one(node => node.type === 'ui.DisclosureRow', '工具行')
  assert.ok(row().props.collapsedContent)
  enabled = false
  for (const notify of listeners) notify()
  await client.react.settle()
  assert.equal(row().props.title, 'lr.found:2')
  assert.equal(row().props.collapsedContent, undefined)
})

test('项目记忆的工具行：分隔点后面是大小；失败时摘要标成出错', (t0) => {
  const client = loadClient(CLIENT)
  t0.after(() => client.react.unmount())
  const block = { kind: 'result', meta: { bytes: 120, exists: true }, content: [{ type: 'text', text: '{"content":"记住这件事"}' }], isError: false }
  const ok = rowParts(client, 'MemoryToolRow', { phase: 'result', block, writing: false, t })
  assert.deepEqual(ok.parts, ['memory.read', '·', 'memory.size:120'])
  assert.equal(ok.nodes[1].props['data-error'], undefined)
  const failed = rowParts(client, 'MemoryToolRow', { phase: 'result', block: { ...block, isError: true }, writing: true, t })
  assert.deepEqual(failed.parts, ['memory.write', '·', 'memory.failed'])
  assert.notEqual(failed.nodes[1].props['data-error'], undefined, '失败的摘要用出错的颜色')
})

test('发布页面的工具行：分隔点后面是版本、大小和内联，再是「打开」；失败时是标成出错的原因', (t0) => {
  const client = loadClient(CLIENT)
  t0.after(() => client.react.unmount())
  client.set('pagesT', t)
  t0.after(() => client.set('pagesT', undefined))
  const ok = rowParts(client, 'PublishRow', { phase: 'result', block: { kind: 'result', meta: { id: 'p1', n: 2, title: '发布说明', size: 2048, assets: {} }, content: [], isError: false } })
  assert.equal(ok.parts.length, 4)
  assert.deepEqual([ok.parts[0], ok.parts[1], ok.parts[3]], ['发布说明', '·', 'pages.row.open'])
  assert.match(ok.parts[2], /^pages\.version:2 · 2 KB · pages\.inline:/)
  const failed = rowParts(client, 'PublishRow', { phase: 'result', block: { kind: 'result', content: [{ type: 'text', text: '网络断了\n详情' }], isError: true } })
  assert.deepEqual(failed.parts, ['pages.row.title', '·', 'pages.row.failed:网络断了'])
  assert.notEqual(failed.nodes[1].props['data-error'], undefined)
})

test('新写的工具行也照 DSH 排：collapsedContent 交给 toolRowSummary（MCP 页的分组行不是工具行，除外）', () => {
  const directory = new URL('../src/client/', import.meta.url)
  const NOT_TOOL_ROWS = new Set(['mcp.js'])
  const offenders = []
  for (const file of readdirSync(directory).filter(name => name.endsWith('.js') && !NOT_TOOL_ROWS.has(name))) {
    const source = readFileSync(new URL(file, directory), 'utf8')
    for (const match of source.matchAll(/collapsedContent:(?!\s*toolRowSummary\()/g)) {
      offenders.push(`${file}:${source.slice(0, match.index).split('\n').length}`)
    }
  }
  assert.deepEqual(offenders, [], '工具行折叠时标题后面的部分用 controls.js 的 toolRowSummary(摘要, { error, suffix }) 生成，才有 DSH 的分隔点和摘要样式')
})

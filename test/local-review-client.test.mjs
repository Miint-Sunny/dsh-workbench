/** 本地审查和审阅标签的入口测试。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const REPORT_ID = `wbr-${'a'.repeat(64)}-moh7n7ca-${'b'.repeat(32)}`
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 挂本地审查这一行，记录槽位、命令事件和右侧栏调用。 */
function mountLocalReview({ reviewRow = true, fetch = async () => json({ reports: [{ id: REPORT_ID }] }) } = {}) {
  const client = loadClient(CLIENT, { fetch })
  const listeners = new Map()
  const slots = new Map()
  const tabTypes = new Map()
  const opened = []
  let currentSession = 's1'
  const ctx = {
    slots: {
      inject(_name, setup) {
        const result = setup()
        if (typeof result === 'function') return result
        const disposers = [...result]
        return () => disposers.forEach(dispose => dispose())
      },
      register({ name, key }, component) {
        const slot = key === undefined ? name : `${name}:${key}`
        slots.set(slot, component)
        return () => slots.delete(slot)
      },
    },
    resources: { register: () => () => {} },
    sidebarRightTabs: { register: (type) => { tabTypes.set(type.kind, type); return () => tabTypes.delete(type.kind) } },
    contextMenus: { register: () => () => {} },
    sidebarRight: {
      mounted: { getSnapshot: () => currentSession },
      openResource: (address, options) => { opened.push([address, options]) },
    },
    on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name) },
    effect: fn => fn(),
  }
  const app = { ctx, t: key => key, store: { has: id => (id === 'review' ? reviewRow : true) } }
  const dispose = client.get('applyLocalReview')(app)
  return { app, client, opened, listeners, slots, tabTypes, dispose, select: id => { currentSession = id } }
}

test('/review 跑完：打开本会话的审阅标签，显示刚发起的那份报告（它按报告的范围切过去）', async () => {
  const { opened, listeners, dispose } = mountLocalReview()
  await listeners.get('command/executed')('s1', 'review', { kind: 'success' })
  assert.deepEqual(opened, [['dsh-resource://wbreview/session/s1', { params: { reportId: REPORT_ID } }]])
  // 别的命令、失败的 /review 不打开。
  await listeners.get('command/executed')('s1', 'commit', { kind: 'success' })
  await listeners.get('command/executed')('s1', 'review', { kind: 'error' })
  assert.equal(opened.length, 1)
  dispose()
})

test('/review 跑完但改动审阅这一行关着：没有审阅面板可开，不打开别的页', async () => {
  const { opened, listeners, dispose } = mountLocalReview({ reviewRow: false })
  await listeners.get('command/executed')('s1', 'review', { kind: 'success' })
  assert.deepEqual(opened, [])
  dispose()
})

test('/review 等报告清单时切换会话，报告不会打开到新的会话里', async (t) => {
  const request = Promise.withResolvers()
  const view = mountLocalReview({ fetch: () => request.promise })
  t.after(view.dispose)
  const completed = view.listeners.get('command/executed')('s1', 'review', { kind: 'success' })
  view.select('s2')
  request.resolve(json({ reports: [{ id: REPORT_ID }] }))
  await completed
  assert.deepEqual(view.opened, [])
})

test('内部预设提示只在手动选了预设、没有审查报告的会话里出现', async (t) => {
  const view = mountLocalReview()
  t.after(view.dispose)
  t.after(() => view.client.react.unmount())
  const dock = view.slots.get('conversation.input.dock')
  const useProjection = () => 'dsh-workbench-readonly-review'
  view.client.react.mount(dock({ sessionId: 'ordinary-session', useProjection }))
  assert.equal(view.client.react.all(node => node.props.role === 'status').length, 1)
  view.client.react.update(dock({ sessionId: REPORT_ID, useProjection }))
  await view.client.react.settle()
  assert.equal(view.client.react.all(node => node.props.role === 'status').length, 0)
})

function mountSavedReviewTab(t, kind, contentId, params) {
  const view = mountLocalReview()
  t.after(view.dispose)
  t.after(view.client.get('applyReview')(view.app))
  t.after(() => view.client.react.unmount())
  const type = view.tabTypes.get(kind)
  assert.ok(type, `右侧栏认得保存的标签类型 ${kind}`)
  const component = view.slots.get(`sidebar.right.pane.tab:${type.id}`)
  const closed = []
  const tab = {
    contentId, visible: true, navigation: { params, revision: 1 },
    actions: {
      openResource: (address, options) => { view.opened.push([address, options]) },
      close: () => { closed.push(contentId) },
    },
  }
  view.client.react.mount(component({ sessionId: 's1', useTabInfo: () => ({ tab }) }))
  return { ...view, type, closed }
}

test('升级前保存的本地审查报告地址换成审阅标签，保留报告编号', (t) => {
  const address = `dsh-resource://wblocalreview/${REPORT_ID}`
  const view = mountSavedReviewTab(t, 'wblocalreview', address)
  assert.equal(view.type.canOpen(address), true)
  assert.deepEqual(view.type.guide ?? [], [])
  assert.deepEqual(view.opened, [['dsh-resource://wbreview/session/s1', { replaceTab: true, params: { reportId: REPORT_ID } }]])
  assert.deepEqual(view.closed, [address])
})

test('升级前从新标签页打开的本地审查页换成审阅标签，显示未暂存范围', (t) => {
  const address = 'sidebar://wblocalreview'
  const view = mountSavedReviewTab(t, 'wblocalreview', address)
  assert.deepEqual(view.opened, [['dsh-resource://wbreview/session/s1', { replaceTab: true, params: { scope: 'unstaged' } }]])
  assert.deepEqual(view.closed, [address])
})

test('别的会话的轮次地址和审阅地址不会把当前会话切到它们的范围或报告', (t) => {
  for (const [kind, address, params] of [
    ['changes-review', 'dsh-resource://changes-review/session/s2/50/5', { index: 2 }],
    ['wbreview', 'dsh-resource://wbreview/session/s2', { reportId: REPORT_ID }],
  ]) {
    const view = mountSavedReviewTab(t, kind, address, params)
    assert.deepEqual(view.opened, [])
    assert.deepEqual(view.closed, [address])
  }
})

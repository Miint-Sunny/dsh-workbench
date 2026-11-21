import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSidebarWorktreePaths, orderWorktreeEntries } from '../src/client/worktrees.js'

const ORIGINAL_FETCH = globalThis.fetch

async function withFetch(impl, run) {
  globalThis.fetch = impl
  try {
    return await run()
  }
  finally {
    globalThis.fetch = ORIGINAL_FETCH
  }
}

const own = [{ id: 'a', path: '/w/a', branch: 'a' }, { id: 'b', path: '/w/b', branch: 'b' }, { id: 'c', path: '/w/c', branch: 'c' }]
const ids = rows => rows.map(row => row.id)
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

const unavailable = [
  ['fetch 被拒绝', async () => { throw new TypeError('Failed to fetch') }],
  ['405 且没有正文', async () => new Response('', { status: 405 })],
  ['状态码 500 但正文是有效的 ok:true 列表', async () => json({ ok: true, value: [{ path: '/w/c' }] }, { status: 500 })],
  ['2xx 正文为空', async () => new Response('', { status: 200 })],
  ['2xx 正文不是 JSON', async () => new Response('<html>not found</html>', { status: 200 })],
  ['ok 不是 true', async () => json({ ok: false, error: 'nope' })],
  ['ok 缺失', async () => json({ value: [{ path: '/w/c' }] })],
  ['value 不是数组', async () => json({ ok: true, value: { path: '/w/c' } })],
  ['value 为 null', async () => json({ ok: true, value: null })],
]

for (const [name, impl] of unavailable) {
  test(`better-sidebar 读不到（${name}）时读取不抛错，排序保持原顺序`, async () => {
    await withFetch(impl, async () => {
      const paths = await readSidebarWorktreePaths({ sessionId: 's1' })
      assert.deepEqual(paths, [])
      assert.deepEqual(ids(orderWorktreeEntries(own, paths)), ['a', 'b', 'c'])
    })
  })
}

test('读得到时请求 better-sidebar 路由并带上 sessionId', async () => {
  let seen
  await withFetch(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return json({ ok: true, value: [] }) }, async () => {
    await readSidebarWorktreePaths({ sessionId: 's1' })
  })
  assert.equal(seen.url, 'sidebar/api/git.worktrees')
  assert.equal(seen.init.method, 'POST')
  assert.deepEqual(seen.body, { sessionId: 's1' })
})

test('读得到时按 better-sidebar 的顺序排列', async () => {
  const paths = await withFetch(async () => json({ ok: true, value: [{ path: '/w/c', changes: 3 }, { path: '/w/a', changes: 0 }] }), () => readSidebarWorktreePaths({ sessionId: 's1' }))
  assert.deepEqual(ids(orderWorktreeEntries(own, paths)), ['c', 'a', 'b'])
})

test('没列出的行排在后面，且保持原来的相对顺序', () => {
  const entries = [{ id: 'x', path: '/w/x' }, { id: 'a', path: '/w/a' }, { id: 'y', path: '/w/y' }, { id: 'c', path: '/w/c' }, { id: 'z', path: '/w/z' }]
  assert.deepEqual(ids(orderWorktreeEntries(entries, ['/w/c', '/w/a'])), ['c', 'a', 'x', 'y', 'z'])
})

test('路径完全对不上时保持原顺序', () => {
  assert.deepEqual(ids(orderWorktreeEntries(own, ['/elsewhere/1', '/elsewhere/2'])), ['a', 'b', 'c'])
})

test('better-sidebar 返回的异常行被忽略，不影响其余排序', async () => {
  const paths = await withFetch(async () => json({ ok: true, value: [null, 'oops', { path: 42 }, { path: '/w/b' }] }), () => readSidebarWorktreePaths({ sessionId: 's1' }))
  assert.deepEqual(paths, ['/w/b'])
  assert.deepEqual(ids(orderWorktreeEntries(own, paths)), ['b', 'a', 'c'])
})

test('结果里没有 changes，即使 better-sidebar 带了 changes', async () => {
  const paths = await withFetch(async () => json({ ok: true, value: [{ path: '/w/b', changes: 7 }] }), () => readSidebarWorktreePaths({ sessionId: 's1' }))
  const result = orderWorktreeEntries(own, paths)
  for (const row of result) assert.equal('changes' in row, false)
})

test('排序不改传入的数组，也不改其中的行', () => {
  const input = own.map(row => ({ ...row }))
  const snapshot = structuredClone(input)
  const before = [...input]
  const result = orderWorktreeEntries(input, ['/w/c'])
  assert.deepEqual(ids(result), ['c', 'a', 'b'])
  assert.deepEqual(input, snapshot)
  assert.deepEqual(input, before)
  assert.notEqual(result, input)
})

// ---------- 弹窗组件（替身 React 里跑构建好的 lib/client.js） ----------

/** 打开工作树弹窗；list 回 entries，inspect 回检查通过。 */
async function openDialog(t, entries) {
  const { loadClient, textOf } = await import('./react-harness.mjs')
  const calls = []
  const fetch = async (url, init) => {
    if (String(url) !== 'api/dsh-workbench.worktrees') return new Response('', { status: 404 })
    const body = JSON.parse(init.body)
    calls.push(body.op)
    if (body.op === 'list') return json({ ok: true, value: { entries, unfinished: [], current: '/w/main' } })
    if (body.op === 'inspect') return json({ ok: true, value: { safe: true, blockers: [], references: [] } })
    throw new Error(`没准备的操作 ${body.op}`)
  }
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { fetch })
  const react = client.react
  react.mount(react.React.createElement(client.get('WorktreesDialog'), { sessionId: 's1', app: { t: key => key }, close() {} }))
  t.after(() => react.unmount())
  await react.settle()
  const button = text => react.one(node => node.type === 'button' && textOf(node) === text, `「${text}」按钮`)
  return {
    calls,
    button,
    async click(text) {
      react.fire(button(text), 'onClick')
      await react.settle()
    },
    texts: () => react.all(node => node.props.role === 'status').map(textOf),
    has: text => react.all(node => node.type === 'button' && textOf(node) === text).length > 0,
  }
}

test('C-006 刷新后不留上一次的检查结论和确认框，清理要重新检查', async (t) => {
  const ui = await openDialog(t, [{ id: 'w1', path: '/w/feat', branch: 'feat', managed: true, returnable: true, trashed: false }])
  await ui.click('wt.inspect')
  assert.ok(ui.texts().includes('wt.clean'))
  await ui.click('wt.trash')
  assert.ok(ui.has('wt.confirm'))
  await ui.click('wt.refresh')
  assert.deepEqual(ui.calls, ['list', 'inspect', 'list'])
  assert.ok(!ui.texts().includes('wt.clean'))
  assert.ok(!ui.has('wt.confirm'))
  assert.equal(ui.button('wt.trash').props.disabled, true)
})

test('C-006 废纸篓里的目录已经不在时，「从废纸篓取回」不能点；目录还在时检查通过后可以点', async (t) => {
  const ui = await openDialog(t, [{ id: 'w2', path: '/trash/dsh-worktree-x', branch: 'old', managed: true, returnable: true, trashed: true, missing: true }])
  assert.equal(ui.button('wt.untrash').props.disabled, true)
  const present = await openDialog(t, [{ id: 'w3', path: '/trash/dsh-worktree-y', branch: 'kept', managed: true, returnable: true, trashed: true }])
  await present.click('wt.inspect')
  assert.equal(present.button('wt.untrash').props.disabled, false)
})

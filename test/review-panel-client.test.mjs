/**
 * 审阅面板网页端（feat#189）：在替身 React 里跑构建好的 lib/client.js，宿主是照设计说明第 8 节写的内存替身
 * （/api/dsh-workbench.git-review、改动审阅的 changes.* 和 review.*、本地审查的 local-review.*）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStorage, loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const SESSION = 's1'
const REPO = '0123456789abcdef'
const PANEL = `dsh-resource://wbreview/session/${SESSION}`
const REPORT = `wbr-${'a'.repeat(64)}-abcdefgh-${'b'.repeat(32)}`
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ctxLine = (old, now, text) => ({ kind: 'context', old, new: now, text })
const addLine = (now, text) => ({ kind: 'add', new: now, text })
const delLine = (old, text) => ({ kind: 'delete', old, text })
const redirectTs = () => ({
  path: 'src/auth/redirect.ts', status: 'modified', binary: false, tooLarge: false, added: 2, deleted: 1,
  hunks: [{ id: 'h0', oldStart: 12, oldLines: 3, newStart: 12, newLines: 4, lines: [
    ctxLine(12, 12, 'export function rememberTarget(url: string) {'),
    delLine(13, "  sessionStorage.setItem('target', url)"),
    addLine(13, '  if (!isSameOrigin(url)) return'),
    addLine(14, '  sessionStorage.setItem(TARGET_KEY, url)'),
    ctxLine(14, 15, '}'),
  ] }],
})
const loginMd = () => ({
  path: 'docs/login.md', status: 'untracked', binary: false, tooLarge: false, added: 2, deleted: 0,
  hunks: [{ id: 'h0', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [addLine(1, '# 登录'), addLine(2, '跳转回原页面')] }],
})
const diffOf = (scope, files, version = 'v1') => ({
  ok: true, scope, version, files,
  totals: { files: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0) },
})
const repoStatus = (over = {}) => ({
  id: REPO, name: 'app', kind: 'git', root: '/work/app', branch: 'feat/login-redirect', head: 'a1b2c3d', detached: false,
  upstream: 'origin/feat/login-redirect', remoteBranchMissing: false, ahead: 2, behind: 0, conflicts: 0,
  pushTarget: { remote: 'origin', branch: 'feat/login-redirect', setUpstream: false },
  counts: { unstaged: 2, staged: 1, uncommitted: 2 }, ...over,
})

/** 内存里的宿主。diffs 按范围给回答；posts 记下每个 POST（带头）；reply[action] 改某个动作的回答。 */
function reviewHost() {
  const host = {
    token: 'tok-1', running: false, repos: [repoStatus()],
    diffs: { unstaged: diffOf('unstaged', [loginMd(), redirectTs()]), staged: diffOf('staged', [redirectTs()]), uncommitted: diffOf('uncommitted', [loginMd(), redirectTs()]), branch: diffOf('branch', [redirectTs()]) },
    branches: { ok: true, defaultBase: 'main', local: ['main', 'feat/login-redirect'], remote: ['origin/main'] },
    commits: { ok: true, commits: [
      { sha: 'c3'.padEnd(40, '3'), short: 'c333333', subject: '登录后跳转回原来的页面', time: '2026-11-20T10:00:00Z' },
      { sha: 'c2'.padEnd(40, '2'), short: 'c222222', subject: '会话过期后重新登录', time: '2026-11-19T10:00:00Z' },
    ], truncated: false },
    reports: [], gets: [], posts: [], reply: {}, generation: [],
  }
  host.fetch = async (url, init = {}) => {
    const at = new URL(String(url), 'http://dsh.test/')
    const query = Object.fromEntries(at.searchParams)
    const method = init.method ?? 'GET'
    if (at.pathname === '/api/dsh-workbench.git-review' && method === 'GET') {
      host.gets.push(query)
      if (query.requestId !== undefined) return json(host.generation.shift() ?? { ok: true, status: 'running' })
      if (Object.keys(query).length === 1) return json({ ok: true, token: host.token, running: host.running, repos: host.repos })
      if (query.branches === '1') return json(host.branches)
      if (query.commits === '1') return json(host.commits)
      const answer = typeof host.diffs[query.scope] === 'function' ? await host.diffs[query.scope](query) : host.diffs[query.scope]
      return json(answer, answer.ok === false ? 409 : 200)
    }
    if (at.pathname === '/api/dsh-workbench.git-review' && method === 'POST') {
      const body = JSON.parse(init.body)
      const headers = new Headers(init.headers)
      host.posts.push({ ...body, token: headers.get('x-dsh-workbench-git-review'), type: headers.get('content-type') })
      if (headers.get('x-dsh-workbench-git-review') !== host.token) return json({ ok: false, code: 'forbidden' }, 403)
      const reply = host.reply[body.action]
      const answer = typeof reply === 'function' ? await reply(body) : reply ?? { ok: true, ...(body.action === 'revert' ? { undoId: '00000000-0000-4000-8000-000000000001' } : {}) }
      return json(answer, answer.ok === false ? 409 : 200)
    }
    if (at.pathname.startsWith('/api/dsh-workbench.local-review.')) {
      const action = at.pathname.slice('/api/dsh-workbench.local-review.'.length)
      if (action === 'list') return json({ reports: host.reports.map(r => structuredClone(r)) })
      if (action === 'get') return json(structuredClone(host.reports.find(r => r.id === query.id)))
      const body = JSON.parse(init.body)
      host.posts.push({ review: action, ...body })
      const record = host.reports.find(r => r.id === body.id)
      if (action === 'start') {
        const started = reportOf({ status: 'running', findings: [], selection: body.input.startsWith('--base') ? { mode: 'branch', base: body.input.split(' ')[1], untracked: false } : { mode: 'uncommitted', base: null, untracked: false } })
        host.reports.unshift(started)
        return json(started)
      }
      if (body.revision !== record.revision) return json({ error: { code: 'report-changed' } }, 409)
      record.revision += 1
      const finding = record.findings.find(f => f.id === body.findingId)
      if (action === 'state') {
        finding.status = body.status
        return json(structuredClone(record))
      }
      if (action === 'prepare') {
        finding.requestId ??= '00000000-0000-4000-8000-000000000009'
        return json({ parentId: SESSION, revision: record.revision, requestId: finding.requestId, finding: { ...finding }, root: '/repo', fingerprint: 'fp', partial: false })
      }
    }
    if (at.pathname === '/api/changes.summary') {
      host.gets.push({ summary: query.seq })
      return json({ turn: 5, files: [{ path: 'src/editor/save.ts', display: 'src/editor/save.ts', added: 2, deleted: 1 }], total: 1, added: 2, deleted: 1 })
    }
    if (at.pathname === '/api/changes.diff') {
      return json({ kind: 'text', path: 'src/editor/save.ts', display: 'src/editor/save.ts', before: true, after: true, coarse: false, hunks: [{ oldStart: 40, oldLines: 2, newStart: 40, newLines: 3, lines: [' export async function saveDraft(doc) {', '-  await store.write(doc.id, doc.text)', '+  const token = beginWrite(doc.id)', '+  await store.write(doc.id, doc.text)'] }] })
    }
    if (at.pathname === '/api/dsh-workbench.review.state') return json({ ok: true, reverts: host.turnReverts ?? [] })
    if (at.pathname === '/api/dsh-workbench.review.revert' || at.pathname === '/api/dsh-workbench.review.undo') {
      host.posts.push({ turnAction: at.pathname.split('.').pop(), ...JSON.parse(init.body) })
      return json({ ok: true })
    }
    throw new Error(`没准备的请求 ${method} ${url}`)
  }
  host.reviewStreams = []
  host.EventSource = class {
    constructor(url) { this.url = url; host.reviewStreams.push(this) }
    close() {}
  }
  return host
}

const finding = (over = {}) => ({ id: 'f1', path: 'src/auth/redirect.ts', line: 14, endLine: 14, severity: 'high', title: '同源判断失败时没有日志', description: '排查跳转失败时看不到原因。', evidence: '', validation: '', status: 'open', ...over })
function reportOf(over = {}) {
  return {
    id: REPORT, parentId: SESSION, created: Date.parse('2026-11-20T08:00:00Z'), status: 'completed', revision: 3, stale: false,
    childCreated: true, error: null, files: [], skipped: [], selection: { mode: 'uncommitted', base: null, untracked: false },
    findings: [finding(), finding({ id: 'f2', path: 'docs/login.md', line: 1, severity: 'low', title: '说明写得不完整' })], ...over,
  }
}

/** 元素树（没渲染出来的属性里的元素，比如 ui.Menu 的 anchor、ui.Modal 的 footer）里按条件找元素。 */
function findElements(element, predicate, out = []) {
  if (Array.isArray(element)) {
    for (const child of element) findElements(child, predicate, out)
    return out
  }
  if (element === null || typeof element !== 'object' || element.props === undefined) return out
  if (predicate(element)) out.push(element)
  findElements(element.props.children, predicate, out)
  return out
}
const elementText = element => (Array.isArray(element) ? element.map(elementText).join('')
  : typeof element === 'string' || typeof element === 'number' ? String(element)
    : element === null || typeof element !== 'object' || element.props === undefined ? '' : elementText(element.props.children))

/**
 * 挂一个审阅标签。params 是入口给的 navigation.params；status 是会话状态（running）。
 * 返回查找、点击的帮手，以及记下的右侧栏调用、右键菜单注册和发出的消息。
 */
async function openPanel(t, { host = reviewHost(), params, running = false, contentId = PANEL, turns, inputActions, prompt, before, storage } = {}) {
  const client = loadClient(CLIENT, { fetch: host.fetch, EventSource: host.EventSource })
  if (storage !== undefined) client.window.sessionStorage = storage
  before?.(client)
  const react = client.react
  const opened = []
  const closed = []
  const menus = new Map()
  const menuOpens = []
  const prompts = []
  const statuses = new Map([[SESSION, { running }]])
  const chat = { snapshot: { timeline: { turns: turns ?? new Map() } }, listeners: new Set() }
  const session = { prompt: prompt ?? (async (content, _mode, _x, requestId) => { prompts.push({ text: content[0].text, requestId }); return { ok: true } }) }
  const ctx = {
    contextMenus: {
      register: (entry) => { menus.set(entry.target, entry); return () => menus.delete(entry.target) },
      open: (target, point) => { menuOpens.push({ target, point }) },
    },
    sessions: { binding: () => ({ session }), using: async (_id, _o, run) => run({ binding: { session } }), refresh: async () => {} },
    uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => chat.snapshot, subscribe: (fn) => { chat.listeners.add(fn); return () => chat.listeners.delete(fn) } }) }) },
    sidebarRight: { openResource: (address, options) => { opened.push({ address, options }) } },
    uiWorkspace: { openSession() {} },
  }
  const app = { t: (key, values) => (values === undefined ? key : `${key} ${JSON.stringify(values)}`), clock: key => key, ctx, store: { has: () => true } }
  let navigation = params === undefined ? undefined : { params, revision: 1 }
  const tab = () => ({ contentId, visible: true, navigation, actions: { openResource: (address, options) => { opened.push({ address, options, fromTab: true }) }, close: () => { closed.push(contentId) } } })
  const element = () => react.React.createElement(client.get('ReviewPanelTab'), {
    app, sessionId: SESSION, useTabInfo: () => ({ tab: tab() }), useSessionStatus: select => select(statuses), inputActions,
  })
  react.mount(element())
  t.after(() => react.unmount())
  await react.settle()
  const view = {
    react, host, opened, closed, menus, menuOpens, prompts, client,
    all: predicate => react.all(predicate),
    text: () => react.all(node => node.props?.className === 'dwb-rp').map(textOf).join(''),
    button(label) {
      return react.one(node => (node.type === 'button' || node.type === 'ui.Button') && textOf(node) === label, `「${label}」按钮`)
    },
    buttons: label => react.all(node => (node.type === 'button' || node.type === 'ui.Button') && textOf(node) === label),
    byLabel: label => react.one(node => node.props?.['aria-label'] === label, `「${label}」`),
    async click(node, init) { react.fire(node, 'onClick', init); await react.settle() },
    file: path => react.one(node => node.type === 'section' && node.props['data-path'] === path, `文件 ${path}`),
    within: (node, label) => {
      const found = []
      const walk = (n) => { if (typeof n === 'string') return; if ((n.type === 'button' || n.type === 'ui.Button') && textOf(n) === label) found.push(n); n.children.forEach(walk) }
      walk(node)
      if (found.length !== 1) throw new Error(`应当正好有一个「${label}」，找到 ${found.length} 个`)
      return found[0]
    },
    menu: className => react.one(node => node.type === 'ui.Menu' && String(node.props.className ?? '').includes(className), `菜单 ${className}`),
    dialog: () => react.one(node => node.type === 'ui.Modal', '对话框'),
    footer: label => {
      const found = findElements(react.one(node => node.type === 'ui.Modal', '对话框').props.footer, el => elementText(el) === label)
      if (found.length !== 1) throw new Error(`对话框底部应当有一个「${label}」，找到 ${found.length} 个`)
      return found[0]
    },
    async type(node, value) { react.fire(node, 'onChange', { target: { value } }); await react.settle() },
    notices: () => react.all(node => String(node.props?.className ?? '').includes('dwb-rp-notice')).map(textOf),
    async setRunning(value) { statuses.set(SESSION, { running: value }); react.update(element()); await react.settle() },
    async navigate(next) { navigation = { params: next, revision: (navigation?.revision ?? 0) + 1 }; react.update(element()); await react.settle() },
  }
  return view
}

test('未暂存：工具栏写范围、文件数和行数，分支栏写分支、领先几个和推送，文件头有暂存，每一处有暂存这一处和回退这一处', async (t) => {
  const view = await openPanel(t)
  const scope = view.menu('dwb-rp-scope-menu')
  assert.match(elementText(scope.props.anchor), /rp\.scope\.unstaged/)
  assert.match(view.text(), /rp\.files \{"n":2\}/)
  assert.match(view.text(), /\+4/)
  assert.match(view.text(), /−1/)
  assert.match(view.text(), /feat\/login-redirect/)
  assert.equal(view.byLabel('rp.ahead {"n":2}').children.join(''), '↑2')
  view.button('rp.push')
  view.button('rp.stageAll')
  view.button('rp.revertAll')
  view.within(view.file('src/auth/redirect.ts'), 'rp.stage')
  view.within(view.file('src/auth/redirect.ts'), 'rp.stageHunk')
  view.within(view.file('src/auth/redirect.ts'), 'rp.revertHunk')
  assert.match(textOf(view.file('docs/login.md')), /rp\.untracked/)
  // 读差异只带第 8 节的三个参数。
  assert.deepEqual(view.host.gets.find(q => q.scope === 'unstaged'), { sessionId: SESSION, repo: REPO, scope: 'unstaged' })
})

test('暂存这一处：POST 带令牌头和 JSON、范围、版本号、路径和这一处的编号，之后重读状态和差异', async (t) => {
  const view = await openPanel(t)
  const before = view.host.gets.length
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.stageHunk'))
  assert.deepEqual(view.host.posts.at(-1), { action: 'stage', sessionId: SESSION, repo: REPO, scope: 'unstaged', version: 'v1', path: 'src/auth/redirect.ts', hunk: 'h0', token: 'tok-1', type: 'application/json' })
  assert.ok(view.host.gets.slice(before).some(q => Object.keys(q).length === 1), '重读了状态')
  assert.ok(view.host.gets.slice(before).some(q => q.scope === 'unstaged'), '重读了差异')
})

test('令牌过期（403）：重新取令牌后重试一次', async (t) => {
  const view = await openPanel(t)
  view.host.token = 'tok-2'
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.stage'))
  assert.deepEqual(view.host.posts.map(p => [p.action, p.token, p.path]), [['stage', 'tok-1', 'src/auth/redirect.ts'], ['stage', 'tok-2', 'src/auth/redirect.ts']])
  assert.deepEqual(view.notices(), [])
})

test('回退这一处：直接做，出「已回退…这一处」和撤销；撤销带 undoId', async (t) => {
  const view = await openPanel(t)
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.revertHunk'))
  assert.deepEqual(view.host.posts.at(-1).action, 'revert')
  assert.equal(view.host.posts.at(-1).hunk, 'h0')
  assert.match(view.text(), /rp\.reverted\.hunk \{"path":"src\/auth\/redirect\.ts","range":"rp\.lines \{\\"start\\":12,\\"end\\":15\}"\}/)
  await view.click(view.button('rp.undo'))
  assert.deepEqual(view.host.posts.at(-1), { action: 'undo', sessionId: SESSION, repo: REPO, undoId: '00000000-0000-4000-8000-000000000001', token: 'tok-1', type: 'application/json' })
  assert.equal(view.buttons('rp.undo').length, 0)
})

test('撤销时文件又改过：说明不能撤销', async (t) => {
  const view = await openPanel(t)
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.revertHunk'))
  view.host.reply.undo = { ok: false, code: 'stale' }
  await view.click(view.button('rp.undo'))
  assert.deepEqual(view.notices(), ['rp.err.undoStale'])
})

test('会话进行中：回退不能点、出横幅（原文照旧），暂存照常', async (t) => {
  const view = await openPanel(t, { running: true })
  assert.equal(view.within(view.file('src/auth/redirect.ts'), 'rp.revertHunk').props.disabled, true)
  assert.equal(view.button('rp.revertAll').props.disabled, true)
  assert.notEqual(view.within(view.file('src/auth/redirect.ts'), 'rp.stageHunk').props.disabled, true)
  assert.match(view.text(), /review\.running/)
  // 会话停下：重读一次，回退能点了。
  const before = view.host.gets.length
  await view.setRunning(false)
  assert.ok(view.host.gets.length > before, '一轮结束时刷新')
  assert.notEqual(view.within(view.file('src/auth/redirect.ts'), 'rp.revertHunk').props.disabled, true)
})

test('版本过时：宿主回 stale 时说明已重新读取，并重读差异', async (t) => {
  const view = await openPanel(t)
  view.host.reply.stage = { ok: false, code: 'stale' }
  const before = view.host.gets.filter(q => q.scope === 'unstaged').length
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.stage'))
  assert.deepEqual(view.notices(), ['rp.err.stale'])
  assert.ok(view.host.gets.filter(q => q.scope === 'unstaged').length > before)
})

test('全部回退：先确认，按钮写清几个文件，未跟踪的文件说明移到废纸篓；取消不发请求', async (t) => {
  const view = await openPanel(t)
  await view.click(view.button('rp.revertAll'))
  const dialog = view.dialog()
  assert.equal(dialog.props.title, 'rp.revertAll.title')
  assert.match(textOf(dialog), /rp\.revertAll\.body \{"n":2\}/)
  assert.match(textOf(dialog), /rp\.revertAll\.untracked \{"paths":"docs\/login\.md"\}/)
  view.footer('rp.cancel').props.onClick()
  await view.react.settle()
  assert.equal(view.host.posts.length, 0)
  await view.click(view.button('rp.revertAll'))
  view.footer('rp.revertAll.confirm {"n":2}').props.onClick()
  await view.react.settle()
  const post = view.host.posts.at(-1)
  assert.equal(post.action, 'revert')
  assert.equal(post.path, undefined)
  assert.match(view.text(), /rp\.reverted\.all \{"n":2\}/)
})

test('有冲突：横幅写几个文件有冲突，冲突文件头只有更多操作，整个范围不能暂存', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ conflicts: 1 })]
  host.diffs.unstaged = diffOf('unstaged', [redirectTs(), { path: 'src/routes.ts', status: 'conflict', binary: false, tooLarge: false, added: 0, deleted: 0, hunks: [] }])
  const view = await openPanel(t, { host })
  assert.match(view.text(), /rp\.conflicts \{"n":1\}/)
  const conflicted = view.file('src/routes.ts')
  assert.match(textOf(conflicted), /rp\.conflict/)
  assert.equal(view.all(node => (node.type === 'ui.Button') && textOf(node) === 'rp.stage' && conflicted.contains(node)).length, 0)
  assert.equal(view.button('rp.stageAll').props.disabled, true)
})

test('有冲突时不能取消暂存整个范围，可以取消暂存其他文件', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ conflicts: 1 })]
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  assert.equal(view.button('rp.unstageAll').props.disabled, true)
  assert.equal(view.within(view.file('src/auth/redirect.ts'), 'rp.unstage').props.disabled, false)
})

test('宿主报告会话进行中时回退不可用，仍可暂存', async (t) => {
  const host = reviewHost()
  host.running = true
  const view = await openPanel(t, { host })
  assert.match(view.text(), /review\.running/)
  assert.equal(view.button('rp.revertAll').props.disabled, true)
  assert.equal(view.button('rp.stageAll').props.disabled, false)
  host.running = false
  await view.click(view.byLabel('rp.refresh'))
  assert.equal(view.button('rp.revertAll').props.disabled, false)
})

test('切换范围后忽略较早的迟到刷新', async (t) => {
  const host = reviewHost()
  const fetch = host.fetch
  const status = Promise.withResolvers()
  let holdNext = false
  host.fetch = (url, init) => {
    const u = new URL(url, 'http://dsh.test/')
    if (holdNext && u.pathname.endsWith('git-review') && u.searchParams.size === 1) {
      holdNext = false
      return status.promise.then(() => fetch(url, init))
    }
    return fetch(url, init)
  }
  const view = await openPanel(t, { host })
  holdNext = true
  await view.click(view.byLabel('rp.refresh'))
  await view.navigate({ scope: 'staged' })
  assert.doesNotMatch(view.text(), /login\.md/)
  status.resolve()
  await view.react.settle()
  assert.doesNotMatch(view.text(), /login\.md/)
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.unstage'))
  assert.equal(host.posts.at(-1).version, host.diffs.staged.version)
})

test('写操作结束后刷新时使用此时查看的范围', async (t) => {
  const host = reviewHost()
  const stage = Promise.withResolvers()
  host.reply.stage = () => stage.promise
  const view = await openPanel(t, { host })
  await view.click(view.button('rp.stageAll'))
  await view.navigate({ scope: 'staged' })
  host.diffs.staged = diffOf('staged', [redirectTs()], 'v2')
  stage.resolve({ ok: true })
  await view.react.settle()
  assert.doesNotMatch(view.text(), /login\.md/)
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.unstage'))
  assert.equal(host.posts.at(-1).version, 'v2')
})

test('切换仓库时先撤下旧仓库的文件，等待新仓库的差异', async (t) => {
  const host = reviewHost()
  const second = 'fedcba9876543210'
  const diff = Promise.withResolvers()
  const initial = host.diffs.unstaged
  host.repos.push(repoStatus({ id: second, name: 'second', root: '/work/second' }))
  host.diffs.unstaged = query => query.repo === second ? diff.promise : initial
  const view = await openPanel(t, { host })
  view.menu('dwb-rp-repo-menu').props.onSelect(second)
  await view.react.settle()
  const hadOldFile = /login\.md/.test(view.text())
  diff.resolve(diffOf('unstaged', [{ ...loginMd(), path: 'second.md' }], 'v2'))
  await view.react.settle()
  assert.equal(hadOldFile, false)
  assert.match(view.text(), /second\.md/)
})

test('手动刷新重读基准分支，选仓库时清除上一仓库的对比范围', async (t) => {
  const host = reviewHost()
  const second = 'fedcba9876543210'
  host.repos.push(repoStatus({ id: second, name: 'second', root: '/work/second' }))
  const view = await openPanel(t, { host, params: { scope: 'branch' } })
  host.branches.defaultBase = 'trunk'
  await view.click(view.byLabel('rp.refresh'))
  const refreshedBase = host.gets.filter(q => q.scope === 'branch').at(-1).base

  await view.navigate({ scope: 'branch', base: 'trunk' })
  host.branches.defaultBase = 'develop'
  view.menu('dwb-rp-repo-menu').props.onSelect(second)
  await view.react.settle()
  assert.equal(refreshedBase, 'trunk')
  assert.deepEqual(host.gets.filter(q => q.scope === 'branch').at(-1), {
    sessionId: SESSION, repo: second, scope: 'branch', base: 'develop',
  })
})

test('已暂存：文件头取消暂存，一处取消暂存这一处，分支栏全部取消暂存和提交', async (t) => {
  const view = await openPanel(t, { params: { scope: 'staged' } })
  view.within(view.file('src/auth/redirect.ts'), 'rp.unstage')
  await view.click(view.within(view.file('src/auth/redirect.ts'), 'rp.unstageHunk'))
  assert.deepEqual([view.host.posts.at(-1).action, view.host.posts.at(-1).scope, view.host.posts.at(-1).hunk], ['unstage', 'staged', 'h0'])
  view.button('rp.unstageAll')
  view.button('rp.commit')
})

test('没有推送目标时仅能提交', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ upstream: null, remoteBranchMissing: true, ahead: 0, pushTarget: null })]
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  assert.equal(view.buttons('rp.push').length, 0)
  await view.click(view.button('rp.commit'))
  assert.equal(view.all(node => node.type === 'ui.Checkbox' && node.props.label === 'rp.commit.push').length, 0)
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '本地提交')
  view.footer('rp.commit.submit').props.onClick()
  await view.react.settle()
  assert.equal(host.posts.at(-1).push, false)
})

test('提交：信息必填；勾「提交后推送」按钮变「提交并推送」；没有上游时先写明目标；成功后关框并报提交号', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ upstream: null, remoteBranchMissing: true, ahead: 0,
    pushTarget: { remote: 'publish', branch: 'feat/login-redirect', setUpstream: true } })]
  host.reply.commit = { ok: true, sha: 'f00ba12'.padEnd(40, '0'), pushed: true }
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  assert.match(view.text(), /rp\.noRemoteBranch/)
  await view.click(view.button('rp.commit'))
  assert.equal(view.dialog().props.title, 'rp.commit.title {"n":1}')
  assert.equal(view.footer('rp.commit.submit').props.disabled, true)
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '登录后跳转回原来的页面')
  const push = view.react.one(node => node.type === 'ui.Checkbox', '提交后推送')
  assert.equal(push.props.label, 'rp.commit.push')
  push.props.onChange(true)
  await view.react.settle()
  assert.match(textOf(view.dialog()), /rp\.commit\.setUpstream \{"target":"publish\/feat\/login-redirect"\}/)
  view.footer('rp.commit.submitPush').props.onClick()
  await view.react.settle()
  assert.deepEqual(view.host.posts.at(-1), { action: 'commit', sessionId: SESSION, repo: REPO, message: '登录后跳转回原来的页面', push: true, token: 'tok-1', type: 'application/json' })
  assert.equal(view.all(node => node.type === 'ui.Modal').length, 0)
  assert.deepEqual(view.notices(), ['rp.commit.donePushed {"sha":"f00ba12"}'])
})

test('提交：上游和本地分支不同名时写明实际上游', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ upstream: 'publish/release/login',
    pushTarget: { remote: 'publish', branch: 'release/login', setUpstream: false } })]
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  view.react.one(node => node.type === 'ui.Checkbox', '提交后推送').props.onChange(true)
  await view.react.settle()
  assert.match(textOf(view.dialog()), /rp\.commit\.pushTarget \{"target":"publish\/release\/login"\}/)
})

test('推送成功后不把宿主返回的本地分支写成远程分支', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ upstream: 'publish/release/login',
    pushTarget: { remote: 'publish', branch: 'release/login', setUpstream: false } })]
  host.reply.push = { ok: true, remote: 'publish', branch: 'feat/login-redirect', createdUpstream: false }
  const view = await openPanel(t, { host })
  await view.click(view.button('rp.push'))
  assert.deepEqual(view.notices(), ['rp.pushed {"remote":"publish"}'])
})

test('提交被钩子拒绝：显示钩子输出的最后几行，框不关，提交信息留着', async (t) => {
  const host = reviewHost()
  host.reply.commit = { ok: false, code: 'hook-failed', detail: 'trailing whitespace\nsrc/a.ts:3' }
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '修正')
  view.footer('rp.commit.submit').props.onClick()
  await view.react.settle()
  assert.match(textOf(view.dialog()), /rp\.err\.hookFailed/)
  assert.match(textOf(view.dialog()), /trailing whitespace\nsrc\/a\.ts:3/)
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '修正')
})

test('提交进行中按 Esc 不关框，钩子拒绝后仍可编辑原信息', async (t) => {
  const host = reviewHost()
  const result = Promise.withResolvers()
  host.reply.commit = () => result.promise
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '暂存改动')
  view.footer('rp.commit.submit').props.onClick()
  await view.react.settle()
  view.dialog().props.onClose()
  result.resolve({ ok: false, code: 'hook-failed', detail: 'fixture rejected' })
  await view.react.settle()
  assert.match(textOf(view.dialog()), /fixture rejected/)
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '暂存改动')
})

test('提交成功、推送被拒：报已提交和推送没完成的原因，不强推', async (t) => {
  const host = reviewHost()
  host.reply.commit = { ok: true, sha: 'abcdef1'.padEnd(40, '1'), pushed: false, pushError: 'push-rejected' }
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '修正')
  view.react.one(node => node.type === 'ui.Checkbox', '提交后推送').props.onChange(true)
  await view.react.settle()
  view.footer('rp.commit.submitPush').props.onClick()
  await view.react.settle()
  assert.deepEqual(view.notices(), ['rp.commit.pushFailedAfter {"sha":"abcdef1","reason":"rp.err.pushRejected"}'])
})

test('生成提交信息：单独发请求，生成中能停，完成后填进提交框；失败时说明原因，已有内容不动', async (t) => {
  const host = reviewHost()
  host.reply['generate-message'] = { ok: true, requestId: 'req-1' }
  host.generation.push({ ok: true, status: 'running' }, { ok: true, status: 'done', message: '登录后跳转回原来的页面\n\n- 只接受同源地址' })
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.click(view.button('rp.commit.generate'))
  assert.equal(view.host.posts.at(-1).action, 'generate-message')
  view.button('rp.commit.stopGenerate')
  // 轮询到 done。
  for (let round = 0; round < 10 && view.react.one(node => node.type === 'textarea', '提交信息框').props.value === ''; round++) {
    await new Promise(resolve => setTimeout(resolve, 60))
    await view.react.settle()
  }
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '登录后跳转回原来的页面\n\n- 只接受同源地址')
  assert.ok(view.host.gets.some(q => q.requestId === 'req-1'))
  // 第二次：失败，已有内容不动。
  host.reply['generate-message'] = { ok: false, code: 'no-reviewable-files' }
  await view.click(view.button('rp.commit.generate'))
  assert.match(textOf(view.dialog()), /rp\.commit\.generateFailed \{"reason":"rp\.err\.noReviewableFiles"\}/)
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '登录后跳转回原来的页面\n\n- 只接受同源地址')
})

test('生成中点停止：发 cancel-generate，提交框保持原样', async (t) => {
  const host = reviewHost()
  host.reply['generate-message'] = { ok: true, requestId: 'req-2' }
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '手写的')
  await view.click(view.button('rp.commit.generate'))
  await view.click(view.button('rp.commit.stopGenerate'))
  assert.deepEqual([view.host.posts.at(-1).action, view.host.posts.at(-1).requestId], ['cancel-generate', 'req-2'])
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '手写的')
  view.button('rp.commit.generate')
})

test('生成请求尚在启动时可以停止，收到作业编号后立即取消', async (t) => {
  const host = reviewHost()
  const starting = Promise.withResolvers()
  host.reply['generate-message'] = () => starting.promise
  host.generation.push({ ok: true, status: 'done', message: '不要覆盖草稿' })
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '手写的')
  await view.click(view.button('rp.commit.generate'))
  const [stop] = view.buttons('rp.commit.stopGenerate')
  if (stop) await view.click(stop)
  starting.resolve({ ok: true, requestId: 'req-starting' })
  await view.react.settle()
  assert.ok(stop, '启动中显示停止按钮')
  assert.deepEqual(host.posts.map(({ action, requestId }) => [action, requestId]), [
    ['generate-message', undefined], ['cancel-generate', 'req-starting'],
  ])
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '手写的')
})

test('生成开始响应在关闭提交框之后返回时，仍取消宿主作业', async (t) => {
  const host = reviewHost()
  const starting = Promise.withResolvers()
  host.reply['generate-message'] = () => starting.promise
  host.generation.push({ ok: true, status: 'done', message: '不要覆盖草稿' })
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.click(view.button('rp.commit.generate'))
  view.dialog().props.onClose()
  await view.react.settle()
  starting.resolve({ ok: true, requestId: 'req-closed' })
  await view.react.settle()
  assert.deepEqual(host.posts.map(({ action, requestId }) => [action, requestId]), [
    ['generate-message', undefined], ['cancel-generate', 'req-closed'],
  ])
  assert.equal(host.gets.some(q => q.requestId === 'req-closed'), false)
})

test('取消生成失败时保留提交信息并报告失败', async (t) => {
  const host = reviewHost()
  host.reply['generate-message'] = { ok: true, requestId: 'req-cancel-failure' }
  host.reply['cancel-generate'] = { ok: false, code: 'network' }
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  await view.click(view.button('rp.commit'))
  await view.type(view.react.one(node => node.type === 'textarea', '提交信息框'), '手写的')
  await view.click(view.button('rp.commit.generate'))
  await view.click(view.button('rp.commit.stopGenerate'))
  assert.match(textOf(view.dialog()), /rp\.commit\.stopFailed \{"reason":"rp\.err\.network"\}/)
  assert.equal(view.react.one(node => node.type === 'textarea', '提交信息框').props.value, '手写的')
})

test('游离的 HEAD：写明短提交号，「在此建分支…」校验名字；建了分支以后才能提交', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ branch: null, detached: true, upstream: null, remoteBranchMissing: false, ahead: 0 })]
  host.reply['create-branch'] = body => (body.name === 'bad..name' ? { ok: false, code: 'invalid-branch-name' } : { ok: true, branch: body.name })
  const view = await openPanel(t, { host, params: { scope: 'staged' } })
  assert.match(view.text(), /rp\.detached \{"head":"a1b2c3d"\}/)
  assert.match(view.text(), /rp\.detachedNote/)
  assert.equal(view.button('rp.commit').props.disabled, true)
  await view.click(view.button('rp.createBranch'))
  const input = () => view.react.one(node => node.type === 'input' && node.props.className === 'dwb-rp-branch-input', '分支名')
  await view.type(input(), 'bad..name')
  view.footer('rp.branch.create').props.onClick()
  await view.react.settle()
  assert.match(textOf(view.dialog()), /rp\.err\.invalidBranch/)
  await view.type(input(), 'feat/login')
  view.footer('rp.branch.create').props.onClick()
  await view.react.settle()
  assert.deepEqual([view.host.posts.at(-1).action, view.host.posts.at(-1).name], ['create-branch', 'feat/login'])
  assert.deepEqual(view.notices(), ['rp.branch.created {"branch":"feat/login"}'])
})

test('不是 Git 仓库：写明，范围菜单里 Git 范围不能选，轮次能选', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ kind: 'not-git', branch: null, head: null, upstream: null, ahead: 0, counts: { unstaged: 0, staged: 0, uncommitted: 0 } })]
  const turns = new Map([['5', { turn: 5, data: new Map([['deliverables', { changes: { seq: 50 } }]]) }]])
  const view = await openPanel(t, { host, turns })
  assert.match(view.text(), /rp\.notGit/)
  const items = view.menu('dwb-rp-scope-menu').props.items
  assert.deepEqual(items.filter(item => item.type !== 'separator' && item.type !== 'label').map(item => [item.id, item.disabled === true]), [
    ['unstaged', true], ['staged', true], ['uncommitted', true], ['branch', true], ['turn:50', false],
  ])
  assert.equal(view.host.gets.filter(q => q.scope !== undefined).length, 0, '不是 Git 仓库不读 Git 差异')
  view.menu('dwb-rp-scope-menu').props.onSelect('turn:50')
  await view.react.settle()
  assert.ok(view.host.gets.some(q => q.summary === '50'))
})

test('分支：读默认基准，勾「包含未提交的修改」，选一个提交；不在同一条提交链上时照官方原话', async (t) => {
  const view = await openPanel(t, { params: { scope: 'branch' } })
  assert.deepEqual(view.host.gets.filter(q => q.scope === 'branch').at(-1), { sessionId: SESSION, repo: REPO, scope: 'branch', base: 'main' })
  assert.match(view.text(), /rp\.branchInfo \{"base":"main"\}/)
  view.react.one(node => node.type === 'ui.Checkbox' && node.props.label === 'rp.includeUncommitted', '包含未提交的修改').props.onChange(true)
  await view.react.settle()
  assert.equal(view.host.gets.filter(q => q.scope === 'branch').at(-1).includeUncommitted, '1')
  const commits = view.menu('dwb-rp-commits-menu')
  findElements(commits.props.children, el => el.props?.['data-commit'] === view.host.commits.commits[1].sha)[0].props.onSelect({ shiftKey: false })
  await view.react.settle()
  const last = view.host.gets.filter(q => q.scope === 'branch').at(-1)
  assert.deepEqual([last.from, last.to], [view.host.commits.commits[1].sha, view.host.commits.commits[1].sha])
  view.host.diffs.branch = { ok: false, code: 'conflict', detail: '这些提交不在同一条提交链上' }
  const menu = view.menu('dwb-rp-commits-menu')
  findElements(menu.props.children, el => el.props?.['data-commit'] === view.host.commits.commits[0].sha)[0].props.onSelect({ shiftKey: true })
  await view.react.settle()
  assert.match(view.text(), /rp\.err\.notLinear/)
})

test('分支：已审阅按文件勾，工具栏写进度；创建变更请求发官方那句消息', async (t) => {
  const view = await openPanel(t, { params: { scope: 'branch' } })
  const box = view.react.one(node => node.type === 'ui.Checkbox' && node.props['aria-label'] === 'rp.reviewedAria {"name":"src/auth/redirect.ts"}', '已审阅')
  box.props.onChange(true)
  await view.react.settle()
  assert.match(view.text(), /rp\.reviewedProgress \{"viewed":1,"total":1\}/)
  await view.click(view.button('rp.createChangeRequest'))
  assert.deepEqual(view.prompts.map(p => p.text), ['rp.changeRequestPrompt'])
})

test('轮次：读 DSH 的改动摘要和差异，回退这一处走改动审阅的路由；会话进行中不能回退', async (t) => {
  const view = await openPanel(t, { params: { scope: 'turn', seq: 50, turn: 5 } })
  assert.match(elementText(view.menu('dwb-rp-scope-menu').props.anchor), /rp\.scope\.turn \{"turn":5\}/)
  await view.click(view.within(view.file('src/editor/save.ts'), 'rp.revertHunk'))
  assert.deepEqual(view.host.posts.at(-1), { turnAction: 'revert', sessionId: SESSION, seq: 50, fileIndex: 0, hunkIndex: 0 })
  await view.setRunning(true)
  assert.equal(view.within(view.file('src/editor/save.ts'), 'rp.revertFile').props.disabled, true)
})

test('TC-003 轮次：发送等回答期间改了一条、新写了一条，发送成功后这两条都留着', async (t) => {
  const sent = []
  let answer
  const roundKey = `${SESSION}/51`
  const view = await openPanel(t, {
    params: { scope: 'turn', seq: 51, turn: 6 },
    prompt: (content) => { sent.push(content[0].text); return new Promise(resolve => { answer = resolve }) },
    before: (client) => {
      const add = client.get('addRoundComment')
      add(roundKey, { fileIndex: 0, display: 'src/editor/save.ts', line: 41, snippet: 'const token', text: '第一条' })
      add(roundKey, { fileIndex: 0, display: 'src/editor/save.ts', line: 42, snippet: 'await', text: '第二条' })
    },
  })
  const notes = () => view.react.all(node => node.props?.className === 'dwb-rp-cnote-text').map(textOf)
  assert.deepEqual(notes(), ['第一条', '第二条'])
  await view.click(view.button('review.send'))
  assert.equal(sent.length, 1)
  await view.click(view.react.all(node => node.type === 'button' && textOf(node) === 'review.commentEdit')[0])
  await view.type(view.react.one(node => node.type === 'textarea', '评论框'), '第一条改过')
  await view.click(view.button('review.commentSave'))
  await view.click(view.react.one(node => node.props?.className === 'dwb-rp-pick' && textOf(node) === '40', '第 40 行'))
  await view.click(view.react.one(node => node.props?.className === 'dwb-rp-plus', '「+」'))
  await view.type(view.react.one(node => node.type === 'textarea', '评论框'), '新写的')
  await view.click(view.button('review.commentAdd'))
  answer({ ok: true })
  await view.react.settle()
  assert.match(sent[0], /第一条/)
  assert.doesNotMatch(sent[0], /第一条改过|新写的/)
  // 页面上评论在各自那一行下面，按行号排：第 40 行的新评论在第 41 行的前面。
  assert.deepEqual(notes(), ['新写的', '第一条改过'])
  assert.deepEqual(view.client.get('roundComments')(roundKey).map(c => c.text), ['第一条改过', '新写的'])
})

test('Git 范围的评论：点一行出「+」，评论攒在底栏，发出的消息带范围、文件、行号和那一行', async (t) => {
  const view = await openPanel(t)
  await view.click(view.react.one(node => node.props?.className === 'dwb-rp-pick' && textOf(node) === '14' && view.file('src/auth/redirect.ts').contains(node), '第 14 行'))
  await view.click(view.react.one(node => node.props?.className === 'dwb-rp-plus', '「+」'))
  await view.type(view.react.one(node => node.type === 'textarea', '评论框'), '先判断 url 是否存在')
  await view.click(view.button('review.commentAdd'))
  assert.match(view.text(), /review\.footerComments \{"n":1\}/)
  await view.click(view.button('review.send'))
  assert.equal(view.prompts.length, 1)
  assert.match(view.prompts[0].text, /^请按下面的评论修改未暂存的改动：/)
  assert.match(view.prompts[0].text, /src\/auth\/redirect\.ts 第 14 行\n {3}> {3}sessionStorage\.setItem\(TARGET_KEY, url\)\n {3}先判断 url 是否存在/)
  assert.match(view.text(), /review\.footerComments \{"n":0\}/)
})

test('「添加到输入框」插在光标处，末尾带一个换行：输入框里已有一段时，再添加的从新的一行开始', async (t) => {
  const inserted = []
  const view = await openPanel(t, { inputActions: { captureInsertion: () => 'cursor', insertText: (text, span) => { inserted.push({ text, span }); return true } } })
  await view.click(view.react.one(node => node.props?.className === 'dwb-rp-pick' && textOf(node) === '14' && view.file('src/auth/redirect.ts').contains(node), '第 14 行'))
  await view.click(view.react.one(node => node.props?.className === 'dwb-rp-plus', '「+」'))
  await view.type(view.react.one(node => node.type === 'textarea', '评论框'), '先判断 url 是否存在')
  await view.click(view.button('review.commentAdd'))
  await view.click(view.button('review.toDraft'))
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].span, 'cursor')
  assert.match(inserted[0].text, /^请按下面的评论修改未暂存的改动：[\s\S]*先判断 url 是否存在\n$/)
})

async function openLineComment(view, line) {
  await view.click(view.within(view.file('src/auth/redirect.ts'), String(line)))
  await view.click(view.byLabel(`review.commentAria ${JSON.stringify({ line: String(line) })}`))
}

const commentInput = view => view.react.one(node => node.type === 'textarea', '评论框')
const findingCard = (view, id) => view.react.one(node => node.props?.['data-finding'] === id, `发现 ${id}`)

test('审阅回归：评论草稿切换范围和重新加载页面后仍可编辑', async (t) => {
  const storage = createMemoryStorage()
  const view = await openPanel(t, { storage })
  await openLineComment(view, 14)
  await view.type(commentInput(view), '没有添加的评论')
  await view.navigate({ scope: 'staged' })
  assert.equal(view.all(node => node.type === 'textarea').length, 0)
  await view.navigate({ scope: 'unstaged' })
  assert.equal(commentInput(view).props.value, '没有添加的评论')
  await view.click(view.button('review.commentAdd'))
  view.react.unmount()

  const reloaded = await openPanel(t, { storage })
  assert.match(reloaded.text(), /review\.footerComments \{"n":1\}/)
  await reloaded.click(reloaded.button('review.commentEdit'))
  assert.equal(commentInput(reloaded).props.value, '没有添加的评论')
})

test('审阅回归：变更让评论位置失效时仍可查看原文、编辑和删除', async (t) => {
  const host = reviewHost()
  const view = await openPanel(t, { host })
  await openLineComment(view, 14)
  await view.type(commentInput(view), '检查目标键')
  await view.click(view.button('review.commentAdd'))
  const changed = redirectTs()
  changed.hunks[0].lines[3] = addLine(14, '  initializeStore()')
  host.diffs.unstaged = diffOf('unstaged', [changed], 'v2')
  await view.click(view.byLabel('rp.refresh'))
  const note = view.react.one(node => node.props?.['data-testid'] === 'dwb-review-comment', '评论')
  assert.ok(!view.file(changed.path).contains(note))
  assert.match(textOf(note), /src\/auth\/redirect\.ts/)
  assert.match(textOf(note), /sessionStorage\.setItem\(TARGET_KEY, url\)/)
  await view.click(view.within(note, 'review.commentEdit'))
  assert.equal(commentInput(view).props.value, '检查目标键')
  await view.type(commentInput(view), '重新检查目标键')
  await view.click(view.button('review.commentSave'))
  assert.match(view.text(), /重新检查目标键/)
  await view.click(view.button('review.commentDelete'))
  assert.match(view.text(), /review\.footerComments \{"n":0\}/)
})

test('审阅回归：分支评论写明实际基准，默认和同名基准共享草稿', async (t) => {
  const view = await openPanel(t, { params: { scope: 'branch' } })
  await openLineComment(view, 14)
  await view.type(commentInput(view), '检查目标键')
  await view.click(view.button('review.commentAdd'))
  await view.navigate({ scope: 'branch', base: 'main' })
  assert.match(view.text(), /检查目标键/)
  await view.click(view.button('review.send'))
  assert.match(view.prompts[0].text, /相对 main 的改动/)
})

test('审阅回归：发送未完成时切范围，保留原范围的新评论', async (t) => {
  let finish
  const view = await openPanel(t, { prompt: () => new Promise(resolve => { finish = resolve }) })
  await openLineComment(view, 14)
  await view.type(commentInput(view), '先发送')
  await view.click(view.button('review.commentAdd'))
  await view.click(view.button('review.send'))
  await view.click(view.button('review.commentEdit'))
  await view.type(commentInput(view), '编辑后保留')
  await view.click(view.button('review.commentSave'))
  await view.navigate({ scope: 'staged' })
  finish({ ok: true })
  await view.react.settle()
  assert.match(view.text(), /review\.footerComments \{"n":0\}/)
  await view.navigate({ scope: 'unstaged' })
  assert.match(view.text(), /编辑后保留/)
})

test('审阅回归：右键删除行的评论引用被删除的原文和旧行号', async (t) => {
  const view = await openPanel(t)
  const file = view.file('src/auth/redirect.ts')
  const removed = view.react.one(node => node.props?.['data-tone'] === 'del' && file.contains(node), '删除的行')
  const hunk = view.react.one(node => node.props?.['data-hunk'] === 'h0' && file.contains(node), '这一处')
  const dataset = { line: removed.props['data-line'], oldLine: removed.props['data-old-line'] }
  view.react.fire(hunk, 'onContextMenu', { target: { closest: selector => {
    if (selector === '[data-line]' && dataset.line !== undefined) return { dataset }
    if (selector === '[data-old-line]' && dataset.oldLine !== undefined) return { dataset }
    return null
  } } })
  view.menus.get('file').resolve(view.menuOpens.at(-1).target.value).find(item => item.label === 'rp.addComment').run()
  await view.react.settle()
  await view.type(commentInput(view), '保留这一行')
  await view.click(view.button('review.commentAdd'))
  await view.click(view.button('review.send'))
  assert.match(view.prompts[0].text, /src\/auth\/redirect\.ts 旧文件第 13 行\n {3}> {3}sessionStorage\.setItem\('target', url\)/)
})

test('审查发现：挂在对应文件、对应行下面，顶上一栏写条数和等级；换到别的范围时，不在那里的发现写在第二行，「查看」切回报告的范围', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf()]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  assert.match(view.text(), /rp\.review\.titleUncommitted · rp\.review\.count \{"n":2\}/)
  assert.match(view.text(), /rp\.review\.levels \{"high":1,"medium":0,"low":1\}/)
  // 报告审的是未提交：打开时切到未提交。
  assert.equal(view.host.gets.filter(q => q.scope !== undefined).at(-1).scope, 'uncommitted')
  const card = view.react.one(node => node.props?.['data-finding'] === 'f1', '发现 f1')
  assert.ok(view.file('src/auth/redirect.ts').contains(card))
  assert.match(textOf(card), /同源判断失败时没有日志/)
  assert.ok(view.file('docs/login.md').contains(view.react.one(node => node.props?.['data-finding'] === 'f2', '发现 f2')))
  view.byLabel('rp.review.next')
  view.byLabel('rp.review.prev')
  // 已暂存里只有 redirect.ts：login.md 那条写在第二行。
  await view.navigate({ scope: 'staged' })
  assert.match(view.text(), /rp\.review\.outside \{"n":1,"scope":"rp\.scope\.uncommitted"\}/)
  await view.click(view.button('rp.review.show'))
  assert.equal(view.host.gets.filter(q => q.scope !== undefined).at(-1).scope, 'uncommitted')
})

test('忽略一条发现：收成一行，能恢复；修订号跟着宿主走', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf()]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  await view.click(view.within(view.react.one(node => node.props?.['data-finding'] === 'f1', '发现 f1'), 'lr.ignore'))
  assert.deepEqual(view.host.posts.at(-1), { review: 'state', id: REPORT, findingId: 'f1', status: 'ignored', revision: 3 })
  assert.match(view.text(), /rp\.review\.ignored \{"title":"同源判断失败时没有日志"\}/)
  await view.click(view.button('lr.restore'))
  assert.deepEqual(view.host.posts.at(-1), { review: 'state', id: REPORT, findingId: 'f1', status: 'open', revision: 4 })
})

test('C-004 修这一条：先显示可编辑的消息再发；准备让修订号加一，事件流没到也能接着忽略别的发现', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf({ findings: [finding(), finding({ id: 'f3', title: '第二条', line: 13 })] })]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  await view.click(view.within(view.react.one(node => node.props?.['data-finding'] === 'f1', '发现 f1'), 'lr.fix'))
  assert.equal(view.dialog().props.title, 'lr.preview')
  view.footer('lr.send').props.onClick()
  await view.react.settle()
  assert.equal(view.prompts.length, 1)
  assert.equal(view.prompts[0].requestId, '00000000-0000-4000-8000-000000000009')
  await view.click(view.within(view.react.one(node => node.props?.['data-finding'] === 'f3', '发现 f3'), 'lr.ignore'))
  assert.deepEqual(view.host.posts.filter(p => p.review !== undefined).map(p => [p.review, p.revision]), [['prepare', 3], ['prepare', 4], ['state', 5]])
})

test('报告过时：「修这一条」换成「重新审查」，重新审查照原来的范围再发起', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf({ stale: true })]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  const card = view.react.one(node => node.props?.['data-finding'] === 'f1', '发现 f1')
  assert.match(textOf(card), /lr\.stale/)
  await view.click(view.within(card, 'rp.review.again'))
  assert.deepEqual(view.host.posts.at(-1), { review: 'start', sessionId: SESSION, input: 'uncommitted' })
})

test('审阅回归：报告定位到自己的仓库，同名路径的另一个仓库显示「查看」', async (t) => {
  const host = reviewHost()
  const other = 'fedcba9876543210'
  host.repos = [repoStatus({ id: other, name: 'other', root: '/work/other' }), repoStatus()]
  host.reports = [reportOf({ projectRoot: '/work/app' })]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  const lastDiff = () => host.gets.findLast(query => query.scope !== undefined)
  assert.equal(lastDiff().repo, REPO)
  assert.ok(view.file('src/auth/redirect.ts').contains(findingCard(view, 'f1')))
  view.menu('dwb-rp-repo-menu').props.onSelect(other)
  await view.react.settle()
  assert.equal(view.all(node => node.props?.['data-finding'] === 'f1').length, 0)
  await view.click(view.button('rp.review.show'))
  assert.equal(lastDiff().repo, REPO)
})

test('审阅回归：刷新后报告过时，显示重新审查', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf()]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  view.within(findingCard(view, 'f1'), 'lr.fix')
  host.reports[0].stale = true
  const changed = redirectTs()
  changed.hunks[0].lines[3] = addLine(14, '  initializeStore()')
  host.diffs.uncommitted = diffOf('uncommitted', [changed], 'v2')
  await view.click(view.byLabel('rp.refresh'))
  const card = findingCard(view, 'f1')
  view.within(card, 'rp.review.again')
  assert.ok(!view.file(changed.path).contains(card))
  assert.match(textOf(card), /src\/auth\/redirect\.ts/)
})

test('审阅回归：其他仓库的审查菜单保留历史报告，不会在会话仓库误启动审查', async (t) => {
  const host = reviewHost()
  const other = 'fedcba9876543210'
  host.repos = [repoStatus(), repoStatus({ id: other, name: 'other', root: '/work/other' })]
  host.reports = [reportOf({ projectRoot: '/work/app' })]
  const view = await openPanel(t, { host })
  view.menu('dwb-rp-repo-menu').props.onSelect(other)
  await view.react.settle()
  const menu = view.menu('dwb-rp-review-menu')
  assert.equal(menu.props.items.find(item => item.id === 'uncommitted').disabled, true)
  assert.equal(menu.props.items.find(item => item.id === 'branch').disabled, true)
  assert.equal(menu.props.items.find(item => item.id === 'reports').disabled, undefined)
})

test('审阅回归：发送其他仓库的评论时引用那个仓库的文件', async (t) => {
  const host = reviewHost()
  const other = 'fedcba9876543210'
  host.repos = [repoStatus(), repoStatus({ id: other, name: 'other', root: '/work/other' })]
  const view = await openPanel(t, { host })
  view.menu('dwb-rp-repo-menu').props.onSelect(other)
  await view.react.settle()
  await openLineComment(view, 14)
  await view.type(commentInput(view), '检查目标键')
  await view.click(view.button('review.commentAdd'))
  await view.click(view.button('review.send'))
  assert.match(view.prompts[0].text, /\/work\/other\/src\/auth\/redirect\.ts 第 14 行/)
})

test('审阅回归：从行号打开评论框后焦点移动到有名称的输入框', async (t) => {
  const view = await openPanel(t)
  await openLineComment(view, 14)
  const input = commentInput(view)
  assert.ok(view.react.focused === input, '焦点应在评论框里')
  assert.equal(input.props['aria-label'], 'review.commentAt {"line":"14"}')
})

test('审阅回归：审查完成定位第一条，并能跳到折叠文件的发现，跳过忽略项', async (t) => {
  const host = reviewHost()
  const completed = reportOf({ revision: 4, findings: [
    finding(), finding({ id: 'ignored', status: 'ignored', line: 13 }), finding({ id: 'f2', path: 'docs/login.md', line: 1 }),
  ] })
  host.reports = [reportOf({ status: 'running', findings: [] })]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  await view.click(view.byLabel('src/auth/redirect.ts'))
  host.reports[0] = completed
  host.reviewStreams[0].onmessage({ data: JSON.stringify({ reports: [completed] }) })
  await view.react.settle()
  assert.equal(findingCard(view, 'f2').props['aria-current'], 'true')
  await view.click(view.byLabel('rp.review.next'))
  assert.equal(findingCard(view, 'f1').props['aria-current'], 'true')
  assert.ok(view.react.focused === findingCard(view, 'f1'), '焦点应在当前发现卡片上')
  assert.equal(findingCard(view, 'ignored').props['aria-current'], undefined)
  await view.click(view.byLabel('rp.review.prev'))
  assert.equal(findingCard(view, 'f2').props['aria-current'], 'true')
})

test('审阅回归：删除文件的发现挂到旧行；其他范围同一行的不同内容归到「查看」', async (t) => {
  const host = reviewHost()
  const deleted = redirectTs()
  deleted.status = 'deleted'
  deleted.hunks[0] = { id: 'h0', oldStart: 12, oldLines: 2, newStart: 0, newLines: 0, lines: [
    delLine(12, 'first line'), delLine(13, 'deleted check()'),
  ] }
  host.diffs.uncommitted = diffOf('uncommitted', [deleted])
  host.reports = [reportOf({
    files: [{ path: deleted.path, lines: 13, deleted: true }],
    findings: [finding({ line: 13, endLine: 13 })],
  })]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  const hunk = view.react.one(node => node.props?.['data-hunk'] === 'h0', '这一处')
  assert.ok(hunk.contains(findingCard(view, 'f1')))
  await view.navigate({ scope: 'staged' })
  assert.equal(view.all(node => node.props?.['data-finding'] === 'f1').length, 0)
  await view.click(view.button('rp.review.show'))
  assert.ok(view.react.one(node => node.props?.['data-hunk'] === 'h0', '这一处').contains(findingCard(view, 'f1')))
})

test('审阅回归：轮次范围的报告栏可以打开保存的报告', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf()]
  const view = await openPanel(t, { host, params: { reportId: REPORT } })
  await view.navigate({ scope: 'turn', seq: 50, turn: 5 })
  const menu = () => view.react.one(node => node.type === 'ui.Menu' && elementText(node.props.anchor) === 'rp.review.reports', '打开报告菜单')
  menu().props.anchor.props.onClick({ currentTarget: null })
  await view.react.settle()
  assert.equal(menu().props.open, true)
  assert.ok(menu().props.items.some(item => item.id === REPORT))
})

test('审查结果写明没审查的文件和原因；审查菜单能打开独立的审查会话', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf({ skipped: [{ path: '.env', reason: 'sensitive' }, { path: 'logo.png', reason: 'binary' }] })]
  const opened = []
  const view = await openPanel(t, { host, params: { reportId: REPORT }, before: () => {} })
  assert.match(view.text(), /lr\.skipped/)
  assert.match(view.text(), /\.env（lr\.skip\.sensitive）、logo\.png（lr\.skip\.binary）/)
  const menu = view.menu('dwb-rp-review-menu')
  assert.ok(menu.props.items.some(item => item.id === 'session'), '有报告时菜单里有「打开审查会话」')
  view.react.instancesOf(view.client.get('ReviewPanel'))[0].props.app.ctx.uiWorkspace.openSession = (id) => { opened.push(id) }
  menu.props.onSelect('session')
  await view.react.settle()
  assert.deepEqual(opened, [REPORT])
})

test('审查菜单：审查未提交改动直接发起；打开报告列出保存的报告', async (t) => {
  const host = reviewHost()
  host.reports = [reportOf()]
  const view = await openPanel(t)
  const menu = view.menu('dwb-rp-review-menu')
  assert.deepEqual(menu.props.items.filter(item => item.type === undefined).map(item => item.id), ['uncommitted', 'branch', 'reports'])
  menu.props.onSelect('uncommitted')
  await view.react.settle()
  assert.deepEqual(view.host.posts.at(-1), { review: 'start', sessionId: SESSION, input: 'uncommitted' })
  assert.equal(view.host.gets.filter(q => q.scope !== undefined).at(-1).scope, 'uncommitted', '切到审查的范围')
})

test('范围菜单：打开时读分支清单，「分支」后面写对比的基准', async (t) => {
  const view = await openPanel(t)
  findElements(view.menu('dwb-rp-scope-menu').props.anchor, el => el.type === 'button')[0].props.onClick()
  await view.react.settle()
  const branch = view.menu('dwb-rp-scope-menu').props.items.find(item => item.id === 'branch')
  assert.match(elementText(branch.label), /rp\.menu\.compare \{"base":"main"\}/)
})

test('轮次范围：工具栏没有审查按钮（发现只叠在 Git 范围上），写已审阅几个', async (t) => {
  const view = await openPanel(t, { params: { scope: 'turn', seq: 50, turn: 5 } })
  assert.equal(view.all(node => node.type === 'ui.Menu' && String(node.props.className).includes('dwb-rp-review-menu')).length, 0)
  assert.match(view.text(), /rp\.reviewedProgress \{"viewed":0,"total":1\}/)
  view.react.one(node => node.type === 'ui.Checkbox' && node.props['aria-label'] === 'rp.reviewedAria {"name":"src/editor/save.ts"}', '已审阅').props.onChange(true)
  await view.react.settle()
  assert.match(view.text(), /rp\.reviewedProgress \{"viewed":1,"total":1\}/)
})

test('入口：同一个标签里换范围，不开第二个标签', async (t) => {
  const view = await openPanel(t)
  await view.navigate({ scope: 'staged' })
  assert.equal(view.host.gets.filter(q => q.scope !== undefined).at(-1).scope, 'staged')
  assert.deepEqual(view.opened, [])
})

test('入口：官方「第 N 轮改动」的地址转进本会话的审阅标签，带上轮次和文件，原标签关掉', async (t) => {
  const view = await openPanel(t, { contentId: `dsh-resource://changes-review/session/${SESSION}/50/5`, params: { index: 2 } })
  assert.deepEqual(view.opened, [{ address: PANEL, options: { replaceTab: true, params: { scope: 'turn', seq: 50, turn: 5, index: 2 } }, fromTab: true }])
  assert.deepEqual(view.closed, [`dsh-resource://changes-review/session/${SESSION}/50/5`])
})

test('入口：新标签页打开的审阅页转进本会话的审阅标签（未暂存）', async (t) => {
  const view = await openPanel(t, { contentId: 'sidebar://wbreview' })
  assert.deepEqual(view.opened, [{ address: PANEL, options: { replaceTab: true, params: { scope: 'unstaged' } }, fromTab: true }])
})

test('右键一处改动：用 DSH 的「文件」右键目标（打开类的项由 DSH 给），本面板加暂存、回退、评论、复制这一处，每项带图标', async (t) => {
  const view = await openPanel(t)
  const hunk = view.react.one(node => node.props?.['data-hunk'] === 'h0' && view.file('src/auth/redirect.ts').contains(node), '这一处')
  view.react.fire(hunk, 'onContextMenu', { clientX: 10, clientY: 20 })
  await view.react.settle()
  const opened = view.menuOpens.at(-1)
  assert.equal(opened.target.kind, 'file')
  assert.equal(opened.target.value.sessionId, SESSION)
  assert.equal(opened.target.value.path, '/work/app/src/auth/redirect.ts')
  assert.equal(opened.target.value.line, 12)
  const items = view.menus.get('file').resolve(opened.target.value)
  assert.deepEqual(items.map(item => item.label), ['rp.stageHunk', 'rp.revertHunk', 'rp.addComment', 'rp.copyHunk'])
  for (const item of items) assert.equal(typeof item.icon?.key, 'string')
  // 别处的文件右键菜单（没有本面板的标记）不加项。
  assert.deepEqual(view.menus.get('file').resolve({ sessionId: SESSION, path: '/work/app/src/auth/redirect.ts' }), [])
  items[0].run()
  await view.react.settle()
  assert.deepEqual([view.host.posts.at(-1).action, view.host.posts.at(-1).hunk], ['stage', 'h0'])
})

test('右键某一行再「添加评论」：评论落在右键的那一行，「文件」右键目标也带这一行', async (t) => {
  const view = await openPanel(t)
  const file = view.file('src/auth/redirect.ts')
  view.react.one(node => node.props?.['data-line'] === 14 && file.contains(node), '第 14 行')
  const hunk = view.react.one(node => node.props?.['data-hunk'] === 'h0' && file.contains(node), '这一处')
  // 浏览器里右键事件的 target 在 data-line="14" 的那一行里面。
  const row = { dataset: { line: '14' } }
  view.react.fire(hunk, 'onContextMenu', { clientX: 10, clientY: 20, target: { closest: selector => (selector === '[data-line]' ? row : null) } })
  await view.react.settle()
  const opened = view.menuOpens.at(-1)
  assert.equal(opened.target.value.line, 14)
  view.menus.get('file').resolve(opened.target.value).find(item => item.label === 'rp.addComment').run()
  await view.react.settle()
  assert.match(view.text(), /review\.commentAt \{"line":"14"\}/)
})

test('文件头的更多操作：同一个「文件」右键目标，本面板加暂存和回退整个文件', async (t) => {
  const view = await openPanel(t)
  await view.click(view.byLabel('rp.moreActions {"name":"src/auth/redirect.ts"}'))
  const opened = view.menuOpens.at(-1)
  assert.equal(opened.target.kind, 'file')
  assert.equal(opened.target.value.path, '/work/app/src/auth/redirect.ts')
  const items = view.menus.get('file').resolve(opened.target.value)
  assert.deepEqual(items.map(item => item.label), ['rp.stage', 'rp.revertFile'])
  items[1].run()
  await view.react.settle()
  assert.deepEqual([view.host.posts.at(-1).action, view.host.posts.at(-1).path, view.host.posts.at(-1).hunk], ['revert', 'src/auth/redirect.ts', undefined])
})

test('审阅回归：Shift+F10 在焦点行打开该处改动的菜单', async (t) => {
  const view = await openPanel(t)
  const file = view.file('src/auth/redirect.ts')
  const button = view.react.one(node => node.props?.['aria-label'] === 'review.selectLine {"line":"14"}' && file.contains(node), '选中第 14 行')
  const target = {
    getBoundingClientRect: () => ({ left: 42, bottom: 180 }),
    closest: selector => selector === '[data-line]' ? { dataset: { line: '14' } } : null,
  }
  view.react.fire(button, 'onKeyDown', { key: 'F10', shiftKey: true, target })
  const opened = view.menuOpens.at(-1)
  assert.ok(opened, '键盘打开菜单')
  assert.equal(opened.target.value.dwbReview.hunk, 'h0')
  assert.equal(opened.target.value.line, 14)
  assert.deepEqual(opened.point, { x: 42, y: 180 })
  assert.ok(view.menus.get('file').resolve(opened.target.value).some(item => item.label === 'rp.copyHunk'))
})

test('审阅回归：菜单里按 Tab 只关上菜单、焦点回到按钮，不执行聚焦项', async (t) => {
  const view = await openPanel(t)
  const scopeQueries = () => view.host.gets.filter(q => q.scope !== undefined).length
  let focused = 0
  findElements(view.menu('dwb-rp-scope-menu').props.anchor, el => el.type === 'button')[0].props.onClick({ currentTarget: { focus: () => { focused += 1 } } })
  await view.react.settle()
  assert.equal(view.menu('dwb-rp-scope-menu').props.open, true)
  const before = scopeQueries()
  let stopped = false
  view.react.fire(view.menu('dwb-rp-scope-menu'), 'onKeyDown', {
    key: 'Tab',
    target: { closest: selector => (selector === '[role="menu"]' ? {} : null) },
    stopPropagation() { stopped = true },
  })
  await view.react.settle()
  assert.equal(stopped, true, 'Tab 不再交给共用菜单，共用菜单的 Tab 会执行聚焦项')
  assert.equal(view.menu('dwb-rp-scope-menu').props.open, false)
  assert.equal(focused, 1, '焦点回到范围按钮')
  assert.equal(scopeQueries(), before, '没有切换范围')
})

test('审阅回归：长改动的行号只占一个 Tab 停靠点', async (t) => {
  const host = reviewHost()
  const file = loginMd()
  file.added = 3000
  file.hunks[0].newLines = file.added
  file.hunks[0].lines = Array.from({ length: file.added }, (_, i) => addLine(i + 1, `line ${i + 1}`))
  host.diffs.unstaged = diffOf('unstaged', [file])
  const view = await openPanel(t, { host })
  const buttons = view.react.all(node => node.type === 'button' && node.props?.['aria-label']?.startsWith('review.selectLine '))
  assert.equal(buttons.length, 3000)
  const tabbable = buttons.filter(node => node.props.tabIndex !== -1)
  assert.equal(tabbable.length, 1)
  assert.equal(textOf(tabbable[0]), '1')
})

test('审阅回归：左右对比和自动换行用固定名称和按下状态读出开关', async (t) => {
  const view = await openPanel(t)
  for (const label of ['rp.toggleSplit', 'rp.toggleWrap']) {
    assert.equal(view.byLabel(label).props['aria-pressed'], false)
    await view.click(view.byLabel(label))
    assert.equal(view.byLabel(label).props['aria-pressed'], true)
  }
})

test('空了：写「没有变更」，并指向还有内容的范围', async (t) => {
  const host = reviewHost()
  host.repos = [repoStatus({ counts: { unstaged: 0, staged: 2, uncommitted: 2 } })]
  host.diffs.unstaged = diffOf('unstaged', [])
  const view = await openPanel(t, { host })
  assert.match(view.text(), /rp\.empty/)
  assert.match(view.text(), /rp\.emptyHint\.staged \{"n":2\}/)
  await view.click(view.button('rp.emptyShow.staged'))
  assert.equal(view.host.gets.filter(q => q.scope !== undefined).at(-1).scope, 'staged')
})

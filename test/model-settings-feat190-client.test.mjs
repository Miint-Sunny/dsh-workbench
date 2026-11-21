/** 模型设置（从 dsh-model-settings 的 test/feat190-client.test.mjs 搬来，feat#217）。 feat#190 的页面行为：打开「模型」就是两栏（左边分类、右边提供商），点一次进详情或填写页。在替身 React 里跑构建好的 lib/client.js，DSH 的接口全是假的。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'
import { PRESETS } from '../src/client/model-settings/catalog.js'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
const getPath = (value, path) => path.reduce((at, key) => (typeof at === 'object' && at !== null ? at[key] : undefined), value)
const schema = {
  rehydrate: value => value,
  nodeAtPath: (_, path) => (path.at(-1) === 'api' ? { type: 'union', list: [{ value: 'openai-completions' }, { value: 'anthropic-messages' }] } : undefined),
  getPath,
}

/** pi-ai 目录里的一行；key 为 true/false 时带派生凭据名的状态，declared 是自定义的。DSH 只注册配置了的路由，所以 active 跟着 configured。 */
function piRow(provider, { configured = false, declared = false, displayName, baseURL, key } = {}) {
  return {
    entry: { provider, displayName: displayName ?? provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], active: configured,
      ...declared ? { declared: true } : {}, ...baseURL === undefined ? {} : { defaultBaseURL: baseURL },
      nativeAuth: { env: [`${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`], oauth: false } },
    configured, removable: configured, credentialChecks: {},
    ...key === undefined ? {} : { derivedCredential: { configured: key, source: 'file', writable: true } },
  }
}
const official = (configured = true) => ({
  entry: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  configured: true, removable: false, apiKeyEnv: 'DEEPSEEK_API_KEY', credential: { configured, source: 'file', writable: true },
})
const accountRow = { entry: { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: '', settingsPath: [], active: true }, configured: false, removable: false, accountAvailable: true }

/** 一份常见的目录：DeepSeek、Gemini（已添加）、Anthropic（已添加）、Kimi 国内（已添加）、MiniMax、OpenCode、表外路由和一个中转站。 */
function directory(extra = []) {
  return [
    official(),
    piRow('google', { configured: true, key: true }), piRow('google-vertex'), piRow('openai'), piRow('openai-codex'),
    piRow('anthropic', { configured: true, key: true }), piRow('moonshotai-cn', { configured: true, key: true }), piRow('moonshotai'), piRow('kimi-coding'),
    piRow('minimax-cn'), piRow('minimax'), piRow('opencode-go'), piRow('opencode'), piRow('xai'), piRow('zai-coding-cn'), piRow('zai'),
    piRow('relay', { configured: true, declared: true, displayName: '中转站', baseURL: 'https://relay.example/v1', key: true }),
    ...extra,
  ]
}
function snapshotOf(rows, { checks = new Map(), catalog = { groups: [] }, writable = true } = {}) {
  return {
    status: 'ready', writable, checks, rows, catalog,
    namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision: 3, schema: {}, value: { providers: {} }, user: { providers: {} }, base: {} }], ['llm-deepseek', { ns: 'llm-deepseek', revision: 1 }]]),
  }
}

/** 假的 DeepSeek 账号：view 照 DSH 的 AccountView；signIn、cancel 记下调用。 */
function fakeAccount(view) {
  const calls = []
  const listeners = new Set()
  let state = { available: true, view, failed: false }
  return {
    calls,
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async signIn() { calls.push(['signIn']) },
    async cancel(id) { calls.push(['cancel', id]) },
    async copyLink(url) { calls.push(['copy', url]); return 'copied' },
    set(next) { state = { ...state, ...next }; for (const listener of listeners) listener() },
  }
}

function openList(t0, snapshot, { app: shared, account, notice } = {}) {
  const client = loadClient(CLIENT)
  const goes = []
  const app = shared ?? { t, schema, memory: {}, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } }, ops: {}, store: { async load() {}, getSnapshot: () => snapshot } }
  if (account !== undefined) app.account = account
  const react = client.react
  react.mount(react.React.createElement(client.get('ListPage'), { app, snapshot, go: next => goes.push(next), notice }))
  t0.after(() => react.unmount())
  return { client, react, app, goes }
}
const categories = react => react.all(node => node.type === 'button' && node.props.className === 'dms-cat')
const category = (react, key) => react.one(node => node.type === 'button' && node.props.className === 'dms-cat' && textOf(node).startsWith(`cat${key}`), `分类 ${key}`)
const pressed = react => categories(react).filter(node => node.props['aria-pressed'] === 'true').map(textOf)
const rows = react => react.all(node => node.type === 'li' && typeof node.props.className === 'string' && node.props.className.split(' ').includes('dms-pv'))
const rowOf = (react, id) => react.one(node => node.type === 'li' && node.props['data-entry'] === id, `条目 ${id}`)
const hit = (react, id) => react.one(node => node.type === 'button' && node.props.className === 'dms-pv-hit' && node.parent.props['data-entry'] === id, `条目 ${id} 的整行按钮`)
const chips = (react, id) => react.all(node => node.type === 'button' && node.props.className === 'dms-chip' && rowOf(react, id).contains(node))
const search = async (react, text) => {
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-provider-search', '搜索框'), 'onChange', { target: { value: text } })
  await react.settle()
}

test('打开就是两栏：标题、搜索框、左边七个分类停在常用，没有单独的「添加模型提供商」按钮', async (t0) => {
  const { react } = openList(t0, snapshotOf(directory()))
  await react.settle()
  assert.equal(textOf(react.one(node => node.type === 'h2', '标题')), 'title')
  react.one(node => node.type === 'input' && node.props.id === 'dms-provider-search', '搜索框')
  assert.deepEqual(categories(react).map(node => textOf(node).replace(/\d+$/, '')), ['catcommon', 'catadded', 'catdomestic', 'catintl', 'cataggregator', 'catcloud', 'catall'])
  assert.deepEqual(pressed(react), ['catcommon'])
  assert.equal(react.all(node => node.type === 'ui.Button' && textOf(node) === 'add').length, 0)
})

test('常用：自定义模型 API 第一，之后照定好的顺序；名字照原来写', async (t0) => {
  const { react } = openList(t0, snapshotOf(directory()), { account: fakeAccount({ status: 'signed-out', attempt: null }) })
  await react.settle()
  assert.deepEqual(rows(react).map(node => node.props['data-entry']), ['custom', 'deepseek-account', 'deepseek-official', 'opencode', 'kimi', 'zhipu', 'minimax', 'ark', 'openai', 'google', 'anthropic', 'xai'])
  const name = id => textOf(react.one(node => node.props.className === 'dms-name' && rowOf(react, id).contains(node), `${id} 的名字`))
  assert.deepEqual(['kimi', 'anthropic', 'opencode', 'deepseek-official'].map(name), ['Kimi', 'Anthropic', 'OpenCode Go', 'DeepSeekAPI 密钥'])
})

test('同一次打开 DSH 里记住上次选的分类；换一个新的页面对象从常用开始', async (t0) => {
  const first = openList(t0, snapshotOf(directory()))
  await first.react.settle()
  first.react.fire(category(first.react, 'intl'), 'onClick')
  await first.react.settle()
  assert.deepEqual(pressed(first.react), ['catintl'])
  first.react.unmount()
  const again = openList(t0, snapshotOf(directory()), { app: first.app })
  await again.react.settle()
  assert.deepEqual(pressed(again.react), ['catintl'])
  const fresh = openList(t0, snapshotOf(directory()))
  await fresh.react.settle()
  assert.deepEqual(pressed(fresh.react), ['catcommon'])
})

test('搜索一输入就搜全部，自定义那一项收起；没找到时用自定义模型 API 添加，带上搜的词', async (t0) => {
  const { react, goes } = openList(t0, snapshotOf(directory()))
  await react.settle()
  await search(react, 'kimi')
  assert.deepEqual(pressed(react), ['catall'])
  assert.deepEqual(rows(react).map(node => node.props['data-entry']), ['kimi'])
  await search(react, 'yunwu')
  assert.deepEqual(rows(react), [])
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'addWithCustom', '「用自定义模型 API 添加」'), 'onClick')
  assert.deepEqual(goes, [{ page: 'custom', name: 'yunwu' }])
})

test('搜索框：方向键选中并回车打开；输入法组合期间不劫持回车和方向键', async (t0) => {
  const { react, goes } = openList(t0, snapshotOf(directory()))
  await react.settle()
  await search(react, 'gem')
  const box = () => react.one(node => node.type === 'input' && node.props.id === 'dms-provider-search', '搜索框')
  react.fire(box(), 'onFocus')
  await react.settle()
  const e1 = react.fire(box(), 'onKeyDown', { key: 'Enter', isComposing: true })
  const e2 = react.fire(box(), 'onKeyDown', { key: 'ArrowDown', nativeEvent: { isComposing: true } })
  const e3 = react.fire(box(), 'onKeyDown', { key: 'Enter', keyCode: 229 })
  await react.settle()
  assert.deepEqual([e1.defaultPrevented, e2.defaultPrevented, e3.defaultPrevented], [false, false, false])
  assert.deepEqual(goes, [])
  const down = react.fire(box(), 'onKeyDown', { key: 'ArrowDown' })
  await react.settle()
  const enter = react.fire(box(), 'onKeyDown', { key: 'Enter' })
  await react.settle()
  assert.deepEqual([down.defaultPrevented, enter.defaultPrevented], [true, true])
  assert.deepEqual(goes, [{ page: 'fill', family: 'vertex', route: 'google-vertex' }])
})

test('已添加的在任何分类里都显示状态：正常时只有圆点，读屏念状态文字；有问题才写字', async (t0) => {
  const fine = openList(t0, snapshotOf(directory()))
  await fine.react.settle()
  const anthropic = rowOf(fine.react, 'anthropic')
  assert.equal(fine.react.all(node => node.props.className === 'dms-state' && anthropic.contains(node)).length, 0)
  assert.equal(fine.react.all(node => node.props.className === 'dms-dot' && node.props['data-tone'] === 'ok' && anthropic.contains(node)).length, 1)
  assert.match(hit(fine.react, 'anthropic').props['aria-label'], /statusKeyConfigured/)
  const checks = new Map([['anthropic', { ok: false, reason: 'auth', status: 401, at: 1 }]])
  const failed = openList(t0, snapshotOf(directory(), { checks }))
  await failed.react.settle()
  const state = failed.react.one(node => node.props.className === 'dms-state' && rowOf(failed.react, 'anthropic').contains(node), 'Anthropic 的状态')
  assert.match(textOf(state), /^statusCheckFailed/)
})

test('几条线路的提供商：已添加的线路有问题时，在按钮下面写明是哪一条、什么问题', async (t0) => {
  const rows = directory().map(row => (row.entry.provider === 'moonshotai-cn' ? piRow('moonshotai-cn', { configured: true, key: false }) : row))
  const { react } = openList(t0, snapshotOf(rows))
  await react.settle()
  const state = react.one(node => node.props.className === 'dms-state' && rowOf(react, 'kimi').contains(node), 'Kimi 的状态')
  assert.equal(textOf(state), 'variantStatus {"label":"国内","status":"statusKeyMissing"}')
  assert.equal(react.all(node => node.props.className === 'dms-state' && rowOf(react, 'google').contains(node)).length, 0)
})

test('几条线路的提供商每条一个按钮：已添加的进那一条的详情，没添加的进填写页并选好那一条；点整行先进已添加的', async (t0) => {
  const { react, goes } = openList(t0, snapshotOf(directory()))
  await react.settle()
  assert.deepEqual(chips(react, 'kimi').map(textOf), ['variantAdded {"label":"国内"}', '国际', 'Kimi Coding'])
  react.fire(chips(react, 'kimi')[0], 'onClick')
  react.fire(chips(react, 'kimi')[2], 'onClick')
  react.fire(hit(react, 'kimi'), 'onClick')
  react.fire(hit(react, 'minimax'), 'onClick')
  assert.deepEqual(goes, [
    { page: 'detail', provider: 'moonshotai-cn' },
    { page: 'fill', family: 'kimi', route: 'kimi-coding' },
    { page: 'detail', provider: 'moonshotai-cn' },
    { page: 'fill', family: 'minimax', route: 'minimax-cn' },
  ])
})

test('常用里的 Gemini 有 API 密钥和 Vertex AI 两个按钮，Vertex AI 打开它自己那一家的填写页', async (t0) => {
  const { react, goes } = openList(t0, snapshotOf(directory()))
  await react.settle()
  assert.deepEqual(chips(react, 'google').map(textOf), ['variantAdded {"label":"API 密钥"}', 'Vertex AI'])
  react.fire(chips(react, 'google')[1], 'onClick')
  assert.deepEqual(goes, [{ page: 'fill', family: 'vertex', route: 'google-vertex' }])
})

test('火山方舟：没添加的打开预先填好的自定义模型 API；API 地址相同的自定义提供商算已添加，打开它的详情', async (t0) => {
  const mine = piRow('my-ark', { configured: true, declared: true, displayName: '火山方舟 Coding Plan', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', key: true })
  const { react, goes } = openList(t0, snapshotOf(directory([mine])))
  await react.settle()
  assert.deepEqual(chips(react, 'ark').map(textOf), ['Agent Plan', 'variantAdded {"label":"Coding Plan"}', 'API'])
  react.fire(chips(react, 'ark')[0], 'onClick')
  react.fire(chips(react, 'ark')[1], 'onClick')
  assert.deepEqual(goes, [{ page: 'custom', preset: 'ark-agent-plan' }, { page: 'detail', provider: 'my-ark' }])
})

test('只读的设置文档：没添加的不能点，已添加的照常进详情', async (t0) => {
  const { react } = openList(t0, snapshotOf(directory(), { writable: false }))
  await react.settle()
  assert.equal(chips(react, 'kimi')[1].props.disabled, true)
  assert.equal(hit(react, 'minimax').props.disabled, true)
  assert.equal(hit(react, 'custom').props.disabled, true)
  assert.equal(hit(react, 'google').props.disabled, false)
})

test('已添加：每条线路一行，照现在的顺序和卡片内容，伴随条目不单列；分类上写行数', async (t0) => {
  const companion = { ...piRow('opencode-go--openai', { configured: true, declared: true }), companionOf: { origin: 'opencode-go', api: 'openai-completions' } }
  const go = piRow('opencode-go', { configured: true, key: true })
  const catalog = { groups: [{ id: 'google', models: [{ id: 'a' }, { id: 'b' }] }], default: { provider: 'google', model: 'a' } }
  const snapshot = snapshotOf([accountRow, ...directory([companion]).map(row => (row.entry.provider === 'opencode-go' ? go : row))], { catalog })
  const { react, goes } = openList(t0, snapshot)
  await react.settle()
  assert.equal(textOf(category(react, 'added')), 'catadded7')
  react.fire(category(react, 'added'), 'onClick')
  await react.settle()
  assert.deepEqual(rows(react).map(node => node.props['data-entry']), ['deepseek-account', 'deepseek-official', 'google', 'anthropic', 'moonshotai-cn', 'opencode-go', 'relay'])
  assert.match(textOf(rowOf(react, 'google')), /metaModels \{"count":2\}/)
  assert.match(textOf(rowOf(react, 'google')), /metaDefault \{"model":"a"\}/)
  assert.match(textOf(rowOf(react, 'relay')), /customTag/)
  react.fire(hit(react, 'relay'), 'onClick')
  assert.deepEqual(goes, [{ page: 'detail', provider: 'relay' }])
})

test('一个可用的提供商都没有时，已添加照现在列表页的条件和原文显示空状态和两个按钮', async (t0) => {
  const { react, goes } = openList(t0, snapshotOf([official(false), piRow('minimax')]))
  await react.settle()
  react.fire(category(react, 'added'), 'onClick')
  await react.settle()
  assert.equal(textOf(react.one(node => node.type === 'h3', '空状态标题')), 'emptyTitle')
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'emptyDeepSeek', '「填写 DeepSeek API 密钥」'), 'onClick')
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'emptyOther', '「添加其他提供商」'), 'onClick')
  await react.settle()
  assert.deepEqual(goes, [{ page: 'detail', provider: 'deepseek-official' }])
  assert.deepEqual(pressed(react), ['catcommon'])
})

test('DeepSeek 账号没登录：那一行写「尚未登录」，右边「登录」直接走官方的浏览器登录', async (t0) => {
  const account = fakeAccount({ status: 'signed-out', attempt: null })
  const { react } = openList(t0, snapshotOf(directory()), { account })
  await react.settle()
  assert.match(textOf(rowOf(react, 'deepseek-account')), /accountSignedOut/)
  assert.equal(react.all(node => node.props.className === 'dms-pv-hit' && node.parent.props['data-entry'] === 'deepseek-account').length, 0)
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'accountSignIn', '「登录」'), 'onClick')
  assert.deepEqual(account.calls, [['signIn']])
})

test('DeepSeek 账号登录中：写「请在浏览器中继续」，能复制登录链接、能取消；失败后「重新登录」', async (t0) => {
  const account = fakeAccount({ status: 'signed-out', attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize?x=1' } })
  const { react } = openList(t0, snapshotOf(directory()), { account })
  await react.settle()
  assert.match(textOf(rowOf(react, 'deepseek-account')), /accountWaiting/)
  react.fire(react.one(node => node.type === 'button' && textOf(node) === 'accountCopyLink', '「复制登录链接」'), 'onClick')
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'cancel', '「取消」'), 'onClick')
  await react.settle()
  assert.deepEqual(account.calls, [['copy', 'https://platform.example/authorize?x=1'], ['cancel', 'a1']])
  assert.match(textOf(rowOf(react, 'deepseek-account')), /accountCopied/)
  account.set({ view: { status: 'signed-out', attempt: { id: 'a1', phase: 'failed', errorCode: 'network' } } })
  await react.settle()
  assert.match(textOf(rowOf(react, 'deepseek-account')), /accountFailed/)
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'accountRetry', '「重新登录」'), 'onClick')
  assert.deepEqual(account.calls.at(-1), ['signIn'])
})

test('DeepSeek 账号登录后写「已登录」，点开是只读的账号页；不能登录又没登录时不列这一行', async (t0) => {
  const signedIn = openList(t0, snapshotOf([accountRow, ...directory()]), { account: fakeAccount({ status: 'credential-stored', attempt: null }) })
  await signedIn.react.settle()
  assert.match(textOf(rowOf(signedIn.react, 'deepseek-account')), /statusSignedIn/)
  signedIn.react.fire(hit(signedIn.react, 'deepseek-account'), 'onClick')
  assert.deepEqual(signedIn.goes, [{ page: 'detail', provider: 'deepseek-account' }])
  const none = openList(t0, snapshotOf(directory()))
  await none.react.settle()
  assert.equal(rows(none.react).some(node => node.props['data-entry'] === 'deepseek-account'), false)
})

test('样式与布局：等待登录一行允许换行且不裁切链接与焦点框；分类按钮使用内缩焦点框', async (t0) => {
  const account = fakeAccount({ status: 'signed-out', attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize?x=1' } })
  const { client, react } = openList(t0, snapshotOf(directory()), { account })
  await react.settle()
  const copyBtn = react.one(node => node.type === 'button' && textOf(node) === 'accountCopyLink', '「复制登录链接」')
  const metaNode = react.one(node => node.type === 'span' && typeof node.props.className === 'string' && node.props.className.split(' ').includes('dms-meta') && node.contains(copyBtn), '等待登录说明')
  assert.ok(metaNode.props.className.split(' ').includes('dms-meta-wrap'))
  const style = client.get('STYLE')
  assert.match(style, /\.dms-pv\s+\.dms-meta-wrap\s*\{[^}]*white-space:\s*normal[^}]*overflow:\s*visible/)
  assert.match(style, /\.dms-cat:focus-visible\s*\{[^}]*outline-offset:\s*-2px/)
})

test('读屏无障碍：多线路按钮带提供商名和状态；整行按钮包含已添加线路正常状态', async (t0) => {
  const { react } = openList(t0, snapshotOf(directory()))
  await react.settle()
  const kimiChips = chips(react, 'kimi')
  assert.match(kimiChips[0].props['aria-label'] ?? '', /Kimi/)
  assert.match(kimiChips[0].props['aria-label'] ?? '', /variantAdded/)
  assert.match(kimiChips[0].props['aria-label'] ?? '', /statusKeyConfigured/)
  assert.match(kimiChips[1].props['aria-label'] ?? '', /Kimi/)
  assert.match(kimiChips[1].props['aria-label'] ?? '', /国际/)
  assert.match(hit(react, 'kimi').props['aria-label'], /statusKeyConfigured/)
})

test('读屏无障碍：DeepSeek 账号操作按钮带提供商名，状态文本稳定包在 role=status 内', async (t0) => {
  const account = fakeAccount({ status: 'signed-out', attempt: null })
  const { react } = openList(t0, snapshotOf(directory()), { account })
  await react.settle()
  const row = () => rowOf(react, 'deepseek-account')
  const signInBtn = react.one(node => node.type === 'ui.Button' && textOf(node) === 'accountSignIn', '「登录」')
  assert.match(signInBtn.props['aria-label'] ?? '', /DeepSeek 账号/)
  assert.match(signInBtn.props['aria-label'] ?? '', /accountSignIn/)
  const statusEl = () => react.one(node => node.props?.role === 'status' && row().contains(node), '账号状态 region')
  assert.equal(statusEl().props['aria-live'], 'polite')
  assert.equal(textOf(statusEl()), 'accountSignedOut')
  account.set({ view: { status: 'signed-out', attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize?x=1' } } })
  await react.settle()
  assert.equal(textOf(statusEl()), 'accountWaiting')
  const copyBtn = react.one(node => node.type === 'button' && textOf(node) === 'accountCopyLink', '「复制登录链接」')
  assert.equal(statusEl().contains(copyBtn), false)
  const cancelBtn = react.one(node => node.type === 'ui.Button' && textOf(node) === 'cancel', '「取消」')
  assert.match(cancelBtn.props['aria-label'] ?? '', /DeepSeek 账号/)
})

test('读屏无障碍：搜索框方向键切换高亮项时通过稳定 live region 播报并支持失焦清空', async (t0) => {
  const { react } = openList(t0, snapshotOf(directory()))
  await react.settle()
  const live = () => react.one(node => node.props?.className === 'dms-sr' && node.props?.role === 'status', '列表读屏播报区')
  assert.equal(live().props['aria-live'], 'polite')
  assert.equal(textOf(live()), '')
  await search(react, 'gem')
  const box = () => react.one(node => node.type === 'input' && node.props.id === 'dms-provider-search', '搜索框')
  react.fire(box(), 'onFocus')
  react.fire(box(), 'onKeyDown', { key: 'ArrowDown' })
  await react.settle()
  assert.match(textOf(live()), /Google Vertex AI/)
  react.fire(box(), 'onBlur')
  await react.settle()
  assert.equal(textOf(live()), '')
})

// ---- 填写页和预设 ----

function openStep(t0, component, props) {
  const client = loadClient(CLIENT)
  const calls = []
  const goes = []
  const app = {
    t, schema, memory: {}, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } },
    ops: {
      async writeSettings(ns, ops) { calls.push(['write', ops[0].path.join('.'), ops[0].value]); return { kind: 'written', view: {} } },
      async storeCredential(ref, value) { calls.push(['store', ref, value]); return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() { calls.push(['load']) }, getSnapshot: () => props.snapshot },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get(component), { app, go: next => goes.push(next), ...props }))
  t0.after(() => react.unmount())
  return { client, react, calls, goes }
}

test('填写页：选好点开的那一条线路，返回写「模型」，回到列表', async (t0) => {
  const snapshot = snapshotOf(directory())
  const client = loadClient(CLIENT)
  const entry = client.get('pickerEntries')(client.get('catalogRows')(snapshot)).find(item => item.family.id === 'kimi')
  const { react, goes } = openStep(t0, 'FillStep', { snapshot, entry, route: 'kimi-coding' })
  await react.settle()
  assert.equal(react.one(node => node.type === 'ui.SegmentedControl', '线路').props.value, 'kimi-coding')
  const crumb = react.one(node => node.type === 'button' && node.props.className === 'dms-crumb', '返回')
  assert.equal(textOf(crumb), 'back')
  react.fire(crumb, 'onClick')
  assert.deepEqual(goes, [{ page: 'list' }])
})

test('火山方舟预设：显示名称、Provider ID、API 地址和模型预先填好，创建时按 OpenAI Chat Completions 写入', async (t0) => {
  const snapshot = snapshotOf(directory())
  const preset = PRESETS.find(item => item.route === 'ark-coding-plan')
  const { client, react, calls, goes } = openStep(t0, 'CustomStep', { snapshot, preset })
  await react.settle()
  const value = id => react.one(node => node.type === 'input' && node.props.id === id, id).props.value
  assert.deepEqual([value('dms-custom-name'), value('dms-custom-route'), value('dms-custom-url')], ['火山方舟 Coding Plan', 'ark-coding-plan', 'https://ark.cn-beijing.volces.com/api/coding/v3'])
  assert.deepEqual(react.instancesOf(client.get('ModelsEditor'))[0].props.rows, [{ id: 'ark-code-latest' }])
  assert.equal(react.one(node => node.type === 'a' && node.props.className === 'dms-link', '获取 API 密钥').props.href, 'https://ark.volcengine.com/region:cn-beijing/apikey')
  react.fire(react.one(node => node.type === 'input' && node.props.className === 'dms-keyinput', '密钥输入'), 'onChange', { target: { value: 'ark-key' } })
  await react.settle()
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'create', '「创建提供商」'), 'onClick')
  await react.settle()
  assert.deepEqual(calls[0], ['write', 'providers.ark-coding-plan', {
    displayName: '火山方舟 Coding Plan', apiKeyEnv: 'ARK_CODING_PLAN_API_KEY', api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', models: [{ id: 'ark-code-latest' }],
  }])
  assert.deepEqual(goes.at(-1), { page: 'detail', provider: 'ark-coding-plan', saved: 'ark-coding-plan' })
})

test('火山方舟 Agent Plan：密钥框下写明要用专属 API 密钥', async (t0) => {
  const snapshot = snapshotOf(directory())
  const preset = PRESETS.find(item => item.route === 'ark-agent-plan')
  const { react } = openStep(t0, 'CustomStep', { snapshot, preset })
  await react.settle()
  assert.ok(react.all(node => node.props?.className === 'dms-hint' && textOf(node).includes('专属 API 密钥')).length === 1)
})

test('火山方舟预设的凭据名已经有别的提供商在读：先选共用还是单独（feat#174），专属密钥的说明和获取链接照样写；选单独时存到新凭据名下', async (t0) => {
  // my-ark 点名了 Agent Plan 预设的凭据名；它的 API 地址是 Coding Plan 的，所以 Agent Plan 不算已添加，还是打开预设。
  const sharer = {
    ...piRow('my-ark', { configured: true, declared: true, baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' }),
    apiKeyEnv: 'ARK_AGENT_PLAN_API_KEY', credential: { configured: true, writable: true, source: 'file', masked: 'ark-••••0001' },
  }
  const snapshot = snapshotOf(directory([sharer]))
  const preset = PRESETS.find(item => item.route === 'ark-agent-plan')
  const { react, calls } = openStep(t0, 'CustomStep', { snapshot, preset })
  await react.settle()
  const radios = () => react.all(node => node.type === 'button' && node.props.role === 'radio')
  assert.equal(radios().length, 2)
  assert.equal(react.all(node => node.props?.className === 'dms-hint' && textOf(node).includes('专属 API 密钥')).length, 1)
  assert.equal(react.one(node => node.type === 'a' && node.props.className === 'dms-link', '获取 API 密钥').props.href, preset.keyUrl)
  react.fire(radios()[1], 'onClick')
  await react.settle()
  react.fire(react.one(node => node.type === 'input' && node.props.className === 'dms-keyinput', '密钥输入'), 'onChange', { target: { value: 'ark-plan-key' } })
  await react.settle()
  react.fire(react.one(node => node.type === 'ui.Button' && textOf(node) === 'create', '「创建提供商」'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.slice(0, 2), [
    ['write', 'providers.ark-agent-plan', {
      displayName: '火山方舟 Agent Plan', apiKeyEnv: 'ARK_AGENT_PLAN_2_API_KEY', api: 'openai-completions', baseURL: preset.baseURL, models: [{ id: 'ark-code-latest' }],
    }],
    ['store', 'ARK_AGENT_PLAN_2_API_KEY', 'ark-plan-key'],
  ])
})

// ---- 路由 ----

test('页面路由：点没添加的线路进填写页，返回时停在刚才的分类', async (t0) => {
  const snapshot = snapshotOf(directory())
  const client = loadClient(CLIENT)
  const listeners = new Set()
  const app = {
    t, schema, memory: {}, ctx: { locale: { getSnapshot: () => ({ active: 'zh', revision: 1 }), subscribe: () => () => {} } }, ops: { async discoverModels() { return { kind: 'refused', message: 'offline' } } },
    store: { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, async load() {} },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get('ModelsPage'), { app }))
  t0.after(() => react.unmount())
  await react.settle()
  react.fire(category(react, 'domestic'), 'onClick')
  await react.settle()
  react.fire(chips(react, 'kimi')[2], 'onClick')
  await react.settle()
  assert.equal(react.one(node => node.type === 'ui.SegmentedControl', '线路').props.value, 'kimi-coding')
  react.fire(react.one(node => node.type === 'button' && node.props.className === 'dms-crumb', '返回'), 'onClick')
  await react.settle()
  assert.deepEqual(pressed(react), ['catdomestic'])
})

test('页面路由：点「其他」分类里的表外目录路由应打开填写页，不报未找到', async (t0) => {
  const snapshot = snapshotOf(directory([piRow('brand-new', { displayName: 'brand-new' })]))
  const client = loadClient(CLIENT)
  const app = {
    t, schema, memory: {}, ctx: { locale: { getSnapshot: () => ({ active: 'zh', revision: 1 }), subscribe: () => () => {} } },
    ops: { async discoverModels() { return { kind: 'refused', message: 'offline' } } },
    store: { getSnapshot: () => snapshot, subscribe: () => () => {}, async load() {} },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get('ModelsPage'), { app }))
  t0.after(() => react.unmount())
  await react.settle()
  react.fire(category(react, 'other'), 'onClick')
  await react.settle()
  react.fire(hit(react, 'brand-new'), 'onClick')
  await react.settle()
  assert.equal(react.all(node => node.props?.className === 'dms-note' && textOf(node) === 'gone').length, 0)
  react.one(node => node.type === 'input' && node.props.id === 'dms-new-key', '填写页密钥输入框')
  react.one(node => node.type === 'ui.Button' && textOf(node) === 'addAction', '填写页添加按钮')
})

test('滚动：切换分类或搜索时列表滚动条回顶部；切页时设置外层滚动回顶部；左侧分类栏在矮窗口内限高独立滚动', async (t0) => {
  const { client, react } = openList(t0, snapshotOf(directory()))
  await react.settle()
  const scroll = react.one(node => node.props.className === 'dms-scroll', '列表滚动区')
  scroll.scrollTop = 320
  react.fire(category(react, 'intl'), 'onClick')
  await react.settle()
  assert.equal(scroll.scrollTop, 0)
  scroll.scrollTop = 240
  await search(react, 'kimi')
  assert.equal(scroll.scrollTop, 0)

  const style = client.get('STYLE')
  assert.match(style, /\.dms-cats\s*\{[^}]*max-height:\s*100%[^}]*overflow-y:\s*auto/)
  assert.match(style, /@container\s*\(max-width:\s*460px\)[\s\S]*\.dms-cats\s*\{[^}]*max-height:\s*none[^}]*overflow-y:\s*hidden/)

  const snapshot = snapshotOf(directory())
  const app = {
    t, schema, memory: {}, ctx: { locale: { getSnapshot: () => ({ active: 'zh', revision: 1 }), subscribe: () => () => {} } },
    ops: { async discoverModels() { return { kind: 'refused', message: 'offline' } } },
    store: { getSnapshot: () => snapshot, subscribe: () => () => {}, async load() {} },
  }
  const pageClient = loadClient(CLIENT)
  const pageReact = pageClient.react
  pageReact.mount(pageReact.React.createElement(pageClient.get('ModelsPage'), { app }))
  t0.after(() => pageReact.unmount())
  await pageReact.settle()
  const rootNode = pageReact.one(node => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.split(' ').includes('dms'), 'ModelsPage 根容器')
  const dialog = { scrollTop: 50, getAttribute: name => (name === 'role' ? 'dialog' : null), parentElement: null }
  const options = { scrollTop: 280, getAttribute: () => null, parentElement: dialog }
  rootNode.parentElement = options
  pageReact.fire(chips(pageReact, 'kimi')[2], 'onClick')
  await pageReact.settle()
  assert.equal(options.scrollTop, 0)
  assert.equal(dialog.scrollTop, 50)
  options.scrollTop = 190
  pageReact.fire(pageReact.one(node => node.type === 'button' && node.props.className === 'dms-crumb', '返回'), 'onClick')
  await pageReact.settle()
  assert.equal(options.scrollTop, 0)
})

// ---- DeepSeek 账号登录（account.js），照官方 dsh-client-ui-settings-account 的 start() ----

/** 假的浏览器环境和官方接口：记下开了哪个标签页、跳去哪里、调了哪些接口。 */
function accountHarness({ desktop, streamBaseUrl, start = { ok: true, value: { status: 'signed-out', attempt: { id: 'a1', phase: 'initializing' } } }, cancel = { ok: true } }) {
  const client = loadClient(CLIENT)
  const calls = []
  const tabs = []
  const env = {
    desktop: () => desktop,
    streamBaseUrl: () => (streamBaseUrl !== undefined ? streamBaseUrl : desktop ? 'http://127.0.0.1:4100/stream' : undefined),
    origin: () => 'http://localhost:5174',
    open: () => {
      const tab = { opener: 'page', closed: false, went: [], location: { replace: url => tab.went.push(url) }, close() { tab.closed = true } }
      tabs.push(tab)
      return tab
    },
    writeText: async text => calls.push(['clipboard', text]),
  }
  const link = client.get('createAccountLink')(env)
  let view = { status: 'signed-out', attempt: null }
  link.bind({
    remote: {
      async startSignIn(metadata, origin, platform) {
        calls.push(['start', metadata, origin, platform])
        if (typeof start === 'function') return start()
        if (start instanceof Error) throw start
        return start
      },
      async cancelSignIn(id) {
        calls.push(['cancel', id])
        if (typeof cancel === 'function') return cancel(id)
        if (cancel instanceof Error) throw cancel
        return cancel
      },
    },
    view: () => view,
    metadata: () => ({ version: 'test', locale: 'zh', timezoneOffsetSeconds: 0 }),
    colorScheme: () => 'dark',
  })
  return { client, link, calls, tabs, setView(next) { view = next; link.changed(next) } }
}

test('账号登录（桌面端）：交给 App 打开浏览器，回调地址用桌面端的流地址，不开标签页', async () => {
  const { link, calls, tabs } = accountHarness({ desktop: true })
  assert.deepEqual(link.getSnapshot(), { available: true, view: { status: 'signed-out', attempt: null }, failed: false })
  await link.signIn()
  assert.deepEqual(calls, [['start', { version: 'test', locale: 'zh', timezoneOffsetSeconds: 0 }, 'http://127.0.0.1:4100', 'desktop']])
  assert.equal(tabs.length, 0)
})

test('账号登录（网页端）：点击时先开空白标签页，拿到授权地址后带上主题跳过去；失败时关掉', async () => {
  const { link, calls, tabs, setView } = accountHarness({ desktop: false })
  await link.signIn()
  assert.deepEqual(calls.map(call => call.slice(2)), [['http://localhost:5174', 'web']])
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].opener, null)
  setView({ status: 'signed-out', attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize?x=1' } })
  assert.deepEqual(tabs[0].went, ['https://platform.example/authorize?x=1&theme=dark'])
  setView({ status: 'signed-out', attempt: { id: 'a1', phase: 'failed', errorCode: 'network' } })
  assert.equal(tabs[0].closed, true)
})

test('账号登录：发起失败时标成失败、关掉标签页；取消调官方的 cancelSignIn；复制的链接带主题', async () => {
  const { link, calls, tabs } = accountHarness({ desktop: false, start: { ok: false, error: { message: 'refused' } } })
  await link.signIn()
  assert.equal(link.getSnapshot().failed, true)
  assert.equal(tabs[0].closed, true)
  await link.cancel('a1')
  assert.equal(await link.copyLink('https://platform.example/authorize'), 'copied')
  assert.deepEqual(calls.slice(1), [['cancel', 'a1'], ['clipboard', 'https://platform.example/authorize?theme=dark']])
  link.unbind()
  assert.deepEqual(link.getSnapshot(), { available: false, view: undefined, failed: false })
})

test('账号登录：发起期间重复调用 signIn 只发一次请求、只开一个标签页；关掉再重开设置期间仍显示发起中且不重复发起', async (t0) => {
  let resolveStart
  const { client, link, calls, tabs } = accountHarness({
    desktop: false,
    start: () => new Promise((resolve) => { resolveStart = resolve }),
  })
  const p1 = link.signIn()
  const p2 = link.signIn()
  assert.equal(calls.length, 1)
  assert.equal(tabs.length, 1)
  const app = { t, schema, memory: {}, ctx: { locale: { getSnapshot: () => ({ active: 'zh' }) } }, ops: {}, store: { async load() {}, getSnapshot: () => snapshotOf(directory()) }, account: link }
  const mountOnce = () => {
    const react = client.react
    react.mount(react.React.createElement(client.get('ListPage'), { app, snapshot: snapshotOf(directory()), go() {} }))
    return react
  }
  const r1 = mountOnce()
  t0.after(() => r1.unmount())
  await r1.settle()
  assert.match(textOf(rowOf(r1, 'deepseek-account')), /accountStarting/)
  const cancelBtn1 = r1.one(node => node.type === 'ui.Button' && textOf(node) === 'cancel', '发起中取消按钮')
  assert.equal(cancelBtn1.props.disabled, true)
  r1.unmount()
  const r2 = mountOnce()
  t0.after(() => r2.unmount())
  await r2.settle()
  assert.match(textOf(rowOf(r2, 'deepseek-account')), /accountStarting/)
  assert.equal(r2.one(node => node.type === 'ui.Button' && textOf(node) === 'cancel', '重开设置取消按钮').props.disabled, true)
  resolveStart({ ok: true, value: { status: 'signed-out', attempt: { id: 'a1', phase: 'initializing' } } })
  await Promise.all([p1, p2])
  await r2.settle()
  assert.deepEqual(link.getSnapshot(), { available: true, view: { status: 'signed-out', attempt: { id: 'a1', phase: 'initializing' } }, failed: false })
})

test('账号登录：服务卸载（unbind）后，已在途的 startSignIn / cancelSignIn 失败或返回不再改写已卸载状态，changed 也不写入', async () => {
  let rejectStart
  const first = accountHarness({
    desktop: false,
    start: () => new Promise((_, reject) => { rejectStart = reject }),
  })
  const pStart = first.link.signIn()
  first.link.unbind()
  assert.equal(first.tabs[0].closed, true)
  rejectStart(new Error('late reject'))
  await pStart
  first.link.changed({ status: 'signed-out', attempt: { id: 'a1', phase: 'waiting-browser' } })
  assert.deepEqual(first.link.getSnapshot(), { available: false, view: undefined, failed: false })

  let rejectCancel
  const second = accountHarness({
    desktop: true,
    cancel: () => new Promise((_, reject) => { rejectCancel = reject }),
  })
  const pCancel = second.link.cancel('a1')
  second.link.unbind()
  rejectCancel(new Error('late cancel reject'))
  await pCancel
  assert.deepEqual(second.link.getSnapshot(), { available: false, view: undefined, failed: false })
})

test('账号登录：unbind 并重新 bind 发起新登录后，旧在途 signIn 落定不关闭新标签页', async () => {
  let rejectFirst
  let nextStart = () => new Promise((_, reject) => { rejectFirst = reject })
  const { link, tabs } = accountHarness({ desktop: false, start: () => nextStart() })
  const p1 = link.signIn()
  assert.equal(tabs.length, 1)
  link.unbind()
  assert.equal(tabs[0].closed, true)
  let resolveSecond
  nextStart = () => new Promise((resolve) => { resolveSecond = resolve })
  link.bind({
    remote: {
      async startSignIn() { return nextStart() },
      async cancelSignIn() { return { ok: true } },
    },
    view: () => ({ status: 'signed-out', attempt: null }),
    metadata: () => ({ version: 'test', locale: 'zh', timezoneOffsetSeconds: 0 }),
    colorScheme: () => 'dark',
  })
  const p2 = link.signIn()
  assert.equal(tabs.length, 2)
  assert.equal(tabs[1].closed, false)
  rejectFirst(new Error('stale reject'))
  await p1
  assert.equal(tabs[1].closed, false)
  resolveSecond({ ok: true, value: { status: 'signed-out', attempt: { id: 'a2', phase: 'initializing' } } })
  await p2
})

test('账号登录：发起或取消失败后，主机推来新尝试、超时、取消或登录后退出时清除旧的 failed，不卡在登录失败', async () => {
  const { link, setView } = accountHarness({ desktop: false, start: { ok: false, error: { message: 'refused' } }, cancel: { ok: false } })
  await link.signIn()
  assert.equal(link.getSnapshot().failed, true)
  setView({ status: 'signed-out', attempt: { id: 'a2', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize' } })
  assert.equal(link.getSnapshot().failed, false)
  await link.cancel('a2')
  assert.equal(link.getSnapshot().failed, true)
  setView({ status: 'signed-out', attempt: { id: 'a2', phase: 'expired' } })
  assert.equal(link.getSnapshot().failed, false)
  const badUrl = accountHarness({ desktop: true, streamBaseUrl: 'not-a-valid-url' })
  await badUrl.link.signIn()
  assert.equal(badUrl.link.getSnapshot().failed, true)
})

test('applyClient：账号服务按需注入，卸载时 unbind 并清理监听，reset 触发刷新', async (t0) => {
  const styles = []
  const doc = {
    head: { appendChild(el) { styles.push(el) } },
    body: {},
    createElement: tag => ({ tag, dataset: {}, remove() {} }),
    querySelector: () => null,
  }
  class FakeMutationObserver { observe() {} disconnect() {} }
  const client = loadClient(CLIENT, {
    document: doc,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    location: { origin: 'http://localhost:5174' },
    navigator: { clipboard: { writeText: async () => {} } },
  })
  const applyClient = client.get('applyModelSettingsClient')
  const effects = []
  const registeredSlots = []
  let injectDeps
  let injectCb
  let refreshCount = 0
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d) },
    locale: {
      register: () => () => {},
      bind: () => key => key,
      getSnapshot: () => ({ active: 'zh', revision: 1 }),
      subscribe: () => () => {},
    },
    settingsSchema: { getPath, hasPath: () => false },
    configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision: 1, schema: {}, value: { providers: {} }, user: {}, base: {} }] } }), subscribe: () => () => {} }) },
    remote: {
      $on: () => () => {},
      credentials: { getStates: async () => ({ ok: true, value: {} }) },
      llm: { listProviders: async () => { refreshCount++; return { ok: true, value: [] } }, listConfigurableProviders: async () => ({ ok: true, value: [] }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    on: () => () => {},
    inject(deps, cb) { injectDeps = deps; injectCb = cb },
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, Comp) => { registeredSlots.push({ meta, Comp }); return () => {} },
    },
  }
  applyClient(ctx)
  assert.equal(registeredSlots.length, 1)
  assert.equal(registeredSlots[0].meta.id, 'models')
  assert.deepEqual(injectDeps, ['remote.account', 'accountUi', 'theme'])
  const react = client.react
  react.mount(react.React.createElement(registeredSlots[0].Comp, null))
  t0.after(() => react.unmount())
  await react.settle()
  assert.equal(refreshCount, 1)
  assert.equal(rows(react).some(node => node.props['data-entry'] === 'deepseek-account'), false)

  const innerListeners = new Set()
  const innerCleanups = []
  const innerCtx = {
    remote: { account: { async startSignIn() { return { ok: true, value: {} } }, async cancelSignIn() { return { ok: true } } } },
    accountUi: { getSnapshot: () => ({ view: { status: 'signed-out', attempt: null }, failed: false }), clientMetadata: locale => ({ locale }) },
    theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
    on(name, fn) {
      if (name === 'account-ui/change') innerListeners.add(fn)
      return () => { innerListeners.delete(fn) }
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') innerCleanups.push(d) },
  }
  injectCb(innerCtx)
  await react.settle()
  assert.equal(innerListeners.size, 1)
  assert.equal(rows(react).some(node => node.props['data-entry'] === 'deepseek-account'), true)
  for (const fn of innerListeners) fn({ view: { status: 'signed-out', attempt: null }, failed: false }, true)
  await react.settle()
  assert.equal(refreshCount, 2)
  for (const cleanup of innerCleanups) cleanup()
  await react.settle()
  assert.equal(rows(react).some(node => node.props['data-entry'] === 'deepseek-account'), false)
  for (const dispose of effects) dispose()
})

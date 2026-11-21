/** 模型设置（从 dsh-model-settings 的 test/credentials-client.test.mjs 搬来，feat#217）。
 * TS-001、feat#174：凭据名被别的提供商用着时，新建和存密钥前让人选共用还是单独存一把，不悄悄覆盖；删除提供商也不删别人在用的凭据。
 * 在替身 React 里跑构建好的 lib/client.js，凭据和设置接口全是假的，不碰真实凭据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
const schema = {
  rehydrate: value => value,
  nodeAtPath: (_, path) => (path.at(-1) === 'api' ? { type: 'union', list: [{ value: 'openai-completions' }] } : undefined),
  getPath: (value, path) => path.reduce((at, key) => at?.[key], value),
}
const profileOf = apiKeyEnv => ({ api: 'openai-completions', baseURL: 'https://relay.example/v1', models: [{ id: 'm1' }], ...apiKeyEnv === undefined ? {} : { apiKeyEnv } })
/** 一行提供商；declared 表示自定义的，apiKeyEnv 写了就带上本地可写的凭据（saved 为 false 时凭据库里还没有这把，masked 给了就是存在文件里的）。 */
function row(provider, { declared = false, apiKeyEnv, env, configured = true, saved = true, masked } = {}) {
  const credential = !saved ? { configured: false, writable: true } : masked === undefined ? { configured: true, writable: true, source: 'local' } : { configured: true, writable: true, source: 'file', masked }
  return {
    entry: { provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], active: true, ...declared ? { declared: true } : {}, ...env === undefined ? {} : { nativeAuth: { env } } },
    configured, removable: configured,
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv, credential },
  }
}
function snapshotOf(rows) {
  const providers = Object.fromEntries(rows.filter(r => r.configured).map(r => [r.entry.provider, profileOf(r.apiKeyEnv)]))
  return {
    status: 'ready', writable: true, checks: new Map(), rows,
    namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision: 7, schema: {}, value: { providers }, user: { providers }, base: {} }]]),
  }
}

function open(t0, component, props) {
  const client = loadClient(CLIENT)
  const calls = []
  const app = {
    t, schema, ctx: {},
    ops: {
      async writeSettings(ns, ops) { calls.push(['write', ops[0].op, ops[0].path.join('.'), ops[0].value]); return { kind: 'written', view: { revision: 8, user: {} } } },
      async storeCredential(ref) { calls.push(['store', ref]); return undefined },
      async removeCredential(ref) { calls.push(['remove', ref]); return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => props.snapshot },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get(component), { app, go() {}, back() {}, ...props }))
  t0.after(() => react.unmount())
  return { client, react, calls }
}
const alerts = react => react.all(node => node.props.role === 'alert').map(textOf)
const button = (react, label) => react.one(node => node.type === 'ui.Button' && textOf(node) === label, `「${label}」按钮`)
const typeKey = async (react, key) => {
  react.fire(react.one(node => node.type === 'input' && node.props.className === 'dms-keyinput', '密钥输入'), 'onChange', { target: { value: key } })
  await react.settle()
}

const radios = react => react.all(node => node.type === 'button' && node.props.role === 'radio')
const choose = async (react, value) => {
  react.fire(react.one(node => node.type === 'button' && node.props.role === 'radio' && radios(react).indexOf(node) === ['share', 'separate', 'both', 'only'].indexOf(value) % 2, value + ' 选项'), 'onClick')
  await react.settle()
}
const notes = react => react.all(node => node.props.className === 'dms-note' && node.type === 'p').map(textOf)
const keyInputs = react => react.all(node => node.type === 'input' && node.props.className === 'dms-keyinput')
/** 自定义模型 API 填好地址和一个模型，只差密钥那一块。 */
async function fillCustom(react, client) {
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-custom-url', 'API 地址'), 'onChange', { target: { value: 'https://foo.example/v1' } })
  react.instancesOf(client.get('ModelsEditor'))[0].props.onChange([{ id: 'foo-chat' }])
  await react.settle()
}

test('feat#174 自定义提供商的 ID 派生出的凭据名别人在用：ID 不报错，先选共用还是单独，没选时不能创建', async (t0) => {
  const snapshot = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const { react, calls, client } = open(t0, 'CustomStep', { snapshot, initialName: 'Foo' })
  await react.settle()
  await fillCustom(react, client)
  assert.deepEqual(alerts(react), [])
  assert.equal(react.all(node => node.props.className === 'dms-hint' && textOf(node).startsWith('keyShareNoticeId ')).length, 1)
  assert.deepEqual(radios(react).map(node => node.props['aria-checked']), ['false', 'false'])
  assert.deepEqual(notes(react), ['keyShareChoose {"provider":"bar"}'])
  assert.equal(button(react, 'create').props.disabled, true)
  assert.deepEqual(calls, [])
})

test('feat#174 自定义提供商选共用：对方存好了密钥，不出密钥框，配置点名同一个凭据名，不存新密钥', async (t0) => {
  const snapshot = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const { react, calls, client } = open(t0, 'CustomStep', { snapshot, initialName: 'Foo' })
  await react.settle()
  await fillCustom(react, client)
  await choose(react, 'share')
  assert.equal(keyInputs(react).length, 0)
  assert.match(textOf(radios(react)[0]), /keyShareSaved \{"provider":"bar","masked":"sk-ab••••9f2c"\}/)
  react.fire(button(react, 'create'), 'onClick')
  await react.settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2], 'providers.foo')
  assert.equal(calls[0][3].apiKeyEnv, 'FOO_API_KEY')
})

test('feat#174 自定义提供商选单独：要填密钥，配置点名新凭据名 FOO_2_API_KEY，密钥存到它下面', async (t0) => {
  const snapshot = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const { react, calls, client } = open(t0, 'CustomStep', { snapshot, initialName: 'Foo' })
  await react.settle()
  await fillCustom(react, client)
  await choose(react, 'separate')
  assert.match(textOf(radios(react)[1]), /keySeparateNote \{"ref":"FOO_2_API_KEY","provider":"bar"\}/)
  assert.equal(button(react, 'create').props.disabled, true)
  await typeKey(react, 'sk-new')
  react.fire(button(react, 'create'), 'onClick')
  await react.settle()
  assert.equal(calls[0][3].apiKeyEnv, 'FOO_2_API_KEY')
  assert.deepEqual(calls[1], ['store', 'FOO_2_API_KEY'])
})

test('feat#174 添加目录里的提供商：别的提供商点名了它的派生凭据名，选之前不出密钥框、不能添加', async (t0) => {
  const snapshot = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const { react, calls } = open(t0, 'FillStep', { snapshot, entry })
  await react.settle()
  assert.equal(keyInputs(react).length, 0)
  assert.deepEqual(notes(react), ['keyShareChoose {"provider":"bar"}'])
  assert.equal(button(react, 'addAction').props.disabled, true)
  assert.deepEqual(calls, [])
})

test('feat#174 添加目录里的提供商选共用：配置点名同一个凭据名，不存新密钥，对方的密钥不动', async (t0) => {
  const snapshot = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const { react, calls } = open(t0, 'FillStep', { snapshot, entry })
  await react.settle()
  await choose(react, 'share')
  react.fire(button(react, 'addAction'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, [['write', 'set', 'providers.foo', { apiKeyEnv: 'FOO_API_KEY' }]])
})

test('feat#174 添加目录里的提供商选单独：配置点名 FOO_2_API_KEY，密钥存到它下面', async (t0) => {
  const snapshot = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const { react, calls } = open(t0, 'FillStep', { snapshot, entry })
  await react.settle()
  await choose(react, 'separate')
  assert.equal(button(react, 'addAction').props.disabled, true)
  await typeKey(react, 'sk-new')
  react.fire(button(react, 'addAction'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, [['write', 'set', 'providers.foo', { apiKeyEnv: 'FOO_2_API_KEY' }], ['store', 'FOO_2_API_KEY']])
})

test('feat#174 选共用而对方还没存密钥：出密钥框，必须填，填的存到共用的凭据名下', async (t0) => {
  const snapshot = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', saved: false })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const { react, calls } = open(t0, 'FillStep', { snapshot, entry })
  await react.settle()
  await choose(react, 'share')
  assert.match(textOf(radios(react)[0]), /keyShareUnsaved \{"provider":"bar"\}/)
  assert.equal(keyInputs(react).length, 1)
  assert.equal(button(react, 'addAction').props.disabled, true)
  await typeKey(react, 'sk-new')
  react.fire(button(react, 'addAction'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, [['write', 'set', 'providers.foo', { apiKeyEnv: 'FOO_API_KEY' }], ['store', 'FOO_API_KEY']])
})

test('feat#174 两个选项用方向键切换，Tab 先落在第一项', async (t0) => {
  const snapshot = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const { react } = open(t0, 'FillStep', { snapshot, entry })
  await react.settle()
  assert.deepEqual(radios(react).map(node => node.props.tabIndex), [0, -1])
  react.fire(radios(react)[0], 'onKeyDown', { key: 'ArrowDown' })
  await react.settle()
  assert.deepEqual(radios(react).map(node => node.props['aria-checked']), ['false', 'true'])
  assert.deepEqual(radios(react).map(node => node.props.tabIndex), [-1, 0])
  react.fire(radios(react)[1], 'onKeyDown', { key: 'ArrowDown' })
  await react.settle()
  assert.deepEqual(radios(react).map(node => node.props['aria-checked']), ['true', 'false'])
})

test('feat#174 详情页换密钥时别的提供商点名了同一个凭据名：先选，两边一起换就存到原来的名字下', async (t0) => {
  const snapshot = snapshotOf([row('foo', { env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  await typeKey(react, 'sk-new')
  assert.deepEqual(alerts(react), [])
  assert.deepEqual(notes(react), ['keyReplaceChoose {"provider":"bar"}'])
  assert.equal(button(react, 'save').props.disabled, true)
  await choose(react, 'both')
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.at(-1), ['store', 'FOO_API_KEY'])
})

test('feat#174 详情页只换这一家：配置改点名 FOO_2_API_KEY，新密钥存到它下面，别人的凭据名不动', async (t0) => {
  const snapshot = snapshotOf([row('foo', { env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  await typeKey(react, 'sk-new')
  await choose(react, 'only')
  assert.match(textOf(radios(react)[1]), /keyReplaceOnlyNote \{"ref":"FOO_2_API_KEY","provider":"bar"\}/)
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  const writes = calls.filter(call => call[0] === 'write')
  assert.equal(writes.length, 1)
  assert.ok(JSON.stringify(writes[0]).includes('FOO_2_API_KEY'))
  assert.deepEqual(calls.at(-1), ['store', 'FOO_2_API_KEY'])
})

test('feat#174 两个提供商显式写了同一个凭据名（显式共用），详情页换密钥也先选，两边一起换照旧存到共用的名字下', async (t0) => {
  const snapshot = snapshotOf([row('foo', { declared: true, apiKeyEnv: 'SHARED_API_KEY' }), row('bar', { declared: true, apiKeyEnv: 'SHARED_API_KEY' })])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  await typeKey(react, 'sk-new')
  assert.equal(button(react, 'save').props.disabled, true)
  await choose(react, 'both')
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, [['store', 'SHARED_API_KEY']])
})

test('feat#174 单独存一把时的新凭据名：原名去掉 _API_KEY 加 _2_API_KEY，有人在读就往上加', async () => {
  const { separateKeyRef } = await import('../src/client/model-settings/status.js')
  assert.equal(separateKeyRef([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })], 'FOO_API_KEY'), 'FOO_2_API_KEY')
  assert.equal(separateKeyRef([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' }), row('baz', { declared: true, apiKeyEnv: 'FOO_2_API_KEY' })], 'FOO_API_KEY'), 'FOO_3_API_KEY')
  assert.equal(separateKeyRef([row('foo-2', {}), row('qux', { env: ['FOO_3_API_KEY'] })], 'FOO_API_KEY'), 'FOO_4_API_KEY')
  assert.equal(separateKeyRef([], 'TOKEN'), 'TOKEN_2_API_KEY')
})

test('feat#174 在用同一个凭据名的写成列表上的名字：几家时写第一家加「等 N 个提供商」，伴随条目算原提供商', async () => {
  const client = loadClient(CLIENT)
  const sharersLabel = client.get('sharersLabel')
  const rows = [row('bar', { declared: true }), row('baz', { declared: true }), { ...row('go--openai', {}), companionOf: { origin: 'bar' } }]
  assert.equal(sharersLabel({ t }, { rows }, ['bar']), 'bar')
  assert.equal(sharersLabel({ t }, { rows }, ['bar', 'go--openai']), 'bar')
  assert.equal(sharersLabel({ t }, { rows }, ['bar', 'baz']), 'keySharers {"provider":"bar","count":2,"more":1}')
})

test('TS-001 删除提供商时，它的凭据还被别的提供商用着，就只删配置、不删凭据', async (t0) => {
  const snapshot = snapshotOf([row('foo', { declared: true, apiKeyEnv: 'FOO_API_KEY' }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  const modal = react.one(node => node.type === 'ui.Modal', '删除确认框')
  assert.match(modal.props.description, /^deleteDescription /)
  modal.props.footer.props.children[1].props.onClick()
  await react.settle()
  assert.deepEqual(calls, [['write', 'unset', 'providers.foo', undefined]])
})

test('TS-001 删除提供商时，没有别人用它的凭据，照旧一起删', async (t0) => {
  const snapshot = snapshotOf([row('foo', { declared: true, apiKeyEnv: 'FOO_API_KEY' }), row('bar', { declared: true, apiKeyEnv: 'BAR_API_KEY' })])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  const modal = react.one(node => node.type === 'ui.Modal', '删除确认框')
  assert.match(modal.props.description, /^deleteDescriptionWithCredential /)
  modal.props.footer.props.children[1].props.onClick()
  await react.settle()
  // 先写配置，成功后才删凭据（写配置失败时凭据留着）。
  assert.deepEqual(calls, [['write', 'unset', 'providers.foo', undefined], ['remove', 'FOO_API_KEY']])
})

test('TS-001 删除 opencode 时 opencode-go 还按环境变量名读同一把密钥，凭据留着', async (t0) => {
  const snapshot = snapshotOf([row('opencode', { apiKeyEnv: 'OPENCODE_API_KEY', env: ['OPENCODE_API_KEY'] }), row('opencode-go', { env: ['OPENCODE_API_KEY'] })])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: snapshot.rows[0], namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  const modal = react.one(node => node.type === 'ui.Modal', '删除确认框')
  assert.match(modal.props.description, /^deleteDescription /)
  modal.props.footer.props.children[1].props.onClick()
  await react.settle()
  assert.deepEqual(calls, [['write', 'unset', 'providers.opencode', undefined]])
})

test('TS-001 credentialUsers 认点名的、目录环境变量名和派生名；credentialNamedBy 只认点名的', async () => {
  const { credentialUsers, credentialNamedBy } = await import('../src/client/model-settings/status.js')
  const rows = [
    row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' }),
    row('opencode-go', { env: ['OPENCODE_API_KEY'] }),
    row('foo', { env: ['FOO_API_KEY'] }),
    row('named', { apiKeyEnv: 'OTHER_KEY', env: ['FOO_API_KEY'] }),
    { entry: { provider: 'deepseek-account', settingsNs: '', settingsPath: [] } },
  ]
  assert.deepEqual(credentialUsers(rows, 'FOO_API_KEY', 'new'), ['bar', 'foo'])
  assert.deepEqual(credentialUsers(rows, 'FOO_API_KEY', 'foo'), ['bar'])
  assert.deepEqual(credentialUsers(rows, 'OPENCODE_API_KEY', 'opencode'), ['opencode-go'])
  assert.deepEqual(credentialUsers(rows, 'DEEPSEEK_ACCOUNT_API_KEY', 'x'), [])
  assert.deepEqual(credentialNamedBy(rows, 'FOO_API_KEY', 'foo'), ['bar'])
  assert.deepEqual(credentialNamedBy(rows, 'OPENCODE_API_KEY', 'opencode'), [])
})

test('feat#174 带提供商名字的句子：中文名字两边不加空格，英文名字和中文之间补一个空格', () => {
  const spaced = loadClient(CLIENT).get('spaced')
  assert.equal(spaced('凭据名 FOO_API_KEY 已被公司网关使用。'), '凭据名 FOO_API_KEY 已被公司网关使用。')
  assert.equal(spaced('凭据名 FOO_API_KEY 已被Google Gemini使用。'), '凭据名 FOO_API_KEY 已被 Google Gemini 使用。')
  assert.equal(spaced('The credential name FOO_API_KEY is already used by bar.'), 'The credential name FOO_API_KEY is already used by bar.')
})

test('feat#174 已经共用的提供商：不输入时写「与 X 共用这把 API 密钥，不能在这里清除」；输入新密钥时只出选项，这句不再挂', async (t0) => {
  const shared = row('foo', { declared: true, apiKeyEnv: 'SHARED_API_KEY', masked: 'sk-ab••••9f2c' })
  const snapshot = snapshotOf([shared, row('bar', { declared: true, apiKeyEnv: 'SHARED_API_KEY', masked: 'sk-ab••••9f2c' })])
  const { react } = open(t0, 'ProviderDetail', { snapshot, row: shared, namespace: snapshot.namespaces.get('llm-pi-ai') })
  await react.settle()
  const hints = () => react.all(node => node.type === 'p' && node.props.className === 'dms-hint').map(textOf)
  assert.ok(hints().includes('keyTakenNoClear {"ref":"SHARED_API_KEY","provider":"bar"}'))
  await typeKey(react, 'sk-new')
  assert.ok(!hints().some(text => text.startsWith('keyTakenNoClear ')))
  assert.ok(hints().includes('keyReplaceNotice {"ref":"SHARED_API_KEY","provider":"bar"}'))
})

test('feat#174 详情页选「只替换这一家」遇写配置冲突重载后，单选项默认都不选，且按新快照重算不撞上刚被占用的凭据名', async (t0) => {
  const client = loadClient(CLIENT)
  const calls = []
  let snap = snapshotOf([row('foo', { env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  let nextWrite = { kind: 'conflict' }
  const app = {
    t, schema, ctx: {},
    ops: {
      async writeSettings(ns, ops) { calls.push(['write', ops]); return nextWrite },
      async storeCredential(ref) { calls.push(['store', ref]); return undefined },
      async removeCredential() { return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: {
      async load() {
        snap = snapshotOf([
          row('foo', { env: ['FOO_API_KEY'] }),
          row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' }),
          row('baz', { declared: true, apiKeyEnv: 'FOO_2_API_KEY' }),
        ])
      },
      setCheck() {},
      getSnapshot: () => snap,
    },
  }
  const react = client.react
  const Detail = client.get('ProviderDetail')
  const render = () => react.React.createElement(Detail, { app, go() {}, back() {}, snapshot: snap, row: snap.rows[0], namespace: snap.namespaces.get('llm-pi-ai') })
  react.mount(render())
  t0.after(() => react.unmount())
  await react.settle()
  await typeKey(react, 'sk-new')
  await choose(react, 'only')
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  react.fire(button(react, 'reload'), 'onClick')
  await react.settle()
  react.update(render())
  await react.settle()
  await typeKey(react, 'sk-after-reload')
  assert.deepEqual(radios(react).map(node => node.props['aria-checked']), ['false', 'false'])
  await choose(react, 'only')
  assert.match(textOf(radios(react)[1]), /keyReplaceOnlyNote \{"ref":"FOO_3_API_KEY","provider":"bar"\}/)
  nextWrite = { kind: 'written', view: { revision: 8, user: { providers: { foo: profileOf('FOO_3_API_KEY') } } } }
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls.at(-1), ['store', 'FOO_3_API_KEY'])
})

test('feat#174 详情页选「只替换这一家」配置写入成功但存密钥失败（快照未重读）：不再切回旧共用单选，重试存到已写入的新凭据名下', async (t0) => {
  const client = loadClient(CLIENT)
  const calls = []
  const snap = snapshotOf([row('foo', { env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  const storeResults = ['keychain locked', undefined]
  const app = {
    t, schema, ctx: {},
    ops: {
      async writeSettings(ns, ops) {
        calls.push(['write', ops])
        return { kind: 'written', view: { revision: 8, user: { providers: { foo: profileOf('FOO_2_API_KEY') } } } }
      },
      async storeCredential(ref) { calls.push(['store', ref]); return storeResults.shift() },
      async removeCredential() { return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snap },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get('ProviderDetail'), { app, go() {}, back() {}, snapshot: snap, row: snap.rows[0], namespace: snap.namespaces.get('llm-pi-ai') }))
  t0.after(() => react.unmount())
  await react.settle()
  await typeKey(react, 'sk-new')
  await choose(react, 'only')
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(alerts(react), ['saveFailed {"message":"keychain locked"}'])
  assert.equal(radios(react).length, 0)
  await typeKey(react, 'sk-retry')
  assert.equal(radios(react).length, 0)
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.equal(calls.filter(call => call[0] === 'write').length, 1)
  assert.deepEqual(calls.filter(call => call[0] === 'store'), [['store', 'FOO_2_API_KEY'], ['store', 'FOO_2_API_KEY']])
})

test('feat#174 DeepSeek（llm-deepseek）详情页替换共用密钥也支持两边一起换或只换这一家，不再拦死', async (t0) => {
  const dsRow = {
    entry: { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
    configured: true, removable: false, apiKeyEnv: 'DEEPSEEK_API_KEY',
    credential: { configured: true, writable: true, source: 'file', masked: 'sk-ds••••1234' },
  }
  const barRow = row('bar', { declared: true, apiKeyEnv: 'DEEPSEEK_API_KEY', masked: 'sk-ds••••1234' })
  const nsDeepseek = { ns: 'llm-deepseek', revision: 3, schema: {}, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, base: {} }
  const snapshot = { status: 'ready', writable: true, checks: new Map(), rows: [dsRow, barRow], namespaces: new Map([['llm-deepseek', nsDeepseek]]) }
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot, row: dsRow, namespace: nsDeepseek })
  await react.settle()
  await typeKey(react, 'sk-ds-new')
  assert.deepEqual(alerts(react), [])
  assert.equal(radios(react).length, 2)
  assert.equal(button(react, 'save').props.disabled, true)
  await choose(react, 'only')
  assert.match(textOf(radios(react)[1]), /keyReplaceOnlyNote \{"ref":"DEEPSEEK_2_API_KEY","provider":"bar"\}/)
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.deepEqual(calls, [['write', 'set', 'apiKeyEnv', 'DEEPSEEK_2_API_KEY'], ['store', 'DEEPSEEK_2_API_KEY']])
})

test('feat#174 未知命名空间（不能写 apiKeyEnv）仍用 keyRefTakenSave 拦下，且中文提供商名两边不加多余空格', async (t0) => {
  const customNsRow = {
    entry: { provider: 'other-gw', settingsNs: 'llm-custom-ro', settingsPath: [], active: true, nativeAuth: { env: ['OTHER_GW_API_KEY'] } },
    configured: true, removable: false,
  }
  const zhSharer = {
    ...row('cn-gw', { declared: true, apiKeyEnv: 'OTHER_GW_API_KEY' }),
    entry: { ...row('cn-gw', { declared: true, apiKeyEnv: 'OTHER_GW_API_KEY' }).entry, displayName: '公司网关' },
  }
  const nsOther = { ns: 'llm-custom-ro', revision: 1, schema: {}, value: {}, user: {}, base: {} }
  const snapshot = { status: 'ready', writable: true, checks: new Map(), rows: [customNsRow, zhSharer], namespaces: new Map([['llm-custom-ro', nsOther]]) }
  const { react } = open(t0, 'ProviderDetail', { snapshot, row: customNsRow, namespace: nsOther })
  await react.settle()
  await typeKey(react, 'sk-x')
  assert.deepEqual(alerts(react), ['keyRefTakenSave {"ref":"OTHER_GW_API_KEY","provider":"公司网关"}'])
  assert.equal(button(react, 'save').props.disabled, true)
  const { MODEL_SETTINGS_ZH: zh } = await import('../src/client/model-settings/copy.js')
  const spaced = loadClient(CLIENT).get('spaced')
  assert.equal(
    spaced(zh.keyRefTakenSave.replaceAll('{ref}', 'OTHER_GW_API_KEY').replaceAll('{provider}', '公司网关')),
    '凭据名 OTHER_GW_API_KEY 已被公司网关使用，在此保存会覆盖其 API 密钥。如需两者使用不同的 API 密钥，请先在 cordis.patch.yml 中为公司网关设置其他凭据名。',
  )
})

test('feat#174 separateKeyRef 支持跳过额外已存在的凭据名，且 FillStep/CustomStep/ProviderDetail 探测凭据库里已有的名字时跳过 FOO_2_API_KEY 改用 FOO_3_API_KEY', async (t0) => {
  const { separateKeyRef } = await import('../src/client/model-settings/status.js')
  assert.equal(separateKeyRef([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })], 'FOO_API_KEY', ['FOO_2_API_KEY']), 'FOO_3_API_KEY')

  const client = loadClient(CLIENT)
  // 1. FillStep：FOO_2_API_KEY 已在凭据库中且无人引用；起初 describeCredentials 挂起，选 separate 时「添加」先禁用，返回后显示 FOO_3_API_KEY 并可提交
  let releaseDescribe
  const pendingGate = new Promise((resolve) => { releaseDescribe = resolve })
  const callsFill = []
  const snapFill = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const appFill = {
    t, schema, ctx: {},
    ops: {
      async describeCredentials(refs) {
        await pendingGate
        return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, ref === 'FOO_2_API_KEY' ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }])) }
      },
      async writeSettings(ns, ops) { callsFill.push(['write', ops[0].value]); return { kind: 'written', view: { revision: 8, user: {} } } },
      async storeCredential(ref) { callsFill.push(['store', ref]); return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snapFill },
  }
  const rFill = client.react
  rFill.mount(rFill.React.createElement(client.get('FillStep'), { app: appFill, snapshot: snapFill, entry, back() {}, go() {} }))
  t0.after(() => rFill.unmount())
  await rFill.settle()
  await choose(rFill, 'separate')
  await typeKey(rFill, 'sk-new')
  assert.equal(button(rFill, 'addAction').props.disabled, true)
  releaseDescribe()
  await rFill.settle()
  assert.match(textOf(rFill.all(node => node.type === 'button' && node.props.role === 'radio')[1]), /keySeparateNote \{"ref":"FOO_3_API_KEY","provider":"bar"\}/)
  assert.equal(button(rFill, 'addAction').props.disabled, false)
  rFill.fire(button(rFill, 'addAction'), 'onClick')
  await rFill.settle()
  assert.deepEqual(callsFill, [['write', { apiKeyEnv: 'FOO_3_API_KEY' }], ['store', 'FOO_3_API_KEY']])

  // 2. CustomStep：describeCredentials 跳过 FOO_2_API_KEY 用 FOO_3_API_KEY
  const callsCustom = []
  const snapCustom = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const appCustom = {
    t, schema, ctx: {},
    ops: {
      async describeCredentials(refs) {
        return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, ref === 'FOO_2_API_KEY' ? { configured: true, source: 'env', writable: true } : { configured: false, writable: true }])) }
      },
      async writeSettings(ns, ops) { callsCustom.push(['write', ops[0].value]); return { kind: 'written', view: { revision: 8, user: {} } } },
      async storeCredential(ref) { callsCustom.push(['store', ref]); return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snapCustom },
  }
  const c2 = loadClient(CLIENT)
  const rCustom = c2.react
  rCustom.mount(rCustom.React.createElement(c2.get('CustomStep'), { app: appCustom, snapshot: snapCustom, initialName: 'Foo', back() {}, go() {} }))
  t0.after(() => rCustom.unmount())
  await rCustom.settle()
  await fillCustom(rCustom, c2)
  await choose(rCustom, 'separate')
  await typeKey(rCustom, 'sk-custom')
  await rCustom.settle()
  assert.match(textOf(radios(rCustom)[1]), /keySeparateNote \{"ref":"FOO_3_API_KEY","provider":"bar"\}/)
  rCustom.fire(button(rCustom, 'create'), 'onClick')
  await rCustom.settle()
  assert.equal(callsCustom[0][1].apiKeyEnv, 'FOO_3_API_KEY')
  assert.deepEqual(callsCustom[1], ['store', 'FOO_3_API_KEY'])

  // 3. ProviderDetail：describeCredentials 跳过 FOO_2_API_KEY 用 FOO_3_API_KEY；如果 describeCredentials 报错则回退到 FOO_2_API_KEY 不卡死
  const callsDetail = []
  const snapDetail = snapshotOf([row('foo', { env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  const appDetail = {
    t, schema, ctx: {},
    ops: {
      async describeCredentials(refs) {
        return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, ref === 'FOO_2_API_KEY' ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }])) }
      },
      async writeSettings(ns, ops) { callsDetail.push(['write', ops]); return { kind: 'written', view: { revision: 8, user: {} } } },
      async storeCredential(ref) { callsDetail.push(['store', ref]); return undefined },
      async removeCredential() { return undefined },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snapDetail },
  }
  const c3 = loadClient(CLIENT)
  const rDetail = c3.react
  rDetail.mount(rDetail.React.createElement(c3.get('ProviderDetail'), { app: appDetail, snapshot: snapDetail, row: snapDetail.rows[0], namespace: snapDetail.namespaces.get('llm-pi-ai'), go() {} }))
  t0.after(() => rDetail.unmount())
  await rDetail.settle()
  await typeKey(rDetail, 'sk-detail')
  await choose(rDetail, 'only')
  await rDetail.settle()
  assert.match(textOf(radios(rDetail)[1]), /keyReplaceOnlyNote \{"ref":"FOO_3_API_KEY","provider":"bar"\}/)
  rDetail.fire(button(rDetail, 'save'), 'onClick')
  await rDetail.settle()
  assert.ok(JSON.stringify(callsDetail[0]).includes('FOO_3_API_KEY'))
  assert.deepEqual(callsDetail[1], ['store', 'FOO_3_API_KEY'])

  const c4 = loadClient(CLIENT)
  const rErr = c4.react
  const appErr = {
    ...appDetail,
    ops: { ...appDetail.ops, async describeCredentials() { return { ok: false, message: 'unavailable' } } },
  }
  rErr.mount(rErr.React.createElement(c4.get('ProviderDetail'), { app: appErr, snapshot: snapDetail, row: snapDetail.rows[0], namespace: snapDetail.namespaces.get('llm-pi-ai'), go() {} }))
  t0.after(() => rErr.unmount())
  await rErr.settle()
  await typeKey(rErr, 'sk-fallback')
  await choose(rErr, 'only')
  await rErr.settle()
  assert.match(textOf(radios(rErr)[1]), /keyReplaceOnlyNote \{"ref":"FOO_2_API_KEY","provider":"bar"\}/)
  assert.equal(button(rErr, 'save').props.disabled, false)
})

test('feat#174 自定义提供商显式点名了目录原生环境变量（GEMINI_API_KEY）且目录提供商已配置时，详情页替换也先选；未配置时不弹', async (t0) => {
  const customGemini = row('my-gemini', { declared: true, apiKeyEnv: 'GEMINI_API_KEY', masked: 'AIza••••1234' })
  const catalogConfigured = row('google', { configured: true, env: ['GEMINI_API_KEY'] })
  const snap1 = snapshotOf([customGemini, catalogConfigured])
  const { react, calls } = open(t0, 'ProviderDetail', { snapshot: snap1, row: customGemini, namespace: snap1.namespaces.get('llm-pi-ai') })
  await react.settle()
  await typeKey(react, 'AIza-new')
  assert.equal(radios(react).length, 2)
  assert.equal(button(react, 'save').props.disabled, true)
  await choose(react, 'only')
  assert.match(textOf(radios(react)[1]), /keyReplaceOnlyNote \{"ref":"GEMINI_2_API_KEY","provider":"Google Gemini"\}/)
  react.fire(button(react, 'save'), 'onClick')
  await react.settle()
  assert.ok(JSON.stringify(calls[0]).includes('GEMINI_2_API_KEY'))
  assert.deepEqual(calls.at(-1), ['store', 'GEMINI_2_API_KEY'])

  const snap2 = snapshotOf([customGemini, row('google', { configured: false, env: ['GEMINI_API_KEY'] })])
  const c2 = open(t0, 'ProviderDetail', { snapshot: snap2, row: customGemini, namespace: snap2.namespaces.get('llm-pi-ai') })
  await c2.react.settle()
  await typeKey(c2.react, 'AIza-direct')
  assert.equal(radios(c2.react).length, 0)
  assert.equal(button(c2.react, 'save').props.disabled, false)
})

test('feat#174 同目录共用环境变量名的其他条目（opencode 与 opencode-go）：替换不弹选项；未配置的一方不拦清除、不留孤儿凭据', async (t0) => {
  const opencode = row('opencode', { configured: true, apiKeyEnv: 'OPENCODE_API_KEY', env: ['OPENCODE_API_KEY'], masked: 'oc-12••••89ab' })
  const snapBoth = snapshotOf([opencode, row('opencode-go', { configured: true, env: ['OPENCODE_API_KEY'] })])
  const both = open(t0, 'ProviderDetail', { snapshot: snapBoth, row: opencode, namespace: snapBoth.namespaces.get('llm-pi-ai') })
  await both.react.settle()
  await typeKey(both.react, 'oc-new')
  assert.equal(radios(both.react).length, 0)
  assert.equal(button(both.react, 'save').props.disabled, false)

  const snapOnlyOne = snapshotOf([opencode, row('opencode-go', { configured: false, env: ['OPENCODE_API_KEY'] })])
  const onlyOne = open(t0, 'ProviderDetail', { snapshot: snapOnlyOne, row: opencode, namespace: snapOnlyOne.namespaces.get('llm-pi-ai') })
  await onlyOne.react.settle()
  const clearBtn = onlyOne.react.one(node => node.type === 'button' && textOf(node) === 'keyClear', '清除按钮')
  assert.ok(clearBtn)
  const modal = onlyOne.react.one(node => node.type === 'ui.Modal', '删除确认框')
  assert.match(modal.props.description, /^deleteDescriptionWithCredential /)
  modal.props.footer.props.children[1].props.onClick()
  await onlyOne.react.settle()
  assert.deepEqual(onlyOne.calls, [['write', 'unset', 'providers.opencode', undefined], ['remove', 'OPENCODE_API_KEY']])
})

test('feat#174 重复点击已经选中的单选项不再触发 onChange 清空刚输入的 API 密钥', async (t0) => {
  const snapshotFill = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const fill = open(t0, 'FillStep', { snapshot: snapshotFill, entry })
  await fill.react.settle()
  await choose(fill.react, 'separate')
  await typeKey(fill.react, 'sk-keep-me')
  await choose(fill.react, 'separate')
  assert.equal(keyInputs(fill.react)[0].props.value, 'sk-keep-me')
  assert.equal(button(fill.react, 'addAction').props.disabled, false)

  const snapCustom = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const custom = open(t0, 'CustomStep', { snapshot: snapCustom, initialName: 'Foo' })
  await custom.react.settle()
  await fillCustom(custom.react, custom.client)
  await choose(custom.react, 'separate')
  await typeKey(custom.react, 'sk-keep-me')
  await choose(custom.react, 'separate')
  assert.equal(keyInputs(custom.react)[0].props.value, 'sk-keep-me')
  assert.equal(button(custom.react, 'create').props.disabled, false)
})

test('feat#174 CustomStep 隐藏密钥框时不被旧的非法草稿吞掉底栏「请选择」提示', async (t0) => {
  const snapshot = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const { react, client } = open(t0, 'CustomStep', { snapshot, initialName: 'Baz' })
  await react.settle()
  await fillCustom(react, client)
  await typeKey(react, 'bad key')
  react.fire(react.one(node => node.type === 'input' && node.props.id === 'dms-custom-route', 'Provider ID'), 'onChange', { target: { value: 'foo' } })
  await react.settle()
  assert.equal(keyInputs(react).length, 0)
  assert.deepEqual(notes(react), ['keyShareChoose {"provider":"bar"}'])
})

test('feat#174 添加页无冲突写配置成功、存密钥失败后，外部快照新增占用该凭据名的提供商时仍能直接重试存密钥而不锁死', async (t0) => {
  // 1. CustomStep
  const client = loadClient(CLIENT)
  const callsCustom = []
  const storeCustom = ['keychain locked', undefined]
  let snapCustom = snapshotOf([row('other', { declared: true, apiKeyEnv: 'OTHER_API_KEY' })])
  const appCustom = {
    t, schema, ctx: {},
    ops: {
      async writeSettings(ns, ops) { callsCustom.push(['write', ops]); return { kind: 'written', view: { revision: 8, user: {} } } },
      async storeCredential(ref) { callsCustom.push(['store', ref]); return storeCustom.shift() },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snapCustom },
  }
  const CustomStep = client.get('CustomStep')
  const renderCustom = () => client.react.React.createElement(CustomStep, { app: appCustom, snapshot: snapCustom, initialName: 'Foo', back() {}, go() {} })
  client.react.mount(renderCustom())
  t0.after(() => client.react.unmount())
  await client.react.settle()
  await fillCustom(client.react, client)
  await typeKey(client.react, 'sk-foo')
  client.react.fire(button(client.react, 'create'), 'onClick')
  await client.react.settle()
  assert.deepEqual(alerts(client.react), ['saveFailed {"message":"keychain locked"}'])
  snapCustom = snapshotOf([row('foo', { declared: true, apiKeyEnv: 'FOO_API_KEY' }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  client.react.update(renderCustom())
  await client.react.settle()
  assert.equal(button(client.react, 'create').props.disabled, false)
  client.react.fire(button(client.react, 'create'), 'onClick')
  await client.react.settle()
  assert.deepEqual(callsCustom.filter(call => call[0] === 'store'), [['store', 'FOO_API_KEY'], ['store', 'FOO_API_KEY']])

  // 2. FillStep
  const c2 = loadClient(CLIENT)
  const callsFill = []
  const storeFill = ['keychain locked', undefined]
  let snapFill = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const appFill = {
    t, schema, ctx: {},
    ops: {
      async writeSettings(ns, ops) { callsFill.push(['write', ops]); return { kind: 'written', view: { revision: 8, user: {} } } },
      async storeCredential(ref) { callsFill.push(['store', ref]); return storeFill.shift() },
      async discoverModels() { return { kind: 'refused', message: 'offline' } },
    },
    store: { async load() {}, setCheck() {}, getSnapshot: () => snapFill },
  }
  const FillStep = c2.get('FillStep')
  const renderFill = () => c2.react.React.createElement(FillStep, { app: appFill, snapshot: snapFill, entry, back() {}, go() {} })
  c2.react.mount(renderFill())
  t0.after(() => c2.react.unmount())
  await c2.react.settle()
  await typeKey(c2.react, 'sk-foo')
  c2.react.fire(button(c2.react, 'addAction'), 'onClick')
  await c2.react.settle()
  snapFill = snapshotOf([row('foo', { configured: true, apiKeyEnv: 'FOO_API_KEY', env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  c2.react.update(renderFill())
  await c2.react.settle()
  assert.equal(button(c2.react, 'addAction').props.disabled, false)
  c2.react.fire(button(c2.react, 'addAction'), 'onClick')
  await c2.react.settle()
  assert.deepEqual(callsFill.filter(call => call[0] === 'store'), [['store', 'FOO_API_KEY'], ['store', 'FOO_API_KEY']])
})

test('feat#174 三处两选一的 radiogroup 都通过 aria-describedby 关联到上方的冲突说明', async (t0) => {
  const assertDescribed = (react, prefix) => {
    const group = react.one(node => node.props.role === 'radiogroup', '单选组')
    const id = group.props['aria-describedby']
    assert.ok(typeof id === 'string' && id.length > 0)
    const notice = react.one(node => node.props.id === id, '冲突说明')
    assert.ok(textOf(notice).startsWith(prefix))
  }

  const snapFill = snapshotOf([row('foo', { configured: false, env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const entry = { family: { id: 'foo', name: 'Foo', color: '#333', initials: 'F' }, variants: [{ route: 'foo', added: false }] }
  const fill = open(t0, 'FillStep', { snapshot: snapFill, entry })
  await fill.react.settle()
  assertDescribed(fill.react, 'keyShareNotice ')

  const snapCustom = snapshotOf([row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY', masked: 'sk-ab••••9f2c' })])
  const custom = open(t0, 'CustomStep', { snapshot: snapCustom, initialName: 'Foo' })
  await custom.react.settle()
  assertDescribed(custom.react, 'keyShareNoticeId ')

  const snapDetail = snapshotOf([row('foo', { env: ['FOO_API_KEY'] }), row('bar', { declared: true, apiKeyEnv: 'FOO_API_KEY' })])
  const detail = open(t0, 'ProviderDetail', { snapshot: snapDetail, row: snapDetail.rows[0], namespace: snapDetail.namespaces.get('llm-pi-ai') })
  await detail.react.settle()
  await typeKey(detail.react, 'sk-new')
  assertDescribed(detail.react, 'keyReplaceNotice ')
})

/** 模型设置（从 dsh-model-settings 的 test/feat190-logic.test.mjs 搬来，feat#217）。 feat#190：列表页和添加页合成一页两栏。这里测分类、常用的顺序、火山方舟的预设和搜索，页面本身在 feat190-client.test.mjs。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, categoriesOf, entriesIn, pickerEntries, presetMatching, routeMeta, searchEntries } from '../src/client/model-settings/catalog.js'

/** DSH 目录里的一行：目录里的路由、两条内置线路和手工声明的路由都用这个样子。 */
const row = (provider, extra = {}) => ({ provider, configured: false, ...extra })

/** 常用涉及的路由都在目录里，另有小米、OpenRouter、一个表外路由和一个自定义的中转站。 */
const DIRECTORY = [
  row('deepseek-account', { configured: true }), row('deepseek-official', { configured: true }),
  row('google', { configured: true }), row('google-vertex'), row('openai', { configured: true }), row('openai-codex'), row('anthropic', { configured: true }),
  row('xiaomi'), row('zai-coding-cn', { configured: true }), row('zai'), row('moonshotai-cn', { configured: true }), row('moonshotai'), row('kimi-coding'),
  row('minimax-cn'), row('minimax'), row('opencode-go'), row('opencode'), row('openrouter'), row('xai'), row('brand-new', { displayName: 'brand-new' }),
  row('relay', { configured: true, declared: true, displayName: '中转站', defaultBaseURL: 'https://relay.example/v1' }),
]

const ids = entries => entries.map(entry => entry.family.id)
const variantsOf = entry => entry.variants.map(variant => [variant.route, variant.added])

test('常用：自定义之后依次是 DeepSeek 账号、DeepSeek、OpenCode Go、Kimi、智谱、MiniMax、火山方舟、OpenAI、Gemini、Anthropic、Grok', () => {
  const common = entriesIn(pickerEntries(DIRECTORY), 'common')
  assert.deepEqual(ids(common), ['deepseek-account', 'deepseek-official', 'opencode', 'kimi', 'zhipu', 'minimax', 'ark', 'openai', 'google', 'anthropic', 'xai'])
  assert.equal(ids(common).includes('xiaomi'), false)
  assert.equal(ids(common).includes('openrouter'), false)
})

test('常用里的 OpenCode 只有 Go 一条，名字写 OpenCode Go；Gemini 是 API 密钥和 Vertex AI 两条', () => {
  const common = entriesIn(pickerEntries(DIRECTORY), 'common')
  const opencode = common.find(entry => entry.family.id === 'opencode')
  assert.deepEqual(variantsOf(opencode), [['opencode-go', false]])
  assert.equal(opencode.name, 'OpenCode Go')
  const gemini = common.find(entry => entry.family.id === 'google')
  assert.deepEqual(variantsOf(gemini), [['google', true], ['google-vertex', false]])
  assert.deepEqual(gemini.variants.map(variant => variant.label), ['API 密钥', 'Vertex AI'])
  assert.equal(gemini.name, 'Google Gemini')
  // Vertex AI 打开的是它自己那一家的填写页。
  assert.equal(gemini.variants[1].familyId, 'vertex')
})

test('提供商的名字照原来写：Kimi、Anthropic 不加公司名', () => {
  assert.equal(routeMeta('moonshotai-cn').name, 'Kimi')
  assert.equal(routeMeta('anthropic').name, 'Anthropic')
  const common = entriesIn(pickerEntries(DIRECTORY), 'common')
  assert.equal(common.find(entry => entry.family.id === 'kimi').name, 'Kimi')
  assert.equal(common.find(entry => entry.family.id === 'anthropic').name, 'Anthropic')
})

test('DeepSeek、OpenAI、Gemini 的 API 密钥线路带「API 密钥」标签，和同一家的账号线路分开', () => {
  assert.equal(routeMeta('deepseek-official').tag, 'API 密钥')
  assert.equal(routeMeta('openai').tag, 'API 密钥')
  assert.equal(routeMeta('google').tag, 'API 密钥')
  assert.equal(routeMeta('deepseek-account').tag, undefined)
})

test('分类：常用、已添加在前，「其他」只在有表外路由时出现，全部在最后', () => {
  assert.deepEqual(categoriesOf(pickerEntries(DIRECTORY)), ['common', 'added', 'domestic', 'intl', 'aggregator', 'cloud', 'other', 'all'])
  assert.deepEqual(categoriesOf(pickerEntries(DIRECTORY.filter(item => item.provider !== 'brand-new'))), ['common', 'added', 'domestic', 'intl', 'aggregator', 'cloud', 'all'])
})

test('两条 DeepSeek 内置线路在国内和全部里排最前；小米、OpenRouter 照旧在国内、聚合平台里', () => {
  const entries = pickerEntries(DIRECTORY)
  assert.deepEqual(ids(entriesIn(entries, 'domestic')).slice(0, 2), ['deepseek-account', 'deepseek-official'])
  assert.deepEqual(ids(entriesIn(entries, 'all')).slice(0, 2), ['deepseek-account', 'deepseek-official'])
  assert.ok(ids(entriesIn(entries, 'domestic')).includes('xiaomi'))
  assert.ok(ids(entriesIn(entries, 'domestic')).includes('ark'))
  assert.ok(ids(entriesIn(entries, 'aggregator')).includes('openrouter'))
  assert.equal(ids(entriesIn(entries, 'intl')).includes('deepseek-official'), false)
})

test('DeepSeek 账号：没登录时目录里没有这一行，能登录就照样列出、标成没添加；不能登录就不列', () => {
  const signedOut = DIRECTORY.filter(item => item.provider !== 'deepseek-account')
  assert.deepEqual(variantsOf(entriesIn(pickerEntries(signedOut, { account: true }), 'common')[0]), [['deepseek-account', false]])
  assert.equal(ids(entriesIn(pickerEntries(signedOut), 'common')).includes('deepseek-account'), false)
})

test('自定义的提供商只在全部里，搜得到；表外的目录路由在「其他」里', () => {
  const entries = pickerEntries(DIRECTORY)
  const relay = entriesIn(entries, 'all').find(entry => entry.family.id === 'relay')
  assert.equal(relay.kind, 'custom')
  assert.deepEqual(variantsOf(relay), [['relay', true]])
  assert.equal(relay.name, '中转站')
  for (const category of ['common', 'domestic', 'intl', 'aggregator', 'cloud', 'other']) assert.equal(ids(entriesIn(entries, category)).includes('relay'), false, category)
  assert.deepEqual(ids(searchEntries(entriesIn(entries, 'all'), '中转')), ['relay'])
  assert.deepEqual(ids(entriesIn(entries, 'other')), ['brand-new'])
})

test('搜索 deepseek 找到两条内置线路和 pi-ai 的 DeepSeek；搜「方舟」「volc」找到火山方舟', () => {
  const entries = entriesIn(pickerEntries([...DIRECTORY, row('deepseek')]), 'all')
  assert.deepEqual(ids(searchEntries(entries, 'deepseek')), ['deepseek-account', 'deepseek-official', 'deepseek-pi'])
  assert.deepEqual(ids(searchEntries(entries, '方舟')), ['ark'])
  assert.deepEqual(ids(searchEntries(entries, 'volc')), ['ark'])
})

test('火山方舟：三种是预先填好地址的自定义提供商，地址照方舟文档（2026-11-19 核对）', () => {
  assert.deepEqual(PRESETS.map(preset => [preset.label, preset.baseURL, preset.route]), [
    ['Agent Plan', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'ark-agent-plan'],
    ['Coding Plan', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'ark-coding-plan'],
    ['API', 'https://ark.cn-beijing.volces.com/api/v3', 'ark'],
  ])
  assert.deepEqual(PRESETS.map(preset => preset.api), ['openai-completions', 'openai-completions', 'openai-completions'])
  assert.deepEqual(PRESETS.map(preset => preset.models), [['ark-code-latest'], ['ark-code-latest'], []])
  assert.equal(PRESETS[0].keyUrl, 'https://ark.volcengine.com/region:cn-beijing/subscription/agent-plan')
  assert.equal(PRESETS[1].keyUrl, 'https://ark.volcengine.com/region:cn-beijing/apikey')
  assert.match(PRESETS[0].keyNote, /专属 API 密钥/)
})

test('火山方舟：自定义提供商的 API 地址和预设一样就算那一种已添加，打开它自己；不再单列成自定义条目', () => {
  const coding = row('my-ark', { configured: true, declared: true, displayName: '火山方舟 Coding Plan', defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3/' })
  const entries = pickerEntries([...DIRECTORY, coding])
  const ark = entriesIn(entries, 'common').find(entry => entry.family.id === 'ark')
  assert.deepEqual(ark.variants.map(variant => [variant.label, variant.added, variant.provider]), [['Agent Plan', false, undefined], ['Coding Plan', true, 'my-ark'], ['API', false, undefined]])
  assert.equal(ids(entriesIn(entries, 'all')).includes('my-ark'), false)
  assert.equal(presetMatching('https://ark.cn-beijing.volces.com/api/plan/v3').label, 'Agent Plan')
  assert.equal(presetMatching('https://ARK.cn-beijing.volces.com/api/v3/').label, 'API')
  assert.equal(presetMatching('https://relay.example/v1'), undefined)
})

test('火山方舟的自定义提供商在已添加里用方舟的图标和获取 API 密钥的链接，名字照它自己的显示名称', () => {
  const meta = routeMeta('my-ark', { displayName: '火山方舟 Coding Plan', defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' })
  assert.deepEqual([meta.name, meta.initials, meta.color, meta.domain, meta.keyUrl], ['火山方舟 Coding Plan', '方', '#1664ff', 'ark.cn-beijing.volces.com', 'https://ark.volcengine.com/region:cn-beijing/apikey'])
})

test('火山方舟地址匹配拒绝带查询参数、片段、用户信息、错协议或错端口的地址；已添加的方舟自定义路由可按自身 ID 和显示名搜到', () => {
  assert.equal(presetMatching('https://ark.cn-beijing.volces.com/api/v3///').label, 'API')
  assert.equal(presetMatching('HTTPS://ARK.cn-beijing.volces.com:443/api/coding/v3/').label, 'Coding Plan')
  for (const url of [
    'http://ark.cn-beijing.volces.com/api/v3',
    'https://ark.cn-beijing.volces.com/API/v3',
    'https://ark.cn-beijing.volces.com/api/v3?proxy=1',
    'https://ark.cn-beijing.volces.com/api/v3#frag',
    'https://u:p!@ark.cn-beijing.volces.com/api/v3',
    'https://ark.cn-beijing.volces.com:8443/api/v3',
  ]) {
    assert.equal(presetMatching(url), undefined, url)
  }
  const coding = row('my-ark', { configured: true, declared: true, displayName: '公司豆包', defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' })
  const all = entriesIn(pickerEntries([...DIRECTORY, coding]), 'all')
  assert.deepEqual(ids(searchEntries(all, 'my-ark')), ['ark'])
  assert.deepEqual(ids(searchEntries(all, '公司豆包')), ['ark'])
})

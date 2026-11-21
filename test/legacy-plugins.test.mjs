/**
 * 旧插件共存保护（feat#217）：独立的「模型设置」「会话标题」插件没卸时，工作台里并进来的三行不加载并写明原因，
 * 旧插件照常工作，工作台其余的行和守卫照常。真跑 lib/bundle-guard.js 的 apply（假的同级行）和三行的 apply；
 * 三行依赖的 DSH 包用 module.registerHooks 换成替身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const field = `const field = () => { const node = {}; for (const name of ['step', 'min', 'max', 'description', 'default']) node[name] = () => node; return node }`
const STUBS = {
  '@deepseek-ai/schemastery': `${field}; export default { number: field, string: field, array: field, object: shape => ({ shape }) }`,
  '@deepseek-ai/dsh-llm': 'export const createUserMessage = message => message; export class BlockAssembler {}',
  '@deepseek-ai/dsh-timeout': 'export const deadline = signal => ({ signal, [Symbol.dispose]() {} })',
  '@deepseek-ai/dsh-session-title': 'export const SessionTitleProviderId = id => id; export const normalizeSessionTitle = text => text.trim()',
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, format: 'module', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const guard = await import('../lib/bundle-guard.js')
const legacy = await import('../lib/legacy-plugins.js')
const modelSettings = await import('../lib/model-settings/index.js')
const opencodeSession = await import('../lib/model-settings/opencode-session.js')
const sessionTitle = await import('../lib/session-title.js')
const { buildPacks } = await import('../scripts/build-packs.mjs')

const full = 'dsh-workbench'
/** 工作台自己的分组：id、inject 照补丁写，组里是并进来的三行。 */
const bundle = (name = full) => ({
  id: name + '-bundle', name: 'cordis:group', group: true, inject: [name + '.bundle-allowed'],
  config: ['model-settings', 'opencode-session', 'session-title'].map(row => ({ id: `${full}-${row}`, name: `@miint-sunny/${name}/${row}` })),
})
const oldModelSettings = (name = '@miint-sunny/dsh-model-settings', extra = {}) => [
  { id: 'model-settings', name, ...extra },
  { id: 'model-settings-opencode-session', name: name + '/opencode-session', ...extra },
]
const oldSessionTitle = (name = '@miint-sunny/dsh-session-title-headtail', extra = {}) => [{ id: 'session-title-headtail', name, ...extra }]

/** 跑一次守卫（不是报告那一行）：它在检查时记下同级里的旧插件。返回它提供的服务。 */
async function runGuard(rows, module = guard, name = full) {
  const services = new Map()
  const ctx = {
    fiber: { entry: { parent: { data: rows } } },
    logger: { warn() {} },
    effect: body => body(),
    on() {},
    provide(key, value) { services.set(key, value); return () => services.delete(key) },
  }
  await module.apply(ctx, { bundle: name })
  return services
}

/** 三行各 apply 一次（假的上下文，够它们登记），返回每一行的结果：加载了，或抛出的原因。 */
function applyRows() {
  const disposers = []
  const ctx = {
    effect(body) { const dispose = body(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    inject() {},
    on() {},
    get: () => undefined,
    sessionTitle: { register: () => () => {} },
  }
  const outcome = {}
  for (const [row, plugin, config] of [['model-settings', modelSettings, undefined], ['opencode-session', opencodeSession, undefined], ['session-title', sessionTitle, {}]]) {
    try {
      plugin.apply(ctx, config)
      outcome[row] = 'loaded'
    } catch (error) {
      outcome[row] = error.message
    }
  }
  for (const dispose of disposers.splice(0).reverse()) dispose()
  return outcome
}

const MODEL = '「模型设置」已并入工作台，旧插件 @miint-sunny/dsh-model-settings 还装着。请在「插件」页卸载它，然后重启 DSH。'
const OPENCODE = '「OpenCode 会话 ID」已并入工作台，旧插件 @miint-sunny/dsh-model-settings 还装着。请在「插件」页卸载它，然后重启 DSH。'
const TITLE = '「会话标题」已并入工作台，旧插件 @miint-sunny/dsh-session-title-headtail 还装着。请在「插件」页卸载它，然后重启 DSH。'

test('旧的模型设置插件没停用：模型设置、OpenCode 会话 ID 两行不加载并写明旧包名和怎么办，会话标题照常，守卫照常放行', async () => {
  const services = await runGuard([bundle(), ...oldModelSettings()])
  assert.equal(services.get(full + '.bundle-allowed'), true)
  assert.deepEqual(applyRows(), { 'model-settings': MODEL, 'opencode-session': OPENCODE, 'session-title': 'loaded' })
})

test('只有旧的会话标题插件：反过来，会话标题这一行不加载，模型设置两行照常', async () => {
  await runGuard([bundle(), ...oldSessionTitle()])
  assert.deepEqual(applyRows(), { 'model-settings': 'loaded', 'opencode-session': 'loaded', 'session-title': TITLE })
})

test('旧插件的行停用了不算；两个旧插件都在时三行都不加载', async () => {
  await runGuard([bundle(), ...oldModelSettings(undefined, { disabled: true }), ...oldSessionTitle(undefined, { disabled: true })])
  assert.deepEqual(applyRows(), { 'model-settings': 'loaded', 'opencode-session': 'loaded', 'session-title': 'loaded' })
  await runGuard([bundle(), ...oldModelSettings(), ...oldSessionTitle()])
  assert.deepEqual(applyRows(), { 'model-settings': MODEL, 'opencode-session': OPENCODE, 'session-title': TITLE })
})

test('更早的无作用域名字也认：dsh-model-settings（只剩 opencode-session 那一行也算）、dsh-session-title-headtail', async () => {
  await runGuard([bundle(), { id: 'model-settings-opencode-session', name: 'dsh-model-settings/opencode-session' }, ...oldSessionTitle('dsh-session-title-headtail')])
  const outcome = applyRows()
  assert.match(outcome['model-settings'], /旧插件 dsh-model-settings 还装着/)
  assert.match(outcome['opencode-session'], /旧插件 dsh-model-settings 还装着/)
  assert.match(outcome['session-title'], /旧插件 dsh-session-title-headtail 还装着/)
})

test('没有旧插件时三行照常加载；名字只是前缀相同的包不算', async () => {
  await runGuard([bundle(), { id: 'x', name: '@miint-sunny/dsh-model-settings-extra' }, { id: 'y', name: 'dsh-session-title-headtail2' }])
  assert.deepEqual(applyRows(), { 'model-settings': 'loaded', 'opencode-session': 'loaded', 'session-title': 'loaded' })
})

test('插件页上的名字和三行的 locale/<行>/zh.json 一致', () => {
  for (const [row, title] of Object.entries(legacy.LEGACY_TITLES)) {
    assert.equal(JSON.parse(readFileSync(new URL(`../locale/${row}/zh.json`, import.meta.url), 'utf8')).meta.title, title, row)
  }
})

test('小包里的守卫只管自己包里的行：「设置」小包记下的旧插件不影响整包的行，反过来也一样', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dwb-legacy-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const dir = buildPacks({ output: join(scratch, 'packs') }).find(pack => pack.name === '@miint-sunny/dsh-workbench-settings').dir
  const packGuard = await import(pathToFileURL(join(dir, 'lib/bundle-guard.js')).href)
  const packLegacy = await import(pathToFileURL(join(dir, 'lib/legacy-plugins.js')).href)
  await runGuard([bundle()], guard, full)
  await runGuard([bundle(full + '-settings'), ...oldModelSettings()], packGuard, full + '-settings')
  assert.throws(() => packLegacy.assertNoLegacyPlugin('model-settings'), { message: MODEL })
  assert.doesNotThrow(() => legacy.assertNoLegacyPlugin('model-settings'))
  await runGuard([bundle(full + '-settings')], packGuard, full + '-settings')
  await runGuard([bundle(), ...oldModelSettings()], guard, full)
  assert.doesNotThrow(() => packLegacy.assertNoLegacyPlugin('model-settings'))
  assert.throws(() => legacy.assertNoLegacyPlugin('model-settings'), { message: MODEL })
  await runGuard([bundle()], guard, full)
})

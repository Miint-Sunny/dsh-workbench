/**
 * 切换 Agent 预设（feat#162）的挂载和接线：用官方页头标签的 id 换掉它、入口按行开关挂载、中英文词典齐全且注册进 DSH，
 * 缓存未命中的数照 DSH 的写法缩成 K、M。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClient } from './react-harness.mjs'
import { presetSwitchTokens } from '../src/client/preset-switch-model.js'
import { buildPacks } from '../scripts/build-packs.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)

/** 替身 slots：inject 立即执行（槽位已声明），register 记下选项和组件，撤销时标记。 */
function fakeSlots() {
  const injected = []
  const registered = []
  return {
    injected,
    registered,
    inject(name, factory) {
      injected.push(name)
      const dispose = factory()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    register(options, component) {
      const entry = { options, component, live: true }
      registered.push(entry)
      return () => { entry.live = false }
    },
  }
}

test('挂载：用官方页头标签的 id 换掉它：conversation.session.header.actions、id agent-preset、order -10、priority 比官方的 0 小', () => {
  const client = loadClient(CLIENT)
  const slots = fakeSlots()
  const dispose = client.get('applyPresetSwitch')({ ctx: { slots }, t })
  assert.deepEqual(slots.injected, ['conversation.session.header.actions'])
  assert.equal(slots.registered.length, 1)
  const [{ options, component }] = slots.registered
  assert.equal(options.name, 'conversation.session.header.actions')
  assert.equal(options.id, 'agent-preset', '同一个 id：DSH 的列表槽位按 id 去重，只显示 priority 最小的那个')
  assert.equal(options.order, -10, '和官方标签同一个位置')
  assert.ok(Number.isInteger(options.priority) && options.priority < 0, `priority ${options.priority}：比官方默认的 0 小才盖得住`)
  assert.equal(typeof component, 'function')
  assert.equal(slots.registered.some(entry => entry.options.name === 'conversation.hero.agentPreset'), false, '空白会话的选择器不动')
  dispose()
  assert.equal(slots.registered[0].live, false, '关掉这一行时注销，官方标签回来')
})

test('入口：功能清单里有 preset-switch 这一行时挂上，用到的服务在 inject 里', () => {
  const client = loadClient(CLIENT)
  const ui = client.get('FEATURE_UI')
  assert.equal(typeof ui['preset-switch'], 'function')
  const inject = client.get('INJECT')
  for (const service of ['slots', 'locale', 'remote.agentPresets']) assert.ok(inject.includes(service), service)
})

test('词典：中英文的键一样，界面用到的每个键都有；入口把它们注册进 DSH', () => {
  const client = loadClient(CLIENT, {
    document: { head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }), addEventListener() {}, removeEventListener() {} },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  })
  const zh = client.get('PRESETSWITCH_ZH')
  const en = client.get('PRESETSWITCH_EN')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  const source = ['preset-switch.js', 'preset-switch-model.js'].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n')
  const used = new Set([...source.matchAll(/'(pswitch\.[\w.-]+)'/g)].map(match => match[1]))
  // 错误文字的键由代码拼出来：pswitch.error.<代码>。
  for (const code of ['compact-failed', 'not-idle', 'busy', 'unsupported', 'failed']) used.add(`pswitch.error.${code}`)
  for (const key of used) {
    assert.equal(typeof zh[key], 'string', `zh ${key}`)
    assert.equal(typeof en[key], 'string', `en ${key}`)
  }
  const registered = new Map()
  const effects = []
  const ctx = {
    effect: (fn) => { effects.push(fn()) },
    locale: { register: (namespace, dictionaries) => { registered.set(namespace, dictionaries) }, bind: () => key => key },
    on: () => () => {},
    remote: { $on: () => () => {} },
  }
  client.get('applyClient')(ctx)
  const dictionaries = registered.get('@miint-sunny/dsh-workbench')
  assert.equal(typeof dictionaries.zh['pswitch.confirm.title'], 'string')
  assert.equal(dictionaries.zh['pswitch.confirm.title'], zh['pswitch.confirm.title'])
  assert.equal(dictionaries.en['pswitch.confirm.title'], en['pswitch.confirm.title'])
})

test('缓存未命中的数：照 DSH 的 formatTokens，不到一千照写，千和百万缩成 K、M，一百以下留一位小数', () => {
  assert.equal(presetSwitchTokens(0, t), '0')
  assert.equal(presetSwitchTokens(517, t), '517')
  assert.equal(presetSwitchTokens(12_240, t), 'pswitch.number.thousand{"value":"12.2"}')
  assert.equal(presetSwitchTokens(65_536, t), 'pswitch.number.thousand{"value":"65.5"}')
  assert.equal(presetSwitchTokens(118_000, t), 'pswitch.number.thousand{"value":"118"}')
  assert.equal(presetSwitchTokens(1_250_000, t), 'pswitch.number.million{"value":"1.3"}')
})

test('单装包：这一行和 presets 行一样只在整包里，网页文件不进任何单装包；整包的 lib/client.js 里有', (t) => {
  const output = join(mkdtempSync(join(tmpdir(), 'dwb-pswitch-packs-')), 'packs')
  t.after(() => rmSync(join(output, '..'), { recursive: true, force: true }))
  const products = buildPacks({ output })
  assert.ok(products.length > 0)
  for (const { name, dir } of products) {
    const client = readFileSync(join(dir, 'lib/client.js'), 'utf8')
    assert.doesNotMatch(client, /PresetSwitchHeader|dwb-pswitch|PRESETSWITCH_(?:ZH|EN)|PRESET_SWITCH_INJECT|'preset-switch'/, name)
  }
  assert.match(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), /function PresetSwitchHeader\(/)
})

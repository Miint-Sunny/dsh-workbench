import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_EXCLUDED_PRESETS, applyNotifyRoutes, defaultNotifyConfig,
  parseNotifyConfig, readNotifyConfig, writeNotifyConfig,
} from '../lib/notify-state.js'
import { workbenchDataDir } from '../lib/data-dir.js'
import { notificationsBetween } from '../src/client/notify.js'

/** 一个会话的状态。 */
function statusOf(running, interaction) {
  return { running, pendingInteraction: interaction, completionUnread: false }
}

/** 全开的默认配置（按需覆盖）。 */
function configOf(overrides = {}) {
  const config = defaultNotifyConfig()
  config.excludedPresets = []
  return { ...config, ...overrides }
}

const IDLE = new Map()
const s1 = 'session-1'

test('notify transitions: completion when running goes true to false', () => {
  const before = new Map([[s1, statusOf(true)]])
  const after = new Map([[s1, statusOf(false)]])
  assert.deepEqual(notificationsBetween(before, after, configOf(), false, () => undefined), [{ sessionId: s1, event: 'completed' }])
})

test('notify transitions: waiting approval, waiting answer and plan review each notify once', () => {
  const cases = [
    ['approval', { kind: 'approval', key: 'k1', sessionId: s1 }, 'approval'],
    ['question', { kind: 'question', key: 'k2', sessionId: s1 }, 'question'],
    ['plan review', { kind: 'plan-review', key: 'k3', sessionId: s1 }, 'planReview'],
  ]
  for (const [label, interaction, event] of cases) {
    const after = new Map([[s1, statusOf(true, interaction)]])
    assert.deepEqual(notificationsBetween(IDLE, after, configOf(), false, () => undefined), [{ sessionId: s1, event }], label)
    // 同一个请求持续等待：不再发
    const steady = new Map([[s1, statusOf(true, { ...interaction })]])
    assert.deepEqual(notificationsBetween(after, steady, configOf(), false, () => undefined), [], `${label} 不重复`)
  }
})

test('notify transitions: a pending interaction beats completion in the same change', () => {
  const before = new Map([[s1, statusOf(true)]])
  const after = new Map([[s1, statusOf(false, { kind: 'question', key: 'k', sessionId: s1 })]])
  assert.deepEqual(notificationsBetween(before, after, configOf(), false, () => undefined), [{ sessionId: s1, event: 'question' }])
})

test('notify gating: nothing while DSH is frontmost unless configured, nothing on the first snapshot', () => {
  const before = new Map([[s1, statusOf(true)]])
  const after = new Map([[s1, statusOf(false)]])
  assert.deepEqual(notificationsBetween(before, after, configOf(), true, () => undefined), [])
  assert.deepEqual(notificationsBetween(before, after, configOf({ notifyForeground: true }), true, () => undefined), [{ sessionId: s1, event: 'completed' }])
  assert.deepEqual(notificationsBetween(null, after, configOf(), false, () => undefined), [])
})

test('notify gating: excluded presets and disabled events stay silent', () => {
  const before = new Map([[s1, statusOf(true)]])
  const after = new Map([[s1, statusOf(false)]])
  assert.deepEqual(notificationsBetween(before, after, configOf({ excludedPresets: ['whale'] }), false, () => 'whale'), [])
  assert.deepEqual(notificationsBetween(before, after, configOf({ excludedPresets: ['whale'] }), false, () => 'whale-dream'), [{ sessionId: s1, event: 'completed' }])
  assert.deepEqual(notificationsBetween(before, after, configOf({ events: { ...defaultNotifyConfig().events, completed: false } }), false, () => undefined), [])
  // 查不到预设的会话（投影还没读到）不排除
  assert.deepEqual(notificationsBetween(before, after, configOf({ excludedPresets: ['whale'] }), false, () => undefined), [{ sessionId: s1, event: 'completed' }])
})

test('notify defaults: the whale presets are excluded by default', () => {
  assert.deepEqual(DEFAULT_EXCLUDED_PRESETS, ['whale', 'whale-dream'])
  const before = new Map([[s1, statusOf(true)]])
  const after = new Map([[s1, statusOf(false)]])
  assert.deepEqual(notificationsBetween(before, after, defaultNotifyConfig(), false, () => 'whale-dream'), [])
})

test('notify config parse: canonical values in, malformed ones out', () => {
  const config = defaultNotifyConfig()
  assert.deepEqual(parseNotifyConfig(JSON.parse(JSON.stringify(config))), config)
  assert.deepEqual(parseNotifyConfig({ ...config, excludedPresets: ['a', 'a', 'b'] }).excludedPresets, ['a', 'b'])
  assert.throws(() => parseNotifyConfig({ ...config, events: { ...config.events, completed: 'yes' } }), /completed/)
  assert.throws(() => parseNotifyConfig({ ...config, excludedPresets: 'nope' }), /excludedPresets/)
  assert.throws(() => parseNotifyConfig({ ...config, notifyForeground: 1 }), /notifyForeground/)
  assert.throws(() => parseNotifyConfig({ ...config, showFirstLine: null }), /showFirstLine/)
  assert.throws(() => parseNotifyConfig(null), /object/)
})

test('notify config storage: missing or corrupt file falls back to defaults, save round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-notify-'))
  try {
    assert.deepEqual(readNotifyConfig(dir), defaultNotifyConfig())
    writeFileSync(join(dir, 'notify.json'), '{broken')
    assert.deepEqual(readNotifyConfig(dir), defaultNotifyConfig())
    const changed = { ...defaultNotifyConfig(), notifyForeground: true, excludedPresets: ['whale'] }
    writeNotifyConfig(dir, changed)
    assert.deepEqual(readNotifyConfig(dir), changed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workbench data dir: $DSH_HOME wins, default under ~/.dsh', () => {
  assert.equal(workbenchDataDir({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/dsh-workbench')
  assert.equal(workbenchDataDir({}).endsWith(join('.dsh', 'dsh-workbench')), true)
})

test('notify routes: GET serves stored config, POST validates and saves, bad bodies answer 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-notify-'))
  const routes = []
  const scope = {
    connection: { fetch: { register: route => { routes.push(route); return () => routes.pop() } } },
  }
  try {
    applyNotifyRoutes(scope, { dir })
    assert.equal(routes.length, 1)
    const route = routes[0]
    assert.equal(route.path, '/api/dsh-workbench.notify.config')
    assert.deepEqual(route.methods, ['GET', 'POST'])
    assert.deepEqual((await (await route.fetch(new Request('http://dsh/api'))).json()), defaultNotifyConfig())
    const saved = { ...defaultNotifyConfig(), events: { ...defaultNotifyConfig().events, completed: false }, excludedPresets: ['whale'] }
    const post = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify(saved) }))
    assert.equal(post.status, 200)
    assert.deepEqual((await post.json()), { ok: true, config: saved })
    assert.deepEqual(readNotifyConfig(dir), saved)
    const bad = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: '{nope' }))
    assert.equal(bad.status, 400)
    const invalid = await route.fetch(new Request('http://dsh/api', { method: 'POST', body: JSON.stringify({ ...saved, showFirstLine: 'x' }) }))
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).message, /showFirstLine/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 网页端：配置页保存后，正在跑的监听马上用新配置（替身 React 里跑构建好的 lib/client.js） ----------

/** 挂上通知功能、打开配置页；change 在配置页上改设置，之后保存，再让会话 s1 跑完一轮。 */
async function notifyAfterSaving(t, change) {
  const { loadClient } = await import('./react-harness.mjs')
  let stored = { ...defaultNotifyConfig(), excludedPresets: [], notifyForeground: true, showFirstLine: true }
  const fetch = async (url, init = {}) => {
    if (String(url) !== 'api/dsh-workbench.notify.config') throw new Error(`没准备的请求 ${url}`)
    if (init.method === 'POST') stored = JSON.parse(init.body)
    return new Response(JSON.stringify(init.method === 'POST' ? { ok: true, config: stored } : stored), { status: 200 })
  }
  const shown = []
  class Notification {
    static permission = 'granted'
    constructor(title, options) { shown.push({ title, body: options.body }) }
    close() {}
  }
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { fetch, Notification, document: { hasFocus: () => false } })
  const listeners = new Set()
  let status = new Map([[s1, statusOf(true)]])
  const app = {
    t: key => key,
    ctx: {
      effect: (open) => { const close = open(); return () => { if (typeof close === 'function') close() } },
      slots: { inject: (_, register) => { register(); return () => {} }, register: () => () => {} },
      uiSession: { sessionStatus: { getSnapshot: () => status, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } } },
      sessions: {
        list: { getSnapshot: () => ({ byId: { [s1]: { displayTitle: '会话一', projectionValues: { agentPreset: 'default' } } } }) },
        retain: () => ({
          ready: Promise.resolve(), release() {},
          binding: { eventSource: { getSnapshot: () => ({ entries: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '改好了。' }] } } }] }) } },
        }),
      },
      remote: { agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }) } },
      get: () => undefined,
    },
  }
  const react = client.react
  const stop = client.get('applyNotify')(app)
  react.mount(react.React.createElement(client.get('NotifyConfigPage'), { app }))
  t.after(() => { react.unmount(); stop() })
  await react.settle()
  change(label => react.one(node => node.type === 'ui.Checkbox' && node.props.label === label, `「${label}」`).props.onChange())
  await react.settle()
  react.one(node => node.type === 'ui.SettingsForm', '保存条').props.onSave()
  await react.settle()
  const emit = () => { for (const fn of listeners) fn() }
  emit()
  status = new Map([[s1, statusOf(false)]])
  emit()
  await react.settle()
  return { shown, stored }
}

test('TC-005 关掉「显示回复的第一句」并保存后，下一条完成通知不带回复内容', async (t) => {
  const { shown, stored } = await notifyAfterSaving(t, toggle => toggle('notify.page.showFirstLine'))
  assert.equal(stored.showFirstLine, false)
  assert.deepEqual(shown, [{ title: '会话一', body: 'notify.state.completed' }])
})

test('TC-005 关掉「完成」事件并保存后，会话跑完不再通知', async (t) => {
  const { shown, stored } = await notifyAfterSaving(t, toggle => toggle('notify.page.event.completed'))
  assert.equal(stored.events.completed, false)
  assert.deepEqual(shown, [])
})

// ---------- 网页端：配置页里写到操作系统的三句按平台显示（fix#223）。平台是注入的 navigator 替身，不读本机 ----------

/** 配置页的概要、「显示回复的第一句」下的说明、权限说明。Mac 的原句一字不改；Windows 以外的平台照 Mac 的写。 */
const PAGE_TEXT = {
  macos: {
    zh: {
      summary: 'DSH 不在前台时发送 macOS 通知；点击通知打开对应会话。',
      showFirstLineHint: 'macOS 通知中心会保留通知里的文字。',
      permissionInfo: '首次发送通知时，macOS 会请求通知权限；可在「系统设置 → 通知 → DeepSeek Harness」中修改。',
    },
    en: {
      summary: 'Sends macOS notifications while DSH is not in the foreground. Clicking a notification opens its session.',
      showFirstLineHint: 'macOS Notification Center keeps the text of notifications.',
      permissionInfo: 'macOS asks for notification permission the first time. Change it in System Settings → Notifications → DeepSeek Harness.',
    },
  },
  windows: {
    zh: {
      summary: 'DSH 不在前台时发送系统通知；点击通知打开对应会话。',
      showFirstLineHint: 'Windows 通知中心会保留通知里的文字。',
      permissionInfo: '可在「设置 → 系统 → 通知」中修改通知权限；DeepSeek Harness 发出第一条通知后才会出现在列表中。开启「请勿打扰」时，通知只进入通知中心，不弹出。',
    },
    en: {
      summary: 'Sends system notifications while DSH is not in the foreground. Clicking a notification opens its session.',
      showFirstLineHint: 'Windows keeps the text of notifications in notification center.',
      permissionInfo: 'Change notification permission in Settings → System → Notifications. DeepSeek Harness is listed there only after it sends its first notification. With Do not disturb on, notifications go to notification center without popping up.',
    },
  },
}

/**
 * 在 navigator.platform 是 platform 的网页里打开配置页，读出那三句，和插件页这一行的概要（row）。
 * @param {string} platform navigator.platform 的值。
 * @param {'zh' | 'en'} lang 用包里哪一本词典。
 * @returns {Promise<{summary: string, showFirstLineHint: string, permissionInfo: string, row: string}>} 页面上的文字。
 */
async function notifyPageTexts(platform, lang) {
  const { loadClient, textOf } = await import('./react-harness.mjs')
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { navigator: { platform } })
  const dictionary = client.get(lang)
  const app = {
    t: key => dictionary[key] ?? `（词典里没有 ${key}）`,
    notifyConfig: { load: async () => defaultNotifyConfig(), set() {} },
    ctx: { remote: { agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }) } } },
  }
  const react = client.react
  react.mount(react.React.createElement(client.get('NotifyConfigPage'), { app }))
  try {
    await react.settle()
    const hints = react.all(node => node.props.className === 'dwb-notify-hint').map(textOf)
    assert.equal(hints.length, 2, '配置页有概要和第一句的说明两段')
    return {
      summary: hints[0],
      showFirstLineHint: hints[1],
      permissionInfo: textOf(react.one(node => node.props.className === 'dwb-notify-info', '权限说明')),
      row: client.get('NotifyConfigEntry')({ app, view: 'summary' }),
    }
  } finally {
    react.unmount()
  }
}

test('fix#223 配置页写到操作系统的三句按平台显示：Mac 照原句，Windows 写系统通知和「设置 → 系统 → 通知」，其他平台照 Mac', async () => {
  for (const [platform, kind] of [['MacIntel', 'macos'], ['Win32', 'windows'], ['Linux x86_64', 'macos']]) {
    for (const lang of ['zh', 'en']) {
      const expected = PAGE_TEXT[kind][lang]
      assert.deepEqual(await notifyPageTexts(platform, lang), { ...expected, row: expected.summary }, `${platform} 上的${lang === 'zh' ? '中文' : '英文'}`)
    }
  }
})

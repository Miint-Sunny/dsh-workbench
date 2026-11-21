/**
 * 会话标题这一行的网页端（从 dsh-session-title-headtail 的 test/client.test.mjs 搬来，feat#217）：侧栏会话菜单的「重新起名」。
 * 在替身 React 里跑构建好的 lib/client.js，按功能清单挂上这一行（FEATURE_UI['session-title']）；
 * 假的客户端上下文照 cordis 的 inject 写：开一个子作用域，子作用域的 dispose 撤掉它登记的全部东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const LEGACY_SLOT = 'sidebar.workspaces.session.menu.item'

/**
 * 挂上这一行。
 * @param {unknown} [answer] remote.commands.execute 的结果；是 Error 时 reject。
 * @returns {{ client: object, record: object, locale: object, app: object, dispose: () => void }} 包、登记下的东西、语言服务、入口上下文和撤销函数。
 */
function mount(answer) {
  const client = loadClient(CLIENT)
  const record = { menus: [], slots: [], executed: [] }
  const locale = { subscribe: () => () => {} }
  const scope = () => {
    const disposers = []
    return {
      effect(body) { const dispose = body(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
      inject(_deps, setup) {
        const child = scope()
        setup(child)
        const fiber = { dispose: () => child.disposeAll() }
        disposers.push(fiber.dispose)
        return fiber
      },
      locale,
      slots: {
        inject(name, make) {
          const entry = { name, registration: make() }
          record.slots.push(entry)
          disposers.push(() => record.slots.splice(record.slots.indexOf(entry), 1))
        },
        register: (options, component) => ({ ...options, component }),
      },
      contextMenus: {
        register(input) {
          record.menus.push(input)
          return () => record.menus.splice(record.menus.indexOf(input), 1)
        },
      },
      remote: {
        commands: {
          execute: async (...args) => {
            record.executed.push(args)
            if (answer instanceof Error) throw answer
            return answer
          },
        },
      },
      disposeAll() { for (const dispose of disposers.splice(0).reverse()) dispose() },
    }
  }
  const zh = client.get('zh')
  const app = { ctx: scope(), t: key => zh[key] }
  const dispose = client.get('FEATURE_UI')['session-title'](app)
  return { client, record, locale, app, dispose }
}

test('这一行的子 fiber 注入它注册菜单项要用的服务', () => {
  const client = loadClient(CLIENT)
  assert.deepEqual(client.get('SESSION_TITLE_INJECT'), ['slots', 'contextMenus', 'remote', 'remote.commands'])
})

test('「重新起名」是会话菜单里的一项，位于「重命名」（200）和「分叉会话」（300）之间，不用旧插槽', () => {
  const { record, locale, dispose } = mount()
  assert.equal(record.menus.length, 1)
  const [menu] = record.menus
  assert.equal(menu.id, 'dsh-workbench.session-title.retitle')
  assert.equal(menu.target, 'session')
  assert.equal(menu.order, 250)
  assert.ok(menu.order > 200 && menu.order < 300)
  // 菜单开着时切换语言，菜单项跟着换名字。
  assert.deepEqual(menu.observe({ sessionId: 's1', displayTitle: '旧标题' }), [locale])
  const actions = menu.resolve({ sessionId: 's1', displayTitle: '旧标题' })
  assert.deepEqual(actions.map(({ id, label, icon }) => ({ id, label, icon })), [
    { id: 'retitle', label: '重新起名', icon: { key: 'dsh-workbench.session-title.retitle' } },
  ])
  assert.deepEqual(record.slots.map(slot => slot.name), ['contextMenu.icon'])
  assert.ok(!record.slots.some(slot => slot.name === LEGACY_SLOT))
  dispose()
})

test('菜单项的图标是 DSH 的刷新图标，按菜单项声明的键注册', () => {
  const { client, record, dispose } = mount()
  const [slot] = record.slots
  const [action] = record.menus[0].resolve({ sessionId: 's1', displayTitle: '' })
  assert.equal(slot.registration.name, 'contextMenu.icon')
  assert.equal(slot.registration.key, action.icon.key)
  assert.equal(slot.registration.component, client.react.ui.IconRefreshOutlineRegular)
  dispose()
})

test('词条照旧：「重新起名」/ "Regenerate title"，在工作台的词典里', () => {
  const client = loadClient(CLIENT)
  assert.equal(client.get('zh')['sessionTitle.retitle'], '重新起名')
  assert.equal(client.get('en')['sessionTitle.retitle'], 'Regenerate title')
})

test('点菜单项：对打开菜单时的那个会话执行 /retitle', async () => {
  const { record, dispose } = mount({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '会话标题：新标题' } } })
  const [action] = record.menus[0].resolve({ sessionId: 's1', displayTitle: '旧标题' })
  await action.run()
  assert.deepEqual(record.executed, [['s1', '/retitle', []]])
  dispose()
})

test('/retitle 被拒绝、没注册、报错或连接出错时 reject，菜单显示 DSH 自己的失败提示', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  for (const answer of [
    { ok: false, error: { code: 'RPC_REFUSED', message: 'no access' } },
    { ok: true, value: undefined },
    { ok: true, value: { commandId: 'c2', result: { kind: 'error', text: '这个会话还没有可用来起标题的消息。' } } },
    new Error('socket closed'),
  ]) {
    const { record, dispose } = mount(answer)
    const [action] = record.menus[0].resolve({ sessionId: 's2', displayTitle: '' })
    await assert.rejects(action.run())
    assert.deepEqual(record.executed, [['s2', '/retitle', []]])
    dispose()
  }
  assert.equal(warn.mock.callCount(), 4)
})

test('这一行关掉：菜单项和图标都撤下；再开回来仍只有一个「重新起名」', () => {
  const { client, record, app, dispose } = mount()
  assert.equal(record.menus.length, 1)
  dispose()
  assert.deepEqual(record.menus, [])
  assert.deepEqual(record.slots, [])
  const again = client.get('FEATURE_UI')['session-title'](app)
  assert.deepEqual(record.menus.map(menu => menu.id), ['dsh-workbench.session-title.retitle'])
  assert.equal(record.slots.length, 1)
  again()
  assert.deepEqual(record.menus, [])
})

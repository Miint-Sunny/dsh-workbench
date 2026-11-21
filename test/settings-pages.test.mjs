/**
 * 设置页的顺序和图标（chore#163）：工作台自己四页的排序值，和「设置页图标」这一行给养鱼、订阅两页补的图标。
 * 在替身 React 里跑构建好的 lib/client.js，装上各行，读它们向 settings.section 和 settings.section.icon 注册了什么。
 *
 * 排序值为什么是这几个数（样稿 docs/mocks/2026-11-17-设置页顺序和图标.html）：
 * 官方 通用设置 0、模型 10、内置插件 15、Agent 预设 20；第三方 养鱼 6、订阅 90、侧边卡片 100，都不动。
 * 工作台四页夹在 20 和 90 之间，按「模型和智能体 → 工具 → 权限」排：压缩 25、MCP 30、放行规则 40、工作区信任 41。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)

/** 官方和第三方设置页的排序值（只用来核对工作台四页夹在哪里，不是工作台注册的）。 */
const OFFICIAL_LAST = 20 // Agent 预设
const THIRD_PARTY_SUBSCRIPTIONS = 90

/** 装上一行（假的 ctx），记下它向设置页相关槽位注册的东西；dispose 撤下这一行。 */
function install(applyName) {
  const client = loadClient(CLIENT)
  const registered = []
  const ctx = {
    slots: {
      // 生成器写法的工厂（右键菜单图标）在这里不展开：只关心设置页的两个槽位。
      inject: (_slot, make) => { const result = make(); return typeof result === 'function' ? result : () => {} },
      register: (info, render) => {
        const entry = { info, render, disposed: false }
        registered.push(entry)
        return () => { entry.disposed = true }
      },
    },
    sidebarRightTabs: { register: () => () => {} },
  }
  const app = { ctx, t: key => key, clock: key => key }
  const dispose = client.get(applyName)(app)
  return { client, registered, dispose }
}

const PAGES = [
  { apply: 'applyCompactionSettings', id: 'dsh-workbench-compaction', order: 25 },
  { apply: 'applyMcp', id: 'dsh-workbench-mcp', order: 30 },
  { apply: 'applyApprovalRules', id: 'dsh-workbench-approval-rules', order: 40 },
  { apply: 'applyWorkspaceTrust', id: 'dsh-workbench-workspace-trust', order: 41 },
]

test('工作台四页的排序值：压缩 25、MCP 30、放行规则 40、工作区信任 41', () => {
  const orders = {}
  for (const page of PAGES) {
    const { registered, dispose } = install(page.apply)
    const sections = registered.filter(entry => entry.info.name === 'settings.section')
    assert.equal(sections.length, 1, `${page.id} 应该只注册一个设置页`)
    assert.equal(sections[0].info.id, page.id)
    orders[page.id] = sections[0].info.order
    dispose()
  }
  assert.deepEqual(orders, Object.fromEntries(PAGES.map(page => [page.id, page.order])))
})

test('四页排在官方最后一项（Agent 预设 20）之后、第三方订阅（90）之前，顺序是模型和智能体、工具、权限', () => {
  const orders = PAGES.map(page => {
    const { registered, dispose } = install(page.apply)
    const order = registered.find(entry => entry.info.name === 'settings.section').info.order
    dispose()
    return order
  })
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), '四页的顺序：压缩、MCP、放行规则、工作区信任')
  assert.equal(new Set(orders).size, orders.length, '排序值不能重复：重复时谁在前取决于注册先后')
  assert.ok(Math.min(...orders) > OFFICIAL_LAST)
  assert.ok(Math.max(...orders) < THIRD_PARTY_SUBSCRIPTIONS)
})

test('四页的图标仍按自己的 id 注册，和设置页的 id 一一对应（图标按 id 对应设置页，id 对不上不显示）', () => {
  for (const page of PAGES) {
    const { registered, dispose } = install(page.apply)
    const icons = registered.filter(entry => entry.info.name === 'settings.section.icon')
    assert.deepEqual(icons.map(entry => entry.info.id), [page.id])
    dispose()
  }
})

test('设置页图标这一行：只给养鱼（bili-whale）和订阅（subscriptions）注册图标，不注册设置页，也不碰通用设置', () => {
  const { registered, dispose } = install('applySettingsIcons')
  assert.deepEqual(registered.map(entry => entry.info.name), ['settings.section.icon', 'settings.section.icon'])
  assert.deepEqual(registered.map(entry => entry.info.id), ['bili-whale', 'subscriptions'])
  assert.ok(!registered.some(entry => entry.info.id === 'general'), '通用设置保留官方的齿轮')
  dispose()
  assert.ok(registered.every(entry => entry.disposed), '关掉这一行要把图标一并撤下，恢复默认的齿轮')
})

test('让位：优先级比默认的 0 大，第三方自己注册了图标时显示第三方的', () => {
  // 2026-11-17 在隔离 DSH 里实测（见 src/client/settings-icons.js 的注释）：同一个 id 的两个注册，
  // 优先级数字小的显示；数字相同时后注册的那个直接报错。第三方不写优先级就是 0，所以我们要比 0 大。
  const { registered, dispose } = install('applySettingsIcons')
  for (const { info } of registered) {
    assert.equal(typeof info.priority, 'number')
    assert.ok(Number.isFinite(info.priority) && info.priority > 0, `${info.id} 的优先级是 ${info.priority}`)
  }
  assert.equal(new Set(registered.map(entry => entry.info.priority)).size, 1, '两个图标用同一个让位的数字')
  dispose()
})

test('两个图标是自己画的：16×16、描边 1 像素、currentColor，大小跟着设置页给的 size', () => {
  const { client, registered, dispose } = install('applySettingsIcons')
  for (const size of [16, 20]) {
    for (const entry of registered) {
      client.react.mount(client.react.React.createElement(entry.render, { size, active: false }))
      const svg = client.react.one(node => node.type === 'svg', `${entry.info.id} 的 svg`)
      assert.equal(svg.props.viewBox, '0 0 16 16')
      assert.equal(svg.props.width, size)
      assert.equal(svg.props.height, size)
      assert.equal(svg.props.fill, 'none')
      assert.equal(svg.props.stroke, 'currentColor')
      assert.equal(svg.props.strokeWidth, 1)
      assert.equal(svg.props['aria-hidden'], true, '图标只是装饰：名字由设置页的行文字给')
      assert.ok(svg.children.length >= 2, `${entry.info.id} 至少有两笔`)
      client.react.unmount()
    }
  }
  dispose()
})

test('养鱼和订阅的图标画得不一样（不是同一个图形）', () => {
  const { client, registered, dispose } = install('applySettingsIcons')
  const drawings = registered.map(entry => {
    client.react.mount(client.react.React.createElement(entry.render, { size: 16, active: false }))
    const paths = client.react.all(node => node.type === 'path' || node.type === 'circle').map(node => node.props.d ?? `${node.props.cx},${node.props.cy},${node.props.r}`)
    client.react.unmount()
    return paths.join('|')
  })
  assert.equal(new Set(drawings).size, 2)
  assert.ok(drawings.every(drawing => drawing !== ''))
  dispose()
})

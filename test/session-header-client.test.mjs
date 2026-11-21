/**
 * 会话顶栏（feat#148）的客户端测试：样式规则、「更多操作」里的变更请求项什么时候出现、点了打开哪个面板、撤销干净。
 * 顶栏的实际排列和隐藏要在 DSH 桌面端里看（官方类名带构建哈希，这里只测规则写法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_HEADER_CSS, SESSION_HEADER_EN, SESSION_HEADER_ZH, applySessionHeader, changeRequestsButtonPresent, changeRequestsMenu,
} from '../src/client/session-header.js'

test('样式：「更多操作」排到工具区最前；变更请求按钮按它自己的标记隐藏，带红点时不隐藏', () => {
  const rules = SESSION_HEADER_CSS.split('}').map(rule => rule.trim()).filter(Boolean)
  assert.equal(rules.length, 2)
  // 「更多操作」：只认工具区的直接子元素，跳过槽位锚点。
  assert.match(rules[0], /\[class\*="_headerUtilities"\] > \[class\*="_headerMenuButton"\]/)
  assert.match(rules[0], /> :not\(\[data-slot\]\):has\(\[class\*="_headerMenuButton"\]\)/)
  assert.match(rules[0], /order: -1/)
  // 变更请求按钮：在 utilities 槽位锚点里找按钮本身；红点的两种标记（类名、StateDot 的 data-state）都豁免。
  assert.match(rules[1], /^\[data-slot="conversation\.session\.header\.utilities"\] \[data-forge-header\]:not\(:has\(\[class\*="_dot"\], \[data-state="error"\]\)\) \{ display: none;$/)
})

test('样式不去藏槽位锚点：DSH 的 [data-slot] 锚点是 display:contents，藏它会连同定时任务、共享等按钮一起藏掉（chore#149 审查发现）', () => {
  // 曾经的错误写法：工具区的直接子元素里「含有」变更请求按钮的那个——命中的正是整个槽位锚点。
  assert.doesNotMatch(SESSION_HEADER_CSS, /_headerUtilities"\]\s*>\s*:(?:is|has)\([^)]*data-forge-header/)
  assert.doesNotMatch(SESSION_HEADER_CSS, /\[data-slot[^\]]*\]\s*\{/)
  for (const line of SESSION_HEADER_CSS.split('\n').filter(line => line.includes('display: none'))) {
    assert.match(line, /\[data-forge-header\]:not\(/, '只隐藏变更请求按钮本身')
  }
})

test('菜单项：顶栏有官方变更请求按钮时出现，点了打开官方的变更请求面板；没有按钮时不出现', () => {
  let present = true
  const opened = []
  const resolve = changeRequestsMenu({ t: key => `t:${key}`, present: () => present, open: () => opened.push('open') })
  const items = resolve({ sessionId: 's1' })
  assert.equal(items.length, 1)
  assert.equal(items[0].label, 't:sessionHeader.changeRequests')
  assert.equal(items[0].icon.key, 'dwb-session-header-change-requests')
  items[0].run()
  assert.deepEqual(opened, ['open'])
  present = false
  assert.deepEqual(resolve({ sessionId: 's1' }), [])
})

test('按钮在不在：按 data-forge-header 找；没有页面时算不在', () => {
  const seen = []
  assert.equal(changeRequestsButtonPresent({ querySelector: selector => { seen.push(selector); return {} } }), true)
  assert.deepEqual(seen, ['[data-forge-header]'])
  assert.equal(changeRequestsButtonPresent({ querySelector: () => null }), false)
  assert.equal(changeRequestsButtonPresent(undefined), false)
})

test('文案：中英文各一条，菜单项和官方按钮的名称一致', () => {
  assert.deepEqual(SESSION_HEADER_ZH, { 'sessionHeader.changeRequests': '本会话的变更请求' })
  assert.deepEqual(SESSION_HEADER_EN, { 'sessionHeader.changeRequests': 'Change requests of this Session' })
})

test('挂载和撤销：挂上样式，登记「更多操作」的菜单项和图标；官方按钮在时点菜单项打开 forge-panel；撤销时都收回', (t0) => {
  const log = { menus: [], icons: [], opened: [], disposed: [], styles: [] }
  let buttonOnPage = false
  // 最小的页面替身：样式元素和按钮查找。
  globalThis.document = {
    createElement: () => ({ dataset: {}, set textContent(value) { log.styles.push(value) }, remove() { log.disposed.push('style') } }),
    head: { appendChild() {} },
    querySelector: selector => (selector === '[data-forge-header]' && buttonOnPage ? {} : null),
  }
  t0.after(() => { delete globalThis.document })
  const ctx = {
    contextMenus: { register(def) { log.menus.push(def); return () => log.disposed.push('menu') } },
    sidebarRight: { openTab(kind) { log.opened.push(kind) } },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'contextMenu.icon')
        const disposers = [...factory()]
        return () => { for (const dispose of disposers) dispose(); log.disposed.push('icon') }
      },
      register(def) { log.icons.push(def.key); return () => {} },
    },
  }
  const dispose = applySessionHeader({ ctx, t: key => key })
  assert.deepEqual(log.styles, [SESSION_HEADER_CSS])
  assert.equal(log.menus.length, 1)
  assert.equal(log.menus[0].target, 'sessionHeader')
  assert.ok(log.menus[0].order < 100, '排在官方「复制」「下载」（100）前面')
  assert.deepEqual(log.icons, ['dwb-session-header-change-requests'])
  // 会话目录不是 Git 仓库：官方按钮不渲染，菜单项也不出现。
  assert.deepEqual(log.menus[0].resolve({ sessionId: 's1' }), [])
  // 官方按钮在（被样式藏着也算）：菜单项出现，点了打开官方变更请求面板。
  buttonOnPage = true
  const items = log.menus[0].resolve({ sessionId: 's1' })
  assert.deepEqual(items.map(item => item.label), ['sessionHeader.changeRequests'])
  items[0].run()
  assert.deepEqual(log.opened, ['forge-panel'])
  dispose()
  assert.deepEqual(log.disposed.sort(), ['icon', 'menu', 'style'])
})

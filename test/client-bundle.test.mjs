/** 客户端包的冒烟：lib/client.js 能被 DSH 的模块加载器装载——factory 顶层没有引用错误，交回 inject 和 apply。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPacks } from '../scripts/build-packs.mjs'

test('lib/client.js 装载：factory 执行到底，inject 里有各功能要的服务，交回 apply', () => {
  const react = {
    Fragment: 'Fragment',
    // 顶层不会真的渲染；组件里的钩子在这里只会被引用，不会被调用。
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const ui = new Proxy({}, { get: () => () => null })
  let entry
  globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  try {
    // 间接 eval 在全局作用域执行，lib/client.js 里只引用 window.__ModuleLoader__。
    (0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
    assert.equal(entry.id, '@miint-sunny/dsh-workbench')
    const exports = entry.factory((name) => (name === 'react' ? react : ui))
    assert.equal(typeof exports.apply, 'function')
    // 共用的服务一个不少，没有重复；各功能自己要的服务由各功能的测试查（见 *_INJECT）。
    for (const service of ['slots', 'locale', 'remote', 'sessions', 'uiSession', 'remote.agentPresets', 'sidebarRightTabs']) {
      assert.ok(exports.inject.includes(service), service)
    }
    assert.equal(new Set(exports.inject).size, exports.inject.length)
  } finally {
    delete globalThis.window
  }
})

test('整包和七个小包的网页头部解构同一组 React 钩子，都有 useSyncExternalStore：模型设置在用，漏了它装载照样通过，一渲染才报 ReferenceError', t => {
  const hooksOf = source => source.match(/^ {2}const \{ createElement: h, ([^}]+) \} = React$/m)?.[1].split(',').map(name => name.trim()).sort()
  const full = hooksOf(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  assert.ok(full?.includes('useSyncExternalStore'), `整包头部的钩子：${full}`)
  const scratch = mkdtempSync(join(tmpdir(), 'dwb-hooks-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const packs = buildPacks({ output: join(scratch, 'packs') })
  assert.equal(packs.length, 7)
  for (const { name, dir } of packs) assert.deepEqual(hooksOf(readFileSync(join(dir, 'lib/client.js'), 'utf8')), full, name)
})

test('拼进 lib/client.js 的各模块顶层名字互不重名：同一个作用域里后一个会悄悄盖住前一个', () => {
  const build = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
  const order = [...build.match(/const ORDER = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.ok(order.length >= 8, `ORDER 里只有 ${order.length} 个模块`)
  const owners = new Map()
  const clashes = []
  for (const file of order) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    // 顶层声明都顶格写：function/async function/const/let/class。
    for (const match of source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1]
      if (owners.has(name) && owners.get(name) !== file) clashes.push(`${name}（${owners.get(name)} 和 ${file}）`)
      else owners.set(name, file)
    }
  }
  assert.deepEqual(clashes, [])
})

test('sendUserMessage：按队列发一条用户消息；没有会话、被拒绝、抛错都返回原因，用各功能自己的断线文字', async () => {
  const { sendUserMessage } = await import('../src/client/features.js')
  const t = key => `<${key}>`
  const appOf = binding => ({ ctx: { sessions: { binding: () => binding } }, t })
  const calls = []
  const ok = appOf({ session: { prompt: async (content, mode) => { calls.push([content, mode]); return { ok: true } } } })
  assert.equal(await sendUserMessage(ok, 's1', '你好', 'wrap.disconnected'), undefined)
  assert.deepEqual(calls, [[[{ type: 'text', text: '你好' }], 'queue']])
  assert.equal(await sendUserMessage(appOf(undefined), 's1', 'x', 'wrap.disconnected'), '<wrap.disconnected>')
  const refused = appOf({ session: { prompt: async () => ({ ok: false, error: { message: '会话已移除' } }) } })
  assert.equal(await sendUserMessage(refused, 's1', 'x', 'review.disconnected'), '会话已移除')
  const refusedBare = appOf({ session: { prompt: async () => ({ ok: false }) } })
  assert.equal(await sendUserMessage(refusedBare, 's1', 'x', 'review.disconnected'), '<review.disconnected>')
  const thrown = appOf({ session: { prompt: async () => { throw new Error('网络断了') } } })
  assert.equal(await sendUserMessage(thrown, 's1', 'x', 'wrap.disconnected'), '网络断了')
  const thrownString = appOf({ session: { prompt: async () => { throw 'boom' } } })
  assert.equal(await sendUserMessage(thrownString, 's1', 'x', 'review.disconnected'), '<review.disconnected>')
})

test('bundle 的共用作用域里有两个坑：全局 CSS 被 style.js 的 const CSS 盖住，react 里没有 createPortal', () => {
  // 各模块在同一个 factory 里：style.js 的顶层 `const CSS`（样式字符串）盖住浏览器的 CSS 对象，
  // CSS.highlights 取到的是字符串，高亮被静默跳过（查找条 2026-11-06 在真实 App 里才发现）。
  // createPortal 在 react-dom 里，React.createPortal 一渲染就抛错，被 DSH 的插槽边界吞掉。
  const build = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
  assert.match(build, /const ReactDOM = require\('react-dom'\)/)
  const order = [...build.match(/const ORDER = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  const offenders = []
  for (const file of order) {
    if (file === 'src/client/style.js') continue
    const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join('\n')
    if (/\bReact\.createPortal\b/.test(code)) offenders.push(`${file}：React.createPortal，改用 ReactDOM.createPortal`)
    if (/(^|[^.\w$])CSS\.[a-z]/.test(code) || /\btypeof CSS\b/.test(code)) offenders.push(`${file}：直接用全局 CSS，改用 window.CSS`)
  }
  assert.deepEqual(offenders, [])
})

test('C-007 workbenchPathBelow：posix 逐字比较，Windows 盘符和 UNC 不分大小写，末尾分隔符不算一段', async () => {
  const { workbenchPathBelow } = await import('../src/client/features.js')
  assert.deepEqual(workbenchPathBelow('/w/x/', '/w/x/a/b.html'), ['a', 'b.html'])
  assert.deepEqual(workbenchPathBelow('/w/x', '/w/x'), [])
  assert.deepEqual(workbenchPathBelow('/', '/a'), ['a'])
  assert.equal(workbenchPathBelow('/w/x', '/W/x/a'), undefined)
  assert.equal(workbenchPathBelow('/w/x', '/w/xy/a'), undefined)
  assert.deepEqual(workbenchPathBelow('C:\\Work', 'c:/work/Sub'), ['Sub'])
  assert.deepEqual(workbenchPathBelow('C:\\', 'C:\\a'), ['a'])
  assert.deepEqual(workbenchPathBelow('\\\\Server\\Share', '\\\\server\\share\\a'), ['a'])
  assert.equal(workbenchPathBelow('C:\\Work', 'D:\\Work\\a'), undefined)
})

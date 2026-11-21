/**
 * 会话里查找的客户端测试：四个纯函数（文字段收集、匹配、保持当前处、回绕下标）、查找条
 * 位置、快捷键的会话判定，加 applyFind 的注册和撤销。渲染、高亮和真实 ⌘F 由 Claude 装进
 * 桌面端时看（这台机器跑不了模型对话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFind, collectSegments, createFindBarStore, findBar, findMatches, findResolveSession, placeFindBar, pickCurrent, stepIndex,
} from '../src/client/find.js'

// ---------- 假节点树（只用 nodeType、nodeValue、childNodes、getAttribute） ----------

/** 文字节点。 */
const text = value => ({ nodeType: 3, nodeValue: value })

/** 元素节点。 */
function el(tag, attrs = {}, children = []) {
  return {
    nodeType: 1,
    tagName: tag,
    childNodes: children,
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null },
  }
}

// ---------- collectSegments ----------

test('collectSegments：深度优先收集文字节点，空文字不收', () => {
  const root = el('div', {}, [text('你好'), el('p', {}, [text('a'), text('b')]), text('尾')])
  const segments = collectSegments(root)
  assert.deepEqual(segments.map(segment => segment.text), ['你好', 'a', 'b', '尾'])
  assert.deepEqual(segments.map(segment => segment.node.nodeValue), ['你好', 'a', 'b', '尾'])
  assert.deepEqual(segments.map(segment => segment.hiddenUntilFound), [null, null, null, null])
  // 空文字节点不收（匹配不了非空查询，白占段下标）。
  assert.deepEqual(collectSegments(el('div', {}, [text(''), text('x')])).map(segment => segment.text), ['x'])
})

test('collectSegments：跳过 script、style、textarea、input、查找条和输入区的子树', () => {
  const root = el('div', {}, [
    el('script', {}, [text('var x')]),
    el('style', {}, [text('color:red')]),
    el('textarea', {}, [text('草稿')]),
    el('input', { value: '输入' }, []),
    el('div', { 'data-dwb-find-bar': '' }, [text('查找条')]),
    el('div', { 'data-conversation-region': 'composer' }, [el('p', {}, [text('输入区')])]),
    el('p', {}, [text('正文')]),
  ])
  assert.deepEqual(collectSegments(root).map(segment => segment.text), ['正文'])
  // 大小写不同的标签名一样跳过（SVG 里的小写 style 等）。
  assert.deepEqual(collectSegments(el('div', {}, [el('Style', {}, [text('x')]), text('y')])).map(s => s.text), ['y'])
})

test('collectSegments：隐藏子树跳过，hidden="until-found" 的子树收进并记下祖先', () => {
  const root = el('div', {}, [
    el('p', { hidden: '' }, [text('藏')]),
    el('p', { hidden: 'hidden' }, [text('也藏')]),
    el('p', { hidden: 'until-found' }, [text('折叠行'), el('span', {}, [text('里面')])]),
    el('p', { 'aria-hidden': 'true' }, [text('读屏藏')]),
    el('p', { 'aria-hidden': 'false' }, [text('读屏没藏')]),
    text('外面'),
  ])
  const segments = collectSegments(root)
  assert.deepEqual(segments.map(segment => segment.text), ['折叠行', '里面', '读屏没藏', '外面'])
  assert.equal(segments[0].hiddenUntilFound, segments[1].hiddenUntilFound) // 同一个折叠祖先
  assert.equal(segments[1].hiddenUntilFound.tagName, 'p')
  assert.equal(segments[2].hiddenUntilFound, null)
})

test('collectSegments：嵌套的 until-found 记最近的那个祖先', () => {
  const inner = el('span', { hidden: 'until-found' }, [text('里')])
  const outer = el('div', { hidden: 'until-found' }, [inner, text('外层')])
  const segments = collectSegments(el('main', {}, [outer]))
  assert.equal(segments[0].hiddenUntilFound, inner)
  assert.equal(segments[1].hiddenUntilFound, outer)
})

// ---------- findMatches ----------

test('findMatches：不分大小写的子串，一段里多处不重叠，多段按文档顺序', () => {
  const segments = [
    { node: text('登录页的校验'), text: '登录页的校验' },
    { node: text('校验（Validation）函数在 useFieldValidation.ts'), text: '校验（Validation）函数在 useFieldValidation.ts' },
    { node: text('提交时整体校验'), text: '提交时整体校验' },
  ]
  const { matches, capped } = findMatches(segments, '校验')
  assert.equal(capped, false)
  assert.deepEqual(matches.map(match => [match.segmentIndex, match.start, match.end]), [
    [0, 4, 6], [1, 0, 2], [2, 5, 7],
  ])
  assert.deepEqual(matches.map(match => match.node), segments.map(segment => segment.node))
  // 一段里两处：不重叠地从左到右。
  const twice = findMatches([{ node: text('aa'), text: 'aa' }], 'a')
  assert.deepEqual(twice.matches.map(match => [match.start, match.end]), [[0, 1], [1, 2]])
  // 英文不分大小写。
  assert.equal(findMatches([{ node: text('x'), text: 'UseFieldValidation' }], 'FIELDVAL').matches.length, 1)
})

test('findMatches：中文、空查询、空段', () => {
  const segments = [{ node: text('x'), text: '把登录页的表单校验改成边输入边提示' }]
  assert.deepEqual(findMatches(segments, '校验').matches.map(match => [match.start, match.end]), [[7, 9]])
  assert.deepEqual(findMatches(segments, ''), { matches: [], capped: false })
  assert.deepEqual(findMatches([], 'x'), { matches: [], capped: false })
  assert.deepEqual(findMatches(undefined, 'x'), { matches: [], capped: false })
  assert.deepEqual(findMatches([{ node: text(''), text: '' }], 'x').matches, [])
})

test('findMatches：匹配不跨文字节点', () => {
  // 一个词被样式拆成两个节点：搜不到（README 写明的限制）。
  const split = [{ node: text('a'), text: '校' }, { node: text('b'), text: '验' }]
  assert.equal(findMatches(split, '校验').matches.length, 0)
  assert.equal(findMatches(split, '校').matches.length, 1)
})

test('findMatches：toLowerCase 会改长度的字符（İ）不把下标弄错', () => {
  // İ（U+0130）小写成 i 加组合附点两个码位：整串 toLowerCase 会让匹配下标对不回原文。
  const segment = { node: text('n1'), text: 'İstanbul' }
  const { matches } = findMatches([segment], 'İstanbul')
  assert.deepEqual(matches.map(match => [match.start, match.end]), [[0, 8]])
  // 小写形式（带组合附点）也命中同一个原文区间。
  assert.deepEqual(findMatches([segment], 'i̇stanbul').matches.map(match => [match.start, match.end]), [[0, 8]])
  // İ 不等于 i：不带附点的查询不该命中。
  assert.equal(findMatches([segment], 'istanbul').matches.length, 0)
  // 前面有普通字符时下标照样对：高亮区间落在原文 [1, 9)。
  const mixed = { node: text('n2'), text: 'aİb' }
  assert.deepEqual(findMatches([mixed], 'İb').matches.map(match => [match.start, match.end]), [[1, 3]])
})

test('findMatches：总数封顶 5000 并标 capped', () => {
  const segment = { node: text('cap'), text: 'a'.repeat(6000) } // 6000 处「a」
  const { matches, capped } = findMatches([segment], 'a')
  assert.equal(matches.length, 5000)
  assert.equal(capped, true)
  const under = findMatches([segment], 'aa')
  assert.equal(under.capped, false)
  assert.equal(under.matches.length, 3000)
})

// ---------- pickCurrent ----------

/** 造一个匹配。 */
const match = (segmentIndex, start, node) => ({ segmentIndex, start, end: start + 1, node })

test('pickCurrent：同一节点同一偏移还在就取它', () => {
  const node = text('keep')
  const next = [match(0, 0, {}), match(1, 5, node), match(2, 0, {})]
  assert.equal(pickCurrent(match(1, 5, node), next), next[1])
})

test('pickCurrent：同一节点偏移变了取该节点里最近的', () => {
  const node = text('shift')
  const next = [match(0, 0, node), match(0, 7, node), match(3, 100, {})]
  assert.equal(pickCurrent(match(0, 6, node), next), next[1])
})

test('pickCurrent：节点没了取文档顺序里最近的，段下标主导、段内偏移分先后', () => {
  const gone = text('gone')
  const near = match(3, 40, {})
  const next = [match(0, 0, {}), near, match(6, 0, {})]
  // 离段 4 最近的是段 3：段内偏移差 30 不敌段 6 那两段的差距。
  assert.equal(pickCurrent(match(4, 10, gone), next), near)
  const closer = [match(0, 0, {}), match(3, 8, {}), match(3, 44, {})]
  assert.equal(pickCurrent(match(4, 10, gone), closer), closer[1]) // 同段里偏移 8 比 44 近
})

test('pickCurrent：没有匹配给 undefined，没有上一处取第一处', () => {
  const first = match(0, 0, {})
  assert.equal(pickCurrent(match(0, 0, {}), []), undefined)
  assert.equal(pickCurrent(undefined, [first]), first)
  assert.equal(pickCurrent(null, [first]), first)
})

// ---------- stepIndex ----------

test('stepIndex：下一处上一处都回绕，没有匹配给 0', () => {
  assert.equal(stepIndex(0, 3, 1), 1)
  assert.equal(stepIndex(2, 3, 1), 0) // 末尾绕回头
  assert.equal(stepIndex(0, 3, -1), 2) // 开头绕到尾
  assert.equal(stepIndex(1, 3, -1), 0)
  assert.equal(stepIndex(0, 0, 1), 0)
  assert.equal(stepIndex(5, 3, 1), 0) // 下标越界也能给回一个合法值
})

// ---------- placeFindBar ----------

/** 一个矩形。 */
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })

test('placeFindBar：贴对话容器右上角，宽度不超过容器宽减 24', () => {
  // 主对话区（左 200、宽 600，右边到 800）：条离视口右边 1440-800+18。
  assert.deepEqual(placeFindBar(rect(200, 100, 600, 800), 1440), { right: 658, top: 110, maxWidth: 380 })
  // 右侧栏嵌入的窄窗格（约 400 宽）：条收窄到 376，右边到 1400。
  assert.deepEqual(placeFindBar(rect(1000, 60, 400, 700), 1440), { right: 58, top: 70, maxWidth: 376 })
  // 容器贴着视口边上（右边到 1930，超出视口）：right 不小于 4。
  const edge = placeFindBar(rect(1430, 50, 500, 700), 1440)
  assert.equal(edge.right, 4)
  // 极窄的容器（宽 100）：保底 120，输入框收缩。
  assert.equal(placeFindBar(rect(0, 0, 100, 700), 1440).maxWidth, 120)
})

// ---------- findResolveSession ----------

/** 造一个带 closest 的假焦点元素。 */
function targetOf(closest) {
  return { closest: name => closest[name] ?? null }
}

test('findResolveSession：焦点在会话里查那个会话；在查找条里算当前开着的', () => {
  const host = { getAttribute: name => (name === 'data-conversation-session' ? 'embedded-1' : null) }
  const target = targetOf({ '[data-conversation-session]': host })
  assert.equal(findResolveSession(target, {}, undefined), 'embedded-1')
  // 焦点在查找条自己（portal 在 body 上，不在任何会话里）：算当前开着查找条的那个。
  const inBar = targetOf({ '[data-dwb-find-bar]': {} })
  assert.equal(findResolveSession(inBar, {}, 'open-1'), 'open-1')
  assert.equal(findResolveSession(inBar, {}, undefined), undefined)
})

test('findResolveSession：找不到焦点会话回退主对话区的会话；都没有给 undefined（pass）', () => {
  const byId = {
    a: { id: 'a', retainedBy: {} },
    b: { id: 'b', retainedBy: { mainView: 2 } },
  }
  assert.equal(findResolveSession(targetOf({}), byId, undefined), 'b')
  assert.equal(findResolveSession(null, byId, undefined), 'b')
  assert.equal(findResolveSession(targetOf({}), {}, undefined), undefined)
  assert.equal(findResolveSession(targetOf({}), null, undefined), undefined)
})

// ---------- 小 store ----------

test('createFindBarStore：开、换会话重置查询、再开聚焦令牌、关、改查询', () => {
  const store = createFindBarStore()
  const seen = []
  store.subscribe(() => { seen.push({ ...store.getSnapshot() }) })
  store.open('s1')
  assert.deepEqual(store.getSnapshot(), { sessionId: 's1', query: '', focus: 1 })
  store.setQuery('校验')
  store.open('s1') // 已开着：不动查询，只发聚焦令牌
  assert.deepEqual(store.getSnapshot(), { sessionId: 's1', query: '校验', focus: 2 })
  store.open('s2') // 换会话：查询重置
  assert.deepEqual(store.getSnapshot(), { sessionId: 's2', query: '', focus: 3 })
  store.close()
  assert.deepEqual(store.getSnapshot(), { sessionId: undefined, query: '', focus: 3 })
  store.close() // 关着再关不动
  store.setQuery('') // 查询没变不动
  store.open('') // 空 id 不理
  assert.equal(seen.length, 5) // 开、改查询、再开（聚焦）、换会话、关，五次通知
  store.setQuery('x') // 关着也能改查询（不影响：开的时候会重置）
  store.reset()
  assert.deepEqual(store.getSnapshot(), { sessionId: undefined, query: '', focus: 0 })
})

// ---------- applyFind：注册和撤销 ----------

/**
 * 造一个假的客户端上下文：effect 立刻执行并记下撤销函数，注册处都记账。
 * @param {Record<string, object>} byId 会话列表快照里的 byId（快捷键回退主对话区时读）。
 * @returns {{ctx: object, log: object}} 假上下文和记账。
 */
function fakeCtx(byId = {}) {
  const log = { shortcuts: [], slotNames: [], slotDefs: [], disposers: 0 }
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { log.disposers += 1; dispose() } },
    shortcuts: { register(def) { log.shortcuts.push(def); return () => { log.shortcuts.pop() } } },
    slots: {
      inject(name, factory) { log.slotNames.push(name); return factory() },
      register(def) { log.slotDefs.push(def); return () => {} },
    },
    sessions: { list: { getSnapshot: () => ({ byId }) } },
  }
  return { ctx, log }
}

test('applyFind：注册 ⌘F 快捷键和停靠条条目，撤销函数全撤', () => {
  const { ctx, log } = fakeCtx()
  const dispose = applyFind({ ctx, store: {}, t: key => key })
  try {
    assert.deepEqual(log.slotNames, ['conversation.input.dock'])
    const dock = log.slotDefs[0]
    assert.equal(dock.name, 'conversation.input.dock')
    assert.equal(dock.id, 'dsh-workbench-find')
    // 快捷键：id、三个桌面端的默认键位（网页端不接受 Mod+F，不声明 web 默认）。
    assert.equal(log.shortcuts.length, 1)
    const shortcut = log.shortcuts[0]
    assert.equal(shortcut.id, 'dsh-workbench.find')
    assert.equal(shortcut.label(), 'find.shortcut')
    assert.deepEqual(shortcut.aliases, [])
    assert.deepEqual(shortcut.defaults, {
      'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
    })
  } finally {
    dispose()
  }
  assert.equal(log.shortcuts.length, 0)
  assert.equal(log.disposers, 2) // 快捷键和停靠条条目两个 effect（样式不走 effect，也在同一批撤销里）
})

test('applyFind 的 resolve：焦点会话、主对话区回退、没有对话三种情况', async () => {
  const byId = { main: { id: 'main', retainedBy: { mainView: 1 } } }
  const { ctx, log } = fakeCtx(byId)
  const dispose = applyFind({ ctx, store: {}, t: key => key })
  try {
    const { resolve } = log.shortcuts[0]
    // 焦点在一个嵌入的会话里：handled，run 打开那个会话的查找条。
    const host = { getAttribute: name => (name === 'data-conversation-session' ? 'embedded-1' : null) }
    const inConversation = resolve({ target: targetOf({ '[data-conversation-session]': host }) })
    assert.equal(inConversation.status, 'handled')
    assert.equal(typeof inConversation.run, 'function')
    inConversation.run()
    assert.equal(findBar.getSnapshot().sessionId, 'embedded-1')
    // 焦点不在任何会话里：回退主对话区的会话。
    const fallback = resolve({ target: targetOf({}) })
    assert.equal(fallback.status, 'handled')
    fallback.run()
    assert.equal(findBar.getSnapshot().sessionId, 'main')
    assert.equal(findBar.getSnapshot().query, '') // 换会话重置查询
    // 页面里没有对话（面板页）：主对话区也没有会话时 pass。
    ctx.sessions.list.getSnapshot = () => ({ byId: {} })
    assert.deepEqual(resolve({ target: null }), { status: 'pass' })
  } finally {
    dispose()
  }
})

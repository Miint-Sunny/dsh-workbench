/**
 * 轮次导航（dsh-workbench/turn-nav）：行的报到，加载时查 DSH 的样式，打开对话时查轮次导航的结构，
 * 以及这一行生没生效的状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/turn-nav.js'
import { enabledFeatures, FEATURE_META } from '../lib/features.js'
import {
  turnNavStyleMatches, turnNavPreviewPlaceMatches, turnNavCheck, createTurnNavStatus,
  TURN_NAV_GROW, turnNavNear, turnNavGeometry, turnNavIndexAt, turnNavCount, turnNavReveal, turnNavKeyTarget, turnNavTurnMatcher,
  TURN_NAV_BOOKMARK_KEY, turnNavBookmarksFrom, turnNavToggleBookmark, createTurnNavBookmarks, turnNavBookmarkCss,
} from '../src/client/turn-nav-model.js'

/** DSH 0.2.2-rc.2 轮次导航样式表（与 rc.1 相同）里这一行要靠的两条：槽是宽度容器，槽内窄于 900 时把轨道藏起来。 */
const DSH_STYLE = '._4if9eW_slot{z-index:7;height:0;padding-inline:calc(var(--dsh-composer-side-clearance) + 16px);pointer-events:none;position:absolute;top:0;left:0;right:0;container-type:inline-size}'
  + '._4if9eW_frame{width:28px;position:absolute;right:12px}'
  + '@container (width<=900px){._4if9eW_frame{display:none}}'

/** DSH 0.2.2-rc.2 预览卡片那条规则（与 rc.1 相同）里和定位有关的几项：上边按 `--turn-preview-center` 算，高度按 100 算。 */
const DSH_PREVIEW = '._4if9eW_preview{top:clamp(0px, calc(var(--turn-preview-center) - var(--turn-preview-height) / 2), calc(100% - var(--turn-preview-height)));max-height:var(--turn-preview-height);transition:top .14s cubic-bezier(.2,.8,.2,1);position:absolute;right:calc(100% + 10px)}'

test('加载时：DSH 的预览卡片还按 --turn-preview-center 定上边，才改卡片的定位', () => {
  assert.equal(turnNavPreviewPlaceMatches(DSH_STYLE + DSH_PREVIEW), true)
  assert.equal(turnNavPreviewPlaceMatches(DSH_STYLE + DSH_PREVIEW.replaceAll('--turn-preview-center', '--turn-preview-middle')), false, '变量改了名')
  assert.equal(turnNavPreviewPlaceMatches(DSH_STYLE + DSH_PREVIEW.replace('top:clamp(', 'translate:0 clamp(')), false, '卡片不再用上边定位')
  assert.equal(turnNavPreviewPlaceMatches(null), false, '样式表不在了')
})

test('轮次导航行只向功能登记处报到，不用模型的服务；卸载时除名', () => {
  const disposers = []
  const ctx = new Proxy({ effect: fn => { const stop = fn(); disposers.push(stop); return stop } }, {
    get: (target, key) => { assert(key in target, `unexpected service ${String(key)}`); return target[key] },
  })
  apply(ctx)
  assert.equal(enabledFeatures().find(feature => feature.id === 'turn-nav')?.title, '轮次导航')
  for (const stop of disposers) stop()
  assert(!enabledFeatures().some(feature => feature.id === 'turn-nav'))
})

test('插件页的行标题和说明与功能登记处一致', () => {
  const zh = JSON.parse(readFileSync(new URL('../locale/turn-nav/zh.json', import.meta.url), 'utf8')).meta
  assert.deepEqual(zh, { title: FEATURE_META['turn-nav'].title, description: FEATURE_META['turn-nav'].description })
  const en = JSON.parse(readFileSync(new URL('../locale/turn-nav/en.json', import.meta.url), 'utf8')).meta
  assert.equal(en.title, 'Turn navigation')
})

test('加载时：DSH 的轮次导航样式还是「槽按宽度、窄了就藏」才算对得上', () => {
  assert.equal(turnNavStyleMatches(DSH_STYLE), true)
  assert.equal(turnNavStyleMatches(DSH_STYLE.replace('container-type:inline-size', '')), false, '槽不再是宽度容器')
  assert.equal(turnNavStyleMatches(DSH_STYLE.replace('@container (width<=900px)', '@media (width<=900px)')), false, '改成按窗口宽度藏')
  assert.equal(turnNavStyleMatches(null), false, '样式表不在了')
})

/** 在 DSH 对话页上读到的事实：主区会话、对话页、看得见的轮数、那条 nav。 */
const seen = (patch = {}) => ({
  main: true, scroll: true, flow: true, turns: 25, label: '轮次导航',
  nav: { label: '轮次导航', container: 'inline-size', matches: true },
  ...patch,
})

test('对话页的轮次导航结构对得上：生效', () => {
  assert.deepEqual(turnNavCheck(seen()), { state: 'ok' })
})

test('对话页有两轮以上却找不到轮次导航，或者它变了样：没生效，说出是哪一处', () => {
  assert.deepEqual(turnNavCheck(seen({ nav: null })), { state: 'mismatch', reason: 'nav' })
  assert.deepEqual(turnNavCheck(seen({ nav: { label: 'chat.turnNavigation.label', container: 'inline-size', matches: true } })), { state: 'mismatch', reason: 'nav' }, '名字对不上 DSH 的词典')
  assert.deepEqual(turnNavCheck(seen({ nav: { label: '轮次导航', container: 'inline-size', matches: false } })), { state: 'mismatch', reason: 'nav' }, '样式选择器选不中它')
  assert.deepEqual(turnNavCheck(seen({ nav: { label: '轮次导航', container: 'normal', matches: true } })), { state: 'mismatch', reason: 'container' })
  assert.deepEqual(turnNavCheck(seen({ main: false })), { state: 'mismatch', reason: 'slot' }, '主区的会话不在 main.conversation 插槽里')
  assert.deepEqual(turnNavCheck(seen({ scroll: false })), { state: 'mismatch', reason: 'slot' })
})

test('看不出来的时候不下结论：别的页、还不到两轮', () => {
  assert.deepEqual(turnNavCheck(seen({ flow: false, nav: null })), { state: 'none' }, '气泡页、轨迹页这些不是对话页')
  assert.deepEqual(turnNavCheck(seen({ turns: 1, nav: null })), { state: 'none' })
  assert.deepEqual(turnNavCheck(seen({ turns: 0, nav: null })), { state: 'none' })
})

test('生效状态：只有结论变了才通知；看不出来的结果不改状态', () => {
  const status = createTurnNavStatus()
  const heard = []
  status.subscribe(() => heard.push(status.getSnapshot()))
  assert.deepEqual(status.getSnapshot(), { state: 'waiting' })
  status.report({ state: 'none' })
  assert.deepEqual(heard, [])
  status.report({ state: 'ok' })
  status.report({ state: 'ok' })
  assert.deepEqual(heard, [{ state: 'ok' }])
  status.report({ state: 'mismatch', reason: 'nav' })
  status.report({ state: 'mismatch', reason: 'nav' })
  assert.deepEqual(heard, [{ state: 'ok' }, { state: 'mismatch', reason: 'nav' }])
  status.reset()
  assert.deepEqual(status.getSnapshot(), { state: 'waiting' })
})

// ---------- 第二步：放大、拖动、键盘 ----------

test('指着的那根放大，上下三根跟着：只给距离 0 到 3 的刻度标档位', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => turnNavNear(index, 5)), [undefined, 3, 2, 1, 0, 1, 2, 3, undefined])
  assert.deepEqual([0, 1, 2, 3, 4].map(index => turnNavNear(index, 0)), [0, 1, 2, 3, undefined])
  assert.equal(turnNavNear(5, -1), undefined, '没有指着的刻度')
  assert.deepEqual(TURN_NAV_GROW, [1.3, 1.1, 0.9, 0.7], '样稿的数值：DSH 20 像素的刻度上 26、22、18、14')
})

test('从画出来的刻度量出间距和起点；间距不一致就不量', () => {
  assert.deepEqual(turnNavGeometry([{ index: 12, top: 121 }, { index: 13, top: 131 }, { index: 20, top: 201 }]), { pitch: 10, inset: 1 })
  assert.equal(turnNavGeometry([{ index: 3, top: 31 }]), undefined, '只有一根')
  assert.equal(turnNavGeometry([{ index: 3, top: 31 }, { index: 4, top: 41 }, { index: 5, top: 57 }]), undefined, '不是等间距')
})

test('拖动时按指针的高度算第几根，超出两头就停在第一根、最后一根', () => {
  const geometry = { pitch: 10, inset: 1 }
  assert.equal(turnNavIndexAt(1, geometry, 40), 0)
  assert.equal(turnNavIndexAt(10.9, geometry, 40), 0)
  assert.equal(turnNavIndexAt(11, geometry, 40), 1)
  assert.equal(turnNavIndexAt(-300, geometry, 40), 0)
  assert.equal(turnNavIndexAt(9000, geometry, 40), 39)
  assert.equal(turnNavCount(402, geometry), 40, 'DSH 的轨道高 = 两头各 1 加 40 根乘 10')
})

test('刻度移进轨道里不淡出的那一段：已经在里面就不动，挪得最少', () => {
  const geometry = { pitch: 10, inset: 1 }
  const view = { scrollTop: 100, height: 200, total: 3002 }
  assert.equal(turnNavReveal(15, view, geometry), undefined, '中心 156 在 124 到 276 之间')
  assert.equal(turnNavReveal(5, view, geometry), 56 - 24, '上面淡出带里：中心 56 放到离顶 24')
  assert.equal(turnNavReveal(40, view, geometry), 406 - 200 + 24, '下面淡出带外：中心 406 放到离底 24')
  assert.equal(turnNavReveal(0, { scrollTop: 0, height: 200, total: 3002 }, geometry), undefined)
  assert.equal(turnNavReveal(299, view, geometry), 2802, '不滚过头')
})

test('上下方向键挪一根，Home、End 到两头，PageUp、PageDown 挪十根，不出界', () => {
  assert.equal(turnNavKeyTarget('ArrowUp', 5, 40), 4)
  assert.equal(turnNavKeyTarget('ArrowDown', 5, 40), 6)
  assert.equal(turnNavKeyTarget('ArrowUp', 0, 40), 0)
  assert.equal(turnNavKeyTarget('ArrowDown', 39, 40), 39)
  assert.equal(turnNavKeyTarget('Home', 5, 40), 0)
  assert.equal(turnNavKeyTarget('End', 5, 40), 39)
  assert.equal(turnNavKeyTarget('PageUp', 5, 40), 0)
  assert.equal(turnNavKeyTarget('PageDown', 5, 40), 15)
  assert.equal(turnNavKeyTarget('Enter', 5, 40), undefined, '回车留给 DSH 自己跳')
  assert.equal(turnNavKeyTarget('a', 5, 40), undefined)
})

test('照 DSH 词典的刻度名字取出轮次号：「跳转到第 N 轮」认已加载的，「加载并跳转到第 N 轮」认没加载的', () => {
  const loaded = turnNavTurnMatcher('跳转到第 \u0000 轮', '\u0000')
  const unloaded = turnNavTurnMatcher('加载并跳转到第 \u0000 轮', '\u0000')
  assert.equal(loaded('跳转到第 12 轮'), 12)
  assert.equal(loaded('加载并跳转到第 12 轮'), undefined)
  assert.equal(unloaded('加载并跳转到第 12 轮'), 12)
  assert.equal(unloaded('跳转到第 12 轮'), undefined)
  assert.equal(loaded('跳转到第 轮'), undefined)
  const english = turnNavTurnMatcher('Jump to turn \u0000', '\u0000')
  assert.equal(english('Jump to turn 7'), 7)
  assert.equal(english('Load and jump to turn 7'), undefined)
  assert.equal(turnNavTurnMatcher('chat.turnNavigation.jump', '\u0000')('跳转到第 12 轮'), undefined, '词条没了：认不出，拖动时就不跳，也加不了书签')
})

// ---------- 书签 ----------

/** 一个够用的 localStorage：能读能写，也能模拟被禁用。 */
const memoryStorage = () => {
  const map = new Map()
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)) } }
}

test('书签按会话记轮次号；坏的、不认识的内容读成没有书签', () => {
  assert.deepEqual(turnNavBookmarksFrom(JSON.stringify({ s1: [3, 12], s2: [7] })), { s1: [3, 12], s2: [7] })
  assert.deepEqual(turnNavBookmarksFrom(null), {})
  assert.deepEqual(turnNavBookmarksFrom('{broken'), {})
  assert.deepEqual(turnNavBookmarksFrom(JSON.stringify([1, 2])), {}, '不是按会话记的')
  assert.deepEqual(turnNavBookmarksFrom(JSON.stringify({ s1: [3, 'x', -1, 2.5, 3], s2: 'no', s3: [] })), { s1: [3] }, '只留正整数，去重，空的不留')
})

test('加书签、去书签：同一轮再切一次就去掉，会话没有书签了就不留空的', () => {
  const one = turnNavToggleBookmark({}, 's1', 12)
  assert.deepEqual(one, { s1: [12] })
  const two = turnNavToggleBookmark(one, 's1', 3)
  assert.deepEqual(two, { s1: [3, 12] })
  assert.deepEqual(turnNavToggleBookmark(two, 's2', 12), { s1: [3, 12], s2: [12] }, '各会话各记各的')
  assert.deepEqual(turnNavToggleBookmark(two, 's1', 12), { s1: [3] })
  assert.deepEqual(turnNavToggleBookmark({ s1: [3] }, 's1', 3), {})
  assert.deepEqual(one, { s1: [12] }, '不改原来的')
})

test('书签存进浏览器本地；存储不可用时只在这个页面里记着', () => {
  const storage = memoryStorage()
  const bookmarks = createTurnNavBookmarks(() => storage)
  let heard = 0
  bookmarks.subscribe(() => { heard += 1 })
  bookmarks.toggle('s1', 12)
  assert.equal(bookmarks.has('s1', 12), true)
  assert.equal(heard, 1)
  assert.deepEqual(JSON.parse(storage.getItem(TURN_NAV_BOOKMARK_KEY)), { s1: [12] })
  assert.equal(createTurnNavBookmarks(() => storage).has('s1', 12), true, '另一个窗口读到同一份')
  storage.setItem(TURN_NAV_BOOKMARK_KEY, JSON.stringify({ s1: [5] }))
  bookmarks.reload()
  assert.deepEqual(bookmarks.getSnapshot(), { s1: [5] })
  const blocked = createTurnNavBookmarks(() => { throw new Error('storage disabled') })
  assert.deepEqual(blocked.getSnapshot(), {})
  blocked.toggle('s1', 2)
  assert.equal(blocked.has('s1', 2), true)
})

test('书签的样式只给加了书签的轮次写规则，按刻度名字选，会话 id 和名字里的引号、反斜杠都转义', () => {
  const labels = { loaded: turn => `跳转到第 ${turn} 轮`, unloaded: turn => `加载并跳转到第 ${turn} 轮` }
  assert.equal(turnNavBookmarkCss({}, labels), '')
  const css = turnNavBookmarkCss({ 's"1': [12] }, labels)
  assert.match(css, /\[data-conversation-session="s\\"1"\]/)
  assert.match(css, /button\[aria-label="跳转到第 12 轮"\]/)
  assert.match(css, /button\[aria-label="加载并跳转到第 12 轮"\]/)
  assert.doesNotMatch(css, /第 3 轮/)
  const odd = turnNavBookmarkCss({ s1: [1] }, { loaded: () => 'a"b\\c', unloaded: () => 'x' })
  assert.match(odd, /aria-label="a\\"b\\\\c"/)
})

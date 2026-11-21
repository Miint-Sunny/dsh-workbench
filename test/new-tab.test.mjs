import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupNewTabEntries, readNewTabLayout, writeNewTabLayout, readNewTabEntries,
  NEW_TAB_DEFAULT_PINS, newTabEntryPin, addNewTabPin, removeNewTabPin, moveNewTabPin, readNewTabPins, createNewTabPinStore,
  guideTabShouldClose, NEW_TAB_SPLIT_ICON, newTabSplitCss,
} from '../src/client/new-tab-model.js'
import { apply } from '../lib/new-tab.js'
import { enabledFeatures } from '../lib/features.js'

const entry = (kind, order = 0) => ({ id: kind, providerId: kind, kind, order, title: () => kind })
test('已知入口分组、未知入口进其他，组内按 order 且不改动来源列表', () => {
  const entries = [entry('other-addon', 0), entry('git', 20), entry('files', 10), entry('wbmcp'), entry('sidechat'), entry('wbsplit'), entry('wbcontext')]
  const result = groupNewTabEntries(entries, 'list')
  assert.deepEqual(result.groups.map(g => [g.id, g.entries.map(e => e.kind)]), [
    ['workspace', ['files', 'git']], ['conversation', ['sidechat', 'wbsplit']], ['inspect', ['wbcontext']], ['settings', ['wbmcp']], ['other', ['other-addon']],
  ])
  assert.deepEqual(entries.map(e => e.kind), ['other-addon', 'git', 'files', 'wbmcp', 'sidechat', 'wbsplit', 'wbcontext'])
})
test('官方的代码审查和变更归到工作区', () => {
  const { groups } = groupNewTabEntries([entry('git', 10), entry('forge-panel', 20), entry('browser', 30)], 'list')
  assert.deepEqual(groups.map(g => [g.id, g.entries.map(e => e.kind)]), [['workspace', ['git', 'forge-panel', 'browser']]])
})
test('审阅（wbreview）归到工作区，排在官方的代码审查和变更前面；原来的本地审查页不再单列', () => {
  const { groups } = groupNewTabEntries([entry('forge-panel', 20), entry('wbreview', 15), entry('git', 10), entry('wbcontext')], 'list')
  assert.deepEqual(groups.map(g => [g.id, g.entries.map(e => e.kind)]), [['workspace', ['git', 'wbreview', 'forge-panel']], ['inspect', ['wbcontext']]])
  assert.deepEqual(groupNewTabEntries([entry('wblocalreview')], 'list').groups.map(g => g.id), ['other'])
})
test('默认置顶只看四个固定入口，扩展归对话组，不在普通行重复', () => {
  const base = [entry('sidechat'), entry('browser'), entry('git'), entry('files'), entry('subagent')]
  const extra = [entry('addon-a'), entry('addon-b')]
  const result = groupNewTabEntries([...base, ...extra], 'common', NEW_TAB_DEFAULT_PINS, kind => kind.startsWith('addon-'))
  assert.deepEqual(result.favorites.map(({ entry }) => entry.kind), ['files', 'git', 'browser', 'sidechat'])
  assert.deepEqual(result.groups.find(group => group.id === 'conversation').entries.map(row => row.kind), ['subagent', 'addon-a', 'addon-b'])
  assert.equal(result.hidden, 0)
  assert.equal(groupNewTabEntries([entry('files')], 'common').hidden, 3)
})

test('可置顶任意注册入口，取消后回到原组，列表与两列不抽出置顶', () => {
  const files = entry('files')
  const terminal = entry('terminal')
  const extra = entry('addon')
  let pins = addNewTabPin(NEW_TAB_DEFAULT_PINS, newTabEntryPin(terminal))
  pins = addNewTabPin(pins, newTabEntryPin(extra))
  const result = groupNewTabEntries([terminal, extra, files], 'common', pins)
  assert.deepEqual(result.favorites.map(({ entry }) => entry.kind), ['files', 'terminal', 'addon'])
  assert.deepEqual(result.groups, [])
  pins = removeNewTabPin(pins, newTabEntryPin(terminal))
  assert.equal(groupNewTabEntries([terminal, extra], 'common', pins).groups[0].entries[0], terminal)
  for (const layout of ['list', 'columns']) {
    const view = groupNewTabEntries([terminal, extra, files], layout, pins)
    assert.equal(view.favorites.length, 0)
    assert.equal(view.groups.flatMap(group => group.entries).length, 3)
  }
  assert.deepEqual(groupNewTabEntries([terminal, extra, files], 'common', []).favorites, [])
})

test('最多八个，暂不可用的入口也占名额，排序保留它们', () => {
  const extras = ['a', 'b', 'c', 'd', 'e'].map(kind => entry(kind))
  let pins = extras.slice(0, 4).reduce((current, row) => addNewTabPin(current, newTabEntryPin(row)), NEW_TAB_DEFAULT_PINS)
  assert.equal(pins.length, 8)
  const blocked = addNewTabPin(pins, newTabEntryPin(extras[4]))
  assert.equal(blocked, pins)
  const view = groupNewTabEntries([entry('files'), entry('git'), ...extras.slice(2)], 'common', pins)
  assert.equal(view.hidden, 4)
  assert.equal(view.favorites.length, 4)
  pins = moveNewTabPin(pins, 'files', newTabEntryPin(extras[2]))
  assert.deepEqual(groupNewTabEntries([entry('files'), entry('git'), ...extras.slice(2)], 'common', pins)
    .favorites.map(({ entry }) => entry.kind), ['git', 'c', 'files', 'd'])
  assert.equal(moveNewTabPin(pins, 'files', 'absent'), pins)
  assert.equal(addNewTabPin(['files'], newTabEntryPin(entry('files'))).length, 1)
})

test('置顶存储拒绝未知裸 ID 和坏数据，保留已记录但暂时不可用的注册身份', () => {
  for (const stored of ['broken', '["unknown-entry"]', '["files","files"]', '{"pins":[]}']) {
    assert.deepEqual(readNewTabPins(() => ({ getItem: () => stored })), NEW_TAB_DEFAULT_PINS)
  }
  const key = newTabEntryPin(entry('addon'))
  let stored
  const storage = () => ({ getItem: () => stored, setItem: (_key, value) => { stored = value } })
  const first = createNewTabPinStore(storage)
  let changes = 0
  const off = first.subscribe(() => changes++)
  first.update(pins => addNewTabPin(pins, key))
  assert.equal(changes, 1)
  assert.deepEqual(readNewTabPins(storage), [...NEW_TAB_DEFAULT_PINS, key])
  const resumed = createNewTabPinStore(storage)
  assert.equal(groupNewTabEntries([entry('files')], 'common', resumed.getSnapshot()).hidden, 4)
  resumed.update(() => [])
  first.reload()
  assert.deepEqual(first.getSnapshot(), [])
  assert.equal(changes, 2)
  off()
  const denied = createNewTabPinStore(() => { throw Error('denied') })
  denied.update(() => [])
  assert.deepEqual(denied.getSnapshot(), [])
})

test('升级前置顶的本地审查由审阅接替，沿用位置且只占一个名额', () => {
  const legacy = { kind: 'wblocalreview', providerId: 'dsh-workbench-local-review', id: 'local-review' }
  const review = { kind: 'wbreview', providerId: 'dsh-workbench-review-panel', id: 'review' }
  const getItem = () => JSON.stringify(['files', newTabEntryPin(legacy), 'git', newTabEntryPin(review)])
  const pins = readNewTabPins(() => ({ getItem }))
  const { favorites, hidden } = groupNewTabEntries([entry('files'), entry('git'), review], 'common', pins)
  assert.deepEqual(favorites.map(({ entry }) => entry.kind), ['files', 'wbreview', 'git'])
  assert.equal(hidden, 0)
})

test('存储无法读取或写入时仍可用默认版式，无效值不进入界面', () => {
  const denied = () => { throw Error('denied') }
  assert.equal(readNewTabLayout(denied), 'common')
  assert.doesNotThrow(() => writeNewTabLayout('list', denied))
  assert.equal(readNewTabLayout(() => ({ getItem: () => 'obsolete' })), 'common')
  let saved
  const storage = () => ({ getItem: () => saved, setItem: (_key, value) => { saved = value } })
  writeNewTabLayout('columns', storage)
  assert.equal(readNewTabLayout(storage), 'columns')
})
test('入口读取失败时 chain selector 拒绝接管，让官方页保留', () => {
  assert.equal(readNewTabEntries({ guide: () => { throw Error('unavailable') } }), null)
  assert.equal(readNewTabEntries({ guide: () => undefined }), null)
  assert.deepEqual(readNewTabEntries({ guide: () => [] }), [])
})
test('新行仅登记可撤销界面能力，不访问工具、提示词或预设', () => {
  const disposers = []
  apply(new Proxy({ effect: fn => { const off = fn(); disposers.push(off); return off } }, { get(target, key) { assert(key in target, String(key)); return target[key] } }))
  assert(enabledFeatures().some(f => f.id === 'new-tab'))
  for (const off of disposers) off()
  assert(!enabledFeatures().some(f => f.id === 'new-tab'))
})

test('新标签页不在最前面就关掉，官方只在格里没有引导页时才画加号', () => {
  assert.equal(guideTabShouldClose({ visible: true, selected: 'false' }), true)
  assert.equal(guideTabShouldClose({ visible: true, selected: 'true' }), false)
})
test('右侧栏收起或会话在后台时不关，看不出是不是在最前面就不动', () => {
  assert.equal(guideTabShouldClose({ visible: false, selected: 'false' }), false)
  assert.equal(guideTabShouldClose({ visible: true, selected: null }), false)
  assert.equal(guideTabShouldClose({ visible: true, selected: undefined }), false)
})

test('换分栏图标：藏官方图标和画新图标两条规则挂在同一个官方标记上，少一条按钮就是空的或叠两个', () => {
  const rules = [...newTabSplitCss().matchAll(/([^{}\n]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }))
  assert.deepEqual(rules.map(rule => rule.selector), ['[data-dockkit-split-button]>svg', '[data-dockkit-split-button]::before'])
  assert.match(rules[0].body, /display:none/)
  // 新图标跟着按钮的颜色走（置灰、指着时不用另写），大小和官方按钮里的图标一样。
  assert.match(rules[1].body, /background:currentColor/)
  assert.match(rules[1].body, /width:15px;height:15px/)
  for (const property of ['-webkit-mask', 'mask']) assert.match(rules[1].body, new RegExp(`(?:^|;)${property}:url\\("data:image/svg\\+xml,`))
})

test('换分栏图标：样式里带的就是那张图，图画在 16 格里', () => {
  const [, encoded] = /mask:url\("data:image\/svg\+xml,([^"]+)"\)/.exec(newTabSplitCss())
  assert.equal(decodeURIComponent(encoded), NEW_TAB_SPLIT_ICON)
  assert.match(NEW_TAB_SPLIT_ICON, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16" fill="none" stroke="#000">(?:<path d="[^"]+"\/>)+<\/svg>$/)
  const numbers = [...NEW_TAB_SPLIT_ICON.matchAll(/d="([^"]+)"/g)].flatMap(([, d]) => d.match(/-?\d+(?:\.\d+)?/g).map(Number))
  assert(numbers.length > 0)
  assert(numbers.every(n => n >= 0 && n <= 16), `有坐标画出了 16 格：${numbers.filter(n => n < 0 || n > 16)}`)
})


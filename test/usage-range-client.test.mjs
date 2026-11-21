/** 用量页左侧汇总跟随范围：替身 React 里挂载构建好的 UsagePage，数据是合成的（test/fixtures/usage/page-data.mjs）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pageOverview } from './fixtures/usage/page-data.mjs'
import { mountUsagePage, usageTranslator, USAGE_EN } from './usage-page-harness.mjs'
import { textOf } from './react-harness.mjs'
import { usageTokens, usageMoney, usageCount } from '../src/client/usage-model.js'

const t = usageTranslator()
const RANGE_KEY = 'dsh-workbench.usage.range'
const DETAILS_KEY = 'dsh-workbench.usage.details'
const data = pageOverview()

const byClass = (react, name) => react.all(node => typeof node.props.className === 'string' && node.props.className.split(' ').includes(name))
const tabs = (react, which) => react.one(node => node.type === 'ui.SegmentedTabs' && node.props.className.includes(`dwb-us-seg-${which}`), `${which} 范围标签`)
const choose = async (react, range) => { tabs(react, 'narrow').props.onChange(range); await react.settle() }
const head = react => {
  const root = react.one(node => node.props.className === 'dwb-us-head')
  const stack = react.all(node => node.props.className?.startsWith('dwb-us-stack') && root.contains(node))[0]
  return {
    hero: textOf(byClass(react, 'dwb-us-hero')[0]),
    caption: textOf(root.children.find(child => typeof child !== 'string' && child.children.some(grand => typeof grand !== 'string' && grand.props.className === 'dwb-us-cap')).children[1]),
    legend: textOf(byClass(react, 'dwb-us-legend')[0]),
    counts: byClass(react, 'dwb-us-grid3')[0].children.map(textOf),
    flex: stack.children.map(part => part.props.style.flex),
    stackClass: stack.props.className,
  }
}
const headersIn = section => { const found = []; const walk = node => { if (typeof node === 'string') return; if (node.type === 'header') found.push(node); node.children.forEach(walk) }; walk(section); return found }
const factNames = react => byClass(react, 'dwb-us-hstats')[0].children.map(item => textOf(item.children[0]))
const summaryOf = range => (range === 'all' ? data.life : data.ranges[range])

test('左侧汇总：大数、说明、构成条图例和六个计数都跟着所选范围，「全部」是累计', async () => {
  const { react } = await mountUsagePage(data)
  for (const range of ['today', '24h', '7d', '30', '365', 'all']) {
    await choose(react, range)
    const summary = summaryOf(range)
    const shown = head(react)
    assert.equal(shown.hero, `${usageTokens(summary.tokens)} token`, range)
    assert.equal(shown.caption, range === 'all'
      ? `${data.life.first} 起累计 · 估算费用 ${usageMoney(data.life.c)}`
      : `${t(`usage.chart.title.${range}`)} · 估算费用 ${usageMoney(summary.c)}`, range)
    const total = summary.rd + summary.input + summary.out
    assert.equal(shown.legend, `缓存读取 ${(summary.rd / total * 100).toFixed(1)}%未缓存输入 ${(summary.input / total * 100).toFixed(1)}%输出 ${(summary.out / total * 100).toFixed(1)}%`, range)
    assert.deepEqual(shown.counts, [['sessions', 'sessions'], ['turns', 'turns'], ['req', 'req'], ['tools', 'tools'], ['comp', 'comp'], ['retries', 'retries']].map(([key, label]) => `${usageCount(summary[key])}${t(`usage.stat.${label === 'req' ? 'requests' : label === 'comp' ? 'compactions' : label}`)}`), range)
  }
})

test('说明的英文：范围用 usage.hero.range，累计用 usage.hero.total', async () => {
  const { react } = await mountUsagePage(data, { dictionary: USAGE_EN })
  await choose(react, '7d')
  assert.equal(head(react).caption, `Past 7 days · estimated cost ${usageMoney(data.ranges['7d'].c)}`)
  await choose(react, 'all')
  assert.equal(head(react).caption, `Since ${data.life.first} · estimated cost ${usageMoney(data.life.c)}`)
})

test('范围状态由页面持有：窄布局的标签和图里的标签共用一个值，id 不同，选择记在这台机器上', async () => {
  const store = {}
  const { react } = await mountUsagePage(data, { store })
  const narrow = tabs(react, 'narrow')
  const wide = tabs(react, 'wide')
  assert.deepEqual(wide.props.items.map(item => item.value), narrow.props.items.map(item => item.value))
  assert.equal(new Set([...narrow.props.items, ...wide.props.items].map(item => item.id)).size, 12)
  assert.equal(narrow.props.value, '30', '默认范围')
  wide.props.onChange('24h')
  await react.settle()
  assert.equal(tabs(react, 'narrow').props.value, '24h')
  assert.equal(tabs(react, 'wide').props.value, '24h')
  assert.equal(store[RANGE_KEY], '24h')
  assert.equal(head(react).hero, `${usageTokens(data.ranges['24h'].tokens)} token`)
  const again = await mountUsagePage(data, { store })
  assert.equal(tabs(again.react, 'narrow').props.value, '24h', '重新打开时还是上次的范围')
})

test('范围里没有用量：三个比例是破折号，构成条是空的，计数是 0', async () => {
  const idle = pageOverview({ idleDays: 10 })
  assert.equal(idle.ranges['7d'].tokens, 0)
  assert.ok(idle.ranges['30'].tokens > 0)
  const { react } = await mountUsagePage(idle)
  await choose(react, '7d')
  const shown = head(react)
  assert.equal(shown.hero, '0 token')
  assert.equal(shown.caption, `过去 7 天 · 估算费用 ${usageMoney(0)}`)
  assert.equal(shown.legend, '缓存读取 —未缓存输入 —输出 —')
  assert.deepEqual(shown.flex, [], '构成条里没有任何一段')
  assert.equal(shown.stackClass, 'dwb-us-stack dwb-us-stack-empty')
  assert.deepEqual(shown.counts.map(text => text.replace(/\D+$/, '')), ['0', '0', '0', '0', '0', '0'])
})

test('第一张图没有标题行：范围名、合计在左侧汇总里，区块保留同名的可访问名称；第二张图的标题行不变', async () => {
  const { react } = await mountUsagePage(data, { store: { [DETAILS_KEY]: '1' } })
  for (const range of ['today', '30', 'all']) {
    await choose(react, range)
    const [top, second] = byClass(react, 'dwb-us-chart')
    assert.equal(top.props['aria-label'], range === 'all' ? t('usage.chart.title.all', { day: data.life.first }) : t(`usage.chart.title.${range}`), range)
    assert.deepEqual(headersIn(top), [], `${range} 没有标题行`)
    assert.equal(headersIn(second).length, 1, '第二张图的标题行还在')
    assert.equal(textOf(headersIn(second)[0].children[0]).startsWith(t('usage.chart.title.today')), true)
  }
})

test('没有选中时第一张图下面的数字：去掉合计 token、费用和模型请求，其余保留', async () => {
  const { react } = await mountUsagePage(data)
  const expected = {
    today: ['usage.chart.vsMedian', 'usage.chart.activeHours', 'usage.chart.peakHour'],
    '24h': ['usage.chart.vsMedian', 'usage.chart.activeHours', 'usage.chart.peakHour'],
    '7d': ['usage.life.active', 'usage.chart.activeHours', 'usage.chart.medianHour', 'usage.chart.peakHour'],
    30: ['usage.life.active', 'usage.life.streak', 'usage.life.longest', 'usage.life.median', 'usage.life.peak', 'usage.life.busy'],
    365: ['usage.life.active', 'usage.life.streak', 'usage.life.longest', 'usage.life.median', 'usage.life.peak', 'usage.life.busy'],
    all: ['usage.life.active', 'usage.life.streak', 'usage.life.longest', 'usage.life.median', 'usage.life.peak', 'usage.life.busy'],
  }
  for (const [range, keys] of Object.entries(expected)) {
    await choose(react, range)
    assert.deepEqual(factNames(react), keys.map(key => t(key)), range)
    const fit = byClass(react, 'dwb-us-hstats')[0].props['data-fit']
    assert.equal(fit, keys.length, `${range} 列数跟着项数走`)
    for (const dropped of ['usage.chart.cumulative', 'usage.metric.cost', 'usage.metric.requests']) assert.equal(factNames(react).includes(t(dropped)), false, `${range} 不再写${t(dropped)}`)
  }
})

test('选中一根柱子：数字不变（仍含 token、费用、模型请求），换范围后选中清掉', async () => {
  const { react } = await mountUsagePage(data)
  await choose(react, '7d')
  const bars = byClass(react, 'dwb-us-rbars')[0]
  const index = 7 * 24 - 12
  react.fire(bars, 'onClick', { target: { closest: () => ({ dataset: { index: String(index) }, disabled: false }) } })
  await react.settle()
  assert.deepEqual(factNames(react).slice(0, 3), [t('usage.metric.tokens'), t('usage.metric.cost'), t('usage.metric.requests')])
  assert.equal(factNames(react).length, 6)
  assert.equal(byClass(react, 'dwb-us-factlabel').length, 1)
  await choose(react, 'today')
  assert.equal(byClass(react, 'dwb-us-factlabel').length, 0)
  assert.equal(factNames(react).length, 3)
})

test('换范围的那一次渲染里就没有旧的选中：从头部标签和图里的标签换都一样', async () => {
  for (const which of ['narrow', 'wide']) {
    const { react, client } = await mountUsagePage(data)
    const stats = client.get('usagePickStats')
    const seen = []
    client.set('usagePickStats', (...args) => { seen.push(args[2]); return stats(...args) })
    await choose(react, '7d')
    const bars = byClass(react, 'dwb-us-rbars')[0]
    react.fire(bars, 'onClick', { target: { closest: () => ({ dataset: { index: '150' }, disabled: false }) } })
    await react.settle()
    assert.ok(seen.includes('7d'), '选中后第一张图下面显示了这根柱子的数字')
    seen.length = 0
    tabs(react, which).props.onChange('today')
    await react.settle()
    assert.deepEqual(seen, [], `${which} 标签：新范围的任何一次渲染都不再算旧选中的数字`)
    assert.equal(byClass(react, 'dwb-us-factlabel').length, 0)
  }
})

const sideSection = (react, key) => react.all(node => node.type === 'section' && node.children[0]?.type === 'h5' && textOf(node.children[0]).startsWith(t(key)))[0]
const rowsOf = section => section.children.filter(child => typeof child !== 'string' && child.props.className?.startsWith('dwb-us-kv')).map(textOf)

test('左栏的模型和工作区跟着范围：数字、条和行来自所选范围，「全部」是累计', async () => {
  const { react } = await mountUsagePage(data)
  for (const range of ['today', '7d', '30', 'all']) {
    await choose(react, range)
    const scoped = range === 'all' ? data : data.ranges[range]
    const models = sideSection(react, 'usage.models')
    const workspaces = sideSection(react, 'usage.workspaces')
    assert.equal(textOf(models.children[0]), `模型 ${scoped.models.length}`, range)
    assert.deepEqual(rowsOf(models), scoped.models.map(model => `${model.n}${(model.p * 100).toFixed(1)}%`), range)
    assert.equal(textOf(workspaces.children[0]), `工作区 ${scoped.workspaces.length}`, range)
    assert.deepEqual(rowsOf(workspaces), scoped.workspaces.slice(0, 5).map(ws => `${ws.n}${(ws.p * 100).toFixed(1)}%`), range)
  }
  await choose(react, 'today')
  assert.equal(rowsOf(sideSection(react, 'usage.models')).some(row => row.startsWith('gemini')), false, '今日没有只出现在更早日子里的模型')
  await choose(react, 'all')
  assert.equal(rowsOf(sideSection(react, 'usage.models')).some(row => row.startsWith('gemini')), true)
  assert.equal(rowsOf(sideSection(react, 'usage.workspaces')).some(row => row.startsWith('legacy-tool')), true)
})

test('范围里没有用量：模型和工作区两节还在，数字是 0，模型条是空的，没有行', async () => {
  const { react } = await mountUsagePage(pageOverview({ idleDays: 10 }))
  await choose(react, '7d')
  const models = sideSection(react, 'usage.models')
  const workspaces = sideSection(react, 'usage.workspaces')
  assert.equal(textOf(models.children[0]), '模型 0')
  assert.equal(textOf(workspaces.children[0]), '工作区 0')
  assert.deepEqual([rowsOf(models), rowsOf(workspaces)], [[], []])
  assert.equal(models.children[1].props.className, 'dwb-us-stack dwb-us-stack-empty')
})

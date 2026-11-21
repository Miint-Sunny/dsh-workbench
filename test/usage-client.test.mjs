/** 用量主页的客户端：页面上看得见的数字、排序、格子位置和字典是否齐全，以及明细表刷新后的展开状态（替身 React）。页面本身在真实 DSH 里核对。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  usageProviderName, usageTokens, usageMoney, usagePercent, usageZ, usagePValue, usageVitalOrder, usageVerdict, usageVitalTone,
  usageHeatLevel, usageGapLabel, usageCacheLifeMinutes,
  usageResetTime, usageCompParts, usageRateLimitUpstream, usageCountList, usageBalanceBlock, usageBalanceText,
  usageMissLever, usageLocalMonthDay, usageSpendGroups,
  usageCardShouldRead, usageSessionFinished, usageCardToday, usageCardPlans, usageLocalMidnight, usageCardEscapeAction, USAGE_CARD_MIN_GAP_MS,
} from '../src/client/usage-model.js'
import { USAGE_RANGES } from '../src/client/usage-charts.js'
import { USAGE_ZH, USAGE_EN } from '../src/client/usage-copy.js'

const usageClientFiles = ['../src/client/usage.js', '../src/client/usage-chart-view.js']

test('数字格式：token 缩写、金额、比例，没有值时都是破折号', () => {
  assert.equal(usageTokens(55684130), '55.68M')
  assert.equal(usageTokens(635000), '635k')
  assert.equal(usageTokens(1349), '1.3k')
  assert.equal(usageTokens(999), '999')
  assert.equal(usageMoney(15.1575), '¥15.16')
  assert.equal(usageMoney(0.0417, 3), '¥0.042')
  assert.equal(usagePercent(0.85), '85.0%')
  for (const text of [usageTokens(null), usageMoney(null), usagePercent(null), usageZ(null)]) assert.equal(text, '—')
})

test('z 和 p 的写法：z 带符号，p 省掉小数点前的 0', () => {
  assert.equal(usageZ(5.33), '+5.3')
  assert.equal(usageZ(-1.72), '-1.7')
  assert.equal(usagePValue(4e-13), 'p < .001')
  assert.equal(usagePValue(0.0526), 'p = .053')
  assert.equal(usagePValue(0.874), 'p = .87')
  assert.equal(usagePValue(undefined), '')
})

test('监控：偏离最大的排最上面，没有基线的排最后；结论只数宿主标的异常', () => {
  const vitals = [
    { key: 'c', z: 2.8, anomaly: false },
    { key: 'retry', z: 22.3, anomaly: true },
    { key: 'tps', z: -4.1, anomaly: true },
    { key: 'hit', z: null, anomaly: false },
  ]
  assert.deepEqual(usageVitalOrder(vitals).map(vital => vital.key), ['retry', 'tps', 'c', 'hit'])
  assert.deepEqual(vitals.map(vital => vital.key), ['c', 'retry', 'tps', 'hit'], '不改接口给的数组')
  assert.deepEqual(usageVerdict(vitals), { bad: 2, ok: 2, serious: true })
  assert.deepEqual(usageVerdict([{ key: 'tps', anomaly: true }]), { bad: 1, ok: 0, serious: false })
})

test('监控行按 |z| 分亮度档', () => {
  assert.equal(usageVitalTone(null), 'none')
  assert.equal(usageVitalTone(undefined), 'none')
  assert.deepEqual([0, 0.99, -0.5].map(usageVitalTone), ['low', 'low', 'low'])
  assert.deepEqual([1, 1.99, -1.5].map(usageVitalTone), ['mid', 'mid', 'mid'])
  assert.deepEqual([2, 2.9, -2, 3, -22.3].map(usageVitalTone), ['strong', 'strong', 'strong', 'strong', 'strong'])
})

test('请求间隔分桶的标签和缓存有效期', () => {
  assert.deepEqual(usageGapLabel({ fromSeconds: 0, toSeconds: 60 }), { kind: 'under', a: 1, unit: 'minute' })
  assert.deepEqual(usageGapLabel({ fromSeconds: 60, toSeconds: 300 }), { kind: 'range', a: 1, b: 5, unit: 'minute' })
  assert.deepEqual(usageGapLabel({ fromSeconds: 3600, toSeconds: 5400 }), { kind: 'range', a: 1, b: 1.5, unit: 'hour' })
  assert.deepEqual(usageGapLabel({ fromSeconds: 43200, toSeconds: null }), { kind: 'over', a: 12, unit: 'hour' })
  const gaps = [
    { toSeconds: 1800, p50: 98 },
    { toSeconds: 3000, p50: 99 },
    { toSeconds: 3600, p50: 0 },
    { toSeconds: 5400, p50: null },
  ]
  assert.equal(usageCacheLifeMinutes(gaps), 50)
  assert.equal(usageCacheLifeMinutes([{ toSeconds: 60, p50: 0 }]), null)
  assert.equal(usageCacheLifeMinutes([{ toSeconds: null, p50: 90 }]), null, '最长的分桶也命中，说不出有效期')
})

test('额度重置时间：今天只写时分，别的日子带月日，坏值是空串', () => {
  const now = new Date(2026, 10, 6, 7, 30).getTime()
  assert.equal(usageResetTime(new Date(2026, 10, 6, 19, 46).toISOString(), now), '19:46')
  assert.equal(usageResetTime(new Date(2026, 10, 8, 2, 5).toISOString(), now), '11-08 02:05')
  assert.equal(usageResetTime(undefined, now), '')
  assert.equal(usageResetTime('不是时间', now), '')
})

test('上下文构成从大到小，缺的部分算 0', () => {
  const parts = usageCompParts({ tools: 5, res: 9, msg: 1 })
  assert.deepEqual(parts.slice(0, 3).map(part => part.key), ['res', 'tools', 'msg'])
  assert.equal(parts.length, 7)
  assert.equal(usageCompParts(undefined).every(part => part.v === 0), true)
})

test('RATE_LIMIT 只有次数和上游原因对得上才说「全部来自上游」', () => {
  assert.equal(usageRateLimitUpstream({ codes: { RATE_LIMIT: 36 }, why: { overloaded: 15, endpoint_unavailable: 21 } }), true)
  assert.equal(usageRateLimitUpstream({ codes: { RATE_LIMIT: 36 }, why: { overloaded: 15 } }), false)
  assert.equal(usageRateLimitUpstream({ codes: { TIMEOUT: 2 }, why: {} }), false)
  assert.equal(usageCountList({ TIMEOUT: 2, overloaded: 15 }), 'overloaded 15 · TIMEOUT 2')
  assert.equal(usageCountList(undefined), '')
})

test('最大来源：心跳唤醒是超过 1 小时的一部分，只和其余原因比', () => {
  const base = { missX: 6.84, T: { c: 10.69 } }
  const missBy = [{ why: 'gap-over-1h', x: 4.8 }, { why: 'first-request', x: 1.17 }]
  assert.deepEqual(usageMissLever({ ...base, missBy, wakeInfo: { n: 101, extra: 4.45 } }), { kind: 'wake', top: 4.45 })
  assert.deepEqual(usageMissLever({ ...base, missBy, wakeInfo: { n: 2, extra: 0.1 } }), { kind: 'reason', reason: 'gap-over-1h', top: 4.8 })
  assert.deepEqual(usageMissLever({ ...base, missBy, wakeInfo: { n: 0, extra: 0 } }), { kind: 'reason', reason: 'gap-over-1h', top: 4.8 })
  assert.equal(usageMissLever({ missX: 0, T: { c: 1 }, missBy, wakeInfo: { n: 0, extra: 0 } }), null)
  assert.equal(usageMissLever({ missX: 1, T: { c: 0 }, missBy, wakeInfo: { n: 0, extra: 0 } }), null)
})

test('余额起算日按本机时区，不按 UTC', () => {
  assert.equal(usageLocalMonthDay(new Date(2026, 9, 13, 0, 30).getTime()), '10-13')
})

test('余额块：人民币在前，差额等于余额减少减本机估算；什么都没有时不显示', () => {
  const quota = {
    queriedAt: 5,
    providers: [
      { id: 'deepseek-official', name: 'DeepSeek', state: 'ok', balances: [{ currency: 'USD', total: '380.27' }, { currency: 'CNY', total: '120.5' }] },
      { id: 'opencode-go', name: 'OpenCode Go', state: 'ok', windows: [{ key: '5h', percent: 12 }] },
      { id: 'zai-coding-cn', name: 'GLM Coding Plan', state: 'rate-limited', stale: true, queriedAt: 3, plan: 'pro', windows: [{ key: 'week', percent: 93 }] },
    ],
    spend: { cny: 560.5, since: 1 },
  }
  const block = usageBalanceBlock(quota, { c: 0.5 })
  assert.deepEqual(block.balances.map(balance => balance.currency), ['CNY', 'USD'])
  assert.deepEqual(block.gap, { since: 1, spend: 560.5, local: 0.5, other: 560 })
  assert.deepEqual(block.plans.map(plan => plan.name), ['OpenCode Go', 'GLM Coding Plan pro'])
  assert.deepEqual(block.problems, [{ id: 'zai-coding-cn', name: 'GLM Coding Plan', state: 'rate-limited', stale: true, queriedAt: 3 }])
  assert.equal(usageBalanceBlock(quota, null).gap, null, '本机估算读不到时不算差额')
  assert.equal(usageBalanceBlock({ ...quota, spend: null }, { c: 1 }).gap, null, '还没观察到余额减少时不算差额')
  assert.equal(usageBalanceBlock({ ...quota, spend: { cny: 0, since: 1 } }, { c: 0 }).gap, null, '两边都是 0 时不列')
  assert.equal(usageBalanceBlock({ ...quota, spend: { cny: 0, since: 1 } }, { c: 0.5 }).gap.other, 0, '余额接口比本机估算慢时不写负数')
  const official = balances => ({ providers: [{ id: 'deepseek-official', name: 'DeepSeek', state: 'ok', balances }], spend: null })
  assert.deepEqual(usageBalanceBlock(official([{ currency: 'USD', total: '0.00' }, { currency: 'CNY', total: '380.27' }]), null).balances.map(balance => balance.currency), ['CNY'], '余额为 0 的币种不列')
  assert.deepEqual(usageBalanceBlock(official([{ currency: 'USD', total: '0.00' }, { currency: 'CNY', total: '0.00' }]), null).balances.map(balance => balance.currency), ['CNY'], '全是 0 时留人民币')
  assert.equal(usageBalanceBlock({ providers: [], spend: null }, null), null, '一家密钥都没配')
  assert.deepEqual(usageBalanceBlock({ providers: [{ id: 'x', name: 'X', state: 'unreachable', stale: false }], spend: null }, null).problems[0].stale, false, '查不到时也要说')
  assert.equal(usageBalanceText({ currency: 'CNY', total: '120.5' }), '¥120.50')
  assert.equal(usageBalanceText({ currency: 'USD', total: '380.27' }), 'USD 380.27')
})

test('卡片什么时候读：第一次一定读，窗口不在前台不读，有会话结束才读，至少隔一分钟，换了一天要读', () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime()
  const later = gap => ({ readAt: now - gap, now })
  assert.equal(usageCardShouldRead({ readAt: null, dirty: false, focused: false, now }), true)
  assert.equal(usageCardShouldRead({ ...later(3600e3), dirty: true, focused: false }), false)
  assert.equal(usageCardShouldRead({ ...later(3600e3), dirty: false, focused: true }), false, '没有新东西就不读')
  assert.equal(usageCardShouldRead({ ...later(USAGE_CARD_MIN_GAP_MS - 1), dirty: true, focused: true }), false)
  assert.equal(usageCardShouldRead({ ...later(USAGE_CARD_MIN_GAP_MS), dirty: true, focused: true }), true)
  const yesterday = new Date(2026, 10, 5, 23, 59).getTime()
  assert.equal(usageCardShouldRead({ readAt: yesterday, dirty: false, focused: true, now: new Date(2026, 10, 6, 0, 1).getTime() }), true)
})

test('有会话结束：运行中变成不在运行才算，刚开始和一直在跑都不算', () => {
  const run = running => ({ running })
  assert.equal(usageSessionFinished(new Map([['a', run(true)]]), new Map([['a', run(false)]])), true)
  assert.equal(usageSessionFinished(new Map([['a', run(false)]]), new Map([['a', run(true)]])), false)
  assert.equal(usageSessionFinished(new Map([['a', run(true)]]), new Map([['a', run(true)]])), false)
  assert.equal(usageSessionFinished(new Map(), new Map([['a', run(false)]])), false)
})

test('卡片的数字：今天的值来自监控，异常项数和页面的结论一致；额度只写用得最多的窗口', () => {
  const vitals = [{ key: 'token', x: 5540000 }, { key: 'req', x: 113 }, { key: 'c', x: 0.87 }, { key: 'retry', x: 29, anomaly: true }, { key: 'ttft', x: null, anomaly: true }]
  assert.deepEqual(usageCardToday({ vitals }), { tokens: 5540000, requests: 113, cost: 0.87, bad: 2, serious: true })
  assert.deepEqual(usageCardToday({ vitals: [] }), { tokens: 0, requests: 0, cost: 0, bad: 0, serious: false })
  const windows = [{ key: '5h', percent: 0 }, { key: 'week', percent: 94 }, { key: 'month' }]
  assert.deepEqual(usageCardPlans([{ id: 'g', name: 'GLM', windows }]), [{ id: 'g', name: 'GLM', key: 'week', percent: 94 }])
  assert.deepEqual(usageCardPlans([{ id: 'o', name: 'Go', windows: [{ key: '5h' }] }]), [{ id: 'o', name: 'Go', key: '5h', percent: 0 }])
  assert.equal(usageLocalMidnight(new Date(2026, 10, 6, 15, 30, 12).getTime()), new Date(2026, 10, 6).getTime())
})

test('按 Esc：先收卡片，再回到会话；对话框和菜单优先，输入框里的 Esc 不抢，除非鼠标停在卡片上', () => {
  const base = { open: false, pageActive: false, hovering: false, typing: false, blocked: false }
  assert.equal(usageCardEscapeAction({ ...base, open: true }), 'collapse')
  assert.equal(usageCardEscapeAction({ ...base, open: true, pageActive: true }), 'collapse', '两样都开着时先收卡片')
  assert.equal(usageCardEscapeAction({ ...base, pageActive: true }), 'close-page')
  assert.equal(usageCardEscapeAction(base), null)
  assert.equal(usageCardEscapeAction({ ...base, open: true, blocked: true }), null)
  assert.equal(usageCardEscapeAction({ ...base, open: true, typing: true }), null)
  assert.equal(usageCardEscapeAction({ ...base, open: true, typing: true, hovering: true }), 'collapse')
})

test('用量的文字写「今日」，不写「今天」', () => {
  for (const [key, text] of Object.entries(USAGE_ZH)) assert.ok(!text.includes('今天'), `${key}：${text}`)
  assert.equal(USAGE_ZH['usage.card.today'], '今日用量')
})

test('字典：中英文的键一样，占位符一样，页面用到的键都有', () => {
  assert.deepEqual(Object.keys(USAGE_EN).sort(), Object.keys(USAGE_ZH).sort())
  const holes = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const key of Object.keys(USAGE_ZH)) assert.deepEqual(holes(USAGE_EN[key]), holes(USAGE_ZH[key]), key)
  assert.equal(USAGE_ZH['usage.heat.months'].split(',').length, 12)
  assert.equal(USAGE_EN['usage.heat.months'].split(',').length, 12)
  const source = usageClientFiles.map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
  const used = [...source.matchAll(/\bt\('(usage\.[\w.-]+)'/g)].map(match => match[1])
  assert.ok(used.length > 50)
  for (const key of used) assert.ok(key in USAGE_ZH, key)
  // 拼出来的键逐类查：接口给的代码都要有文字。
  for (const key of ['token', 'c', 'req', 'hit', 'ttft', 'tps', 'ctx', 'retry']) assert.ok(`usage.vital.${key}` in USAGE_ZH, key)
  for (const key of ['gap-over-1h', 'first-request', 'resume', 'system-changed', 'tools-changed', 'other']) assert.ok(`usage.miss.${key}` in USAGE_ZH, key)
  for (const key of ['tools', 'res', 'reas', 'msg', 'inject', 'sys', 'comp']) assert.ok(`usage.comp.${key}` in USAGE_ZH, key)
  for (const key of ['all', 'whale', 'other']) assert.ok(`usage.scope.${key}` in USAGE_ZH, key)
  for (const key of USAGE_RANGES) {
    assert.ok(`usage.range.${key}` in USAGE_ZH, key)
    assert.ok(`usage.chart.title.${key}` in USAGE_ZH, key)
  }
  for (const key of ['auth-failed', 'rate-limited', 'unreachable', 'unexpected']) assert.ok(`usage.quota.state.${key}` in USAGE_ZH, key)
})

test('费用构成的分组行：只列有会话的分组，有会话的不到两组时整块不列', () => {
  const whale = { id: 'whale', c: 0, req: 0, s: 0 }
  const other = { id: 'other', c: 0.4, req: 12, s: 3 }
  assert.deepEqual(usageSpendGroups([whale, other]), [], '没有小鲸鱼会话的人不出「小鲸鱼 0 个请求」')
  const used = { ...whale, c: 1.2, req: 40, s: 1 }
  assert.deepEqual(usageSpendGroups([used, other]), [used, other])
  assert.deepEqual(usageSpendGroups([used, { ...other, c: 0, req: 0, s: 0 }]), [], '只有一组时和上面的合计重复')
  const extra = { id: 'team', c: 0.1, req: 2, s: 1 }
  assert.deepEqual(usageSpendGroups([whale, extra, other]), [extra, other], '自己配的分组照样按顺序列')
})

test('页面不轮询：客户端代码里没有定时器', () => {
  const source = usageClientFiles.map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
  assert.equal(/setInterval|setTimeout|requestAnimationFrame/.test(source), false)
})

test('提供方名称保留自定义 ID，只有缺失 ID 使用本地化未知值', () => {
  assert.equal(usageProviderName('custom-a', '未知'), 'custom-a')
  assert.equal(usageProviderName('custom-b', '未知'), 'custom-b')
  assert.equal(usageProviderName('deepseek-official', '未知'), 'DeepSeek')
  assert.equal(usageProviderName(null, '未知'), '未知')
  assert.equal(usageProviderName('', '未知'), '未知')
})

// ---------- 明细表（替身 React 里跑构建好的 lib/client.js） ----------

/** 明细表的一行：统计值随 n 变，刷新后同一行换成新的对象和新数字。 */
function usageDetailRow(identity, n) {
  const stats = { n: 3, p50: n, p90: n * 2, p99: n * 3 }
  return {
    ...identity, ws: '~/w', preset: null, deleted: false, req: n, tokens: n * 1000, c: n / 10, hit: 0.5,
    ttft: stats, tps: stats, context: stats, output: stats, retries: 0, errors: 0, z: 0.5, baselineN: 7,
    todayTokens: n * 100, median: 90, anomaly: false, reasons: {},
  }
}

async function openDetails(t, view, rows) {
  const { loadClient, textOf } = await import('./react-harness.mjs')
  const client = loadClient(new URL('../lib/client.js', import.meta.url))
  client.set('usageT', (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`))
  const react = client.react
  const Table = client.get('UsageDetailTable')
  const render = list => react.React.createElement(Table, { view, data: { windowN: 30, priceMissing: [], breakdown: { [view]: list } } })
  react.mount(render(rows))
  t.after(() => react.unmount())
  return {
    async open(name) {
      react.fire(react.one(node => node.props.className === 'dwb-us-detail-name' && textOf(node) === name, `「${name}」那一行`), 'onClick')
      await react.settle()
    },
    async refresh(list) {
      react.update(render(list))
      await react.settle()
    },
    expanded: () => react.all(node => node.props.className === 'dwb-us-detail-expanded').map(node => textOf(node.children[0])),
  }
}

test('C 批用量明细：会话行展开后刷新，换成新数据也保持展开，那一行没了才收起', async (t) => {
  const ui = await openDetails(t, 'sessions', [usageDetailRow({ id: 's1', name: '整理文档' }, 1), usageDetailRow({ id: 's2', name: '写周报' }, 2)])
  await ui.open('整理文档')
  assert.deepEqual(ui.expanded(), ['整理文档'])
  await ui.refresh([usageDetailRow({ id: 's1', name: '整理文档' }, 5), usageDetailRow({ id: 's2', name: '写周报' }, 2)])
  assert.deepEqual(ui.expanded(), ['整理文档'])
  await ui.refresh([usageDetailRow({ id: 's2', name: '写周报' }, 2)])
  assert.deepEqual(ui.expanded(), [])
})

test('C 批用量明细：模型行按名字认，刷新后保持展开', async (t) => {
  const ui = await openDetails(t, 'models', [usageDetailRow({ name: 'deepseek-v4' }, 1), usageDetailRow({ name: 'glm-5' }, 2)])
  await ui.open('deepseek-v4')
  await ui.refresh([usageDetailRow({ name: 'glm-5' }, 3), usageDetailRow({ name: 'deepseek-v4' }, 4)])
  assert.deepEqual(ui.expanded(), ['deepseek-v4'])
})

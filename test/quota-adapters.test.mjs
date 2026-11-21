/** 三家适配器的响应解析（lib/quota-adapters.js），字段照 dsh-usage 的 adapters.ts。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUOTA_ADAPTERS, adapterById } from '../lib/quota-adapters.js'

/** DeepSeek /user/balance 的响应形状。 */
const deepseekBody = (infos) => ({ is_available: true, balance_infos: infos })

test('quota adapters: 登记了第一批三家，id 和名字固定', () => {
  assert.deepEqual(QUOTA_ADAPTERS.map(a => [a.id, a.kind]), [
    ['deepseek-official', 'balance'],
    ['opencode-go', 'plan'],
    ['zai-coding-cn', 'plan'],
  ])
  assert.equal(adapterById('deepseek-official').name, 'DeepSeek')
  assert.equal(adapterById('opencode-go').name, 'OpenCode Go')
  assert.equal(adapterById('zai-coding-cn').name, 'GLM Coding Plan')
  assert.equal(adapterById('nope'), undefined)
})

test('quota adapters: DeepSeek 读全部币种，不止第一项', () => {
  const parse = adapterById('deepseek-official').parse
  const both = parse(200, deepseekBody([
    { currency: 'CNY', total_balance: '110.30', granted_balance: '10.00', topped_up_balance: '100.30' },
    { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
  ]))
  assert.deepEqual(both, { balances: [{ currency: 'CNY', total: '110.30' }, { currency: 'USD', total: '0.00' }] })
  // 顺序反过来也一样全读（dsh-usage 只取第一项，读数会在两币之间跳）
  const swapped = parse(200, deepseekBody([
    { currency: 'USD', total_balance: '2.00' },
    { currency: 'CNY', total_balance: '7.50' },
  ]))
  assert.deepEqual(swapped, { balances: [{ currency: 'USD', total: '2.00' }, { currency: 'CNY', total: '7.50' }] })
})

test('quota adapters: DeepSeek 坏形状答 undefined', () => {
  const parse = adapterById('deepseek-official').parse
  assert.equal(parse(200, {}), undefined)
  assert.equal(parse(200, { balance_infos: [] }), undefined)
  assert.equal(parse(200, { balance_infos: 'x' }), undefined)
  assert.equal(parse(200, { balance_infos: [{ currency: 'CNY' }] }), undefined)
  assert.equal(parse(200, { balance_infos: [{ currency: 'CNY', total_balance: ' ' }] }), undefined)
  assert.equal(parse(401, deepseekBody([{ currency: 'CNY', total_balance: '1' }])), undefined)
})

test('quota adapters: OpenCode Go 三个窗口（5 小时、每周、每月）', () => {
  const parse = adapterById('opencode-go').parse
  const parsed = parse(200, {
    usage: {
      rolling: { status: 'x', percent: 42.5, resetsAt: '2026-11-06T04:00:00Z' },
      weekly: { status: 'x', percent: 10, resetsAt: '2026-11-09T00:00:00Z' },
      monthly: { status: 'x', percent: 0, resetsAt: '2026-11-30T00:00:00Z' },
    },
  })
  assert.deepEqual(parsed, {
    windows: [
      { key: '5h', percent: 42.5, resetsAt: '2026-11-06T04:00:00.000Z' },
      { key: 'week', percent: 10, resetsAt: '2026-11-09T00:00:00.000Z' },
      // percent 0 的 resetsAt 是占位值（dsh-usage 的做法），丢弃
      { key: 'month', percent: 0, resetsAt: undefined },
    ],
  })
})

test('quota adapters: OpenCode Go 缺窗口、坏形状答 undefined 或只带有的窗口', () => {
  const parse = adapterById('opencode-go').parse
  assert.deepEqual(parse(200, { usage: { rolling: { percent: 3 } } }), { windows: [{ key: '5h', percent: 3, resetsAt: undefined }] })
  assert.equal(parse(200, { usage: {} }), undefined)
  assert.equal(parse(200, {}), undefined)
  assert.equal(parse(500, { usage: { rolling: { percent: 1 } } }), undefined)
  // 百分比夹进 0–100
  assert.deepEqual(
    parse(200, { usage: { rolling: { percent: 140 } } })?.windows[0],
    { key: '5h', percent: 100, resetsAt: undefined },
  )
})

test('quota adapters: GLM 套餐名加窗口，TIME_LIMIT 不算窗口', () => {
  const parse = adapterById('zai-coding-cn').parse
  const parsed = parse(200, {
    success: true,
    data: {
      level: 'Max',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 45.5, currentValue: 0, usage: 0, nextResetTime: '2026-11-06T07:00:00Z' },
        { type: 'CREDIT_LIMIT', unit: 6, percentage: 50, currentValue: 3000, usage: 60000, nextResetTime: '2026-11-09T00:00:00Z' },
        { type: 'TIME_LIMIT', unit: 99, percentage: 3, nextResetTime: '2026-11-06T06:00:00Z' },
        { type: 'TOKENS_LIMIT', unit: 77, percentage: 5, nextResetTime: '2026-11-06T06:00:00Z' },
      ],
    },
  })
  assert.deepEqual(parsed, {
    plan: 'Max',
    windows: [
      { key: '5h', percent: 45.5, resetsAt: '2026-11-06T07:00:00.000Z' },
      // CREDIT_LIMIT 用 currentValue/usage 的精确比例，不用接口自己的 percentage
      { key: 'week', percent: 5, resetsAt: '2026-11-09T00:00:00.000Z' },
    ],
  })
})

test('quota adapters: GLM success 不为 true、缺 limits、空窗口答 undefined', () => {
  const parse = adapterById('zai-coding-cn').parse
  assert.equal(parse(200, { success: false, data: { level: 'Max', limits: [] } }), undefined)
  assert.equal(parse(200, { success: true, data: { level: 'Max' } }), undefined)
  assert.equal(parse(200, { success: true, data: { level: 'Max', limits: [{ type: 'TIME_LIMIT', unit: 9 }] } }), undefined)
  assert.equal(parse(403, { success: true, data: { level: 'x', limits: [] } }), undefined)
  // 没有套餐名也照样解析（level 缺失）
  assert.deepEqual(
    parse(200, { success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 5, percentage: 12 }] } }),
    { plan: undefined, windows: [{ key: 'month', percent: 12, resetsAt: undefined }] },
  )
})

test('quota adapters: 请求头——DeepSeek 和 OpenCode Go 用 Bearer，GLM 用裸 key', () => {
  assert.deepEqual(adapterById('deepseek-official').headers('sk-ds'), { authorization: 'Bearer sk-ds' })
  assert.deepEqual(adapterById('opencode-go').headers('sk-oc'), { authorization: 'Bearer sk-oc' })
  assert.deepEqual(adapterById('zai-coding-cn').headers('sk-glm.raw'), { authorization: 'sk-glm.raw', 'accept-language': 'en-US,en' })
})

test('quota adapters: 三家的地址都是各自官方域名', () => {
  assert.equal(adapterById('deepseek-official').url, 'https://api.deepseek.com/user/balance')
  assert.equal(adapterById('opencode-go').url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(adapterById('zai-coding-cn').url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
})

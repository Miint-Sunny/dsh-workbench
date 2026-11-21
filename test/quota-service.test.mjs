/**
 * 余额与额度的查询服务（lib/quota.js 的 createQuotaService）：假 fetch、假凭据、假时钟，
 * 覆盖缓存、并发只发一次、失败回退上次成功的值（stale）、spend 下降累计、状态文件
 * （0600、不含密钥、损坏从头开始）。不出网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuotaService } from '../lib/quota.js'
import { QUOTA_ADAPTERS } from '../lib/quota-adapters.js'

/** 三家的成功响应体。 */
const okBodies = {
  'https://api.deepseek.com/user/balance': { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100.00' }] },
  'https://opencode.ai/zen/go/v1/usage': { usage: { rolling: { percent: 10, resetsAt: '2026-11-06T04:00:00Z' }, weekly: { percent: 20, resetsAt: '2026-11-09T00:00:00Z' }, monthly: { percent: 30, resetsAt: '2026-11-30T00:00:00Z' } } },
  'https://open.bigmodel.cn/api/monitor/usage/quota/limit': { success: true, data: { level: 'Pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 45.5, nextResetTime: '2026-11-06T07:00:00Z' }] } },
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * 组一套服务依赖。
 * @param {object} [options] 覆盖项：behavior（url → Response | Error | Promise）、resolveKey、config。
 * @returns 测试用具。
 */
function makeQuota(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-quota-svc-'))
  const calls = []
  const behavior = options.behavior ?? (url => jsonResponse(200, okBodies[url]))
  const fetcher = (url, init) => {
    calls.push({ url, init })
    const outcome = behavior(url, calls.length)
    return outcome instanceof Promise ? outcome.then(v => (v instanceof Error ? Promise.reject(v) : v)) : outcome instanceof Error ? Promise.reject(outcome) : outcome
  }
  let t = 1_000_000
  const service = createQuotaService({
    dir,
    fetcher,
    resolveKey: options.resolveKey ?? (adapter => `fake-${adapter.id}`),
    getConfig: () => options.config ?? { timeoutSeconds: 10, cacheSeconds: 300 },
    now: () => t,
    logger: { warn: () => {}, info: () => {} },
  })
  return {
    dir, calls, service,
    advance: ms => { t += ms },
    time: () => t,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const deepseekProvider = response => response.providers.find(p => p.id === 'deepseek-official')

test('quota service: 成功查询的响应形状、请求头和 redirect', async () => {
  const q = makeQuota()
  try {
    const response = await q.service.overview()
    assert.equal(response.queriedAt, q.time())
    assert.deepEqual(response.providers.map(p => [p.id, p.name, p.state, p.stale]), [
      ['deepseek-official', 'DeepSeek', 'ok', false],
      ['opencode-go', 'OpenCode Go', 'ok', false],
      ['zai-coding-cn', 'GLM Coding Plan', 'ok', false],
    ])
    assert.deepEqual(deepseekProvider(response).balances, [{ currency: 'CNY', total: '100.00' }])
    assert.equal(deepseekProvider(response).windows, undefined)
    const glm = response.providers.find(p => p.id === 'zai-coding-cn')
    assert.equal(glm.plan, 'Pro')
    assert.deepEqual(glm.windows, [{ key: '5h', percent: 45.5, resetsAt: '2026-11-06T07:00:00.000Z' }])
    // 请求：只发给各家自己的地址，带身份压缩头，拒绝重定向，带超时
    assert.equal(q.calls.length, 3)
    for (const call of q.calls) {
      assert.equal(call.init.redirect, 'error')
      assert.equal(call.init.headers['accept-encoding'], 'identity')
      assert.ok(call.init.signal instanceof AbortSignal)
    }
    const byUrl = Object.fromEntries(q.calls.map(call => [call.url, call]))
    assert.deepEqual(byUrl['https://api.deepseek.com/user/balance'].init.headers.authorization, 'Bearer fake-deepseek-official')
    assert.deepEqual(byUrl['https://opencode.ai/zen/go/v1/usage'].init.headers.authorization, 'Bearer fake-opencode-go')
    assert.deepEqual(byUrl['https://open.bigmodel.cn/api/monitor/usage/quota/limit'].init.headers.authorization, 'fake-zai-coding-cn')
    // 假密钥不进响应
    assert.doesNotMatch(JSON.stringify(response), /fake-/)
  } finally { q.cleanup() }
})

test('quota service: 没配密钥的提供方不列出、不出网', async () => {
  const q = makeQuota({ resolveKey: adapter => adapter.id === 'zai-coding-cn' ? undefined : `fake-${adapter.id}` })
  try {
    const response = await q.service.overview()
    assert.deepEqual(response.providers.map(p => p.id), ['deepseek-official', 'opencode-go'])
    assert.equal(q.calls.length, 2)
  } finally { q.cleanup() }
})

test('quota service: 缓存有效时不出网，refresh=1 绕过', async () => {
  const q = makeQuota()
  try {
    await q.service.overview()
    assert.equal(q.calls.length, 3)
    await q.service.overview()
    assert.equal(q.calls.length, 3, '缓存有效，第二次不出网')
    await q.service.overview({ refresh: true })
    assert.equal(q.calls.length, 6, 'refresh=1 绕过缓存')
    q.advance(301_000)
    await q.service.overview()
    assert.equal(q.calls.length, 9, '过了 cacheSeconds 自动重查')
    // 缓存的回答 state ok、stale false
    const cached = await q.service.overview()
    assert.equal(cached.providers.every(p => p.state === 'ok' && p.stale === false), true)
  } finally { q.cleanup() }
})

test('quota service: 同一家的并发请求只发一次', async () => {
  const gates = Object.keys(okBodies).map(url => {
    let release
    const opened = new Promise(resolve => { release = resolve })
    return { url, opened, release }
  })
  const byUrl = new Map(gates.map(gate => [gate.url, gate.opened.then(() => jsonResponse(200, okBodies[gate.url]))]))
  const q = makeQuota({ behavior: url => byUrl.get(url) })
  try {
    const both = Promise.all([q.service.overview(), q.service.overview()])
    // 两次 overview 都等到出网这一步（读状态文件是真 IO，不能只等一个 setImmediate）
    for (let attempt = 0; attempt < 200 && q.calls.length < 3; attempt++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(q.calls.length, 3, '两次并发只发三份请求')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(q.calls.length, 3, '等一拍也没有多发')
    for (const gate of gates) gate.release()
    const [a, b] = await both
    assert.deepEqual(a.providers.map(p => p.state), ['ok', 'ok', 'ok'])
    assert.deepEqual(b.providers.map(p => p.state), ['ok', 'ok', 'ok'])
  } finally { q.cleanup() }
})

test('quota service: 401、429、超时、坏 JSON、5xx、302 的 state；失败回退上次成功的值', async () => {
  let mode = 'ok'
  const q = makeQuota({ behavior: url => {
    if (mode === 'ok') return jsonResponse(200, okBodies[url])
    if (mode === 'unauthorized') return jsonResponse(401, { error: 'bad key' })
    if (mode === 'rate') return jsonResponse(429, {})
    if (mode === 'down') return Promise.reject(new Error('fetch failed'))
    if (mode === 'badjson') return new Response('{nope', { status: 200 })
    if (mode === 'server') return jsonResponse(500, {})
    return jsonResponse(302, {}) // redirect
  } })
  try {
    // 从来没成功过：只有 state，没有读数
    mode = 'unauthorized'
    let response = await q.service.overview({ refresh: true })
    assert.deepEqual(deepseekProvider(response), { id: 'deepseek-official', name: 'DeepSeek', state: 'auth-failed', queriedAt: q.time(), stale: false })

    // 成功一次
    mode = 'ok'
    response = await q.service.overview({ refresh: true })
    assert.equal(deepseekProvider(response).state, 'ok')

    // 再失败：回退上次成功的值，stale，queriedAt 是上次成功的时间
    mode = 'rate'
    q.advance(5_000)
    response = await q.service.overview({ refresh: true })
    const stale = deepseekProvider(response)
    assert.equal(stale.state, 'rate-limited')
    assert.equal(stale.stale, true)
    assert.deepEqual(stale.balances, [{ currency: 'CNY', total: '100.00' }])
    assert.equal(stale.queriedAt, q.time() - 5_000)

    mode = 'down'
    response = await q.service.overview({ refresh: true })
    assert.equal(deepseekProvider(response).state, 'unreachable')
    assert.equal(deepseekProvider(response).stale, true)

    mode = 'badjson'
    response = await q.service.overview({ refresh: true })
    assert.equal(deepseekProvider(response).state, 'unexpected')

    mode = 'server'
    response = await q.service.overview({ refresh: true })
    assert.equal(deepseekProvider(response).state, 'unexpected')

    mode = 'redirect'
    response = await q.service.overview({ refresh: true })
    assert.equal(deepseekProvider(response).state, 'unexpected')
    assert.equal(deepseekProvider(response).stale, true)
  } finally { q.cleanup() }
})

test('quota service: spend 只累计 CNY 的下降，上升算充值，失败不动', async () => {
  let cny = '100.00'
  let fail = false
  const q = makeQuota({ behavior: url => {
    if (fail) return jsonResponse(500, {})
    if (url.includes('deepseek')) return jsonResponse(200, { balance_infos: [{ currency: 'CNY', total_balance: cny }] })
    return jsonResponse(200, okBodies[url])
  } })
  try {
    let response = await q.service.overview()
    assert.deepEqual(response.spend, { cny: 0, since: q.time(), lastCny: 100 }, '第一次观测记 since')
    q.advance(60_000); cny = '90.50'
    response = await q.service.overview({ refresh: true })
    assert.equal(response.spend.cny, 9.5)
    q.advance(60_000); cny = '120.00'
    response = await q.service.overview({ refresh: true })
    assert.equal(response.spend.cny, 9.5, '上升是充值，不计')
    q.advance(60_000); fail = true
    response = await q.service.overview({ refresh: true })
    assert.deepEqual(response.spend, { cny: 9.5, since: 1_000_000, lastCny: 120 }, '失败不动')
  } finally { q.cleanup() }
})

test('quota service: 只有 USD 读数时 spend 还是 null', async () => {
  const q = makeQuota({ behavior: url => url.includes('deepseek')
    ? jsonResponse(200, { balance_infos: [{ currency: 'USD', total_balance: '3.00' }] })
    : jsonResponse(200, okBodies[url]) })
  try {
    const response = await q.service.overview()
    assert.equal(response.spend, null)
    assert.deepEqual(deepseekProvider(response).balances, [{ currency: 'USD', total: '3.00' }])
  } finally { q.cleanup() }
})

test('quota service: 状态文件 0600、不含密钥，重启后靠它答上次的值', async () => {
  const q = makeQuota()
  try {
    await q.service.overview()
    const file = join(q.dir, 'quota-state.json')
    assert.equal(existsSync(file), true)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /fake-/)
    const stored = JSON.parse(text)
    assert.equal(stored.version, 1)
    assert.deepEqual(stored.providers['deepseek-official'].facts.balances, [{ currency: 'CNY', total: '100.00' }])
    assert.equal(stored.providers['opencode-go'].facts.windows.length, 3)
    assert.deepEqual(stored.spend, { cny: 0, since: 1_000_000, lastCny: 100 })

    // 新的服务实例（等于重启）：第一次就失败，也答得出上次的值
    const restarted = createQuotaService({
      dir: q.dir,
      fetcher: () => jsonResponse(500, {}),
      resolveKey: () => 'sk-test',
      getConfig: () => ({ timeoutSeconds: 10, cacheSeconds: 300 }),
      now: () => 2_000_000,
      logger: { warn: () => {}, info: () => {} },
    })
    const response = await restarted.overview()
    const deepseek = deepseekProvider(response)
    assert.equal(deepseek.state, 'unexpected')
    assert.equal(deepseek.stale, true)
    assert.deepEqual(deepseek.balances, [{ currency: 'CNY', total: '100.00' }])
    assert.equal(deepseek.queriedAt, 1_000_000)
    assert.deepEqual(response.spend, { cny: 0, since: 1_000_000, lastCny: 100 })
    // spend 接着上次的值累计：文件里 lastCny 是 100，再读到 90 又花了 10
    const q2dir = q.dir
    const followup = createQuotaService({
      dir: q2dir,
      fetcher: url => url.includes('deepseek')
        ? jsonResponse(200, { balance_infos: [{ currency: 'CNY', total_balance: '90.00' }] })
        : jsonResponse(200, okBodies[url]),
      resolveKey: () => 'sk-test',
      getConfig: () => ({ timeoutSeconds: 10, cacheSeconds: 300 }),
      now: () => 2_100_000,
      logger: { warn: () => {}, info: () => {} },
    })
    const after = await followup.overview({ refresh: true })
    assert.deepEqual(after.spend, { cny: 10, since: 1_000_000, lastCny: 90 })
  } finally { q.cleanup() }
})

test('quota service: 状态文件损坏就从头开始', async () => {
  const q = makeQuota()
  try {
    await q.service.overview()
    writeFileSync(join(q.dir, 'quota-state.json'), '{corrupt')
    const fresh = createQuotaService({
      dir: q.dir,
      fetcher: () => jsonResponse(500, {}),
      resolveKey: () => 'sk-test',
      getConfig: () => ({ timeoutSeconds: 10, cacheSeconds: 300 }),
      now: () => 3_000_000,
      logger: { warn: () => {}, info: () => {} },
    })
    const response = await fresh.overview()
    const deepseek = deepseekProvider(response)
    assert.equal(deepseek.state, 'unexpected')
    assert.equal(deepseek.stale, false)
    assert.equal(deepseek.balances, undefined)
    assert.equal(response.spend, null)
  } finally { q.cleanup() }
})

test('quota service: adapters 依赖可注入（测试用假适配器）', async () => {
  const adapter = {
    id: 'fake', name: 'Fake', kind: 'balance', url: 'https://fake.example/balance',
    headers: key => ({ authorization: `Bearer ${key}` }),
    parse: (status, body) => (status === 200 ? { balances: [{ currency: 'CNY', total: '5.00' }] } : undefined),
  }
  const q = makeQuota({ behavior: () => jsonResponse(200, {}) })
  const service = createQuotaService({
    adapters: [adapter],
    dir: q.dir,
    fetcher: () => jsonResponse(200, {}),
    resolveKey: () => 'sk-fake',
    getConfig: () => ({ timeoutSeconds: 10, cacheSeconds: 300 }),
    now: () => 4_000_000,
    logger: { warn: () => {}, info: () => {} },
  })
  try {
    const response = await service.overview()
    assert.deepEqual(response.providers, [{ id: 'fake', name: 'Fake', state: 'ok', balances: [{ currency: 'CNY', total: '5.00' }], queriedAt: 4_000_000, stale: false }])
    assert.deepEqual(response.spend, { cny: 0, since: 4_000_000, lastCny: 5 })
  } finally { q.cleanup() }
})

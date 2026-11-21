/**
 * 凭据解析（lib/quota.js 的 resolveQuotaCredential 和 readEntryConfig）：llm-pi-ai 的
 * api-key 记录优先，其次 profile 里配置的 apiKeyEnv 引用，再次派生的默认引用名；
 * deepseek-official 另有 llm-deepseek 的兜底。密钥只在宿主进程里过手，不进测试断言以
 * 外的任何地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readEntryConfig, resolveQuotaCredential } from '../lib/quota.js'

/** 假的 credentials 服务：记录按表答，resolve 按表答并记调用。 */
function makeCredentials({ records = {}, values = {}, failRead = false } = {}) {
  const resolved = []
  return {
    resolved,
    async readRecord(key) {
      if (failRead) throw new Error('nope')
      return records[key]
    },
    async resolve(ref) {
      resolved.push(ref)
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'env' }
    },
  }
}

test('credentials: llm-pi-ai 的 api-key 记录优先，不碰环境引用', async () => {
  const credentials = makeCredentials({ records: { 'llm-pi-ai/opencode-go': { kind: 'api-key', key: 'sk-record' } }, values: { OPENCODE_GO_API_KEY: 'sk-env' } })
  assert.equal(await resolveQuotaCredential(credentials, 'opencode-go', () => undefined), 'sk-record')
  assert.deepEqual(credentials.resolved, [])
})

test('credentials: 记录不是 api-key（grant、空 key）时落到环境引用', async () => {
  const credentials = makeCredentials({
    records: { 'llm-pi-ai/zai-coding-cn': { kind: 'grant', payload: {} }, 'llm-pi-ai/opencode-go': { kind: 'api-key', key: '' } },
    values: { ZAI_CODING_CN_API_KEY: 'sk-zai' },
  })
  assert.equal(await resolveQuotaCredential(credentials, 'zai-coding-cn', () => undefined), 'sk-zai')
  assert.equal(await resolveQuotaCredential(credentials, 'opencode-go', () => undefined), undefined)
})

test('credentials: profile 配了 apiKeyEnv 就用它，没配用派生的默认名', async () => {
  const credentials = makeCredentials({ values: { MY_OC_REF: 'sk-named', OPENCODE_GO_API_KEY: 'sk-derived' } })
  const configured = ns => ns === 'llm-pi-ai'
    ? { providers: { 'opencode-go': { apiKeyEnv: 'MY_OC_REF' } } }
    : undefined
  assert.equal(await resolveQuotaCredential(credentials, 'opencode-go', configured), 'sk-named')
  assert.equal(await resolveQuotaCredential(credentials, 'opencode-go', () => undefined), 'sk-derived')
})

test('credentials: deepseek-official 先 pi-ai 的引用，再 llm-deepseek 的 apiKeyEnv（默认 DEEPSEEK_API_KEY）', async () => {
  const empty = makeCredentials({ values: {} })
  assert.equal(await resolveQuotaCredential(empty, 'deepseek-official', () => undefined), undefined)
  assert.deepEqual(empty.resolved, ['DEEPSEEK_OFFICIAL_API_KEY', 'DEEPSEEK_API_KEY'])

  const named = makeCredentials({ values: { MY_DS_REF: 'sk-ds' } })
  const profile = ns => ns === 'llm-deepseek' ? { apiKeyEnv: 'MY_DS_REF' } : undefined
  assert.equal(await resolveQuotaCredential(named, 'deepseek-official', profile), 'sk-ds')
  assert.deepEqual(named.resolved, ['DEEPSEEK_OFFICIAL_API_KEY', 'MY_DS_REF'])

  const both = makeCredentials({ values: { DEEPSEEK_OFFICIAL_API_KEY: 'sk-official' } })
  assert.equal(await resolveQuotaCredential(both, 'deepseek-official', () => undefined), 'sk-official')
})

test('credentials: readRecord 抛错、resolve 抛错都按没有处理', async () => {
  const credentials = {
    async readRecord() { throw new Error('boom') },
    async resolve() { throw new Error('boom') },
  }
  assert.equal(await resolveQuotaCredential(credentials, 'opencode-go', () => undefined), undefined)
})

test('readEntryConfig: settings 服务、loader、configEditor 三层，观测值解包', async () => {
  // settings.get 优先
  const settingsService = { get: ns => ns === 'llm-pi-ai' ? { providers: { 'opencode-go': { get: () => ({ apiKeyEnv: 'A' }) } } } : undefined }
  const settingsCtx = { get: name => name === 'settings' ? settingsService : undefined }
  assert.deepEqual(readEntryConfig(settingsCtx, 'llm-pi-ai'), { providers: { 'opencode-go': { apiKeyEnv: 'A' } } })
  // settings 没有 get 时用 describe，只读剥掉 secret 字段后的配置；apiKeyEnv 是引用名，不会被剥掉
  const describeCalls = []
  const describeService = { describe: options => { describeCalls.push(options); return [{ ns: 'llm-pi-ai', value: { providers: 1 } }, { ns: 'other' }] } }
  const describeCtx = { get: name => name === 'settings' ? describeService : undefined }
  assert.deepEqual(readEntryConfig(describeCtx, 'llm-pi-ai'), { providers: 1 })
  assert.deepEqual(describeCalls, [{ redactSecrets: true }])
  // llm-pi-ai 的别名 llm（dsh-usage 的写法）
  const aliasService = { describe: () => [{ ns: 'llm', value: { providers: 2 } }] }
  const aliasCtx = { get: name => name === 'settings' ? aliasService : undefined }
  assert.deepEqual(readEntryConfig(aliasCtx, 'llm-pi-ai'), { providers: 2 })
  // settings 不在：loader 的 entry 配置
  const loaderCtx = {
    get: () => undefined,
    root: { loader: { entries: () => [
      { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' }, fiber: { config: { apiKeyEnv: 'B' } } },
    ] } },
  }
  assert.deepEqual(readEntryConfig(loaderCtx, 'llm-deepseek'), { apiKeyEnv: 'B' })
  // loader 也没有：configEditor 的合并视图
  const editor = { configuration: () => [{ entry: { options: { id: 'llm-deepseek' } }, inherited: { baseURL: 'x' }, override: { apiKeyEnv: 'C' } }] }
  const editorCtx = { get: name => name === 'configEditor' ? editor : undefined, root: {} }
  assert.deepEqual(readEntryConfig(editorCtx, 'llm-deepseek'), { baseURL: 'x', apiKeyEnv: 'C' })
  // 都没有：undefined
  assert.equal(readEntryConfig({ get: () => undefined }, 'llm-pi-ai'), undefined)
})

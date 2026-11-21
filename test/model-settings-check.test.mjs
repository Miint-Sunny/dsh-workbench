/** 模型设置的「检查连接」（从 dsh-model-settings 的 test/check.test.mjs 搬来，feat#217）：失败归类、推理档位、请求体校验和一次检查。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRequestOf, cheapestEffort, classifyFailure, innerMessage, runCheck, statusFromText } from '../lib/model-settings/check.js'

const llmError = (message, code, status) => Object.assign(new Error(message), { failure: { message, code, ...status === undefined ? {} : { status } } })

test('检查失败按状态码和错误代码归类', () => {
  assert.deepEqual(classifyFailure(llmError('bad key', 'PROVIDER', 401)), { ok: false, reason: 'auth', status: 401 })
  assert.deepEqual(classifyFailure(llmError('denied', 'PROVIDER', 403)), { ok: false, reason: 'forbidden', status: 403 })
  assert.deepEqual(classifyFailure(llmError('slow down', 'RATE_LIMIT')), { ok: false, reason: 'rate', status: 429 })
  assert.deepEqual(classifyFailure(llmError('no such route', 'PROVIDER', 404)), { ok: false, reason: 'notFound', status: 404 })
  assert.deepEqual(classifyFailure(new Error('fetch failed')), { ok: false, reason: 'network' })
  assert.deepEqual(classifyFailure(new Error('aborted'), { timedOut: true }), { ok: false, reason: 'timeout', seconds: 20 })
})

test('Gemini 的密钥不对是 400 加 API_KEY_INVALID，也归到「API 密钥无效」', () => {
  const gemini = '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\",\\n    \\"details\\": [{\\"reason\\": \\"API_KEY_INVALID\\"}]\\n  }\\n}\\n","code":400,"status":"Bad Request"}}'
  assert.deepEqual(classifyFailure(llmError(gemini, 'PROVIDER')), { ok: false, reason: 'auth', status: 400 })
  assert.deepEqual(classifyFailure(llmError('401 invalid x-api-key', 'PROVIDER')), { ok: false, reason: 'auth', status: 401 })
})

test('别的错误只留最里面那句说明和状态码', () => {
  const opencode = '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently."}'
  assert.deepEqual(classifyFailure(llmError(opencode, 'PROVIDER')), { ok: false, reason: 'other', status: 400, message: 'Request is missing x-opencode-session and cannot be routed efficiently.' })
  assert.equal(innerMessage('plain text'), 'plain text')
  assert.equal(innerMessage('{"broken'), '{"broken')
  assert.equal(statusFromText('HTTP 502 Bad Gateway'), 502)
  assert.equal(statusFromText('no status here'), undefined)
})

test('检查用最便宜的推理档位', () => {
  assert.deepEqual(cheapestEffort({ reasoning: { efforts: ['low', 'off', 'high'] } }), { reasoningEffort: 'off' })
  assert.deepEqual(cheapestEffort({ reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } }), { reasoningEffort: 'minimal' })
  assert.deepEqual(cheapestEffort({}), {})
})

test('请求体只收合法的路由和模型', () => {
  assert.deepEqual(checkRequestOf({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(checkRequestOf({ provider: '../x', model: 'm' }), undefined)
  assert.equal(checkRequestOf({ provider: 'p', model: '' }), undefined)
  assert.equal(checkRequestOf(null), undefined)
})

test('检查请求带一次性会话 id、限 16 个输出 token，成功时回报模型和耗时', async () => {
  const seen = {}
  const llm = {
    async prepareCall(config, signal, configure) {
      seen.config = config
      seen.controls = configure({}, { reasoning: { efforts: ['off', 'high'] } })
      return {
        config: { provider: config.provider, model: config.model },
        async* stream(options) { seen.options = options; yield { type: 'finish' } },
      }
    },
  }
  class BlockAssembler { push() {} get finish() { return { kind: 'stop' } } }
  const result = await runCheck(llm, { createUserMessage: message => message, BlockAssembler }, { provider: 'opencode-go', model: 'm' })
  assert.equal(result.ok, true)
  assert.equal(result.model, 'm')
  assert.equal(seen.config.maxTokens, 16)
  assert.deepEqual(seen.controls, { reasoningEffort: 'off' })
  assert.match(seen.options.sessionId, /^session-[0-9a-f-]{36}$/)
  assert.equal('purpose' in seen.options, false)
})

test('流结束带错误时按错误归类', async () => {
  const llm = { async prepareCall() { return { config: {}, async* stream() { yield {} } } } }
  class BlockAssembler { push() {} get finish() { return { kind: 'error', error: { message: 'bad', code: 'AUTH' } } } }
  assert.deepEqual(await runCheck(llm, { createUserMessage: m => m, BlockAssembler }, { provider: 'p', model: 'm' }), { ok: false, reason: 'auth', status: 401 })
})

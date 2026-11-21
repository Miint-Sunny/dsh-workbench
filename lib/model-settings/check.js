/** 「检查连接」：用 DSH 自己的模型服务和这一家已存的凭据发一条最短的请求，把失败归成页面能讲清的几类。 */
import { randomUUID } from 'node:crypto'

/** 检查的等待上限，秒。 */
export const CHECK_TIMEOUT_SECONDS = 20

/**
 * 把一次失败归类。DSH 的 LlmError 带 `failure.status`（HTTP 状态码）和 `failure.code`（AUTH、RATE_LIMIT 等）。
 * @param {unknown} error 抛出的错误，或流结束时带的错误。
 * @param {{ timedOut?: boolean }} [context] 是否因为超时被取消。
 * @returns {{ ok: false, reason: 'auth' | 'forbidden' | 'rate' | 'notFound' | 'network' | 'timeout' | 'other', status?: number, seconds?: number, message?: string }}
 */
export function classifyFailure(error, context = {}) {
  const failure = typeof error === 'object' && error !== null ? (error.failure ?? error) : {}
  const code = typeof failure.code === 'string' ? failure.code : undefined
  const message = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : String(error)
  const status = Number.isInteger(failure.status) ? failure.status : statusFromText(message)
  const name = typeof error === 'object' && error !== null ? error.name : undefined
  const text = `${code ?? ''} ${message}`
  if (context.timedOut === true || name === 'TimeoutError') return { ok: false, reason: 'timeout', seconds: CHECK_TIMEOUT_SECONDS }
  if (status === 401 || code === 'AUTH' || code === 'UNAUTHORIZED' || INVALID_KEY.test(text)) return { ok: false, reason: 'auth', status: status ?? 401 }
  if (status === 403 || code === 'FORBIDDEN') return { ok: false, reason: 'forbidden', status: 403 }
  if (status === 429 || code === 'RATE_LIMIT' || code === 'QUOTA') return { ok: false, reason: 'rate', status: 429 }
  if (status === 404 || code === 'NOT_FOUND') return { ok: false, reason: 'notFound', status: 404 }
  if (status === undefined && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|getaddrinfo|socket hang up|network/i.test(text)) {
    return { ok: false, reason: 'network' }
  }
  return { ok: false, reason: 'other', ...status === undefined ? {} : { status }, message: innerMessage(message) }
}

/** 各家说「密钥不对」的写法：Gemini 返回 400 加 API_KEY_INVALID，Anthropic 写 invalid x-api-key，OpenAI 写 Incorrect API key。 */
const INVALID_KEY = /API_KEY_INVALID|api key not valid|invalid[ _-]?api[ _-]?key|incorrect api key|invalid x-api-key|unauthori[sz]ed|authentication (failed|error)/i

/**
 * 从错误文字里找 HTTP 状态码：开头的「400:」、JSON 里的 "code": 400 或「HTTP 400」。
 * @param {string} message 错误文字。
 * @returns {number | undefined} 状态码。
 */
export function statusFromText(message) {
  const match = /^\s*(\d{3})\b/.exec(message) ?? /"code"\s*:\s*(\d{3})\b/.exec(message) ?? /\bHTTP\s*(\d{3})\b/i.exec(message)
  const status = match === null ? undefined : Number(match[1])
  return status !== undefined && status >= 100 && status <= 599 ? status : undefined
}

/**
 * 提供商常把错误包成几层 JSON；一层层剥开，只留最里面那句说明。
 * @param {string} message 错误文字。
 * @returns {string} 最多 300 个字符的说明。
 */
export function innerMessage(message) {
  let text = message
  for (let depth = 0; depth < 4; depth++) {
    const start = text.indexOf('{')
    if (start < 0) break
    let parsed
    try {
      parsed = JSON.parse(text.slice(start))
    } catch {
      // 不是完整的 JSON：保留当前这一层的文字。
      break
    }
    const inner = parsed?.error?.message ?? parsed?.message ?? (typeof parsed?.error === 'string' ? parsed.error : undefined)
    if (typeof inner !== 'string' || inner.length === 0) break
    text = inner
  }
  return text.trim().slice(0, 300)
}

/**
 * 检查用的推理档位：能关就关，关不了就用最低的一档，尽量少花 token。
 * @param {{ reasoning?: { efforts?: readonly (string | { id: string })[] } }} info DSH 给的模型信息。
 * @returns {{ reasoningEffort?: string }} 要附加到请求上的控制项。
 */
export function cheapestEffort(info) {
  const ids = (info?.reasoning?.efforts ?? []).map(effort => typeof effort === 'string' ? effort : effort?.id).filter(id => typeof id === 'string')
  if (ids.length === 0) return {}
  return { reasoningEffort: ids.includes('off') ? 'off' : ids[0] }
}

/**
 * 校验页面发来的请求体。
 * @param {unknown} body 解析后的 JSON。
 * @returns {{ provider: string, model: string } | undefined} 合法时返回路由和模型。
 */
export function checkRequestOf(body) {
  if (typeof body !== 'object' || body === null) return undefined
  const { provider, model } = body
  if (typeof provider !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(provider)) return undefined
  if (typeof model !== 'string' || model.length === 0 || model.length > 200) return undefined
  return { provider, model }
}

/**
 * 发一次检查。只在页面上点「检查连接」时调用，不自动检查。
 * @param {object} llm DSH 的模型服务（`ctx.llm`）。
 * @param {{ createUserMessage: Function, BlockAssembler: new () => object }} protocol DSH 的消息构造和流累积。
 * @param {{ provider: string, model: string }} request 路由和模型。
 * @returns {Promise<{ ok: true, model: string, ms: number } | ReturnType<typeof classifyFailure>>} 结果。
 */
export async function runCheck(llm, protocol, request) {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_SECONDS * 1000)
  const started = Date.now()
  try {
    const call = await llm.prepareCall({ provider: request.provider, model: request.model, maxTokens: 16, temperature: 0 }, timeout,
      (controls, info) => ({ ...controls, ...cheapestEffort(info) }))
    const messages = [protocol.createUserMessage({ content: [{ type: 'text', text: 'Reply with OK.' }], source: { kind: 'dsh-model-settings' } })]
    const assembler = new protocol.BlockAssembler()
    // 有的提供商按会话分流，没有会话标识就拒绝（OpenCode Go 要 x-opencode-session），所以给这次检查一个一次性的会话 id。
    const sessionId = `session-${randomUUID()}`
    for await (const chunk of call.stream({ ...call.config, messages, sessionId, signal: timeout })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish?.kind === 'error') return classifyFailure(finish.error ?? finish, { timedOut: timeout.aborted })
    if (finish?.kind === 'aborted') return classifyFailure(new Error('aborted'), { timedOut: timeout.aborted })
    return { ok: true, model: request.model, ms: Date.now() - started }
  } catch (error) {
    return classifyFailure(error, { timedOut: timeout.aborted })
  }
}

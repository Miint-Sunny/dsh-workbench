/**
 * 会话标题这一行的标题提供方：自动起名只看首条用户消息（和它顶替的 DSH 自带首条起名一样；标题服务只接受一个提供方）；
 * `/retitle`、侧栏会话菜单的「重新起名」和可选的轮末重算（`refreshEveryPrompts`）另取最近的对话（用户和助手的文字）。
 * 标题请求选模型声明的最安静的思考档位（`titleEfforts`），会思考的模型也只交回标题。
 * 每次发给模型的内容先记成 DSH 的 `session/title-llm-request` 事件，再发请求，和 DSH 自带的标题插件一样。
 *
 * 本模块不 import DSH 的包：消息构造、流累积、超时和标题服务的两个函数由 session-title.js 传进来，`node --test` 直接可跑。
 * 写法照独立插件 dsh-session-title-headtail 的 lib/index.js（它照 DSH 0.2.0-rc.2 的 @deepseek-ai/dsh-session-title-llm）。
 */
import { claimOfficialRow } from './official-rows.js'
import { conversationOf, frameSample, humanSeqsOf, promptsSince, selectSample, systemPrompt, titleEffortOf } from './session-title-sample.js'

/** 标题提供方的 id，会话日志 `session/title-llm-request` 的 `titleProvider` 记的就是它：沿用独立插件的，前后的日志一致。 */
export const PROVIDER_ID = 'dsh-session-title-headtail'

/** 这一行顶替的 DSH 自带行：基础包里的首条消息生成标题。它等工作台的许可（official-rows.js），这一行开着时收回。 */
export const OFFICIAL_ROW = 'session-title-llm'

const TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** 配置的默认值。补丁不写显式 config，Config 的默认值从这里取；等于独立插件补丁里写的 10 个值。 */
export const DEFAULTS = Object.freeze({
  tailMessages: 6,
  refreshEveryPrompts: 0,
  headMaxChars: 2000,
  messageMaxChars: 1500,
  maxInputChars: 8000,
  targetWords: 6,
  targetCjkCharacters: 12,
  maxOutputTokens: 2048,
  titleEfforts: Object.freeze(['off', 'none', 'minimal', 'low']),
  timeoutMs: 60000,
})

/** 把流的结束原因换成标题请求的失败。 */
function finishError(finish) {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-title-headtail: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-title-headtail: title model unexpectedly requested a tool')
    default:
      return new Error(`session-title-headtail: unsupported finish reason "${String(finish.kind)}"`)
  }
}

/** 配置里固定了 provider 和 model 就用它们，否则用会话日志里最近一次主请求的路由。 */
function resolveRoute(config, request) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  if (request.route === undefined) throw new Error('session-title-headtail: no logged request route; set provider and model together')
  return request.route
}

/**
 * 按首条（和最近的对话）起一个标题。
 * @param {object} ctx 插件上下文（要有 llm）。
 * @param {object} config 校验过的配置。
 * @param {object} dsh DSH 的构造：BlockAssembler、createUserMessage、deadline、normalizeSessionTitle。
 * @param {string} providerId 打上标题服务品牌的提供方 id。
 * @param {object} request 标题服务给的一次请求。
 * @param {boolean} withContext 除了首条，是否也取最近的对话。
 * @returns {Promise<{title: string, messageSeqs: number[], model: {provider: string, model: string}}>} 标题、用到的用户消息序号和模型路由。
 */
async function generate(ctx, config, dsh, providerId, request, withContext) {
  request.signal.throwIfAborted()
  const first = request.messages[0]
  if (first === undefined) throw new Error('session-title-headtail: no eligible human message')
  const sample = selectSample(conversationOf(request.session.snapshotEvents()), first, config, withContext)
  const messageSeqs = humanSeqsOf(sample, request.messages)
  const route = resolveRoute(config, request)
  const system = systemPrompt(config, withContext)
  const messages = [
    dsh.createUserMessage({
      content: [{ type: 'text', text: frameSample(sample) }],
      source: { kind: 'dsh-session-title-llm' },
    }),
  ]
  const call = dsh.deadline(request.signal, config.timeoutMs, TIMEOUT_CODE)
  try {
    const effort = titleEffortOf(await ctx.llm.resolveModelInfo(route.provider, route.model, call.signal), config.titleEfforts)
    call.signal.throwIfAborted()
    request.session.append('session/title-llm-request', {
      titleProvider: providerId,
      messageSeqs,
      route,
      system,
      messages,
      maxTokens: config.maxOutputTokens,
    })
    call.signal.throwIfAborted()
    const assembler = new dsh.BlockAssembler()
    const options = Object.freeze({
      provider: route.provider,
      model: route.model,
      messages,
      system,
      maxTokens: config.maxOutputTokens,
      sessionId: request.session.id,
      purpose: 'session-title',
      signal: call.signal,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })
    for await (const chunk of ctx.llm.stream(options)) {
      call.signal.throwIfAborted()
      assembler.push(chunk)
    }
    call.signal.throwIfAborted()
    const failure = finishError(assembler.finish)
    if (failure !== undefined) throw failure
    const blocks = assembler.blocks()
    if (blocks.some((block) => block.type === 'tool-call')) throw new Error('session-title-headtail: title output must contain text only')
    const title = dsh.normalizeSessionTitle(
      blocks.filter((block) => block.type === 'text').map((block) => block.text).join(' '),
      Number.MAX_SAFE_INTEGER,
    )
    if (title.length === 0) throw new Error('session-title-headtail: title model produced no text')
    return { title, messageSeqs, model: route }
  } finally {
    call[Symbol.dispose]()
  }
}

/** 会话是不是子智能体的（不是人发起的对话）。 */
function isSubagent(session) {
  return session.header.origin !== undefined || (session.header.delegationDepth ?? 0) > 0
}

/**
 * 注册标题提供方、轮末的补救和重算、`/retitle`。全部登记在 ctx 上，这一行撤下时一起撤。
 * 标题服务同时只接受一个提供方：先收回 DSH 自带那一行（OFFICIAL_ROW）的许可，等它的提供方注销完、在途的请求收尾，
 * 再注册自己的；撤下时倒过来，先注销自己的，再交还许可，DSH 自带的那一行随即重新挂上。轮末监听和 `/retitle` 不等许可。
 * @param {object} ctx 插件上下文（要有 sessionTitle、llm）。
 * @param {object} config 校验过的配置。
 * @param {{BlockAssembler: new () => object, createUserMessage: Function, deadline: Function, SessionTitleProviderId: (id: string) => string, normalizeSessionTitle: Function}} dsh DSH 的构造。
 * @throws {Error} provider 和 model 没有同时设置时。
 */
export function registerSessionTitle(ctx, config, dsh) {
  if (Boolean(config.provider) !== Boolean(config.model)) throw new Error('session-title-headtail: provider and model must be set together')
  const providerId = dsh.SessionTitleProviderId(PROVIDER_ID)
  // 这几个会话的这一次重算要带最近的对话（/retitle、轮末重算）；别的生成（自动的首条起名）只看首条。
  const contextual = new Set()
  const refreshWithContext = async (session, signal) => {
    contextual.add(session.id)
    try {
      return await ctx.sessionTitle.refresh(session, signal)
    } finally {
      contextual.delete(session.id)
    }
  }
  const provider = {
    id: providerId,
    automatic: 'first-prompt',
    generate: (request) => generate(ctx, config, dsh, providerId, request, contextual.has(request.session.id)),
  }
  // 同一个 effect 里的撤销函数倒序、一个接一个跑：先注销提供方（等它在途的请求收尾），再交还许可。
  ctx.effect(async function* () {
    const claim = claimOfficialRow(OFFICIAL_ROW)
    yield () => claim.release()
    await claim.ready
    yield ctx.sessionTitle.register(provider)
  }, '@miint-sunny/dsh-workbench/session-title: title provider')

  // 轮末做的事，都不覆盖用户改过的标题：
  // - 又发过消息、标题还是临时标题的会话（首条起名失败了，或者是这一行装上之前的旧会话）：每次启动只看首条重试一次；
  // - refreshEveryPrompts 大于 0 时，每隔这么多条消息带最近的对话重算一次。
  const inFlight = new Set()
  const retried = new Set()
  const track = (session, operation, what) => {
    inFlight.add(session.id)
    operation
      .catch((error) => ctx.logger.warn(`session "${session.id}": ${what} failed: ${String(error)}`))
      .finally(() => inFlight.delete(session.id))
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || isSubagent(session) || inFlight.has(session.id)) return
    const current = ctx.sessionTitle.get(session)
    if (current === undefined || current.source.kind === 'user') return
    const since = promptsSince(session.snapshotEvents(), current.messageSeqs)
    if (current.source.kind === 'fallback') {
      if (since < 1 || retried.has(session.id)) return
      retried.add(session.id)
      track(session, ctx.sessionTitle.refresh(session), 'first-prompt title retry')
      return
    }
    if (config.refreshEveryPrompts === 0 || since < config.refreshEveryPrompts) return
    track(session, refreshWithContext(session), 'head+tail title refresh')
  })

  ctx.inject(['commands'], (commandsCtx) => {
    const active = new Set()
    commandsCtx.effect(function* () {
      yield async () => {
        await Promise.allSettled(active)
      }
      yield commandsCtx.commands.register({
        name: 'retitle',
        description: '用开头和最近的对话重新生成本会话标题（会替换手动改过的标题）',
        handler: (invocation) => {
          const operation = retitle(refreshWithContext, invocation)
          active.add(operation)
          const retire = () => active.delete(operation)
          operation.then(retire, retire)
          return operation
        },
      })
    }, '@miint-sunny/dsh-workbench/session-title: retitle command')
  })
}

/** 对发起命令的会话执行一次 `/retitle`，带最近的对话。 */
async function retitle(refreshWithContext, invocation) {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: '用法：/retitle（不带参数）' }
  try {
    const snapshot = await refreshWithContext(invocation.agent.session, invocation.signal)
    return snapshot === undefined
      ? { kind: 'error', text: '这个会话还没有可用来起标题的消息。' }
      : { kind: 'success', text: `会话标题：${snapshot.title}` }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: '已取消。' }
    return { kind: 'error', text: `重新生成标题失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 闲时压缩这一行：把官方服务接到 compaction-service.js 的调度器，注册路由、llm/stream 和 agent/pre-step 的监听，
 * 让 `/compact` 能带说明文字。只调官方接口，不覆盖预设，不新增会话事件；关掉这一行，官方行为完全恢复。
 * 设计和取舍见 docs/plans/2026-11-09-闲时压缩和上下文页.md。
 */
import { join } from 'node:path'
import { registerFeature } from './features.js'
import { workbenchDataDir } from './data-dir.js'
import { cacheLife } from './cache-life.js'
import { parseCompactionConfig } from './compaction-config.js'
import { officialLine } from './compaction-policy.js'
import { SEVEN_ITEMS } from './compaction-prompt.js'
import { createCompactionService, createPromptSwap } from './compaction-service.js'
import { createCompactionState, TIER_MIN, TIER_STEP } from './compaction-state.js'
import { readDigestRows } from './usage-store.js'

export const name = '@miint-sunny/dsh-workbench/compaction'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
/** 压完还在的注入：记忆文件、技能、运行时上下文。 */
const KEPT_KINDS = new Set(['agent-instructions', 'skill-catalog', 'skill-invocation', 'runtime-context', 'time-context'])
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const failure = (code, status) => reply({ error: { code } }, status)

/** 工具调用没配对的地方不能切。@param {object} session 官方 session。@returns {function(number): boolean} 切点检查。 */
function balanceOf(session) {
  const balanced = new Map()
  const open = new Set()
  for (const seq of session.surface.nodes) {
    balanced.set(seq, open.size === 0)
    const event = session.eventAt(seq)
    if (event.type === 'assistant/message') for (const block of event.data.message?.content ?? []) if (block.type === 'tool-call') open.add(block.id)
    if (event.type === 'tool/result') open.delete(event.data.message?.toolCallId ?? event.data.message?.source?.callId)
  }
  return seq => balanced.get(seq) === true
}

/**
 * 主会话：不是子智能体建的会话。0.2.2-rc.2 的 agents 服务只有 get、list，判断照官方 dsh-action-cards 的 isLiveRoot。
 * @param {object} agent 官方 agent。
 * @returns {boolean} 主会话时 true。
 */
const isRootSession = agent => agent.session.header?.origin !== 'subagent'

/**
 * 官方服务的适配层。调度器只见到这些函数，测试用假的。
 * @param {object} scope 带 agents、agentPresets、tokenMeter、llm、sessionProjections 的上下文。
 * @param {object} config 这一行的配置。
 * @returns {object} 调度器要的 host。
 */
export function createHost(scope, config) {
  const presets = new Set(config.presets)
  const infos = new Map()
  const engineOf = agent => scope.agentPresets.serviceFor(agent, 'compaction')
  const pressureOf = agent => scope.sessionProjections.snapshot(agent.session)?.values?.contextPressure
  /** 模型信息按路由记一份；第一次还没拿到时输出预留未知，官方线就不算。 */
  function infoFor(target) {
    if (target === undefined) return undefined
    const key = `${target.provider}/${target.model}`
    if (!infos.has(key)) {
      infos.set(key, undefined)
      Promise.resolve(scope.llm.resolveModelInfo(target.provider, target.model, AbortSignal.timeout(10_000))).then(info => infos.set(key, info), () => infos.delete(key))
    }
    return infos.get(key)
  }
  function limits(agent) {
    const target = agent.session.requestHeader()?.config
    const info = infoFor(target)
    const window = info?.context?.contextWindow ?? pressureOf(agent)?.contextWindow ?? null
    const output = target?.maxTokens ?? info?.defaultMaxTokens ?? null
    const engine = engineOf(agent)
    return { window, output, headroom: engine?.config?.headroomTokens ?? null, official: engine === undefined ? null : officialLine({ window, output, thresholdRatio: engine.config.thresholdRatio, headroomTokens: engine.config.headroomTokens }) }
  }
  return {
    roots: () => scope.agents.list().filter(isRootSession),
    get: id => scope.agents.get(id),
    allowed: agent => presets.has(scope.agentPresets.composedPreset(agent.ctx)) && engineOf(agent) !== undefined,
    root: agent => scope.agents.get(agent.id) === agent && isRootSession(agent),
    parent: agent => agent.session.header?.parentSession,
    status: agent => agent.status,
    used(agent) {
      const pressure = pressureOf(agent)
      return pressure?.projectedTokens ?? pressure?.pressureTokens ?? null
    },
    inbox(agent) {
      const inbox = scope.sessionProjections.snapshot(agent.session)?.values?.inbox
      return (inbox?.['next-turn']?.length ?? 0) + (inbox?.['next-step']?.length ?? 0)
    },
    lastTurn(agent) {
      const { session } = agent
      for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(seq)
        if (event?.type === 'turn/end') return { kind: event.data?.reason?.kind ?? null, at: event.time }
      }
      return null
    },
    activity: agent => scope.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([])),
    limits,
    measure(agent) {
      const { session } = agent
      const measured = scope.tokenMeter.measure(session, session.requestHeader())
      const nodes = measured.nodes
      const firstIndex = nodes.length > 0 && session.eventAt(nodes[0].seq)?.type === 'system/message' ? 1 : 0
      let compactable = 0
      for (let index = firstIndex; index < nodes.length - 1; index += 1) {
        const event = session.eventAt(nodes[index].seq)
        if (event?.type === 'user/message' && KEPT_KINDS.has(event.data?.source?.kind)) continue
        compactable += nodes[index].tokens
      }
      return { total: measured.totalTokens, compactable, nodes, firstIndex, balancedBefore: balanceOf(session), ...limits(agent) }
    },
    prune: agent => scope.agentPresets.serviceFor(agent, 'toolResultPruner')?.pruneSession(agent.session),
    compactNow: (agent, signal) => engineOf(agent).compactNow(agent, signal),
    compactRegion: (start, end, agent, signal) => engineOf(agent).compactRegion(start, end, agent, signal),
  }
}

/**
 * 注册读写路由，严格校验参数，失败响应不带内部信息。
 * @param {object} scope 带 connection 的上下文。
 * @param {object} deps service、state、host、config、life（算缓存寿命）。
 * @returns {function(): void} 注销函数。
 */
export function applyCompactionRoutes(scope, { service, state, host, config, life }) {
  const describe = async (id, provider) => {
    const agent = host.get(id)
    const limits = agent === undefined ? null : host.limits(agent)
    const view = service.view(id)
    return {
      ...view,
      live: agent !== undefined,
      allowed: agent === undefined ? null : host.allowed(agent),
      root: agent === undefined ? null : host.root(agent),
      presets: config.presets,
      defaultPreset: scope.agentPresets?.defaultId ?? null,
      official: limits,
      used: agent === undefined ? null : host.used(agent),
      tiers: { step: TIER_STEP, min: TIER_MIN },
      idleMinutes: config.idleChoices,
      minCompactable: config.minCompactable,
      life: provider === undefined || view.settings.idle === null ? null : await life(provider),
      note: provider === undefined ? null : config.cacheNotes[provider] ?? null,
    }
  }
  const settings = () => ({ prompt: state.prompt(), defaults: state.defaults(), seven: SEVEN_ITEMS, reason: state.reason(), tiers: { step: TIER_STEP, min: TIER_MIN }, idleMinutes: config.idleChoices })
  const body = async request => {
    const value = await request.json().catch(() => null)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  }
  const routes = [
    scope.connection.fetch.register({
      path: '/api/dsh-workbench.compaction', methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') {
          const query = new URL(request.url).searchParams
          const id = query.get('sessionId')
          const provider = query.get('provider') ?? undefined
          if ([...query.keys()].some(key => key !== 'sessionId' && key !== 'provider') || query.getAll('sessionId').length !== 1 || !SESSION_ID.test(id ?? '') || (provider !== undefined && !PROVIDER.test(provider))) return failure('invalid-session', 400)
          return reply(await describe(id, provider))
        }
        const value = await body(request)
        if (value === null || !SESSION_ID.test(value.sessionId ?? '') || Object.keys(value).some(key => !['sessionId', 'set', 'reset', 'cancel', 'provider'].includes(key))) return failure('invalid-request', 400)
        if (value.provider !== undefined && !PROVIDER.test(value.provider)) return failure('invalid-request', 400)
        try {
          if (value.cancel === true) service.cancel(value.sessionId)
          else if (value.reset === true) service.resetSession(value.sessionId)
          else service.setSession(value.sessionId, value.set ?? {})
        } catch (error) {
          return /invalid/.test(error.message) ? failure('invalid-settings', 400) : failure('write-failed', 500)
        }
        return reply(await describe(value.sessionId, value.provider))
      },
    }),
    scope.connection.fetch.register({
      path: '/api/dsh-workbench.compaction.settings', methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') return reply(settings())
        const value = await body(request)
        if (value === null || Object.keys(value).some(key => !['prompt', 'defaults'].includes(key))) return failure('invalid-request', 400)
        try {
          if (value.prompt !== undefined) state.setPrompt(value.prompt)
          if (value.defaults !== undefined) service.setDefaults(value.defaults)
        } catch (error) {
          return /invalid/.test(error.message) ? failure('invalid-settings', 400) : failure('write-failed', 500)
        }
        return reply(settings())
      },
    }),
  ]
  return () => { for (const dispose of routes) dispose() }
}

/**
 * 缓存寿命读用量摘要，隔一段时间才重算，只有页面要的时候才读。
 * 只统计会话头预设在 presets（这一行会压缩的预设）里的会话。名单外预设的长间隔请求命中率低，混进来会把同提供方的缓存寿命估成已过期。
 * @param {{dir: string, presets: string[], refreshMs: number, now?: function(): number}} options 摘要目录、算哪些预设的会话、刷新间隔。
 * @returns {function(string): Promise<object>} 输入提供方，返回 cacheLife 的结果。
 */
export function createLifeReader({ dir, presets, refreshMs, now = Date.now }) {
  const counted = new Set(presets)
  let rows
  let readAt = -Infinity
  return async provider => {
    if (rows === undefined || now() - readAt >= refreshMs) {
      rows = (await readDigestRows(dir)).filter(row => counted.has(row.preset))
      readAt = now()
    }
    return cacheLife(rows, provider)
  }
}

/**
 * 注册这一行。
 * @param {object} ctx 插件上下文。
 * @param {object} options 行的 config，字段见 compaction-config.js。
 * @returns {void}
 */
export function apply(ctx, options) {
  const config = parseCompactionConfig(options)
  ctx.effect(() => registerFeature('compaction'), '@miint-sunny/dsh-workbench/compaction: feature registration')
  ctx.inject(['agents', 'agentPresets', 'tokenMeter', 'llm', 'commands', 'sessionProjections'], scope => {
    const dir = config.dir ?? workbenchDataDir()
    const state = createCompactionState({ dir, idleChoices: config.idleChoices })
    const host = createHost(scope, config)
    const service = createCompactionService({ host, config, state, logger: scope.logger ?? console })
    const extras = new Map()
    const swap = createPromptSwap({
      prompt: () => state.prompt(),
      allowed: id => { const agent = host.get(id); return agent !== undefined && host.allowed(agent) },
      extra: id => extras.get(id),
    })
    const fibers = new Map()
    /** 官方 /compact 拒绝带文字。在名单内的会话里注册同 definitionId 的命令，把文字留给这次的提示词，其余交给官方。 */
    function mountCommand(agent) {
      if (fibers.has(agent.id) || !host.allowed(agent) || !host.root(agent)) return
      const official = scope.commands.find(agent, 'compact')
      if (official === undefined) return
      fibers.set(agent.id, agent.ctx.plugin({
        name: '@miint-sunny/dsh-workbench/compaction-command',
        inject: ['commands'],
        apply(inner) {
          inner.effect(() => inner.commands.register({
            definitionId: official.definitionId,
            name: 'compact',
            description: official.description,
            // 输入框靠 input 判断这条命令能带文字；没有它，/compact 说明文字 会被当成普通消息发给模型。
            input: { hint: '[text]' },
            async handler(invocation) {
              const text = invocation.rawInput.trim()
              if (text === '') return official.handler(invocation)
              extras.set(agent.id, text)
              try { return await official.handler({ agent: invocation.agent, signal: invocation.signal, commandId: invocation.commandId, rawInput: '' }) } finally { extras.delete(agent.id) }
            },
          }), '@miint-sunny/dsh-workbench/compaction: compact with instructions')
        },
      }))
    }
    const attach = agent => {
      try { service.created(agent); mountCommand(agent) } catch (error) { scope.logger?.warn?.(`dsh-workbench/compaction: ${error.message}`) }
    }
    scope.on('agent/created', ({ agent }) => attach(agent))
    scope.on('agent/disposed', ({ agent }) => { service.disposed(agent); fibers.delete(agent.id) })
    scope.on('agent/status', ({ agent, status }) => service.status(agent, status))
    scope.on('agent/inbox/inserted', ({ agent }) => service.inboxInserted(agent))
    scope.on('agent/pre-step', async ({ agent, signal }, next) => {
      try { await service.preStep(agent, signal) } catch (error) { scope.logger?.warn?.(`dsh-workbench/compaction: ${error.message}`) }
      return next()
    }, { prepend: true })
    scope.on('llm/stream', (request, next) => {
      const messages = swap(request)
      return messages === undefined ? next() : scope.llm.stream({ ...request, messages })
    }, { prepend: true })
    for (const agent of host.roots()) attach(agent)
    scope.effect(() => () => service.dispose(), '@miint-sunny/dsh-workbench/compaction: timers')
    scope.effect(() => () => { for (const fiber of fibers.values()) fiber.dispose() }, '@miint-sunny/dsh-workbench/compaction: commands')
    const life = createLifeReader({ dir: join(dir, 'usage'), presets: config.presets, refreshMs: config.lifeRefreshMinutes * 60_000 })
    // 路由单独等 connection：调度不依赖 HTTP，无头运行时也照常。
    scope.inject(['connection'], web => {
      web.effect(() => applyCompactionRoutes(web, { service, state, host, config, life }), '@miint-sunny/dsh-workbench/compaction: routes')
    })
  })
}

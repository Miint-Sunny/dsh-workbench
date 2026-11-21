/**
 * 闲时压缩的调度：每个会话一个定时器，一次只压一个，429 全局冷却。不轮询，判断都在 compaction-policy.js。
 * 官方服务都经 host 进来（真实实现在 compaction.js），`node --test` 用假的 host 测调度。
 */
import { armDecision, classifyFailure, fireDecision, resumeDecision, retainTokens, selectRegion, workLineDecision } from './compaction-policy.js'
import { swapInstruction } from './compaction-prompt.js'

const MINUTE = 60_000

/**
 * 创建调度器。
 * @param {object} deps host（官方服务）、config、state（设置）、now、schedule、cancel、logger。
 * @returns {object} 事件入口 status、created、disposed、inboxInserted、preStep，操作 setSession、resetSession、setDefaults、cancel，查询 view，以及 dispose。
 */
export function createCompactionService({ host, config, state, now = Date.now, schedule = defaultSchedule, cancel: cancelTimer = clearTimeout, logger = console }) {
  const runtimes = new Map()
  const lateMs = config.lateMinutes * MINUTE
  let queue = []
  let flight = null
  let cooldownUntil = 0
  let stopped = false

  const runtimeOf = id => {
    let runtime = runtimes.get(id)
    if (runtime === undefined) { runtime = { state: 'off' }; runtimes.set(id, runtime) }
    return runtime
  }
  const settingsOf = agent => state.effective(agent.id, host.parent?.(agent))
  const clear = runtime => {
    if (runtime.timer !== undefined) cancelTimer(runtime.timer)
    runtime.timer = undefined
    runtime.dueAt = undefined
  }

  /** 一轮结束、会话打开、设置改了时算一次：开定时器，或者记下为什么不开。一段空闲试过一次就不再试，用户改设置时除外。 */
  function evaluate(agent, { fromSettings = false } = {}) {
    if (stopped) return
    const runtime = runtimeOf(agent.id)
    const lastTurn = host.lastTurn(agent)
    if (!fromSettings && lastTurn !== null && runtime.triedTurnAt === lastTurn.at) return
    clear(runtime)
    queue = queue.filter(id => id !== agent.id)
    const settings = settingsOf(agent)
    const decision = armDecision({ allowed: host.allowed(agent), root: host.root(agent), status: host.status(agent), turnKind: lastTurn?.kind ?? null, idle: settings.idle, work: settings.work, used: host.used(agent) })
    if (!decision.arm) { runtime.state = decision.reason; return }
    const resume = resumeDecision({ endedAt: lastTurn.at, now: now(), idleMinutes: settings.idleMinutes, lateMs })
    if (resume.action === 'stale') { runtime.state = 'stale'; return }
    runtime.state = 'armed'
    runtime.dueAt = resume.dueAt
    runtime.timer = schedule(() => fire(agent.id), Math.max(0, resume.dueAt - now()))
  }

  async function fire(id) {
    const agent = host.get(id)
    const runtime = runtimeOf(id)
    runtime.timer = undefined
    if (stopped || agent === undefined) return
    const activity = await host.activity(agent)
    if (stopped || (runtime.state !== 'armed' && runtime.state !== 'queued')) return
    const settings = settingsOf(agent)
    if (settings.idle === null) { runtime.state = 'off'; return }
    const measured = host.measure(agent)
    const decision = fireDecision({ status: host.status(agent), inbox: host.inbox(agent), activity, now: now(), dueAt: runtime.dueAt, lateMs, cooldownUntil, busy: flight !== null, idle: settings.idle, used: measured.total, compactable: measured.compactable, minCompactable: config.minCompactable })
    if (decision.wait) { runtime.state = 'queued'; if (!queue.includes(id)) queue.push(id); return }
    if (!decision.go) { runtime.state = decision.reason === 'slept' ? 'stale' : decision.reason; return }
    await run(agent, runtime)
  }

  async function run(agent, runtime) {
    clear(runtime)
    queue = queue.filter(id => id !== agent.id)
    const controller = new AbortController()
    const before = host.used(agent)
    runtime.triedTurnAt = host.lastTurn(agent)?.at
    runtime.state = 'compacting'
    runtime.code = undefined
    runtime.message = undefined
    const timeout = schedule(() => controller.abort(Object.assign(new Error('compaction timed out'), { code: 'timeout' })), config.timeoutMs)
    let settled
    flight = { id: agent.id, controller, done: new Promise(resolve => { settled = resolve }) }
    try {
      const result = await host.compactNow(agent, controller.signal)
      runtime.state = result === null ? 'small' : 'done'
      if (result !== null) Object.assign(runtime, { at: now(), before, after: host.used(agent) })
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason?.code !== 'timeout') runtime.state = 'cancelled'
      else {
        const timedOut = controller.signal.reason?.code === 'timeout'
        const rate = !timedOut && classifyFailure(error) === 'rate'
        if (rate) cooldownUntil = now() + config.cooldownMinutes * MINUTE
        Object.assign(runtime, { state: 'failed', at: now(), code: timedOut ? 'timeout' : rate ? 'rate' : 'error', message: String(error?.message ?? error).slice(0, 160) })
        logger.warn(`dsh-workbench/compaction: idle compaction failed: ${runtime.message}`)
      }
    } finally {
      cancelTimer(timeout)
      flight = null
      settled()
    }
    while (!stopped && flight === null && queue.length > 0) {
      await fire(queue.shift())
    }
  }

  function reevaluate(id, patch) {
    const agent = host.get(id)
    if (agent === undefined) return
    evaluate(agent, { fromSettings: true })
    if (patch?.work === undefined || patch.work === null || flight !== null || host.status(agent) !== 'idle') return
    const decision = workLineDecision({ allowed: host.allowed(agent), root: host.root(agent), line: patch.work, official: host.measure(agent).official, used: host.used(agent), failedThisTurn: false })
    if (decision.compact) void run(agent, runtimeOf(id))
  }

  return {
    /**
     * agent/status 事件。
     * @param {object} agent 官方 agent。
     * @param {string} status idle 或 running。
     * @returns {void}
     */
    status(agent, status) {
      if (stopped) return
      const runtime = runtimeOf(agent.id)
      if (status === 'idle') { evaluate(agent); return }
      clear(runtime)
      queue = queue.filter(id => id !== agent.id)
      if (runtime.state !== 'compacting') runtime.state = 'running'
    },
    /** @param {object} agent 刚打开或恢复的 agent。@returns {void} */
    created: agent => evaluate(agent),
    /** @param {object} agent 关掉的 agent。@returns {void} */
    disposed(agent) {
      const runtime = runtimes.get(agent.id)
      if (runtime !== undefined) clear(runtime)
      queue = queue.filter(id => id !== agent.id)
      if (flight?.id === agent.id) flight.controller.abort(new Error('session closed'))
      runtimes.delete(agent.id)
    },
    /** @param {object} agent 收到消息的 agent：压着的话取消，让消息马上走。@returns {void} */
    inboxInserted(agent) {
      if (flight?.id === agent.id) flight.controller.abort(new Error('message arrived'))
    },
    /**
     * agent/pre-step：选了工作线的会话，到线就压最老的一段，留尾部。失败不打断这一轮。
     * @param {object} agent 官方 agent。
     * @param {AbortSignal} signal 这一步的取消信号。
     * @returns {Promise<void>} 压完或不用压。
     */
    async preStep(agent, signal) {
      if (stopped) return
      const line = settingsOf(agent).work
      if (line === null) return
      const runtime = runtimeOf(agent.id)
      const base = { allowed: host.allowed(agent), root: host.root(agent), line, failedThisTurn: false }
      if (!workLineDecision({ ...base, official: null, used: host.used(agent) }).compact) return
      // 这一轮试过就不再试。「这一轮」用上一个 turn/end 认：下一轮开始时它就变了。
      const turn = host.lastTurn(agent)?.at ?? 0
      if (runtime.gaveUpAfterTurn === turn) return
      const giveUp = () => { runtime.gaveUpAfterTurn = turn }
      let measured = host.measure(agent)
      if (!workLineDecision({ ...base, official: measured.official, used: measured.total }).compact) return
      host.prune(agent)
      measured = host.measure(agent)
      if (measured.total < line) return
      const retain = retainTokens({ line, window: measured.window, output: measured.output, ratio: config.retainRatio, divisor: config.retainDivisor })
      const region = selectRegion({ nodes: measured.nodes, firstIndex: measured.firstIndex, retain, balancedBefore: measured.balancedBefore })
      const regionTokens = region === null ? 0 : measured.nodes.reduce((sum, node) => (node.seq >= region.start && node.seq <= region.end ? sum + node.tokens : sum), 0)
      // 尾部一条消息比线还大时，前面压完也下不来。不为这个花钱；后面工具结果多了，下一步再量。
      if (regionTokens < config.minCompactable) return
      try {
        await host.compactRegion(region.start, region.end, agent, signal)
        if (host.measure(agent).total >= line) giveUp()
      } catch (error) {
        giveUp()
        if (!signal.aborted) logger.warn(`dsh-workbench/compaction: work line compaction failed: ${String(error?.message ?? error).slice(0, 160)}`)
      }
    },
    /**
     * 改一个会话的设置。空闲时选了比用量低的工作线就马上压。
     * @param {string} id 会话 id。
     * @param {object} patch work、idle、idleMinutes 里要改的项。
     * @returns {void}
     */
    setSession(id, patch) {
      state.setSession(id, patch)
      reevaluate(id, patch)
    },
    /** @param {string} id 会话 id：回到默认。@returns {void} */
    resetSession(id) {
      state.resetSession(id)
      reevaluate(id)
    },
    /** @param {object} patch 新会话默认的改动。@returns {void} */
    setDefaults(patch) {
      state.setDefaults(patch)
      for (const agent of host.roots()) evaluate(agent, { fromSettings: true })
    },
    /** @param {string} id 会话 id：停下正在压的，或者取消等着的定时器。@returns {void} */
    cancel(id) {
      const runtime = runtimes.get(id)
      if (runtime !== undefined) {
        clear(runtime)
        if (runtime.state === 'armed' || runtime.state === 'queued') runtime.state = 'cancelled'
      }
      queue = queue.filter(queued => queued !== id)
      if (flight?.id === id) flight.controller.abort(new Error('cancelled'))
    },
    /**
     * 页面要的状态。
     * @param {string} id 会话 id。
     * @returns {{settings: object, defaults: object, reason: string|null, runtime: object}} 设置、默认和调度状态。
     */
    view(id) {
      const agent = host.get(id)
      const settings = agent === undefined ? state.effective(id) : settingsOf(agent)
      const runtime = runtimes.get(id)
      const { timer: _timer, gaveUpAfterTurn: _gaveUp, triedTurnAt: _tried, ...visible } = runtime ?? { state: settings.idle === null ? 'off' : 'inactive' }
      return { settings, defaults: state.defaults(), reason: state.reason(), runtime: visible }
    },
    /** @returns {Promise<void>} 清掉定时器，等压到一半的结束。 */
    async dispose() {
      stopped = true
      for (const runtime of runtimes.values()) clear(runtime)
      queue = []
      if (flight !== null) { flight.controller.abort(new Error('row disposed')); await flight.done }
    },
  }
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

/**
 * 压缩提示词的替换判断，给 llm/stream 监听用。重发的请求会再经过一次监听，靠上次发出的文字认出来，自定义文字以官方开头时也不会循环。
 * @param {{prompt: function(): object, allowed: function(string): boolean, extra: function(string): (string|undefined)}} deps 全局设置、预设名单和这次的补充。
 * @returns {function(object): (object[]|undefined)} 输入 llm/stream 的请求，返回新的消息列表；不用换时是 undefined。
 */
export function createPromptSwap({ prompt, allowed, extra }) {
  const lastSent = new Map()
  return options => {
    if (options.purpose !== 'compaction' || options.sessionId === undefined) return undefined
    const text = options.messages?.at(-1)?.content?.[0]?.text
    if (text !== undefined && lastSent.get(options.sessionId) === text) return undefined
    if (!allowed(options.sessionId)) return undefined
    const messages = swapInstruction(options, { ...prompt(), extra: extra(options.sessionId) })
    if (messages !== undefined) lastSent.set(options.sessionId, messages.at(-1).content[0].text)
    return messages
  }
}

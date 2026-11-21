/**
 * 会话标题并进工作台后的宿主端（feat#217）：真跑 lib/session-title.js 的 apply，DSH 换成下面的替身。
 * 替身照 DSH 0.2.2-rc.5 的几处行为写：标题服务同时只有一个提供方，register 返回撤销函数、登记在调用方的 ctx 上；
 * 轮末是 session/event 的 turn/end；/retitle 经 commands 注册，返回撤销函数。effect 照 cordis：async generator 的
 * effect 在后台跑，yield 出来的撤销函数归这个 effect，撤下时倒序、一个接一个跑。
 * lib/session-title.js 依赖的四个 DSH 包用 module.registerHooks 换成替身：schemastery 记下每个字段的默认值，
 * BlockAssembler 把流里的文字收成一块，deadline 交回调用方的 signal。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const STUBS = {
  '@deepseek-ai/schemastery': `
    const field = () => {
      const node = { defaultValue: undefined }
      for (const name of ['step', 'min', 'max', 'description']) node[name] = () => node
      node.default = value => { node.defaultValue = value; return node }
      return node
    }
    const z = { number: field, string: field, array: field, object: shape => ({ shape }) }
    export default z`,
  '@deepseek-ai/dsh-llm': `
    export const createUserMessage = message => ({ role: 'user', ...message })
    export class BlockAssembler {
      constructor() { this.text = ''; this.finish = { kind: 'stop' } }
      push(chunk) { if (chunk.type === 'text') this.text += chunk.text }
      blocks() { return [{ type: 'text', text: this.text }] }
    }`,
  '@deepseek-ai/dsh-timeout': 'export const deadline = signal => ({ signal, [Symbol.dispose]() {} })',
  '@deepseek-ai/dsh-session-title': 'export const SessionTitleProviderId = id => id; export const normalizeSessionTitle = text => text.trim()',
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, format: 'module', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const row = await import('../lib/session-title.js')
const { DEFAULTS, PROVIDER_ID } = await import('../lib/session-title-provider.js')
const { enabledFeatures } = await import('../lib/features.js')

const human = (seq, text) => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const assistant = (seq, text) => ({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const turnEnd = seq => ({ type: 'turn/end', seq, data: {} })

/** 一个会话：日志、追加的事件、标题服务里的当前标题。 */
function sessionOf(id, events, { title, header = {} } = {}) {
  return { id, header, events, appended: [], title, snapshotEvents: () => events, append(type, data) { this.appended.push({ type, data }) } }
}

/**
 * 替身宿主。register 和 commands.register 的撤销函数登记在调用方的 ctx 上，disposeAll 对应插件页关掉这一行。
 * @param {{ answer?: string, failRefresh?: Error, onRegister?: () => void, onUnregister?: () => void }} [options] 模型回答的标题、refresh 要抛的错、注册和注销时的回调。
 */
function createHost({ answer = '新标题', failRefresh, onRegister, onUnregister } = {}) {
  const providers = []
  const commands = new Map()
  const listeners = new Set()
  const refreshes = []
  const requests = []
  const warnings = []
  const disposers = []
  const running = []
  const keep = dispose => { disposers.push(dispose); return dispose }
  const runEffect = (body) => {
    const result = body()
    if (typeof result === 'function') return keep(result)
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      const collected = []
      const task = (async () => {
        for await (const dispose of result) {
          // 照 cordis：yield 出来的撤销函数从 ctx 上挪进这个 effect。
          if (disposers.includes(dispose)) disposers.splice(disposers.indexOf(dispose), 1)
          collected.push(dispose)
        }
      })()
      running.push(task)
      keep(async () => {
        await task
        for (const dispose of collected.splice(0).reverse()) await dispose()
      })
      return undefined
    }
    if (result && typeof result[Symbol.iterator] === 'function') for (const dispose of result) keep(dispose)
    return undefined
  }
  const ctx = {
    sessionTitle: {
      register(provider) {
        assert.equal(providers.length, 0, '标题服务同时只接受一个提供方')
        providers.push(provider)
        onRegister?.()
        return keep(async () => { providers.splice(providers.indexOf(provider), 1); onUnregister?.() })
      },
      get: session => session.title,
      async refresh(session, signal) {
        refreshes.push(session.id)
        if (failRefresh) throw failRefresh
        const messages = session.events.filter(event => event.type === 'user/message').map(event => ({ seq: event.seq, text: event.data.content[0].text }))
        const result = await providers[0].generate({ session, messages, route: { provider: 'p', model: 'm' }, signal: signal ?? new AbortController().signal })
        session.title = { title: result.title, messageSeqs: result.messageSeqs, source: { kind: 'provider' } }
        return session.title
      },
    },
    llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
      async *stream(options) {
        requests.push(options)
        yield { type: 'text', text: answer }
      },
    },
    logger: { warn: message => warnings.push(message) },
    on(event, listener) {
      assert.equal(event, 'session/event')
      listeners.add(listener)
      return keep(() => listeners.delete(listener))
    },
    effect: runEffect,
    inject(names, mount) {
      assert.deepEqual(names, ['commands'])
      mount({
        effect: runEffect,
        commands: {
          register(command) {
            commands.set(command.name, command)
            return () => commands.delete(command.name)
          },
        },
      })
    },
    disposeAll: async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() },
  }
  const emit = (session, event) => { for (const listener of [...listeners]) listener(session, event) }
  const ready = () => Promise.all(running)
  return { ctx, providers, commands, listeners, refreshes, requests, warnings, emit, ready }
}

const config = (overrides = {}) => ({ ...DEFAULTS, titleEfforts: [...DEFAULTS.titleEfforts], ...overrides })
const settle = () => new Promise(resolve => setImmediate(resolve))

test('默认值等于独立插件补丁里写的 10 个值；Config 的默认值从这里取，补丁不写显式 config', () => {
  assert.deepEqual({ ...DEFAULTS, titleEfforts: [...DEFAULTS.titleEfforts] }, {
    tailMessages: 6, refreshEveryPrompts: 0, headMaxChars: 2000, messageMaxChars: 1500, maxInputChars: 8000,
    targetWords: 6, targetCjkCharacters: 12, maxOutputTokens: 2048, titleEfforts: ['off', 'none', 'minimal', 'low'], timeoutMs: 60000,
  })
  const defaults = Object.fromEntries(Object.entries(row.Config.shape).filter(([, node]) => node.defaultValue !== undefined).map(([key, node]) => [key, node.defaultValue]))
  assert.deepEqual(defaults, { ...DEFAULTS, titleEfforts: [...DEFAULTS.titleEfforts] })
  assert.equal(row.name, '@miint-sunny/dsh-workbench/session-title')
  assert.deepEqual(row.inject, ['sessionTitle', 'llm'])
})

test('标题提供方：id 是 dsh-session-title-headtail，automatic 是 first-prompt；自动起名只看首条，请求先记进会话日志', async () => {
  const host = createHost()
  row.apply(host.ctx, config())
  await host.ready()
  assert.equal(host.providers.length, 1)
  assert.equal(host.providers[0].id, PROVIDER_ID)
  assert.equal(PROVIDER_ID, 'dsh-session-title-headtail')
  assert.equal(host.providers[0].automatic, 'first-prompt')
  const session = sessionOf('s1', [human(1, '写一个解析器'), assistant(2, '好的'), human(3, '换成流式的')])
  const result = await host.providers[0].generate({ session, messages: [{ seq: 1, text: '写一个解析器' }, { seq: 3, text: '换成流式的' }], route: { provider: 'p', model: 'm' }, signal: new AbortController().signal })
  assert.deepEqual(result, { title: '新标题', messageSeqs: [1], model: { provider: 'p', model: 'm' } })
  assert.deepEqual(session.appended.map(event => event.type), ['session/title-llm-request'])
  assert.equal(session.appended[0].data.titleProvider, PROVIDER_ID)
  assert.doesNotMatch(host.requests[0].messages[0].content[0].text, /recent_conversation/)
  assert.equal(host.requests[0].reasoningEffort, 'low')
  assert.equal(host.requests[0].purpose, 'session-title')
  await host.ctx.disposeAll()
})

test('/retitle：注册成命令；带参数时报用法；成功写出新标题并带上最近的对话；失败、没有消息、已取消各有说明', async () => {
  const host = createHost()
  row.apply(host.ctx, config())
  await host.ready()
  const command = host.commands.get('retitle')
  assert.ok(command)
  const session = sessionOf('s1', [human(1, '写一个解析器'), assistant(2, '好的'), human(3, '换成流式的')])
  const invoke = (rawInput, signal = new AbortController().signal) => command.handler({ rawInput, signal, agent: { session } })
  assert.deepEqual(await invoke('现在'), { kind: 'error', text: '用法：/retitle（不带参数）' })
  assert.deepEqual(await invoke(''), { kind: 'success', text: '会话标题：新标题' })
  assert.match(host.requests.at(-1).messages[0].content[0].text, /recent_conversation/)
  assert.deepEqual(host.refreshes, ['s1'])

  const failing = createHost({ failRefresh: new Error('rate limited') })
  row.apply(failing.ctx, config())
  await failing.ready()
  const failed = await failing.commands.get('retitle').handler({ rawInput: '', signal: new AbortController().signal, agent: { session } })
  assert.deepEqual(failed, { kind: 'error', text: '重新生成标题失败：rate limited' })
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await failing.commands.get('retitle').handler({ rawInput: '', signal: aborted.signal, agent: { session } }), { kind: 'error', text: '已取消。' })
  await failing.ctx.disposeAll()

  const empty = createHost()
  empty.ctx.sessionTitle.refresh = async () => undefined
  row.apply(empty.ctx, config())
  await empty.ready()
  assert.deepEqual(await empty.commands.get('retitle').handler({ rawInput: '', signal: new AbortController().signal, agent: { session } }), { kind: 'error', text: '这个会话还没有可用来起标题的消息。' })
  await empty.ctx.disposeAll()
  await host.ctx.disposeAll()
})

test('轮末：临时标题的会话又发过消息时只看首条补一次；手动改过的标题不碰；refreshEveryPrompts 到了才带上下文重算；子智能体不管', async () => {
  const host = createHost()
  row.apply(host.ctx, config({ refreshEveryPrompts: 2 }))
  await host.ready()
  const fallback = sessionOf('fallback', [human(1, '第一条'), human(2, '第二条')], { title: { title: '第一条', messageSeqs: [1], source: { kind: 'fallback' } } })
  host.emit(fallback, turnEnd(3))
  await settle()
  host.emit(fallback, turnEnd(4))
  await settle()
  assert.deepEqual(host.refreshes, ['fallback'], '补救每次启动只做一次')
  assert.doesNotMatch(host.requests[0].messages[0].content[0].text, /recent_conversation/, '补救只看首条')

  const renamed = sessionOf('renamed', [human(1, 'a'), human(2, 'b'), human(3, 'c')], { title: { title: '我起的', messageSeqs: [], source: { kind: 'user' } } })
  host.emit(renamed, turnEnd(4))
  const fresh = sessionOf('fresh', [human(1, 'a'), human(2, 'b')], { title: { title: '模型起的', messageSeqs: [1], source: { kind: 'provider' } } })
  host.emit(fresh, turnEnd(3))
  const subagent = sessionOf('child', [human(1, 'a'), human(2, 'b'), human(3, 'c')], { title: { title: '模型起的', messageSeqs: [1], source: { kind: 'provider' } }, header: { origin: 'subagent' } })
  host.emit(subagent, turnEnd(4))
  await settle()
  assert.deepEqual(host.refreshes, ['fallback'], '手动标题、还没到间隔的、子智能体都不重算')

  const due = sessionOf('due', [human(1, 'a'), assistant(2, 'x'), human(3, 'b'), human(4, 'c')], { title: { title: '模型起的', messageSeqs: [1], source: { kind: 'provider' } } })
  host.emit(due, turnEnd(5))
  await settle()
  assert.deepEqual(host.refreshes, ['fallback', 'due'])
  assert.match(host.requests.at(-1).messages[0].content[0].text, /recent_conversation/, '到了间隔就带上下文重算')
  await host.ctx.disposeAll()
})

test('撤下这一行：提供方注销、/retitle 撤掉、轮末监听撤掉、功能清单里不再有 session-title', async () => {
  const host = createHost()
  row.apply(host.ctx, config())
  await host.ready()
  assert.equal(host.providers.length, 1)
  assert.ok(enabledFeatures().some(feature => feature.id === 'session-title'))
  await host.ctx.disposeAll()
  assert.equal(host.providers.length, 0)
  assert.equal(host.commands.has('retitle'), false)
  assert.equal(host.listeners.size, 0)
  assert.equal(enabledFeatures().some(feature => feature.id === 'session-title'), false)
})

test('provider 和 model 要同时设置，只设一个时这一行加载失败', async () => {
  const host = createHost()
  assert.throws(() => row.apply(host.ctx, config({ provider: 'p' })), /provider and model must be set together/)
  assert.equal(host.providers.length, 0)
  await host.ctx.disposeAll()
})

test('fix#226 先收回 DSH 自带那一行的许可、等它卸载完才注册；撤下时先注销自己的提供方，再交还许可', async () => {
  const { offerOfficialRows, withdrawOfficialRows } = await import('../lib/official-rows.js')
  const log = []
  let unloadOfficial
  let immediate = false
  const guard = {
    provide(key) {
      assert.equal(key, 'dsh-workbench.session-title-llm-allowed')
      log.push('grant')
      return () => {
        log.push('withdraw')
        return immediate ? Promise.resolve() : new Promise(resolve => { unloadOfficial = () => { log.push('official unloaded'); resolve() } })
      }
    },
  }
  offerOfficialRows(guard, 'dsh-workbench', [{ id: 'session-title-llm', inject: ['dsh-workbench.session-title-llm-allowed'] }])
  const host = createHost({ onRegister: () => log.push('register'), onUnregister: () => log.push('unregister') })
  row.apply(host.ctx, config())
  await settle()
  assert.deepEqual(log, ['grant', 'withdraw'])
  assert.equal(host.providers.length, 0, 'DSH 自带的那一行还没卸载完，先不注册')
  assert.ok(host.commands.has('retitle'), '/retitle 不等许可')
  unloadOfficial()
  await host.ready()
  assert.deepEqual(log, ['grant', 'withdraw', 'official unloaded', 'register'])
  await host.ctx.disposeAll()
  assert.deepEqual(log.slice(-2), ['unregister', 'grant'], '先注销自己，再交还许可')
  immediate = true
  withdrawOfficialRows(guard)
})

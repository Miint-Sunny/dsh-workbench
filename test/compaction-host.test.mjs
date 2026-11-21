/**
 * 闲时压缩这一行接官方 agents 服务的部分。0.2.2-rc.2 的 agents 服务只有 get、list，没有 roots：
 * 主会话靠会话头 origin 认出来，空闲压缩、带说明的 /compact、压缩提示词替换都要照常挂上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createHost } from '../lib/compaction.js'
import { parseCompactionConfig } from '../lib/compaction-config.js'
import { OFFICIAL_HEAD } from '../lib/compaction-prompt.js'

/** 只有 get、list 的 agents 服务，和 rc.2 一样。 */
function agentsService(list) {
  return { get: id => list.find(agent => agent.id === id), list: () => [...list] }
}

/** 假的官方 agent：mounted 记下在它的 ctx 里注册的命令。 */
function fakeAgent(id, { origin } = {}) {
  const agent = {
    id,
    status: 'idle',
    mounted: [],
    session: {
      header: origin === undefined ? {} : { origin },
      seq: 1,
      eventAt: () => ({ type: 'turn/end', data: { reason: { kind: 'completed' } }, time: Date.now() }),
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    },
  }
  agent.ctx = {
    plugin(spec) {
      const disposers = []
      spec.apply({ effect: body => { disposers.push(body()) }, commands: { register: definition => { agent.mounted.push(definition); return () => {} } } })
      return { dispose: () => { for (const dispose of disposers) dispose?.() } }
    },
  }
  return agent
}

test('host：agents 服务没有 roots 时，按会话头认主会话，子智能体和已换掉的 agent 不算', () => {
  const root = fakeAgent('root')
  const child = fakeAgent('child', { origin: 'subagent' })
  const host = createHost({ agents: agentsService([root, child]) }, parseCompactionConfig())
  assert.deepEqual(host.roots(), [root])
  assert.equal(host.root(root), true)
  assert.equal(host.root(child), false)
  assert.equal(host.root(fakeAgent('root')), false, '同 id 但不是当前活着的那个 agent')
})

test('整行挂载：agents 服务没有 roots 时，空闲压缩、带说明的 /compact、提示词替换照常挂上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-compaction-host-'))
  const root = fakeAgent('root')
  const child = fakeAgent('child', { origin: 'subagent' })
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const streamed = []
  const official = {
    definitionId: 'official-compact',
    description: 'Compact',
    handler: async ({ agent }) => {
      const request = { purpose: 'compaction', sessionId: agent.id, messages: [{ role: 'user', content: [{ type: 'text', text: `${OFFICIAL_HEAD} for this assistant.` }] }] }
      return listeners.get('llm/stream')(request, () => streamed.push(request.messages))
    },
  }
  const scope = {
    agents: agentsService([root, child]),
    agentPresets: { composedPreset: () => 'standard', serviceFor: (_agent, kind) => kind === 'compaction' ? { config: { thresholdRatio: 0.8, headroomTokens: 20_000 } } : undefined, defaultId: 'standard' },
    tokenMeter: {},
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 8_000 }), stream: request => { streamed.push(request.messages) } },
    commands: { find: (_agent, name) => name === 'compact' ? official : undefined },
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { projectedTokens: 300_000, contextWindow: 1_000_000 } } }) },
    logger: { warn: message => assert.fail(message) },
    on: (name, listener) => { listeners.set(name, listener) },
    effect: body => { disposers.push(body()) },
    inject: (_names, body) => body({ ...scope, effect: inner => { disposers.push(inner()) }, connection: { fetch: { register: route => { routes.set(route.path, route); return () => {} } } } }),
  }
  const ctx = { effect: body => { disposers.push(body()) }, inject: (_names, body) => body(scope) }
  try {
    apply(ctx, { dir })

    assert.deepEqual(root.mounted.map(command => command.name), ['compact'], '主会话挂上带说明的 /compact')
    assert.deepEqual(child.mounted, [], '子智能体不挂')
    for (const name of ['agent/created', 'agent/pre-step', 'llm/stream']) assert.ok(listeners.has(name), name)

    const settings = routes.get('/api/dsh-workbench.compaction.settings')
    const saved = await settings.fetch(new Request('http://dsh/api/dsh-workbench.compaction.settings', { method: 'POST', body: JSON.stringify({ defaults: { idle: 100_000 } }) }))
    assert.equal(saved.status, 200)
    const view = async id => (await routes.get('/api/dsh-workbench.compaction').fetch(new Request(`http://dsh/api/dsh-workbench.compaction?sessionId=${id}`))).json()
    const rootView = await view('root')
    assert.equal(rootView.root, true)
    assert.equal(rootView.runtime.state, 'armed', '改了默认后主会话的空闲压缩排上')
    const childView = await view('child')
    assert.equal(childView.root, false)
    assert.equal(childView.runtime.state, 'inactive', '挂载和改默认都只算主会话')

    await root.mounted[0].handler({ agent: root, signal: AbortSignal.timeout(1_000), commandId: 'c', rawInput: ' 保留改过的文件列表 ' })
    const sent = streamed.at(-1).at(-1).content[0].text
    assert.ok(sent.startsWith(OFFICIAL_HEAD))
    assert.match(sent, /保留改过的文件列表/, '/compact 的说明文字进了压缩提示词')
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

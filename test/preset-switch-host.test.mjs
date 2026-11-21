import assert from 'node:assert/strict'
import test from 'node:test'
import { presetHost } from './helpers/preset-host.mjs'

// Guards the owner-approved rebinding of a started session (recompose, then
// agent-preset/selected). A future DSH that tightens recompose fails here.
test('a started idle session switches through the Workbench route and the next request uses the new preset', {
  skip: !process.env.DSH_APP && 'requires a disposable DSH_APP',
  timeout: 45000,
}, async t => {
  const { extra } = await presetHost({ timeout: 40000, inspect: `
    const assert = (await import('node:assert/strict')).default
    const { pathToFileURL } = await import('node:url')
    const anchor = pathToFileURL(ctx.get('profileContext').installAnchor).href
    const { LlmAdapter } = await loader.internal.import('@deepseek-ai/dsh-llm', anchor, {})
    const provider = 'workbench-test', model = 'preset-test'
    const requests = []
    class RecordingAdapter extends LlmAdapter {
      async listModels() { return [{ provider, id: model, name: model }] }
      async *stream(options) {
        if (options.purpose === undefined) requests.push(structuredClone(options.tools))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.get('llm').registerAdapter([provider], new RecordingAdapter())
    const agents = ctx.get('agents')
    const controller = ctx.get('sessionController')
    const { sessionId } = await controller.create({ cwd: process.cwd(), agentPreset: 'standard' })
    const { agent } = await controller.resolveAgent(sessionId)
    const signal = AbortSignal.timeout(25000)
    const projected = async () => (await controller.projections({ sessionId }, signal)).values.agentPreset
    const selections = []
    ctx.on('session/event', (session, event) => {
      if (session.id === sessionId && event.type === 'agent-preset/selected') selections.push(event.data.agentPreset)
    })

    const code = 'dsh-workbench-coding'
    assert.equal(await projected(), 'standard')
    await controller.selectModel({ sessionId, provider, model })
    async function turn(requestId) {
      const result = await controller.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: 'Reply OK.' }] }, signal)
      assert.equal(result.accepted, true)
      await agent.whenIdle()
    }
    await turn('before-switch')
    const boundary = agents.turnBoundaryOf(agent.session)
    assert.equal(boundary.lastTurn, 1)
    assert.equal(boundary.openTurnStartSeq, null)
    // Official behaviour, unchanged: the registry's own selector still locks a started session.
    await assert.rejects(() => registry.select(agent, code), { code: 'agent-preset/locked' })
    assert.equal(registry.composedPreset(agent.ctx), 'standard')

    const origin = ctx.get('webServer').getOrigin()
    const login = await fetch(ctx.get('connection').authenticatedUrl(origin), { redirect: 'manual', signal })
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
    assert.ok(cookie, 'the disposable Host issued a browser cookie')
    const response = await fetch(new URL('/api/dsh-workbench.preset-switch', origin), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin }, signal,
      body: JSON.stringify({ sessionId, step: 'switch', expectedFrom: 'standard', agentPreset: code }),
    })
    assert.equal(response.status, 200, 'the Workbench preset-switch route is mounted')
    const result = await response.json()
    assert.deepEqual(result, { ok: true, value: { agentPreset: code } })
    assert.equal(await projected(), code)
    assert.equal(registry.composedPreset(agent.ctx), code)
    await turn('after-switch')
    return { requests, selections, current: await projected(), live: registry.composedPreset(agent.ctx),
      turnCount: agents.turnBoundaryOf(agent.session).lastTurn }
  ` })
  assert.equal(extra.turnCount, 2)
  assert.equal(extra.current, 'dsh-workbench-coding')
  assert.equal(extra.live, 'dsh-workbench-coding')
  assert.equal(extra.selections.at(-1), 'dsh-workbench-coding', 'the last agent-preset/selected names the new preset')
  assert.deepEqual(extra.selections, ['dsh-workbench-coding'])
  assert.equal(extra.requests.length, 2)
  const names = request => request.map(tool => tool.name)
  assert.ok(names(extra.requests[0]).includes('plugin_manager'), 'Standard mode served the first request')
  assert.ok(!names(extra.requests[0]).includes('workbench_discover_tools'))
  assert.ok(names(extra.requests[1]).includes('workbench_discover_tools'), 'Code mode tool discovery served the next request')
  assert.ok(!names(extra.requests[1]).includes('plugin_manager'))
  t.diagnostic(`Started-session switch succeeded: ${extra.requests[0].length} tools before, ${extra.requests[1].length} after.`)
})

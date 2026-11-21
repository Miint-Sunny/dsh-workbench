/** 指定顶层预设的原生工具声明筛选与日志投影。 */
import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import {
  DISCOVERY_TOOL, discoveryConfig, discoveryDescription, discoveryResult, foldDiscovery, parseDiscoveryState,
  registerDiscoveryPreview, visibleDefinitions,
} from './tool-discovery-state.js'

export const name = '@miint-sunny/dsh-workbench/tool-discovery'
export const inject = ['agents', 'agentPresets', 'sessionProjections', 'tools']

const executors = new WeakMap()
const nativeSchema = tool => projectToolSchema(tool, false)
const hasPtcExecutor = composition => composition?.modules.some(({ moduleName }) => moduleName === '@deepseek-ai/dsh-tool-executor-ptc')

function discoverySchemas(definitions, config, state, project) {
  return visibleDefinitions(definitions, config, state.selected).map(tool => {
    const schema = project(tool)
    return tool.name === DISCOVERY_TOOL ? { ...schema, description: discoveryDescription(definitions, config, state) } : schema
  })
}

/** 保留 Agent 自己的执行器直到会话释放。0.2.2-rc.1 卸载后不会回退到上层执行器。 */
function executorFor(agent) {
  const existing = executors.get(agent)
  if (existing) return existing
  const binding = {}
  const pipeline = new ToolExecutionPipeline(agent.ctx)
  agent.ctx.tools.setExecutor({
    describe(definitions) {
      const active = binding.active
      return { schemas: active ? discoverySchemas(definitions, active.config, active.state(), nativeSchema)
        : definitions.map(nativeSchema) }
    },
    execute(input) {
      // 非 AgentLoop 批次沿用该版本原生执行器的并发缺省值。
      return executeToolBatch(input, pipeline, () => 10)
    },
  })
  executors.set(agent, binding)
  return binding
}

/** 只在目标原生预设锁定后接管声明；整包默认目标为代码模式。 */
export async function apply(ctx, options) {
  const config = discoveryConfig(options)
  const projection = await ctx.sessionProjections.register({
    key: 'workbenchToolDiscovery',
    stateVersion: 2,
    stateSchema: { parse: parseDiscoveryState },
    init: () => ({ selected: [], description: null }),
    apply: foldDiscovery,
  })

  const tool = defineTool({
    name: DISCOVERY_TOOL,
    description: 'Find hidden tools or select names to load their definitions on the next request.',
    parameters: {
      query: { type: 'string', description: 'Keywords to search.' },
      select: { type: 'array', items: { type: 'string' }, description: 'Tool names to load.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selected: { type: 'array', items: { type: 'string' }, required: true },
          matches: { type: 'array', items: { type: 'string' }, required: true },
          groups: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render(_args, { selected, matches, groups }) {
        if (selected.length) return [{ type: 'text', text: `Selected for the next request: ${selected.join(', ')}` }]
        if (matches.length) return [{ type: 'text', text: matches.join('\n') }]
        const text = groups.length ? `No matching hidden tools. Try a group or MCP server name.\n${groups.join('\n')}` : 'No matching hidden tools.'
        return [{ type: 'text', text }]
      },
      presentationMeta(_args, { selected }) {
        return { workbenchToolDiscovery: selected }
      },
    },
    execute(args, { agent, toolSet }) {
      if (!agent || !toolSet) throw new Error('Tool discovery requires an active model step.')
      return discoveryResult(ctx.tools.definitions(agent, toolSet), config, projection.stateOf(agent.session).selected, args)
    },
  })

  const attached = new Map()
  let closing = false
  function targets(preset, session) {
    const { origin, parentSession } = session.header
    return origin !== 'subagent' && parentSession === undefined && config.presets.has(preset)
  }
  function preview(preset, session, schemas, previewCtx) {
    if (!targets(preset, session)) return schemas
    if (!previewCtx) return null
    try {
      const [composition] = ctx.agentPresets.inspectCompositions(previewCtx)
      if (!composition) return null
      if (hasPtcExecutor(composition)) return schemas
      const state = projection.stateOf(session)
      if (!state || schemas.some(schema => schema.name === DISCOVERY_TOOL)) return null
      return discoverySchemas([...schemas, nativeSchema(tool)], config, state, schema => schema)
    } catch {
      return null
    }
  }
  function attach(agent) {
    if (closing || attached.has(agent) || !targets(ctx.agentPresets.presetForSession(agent.session), agent.session)) return
    const [composition] = ctx.agentPresets.inspectCompositions(agent.ctx)
    if (hasPtcExecutor(composition)) return
    const binding = executorFor(agent)
    const dispose = agent.ctx.tools.register(tool, { when: () => true })
    binding.active = { config, state: () => projection.stateOf(agent.session) }
    attached.set(agent, () => {
      binding.active = undefined
      return dispose()
    })
  }

  function detach(agent) {
    const disable = attached.get(agent)
    attached.delete(agent)
    return disable?.()
  }

  ctx.effect(() => registerDiscoveryPreview(ctx, preview), 'workbench tool discovery preview')
  ctx.effect(() => async () => {
    closing = true
    await Promise.all([...attached.keys()].map(detach))
  }, 'workbench tool discovery')
  ctx.on('agent/created', ({ agent }) => {
    const { openTurnStartSeq, lastTurn } = ctx.agents.turnBoundaryOf(agent.session)
    if (openTurnStartSeq !== null || lastTurn > 0) attach(agent)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'agent-preset/selected') return
    const agent = ctx.agents.get(session.id)
    if (agent?.session !== session) return
    // 旧组合的发现入口随选择撤销。下一轮按已记录的预设及新组合重新决定是否挂接。
    if (event.type === 'agent-preset/selected') return detach(agent)
    attach(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => detach(agent))
}

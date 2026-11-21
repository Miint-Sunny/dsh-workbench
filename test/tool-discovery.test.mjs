import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  DISCOVERY_TOOL, discoveryConfig, discoveryDescription, discoveryResult, foldDiscovery,
  parseDiscoveryState, previewDiscoverySchemas, visibleDefinitions,
} from '../lib/tool-discovery-state.js'

const tools = [
  { name: 'read', description: 'Read a file.' },
  { name: 'glob', description: 'Find file paths. Extra instructions on a second sentence.' },
  { name: 'fetch', description: 'Read the web.\nExtra instructions on a second line.' },
  { name: 'web_read', description: 'Read a web page.' },
  { name: DISCOVERY_TOOL, description: 'Find more tools.' },
]
const config = discoveryConfig({ residentTools: ['read'], maxResults: 2, maxQueryChars: 30 })
const initial = { selected: [], description: null }

function committedSelection(selected, isError = false) {
  return { type: 'tool/result', data: { message: { isError }, meta: { workbenchToolDiscovery: selected } } }
}

function requestHeader(description) {
  return { type: 'request/header', data: { header: {
    tools: description === undefined ? [] : [{ name: DISCOVERY_TOOL, description }],
  } } }
}

test('only resident and discovery schemas are visible until a successful selection', () => {
  const extended = [...tools, { name: 'mcp__new_server__inspect' }, { name: 'fresh_plugin_tool' }]
  const before = visibleDefinitions(extended, config, [])
  const { selected } = foldDiscovery(initial, committedSelection(['web_read', 'glob']))
  const after = visibleDefinitions(extended, config, selected)
  assert.deepEqual(before.map(tool => tool.name), ['read', DISCOVERY_TOOL])
  assert.deepEqual(after.map(tool => tool.name), ['read', 'glob', 'web_read', DISCOVERY_TOOL])
  assert.equal(after[1], tools[1])
})

test('the default list keeps what coding uses in front and leaves MCP and rarely used tools on demand', () => {
  const defaults = discoveryConfig()
  const resident = [
    'ask_user_question', 'bash', 'create_goal', 'create_worktree', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep',
    'job_kill', 'job_list', 'job_output', 'list_agents', 'list_subagent_models', 'load_workspace_dependencies', 'look',
    'look_fetch', 'look_find', 'look_zoom', 'lsp', 'memory_view', 'memory_write', 'office_convert', 'office_recalculate',
    'office_render', 'present', 'publish_page', 'pwsh', 'read', 'read_image', 'send_message', 'skill', 'subagent',
    'subagent_fork', 'todo_write', 'update_goal', 'wait_agent', 'web_fetch', 'web_search', 'workflow', 'working_directory',
    'wrap_up', 'write',
  ]
  const onDemand = [
    'image_generate', 'interrupt_agent', 'list_mcp_resource_templates', 'list_mcp_resources',
    'mcp__github__get_file_contents', 'mcp__safari__safari_navigate', 'plugin_manager', 'read_mcp_resource', 'schedule_create',
    'schedule_edit', 'schedule_list', 'schedule_view', 'session_event_read', 'session_event_search', 'session_event_trace',
    'session_search', 'session_trace', 'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
    'video_generate', 'x_search',
  ]
  const definitions = [...resident, ...onDemand, DISCOVERY_TOOL].map(name => ({ name }))
  assert.deepEqual(visibleDefinitions(definitions, defaults, []).map(tool => tool.name), [...resident, DISCOVERY_TOOL])
  assert.deepEqual([...defaults.presets], ['dsh-workbench-coding'])
  assert.deepEqual([...discoveryConfig({ presets: ['full', 'coding'] }).presets], ['full', 'coding'])
})

test('the description names only the groups hidden in this request', () => {
  const hidden = ['schedule_list', 'team_task_list', 'spawn_teammate', 'wait_agent', 'session_search', 'image_generate', 'video_generate',
    'plugin_manager', 'x_search', 'list_mcp_resources', 'load_workspace_dependencies', 'mcp__github__list_prs']
  const description = discoveryDescription([{ name: 'read' }, ...hidden.map(name => ({ name }))], config, initial)
  assert.match(description, /^MCP tools and rarely used tools are hidden/)
  assert.match(description, / Hidden MCP servers: github\. /)
  assert.match(description, / Other hidden groups: Images, MCP resources, Past sessions, Plugins, Schedules, Teams, Video, X search\. /)
  assert.doesNotMatch(description, /Goals|Workflows|Other tools/)
  const nothingElse = discoveryDescription([{ name: 'read' }, { name: 'mcp__github__list_prs' }], config, initial)
  assert.doesNotMatch(nothingElse, /Other hidden groups/)
  const waitOnly = discoveryDescription([{ name: 'read' }, { name: 'wait_agent' }], config, initial)
  assert.doesNotMatch(waitOnly, /Teams/, 'wait_agent 是普通的子智能体控制工具，不归进团队')
})

test('compaction retains the selection and a fork before the result does not inherit it', () => {
  const prefix = [requestHeader('Initial description'),
    { type: 'tool/call', data: { name: DISCOVERY_TOOL, arguments: '{"select":["glob"]}' } }]
  const history = [...prefix, committedSelection(['glob']), { type: 'compaction/end', data: {} }, committedSelection(['fetch'])]
  assert.deepEqual(history.reduce(foldDiscovery, initial), { selected: ['glob', 'fetch'], description: 'Initial description' })
  assert.deepEqual(history.slice(0, 4).reduce(foldDiscovery, initial).selected, ['glob'])
  assert.deepEqual(prefix.reduce(foldDiscovery, initial).selected, [])
})

test('failed, malformed and unrelated results do not unlock definitions', () => {
  const history = [
    committedSelection(['glob'], true),
    committedSelection(['fetch', null]),
    { type: 'tool/result', data: { message: {}, meta: { anotherPlugin: ['fetch'] } } },
    committedSelection(['web_read']),
    committedSelection(['web_read']),
  ]
  assert.deepEqual(history.reduce(foldDiscovery, initial).selected, ['web_read'])
})

test('one matching keyword is enough and more distinct matches rank first', () => {
  const catalog = [...tools, { name: 'schedule_list', description: 'List the scheduled jobs.' }]
  const result = discoveryResult(catalog, config, [], { query: 'read,web jobs jobs jobs' })
  assert.deepEqual(result.matches, ['web_read — Read a web page.', 'fetch — Read the web.'])
  assert.deepEqual(discoveryResult(catalog, config, [], { query: 'glob 计划' }).matches, ['glob — Find file paths.'])
  assert.deepEqual(discoveryResult(catalog, config, ['web_read'], { query: 'web' }).matches, ['fetch — Read the web.'])
})

test('name matches break ties within the configured result limit', () => {
  const bounded = discoveryConfig({ residentTools: ['read', 'glob'], maxResults: 1 })
  assert.deepEqual(discoveryResult(tools, bounded, [], { query: 'web' }).matches, ['web_read — Read a web page.'])
})

test('no match gives current groups and counts and a late MCP server is searchable', () => {
  const catalog = [...tools,
    { name: 'mcp__github__list_prs', description: 'List pull requests.' },
    { name: 'mcp__late_server__probe', description: 'Check a fixture.' },
    { name: 'mcp__late_server__second_probe', description: 'Check another fixture.' },
    { name: 'schedule_list', description: 'List schedules.' },
  ]
  const fallback = discoveryResult(catalog, config, ['mcp__late_server__second_probe'], { query: '查看一下' })
  assert.deepEqual(fallback, {
    selected: [], matches: [], groups: ['MCP github (1)', 'MCP late_server (1)', 'Other tools (3)', 'Schedules (1)'],
  })
  assert.deepEqual(discoveryResult(catalog, config, ['mcp__late_server__second_probe'], { query: 'late_server 无关' }).matches,
    ['mcp__late_server__probe — Check a fixture.'])
})

test('the first logged description stays stable when servers arrive, across projection replay', () => {
  const github = { name: 'mcp__github__list_prs', description: 'List pull requests.' }
  const safari = { name: 'mcp__safari__open', description: 'Open a page.' }
  const late = { name: 'mcp__late__probe', description: 'Check a fixture.' }
  const description = discoveryDescription([...tools, safari, github], config, initial)
  assert.match(description, /github, safari/)
  assert.match(description, /search here first, before trying other tools such as bash/)
  assert.match(description, /one call.*changes the tool list/)
  const history = [requestHeader(), requestHeader(description), committedSelection([github.name]),
    requestHeader('Different later description'), { type: 'compaction/end', data: {} }]
  const restored = history.reduce(foldDiscovery, initial)
  assert.deepEqual(parseDiscoveryState(JSON.parse(JSON.stringify(restored))), restored)
  assert.equal(discoveryDescription([...tools, github, late], config, restored), description)
  assert.match(discoveryDescription([...tools, github, late], config, initial), /github, late/)
})

test('selection is idempotent and refuses unavailable, resident or discovery names', () => {
  assert.deepEqual(discoveryResult(tools, config, ['glob'], { select: ['glob', 'glob', 'fetch'] }), {
    selected: ['glob', 'fetch'], matches: [], groups: [],
  })
  assert.throws(() => discoveryResult(tools, config, [], { select: ['glob', 'missing'] }), /missing/)
  assert.throws(() => discoveryResult(tools, config, [], { select: ['read'] }), /read/)
  assert.throws(() => discoveryResult(tools, config, [], { select: [DISCOVERY_TOOL] }), /workbench_discover_tools/)
})

test('query and select together select valid names and otherwise fall back to the search', () => {
  assert.deepEqual(discoveryResult(tools, config, [], { query: 'web', select: ['glob'] }), { selected: ['glob'], matches: [], groups: [] })
  for (const select of [['missing'], ['glob', 'missing'], []]) {
    const result = discoveryResult(tools, config, [], { query: 'web', select })
    assert.deepEqual(result.selected, [])
    assert.deepEqual(result.matches, ['web_read — Read a web page.', 'fetch — Read the web.'])
  }
})

test('a short MCP name is accepted only when it points at one hidden tool', () => {
  const catalog = [...tools,
    { name: 'mcp__playwright__browser_navigate', description: 'Navigate.' },
    { name: 'mcp__safari__safari_navigate', description: 'Navigate Safari.' },
    { name: 'mcp__github__read', description: 'Read a file on GitHub.' },
  ]
  assert.deepEqual(discoveryResult(catalog, config, [], { select: ['playwright_browser_navigate', 'browser_navigate'] }).selected,
    ['mcp__playwright__browser_navigate'])
  assert.throws(() => discoveryResult(catalog, config, [], { select: ['navigate'] }), /unavailable for selection: navigate/)
  assert.throws(() => discoveryResult(catalog, config, [], { select: ['read'] }), /unavailable for selection: read/)
  assert.throws(() => discoveryResult(catalog, config, [], { select: ['web_read', 'fetch', 'glob'].map(name => 'x_' + name) }), /x_web_read/)
})

test('the selection cap is its own setting', () => {
  const capped = discoveryConfig({ residentTools: ['read'], maxResults: 1, maxSelect: 2 })
  assert.deepEqual(discoveryResult(tools, capped, [], { select: ['glob', 'fetch'] }).selected, ['glob', 'fetch'])
  assert.throws(() => discoveryResult(tools, capped, [], { select: ['glob', 'fetch', 'web_read'] }), /1–2 names/)
  assert.equal(discoveryConfig().maxSelect, 12)
  assert.throws(() => discoveryConfig({ maxSelect: 0 }), /maxSelect/)
})

test('invalid modes, bounds and row settings are rejected', () => {
  assert.throws(() => discoveryResult(tools, config, [], {}), /query or select/)
  assert.throws(() => discoveryResult(tools, config, [], { query: 'x'.repeat(31) }), /30/)
  assert.throws(() => discoveryResult(tools, config, [], { select: [] }), /select/)
  assert.throws(() => discoveryConfig({ hiddenTools: ['glob'] }), /unknown field hiddenTools/)
  assert.throws(() => discoveryConfig({ residentTools: ['glob', 'glob'] }), /residentTools/)
  assert.throws(() => discoveryConfig({ residentTools: ['run_code'] }), /residentTools/)
  assert.throws(() => discoveryConfig({ presets: ['full', 'full'] }), /presets/)
  assert.throws(() => discoveryConfig({ presets: [' '] }), /presets/)
  assert.throws(() => discoveryConfig(null), /config must be an object/)
  assert.throws(() => discoveryConfig({ maxResults: 0 }), /maxResults/)
  assert.throws(() => discoveryConfig({ maxResult: 2 }), /maxResult/)
})

// rc.3 的无 MCP/LSP 样本。两组分别是代码模式常驻的 31 项和标准模式额外提供的 5 项。
const resident = [
  'ask_user_question', 'bash', 'create_goal', 'edit', 'get_goal', 'glob', 'grep', 'job_kill', 'job_list',
  'job_output', 'list_agents', 'list_subagent_models', 'memory_view', 'memory_write', 'present', 'publish_page',
  'read', 'read_image', 'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
  'wait_agent', 'web_fetch', 'web_search', 'workflow', 'working_directory', 'wrap_up', 'write',
]
const onDemand = ['plugin_manager', 'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']
const standard = [...resident, ...onDemand].sort()
const coding = [...resident, DISCOVERY_TOOL].sort()
const codePreset = 'dsh-workbench-coding'
const fullPreset = 'dsh-workbench-full'

// apply 的 SDK 依赖由宿主提供。只替代边界，把真实行的注册、过滤和撤销作用到同一份工具表。
const sdk = {
  '@deepseek-ai/dsh-tools': `
    export const defineTool = spec => ({ ...spec, parameters: { type: 'object', properties: spec.parameters } })
    export const projectToolSchema = ({ name, description, parameters, deferLoading }) =>
      ({ name, description, parameters, ...(deferLoading === true ? { deferLoading } : {}) })
  `,
  '@deepseek-ai/dsh-tools/pipeline': 'export class ToolExecutionPipeline {}\nexport function executeToolBatch() {}',
}
const sdkHooks = registerHooks({
  resolve(name, context, next) {
    return Object.hasOwn(sdk, name)
      ? { url: 'data:text/javascript,' + encodeURIComponent(sdk[name]), shortCircuit: true }
      : next(name, context)
  },
})
let discoveryRow
try { discoveryRow = await import('../lib/tool-discovery.js') } finally { sdkHooks.deregister() }

async function discoveryHost({ preset = 'standard', completedTurns = 0, header = {}, modules = [],
  options, state = initial } = {}) {
  const listeners = new Map(), cleanup = [], localTools = new Map()
  const definitions = standard.map(name => ({ name, description: name, parameters: { type: 'object' } }))
  const session = { id: 'session', header: { agentPreset: 'standard', ...header } }
  let executor
  const agent = { id: session.id, session, ctx: { modules, tools: {
    setExecutor(value) { executor = value },
    register(tool) {
      if (localTools.has(tool.name)) throw new Error('duplicate tool ' + tool.name)
      localTools.set(tool.name, tool)
      return () => localTools.delete(tool.name)
    },
  } } }
  const ctx = {
    root: {},
    agents: { get: id => id === agent.id ? agent : undefined,
      turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: completedTurns }) },
    agentPresets: { presetForSession: () => preset, inspectCompositions: scope => [{ modules: scope.modules }] },
    sessionProjections: { register: async () => ({ stateOf: () => state }) },
    on(name, listener) { listeners.set(name, listener); cleanup.push(() => listeners.delete(name)) },
    effect(register) { cleanup.push(register()) },
  }
  const event = (type, data, owner = session) => listeners.get('session/event')?.(owner, { type, data })
  const enable = () => discoveryRow.apply(ctx, options)
  const schemas = () => {
    const all = [...definitions, ...localTools.values()]
    return executor ? executor.describe(all).schemas : all
  }
  await enable()
  listeners.get('agent/created')({ agent })
  return {
    ctx, agent, definitions, schemas, event, enable, names: () => schemas().map(tool => tool.name).sort(),
    selected(value) { preset = value; return event('agent-preset/selected', { agentPreset: value }) },
    turn() { return event('turn/start', { turn: ++completedTurns }) },
    async disable() { for (const dispose of cleanup.splice(0).reverse()) await dispose() },
  }
}

test('leaving Code removes discovery immediately and the next Code turn registers it again', async () => {
  const host = await discoveryHost()
  host.turn()
  assert.deepEqual(host.names(), standard)
  host.selected(codePreset)
  host.turn()
  assert.deepEqual(host.names(), coding)
  host.event('agent-preset/selected', { agentPreset: 'standard' }, { id: host.agent.id })
  assert.deepEqual(host.names(), coding, 'a stale session object cannot detach the active agent')

  for (const [target, want] of [['standard', standard], [fullPreset, standard], ['standard', standard],
    [codePreset, coding], [fullPreset, standard]]) {
    await host.selected(target)
    if (target !== codePreset) assert.deepEqual(host.names(), want, 'selection must also remove the discovery filter')
    host.turn()
    assert.deepEqual(host.names(), want)
  }
})

test('a resumed agent uses the recorded preset and selection, and the row can be disabled and enabled', async () => {
  const state = { selected: ['schedule_list'], description: 'Original tool catalog' }
  for (const [preset, want] of [['standard', standard], [fullPreset, standard], [codePreset, [...coding, 'schedule_list'].sort()]]) {
    const host = await discoveryHost({ preset, completedTurns: 3, state })
    assert.deepEqual(host.names(), want)
    if (preset === codePreset) assert.equal(host.schemas().find(tool => tool.name === DISCOVERY_TOOL).description, state.description)
    await host.disable()
    assert.deepEqual(host.names(), standard)
    await host.enable()
    host.turn()
    assert.deepEqual(host.names(), want)
  }
})

test('preview reads the active row and restored selections without changing the live tool table', async () => {
  const host = await discoveryHost({
    options: { residentTools: ['read'], presets: [fullPreset] },
    state: { selected: ['schedule_list'], description: 'Saved catalog' },
  })
  const scope = { modules: [] }
  const schemas = host.definitions.map(schema => Object.freeze({ ...schema, ...(schema.name === 'read' ? { deferLoading: true } : {}) }))
  const preview = () => previewDiscoverySchemas(host.ctx, fullPreset, host.agent.session, schemas, scope)
  assert.equal(previewDiscoverySchemas(host.ctx, codePreset, host.agent.session, schemas, scope), schemas)
  const result = preview()
  assert.deepEqual(result.map(tool => tool.name).sort(), ['read', 'schedule_list', DISCOVERY_TOOL].sort())
  assert.equal(result.find(tool => tool.name === 'read').deferLoading, true)
  const discovery = result.find(tool => tool.name === DISCOVERY_TOOL)
  assert.equal(discovery.description, 'Saved catalog')
  assert.equal(discovery.parameters.properties.select.items.type, 'string')
  assert.deepEqual(host.names(), standard)
  host.selected(fullPreset)
  host.turn()
  assert.deepEqual(host.schemas().find(tool => tool.name === DISCOVERY_TOOL), discovery)
  assert.deepEqual(host.names(), result.map(tool => tool.name).sort())
  await host.disable()
  assert.equal(preview(), schemas)
})

test('a preview respects the target composition and session type and reports unavailable state', async () => {
  const host = await discoveryHost()
  const { ctx, agent: { session }, definitions } = host
  const native = { modules: [] }
  const preview = (owner, scope) => previewDiscoverySchemas(ctx, codePreset, owner, definitions, scope)
  assert.equal(preview(session, { modules: [{ moduleName: '@deepseek-ai/dsh-tool-executor-ptc' }] }), definitions)
  for (const header of [{ origin: 'subagent' }, { parentSession: 'parent' }]) {
    assert.equal(preview({ header }, native), definitions)
  }
  assert.equal(preview(session, undefined), null)
  assert.equal(previewDiscoverySchemas({ root: {} }, codePreset, session, definitions, native), definitions)
  const unavailable = await discoveryHost({ state: null })
  assert.equal(previewDiscoverySchemas(unavailable.ctx, codePreset, unavailable.agent.session, definitions, native), null)
  const result = preview(session, native)
  assert.match(result.find(tool => tool.name === DISCOVERY_TOOL).description, /Other hidden groups: Plugins, Schedules/)
})

/** 可见定义、发现目录和从原生会话日志重建的状态。 */
import { MCP_SHARED } from './mcp-state.js'

export const DISCOVERY_TOOL = 'workbench_discover_tools'

const previewReaders = new WeakMap()

/** 同一宿主中复用已启用行的配置和投影；行卸载时撤销。 */
export function registerDiscoveryPreview(ctx, read) {
  previewReaders.set(ctx.root, read)
  return () => { if (previewReaders.get(ctx.root) === read) previewReaders.delete(ctx.root) }
}

/** 输入是目标组合已准入的原生声明。预览仅读取行状态，无可用目标组合或投影时返回 null。 */
export function previewDiscoverySchemas(ctx, preset, session, schemas, previewCtx) {
  const read = previewReaders.get(ctx.root)
  return read ? read(preset, session, schemas, previewCtx) : schemas
}

// 写代码常用的工具。exit_plan_mode 只在计划模式里注册，pwsh 是 Windows 上的 shell，office_* 只在加载 Office 技能后注册，都不能藏。
const DEFAULT_RESIDENT_TOOLS = [
  'ask_user_question', 'bash', 'create_goal', 'create_worktree', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep',
  'job_kill', 'job_list', 'job_output', 'list_agents', 'list_subagent_models', 'load_workspace_dependencies', 'look',
  'look_fetch', 'look_find', 'look_zoom', 'lsp', 'memory_view', 'memory_write', 'office_convert', 'office_recalculate',
  'office_render', 'present', 'publish_page', 'pwsh', 'read', 'read_image', 'send_message', 'skill', 'subagent',
  'subagent_fork', 'todo_write', 'update_goal', 'wait_agent', 'web_fetch', 'web_search', 'workflow', 'working_directory',
  'wrap_up', 'write',
]
const RESERVED_NAMES = new Set([DISCOVERY_TOOL, 'run_code'])
const toolName = value => typeof value === 'string' && /^[\w-]+$/u.test(value) && !RESERVED_NAMES.has(value)
const presetId = value => typeof value === 'string' && value.length > 0 && value === value.trim()

const TOOL_GROUPS = [
  [/^schedule_/u, 'Schedules'],
  [/^workflow(?:_|$)/u, 'Workflows'],
  [/^(?:create|get|update)_goal$/u, 'Goals'],
  [/^(?:task_board|todo)_/u, 'Task boards'],
  [/^(?:image_|read_image$)/u, 'Images'],
  [/^(?:make_video$|video_)/u, 'Video'],
  [/^(?:team_|spawn_teammate$|interrupt_agent$)/u, 'Teams'],
  [/^job_/u, 'Background jobs'],
  [/^session_/u, 'Past sessions'],
  [/^plugin_/u, 'Plugins'],
  [/^x_search$/u, 'X search'],
]

/** 解析独立行配置。未列入常驻名单的定义按需出现。 */
export function discoveryConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('tool-discovery: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!['residentTools', 'presets', 'maxResults', 'maxSelect', 'maxQueryChars'].includes(key)) {
      throw new Error(`tool-discovery: unknown field ${key}`)
    }
  }
  const { residentTools = DEFAULT_RESIDENT_TOOLS, presets = ['dsh-workbench-coding'], maxResults = 6, maxSelect = 12, maxQueryChars = 160 } = config
  if (!Array.isArray(residentTools) || !residentTools.every(toolName) || new Set(residentTools).size !== residentTools.length) {
    throw new Error('tool-discovery: residentTools must contain unique tool names, excluding the discovery tool and run_code')
  }
  if (!Array.isArray(presets) || !presets.every(presetId) || new Set(presets).size !== presets.length) {
    throw new Error('tool-discovery: presets must contain unique non-empty preset IDs')
  }
  for (const [key, value] of Object.entries({ maxResults, maxSelect, maxQueryChars })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`tool-discovery: ${key} must be a positive integer`)
  }
  return { residentTools: new Set(residentTools), presets: new Set(presets), maxResults, maxSelect, maxQueryChars }
}

/** 读取持久化投影，拒绝损坏的 checkpoint。 */
export function parseDiscoveryState(value) {
  if (!value || !Array.isArray(value.selected) || !value.selected.every(toolName) ||
      (value.description !== null && typeof value.description !== 'string')) {
    throw new Error('Invalid tool discovery state')
  }
  return value
}

/** 从原生请求头恢复首份说明，累计成功的工具选择结果。 */
export function foldDiscovery(state, event) {
  if (event.type === 'request/header' && state.description === null) {
    const description = event.data.header.tools?.find(tool => tool.name === DISCOVERY_TOOL)?.description
    return description === undefined ? state : { ...state, description }
  }
  if (event.type !== 'tool/result' || event.data.message.isError === true) return state
  const names = event.data.meta?.workbenchToolDiscovery
  if (!Array.isArray(names) || !names.every(toolName)) return state
  const additions = names.filter(name => !state.selected.includes(name))
  return additions.length ? { ...state, selected: [...new Set([...state.selected, ...additions])] } : state
}

function discoverable(name, config) {
  return name !== DISCOVERY_TOOL && !config.residentTools.has(name)
}

/** 按 registry 顺序留下常驻工具、发现入口和本会话已选工具。 */
export function visibleDefinitions(definitions, config, selected) {
  return definitions.filter(({ name }) => !discoverable(name, config) || selected.includes(name))
}

function mcpServer(name) {
  const parts = name.split('__')
  const [prefix, server, tool] = parts
  // 只有名称能明确分出服务器时才加标签，分组不参与准入。
  return parts.length === 3 && prefix === 'mcp' && server && tool && !tool.startsWith('_') ? server : undefined
}

function groupFor(name) {
  const server = mcpServer(name)
  if (server) return `MCP ${server}`
  if (MCP_SHARED.includes(name)) return 'MCP resources'
  if (name.startsWith('mcp__')) return 'Other MCP tools'
  return TOOL_GROUPS.find(([pattern]) => pattern.test(name))?.[1] ?? 'Other tools'
}

/** 首份请求按当前已获准的服务器命名，之后复用日志里的同一句说明。 */
export function discoveryDescription(definitions, config, state) {
  if (state.description !== null) return state.description
  const servers = new Set()
  const groups = new Set()
  for (const { name } of definitions) {
    if (!discoverable(name, config)) continue
    const server = mcpServer(name)
    if (server) servers.add(server)
    else groups.add(groupFor(name))
  }
  groups.delete('Other tools')
  groups.delete('Other MCP tools')
  const serverList = servers.size ? ` Hidden MCP servers: ${[...servers].sort().join(', ')}.` : ''
  const groupList = groups.size ? ` Other hidden groups: ${[...groups].sort().join(', ')}.` : ''
  return 'MCP tools and rarely used tools are hidden until you select them here. When the task names a product or capability that is not in your tool list, search here first, before trying other tools such as bash.' +
    serverList + groupList + ' Servers connected later can be found by name or "mcp". Pass query to search, or select with the tool names to load them on the next request. Select everything the task needs in one call, because each selection changes the tool list.'
}

function firstSentence(description) {
  return description.trim().split(/\r?\n|(?<=[.!?])\s+|(?<=[。！？])/u, 1)[0]
}

/** 模型常把 MCP 工具写成不带前缀的短名。只对应一个隐藏工具时才采纳，已有的定义名不改。 */
function resolveName(name, definitions, hidden) {
  if (definitions.some(tool => tool.name === name)) return name
  const found = hidden.filter(tool => {
    if (!tool.name.startsWith('mcp__')) return false
    const plain = tool.name.slice('mcp__'.length).replaceAll('__', '_')
    return plain === name || plain.endsWith(`_${name}`)
  })
  return found.length === 1 ? found[0].name : name
}

/** 检索或选择本步的隐藏工具。同时带 query 和 select 时，名称都可用就选中，否则按 query 检索。零命中时给出当前可查的分组计数。 */
export function discoveryResult(definitions, config, selected, args) {
  const { query, select } = args
  if (query === undefined && select === undefined) throw new Error('Provide query or select.')
  const hidden = definitions.filter(({ name }) => discoverable(name, config))
  if (select !== undefined && (select.length > 0 || query === undefined)) {
    const names = [...new Set(select.map(name => resolveName(name, definitions, hidden)))]
    if (!names.length || names.length > config.maxSelect) throw new Error(`select requires 1–${config.maxSelect} names.`)
    const available = new Set(hidden.map(tool => tool.name))
    const unavailable = names.find(name => !available.has(name))
    if (unavailable === undefined) return { selected: names, matches: [], groups: [] }
    if (query === undefined) throw new Error(`Tool unavailable for selection: ${unavailable}`)
  }

  const text = query.trim().toLowerCase()
  if (!text || text.length > config.maxQueryChars) throw new Error(`query requires 1–${config.maxQueryChars} characters.`)
  const words = [...new Set(text.match(/[\p{L}\p{N}_-]+/gu) ?? [])]
  const matches = []
  const counts = new Map()
  for (const tool of hidden) {
    if (selected.includes(tool.name)) continue
    const group = groupFor(tool.name)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    const name = tool.name.toLowerCase()
    const haystack = `${name}\n${tool.description.toLowerCase()}\n${group.toLowerCase()}`
    const hits = words.filter(word => haystack.includes(word)).length
    if (hits) matches.push({ tool, hits, nameHits: words.filter(word => name.includes(word)).length })
  }
  matches.sort((left, right) => right.hits - left.hits || right.nameHits - left.nameHits || left.tool.name.localeCompare(right.tool.name, 'en'))
  const groups = matches.length ? [] : [...counts.keys()].sort().map(group => `${group} (${counts.get(group)})`)
  return {
    selected: [],
    matches: matches.slice(0, config.maxResults).map(({ tool }) => `${tool.name} — ${firstSentence(tool.description)}`),
    groups,
  }
}

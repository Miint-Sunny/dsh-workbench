/** Runtime inputs contain user-owned configuration, never a generated preset snapshot. */
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const presetPlugin = '@deepseek-ai/dsh-agent-preset'
const mcpPlugin = '@deepseek-ai/dsh-mcp-client'

function officialDefinition(patches, id) {
  const rows = patches.flatMap(patch => patch.insert ?? [])
  const found = rows.filter(row => row.name === presetPlugin && row.config?.id === id)
  if (found.length !== 1 || !Array.isArray(found[0].config.plugins)) throw new Error(`Unsupported official ${id} preset`)
  return found[0].config
}

/** Keep the current App's parsed entries, including unevaluated !!js nodes. */
export function officialPresetPair(standardPatch, ptcPatch) {
  const standard = officialDefinition(standardPatch, 'standard')
  const ptc = officialDefinition(ptcPatch, 'ptc')
  const gap = ptc.order - standard.order
  const orders = { coding: standard.order + gap / 10, full: standard.order + gap / 5 }
  if (!Number.isFinite(standard.order) || !Number.isFinite(ptc.order) ||
      !(standard.order < orders.coding && orders.coding < orders.full && orders.full < ptc.order)) {
    throw new Error('Unsupported official preset order')
  }
  return { plugins: structuredClone(standard.plugins), orders }
}

/** Inspect composed declarations before activation, without waiting on the registry itself. */
export function declaredPresetIds(rows, disabled = row => Boolean(row.disabled), ids = new Set()) {
  for (const row of rows ?? []) {
    if (disabled(row)) continue
    if (row.name === presetPlugin && typeof row.config?.id === 'string') ids.add(row.config.id)
    if (row.group && Array.isArray(row.config)) declaredPresetIds(row.config, disabled, ids)
  }
  return ids
}

function readConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Configuration path must be absolute')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function mcpRows(servers) {
  if (!Array.isArray(servers)) throw new Error('MCP servers must be a list')
  const names = new Set()
  return servers.map(row => {
    const config = row?.config, name = config?.serverName
    if (row.name !== mcpPlugin || typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(name) ||
        names.has(name) || !['stdio', 'streamable-http'].includes(config.transport) ||
        (row.disabled !== undefined && typeof row.disabled !== 'boolean')) throw new Error('Invalid MCP export entry')
    names.add(name)
    return { id: 'dsh-workbench-preset-mcp-' + name, name: mcpPlugin, config: structuredClone(config),
      ...(row.disabled === undefined ? {} : { disabled: row.disabled }) }
  })
}

/** Only explicitly configured files are read; optional failures never remove the base modes. */
export function readPresetConfiguration(options = {}) {
  const result = { locale: options.locale, lsp: options.lsp, mcpRows: [], lspUnavailable: false, mcpUnavailable: false }
  if (options.configFile !== undefined) {
    try { result.lsp = readConfig(options.configFile).lsp } catch { result.lspUnavailable = true }
  }
  if (options.mcpConfigFile !== undefined) {
    try {
      const handoff = readConfig(options.mcpConfigFile)
      if (handoff.version !== 1 || handoff.target !== 'dsh-desktop') throw new Error('Unsupported MCP export')
      result.mcpRows = mcpRows(handoff.servers)
    } catch { result.mcpUnavailable = true }
  }
  return result
}

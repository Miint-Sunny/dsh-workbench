import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { officialPresetPair, declaredPresetIds, readPresetConfiguration } from '../lib/preset-config.js'

test('runtime presets keep current official tools and expressions, ordered between Standard and PTC', () => {
  const plugins = [{ id: 'new-tool', name: '@official/new-tool', disabled: { __jsExpr: 'process.platform === "win32"' } }]
  const patch = (id, order) => [{ insert: [{ name: '@deepseek-ai/dsh-agent-preset', config: { id, order, plugins } }] }]
  const result = officialPresetPair(patch('standard', 10), patch('ptc', 30))
  assert.deepEqual(result.plugins, plugins)
  assert.equal(result.orders.coding, 12)
  assert.equal(result.orders.full, 14)
  result.plugins[0].id = 'changed'
  assert.equal(plugins[0].id, 'new-tool')
  assert.throws(() => officialPresetPair(patch('standard', 30), patch('ptc', 10)), /order/)
})

test('only enabled legacy declarations reserve IDs, irrespective of row order or disabled groups', () => {
  const row = id => ({ name: '@deepseek-ai/dsh-agent-preset', config: { id } })
  const rows = [row('dsh-workbench-coding'), { ...row('dsh-workbench-full'), disabled: true },
    { name: 'cordis:group', group: true, disabled: true, config: [row('disabled-group')] }]
  assert.deepEqual([...declaredPresetIds(rows)], ['dsh-workbench-coding'])
  assert.deepEqual([...declaredPresetIds([...rows].reverse())], ['dsh-workbench-coding'])
})

test('optional exported MCP preserves four configurations without adding any for unconfigured profiles', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-preset-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const mcpConfigFile = join(dir, 'mcp.json'), configFile = join(dir, 'lsp.json')
  const servers = ['example-a', 'example-b', 'example-c', 'example-d'].map(serverName => ({
    id: 'fixture-mcp-' + serverName, name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName, transport: 'stdio', command: '/fixture/mcp', env: { SECRET: 'fixture-only' } },
  }))
  writeFileSync(mcpConfigFile, JSON.stringify({ version: 1, target: 'dsh-desktop', servers }))
  writeFileSync(configFile, JSON.stringify({ lsp: { nodePath: '/n', serverPath: '/s', typescriptPath: '/t' } }))
  const result = readPresetConfiguration({ configFile, mcpConfigFile })
  assert.deepEqual(result.mcpRows.map(row => row.config), servers.map(row => row.config))
  assert.equal(result.lsp.nodePath, '/n')
  assert.deepEqual(readPresetConfiguration().mcpRows, [])
  servers[3].config.serverName = 'example-a'
  writeFileSync(mcpConfigFile, JSON.stringify({ version: 1, target: 'dsh-desktop', servers }))
  const bad = readPresetConfiguration({ mcpConfigFile })
  assert.deepEqual(bad.mcpRows, [])
  assert.equal(bad.mcpUnavailable, true)
  assert(!JSON.stringify(bad).includes('fixture-only'))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { presetHost } from './helpers/preset-host.mjs'

const modeIds = ['dsh-workbench-coding', 'dsh-workbench-full']

test('chore136 standalone workbench exposes healthy Code and Full modes without LSP or a generated bundle',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    const result = await presetHost()
    const modes = result.roster.filter(preset => ['dsh-workbench-coding', 'dsh-workbench-full'].includes(preset.id))
    assert.deepEqual(modes.map(preset => preset.id), ['dsh-workbench-coding', 'dsh-workbench-full'])
    for (const mode of modes) {
      assert.equal(mode.broken, undefined, mode.broken)
      assert.match(mode.description, /not installed|未安装/)
      const modules = result.compositions.find(row => row.id === mode.id).rows.filter(row => row.enabled !== false).map(row => row.moduleName)
      assert(modules.includes('@deepseek-ai/dsh-tool-fs'))
      assert(modules.includes('@deepseek-ai/dsh-tool-bash'))
      assert(!modules.includes('@miint-sunny/dsh-workbench/lsp'))
      assert(!modules.includes('@deepseek-ai/dsh-mcp-client'))
    }
    assert(result.roster.find(row => row.id === 'standard').order < modes[0].order)
    assert(modes[1].order < result.roster.find(row => row.id === 'ptc').order)
  })

for (const [version, ready] of [['0.2.2-rc.3', true], ['0.2.2-rc.2', false]]) {
  test(`chore136 ${version} LSP packages keep both modes healthy with LSP ${ready ? 'enabled' : 'omitted'}`,
    { skip: !(process.env.DSH_APP && process.env.DSH_LSP_FIXTURES && process.env.DSH_LSP_CONFIG) && 'requires cached LSP fixtures', timeout: 40000 }, async () => {
      const directory = join(process.env.DSH_LSP_FIXTURES, 'lsp-' + version, 'node_modules', '@deepseek-ai')
      const dependencies = Object.fromEntries(['dsh-lsp', 'dsh-lsp-stdio', 'dsh-tool-lsp'].map(name => ['@deepseek-ai/' + name, join(directory, name)]))
      const { lsp } = JSON.parse(readFileSync(process.env.DSH_LSP_CONFIG, 'utf8'))
      const result = await presetHost({ dependencies, rows: [{ id: 'dsh-workbench-presets', config: { lsp } }] })
      const modes = result.roster.filter(row => modeIds.includes(row.id))
      assert.equal(modes.length, 2, result.log)
      for (const mode of modes) {
        assert.equal(mode.broken, undefined, mode.broken ?? result.log)
        const modules = result.compositions.find(row => row.id === mode.id).rows.filter(row => row.enabled !== false).map(row => row.moduleName)
        assert.equal(modules.includes('@miint-sunny/dsh-workbench/lsp'), ready, JSON.stringify(result.compositions))
        assert.equal(result.toolNames[mode.id].includes('lsp'), ready)
        if (!ready) {
          assert.match(mode.description, /version mismatch|版本.*不一致/)
          assert.doesNotMatch(mode.description, /dsh plugin|@deepseek-ai/)
        }
      }
    })
}

test('chore136 enabled legacy declarations win without duplicate IDs; disabled legacy rows allow runtime takeover',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    for (const disabled of [false, true]) {
      const result = await presetHost({ rows: [{ insert: modeIds.map(id => ({ id: 'legacy-' + id,
        name: '@deepseek-ai/dsh-agent-preset', disabled,
        config: { id, name: 'Legacy ' + id, plugins: [] } })) }] })
      const modes = result.roster.filter(row => modeIds.includes(row.id))
      assert.equal(modes.length, 2, result.log)
      assert(!result.log.includes('Duplicate agent preset'), result.log)
      assert.equal(result.rootRows.find(row => row.id === 'dsh-workbench-presets')?.state, 2, result.log)
      for (const mode of modes) {
        assert.equal(mode.broken, undefined)
        assert.equal(mode.name.startsWith('Legacy '), !disabled)
      }
    }
  })

test('chore136 legacy false expressions on rows and groups reserve IDs without breaking the runtime row',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    for (const grouped of [false, true]) {
      const legacy = modeIds.map(id => ({ id: 'legacy-' + id, name: '@deepseek-ai/dsh-agent-preset',
        disabled: { __jsExpr: 'false' }, config: { id, name: 'Legacy ' + id, plugins: [] } }))
      const result = await presetHost({ rows: [{ insert: grouped ? [{ id: 'legacy-group', name: 'cordis:group', group: true,
        disabled: { __jsExpr: 'false' }, config: legacy }] : legacy }] })
      assert.equal(result.rootRows.find(row => row.id === 'dsh-workbench-presets')?.state, 2, result.log)
      assert.equal(result.roster.filter(row => modeIds.includes(row.id)).length, 2)
      for (const id of modeIds) assert.equal(result.roster.find(row => row.id === id).name, 'Legacy ' + id)
    }
  })

test('chore136 malformed optional MCP fields leave both base presets healthy',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dwb-mcp-invalid-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    for (const config of [{ serverName: 'fixture', transport: 'stdio' },
      { serverName: 'fixture', transport: 'streamable-http' },
      { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: 123, env: { BAD: false }, startupTimeoutMs: -1 }]) {
      const file = join(dir, 'export.json')
      writeFileSync(file, JSON.stringify({ version: 1, target: 'dsh-desktop', servers: [{ name: '@deepseek-ai/dsh-mcp-client', config }] }))
      const result = await presetHost({ rows: [{ id: 'dsh-workbench-presets', config: { mcpConfigFile: file } }] })
      for (const id of modeIds) {
        const preset = result.roster.find(row => row.id === id)
        assert(preset)
        assert.equal(preset.broken, undefined, result.log)
        assert.match(preset.description, /共享 MCP 未加载|Shared MCP not loaded/)
      }
    }
  })

test('chore136 live legacy disable, enable and removal hand ownership over without missing or duplicate modes',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    const legacy = modeIds.map(id => ({ id: 'legacy-' + id, name: '@deepseek-ai/dsh-agent-preset',
      config: { id, name: 'Legacy ' + id, plugins: [] } }))
    const result = await presetHost({ rows: [{ insert: legacy }], inspect: `
      const profile = ctx.get('profileContext')
      const { pathToFileURL } = await import('node:url')
      const { reconcileProfilePatches } = await loader.internal.import('@deepseek-ai/dsh-app-boot', pathToFileURL(profile.installAnchor).href, {})
      const base = structuredClone(loader.resolve('include').options.config.patches)
      const states = []
      const record = async () => ({ roster: await registry.list(), runtimeState: [...loader.entries()].find(e => e.options.id === 'dsh-workbench-presets')?.fiber?.state })
      states.push(await record())
      await reconcileProfilePatches(ctx.root, [...base, ...${JSON.stringify(modeIds)}.map(id => ({ id: 'legacy-' + id, disabled: true }))], 'chore136')
      states.push(await record())
      await reconcileProfilePatches(ctx.root, base, 'chore136')
      states.push(await record())
      const removed = base.map(patch => patch.insert ? { ...patch, insert: patch.insert.filter(row => !row.id?.startsWith('legacy-')) } : patch)
      await reconcileProfilePatches(ctx.root, removed, 'chore136')
      states.push(await record())
      return { states }
    ` })
    for (const [index, state] of result.extra.states.entries()) {
      const modes = state.roster.filter(row => modeIds.includes(row.id))
      assert.equal(modes.length, 2, 'transition stage ' + index)
      assert.equal(state.runtimeState, 2)
      for (const mode of modes) { assert.equal(mode.broken, undefined); assert.equal(mode.name.startsWith('Legacy '), index % 2 === 0) }
    }
  })

test('chore136 disabling and re-enabling the runtime row releases and recreates both registrations',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    const result = await presetHost({ inspect: `
      const profile = ctx.get('profileContext')
      const { pathToFileURL } = await import('node:url')
      const { reconcileProfilePatches } = await loader.internal.import('@deepseek-ai/dsh-app-boot', pathToFileURL(profile.installAnchor).href, {})
      const base = structuredClone(loader.resolve('include').options.config.patches)
      await reconcileProfilePatches(ctx.root, [...base, { id: 'dsh-workbench-presets', disabled: true }], 'chore136')
      const disabled = await registry.list()
      await reconcileProfilePatches(ctx.root, base, 'chore136')
      return { disabled, enabled: await registry.list() }
    ` })
    assert.deepEqual(result.extra.disabled.filter(row => modeIds.includes(row.id)), [])
    const enabled = result.extra.enabled.filter(row => modeIds.includes(row.id))
    assert.equal(enabled.length, 2)
    for (const preset of enabled) assert.equal(preset.broken, undefined)
  })

test('chore136 legacy LSP rows with absent packages no longer mark their preset broken',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    const result = await presetHost({ rows: [{ insert: [{ id: 'legacy-with-lsp', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'legacy-lsp', plugins: [{ name: 'cordis:group', group: true, isolate: { lsp: true },
        config: [{ name: '@miint-sunny/dsh-workbench/lsp', config: { nodePath: '/missing/node', serverPath: '/missing/server', typescriptPath: '/missing/ts' } }] }],
    } }] }] })
    const preset = result.roster.find(row => row.id === 'legacy-lsp')
    assert(preset, result.log)
    assert.equal(preset.broken, undefined, result.log)
  })

test('chore136 native Code agents discover tools without generator config; Full and Standard keep all definitions',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async () => {
    const result = await presetHost({ inspect: `
      const agents = ctx.get('agents'), results = {}
      for (const id of ['dsh-workbench-coding', 'dsh-workbench-full', 'standard']) {
        const handle = await agents.create({ sessionId: 'discovery-' + id,
          meta: { cwd: process.cwd(), agentPreset: id }, setup: async scope => { await registry.mount(scope, id) } })
        try {
          handle.agent.session.append('turn/start', { turn: 1 })
          const definitions = tools.definitions(handle.agent)
          results[id] = { all: definitions.map(tool => tool.name).sort(),
            visible: tools.selectExecutor(handle.agent).describe(definitions).schemas.map(tool => tool.name).sort() }
          handle.agent.session.append('turn/end', { turn: 1 })
        } finally { await handle.dispose() }
      }
      return results
    ` })
    const code = result.extra['dsh-workbench-coding']
    assert(code.visible.includes('workbench_discover_tools'))
    assert(code.visible.includes('read'))
    assert(code.all.includes('schedule_list'))
    assert(!code.visible.includes('schedule_list'))
    for (const id of ['dsh-workbench-full', 'standard']) {
      assert(!result.extra[id].visible.includes('workbench_discover_tools'))
      assert.deepEqual(result.extra[id].visible, result.extra[id].all)
    }
  })

test('chore136 optional exported MCP registers all four servers in both modes and none in Standard',
  { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 40000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dwb-mcp-config-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const mcpConfigFile = join(dir, 'export.json')
    const names = ['example-a', 'example-b', 'example-c', 'example-d']
    writeFileSync(mcpConfigFile, JSON.stringify({ version: 1, target: 'dsh-desktop', servers: names.map(serverName => ({
      id: 'fixture-mcp-' + serverName, name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport: 'stdio',
        command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-preset-server.mjs', import.meta.url))], failOnStartupError: true },
    })) }))
    const result = await presetHost({ rows: [{ id: 'dsh-workbench-presets', config: { mcpConfigFile } }] })
    for (const id of modeIds) {
      const preset = result.roster.find(row => row.id === id)
      assert(preset, result.log)
      assert.equal(preset.broken, undefined, result.log)
      assert.deepEqual(result.toolNames[id].filter(name => name.startsWith('mcp__')).sort(), names.map(name => `mcp__${name}__probe`).sort())
    }
    assert.deepEqual(result.toolNames.standard.filter(name => name.startsWith('mcp__')), [])
  })

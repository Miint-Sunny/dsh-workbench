import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presetHost } from './helpers/preset-host.mjs'
import { buildPacks } from '../scripts/build-packs.mjs'

const ids = ['dsh-workbench-coding', 'dsh-workbench-full']
const host = { skip: !process.env.DSH_APP && 'requires a disposable DSH_APP', timeout: 60000 }
function scratch(t) { const dir = mkdtempSync(join(tmpdir(), 'dwb-138-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
function healthy(result) {
  for (const id of ids) {
    const row = result.roster.find(row => row.id === id)
    assert(row, result.log); assert.equal(row.broken, undefined, result.log)
  }
  assert.equal(result.rootRows.find(row => row.id === 'dsh-workbench-presets')?.state, 2, result.log)
}
function mcpExport(dir, config) {
  const file = join(dir, 'mcp.json')
  writeFileSync(file, JSON.stringify({ version: 1, target: 'dsh-desktop', servers: [{ name: '@deepseek-ai/dsh-mcp-client', config }] }))
  return file
}
const lspDependencies = () => Object.fromEntries(['dsh-lsp', 'dsh-lsp-stdio', 'dsh-tool-lsp'].map(name =>
  ['@deepseek-ai/' + name, join(process.env.DSH_LSP_FIXTURES, 'lsp-0.2.2-rc.3/node_modules/@deepseek-ai', name)]))
const reconcile = `
  const { pathToFileURL } = await import('node:url')
  const profile = ctx.get('profileContext')
  const { reconcileProfilePatches } = await loader.internal.import('@deepseek-ai/dsh-app-boot', pathToFileURL(profile.installAnchor).href, {})
  const base = structuredClone(loader.resolve('include').options.config.patches)
`

test('chore138 preset names and descriptions follow live DSH language including internal review', host, async () => {
  const result = await presetHost({ rows: [{ id: 'locale', config: { preference: 'en' } }], inspect: `
    const states = [await registry.list()]
    for (const preference of ['zh', 'en']) {
      await ctx.get('settings').update('locale', { preference })
      states.push(await registry.list())
    }
    return { states }
  ` })
  healthy(result)
  for (const [index, roster] of result.extra.states.entries()) {
    const chinese = index === 1
    for (const id of [...ids, 'dsh-workbench-readonly-review']) {
      const row = roster.find(row => row.id === id); assert(row)
      assert.equal(/[\u3400-\u9fff]/.test(row.name), chinese, row.name)
      assert.equal(/[\u3400-\u9fff]/.test(row.description), chinese, row.description)
    }
  }
})

test('chore138 explicit preset locale overrides the DSH language', host, async () => {
  const result = await presetHost({ rows: [{ id: 'locale', config: { preference: 'en' } },
    { id: 'dsh-workbench-presets', config: { locale: 'zh' } }, { id: 'dsh-workbench-local-review', config: { locale: 'zh' } }],
    inspect: `await ctx.get('settings').update('locale', { preference: 'en' }); return { roster: await registry.list() }` })
  healthy(result)
  for (const row of result.extra.roster.filter(row => [...ids, 'dsh-workbench-readonly-review'].includes(row.id))) assert.match(row.name, /[\u3400-\u9fff]/)
})

test('chore138 unrelated row toggles keep both presets present and retain MCP processes', host, async t => {
  const dir = scratch(t), starts = join(dir, 'starts.jsonl')
  const fixture = join(dir, 'mcp.mjs')
  const original = readFileSync(fileURLToPath(new URL('./fixtures/mcp-preset-server.mjs', import.meta.url)), 'utf8')
  writeFileSync(fixture, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(starts)}, JSON.stringify(process.pid)+'\\n');\n` + original)
  const file = mcpExport(dir, { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture] })
  const result = await presetHost({ rows: [{ id: 'dsh-workbench-presets', config: { mcpConfigFile: file } },
    { insert: [{ id: 'chore138-unrelated', name: './unrelated.mjs', disabled: true }] }],
    files: { 'unrelated.mjs': `export async function apply() { await new Promise(r => setTimeout(r, 80)) }` }, inspect: `
      ${reconcile}
      const { readFileSync } = await import('node:fs')
      const started = () => readFileSync(${JSON.stringify(starts)}, 'utf8').trim().split('\\n').map(Number).sort()
      const before = started(), missing = [], reads = []
      const timer = setInterval(() => { for (const id of ${JSON.stringify(ids)}) reads.push(registry.resolve(id).catch(() => missing.push(id))) }, 1)
      try {
        for (const disabled of [false, true, false, true]) await reconcileProfilePatches(ctx.root, [...base, { id: 'chore138-unrelated', disabled }], 'chore138')
      } finally { clearInterval(timer) }
      await Promise.all(reads)
      await ctx.get('settings').update('locale', { preference: 'zh' })
      await registry.list()
      return { before, after: started(), missing, samples: reads.length, roster: await registry.list() }
    ` })
  healthy(result)
  t.diagnostic(JSON.stringify({ before: result.extra.before, after: result.extra.after, missing: result.extra.missing, samples: result.extra.samples }))
  assert(result.extra.before.length >= 2)
  assert(result.extra.samples > 0)
  assert.deepEqual(result.extra.missing, [])
  assert.deepEqual(result.extra.after, result.extra.before)
  for (const id of ids) assert(result.toolNames[id].includes('mcp__fixture__probe'))
})

test('chore138 throwing disabled expressions are treated as disabled without losing modes', host, async () => {
  const result = await presetHost({ rows: [{ insert: [{ id: 'invalid-expression', name: 'cordis:group', group: true,
    disabled: { __jsExpr: 'missingVariable.value' }, config: [] }] }] })
  healthy(result)
})

test('chore138 presets row exposes bilingual plugin metadata through the official manager', host, async () => {
  const result = await presetHost({ inspect: `return { bundles: await ctx.get('pluginManager').listBundles() }` })
  const row = result.extra.bundles.find(b => b.name === '@miint-sunny/dsh-workbench').rows.find(r => r.rowId === 'dsh-workbench-presets')
  for (const lang of ['zh', 'en']) {
    assert(row.meta?.title?.[lang], JSON.stringify(row))
    assert(row.meta?.description?.[lang], JSON.stringify(row))
    assert.doesNotMatch(row.meta.title[lang], /dsh-workbench\//)
  }
})

test('chore138 directories in any language server path omit LSP without breaking either preset',
  { ...host, skip: !(process.env.DSH_APP && process.env.DSH_LSP_CONFIG && process.env.DSH_LSP_FIXTURES) && 'requires cached LSP fixtures' }, async t => {
    const dir = scratch(t), { lsp } = JSON.parse(readFileSync(process.env.DSH_LSP_CONFIG, 'utf8'))
    for (const key of ['nodePath', 'serverPath', 'typescriptPath']) {
      const result = await presetHost({ dependencies: lspDependencies(), rows: [{ id: 'dsh-workbench-presets', config: { lsp: { ...lsp, [key]: dir } } }] })
      healthy(result)
      for (const id of ids) { assert(!result.toolNames[id].includes('lsp'), key); assert.match(result.roster.find(row => row.id === id).description, /not configured|未配置语言服务器/) }
    }
  })

for (const [label, fields] of [
  ['startup failure', { command: '/nonexistent/chore138-mcp', failOnStartupError: true }],
  ['invalid reconnect', { reconnect: { initialDelayMs: 500, maxDelayMs: 100 } }],
  ['malformed template', { expandTemplates: true, command: '${broken}' }],
  ['missing credential', { expandTemplates: true, env: { TOKEN: '${credential:CHORE138_MISSING}' } }],
]) test(`chore138 MCP ${label} preserves both modes and reports MCP not loaded`, host, async t => {
  const file = mcpExport(scratch(t), { serverName: 'fixture', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/mcp-preset-server.mjs', import.meta.url))], startupTimeoutMs: 100, reconnect: { enabled: false }, ...fields })
  const result = await presetHost({ rows: [{ id: 'dsh-workbench-presets', config: { mcpConfigFile: file } }] })
  healthy(result)
  for (const id of ids) {
    assert.match(result.roster.find(row => row.id === id).description, /共享 MCP 未加载|Shared MCP not loaded/)
    assert.equal(result.toolNames[id].some(n => n.startsWith('mcp__')), false)
  }
})

test('chore138 enabling standalone Essentials discovery filters Standard mode tools', host, async t => {
  const dir = scratch(t), packageName = '@miint-sunny/dsh-workbench-essentials'
  const source = buildPacks({ output: join(dir, 'packs') }).find(pack => pack.name === packageName).dir
  const result = await presetHost({ packageName, source, rows: [{ id: 'dsh-workbench-tool-discovery', disabled: false }], inspect: `
    const handle = await ctx.get('agents').create({ sessionId: 'small-discovery', meta: { cwd: process.cwd(), agentPreset: 'standard' },
      setup: async scope => { await registry.mount(scope, 'standard') } })
    try {
      handle.agent.session.append('turn/start', { turn: 1 })
      const defs = tools.definitions(handle.agent)
      return { all: defs.map(t => t.name), visible: tools.selectExecutor(handle.agent).describe(defs).schemas.map(t => t.name), bundles: await ctx.get('pluginManager').listBundles() }
    } finally { await handle.dispose() }
  ` })
  assert(!result.roster.some(row => ids.includes(row.id)))
  assert(result.extra.visible.includes('workbench_discover_tools'))
  assert(result.extra.visible.includes('read'))
  assert(result.extra.all.includes('schedule_list'))
  assert(!result.extra.visible.includes('schedule_list'))
  const row = result.extra.bundles.find(b => b.name === packageName).rows.find(r => r.rowId === 'dsh-workbench-tool-discovery')
  assert.match(row.meta.description.zh, /标准模式/)
  assert.match(row.meta.description.en, /Standard mode/)
})

test('chore138 connected MCP disconnects visibly while both base presets stay healthy', host, async t => {
  const dir = scratch(t), starts = join(dir, 'starts.jsonl'), fixture = join(dir, 'mcp.mjs')
  writeFileSync(fixture, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(starts)}, JSON.stringify(process.pid)+'\\n');\n` +
    readFileSync(fileURLToPath(new URL('./fixtures/mcp-preset-server.mjs', import.meta.url)), 'utf8'))
  const file = mcpExport(dir, { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], reconnect: { enabled: false } })
  const result = await presetHost({ rows: [{ id: 'dsh-workbench-presets', config: { mcpConfigFile: file } }], inspect: `
    const { readFileSync } = await import('node:fs')
    const pids = readFileSync(${JSON.stringify(starts)}, 'utf8').trim().split('\\n').map(Number)
    const before = await registry.list()
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') throw e } }
    const until = Date.now() + 3000; let after
    do {
      after = await registry.list()
      if (after.filter(r => ${JSON.stringify(ids)}.includes(r.id)).every(r => /not loaded|未加载/.test(r.description))) break
      await new Promise(r => setTimeout(r, 10))
    } while (Date.now() < until)
    return { before, after }
  ` })
  healthy(result)
  for (const id of ids) {
    assert.match(result.extra.before.find(r => r.id === id).description, /Shared MCP loaded|已加载共享 MCP/)
    const row = result.extra.after.find(r => r.id === id)
    assert(row); assert.equal(row.broken, undefined)
    assert.match(row.description, /Shared MCP not loaded|共享 MCP 未加载/)
  }
})

test('chore138 disabling the runtime during MCP handshake leaves no presets or child process', host, async t => {
  const dir = scratch(t), starts = join(dir, 'starts.jsonl'), fixture = join(dir, 'slow-mcp.mjs')
  let server = readFileSync(fileURLToPath(new URL('./fixtures/mcp-preset-server.mjs', import.meta.url)), 'utf8')
  server = server.replace("input.on('line', line =>", "input.on('line', async line =>")
    .replace("  let result = {}", "  if (request.method === 'initialize') await new Promise(r => setTimeout(r, 250))\n  let result = {}")
  writeFileSync(fixture, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(starts)}, JSON.stringify(process.pid)+'\\n');\n` + server)
  const file = mcpExport(dir, { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], startupTimeoutMs: 2000, reconnect: { enabled: true, initialDelayMs: 40, maxDelayMs: 40 } })
  const result = await presetHost({ inspect: `
    const { existsSync, readFileSync } = await import('node:fs')
    const entry = [...loader.entries()].find(row => row.options.id === 'dsh-workbench-presets')
    const updating = entry.fiber.update({ mcpConfigFile: ${JSON.stringify(file)} }, true)
    const until = Date.now() + 3000
    while (!existsSync(${JSON.stringify(starts)}) && Date.now() < until) await new Promise(r => setTimeout(r, 5))
    if (!existsSync(${JSON.stringify(starts)})) throw new Error('MCP handshake never began')
    await entry.update({ disabled: true })
    await updating
    const pids = readFileSync(${JSON.stringify(starts)}, 'utf8').trim().split('\\n').map(Number)
    const alive = () => pids.filter(pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } })
    while (alive().length && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 120))
    const finalPids = readFileSync(${JSON.stringify(starts)}, 'utf8').trim().split('\\n').map(Number)
    return { roster: await registry.list(), pids, finalPids, alive: alive() }
  ` })
  assert(result.extra.pids.length > 0)
  assert.deepEqual(result.extra.alive, [])
  assert.deepEqual(result.extra.finalPids, result.extra.pids)
  assert.deepEqual(result.extra.roster.filter(row => ids.includes(row.id)), [])
})

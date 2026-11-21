import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

export const repository = fileURLToPath(new URL('../..', import.meta.url))

export async function presetHost({ app = process.env.DSH_APP, rows = [], dependencies = {}, bundles = [], inspect = '', files = {}, packageName = '@miint-sunny/dsh-workbench', source = repository, timeout = 30000 } = {}) {
  if (!app) throw new Error('DSH_APP must point to a disposable App copy')
  const appPath = realpathSync(app)
  for (const root of [source, ...Object.values(dependencies)]) {
    const inside = relative(realpathSync(root), appPath)
    if (inside === '' || (inside !== '..' && !inside.startsWith('..' + sep) && !inside.startsWith(sep))) {
      throw new Error('DSH_APP must be outside linked plugin roots: HMR treats nested App ASAR files as plugin sources')
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'dwb-presets-'))
  const home = join(dir, 'home'), profile = join(home, 'profiles', 'chore136')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  const links = { [packageName]: source, ...dependencies }
  for (const [name, source] of Object.entries(links)) {
    const target = join(profile, 'node_modules', name)
    mkdirSync(resolve(target, '..'), { recursive: true })
    symlinkSync(source, target, 'dir')
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'workbench-preset-test', private: true,
    dependencies: Object.fromEntries(Object.entries(links).map(([name, path]) => [name, 'link:' + path])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName, ...bundles] } },
  }))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\nminimumReleaseAgeStrict: true\n')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(profile, name), text)
  writeFileSync(join(profile, 'inspect.mjs'), `
import { writeFileSync } from 'node:fs'
export const inject = ['agentPresets', 'loader']
export function apply(ctx) {
  let stopped = false
  const registry = ctx.agentPresets, loader = ctx.loader, tools = ctx.get('tools')
  const timer = setTimeout(async () => {
    try {
      await loader.await()
      if (stopped) return
      const roster = await registry.list()
      if (stopped) return
      const compositions = await registry.compositionInventory()
      if (stopped) return
      const toolNames = {}
      for (const preset of roster.filter(row => row.broken === undefined)) {
        const lease = await registry.acquireScope(preset.id)
        try { toolNames[preset.id] = tools.definitions(lease.key).map(tool => tool.name).sort() }
        finally { await lease[Symbol.asyncDispose]() }
        if (stopped) return
      }
      const extra = await (async () => { ${inspect}; return {} })()
      if (stopped) return
      const rootRows = [...loader.entries()].map(entry => ({ id: entry.options.id, module: entry.options.name, state: entry.fiber?.state, disabled: entry.disabled }))
      writeFileSync(${JSON.stringify(join(dir, 'result.json'))}, JSON.stringify({ roster, compositions, toolNames, rootRows, extra }))
      process.exit(0)
    } catch (error) { if (!stopped) { console.error('PRESET_INSPECTION_FAILED', error); process.exit(1) } }
  }, 0)
  ctx.effect(() => () => { stopped = true; clearTimeout(timer) })
}
`)
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([...rows, { insert: [{ id: 'chore136-inspect', name: './inspect.mjs' }] }]))
  const port = await new Promise((res, reject) => {
    const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const value = server.address().port
      server.close(() => res(value))
    })
  })
  const env = { HOME: join(dir, 'user'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_offline: 'true', npm_config_update_notifier: 'false' }
  mkdirSync(env.HOME)
  const child = spawn(join(app, 'Contents/Resources/runtime/cli/bin/dsh'), ['--profile', 'chore136', '--port', String(port), '--no-open'],
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  try {
    const code = await new Promise((res, reject) => { child.once('exit', res); child.once('error', reject) })
    log = log.replace(/([?&]token=)[^\s]+/g, '$1[temporary-token]')
    if (code !== 0) throw new Error(`Preset Host exited ${code}:\n${log}`)
    return { ...JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), log }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

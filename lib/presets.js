/** Register current-App compositions independently of installers and generated bundles. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { officialPresetPair, declaredPresetIds, readPresetConfiguration } from './preset-config.js'
import { createLspPresetEntry } from './lsp-config.js'
import { probeLspStatus } from './lsp-status.js'
import { presetText } from './preset-copy.js'
import { presetLocale, watchPresetLocale } from './preset-locale.js'
import { presetMcpStates, forgetPresetMcp } from './preset-mcp-state.js'

export const name = '@miint-sunny/dsh-workbench/presets'
export const inject = ['agentPresets', 'loader']
export async function apply(ctx, options = {}) {
  const profile = ctx.get('profileContext')
  const anchor = profile ? pathToFileURL(profile.installAnchor).href : import.meta.resolve('@deepseek-ai/dsh-app-boot')
  const require = createRequire(anchor), { load } = require('js-yaml')
  const loader = ctx.loader, registry = ctx.agentPresets
  const { entryListSchema, applyEntryPatches } = await loader.internal.import('@deepseek-ai/cordis-plugin-include', anchor, {})
  const { isJsExpr, evaluate } = await loader.internal.import('@deepseek-ai/cordis-plugin-loader', anchor, {})
  const official = id => load(readFileSync(require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`), 'utf8'), { schema: entryListSchema })
  const tree = ctx.fiber.entry.parent.tree, owner = tree.ctx.fiber.entry
  const owned = new Map(), pending = new Set()
  let closed = false, queue = Promise.resolve()
  watchPresetLocale(ctx)

  function reservedIds(rows) {
    const entries = new Map([...tree.entries()].map(entry => [entry.options.id, entry]))
    return declaredPresetIds(rows, row => {
      try {
        return isJsExpr(row.disabled) ? Boolean(evaluate(entries.get(row.id)?.context ?? ctx, row.disabled.__jsExpr)) : Boolean(row.disabled)
      } catch { return true } // The Host treats invalid disabled expressions as disabled.
    })
  }

  async function release(ids = [...owned.keys()]) {
    const disposers = ids.map(id => { const record = owned.get(id); owned.delete(id); return record?.dispose })
    await Promise.all(disposers.filter(Boolean).map(dispose => dispose()))
  }

  async function registerCurrent() {
    if (closed) return
    const { plugins, orders } = officialPresetPair(official('standard'), official('ptc'))
    const settings = readPresetConfiguration(options)
    const status = await probeLspStatus(ctx, settings.lsp)
    if (closed) return
    const reserved = reservedIds(tree.root.data)
    for (const kind of ['coding', 'full']) {
      const id = 'dsh-workbench-' + kind
      if (closed || reserved.has(id)) continue
      const base = [...structuredClone(plugins), ...(status.ready ? [createLspPresetEntry(status.config)] : [])]
      const signature = { order: orders[kind], plugins: base, mcp: settings.mcpRows }
      const existing = owned.get(id)
      if (existing && isDeepStrictEqual(existing.signature, signature)) {
        existing.display.status = status
        existing.display.settings = settings
        continue
      }
      await release([id])
      if (closed) return
      const token = randomUUID(), states = presetMcpStates(ctx, token)
      const display = { status, settings }
      const text = () => presetText(presetLocale(ctx, options.locale), kind, display.status, {
        ...display.settings, mcpUnavailable: display.settings.mcpUnavailable || [...states.values()].some(ready => !ready),
      })
      const definition = { id, get name() { return text().name }, get description() { return text().description },
        order: orders[kind], plugins: [...base, ...settings.mcpRows.map(row => ({
          id: row.id, name: '@miint-sunny/dsh-workbench/preset-mcp', disabled: row.disabled,
          config: { token, server: row.config },
        }))] }
      const registering = registry.register(definition).then(dispose => async () => { await dispose(); forgetPresetMcp(ctx, token) })
      pending.add(registering)
      try {
        const dispose = await registering
        if (closed) await dispose()
        else owned.set(id, { dispose, signature, display })
      } finally { pending.delete(registering) }
    }
  }

  function serial(action) {
    const work = queue.then(action)
    queue = work.catch(() => {})
    return work
  }

  ctx.effect(() => async () => {
    closed = true
    // A composition update can itself dispose this row; wait only for registrations.
    await Promise.allSettled([...pending].map(async registering => (await registering)()))
    await release()
  }, 'workbench runtime presets')

  ctx.on('loader/patch-context', (entry, next) => {
    if (entry !== owner) return next()
    return serial(async () => {
      // Include has received its next config, but has not yet updated its children.
      // Release only IDs a declarative row will claim during that concurrent update.
      const upcoming = applyEntryPatches(tree.cache.data, entry.options.config.patches)
      await release([...reservedIds(upcoming)])
      try { return await next() }
      finally { if (!closed) await registerCurrent() }
    })
  })
  await serial(registerCurrent)
}

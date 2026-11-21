/** Optional MCP adapter: an unavailable server cannot invalidate the base preset. */
import { pathToFileURL } from 'node:url'
import { presetMcpStates } from './preset-mcp-state.js'
import { refreshPresetDisplay } from './preset-locale.js'

export const name = '@miint-sunny/dsh-workbench/preset-mcp'
export const inject = ['loader', 'tools']
export async function apply(ctx, { token, server }) {
  const states = presetMcpStates(ctx, token), key = ctx.fiber
  const update = state => {
    const ready = state === 'connected'
    if (states.get(key) === ready) return
    states.set(key, ready)
    refreshPresetDisplay(ctx)
  }
  states.set(key, false)
  ctx.effect(() => () => { states.delete(key) }, 'optional MCP status')
  try {
    const profile = ctx.get('profileContext')
    const anchor = profile ? pathToFileURL(profile.installAnchor).href : ctx.baseUrl
    const mcp = await ctx.loader.internal.import('@deepseek-ai/dsh-mcp-client', anchor, {})
    const config = mcp.Config({ ...structuredClone(server), failOnStartupError: false })
    // Use this row's lifecycle. All official connection/tool effects are disposed
    // with it, including partially initialized connections after a failed apply.
    await mcp.apply(ctx, config)
    const handle = mcp.connectionStatusOf(ctx.fiber)
    if (handle) {
      update(handle.current().state)
      ctx.effect(() => handle.onChange(status => update(status.state)), 'optional MCP connection status')
    }
  } catch {
    // Configuration and startup errors are optional here; never expose config/credentials.
    update('unavailable')
  }
}

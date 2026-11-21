/** Optional MCP status belongs to one retained preset generation, never a profile file. */
const roots = new WeakMap()
export function presetMcpStates(ctx, token) {
  let groups = roots.get(ctx.root)
  if (!groups) roots.set(ctx.root, groups = new Map())
  let states = groups.get(token)
  if (!states) groups.set(token, states = new Map())
  return states
}
export function forgetPresetMcp(ctx, token) { roots.get(ctx.root)?.delete(token) }

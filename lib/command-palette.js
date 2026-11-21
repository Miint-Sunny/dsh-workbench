/** Client-only command directory; contributes no model tools or system prompt. */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/command-palette'
export function apply(ctx) {
  ctx.effect(() => registerFeature('command-palette'), '@miint-sunny/dsh-workbench/command-palette: feature')
}

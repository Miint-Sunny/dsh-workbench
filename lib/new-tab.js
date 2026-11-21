/** Client-only guide layout; contributes no model tools or system prompt. */
import { registerFeature } from './features.js'
export const name = '@miint-sunny/dsh-workbench/new-tab'
export function apply(ctx) {
  ctx.effect(() => registerFeature('new-tab'), '@miint-sunny/dsh-workbench/new-tab: feature')
}

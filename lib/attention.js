/** Read-only pending-interaction UI; does not register model content or request handlers. */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/attention'
export function apply(ctx) {
  ctx.effect(() => registerFeature('attention'), '@miint-sunny/dsh-workbench/attention: feature')
}

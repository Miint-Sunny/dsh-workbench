/**
 * dsh-workbench/session-header 行的宿主端：会话顶栏的排列只在网页端做，这里只向根行的功能登记处报到。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/session-header'

/**
 * 注册 session-header 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('session-header'), '@miint-sunny/dsh-workbench/session-header: feature registration')
}

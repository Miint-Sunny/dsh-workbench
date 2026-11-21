/**
 * dsh-workbench/turn-nav 行的宿主端：轮次导航只有网页部分（src/client/turn-nav.js），这里只向根行的功能登记处报到，
 * 不给模型加工具或提示词。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/turn-nav'

/**
 * 注册 turn-nav 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('turn-nav'), '@miint-sunny/dsh-workbench/turn-nav: feature registration')
}

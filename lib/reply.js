/**
 * dsh-workbench/reply 行的宿主端：选中文字回复。界面和逻辑都在客户端（src/client/reply.js），这里只登记功能清单。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/reply'

/**
 * 注册 reply 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('reply'), '@miint-sunny/dsh-workbench/reply: feature registration')
}

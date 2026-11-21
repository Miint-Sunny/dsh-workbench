/**
 * dsh-workbench/plan 行的宿主端：计划全文进对话。界面和逻辑都在客户端（src/client/plan.js），
 * 这里只登记功能清单。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/plan'

/**
 * 注册 plan 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('plan'), '@miint-sunny/dsh-workbench/plan: feature registration')
}

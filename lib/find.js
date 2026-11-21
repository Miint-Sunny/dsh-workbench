/**
 * dsh-workbench/find 行的宿主端：会话里查找（计划第 7 项）。先只向根行的功能登记处报到，开发时在这里补路由和工具。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/find'

/**
 * 注册 find 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('find'), '@miint-sunny/dsh-workbench/find: feature registration')
}

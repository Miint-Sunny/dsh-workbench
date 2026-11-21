/**
 * dsh-workbench/organize 行的宿主端：向根行的功能登记处报到，并提供标签、标为未读
 * 数据的读写路由（存取和校验在同目录 organize-state.js，纯函数，测试直接跑它）。
 */
import { registerFeature } from './features.js'
import { applyOrganizeRoutes } from './organize-state.js'

export const name = '@miint-sunny/dsh-workbench/organize'

/**
 * 注册 organize 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('organize'), '@miint-sunny/dsh-workbench/organize: feature registration')
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => applyOrganizeRoutes(scope), '@miint-sunny/dsh-workbench/organize: state routes')
  })
}

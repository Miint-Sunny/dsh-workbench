/**
 * dsh-workbench/rerun 行的宿主端：重新生成和编辑重发（计划第 6 项）。界面和逻辑都在客户端（src/client/rerun.js）：从这一轮提问之前分叉出新会话再发。宿主端向根行的功能登记处报到，并提供行配置的读写路由（默认值和校验在同目录 rerun-state.js，纯函数，测试直接跑它）。
 */
import { registerFeature } from './features.js'
import { applyRerunRoutes } from './rerun-state.js'

export const name = '@miint-sunny/dsh-workbench/rerun'

/**
 * 注册 rerun 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('rerun'), '@miint-sunny/dsh-workbench/rerun: feature registration')
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => applyRerunRoutes(scope), '@miint-sunny/dsh-workbench/rerun: config routes')
  })
}

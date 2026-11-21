/**
 * dsh-workbench/notify 行的宿主端：向根行的功能登记处报到，并提供通知配置的读写
 * 路由。通知本身在客户端发（订阅 uiSession.sessionStatus，用网页 Notification），
 * 配置的默认值和校验在同目录 notify-state.js（纯函数，测试直接跑它）。
 */
import { registerFeature } from './features.js'
import { applyNotifyRoutes } from './notify-state.js'

export const name = '@miint-sunny/dsh-workbench/notify'

/**
 * 注册 notify 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('notify'), '@miint-sunny/dsh-workbench/notify: feature registration')
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => applyNotifyRoutes(scope), '@miint-sunny/dsh-workbench/notify: config routes')
  })
}

/**
 * dsh-workbench/settings-icons 行的宿主端：设置页图标只在网页端注册，这里只向根行的功能登记处报到。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/settings-icons'

/**
 * 注册 settings-icons 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('settings-icons'), '@miint-sunny/dsh-workbench/settings-icons: feature registration')
}

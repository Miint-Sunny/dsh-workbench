/**
 * dsh-workbench/browser-viewport 行的宿主端：视口尺寸只在网页端做（往官方浏览器卡片的工具栏里插按钮、给网页框套样式），
 * 这里只向根行的功能登记处报到。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/browser-viewport'

/**
 * 注册 browser-viewport 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('browser-viewport'), '@miint-sunny/dsh-workbench/browser-viewport: feature registration')
}

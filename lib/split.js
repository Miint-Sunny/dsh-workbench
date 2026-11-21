/**
 * dsh-workbench/split 行的宿主端：分屏（计划第 4 项）。界面和逻辑都在客户端（src/client/split.js）：右边栏新标签类型嵌入另一个普通会话。宿主端只向根行的功能登记处报到。
 */
import { registerFeature } from './features.js'

export const name = '@miint-sunny/dsh-workbench/split'

/**
 * 注册 split 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('split'), '@miint-sunny/dsh-workbench/split: feature registration')
}

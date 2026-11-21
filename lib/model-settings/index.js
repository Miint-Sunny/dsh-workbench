/**
 * dsh-workbench/model-settings 行的宿主端：向根行的功能登记处报到，注册「检查连接」「获取可用模型」（目录里的提供商）、
 * 「目录协议」和「设为默认模型」四个接口（routes.js）。页面在网页端（src/client/model-settings/），读写设置和凭据都走
 * DSH 自己的接口。OpenCode 目录外模型要的会话 ID 请求头在另一行 @miint-sunny/dsh-workbench/opencode-session
 * （opencode-session.js），和页面分开开关。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerFeature } from '../features.js'
import { assertNoLegacyPlugin } from '../legacy-plugins.js'
import { registerRoutes } from './routes.js'

export const name = '@miint-sunny/dsh-workbench/model-settings'

/**
 * 注册 model-settings 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  assertNoLegacyPlugin('model-settings')
  ctx.effect(() => registerFeature('model-settings'), '@miint-sunny/dsh-workbench/model-settings: feature registration')
  registerRoutes(ctx, { createUserMessage, BlockAssembler })
}

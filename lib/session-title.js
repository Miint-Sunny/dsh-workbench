/**
 * dsh-workbench/session-title 行（插件页叫「会话标题」）的宿主端：向根行的功能登记处报到，再注册标题提供方、
 * 轮末的补救和重算、`/retitle`（session-title-provider.js）。这里 import DSH 的四个包，把用到的构造传给提供方模块；
 * 侧栏会话菜单的「重新起名」在网页端（src/client/session-title.js）。
 */
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { SessionTitleProviderId, normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import { registerFeature } from './features.js'
import { assertNoLegacyPlugin } from './legacy-plugins.js'
import { DEFAULTS, registerSessionTitle } from './session-title-provider.js'

export const name = '@miint-sunny/dsh-workbench/session-title'
export const inject = ['sessionTitle', 'llm']

const positive = () => z.number().step(1).min(1)

/** 这一行的配置；补丁里不写，用 DEFAULTS 的默认值。 */
export const Config = z.object({
  tailMessages: positive().default(DEFAULTS.tailMessages).description('取最近多少条对话（用户和助手都算），加上首条用户消息一起起标题'),
  refreshEveryPrompts: z.number().step(1).min(0).default(DEFAULTS.refreshEveryPrompts).description('距上次标题又发了多少条消息后，在一轮结束时参考上下文自动重算；0 = 关闭（只在首条消息时起名，参考上下文只靠 /retitle 或菜单「重新起名」）'),
  headMaxChars: positive().default(DEFAULTS.headMaxChars).description('首条用户消息最多保留的字符数'),
  messageMaxChars: positive().default(DEFAULTS.messageMaxChars).description('最近对话里每条消息最多保留的字符数'),
  maxInputChars: positive().default(DEFAULTS.maxInputChars).description('一次请求里对话内容的总字符上限；超出时先丢中间的旧消息'),
  targetWords: positive().default(DEFAULTS.targetWords).description('非中日韩语言标题的目标词数'),
  targetCjkCharacters: positive().default(DEFAULTS.targetCjkCharacters).description('中日韩语言标题的目标字数'),
  maxOutputTokens: positive().default(DEFAULTS.maxOutputTokens).description('标题请求的输出 token 上限；关不掉思考的模型要靠它给思考留出空间，能关思考时模型写完标题就停，不会用满'),
  titleEfforts: z.array(z.string()).default([...DEFAULTS.titleEfforts]).description('标题请求的思考档位偏好：取模型声明的第一个；都没有就用模型默认档位'),
  timeoutMs: positive().max(600000).default(DEFAULTS.timeoutMs).description('单次标题请求超时（毫秒）'),
  provider: z.string().description('可选：固定标题请求用的模型提供商，须与 model 同时设置；不设则跟随会话当前模型'),
  model: z.string().description('可选：固定标题请求用的模型 id，须与 provider 同时设置'),
})

/**
 * 注册 session-title 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（已注入 sessionTitle、llm）。
 * @param {object} config Loader 校验过的配置。
 */
export function apply(ctx, config) {
  assertNoLegacyPlugin('session-title')
  ctx.effect(() => registerFeature('session-title'), '@miint-sunny/dsh-workbench/session-title: feature registration')
  registerSessionTitle(ctx, config, { BlockAssembler, createUserMessage, deadline, SessionTitleProviderId, normalizeSessionTitle })
}

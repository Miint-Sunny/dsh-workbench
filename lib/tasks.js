/**
 * dsh-workbench/tasks 行的宿主端：任务清单和收尾框（计划第 2 项）。
 *
 * - `wrap_up` 工具：模型交回前报两三句总结，需要用户拍板时带一个问题和 1–2 个按钮。
 *   参数校验和投影折叠在同目录 wrapup-state.js（纯函数，测试直接跑它）。
 * - 任务清单的数据还是官方 todo_write 的 todos 投影，这一行只换显示（网页端）。
 * - 提示词：一段静态系统提示词，告诉模型多步任务用 todo_write、交回时调 wrap_up。
 *   采用完整系统提示词（complete: true）的预设不会接收全局提示词段。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerFeature } from './features.js'
import { MAX_ACTION_CHARS, MAX_ASK_CHARS, MAX_RECAP_CHARS, parseWrapUpState, wrapUpArgsOf, wrapUpFold, wrapUpInit } from './wrapup-state.js'

export const name = '@miint-sunny/dsh-workbench/tasks'
export const inject = ['tools', 'sessionProjections', 'systemPrompt']

/** wrap_up 工具给模型的说明。 */
const WRAP_UP_DESCRIPTION =
  '在把工作交回给用户之前调用（只回答问题或闲聊时不用调）。用户点 actions 按钮即把按钮文字作为回答发出。'

/** 静态提示词段：多步任务用任务清单，交回时收尾；总结只进 wrap_up，正文不重复（桌面端实测：模型把 recap 又写进了正文）。 */
const PROMPT_TEXT =
  '多步任务先用 todo_write 列出任务清单，每完成一项就更新它。把这一轮的工作交回给用户之前，调用 wrap_up 做两三句总结；需要用户决定的事用它的 ask 和 actions 写成一个问题加按钮，不要把问题埋在正文里。总结只写进 wrap_up 的 recap，正文不要再重复一遍；正文只放 recap 装不下的东西，例如命令输出和文件清单。'

/**
 * 注册 tasks 行：功能登记、wrap_up 工具、workbenchWrapUp 投影、提示词段。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('tasks'), '@miint-sunny/dsh-workbench/tasks: feature registration')

  ctx.sessionProjections.register({
    key: 'workbenchWrapUp',
    stateSchema: { parse: parseWrapUpState },
    init: () => wrapUpInit(),
    apply: wrapUpFold,
    wire: { viewSchema: { parse: parseWrapUpState }, view: (state) => state },
    stateVersion: 1,
  })

  ctx.tools.register(defineTool({
    name: 'wrap_up',
    description: WRAP_UP_DESCRIPTION,
    parameters: {
      recap: {
        type: 'string',
        required: true,
        description: `两三句总结这一轮做了什么、结果如何；不超过 ${MAX_RECAP_CHARS} 字。`,
      },
      ask: {
        type: 'string',
        description: `需要用户决定时的问题，一句话；不超过 ${MAX_ASK_CHARS} 字。给了 actions 就必填。`,
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
        description: `问题的 1–2 个按钮文字（第一个是你推荐的），每个不超过 ${MAX_ACTION_CHARS} 字；只在给了 ask 时使用。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (args) => [{
        type: 'text',
        text: Array.isArray(args?.actions) && args.actions.length > 0 ? '已显示总结和按钮。' : '已显示总结。',
      }],
    },
    execute(args) {
      wrapUpArgsOf(args)
      return Promise.resolve({ ok: true })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '收尾',
      kind: 'other',
      rawInput: typeof args?.recap === 'string' ? args.recap : '',
    }),
  }))

  ctx.systemPrompt.section({ name: 'workbench:tasks', order: 2950, text: PROMPT_TEXT })
}

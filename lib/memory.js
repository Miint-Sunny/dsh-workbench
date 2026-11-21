/** 项目记忆工具；正文仅通过已记录的工具结果进入模型，不注入文件内容。 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { workbenchDataDir } from './data-dir.js'
import { registerFeature } from './features.js'
import { createMemoryStore, memoryEligible, parseMemoryConfig } from './memory-store.js'

export const name = '@miint-sunny/dsh-workbench/memory'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']
export const MEMORY_PROMPT = '开始项目工作时先用 memory_view 读记忆；确认项目约定或踩坑后合并进 memory_write。只写当前项目已验证事实，不写跨项目偏好、凭据或临时进度。'

/** 注册两个条件工具及与实际可用工具一致的静态提示词。 */
export function apply(ctx, options) {
  const config = parseMemoryConfig(options)
  const store = createMemoryStore({ root: join(workbenchDataDir(), 'memory'), maxBytes: config.maxBytes })
  ctx.effect(() => registerFeature('memory'), 'workbench memory feature')
  const current = agent => {
    if (agent === undefined) return {}
    const presets = ctx.get('agentPresets')
    return {
      cwd: ctx.workingDirectory.get(agent.session),
      origin: agent.session.header.origin,
      delegationDepth: agent.session.header.delegationDepth,
      agentPreset: presets === undefined ? agent.session.header.agentPreset : presets.presetForSession(agent.session),
    }
  }
  const eligible = agent => memoryEligible(current(agent), config)
  for (const writing of [false, true]) {
    ctx.tools.register(defineTool({
      name: writing ? 'memory_write' : 'memory_view',
      description: writing ? `替换同项目记忆（含项目头最多 ${config.maxBytes} 字节）。` : '读取同项目记忆和 revision；Git 工作树共享。',
      parameters: writing ? {
        content: { type: 'string', required: true, description: '整理后的完整记忆正文，不含项目头。' },
        revision: { type: 'string', required: true, description: '最近 memory_view 返回的 revision，防止覆盖别处的修改。' },
      } : {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          project: { type: 'string', required: true }, content: { type: 'string', required: true }, revision: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, exists: { type: 'boolean', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => ({ project: value.project, bytes: value.bytes, exists: value.exists }),
      },
      async execute(args, exec) {
        const state = current(exec.agent)
        if (!memoryEligible(state, config)) throw new Error('这个会话不使用项目记忆。')
        const cwd = state.cwd
        const value = writing ? await store.write(cwd, args) : await store.view(cwd)
        return { project: value.project.path, content: value.content, revision: value.revision, bytes: value.bytes, exists: value.exists }
      },
      presentCall: () => ({ card: 'generic', title: writing ? '写入项目记忆' : '读取项目记忆', kind: 'other' }),
    }), { when: ({ agent }) => eligible(agent) })
  }
  ctx.systemPrompt.section({ name: 'workbench:memory', order: 2960, text: ({ agent, toolSet }) => {
    if (!eligible(agent) || toolSet === undefined) return ''
    return ['memory_view', 'memory_write'].every(name => ctx.tools.get(name, agent, toolSet)) ? MEMORY_PROMPT : ''
  } })
}

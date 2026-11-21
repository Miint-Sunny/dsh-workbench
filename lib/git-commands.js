/** 提交、推送、变更请求和修复检查的斜杠命令。命令只发一条用户消息，不加工具，也不进系统提示词。 */
import { randomUUID } from 'node:crypto'

export const name = '@miint-sunny/dsh-workbench/git-commands'
export const inject = ['commands']

/** 命令宿主没有浏览器 locale 参数，静态文案由行配置 locale 选择。`pr` 的消息和官方「创建变更请求」按钮发的一样。 */
const COPY = {
  zh: {
    hint: '[补充说明]',
    extra: '补充说明：',
    commands: {
      commit: ['提交本会话的变更', '提交本会话的变更。先看 git status 和 git diff，只提交这次的改动，提交信息写清楚改了什么。不要推送。'],
      push: ['推送当前分支', '把当前分支推送到远端。推送前确认分支和远端，不要强制推送。'],
      pr: ['为本会话的变更创建变更请求', '为本会话的变更创建变更请求'],
      'fix-ci': ['修复变更请求失败的检查', '查看当前分支变更请求失败的检查，用 gh pr checks 和 gh run view --log-failed 找到原因并修复。修好后提交并推送，再看一次检查结果。'],
    },
  },
  en: {
    hint: '[notes]',
    extra: 'Notes: ',
    commands: {
      commit: ["Commit this Session's changes", "Commit this Session's changes. Check git status and git diff first, commit only these changes, and say what changed in the message. Do not push."],
      push: ['Push the current branch', 'Push the current branch to its remote. Confirm the branch and remote first. Do not force push.'],
      pr: ['Create a change request for the changes of this Session', 'Create a change request for the changes of this Session'],
      'fix-ci': ['Fix failed checks on the change request', "Look at the failed checks on this branch's change request, use gh pr checks and gh run view --log-failed to find the cause, and fix it. Then commit, push and check the results again."],
    },
  },
}

/** 解析行配置，配错就拒绝加载。 */
export function gitCommandsConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('git-commands: config must be an object')
  for (const key of Object.keys(config)) {
    if (key !== 'locale') throw new Error(`git-commands: unknown field ${key}`)
  }
  const { locale = 'zh' } = config
  if (!Object.hasOwn(COPY, locale)) throw new Error('git-commands: locale must be zh or en')
  return { locale }
}

/** 拼出发给模型的那条消息。斜杠后面写的内容跟在固定文字之后。 */
export function gitCommandMessage(fixed, extraLabel, rawInput) {
  const extra = rawInput.trim()
  return extra ? `${fixed}\n\n${extraLabel}${extra}` : fixed
}

/** 全局注册，命令面板和输入框都从同一份列表读。输入只记在用户消息里，所以不再写进命令事件。 */
export function apply(ctx, options) {
  const copy = COPY[gitCommandsConfig(options).locale]
  for (const [command, [description, message]] of Object.entries(copy.commands)) {
    ctx.commands.register({
      name: command,
      definitionId: `dsh-workbench.git-commands.${command}`,
      description,
      input: { hint: copy.hint },
      recordInput: false,
      handler({ agent, rawInput }) {
        agent.followup({
          id: randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: gitCommandMessage(message, copy.extra, rawInput) }],
        })
        return { kind: 'success' }
      },
    })
  }
}

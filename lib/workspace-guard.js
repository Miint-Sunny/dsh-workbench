/**
 * dsh-workbench/workspace-guard 宿主端（feat#188）：
 * 在 tools/pre-execute 挂全局前置拦截（对所有会话、所有子智能体、所有权限模式生效）：
 * - 写入、移动、删除 DSH 数据目录（$DSH_HOME，默认 ~/.dsh）下的 storages/ 和 sessions/ 时先请用户确认；
 * - 移动、改名、删除已登记工作区的根文件夹本身时先请用户确认。
 *
 * 权限模式边界（基于 App 0.2.2-rc.5 源码实查）：
 * - ask 策略（仅可查看、工作区内修改、自动审查根会话）：返回 { kind: 'ask', reason, displayReason }，
 *   经 ToolExecutionPipeline.serviceAsk 走人工审批卡片；放行规则因 isWorkspaceGuardReason 拒答。
 * - never 策略（「完全权限」与所有子智能体）：ApprovalService.decide 在分发前直接返回 'rejected'，
 *   插件无法弹出审批卡片；此时返回 { kind: 'deny' } 阻止执行并说明原因和正确做法。
 */
import { homedir } from 'node:os'
import { dirname, isAbsolute, sep } from 'node:path'
import { workbenchDataDir } from './data-dir.js'
import { registerFeature } from './features.js'
import { formatGuardPrompt } from './workspace-guard-copy.js'
import { buildProtectedContext, classifyPathTarget, expandPathVars } from './workspace-guard-paths.js'
import { inspectShellCommand } from './workspace-guard-shell.js'

export const name = '@miint-sunny/dsh-workbench/workspace-guard'

/**
 * 解析 apply_patch 补丁里的文件增删改移动路径。
 * @param {string} input 补丁文本。
 * @param {object} context 规范化上下文。
 * @returns {{ kind: 'dsh-data' | 'workspace-root' | 'unverified', target: string } | null} 命中目标或 null。
 */
function inspectApplyPatch(input, context) {
  if (typeof input !== 'string' || !input) return null
  for (const line of input.split(/\r?\n/)) {
    let m = line.match(/^\*\*\* (?:Add|Update) File:\s*(.+)$/)
    if (m) {
      const hit = classifyPathTarget(m[1].trim(), 'write', context)
      if (hit) return hit
      continue
    }
    m = line.match(/^\*\*\* Move to:\s*(.+)$/)
    if (m) {
      const hit = classifyPathTarget(m[1].trim(), 'write', context)
      if (hit) return hit
      continue
    }
    m = line.match(/^\*\*\* Delete File:\s*(.+)$/)
    if (m) {
      const hit = classifyPathTarget(m[1].trim(), 'move-or-delete', context)
      if (hit) return hit
    }
  }
  return null
}

/**
 * 按工具名与参数判断一次工具调用是否触及受保护路径。
 * @param {{ name?: string, arguments?: unknown, parent?: unknown }} exec 待执行的工具调用。
 * @param {{ dshHome: string, home?: string, cwd?: string, workspaceRoots?: string[], env?: Record<string, string | undefined> }} options 路径与工作区配置。
 * @returns {{ kind: 'dsh-data' | 'workspace-root' | 'unverified', target: string } | null} 命中目标或 null。
 */
export function inspectToolExecution(exec, options) {
  if (!exec || typeof exec.name !== 'string') return null
  // 外层 run_code 只是 PTC 传输壳，里面的每次工具调用都会再经 ToolExecutionPipeline 进入本函数
  if (exec.parent === undefined && exec.name === 'run_code') return null

  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
  const ctx = buildProtectedContext(options)

  switch (exec.name) {
    case 'write':
    case 'edit':
      return typeof args.file_path === 'string' ? classifyPathTarget(args.file_path, 'write', ctx) : null

    case 'apply_patch':
      return inspectApplyPatch(args.input, ctx)

    case 'str_replace_editor':
      if (args.command === 'view') return null
      return typeof args.path === 'string' ? classifyPathTarget(args.path, 'write', ctx) : null

    case 'bash':
    case 'pwsh': {
      if (typeof args.command !== 'string') return null
      let effectiveCwd = ctx.cwd
      if (typeof args.workdir === 'string' && args.workdir.trim() !== '') {
        const exp = expandPathVars(args.workdir, ctx)
        effectiveCwd = isAbsolute(exp) ? exp : ctx.cwd + sep + exp
      }
      return inspectShellCommand(args.command, { ...ctx, cwd: effectiveCwd }, { shell: exec.name })
    }

    case 'terminal_send':
      return typeof args.text === 'string' ? inspectShellCommand(args.text, ctx, { shell: 'bash' }) : null

    default:
      return null
  }
}

function effectiveApprovalPolicy(approval, session) {
  if (!approval || !session) return 'ask'
  if (typeof approval.effectivePolicy === 'function') return approval.effectivePolicy(session)
  if (typeof approval.overrideOf === 'function') {
    const override = approval.overrideOf(session)
    if (override === 'ask' || override === 'never') return override
    if (approval.config?.policy === 'ask' || approval.config?.policy === 'never') return approval.config.policy
  }
  return 'ask'
}

/**
 * 在宿主上下文上安装保护监听器，返回注销函数。
 * @param {object} scope Cordis 上下文（含 on/get 等）。
 * @param {{ dshHome: string, home?: string, env?: Record<string, string | undefined> }} options 数据目录与家目录。
 * @returns {() => void} 注销函数。
 */
export function createWorkspaceGuard(scope, { dshHome, home = homedir(), env = process.env }) {
  const guardedTools = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'bash', 'pwsh', 'terminal_send'])
  return scope.on('tools/pre-execute', async (exec, next) => {
    if (!guardedTools.has(exec.name)) return next()
    const session = exec.agent?.session
    const cwd = (session && scope.get('workingDirectory')?.get?.(session))
      ?? session?.header?.cwd
      ?? process.cwd()
    const hit = inspectToolExecution(exec, {
      dshHome, home, cwd, workspaceRegistry: scope.get('workspaceRegistry'), env,
    })
    if (!hit) return next()

    const prompt = formatGuardPrompt(hit.kind)
    const approval = scope.get('approval')
    if (effectiveApprovalPolicy(approval, session) === 'never') {
      return {
        kind: 'deny',
        reason: prompt.denyReason,
        info: {
          name: 'ProtectedPathError',
          code: 'PROTECTED_PATH_DENIED',
          reason: prompt.displayReason.zh,
        },
      }
    }
    const downstream = await next()
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
    return {
      kind: 'ask',
      reason: prompt.reason,
      displayReason: prompt.displayReason,
    }
  }, { prepend: true })
}

/**
 * 注册 workspace-guard 功能行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dshHome?: string, home?: string, env?: Record<string, string | undefined> }} [config] 可选覆盖（测试用）。
 */
export function apply(ctx, config = {}) {
  ctx.effect(() => registerFeature('workspace-guard'), '@miint-sunny/dsh-workbench/workspace-guard: feature registration')
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => createWorkspaceGuard(scope, {
      dshHome: config.dshHome ?? dirname(workbenchDataDir(config.env)),
      home: config.home ?? homedir(),
      env: config.env ?? process.env,
    }), '@miint-sunny/dsh-workbench/workspace-guard: pre-execute guard')
  })
}

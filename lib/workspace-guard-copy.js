/**
 * 保护 DSH 数据目录和已登记工作区根文件夹的审批提示文案（feat#188）。
 * 独立放在小文件里，供宿主端校验和 dsh-ui-guard 用语检查一起读到。
 */
export const WORKSPACE_GUARD_REASON_PREFIX = 'Workbench protected path requires confirmation: '

export const WORKSPACE_GUARD_ZH = {
  'dshData.reason': '这一步会改动 DSH 的会话或工作区登记文件。App 运行时这些改动会被覆盖，还可能让会话打不开。',
  'workspaceRoot.reason': '这一步会移动或删除已登记的工作区文件夹，工作区里的会话会找不到工作目录。',
  'unverified.reason': '无法确认这一步是否会改动 DSH 数据或已登记的工作区。请先核对命令和目标路径。',
  guidance: '要移动工作区，请在工作区设置中使用「更换文件夹…」。',
  neverPolicyNote: '当前会话处于不询问审批策略，无法弹出确认卡片，已阻止执行。',
}

export const WORKSPACE_GUARD_EN = {
  'dshData.reason': 'This action modifies DSH session or workspace registry files. While the app is running, these changes will be overwritten and may make sessions fail to open.',
  'workspaceRoot.reason': 'This action moves or deletes a registered workspace folder, so sessions in that workspace will lose their working directory.',
  'unverified.reason': 'Workbench could not verify whether this action changes DSH data or a registered workspace. Check the command and target paths first.',
  guidance: 'To move a workspace, use "Change folder…" in workspace settings.',
  neverPolicyNote: 'This session uses a non-interactive approval policy, so no confirmation card can be shown; execution was blocked.',
}

/**
 * 判断一条 approval/request 的 reason 是否由工作台保护规则发出，放行规则不得代答或建规则。
 * @param {unknown} reason 请求原因。
 * @returns {boolean} 是否为保护路径审批请求。
 */
export function isWorkspaceGuardReason(reason) {
  return typeof reason === 'string' && reason.startsWith(WORKSPACE_GUARD_REASON_PREFIX)
}

/**
 * 拼出展示在审批卡片和拒绝结果里的原因与正确做法。
 * @param {'dsh-data' | 'workspace-root' | 'unverified'} kind 命中的保护类别。
 * @returns {{ reason: string, displayReason: { zh: string, en: string }, denyReason: string, zhReason: string }} 审批与拒绝文案。
 */
export function formatGuardPrompt(kind) {
  const key = {
    'dsh-data': 'dshData.reason',
    'workspace-root': 'workspaceRoot.reason',
    unverified: 'unverified.reason',
  }[kind]
  const zhReason = WORKSPACE_GUARD_ZH[key]
  const zh = kind === 'unverified' ? zhReason : `${zhReason}${WORKSPACE_GUARD_ZH.guidance}`
  const en = kind === 'unverified' ? WORKSPACE_GUARD_EN[key] : `${WORKSPACE_GUARD_EN[key]} ${WORKSPACE_GUARD_EN.guidance}`
  return {
    reason: `${WORKSPACE_GUARD_REASON_PREFIX}${en}`,
    displayReason: { zh, en },
    denyReason: `${zh}${WORKSPACE_GUARD_ZH.neverPolicyNote}\n${en} ${WORKSPACE_GUARD_EN.neverPolicyNote}`,
    zhReason,
  }
}

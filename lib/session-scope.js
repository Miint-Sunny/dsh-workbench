/** 会话范围：工作台的记忆、检查点、收尾只给用户直接对话的顶层会话，子智能体会话不给。 */

/**
 * 是不是子智能体会话：来源是 subagent，或委派深度大于 0。
 * @param {{ origin?: string, delegationDepth?: number } | undefined} header 会话头；没有会话（例如不带会话查工具）时传 undefined，按顶层会话算。
 * @returns {boolean} 子智能体会话为 true。
 */
export function delegatedSession(header) {
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

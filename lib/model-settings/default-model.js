/**
 * 「设为默认模型」。DSH 没有不经会话设默认模型的远程接口，这里在宿主端调用 DSH 自己的
 * agentDefaultModel.saveSelection——对话里选模型时用的就是它，写进 DSH 自己的配置，插件不另存。
 * 写之前和会话里一样先让 DSH 解析一次这个模型（dsh-api-session-controller 的 commands.ts:170-185）。
 */

/**
 * 校验页面发来的请求体。
 * @param {unknown} body 解析后的 JSON。
 * @returns {{ provider: string, model: string } | undefined} 合法时返回 Provider ID 和模型 ID。
 */
export function defaultModelRequestOf(body) {
  if (typeof body !== 'object' || body === null) return undefined
  const { provider, model } = body
  if (typeof provider !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(provider)) return undefined
  if (typeof model !== 'string' || model.length === 0 || model.length > 200) return undefined
  return { provider, model }
}

/**
 * 保存默认模型。推理强度：同一个模型保留原来的；换了模型就不写，用这个模型自己的默认值。
 * @param {{ canSave: () => boolean, currentSelection: () => object, resolveCallConfig: (config: object) => Promise<unknown>, saveSelection: (selection: object) => Promise<void> }} deps DSH 的服务。
 * @param {{ provider: string, model: string }} request 合法的请求。
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'notSavable' | 'unknownModel' | 'other', message?: string }>} 结果。
 */
export async function setDefaultModel(deps, request) {
  const current = deps.currentSelection()
  if (current?.provider === request.provider && current?.model === request.model) return { ok: true }
  // 部署没有配置编辑器时，saveSelection 什么都不写也不报错，要先说清楚。
  if (!deps.canSave()) return { ok: false, reason: 'notSavable' }
  const selection = { provider: request.provider, model: request.model }
  try {
    await deps.resolveCallConfig(selection)
  } catch {
    return { ok: false, reason: 'unknownModel' }
  }
  try {
    await deps.saveSelection(selection)
  } catch (error) {
    return { ok: false, reason: 'other', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  }
  // DSH 的 saveSelection 在服务不是从配置项加载时直接返回、不报错（dsh-agent-default-model index.ts:82-86）：读回来核对，没变就不说成功。
  const after = deps.currentSelection()
  if (after?.provider !== request.provider || after?.model !== request.model) return { ok: false, reason: 'notSavable' }
  return { ok: true }
}

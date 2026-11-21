/** Compare the actual model-facing declarations, including edits under an existing tool name. */
function ordered(schemas) {
  if (!Array.isArray(schemas)) return null
  const names = new Set()
  for (const tool of schemas) {
    if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) return null
    names.add(tool.name)
  }
  return [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

const count = value => Number.isSafeInteger(value) && value >= 0
const knownPrompt = value => typeof value === 'string'

/**
 * Estimate the admitted dialogue and sorted schema suffix specified by the preview API.
 * The first system message belongs to the request prefix. Older in-history updates are
 * dialogue until a replacement clears them. Missing inputs affect only dependent fields.
 */
export function comparePresetRequests(before, after, {
  inHistory, history, estimateTools, estimatePrompt, compactFirstAboveTokens,
} = {}) {
  const oldTools = ordered(before?.tools), newTools = ordered(after?.tools)
  let tools = null, prefix = 0, toolChange = null
  if (oldTools && newTools) {
    const oldNames = new Set(oldTools.map(tool => tool.name)), newNames = new Set(newTools.map(tool => tool.name))
    tools = {
      added: [...newNames].filter(name => !oldNames.has(name)),
      removed: [...oldNames].filter(name => !newNames.has(name)),
    }
    // Match the Host's header equality, including the order of properties serialized on the wire.
    while (prefix < oldTools.length && prefix < newTools.length &&
      JSON.stringify(oldTools[prefix]) === JSON.stringify(newTools[prefix])) prefix++
    toolChange = prefix < oldTools.length || prefix < newTools.length
  }
  const textChange = knownPrompt(before?.prompt) && knownPrompt(after?.prompt)
    ? before.prompt !== after.prompt || before.agentSection !== after.agentSection : null
  let systemPrompt = null
  if (textChange === false) systemPrompt = 'unchanged'
  if (textChange) {
    if (!after.prompt && !after.agentSection) systemPrompt = 'replaced'
    else if (typeof inHistory === 'boolean') systemPrompt = inHistory ? 'appended' : 'replaced'
  }
  const changes = toolChange || textChange ? true : toolChange === false && textChange === false ? false : null

  let uncachedTokens = null
  const replaced = systemPrompt === 'replaced'
  const dialogue = replaced ? history?.withoutSystems : history?.dialogue
  if (count(dialogue) && systemPrompt && newTools && (replaced || oldTools)) {
    try {
      const schemaTokens = estimateTools(replaced ? newTools : newTools.slice(prefix))
      // Host pricing uses total text length. Joining the validated Agent contribution here
      // has the same length as inserting it at the provider's registered section order.
      const promptTokens = systemPrompt === 'unchanged' ? 0 : estimatePrompt([after.prompt, after.agentSection].filter(Boolean).join('\n\n'))
      const sum = dialogue + schemaTokens + promptTokens
      if (count(schemaTokens) && count(promptTokens) && count(sum)) uncachedTokens = sum
    } catch { /* The Host may lack the estimator while its plugin is reloading. */ }
  }
  return {
    tools, systemPrompt, changes, uncachedTokens,
    compactSuggested: uncachedTokens === null || !count(compactFirstAboveTokens) ? null : uncachedTokens >= compactFirstAboveTokens,
  }
}

/** Produce the route value without publishing an Agent, advancing a Session or preparing a model call. */
export async function previewPresetSwitch(ctx, agent, {
  from, to, sessionId = agent?.id, compactFirstAboveTokens = 65536, signal = new AbortController().signal,
}) {
  const { readPreviewRequests, countRunningSubagents } = await import('./preset-switch-preview-runtime.js')
  const [read, children] = await Promise.allSettled([
    agent ? readPreviewRequests(ctx, agent, { from, to, signal }) : {},
    countRunningSubagents(ctx, sessionId, signal),
  ])
  const state = read.status === 'fulfilled' ? read.value : {}
  return {
    from, to, ...comparePresetRequests(state.before, state.after, { ...state, compactFirstAboveTokens }),
    runningSubagents: children.status === 'fulfilled' ? children.value : null,
  }
}

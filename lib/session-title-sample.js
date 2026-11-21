/**
 * Pure transcript sampling and prompt framing for the head+tail title provider.
 * No dsh imports, so the selection rules are unit-testable under plain Node.
 * 会话标题这一行用（lib/session-title-provider.js），从独立插件 dsh-session-title-headtail 的 lib/sample.js 搬来。
 */

/**
 * Concatenate the text blocks of one message content array.
 * @param {unknown} blocks - `content` array from a `user/message` or assistant message.
 * @returns {string} trimmed text, empty when the message carries no text block.
 */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Whether a session event is a human-typed message with text.
 * @param {{ type: string, data?: any }} event - one session log event.
 * @returns {boolean} true for `user/message` events whose source is the human user.
 */
export function isHumanMessage(event) {
  return event.type === 'user/message' && event.data?.source?.kind === 'user' && textOf(event.data.content) !== ''
}

/**
 * Human and assistant text turns of a session log, in log order. Reasoning,
 * tool calls, tool results, and system-injected messages are left out.
 * @param {readonly { type: string, seq: number, data?: any }[]} events - session log snapshot.
 * @returns {{ role: 'user' | 'assistant', seq: number, text: string }[]} conversation items.
 */
export function conversationOf(events) {
  const items = []
  for (const event of events) {
    if (isHumanMessage(event)) items.push({ role: 'user', seq: event.seq, text: textOf(event.data.content) })
    else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') items.push({ role: 'assistant', seq: event.seq, text })
    }
  }
  return items
}

/**
 * Cut text to a code-point budget, marking the cut with an ellipsis.
 * @param {string} text - source text.
 * @param {number} max - maximum code points kept, including the ellipsis.
 * @returns {string} the text unchanged when it fits, otherwise its prefix plus `…`.
 */
export function clip(text, max) {
  const points = Array.from(text)
  return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join('')}…`
}

const lengthOf = (text) => Array.from(text).length

/**
 * Pick the opening human message plus the newest conversation items within
 * a character budget. Over budget, the oldest tail items go first, so the
 * opening request and the newest item always survive.
 * @param {readonly { role: string, seq: number, text: string }[]} items - output of {@link conversationOf}.
 * @param {{ seq: number, text: string }} first - the first eligible human message from the title service.
 * @param {{ tailMessages: number, headMaxChars: number, messageMaxChars: number, maxInputChars: number }} limits - sampling limits.
 * @param {boolean} [withContext=true] - false keeps only the opening message (automatic first-prompt titles).
 * @returns {{ head: { seq: number, text: string }, tail: { role: string, seq: number, text: string }[], omitted: number }} the sample.
 */
export function selectSample(items, first, limits, withContext = true) {
  const head = { seq: first.seq, text: clip(first.text, limits.headMaxChars) }
  if (!withContext) return { head, tail: [], omitted: 0 }
  const later = items.filter((item) => item.seq > first.seq)
  const tail = later.slice(-limits.tailMessages).map((item) => ({ role: item.role, seq: item.seq, text: clip(item.text, limits.messageMaxChars) }))
  let omitted = later.length - tail.length
  const size = () => lengthOf(head.text) + tail.reduce((total, item) => total + lengthOf(item.text), 0)
  while (tail.length > 1 && size() > limits.maxInputChars) {
    tail.shift()
    omitted += 1
  }
  if (tail.length === 1 && size() > limits.maxInputChars) {
    tail[0] = { ...tail[0], text: clip(tail[0].text, Math.max(200, limits.maxInputChars - lengthOf(head.text))) }
  }
  return { head, tail, omitted }
}

/**
 * Human message seqs represented in a sample, ascending, restricted to the
 * seqs the title service offered for this revision.
 * @param {{ head: { seq: number }, tail: { role: string, seq: number }[] }} sample - output of {@link selectSample}.
 * @param {readonly { seq: number }[]} offered - `request.messages` from the title service.
 * @returns {number[]} source seqs for the provider result and the request log.
 */
export function humanSeqsOf(sample, offered) {
  const allowed = new Set(offered.map((message) => message.seq))
  const seqs = [sample.head.seq, ...sample.tail.filter((item) => item.role === 'user').map((item) => item.seq)]
  return [...new Set(seqs)].filter((seq) => allowed.has(seq)).sort((left, right) => left - right)
}

/**
 * System instruction for the auxiliary title request.
 * @param {{ targetWords: number, targetCjkCharacters: number }} limits - title length targets.
 * @param {boolean} [withContext=true] - whether the request carries recent conversation besides the opening message.
 * @returns {string} the system prompt.
 */
export function systemPrompt(limits, withContext = true) {
  return [
    'Create a concise title for an AI coding-assistant session.',
    ...(withContext
      ? ["Weigh the human's opening request together with what the conversation is about now: if the work has moved to a different main task, name the current one; otherwise keep to the original task."]
      : []),
    'Return only the title on one line, in plain natural-language text, with no quotes, prefix, explanation, Markdown, XML, code, or terminal control codes.',
    "Use the main language of the human's messages.",
    `Aim for about ${limits.targetWords} words in non-CJK languages or ${limits.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/**
 * Frame a sample as JSON so conversation text cannot break the prompt structure.
 * @param {{ head: { text: string }, tail: { role: string, text: string }[], omitted: number }} sample - output of {@link selectSample}.
 * @returns {string} the user-turn text of the auxiliary request.
 */
export function frameSample(sample) {
  if (sample.tail.length === 0) {
    return `Generate the session title from this JSON object. "first_request" is the human's opening message.\n${JSON.stringify({ first_request: sample.head.text })}`
  }
  const gap = sample.omitted > 0 ? `; ${sample.omitted} earlier messages between them are omitted` : ''
  const payload = {
    first_request: sample.head.text,
    recent_conversation: sample.tail.map(({ role, text }) => ({ role, text })),
  }
  return `Generate the session title from this JSON object. "first_request" is the human's opening message and "recent_conversation" is the latest part of the conversation in order${gap}.\n${JSON.stringify(payload)}`
}

/**
 * Reasoning effort for the title call: the first preferred effort the model
 * declares, so a thinking model answers with the title instead of spending
 * the output budget on reasoning.
 * @param {{ reasoning?: { efforts: readonly { id: string }[] } }} info - exact model info from `llm.resolveModelInfo`.
 * @param {readonly string[]} preferred - effort ids in order of preference.
 * @returns {string | undefined} the effort to request; undefined for a model without reasoning controls or without any preferred effort.
 */
export function titleEffortOf(info, preferred) {
  const declared = new Set((info.reasoning?.efforts ?? []).map((effort) => effort.id))
  return preferred.find((id) => declared.has(id))
}

/**
 * Human prompts logged after the latest accepted title's newest source message.
 * @param {readonly { type: string, seq: number, data?: any }[]} events - session log snapshot.
 * @param {readonly number[]} titleSeqs - `messageSeqs` of the latest `session/title` event.
 * @returns {number} count of later human messages.
 */
export function promptsSince(events, titleSeqs) {
  const since = titleSeqs.length === 0 ? -1 : Math.max(...titleSeqs)
  let count = 0
  for (const event of events) if (event.seq > since && isHumanMessage(event)) count += 1
  return count
}

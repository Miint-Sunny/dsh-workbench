/**
 * 压缩提示词的替换。官方摘要请求的最后一条是固定说明，这里只换这一条，其余请求内容不动，缓存前缀不受影响。
 * 只认官方说明的开头：自定义提示词的预设对不上，官方改措辞时也对不上，都原样放行。
 * 全文和对比在 docs/research/2026-11-09-feat94-压缩现状和账本.md 第 9 节。
 */

/** 官方 dsh-compaction-basic 说明的开头。App 更新后要重新核对这段开头是否还和官方一致。 */
export const OFFICIAL_HEAD = 'You are now acting as a compaction engine'

const SEVEN_ZH = `请把上面的对话整理成一份交接摘要。接手的模型只看这份摘要和它后面的最后一条回复，要能接着做，不用再问用户，也不再走一遍走过的弯路。这条说明不是用户说的，不要写进摘要。

严格按下面的结构输出，每一节都保留，顺序不变。某一节没有内容就写「（无）」。

## 任务目标
- 用户最初要什么，后来加的要求、限制和纠正。会影响后面怎么做的话照抄原话，特别是「不要」「必须」「只能」这类。顺口问的、用户说了不用管的不写。

## 完整计划或审计
- 有计划或压缩前的审计时，用最新的版本逐条抄全，每条的编号、内容、验收标准都留着，不概括，不合并，并标明状态（已完成、进行中、未开始）。
- 计划和审计都有就都写。计划写在文件里时，写出路径和每条的状态。

## 上一步
- 最后一条用户消息的原话。
- 这之后做了什么，工具输出里要紧的结果照抄：命令、数字、报错原文、失败的用例名。

## 改过的文件
- 只列真正新建、修改或删除过的文件：路径，改了什么，为什么改。只读过的文件不列。

## 关键决策
- 决定了什么，为什么这样决定。被否掉的方案和否掉的原因也写。

## 踩过的坑
- 现象、原因、解决办法或绕开的办法。用户提醒过不要做的事也算。没解决的写明没解决。

## 下一步
- 接下来要做的事，按顺序写，用户说过的先后顺序照写。
- 最后一条用户消息里的限制优先：用户说了先别做、先等等的，第一条就写等用户确认。

规则：
- 用对话本身的语言写，说话人写成「用户」，不写「你」「我」。路径、命令、报错原文、标识符、数字一字不改。
- 除了计划、审计和原话，都用简短的条目，不写成大段文字。
- 其余内容不保留：工具输出的全文、只读过的文件内容、和任务无关的闲聊、技术概念解释。
- 不提这次整理，也不提上下文被压缩。
- 只输出摘要正文，不调用工具，不做别的事。
- 如果对话里已经有 <compacted-summary> 块，那是之前的摘要：不要原样照抄，保留仍然成立的，删掉过时的，把新内容合并进同一份结构。计划和审计的条目不能因为合并而丢掉。`

const SEVEN_EN = `Turn the conversation above into a handoff summary. The model taking over sees only this summary and the last reply after it. It must be able to continue without asking the user again and without repeating dead ends. These instructions did not come from the user; do not put them in the summary.

Use exactly this structure. Keep every section, in this order. Write "(none)" for an empty section.

## Goal
- What the user asked for at first, and the requirements, limits and corrections added later. Quote wording verbatim when it affects later work, especially "do not", "must" and "only". Leave out passing questions and things the user said to ignore.

## Full plan or audit
- If there is a plan or a pre-compaction audit, copy the latest version item by item: number, content and acceptance criteria. Do not summarize or merge. Mark each item's status (done, in progress, not started).
- Include both if both exist. If the plan lives in a file, give its path and each item's status.

## Last step
- The last user message, verbatim.
- What was done after it. Copy the results that matter from tool output: commands, numbers, exact errors, names of failing tests.

## Changed files
- Only files actually created, modified or deleted: path, what changed, why. Do not list files that were only read.

## Key decisions
- What was decided and why. Include rejected options and why they were rejected.

## Pitfalls
- Symptom, cause, fix or workaround. Things the user warned against count. Say so when something is unresolved.

## Next steps
- What to do next, in order. Keep any order the user stated.
- Limits in the last user message come first: if the user said to hold off or wait, the first item is to wait for the user to confirm.

Rules:
- Write in the language of the conversation. Refer to the speaker as "the user", not "you" or "I". Keep paths, commands, exact errors, identifiers and numbers unchanged.
- Apart from the plan, the audit and verbatim quotes, use short bullets, not long paragraphs.
- Keep nothing else: full tool output, contents of files that were only read, small talk unrelated to the task, explanations of technical concepts.
- Do not mention this summarization or that context was compacted.
- Output only the summary. Do not call tools or do anything else.
- If the conversation already contains a <compacted-summary> block, that is an earlier summary: do not copy it verbatim. Keep what still holds, drop what is stale, and merge new material into the same structure. Plan and audit items must not be lost in the merge.`

/** 「保留七项」的全文，按语言。 */
export const SEVEN_ITEMS = Object.freeze({ zh: SEVEN_ZH, en: SEVEN_EN })

const EXTRA_LABEL = Object.freeze({ zh: '这次压缩的补充要求：', en: 'Additional instructions for this summary: ' })

/**
 * 算出替换后的消息列表。
 * @param {{purpose?: string, messages: object[]}} options llm/stream 的请求。
 * @param {{selection: string, custom: string, locale?: string, extra?: string}} choice 选哪档、自定义文字、语言和这次的补充要求。
 * @returns {object[]|undefined} 新的消息列表，只有最后一条变了；不用换时是 undefined。
 */
export function swapInstruction(options, { selection, custom, locale, extra }) {
  if (options.purpose !== 'compaction') return undefined
  const last = options.messages?.at(-1)
  const text = last?.role === 'user' ? last.content?.[0]?.text : undefined
  if (typeof text !== 'string' || !text.startsWith(OFFICIAL_HEAD)) return undefined
  const language = Object.hasOwn(SEVEN_ITEMS, locale ?? '') ? locale : 'zh'
  const addition = extra?.trim() ?? ''
  let base
  if (selection === 'seven') base = SEVEN_ITEMS[language]
  else if (selection === 'custom') base = custom.trim()
  else if (addition !== '') base = text
  if (!base) return undefined
  const replaced = addition === '' ? base : `${base}\n\n${EXTRA_LABEL[language]}${addition}`
  return [...options.messages.slice(0, -1), Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: replaced })]) })]
}

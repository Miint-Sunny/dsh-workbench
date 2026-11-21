/** 改动审阅给用户和模型看的文字。用词照仓库 DESIGN.md 的对照表：回退这一处、回退整个文件、撤销、评论、改动；句式照样稿。 */

/**
 * 行区间的写法：一行是「第 42 行」，多行是「第 3–7 行」（样稿用的长破折号）。
 * @param {{ start: number, end: number }} range 1 起、含两端的行区间。
 * @returns {string} 行区间的文字。
 */
export function rangeText(range) {
  return range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}–${range.end} 行`
}

/**
 * 一个改动处占的行区间，用来指给用户看。优先用这一轮结束时的行号（审阅页上右栏的行号）；结束时这里是空的（整段被删），用这一轮开始前的行号。
 * @param {{ oldStart: number, oldLines: number, newStart: number, newLines: number }} hunk 改动处。
 * @returns {{ start: number, end: number }} 1 起、含两端的行区间。
 */
export function hunkRange(hunk) {
  if (hunk.newLines > 0) return { start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 }
  return { start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 }
}

/**
 * 回退记录和转告里指代一处回退的说法：整文件是「整个文件」，一处是「第 3–7 行这一处」。
 * @param {{ oldStart: number, oldLines: number, newStart: number, newLines: number } | null} hunk 改动处；null 表示整个文件。
 * @returns {string} 指代这处回退的文字。
 */
export function describeRevert(hunk) {
  if (hunk === null) return '整个文件'
  return `${rangeText(hunkRange(hunk))}这一处`
}

/**
 * 不能回退的原因，直接显示在那一处下面（样稿 B/C）。
 * @param {string} display 文件的显示路径。
 * @param {boolean} whole 是否回退整个文件。
 * @param {{ start: number, end: number } | undefined} range 对不上的行区间；整文件不给。
 * @param {boolean} absentNow 文件现在已经不在了（这一轮结束时还在）。
 * @returns {string} 原因的文字。
 */
export function revertConflictMessage(display, whole, range, absentNow) {
  const scope = whole ? '整个文件' : '这一处'
  if (absentNow) return `无法回退${scope}：${display} 已不存在，与本轮结束时不一致。`
  if (range === undefined) return `无法回退${scope}：本轮之后 ${display} 已被修改，与本轮结束时不一致。`
  return `无法回退${scope}：本轮之后 ${display} 的${rangeText(range)}已被修改，与本轮结束时不一致。`
}

/** 会话运行中的原因（样稿 D 的横幅）。@param {'revert' | 'undo'} action 要做的动作。 */
export function runningMessage(action) {
  return action === 'undo' ? '会话进行中，结束后才能撤销。' : '会话进行中，结束后才能回退。'
}

/** @param {{display: string, messagePath?: string, line: number, side?: string, detached?: boolean, snippet: string, text: string}[]} comments 要发送的评论。 */
export function reviewCommentEntries(comments) {
  const sorted = [...comments].sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : a.line - b.line))
  return sorted.map((comment, at) => [
    `${at + 1}. ${comment.messagePath ?? comment.display} ${comment.side === 'old' ? '旧文件' : ''}第 ${comment.line} 行${comment.detached ? '（变更前的位置）' : ''}`,
    `   > ${comment.snippet}`,
    ...comment.text.split('\n').map(line => `   ${line}`),
  ].join('\n')).join('\n\n')
}

/**
 * 把攒下的评论和回退清单拼成一条用户消息（样稿 E）。评论按文件和行号排好，带上那几行原文；回退过的地方列在最后，模型就知道文件已经变了。之前报给模型、后来又撤销了的回退也写一句，模型才知道文件又变回来了。
 * @param {object} input 消息的素材。
 * @param {number} input.turn 轮次号，用在开头。
 * @param {{ display: string, line: number, side?: string, snippet: string, text: string }[]} input.comments 评论：显示路径、行号、差异一侧、那行的原文、评论内容。
 * @param {{ display: string, description: string }[]} input.reverts 回退过的处：显示路径和指代说法（describeRevert 的结果）。
 * @param {{ display: string, description: string }[]} [input.undoneReverts] 之前报给模型、后来又撤销了的回退。
 * @returns {string | undefined} 消息全文；评论、回退和撤销的回退都为空时是 undefined，调用方不该发。
 */
export function composeReviewMessage({ turn, comments = [], reverts = [], undoneReverts = [] }) {
  const revertSentences = reverts.length === 0 ? []
    : reverts.length === 1
      ? [`我已经回退了 ${reverts[0].display} ${reverts[0].description}。`]
      : ['我已经回退了以下改动：', ...reverts.map((r, i) => `${i + 1}. ${r.display} ${r.description}`)]
  const undoSentences = undoneReverts.length === 0 ? []
    : undoneReverts.length === 1
      ? [`我撤销了对 ${undoneReverts[0].display} ${undoneReverts[0].description}的回退。`]
      : ['我撤销了对以下改动的回退，文件已经变回这一轮结束时的样子：', ...undoneReverts.map((r, i) => `${i + 1}. ${r.display} ${r.description}`)]
  // 回退清单和撤销说明各成一段，段间空一行；没有评论时直接从这两段里拼。
  const sections = [revertSentences, undoSentences].filter(section => section.length > 0)
  const tail = sections.flatMap((section, at) => (at === 0 ? section : ['', ...section]))
  if (comments.length === 0) {
    return tail.length === 0 ? undefined : tail.join('\n')
  }
  return [
    `请按下面的评论修改第 ${turn} 轮的改动：`,
    '',
    reviewCommentEntries(comments),
    ...(tail.length === 0 ? [] : ['', ...tail]),
  ].join('\n')
}

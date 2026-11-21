/** 行归一：和 DSH「第 N 轮改动」的行比较（workspace-changes 的 compare）同一套规则。回退前的核对和回退后的写回都按它来，两侧才对得上。 */

/**
 * 文本按行拆开。和 DSH 的比较一样：最后一行没有换行也当成有；空文本是 0 行，不是一个空行。
 * @param {string} text 文件的完整内容。
 * @returns {string[]} 行数组，行内不含换行符。
 */
export function textToLines(text) {
  const terminated = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return terminated === '' ? [] : terminated.slice(0, -1).split('\n')
}

/**
 * 行数组拼回文件内容：最后一行总带换行，和比较侧的归一对齐。回退写回的文件以此为准，原文件末行缺换行时会补上。
 * @param {string[]} lines 行数组。
 * @returns {string} 文件内容；0 行是空字符串。
 */
export function linesToText(lines) {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

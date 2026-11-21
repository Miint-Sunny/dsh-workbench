/** 反向应用引擎：把 DSH workspace-changes 给出的改动处（hunk）从文件现在的行上倒着抹掉，恢复成这一轮开始前的样子；撤销「回退这一处」时按同一套办法正向应用回去。内容对不上就拒绝，不做模糊合并；行内容完全一致、只是位置挪了（这一轮之后上面加过行）的，按挪到的位置应用。 */

/** 统一差异格式的行首：加号是加的行，减号是删的行，其余（空格）是上下文。 */
const ADDED_LINE = /^\+/
const REMOVED_LINE = /^-/

/**
 * 取一个改动处的两侧：前缀 `-` 和空格是这一轮开始前的行，前缀 `+` 和空格是这一轮结束时的行。
 * @param {{ lines: string[] }} hunk 统一差异的改动处，每行带前缀。
 * @returns {{ oldSide: string[], newSide: string[] }} 两侧的行，按出现顺序。
 */
export function hunkSides(hunk) {
  const oldSide = []
  const newSide = []
  for (const line of hunk.lines) {
    const text = line.slice(1)
    if (REMOVED_LINE.test(line)) oldSide.push(text)
    else if (ADDED_LINE.test(line)) newSide.push(text)
    else {
      oldSide.push(text)
      newSide.push(text)
    }
  }
  return { oldSide, newSide }
}

/**
 * 在行数组里找一侧的行出现的位置：先看记录的位置（`hint`，0 起），再按偏移一上一下往外找，内容要逐行完全一致。
 * @param {string[]} current 当前的行。
 * @param {string[]} side 要找的行。
 * @param {number} hint 记录的位置（0 起）。
 * @returns {number | undefined} 找到的 0 起位置；找不到就是 undefined。
 */
function locateSide(current, side, hint) {
  const farthest = Math.max(hint, current.length - side.length - hint)
  for (let offset = 0; offset <= farthest; offset++) {
    for (const at of offset === 0 ? [hint] : [hint + offset, hint - offset]) {
      if (at < 0 || at + side.length > current.length) continue
      let matches = true
      for (let i = 0; i < side.length; i++) {
        if (current[at + i] !== side[i]) {
          matches = false
          break
        }
      }
      if (matches) return at
    }
  }
  return undefined
}

/**
 * 就地把一个改动处反向应用到行数组上：把「这一轮结束时的行」换回「这一轮开始前的行」。
 * @param {string[]} lines 会就地修改的行数组。
 * @param {{ newStart: number, lines: string[] }} hunk 改动处。
 * @returns {number | undefined} 应用位置的 0 起行号；undefined 表示现在的行和这一轮结束时对不上。
 */
function applyReversed(lines, hunk) {
  const { oldSide, newSide } = hunkSides(hunk)
  if (newSide.length === 0) {
    // 这一轮结束时这里是空的（整个文件被删掉或清空）：现在也得是空的，才能把旧行补回来。
    if (lines.length !== 0) return undefined
    lines.splice(0, 0, ...oldSide)
    return 0
  }
  const at = locateSide(lines, newSide, hunk.newStart - 1)
  if (at === undefined) return undefined
  lines.splice(at, newSide.length, ...oldSide)
  return at
}

/**
 * 就地把一个改动处正向应用到行数组上：把「这一轮开始前的行」换回「这一轮结束时的行」。撤销「回退这一处」用它。
 * @param {string[]} lines 会就地修改的行数组。
 * @param {{ oldStart: number, lines: string[] }} hunk 改动处。
 * @param {number} hint 回退时应用到的位置（0 起），没有就用改动处记的开始前行号。
 * @returns {boolean} 应用成功；false 表示回退时写回去的行现在找不到了。
 */
function applyForward(lines, hunk, hint) {
  const { oldSide, newSide } = hunkSides(hunk)
  if (oldSide.length === 0) {
    // 回退时把这一轮加的行删掉了（本轮新建的文件上的一处）：现在也得是空的，才能把加过的行放回去。
    if (lines.length !== 0) return false
    lines.splice(0, 0, ...newSide)
    return true
  }
  const at = locateSide(lines, oldSide, hint)
  if (at === undefined) return false
  lines.splice(at, oldSide.length, ...newSide)
  return true
}

/**
 * 反向应用一个改动处，得到新的行数组。回退「这一处」用它。
 * @param {string[]} currentLines 文件现在的行。
 * @param {{ newStart: number, lines: string[] }} hunk 改动处。
 * @returns {{ ok: true, lines: string[], at: number } | { ok: false, mismatch: true }} 成功时的行数组和应用位置（0 起，存进回退记录，撤销时当定位线索）；对不上时 mismatch。
 */
export function reverseHunk(currentLines, hunk) {
  const lines = [...currentLines]
  const at = applyReversed(lines, hunk)
  return at === undefined ? { ok: false, mismatch: true } : { ok: true, lines, at }
}

/**
 * 正向应用一个改动处，撤销「回退这一处」用它：把回退时写回去的行换回这一轮结束时的行。
 * @param {string[]} currentLines 文件现在的行。
 * @param {{ oldStart: number, lines: string[] }} hunk 改动处。
 * @param {number} [hint] 回退时应用到的位置（0 起）；缺省用改动处记的开始前行号。
 * @returns {{ ok: true, lines: string[] } | { ok: false, mismatch: true }} 成功时的行数组；回退时写回去的行找不到时 mismatch。
 */
export function forwardHunk(currentLines, hunk, hint = hunk.oldStart - 1) {
  const lines = [...currentLines]
  return applyForward(lines, hunk, hint) ? { ok: true, lines } : { ok: false, mismatch: true }
}

/**
 * 反向应用全部改动处，回退「整个文件」时用。从最后一个往前应用，前面改动处的行号不受影响；任何一处对不上就整体失败。
 * @param {string[]} currentLines 文件现在的行。
 * @param {{ newStart: number, lines: string[] }[]} hunks 按文件顺序的改动处。
 * @returns {{ ok: true, lines: string[] } | { ok: false, mismatch: true }} 成功时的行数组；对不上时 mismatch。
 */
export function reverseHunks(currentLines, hunks) {
  const lines = [...currentLines]
  for (let i = hunks.length - 1; i >= 0; i--) {
    if (applyReversed(lines, hunks[i]) === undefined) return { ok: false, mismatch: true }
  }
  return { ok: true, lines }
}

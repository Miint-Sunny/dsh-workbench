/** 反向应用引擎的测试：正常、位置有偏移、冲突、新建的文件、删除的文件、整文件替换的粗对比；撤销「回退这一处」用的正向应用和它对称。改动处（hunk）都是手写的固定样本，和 DSH workspace-changes 生成的统一差异同一格式。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forwardHunk, hunkSides, reverseHunk, reverseHunks } from '../lib/review/revert.js'
import { textToLines } from '../lib/review/lines.js'

/** 改这一处：第 2 行 `l2` 换成 `L2`，带一行上下文。 */
const EDIT_HUNK = {
  oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
  lines: [' l1', '-l2', '+L2', ' l3'],
}

test('hunk 的两侧：`-` 和空格归这一轮开始前，`+` 和空格归这一轮结束时', () => {
  assert.deepEqual(hunkSides(EDIT_HUNK), { oldSide: ['l1', 'l2', 'l3'], newSide: ['l1', 'L2', 'l3'] })
})

test('反向应用（正常）：把这一轮改的行换回这一轮开始前的行，带上应用到的位置', () => {
  assert.deepEqual(reverseHunk(['l1', 'L2', 'l3'], EDIT_HUNK), { ok: true, lines: ['l1', 'l2', 'l3'], at: 0 })
})

test('反向应用（位置有偏移）：这一轮之后上面加过行，行内容对得上就按挪到的位置应用', () => {
  assert.deepEqual(reverseHunk(['added', 'l1', 'L2', 'l3'], EDIT_HUNK), { ok: true, lines: ['added', 'l1', 'l2', 'l3'], at: 1 })
  assert.deepEqual(reverseHunk(['l0', 'l1', 'L2', 'l3'], EDIT_HUNK), { ok: true, lines: ['l0', 'l1', 'l2', 'l3'], at: 1 })
})

test('位置有偏移时两边都有一样的行：取离记录位置最近的', () => {
  // 记录位置是第 3 行（0 起 2，那里是 rA）；[X,Y] 在第 5 行和第 8 行各出现一次，先找到第 5 行（偏移 +2）。
  const hunk = { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: ['-a', '-b', '+X', '+Y'] }
  const current = textToLines('p\nq\nrA\nX\nY\ns\nX\nY\n')
  assert.deepEqual(reverseHunk(current, hunk), { ok: true, lines: ['p', 'q', 'rA', 'a', 'b', 's', 'X', 'Y'], at: 3 })
  // 距离一样时先往下找：记录位置（0 起 2）上下各一处 [X,Y]，用的是下面那处（0 起 3）。
  const tie = textToLines('a\nX\nY\nX\nY\nb\n')
  assert.deepEqual(reverseHunk(tie, hunk), { ok: true, lines: ['a', 'X', 'Y', 'a', 'b', 'b'], at: 3 })
})

test('反向应用（冲突）：那几行和这一轮结束时不一样就拒绝，不猜着合并', () => {
  assert.deepEqual(reverseHunk(['l1', 'CHANGED', 'l3'], EDIT_HUNK), { ok: false, mismatch: true })
})

test('反向应用（新建的文件）：全是 `+` 行，回退就是把这几行删掉', () => {
  const hunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }
  assert.deepEqual(reverseHunk(['a', 'b', 'c'], hunk), { ok: true, lines: [], at: 0 })
  // 这一轮之后又在后面加过行：改的这一处对得上，退这一处只退自己。
  assert.deepEqual(reverseHunk(['a', 'b', 'c', 'd'], hunk), { ok: true, lines: ['d'], at: 0 })
})

test('反向应用（删除的文件）：结束时这里是空的，现在是空的才能补回旧行；现在有内容就拒绝', () => {
  const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] }
  assert.deepEqual(reverseHunk([], hunk), { ok: true, lines: ['x', 'y'], at: 0 })
  assert.deepEqual(reverseHunk(['z'], hunk), { ok: false, mismatch: true })
})

test('反向应用（整文件替换的粗对比）：所有旧行在前、所有新行在后的一个改动处，等于整文件对调', () => {
  const oldLines = ['o1', 'o2']
  const newLines = ['n1', 'n2', 'n3']
  const hunk = {
    oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length,
    lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
  }
  assert.deepEqual(reverseHunk(newLines, hunk), { ok: true, lines: oldLines, at: 0 })
  assert.deepEqual(reverseHunk(['n1', '别的', 'n3'], hunk), { ok: false, mismatch: true })
})

test('回退整个文件：从最后一个改动处往前应用，行号互不干扰，回到这一轮开始前的样子', () => {
  // 这轮把第 2 行 l2 改成 L2、第 7 行 l7 改成 L7。
  const hunks = [
    { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' l1', '-l2', '+L2', ' l3'] },
    { oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: [' l6', '-l7', '+L7', ' l8'] },
  ]
  const after = textToLines('l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n')
  const result = reverseHunks(after, hunks)
  assert.deepEqual(result, { ok: true, lines: textToLines('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n') })
})

test('回退整个文件：任何一处对不上就整体失败，不写半个结果', () => {
  const hunks = [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-l1', '+n1', ' l2'] },
    { oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' l4', '-l5', '+n5'] },
  ]
  const after = textToLines('n1\nl2\nl3\nl4\n改过的\n')
  assert.deepEqual(reverseHunks(after, hunks), { ok: false, mismatch: true })
})

test('回退整个文件：改动处之外后来加的行留着，只退这一轮改的地方', () => {
  const hunks = [EDIT_HUNK]
  const after = textToLines('l1\nL2\nl3\nl4\n后来加的\n')
  const result = reverseHunks(after, hunks)
  assert.deepEqual(result, { ok: true, lines: ['l1', 'l2', 'l3', 'l4', '后来加的'] })
})

test('正向应用（撤销回退这一处）：把回退时写回去的行换回这一轮结束时的行，和反向应用对称', () => {
  assert.deepEqual(forwardHunk(['l1', 'l2', 'l3'], EDIT_HUNK, 0), { ok: true, lines: ['l1', 'L2', 'l3'] })
  // 回退之后上面又加过行：按挪到的位置换回去。
  assert.deepEqual(forwardHunk(['added', 'l1', 'l2', 'l3'], EDIT_HUNK, 1), { ok: true, lines: ['added', 'l1', 'L2', 'l3'] })
  // 不给回退位置时用改动处记的开始前行号。
  assert.deepEqual(forwardHunk(['l1', 'l2', 'l3'], EDIT_HUNK), { ok: true, lines: ['l1', 'L2', 'l3'] })
})

test('正向应用（回退时写回去的行找不到了）：拒绝，不猜', () => {
  assert.deepEqual(forwardHunk(['l1', '改过的', 'l3'], EDIT_HUNK, 0), { ok: false, mismatch: true })
  assert.deepEqual(forwardHunk([], EDIT_HUNK, 0), { ok: false, mismatch: true })
})

test('正向应用（新建的文件上退掉的一段）：现在是空的才能把加过的行放回去；有内容就拒绝', () => {
  const hunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }
  assert.deepEqual(forwardHunk([], hunk, 0), { ok: true, lines: ['a', 'b', 'c'] })
  assert.deepEqual(forwardHunk(['d'], hunk, 0), { ok: false, mismatch: true })
})

test('正向应用（这一轮删掉的文件被回退补了回来）：找到补回的行，换回空', () => {
  const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] }
  assert.deepEqual(forwardHunk(['x', 'y'], hunk, 0), { ok: true, lines: [] })
  assert.deepEqual(forwardHunk(['x', '改过的'], hunk, 0), { ok: false, mismatch: true })
})

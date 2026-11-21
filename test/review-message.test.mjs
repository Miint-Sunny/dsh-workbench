/** 评论消息的测试：拼出来的用户消息和样稿 E 一字不差；回退的说法、不能回退的原因这些显示文字的格式。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeReviewMessage, describeRevert, hunkRange, rangeText, revertConflictMessage, runningMessage } from '../lib/review/copy.js'

test('评论消息的格式：照样稿 E，评论按文件和行号排好，带上那几行原文，最后列回退过的地方', () => {
  const message = composeReviewMessage({
    turn: 3,
    comments: [
      { display: 'src/styles/form.css', line: 21, snippet: '.field-error { color: var(--danger); font-size: 12px; }', text: '颜色用设计稿里的 #D93025，不要用变量。' },
      { display: 'src/pages/Login.tsx', line: 42, snippet: '{email.error && <p className="field-error">{email.error}</p>}', text: '错误提示加 role="alert"，读屏软件才能读到。' },
    ],
    reverts: [{ display: 'src/pages/Login.test.tsx', description: '第 3–7 行这一处' }],
  })
  assert.equal(message, [
    '请按下面的评论修改第 3 轮的改动：',
    '',
    '1. src/pages/Login.tsx 第 42 行',
    '   > {email.error && <p className="field-error">{email.error}</p>}',
    '   错误提示加 role="alert"，读屏软件才能读到。',
    '',
    '2. src/styles/form.css 第 21 行',
    '   > .field-error { color: var(--danger); font-size: 12px; }',
    '   颜色用设计稿里的 #D93025，不要用变量。',
    '',
    '我已经回退了 src/pages/Login.test.tsx 第 3–7 行这一处。',
  ].join('\n'))
})

test('评论消息：多行的评论每行都缩进，保持清单的样子', () => {
  const message = composeReviewMessage({
    turn: 1,
    comments: [{ display: 'a.ts', line: 3, snippet: 'x', text: '第一行\n第二行' }],
    reverts: [],
  })
  assert.equal(message, [
    '请按下面的评论修改第 1 轮的改动：',
    '',
    '1. a.ts 第 3 行',
    '   > x',
    '   第一行',
    '   第二行',
  ].join('\n'))
})

test('评论消息：只有回退没有评论时，只说回退；多处回退列成清单', () => {
  assert.equal(
    composeReviewMessage({ turn: 2, comments: [], reverts: [{ display: 'a.ts', description: '第 3–7 行这一处' }] }),
    '我已经回退了 a.ts 第 3–7 行这一处。',
  )
  assert.equal(
    composeReviewMessage({ turn: 2, comments: [], reverts: [
      { display: 'a.ts', description: '第 3–7 行这一处' },
      { display: 'b/new.ts', description: '整个文件' },
    ] }),
    ['我已经回退了以下改动：', '1. a.ts 第 3–7 行这一处', '2. b/new.ts 整个文件'].join('\n'),
  )
})

test('评论消息：评论和回退都为空时是 undefined，调用方不该发', () => {
  assert.equal(composeReviewMessage({ turn: 1, comments: [], reverts: [] }), undefined)
})

test('行区间的写法：一行一行号，多行用长破折号', () => {
  assert.equal(rangeText({ start: 42, end: 42 }), '第 42 行')
  assert.equal(rangeText({ start: 3, end: 7 }), '第 3–7 行')
})

test('一处回退的说法：优先用这一轮结束时的行号；结束时这里是空的用开始前的行号；整个文件就是整个文件', () => {
  assert.deepEqual(hunkRange({ oldStart: 12, oldLines: 6, newStart: 12, newLines: 6 }), { start: 12, end: 17 })
  assert.deepEqual(hunkRange({ oldStart: 3, oldLines: 5, newStart: 1, newLines: 0 }), { start: 3, end: 7 })
  assert.equal(describeRevert({ oldStart: 12, oldLines: 6, newStart: 12, newLines: 6 }), '第 12–17 行这一处')
  assert.equal(describeRevert({ oldStart: 42, oldLines: 3, newStart: 42, newLines: 3 }), '第 42–44 行这一处')
  assert.equal(describeRevert(null), '整个文件')
})

test('不能回退的原因：具体到文件和行，或写明文件已经不在了（样稿 B/C 的说法）', () => {
  assert.equal(
    revertConflictMessage('src/pages/Login.tsx', false, { start: 12, end: 17 }, false),
    '无法回退这一处：本轮之后 src/pages/Login.tsx 的第 12–17 行已被修改，与本轮结束时不一致。',
  )
  assert.equal(
    revertConflictMessage('src/pages/Login.tsx', true, undefined, false),
    '无法回退整个文件：本轮之后 src/pages/Login.tsx 已被修改，与本轮结束时不一致。',
  )
  assert.equal(
    revertConflictMessage('src/pages/Login.tsx', false, undefined, true),
    '无法回退这一处：src/pages/Login.tsx 已不存在，与本轮结束时不一致。',
  )
})

test('会话运行中的原因（样稿 D 横幅的话）', () => {
  assert.equal(runningMessage('revert'), '会话进行中，结束后才能回退。')
  assert.equal(runningMessage('undo'), '会话进行中，结束后才能撤销。')
})

test('评论消息：报过又撤销的回退写在最后，一句一条；只有撤销时也能单独成一条', () => {
  assert.equal(
    composeReviewMessage({ turn: 2, comments: [], reverts: [], undoneReverts: [{ display: 'b.md', description: '整个文件' }] }),
    '我撤销了对 b.md 整个文件的回退。',
  )
  assert.equal(
    composeReviewMessage({ turn: 2, comments: [], undoneReverts: [
      { display: 'b.md', description: '整个文件' },
      { display: 'a.ts', description: '第 3–7 行这一处' },
    ] }),
    ['我撤销了对以下改动的回退，文件已经变回这一轮结束时的样子：', '1. b.md 整个文件', '2. a.ts 第 3–7 行这一处'].join('\n'),
  )
  // 有评论时：回退清单在前，撤销说明在后，段间空一行
  assert.equal(
    composeReviewMessage({
      turn: 2,
      comments: [{ display: 'a.ts', line: 1, snippet: 'l1', text: '改这里' }],
      reverts: [{ display: 'b.md', description: '整个文件' }],
      undoneReverts: [{ display: 'c.ts', description: '第 2 行这一处' }],
    }),
    ['请按下面的评论修改第 2 轮的改动：', '', '1. a.ts 第 1 行', '   > l1', '   改这里', '', '我已经回退了 b.md 整个文件。', '', '我撤销了对 c.ts 第 2 行这一处的回退。'].join('\n'),
  )
})

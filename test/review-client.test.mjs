/** 改动审阅的客户端帮手（审阅面板的轮次范围用）：地址解析、改动处显示行、已查看存取、攒评论、回退清单去重、添加到输入框。页面行为在 review-panel-client.test.mjs。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addRoundComment, clearSentRoundComments, hunkRows, insertIntoDraft, loadSeen, navigatedFileIndex,
  parseReviewAddress, removeRoundComment, revertCoordKey, revertNews,
  roundComments, saveSeen, sentRevertsOf,
} from '../src/client/review.js'

test('地址解析：官方拼法的坐标读得回来，别的地址不认', () => {
  assert.deepEqual(
    parseReviewAddress('dsh-resource://changes-review/session/abc-123/42/3'),
    { sessionId: 'abc-123', seq: 42, turn: 3 },
  )
  assert.deepEqual(
    parseReviewAddress('dsh-resource://changes-review/session/a%2Fb/7/12'),
    { sessionId: 'a/b', seq: 7, turn: 12 },
  )
  for (const bad of [
    'dsh-resource://changes-review/session/abc/42',           // 少一段
    'dsh-resource://changes-review/session/abc/x/3',          // 序号不是数字
    'dsh-resource://changes-review/session/abc/42/0',         // 轮次从 1 起
    'dsh-resource://changes-review/session//42/3',            // 会话空
    'dsh-resource://file/session/abc/42/3',                   // 别的资源
    'sidebar://guide',
  ]) {
    assert.equal(parseReviewAddress(bad), undefined, bad)
  }
})

test('改动处的显示行：`-` 带旧行号、`+` 带新行号、上下文两个都带', () => {
  assert.deepEqual(hunkRows({
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
    lines: [' l1', '-l2', '+L2', ' l3'],
  }), [
    { old: 1, cur: 1, mark: ' ', text: 'l1' },
    { old: 2, cur: undefined, mark: '-', text: 'l2' },
    { old: undefined, cur: 2, mark: '+', text: 'L2' },
    { old: 3, cur: 3, mark: ' ', text: 'l3' },
  ])
  // 本轮新建的文件全是 `+` 行：旧行号一栏空着。
  assert.deepEqual(hunkRows({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] })[0],
    { old: undefined, cur: 1, mark: '+', text: 'a' })
})

test('已查看存取：读写一轮一份，坏了的存档当没有看过', () => {
  const entries = new Map()
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) },
  }
  saveSeen('s1/3', new Set([0, 2]), storage)
  assert.deepEqual([...loadSeen('s1/3', storage)].sort(), [0, 2])
  assert.deepEqual([...loadSeen('s1/4', storage)], [])
  entries.set('dsh-workbench-review-seen:s1/5', '{oops')
  assert.deepEqual([...loadSeen('s1/5', storage)], [])
  assert.deepEqual([...loadSeen('s1/6', undefined)], [])
})

test('攒评论：同一条线再添就替换，删得掉，发出后清空；一轮一份', () => {
  const key = 's1/3'
  assert.deepEqual(roundComments(key), [])
  addRoundComment(key, { fileIndex: 0, display: 'a.ts', line: 42, snippet: 'x', text: '第一条' })
  addRoundComment(key, { fileIndex: 1, display: 'b.ts', line: 7, snippet: 'y', text: '另一条' })
  addRoundComment(key, { fileIndex: 0, display: 'a.ts', line: 42, snippet: 'x', text: '改过的第一条' })
  assert.deepEqual(roundComments(key).map(item => item.text), ['改过的第一条', '另一条'])
  assert.deepEqual(roundComments(key).map(item => [item.fileIndex, item.line]), [[0, 42], [1, 7]])
  removeRoundComment(key, 1, 7)
  assert.deepEqual(roundComments(key).map(item => item.line), [42])
  clearSentRoundComments(key, roundComments(key))
  assert.deepEqual(roundComments(key), [])
  assert.deepEqual(roundComments('别的轮'), [])
})

test('评论 id：删过再加也不和留着的重复（模块自增）', () => {
  const key = 'id-test/1'
  addRoundComment(key, { fileIndex: 0, display: 'a.ts', line: 1, snippet: '', text: '一' })
  addRoundComment(key, { fileIndex: 0, display: 'a.ts', line: 2, snippet: '', text: '二' })
  removeRoundComment(key, 0, 1)
  addRoundComment(key, { fileIndex: 0, display: 'a.ts', line: 3, snippet: '', text: '三' })
  const ids = roundComments(key).map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  clearSentRoundComments(key, roundComments(key))
})

test('回退清单去重：报过的不再报；报过又撤销的说一声；撤销后再回退、中间没发过的不重复报', () => {
  const a = { fileIndex: 0, hunkIndex: 1, display: 'a.ts', description: '第 1–3 行这一处' }
  const b = { fileIndex: 0, hunkIndex: null, display: 'b.ts', description: '整个文件' }
  const c = { fileIndex: 2, hunkIndex: 0, display: 'c.ts', description: '第 6–8 行这一处' }
  assert.equal(revertCoordKey(a), '0:1')
  assert.equal(revertCoordKey(b), '0:w')
  // 第一次发送前，全都是新的。
  assert.deepEqual(revertNews([a, b, c], new Map(), true), { pending: [a, b, c], undone: [] })
  // 发送成功：记下当时全部回退。之后什么都没变，就没有要说的。
  let sent = sentRevertsOf([a, b, c])
  assert.deepEqual(revertNews([a, b, c], sent, true), { pending: [], undone: [] })
  // 新回退 d、撤销 b：d 要报，b 要说撤销了。
  const d = { fileIndex: 3, hunkIndex: 0, display: 'd.ts', description: '第 2–4 行这一处' }
  assert.deepEqual(revertNews([a, c, d], sent, true), { pending: [d], undone: [b] })
  // 撤销 b 以后又回退、中间没发过消息：模型知道的就是现在的样子，什么都不报。
  assert.deepEqual(revertNews([a, b, c], sent, true), { pending: [], undone: [] })
  // 报过 b 的撤销以后（已报表按当时的清单覆盖）再回退 b：按新回退报。
  sent = sentRevertsOf([a, c, d])
  assert.deepEqual(revertNews([a, b, c, d], sent, true), { pending: [b], undone: [] })
})

test('回退清单还没读到时什么都不报：页面重新打开先是空清单，读到以后已报的回退不会被当成撤销或新回退', () => {
  const a = { fileIndex: 0, hunkIndex: 0, display: 'a.txt', description: '第 1–5 行这一处' }
  const sent = sentRevertsOf([a])
  // 页面刚打开：清单还是空的、没读到。
  assert.deepEqual(revertNews([], sent, false), { pending: [], undone: [] })
  // 读到了：a 还在，跟已报的一样。
  assert.deepEqual(revertNews([a], sent, true), { pending: [], undone: [] })
  // 读失败一直没读到：照样什么都不报，已报表也没被改。
  assert.deepEqual(revertNews([], sent, false), { pending: [], undone: [] })
  assert.deepEqual([...sent.keys()], ['0:0'])
})

test('跳到哪个文件：navigation.params.index 只认非负整数', () => {
  assert.equal(navigatedFileIndex({ index: 3 }), 3)
  assert.equal(navigatedFileIndex({ index: 0 }), 0)
  assert.equal(navigatedFileIndex({}), undefined)
  assert.equal(navigatedFileIndex(undefined), undefined)
  assert.equal(navigatedFileIndex({ index: -1 }), undefined)
  assert.equal(navigatedFileIndex({ index: 1.5 }), undefined)
  assert.equal(navigatedFileIndex({ index: '2' }), undefined)
})

test('添加到输入框：先取选区再插入（rc.5 的 insertText 要第二个参数），被拒绝或没有输入框时回答 false', () => {
  const calls = []
  const actions = {
    captureInsertion: () => ({ rev: 7 }),
    insertText: (text, span) => { calls.push([text, span]); return span !== undefined && span.rev === 7 },
  }
  assert.equal(insertIntoDraft(actions, '评论消息'), true)
  assert.deepEqual(calls, [['评论消息', { rev: 7 }]])
  assert.equal(insertIntoDraft({ captureInsertion: () => ({ rev: 1 }), insertText: () => false }, '评论消息'), false)
  assert.equal(insertIntoDraft(undefined, '评论消息'), false)
})

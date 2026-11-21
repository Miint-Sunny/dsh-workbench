/** 改动审阅服务的测试：反向应用落到真文件、新建和删除的文件、整文件回退、冲突拒绝、运行中拒绝、越界下标、二进制和过大、撤销回退（正常、回退后又被改过、写失败收尾）。改动记录服务是假的，文件和回退记录用临时目录里的真文件。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createReviewService } from '../lib/review/service.js'
import { createRevertStore } from '../lib/review/store.js'
import { tempDir } from './helpers/temp-dir.mjs'

/** 改动摘要里的一行。 */
const row = (path, display, over) => ({ path, display, added: 1, deleted: 1, ...over })

/** 一个改动过的文本文件的差异（第 2 行 l2 改成 L2）。 */
const EDIT_DIFF = {
  kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+L2', ' l3'] }],
}

/** 常用的「a.ts 改了一行」的改动摘要。 */
const summaryOf = (cwd) => ({ turn: 3, cwd, files: [row('a.ts', 'a.ts')], total: 1, added: 1, deleted: 1 })

/**
 * 搭一套服务：临时工作区（放文件）+ 临时记录目录 + 假的改动记录服务。
 * @param {(cwd: string) => object} [summaryOfFixture] 拿工作区路径拼改动摘要；不传就没有这一轮的记录。
 * @param {object} [diffOf] index → 差异对象。
 * @param {object} [over] 覆盖依赖（isRunning、io、summary）。
 */
async function setup(summaryOfFixture, diffOf, over = {}) {
  const workspace = await tempDir('dsh-workbench-ws-')
  const store = createRevertStore(await tempDir('dsh-workbench-store-'))
  const changes = {
    summary: over.summary ?? ((_sessionId, _seq) => summaryOfFixture?.(workspace)),
    diff: over.diff ?? (async (_sessionId, _seq, index) => diffOf[index]),
  }
  const service = createReviewService({
    changes, isRunning: over.isRunning ?? (() => false), store, io: over.io,
  })
  return { workspace, store, service, changes }
}

const coord = (over) => ({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 0, ...over })

test('回退这一处（正常）：文件换回这一轮开始前的行，留了记录，返回指代说法', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  const result = await service.revert(coord({}))
  assert.deepEqual(result, { ok: true, display: 'a.ts', description: '第 1–3 行这一处' })
  assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\n')
})

test('回退这一处（位置有偏移）：这一轮之后上面加过行，内容对得上照样回退', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'x\nl1\nL2\nl3\n')
  const result = await service.revert(coord({}))
  assert.equal(result.ok, true)
  assert.equal(await readFile(file, 'utf8'), 'x\nl1\nl2\nl3\n')
})

test('回退这一处（冲突）：那几行和这一轮结束时不一样就拒绝，文件不动，不留记录', async () => {
  const { workspace, service, store } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\n改过的\nl3\n')
  const result = await service.revert(coord({}))
  assert.equal(result.ok, false)
  assert.equal(result.status, 409)
  assert.equal(result.reason, 'conflict')
  assert.equal(result.message, '无法回退这一处：本轮之后 a.ts 的第 1–3 行已被修改，与本轮结束时不一致。')
  assert.equal(await readFile(file, 'utf8'), 'l1\n改过的\nl3\n')
  assert.equal(await store.load(coord({})), undefined)
})

test('回退整个文件（改动过的文件）：全部改动处倒回去，正好是这一轮开始前的内容', async () => {
  const diff = {
    kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
    hunks: [
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' l1', '-l2', '+L2', ' l3'] },
      { oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: [' l6', '-l7', '+L7', ' l8'] },
    ],
  }
  const { workspace, service } = await setup(summaryOf, { 0: diff })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n')
  const result = await service.revert(coord({ hunkIndex: null }))
  assert.deepEqual(result, { ok: true, display: 'a.ts', description: '整个文件' })
  assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n')
})

test('回退整个文件（本轮新建的文件）：就是删掉它；撤销回退把它原样写回来', async () => {
  const diff = {
    kind: 'text', path: 'new.ts', display: 'new.ts', before: false, after: true, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }],
  }
  const fixture = (cwd) => ({ turn: 3, cwd, files: [row('new.ts', 'new.ts', { added: 3, deleted: 0 })], total: 1, added: 3, deleted: 0 })
  const { workspace, service } = await setup(fixture, { 0: diff })
  const file = join(workspace, 'new.ts')
  await writeFile(file, 'a\nb\nc\n')
  assert.deepEqual(await service.revert(coord({ hunkIndex: null })), { ok: true, display: 'new.ts', description: '整个文件' })
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/)
  assert.deepEqual(await service.undo(coord({ hunkIndex: null })), { ok: true, display: 'new.ts', description: '整个文件' })
  assert.equal(await readFile(file, 'utf8'), 'a\nb\nc\n')
})

test('回退整个文件（本轮新建、这一轮之后又加过行）：删掉会连后来的行一起丢，拒绝', async () => {
  const diff = {
    kind: 'text', path: 'new.ts', display: 'new.ts', before: false, after: true, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }],
  }
  const fixture = (cwd) => ({ turn: 3, cwd, files: [row('new.ts', 'new.ts', { added: 3, deleted: 0 })], total: 1, added: 3, deleted: 0 })
  const { workspace, service } = await setup(fixture, { 0: diff })
  const file = join(workspace, 'new.ts')
  await writeFile(file, 'a\nb\nc\nd\n')
  const result = await service.revert(coord({ hunkIndex: null }))
  assert.equal(result.status, 409)
  assert.equal(result.message, '无法回退整个文件：本轮之后 new.ts 已被修改，与本轮结束时不一致。')
  assert.equal(await readFile(file, 'utf8'), 'a\nb\nc\nd\n')
})

test('回退整个文件（本轮删除的文件）：把这一轮开始前的内容写回来；撤销回退再删掉', async () => {
  const diff = {
    kind: 'text', path: 'gone.ts', display: 'gone.ts', before: true, after: false, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] }],
  }
  const fixture = (cwd) => ({ turn: 3, cwd, files: [row('gone.ts', 'gone.ts', { added: 0, deleted: 2 })], total: 1, added: 0, deleted: 2 })
  const { workspace, service } = await setup(fixture, { 0: diff })
  const file = join(workspace, 'gone.ts')
  await rm(file, { force: true })
  assert.deepEqual(await service.revert(coord({ hunkIndex: null })), { ok: true, display: 'gone.ts', description: '整个文件' })
  assert.equal(await readFile(file, 'utf8'), 'x\ny\n')
  assert.deepEqual(await service.undo(coord({ hunkIndex: null })), { ok: true, display: 'gone.ts', description: '整个文件' })
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/)
})

test('本轮删除的文件这一轮之后又被建了回来：对不上这一轮结束时（不在），拒绝', async () => {
  const diff = {
    kind: 'text', path: 'gone.ts', display: 'gone.ts', before: true, after: false, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] }],
  }
  const fixture = (cwd) => ({ turn: 3, cwd, files: [row('gone.ts', 'gone.ts', { added: 0, deleted: 2 })], total: 1, added: 0, deleted: 2 })
  const { workspace, service } = await setup(fixture, { 0: diff })
  await writeFile(join(workspace, 'gone.ts'), 'z\n')
  const result = await service.revert(coord({ hunkIndex: null }))
  assert.equal(result.status, 409)
  assert.equal(result.message, '无法回退整个文件：本轮之后 gone.ts 已被修改，与本轮结束时不一致。')
})

test('整文件替换的粗对比（coarse）：一个改动处就是整文件对调，整文件回退按它来', async () => {
  const diff = {
    kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: true,
    hunks: [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
      lines: ['-o1', '-o2', '+n1', '+n2', '+n3'],
    }],
  }
  const { workspace, service } = await setup(summaryOf, { 0: diff })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'n1\nn2\nn3\n')
  await service.revert(coord({ hunkIndex: null }))
  assert.equal(await readFile(file, 'utf8'), 'o1\no2\n')
})

test('越界下标：文件下标和改动处下标都拒绝，文件不动', async () => {
  const { service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const fileIndex = await service.revert(coord({ fileIndex: 5 }))
  assert.equal(fileIndex.status, 404)
  assert.equal(fileIndex.reason, 'file-index')
  const hunkIndex = await service.revert(coord({ hunkIndex: 9 }))
  assert.equal(hunkIndex.status, 404)
  assert.equal(hunkIndex.reason, 'hunk-index')
})

test('改动记录不在了（DSH 重启后）：摘要和差异都拿不到时拒绝，原因写明重启的事', async () => {
  const { service } = await setup(undefined, undefined, {
    summary: () => undefined,
    diff: async () => undefined,
  })
  const result = await service.revert(coord({}))
  assert.equal(result.status, 404)
  assert.equal(result.reason, 'summary-gone')
  assert.equal(result.message, '本轮改动已不可用：DSH 重启后，无法再查看或回退重启前各轮的改动。')
})

test('二进制和过大的文件：没有内容可比，拒绝；文件不动', async () => {
  const binaryFixture = (cwd) => ({ turn: 3, cwd, files: [row('logo.png', 'logo.png', { binary: true })], total: 1, added: 0, deleted: 0 })
  const { workspace, service } = await setup(binaryFixture, { 0: { kind: 'binary', path: 'logo.png', display: 'logo.png' } })
  const file = join(workspace, 'logo.png')
  await writeFile(file, '\u0000png')
  const binary = await service.revert(coord({ hunkIndex: null }))
  assert.equal(binary.status, 409)
  assert.equal(binary.message, '二进制文件，无法显示改动或回退。')

  const bigFixture = (cwd) => ({ turn: 3, cwd, files: [row('big.bin', 'big.bin', { oversized: true })], total: 1, added: 0, deleted: 0 })
  const { workspace: bigWorkspace, service: bigService } = await setup(bigFixture, { 0: { kind: 'oversized', path: 'big.bin', display: 'big.bin' } })
  const bigFile = join(bigWorkspace, 'big.bin')
  await writeFile(bigFile, '大')
  const oversized = await bigService.revert(coord({ hunkIndex: null }))
  assert.equal(oversized.status, 409)
  assert.equal(oversized.message, '文件超过大小上限，无法显示改动或回退。')
})

test('会话运行中：回退和撤销回退都拒绝，改动记录一概不碰', async () => {
  let summaryReads = 0
  const { service } = await setup(summaryOf, { 0: EDIT_DIFF }, {
    isRunning: () => true,
    summary: (cwd) => {
      summaryReads += 1
      return summaryOf(cwd)
    },
  })
  const revert = await service.revert(coord({}))
  assert.equal(revert.status, 409)
  assert.equal(revert.message, '会话进行中，结束后才能回退。')
  const undo = await service.undo(coord({}))
  assert.equal(undo.status, 409)
  assert.equal(undo.message, '会话进行中，结束后才能撤销。')
  assert.equal(summaryReads, 0)
})

test('撤销回退（正常）：恢复成回退前的样子，记录用掉；再撤销就没有这条记录了', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  await service.revert(coord({}))
  assert.deepEqual(await service.undo(coord({})), { ok: true, display: 'a.ts', description: '第 1–3 行这一处' })
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3\n')
  const again = await service.undo(coord({}))
  assert.equal(again.status, 404)
  assert.equal(again.reason, 'no-record')
})

test('撤销回退（一处、后来在别处又加过行）：正向应用找得到回退时写回去的行就撤销，后来的行留着', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  await service.revert(coord({}))
  await writeFile(file, 'l1\nl2\nl3\n又改的\n')
  assert.deepEqual(await service.undo(coord({})), { ok: true, display: 'a.ts', description: '第 1–3 行这一处' })
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3\n又改的\n')
})

test('撤销回退（一处、回退时写回去的行又被改过）：找不到那几行，拒绝，后来的改动留着', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  await service.revert(coord({}))
  await writeFile(file, 'l1\n改过的\nl3\n')
  const result = await service.undo(coord({}))
  assert.equal(result.status, 409)
  assert.equal(result.reason, 'undo-changed')
  assert.equal(result.message, '无法撤销回退：回退后 a.ts 已被修改，未找到回退时写回的行。')
  assert.equal(await readFile(file, 'utf8'), 'l1\n改过的\nl3\n')
})

test('撤销回退（整个文件、回退后又改过）：整文件核对不过就拒绝，后来的改动留着', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  await service.revert(coord({ hunkIndex: null }))
  await writeFile(file, 'l1\nl2\nl3\n又改的\n')
  const result = await service.undo(coord({ hunkIndex: null }))
  assert.equal(result.status, 409)
  assert.equal(result.reason, 'undo-changed')
  assert.equal(result.message, '无法撤销回退：回退后 a.ts 已被修改。')
  assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\n又改的\n')
})

test('同一文件先回退两处：撤销前一处不碰后一处，再撤销后一处，全部回到这一轮结束时', async () => {
  const diff = {
    kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
    hunks: [
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' l1', '-l2', '+L2', ' l3'] },
      { oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: [' l6', '-l7', '+L7', ' l8'] },
    ],
  }
  const { workspace, service } = await setup(summaryOf, { 0: diff })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n')
  await service.revert(coord({ hunkIndex: 0 }))
  await service.revert(coord({ hunkIndex: 1 }))
  assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n')
  // 撤销第一处：第二处的回退还在。
  assert.deepEqual(await service.undo(coord({ hunkIndex: 0 })), { ok: true, display: 'a.ts', description: '第 1–4 行这一处' })
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\n')
  // 再撤销第二处：回到这一轮结束时的样子。
  assert.deepEqual(await service.undo(coord({ hunkIndex: 1 })), { ok: true, display: 'a.ts', description: '第 6–8 行这一处' })
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n')
})

test('本轮删除的文件回退这一处（整段补回）再撤销：文件又删掉，回到回退前的不在', async () => {
  const diff = {
    kind: 'text', path: 'gone.ts', display: 'gone.ts', before: true, after: false, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] }],
  }
  const fixture = (cwd) => ({ turn: 3, cwd, files: [row('gone.ts', 'gone.ts', { added: 0, deleted: 2 })], total: 1, added: 0, deleted: 2 })
  const { workspace, service } = await setup(fixture, { 0: diff })
  const file = join(workspace, 'gone.ts')
  await rm(file, { force: true })
  await service.revert(coord({}))
  assert.equal(await readFile(file, 'utf8'), 'x\ny\n')
  assert.deepEqual(await service.undo(coord({})), { ok: true, display: 'gone.ts', description: '第 1–2 行这一处' })
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/)
})

test('state：回答这一轮已回退的坐标，撤销以后少一条', async () => {
  const diff = {
    kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
    hunks: [
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' l1', '-l2', '+L2', ' l3'] },
      { oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: [' l6', '-l7', '+L7', ' l8'] },
    ],
  }
  const { workspace, service } = await setup(summaryOf, { 0: diff })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n')
  assert.deepEqual(await service.state({ sessionId: 's1', seq: 3 }), { ok: true, reverts: [] })
  await service.revert(coord({ hunkIndex: 1 }))
  await service.revert(coord({ hunkIndex: 0 }))
  assert.deepEqual(await service.state({ sessionId: 's1', seq: 3 }), {
    ok: true,
    reverts: [
      { fileIndex: 0, hunkIndex: 0, display: 'a.ts', description: '第 1–4 行这一处' },
      { fileIndex: 0, hunkIndex: 1, display: 'a.ts', description: '第 6–8 行这一处' },
    ],
  })
  await service.undo(coord({ hunkIndex: 0 }))
  assert.deepEqual(await service.state({ sessionId: 's1', seq: 3 }), {
    ok: true,
    reverts: [{ fileIndex: 0, hunkIndex: 1, display: 'a.ts', description: '第 6–8 行这一处' }],
  })
})

test('从没有记录的空状态撤销回退：按没有这条记录回答', async () => {
  const { service } = await setup()
  const result = await service.undo(coord({}))
  assert.equal(result.status, 404)
  assert.equal(result.message, '未找到该回退记录。')
})

test('末行没有换行的文件：核对按行归一，回退写回补上换行，撤销回退原样回来', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3')
  await service.revert(coord({}))
  assert.equal(await readFile(file, 'utf8'), 'l1\nl2\nl3\n')
  await service.undo(coord({}))
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3')
})

test('读文件失败：原因带上出错信息，不动文件', async () => {
  const { service } = await setup(summaryOf, { 0: EDIT_DIFF }, {
    io: {
      readFile: async () => { throw Object.assign(new Error('不许读'), { code: 'EACCES' }) },
      modeOf: async () => undefined,
      writeFile: async () => {},
      deleteFile: async () => {},
    },
  })
  const result = await service.revert(coord({}))
  assert.equal(result.status, 500)
  assert.equal(result.reason, 'read-failed')
  assert.equal(result.message, '读取 a.ts 失败：不许读')
})

test('写文件失败：回退失败，刚存的记录收走（撤销回退时不会撞上残记录）', async () => {
  const { workspace, service, store } = await setup(summaryOf, { 0: EDIT_DIFF }, {
    io: {
      readFile: async (path) => readFile(path, 'utf8'),
      modeOf: async () => undefined,
      writeFile: async () => { throw new Error('磁盘满了') },
      deleteFile: async () => {},
    },
  })
  await writeFile(join(workspace, 'a.ts'), 'l1\nL2\nl3\n')
  const result = await service.revert(coord({}))
  assert.equal(result.status, 500)
  assert.equal(result.reason, 'write-failed')
  assert.equal(await store.load(coord({})), undefined)
})

test('撤销回退恢复文件权限：模型新建的 0600 文件，回退整个文件删掉后撤销，内容和权限都照原样回来', async () => {
  const diff = {
    kind: 'text', path: 'b.md', display: 'b.md', before: false, after: true, coarse: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+第一行', '+第二行'] }],
  }
  const { workspace, service } = await setup(
    (cwd) => ({ turn: 3, cwd, files: [row('b.md', 'b.md', { added: 2, deleted: 0 })] }), { 0: diff })
  const file = join(workspace, 'b.md')
  await writeFile(file, '第一行\n第二行\n')
  await chmod(file, 0o600)
  const reverted = await service.revert(coord({ fileIndex: 0, hunkIndex: null }))
  assert.equal(reverted.ok, true)
  // 这一轮新建的文件：回退整个文件是删掉它
  await assert.rejects(stat(file), /ENOENT/)
  const undone = await service.undo(coord({ fileIndex: 0, hunkIndex: null }))
  assert.equal(undone.ok, true)
  assert.equal(await readFile(file, 'utf8'), '第一行\n第二行\n')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('撤销回退不动已有文件的权限：改内容不重设权限位', async () => {
  const { workspace, service } = await setup(summaryOf, { 0: EDIT_DIFF })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'l1\nL2\nl3\n')
  await chmod(file, 0o640)
  await service.revert(coord({}))
  await service.undo(coord({}))
  assert.equal(await readFile(file, 'utf8'), 'l1\nL2\nl3\n')
  assert.equal((await stat(file)).mode & 0o777, 0o640)
})

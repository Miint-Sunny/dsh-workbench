/** 回退记录存储的测试：存取、坐标互不干扰、删除、损坏的记录、换个实例还能读（DSH 重启后撤销回退仍可用）、列一轮已回退的坐标、按天数清理（时间用注入的假时钟，不读本机）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRevertStore } from '../lib/review/store.js'
import { tempDir } from './helpers/temp-dir.mjs'

/** 一个最小的改动处。 */
const HUNK = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+L2', ' l3'] }

/** 一个最小记录。 */
const record = (over) => ({
  kind: 'revert', sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1,
  path: '/tmp/x/a.ts', display: 'a.ts', description: '第 1–3 行这一处',
  hunk: HUNK, appliedAt: 0,
  before: { kind: 'file', text: '旧\n' }, after: { kind: 'file', text: '新\n' },
  ...over,
})

/** 一天里的两个时间点：起点和 31 天后，prune 的测试都在这上面算。 */
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000
const LATER = NOW + 31 * DAY_MS

test('存了就能按坐标读回；整文件和各改动处的坐标互不干扰', async () => {
  const root = await tempDir('dsh-workbench-store-')
  const store = createRevertStore(root)
  await store.save(record({}))
  await store.save(record({ fileIndex: 1, hunkIndex: null, description: '整个文件', after: { kind: 'absent' }, hunk: undefined, appliedAt: undefined }))
  assert.equal((await store.load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1 })).description, '第 1–3 行这一处')
  assert.equal((await store.load({ sessionId: 's1', seq: 3, fileIndex: 1, hunkIndex: null })).after.kind, 'absent')
  assert.equal(await store.load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 0 }), undefined)
  assert.equal(await store.load({ sessionId: '别的', seq: 3, fileIndex: 0, hunkIndex: 1 }), undefined)
})

test('save 盖时间戳（用注入的假时钟），读回带上', async () => {
  const root = await tempDir('dsh-workbench-store-')
  await createRevertStore(root, { clock: () => NOW }).save(record({}))
  const loaded = await createRevertStore(root).load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1 })
  assert.equal(loaded.savedAt, NOW)
})

test('一处的记录缺了改动处按没有这条记录处理（撤销靠它正向应用，不能缺）', async () => {
  const root = await tempDir('dsh-workbench-store-')
  await createRevertStore(root).save(record({ hunk: undefined, appliedAt: undefined }))
  assert.equal(await createRevertStore(root).load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1 }), undefined)
})

test('删掉记录后就读不到，别的会话不受影响', async () => {
  const root = await tempDir('dsh-workbench-store-')
  const store = createRevertStore(root)
  await store.save(record({}))
  await store.save(record({ sessionId: 's2', path: '/tmp/x/b.ts', display: 'b.ts' }))
  await store.remove({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1 })
  assert.equal(await store.load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1 }), undefined)
  assert.notEqual(await store.load({ sessionId: 's2', seq: 3, fileIndex: 0, hunkIndex: 1 }), undefined)
})

test('记录写盘是完整的 JSON，一个坐标一个文件', async () => {
  const root = await tempDir('dsh-workbench-store-')
  await createRevertStore(root, { clock: () => NOW }).save(record({}))
  const files = await readdir(join(root, 's1'))
  assert.deepEqual(files, ['3.0.1.json'])
  const raw = JSON.parse(await readFile(join(root, 's1', '3.0.1.json'), 'utf8'))
  assert.equal(raw.display, 'a.ts')
  assert.equal(raw.savedAt, NOW)
})

test('换个实例还能读同一份记录（DSH 重启后撤销回退仍可用）；坏了的记录按没有处理', async () => {
  const root = await tempDir('dsh-workbench-store-')
  await createRevertStore(root).save(record({}))
  const again = await createRevertStore(root).load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 1 })
  assert.equal(again.before.text, '旧\n')
  await writeFile(join(root, 's1', '4.0.0.json'), '{oops', 'utf8')
  assert.equal(await createRevertStore(root).load({ sessionId: 's1', seq: 4, fileIndex: 0, hunkIndex: null }), undefined)
  await writeFile(join(root, 's1', '5.0.0.json'), JSON.stringify({ kind: '别的' }), 'utf8')
  assert.equal(await createRevertStore(root).load({ sessionId: 's1', seq: 5, fileIndex: 0, hunkIndex: null }), undefined)
})

test('list：列一轮已回退的坐标，按文件下标排好（整文件在同文件的一处前面）；别的轮次和坏记录不算', async () => {
  const root = await tempDir('dsh-workbench-store-')
  const store = createRevertStore(root)
  await store.save(record({ fileIndex: 1, hunkIndex: 0, description: '第 1–3 行这一处', display: 'b.ts' }))
  await store.save(record({ fileIndex: 1, hunkIndex: null, description: '整个文件', display: 'b.ts', hunk: undefined, appliedAt: undefined }))
  await store.save(record({ fileIndex: 0, hunkIndex: 2, description: '第 6–8 行这一处', display: 'a.ts' }))
  await store.save(record({ seq: 7, fileIndex: 0, hunkIndex: 0, description: '别的轮次', display: 'a.ts' }))
  await writeFile(join(root, 's1', '3.2.9.json'), '{oops', 'utf8')
  assert.deepEqual(await store.list('s1', 3), [
    { fileIndex: 0, hunkIndex: 2, display: 'a.ts', description: '第 6–8 行这一处' },
    { fileIndex: 1, hunkIndex: null, display: 'b.ts', description: '整个文件' },
    { fileIndex: 1, hunkIndex: 0, display: 'b.ts', description: '第 1–3 行这一处' },
  ])
  assert.deepEqual(await store.list('s1', 4), [])
  assert.deepEqual(await store.list('没有记录的会话', 3), [])
})

test('prune：按存下的时间删旧记录，新留下的不动；解析不了的和缺时间戳的也删', async () => {
  const root = await tempDir('dsh-workbench-store-')
  // 两个时间点各存一条：31 天前的旧记录和现在的新记录。
  await createRevertStore(root, { clock: () => NOW }).save(record({ fileIndex: 0, hunkIndex: 0 }))
  await createRevertStore(root, { clock: () => LATER }).save(record({ fileIndex: 1, hunkIndex: null, hunk: undefined, appliedAt: undefined }))
  await createRevertStore(root, { clock: () => LATER }).save(record({ sessionId: 's2', fileIndex: 0, hunkIndex: 0, path: '/tmp/x/b.ts', display: 'b.ts' }))
  // 手工放两条收垃圾的：缺时间戳的、JSON 坏的。
  await writeFile(join(root, 's1', '3.2.0.json'), JSON.stringify(record({ fileIndex: 2, hunkIndex: 0 })), 'utf8')
  await writeFile(join(root, 's1', '3.3.0.json'), '{oops', 'utf8')

  // 今天算 31 天那个时间点，保留 30 天：31 天前存的删，今天存的留。
  await createRevertStore(root).prune(LATER - 30 * DAY_MS)

  assert.deepEqual((await readdir(join(root, 's1'))).sort(), ['3.1.json'])
  assert.equal(await createRevertStore(root).load({ sessionId: 's1', seq: 3, fileIndex: 0, hunkIndex: 0 }), undefined)
  assert.notEqual(await createRevertStore(root).load({ sessionId: 's1', seq: 3, fileIndex: 1, hunkIndex: null }), undefined)
  assert.notEqual(await createRevertStore(root).load({ sessionId: 's2', seq: 3, fileIndex: 0, hunkIndex: 0 }), undefined)
})

test('prune：记录目录还不存在（从空状态起步）也不报错', async () => {
  const root = await tempDir('dsh-workbench-store-')
  await createRevertStore(join(root, '还没有的子目录')).prune(NOW)
})

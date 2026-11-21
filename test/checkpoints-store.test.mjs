/** 检查点的磁盘存储（lib/checkpoints-store.js）：meta / jsonl / restore / archived 的读写、坏行跳过、写入排队、files 同轮合并。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsStore } from '../lib/checkpoints-store.js'

test('store：meta 读写、损坏答 undefined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwb-store-'))
  try {
    const store = createCheckpointsStore(root)
    assert.equal(await store.readMeta('s1'), undefined)
    const meta = { cwd: '/tmp/repo', root: '/tmp/repo', kind: 'git' }
    await store.writeMeta('s1', meta)
    assert.deepEqual(await store.readMeta('s1'), meta)
    writeFileSync(join(root, 's1', 'meta.json'), 'not json')
    assert.equal(await store.readMeta('s1'), undefined)
    // 不完整的 meta 也当没有。
    writeFileSync(join(root, 's1', 'meta.json'), JSON.stringify({ cwd: '/x' }))
    assert.equal(await store.readMeta('s1'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store：jsonl 追加、按 turn 升序取最后一条、坏行跳过并回调', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwb-store-'))
  try {
    const store = createCheckpointsStore(root)
    assert.deepEqual(await store.readEntries('s1'), [])
    await store.appendEntry('s1', { turn: 2, seq: 22, time: 2000, kind: 'git', tree: 'b2' })
    await store.appendEntry('s1', { turn: 1, seq: 11, time: 1000, kind: 'git', tree: 'b1' })
    // 同一个 turn 再存一条，取最后一条。
    await store.appendEntry('s1', { turn: 2, seq: 25, time: 2500, kind: 'git', tree: 'b2b' })
    assert.deepEqual(await store.readEntries('s1'), [
      { turn: 1, seq: 11, time: 1000, kind: 'git', tree: 'b1' },
      { turn: 2, seq: 25, time: 2500, kind: 'git', tree: 'b2b' },
    ])
    // 坏行和形状不对的行跳过，各回调一次，好行照常读出。
    writeFileSync(
      join(root, 's1', 'checkpoints.jsonl'),
      '{broken\n'
      + JSON.stringify({ turn: 3, seq: 33, time: 3000, kind: 'git', tree: 'b3' }) + '\n'
      + JSON.stringify({ turn: 4, seq: 44, time: 4000, kind: 'git' }) + '\n'
      + JSON.stringify({ turn: 5, seq: 55, time: 5000, kind: 'files', captures: { 'a.txt': { kind: 'file', sha1: 'a'.repeat(40), mode: 420 }, 'gone.txt': { kind: 'absent' } } }) + '\n'
      // 越界的路径、不像 SHA-1 的副本名：整条当坏行。
      + JSON.stringify({ turn: 6, seq: 66, time: 6000, kind: 'files', captures: { '../escape.txt': { kind: 'absent' } } }) + '\n'
      + JSON.stringify({ turn: 7, seq: 77, time: 7000, kind: 'files', captures: { 'a.txt': { kind: 'file', sha1: 'x', mode: 420 } } }) + '\n',
    )
    const corrupt = []
    const entries = await store.readEntries('s1', line => corrupt.push(line))
    assert.equal(entries.length, 2)
    assert.equal(entries[0].turn, 3)
    assert.equal(entries[1].turn, 5)
    assert.equal(entries[1].kind, 'files')
    assert.equal(corrupt.length, 4)
    assert.equal(corrupt[0], '{broken')
    assert.equal(corrupt[1], JSON.stringify({ turn: 4, seq: 44, time: 4000, kind: 'git' }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store：restore 写读清、archived 读写、目录列表和删除、objects 大小', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwb-store-'))
  try {
    const store = createCheckpointsStore(root)
    assert.equal(await store.readRestore('s1'), undefined)
    await store.writeRestore('s1', { time: 123, turn: 3, tree: 't3' })
    assert.deepEqual(await store.readRestore('s1'), { time: 123, turn: 3, tree: 't3' })
    // 再写一次顶掉旧的。
    await store.writeRestore('s1', { time: 456, turn: 5, tree: 't5' })
    assert.deepEqual(await store.readRestore('s1'), { time: 456, turn: 5, tree: 't5' })
    await store.clearRestore('s1')
    assert.equal(await store.readRestore('s1'), undefined)
    // files 种类的撤销点带 captures。
    const filesRestore = { time: 7, turn: 2, captures: { 'a.txt': { kind: 'file', sha1: 'b'.repeat(40), mode: 420 } } }
    await store.writeRestore('s1', filesRestore)
    assert.deepEqual(await store.readRestore('s1'), filesRestore)
    await store.clearRestore('s1')

    assert.deepEqual(await store.readArchived(), {})
    await store.writeArchived({ s1: 111, s2: 222 })
    assert.deepEqual(await store.readArchived(), { s1: 111, s2: 222 })
    // 坏文件答空对象。
    writeFileSync(join(root, 'archived.json'), 'nope')
    assert.deepEqual(await store.readArchived(), {})

    // 目录列表只数会话目录；删整个会话。
    await store.appendEntry('s2', { turn: 1, seq: 1, time: 1, kind: 'git', tree: 'a' })
    await store.writeArchived({ s1: 111 })
    assert.deepEqual((await store.listSessionIds()).sort(), ['s1', 's2'])
    // 点开头的目录（运行器的 .no-hooks）不是会话目录。
    mkdirSync(join(root, '.no-hooks'), { recursive: true })
    assert.deepEqual((await store.listSessionIds()).sort(), ['s1', 's2'])
    await store.removeSession('s1')
    assert.deepEqual((await store.listSessionIds()), ['s2'])

    // 占用按整个会话目录算：objects、captures、jsonl 都按字节加。
    mkdirSync(join(root, 's2', 'objects', 'ab'), { recursive: true })
    writeFileSync(join(root, 's2', 'objects', 'ab', 'blob1'), '12345')
    writeFileSync(join(root, 's2', 'objects', 'info'), '12')
    assert.equal(await store.sizeBytes('s2'), 7 + statSync(join(root, 's2', 'checkpoints.jsonl')).size)
    // files 种类的副本也算进占用。
    mkdirSync(join(root, 's2', 'captures'), { recursive: true })
    writeFileSync(join(root, 's2', 'captures', 'c'.repeat(40)), '123')
    assert.equal(await store.sizeBytes('s2'), 10 + statSync(join(root, 's2', 'checkpoints.jsonl')).size)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store：同一个会话的写排队，20 条并发追加不交错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwb-store-'))
  try {
    const store = createCheckpointsStore(root)
    const writes = []
    for (let turn = 0; turn < 20; turn += 1) {
      writes.push(store.appendEntry('s1', { turn, seq: turn, time: turn, kind: 'git', tree: `t${turn}` }))
    }
    await Promise.all(writes)
    // 排队后逐行完整写入、按提交顺序，没有交错的半行。
    const entries = await store.readEntries('s1')
    assert.equal(entries.length, 20)
    assert.deepEqual(entries.map(entry => entry.turn), [...Array(20).keys()])
    const raw = readFileSync(join(root, 's1', 'checkpoints.jsonl'), 'utf8')
    const lines = raw.split('\n').filter(line => line !== '')
    assert.equal(lines.length, 20)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- 第 40 件阶段一（记录要安全）的回归测试 ----

test('store：files 种类同一轮增量追加，读时合并成一条（不再每文件抄整张表）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwb-store-'))
  try {
    const store = createCheckpointsStore(root)
    // 第 1 轮开头一条空的，之后每个文件一条增量。
    await store.appendEntry('s1', { turn: 1, seq: 10, time: 1000, kind: 'files', captures: {} })
    for (let index = 0; index < 400; index += 1) {
      await store.appendEntry('s1', {
        turn: 1, seq: 10, time: 1000, kind: 'files',
        captures: { [`src/module-${index}.js`]: { kind: 'file', sha1: `${index}`.padStart(40, '0'), mode: 420 } },
      })
    }
    const entries = await store.readEntries('s1')
    assert.equal(entries.length, 1, '同一轮合成一条')
    assert.equal(entries[0].turn, 1)
    assert.equal(Object.keys(entries[0].captures).length, 400, '增量合起来是整张表')
    // 每行只带自己那一个捕获，整份 jsonl 远小于「每文件重复整张表」的写法。
    const lines = readFileSync(join(root, 's1', 'checkpoints.jsonl'), 'utf8').split('\n').filter(line => line !== '')
    assert.equal(lines.length, 401)
    for (const line of lines.slice(1)) {
      assert.equal(Object.keys(JSON.parse(line).captures).length, 1)
    }
    assert.ok(statSync(join(root, 's1', 'checkpoints.jsonl')).size < 120_000, '400 个文件的记录不再是 7.6 MB 级别')
    // 后一条同路径的捕获把先一条顶掉（同一轮里重复碰到的路径取最后那次）。
    await store.appendEntry('s1', { turn: 1, seq: 10, time: 1000, kind: 'files', captures: { 'src/module-0.js': { kind: 'absent' } } })
    const merged = await store.readEntries('s1')
    assert.equal(merged[0].captures['src/module-0.js'].kind, 'absent')
    assert.equal(Object.keys(merged[0].captures).length, 400)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store：sizeBytes 把会话目录整个算进去（jsonl、meta、restore 也算）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dwb-store-'))
  try {
    const store = createCheckpointsStore(root)
    await store.appendEntry('s1', { turn: 1, seq: 10, time: 1000, kind: 'files', captures: { 'a.txt': { kind: 'absent' } } })
    await store.writeMeta('s1', { cwd: '/x', root: '/x', kind: 'files' })
    await store.writeRestore('s1', { time: 1, turn: 1, captures: {} })
    const jsonlSize = statSync(join(root, 's1', 'checkpoints.jsonl')).size
    const total = await store.sizeBytes('s1')
    assert.ok(total >= jsonlSize + statSync(join(root, 's1', 'meta.json')).size, 'jsonl 和 meta 都算进占用')
    // 会话目录的修改时间能读出来（清理的过期判断用）。
    assert.ok(Number.isSafeInteger(await store.sessionMtime('s1')))
    assert.equal(await store.sessionMtime('nope'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

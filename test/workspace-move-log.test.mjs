import assert from 'node:assert/strict'
import { test } from 'node:test'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { completeTail, projectKey, readHeader, readLog, rewriteHeaderCwd, sessionActivity } from '../lib/workspace-move-log.js'

/** 和 DSH 一样：第一帧只放会话头一行，后面每批事件各一帧，每帧带校验和。 */
const frame = text => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const HEADER = '{"type":"session","version":4,"id":"session-a1","createdAt":1700000000000,"cwd":"/home/u/Documents/old","isSeeded":false,"delegationDepth":0}\n'
const BATCH1 = '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}\n{"type":"turn/end","seq":1,"time":2,"data":{"turn":1,"reason":"completed"}}\n'
const BATCH2 = '{"type":"turn/start","seq":2,"time":3,"data":{"turn":2}}\n'
const zstdLog = () => Buffer.concat([frame(HEADER), frame(BATCH1), frame(BATCH2)])

test('读日志：多帧 zstd 日志的每一帧都解出来，会话头单独给出', () => {
  const log = readLog(zstdLog(), 'zstd')
  assert.equal(log.text, HEADER + BATCH1 + BATCH2)
  assert.equal(log.header.cwd, '/home/u/Documents/old')
  assert.equal(log.header.id, 'session-a1')
})

test('只读会话头：只解第一帧，后面的帧坏了也不影响', () => {
  const log = zstdLog()
  const broken = Buffer.concat([log.subarray(0, log.length - 6), Buffer.alloc(6)])
  assert.throws(() => readLog(broken, 'zstd'))
  assert.deepEqual(readHeader(broken, 'zstd'), JSON.parse(HEADER))
  assert.deepEqual(readHeader(Buffer.from(HEADER + BATCH1), 'none'), JSON.parse(HEADER))
})

test('换会话头：只换第一帧里的目录，后面的字节一个不动，其他字段不变', () => {
  const before = zstdLog()
  const after = rewriteHeaderCwd(before, 'zstd', '/home/u/Documents/old', '/home/u/Documents/work')
  const headerEnd = frame(HEADER).length
  const newHeaderFrame = frame(HEADER.replace('Documents/old', 'Documents/work'))
  assert.deepEqual(after.subarray(newHeaderFrame.length), before.subarray(headerEnd))
  const header = JSON.parse(zstdDecompressSync(after.subarray(0, newHeaderFrame.length)).toString())
  assert.deepEqual(header, { type: 'session', version: 4, id: 'session-a1', createdAt: 1700000000000, cwd: '/home/u/Documents/work', isSeeded: false, delegationDepth: 0 })
  assert.equal(readLog(after, 'zstd').text, HEADER.replace('Documents/old', 'Documents/work') + BATCH1 + BATCH2)
})

test('换会话头：会话头里的目录不是要搬的那个时拒绝，不出结果', () => {
  assert.throws(() => rewriteHeaderCwd(zstdLog(), 'zstd', '/home/u/Documents/other', '/home/u/Documents/work'), /cwd/)
})

test('换会话头：不压缩的日志换第一行，后面不动', () => {
  const before = Buffer.from(HEADER + BATCH1)
  const after = rewriteHeaderCwd(before, 'none', '/home/u/Documents/old', '/home/u/Documents/work')
  assert.equal(after.toString(), HEADER.replace('Documents/old', 'Documents/work') + BATCH1)
})

test('进行中的事：找出没结束的轮次和没结算的后台任务', () => {
  const text = HEADER + BATCH1 + BATCH2
    + '{"type":"job/registered","seq":3,"time":4,"data":{"jobId":"job-x","kind":"bash"}}\n'
    + '{"type":"job/registered","seq":4,"time":5,"data":{"jobId":"job-y","kind":"bash"}}\n'
    + '{"type":"job/settled","seq":5,"time":6,"data":{"jobId":"job-y","status":"done"}}\n'
  assert.deepEqual(sessionActivity(text), { openTurns: [2], openJobs: ['job-x'] })
  assert.deepEqual(sessionActivity(HEADER + BATCH1), { openTurns: [], openJobs: [] })
})

test('项目目录名和 DSH 的写法一致：分隔符合并成一个 -，汉字按 UTF-16 码元写成 ~XXXX', () => {
  assert.equal(projectKey('/data/u/AI/NovelAI/项目'), '--data-u-AI-NovelAI-~9879~76EE--')
  assert.equal(projectKey('/data/u/Documents/dsh_work'), '--data-u-Documents-dsh_work--')
  assert.equal(projectKey('/a//b/c~d'), '--a-b-c~007Ed--')
})

test('完整的尾巴：从帧边界开始、到最后一帧完整结束、解开是整行的才算；截断、乱码、空的、不在帧边界上的都不算', () => {
  const written = Buffer.concat([frame(HEADER), frame(BATCH1)])
  const appended = Buffer.concat([written, frame(BATCH2)])
  assert.equal(completeTail(appended, written.length, 'zstd'), true)
  assert.equal(completeTail(Buffer.concat([written, frame(BATCH2), frame('{"type":"turn/end","seq":3,"time":4,"data":{"turn":2}}\n')]), written.length, 'zstd'), true)
  assert.equal(completeTail(appended.subarray(0, -1), written.length, 'zstd'), false)
  assert.equal(completeTail(Buffer.concat([written, Buffer.from('garbage')]), written.length, 'zstd'), false)
  assert.equal(completeTail(written, written.length, 'zstd'), false)
  assert.equal(completeTail(appended, written.length - 1, 'zstd'), false)
  assert.equal(completeTail(Buffer.concat([written, frame('{"type":"turn/start"')]), written.length, 'zstd'), false)
  const plain = Buffer.from(HEADER + BATCH1)
  assert.equal(completeTail(Buffer.concat([plain, Buffer.from(BATCH2)]), plain.length, 'none'), true)
  assert.equal(completeTail(Buffer.concat([plain, Buffer.from(BATCH2.slice(0, -1))]), plain.length, 'none'), false)
})

for (const compression of ['none', 'zstd']) {
  test(`撤销检查拒绝损坏或序号不连续的追加事件（${compression}）`, () => {
    const encode = text => compression === 'zstd' ? frame(text) : Buffer.from(text)
    const prefix = Buffer.concat([encode(HEADER), encode(BATCH1)])
    for (const line of ['bad json\n', '\n', '{}\n', HEADER, BATCH1, '{"type":"turn/start","seq":2,"data":{"turn":2}}\n']) {
      assert.equal(completeTail(Buffer.concat([prefix, encode(line)]), prefix.length, compression), false, line)
    }
  })
}

test('目标文件夹名中的美元符号按原文写进会话头', () => {
  const path = '/projects/notes-$&-2026'
  const log = rewriteHeaderCwd(zstdLog(), 'zstd', JSON.parse(HEADER).cwd, path)
  assert.equal(readHeader(log, 'zstd').cwd, path)
})

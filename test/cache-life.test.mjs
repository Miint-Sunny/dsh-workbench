import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheLife } from '../lib/cache-life.js'
import { createLifeReader } from '../lib/compaction.js'
import { writeDigest } from './fixtures/usage/digest-files.mjs'

const MIN = 60_000
function rows(provider, table, extra = {}) {
  const out = []
  for (const [minutes, hit, total] of table) {
    for (let i = 0; i < total; i++) out.push({ kind: 'main', p: provider, prompt: 5000, gap: minutes * MIN, hit: i < hit ? 0.98 : 0, reason: null, ...extra })
  }
  return out
}
// 合成请求计数：覆盖连续命中、过渡区间和低命中区间。
const GO = [[2, 32, 36], [10, 10, 12], [20, 8, 9], [30, 5, 6], [40, 1, 4], [50, 2, 6], [70, 0, 6], [100, 0, 8], [150, 0, 7], [300, 1, 5], [800, 0, 4]]

test('合成请求分布：连续命中到 35 分钟，60 分钟后进入低命中区间', () => {
  const life = cacheLife(rows('opencode-go', GO), 'opencode-go')
  assert.equal(life.known, true)
  assert.equal(life.warmUntil, 35)
  assert.equal(life.goneAfter, 60)
  assert.equal(life.n, 103)
  assert.deepEqual(life.bins.slice(0, 5), [
    { from: 0, to: 5, hit: 32, n: 36 },
    { from: 5, to: 15, hit: 10, n: 12 },
    { from: 15, to: 25, hit: 8, n: 9 },
    { from: 25, to: 35, hit: 5, n: 6 },
    { from: 35, to: 45, hit: 1, n: 4 },
  ])
  assert.deepEqual(life.bins.at(-1), { from: 120, to: null, hit: 1, n: 16 })
})

test('隔得久的样本不够时说不知道，不猜', () => {
  const life = cacheLife(rows('deepseek-official', [[2, 19, 20], [10, 1, 1], [300, 1, 1], [800, 1, 1]]), 'deepseek-official')
  assert.equal(life.known, false)
  assert.equal(life.warmUntil, null)
  assert.equal(life.goneAfter, null)
  assert.equal(life.n, 23)
})

test('一直命中、没有过期段时只有下限', () => {
  const life = cacheLife(rows('x', [[2, 50, 50], [10, 5, 5], [20, 5, 5], [30, 5, 5], [40, 5, 5], [50, 5, 5], [70, 5, 5], [100, 5, 5], [150, 5, 5]]), 'x')
  assert.equal(life.known, true)
  assert.equal(life.warmUntil, null)
  assert.equal(life.warmAtLeast, 120)
  assert.equal(life.goneAfter, null)
})

test('只算主请求、这条路由、上下文够大的请求', () => {
  const base = rows('p', [[2, 1, 1]])
  assert.equal(cacheLife(rows('p', [[2, 1, 1]], { kind: 'compaction' }), 'p').n, 0)
  assert.equal(cacheLife(rows('p', [[2, 1, 1]], { prompt: 1999 }), 'p').n, 0)
  assert.equal(cacheLife(rows('p', [[2, 1, 1]], { gap: null }), 'p').n, 0)
  assert.equal(cacheLife(rows('p', [[2, 1, 1]], { hit: null }), 'p').n, 0)
  assert.equal(cacheLife(base, 'other').n, 0)
  assert.equal(cacheLife(base, 'p').n, 1)
})

test('第一个请求、系统提示词和工具变过的不算：那是前缀变了，不是过期', () => {
  for (const reason of ['first', 'system', 'header']) assert.equal(cacheLife(rows('p', [[2, 1, 1]], { reason }), 'p').n, 0)
  assert.equal(cacheLife(rows('p', [[2, 1, 1]], { reason: 'resume' }), 'p').n, 1)
})

test('命中一半以上才算命中', () => {
  const life = cacheLife([{ kind: 'main', p: 'p', prompt: 5000, gap: MIN, hit: 0.49, reason: null }, { kind: 'main', p: 'p', prompt: 5000, gap: MIN, hit: 0.5, reason: null }], 'p')
  assert.deepEqual(life.bins[0], { from: 0, to: 5, hit: 1, n: 2 })
})

test('没有数据时 known 是 false，bins 是空的', () => {
  assert.deepEqual(cacheLife([], 'p'), { n: 0, bins: [], known: false, warmUntil: null, warmAtLeast: null, goneAfter: null })
})

test('只算压缩名单里的预设：未列出的三个预设和会话头没记预设的会话不算', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-life-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeDigest(dir, { id: 'excluded-main', preset: 'custom-main', table: GO })
  await writeDigest(dir, { id: 'excluded-background', preset: 'custom-background', table: [[70, 0, 10]] })
  await writeDigest(dir, { id: 'excluded-media', preset: 'custom-media', table: [[150, 0, 10]] })
  await writeDigest(dir, { id: 'headless', preset: null, table: [[100, 0, 10]] })
  await writeDigest(dir, { id: 'code', preset: 'standard', table: [[2, 40, 40], [10, 4, 4]] })
  await writeDigest(dir, { id: 'code-mode', preset: 'dsh-workbench-coding', table: [[20, 3, 3]] })
  const life = await createLifeReader({ dir, presets: ['standard', 'dsh-workbench-coding'], refreshMs: 60_000 })('opencode-go')
  assert.deepEqual(life.bins, [{ from: 0, to: 5, hit: 40, n: 40 }, { from: 5, to: 15, hit: 4, n: 4 }, { from: 15, to: 25, hit: 3, n: 3 }])
})

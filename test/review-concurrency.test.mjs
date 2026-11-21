import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createReviewService } from '../lib/review/service.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const coord = n => ({ sessionId: `session${n}`, seq: 1, fileIndex: 0, hunkIndex: n })
for (const pair of [['revert', 'revert'], ['undo', 'undo'], ['undo', 'revert']]) {
  test(`W-006 ${pair.join('/')} across sessions preserves both hunks under an explicit read barrier`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'review-concurrency-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const path = join(root, 'file.txt'), records = new Map()
    const hunks = [0, 1].map(n => ({ oldStart: n + 1, newStart: n + 1, oldLines: 1, newLines: 1, lines: [`-${n}old`, `+${n}new`] }))
    let barrier
    const io = {
      async readFile(path) { const text = readFileSync(path, 'utf8'); if (barrier) { const held = barrier; barrier = null; held.entered.resolve(); await held.release.promise } return text },
      async modeOf() { return 0o600 },
      async writeFile(path, text) { writeFileSync(path, text) },
      async deleteFile(path) { rmSync(path, { force: true }) },
    }
    const service = createReviewService({ io, isRunning: () => false,
      resolvePath: (cwd, path) => resolve(cwd, path),
      changes: { summary: id => ({ cwd: root, files: [{ path: id === 'session0' ? './file.txt' : 'dir/../file.txt', display: 'file.txt' }] }), diff: async () => ({ kind: 'text', before: true, after: true, hunks }) },
      store: { async save(r) { records.set(r.sessionId, structuredClone(r)) }, async load(c) { return structuredClone(records.get(c.sessionId)) }, async remove(c) { records.delete(c.sessionId) } },
    })
    writeFileSync(path, '0new\n1new\n')
    for (let n = 0; n < 2; n++) if (pair[n] === 'undo') assert.equal((await service.revert(coord(n))).ok, true)
    const held = { entered: deferred(), release: deferred() }
    barrier = held
    const first = service[pair[0]](coord(0))
    await held.entered.promise
    const second = service[pair[1]](coord(1))
    // All fixture IO except the held read completes in microtasks. This event-loop
    // checkpoint deterministically lets an unlocked second operation finish.
    await setImmediate()
    held.release.resolve()
    const results = await Promise.all([first, second])
    assert.deepEqual(results.map(r => r.ok), [true, true])
    assert.equal(readFileSync(path, 'utf8'), pair.map((op, n) => `${n}${op === 'revert' ? 'old' : 'new'}\n`).join(''))
    assert.equal(records.size, pair.filter(op => op === 'revert').length)
  })
}

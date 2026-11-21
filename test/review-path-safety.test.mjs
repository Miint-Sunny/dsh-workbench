import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewService } from '../lib/review/service.js'
import { createRevertStore } from '../lib/review/store.js'

const coord = { sessionId: 'fixture', seq: 1, fileIndex: 0, hunkIndex: null }
async function fixture(t, external = false) {
  const temp = await mkdtemp(join(tmpdir(), 'dwb-review-path-')), root = await realpath(temp)
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace'), outside = join(root, 'outside')
  await mkdir(cwd); await mkdir(outside); await mkdir(join(cwd, 'src'))
  const path = external ? join(outside, 'file') : join(cwd, 'src', 'file')
  await writeFile(path, 'after\n')
  const store = createRevertStore(join(root, 'records'))
  const service = createReviewService({
    changes: {
      summary: () => ({ cwd, files: [{ path: external ? path : 'src/file', display: 'file' }] }),
      diff: async () => ({ kind: 'text', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }] }),
    }, isRunning: () => false, store,
  })
  return { root, cwd, outside, path, store, service }
}

for (const part of ['file', 'parent']) test(`W-005: revert rejects a replaced ${part} symlink`, async t => {
  const f = await fixture(t)
  const victim = join(f.outside, 'file')
  await writeFile(victim, 'after\n')
  const replaced = part === 'file' ? f.path : join(f.cwd, 'src')
  await rename(replaced, `${replaced}-old`)
  await symlink(part === 'file' ? victim : f.outside, replaced)
  assert.equal((await f.service.revert(coord)).ok, false)
  assert.equal(await readFile(victim, 'utf8'), 'after\n')
  assert.equal(await f.store.load(coord), undefined)
})

test('W-005: undo rejects a link substituted after revert', async t => {
  const f = await fixture(t), victim = join(f.outside, 'file')
  assert.equal((await f.service.revert(coord)).ok, true)
  await writeFile(victim, 'before\n')
  await rm(f.path); await symlink(victim, f.path)
  assert.equal((await f.service.undo(coord)).ok, false)
  assert.equal(await readFile(victim, 'utf8'), 'before\n')
})

test('W-005: canonical recorded files outside cwd still revert and undo', async t => {
  const f = await fixture(t, true)
  assert.equal((await f.service.revert(coord)).ok, true)
  assert.equal(await readFile(f.path, 'utf8'), 'before\n')
  assert.equal((await f.service.undo(coord)).ok, true)
  assert.equal(await readFile(f.path, 'utf8'), 'after\n')
})

test('W-005: atomic revert preserves an existing private file mode', async t => {
  const f = await fixture(t)
  await chmod(f.path, 0o600)
  assert.equal((await f.service.revert(coord)).ok, true)
  assert.equal((await stat(f.path)).mode & 0o777, 0o600)
})


test('TW-006: partial ENOSPC writes preserve the original target even after removing the revert record', async t => {
  const f = await fixture(t)
  const original = Buffer.from('after\nunchanged tail\n原始内容必须完整保留。\n')
  await writeFile(f.path, original)
  const nativeWriteFile = fs.promises.writeFile
  let partialWrite = false, savedBeforeFailure, result
  fs.promises.writeFile = async (path, data, options) => {
    if (typeof path !== 'string' || (path !== f.path && !path.startsWith(`${f.path}.dwb-review-`))) {
      return nativeWriteFile(path, data, options)
    }
    // Keep the real store and the service's default atomic IO. Only this
    // target's low-level write fails, after bytes really reach the filesystem.
    savedBeforeFailure = await f.store.load(coord)
    await nativeWriteFile(path, Buffer.from(data).subarray(0, 2), options)
    partialWrite = true
    throw Object.assign(new Error('fixture: ENOSPC after a partial write'), { code: 'ENOSPC' })
  }
  syncBuiltinESMExports()
  try {
    result = await f.service.revert(coord)
  } finally {
    fs.promises.writeFile = nativeWriteFile
    syncBuiltinESMExports()
  }
  assert.equal(partialWrite, true, 'the target write must reach the injected disk failure')
  assert.equal(savedBeforeFailure.before.text, original.toString('utf8'), 'the real store saved the original before publication')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'write-failed')
  assert.match(result.message, /ENOSPC/)
  assert.equal(await f.store.load(coord), undefined, 'the failure path removed its revert record')
  assert.deepEqual(await readFile(f.path), original, 'all original bytes remain in the real target')
})

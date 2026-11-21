/** Child-only filesystem fixture; its parent imposes a hard deadline for FIFO regressions. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createReviewService } from '../lib/review/service.js'
import { createRevertStore } from '../lib/review/store.js'

const [directory, operation, kind] = process.argv.slice(2)
const root = await realpath(directory), path = join(root, 'target')
const coord = { sessionId: 'fixture', seq: 1, fileIndex: 0, hunkIndex: null }
const store = createRevertStore(join(root, 'records'))
const service = createReviewService({ store, isRunning: () => false, changes: {
  summary: () => ({ cwd: root, files: [{ path: 'target', display: 'target' }] }),
  diff: async () => ({ kind: 'text', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }] }),
} })
await writeFile(path, 'after\n')
if (operation === 'undo') assert.equal((await service.revert(coord)).ok, true)
await rm(path)
if (kind === 'fifo') execFileSync('mkfifo', [path])
else await mkdir(path)
const result = await service[operation](coord)
assert.equal(result.ok, false)
assert.equal(result.reason, 'read-failed')
const info = await lstat(path)
assert.equal(kind === 'fifo' ? info.isFIFO() : info.isDirectory(), true, 'the non-regular entry must remain intact')
assert.equal((await store.load(coord)) !== undefined, operation === 'undo')
await rm(path, { recursive: kind === 'directory' })
await writeFile(path, operation === 'undo' ? 'before\n' : 'after\n')
assert.equal((await service[operation](coord)).ok, true, 'a refused read must release the file queue and preserve undo records')

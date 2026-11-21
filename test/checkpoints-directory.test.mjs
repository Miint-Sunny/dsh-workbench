import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureFile, previewFiles } from '../lib/checkpoints-files.js'

test('W-004: a directory is skipped even when the OS refuses directory open', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dwb-directory-'))
  const directory = join(root, 'entry')
  await fs.mkdir(directory)
  const originalOpen = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (path === directory) throw Object.assign(new Error('directory open refused'), { code: 'EISDIR' })
    return originalOpen(path, ...args)
  })
  syncBuiltinESMExports()
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }) })
  assert.equal(await captureFile(directory, join(root, 'copies'), 1024), undefined)
  assert.deepEqual(await previewFiles(root, join(root, 'copies'), new Map([['entry', { kind: 'absent' }]]), 1024), [])
})

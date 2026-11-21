import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDirSync } from './helpers/temp-dir.mjs'

test('a fixture that recreates its directory after every removal makes its test fail explicitly', () => {
  const outer = tempDirSync('dwb-cleanup-control-')
  const file = join(outer, 'writer.test.mjs')
  const helper = new URL('./helpers/temp-dir.mjs', import.meta.url).href
  // Recreate only this child's own fixture, deterministically at the end of each removal.
  writeFileSync(file, `
    import { test } from 'node:test'
    import promises from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const remove = promises.rm
    let own
    promises.rm = async (path, options) => {
      await remove(path, options)
      if (path === own) await promises.mkdir(own)
    }
    syncBuiltinESMExports()
    const { tempDirSync } = await import(${JSON.stringify(helper)})
    test('writer', () => { own = tempDirSync('writer-', ${JSON.stringify(outer)}) })
  `)
  const child = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(child.error)
  assert.equal(child.status, 1)
  assert.match(child.stdout + child.stderr, /Temporary directory did not stay removed/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

for (const operation of ['revert', 'undo']) for (const kind of ['fifo', 'directory']) {
  test(`W-O01 ${operation} refuses a ${kind} without hanging or losing its retry state`, { skip: kind === 'fifo' && process.platform === 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'review-nonregular-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./review-nonregular-fixture.mjs', import.meta.url)), root, operation, kind], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 3000)
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stderr }) })
    })
    assert.equal(result.timedOut, false, 'the isolated operation exceeded its deadline')
    assert.equal(result.code, 0, result.stderr)
  })
}

/** rerun 行配置的默认值、校验和存取（lib/rerun-state.js 的纯函数部分）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultRerunConfig, parseRerunConfig, readRerunConfig, writeRerunConfig } from '../lib/rerun-state.js'

test('rerun config defaults: archiveOriginal off', () => {
  assert.deepEqual(defaultRerunConfig(), { archiveOriginal: false })
})

test('rerun config parse: canonical values in, malformed ones out', () => {
  assert.deepEqual(parseRerunConfig({ archiveOriginal: true }), { archiveOriginal: true })
  assert.deepEqual(parseRerunConfig({ archiveOriginal: false, extra: 'ignored' }), { archiveOriginal: false })
  assert.throws(() => parseRerunConfig({ archiveOriginal: 1 }), /archiveOriginal/)
  assert.throws(() => parseRerunConfig({ archiveOriginal: 'yes' }), /archiveOriginal/)
  assert.throws(() => parseRerunConfig({}), /archiveOriginal/)
  assert.throws(() => parseRerunConfig(null), /object/)
  assert.throws(() => parseRerunConfig('nope'), /object/)
})

test('rerun config storage: missing or corrupt file falls back to defaults, save round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-rerun-'))
  try {
    assert.deepEqual(readRerunConfig(dir), defaultRerunConfig())
    writeFileSync(join(dir, 'rerun.json'), '{broken')
    assert.deepEqual(readRerunConfig(dir), defaultRerunConfig())
    writeFileSync(join(dir, 'rerun.json'), JSON.stringify({ archiveOriginal: 7 }))
    assert.deepEqual(readRerunConfig(dir), defaultRerunConfig())
    writeRerunConfig(dir, { archiveOriginal: true })
    assert.deepEqual(readRerunConfig(dir), { archiveOriginal: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

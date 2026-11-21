/** 余额与额度的配置（lib/quota-config.js）：默认值、校验、读文件；配置错了启动就报错。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseQuotaConfig, readQuotaConfig } from '../lib/quota-config.js'

test('quota config: 缺省时用默认值（超时 10 秒、缓存 300 秒）', () => {
  assert.deepEqual(parseQuotaConfig(), { timeoutSeconds: 10, cacheSeconds: 300 })
  assert.deepEqual(parseQuotaConfig({}), { timeoutSeconds: 10, cacheSeconds: 300 })
})

test('quota config: 两个字段都能改', () => {
  assert.deepEqual(parseQuotaConfig({ timeoutSeconds: 5, cacheSeconds: 60 }), { timeoutSeconds: 5, cacheSeconds: 60 })
})

test('quota config: 坏值报错（照 usage-config 的校验）', () => {
  for (const value of [0, -1, 1.5, '10', null, true]) {
    assert.throws(() => parseQuotaConfig({ timeoutSeconds: value }), /timeoutSeconds/, `timeoutSeconds=${String(value)}`)
    assert.throws(() => parseQuotaConfig({ cacheSeconds: value }), /cacheSeconds/, `cacheSeconds=${String(value)}`)
  }
  assert.throws(() => parseQuotaConfig({ nope: 1 }), /nope/)
  assert.throws(() => parseQuotaConfig('x'), /object/)
  assert.throws(() => parseQuotaConfig(null), /object/)
})

test('quota config: 读文件——不存在用默认值，坏 JSON 报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-quota-config-'))
  try {
    assert.deepEqual(readQuotaConfig(dir), { timeoutSeconds: 10, cacheSeconds: 300 })
    writeFileSync(join(dir, 'quota.json'), '{nope')
    assert.throws(() => readQuotaConfig(dir), SyntaxError)
    writeFileSync(join(dir, 'quota.json'), JSON.stringify({ timeoutSeconds: 3, cacheSeconds: 30 }))
    assert.deepEqual(readQuotaConfig(dir), { timeoutSeconds: 3, cacheSeconds: 30 })
    writeFileSync(join(dir, 'quota.json'), JSON.stringify({ timeoutSeconds: 0 }))
    assert.throws(() => readQuotaConfig(dir), /timeoutSeconds/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

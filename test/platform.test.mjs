/**
 * 网页端的平台判断只有一处：src/client/features.js 的 clientPlatform。回复菜单的发送键、系统通知配置页的三句都按它分（fix#223）。
 * 平台当参数传，不读本机：Node 自己也有 navigator.platform，在 Mac 上是 MacIntel。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as features from '../src/client/features.js'
import * as reply from '../src/client/reply.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('clientPlatform：MacIntel 是 macos，Win32 是 windows，其余都算 linux（DSH 快捷键的三个平台名）', () => {
  assert.equal(typeof features.clientPlatform, 'function')
  assert.equal(features.clientPlatform('MacIntel'), 'macos')
  assert.equal(features.clientPlatform('Win32'), 'windows')
  assert.equal(features.clientPlatform('Linux x86_64'), 'linux')
  assert.equal(features.clientPlatform(''), 'linux')
})

test('回复菜单的发送键：Mac 上标 ⌘ ⏎，Windows 和其他平台标 Ctrl ⏎', () => {
  assert.equal(typeof reply.replySendKey, 'function')
  assert.equal(reply.replySendKey('macos'), '⌘ ⏎')
  assert.equal(reply.replySendKey('windows'), 'Ctrl ⏎')
  assert.equal(reply.replySendKey('linux'), 'Ctrl ⏎')
})

test('src、lib 里只有 features.js 读平台：别处不读 navigator.platform，也不读 userAgent 和 DSH 页面上的 data-platform', () => {
  const readers = new Set()
  for (const dir of ['src', 'lib']) {
    for (const name of readdirSync(join(ROOT, dir), { recursive: true })) {
      const file = join(dir, name)
      if (!/\.m?js$/.test(file) || file === join('lib', 'client.js')) continue
      if (/navigator\.(?:platform|userAgent)|userAgentData|dataset\.platform|data-platform/.test(readFileSync(join(ROOT, file), 'utf8'))) readers.add(file)
    }
  }
  assert.deepEqual([...readers], [join('src', 'client', 'features.js')])
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import test from 'node:test'

test('chore140 packing clean source builds the client without shipping build inputs', { timeout: 30000 }, t => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'dwb-pack-client-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'source'), output = join(dir, 'output')
  mkdirSync(source); mkdirSync(output); mkdirSync(join(source, 'docs'))
  for (const entry of ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'public-files.json', 'cordis.patch.yml', 'lib', 'src', 'scripts', 'locale', 'docs/configuration.md', 'docs/configuration.en.md']) {
    cpSync(join(root, entry), join(source, entry), { recursive: true })
  }
  rmSync(join(source, 'lib/client.js'), { force: true })
  const env = { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_cache: join(dir, 'cache') }
  const pack = cwd => JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd, env, encoding: 'utf8' }))[0]
  const result = pack(source)
  assert(result.files.some(file => file.path === 'lib/client.js'), 'clean npm pack must include the exported client')
  const artifact = join(output, result.filename)
  const extracted = join(dir, 'extracted'); mkdirSync(extracted)
  execFileSync('/usr/bin/tar', ['-xzf', artifact, '-C', extracted])
  const packaged = join(extracted, 'package')
  const manifest = JSON.parse(readFileSync(join(packaged, 'package.json')))
  const client = join(packaged, manifest.exports['./client'].default)
  assert(existsSync(client))
  assert.doesNotThrow(() => new Script(readFileSync(client, 'utf8')))
  assert(readFileSync(client, 'utf8').includes("id: '@miint-sunny/dsh-workbench'"))
  assert(!result.files.some(file => /^(src|scripts|test)\//.test(file.path)), 'runtime archive excludes build inputs')
  assert.deepEqual(result.files.filter(file => file.path.startsWith('docs/')).map(file => file.path).sort(), ['docs/configuration.en.md', 'docs/configuration.md'])
})

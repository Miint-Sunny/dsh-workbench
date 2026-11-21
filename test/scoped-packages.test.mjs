import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { privacyFindings } from '../scripts/privacy.mjs'
import { buildTarballs, listTarball } from '../scripts/build-packs.mjs'

const baseline = JSON.parse(readFileSync(new URL('./fixtures/scoped-row-ids.json', import.meta.url)))
let root, packages
before(() => {
  root = mkdtempSync(join(tmpdir(), 'dwb-scope-'))
  packages = buildTarballs({ output: join(root, 'packages') }).map(item => ({
    ...item, entries: listTarball(readFileSync(item.file)),
  }))
})
after(() => { if (root) rmSync(root, { recursive: true, force: true }) })
const content = (item, path) => item.entries.find(entry => entry.path === 'package/' + path)?.data.toString('utf8')

function privateArchiveBytes(tar, names) {
  return privacyFindings(tar, 'npm archive', { strictHomePaths: true, privateNames: names }).length > 0
}

test('chore143 archive privacy rejects mixed-case home paths in every raw tar region', () => {
  const missed = []
  for (const location of ['filename', 'uname', 'gname', 'pax', 'content']) {
    for (const value of ['/uSeRs/example/private', '/HoMe/example/private', 'c:\\uSeRs\\example\\private']) {
      const fixture = Buffer.alloc(2048)
      const offset = { filename: 0, uname: 265, gname: 297, pax: 512, content: 1024 }[location]
      fixture.write(value, offset)
      if (!privateArchiveBytes(fixture, [])) missed.push(location + ': ' + value)
    }
  }
  assert.deepEqual(missed, [])
})

test('chore143 archive privacy rejects the runtime username without case sensitivity', () => {
  const username = userInfo().username
  const mixedCase = [...username].map((letter, index) => index % 2 ? letter.toLowerCase() : letter.toUpperCase()).join('')
  assert.equal(privateArchiveBytes(Buffer.from('owner=' + mixedCase), [username]), true)
  assert.equal(privateArchiveBytes(Buffer.alloc(512), [username]), false)
})

test('chore140 eight standalone archives expose scoped public runtime packages', () => {
  assert.deepEqual(packages.map(item => item.name).sort(), Object.keys(baseline).sort())
  for (const item of packages) {
    const pkg = JSON.parse(content(item, 'package.json'))
    assert.equal(pkg.name, item.name)
    assert.notEqual(pkg.private, true)
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
    assert(content(item, 'lib/client.js').includes(`id: '${item.name}'`))
    assert(item.entries.every(entry => !/^package\/(?:test|src|scripts)\//.test(entry.path)))
    assert.deepEqual(item.entries.filter(entry => entry.path.startsWith('package/docs/')).map(entry => entry.path).sort(),
      item.name === '@miint-sunny/dsh-workbench' ? ['package/docs/configuration.en.md', 'package/docs/configuration.md'] : [])
  }
})

test('chore140 renamed archives preserve every pre-scope row id', () => {
  for (const item of packages) {
    const expected = baseline['@miint-sunny/' + item.name.replace(/^@miint-sunny\//, '')]
    const actual = [...content(item, 'cordis.patch.yml').matchAll(/^\s*- id: ([\w-]+)$/gm)].map(match => match[1]).sort()
    assert.deepEqual(actual, expected, item.name)
  }
})

test('chore140 actual archive entries contain no personal home path or local username', () => {
  // Extra CI deny names supplement the runtime account; never put personal literals here.
  const names = [userInfo().username, ...(process.env.DSH_PACKAGE_PRIVATE_NAMES ?? '').split(',')].map(name => name.trim()).filter(Boolean)
  const failures = []
  for (const item of packages) {
    // Check the entire original tar, including filenames, header fields and PAX records.
    const tar = gunzipSync(readFileSync(item.file))
    if (privateArchiveBytes(tar, names)) failures.push(item.name)
  }
  assert.deepEqual(failures, [])
})

test('feat217 整包 tgz 装进 node_modules 后，按包名解析模型设置、OpenCode 会话 ID 两行的入口和语言文件；补丁行 id 和包内名字对得上', async () => {
  const item = packages.find(entry => entry.name === '@miint-sunny/dsh-workbench')
  const consumer = join(root, 'consumer')
  const installed = join(consumer, 'node_modules/@miint-sunny/dsh-workbench')
  for (const entry of item.entries) {
    const target = join(installed, entry.path.slice('package/'.length))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
  writeFileSync(join(consumer, 'package.json'), '{"name":"pack-consumer","type":"module","private":true}\n')
  const expected = {
    '@miint-sunny/dsh-workbench/model-settings': 'lib/model-settings/index.js',
    '@miint-sunny/dsh-workbench/model-settings/locale/zh.json': 'locale/model-settings/zh.json',
    '@miint-sunny/dsh-workbench/model-settings/locale/en.json': 'locale/model-settings/en.json',
    '@miint-sunny/dsh-workbench/opencode-session': 'lib/model-settings/opencode-session.js',
    '@miint-sunny/dsh-workbench/opencode-session/locale/zh.json': 'locale/opencode-session/zh.json',
    '@miint-sunny/dsh-workbench/opencode-session/locale/en.json': 'locale/opencode-session/en.json',
  }
  const specifiers = Object.keys(expected)
  const resolved = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval',
    `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(value => import.meta.resolve(value))))`], { cwd: consumer, encoding: 'utf8' }))
  const base = realpathSync(installed)
  assert.deepEqual(resolved, Object.values(expected).map(path => pathToFileURL(join(base, path)).href))
  const rows = new Map([...content(item, 'cordis.patch.yml').matchAll(/^ {4}- id: (\S+)\n {6}name: '([^']+)'$/gm)].map(([, id, name]) => [id, name]))
  assert.equal(rows.get('dsh-workbench-model-settings'), '@miint-sunny/dsh-workbench/model-settings')
  assert.equal(rows.get('dsh-workbench-opencode-session'), '@miint-sunny/dsh-workbench/opencode-session')
  // OpenCode 会话 ID 那一行不 import DSH 的包，可以直接载入装好的文件核对名字。
  const session = await import(pathToFileURL(join(base, 'lib/model-settings/opencode-session.js')).href)
  assert.equal(session.name, '@miint-sunny/dsh-workbench/opencode-session')
})

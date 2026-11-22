import test from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, rmSync } from 'node:fs'
import { devNull, homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { privacyFindings } from '../scripts/privacy.mjs'
import { exportPublic, publicFiles, scanPublic } from '../scripts/public-release.mjs'
import { fileURLToPath } from 'node:url'

test('公开源码带有发布页面的脚本授权回归测试', () => {
  const files = publicFiles(join(import.meta.dirname, '..'))
  assert.ok(files.includes('test/pages-scripts.test.mjs'))
})

// test/ 下不进公开仓库的文件：npm test 不跑的手动脚本，和测本机检出里才有的材料的测试。
const localOnlyTestFiles = {
  'test/host-smoke.mjs': '手动跑的冒烟脚本，由 scripts/rehearse.sh 装进临时 DSH profile',
  'test/subagent-scope-smoke.mjs': '手动跑的冒烟脚本，由 scripts/rehearse.sh 装进临时 DSH profile',
  'test/review-mocks.browser.mjs': '手动跑的浏览器脚本，读 docs/mocks 的样稿，用本机 media-look 检出里的 puppeteer-core',
  'test/usage-page-shots.mjs': '手动跑的截图脚本，用本机 media-look 检出里的 puppeteer-core 和 Headless Shell',
  'test/mock-standalone.test.mjs': '测 scripts/mock-standalone.mjs 和 docs/mocks 的样稿，两者都不公开',
  'test/new-docs.test.mjs': '和 main 分支比新加的 docs/；公开仓库的 docs/ 只有配置说明，由 public:check 查',
  'test/usage-compare.test.mjs': '测 docs/research 里的用量对照脚本，docs/research 不公开',
}

test('test/ 下 git 跟踪的文件都登记在 public-files.json 里：不在清单里的不进公开仓库，只在本机用的写明原因', () => {
  const root = join(import.meta.dirname, '..')
  const tracked = git(root, 'ls-files', '-z', '--', 'test').split('\0').filter(Boolean)
  assert.ok(tracked.includes('test/public-release.test.mjs'), 'git ls-files 没列出测试文件')
  const published = new Set(publicFiles(root))
  assert.deepEqual(tracked.filter(file => !published.has(file) && !Object.hasOwn(localOnlyTestFiles, file)), [])
  assert.deepEqual(Object.keys(localOnlyTestFiles).filter(file => published.has(file)), [])
})

test('privacy diagnostics locate private material without echoing it', () => {
  const values = [userInfo().username.toUpperCase(), homedir(), '~/' + '.dsh' + '-launcher/private.txt', '~/' + 'Wh' + 'ale/private.txt', '\u4e3b\u4eba说：测试', 'person' + '@' + 'mail.example', 'gh' + 'p_' + 'a1B2c3D4'.repeat(5), 'apiKey = "' + 'aB2_'.repeat(12) + '"']
  for (const value of values) {
    const findings = privacyFindings(Buffer.from('safe\n' + value + '\n'), 'sample.txt')
    assert.ok(findings.some(item => item.line === 2), 'private input must fail with a line number')
    assert.ok(findings.every(item => !JSON.stringify(item).includes(value)), 'diagnostics must not print private contents')
  }
})

test('invented home paths and dependency integrity strings are distributable', () => {
  const account = userInfo().username.toLowerCase()
  const invented = ['alice', 'bob', 'charlie'].find(name => !name.includes(account))
  const text = `/Users/${invented}/project\n/home/${invented}/project\n"integrity": "sha512-` + 'aB5x/'.repeat(20) + '=="\n'
  assert.deepEqual(privacyFindings(Buffer.from(text), 'fixtures.txt'), [])
})

test('the conventional git SSH user is not an email, while personal addresses still fail', () => {
  assert.deepEqual(privacyFindings(Buffer.from('git@' + 'github.com:team/repo.git\nssh://git@' + 'github.com/team/repo.git'), 'README.md'), [])
  assert.ok(privacyFindings(Buffer.from('person@' + 'github.com'), 'README.md').some(item => item.rule === 'email'))
  assert.ok(privacyFindings(Buffer.from('https://person@' + 'github.com/team/repo.git'), 'README.md').some(item => item.rule === 'email'))
})

test('public URLs, model identifiers and a fictional protagonist are not private data', () => {
  const data = ['https://github.com/Miint-Sunny/dsh-nai-desk/blob/main/docs/verification-0.2.0-preview.7.md', 'aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s', '\u4e3b\u4eba公在舞台上', 'https://example.org/assets/some/Public-Model-Version-42-Archive-File.tgz']
  assert.deepEqual(privacyFindings(Buffer.from(data.join('\n')), 'README.md'), [])
})

test('hash provenance and obfuscated library tables do not look like credentials', () => {
  const integrity = '"integrity": "sha512-aBcD+/EcG1eGJ235JHSKUPLMNOPgQrsTxYzA1B2C3D4E5F6G7H8I9J0K=="'
  const table = '`kbnafqOjujmd#ulovnfpBmwklmzoldjm!#QfobwfgF`lmlnzqfb`kfp`vwwjmddqbujwzojef#jm@kbswfq.pkbgltMlwbaof'
  assert.deepEqual(privacyFindings(Buffer.from(integrity + '\n' + table), 'library.js'), [])
  const token = ['aB12cD34eF56gH78iJ90kL12', 'mN34oP56qR78sT90uV12'].join('')
  assert.ok(privacyFindings(Buffer.from('const value = "' + token + '"'), 'config.js').some(item => item.rule === 'token-like'))
})

test('the standard base62 alphabet is encoding data', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789'
  assert.deepEqual(privacyFindings(Buffer.from('const alphabet = "' + alphabet + '"'), 'library.js'), [])
})

test('unquoted environment and YAML credentials, Markdown and bare tokens fail', () => {
  const value = ['aB12cD34eF56gH78iJ90kL12', 'mN34oP56qR78sT90uV12'].join('')
  for (const text of ['apiKey: ' + value, 'API_KEY=' + value, '`' + value + '`', value]) {
    assert.ok(privacyFindings(Buffer.from(text), 'example.txt').some(item => item.rule === 'token-like'), 'unquoted credentials must fail')
  }
})

test('binary bytes elsewhere in an archive do not disable token detection', () => {
  const value = ['aB12cD34eF56gH78iJ90kL12', 'mN34oP56qR78sT90uV12'].join('')
  const archive = Buffer.concat([Buffer.from('const value = "' + value + '"\n'), Buffer.from([0xff])])
  assert.ok(privacyFindings(archive, 'archive').some(item => item.line === 1 && item.rule === 'token-like'))
})

test('an encoded natural-language table is not a random credential', () => {
  const table = ['haoltW259gllqfuboW249', 'ofwpebjolqbosloomlub'].join('')
  assert.deepEqual(privacyFindings(Buffer.from('`' + table + '`'), 'library.js'), [])
})

// The export reads the git index; keep the account's global and system ignore rules out of the fixtures.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' })

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

/** A git checkout with every fixture file added to the index. */
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'release-check-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'source'), destination = join(parent, 'public')
  mkdirSync(join(root, 'lib'), { recursive: true }); mkdirSync(join(root, 'test')); mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'lib/index.js'), 'export const name = "example"\n')
  writeFileSync(join(root, 'test/example.test.mjs'), '/* Synthetic fixture. */\n')
  writeFileSync(join(root, 'docs/private.md'), 'excluded development notes\n')
  writeFileSync(join(root, 'README.md'), '# Example\n')
  const manifest = { version: 1, directory: 'example', sourceFiles: ['test', 'public-files.json'], packageFiles: { '.': ['lib', 'README.md'] } }
  writeFileSync(join(root, 'public-files.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', files: manifest.packageFiles['.'] }))
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  return { root, destination, manifest }
}

/** Rewrite the manifest and the matching npm `files` list after a test changes them. */
function declare(root, manifest) {
  writeFileSync(join(root, 'public-files.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', files: manifest.packageFiles['.'] }))
}

const fixtureFiles = ['README.md', 'lib/index.js', 'package.json', 'public-files.json', 'test/example.test.mjs']

test('exports only files git tracks, leaving built and stray files out', t => {
  const { root, destination, manifest } = fixture(t)
  // Built files that .gitignore excludes, inside a tracked directory and as a whole npm `files` entry, and a file nobody added.
  writeFileSync(join(root, '.gitignore'), 'lib/client.js\ndist/\n')
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist/index.js'), 'export const built = true\n')
  writeFileSync(join(root, 'lib/client.js'), 'export const built = true\n')
  writeFileSync(join(root, 'test/notes.txt'), 'not added to git\n')
  manifest.packageFiles['.'].push('dist')
  declare(root, manifest)
  assert.deepEqual(publicFiles(root), fixtureFiles)
  assert.equal(exportPublic({ root, destination }).files, fixtureFiles.length)
  for (const path of ['dist', 'lib/client.js', 'test/notes.txt']) assert.equal(existsSync(join(destination, path)), false, path)
})

test('a declared entry without tracked files fails unless npm files name an ignored build output', t => {
  const { root, destination, manifest } = fixture(t)
  // A clean clone has no dist/ until npm pack builds it.
  writeFileSync(join(root, '.gitignore'), 'dist/\n')
  manifest.packageFiles['.'].push('dist')
  declare(root, manifest)
  assert.deepEqual(publicFiles(root), fixtureFiles)
  writeFileSync(join(root, '.gitignore'), '')
  assert.throws(() => publicFiles(root), /not an ignored build output: dist$/)
  manifest.packageFiles['.'].pop()
  manifest.sourceFiles.push('docs/new.md')
  declare(root, manifest)
  writeFileSync(join(root, 'docs/new.md'), 'not added to git\n')
  assert.throws(() => exportPublic({ root, destination }), /no file tracked by git: docs\/new\.md$/)
  assert.equal(existsSync(destination), false)
})

test('a directory that is not a git checkout is neither exported nor checked', t => {
  const { root, destination } = fixture(t)
  rmSync(join(root, '.git'), { recursive: true, force: true })
  assert.throws(() => publicFiles(root), /git checkout|tracked by git/)
  assert.throws(() => exportPublic({ root, destination }), /git checkout|tracked by git/)
  assert.equal(existsSync(destination), false)
})

test('exports only declared source and npm files, without Git history', t => {
  const { root, destination } = fixture(t)
  const result = exportPublic({ root, destination })
  assert.equal(result.files, 5)
  assert.equal(readFileSync(join(destination, 'lib/index.js'), 'utf8'), 'export const name = "example"\n')
  assert.equal(existsSync(join(destination, 'docs')), false)
  assert.equal(existsSync(join(destination, '.git')), false)
})

test('rejects a package file list that diverges from the public manifest', t => {
  const { root, destination } = fixture(t)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ files: ['README.md'] }))
  assert.throws(() => exportPublic({ root, destination }), /files.*manifest/i)
  assert.equal(existsSync(destination), false)
})

test('privacy failure leaves no public export and reports the source line', t => {
  const { root, destination } = fixture(t)
  writeFileSync(join(root, 'README.md'), '# Example\n' + userInfo().username + '\n')
  assert.throws(() => exportPublic({ root, destination }), /README\.md:2/)
  assert.equal(existsSync(destination), false)
})

test('refuses to overwrite an existing export', t => {
  const { root, destination } = fixture(t)
  mkdirSync(destination); writeFileSync(join(destination, 'keep'), 'keep\n')
  assert.throws(() => exportPublic({ root, destination }), /exist/i)
  assert.deepEqual(readdirSync(destination), ['keep'])
})

test('rejects tracked symlinks rather than copying outside the selected tree', t => {
  const { root, destination } = fixture(t)
  symlinkSync(join(root, 'docs/private.md'), join(root, 'test/link'))
  git(root, 'add', 'test/link')
  assert.throws(() => exportPublic({ root, destination }), /symlink/i)
  assert.equal(existsSync(destination), false)
})

test('rejects traversal and missing source entries', t => {
  const { root, destination, manifest } = fixture(t)
  for (const entry of ['../private', 'missing.txt']) {
    manifest.sourceFiles = [entry]
    writeFileSync(join(root, 'public-files.json'), JSON.stringify(manifest))
    assert.throws(() => exportPublic({ root, destination }))
  }
})


/** OS adapters are replaced only in a separate process; this test runner stays unchanged. */
function systemIdentityProbe(unavailable = []) {
  const moduleUrl = new URL('../scripts/privacy.mjs', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict'
    import os from 'node:os'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const unavailable = ${JSON.stringify(unavailable)}
    os.hostname = () => {
      if (unavailable.includes('hostname')) throw new Error('unavailable')
      return 'Fixture-Node.local'
    }
    const calls = []
    childProcess.execFileSync = (command, args, options = {}) => {
      calls.push({ command, args, options })
      const key = command.endsWith('scutil') ? args[1] : command.endsWith('id') && args[0] === '-F' ? 'FullName' : ''
      if (unavailable.includes(key)) throw new Error('unavailable')
      const values = { ComputerName: 'Studio Notebook', LocalHostName: 'studio-device', FullName: 'Robin Green' }
      if (!(key in values)) throw new Error('unexpected identity command')
      const output = Buffer.from(values[key] + String.fromCharCode(10))
      return options.encoding && options.encoding !== 'buffer' ? output.toString(options.encoding) : output
    }
    syncBuiltinESMExports()
    const { privacyFindings } = await import(${JSON.stringify(moduleUrl)})
    const text = ['Fixture-Node.local', 'FIXTURE-NODE', 'STUDIO NOTEBOOK', 'STUDIO-DEVICE.local', 'studio-device', 'ROBIN GREEN', 'Robin', 'green', 'unrelated synthetic machine'].join(String.fromCharCode(10))
    const findings = privacyFindings(Buffer.from(text), 'identity-fixture.txt')
    // Check after collection so the optional lookup's catch cannot swallow an assertion.
    for (const { command, args, options } of calls) {
      if (command.endsWith('scutil')) {
        assert.equal(command, '/usr/sbin/scutil')
        assert.ok(['ComputerName', 'LocalHostName'].includes(args[1]))
        assert.deepEqual(args, ['--get', args[1]])
      } else {
        assert.equal(command, '/usr/bin/id')
        assert.deepEqual(args, ['-F'])
      }
      assert.equal(options.timeout, 1000)
    }
    console.log(JSON.stringify(findings.filter(item => item.rule === 'local-system-name').map(item => item.line)))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, 'isolated identity probe must complete')
  return JSON.parse(result.stdout)
}

test('runtime machine names include local suffix variants and ignore case', () => {
  assert.deepEqual(systemIdentityProbe(), [1, 2, 3, 4, 5, 6])
})

for (const [source, expected] of [
  ['hostname', [3, 4, 5, 6]],
  ['ComputerName', [1, 2, 4, 5, 6]],
  ['LocalHostName', [1, 2, 3, 6]],
  ['FullName', [1, 2, 3, 4, 5]],
]) {
  test(`an unavailable ${source} lookup leaves other identity checks active`, () => {
    assert.deepEqual(systemIdentityProbe([source]), expected)
  })
}

test('unavailable identity sources do not make the privacy check fail', () => {
  assert.deepEqual(systemIdentityProbe(['hostname', 'ComputerName', 'LocalHostName', 'FullName']), [])
})

test('account full names match the full phrase rather than common component words', () => {
  assert.deepEqual(systemIdentityProbe(['hostname', 'ComputerName', 'LocalHostName']), [6])
})

test('the published files carry no owner quotations, private directories, addresses or tokens', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  // Account and machine names depend on the machine running the test, so this repository-state check leaves them to `public:check`.
  const portable = new Set(['private-quotation', 'private-directory', 'email', 'token-like'])
  const findings = scanPublic(root).filter(item => portable.has(item.rule))
  assert.deepEqual(findings.map(item => `${item.file}:${item.line} ${item.rule}`), [])
})

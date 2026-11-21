/**
 * 「模型提议另开会话时」这项设置：只认三个值，存档文件的读写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tempDirSync } from './helpers/temp-dir.mjs'
import { readOwnSessionPrefs, writeOwnSessionPrefs, SESSION_CARDS_PREFS_FILE } from '../lib/session-cards-store.js'
import { ownSessionPrefsOf } from '../lib/session-cards-state.js'

test('both configuration guides show the success and conflict response when saving an always choice fails', () => {
  for (const file of ['configuration.md', 'configuration.en.md']) {
    const guide = fs.readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8')
    const examples = [...guide.matchAll(/`(\{[^\n`]+\})`/gu)].flatMap(([, text]) => {
      try { return [JSON.parse(text)] } catch { return [] }
    })
    assert.ok(examples.some(reply => reply.ok === true && reply.notSaved === true), file)
    const conflict = examples.find(reply => reply.ok === false && reply.error?.code === 'ask-not-inheritable')
    assert.ok(conflict && !Object.hasOwn(conflict, 'notSaved'), file)
  }
})

test('both READMEs explain which preference applies after a failed save', () => {
  for (const [file, previous] of [['README.md', /原(有|先|来)?(的)?(偏好|设置)/u], ['README.en.md', /(previous|existing|old) (setting|preference)/iu]]) {
    const readme = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const cardDescription = readme.split(/^- \*\*/mu).find(description => description.includes('propose_session'))
    assert.match(cardDescription, previous, file)
  }
})

test('设置只认询问、总是新建会话、总是在当前会话处理', () => {
  for (const ownSession of ['ask', 'always-new', 'always-here']) assert.deepEqual(ownSessionPrefsOf({ ownSession, extra: 1 }), { ownSession })
  assert.throws(() => ownSessionPrefsOf({ ownSession: 'always' }), /ownSession must be one of ask, always-new, always-here/)
  assert.throws(() => ownSessionPrefsOf({}), /ownSession/)
  assert.throws(() => ownSessionPrefsOf(null), /ownSession/)
})

test('session-cards-prefs 读写：缺省和坏文件都当 ask，合法值往返一致', () => {
  const dir = tempDirSync('dwb-ask-prefs-')
  const file = join(dir, SESSION_CARDS_PREFS_FILE)
  assert.deepEqual(readOwnSessionPrefs(dir), { ownSession: 'ask' })
  fs.writeFileSync(file, '{broken')
  assert.deepEqual(readOwnSessionPrefs(dir), { ownSession: 'ask' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  fs.writeFileSync(file, '{"ownSession":"invalid"}')
  assert.deepEqual(readOwnSessionPrefs(dir), { ownSession: 'ask' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ownSession":"invalid"}')
  writeOwnSessionPrefs(dir, { ownSession: 'always-new' })
  assert.deepEqual(readOwnSessionPrefs(dir), { ownSession: 'always-new' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ownSession: 'always-new' })
  assert.throws(() => writeOwnSessionPrefs(dir, { ownSession: 'bad' }), /ownSession/)
})

test('overlapping preference writes from separate processes each publish their own complete setting', t => {
  const dir = tempDirSync('dwb-ask-overlap-')
  const file = join(dir, SESSION_CARDS_PREFS_FILE)
  const store = new URL('../lib/session-cards-store.js', import.meta.url).href
  const rename = fs.renameSync
  // 当第一个写者已经写完、还没替换目标时，让另一个真实进程也完成一次保存。
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        'const { writeOwnSessionPrefs } = await import(process.argv[1]); writeOwnSessionPrefs(process.argv[2], { ownSession: "always-here" })',
        store, dir], { timeout: 10000 })
      assert.deepEqual(readOwnSessionPrefs(dir), { ownSession: 'always-here' })
    }
    return rename(from, to)
  })
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  syncBuiltinESMExports()
  writeOwnSessionPrefs(dir, { ownSession: 'always-new' })
  assert.deepEqual(readOwnSessionPrefs(dir), { ownSession: 'always-new' })
  assert.deepEqual(fs.readdirSync(dir), [SESSION_CARDS_PREFS_FILE])
})

test('a failed preference replacement cleans its temporary file', () => {
  const dir = tempDirSync('dwb-ask-failed-write-')
  fs.mkdirSync(join(dir, SESSION_CARDS_PREFS_FILE))
  assert.throws(() => writeOwnSessionPrefs(dir, { ownSession: 'always-here' }), /EISDIR|EPERM|EACCES/)
  assert.deepEqual(fs.readdirSync(dir), [SESSION_CARDS_PREFS_FILE])
})

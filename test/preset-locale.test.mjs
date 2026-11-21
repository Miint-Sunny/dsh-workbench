import assert from 'node:assert/strict'
import test from 'node:test'
import { presetLocale } from '../lib/preset-locale.js'

// The loader is the external source of the user's preference; the language decision is real.
const context = preference => ({ get: () => ({ *entries() { yield { options: { id: 'locale', config: { preference } } } } }) })
test('chore138 locale precedence is explicit override, DSH preference, then system language', () => {
  const prior = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
  try {
    process.env.LC_ALL = 'zh_CN.UTF-8'; process.env.LANG = 'en_US.UTF-8'
    assert.equal(presetLocale(context('en'), 'zh'), 'zh')
    assert.equal(presetLocale(context('en')), 'en')
    assert.equal(presetLocale(context('zh-CN')), 'zh')
    assert.equal(presetLocale(context(undefined)), 'zh')
    delete process.env.LC_ALL
    assert.equal(presetLocale(context(undefined)), 'en')
    process.env.LANG = 'zh_TW.UTF-8'
    assert.equal(presetLocale(context(undefined)), 'zh')
    delete process.env.LANG
    assert.equal(presetLocale(context(undefined)), /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en')
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

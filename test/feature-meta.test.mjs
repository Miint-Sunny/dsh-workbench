/** 每个功能行报到用的 id 都要在 FEATURE_META 里，否则 registerFeature 抛错、这一行在 DSH 里挂载失败（feat#148 首次装上时就是这样）。
 *  反过来，FEATURE_META 的每一项也要有宿主模块报到：扫描漏了文件（比如子目录里的 review/index.js，chore#151 查到）或者行已经拿掉，都会在这里报出来。
 *  报到只认原名导入、字面量 id 的调用；注释里提到的不算，别名、回调式的写法直接报错（chore#155 审查）。
 *  有 locale/<行>/zh.json 的行，两处的标题和说明要一致（插件页用语言文件，/api/dsh-workbench.features 用 FEATURE_META）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { FEATURE_META } from '../lib/features.js'

const lib = new URL('../lib/', import.meta.url)
/** lib/ 下的宿主模块，含子目录；client.js 是构建出来的界面包，不算。 */
const hostFiles = readdirSync(lib, { recursive: true }).filter(name => name.endsWith('.js') && name !== 'client.js')
/** 原名从 features.js 导入的那一行；带 as 的别名不算在内。 */
const IMPORT = /^import\s*\{[^}]*\bregisterFeature\b(?!\s+as\b)[^}]*\}\s*from\s*'(?:\.\.?\/)+features\.js';?$/
/** 字面量 id 的报到调用。 */
const CALL = /\bregisterFeature\(\s*(['"])([\w-]+)\1\s*\)/g
/** 写着 registerFeature 的代码行：注释行、原名导入、lib/features.js 里的定义都不算。 */
const lines = hostFiles.flatMap(file => readFileSync(new URL(file, lib), 'utf8').split('\n')
  .map((source, index) => ({ file, line: index + 1, text: source.trim() }))
  .filter(({ file, text }) => /\bregisterFeature\b/.test(text) && !/^(?:\/\/|\/?\*)/.test(text) && !IMPORT.test(text)
    && !(file === 'features.js' && text.startsWith('export function registerFeature(id)'))))
const registered = lines.flatMap(({ file, text }) => [...text.matchAll(CALL)].map(match => ({ file, id: match[2] })))

test('registerFeature 只用原名、字面量 id 调用（下面的核对靠它认出是哪一行）', () => {
  const unrecognized = lines.filter(({ text }) => text.match(/\bregisterFeature\b/g).length !== [...text.matchAll(CALL)].length)
  assert.deepEqual(unrecognized.map(({ file, line }) => `${file}:${line}`), [], '这几行的 registerFeature 认不出是哪一行报到：改成 registerFeature(\'<id>\')，从 ./features.js 原名导入')
})

test('报到的 id 和 FEATURE_META 一一对应', () => {
  const ids = registered.map(({ id }) => id)
  assert.deepEqual(ids.filter(id => FEATURE_META[id] === undefined), [], '报到了却没登记：这一行在 DSH 里会挂载失败，在 lib/features.js 的 FEATURE_META 里补上')
  assert.deepEqual(Object.keys(FEATURE_META).filter(id => !ids.includes(id)), [], '登记了却找不到报到：要么这里漏扫了文件，要么这一行已经拿掉、登记也该删')
  assert.equal(new Set(ids).size, ids.length, '同一个 id 报到了两次')
})

test('有语言文件的行：FEATURE_META 和 locale/<行>/zh.json 的标题、说明一致', () => {
  const mismatched = []
  for (const { id } of registered) {
    const file = new URL(`../locale/${id}/zh.json`, import.meta.url)
    if (!existsSync(file) || FEATURE_META[id] === undefined) continue
    const { meta } = JSON.parse(readFileSync(file, 'utf8'))
    if (meta.title !== FEATURE_META[id].title) mismatched.push(`${id}: title`)
    else if (meta.description !== FEATURE_META[id].description) mismatched.push(`${id}: description`)
  }
  assert.deepEqual(mismatched, [])
})

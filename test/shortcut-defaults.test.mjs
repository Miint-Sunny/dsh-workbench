import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const SOURCE = new URL('../src/client/', import.meta.url).pathname
const APP = process.env.DSH_PROTOCOL_APP ?? process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
const BINARY = join(APP, 'Contents/MacOS/DeepSeek Harness')
const PROTOCOL = join(APP, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-shortcuts/lib/protocol.js')

/** 官方 register() 对每个声明的默认键做的检查，在 App 自己的 Electron 里跑（app.asar 只有它读得了）。 */
const CHECK = `
import(${JSON.stringify(PROTOCOL)}).then(({ bindingIssue, normalizeBinding }) => {
  const rows = JSON.parse(process.env.DWB_DEFAULTS)
  const issues = rows.flatMap((row) => {
    const issue = bindingIssue(normalizeBinding({ code: row.code, modifiers: row.modifiers }, row.platform), row.runtime, row.platform)
    return issue === null ? [] : [{ ...row, issue }]
  })
  process.stdout.write(JSON.stringify(issues))
})
`

/** 源码里写成 'desktop:macos': { code: 'KeyF', modifiers: ['primary'] } 的默认键。 */
function declaredDefaults() {
  const entry = /'(desktop|web):(macos|windows|linux)':\s*\{\s*code:\s*'(\w+)',\s*modifiers:\s*\[([^\]]*)\]/g
  return readdirSync(SOURCE).filter(name => name.endsWith('.js')).flatMap((file) =>
    [...readFileSync(join(SOURCE, file), 'utf8').matchAll(entry)].map(([, runtime, platform, code, modifiers]) => ({
      file, runtime, platform, code, modifiers: modifiers.split(',').map(name => name.trim().replaceAll("'", '')).filter(Boolean),
    })))
}

test('工作台声明的默认键都过得了官方注册时的检查（查不过会抛错，这一行就挂不上）', { skip: existsSync(BINARY) ? false : '这台机器没有 DSH App' }, () => {
  const defaults = declaredDefaults()
  assert.ok(defaults.length >= 5, `只读到 ${defaults.length} 条默认键，写法可能变了`)
  const output = execFileSync(BINARY, ['-e', CHECK], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DWB_DEFAULTS: JSON.stringify(defaults) },
  })
  assert.deepEqual(JSON.parse(output), [])
})

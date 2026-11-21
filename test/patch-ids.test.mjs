/** cordis.patch.yml 插入的行 id 和 profile 里所有行共用一个命名空间；通用 id 会顶掉官方同 id 的行，所以每个 id 都要带包名前缀。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { FEATURE_META } from '../lib/features.js'

test('cordis.patch.yml 的行 id 都带 dsh-workbench 前缀', () => {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const ids = [...text.matchAll(/^    - id: (\S+)$/gm)].map(match => match[1])
  assert.deepEqual(ids, [
    'dsh-workbench-bundle-guard', 'dsh-workbench-bundle-status', 'dsh-workbench-bundle',
    'dsh-workbench', 'dsh-workbench-tasks', 'dsh-workbench-notify', 'dsh-workbench-review',
    'dsh-workbench-split', 'dsh-workbench-rerun', 'dsh-workbench-reply',
    'dsh-workbench-plan', 'dsh-workbench-pages', 'dsh-workbench-find', 'dsh-workbench-organize', 'dsh-workbench-checkpoints', 'dsh-workbench-usage',
    'dsh-workbench-quota',
    'dsh-workbench-keep-awake',
    'dsh-workbench-memory',
    'dsh-workbench-context',
    'dsh-workbench-compaction',
    'dsh-workbench-local-review',
    'dsh-workbench-design',
    'dsh-workbench-mcp',
    'dsh-workbench-approval-rules',
    'dsh-workbench-command-palette',
    'dsh-workbench-attention',
    'dsh-workbench-worktrees',
    'dsh-workbench-new-tab',
    'dsh-workbench-turn-nav',
    'dsh-workbench-session-header',
    'dsh-workbench-browser-viewport',
    'dsh-workbench-git-commands',
    'dsh-workbench-workspace-trust',
    'dsh-workbench-presets',
    'dsh-workbench-preset-switch',
    'dsh-workbench-tool-discovery',
    'dsh-workbench-settings-icons',
    'dsh-workbench-workspace-folders',
    'dsh-workbench-session-cards',
    'dsh-workbench-workspace-guard',
    'dsh-workbench-model-settings',
    'dsh-workbench-opencode-session',
    'dsh-workbench-session-title',
  ])
  for (const id of ids) assert.match(id, /^dsh-workbench(-|$)/)
})

test('切换预设行的包名可解析，插件页可按这个名字加载中英文说明', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const name = patch.match(/^    - id: dsh-workbench-preset-switch\n      name: '([^']+)'$/m)?.[1]
  assert.equal(name, '@miint-sunny/dsh-workbench/preset-switch')
  assert.ok(existsSync(new URL(import.meta.resolve(name))), `缺少宿主入口 ${name}`)
  const meta = lang => JSON.parse(readFileSync(new URL(import.meta.resolve(`${name}/locale/${lang}.json`)), 'utf8')).meta
  const zh = meta('zh'), en = meta('en')
  assert.equal(zh.title, '切换 Agent 预设')
  assert.deepEqual(zh, FEATURE_META['preset-switch'])
  assert.equal(en.title, 'Switch agent preset')
  assert.ok(en.description.trim())
})

test('plugins.row.config 的键「包名#行 id」指向 cordis.patch.yml 里真有的行', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const ids = new Set([...patch.matchAll(/^    - id: (\S+)$/gm)].map(match => match[1]))
  const dir = new URL('../src/client/', import.meta.url)
  const keys = readdirSync(dir).filter(name => name.endsWith('.js'))
    .flatMap(name => [...readFileSync(new URL(name, dir), 'utf8').matchAll(/name: 'plugins\.row\.config', key: '([^']+)'/g)].map(match => match[1]))
  assert.ok(keys.length > 0)
  for (const key of keys) {
    const [pkg, row] = key.split('#')
    assert.equal(pkg, '@miint-sunny/dsh-workbench')
    assert.ok(ids.has(row), `${key} 指向的行 id 不在 cordis.patch.yml 里`)
  }
})

// Default activation and actual schema filtering are exercised in runtime-presets.test.mjs.

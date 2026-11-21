import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const sourceRoot = new URL('../src/', import.meta.url)
const pageRoots = new URL('../src/client/', import.meta.url)

/** 清单里没有、但有意保留的变量：登记在这里并写明原因，其余一律失败。 */
const KNOWN_MISSING = new Map([
  ['--dsw-alias-font-mono', '字体，不是颜色；写法都带了 ui-monospace 回落'],
  ['--dsw-font-mono', '字体，不是颜色；写法都带了 ui-monospace 回落'],
  ['--dsw-alias-text-selection-background', '回落是系统的 Highlight；DSH 没有对应的选区底色变量'],
])

/** 从清单文件读出 DSH 声明过的 --dsw-* 变量名。 */
export function loadKnownVariables(text) {
  return new Set(text.split('\n').map(line => line.trim()).filter(line => line.startsWith('--dsw-')))
}

/**
 * 找出源码里引用了、清单里没有的 --dsw-* 变量。`--dsw-alias-*`、`--dsw-alias-${x}` 这类前缀不算变量名。
 * @param {string} source 源码文本。
 * @param {Set<string>} known DSH 声明过的变量名。
 * @returns {string[]} 不存在的变量名（去重、排序）。
 */
export function unknownVariables(source, known) {
  const used = new Set(source.match(/--dsw-[a-z0-9]+(?:-[a-z0-9]+)*(?![a-z0-9-])/g) ?? [])
  return [...used].filter(name => !known.has(name)).sort()
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) yield* sourceFiles(url)
    else if (/\.(?:js|mjs|css)$/.test(entry.name)) yield url
  }
}

const known = loadKnownVariables(readFileSync(new URL('./fixtures/dsw-variables.txt', import.meta.url), 'utf8'))

test('变量清单取自 DSH 且有主要的背景、文字、状态变量', () => {
  for (const name of ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-mask-1', '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary', '--dsw-alias-link', '--dsw-alias-label-primary-foreground']) {
    assert.ok(known.has(name), name)
  }
  assert.ok(known.size > 300)
})

test('找不存在的变量：前缀和带模板的写法不算，错拼的算', () => {
  const sample = new Set(['--dsw-alias-bg-base'])
  assert.deepEqual(unknownVariables('a{background:var(--dsw-alias-bg-base)} /* --dsw-alias-* */ `--dsw-alias-${x}`', sample), [])
  assert.deepEqual(unknownVariables('color:var(--dsw-alias-label-on-accent, #fff)', sample), ['--dsw-alias-label-on-accent'])
  assert.deepEqual(unknownVariables('x:var(--dsw-alias-bg-base-2)', sample), ['--dsw-alias-bg-base-2'])
})

test('源码里引用的每个 --dsw-* 变量都在 DSH 的变量清单里', () => {
  const problems = []
  for (const url of sourceFiles(sourceRoot)) {
    for (const name of unknownVariables(readFileSync(url, 'utf8'), known)) {
      if (!KNOWN_MISSING.has(name)) problems.push(`${url.pathname.split('/src/')[1]}: ${name}`)
    }
  }
  assert.deepEqual(problems, [], '这些变量 DSH 里没有，会一直落到回落色或没有样式；改成清单里真有的，或升级 DSH 后更新 test/fixtures/dsw-variables.txt')
})

test('登记的已知缺失变量仍在源码里用着，没用了就从登记里删掉', () => {
  const all = [...sourceFiles(sourceRoot)].map(url => readFileSync(url, 'utf8')).join('\n')
  const stale = [...KNOWN_MISSING.keys()].filter(name => !unknownVariables(all, known).includes(name))
  assert.deepEqual(stale, [])
})

/** 整页容器：占满主区域的页根。它们不许自己画 --dsw-alias-bg-layer-*，页底由外壳的 --dsw-alias-bg-base 透出来。 */
export const PAGE_ROOTS = ['.dwb-us-page', '.dwb-og-page', '.dwb-attention-page', '.dwb-pg-tab', '.dwb-pg-preview', '.dwb-pg-panel', '.dwb-nt-root']

/**
 * 样式文本里选择器的最后一段等于 `root` 的规则，哪些画了 bg-layer 背景。
 * @param {string} text 含样式的源码文本。
 * @param {string} root 页根的类选择器。
 * @returns {{found: number, painted: string[]}} 找到几条规则，和其中画了 layer 的声明。
 */
export function pageRootRules(text, root) {
  let found = 0
  const painted = []
  for (const [, head, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = head.split(',').map(part => part.trim().split(/\s+/).at(-1))
    if (!selectors.some(last => last === root || last.startsWith(root + ':') || last.startsWith(root + '['))) continue
    found += 1
    for (const declaration of body.split(';')) {
      if (/^\s*background(?:-color|-image)?\s*:/.test(declaration) && declaration.includes('--dsw-alias-bg-layer-')) painted.push(declaration.trim())
    }
  }
  return { found, painted }
}

test('整页容器的判断：画 layer 的报出来，别的不报', () => {
  assert.deepEqual(pageRootRules('.dwb-x-page{height:100%;background:var(--dsw-alias-bg-layer-1);color:red}', '.dwb-x-page').painted, ['background:var(--dsw-alias-bg-layer-1)'])
  assert.equal(pageRootRules('body[data-ds-dark-theme] .dwb-x-page{background-color:var(--dsw-alias-bg-layer-2)}', '.dwb-x-page').painted.length, 1)
  assert.equal(pageRootRules('.dwb-x-page{height:100%} .dwb-x-card{background:var(--dsw-alias-bg-layer-1)}', '.dwb-x-page').painted.length, 0)
  assert.deepEqual(pageRootRules('.dwb-x-page{background:var(--dsw-alias-bg-base)}', '.dwb-x-page'), { found: 1, painted: [] })
})

test('整页容器不画 --dsw-alias-bg-layer-*', () => {
  const files = readdirSync(pageRoots).filter(name => name.endsWith('.js')).map(name => [name, readFileSync(new URL(name, pageRoots), 'utf8')])
  for (const root of PAGE_ROOTS) {
    let found = 0
    const painted = []
    for (const [name, text] of files) {
      const result = pageRootRules(text, root)
      found += result.found
      painted.push(...result.painted.map(declaration => `${name} ${root}: ${declaration}`))
    }
    assert.ok(found > 0, `${root} 在源码里找不到，页根清单要跟着改`)
    assert.deepEqual(painted, [], '页底用外壳的底（不画，或用 --dsw-alias-bg-base）；卡片、面板才用 layer-1')
  }
})

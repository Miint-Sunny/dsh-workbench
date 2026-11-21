/**
 * 拆包：从现有整包的行和源码生成按用途拆分的七个小包，再连同整包打成八个 tgz（`npm run packs`）。
 * 整包仍由 scripts/build-client.mjs 单独构建，它的 tgz 就是在仓库根直接 `npm pack` 的那份。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { gunzipSync } from 'node:zlib'
import { officialRowGrant } from '../lib/official-rows.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fullName = '@miint-sunny/dsh-workbench'
const rowPrefix = 'dsh-workbench'
const bundleId = name => name.split('/').at(-1)
const generated = '.workbench-packs'
const read = path => readFileSync(join(root, path), 'utf8')
const readJson = path => JSON.parse(read(path))
const json = value => JSON.stringify(value, null, 2) + '\n'

function bundlePatchHeader(name, rootId) {
  const id = bundleId(name)
  return `- insert:
    - id: ${id}-bundle-guard
      name: '${name}/bundle-guard'
      group: true
      config: { bundle: ${id} }
    - id: ${id}-bundle-status
      name: '${name}/bundle-guard'
      inject: [${id}.bundle-state]
      config: { bundle: ${id}, report: true }
    - id: ${id}-bundle
      name: cordis:group
      group: true
      inject: [${id}.bundle-allowed]
      config: []
- id: ${id}-bundle
  insert:
    - id: ${rootId}
      name: '${name}'
`
}

/** 组外等本包许可的 DSH 自带行：一段只有 `- id: <行>` 和 `inject: [dsh-workbench.<行>-allowed]` 两行（official-rows.js）。 */
const officialSegment = /^- id: ([\w-]+)\n {2}inject: \[dsh-workbench\.\1-allowed\]\n/gm

/**
 * 读整包补丁：功能组里的行，和组外等许可的 DSH 自带行。别的写法一律报错。
 * @param {string} text 整包的 cordis.patch.yml。
 * @returns {{rows: Map<string, {id: string, module: string, flags?: string}>, official: string[]}} 功能行（含根行），和组外等许可的 DSH 自带行的 id。
 */
function readRows(text) {
  const header = bundlePatchHeader(fullName, rowPrefix)
  const content = text.split('\n').filter(line => line.trim() && !line.startsWith('#')).join('\n') + '\n'
  if (!content.startsWith(header)) throw new Error('unsupported Workbench bundle guard')
  const children = content.slice(header.length)
  const pattern = /^    - id: ([\w-]+)\n      name: [\'"]?([\w@/-]+)[\'"]?\n(      disabled: (?:true|false)\n)?/gm
  const rows = new Map([[rowPrefix, { id: rowPrefix, module: fullName }]])
  for (const [, id, module, flags = ''] of children.matchAll(pattern)) {
    if (rows.has(id)) throw new Error(`duplicate source row: ${id}`)
    rows.set(id, { id, module, flags })
  }
  const rest = children.replace(pattern, '')
  const official = [...rest.matchAll(officialSegment)].map(match => match[1])
  if (rest.replace(officialSegment, '').trim() || rows.size === 1) throw new Error('unsupported Workbench patch structure')
  for (const id of official) if (official.indexOf(id) !== official.lastIndexOf(id)) throw new Error(`duplicate official row: ${id}`)
  return { rows, official }
}

/**
 * 核对组外等许可的 DSH 自带行和清单 `officialRows`（功能行 → 它顶替的 DSH 自带行）一一对上。
 * @param {string[]} official readRows 读出的 DSH 自带行。
 * @param {Map<string, object>} rows 功能行。
 * @param {Record<string, string[]>} officialRows 清单里的对应。
 */
function checkOfficialRows(official, rows, officialRows) {
  for (const feature of Object.keys(officialRows)) {
    if (!rows.has(`${rowPrefix}-${feature}`)) throw new Error(`official rows for unknown row: ${feature}`)
  }
  exactCoverage(official, Object.values(officialRows).flat(), 'official row')
}

function exactCoverage(actual, claimed, kind) {
  const all = new Set(actual)
  const pending = new Set(all)
  for (const item of claimed) {
    if (!all.has(item)) throw new Error(`unknown ${kind}: ${item}`)
    if (!pending.delete(item)) throw new Error(`duplicate ${kind}: ${item}`)
  }
  if (pending.size) throw new Error(`missing ${kind}: ${[...pending].join(', ')}`)
}

/**
 * 每个功能行在插件页上的名字和说明：取这一行语言文件 `locale/<行>/<语言>.json` 的 meta；没有语言文件的行
 * 取清单 `shared.titles`。中英文的名字和说明都要是非空字符串，因为单装包 README 的「做什么」列取说明。
 * 两边都有、两边都没有、给不存在的行写名字、缺名字或缺说明都报错。
 * @returns {Map<string, {zh: {title: string, description: string}, en: {title: string, description: string}}>} 行（不带包名前缀）到名字和说明。
 */
function resolveTitles(manifest) {
  const titles = manifest.shared.titles ?? {}
  const features = Object.values(manifest.packs).flatMap(pack => pack.rows)
  for (const row of Object.keys(titles)) {
    if (!features.includes(row)) throw new Error(`title for unknown row: ${row}`)
  }
  return new Map(features.map(row => {
    const path = `locale/${row}/zh.json`
    const hasLocale = existsSync(join(root, path))
    if (hasLocale && titles[row]) throw new Error(`title for ${row} is already in ${path}`)
    const meta = lang => hasLocale ? readJson(`locale/${row}/${lang}.json`).meta : titles[row]?.[lang]
    const entry = { zh: meta('zh'), en: meta('en') }
    const filled = value => typeof value === 'string' && value.trim() !== ''
    for (const lang of ['zh', 'en']) {
      if (!filled(entry[lang]?.title)) throw new Error(`no title for row: ${row}`)
      if (!filled(entry[lang].description)) throw new Error(`no description for row: ${row} (${lang})`)
    }
    return [row, entry]
  }))
}

function clientOrder() {
  const body = read('scripts/build-client.mjs').match(/^const ORDER = \[\n([\s\S]*?)^\]\n/m)?.[1]
  if (!body) throw new Error('whole-package client order has moved')
  return body.trimEnd().split('\n').map(line => {
    const path = line.match(/^  '([^']+)',$/)?.[1]
    if (!path) throw new Error('unsupported whole-package client order')
    return path
  })
}

function extractHelpers(sources, locations) {
  const helpers = []
  for (const [path, names] of Object.entries(locations)) {
    let source = sources.get(path)
    for (const name of names) {
      if (!/^\w+$/u.test(name)) throw new Error(`invalid client helper: ${name}`)
      const pattern = new RegExp(`^(?:export )?(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'gm')
      const matches = [...source.matchAll(pattern)]
      if (matches.length !== 1) throw new Error(`cannot locate client helper ${name} in ${path}`)
      const [match] = matches
      const doc = source.slice(0, match.index).match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n$/)?.[0] ?? ''
      const segment = doc + match[0]
      helpers.push(segment.trimEnd())
      source = source.replace(segment, '')
    }
    sources.set(path, source)
  }
  return helpers.join('\n\n')
}

function clientMain(source, rows, code, name) {
  const definitions = new Set([...code.matchAll(/^(?:export )?const ([A-Z][\w]*_(?:INJECT|ZH|EN))\s*=/gm)].map(match => match[1]))
  const ui = /^const FEATURE_UI = \{\n([\s\S]*?)^\}/m
  if (!ui.test(source)) throw new Error('whole-package feature UI has moved')
  return source.replace(ui, (_, body) => {
    const kept = body.trimEnd().split('\n').filter(line => {
      const id = line.match(/^  (?:'([\w-]+)'|([\w-]+)):/)?.slice(1).find(Boolean)
      if (!id) throw new Error('unsupported feature UI entry')
      return rows.includes(id)
    })
    return `const FEATURE_UI = {\n${kept.join('\n')}\n}`
  }).replace(/\.\.\.([A-Z][\w]*_(?:INJECT|ZH|EN))(?:,[ \t]*)?/g, (spread, id) => definitions.has(id) ? spread : '')
    .replaceAll("'@miint-sunny/dsh-workbench'", `'${name}'`)
}

function clientBundle(order, sources, pack, name, helpers) {
  const files = order.filter(path => pack.client.has(path))
  const declarations = files.filter(path => path !== 'src/client/main.js').map(path => sources.get(path)).join('\n')
  const parts = files.map(path => {
    let source = sources.get(path)
    if (path === 'src/client/main.js') source = clientMain(source, pack.rows, declarations, name)
    return [path, source.replaceAll('api/dsh-workbench.features', `api/${bundleId(name)}.features`)
      .replaceAll("style.dataset.plugin = 'dsh-workbench'", `style.dataset.plugin = '${bundleId(name)}-shared'`)
      .replaceAll("locale: '@miint-sunny/dsh-workbench'", `locale: '${name}'`)
      .replaceAll("'@miint-sunny/dsh-workbench#", `'${name}#`)]
  })
  parts.unshift(['shared helpers', helpers])
  const body = parts.map(([path, source]) => `  // ---- ${path} ----\n${source.split('\n')
    .filter(line => !/^import\s.+\sfrom\s.+$/.test(line))
    .map(line => line.replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/, ''))
    .map(line => line ? '  ' + line : '').join('\n')}`).join('\n')
  const output = `/** ${name} 的浏览器端：由 scripts/build-packs.mjs 从 src/client 生成，不要手改。 */
window.__ModuleLoader__.load({
  id: '${name}',
  factory: require => {
  'use strict'
  const React = require('react')
  const ReactDOM = require('react-dom')
  const ui = require('@deepseek-ai/dsh-client-ui-primitives')
  const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
${body}
  return { inject: INJECT, apply: applyClient }
  },
})
`
  new Script(output, { filename: name + '/lib/client.js' })
  return output
}

function staticImports(source) {
  const imports = [...source.matchAll(/^import(?=[\s{*'"])(?:\s*(['"])([^'"]+)\1|[\s\S]*?\bfrom\s*(['"])([^'"]+)\3)/gm)]
    .map(match => match[2] ?? match[4])
  const reexports = [...source.matchAll(/^export\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*(['"])([^'"]+)\1/gm)]
    .map(match => match[2])
  return [...imports, ...reexports]
}

function hostFiles(pack, full, name) {
  const assets = new Map()
  const peers = new Set(['@deepseek-ai/cordis'])
  for (const path of pack.lib) {
    // .mjs：会话迁移的小进程和核对脚本，由宿主另起进程运行，不经 import
    if (!/^lib\/(?:[\w-]+\/)*[\w-]+\.m?js$/u.test(path)) throw new Error(`invalid lib path: ${path}`)
    let source = read(path)
    for (const spec of staticImports(source)) {
      if (spec.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(path), spec))
        if (!pack.lib.has(target)) throw new Error(`${name} missing lib dependency: ${path} imports ${target}`)
      } else if (!spec.startsWith('node:')) {
        peers.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))
      }
    }
    if (path === 'lib/index.js') source = source.replace("name = '@miint-sunny/dsh-workbench'", `name = '${name}'`)
      .replaceAll('/api/dsh-workbench.features', `/api/${bundleId(name)}.features`)
    assets.set(path, source)
  }
  const peerDependencies = Object.fromEntries([...peers].map(peer => {
    const range = full.peerDependencies[peer]
    if (!range) throw new Error(`${name} needs an undeclared peer: ${peer}`)
    return [peer, range]
  }))
  const peerDependenciesMeta = Object.fromEntries(Object.keys(peerDependencies)
    .filter(peer => full.peerDependenciesMeta?.[peer]).map(peer => [peer, full.peerDependenciesMeta[peer]]))
  return { assets, peerDependencies, peerDependenciesMeta }
}

/** 带有改写代码的小包，沿用整包对应语言的第三方声明。 */
function thirdPartyNotice(assets) {
  if (![...assets.values()].some(source => source.includes('README「第三方来源」'))) return undefined
  const zh = read('README.md').match(/^## 第三方来源\n[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0]
  const en = read('README.en.md').match(/^## Third-party sources\n[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0]
  if (!zh || !en) throw new Error('README files have no 第三方来源 or Third-party sources section')
  return { zh: zh.trimEnd(), en: en.trimEnd() }
}

/** 小包的双语安装文档：功能行由拆包清单生成，设置和限制取清单中的用户说明。 */
function packReadme({ name, pack, full, rows, titles, rootMeta, notice, lang }) {
  const zh = lang === 'zh'
  const docs = pack.readme[lang]
  const repository = full.homepage.replace(/#.*$/, '')
  const off = row => rows.get(`${rowPrefix}-${row}`).flags.includes('disabled: true')
  const cell = text => text.replaceAll('|', '\\|')
  const table = pack.rows.map(row => {
    const { title, description } = titles.get(row)[lang]
    return `| \`${rowPrefix}-${row}\` | ${cell(title)} | ${cell(description)} | ${off(row) ? zh ? '停用' : 'Disabled' : zh ? '启用' : 'Enabled'} |`
  })
  const lines = [
    `# ${name}`, '',
    zh ? '[English](README.en.md)' : '[中文](README.md)', '',
    zh ? `DSH 工作台的「${pack.title.zh}」单装包，在「插件」页显示为「${rootMeta.title}」。版本 ${full.version}，仅包含下表中的功能。`
      : `The ${pack.title.en} package of DSH Workbench, shown as “${rootMeta.title}” on the Plugins page. Version ${full.version}; includes only the features below.`, '',
    zh ? '## 使用要求' : '## Requirements', '',
    zh ? `要求 DSH 桌面端 \`${full.engines.dsh}\`。目前只支持 macOS；Windows 还不支持。安装 tgz 无需构建。`
      : `Requires DSH desktop \`${full.engines.dsh}\`. Currently supports macOS only; Windows is not supported yet. Installing a tgz requires no build.`, '',
    zh ? '## 安装' : '## Installation', '',
    zh ? `目前尚未发布到 npm。到 [GitHub Releases](${repository}/releases) 下载 tgz，保存到本机后，在 DSH「插件」页选择「添加插件」，填写文件的绝对路径。也可完全退出 DSH 后使用 App 自带的 dsh：`
      : `Not published to npm yet. Download the tgz from [GitHub Releases](${repository}/releases) and save it locally, then open Plugins → Add plugin in DSH and enter its absolute path. Alternatively, fully quit DSH and use the App-bundled dsh:`, '',
    '```sh', `dsh plugin --profile desktop add /absolute/path/${name.replace(/^@/, '').replace('/', '-')}-${full.version}.tgz`, '```', '',
    zh ? `发布到 npm 后，在同一入口填写 \`${name}\`，或执行 \`dsh plugin --profile desktop add ${name}\`。安装后确认「插件」页中的行已加载。`
      : `After npm publication, enter \`${name}\` in the same dialog, or run \`dsh plugin --profile desktop add ${name}\`. Confirm that its rows have loaded on the Plugins page.`, '',
    zh ? '## 更新和卸载' : '## Updating and uninstalling', '',
    zh ? '按 npm 包名安装后可在「插件」页更新。本地 tgz 没有版本更新按钮：先卸载，再添加新版 tgz 的绝对路径。'
      : 'An installation by npm name can be updated on the Plugins page. A local tgz has no version update button: remove it, then add the absolute path of the new tgz.', '',
    zh ? `在「插件」页移除此包，或完全退出 DSH 后执行 \`dsh plugin --profile desktop remove ${name}\`。更换前备份 profile 和工作台数据；卸载不等于删除已有数据。`
      : `Remove the package on the Plugins page, or fully quit DSH and run \`dsh plugin --profile desktop remove ${name}\`. Back up your profile and workbench data first; uninstalling does not mean deleting stored data.`, '',
    zh ? '## 功能行' : '## Feature rows', '',
    zh ? '每项功能可单独启用或停用。'
      : 'Each feature can be enabled separately.', '',
    zh ? '| 行 ID | 名称 | 做什么 | 默认行开关 |' : '| Row ID | Name | What it does | Default row switch |',
    '| --- | --- | --- | --- |', ...table, '',
    zh ? `另有两行不是功能：「${rootMeta.title}」（\`${bundleId(name)}-root\`）加载此包的界面；\`${bundleId(name)}-bundle-status\` 在「插件」页报告混装冲突。`
      : `Two other rows are not features: “${rootMeta.title}” (\`${bundleId(name)}-root\`) loads this package’s interfaces; \`${bundleId(name)}-bundle-status\` reports installation conflicts on the Plugins page.`, '',
    zh ? '## 设置' : '## Settings', '',
    zh ? '在「插件」页相应行的「配置」中设置；部分功能也提供独立设置页。'
      : 'Use Configure on the relevant plugin row; some features also have their own settings page.', '',
    ...docs.settings.map(value => '- ' + value), '',
    zh ? '## 已知限制' : '## Known limitations', '',
    zh ? `不能和整包 \`${fullName}\` 同时装。它们使用相同的功能行 ID；混装时相关功能行不加载，请移除冲突包后重新加载 profile。七个单装包之间可以组合安装。`
      : `Cannot be installed with the full package \`${fullName}\`: they share feature row IDs. Conflicting packages do not load their feature rows. Remove the conflict and reload the profile. The seven smaller packages can be combined with each other.`, '',
    ...docs.limitations.map(value => '- ' + value), '',
    zh ? '完整功能说明见工作台整包随附的 README。'
      : 'For full feature details, see the README supplied with the full Workbench package.', '',
    zh ? '## 问题反馈' : '## Feedback', '',
    zh ? `在 [GitHub Issues](${full.bugs.url}) 报告问题。熟人试用时，也可以直接联系提供插件的人。请附 DSH App 版本、包名和版本、macOS 版本及芯片、操作步骤、实际与预期结果，以及未加载的行和完整报错或截图。不要提交密钥、令牌、凭据或私人聊天。`
      : `Report problems through [GitHub Issues](${full.bugs.url}). During private testing, you can also contact the person who provided the plugin. Include the DSH App version, package name and version, macOS version and chip, steps, actual and expected results, unloaded rows and full errors or screenshots. Do not include keys, tokens, credentials or private conversations.`, '',
    zh ? '## 许可证' : '## License', '',
    `${full.license}; [LICENSE](LICENSE).`,
  ]
  if (notice) lines.push('', notice[lang])
  return lines.join('\n') + '\n'
}

function createProduct(pack, rows, full, order, sources, helpers, titles, officialRows) {
  const { name } = pack
  // Small packages do not own Code mode; preserve their opt-in discovery row.
  rows = new Map(rows)
  const discovery = rows.get('dsh-workbench-tool-discovery')
  if (discovery) rows.set(discovery.id, { ...discovery, flags: '      disabled: true\n      config: { presets: [standard] }\n' })
  if (!full.license) throw new Error('the whole package has no license')
  const { assets, peerDependencies, peerDependenciesMeta } = hostFiles(pack, full, name)
  assets.set('lib/client.js', clientBundle(order, sources, pack, name, helpers))
  const exports = Object.fromEntries(Object.entries(full.exports).filter(([key]) =>
    ['.', './client', './bundle-guard', './cordis.patch.yml', './package.json', './locale/en.json', './locale/zh.json'].includes(key) ||
    pack.rows.includes(key.split('/')[1])))
  // 插件页上这个包的名字和说明：名字是整包的名字加小包的用途，说明只列自己的功能行。
  const fullMeta = lang => readJson(`locale/${lang}.json`).meta
  const rowList = lang => pack.rows.map(row => titles.get(row)[lang].title).join(lang === 'zh' ? '、' : ', ')
  const packMeta = {
    zh: { title: `${fullMeta('zh').title} · ${pack.title.zh}`, description: `${fullMeta('zh').title}按用途拆出的小包：${rowList('zh')}。不能和整包同时装。` },
    en: {
      title: `${fullMeta('en').title} · ${pack.title.en}`,
      description: `${fullMeta('en').title} split package: ${rowList('en')}. Cannot be installed together with the full ${fullMeta('en').title} package.`,
    },
  }
  for (const value of Object.values(exports)) {
    const path = (value.default ?? value).slice(2)
    if (!path.startsWith('locale/')) continue
    const locale = readJson(path)
    const lang = path.match(/\/(en|zh)\.json$/)?.[1]
    if (path === `locale/${lang}.json`) locale.meta = { ...locale.meta, ...packMeta[lang] }
    assets.set(path, json(locale))
  }
  if (pack.rows.includes('tool-discovery')) for (const lang of ['zh', 'en']) {
    const path = `locale/tool-discovery/${lang}.json`
    exports[`./tool-discovery/locale/${lang}.json`] = './' + path
    assets.set(path, json({ meta: titles.get('tool-discovery')[lang] }))
  }
  const description = `DSH 工作台的「${pack.title.zh}」小包：${rowList('zh')}。不能和整包 ${fullName} 同时装。`
  // Small packages contain their generated client; preset configuration docs belong to the full package.
  const files = readJson('public-files.json').packageFiles['.'].filter(entry => !entry.startsWith('docs/'))
  assets.set('package.json', json({
    name, version: full.version, publishConfig: full.publishConfig, description, license: full.license,
    repository: full.repository, bugs: full.bugs, homepage: full.homepage,
    type: full.type, main: full.main, exports, files, engines: full.engines, dsh: full.dsh, peerDependencies,
    ...Object.keys(peerDependenciesMeta).length ? { peerDependenciesMeta } : {},
  }))
  const patch = [bundlePatchHeader(name, bundleId(name) + '-root')]
  for (const row of rows.values()) {
    const feature = row.id.slice(rowPrefix.length + 1)
    if (!pack.rows.includes(feature)) continue
    if (row.module !== `${fullName}/${feature}` || !exports['./' + feature]) throw new Error(`missing export for row: ${row.id}`)
    patch.push(`    - id: ${row.id}\n      name: '${name}/${feature}'\n${row.flags}`)
  }
  // 顶替 DSH 自带行的功能行在这个包里时，组外照整包让那一行等许可，许可用这个包自己的名字。
  for (const [feature, ids] of Object.entries(officialRows)) {
    if (pack.rows.includes(feature)) for (const id of ids) patch.push(`- id: ${id}\n  inject: [${officialRowGrant(bundleId(name), id)}]\n`)
  }
  assets.set('cordis.patch.yml', patch.join(''))
  assets.set('LICENSE', read('LICENSE'))
  assets.set('NOTICE', read('NOTICE'))
  const notice = thirdPartyNotice(assets)
  for (const [lang, path] of [['zh', 'README.md'], ['en', 'README.en.md']]) {
    const rootMeta = JSON.parse(assets.get(`locale/${lang}.json`)).meta
    assets.set(path, packReadme({ name, pack, full, rows, titles, rootMeta, notice, lang }))
  }
  for (const value of Object.values(exports)) {
    const path = (value.default ?? value).slice(2)
    if (!assets.has(path)) throw new Error(`${name} missing export file: ${path}`)
  }
  for (const entry of files) {
    if (!assets.has(entry) && ![...assets.keys()].some(path => path.startsWith(entry + '/'))) throw new Error(`${name} has nothing for files entry: ${entry}`)
  }
  return { name, assets }
}

function assertGenerated(output) {
  if (existsSync(output) && !existsSync(join(output, generated))) throw new Error('output is not a generated pack directory')
}

/** 用 staged 整体换掉 output；换不进去时把原来的 output 放回去。两者要在同一个文件系统里。 */
function replaceDirectory(staged, output) {
  const previous = staged + '-previous'
  if (existsSync(output)) renameSync(output, previous)
  try {
    renameSync(staged, output)
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, output)
    throw error
  }
  rmSync(previous, { recursive: true, force: true })
}

function writeProducts(products, output) {
  assertGenerated(output)
  mkdirSync(dirname(output), { recursive: true })
  const staging = mkdtempSync(join(dirname(output), '.packs-'))
  try {
    for (const { name, assets } of products) for (const [path, source] of assets) {
      const target = join(staging, name, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
    writeFileSync(join(staging, generated), 'Generated by scripts/build-packs.mjs\n')
    replaceDirectory(staging, output)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 校验清单并把七个小包写成目录，整包的构建入口和文件不参与写入。
 * @param {{output: string, manifest?: object, patch?: string}} options 输出目录（不存在，或是以前生成的）、拆包清单和整包补丁的内容（默认读仓库里的 cordis.patch.yml）。
 * @returns {{name: string, dir: string}[]} 七个小包的名字和目录，按清单顺序。
 */
export function buildPacks({ output, manifest = readJson('scripts/packs.json'), patch = read('cordis.patch.yml') }) {
  if (!output) throw new Error('buildPacks needs an output directory')
  const full = readJson('package.json')
  const { rows, official } = readRows(patch)
  const officialRows = manifest.officialRows ?? {}
  checkOfficialRows(official, rows, officialRows)
  const order = clientOrder()
  const groups = Object.entries(manifest.packs)
  exactCoverage(rows.keys(), [...manifest.shared.rows, ...(manifest.fullOnlyRows ?? []), ...groups.flatMap(([, pack]) => pack.rows.map(row => rowPrefix + '-' + row))], 'row')
  // 只在整包里的行（fullOnlyRows）自己的网页文件列在 fullOnlyClient：算作已归属，不进任何单装包。
  exactCoverage(order, [...manifest.shared.client, ...(manifest.fullOnlyClient ?? []), ...groups.flatMap(([, pack]) => pack.client)], 'client file')
  const titles = resolveTitles(manifest)
  const sources = new Map(order.map(path => [path, read(path)]))
  const helpers = extractHelpers(sources, manifest.shared.helpers)
  const products = groups.map(([slug, pack]) => {
    if (!/^[a-z0-9-]+$/u.test(slug)) throw new Error(`invalid pack name: ${slug}`)
    return createProduct({
      ...pack, name: fullName + '-' + slug,
      lib: new Set([...manifest.shared.lib, ...pack.lib]),
      client: new Set([...manifest.shared.client, ...pack.client]),
    }, rows, full, order, sources, helpers, titles, officialRows)
  })
  writeProducts(products, output)
  return products.map(({ name }) => ({ name, dir: join(output, name) }))
}

/**
 * 列出 npm pack 出的 tgz 里的文件。只认普通文件和目录两种条目，别的类型（长路径的 PAX 头之类）直接报错。
 * @param {Buffer} archive tgz 的内容。
 * @returns {{path: string, data: Buffer}[]} 每个文件的路径（带 package/ 前缀）和内容，按包里的顺序。
 */
export function listTarball(archive) {
  const tar = gunzipSync(archive)
  const entries = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const text = (start, length) => header.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '')
    const size = Number.parseInt(text(124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size)) throw new Error('unsupported tar entry size')
    const type = text(156, 1) || '0'
    const prefix = text(345, 155)
    const path = (prefix ? prefix + '/' : '') + text(0, 100)
    const start = offset + 512
    offset = start + Math.ceil(size / 512) * 512
    if (type === '5') continue
    if (type !== '0') throw new Error(`unsupported tar entry type ${type}: ${path}`)
    entries.push({ path, data: tar.subarray(start, start + size) })
  }
  return entries
}

/**
 * 核对一个 tgz：条目都在 package/ 下，文件正好是预期的那些，package.json 的名字和版本对得上。
 * @param {{name: string, version: string, files: string[]}} expected 包名、版本、相对包根的全部文件。
 * @param {{path: string, data: Buffer}[]} entries listTarball 的结果。
 */
export function verifyTarball({ name, version, files }, entries) {
  const outside = entries.filter(entry => !entry.path.startsWith('package/')).map(entry => entry.path)
  if (outside.length) throw new Error(`${name}.tgz has entries outside package/: ${outside.join(', ')}`)
  const actual = new Set(entries.map(entry => entry.path.slice('package/'.length)))
  const missing = files.filter(path => !actual.has(path))
  if (missing.length) throw new Error(`${name}.tgz is missing files: ${missing.join(', ')}`)
  const wanted = new Set(files)
  const unexpected = [...actual].filter(path => !wanted.has(path))
  if (unexpected.length) throw new Error(`${name}.tgz has unexpected files: ${unexpected.join(', ')}`)
  const pkg = JSON.parse(entries.find(entry => entry.path === 'package/package.json').data)
  if (pkg.name !== name) throw new Error(`${name}.tgz has package name ${pkg.name}`)
  if (pkg.version !== version) throw new Error(`${name}.tgz has version ${pkg.version}, expected ${version}`)
}

/** base 下 dir 里的全部文件（posix 相对路径）。npm 总会丢掉的 .DS_Store 不算。 */
function filesIn(base, dir) {
  return readdirSync(join(base, dir), { recursive: true })
    .map(path => posix.join(dir, path.split(sep).join('/')))
    .filter(path => !path.endsWith('.DS_Store') && statSync(join(base, path)).isFile())
}

/** 整包 tgz 应有的文件：package.json 的 files 展开，加上 npm 总会带的 package.json 和 LICENSE。 */
function fullFiles(full) {
  const files = new Set(['package.json', 'LICENSE'])
  for (const entry of full.files) {
    if (statSync(join(root, entry)).isDirectory()) for (const path of filesIn(root, entry)) files.add(path)
    else files.add(entry)
  }
  return [...files]
}

/** 离线打包。npm 用隔离的 HOME、配置和缓存，不读用户的 npmrc，不跑生命周期脚本。 */
function npmPack(dir, destination, home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)))
  Object.assign(env, {
    HOME: home, npm_config_userconfig: join(home, 'npmrc'), npm_config_cache: join(home, 'cache'),
    npm_config_offline: 'true', npm_config_update_notifier: 'false',
  })
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))
  return join(destination, pack.filename)
}

/**
 * `npm run packs`：按 src/client 重新生成整包的 lib/client.js，生成七个小包，把整包和小包离线打成八个 tgz，
 * 逐个核对文件、名字和版本，全部对上才整体换进 output。
 * @param {{output?: string, manifest?: object}} [options] 输出目录（默认 .local/packs；不存在，或是以前生成的）和拆包清单。
 * @returns {{name: string, file: string, bytes: number, files: number}[]} 八个 tgz：整包在前，小包按清单顺序。
 */
export function buildTarballs({ output = join(root, '.local/packs'), manifest = readJson('scripts/packs.json') } = {}) {
  assertGenerated(output)
  execFileSync(process.execPath, [join(root, 'scripts/build-client.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] })
  const full = readJson('package.json')
  mkdirSync(dirname(output), { recursive: true })
  const staging = mkdtempSync(join(dirname(output), '.packs-'))
  try {
    const packed = join(staging, 'tgz')
    mkdirSync(packed)
    const home = join(staging, 'npm')
    const sources = [{ name: fullName, dir: root, files: fullFiles(full) },
      ...buildPacks({ output: join(staging, 'dirs'), manifest }).map(({ name, dir }) => ({ name, dir, files: filesIn(dir, '') }))]
    const results = sources.map(({ name, dir, files }) => {
      const file = npmPack(dir, packed, home)
      const entries = listTarball(readFileSync(file))
      verifyTarball({ name, version: full.version, files }, entries)
      return { name, file: basename(file), bytes: statSync(file).size, files: entries.length }
    })
    writeFileSync(join(packed, generated), 'Generated by scripts/build-packs.mjs\n')
    replaceDirectory(packed, output)
    return results.map(result => ({ ...result, file: join(output, result.file) }))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packs = buildTarballs(process.argv[2] ? { output: resolve(process.argv[2]) } : {})
  for (const { file, bytes, files } of packs) console.log(`${file}  ${bytes} 字节  ${files} 个文件`)
}

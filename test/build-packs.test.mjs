/**
 * 拆包的测试：清单生成七个小包目录（行、导出、共用片段、LICENSE 和 README），漏行、重行、
 * 漏文件、没有名字的行在写入前报错；`npm run packs` 一条命令出八个 tgz（整包和七个小包），
 * 每个 tgz 里正好是运行要的文件加 LICENSE、README，版本、engines、许可跟整包一样；出包前后
 * 整包的 lib/client.js 和直接 `npm pack` 的 tgz 逐字节不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPacks, listTarball, verifyTarball } from '../scripts/build-packs.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const load = path => readFileSync(join(root, path), 'utf8')
const manifest = JSON.parse(load('scripts/packs.json'))
const full = JSON.parse(load('package.json'))
const configurationDocs = ['docs/configuration.md', 'docs/configuration.en.md']
const smallNames = Object.keys(manifest.packs).map(slug => '@miint-sunny/dsh-workbench-' + slug)

function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), 'dwb-packs-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/** 仓库里一个目录下的全部文件（相对仓库根），npm 总会丢掉的 .DS_Store 不算。 */
function walk(dir) {
  return readdirSync(join(root, dir), { recursive: true })
    .map(path => dir + '/' + path)
    .filter(path => !path.endsWith('.DS_Store') && statSync(join(root, path)).isFile())
}
const pathsOf = entries => entries.map(entry => entry.path.replace(/^package\//, '')).sort()
const fileOf = (entries, path) => entries.find(entry => entry.path === 'package/' + path)?.data.toString('utf8')
/** 功能行在插件页上的名字：有语言文件取 meta.title，没有的取清单 titles。 */
const rowTitle = (row, lang) => existsSync(join(root, `locale/${row}/${lang}.json`))
  ? JSON.parse(load(`locale/${row}/${lang}.json`)).meta.title
  : manifest.shared.titles[row][lang].title

test('小包在插件页上的名字和说明只讲自己的功能行，不照抄整包', t => {
  const output = join(scratch(t), 'packs')
  const fullMeta = lang => JSON.parse(load(`locale/${lang}.json`)).meta
  for (const { name, dir } of buildPacks({ output })) {
    const pack = manifest.packs[name.slice('@miint-sunny/dsh-workbench-'.length)]
    for (const lang of ['zh', 'en']) {
      const { title, description } = JSON.parse(readFileSync(join(dir, `locale/${lang}.json`), 'utf8')).meta
      assert.equal(title, `${fullMeta(lang).title} · ${pack.title[lang]}`)
      assert.notEqual(description, fullMeta(lang).description, `${name} ${lang}`)
      for (const row of pack.rows) assert(description.includes(rowTitle(row, lang)), `${name} ${lang} ${row}`)
    }
    assert.match(JSON.parse(readFileSync(join(dir, 'locale/zh.json'), 'utf8')).meta.description, /不能和整包同时装。$/)
    assert.match(JSON.parse(readFileSync(join(dir, 'locale/en.json'), 'utf8')).meta.description, /Cannot be installed together with the full Workbench package\.$/)
  }
})

test('builds seven standalone packages from every row and preserves disabled flags', t => {
  const output = join(scratch(t), 'packs')
  const products = buildPacks({ output })
  assert.deepEqual(products.map(({ name }) => name), smallNames)
  const featureRows = patch => [...patch.split('\n  insert:\n')[1].matchAll(/^    - id: (\S+)$/gm)].slice(1).map(match => match[1])
  const fullRows = featureRows(load('cordis.patch.yml'))
  const fullOnlyRows = ['dsh-workbench-presets', 'dsh-workbench-preset-switch']
  assert.deepEqual(manifest.fullOnlyRows, fullOnlyRows)
  const packedRows = []
  for (const { name, dir } of products) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, name)
    assert.equal(pkg.version, full.version)
    assert.deepEqual(pkg.engines, full.engines)
    assert.equal(pkg.license, full.license)
    assert.deepEqual(pkg.files, full.files.filter(entry => !configurationDocs.includes(entry)))
    assert.deepEqual(pkg.repository, full.repository)
    assert.deepEqual(pkg.bugs, full.bugs)
    assert.equal(pkg.homepage, full.homepage)
    assert.equal(pkg.publishConfig.access, 'public')
    assert.match(pkg.description, /不能和整包 @miint-sunny\/dsh-workbench 同时装/)
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(readFileSync(join(dir, 'LICENSE'), 'utf8'), load('LICENSE'))
    assert(existsSync(join(dir, 'README.md')))
    assert(existsSync(join(dir, 'README.en.md')))
    for (const value of Object.values(pkg.exports)) assert(existsSync(join(dir, value.default ?? value)))
    for (const row of fullOnlyRows) {
      const feature = row.slice('dsh-workbench-'.length)
      assert(!Object.keys(pkg.exports).some(key => key.split('/')[1] === feature), name + ' exports ' + feature)
      assert(!existsSync(join(dir, 'locale', feature)), name + ' includes locale/' + feature)
      assert(!readdirSync(join(dir, 'lib')).some(file => file === feature + '.js' || file.startsWith(feature + '-')), name + ' includes lib/' + feature)
    }
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, new RegExp('id: ' + name.split('/').at(-1) + '-root\\n      name: \'' + name + '\'\\n'))
    assert.match(patch, new RegExp('name: cordis:group\n      group: true\n      inject: \\[' + name.split('/').at(-1) + '\\.bundle-allowed\\]'))
    assert.equal(pkg.exports['./bundle-guard'].default, './lib/bundle-guard.js')
    packedRows.push(...featureRows(patch))
    const client = readFileSync(join(dir, 'lib/client.js'), 'utf8')
    const host = readFileSync(join(dir, 'lib/index.js'), 'utf8')
    assert(client.includes("id: '" + name + "'"))
    assert(client.includes("register('" + name + "'"))
    assert(client.includes("style.dataset.plugin = '" + name.split('/').at(-1) + "-shared'"))
    assert(client.includes("'api/" + name.split('/').at(-1) + ".features'"))
    assert(host.includes("path: '/api/" + name.split('/').at(-1) + ".features'"))
    assert(!client.includes("'api/dsh-workbench.features'"))
    // 单装包的网页只认自己的名字：行的键、locale、打开插件页都要换成小包名（换法见 build-packs.mjs 的 clientBundle）。
    assert.deepEqual(client.match(/@miint-sunny\/dsh-workbench(?=['#`])/g) ?? [], [], name + ' 的网页里还留着整包的名字')
    assert.equal([...client.matchAll(/function fetchJson\(/g)].length, 1)
    execFileSync(process.execPath, ['--check', join(dir, 'lib/client.js')])
  }
  assert.deepEqual(packedRows.sort(), fullRows.filter(id => !fullOnlyRows.includes(id)).sort())
  const essentials = join(output, '@miint-sunny/dsh-workbench-essentials')
  assert.match(readFileSync(join(essentials, 'cordis.patch.yml'), 'utf8'),
    /id: dsh-workbench-tool-discovery\n      name: '@miint-sunny\/dsh-workbench-essentials\/tool-discovery'\n      disabled: true/)
  const checks = readFileSync(join(output, '@miint-sunny/dsh-workbench-checkpoints/lib/client.js'), 'utf8')
  assert(checks.includes('dsh-workbench-checkpoints#dsh-workbench-checkpoints'))
  assert(!checks.includes('function applyUsage('))
  assert(existsSync(join(output, '@miint-sunny/dsh-workbench-review/lib/git-commands.js')))
})

test('「设置」小包带模型设置和 OpenCode 会话 ID 两行、lib/model-settings 的全部宿主文件和网页部分；别的小包都没有', t => {
  const output = join(scratch(t), 'packs')
  const hosts = walk('lib/model-settings')
  assert.equal(hosts.length, 8)
  for (const { name, dir } of buildPacks({ output })) {
    const settings = name === '@miint-sunny/dsh-workbench-settings'
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    for (const row of ['model-settings', 'opencode-session']) {
      assert.equal(patch.includes(`    - id: dsh-workbench-${row}\n      name: '${name}/${row}'\n`), settings, `${name} ${row}`)
      for (const lang of ['zh', 'en']) assert.equal(existsSync(join(dir, `locale/${row}/${lang}.json`)), settings, `${name} ${row} ${lang}`)
    }
    for (const path of hosts) assert.equal(existsSync(join(dir, path)), settings, `${name} ${path}`)
    const client = readFileSync(join(dir, 'lib/client.js'), 'utf8')
    assert.equal(client.includes('function applyModelSettings('), settings, name)
    assert.equal(client.includes("'model-settings': (app) => applyModelSettings(app)"), settings, name)
  }
})

test('整包补丁在组外让 DSH 自带的首条起名（session-title-llm）等工作台的许可，「导航」小包写自己的许可，别的小包没有这一段', t => {
  assert.deepEqual(manifest.officialRows, { 'session-title': ['session-title-llm'] })
  assert.match(load('cordis.patch.yml'), /^- id: session-title-llm\n {2}inject: \[dsh-workbench\.session-title-llm-allowed\]$/m)
  assert.doesNotMatch(load('cordis.patch.yml'), /^- id: session-title-llm\n {2}disabled: true$/m)
  const output = join(scratch(t), 'packs')
  for (const { name, dir } of buildPacks({ output })) {
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    const navigation = name === '@miint-sunny/dsh-workbench-navigation'
    assert.equal(/^- id: session-title-llm$/m.test(patch), navigation, name)
    if (navigation) assert.match(patch, /^- id: session-title-llm\n {2}inject: \[dsh-workbench-navigation\.session-title-llm-allowed\]$/m)
  }
})

test('组外等许可的那一段：少了、多了、写成 disabled、许可名字不对，或清单里写了不存在的行，都在写入前报错', t => {
  const output = join(scratch(t), 'packs')
  const patch = load('cordis.patch.yml')
  const segment = /^- id: session-title-llm\n {2}inject: \[dsh-workbench\.session-title-llm-allowed\]\n/m
  assert.match(patch, segment)
  assert.throws(() => buildPacks({ output, patch: patch.replace(segment, '') }), /unknown official row: session-title-llm/)
  assert.throws(() => buildPacks({ output, patch: patch + '- id: agent-default-model\n  inject: [dsh-workbench.agent-default-model-allowed]\n' }), /missing official row: agent-default-model/)
  assert.throws(() => buildPacks({ output, patch: patch.replace(segment, '- id: session-title-llm\n  disabled: true\n') }), /unsupported Workbench patch structure/)
  assert.throws(() => buildPacks({ output, patch: patch.replace(segment, '- id: session-title-llm\n  inject: [dsh-workbench.bundle-allowed]\n') }), /unsupported Workbench patch structure/)
  assert.throws(() => buildPacks({ output, patch: patch.replace(segment, '- id: session-title-llm\n  config: {}\n') }), /unsupported Workbench patch structure/)
  const unknownRow = structuredClone(manifest)
  unknownRow.officialRows = { 'session-titles': ['session-title-llm'] }
  assert.throws(() => buildPacks({ output, manifest: unknownRow }), /official rows for unknown row: session-titles/)
  const unlisted = structuredClone(manifest)
  delete unlisted.officialRows
  assert.throws(() => buildPacks({ output, manifest: unlisted }), /missing official row: session-title-llm/)
  assert(!existsSync(output))
})

test('feat#217 工作台 0.2.0：套件 r12b 已装 0.1.0，插件同步只比版本号，同号不更新；README 的安装示例和迁移说明跟着改', () => {
  assert.equal(full.version, '0.2.0')
  for (const file of ['README.md', 'README.en.md']) {
    const versions = [...load(file).matchAll(/miint-sunny-dsh-workbench-(\d+\.\d+\.\d+)\.tgz/g)].map(match => match[1])
    assert.ok(versions.length >= 2, file)
    assert.deepEqual([...new Set(versions)], [full.version], file)
  }
  const migration = (file, heading) => load(file).split(heading)[1]?.split('\n## ')[0] ?? ''
  for (const [file, heading] of [['README.md', '## 从独立插件迁移'], ['README.en.md', '## Migrating from the standalone plugins']]) {
    const section = migration(file, heading)
    for (const part of ['@miint-sunny/dsh-model-settings', '@miint-sunny/dsh-session-title-headtail', 'session-title-headtail', 'dsh-workbench-model-settings', 'dsh-workbench-session-title']) {
      assert.ok(section.includes(part), `${file}: ${part}`)
    }
  }
})

test('fix#226 说明跟着改：停用「会话标题」后 DSH 自带的首条消息生成标题回来，不再写「不会回到」', () => {
  // docs/development.md 不进公开仓库（public-files.json），只在有它的检出里一起核对。
  const files = ['README.md', 'README.en.md', 'scripts/packs.json', 'locale/session-title/zh.json', 'locale/session-title/en.json', 'docs/development.md']
  const texts = Object.fromEntries(files.filter(file => existsSync(join(root, file))).map(file => [file, load(file)]))
  for (const [file, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /不会回到 DSH 自带的模型起名|不会自己回来|does not bring back DSH's built-in model naming/, file)
  }
  assert.match(JSON.parse(texts['locale/session-title/zh.json']).meta.description, /关闭后恢复 DSH 自带的首条消息生成标题。$/)
  assert.match(JSON.parse(texts['locale/session-title/en.json']).meta.description, /Turn it off to restore DSH's built-in first-message titles\.$/)
  assert.match(texts['README.md'], /停用这一行后，DSH 自带的首条消息生成标题随即回来/)
  assert.match(texts['README.en.md'], /When this row is off, DSH's built-in first-message titles come back right away/)
})

test('an omitted or repeated feature row fails before generating packages', t => {
  const output = join(scratch(t), 'packs')
  const missing = structuredClone(manifest)
  missing.packs.essentials.rows = missing.packs.essentials.rows.filter(row => row !== 'tool-discovery')
  assert.throws(() => buildPacks({ output, manifest: missing }), /missing row.*dsh-workbench-tool-discovery/)
  const duplicate = structuredClone(manifest)
  duplicate.packs.settings.rows.push('context')
  assert.throws(() => buildPacks({ output, manifest: duplicate }), /duplicate row.*dsh-workbench-context/)
  assert(!existsSync(output))
})

test('漏了宿主文件、网页文件，或者功能行没有名字：写入前报错，不生成半套包', t => {
  const output = join(scratch(t), 'packs')
  const noStore = structuredClone(manifest)
  noStore.packs.usage.lib = noStore.packs.usage.lib.filter(path => path !== 'lib/usage-store.js')
  assert.throws(() => buildPacks({ output, manifest: noStore }),
    /dsh-workbench-usage missing lib dependency: lib\/\w+(-\w+)*\.js imports lib\/usage-store\.js/)
  const noClient = structuredClone(manifest)
  noClient.packs.usage.client = noClient.packs.usage.client.filter(path => path !== 'src/client/usage.js')
  assert.throws(() => buildPacks({ output, manifest: noClient }), /missing client file: src\/client\/usage\.js/)
  // git-commands 没有自己的语言文件，README 里的名字只能来自清单的 titles。
  const untitled = structuredClone(manifest)
  delete untitled.shared.titles['git-commands']
  assert.throws(() => buildPacks({ output, manifest: untitled }), /no title for row: git-commands/)
  // 单装包 README 的「做什么」列取说明，英文缺说明或说明只有空白，都要在写入前报错。
  const noEnglish = structuredClone(manifest)
  noEnglish.shared.titles['git-commands'].en = { title: 'Commit commands' }
  assert.throws(() => buildPacks({ output, manifest: noEnglish }), /no description for row: git-commands \(en\)/)
  const blank = structuredClone(manifest)
  blank.shared.titles['git-commands'].zh.description = '  '
  assert.throws(() => buildPacks({ output, manifest: blank }), /no description for row: git-commands \(zh\)/)
  const stale = structuredClone(manifest)
  stale.shared.titles.usage = { title: '用量', description: '多余的名字' }
  assert.throws(() => buildPacks({ output, manifest: stale }), /title for usage is already in locale\/usage\/zh\.json/)
  assert(!existsSync(output))
})

test('功能行说明里有竖线：单装包 README 转义成 \\|，表格仍是四列', t => {
  const output = join(scratch(t), 'packs')
  const piped = structuredClone(manifest)
  piped.shared.titles['git-commands'].zh.description = '提交 | 推送'
  piped.shared.titles['git-commands'].en.description = 'Commit | push'
  const products = buildPacks({ output, manifest: piped })
  const owner = products.find(({ dir }) => readFileSync(join(dir, 'README.md'), 'utf8').includes('`dsh-workbench-git-commands`'))
  assert(owner, 'a pack carries git-commands')
  for (const [file, text] of [['README.md', '提交 \\| 推送'], ['README.en.md', 'Commit \\| push']]) {
    const line = readFileSync(join(owner.dir, file), 'utf8').split('\n').find(row => row.startsWith('| `dsh-workbench-git-commands` |'))
    assert(line?.includes(' | ' + text + ' | '), file)
    assert.equal(line.split(/(?<!\\)\|/).length, 6, file + ' has four cells')
  }
})

test('tgz 里的文件和预期对不上、名字或版本不一致、有包外路径，都报错', () => {
  const entry = (path, data = '') => ({ path: 'package/' + path, data: Buffer.from(data) })
  const manifestOf = (name, version) => entry('package.json', JSON.stringify({ name, version }))
  const expected = { name: 'dsh-workbench-usage', version: full.version, files: ['package.json', 'LICENSE', 'README.md', 'lib/index.js'] }
  const good = [manifestOf('dsh-workbench-usage', full.version), entry('LICENSE'), entry('README.md'), entry('lib/index.js')]
  assert.doesNotThrow(() => verifyTarball(expected, good))
  assert.throws(() => verifyTarball(expected, good.filter(item => item.path !== 'package/LICENSE')),
    /dsh-workbench-usage.*missing.*LICENSE/)
  assert.throws(() => verifyTarball(expected, [...good, entry('test/usage.test.mjs')]),
    /dsh-workbench-usage.*unexpected.*test\/usage\.test\.mjs/)
  assert.throws(() => verifyTarball(expected, [manifestOf('dsh-workbench-usage', '0.0.9'), ...good.slice(1)]),
    new RegExp(`dsh-workbench-usage.*version 0\\.0\\.9.*${full.version.replaceAll('.', '\\.')}`))
  assert.throws(() => verifyTarball(expected, [manifestOf('dsh-workbench', full.version), ...good.slice(1)]),
    /dsh-workbench-usage.*name dsh-workbench\b/)
  assert.throws(() => verifyTarball(expected, [...good, { path: 'other/x.js', data: Buffer.from('') }]),
    /dsh-workbench-usage.*outside package\/: other\/x\.js/)
})

test('npm run packs：一条命令出八个 tgz；npm run build 的产物和整包 tgz 逐字节不变', async t => {
  const path = scratch(t)
  const npm = args => execFileSync('npm', args, {
    cwd: root,
    env: { ...process.env, HOME: path, npm_config_userconfig: join(path, 'npmrc'), npm_config_cache: join(path, 'cache'), npm_config_offline: 'true' },
    stdio: 'pipe',
  })
  const makeTarball = dir => {
    mkdirSync(dir)
    const [pack] = JSON.parse(npm(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', dir]))
    return readFileSync(join(dir, pack.filename))
  }
  const existingBuild = load('scripts/build-client.mjs')
  npm(['run', 'build'])
  const beforeClient = readFileSync(join(root, 'lib/client.js'))
  const beforeTarball = makeTarball(join(path, 'before'))
  const output = join(path, 'packs')
  npm(['run', 'packs', '--', output])
  const archive = name => `${name.replace(/^@/, '').replace('/', '-')}-${full.version}.tgz`
  const tarballs = Object.fromEntries(['@miint-sunny/dsh-workbench', ...smallNames].map(name =>
    [name, listTarball(readFileSync(join(output, archive(name))))]))

  await t.test('出包前后 npm run build 的产物和整包 tgz 逐字节不变，出来的整包就是直接 npm pack 的那份', () => {
    assert.equal(load('scripts/build-client.mjs'), existingBuild)
    assert.deepEqual(readFileSync(join(root, 'lib/client.js')), beforeClient)
    assert.deepEqual(makeTarball(join(path, 'after')), beforeTarball)
    assert.deepEqual(readFileSync(join(output, archive('@miint-sunny/dsh-workbench'))), beforeTarball)
  })

  await t.test('输出目录里正好八个 tgz，名字都带整包的版本', () => {
    assert.deepEqual(readdirSync(output).filter(file => !file.startsWith('.')).sort(),
      ['@miint-sunny/dsh-workbench', ...smallNames].map(archive).sort())
  })

  await t.test('每个包的 package.json：名字、版本、engines、许可、补丁和整包一致，LICENSE 同一份，只带整包配置文档，不带测试、内部文档或截图', () => {
    for (const [name, entries] of Object.entries(tarballs)) {
      const pkg = JSON.parse(fileOf(entries, 'package.json'))
      assert.equal(pkg.name, name)
      assert.equal(pkg.version, full.version)
      assert.deepEqual(pkg.engines, full.engines)
      assert.equal(pkg.license, 'MIT')
      assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
      assert.equal(fileOf(entries, 'LICENSE'), load('LICENSE'))
      assert(entries.every(item => item.path.startsWith('package/')), name)
      const docs = entries.filter(item => item.path.startsWith('package/docs/')).map(item => item.path.slice('package/'.length)).sort()
      assert.deepEqual(docs, name === full.name ? [...configurationDocs].sort() : [], name)
      const extra = entries.filter(item => /^package\/(?:test|scripts|src)\//.test(item.path) || item.path.endsWith('.png'))
      assert.deepEqual(extra.map(item => item.path).sort(), [], name)
    }
  })

  await t.test('每个小包里正好是清单里的宿主文件、网页脚本和各行的语言文件，加补丁、LICENSE、NOTICE、README', () => {
    for (const [slug, pack] of Object.entries(manifest.packs)) {
      const name = '@miint-sunny/dsh-workbench-' + slug
      const expected = new Set(['package.json', 'LICENSE', 'NOTICE', 'README.md', 'README.en.md', 'cordis.patch.yml', 'lib/client.js',
        ...manifest.shared.lib, ...pack.lib, 'locale/en.json', 'locale/zh.json'])
      for (const row of pack.rows) {
        for (const lang of ['en', 'zh']) if (row === 'tool-discovery' || existsSync(join(root, `locale/${row}/${lang}.json`))) expected.add(`locale/${row}/${lang}.json`)
      }
      assert.deepEqual(pathsOf(tarballs[name]), [...expected].sort(), name)
    }
  })

  await t.test('整包 tgz 包含运行文件、双语配置文档、package.json、README、LICENSE 和补丁', () => {
    const expected = ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE', 'cordis.patch.yml', ...configurationDocs, ...walk('lib'), ...walk('locale')].sort()
    assert.deepEqual(pathsOf(tarballs['@miint-sunny/dsh-workbench']), expected)
  })

  await t.test('整包和七个小包都带同一份 NOTICE：模型设置里改写自 DSH 的代码的出处和 MIT 许可', () => {
    for (const [name, entries] of Object.entries(tarballs)) assert.equal(fileOf(entries, 'NOTICE'), load('NOTICE'), name)
    assert.match(load('NOTICE'), /Copyright \(c\) 2026 DeepSeek/)
  })

  await t.test('整包导出的所有运行时入口都在实际 tgz 内，无需安装时构建', () => {
    const entries = tarballs['@miint-sunny/dsh-workbench']
    const pkg = JSON.parse(fileOf(entries, 'package.json'))
    for (const value of Object.values(pkg.exports)) assert(fileOf(entries, (value.default ?? value).replace(/^\.\//, '')), String(value))
  })

  await t.test('小包的 README 列出每个功能行，写明不能和整包同时装；带改写代码的用量包、设置包附上第三方来源', () => {
    const notice = load('README.md').split('\n').find(line => line.startsWith('- `lib/quota-adapters.js`'))
    assert(notice)
    const modelNotice = load('README.md').split('\n').find(line => line.startsWith('- 「模型设置」'))
    assert(modelNotice)
    const credited = slug => slug === 'usage' || slug === 'settings'
    for (const [slug, pack] of Object.entries(manifest.packs)) {
      const name = '@miint-sunny/dsh-workbench-' + slug
      const readme = fileOf(tarballs[name], 'README.md')
      for (const row of pack.rows) assert(readme.includes('| `dsh-workbench-' + row + '` |'), name + ' ' + row)
      assert.match(readme, /不能和整包 `@miint-sunny\/dsh-workbench` 同时装/)
      assert.equal(readme.includes('## 第三方来源'), credited(slug), name)
      assert.equal(readme.includes(notice), credited(slug), name)
      assert.equal(readme.includes(modelNotice), credited(slug), name)
      const english = fileOf(tarballs[name], 'README.en.md')
      assert.match(readme, /\[English\]\(README.en.md\)/)
      assert.match(english, /\[中文\]\(README.md\)/)
      assert.match(readme, /Windows 还不支持/)
      assert.match(english, /Windows is not supported yet/)
      assert.equal(english.includes('## Third-party sources'), credited(slug), name)
      for (const row of pack.rows) assert(english.includes('| `dsh-workbench-' + row + '` |'), name + ' en ' + row)
      for (const [lang, document] of [['zh', readme], ['en', english]]) {
        const meta = JSON.parse(fileOf(tarballs[name], `locale/${lang}.json`)).meta
        const rootId = name.split('/').at(-1) + '-root'
        const rootLine = document.split('\n').find(line => line.includes('`' + rootId + '`'))
        assert(rootLine?.includes(meta.title), name + ' ' + lang + ' root name')
        assert(document.includes('`' + name.split('/').at(-1) + '-bundle-status`'), name + ' status row')
        for (const row of pack.rows) {
          const entry = existsSync(join(root, `locale/${row}/${lang}.json`))
            ? JSON.parse(load(`locale/${row}/${lang}.json`)).meta : manifest.shared.titles[row][lang]
          const description = entry.description.replaceAll('|', '\\|')
          const tableLine = document.split('\n').find(line => line.startsWith('| `dsh-workbench-' + row + '` |'))
          assert(tableLine?.includes(' | ' + description + ' | '), name + ' ' + lang + ' ' + row + ' description')
        }
      }
    }
    assert.match(fileOf(tarballs['@miint-sunny/dsh-workbench-essentials'], 'README.md'), /\| `dsh-workbench-tool-discovery` \| 工具按需出现 \| .+ \| 停用 \|/)
  })

  await t.test('八个包的中英 README 都写到 GitHub Releases 下载 tgz、到 GitHub Issues 报告问题，不再写等公开仓库开放', () => {
    for (const [name, entries] of Object.entries(tarballs)) {
      for (const file of ['README.md', 'README.en.md']) {
        const document = fileOf(entries, file)
        assert(document.includes('](https://github.com/Miint-Sunny/dsh-workbench/releases)'), name + ' ' + file + ' Releases')
        assert(document.includes('](https://github.com/Miint-Sunny/dsh-workbench/issues)'), name + ' ' + file + ' Issues')
        assert.doesNotMatch(document, /收到 tgz|After receiving a tgz|公开仓库开放后|Once the public repository opens/, name + ' ' + file)
      }
    }
  })
})

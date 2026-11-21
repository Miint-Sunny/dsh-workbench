/**
 * 测试夹具（fix#226）：在 DSH App 自带的 Electron 里（ELECTRON_RUN_AS_NODE）拼一棵真的配置树：
 * DSH 的 Loader、Include（应用补丁）、Group、标题服务（@deepseek-ai/dsh-session-title）、DSH 自带的首条起名
 * （@deepseek-ai/dsh-session-title-first-prompt-llm，基础包里的 session-title-llm 行），再加上工作台补丁里的
 * 守卫、状态行、功能组、会话标题这一行和组外那一段。补丁取自仓库里的 cordis.patch.yml，只留会话标题这一行
 * （别的行的包在这里解析不到），包名换成仓库文件的地址。标题服务要的会话、投影和智能体，首条起名要的模型服务，都是空的替身。
 *
 * 开关会话标题这一行（和插件页一样改这一行的 disabled），每一步等到标题服务的提供方换好（最多 3 秒），记下当时是谁；
 * 标题服务每次注册都记下注册前的提供方，和离这一步开始（开关这一行）过了多少毫秒。输出 JSON：{ runs: [{ name, steps, registers, problems }] }。
 * 环境变量：DWB_REPO 是工作台仓库根，DWB_DIR 是临时目录。
 */
import { registerHooks } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const R = join(dirname(process.execPath), '../Resources/app.asar/dsh/node_modules')
const repo = process.env.DWB_REPO
const dir = process.env.DWB_DIR
const asar = path => pathToFileURL(join(R, path)).href

// 工作台的宿主模块按包名 import DSH 的包；仓库里没有 node_modules，改从 App 安装的位置解析，和 DSH 自己的包是同一份。
const anchor = asar('@deepseek-ai/dsh-session-title/lib/index.js')
const repoUrl = pathToFileURL(repo).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(repoUrl)) return nextResolve(specifier, { ...context, parentURL: anchor })
    return nextResolve(specifier, context)
  },
})

const { Context } = await import(asar('@deepseek-ai/cordis/lib/index.js'))
const { default: Loader, Group } = await import(asar('@deepseek-ai/cordis-plugin-loader/lib/index.js'))
const { default: Include } = await import(asar('@deepseek-ai/cordis-plugin-include/lib/index.js'))
const { default: SessionTitleService } = await import(asar('@deepseek-ai/dsh-session-title/lib/index.js'))
const yaml = await import(asar('js-yaml/index.js'))

const OURS = 'dsh-session-title-headtail'
const OFFICIAL = 'session-title-first-prompt-llm'
const ROW = 'dsh-workbench-session-title'

// 标题服务每次注册：记下注册的提供方、注册前在册的是谁（还在不在收尾）、离这一步开始多少毫秒，抛错时记下原文。
let registers = []
let stepStarted = performance.now()
const sinceStep = () => Math.round((performance.now() - stepStarted) * 10) / 10
const register = SessionTitleService.prototype.register
SessionTitleService.prototype.register = function (provider) {
  const before = this.registration === undefined ? null : { id: this.registration.provider.id, closing: this.registration.closing }
  try {
    const dispose = register.call(this, provider)
    registers.push({ id: provider.id, before, ms: sinceStep() })
    return dispose
  } catch (error) {
    registers.push({ id: provider.id, before, ms: sinceStep(), error: error.message })
    throw error
  }
}

writeFileSync(join(dir, 'host-services.mjs'), `export const name = 'fake-host-services'
export function apply(ctx) {
  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('sessionProjections', { register: async () => ({ dispose() {} }), stateOf: () => undefined })
  ctx.provide('agents', { turnBoundaryOf: () => ({}) })
  ctx.provide('llm', { resolveModelInfo: async () => ({}), stream: async function* () {} })
}
`)

/** 基础包里的三行（照 packages/bundle/base/cordis.patch.yml 的 session-title、session-title-llm）加上替身服务。 */
const BASE = [
  { id: 'host-services', name: pathToFileURL(join(dir, 'host-services.mjs')).href },
  { id: 'session-title', name: asar('@deepseek-ai/dsh-session-title/lib/index.js'), config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
  { id: 'session-title-llm', name: asar('@deepseek-ai/dsh-session-title-first-prompt-llm/lib/index.js'), config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 } },
]

/** 仓库里的工作台补丁：只留会话标题这一行，包名换成仓库文件的地址；mixed 时再插一个同 id 的单装包分组，守卫判成混装。 */
function workbenchPatches(disabledAtBoot, mixed) {
  const local = file => pathToFileURL(join(repo, 'lib', file)).href
  const names = { '@miint-sunny/dsh-workbench/bundle-guard': local('bundle-guard.js'), '@miint-sunny/dsh-workbench/session-title': local('session-title.js') }
  return yaml.load(readFileSync(join(repo, 'cordis.patch.yml'), 'utf8')).map(layer => {
    if (!layer.insert) return layer
    const rows = layer.id === 'dsh-workbench-bundle' ? layer.insert.filter(row => row.id === ROW) : layer.insert
    return { ...layer, insert: rows.map(row => ({ ...row, name: names[row.name] ?? row.name, ...row.id === ROW && disabledAtBoot ? { disabled: true } : {} })) }
  }).concat(mixed ? [{ insert: [{ id: 'dsh-workbench-navigation-bundle', name: 'cordis:group', group: true, inject: ['dsh-workbench-navigation.bundle-allowed'], config: [{ id: ROW, name: names['@miint-sunny/dsh-workbench/session-title'] }] }] }] : [])
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

async function run(name, { disabledAtBoot = false, mixed = false, steps }) {
  registers = []
  stepStarted = performance.now()
  const problems = []
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  ctx.logger.exporter({
    levels: { default: 1 },
    export: message => {
      if (message.level > 1) return
      problems.push({ type: message.type, text: message.args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' ') })
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const file = join(dir, `${name}.yml`)
  writeFileSync(file, yaml.dump(BASE))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href, patches: workbenchPatches(disabledAtBoot, mixed) } })
  await ctx.loader.await()
  const entry = id => [...ctx.loader.entries()].find(item => item.options.id === id)
  const current = () => {
    const registration = ctx.get('sessionTitle')?.registration
    return registration === undefined ? null : { id: registration.provider.id, closing: registration.closing }
  }
  const settle = async (want) => {
    for (let waited = 0; waited < 3000; waited += 10) {
      await ctx.loader.await()
      const now = current()
      if (want === undefined ? true : now?.id === want && !now.closing) break
      await tick(10)
    }
    await tick(30)
    return current()
  }
  const report = [{ step: 'boot', current: await settle(disabledAtBoot || mixed ? OFFICIAL : OURS) }]
  for (const step of steps) {
    stepStarted = performance.now()
    if (step === 'off') await entry(ROW).update({ disabled: true })
    else if (step === 'on') await entry(ROW).update({ disabled: null })
    else if (step === 'off-on') {
      await entry(ROW).update({ disabled: true })
      await entry(ROW).update({ disabled: null })
    } else if (step === 'recheck') await entry('dsh-workbench-bundle-guard').update({}, false, true)
    const want = step === 'off' ? OFFICIAL : step === 'recheck' ? undefined : OURS
    report.push({ step, current: await settle(want) })
  }
  await ctx.fiber.dispose()
  await tick(30)
  return { name, steps: report, registers, problems }
}

const runs = [
  await run('enabled-at-boot', { disabledAtBoot: false, steps: ['off', 'on', 'off', 'on', 'off-on', 'recheck'] }),
  await run('disabled-at-boot', { disabledAtBoot: true, steps: ['on', 'off'] }),
  await run('mixed-install', { mixed: true, steps: [] }),
]
console.log(JSON.stringify({ runs }))

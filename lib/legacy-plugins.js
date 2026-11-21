/**
 * 已并入工作台的独立插件（feat#217）：模型设置（@miint-sunny/dsh-model-settings）和会话标题
 * （@miint-sunny/dsh-session-title-headtail），连同更早的无作用域名字。旧插件没卸、工作台又有了对应的行时，
 * 两边都挂上会撞：设置里两个 models 页、侧栏两个「重新起名」，标题服务第二个注册的提供方直接抛 already registered。
 *
 * 守卫（bundle-guard.js）每次检查时记下同级里没停用的旧插件行；对应的行 apply 第一步问这里，旧插件还在就抛错：
 * 插件页这一行写明原因，旧插件照常工作，工作台其余的行不受影响。同一个包的守卫和各行共用这个模块实例
 * （features.js 的登记处也靠这一点），整包和每个小包各管各的。卸掉旧插件以后要重启才加载，和混装冲突解除时一样，不做热恢复。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */

/** 每一行对应的旧插件包名：先是带作用域的，再是更早的无作用域名字。 */
export const LEGACY_PACKAGES = Object.freeze({
  'model-settings': Object.freeze(['@miint-sunny/dsh-model-settings', 'dsh-model-settings']),
  'opencode-session': Object.freeze(['@miint-sunny/dsh-model-settings', 'dsh-model-settings']),
  'session-title': Object.freeze(['@miint-sunny/dsh-session-title-headtail', 'dsh-session-title-headtail']),
})

/** 这三行在插件页上的名字，和 locale/<行>/zh.json 的 meta.title 一致（test/legacy-plugins.test.mjs 核对）。 */
export const LEGACY_TITLES = Object.freeze({ 'model-settings': '模型设置', 'opencode-session': 'OpenCode 会话 ID', 'session-title': '会话标题' })

const ALL = new Set(Object.values(LEGACY_PACKAGES).flat())

/** 守卫最近一次检查时看到的、没停用的旧插件包名。 */
let present = new Set()

/** 一行（含子组里的行）属于哪个旧插件包；不是旧插件的行时 undefined。 */
function legacyPackageOf(row) {
  if (typeof row.name !== 'string') return undefined
  return [...ALL].find(name => row.name === name || row.name.startsWith(name + '/'))
}

/**
 * 守卫调用：从同级的行里（含子组）找出没停用的旧插件行，按包名记下，替换上一次的记录。
 * @param {readonly {name?: unknown, disabled?: unknown, group?: unknown, config?: unknown}[]} rows 守卫所在那一层的行（ctx.fiber.entry.parent.data）。
 * @returns {string[]} 找到的旧包名，排好序。
 */
export function recordLegacyPlugins(rows) {
  const found = new Set()
  const visit = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object' || row.disabled === true) continue
      const name = legacyPackageOf(row)
      if (name !== undefined) found.add(name)
      if (row.group && Array.isArray(row.config)) visit(row.config)
    }
  }
  visit(rows)
  present = found
  return [...found].sort()
}

/**
 * 并入的行 apply 的第一步：对应的旧插件还装着就抛错，这一行不加载。
 * @param {'model-settings' | 'opencode-session' | 'session-title'} feature 行（不带 dsh-workbench- 前缀）。
 * @throws {Error} 旧插件没停用时，写明这一行、旧包名和怎么办。
 */
export function assertNoLegacyPlugin(feature) {
  const packages = LEGACY_PACKAGES[feature]
  if (packages === undefined) throw new Error(`unknown merged dsh-workbench row: ${feature}`)
  const installed = packages.filter(name => present.has(name))
  if (installed.length === 0) return
  throw new Error(`「${LEGACY_TITLES[feature]}」已并入工作台，旧插件 ${installed.join('、')} 还装着。请在「插件」页卸载它，然后重启 DSH。`)
}

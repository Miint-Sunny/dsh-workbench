import { recordLegacyPlugins } from './legacy-plugins.js'
import { offerOfficialRows, withdrawOfficialRows } from './official-rows.js'

const full = 'dsh-workbench'
const suffix = '-bundle'

function rowIds(rows, ids = new Set()) {
  for (const row of rows) {
    if (typeof row.id === 'string') ids.add(row.id)
    if (row.group && Array.isArray(row.config)) rowIds(row.config, ids)
  }
  return ids
}

/** 比较尚未挂载的同级分组；每个有冲突的包都暂缓挂载。 */
export function workbenchBundleConflict(rows, name) {
  const bundles = new Map()
  for (const row of rows) {
    if (row.name !== 'cordis:group' || !row.id?.endsWith(suffix) || !Array.isArray(row.config)) continue
    const owner = row.id.slice(0, -suffix.length)
    if ((owner === full || owner.startsWith(full + '-')) && row.inject?.includes(owner + '.bundle-allowed')) {
      bundles.set(owner, rowIds(row.config))
    }
  }
  // 兼容还没有分组的整包，供新版小包与已安装的旧整包混用时识别。
  if (!bundles.has(full) && rows.some(row => row.name === full)) {
    bundles.set(full, rowIds(rows.filter(row => row.name?.startsWith(full + '/'))))
  }
  const own = bundles.get(name)
  if (!own) return
  const conflicts = []
  for (const [other, ids] of bundles) {
    if (other === name) continue
    const shared = [...own].filter(id => ids.has(id)).sort()
    if (!shared.length && name !== full && other !== full) continue
    const detail = shared.length ? '，重复的行 ID 为 ' + shared.join('、') : ''
    conflicts.push(`工作台组合包 ${[name, other].sort().join(' 与 ')} 无法同时启用${detail}。`)
  }
  if (conflicts.length) {
    return conflicts.join(' ') + '请在「插件」中保留整包或仅启用互不冲突的小包，然后重启此 profile。'
  }
}

/** 由原生 Loader 在启动及重组配置时调用，功能分组在获得许可前不会登记子行。 */
export function apply(ctx, { bundle, report }) {
  if (report) {
    const { conflict } = ctx.get(bundle + '.bundle-state')
    if (conflict) throw new Error(conflict)
    return
  }
  let current
  let release = []
  async function check() {
    // 已并入工作台的旧插件：只记下，对应的行在自己的 apply 里决定加不加载（legacy-plugins.js）。
    recordLegacyPlugins(ctx.fiber.entry.parent.data)
    // 工作台顶替的 DSH 自带行等本包的许可：没有行认领时由守卫提供（official-rows.js）。
    offerOfficialRows(ctx, bundle, ctx.fiber.entry.parent.data)
    const conflict = workbenchBundleConflict(ctx.fiber.entry.parent.data, bundle)
    // 混装解除后等新进程统一加载，避免热恢复留下只挂载了一部分的工作台。
    if (release.length && (conflict === current || !conflict)) return
    await Promise.all(release.map(dispose => dispose()))
    current = conflict
    release = [ctx.provide(bundle + '.bundle-state', { conflict })]
    if (conflict) ctx.logger.warn('%s', conflict)
    else release.push(ctx.provide(bundle + '.bundle-allowed', true))
  }
  ctx.effect(() => () => withdrawOfficialRows(ctx), `${bundle}: official row grants`)
  // Loader 强制更新 group 行，即使守卫自己的 config 没变，同级配置也可能已重组。
  ctx.on('internal/update', check)
  return check()
}

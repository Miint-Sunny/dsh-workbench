/**
 * 工作台顶替的 DSH 自带行（fix#226）：基础包里的 session-title-llm（DSH 自带的首条消息生成标题）。标题服务同时只接受一个提供方，
 * 所以 DSH 自带的那一行和工作台的「会话标题」轮流运行：整包补丁在组外给它加 `inject: [<包>.<行>-allowed]`，它要等这份许可；
 * 守卫（bundle-guard.js，组外、不能停用）在同级有行要这份许可时提供它，会话标题这一行开着时收回、停用时交还。
 *
 * - 收回许可用 cordis `ctx.provide` 的撤销函数：它返回的 promise 等所有依赖这份许可的 fiber 卸载完才结束，
 *   这时 DSH 自带那一行的提供方已经注销、在途的请求已经收尾。认领方等到这一步再注册自己的提供方。
 * - 交还许可时 DSH 自带的那一行重新挂上。认领方要先注销完自己的提供方再交还（session-title-provider.js 的顺序）。
 * - 守卫重查（同级重组）时只增删要提供的许可，提供着的不撤了再给。守卫卸载（profile 关闭、工作台被移除）以后不再提供；
 *   这时 DSH 自带的那一行跟着整棵树撤，或者等重启后补丁层一起没了。
 *
 * 同一个包的守卫和各行共用这个模块实例（features.js 的登记处也靠这一点），整包和每个小包各管各的。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */

/**
 * 许可的服务名：包名加 `.<DSH 自带行的 id>-allowed`，和功能组的 `<包>.bundle-allowed` 一个写法。
 * @param {string} bundle 包名的最后一段，比如 dsh-workbench、dsh-workbench-navigation。
 * @param {string} id 顶替的 DSH 自带行的 id，比如 session-title-llm。
 * @returns {string} 服务名。
 */
export function officialRowGrant(bundle, id) {
  return `${bundle}.${id}-allowed`
}

/** 每一行的状态：id → { claims, offer?: { owner, provide }, provided?: 撤销函数, withdrawn: 最近一次撤销的 promise }。 */
const slots = new Map()

function slotOf(id) {
  let slot = slots.get(id)
  if (slot === undefined) {
    slot = { claims: 0, offer: undefined, provided: undefined, withdrawn: Promise.resolve() }
    slots.set(id, slot)
  }
  return slot
}

/** 让「提供着没有」和「有人提供、没人认领」对上。 */
function sync(slot) {
  if (slot.offer !== undefined && slot.claims === 0 && slot.provided === undefined) {
    try {
      slot.provided = slot.offer.provide()
    } catch (error) {
      // 守卫已在卸载（profile 关闭、工作台被移除），cordis 不让在它上面再登记：DSH 自带的那一行跟着整棵树撤，不用再交还。
      if (error?.code !== 'INACTIVE_EFFECT') throw error
      slot.offer = undefined
    }
  } else if ((slot.offer === undefined || slot.claims > 0) && slot.provided !== undefined) {
    const withdraw = slot.provided
    slot.provided = undefined
    slot.withdrawn = Promise.resolve(withdraw())
  }
}

/**
 * 守卫每次检查时调用：同级（含子组）里 inject 写着本包许可的行，本包就提供那份许可；不再有行要的就撤回。
 * @param {object} ctx 守卫的插件上下文（许可用它的 ctx.provide 提供，守卫卸载时 cordis 一起撤）。
 * @param {string} bundle 包名的最后一段。
 * @param {readonly object[]} rows 守卫所在那一层的行（ctx.fiber.entry.parent.data）。
 */
export function offerOfficialRows(ctx, bundle, rows) {
  const wanted = new Set()
  const visit = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue
      const inject = Array.isArray(row.inject) ? row.inject : row.inject !== null && typeof row.inject === 'object' ? Object.keys(row.inject) : []
      if (typeof row.id === 'string' && inject.includes(officialRowGrant(bundle, row.id))) wanted.add(row.id)
      if (row.group && Array.isArray(row.config)) visit(row.config)
    }
  }
  visit(rows)
  for (const [id, slot] of slots) {
    if (slot.offer?.owner === ctx && !wanted.has(id)) {
      slot.offer = undefined
      sync(slot)
    }
  }
  for (const id of wanted) {
    const slot = slotOf(id)
    if (slot.offer?.owner === ctx) continue
    const grant = officialRowGrant(bundle, id)
    slot.offer = { owner: ctx, provide: () => ctx.provide(grant, true) }
    sync(slot)
  }
}

/**
 * 守卫卸载时调用：它提供的许可都不再提供，交还许可也不再找它。
 * @param {object} ctx 守卫的插件上下文。
 */
export function withdrawOfficialRows(ctx) {
  for (const slot of slots.values()) {
    if (slot.offer?.owner !== ctx) continue
    slot.offer = undefined
    sync(slot)
  }
}

/**
 * 认领 DSH 自带的一行：撤掉它的许可。没有守卫提供这份许可时（DSH 自带的那一行不归工作台管）马上就绪。
 * @param {string} id DSH 自带行的 id，比如 session-title-llm。
 * @returns {{ ready: Promise<void>, release: () => void }} ready 在 DSH 自带的那一行卸载完时结束；release 交还许可，只算一次。
 */
export function claimOfficialRow(id) {
  const slot = slotOf(id)
  slot.claims += 1
  sync(slot)
  let released = false
  return {
    ready: slot.withdrawn,
    release() {
      if (released) return
      released = true
      slot.claims -= 1
      sync(slot)
    },
  }
}

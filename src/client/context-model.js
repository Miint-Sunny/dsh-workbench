/** 上下文页「自动压缩于」下拉的内容。纯函数，不碰 React。 */

/** 官方默认这一项的 id。选它就是不设线，设置里存 null。 */
export const CONTEXT_OFFICIAL_CHOICE = 'off'

/**
 * 算下拉要列哪些档、现在选中哪一项。线不低于官方线时官方先到，设了也不起作用，所以档位只列到官方线以下，这种设置显示成官方默认。
 * @param {{work: number|null, official: number|null, min: number, step: number, max: number}} input 设的线、官方线、最低档、一档的大小和官方线未知时的上限。
 * @returns {{tiers: number[], selected: string}} 从小到大的档位，和选中项的 id。
 */
export function workLineChoices({ work, official, min, step, max }) {
  const tiers = []
  for (let tier = min; official === null ? tier <= max : tier < official; tier += step) tiers.push(tier)
  const applies = work !== null && (official === null || work < official)
  return { tiers, selected: applies ? String(work) : CONTEXT_OFFICIAL_CHOICE }
}

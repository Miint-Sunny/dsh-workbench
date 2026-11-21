/** 「获取可用模型」：安装包目录和提供商返回的列表合在一起，以及加进来的目录外模型缺哪些数据。 */

/**
 * 合并两份列表。目录里的行在前、按目录顺序，数据用目录的（目录带容量和输入类型，列表接口一般没有）；只在提供商返回里有的排在后面。
 * @param {readonly object[] | undefined} catalog 安装包目录（discoverModels 带 provider 的回答）；自定义的提供商没有。
 * @param {readonly object[] | undefined} live 提供商返回的列表；没查到时 undefined。
 * @param {boolean} acceptsUnlisted 这一家能不能加目录外的模型（目录里的模型协议不统一时不能）。
 * @returns {object[]} 候选，每个带 origin：catalog、provider、both，没有目录时是 endpoint；不能加的带 blocked。
 */
export function mergeCandidates(catalog, live, acceptsUnlisted) {
  const liveIds = new Set((live ?? []).map(model => model.id))
  const catalogIds = new Set((catalog ?? []).map(model => model.id))
  const fromCatalog = (catalog ?? []).map(model => ({ ...model, origin: live === undefined || !liveIds.has(model.id) ? 'catalog' : 'both' }))
  // 没有安装包目录（自定义地址）时整份列表都是向它请求来的，记作 endpoint，不标「仅提供商返回」。
  const onlyLive = (live ?? []).filter(model => !catalogIds.has(model.id)).map(model => ({
    ...model, origin: catalog === undefined ? 'endpoint' : 'provider', ...catalog !== undefined && !acceptsUnlisted ? { blocked: true } : {},
  }))
  return [...fromCatalog, ...onlyLive]
}

/**
 * 目录里的提供商，一行目录外的模型缺上下文窗口或最大输出 token 数：DSH 用这一家的默认值，界面上标「数据不全」。
 * @param {object} model 模型行。
 * @param {ReadonlySet<string> | undefined} catalogIds 安装包目录里这一家的模型 ID；自定义的提供商传 undefined（它的数据本来就由用户填）。
 * @returns {boolean} 数据不全时为 true。
 */
export function modelDataIncomplete(model, catalogIds) {
  if (catalogIds === undefined || catalogIds.has(model.id)) return false
  return typeof model.contextWindow !== 'number' || typeof model.maxTokens !== 'number'
}

/**
 * 列表接口的地址，只用来告诉用户「列表从哪来」。算法照 DSH discovery.ts 的 listingUrl（去掉分页参数），和宿主端 lib/discover.js 的同名函数一致。
 * @param {string} baseURL API 地址。
 * @param {string} api 协议。
 * @returns {string} 地址。
 */
export function listingUrl(baseURL, api) {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  return `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/models`
}

/**
 * 这次失败要不要换一种协议再问：被拒、找不到接口、回答不是列表时换；连不上、超时就不换（换了也连不上，只会多等）。
 * @param {string} message DSH 的报错原文。
 * @returns {boolean} 换的时候为 true。
 */
export function worthAnotherProtocol(message) {
  return /answered (40[0-9])\b|has no model listing|did not answer with JSON|neither a "data" array|no "models" array/.test(message)
}

/** 凭据名的规则，宿主端（discover.js）和页面（src/client/model-settings/ 的 status.js 等，构建时拼进 lib/client.js）共用这一份；移植自 DSH 0.2.1-rc.5 内置模型页（MIT，见 NOTICE 和 README「第三方来源」）。 */

/**
 * 内置页给提供商起凭据名的规则：路由名大写，非字母数字换成 `_`，再加 `_API_KEY`。
 * media look 按这个名字找 key，不能改。
 * @param {string} provider 路由标识符，例如 `minimax-cn`。
 * @returns {string} 凭据名，例如 `MINIMAX_CN_API_KEY`。
 */
export function deriveKeyRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

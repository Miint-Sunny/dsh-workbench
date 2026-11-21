/** API 密钥格式、Provider ID 和 API 地址的判断（凭据名的规则在 lib/model-settings/key-ref.js）；规则照 DSH 0.2.1-rc.5 内置模型页（MIT，见 NOTICE 和 README「第三方来源」）。 */

const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

/**
 * 判断输入框里的 API 密钥能不能保存。空输入不算错：已配置时留空表示保持当前密钥。
 * @param {string} draft 输入框原样的内容。
 * @returns {'keyBlank' | 'keyIllegalCharacters' | undefined} 文案键，能保存时为 undefined。
 */
export function apiKeyFailure(draft) {
  if (draft.length === 0) return undefined
  const value = draft.trim()
  if (value.length === 0) return 'keyBlank'
  const first = value[0]
  const quoted = (first === '"' || first === '\'' || first === '`') && value.length > 1 && value.endsWith(first)
  if (ENV_LINE.test(value) || quoted || !LEGAL_API_KEY.test(value)) return 'keyIllegalCharacters'
  return undefined
}

/** 手工声明的 Provider ID：小写字母开头，可用小写字母、数字和单个短横线分隔。 */
export const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * 判断自定义提供商的 Provider ID。
 * @param {string} route 输入的 ID。
 * @param {readonly string[]} taken 已有的路由标识符。
 * @returns {'customRouteInvalid' | 'customRouteTaken' | undefined} 文案键，可用时为 undefined。
 */
export function routeIdFailure(route, taken) {
  if (route.length === 0) return undefined
  if (!ROUTE_PATTERN.test(route)) return 'customRouteInvalid'
  if (taken.includes(route)) return 'customRouteTaken'
  return undefined
}

/**
 * 按显示名称生成 Provider ID 的建议值：取其中的英文字母和数字，其余换成短横线。
 * 显示名称里没有字母开头的英文部分时返回空串，由用户自己填写。
 * @param {string} name 显示名称。
 * @returns {string} 建议的 ID，可能为空。
 */
export function routeIdFromName(name) {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const start = slug.search(/[a-z]/)
  return start < 0 ? '' : slug.slice(start).replace(/-+$/, '')
}

/**
 * 是否是可解析的 HTTP 或 HTTPS 地址。
 * @param {string} value 地址文本。
 * @returns {boolean} 能用作 API 地址时为 true。
 */
export function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    // URL 构造失败就是地址写错了，调用方按「请输入有效的地址」提示。
    return false
  }
}

/** 各协议在 API 地址后面追加的路径；Anthropic 的 SDK 会补 `/v1/messages`。 */
const REQUEST_SUFFIX = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/v1/messages',
}

/**
 * 预览实际请求地址，写在 API 地址下面。
 * @param {string} baseURL 填写的 API 地址。
 * @param {string} api 协议标识符。
 * @returns {string | undefined} 预览地址；地址无效或协议未知时为 undefined。
 */
export function requestUrlPreview(baseURL, api) {
  const base = baseURL.trim()
  const suffix = REQUEST_SUFFIX[api]
  if (suffix === undefined || !isHttpUrl(base)) return undefined
  return base.replace(/\/+$/, '') + suffix
}

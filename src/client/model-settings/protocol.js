/** API 协议的规则：Gemini API 的两条（照 DSH 0.2.2-rc.2 官方 protocol-rules.ts，MIT，见 NOTICE 和 README「第三方来源」），和自动识别时按什么顺序问。 */

/** Gemini 原生协议的标识符。 */
export const GEMINI = 'google-generative-ai'

/** Gemini API 只接受这四档，参数值和档位同名。 */
const GEMINI_LEVELS = ['minimal', 'low', 'medium', 'high']

/**
 * 这种协议没有密钥就不能用。DSH 照样注册这样的路由，第一次请求才失败，所以页面自己拦。
 * @param {string | undefined} protocol 协议标识符。
 * @returns {boolean} Gemini API 时为 true。
 */
export function protocolNeedsKey(protocol) {
  return protocol === GEMINI
}

/**
 * 这种协议能用的推理档位。
 * @param {string | undefined} protocol 协议标识符。
 * @param {readonly string[]} levels schema 给的全部档位。
 * @returns {{ levels: string[], levelsOnly: boolean }} 能用的档位；levelsOnly 表示参数值必须和档位同名。
 */
export function protocolReasoningLevels(protocol, levels) {
  if (protocol !== GEMINI) return { levels: [...levels], levelsOnly: false }
  return { levels: levels.filter(level => GEMINI_LEVELS.includes(level)), levelsOnly: true }
}

/**
 * 自动识别协议时依次问哪几种。手动选了协议就只问那一种。地址像 Gemini（googleapis.com，或路径以 /v1beta 结尾）先问 Gemini API；
 * 路径里有 anthropic 先问 Anthropic Messages；其余先问 OpenAI Chat Completions。OpenAI Responses 的列表接口和 Chat Completions 相同，不另问。
 * @param {string} baseURL API 地址。
 * @param {readonly string[]} choices schema 给的协议。
 * @param {string} [chosen] 手动选的协议。
 * @returns {string[]} 要问的协议，按顺序。
 */
export function protocolProbeOrder(baseURL, choices, chosen) {
  if (chosen !== undefined) return [chosen]
  let url
  try {
    url = new URL(baseURL)
  } catch {
    // 地址还没写完：按路径文字判断。
    url = { hostname: '', pathname: baseURL }
  }
  const gemini = /(^|\.)googleapis\.com$/i.test(url.hostname) || /\/v1beta\/?$/i.test(url.pathname)
  const anthropic = /anthropic/i.test(baseURL)
  const first = gemini ? GEMINI : anthropic ? 'anthropic-messages' : 'openai-completions'
  const rest = first === 'anthropic-messages' ? ['openai-completions', GEMINI] : ['openai-completions', 'anthropic-messages', GEMINI]
  return [...new Set([first, ...rest])].filter(protocol => choices.includes(protocol))
}

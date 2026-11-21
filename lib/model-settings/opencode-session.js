/**
 * dsh-workbench/opencode-session 行（插件页叫「OpenCode 会话 ID」）：给 OpenCode 的目录外模型补会话 ID 请求头。和模型设置那一行（`@miint-sunny/dsh-workbench/model-settings`）分开，各自能开关：
 * 这一行影响的是真正的模型请求，停用模型页、回到官方页时 OpenCode 的目录外模型照样能用。
 *
 * OpenCode 要求每个请求带 `x-opencode-session`（会话 ID），pi-ai 只在它自己的 opencode、opencode-go 提供商里加
 * （@earendil-works/pi-ai dist/providers/opencode-headers.js 的 withOpenCodeSessionHeader：值是 options.sessionId，已有同名头时不改）。
 * 伴随条目走的是通用协议，所以在 DSH 的 `llm-pi-ai/request-headers` 上补同样的头：只对模型页建的 `opencode--*`、`opencode-go--*` 伴随条目，
 * 认法和页面相同（companion.js 的 ownCompanion），手写的同形条目不补。
 */
import { assertNoLegacyPlugin } from '../legacy-plugins.js'
import { ownCompanion } from './companion.js'

export const name = '@miint-sunny/dsh-workbench/opencode-session'

const HEADER = 'x-opencode-session'
const OPENCODE = new Set(['opencode', 'opencode-go'])
const isOpenCode = origin => OPENCODE.has(origin)

/**
 * 做一个 `llm-pi-ai/request-headers` 的监听：同步、必须调 next，只改这次请求自己的 headers（dsh-llm-pi-ai index.ts:100-114）。
 * @param {(route: string) => unknown} profileOf 读这个 Provider ID 现在的配置；读不到时返回 undefined（就不补）。
 * @returns {(request: { provider: string, sessionId?: string }, headers: Headers, next: () => Headers) => Headers} 监听。
 */
export function opencodeSessionHeader(profileOf) {
  return (request, headers, next) => {
    const sessionId = request.sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0 && !headers.has(HEADER)) {
      const parsed = /^(opencode|opencode-go)--[a-z]+$/.test(request.provider) ? ownCompanion(request.provider, profileOf(request.provider), isOpenCode) : undefined
      if (parsed !== undefined) headers.set(HEADER, sessionId)
    }
    return next()
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  assertNoLegacyPlugin('opencode-session')
  // 每次请求现读 DSH 的设置（同步）：条目在别处被改名、删掉后立刻不再补。
  const profileOf = (route) => {
    try {
      return ctx.get('settings')?.describe().find(view => view.ns === 'llm-pi-ai')?.value?.providers?.[route]
    } catch {
      return undefined
    }
  }
  ctx.on('llm-pi-ai/request-headers', opencodeSessionHeader(profileOf))
}

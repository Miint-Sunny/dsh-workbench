/** dsh-workbench/usage：按需统计的宿主入口，只通过 DSH 已鉴权的 connection 注册路由。 */
import { join } from 'node:path'
import { registerFeature } from './features.js'
import { workbenchDataDir } from './data-dir.js'
import { readUsageConfig } from './usage-config.js'
import { digestSession } from './usage-digest.js'
import { createUsageStore } from './usage-store.js'
import { buildOverview, buildCost } from './usage-overview.js'

export const name = '@miint-sunny/dsh-workbench/usage'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const error = (code, status) => json({ error: { code } }, status)

/** 注册功能和依赖作用域。@param {object} ctx Cordis 上下文。@param {object} options 可选的数据目录覆盖。@returns {void} */
export function apply(ctx, options = {}) {
  const dir = options.dir ?? workbenchDataDir()
  readUsageConfig(dir)
  ctx.effect(() => registerFeature('usage'), '@miint-sunny/dsh-workbench/usage: feature registration')
  ctx.inject(['connection', 'sessionQuery', 'sessions', 'sessionPersistence'], scope => {
    const store = createUsageStore({ dir: join(dir, 'usage'), sessionQuery: scope.sessionQuery, sessionPersistence: scope.sessionPersistence, sessions: scope.sessions, digest: digestSession })
    scope.effect(() => applyUsageRoutes(scope, { store, getConfig: () => readUsageConfig(dir) }), '@miint-sunny/dsh-workbench/usage: routes')
  })
}

/** 注册两条只读路由。@param {object} scope 已鉴权的 connection 作用域。@param {object} options store、getConfig 和可选 now 时钟。@returns {function():void} 注销函数。 */
export function applyUsageRoutes(scope, { store, getConfig, now = Date.now }) {
  const disposers = ['overview', 'cost'].map(kind => scope.connection.fetch.register({
    path: `/api/dsh-workbench.usage.${kind}`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const params = new URL(request.url).searchParams
        const allowed = kind === 'overview' ? ['group'] : ['providers', 'since']
        for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) return error('invalid-query', 400)
        const config = getConfig()
        let options
        if (kind === 'overview') {
          const group = params.get('group') ?? 'all'
          if (!['all', 'other', ...config.groups.map(g => g.id)].includes(group)) return error('invalid-group', 400)
          options = { group, now: now() }
        } else {
          const providers = params.get('providers')?.split(','), text = params.get('since')
          if (!providers?.length || providers.some(p => !/^[\w./-]+$/.test(p)) || text === null || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 8640000000000000) return error('invalid-query', 400)
          options = { providers: [...new Set(providers)], since: Number(text) }
        }
        const digests = await store.refresh(request.signal)
        return json(kind === 'overview' ? { ...buildOverview(digests, config, options), unreadable: store.unreadable() } : buildCost(digests, config, options))
      } catch {
        return error(request.signal.aborted ? 'request-aborted' : 'usage-read-failed', request.signal.aborted ? 499 : 500)
      }
    },
  }))
  return () => { for (const dispose of disposers) dispose() }
}

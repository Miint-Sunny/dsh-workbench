/**
 * dsh-workbench 根行（cordis.patch.yml 里 id 为 web 的行）：宿主侧只做一件事——
 * 提供 GET /api/dsh-workbench.features，把各功能行报到登记处的当前状态回答给网页端。
 * 网页部分（lib/client.js，由 scripts/build-client.mjs 从 src/client 生成）也由这
 * 一行加载：DSH 只在有一行直接以包名挂载时才加载包的 ./client。
 * 路由挂在 DSH 共用的 /api 通道上：进来之前已经过了 Host/Origin 校验和登录状态，
 * 而且只接受本人，所以这里不再自己调 requestRejection。
 */
import { enabledFeatures } from './features.js'

export const name = '@miint-sunny/dsh-workbench'

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })

/**
 * 注册根行：功能清单路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-workbench.features',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => json({ features: enabledFeatures() }),
    }), 'dsh-workbench: features route')
  })
}

/** 模型设置的四个宿主端接口，从 index.js 拆出来：这里不 import DSH 的包，DSH 的服务和消息构造都由调用方给，测试可以直接注册假的上下文。 */
import { runCheck, checkRequestOf } from './check.js'
import { catalogApiOf, catalogModelsOf, discoverRequestOf, runCatalogProtocols, runDiscover } from './discover.js'
import { defaultModelRequestOf, setDefaultModel } from './default-model.js'

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/**
 * 读请求体并校验；不合法时返回 400 的回答。
 * @param {Request} request 请求。
 * @param {(body: unknown) => object | undefined} parse 校验函数。
 * @returns {Promise<{ value: object } | { response: Response }>} 合法的请求或回答。
 */
async function bodyOf(request, parse) {
  let body
  try {
    body = await request.json()
  } catch {
    // 请求体不是 JSON：按参数错误回答，不往下走。
    return { response: json({ ok: false, reason: 'other', message: 'invalid request body' }, 400) }
  }
  const value = parse(body)
  return value === undefined ? { response: json({ ok: false, reason: 'other', message: 'invalid request' }, 400) } : { value }
}

/**
 * 注册宿主端接口。它们挂在 DSH 共用的 `/api` 通道上：进来之前已经过了 Host/Origin 校验和登录状态（`connection.admit`，和 `requestRejection` 同一套），而且只接受本人。
 * - `POST /api/dsh-workbench.model-settings.check`：检查连接。
 * - `POST /api/dsh-workbench.model-settings.discover`：目录里的提供商向提供商请求一次模型列表。只收 Provider ID，密钥在这里读、这里用完。
 * - `POST /api/dsh-workbench.model-settings.catalog-protocols`：协议混合的提供商加目录外模型要的目录信息，只读安装包目录。
 * - `POST /api/dsh-workbench.model-settings.default-model`：设为默认模型。
 * 每个接口在任何输入下都回答 JSON：DSH 的服务抛异常时回答 `{ ok: false, reason: 'other' }`，原因原文只留 300 个字符。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ createUserMessage: Function, BlockAssembler: new () => object }} protocol DSH 的消息构造和流累积（检查连接用）。
 */
export function registerRoutes(ctx, protocol) {
  ctx.inject(['connection'], (scope) => {
    const route = (name, handle) => scope.effect(() => scope.connection.fetch.register({
      path: `/api/dsh-workbench.model-settings.${name}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handle(request)
        } catch (error) {
          return json({ ok: false, reason: 'other', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) }, 500)
        }
      },
    }), `@miint-sunny/dsh-workbench/model-settings: ${name} route`)
    route('check', async (request) => {
      const parsed = await bodyOf(request, checkRequestOf)
      if ('response' in parsed) return parsed.response
      const llm = ctx.get('llm')
      if (llm === undefined) return json({ ok: false, reason: 'other', message: 'DSH LLM service is unavailable' }, 503)
      return json(await runCheck(llm, protocol, parsed.value))
    })
    route('discover', async (request) => {
      const parsed = await bodyOf(request, discoverRequestOf)
      if ('response' in parsed) return parsed.response
      const llm = ctx.get('llm')
      if (llm === undefined) return json({ ok: false, reason: 'other', message: 'DSH LLM service is unavailable' }, 503)
      const credentials = ctx.get('credentials')
      return json(await runDiscover({
        describeSettings: () => ctx.get('settings')?.describe() ?? [],
        listDirectory: () => llm.listConfigurableProviders(),
        // 用 DSH 的凭据服务读，和 DSH 自己发模型请求时一样；不直接读凭据文件。
        ...credentials === undefined ? {} : { resolveCredential: async ref => (await credentials.resolve(ref))?.value },
        discoverModels: (ns, discovery, signal) => llm.discoverModels(ns, discovery, signal),
        catalogApi: catalogApiOf,
        now: () => Date.now(),
      }, parsed.value))
    })
    // 协议混合的提供商加目录外模型时要的目录信息：只读安装包目录，不读密钥、不发请求。
    route('catalog-protocols', async (request) => {
      const parsed = await bodyOf(request, discoverRequestOf)
      if ('response' in parsed) return parsed.response
      const llm = ctx.get('llm')
      if (llm === undefined) return json({ ok: false, reason: 'other', message: 'DSH LLM service is unavailable' }, 503)
      return json(await runCatalogProtocols({
        describeSettings: () => ctx.get('settings')?.describe() ?? [],
        listDirectory: () => llm.listConfigurableProviders(),
        catalogModels: provider => catalogModelsOf(provider),
      }, parsed.value))
    })
    route('default-model', async (request) => {
      const parsed = await bodyOf(request, defaultModelRequestOf)
      if ('response' in parsed) return parsed.response
      const llm = ctx.get('llm')
      const defaults = ctx.get('agentDefaultModel')
      if (llm === undefined || defaults === undefined) return json({ ok: false, reason: 'notSavable' })
      return json(await setDefaultModel({
        canSave: () => ctx.get('configEditor') !== undefined,
        currentSelection: () => defaults.currentSelection(),
        resolveCallConfig: config => llm.resolveCallConfig(config),
        saveSelection: selection => defaults.saveSelection(selection),
      }, parsed.value))
    })
  })
}

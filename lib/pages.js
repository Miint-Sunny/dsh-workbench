/**
 * dsh-workbench/pages 行的宿主端：网页发布（计划第 8 项）。组装存储（$DSH_HOME/dsh-workbench/pages，
 * 目录见 lib/data-dir.js）、publish_page 工具（lib/pages-tool.js）和 pages.* 路由
 * （lib/pages-routes.js）；读文件和内联在 lib/pages-read.js、lib/pages-inline.js、lib/pages-publish.js，
 * 工具和路由走同一份。行启动时清一次回收目录。
 */
import { join } from 'node:path'
import { workbenchDataDir } from './data-dir.js'
import { registerFeature } from './features.js'
import { createPagesStore } from './pages-store.js'
import { applyPagesRoutes } from './pages-routes.js'
import { registerPublishPageTool } from './pages-tool.js'

export const name = '@miint-sunny/dsh-workbench/pages'

/**
 * 页面数据目录：配置给了 dataDir 用它；否则在插件数据目录下的 pages/。临时 DSH 演练时
 * DSH_HOME 指着临时目录，页面不会写进真的 ~/.dsh。
 * @param {{ dataDir?: string }} config 行配置。
 * @param {{ DSH_HOME?: string }} [env] 环境变量，缺省用进程的；测试注入。
 * @returns {string} 数据目录的绝对路径。
 */
export function pagesDataDir(config = {}, env = process.env) {
  if (config.dataDir !== undefined) return config.dataDir
  return join(workbenchDataDir(env), 'pages')
}

/**
 * 会话的工作区根：live 会话读 header 的 cwd（会话列表条目的同一个来源），冷会话问持久层；
 * 都读不到时 undefined（路由按会话不存在回答）。
 * @param {object} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<string | undefined>} 工作区根。
 */
async function headerWorkspaceRoot(ctx, sessionId) {
  const live = ctx.get?.('sessions')?.get(sessionId)
  if (live?.header?.cwd !== undefined) return live.header.cwd
  const stored = await ctx.get?.('sessionPersistence')?.stat(sessionId)
  return stored?.header?.cwd
}

/**
 * 装上网页发布的宿主端。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dataDir?: string }} [config] 行配置；dataDir 覆盖页面数据目录。
 */
export function applyPages(ctx, config = {}) {
  const store = createPagesStore(pagesDataDir(config))
  ctx.provide('workbenchPages', { readVersion: store.readVersion, listPages: store.listPages })
  // 行启动时清一次回收目录；之后每次删除时 store 自己清。
  store.purgeTrash()
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => registerPublishPageTool(scope, {
      store,
      /** 工具的工作区根是会话的目录（header 的 cwd）；模型眼里 path 相对的是它当前所在的目录（workingDirectory
       * 的投影，会跟着 cd 走），所以两个都给，工具把 path 换成相对根的写法再做包含检查。投影不认识这个会话
       * 对象（冒烟的桩会话）或服务不在时，当前目录就是根。 */
      workspaceRootOf: async (sessionId, exec) => {
        const root = typeof exec?.agent?.session?.header?.cwd === 'string'
          ? exec.agent.session.header.cwd
          : await headerWorkspaceRoot(ctx, sessionId)
        let base = root
        const workingDirectory = scope.get?.('workingDirectory')
        if (exec?.agent !== undefined && workingDirectory !== undefined) {
          try {
            base = workingDirectory.get(exec.agent.session)
          } catch {
            // 投影没见过这个会话对象：当前目录按根算。
          }
        }
        return { root, base }
      },
    }), '@miint-sunny/dsh-workbench/pages: publish_page tool')
  })
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => applyPagesRoutes(scope, {
      store,
      workspaceRootOf: (sessionId) => headerWorkspaceRoot(ctx, sessionId),
    }), '@miint-sunny/dsh-workbench/pages: routes')
  })
}

/**
 * 注册 pages 行（cordis.patch.yml 里 id 为 dsh-workbench-pages 的行）。行配置原样传下去。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dataDir?: string }} [config] 行配置。
 */
export function apply(ctx, config) {
  ctx.effect(() => registerFeature('pages'), '@miint-sunny/dsh-workbench/pages: feature registration')
  applyPages(ctx, config)
}

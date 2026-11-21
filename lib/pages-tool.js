/**
 * 网页发布（dsh-workbench/pages）的工具 publish_page：模型把工作区里写好的 HTML 发布成带版本的
 * 页面。写法照第一批的 wrap_up（lib/tasks.js）：defineTool 定义，execute 里校验后的错误抛出去
 * （DSH 把 message 作为工具结果给模型）。发布流程在同目录 pages-publish.js，和路由共用。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PagesError } from './pages-error.js'
import { rebaseWorkspacePath } from './pages-read.js'
import { publishHtml, publishResultText, PUBLISH_PAGE_DESCRIPTION } from './pages-publish.js'

/**
 * 注册 publish_page 工具。
 * @param {object} scope 带有 tools 服务的插件作用域。
 * @param {{ store: object, workspaceRootOf: (sessionId: string, exec: object) => { root: string | undefined, base?: string } | string | undefined | Promise<{ root: string | undefined, base?: string } | string | undefined> }} services 存储和取工作区根（和模型当前所在目录）的函数。
 * @returns {() => void} 注销函数。
 */
export function registerPublishPageTool(scope, { store, workspaceRootOf }) {
  return scope.tools.register(defineTool({
    name: 'publish_page',
    description: PUBLISH_PAGE_DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '要发布的 HTML 文件，工作区里的相对路径（.html 或 .htm）。',
      },
      title: {
        type: 'string',
        description: '页面标题；省略时用 HTML 的 <title>，再没有就用文件名。',
      },
      page: {
        type: 'string',
        description: '已有页面的 id：给了就是给那个页面加一版，不建新页面；不填时同一个文件再次发布会自动加版。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          n: { type: 'integer', required: true },
          size: { type: 'integer', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{ type: 'text', text: publishResultText(value) }],
      presentationMeta: (args, value) => value,
    },
    async execute(args, exec) {
      let where
      try {
        where = await workspaceRootOf(exec.agent?.session?.id, exec)
      } catch (error) {
        throw new PagesError('no-workspace', error instanceof Error ? error.message : String(error))
      }
      const workspaceRoot = typeof where === 'string' ? where : where?.root
      const baseDir = typeof where === 'string' ? where : where?.base
      if (workspaceRoot === undefined || workspaceRoot === '') {
        throw new PagesError('no-workspace', '找不到会话的工作区目录，不能发布。')
      }
      const { meta, version, warnings } = await publishHtml(store, {
        sessionId: exec.agent?.session?.id ?? '',
        path: rebaseWorkspacePath(args.path, baseDir, workspaceRoot),
        workspaceRoot,
        title: args.title,
        pageId: args.page,
        signal: exec.signal,
      })
      return { ok: true, id: meta.id, title: meta.title, n: version.n, size: version.size, warnings }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '网页发布',
      kind: 'other',
      rawInput: typeof args?.path === 'string' ? args.path : '',
    }),
  }))
}

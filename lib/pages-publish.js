/**
 * 网页发布（dsh-workbench/pages）的发布流程：读 HTML → 内联 → 叠 CSP → 存进存储。工具
 * （publish_page）和路由（POST publish，文件预览里的「发布为页面」）走同一个函数，读文件和
 * 内联的规则只有一份。同一个来源文件第二次发布时给原来的页面加一版（meta 的 source 对得上）。
 * 本模块不 import 任何 @deepseek-ai 包。
 */
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { applyPageHardening } from './pages-csp.js'
import { inlineHtml } from './pages-inline.js'
import { readWorkspaceAsset, readWorkspaceHtml, sameSourcePath, titleOfHtml } from './pages-read.js'

/** publish_page 给模型的说明（lib/pages-tool.js 用；放这里让单测不用装 DSH 的包也能查字）。 */
export const PUBLISH_PAGE_DESCRIPTION = [
  '用户要一个能直接看的网页、报告或图表时调用：先在工作区里写好完整的 HTML 文件（脚本、样式、图片放在旁边的相对路径），再用这个工具把它发布成页面。不要用它存放普通文件，也不要在没有写 HTML 的情况下调用。',
  '预览默认不运行脚本。把正文、表格和图表的数据直接写进 HTML，让用户打开就能看到，脚本只做交互。发布时会内联支持的相对路径资源（单个资源最多 4 MiB，每版资源合计最多 16 MiB、64 个），并返回未内联的警告。预览会拦截 fetch、表单提交和外部图片。资源策略允许从 cdnjs.cloudflare.com、cdn.jsdelivr.net、unpkg.com 加载脚本和样式，从 Google Fonts 加载样式和字体。用户点「运行脚本」后，页面可以跳转到其他网站并把页面内容带过去。',
].join('\n')

/** 工具结果里最多列出多少条内联警告。 */
const PUBLISH_WARNINGS_SHOWN = 10

/**
 * publish_page 给模型的结果文字：已发布的页面，加上内联时的警告（读不到的资源、没有内联的引用），
 * 模型看得到才改得了。
 * @param {{ title: string, n: number, id: string, warnings?: string[] }} value 工具的结果。
 * @returns {string} 结果文字。
 */
export function publishResultText(value) {
  const lines = [`已发布页面「${value.title}」第 ${value.n} 版（页面 id ${value.id}）。用户可以在右侧栏的「页面」标签和侧边栏的「页面」里查看。`]
  const warnings = value.warnings ?? []
  if (warnings.length > 0) {
    // 一个页面可以有成千上万处引用：最多给模型看前 10 条，别把结果撑成一大篇。
    lines.push(`但有 ${warnings.length} 处资源没有内联，页面在离线沙箱里可能显示不全：`, ...warnings.slice(0, PUBLISH_WARNINGS_SHOWN).map(warning => `- ${warning}`))
    if (warnings.length > PUBLISH_WARNINGS_SHOWN) lines.push(`（还有 ${warnings.length - PUBLISH_WARNINGS_SHOWN} 条没有列出。）`)
  }
  return lines.join('\n')
}

/**
 * 发布一次：返回加了新版的 meta 和警告。
 * @param {object} store lib/pages-store.js 的存储实例。
 * @param {{ sessionId: string, path: string, workspaceRoot: string, title?: string, pageId?: string, signal?: AbortSignal }} input 发布参数；pageId 指定给哪个页面加版（不给时按来源找，找不到新建）。
 * @returns {Promise<{ meta: object, version: { n: number, createdAt: number, size: number, assets: object }, warnings: string[] }>} 新版的 meta、版本和内联警告。
 * @throws {import('./pages-error.js').PagesError} 读文件或限额失败（message 给用户和模型看）。
 */
export async function publishHtml(store, { sessionId, path, workspaceRoot, title, pageId, signal }) {
  const read = await readWorkspaceHtml(path, workspaceRoot, { signal })
  const settledTitle = (title ?? '').trim() !== '' ? title.trim().slice(0, 60) : titleOfHtml(read.html, path)
  // inlineHtml 给出的资源路径相对 HTML 所在的目录，读文件的根是工作区根：HTML 不在根目录时要拼上它的目录。
  const htmlDir = posix.dirname(path.replace(/\\/g, '/'))
  const workspacePathOf = (assetPath) => (htmlDir === '.' ? assetPath : posix.join(htmlDir, assetPath))
  const digest = value => createHash('sha256').update(value).digest('hex')
  const sourceFiles = new Map([[path, digest(read.html)]])
  const { html, assets, warnings } = await inlineHtml(
    read.html, async (assetPath) => { const localPath = workspacePathOf(assetPath); const asset = await readWorkspaceAsset(localPath, workspaceRoot, { signal }); sourceFiles.set(localPath, digest(asset.bytes)); return asset }, { signal })
  const hardened = applyPageHardening(html)
  const counts = { scripts: assets.scripts.length, styles: assets.styles.length, images: assets.images.length }
  const sourceRevision = { root: await realpath(workspaceRoot), source: { sessionId, path }, files: [...sourceFiles].map(([path, hash]) => ({ path, hash })) }
  const input = { sessionId, path, html: hardened, assets: counts, title: settledTitle, sourceRevision }

  let meta
  if (pageId !== undefined && pageId !== null && pageId !== '') {
    ;({ meta } = await store.addVersion(pageId, input))
  } else {
    // 同一个来源文件再发布：给原来的页面加版（标题跟着这次的 <title> 或 title 参数走）。
    const existing = store.listPages().pages.find(page =>
      page.corrupt !== true && page.source.sessionId === sessionId && sameSourcePath(page.source.path, path))
    if (existing === undefined) {
      ;({ meta } = await store.createPage(input))
    } else {
      ;({ meta } = await store.addVersion(existing.id, input))
    }
  }
  const version = meta.versions[meta.versions.length - 1]
  return { meta, version, warnings }
}

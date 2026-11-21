/**
 * 网页发布（dsh-workbench/pages）的读文件：从会话的工作区里读要发布的 HTML 和它引用的资源。
 * 包含检查自己做（调研 E 第 3 节：组合文件系统的 resolve 不是包含边界）：lstat 不跟符号链接、
 * realpath 之后必须在工作区根之内、只认普通文件、HTML 32 MiB 上限。会话的工作区根由调用方给
 * （工具用 workingDirectory 的当前目录，路由用会话 header 的 cwd）。
 * 本模块不 import 任何 @deepseek-ai 包。
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { PagesError, formatBytes } from './pages-error.js'
import { MAX_ASSET_BYTES } from './pages-inline.js'

/** HTML 文件的上限（和 DSH workspaceFiles 的整文件上限一致）。 */
export const MAX_HTML_BYTES = 32 * 1024 * 1024

/** 资源扩展名到 MIME：内联时 data: 地址和 <script>/<style> 都用。 */
export const ASSET_MIME = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
}

/**
 * 把 HTML 或资源的路径解析到工作区里的普通文件。检查：相对路径、存在、不是符号链接、
 * realpath 之后在工作区根之内、是普通文件。
 * @param {string} path 工作区里的相对路径。
 * @param {string} workspaceRoot 工作区根（绝对路径）。
 * @param {{ signal?: AbortSignal }} [options] 取消信号。
 * @returns {Promise<{ absolutePath: string, size: number }>} 绝对路径和大小。
 * @throws {PagesError} 'not-a-relative-path'、'not-found'、'not-a-file'、'outside-workspace'。
 */
export async function locateWorkspaceFile(path, workspaceRoot, options = {}) {
  if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new PagesError('not-a-relative-path', `路径 ${JSON.stringify(path ?? '')} 要是工作区里的相对路径。`)
  }
  const joined = resolve(workspaceRoot, path)
  let entry
  try {
    entry = await lstat(joined)
  } catch {
    throw new PagesError('not-found', `文件 ${path} 不存在。`)
  }
  options.signal?.throwIfAborted()
  if (!entry.isFile()) throw new PagesError('not-a-file', `文件 ${path} 不是普通文件。`)
  const [realRoot, realPath] = await Promise.all([realpath(workspaceRoot), realpath(joined)])
  const rel = relative(realRoot, realPath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PagesError('outside-workspace', `文件 ${path} 在工作区之外，不能发布。`)
  }
  return { absolutePath: realPath, size: entry.size }
}

/**
 * 工具的 path 相对模型当前所在的目录（base），工作区根（root）是会话的目录：把 path 换成相对 root
 * 的写法，之后的包含检查都按 root 来。模型 `cd` 到别处（甚至 `/`）不会让「工作区」跟着变大。
 * 绝对路径、带协议、空字符串原样返回，由 locateWorkspaceFile 报 'not-a-relative-path'。
 * @param {string} path 模型给的路径。
 * @param {string | undefined} baseDir 模型当前所在的目录；没有时等于 root。
 * @param {string} rootDir 会话的工作区根。
 * @returns {string} 相对 root 的路径。
 * @throws {PagesError} 'outside-workspace'：换算后在 root 之外。
 */
export function rebaseWorkspacePath(path, baseDir, rootDir) {
  if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) return path
  if (baseDir === undefined || baseDir === rootDir) return path
  const rel = relative(rootDir, resolve(baseDir, path))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PagesError('outside-workspace', `文件 ${path} 在工作区之外，不能发布。`)
  }
  return rel
}

/**
 * 读要发布的 HTML 文本：定位、限 32 MiB、解码；扩展名不是 .html/.htm 拒绝。
 * @param {string} path 工作区里的相对路径。
 * @param {string} workspaceRoot 工作区根。
 * @param {{ signal?: AbortSignal }} [options] 取消信号。
 * @returns {Promise<{ html: string, absolutePath: string, size: number }>} HTML 文本和文件位置。
 * @throws {PagesError} 定位失败的各条，加 'not-html'（扩展名不对或内容有 NUL）和 'html-too-large'。
 */
export async function readWorkspaceHtml(path, workspaceRoot, options = {}) {
  const located = await locateWorkspaceFile(path, workspaceRoot, options)
  if (!/\.(html?|htm)$/i.test(path)) {
    throw new PagesError('not-html', `文件 ${path} 不是 HTML（要 .html 或 .htm）。`)
  }
  if (located.size > MAX_HTML_BYTES) {
    throw new PagesError('html-too-large', `文件 ${path} 有 ${formatBytes(located.size)}，超过 ${formatBytes(MAX_HTML_BYTES)} 的上限。`)
  }
  const raw = await readFile(located.absolutePath)
  options.signal?.throwIfAborted()
  const html = new TextDecoder().decode(raw)
  if (html.includes('\u0000')) throw new PagesError('not-html', `文件 ${path} 不是 HTML（内容是二进制）。`)
  return { html, absolutePath: located.absolutePath, size: raw.byteLength }
}

/**
 * 读一个资源（脚本、样式、图片）的字节。
 * @param {string} path 工作区里的相对路径。
 * @param {string} workspaceRoot 工作区根。
 * @param {{ signal?: AbortSignal, maxBytes?: number }} [options] 取消信号；单个资源的上限（缺省 4 MiB，读之前按 lstat 的大小查）。
 * @returns {Promise<{ bytes: Uint8Array, mime: string }>} 字节和 MIME。
 * @throws {PagesError} 定位失败的各条，加 'unknown-asset-type'（扩展名不认识）和 'asset-too-large'。
 */
export async function readWorkspaceAsset(path, workspaceRoot, options = {}) {
  const located = await locateWorkspaceFile(path, workspaceRoot, options)
  const ext = path.split('/').pop() ?? ''
  const dot = ext.lastIndexOf('.')
  const extension = dot === -1 ? '' : ext.slice(dot + 1).toLowerCase()
  // 只认自己的键：`x.constructor`、`x.__proto__` 取到的是对象原型上的东西。
  const mime = Object.hasOwn(ASSET_MIME, extension) ? ASSET_MIME[extension] : undefined
  if (mime === undefined) throw new PagesError('unknown-asset-type', `资源 ${path} 的类型不认识，不能内联。`)
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES
  // 先按文件大小拒绝，别把几 GB 的文件整个读进内存再让内联模块拒。
  if (located.size > maxBytes) {
    throw new PagesError('asset-too-large', `资源 ${path} 有 ${formatBytes(located.size)}，超过单个资源 ${formatBytes(maxBytes)} 的上限。压缩它，或改成外链。`, { size: located.size })
  }
  const bytes = await readFile(located.absolutePath)
  options.signal?.throwIfAborted()
  return { bytes, mime }
}

/**
 * 页面标题：HTML 里第一个 <title> 的文字（去标签、空白折成一个空格、最长 60 个字）；
 * 没有就用文件名去掉扩展名。
 * @param {string} html HTML 文本。
 * @param {string} path 文件的相对路径（兜底标题用）。
 * @returns {string} 标题。
 */
export function titleOfHtml(html, path) {
  const match = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(html)
  const fromTag = match === null ? '' : match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (fromTag !== '') return fromTag
  const base = path.split('/').pop() ?? path
  return base.replace(/\.[^.]+$/, '').trim().slice(0, 60) || '页面'
}

/**
 * 两个来源路径是不是同一个文件：posix 写法归一（反斜杠折成正斜杠、去掉 ./、拼段）后比较。
 * @param {string} left meta 里的来源路径。
 * @param {string} right 这次发布的路径。
 * @returns {boolean} 同一个文件时 true。
 */
export function sameSourcePath(left, right) {
  const normalize = (value) => String(value).replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.').join('/')
  return normalize(left) === normalize(right)
}

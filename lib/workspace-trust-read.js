/**
 * 工作区信任（dsh-workbench/workspace-trust）的边界检查和读取：HTML 预览要内联的一个本地资源，
 * 只有工作区已信任、文档和资源都在工作区根以内（词法和 realpath 之后都算）、路径上没有点文件或点目录、
 * 扩展名在白名单里（样式、脚本、图片、字体、音视频和 <track> 字幕）、是不超过上限的普通文件时，才读出来。检查和读取在同一个函数里，读的是检查过的那个
 * 真实路径，打开时不跟最后一段符号链接，读完核对 inode 和 realpath。规则逐条写在
 * docs/plans/2026-11-13-工作区信任.md 4.5 节。本模块不 import 任何 @deepseek-ai 包。
 */
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import nodePath, { extname, isAbsolute, resolve, sep } from 'node:path'

/** 单个资源的上限。内联成 data: 地址后还要再大三分之一，视频也够用。 */
export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024

/** 允许内联的扩展名和它们的类型：样式、脚本、图片、字体、音视频和字幕。只认这张表，不嗅探内容。 */
const MEDIA_TYPES = {
  css: 'text/css',
  // <track> 的字幕是纯文本，和样式文件同样处理。
  vtt: 'text/vtt',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
}

/**
 * 按扩展名给出允许的类型。
 * @param {string} path 文件路径。
 * @returns {string | undefined} MIME；不在白名单里时 undefined。
 */
export function mediaTypeOf(path) {
  const extension = extname(path).slice(1).toLowerCase()
  // 只认自己的键：`x.constructor` 这类取到的是原型上的东西。
  return Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : undefined
}

/** `~`、`~/x` 按主目录展开（和 better-sidebar 的 resolveTarget 一致），再做词法 resolve。 */
function expand(path, home, pathApi = nodePath) {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return pathApi.resolve(pathApi.join(home, path.slice(1)))
  return pathApi.resolve(path)
}

/** child 在 root 之内时给出相对路径（root 本身不算），否则 undefined。 */
function inside(root, child, pathApi = nodePath) {
  const rel = pathApi.relative(root, child)
  if (rel === '' || rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return undefined
  return rel
}

/**
 * 文档的真实路径是否在工作区内；点目录里的 HTML 也属于工作区。不存在或无法解析时不放行。
 * @param {{ realRoot: string, documentPath: string, home: string }} options 真实工作区根、文档路径和主目录。
 * @param {typeof nodePath} [pathApi] 宿主的路径规则；测试可指定 win32。
 * @param {(path: string) => Promise<string>} [realpathOf] 真实路径解析器。
 * @returns {Promise<boolean>} 文档是否在真实工作区根之内。
 */
export async function documentInWorkspace({ realRoot, documentPath, home }, pathApi = nodePath, realpathOf = realpath) {
  let documentReal
  try {
    documentReal = await realpathOf(expand(documentPath, home, pathApi))
  } catch {
    return false
  }
  return inside(realRoot, documentReal, pathApi) !== undefined
}

/** 相对路径里有没有以 . 开头的段（点文件、点目录）。 */
const hasHiddenSegment = (rel) => rel.split(sep).some(segment => segment.startsWith('.'))

/** 显示用的路径：工作区内写相对路径，工作区外用 ~ 缩写主目录。 */
function displayOf(path, roots, home) {
  for (const root of roots) {
    const rel = inside(root, path)
    if (rel !== undefined) return rel.split(sep).join('/')
  }
  const inHome = inside(home, path)
  return inHome === undefined ? path : `~/${inHome.split(sep).join('/')}`
}

/** realpath，不存在时 undefined。 */
async function realOrUndefined(path) {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/**
 * 检查并读取一个资源。
 * @param {object} options 参数。
 * @param {string} options.root 会话的工作区根（会话 header 的 cwd，可能不是真实路径）。
 * @param {string} options.documentPath 预览文档的路径（路由解码出来的绝对路径或 ~ 开头）。
 * @param {string} options.resourcePath 资源的路径（同上）。
 * @param {(realRoot: string) => boolean} options.isTrusted 真实根是否已信任。
 * @param {string} options.home 主目录（展开 ~ 和显示用）。
 * @param {number} [options.maxBytes] 单个资源上限，缺省 MAX_RESOURCE_BYTES。
 * @param {() => (void | Promise<void>)} [options.onChecked] 测试用：全部检查通过、打开文件之前调用。
 * @param {() => (void | Promise<void>)} [options.onOpened] 测试用：打开并核对 inode 之后、读内容之前调用。
 * @param {(size: number) => boolean} [options.admitBytes] 按文件大小记入这个文档的字节额度；超过时返回 false，回答 limit。
 * @returns {Promise<{ ok: true, bytes: Buffer, mediaType: string, display: string } | { ok: false, reason: string, display?: string }>}
 *   reason 为 no-workspace、untrusted、document-outside、outside、hidden、missing、type、not-file、too-large、limit、changed 之一。
 */
export async function readTrustedResource({ root, documentPath, resourcePath, isTrusted, home, maxBytes = MAX_RESOURCE_BYTES, onChecked, onOpened, admitBytes }) {
  if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, reason: 'no-workspace' }
  const lexicalRoot = resolve(root)
  const realRoot = await realOrUndefined(lexicalRoot)
  if (realRoot === undefined) return { ok: false, reason: 'no-workspace' }
  const roots = [lexicalRoot, realRoot]
  const lexical = expand(resourcePath, home)
  const display = displayOf(lexical, roots, home)
  const fail = (reason) => ({ ok: false, reason, display })
  if (!isTrusted(realRoot)) return fail('untrusted')

  // 文档本身要在工作区里：不在的 HTML，信任这个工作区也不管它。
  if (!await documentInWorkspace({ realRoot, documentPath, home })) return fail('document-outside')

  // 词法：../、绝对路径、<base href> 带出去的在这里拦下；点段也在这里拦（链接指到哪里都一样）。
  const lexicalRel = roots.map(base => inside(base, lexical)).find(rel => rel !== undefined)
  if (lexicalRel === undefined) return fail('outside')
  if (hasHiddenSegment(lexicalRel)) return fail('hidden')

  // 真实路径：解析全部符号链接之后仍要在真实根之内，也不能落到点文件、点目录上。
  const real = await realOrUndefined(lexical)
  if (real === undefined) return fail('missing')
  const realRel = inside(realRoot, real)
  if (realRel === undefined) return fail('outside')
  if (hasHiddenSegment(realRel)) return fail('hidden')

  const mediaType = mediaTypeOf(real)
  if (mediaTypeOf(lexical) === undefined || mediaType === undefined) return fail('type')
  let checked
  try {
    checked = await stat(real)
  } catch {
    return fail('missing')
  }
  if (!checked.isFile()) return fail('not-file')
  if (checked.size > maxBytes) return fail('too-large')
  if (admitBytes !== undefined && !admitBytes(checked.size)) return fail('limit')
  await onChecked?.()

  let handle
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    return fail(error?.code === 'ENOENT' ? 'missing' : 'changed')
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) return fail('changed')
    if (opened.size > maxBytes) return fail('too-large')
    await onOpened?.()
    // 读的过程中文件可能变大：读完再按实际字节数查一次。
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) return fail('too-large')
    // 同一个 inode 可能已经连同目录被搬出工作区（原处换成链接）：读完再 realpath 一次，路径变了就不交出。
    if (await realOrUndefined(lexical) !== real) return fail('changed')
    return { ok: true, bytes, mediaType, display }
  } finally {
    await handle.close()
  }
}

/**
 * 工作区文件夹和权限（dsh-workbench/workspace-folders，feat#159）的纯逻辑。本模块不 import 任何 @deepseek-ai 包。
 *
 * 两种文件夹：
 * - 子文件夹：主文件夹里面另登记的 DSH 工作区（官方左栏的「按工作区树」把它嵌在主文件夹下面）。它的会话以子文件夹为工作区根，
 *   主文件夹天然不能写；设成「可写」时，工作台给这些会话登记主文件夹为可写目录。
 * - 外部文件夹：主文件夹外面的目录，工作台给主文件夹的会话登记为可写目录，和主文件夹同一档（只在「工作区内修改」下起作用）。
 *   范围太大的目录不能当外部文件夹（externalRefusal）：添加时报错，设置文件被手改过也不登记。
 *
 * 比较一律用真实路径：DSH 登记工作区时存真实路径；沙箱拒绝符号链接写法的可写目录，登记了找不到的目录会让这个会话的
 * 所有写操作都以 SANDBOX_INVALID_ROOT 失败（2026-11-17 隔离宿主实测），所以登记前要筛掉（usableFolder，对话框也用它）。
 */
import { realpathSync, statSync } from 'node:fs'
import nodePath from 'node:path'

/**
 * child 是否在 parent 里面（不含 parent 本身）。
 * @param {string} parent 上层目录。
 * @param {string} child 要判断的目录。
 * @param {typeof nodePath} pathApi 路径规则。
 * @returns {boolean} 在里面时 true。
 */
function strictlyInside(parent, child, pathApi) {
  const rel = pathApi.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel)
}

/** 比较用的形式：Windows 路径不分大小写，其余原样；去掉末尾多余的分隔符。 */
function comparable(path, pathApi) {
  const resolved = pathApi.resolve(path)
  return pathApi.sep === '\\' ? resolved.toLowerCase() : resolved
}

/** 同一目录可有不止一个真实路径；卷和文件号一起才是它的身份。 */
function directoryIdentity(path) {
  try {
    const info = statSync(path, { bigint: true })
    return info.isDirectory() && info.ino !== 0n ? `${info.dev}:${info.ino}` : undefined
  } catch {
    return undefined
  }
}

/**
 * 选中的文件夹（已经是真实路径）相对主文件夹怎么分类。
 * @param {{ main: string, picked: string, listed: string[], pathApi?: typeof nodePath }} input
 *   主文件夹和选中文件夹的真实路径；listed 是列表里已有的子文件夹和外部文件夹。
 * @returns {{ kind: 'subfolder' | 'external' } | { error: 'ancestor' | 'duplicate' }} 分类或拒绝原因。
 */
export function classifyFolder({ main, picked, listed, pathApi = nodePath }) {
  const target = comparable(picked, pathApi)
  const base = comparable(main, pathApi)
  if (target === base || listed.some(path => comparable(path, pathApi) === target)) return { error: 'duplicate' }
  if (strictlyInside(target, base, pathApi)) return { error: 'ancestor' }
  return { kind: strictlyInside(base, target, pathApi) ? 'subfolder' : 'external' }
}

/**
 * 不能当外部文件夹的目录：任何一个根（各盘符的根、UNC 共享的根，判断是 dirname(p) === p）、主目录和主目录的上级（'too-broad'），
 * DSH 的数据目录（$DSH_HOME）本身、它里面的目录和它的上级（'dsh-data'）。会话能写数据目录，就能改工作台存的这份设置和 DSH 的配置，
 * 自己把能写的范围扩大。照 lib/workspace-trust.js 的 trustRefusal 写，Windows 路径不分大小写。
 * 子文件夹的「可写」登记的是主文件夹，那是 DSH 官方登记的工作区，不归这里管。
 * @param {string} path 文件夹的真实路径。
 * @param {{ homes?: string[], dshHomes?: string[], identityOf?: (dir: string) => string | undefined }} dirs 主目录、DSH 的数据目录（各给写法和真实路径），以及可选的目录身份读取器。
 * @param {typeof nodePath} [pathApi] 路径规则，缺省按本机；测试传 path.win32。
 * @returns {'too-broad' | 'dsh-data' | undefined} 拒绝原因；能当外部文件夹时 undefined。
 */
export function externalRefusal(path, { homes = [], dshHomes = [], identityOf = directoryIdentity } = {}, pathApi = nodePath) {
  const target = comparable(path, pathApi)
  if (pathApi.dirname(target) === target) return 'too-broad'
  // 每次判断重新读取，目录可能被替换。同一次判断只 stat 每个名字一次。
  const identities = new Map()
  const identity = (dir) => {
    if (identityOf === directoryIdentity && pathApi.sep !== nodePath.sep) return undefined
    if (!identities.has(dir)) identities.set(dir, identityOf(dir))
    return identities.get(dir)
  }
  const covers = (outer, inner) => {
    if (outer === inner || strictlyInside(outer, inner, pathApi)) return true
    const outerId = identity(outer)
    if (outerId === undefined) return false
    let dir = inner
    for (;;) {
      if (identity(dir) === outerId) return true
      const parent = pathApi.dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  }
  const namesOf = (dirs) => {
    const names = new Set(dirs.map(dir => comparable(dir, pathApi)))
    if (identityOf === directoryIdentity && pathApi.sep === nodePath.sep) {
      for (const dir of [...names]) {
        try {
          names.add(comparable(realpathSync.native(dir), pathApi))
        } catch {
          // 尚未建好或读取失败时仍检查配置里的原路径和已知祖先。
        }
      }
    }
    // macOS 的系统卷和数据卷通过 firmlink 显示在同一棵树里。在两个视图分岔点以上，
    // 祖先本身的身份也不同。仅在两个拼法实指同一目录时才把另一条祖先链纳入检查。
    if (process.platform === 'darwin' && pathApi.sep === '/') {
      const dataVolume = '/System/Volumes/Data'
      for (const dir of [...names]) {
        const other = dir === dataVolume || strictlyInside(dataVolume, dir, pathApi)
          ? pathApi.resolve('/', pathApi.relative(dataVolume, dir))
          : pathApi.join(dataVolume, dir)
        const id = identity(dir)
        if (id !== undefined && identity(other) === id) names.add(other)
      }
    }
    return names
  }
  for (const home of namesOf(homes)) {
    if (covers(target, home)) return 'too-broad'
  }
  for (const data of namesOf(dshHomes)) {
    if (covers(target, data) || covers(data, target)) return 'dsh-data'
  }
  return undefined
}

/**
 * 把选中的路径解析成真实路径再分类。找不到、不是文件夹、不是绝对路径的不分类；外部文件夹再过一遍 refuse。
 * @param {{ main: string, picked: string, listed: string[], refuse?: (path: string) => string | undefined }} input
 *   主文件夹的真实路径、选中的路径、列表里已有的、外部文件夹的拒绝判据（宿主传 externalRefusal）。
 * @returns {{ kind: 'subfolder' | 'external', path: string } | { error: string, path?: string }} 分类和真实路径，或拒绝原因。
 */
export function resolvePickedFolder({ main, picked, listed, refuse = () => undefined }) {
  if (typeof picked !== 'string' || !nodePath.isAbsolute(picked) || picked.includes('\0')) return { error: 'invalid' }
  let real
  try {
    real = realpathSync.native(picked)
  } catch {
    return { error: 'missing' }
  }
  try {
    if (!statSync(real).isDirectory()) return { error: 'not-directory' }
  } catch {
    return { error: 'missing' }
  }
  const result = classifyFolder({ main, picked: real, listed })
  const refused = result.kind === 'external' ? refuse(real) : undefined
  return refused === undefined ? { ...result, path: real } : { error: refused, path: real }
}

/**
 * 一个会话要登记哪些可写目录（还没检查存在与否）。只看已登记的工作区：会话的 cwd 必须正好是一个工作区的目录。
 * - 它自己的外部文件夹，refuse 拒绝的不算（设置文件可能被手改过）；
 * - 它是某个工作区里面的子文件夹、那个工作区把它设成「可写」时，那个工作区的目录。
 * @param {{ cwd: string | undefined, workspaces: { id: string, path: string }[], settings: object, refuse?: (path: string) => string | undefined, pathApi?: typeof nodePath }} input
 *   会话的工作区根（会话头里的 cwd，真实路径）、当前已登记的工作区、工作台存的设置（工作区 id → { externals, writableSubfolders }）、
 *   外部文件夹的拒绝判据。
 * @returns {string[]} 目录，按出现顺序去重，不含 cwd 本身。
 */
export function writableRootsFor({ cwd, workspaces, settings, refuse = () => undefined, pathApi = nodePath }) {
  if (typeof cwd !== 'string' || cwd === '') return []
  const here = comparable(cwd, pathApi)
  const own = workspaces.find(workspace => comparable(workspace.path, pathApi) === here)
  if (own === undefined) return []
  const roots = (settings[own.id]?.externals ?? []).filter(root => refuse(root) === undefined)
  for (const workspace of workspaces) {
    if (workspace.id === own.id || !strictlyInside(comparable(workspace.path, pathApi), here, pathApi)) continue
    if (settings[workspace.id]?.writableSubfolders?.includes(own.id)) roots.push(workspace.path)
  }
  const seen = new Set([here])
  return roots.filter((root) => {
    const key = comparable(root, pathApi)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 一个目录现在能不能登记：存在、是文件夹、写法就是它的真实路径（被换成符号链接的不算）。登记了别的会让会话所有写操作失败。
 * 宿主登记前筛目录、对话框标「找不到」都用这一个判据，两边说法一致。
 * @param {string} dir 目录。
 * @returns {boolean} 能登记时 true。
 */
export function usableFolder(dir) {
  try {
    return realpathSync.native(dir) === dir && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 现在能登记的目录（usableFolder），其余的不登记。
 * @param {string[]} roots 目录。
 * @returns {string[]} 能登记的目录，顺序不变。
 */
export function usableRoots(roots) {
  return roots.filter(usableFolder)
}

/**
 * 对话框里的文件夹列表。子文件夹是嵌在主文件夹里面的已登记工作区（任意深度），按路径排；外部文件夹按添加的顺序。
 * refuse 拒绝的外部文件夹带上原因（refused），宿主不登记它们。
 * @param {{ workspace: { id: string, path: string }, workspaces: { id: string, path: string }[], settings: object, exists: (dir: string) => boolean, refuse?: (path: string) => string | undefined, pathApi?: typeof nodePath }} input
 * @returns {{ main: object, subfolders: object[], externals: object[] }} 三组文件夹，每项带 missing，被拒绝的外部文件夹另带 refused。
 */
export function folderList({ workspace, workspaces, settings, exists, refuse = () => undefined, pathApi = nodePath }) {
  const own = settings[workspace.id] ?? {}
  const base = comparable(workspace.path, pathApi)
  const subfolders = workspaces
    .filter(candidate => candidate.id !== workspace.id && strictlyInside(base, comparable(candidate.path, pathApi), pathApi))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(candidate => ({ id: candidate.id, path: candidate.path, writable: own.writableSubfolders?.includes(candidate.id) === true, missing: !exists(candidate.path) }))
  return {
    main: { path: workspace.path, missing: !exists(workspace.path) },
    subfolders,
    externals: (own.externals ?? []).map((path) => {
      const refused = refuse(path)
      return { path, missing: !exists(path), ...refused === undefined ? {} : { refused } }
    }),
  }
}

/**
 * 显示用的文件夹路径：主目录下的写成 ~ 开头，末尾带 /（根目录本身就是 /）。
 * @param {string} path 真实路径。
 * @param {string[]} homes 主目录（写法和真实路径各一个）。
 * @returns {string} 显示用的路径。
 */
export function displayFolder(path, homes) {
  const slash = value => (value.endsWith('/') || value.endsWith('\\') ? value : `${value}/`)
  for (const home of homes) {
    if (path === home) return '~/'
    if (strictlyInside(home, path, nodePath)) return slash(`~/${nodePath.relative(home, path).split(nodePath.sep).join('/')}`)
  }
  return slash(path)
}

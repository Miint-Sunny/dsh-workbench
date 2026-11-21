/**
 * 路径还原与受保护目录比对（feat#188）：还原 ~、$HOME、$DSH_HOME、相对路径和符号链接（含悬空链接）。
 * 本模块只使用 Node 内置模块，不依赖 @deepseek-ai 包。
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path'

const MAX_SYMLINK_DEPTH = 16
function firstGlobIndex(path) {
  const wildcard = path.search(/[*?[]/)
  for (const group of path.matchAll(/\{([^{}]*)\}/g)) {
    if (group[1].includes(',') || group[1].includes('..')) {
      return wildcard < 0 ? group.index : Math.min(wildcard, group.index)
    }
  }
  return wildcard
}
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

/**
 * 展开开头的 ~ 以及常见家目录/DSH 目录环境变量。
 * @param {string} raw 原始路径文本。
 * @param {{ home?: string, dshHome?: string, cwd?: string, env?: Record<string, string | undefined> }} [options] 变量环境。
 * @returns {string} 展开后的路径字符串。
 */
export function expandPathVars(raw, { home = homedir(), dshHome, cwd, env = process.env } = {}) {
  if (typeof raw !== 'string' || !raw) return raw
  const resolvedHome = home || env?.HOME || homedir()
  const resolvedDshHome = dshHome || env?.DSH_HOME || join(resolvedHome, '.dsh')
  let text = raw
  if (text === '~') return resolvedHome
  if (text.startsWith('~/') || text.startsWith('~\\')) text = resolvedHome + sep + text.slice(2)
  text = text.replace(/\$\{DSH_HOME\}|\$DSH_HOME(?![A-Za-z0-9_])/g, resolvedDshHome)
  text = text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, resolvedHome)
  if (cwd) text = text.replace(/\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, cwd)
  return text
}

function realOrSelf(target) {
  try {
    return realpathSync.native(target)
  } catch {
    return target
  }
}

function resolvePhysical(absPath, depth = 0, cache) {
  if (!absPath || absPath.includes('\0')) return absPath
  let cur = absPath
  const tail = []
  for (;;) {
    let base = cache?.get(cur)
    if (base === undefined) {
      let entry
      try {
        entry = lstatSync(cur, { throwIfNoEntry: false })
      } catch (error) {
        if (error.code !== 'ENOTDIR' && error.code !== 'ENOENT') base = cur
      }
      if (entry) {
        base = realOrSelf(cur)
        if (entry.isSymbolicLink() && base === cur && depth < MAX_SYMLINK_DEPTH) {
          const link = readlinkSync(cur)
          const target = isAbsolute(link) ? link : dirname(cur) + sep + link
          base = resolvePhysical(target, depth + 1, cache)
        }
        cache?.set(cur, base)
      }
    }
    if (base !== undefined) return resolve(base, tail.reverse().join(sep))
    const parent = dirname(cur)
    if (parent === cur) return resolve(cur, tail.reverse().join(sep))
    tail.push(basename(cur))
    cur = parent
  }
}

/**
 * 展开变量、按 cwd 解析相对路径，并沿路径与符号链接解析为真实规范路径。
 * @param {string} rawPath 待解析路径。
 * @param {{ cwd?: string, home?: string, dshHome?: string, env?: Record<string, string | undefined> }} [options] 解析上下文。
 * @returns {string} 还原后的绝对路径。
 */
export function canonicalizePath(rawPath, { cwd = process.cwd(), home = homedir(), dshHome, env = process.env, physicalPaths } = {}) {
  const expanded = expandPathVars(rawPath, { home, dshHome, cwd, env })
  const abs = isAbsolute(expanded) ? expanded : cwd + sep + expanded
  return resolvePhysical(abs, 0, physicalPaths)
}

function normalizeForCompare(target) {
  const cleaned = resolve(target)
  return CASE_INSENSITIVE_FS ? cleaned.toLowerCase() : cleaned
}

function isSamePath(left, right) {
  return normalizeForCompare(left) === normalizeForCompare(right)
}

function isSameOrInside(root, target) {
  const r = normalizeForCompare(root)
  const t = normalizeForCompare(target)
  const rel = relative(r, t)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function isStrictAncestor(ancestor, descendant) {
  const a = normalizeForCompare(ancestor)
  const d = normalizeForCompare(descendant)
  if (a === d) return false
  const rel = relative(a, d)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

function ancestorsOf(target) {
  const list = []
  let cur = resolve(target)
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) break
    list.push(parent)
    cur = parent
  }
  return list
}

function globPrefixCanonical(absPattern) {
  const parts = absPattern.split(sep)
  const globIndex = parts.findIndex(part => firstGlobIndex(part) >= 0)
  if (globIndex <= 0) return absPattern
  const prefix = parts.slice(0, globIndex).join(sep) || sep
  const rest = parts.slice(globIndex)
  return join(resolvePhysical(prefix), ...rest)
}

function globMatches(candidate, pattern) {
  return matchesGlob(normalizeForCompare(candidate), normalizeForCompare(pattern))
}

function globCouldTouch(patternAbs, protectedPath, includeDescendants) {
  if (firstGlobIndex(patternAbs) < 0) return false
  const resolvedPattern = globPrefixCanonical(patternAbs)
  const wildcardAt = firstGlobIndex(resolvedPattern)
  const prefix = dirname(resolvedPattern.slice(0, wildcardAt) + '_')
  if (!includeDescendants && isSamePath(prefix, protectedPath)) return false
  if (!isSameOrInside(prefix, protectedPath) && !(includeDescendants && isSameOrInside(protectedPath, prefix))) return false
  // Brace expansion and large pattern sets may expand before the matcher compares a single path.
  if (resolvedPattern.includes('{') || resolvedPattern.length > 4096 || (resolvedPattern.match(/[*?[]/g) ?? []).length > 16) return 'unverified'
  try {
    return matchesProtectedGlob(resolvedPattern, protectedPath, includeDescendants)
  } catch {
    return 'unverified'
  }
}

function matchesProtectedGlob(resolvedPattern, protectedPath, includeDescendants) {
  if (globMatches(protectedPath, resolvedPattern)) return true
  for (const anc of ancestorsOf(protectedPath)) {
    if (globMatches(anc, resolvedPattern)) return true
  }
  if (includeDescendants) {
    const patternParts = normalizeForCompare(resolvedPattern).split(sep).filter(Boolean)
    const targetParts = normalizeForCompare(protectedPath).split(sep).filter(Boolean)
    if (patternParts.length >= targetParts.length) {
      const prefixPattern = (resolvedPattern.startsWith(sep) ? sep : '') + patternParts.slice(0, targetParts.length).join(sep)
      if (globMatches(protectedPath, prefixPattern)) return true
    }
  }
  return false
}

/**
 * 从 $DSH_HOME/storages/workspace.json 读取已登记工作区的根路径。
 * @param {string} dshHome DSH 数据目录。
 * @param {{ missingIsEmpty?: boolean }} [options] 登记服务故障时必须有可读的回退文件。
 * @returns {string[]} 登记表里的工作区路径列表；首次启动、文件尚不存在时返回空数组。
 */
export function readWorkspaceRootsFromFile(dshHome, { missingIsEmpty = true } = {}) {
  if (!dshHome) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && missingIsEmpty) return []
    throw error
  }
  const workspaces = parsed?.tables?.workspaces
  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) throw new Error('Invalid workspace registry')
  const paths = []
  for (const record of Object.values(workspaces)) {
    if (typeof record?.path !== 'string' || !record.path.trim()) throw new Error('Missing workspace path')
    paths.push(record.path)
  }
  return paths
}

/**
 * 读取当前全部已登记工作区路径：优先读宿主 workspaceRegistry，拿不到时回退到 workspace.json。
 * @param {{ workspaceRegistry?: { list?: () => Array<{ path?: string }> }, dshHome: string }} options 来源选项。
 * @returns {string[]} 去重后的工作区路径。
 */
export function resolveWorkspaceRoots({ workspaceRegistry, dshHome }) {
  const rawPaths = []
  if (workspaceRegistry && typeof workspaceRegistry.list === 'function') {
    try {
      for (const item of workspaceRegistry.list() ?? []) {
        if (typeof item?.path === 'string' && item.path.trim() !== '') rawPaths.push(item.path)
      }
    } catch {
      return readWorkspaceRootsFromFile(dshHome, { missingIsEmpty: false })
    }
  } else {
    rawPaths.push(...readWorkspaceRootsFromFile(dshHome))
  }
  return [...new Set(rawPaths)]
}

/**
 * 预计算受保护的 storages、sessions 与工作区根路径规范形式。
 * @param {{ dshHome: string, home?: string, cwd?: string, workspaceRoots?: string[], env?: Record<string, string | undefined> }} options 上下文配置。
 * @returns {object} 规范化后的受保护上下文。
 */
export function buildProtectedContext({ dshHome, home = homedir(), cwd = process.cwd(), workspaceRoots, workspaceRegistry, env = process.env }) {
  const effectiveHome = home || env?.HOME || homedir()
  const effectiveDshHome = dshHome || env?.DSH_HOME || join(effectiveHome, '.dsh')
  const dshCandidates = [...new Set([resolve(effectiveDshHome), resolvePhysical(resolve(effectiveDshHome))])]
  const storagesDirs = []
  const sessionsDirs = []
  for (const base of dshCandidates) {
    storagesDirs.push(resolve(base, 'storages'), resolvePhysical(resolve(base, 'storages')))
    sessionsDirs.push(resolve(base, 'sessions'), resolvePhysical(resolve(base, 'sessions')))
  }
  const uniqueNorm = (list) => {
    const seen = new Set()
    const out = []
    for (const item of list) {
      const norm = normalizeForCompare(item)
      if (!seen.has(norm)) {
        seen.add(norm)
        out.push(resolve(item))
      }
    }
    return out
  }
  let rootsAvailable = true
  let rootsInput = workspaceRoots
  if (rootsInput === undefined) {
    try {
      rootsInput = resolveWorkspaceRoots({ workspaceRegistry, dshHome: effectiveDshHome })
    } catch {
      rootsAvailable = false
      rootsInput = []
    }
  }
  const rootPaths = []
  for (const root of rootsInput) {
    if (typeof root !== 'string' || root.trim() === '') continue
    const expanded = expandPathVars(root, { home: effectiveHome, dshHome: effectiveDshHome, env })
    rootPaths.push(resolve(expanded), resolvePhysical(resolve(expanded)))
  }
  return {
    home: effectiveHome,
    dshHome: effectiveDshHome,
    cwd: isAbsolute(cwd) ? cwd : resolve(cwd),
    rootsAvailable,
    env,
    storagesDirs: uniqueNorm(storagesDirs),
    sessionsDirs: uniqueNorm(sessionsDirs),
    workspaceRoots: uniqueNorm(rootPaths),
  }
}

/**
 * 判断单个路径是否落入受保护目标。
 * @param {string} rawPath 原始或命令参数路径。
 * @param {'write' | 'move-or-delete' | 'tree-contents'} mode 操作类别：写/改/复制 vs 移动/改名/删除。
 * @param {object} context 由 buildProtectedContext 或同形配置生成的上下文。
 * @returns {{ kind: 'dsh-data' | 'workspace-root' | 'unverified', target: string } | null} 命中结果或 null。
 */
export function classifyPathTarget(rawPath, mode, context) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '' || rawPath.includes('\0')) return null
  const ctx = context.storagesDirs ? context : buildProtectedContext(context)
  const expanded = expandPathVars(rawPath, { home: ctx.home, dshHome: ctx.dshHome, cwd: ctx.cwd, env: ctx.env })
  if (!expanded || expanded.includes('\0')) return null

  const logicalAbs = resolve(ctx.cwd, expanded)
  const physicalAbs = canonicalizePath(rawPath, ctx)
  const candidates = isSamePath(logicalAbs, physicalAbs) ? [physicalAbs] : [physicalAbs, logicalAbs]

  // 1. 先检查 DSH 内部目录 storages/ 与 sessions/
  const dataDirs = [...ctx.storagesDirs, ...ctx.sessionsDirs]
  for (const cand of candidates) {
    for (const dir of dataDirs) {
      if (isSameOrInside(dir, cand)) return { kind: 'dsh-data', target: cand }
      if (mode !== 'write' && isStrictAncestor(cand, dir)) return { kind: 'dsh-data', target: cand }
      const glob = globCouldTouch(cand, dir, true)
      if (glob) return { kind: glob === 'unverified' ? glob : 'dsh-data', target: cand }
    }
  }

  // 2. 移动/改名/删除时检查已登记工作区的根文件夹本身（工作区里的普通文件不算）
  if (mode !== 'write') {
    if (ctx.rootsAvailable === false) return { kind: 'unverified', target: rawPath }
    for (const cand of candidates) {
      for (const root of ctx.workspaceRoots) {
        if ((mode === 'move-or-delete' && isSamePath(cand, root)) || isStrictAncestor(cand, root)) {
          return { kind: 'workspace-root', target: cand }
        }
        const glob = globCouldTouch(cand, root, false)
        if (glob) return { kind: glob === 'unverified' ? glob : 'workspace-root', target: cand }
      }
    }
  }

  return null
}

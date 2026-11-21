/**
 * 会话迁移（feat#187）：把一个工作区整组搬到另一个文件夹。目标还没登记成工作区时，保留原工作区
 * （同一个 id）只改路径；目标已是另一个工作区时，会话并进去，旧登记删掉。每个会话只换日志第一帧
 * （会话头）里的 cwd，再把会话目录挪到新 cwd 对应的项目目录；分叉、子代理和归档的会话一起搬。
 * 工作台自己按路径存的检查点、记忆和工作区信任跟着改，按工作区 id 存的文件夹设置在合并时并过去。
 *
 * 只在 DSH App 退出时做：App 运行时登记表以内存为准，正在用的会话按内存里的会话头追加日志，外面改了
 * 会被覆盖或写到旧位置（依据见 docs/research/2026-11-19-会话迁移设计.md）。每次搬都在
 * `$DSH_HOME/dsh-workbench/workspace-moves/<moveId>/` 留下 plan.json、journal.json、after.json 和
 * before/（被替换文件的原样副本、挪出来的原会话目录和旧记忆）。中途失败按 journal 倒着回到原样；
 * 撤回时保留登记表中的无关字段、检查点和续写的记忆。整个过程不删除任何东西：撤掉的新文件挪进 discarded/。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑；用 App 自己的代码核对见
 * lib/workspace-move-appcheck.mjs。
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { workbenchDataDir } from './data-dir.js'
import { memoryHeader, memoryKey, memoryProject } from './memory-store.js'
import { policyHash } from './policy-scope.js'
import { completeTail, encodeSegment, parseLogFileName, projectKey, readHeader, readLog, rewriteHeaderCwd, sessionActivity } from './workspace-move-log.js'
import { mergeFolderSettings, restoreFolders, restoreRegistry, restoreTrust } from './workspace-move-fields.js'
import { desktopUsesHome } from './workspace-move-processes.js'
import { trustRefusal } from './workspace-trust.js'
import { TRUST_FILE } from './workspace-trust-store.js'
import { FOLDERS_FILE } from './workspace-folders-store.js'

const MOVES_DIR = 'workspace-moves'
/** 「别的按路径存的东西」只看这么大以内的文件，再大的不会是工作台的设置。 */
const SCAN_LIMIT_BYTES = 4 * 1024 * 1024
const CHECKPOINT_FILES = ['meta.json', 'checkpoints.jsonl', 'restore.json']
const sha256 = data => createHash('sha256').update(data).digest('hex')
const isMissing = error => error?.code === 'ENOENT'

/** 带错误码的迁移错误；message 以错误码开头，界面按 code 取文案。 */
export class WorkspaceMoveError extends Error {
  /**
   * @param {string} code 错误码（app-running、open-turn、stale-plan、changed-since-move 等）。
   * @param {string} message 中文说明。
   * @param {object} [details] 附加信息。
   */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'WorkspaceMoveError'
    this.code = code
    this.details = details
  }
}

/**
 * macOS 上的 App 主进程或桌面宿主是否正在使用默认数据目录 `~/.dsh`。
 * @param {string} home DSH_HOME。
 * @returns {Promise<boolean>} App 正在用它时 true。
 */
export async function dshAppRunning(home) {
  if (process.platform !== 'darwin') return false
  const defaultHome = await realpathOrUndefined(join(homedir(), '.dsh'))
  return defaultHome !== undefined && await realpathOrUndefined(home) === defaultHome && await desktopUsesHome(defaultHome)
}

const locations = (home) => {
  const data = workbenchDataDir({ DSH_HOME: home })
  return { sessions: join(home, 'sessions'), registry: join(home, 'storages', 'workspace.json'), data, moves: join(data, MOVES_DIR) }
}

/** 宿主生成或保存在旧记录中的单段迁移编号。 */
export const validWorkspaceMoveId = value => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/.test(value)

async function moveRecordDirectory(home, moveId) {
  if (!validWorkspaceMoveId(moveId)) throw new WorkspaceMoveError('bad-request', '迁移号无效。')
  const dir = join(locations(home).moves, moveId)
  await dataPath(home, join(dir, 'journal.json'))
  await dataPath(home, join(dir, 'plan.json'))
  return dir
}

async function realpathOrUndefined(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** 迁移只认数据目录树中的普通文件和目录。先检查父级，未创建的路径留给提交阶段。 */
export async function dataPath(root, path, directory = false) {
  const rel = relative(root, path)
  const parts = rel.split(sep)
  if (!rel || isAbsolute(rel) || parts[0] === '..') throw new WorkspaceMoveError('data-format', '数据路径不属于此 DSH 数据目录。')
  let at = root
  for (const [i, part] of parts.entries()) {
    at = join(at, part)
    let info
    try { info = await lstat(at) } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    if (!(i < parts.length - 1 || directory ? info.isDirectory() : info.isFile())) {
      throw new WorkspaceMoveError('data-format', `迁移记录需要普通文件和目录：${rel}`)
    }
  }
  return true
}

/** 归档目录中的附属数据也要能原样复制和核对。 */
async function checkSessionTree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await checkSessionTree(join(dir, entry.name))
    else if (!entry.isFile()) throw new WorkspaceMoveError('data-format', `会话包含无法迁移的文件：${entry.name}`)
  }
}

async function readOrUndefined(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function hashOrUndefined(path) {
  const bytes = await readOrUndefined(path)
  return bytes === undefined ? undefined : sha256(bytes)
}

/** 原文件用的 JSON 写法（缩进 2 或不缩进、结尾有没有换行）；认不出时 undefined。 */
function jsonStyle(raw, value) {
  for (const indent of [2, 0]) {
    for (const newline of ['\n', '']) {
      if (JSON.stringify(value, null, indent || undefined) + newline === raw) return { indent, newline }
    }
  }
  return undefined
}
const formatJson = (value, style) => JSON.stringify(value, null, style.indent || undefined) + style.newline

/** 路径等于 from 或在 from 下面时，换成 to 下面的同一处。 */
function remapPath(value, from, to) {
  if (typeof value !== 'string') return value
  if (value === from) return to
  return value.startsWith(from + sep) ? to + value.slice(from.length) : value
}

/**
 * DSH 启动工作区登记表时做的检查（dsh-workspace src/index.ts validateStoredState、recoverPendingMutation）。
 * @param {object} data workspace.json 的内容。
 * @returns {string[]} 问题；空数组表示过得了。
 */
export function registryProblems(data) {
  const problems = []
  const table = data?.tables?.workspaces
  const state = data?.global
  if (data?.unit?.name !== 'workspace' || data?.unit?.version !== 2 || !table || !state || !Array.isArray(state.workspaceIds)) return ['登记表不是 workspace v2 格式']
  if (state.pendingMutation !== undefined) problems.push('登记表有没做完的操作（pendingMutation）')
  const order = new Set()
  for (const id of state.workspaceIds) {
    if (order.has(id)) problems.push(`顺序里重复出现工作区 ${id}`)
    if (table[id] === undefined) problems.push(`顺序里的工作区 ${id} 没有记录`)
    order.add(id)
  }
  if (state.initialized && order.size !== Object.keys(table).length) problems.push('有工作区记录不在顺序里')
  const paths = new Map()
  const accounted = new Map()
  for (const [id, record] of Object.entries(table)) {
    if (paths.has(record.path)) problems.push(`路径 ${record.path} 同时被 ${paths.get(record.path)} 和 ${id} 占用`)
    paths.set(record.path, id)
    for (const sessionId of record.sessionIds) {
      if (accounted.has(sessionId)) problems.push(`会话 ${sessionId} 同时记在 ${accounted.get(sessionId)} 和 ${id}`)
      accounted.set(sessionId, id)
    }
  }
  return problems
}

/** 读 sessions/ 下每个会话目录：日志文件（最新的在前）和最新那份的会话头。 */
async function scanSessions(root) {
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return found
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const entry of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(root, project.name, entry.name)
      const children = await readdir(dir, { withFileTypes: true })
      const logs = children.map(child => child.name)
        .map(name => ({ name, ...parseLogFileName(name) }))
        .filter(log => log.version !== undefined)
        .sort((a, b) => b.version - a.version)
      if (logs.length === 0) continue
      let header
      let error
      try {
        if (!children.find(child => child.name === logs[0].name).isFile()) throw new Error('日志不是普通文件')
        header = readHeader(await readFile(join(dir, logs[0].name)), logs[0].compression)
      } catch (cause) {
        error = cause
      }
      found.push({ project: project.name, dirName: entry.name, dir, logs, header, error })
    }
  }
  return found
}

/** 两组会话合成一组：各自原来的顺序不变，在交界处按创建时间新的在前（DSH 新建会话就是放在最前面）。 */
function mergeByCreatedAt(target, moved, createdAt) {
  const merged = []
  let i = 0
  let j = 0
  while (i < target.length && j < moved.length) {
    if ((createdAt(moved[j]) ?? -Infinity) > (createdAt(target[i]) ?? -Infinity)) merged.push(moved[j++])
    else merged.push(target[i++])
  }
  return merged.concat(target.slice(i), moved.slice(j))
}

const roleOf = header => (header.origin === 'subagent' ? 'subagent' : header.parentSession !== undefined || header.isSeeded ? 'fork' : 'session')

/** 工作台数据目录下的文件，相对 DSH_HOME 的路径。 */
const relHome = (home, path) => relative(home, path)

/** 改写检查点文件里等于旧路径或在它下面的 cwd、root；返回新内容和改了几处。 */
function rewriteCheckpointFile(name, raw, from, to, reverse) {
  const original = reverse?.original
  let fields = 0
  const fix = (object, prior) => {
    for (const key of ['cwd', 'root']) {
      // 备份中未迁移的路径可能原本就在目标目录下。
      if (prior && prior[key] === object[key]) continue
      const next = remapPath(object[key], from, to)
      if (prior && remapPath(prior[key], to, from) !== prior[key] && next === object[key]) {
        throw new WorkspaceMoveError('changed-since-move', '检查点的目录已更改。')
      }
      if (next !== object[key]) {
        object[key] = next
        fields++
      }
    }
    return object
  }
  if (name.endsWith('.jsonl')) {
    const previous = original?.split('\n')
    const lines = raw.split('\n').map((line, i) => {
      let prior
      if (previous?.[i]) {
        try { prior = JSON.parse(previous[i]) } catch { /* 检查点存储允许备份中留有坏行。 */ }
      }
      let entry
      try { entry = JSON.parse(line) } catch {
        if (prior && ['cwd', 'root'].some(key => remapPath(prior[key], to, from) !== prior[key])) {
          throw new WorkspaceMoveError('changed-since-move', '无法读取迁移改过的检查点路径。')
        }
        return line
      }
      const before = fields
      fix(entry, prior)
      return fields === before ? line : JSON.stringify(entry)
    })
    return { text: lines.join('\n'), fields }
  }
  const value = JSON.parse(raw)
  const style = jsonStyle(raw, value) ?? (reverse && { indent: raw.match(/\n([ \t]+)"/)?.[1] ?? 2, newline: raw.endsWith('\n') ? '\n' : '' })
  if (style === undefined) throw new WorkspaceMoveError('data-format', `认不出 ${name} 的写法`)
  fix(value, original && JSON.parse(original))
  return { text: fields ? formatJson(value, style) : raw, fields }
}

/** 工作台数据：要改的检查点、记忆、信任和文件夹设置，以及别的提到旧路径、搬了也不会跟过去的文件。 */
async function planWorkbench({ data, source, targetReal, sessionIds, merge }) {
  const checkpoints = []
  for (const sessionId of sessionIds) {
    let files = 0
    let fields = 0
    for (const name of CHECKPOINT_FILES) {
      const path = join(data, 'checkpoints', sessionId, name)
      if (!(await dataPath(data, path))) continue
      const bytes = await readOrUndefined(path)
      if (bytes === undefined) continue
      const changed = rewriteCheckpointFile(name, bytes.toString('utf8'), source.path, targetReal).fields
      if (changed > 0) {
        files++
        fields += changed
      }
    }
    if (fields > 0) checkpoints.push({ sessionId, files, fields })
  }

  const to = await memoryProject(targetReal)
  let memory = { action: 'none', from: null, to: to.key, bytes: 0 }
  for (const project of [{ kind: 'workspace', path: source.path }, { kind: 'git', path: join(source.path, '.git') }]) {
    const key = memoryKey(project.kind, project.path)
    if (key === to.key) continue
    const path = join(data, 'memory', key, 'MEMORY.md')
    if (!(await dataPath(data, path))) continue
    const bytes = await readOrUndefined(path)
    if (bytes === undefined) continue
    const readable = (await readdir(dirname(path))).length === 1 && bytes.toString('utf8').startsWith(memoryHeader(project))
    const occupied = await dataPath(data, join(data, 'memory', to.key), true)
    memory = { action: !readable ? 'unreadable' : occupied ? 'conflict' : 'move', from: key, to: to.key, bytes: bytes.length, fromProject: project, toProject: { kind: to.kind, path: to.path } }
    break
  }

  const trustBytes = await readOrUndefined(join(data, TRUST_FILE))
  let trust = { action: 'none' }
  if (trustBytes !== undefined) {
    const entries = JSON.parse(trustBytes.toString('utf8')).workspaces ?? []
    const sourceTrusted = entries.some(entry => entry.path === source.path)
    const targetTrusted = entries.some(entry => entry.path === targetReal)
    if (sourceTrusted) trust = { action: targetTrusted ? 'drop-source' : 'replace' }
  }

  const foldersBytes = await readOrUndefined(join(data, FOLDERS_FILE))
  let folders = { action: 'none' }
  if (merge && foldersBytes !== undefined) {
    const settings = JSON.parse(foldersBytes.toString('utf8')).workspaces ?? {}
    const referenced = Object.values(settings).some(entry => entry.writableSubfolders?.includes(source.id))
    if (settings[source.id] !== undefined || referenced) folders = { action: 'merge' }
  }

  const skip = new Set([MOVES_DIR, 'memory', TRUST_FILE, FOLDERS_FILE, ...sessionIds.map(id => join('checkpoints', id))])
  const needles = [source.path, policyHash(source.path)]
  const untouched = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (skip.has(relative(data, path))) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && (await stat(path)).size <= SCAN_LIMIT_BYTES) {
        const text = (await readFile(path)).toString('utf8')
        const mentions = needles.reduce((sum, needle) => sum + text.split(needle).length - 1, 0)
        if (mentions > 0) untouched.push({ file: relative(data, path), mentions })
      }
    }
  }
  await walk(data)
  untouched.sort((a, b) => a.file.localeCompare(b.file))
  return { checkpoints, memory, trust, folders, untouched }
}

/**
 * 预览一次迁移（只读）：要搬的会话、搬后的分组、工作台数据要改什么、有什么挡着。
 * 返回结构见 docs/research/2026-11-19-会话迁移设计.md「预览的返回结构」。
 * @param {object} options 参数。
 * @param {string} options.home DSH_HOME。
 * @param {string} options.workspaceId 要搬的工作区。
 * @param {string} options.targetPath 目标文件夹（绝对路径，必须已存在）。
 * @param {(home: string) => boolean | Promise<boolean>} [options.appRunning] App 是否正在用这个 DSH_HOME（默认 dshAppRunning）。
 * @returns {Promise<object>} 预览。
 * @throws {WorkspaceMoveError} 工作区不存在、目标不是已有文件夹或就是原文件夹时。
 */
export async function planWorkspaceMove({ home, workspaceId, targetPath, appRunning = dshAppRunning }) {
  home = resolve(home)
  const where = locations(home)
  const blockers = []
  const warnings = []
  const block = (code, message, extra = {}) => blockers.push({ code, message, ...extra })
  for (const path of [where.sessions, where.data, where.moves]) await dataPath(home, path, true)
  for (const path of [where.registry, join(where.data, TRUST_FILE), join(where.data, FOLDERS_FILE)]) await dataPath(home, path)
  if (await appRunning(home)) block('app-running', 'DSH App 正在运行。请先退出 App（菜单里的「退出」），再搬。')

  const registryRaw = await readFile(where.registry, 'utf8')
  const registry = JSON.parse(registryRaw)
  if (jsonStyle(registryRaw, registry) === undefined) block('registry-format', '认不出登记表的写法，不敢改。')
  for (const problem of registryProblems(registry)) block(problem.includes('pendingMutation') ? 'registry-pending' : 'registry-invalid', problem)
  const table = registry.tables?.workspaces ?? {}
  const sourceRecord = table[workspaceId]
  if (sourceRecord === undefined) throw new WorkspaceMoveError('source-unknown', `没有这个工作区：${workspaceId}`)
  const source = { id: workspaceId, ...sourceRecord }

  if (typeof targetPath !== 'string' || targetPath.includes('\0') || !isAbsolute(targetPath)) throw new WorkspaceMoveError('target-invalid', '目标文件夹要写绝对路径。')
  const targetReal = await realpathOrUndefined(targetPath)
  if (targetReal === undefined || !(await stat(targetReal)).isDirectory()) throw new WorkspaceMoveError('target-missing', `目标文件夹不存在：${targetPath}`)
  if (targetReal === source.path) throw new WorkspaceMoveError('same-folder', '目标就是这个工作区现在的文件夹。')
  const targetEntry = Object.entries(table).find(([id, record]) => id !== workspaceId && record.path === targetReal)
  const merge = targetEntry !== undefined

  const scanned = await scanSessions(where.sessions)
  const headerOf = new Map(scanned.filter(item => item.header).map(item => [item.header.id, item.header]))
  const archived = new Set(registry.global?.archivedSessionIds ?? [])
  const pinned = new Set(registry.global?.pinnedSessionIds ?? [])
  const accountedBy = new Map(Object.entries(table).flatMap(([id, record]) => record.sessionIds.map(sessionId => [sessionId, id])))
  const targetProject = projectKey(targetReal)
  await dataPath(home, join(where.sessions, targetProject), true)
  const sourceProject = projectKey(source.path)
  const registeredDirs = new Set(source.sessionIds.map(encodeSegment))
  const sessions = []
  const fingerprintFiles = {}
  let subfolderSessions = 0
  for (const item of scanned) {
    if (item.error !== undefined || typeof item.header?.cwd !== 'string') {
      if (item.project === sourceProject || registeredDirs.has(item.dirName)) block('log-format', `无法辨认会话 ${item.dirName} 的日志。`, { sessionId: item.dirName })
      continue
    }
    const cwd = item.header.cwd
    const matches = cwd === source.path || (await realpathOrUndefined(cwd)) === source.path
    if (!matches) {
      if (cwd.startsWith(source.path + sep)) subfolderSessions++
      continue
    }
    const id = item.header.id
    if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/\0]/.test(id) || encodeSegment(id) !== item.dirName || projectKey(cwd) !== item.project) {
      block('session-dir', `会话目录 ${item.dirName} 与会话头不一致。`, { sessionId: item.dirName })
      continue
    }
    await checkSessionTree(item.dir)
    const role = roleOf(item.header)
    const owner = accountedBy.get(id)
    if (role !== 'subagent' && owner !== undefined && owner !== workspaceId) block('accounted-elsewhere', `会话 ${id} 的目录在这个文件夹，却记在另一个工作区 ${owner}。`, { sessionId: id })
    const to = join(where.sessions, targetProject, item.dirName)
    try {
      await lstat(to)
      block('target-session-exists', `目标位置已经有会话 ${id} 的目录。`, { sessionId: id })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    let bytes = 0
    for (const log of item.logs) {
      const buf = await readFile(join(item.dir, log.name))
      bytes += buf.length
      fingerprintFiles[relHome(home, join(item.dir, log.name))] = sha256(buf)
      try {
        const header = readHeader(buf, log.compression)
        if (header.cwd !== cwd) block('header-mismatch', `会话 ${id} 的旧日志 ${log.name} 记的目录不一样。`, { sessionId: id })
      } catch {
        block('log-format', `会话 ${id} 的日志 ${log.name} 读不出会话头。`, { sessionId: id })
      }
    }
    const latest = await readFile(join(item.dir, item.logs[0].name))
    let activity = { openTurns: [], openJobs: [] }
    try {
      activity = sessionActivity(readLog(latest, item.logs[0].compression).text)
    } catch {
      block('log-format', `会话 ${id} 的日志解不开。`, { sessionId: id })
    }
    if (activity.openTurns.length > 0) block('open-turn', `会话 ${id} 有没结束的轮次（第 ${activity.openTurns.join('、')} 轮）。请在 App 里等它结束或停止后再退出。`, { sessionId: id })
    if (activity.openJobs.length > 0) block('open-job', `会话 ${id} 有没结束的后台任务。请在 App 里等它结束或停止后再退出。`, { sessionId: id })
    sessions.push({
      id,
      role,
      archived: archived.has(id),
      pinned: pinned.has(id),
      accounted: owner === workspaceId,
      ...item.header.parentSession === undefined ? {} : { parentSession: item.header.parentSession },
      createdAt: item.header.createdAt,
      bytes,
      fromCwd: cwd,
      from: relHome(home, item.dir),
      to: relHome(home, to),
    })
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  if (subfolderSessions > 0) warnings.push({ code: 'subfolder-sessions', message: `有 ${subfolderSessions} 个会话建在旧文件夹的子文件夹里，这次不搬。`, count: subfolderSessions })
  const movedIds = new Set(sessions.map(item => item.id))
  const unmatched = source.sessionIds.filter(id => !movedIds.has(id))
  if (unmatched.length > 0) warnings.push({ code: 'unmatched-accounted', message: `登记在这个工作区、但目录不在旧文件夹的会话有 ${unmatched.length} 个，App 本来就不显示它们，原样带过去。`, count: unmatched.length })
  warnings.push({ code: 'old-paths-in-history', message: '旧对话里写死的旧路径不会改，接着聊时模型要按新位置重新找文件。' })

  const createdAt = id => headerOf.get(id)?.createdAt
  const result = merge
    ? { workspaceId: targetEntry[0], title: targetEntry[1].title, path: targetEntry[1].path, sessionIds: mergeByCreatedAt(targetEntry[1].sessionIds, source.sessionIds, createdAt) }
    : { workspaceId, title: source.title === basename(source.path) ? basename(targetReal) : source.title, path: targetReal, sessionIds: [...source.sessionIds] }

  const workbench = await planWorkbench({ data: where.data, source, targetReal, sessionIds: sessions.map(item => item.id), merge })
  if (workbench.trust.action !== 'none' && [homedir(), await realpathOrUndefined(homedir())].some(dir => dir && trustRefusal(targetReal, dir))) {
    throw new WorkspaceMoveError('target-invalid', '此目标不能继承工作区信任设置。')
  }
  if (workbench.memory.action === 'conflict') warnings.push({ code: 'memory-conflict', message: '新位置已经有一份项目记忆，旧的那份不合并，原样留着。' })
  if (workbench.memory.action === 'unreadable') warnings.push({ code: 'memory-unreadable', message: '旧位置的项目记忆开头的项目说明对不上，不搬。' })
  for (const { id: sessionId } of sessions) {
    for (const name of CHECKPOINT_FILES) {
      const path = join(where.data, 'checkpoints', sessionId, name)
      const hash = await hashOrUndefined(path)
      if (hash !== undefined) fingerprintFiles[relHome(home, path)] = hash
    }
  }
  for (const path of [
    ...workbench.memory.action === 'move' ? [join(where.data, 'memory', workbench.memory.from, 'MEMORY.md')] : [],
    ...workbench.trust.action !== 'none' ? [join(where.data, TRUST_FILE)] : [],
    ...workbench.folders.action !== 'none' ? [join(where.data, FOLDERS_FILE)] : [],
  ]) fingerprintFiles[relHome(home, path)] = await hashOrUndefined(path)

  return {
    version: 1,
    home,
    createdAt: new Date().toISOString(),
    source: { workspaceId, title: source.title, path: source.path, folderExists: (await realpathOrUndefined(source.path)) !== undefined },
    target: merge
      ? { kind: 'workspace', workspaceId: targetEntry[0], title: targetEntry[1].title, path: targetReal }
      : { kind: 'folder', workspaceId: null, title: basename(targetReal), path: targetReal },
    result,
    sessions,
    counts: {
      sessions: sessions.filter(item => item.role !== 'subagent').length,
      forks: sessions.filter(item => item.role === 'fork').length,
      subagents: sessions.filter(item => item.role === 'subagent').length,
      archived: sessions.filter(item => item.archived).length,
    },
    bytes: sessions.reduce((sum, item) => sum + item.bytes, 0),
    workbench: {
      checkpoints: workbench.checkpoints,
      memory: { action: workbench.memory.action, from: workbench.memory.from, to: workbench.memory.to, bytes: workbench.memory.bytes },
      trust: workbench.trust,
      folders: workbench.folders,
      untouched: workbench.untouched,
    },
    blockers,
    warnings,
    fingerprint: { registry: sha256(registryRaw), files: fingerprintFiles },
    internal: { targetProject, memory: workbench.memory, checkpointBackups: true },
  }
}

/** 迁移记录：每做一步之前先记下来（崩了也能照着倒回去），journal.json 每次整份重写。 */
function createJournal(moveDir, state = { status: 'applying', entries: [] }) {
  const save = async () => {
    const temp = join(moveDir, `.journal.${randomUUID()}.tmp`)
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`)
    await rename(temp, join(moveDir, 'journal.json'))
  }
  return {
    state, save,
    async record(entry) {
      state.entries.push(entry)
      await save()
    },
    async setStatus(status) {
      state.status = status
      await save()
    },
  }
}

/** 先写临时文件再改名，权限照给的来。 */
async function writeAtomically(io, path, data, mode, tempDir = dirname(path)) {
  const temp = join(tempDir, `.${basename(path)}.${randomUUID()}.tmp`)
  await io.writeFile(temp, data, { flag: 'wx', mode })
  await chmod(temp, mode)
  await io.rename(temp, path)
}

const SESSION_LOCK = 'session.lock'
const emptyHash = sha256(Buffer.alloc(0))

/** 包括空目录；遇到链接或特殊文件时只记录类型，不读取它指向的内容。 */
async function treeHashes(root) {
  const files = Object.create(null)
  async function visit(rel) {
    const path = join(root, rel)
    const info = await lstat(path)
    if (info.isDirectory()) {
      files[rel] = null
      for (const name of await readdir(path)) await visit(join(rel, name))
    } else {
      files[rel] = info.isFile() ? sha256(await readFile(path)) : 'unsupported'
    }
  }
  await visit('')
  return files
}

function ignoreEmptySessionLock(expected, actual) {
  if ([undefined, emptyHash].includes(actual[SESSION_LOCK]) && [undefined, emptyHash].includes(expected[SESSION_LOCK])) {
    delete expected[SESSION_LOCK]
    delete actual[SESSION_LOCK]
  }
}

function treeDifferences(expected, actual) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(name => expected[name] !== actual[name])
}

function within(root, path) {
  return typeof path === 'string' && isAbsolute(path) && path === join(root, relative(root, path)) && path.startsWith(root + sep)
}

async function present(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** journal 里的文件名必须属于这次预览允许改动的位置；备份只能从同一条迁移记录取。 */
function validateEntries(home, plan, moveDir, entries) {
  const where = locations(home), before = join(moveDir, 'before'), staging = join(moveDir, 'staging')
  const parks = new Set(), live = new Set(), projects = new Set()
  const files = new Set([where.registry]), checkpointFiles = new Set()
  if (plan.workbench.trust.action !== 'none') files.add(join(where.data, TRUST_FILE))
  if (plan.workbench.folders.action !== 'none') files.add(join(where.data, FOLDERS_FILE))
  const staged = new Map()
  const fail = () => { throw new WorkspaceMoveError('data-format', '迁移记录含有与工作区不符的文件路径。') }
  if (plan.home !== home || !within(where.moves, moveDir) || dirname(moveDir) !== where.moves) fail()
  for (const session of plan.sessions) {
    const from = join(home, session.from), to = join(home, session.to)
    if (typeof session.id !== 'string' || !session.id || session.id === '.' || session.id === '..' || /[\\/\0]/.test(session.id) ||
        !within(where.sessions, from) || !within(where.sessions, to) ||
        dirname(dirname(from)) !== where.sessions || dirname(dirname(to)) !== where.sessions ||
        basename(from) !== encodeSegment(session.id) || basename(to) !== basename(from) ||
        dirname(to) !== join(where.sessions, projectKey(plan.result.path)) || dirname(from) !== join(where.sessions, projectKey(session.fromCwd)) || from === to) fail()
    parks.add(from)
    staged.set(to, join(staging, basename(to)))
    projects.add(dirname(from))
    for (const name of CHECKPOINT_FILES) checkpointFiles.add(join(where.data, 'checkpoints', session.id, name))
    if (plan.workbench.checkpoints.some(item => item.sessionId === session.id)) {
      for (const name of CHECKPOINT_FILES) files.add(join(where.data, 'checkpoints', session.id, name))
    }
  }
  const memory = plan.workbench.memory
  if (memory.action === 'move') {
    if (![memory.from, memory.to].every(value => /^[0-9a-f]{64}$/.test(value)) || memory.from === memory.to) fail()
    parks.add(join(where.data, 'memory', memory.from))
    live.add(join(where.data, 'memory', memory.to))
    staged.set(join(where.data, 'memory', memory.to), join(staging, '.memory'))
  }
  for (const entry of entries) {
    switch (entry.op) {
      case 'move':
        if (parks.has(entry.from) && entry.to === join(before, relative(home, entry.from))) break
        if (!staged.has(entry.to) || staged.get(entry.to) !== entry.from) fail()
        break
      case 'checkpoint':
        if (!checkpointFiles.has(entry.path)) fail()
        break
      case 'replace':
        if (!files.has(entry.path) || entry.backup !== join(before, relative(home, entry.path)) ||
            !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail()
        break
      case 'create':
        if (entry.path !== staging && !live.has(entry.path)) fail()
        break
      case 'mkdir':
        if (entry.path !== join(where.sessions, projectKey(plan.result.path))) fail()
        break
      case 'rmdir':
        if (!projects.has(entry.path)) fail()
        break
      default:
        fail()
    }
  }
  for (const rel of Object.keys(plan.fingerprint.files)) {
    const path = join(home, rel)
    if (!within(home, path) || !files.has(path) && !checkpointFiles.has(path) && ![...parks].some(dir => within(dir, path))) fail()
  }
}

function originalTree(plan, home, dir, current, after) {
  const expected = { ...current }
  const session = plan.sessions.find(s => join(home, s.from) === dir)
  if (session && after) {
    for (const [name, hash] of Object.entries(after)) {
      const rel = relative(join(home, session.to), join(home, name))
      if (rel && within(join(home, session.to), join(home, name)) && !parseLogFileName(rel)) expected[rel] = hash
    }
  }
  for (const [rel, hash] of Object.entries(plan.fingerprint.files)) {
    const path = join(home, rel)
    if (within(dir, path)) expected[relative(dir, path)] = hash
  }
  return expected
}

const discardedAt = (moveDir, index, path) => join(moveDir, 'discarded', index + '-' + basename(path))

async function readRecord(home, path) {
  await dataPath(home, path)
  return JSON.parse(await readFile(path, 'utf8'))
}

function rollbackConflict({ changed, conflict }) {
  let message = '这些路径在迁移后发生了变化'
  if (conflict?.code === 'new-sessions') message = `工作区在迁移后新增了 ${conflict.count} 个会话`
  if (conflict?.code === 'path-changed') message = '工作区的文件夹在迁移后再次更改'
  if (conflict?.code === 'original-occupied') message = '原位置已被占用'
  return new WorkspaceMoveError('changed-since-move', message + '：' + changed.slice(0, 5).join('、'), { changed, conflict })
}

/** 从备份推导只属于这一步的反向修改；预检和写入使用同一份结果。 */
function reverseFile(home, plan, entry, raw, original, options) {
  const where = locations(home)
  if (entry.path === where.registry || entry.path === join(where.data, TRUST_FILE) || entry.path === join(where.data, FOLDERS_FILE)) {
    const value = JSON.parse(raw), before = JSON.parse(original)
    const style = jsonStyle(raw, value) ?? { indent: 2, newline: '\n' }
    const restore = entry.path === where.registry ? restoreRegistry : entry.path === join(where.data, TRUST_FILE) ? restoreTrust : restoreFolders
    const conflict = restore(value, before, plan, options)
    if (conflict) return { conflict }
    if (entry.path === where.registry && registryProblems(value).length) return { conflict: { code: 'registry-changed' } }
    return { text: formatJson(value, style) }
  }
  return rewriteCheckpointFile(basename(entry.path), raw, plan.result.path, plan.source.path, { original })
}

/** 新记忆回到旧目录，before 中的原件保留供核对。两次正向改名都落盘以后才能按此方式撤。 */
async function inspectMemory(home, plan, moveDir, state, entries, left, exists, change) {
  const memory = plan.internal.memory
  if (memory.from !== plan.workbench.memory.from || memory.to !== plan.workbench.memory.to) throw new WorkspaceMoveError('data-format', '记忆目录与迁移记录不符。')
  if (memory.action !== 'move' || (state.rollback && !state.rollback.liveMemory)) return
  const root = join(locations(home).data, 'memory'), old = join(root, memory.from), live = join(root, memory.to)
  const index = entries.findIndex(entry => entry.op === 'move' && entry.from === old)
  if (index < 0) return
  const park = entries[index], publish = entries[index - 1]
  if (publish?.from !== join(moveDir, 'staging', '.memory') || publish.to !== live) throw new WorkspaceMoveError('data-format', '缺少记忆目录的迁移步骤。')
  if (!(await exists(park.to, true))) {
    if (state.rollback?.liveMemory) change(park.to)
    return
  }
  const expected = plan.fingerprint.files[relHome(home, join(old, 'MEMORY.md'))]
  const saved = await treeHashes(park.to)
  for (const name of treeDifferences({ '': null, 'MEMORY.md': expected }, saved)) change(join(park.to, name))
  const retry = state.rollback && left <= index + 1
  const atOld = await exists(old, true), atNew = await exists(live, true)
  if (state.rollback && left <= index && !atOld) change(old)
  if (await exists(publish.from, true)) change(publish.from)
  if (await present(old) && (atNew || !retry)) change(old, { code: 'original-occupied' })
  if (!atOld && !atNew) change(live)
  const dir = atNew ? live : old
  if (atNew || atOld) {
    const path = join(dir, 'MEMORY.md')
    for (const item of await readdir(dir)) if (item !== 'MEMORY.md') change(join(dir, item))
    if (!(await exists(path))) change(path)
    else {
      const content = await readFile(path)
      const starts = project => content.toString('utf8', 0, Buffer.byteLength(memoryHeader(project))) === memoryHeader(project)
      if (!(atNew && starts(memory.toProject)) && !(retry && starts(memory.fromProject))) change(path, { code: 'memory-changed' })
    }
  }
  return { index, old, live }
}

/** 只读核对所有尚未撤销的步骤。最后一步可能停在改名前，或已倒回但还没有记下进度。 */
async function inspectRollback(home, plan, moveDir, state, undo = state.rollback?.status === 'undone' || state.status === 'done') {
  const changed = new Set(), appended = [], retained = Object.create(null)
  let applied = state.entries.length
  const left = state.rollback?.left ?? state.entries.length
  const entries = state.entries.slice(0, state.rollback?.applied ?? left)
  const originalSessions = new Map(plan.sessions.map(session => [join(home, session.from), session]))
  let conflict
  const writes = new Map(), extraCheckpoints = []
  const change = (path, detail) => {
    conflict ??= detail
    changed.add(relHome(home, path))
  }
  async function exists(path, directory = false, detail) {
    try {
      return await dataPath(home, path, directory)
    } catch (error) {
      if (error.code !== 'data-format') throw error
      change(path, detail)
      return false
    }
  }
  validateEntries(home, plan, moveDir, state.entries)
  const after = state.status === 'done' ? (await readRecord(home, join(moveDir, 'after.json'))).files : undefined
  const before = join(moveDir, 'before')
  const allowedPending = index => index === left - 1 && state.status === 'applying'
  const liveMemory = await inspectMemory(home, plan, moveDir, state, entries, left, exists, change)
  const time = state.rollback?.time ?? new Date().toISOString()
  async function inspectFile(entry, backup, retry) {
    const raw = await readFile(entry.path, 'utf8')
    // 改名后、记录进度前中断时，不会对嵌套目录再改写一次。
    const hash = sha256(raw)
    if (retry && state.rollback?.pendingHash) {
      if (state.rollback.pendingHash === hash) return
      if (entry.path.endsWith('.jsonl') && Number.isSafeInteger(state.rollback.pendingSize)) {
        const prefix = Buffer.from(raw).subarray(0, state.rollback.pendingSize)
        if (sha256(prefix) === state.rollback.pendingHash) backup = prefix.toString('utf8')
      }
    }
    let result
    try { result = reverseFile(home, plan, entry, raw, backup, { retry, time, undo }) }
    catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof WorkspaceMoveError)) throw error
      change(entry.path, CHECKPOINT_FILES.includes(basename(entry.path)) ? { code: 'checkpoint-changed' } : undefined)
      return
    }
    if (result.conflict) change(entry.path, result.conflict)
    else if (result.text !== raw) writes.set(entry.path, { text: result.text, hash })
  }
  async function inspectLaterCheckpoint(entry, retry) {
    const rel = relHome(home, entry.path), hash = plan.fingerprint.files[rel]
    let original
    if (hash && plan.internal.checkpointBackups) {
      const backup = join(before, rel)
      if (!(await exists(backup)) || await hashOrUndefined(backup) !== hash) {
        change(backup)
        return
      }
      original = await readFile(backup, 'utf8')
    } else if (hash && entry.path.endsWith('.jsonl')) {
      // 旧记录只存了整份摘要，按行寻找仍然完整的原始前缀。
      const raw = await readFile(entry.path, 'utf8'), digest = createHash('sha256')
      let length = 0
      for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        digest.update(line)
        length += line.length
        if (digest.copy().digest('hex') === hash) {
          original = raw.slice(0, length)
          break
        }
      }
      if (original === undefined) { change(entry.path); return }
    }
    await inspectFile(entry, original, retry)
  }
  // 这些检查点在搬完后才写入，旧 journal 自然没有 replace 步骤。
  if (!state.rollback && (undo || entries.some(e => e.path === locations(home).registry))) {
    for (const session of plan.sessions) {
      for (const name of CHECKPOINT_FILES) {
        const path = join(locations(home).data, 'checkpoints', session.id, name)
        if (entries.some(e => e.path === path) || !(await exists(path))) continue
        if (plan.fingerprint.files[relHome(home, path)] === await hashOrUndefined(path)) continue
        await inspectLaterCheckpoint({ path }, false)
        if (writes.has(path)) extraCheckpoints.push({ op: 'checkpoint', path })
      }
    }
  }
  for (const [index, entry] of entries.entries()) {
    if (liveMemory && (index === liveMemory.index || index === liveMemory.index - 1)) continue
    const completed = index >= left
    if (completed && entry.op === 'replace' && entry.path === locations(home).registry) {
      if (!(await exists(entry.path))) change(entry.path)
      else {
        const value = await readRecord(home, entry.path)
        if (value.tables?.workspaces?.[plan.source.workspaceId]?.path !== plan.source.path) change(entry.path, { code: 'path-changed' })
        else if (registryProblems(value).length) change(entry.path, { code: 'registry-changed' })
      }
    }
    if (completed && (entry.op !== 'move' || !originalSessions.has(entry.from))) continue
    const pending = completed || allowedPending(index)
    if (entry.op === 'move') {
      const session = plan.sessions.find(s => join(home, s.to) === entry.to)
      const parked = within(before, entry.to)
      const [from, to] = await Promise.all([exists(entry.from, true, parked ? { code: 'original-occupied' } : undefined), exists(entry.to, true)])
      if (from === to || (!to && !pending) || (completed && !from)) {
        change(from ? entry.from : entry.to, parked && from && to ? { code: 'original-occupied' } : undefined)
        continue
      }
      if (from && !state.rollback) {
        applied = index // 最后一步的正向改名尚未发生，原处之后写的新内容仍由 DSH 持有。
        continue
      }
      const dir = to ? entry.to : entry.from
      const actual = await treeHashes(dir)
      let expected
      if (parked) {
        expected = { ...(entry.tree ?? originalTree(plan, home, entry.from, actual, after)) }
        if (pending && state.rollback) {
          for (const tail of state.rollback.tails.filter(tail => tail.from === entry.from)) {
            if (from || actual[tail.name] === tail.restored) expected[tail.name] = tail.restored
          }
          // 原目录已经放回时，DSH 可能在下次恢复前又追加过完整事件。
          if (from && originalSessions.has(entry.from)) {
            ignoreEmptySessionLock(expected, actual)
            for (const name of treeDifferences(expected, actual)) {
              const log = parseLogFileName(name)
              const rel = relHome(home, join(entry.from, name))
              const length = state.rollback.logSizes?.[rel]
              if (!log || !Number.isSafeInteger(length) || !/^[a-f0-9]{64}$/.test(actual[name])) continue
              const bytes = await readFile(join(entry.from, name))
              if (sha256(bytes.subarray(0, length)) === expected[name] && completeTail(bytes, length, log.compression)) {
                expected[name] = actual[name]
                retained[rel] = actual[name]
              }
            }
          }
        }
      } else if (session) {
        const oldDir = join(home, session.from)
        const park = state.entries.find(e => e.op === 'move' && e.from === oldDir)
        if (!park || !(await exists(park.to, true))) {
          change(oldDir)
          continue
        }
        expected = { ...(park.tree ?? originalTree(plan, home, oldDir, await treeHashes(park.to), after)), ...entry.hashes }
        ignoreEmptySessionLock(expected, actual)
        for (const name of treeDifferences(expected, actual)) {
          const log = parseLogFileName(name)
          if (!log || typeof entry.hashes?.[name] !== 'string' || typeof actual[name] !== 'string' || actual[name] === 'unsupported') continue
          if (state.rollback) {
            const saved = state.rollback.tails.find(tail => tail.from === oldDir && tail.name === name)
            if (saved?.moved === actual[name]) expected[name] = actual[name]
            continue
          }
          const path = join(dir, name)
          if (!(await exists(join(park.to, name)))) {
            change(join(park.to, name))
            continue
          }
          const original = await readFile(join(park.to, name))
          const originalHash = sha256(original)
          if (originalHash !== plan.fingerprint.files[join(session.from, name)]) {
            change(join(park.to, name))
            continue
          }
          const written = rewriteHeaderCwd(original, log.compression, session.fromCwd, plan.result.path)
          const current = await readFile(path)
          if (sha256(written) === entry.hashes[name] && current.length > written.length && current.subarray(0, written.length).equals(written) &&
              completeTail(current, written.length, log.compression)) {
            expected[name] = actual[name]
            appended.push({ session, name, offset: written.length, moved: actual[name], originalHash })
          }
        }
      } else expected = entry.tree ?? { '': null, ...entry.hashes }
      for (const name of treeDifferences(expected, actual)) change(join(dir, name))
    } else if (entry.op === 'replace') {
      const backupHash = entry.path === locations(home).registry ? plan.fingerprint.registry : plan.fingerprint.files[relHome(home, entry.path)]
      if (!backupHash || !(await exists(entry.backup)) || await hashOrUndefined(entry.backup) !== backupHash) {
        change(entry.backup)
        continue
      }
      if (!(await exists(entry.path))) {
        change(entry.path)
        continue
      }
      const hash = await hashOrUndefined(entry.path)
      if (!state.rollback && pending && hash === backupHash && hash !== entry.hash) {
        applied = index
        continue
      }
      if (hash === entry.hash && (!undo || entry.path !== locations(home).registry)) {
        writes.set(entry.path, { text: await readFile(entry.backup), hash })
      } else {
        await inspectFile(entry, await readFile(entry.backup, 'utf8'), pending)
      }
    } else if (entry.op === 'checkpoint') {
      if (await exists(entry.path)) await inspectLaterCheckpoint(entry, pending)
      else change(entry.path)
    } else if (entry.op === 'create') {
      const hasDirectory = await exists(entry.path, true)
      const discarded = discardedAt(moveDir, index, entry.path)
      const archived = await exists(discarded, true)
      if ((archived && (hasDirectory || !state.rollback || !pending)) || (!hasDirectory && !pending)) change(entry.path)
      if (hasDirectory && entry.hashes) {
        const actual = await treeHashes(entry.path)
        for (const name of treeDifferences({ '': null, ...entry.hashes }, actual)) change(join(entry.path, name))
      }
    } else {
      await exists(entry.path, true)
    }
  }
  return { changed: [...changed], conflict, appended, applied, retained, writes, liveMemory, extraCheckpoints, time }
}

/** 在首次倒回前存好带追加事件的完整日志。后续只做原子替换，重复执行不会重复追加。 */
async function beginRollback(home, plan, moveDir, journal, inspection, status) {
  const { appended, applied, liveMemory, extraCheckpoints, time } = inspection
  const tails = [], logSizes = Object.create(null)
  const oldSessions = new Map(plan.sessions.map(session => [join(home, session.from), session]))
  for (const entry of journal.state.entries.slice(0, applied)) {
    const session = entry.op === 'move' && oldSessions.get(entry.from)
    if (!session) continue
    entry.tree ??= await treeHashes(entry.to)
    for (const name of Object.keys(entry.tree)) {
      if (parseLogFileName(name)) logSizes[join(session.from, name)] = (await stat(join(entry.to, name))).size
    }
  }
  for (const { session, name, offset, moved, originalHash } of appended) {
    const from = join(home, session.from)
    const original = await readFile(join(moveDir, 'before', session.from, name))
    const current = await readFile(join(home, session.to, name))
    if (sha256(original) !== originalHash || sha256(current) !== moved) throw new WorkspaceMoveError('changed-since-move', '迁移后的会话日志又有改动。')
    const output = Buffer.concat([original, current.subarray(offset)])
    logSizes[join(session.from, name)] = output.length
    const restored = sha256(output), directory = join(moveDir, 'rollback-files')
    if (!(await dataPath(home, directory, true))) await mkdir(directory, { mode: 0o700 })
    const backup = join(directory, randomUUID())
    await writeFile(backup, output, { flag: 'wx', mode: 0o600 })
    tails.push({ from, name, backup, restored, moved, original: originalHash })
  }
  // 最后一次登记的正向写入可能尚未生效；保留原 journal，不给未执行的步骤分配反向写入。
  let count = applied
  if (count === journal.state.entries.length) count = journal.state.entries.push(...extraCheckpoints)
  journal.state.rollback = { status, left: count, applied: count, tails, logSizes, liveMemory: !!liveMemory, time }
  await journal.setStatus('applying')
}

async function rollback(home, plan, moveDir, journal, status, inspection) {
  const state = journal.state
  if (state.rollback) {
    const { left, applied, tails, status: end } = state.rollback
    if (!Number.isInteger(left) || left < 0 || left > applied || !Number.isInteger(applied) || applied > state.entries.length || !['undone', 'rolled-back'].includes(end) || !Array.isArray(tails)) {
      throw new WorkspaceMoveError('data-format', '撤销进度无效。')
    }
    for (const tail of tails) {
      const session = plan.sessions.find(s => join(home, s.from) === tail.from)
      if (!session || !parseLogFileName(tail.name) || dirname(tail.backup) !== join(moveDir, 'rollback-files') ||
          tail.original !== plan.fingerprint.files[join(session.from, tail.name)] || !(await dataPath(home, tail.backup)) ||
          await hashOrUndefined(tail.backup) !== tail.restored) throw new WorkspaceMoveError('changed-since-move', '用于恢复追加事件的日志发生了变化。')
    }
  }
  inspection ??= await inspectRollback(home, plan, moveDir, state)
  const { changed, conflict, retained, writes, liveMemory } = inspection
  if (changed.length) throw rollbackConflict({ changed, conflict })
  if (!state.rollback) await beginRollback(home, plan, moveDir, journal, inspection, status)
  const progress = state.rollback
  while (progress.left > 0) {
    const index = progress.left - 1, entry = state.entries[index]
    if (liveMemory && index === liveMemory.index) {
      const { old, live } = liveMemory
      if (await present(live)) {
        if (await present(old)) throw new WorkspaceMoveError('changed-since-move', '原位置已被占用。', { conflict: { code: 'original-occupied' } })
        const path = join(live, 'MEMORY.md'), bytes = await readFile(path)
        const memory = plan.internal.memory, header = Buffer.from(memoryHeader(memory.toProject))
        if (bytes.subarray(0, header.length).equals(header)) {
          const restored = Buffer.concat([Buffer.from(memoryHeader(memory.fromProject)), bytes.subarray(header.length)])
          await writeAtomically({ writeFile, rename }, path, restored, (await stat(path)).mode & 0o777, moveDir)
        } else if (!bytes.subarray(0, Buffer.byteLength(memoryHeader(memory.fromProject))).equals(Buffer.from(memoryHeader(memory.fromProject)))) {
          throw new WorkspaceMoveError('changed-since-move', '记忆文件头与迁移记录不符。', { conflict: { code: 'memory-changed' } })
        }
        await rename(live, old)
      }
    } else if (entry.op === 'move' && await present(entry.to)) {
      if (await present(entry.from)) throw new WorkspaceMoveError('changed-since-move', '原位置已被占用。')
      for (const tail of progress.tails.filter(tail => tail.from === entry.from)) {
        const log = join(entry.to, tail.name), current = await hashOrUndefined(log)
        if (current === tail.restored) continue
        if (current !== tail.original) throw new WorkspaceMoveError('changed-since-move', '原会话日志发生了变化。')
        await writeAtomically({ writeFile, rename }, log, await readFile(tail.backup), (await stat(log)).mode & 0o777, moveDir)
      }
      await mkdir(dirname(entry.from), { recursive: true })
      await rename(entry.to, entry.from)
    } else if (entry.op === 'create' && await present(entry.path)) {
      const dest = discardedAt(moveDir, index, entry.path)
      if (await present(dest)) throw new WorkspaceMoveError('changed-since-move', '撤销文件的存放位置已被占用。')
      await mkdir(dirname(dest), { recursive: true })
      await rename(entry.path, dest)
    } else if (entry.op === 'mkdir') {
      try { await rmdir(entry.path) } catch (error) {
        if (!isMissing(error) && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
      }
    } else if (entry.op === 'rmdir') {
      await mkdir(entry.path, { recursive: true })
    } else if (entry.op === 'replace' || entry.op === 'checkpoint') {
      const write = writes.get(entry.path)
      if (write) {
        if (await hashOrUndefined(entry.path) !== write.hash) throw new WorkspaceMoveError('changed-since-move', '撤销期间数据又有改动。')
        progress.pendingHash = sha256(write.text)
        progress.pendingSize = Buffer.byteLength(write.text)
        await journal.save()
        await writeAtomically({ writeFile, rename }, entry.path, write.text, (await stat(entry.path)).mode & 0o777, moveDir)
        if (await hashOrUndefined(entry.path) !== progress.pendingHash) throw new WorkspaceMoveError('recover-mismatch', '撤销后的文件与预期不符。')
      }
    }
    delete progress.pendingSize
    delete progress.pendingHash
    progress.left = index
    await journal.save()
  }
  const files = { ...plan.fingerprint.files }
  for (const tail of progress.tails) files[relHome(home, join(tail.from, tail.name))] = tail.restored
  const restoredDirs = state.entries.slice(0, progress.applied)
    .filter(entry => entry.op === 'move' && entry.from !== liveMemory?.old).map(entry => entry.from)
  const match = await restoredDirectoriesMatch(home, { ...files, ...retained }, restoredDirs)
  if (!match) throw new WorkspaceMoveError(progress.status === 'undone' ? 'undo-mismatch' : 'recover-mismatch', '恢复后的文件与迁移记录不符。')
  await journal.setStatus(progress.status)
  return { status: progress.status }
}

/** 核对已放回的目录中有原始摘要的文件，包括接回原日志的完整追加事件。 */
async function restoredDirectoriesMatch(home, files, directories) {
  const covered = path => directories.some(dir => path.startsWith(dir + sep))
  for (const [rel, hash] of Object.entries(files)) {
    const path = join(home, rel)
    if (covered(path) && (!(await dataPath(home, path)) || (await hashOrUndefined(path)) !== hash)) return false
  }
  return true
}

async function fingerprintMatches(home, fingerprint) {
  const registry = await hashOrUndefined(locations(home).registry)
  if (registry !== fingerprint.registry) return false
  for (const [rel, hash] of Object.entries(fingerprint.files)) {
    if ((await hashOrUndefined(join(home, rel))) !== hash) return false
  }
  return true
}

/** 搬完后的自查：新日志的会话头和事件、重复的会话目录、登记表和归组。不对时抛 verify-failed。 */
async function verifyMoved(home, plan, moveDir) {
  const where = locations(home)
  const problems = []
  for (const session of plan.sessions) {
    const newDir = join(home, session.to)
    const oldDir = join(moveDir, 'before', 'sessions', basename(dirname(join(home, session.from))), basename(session.from))
    for (const name of await readdir(oldDir)) {
      const log = parseLogFileName(name)
      if (log === undefined) continue
      const before = readLog(await readFile(join(oldDir, name)), log.compression)
      const after = readLog(await readFile(join(newDir, name)), log.compression)
      if (after.header.cwd !== plan.result.path) problems.push(`${session.id}/${name} 的会话头目录不是新文件夹`)
      if (after.text.slice(after.headerLine.length) !== before.text.slice(before.headerLine.length)) problems.push(`${session.id}/${name} 的事件变了`)
    }
  }
  const scanned = await scanSessions(where.sessions)
  const seen = new Map()
  for (const item of scanned) seen.set(item.dirName, (seen.get(item.dirName) ?? 0) + 1)
  for (const [name, count] of seen) if (count > 1) problems.push(`会话目录 ${name} 出现了 ${count} 次`)
  const registry = JSON.parse(await readFile(where.registry, 'utf8'))
  problems.push(...registryProblems(registry))
  const record = registry.tables.workspaces[plan.result.workspaceId]
  const headers = new Map(scanned.filter(item => item.header).map(item => [item.header.id, item.header]))
  for (const sessionId of record?.sessionIds ?? []) {
    const header = headers.get(sessionId)
    if (header?.cwd === undefined) continue
    const real = await realpathOrUndefined(header.cwd)
    if (real !== undefined && real !== record.path && plan.sessions.some(item => item.id === sessionId)) problems.push(`会话 ${sessionId} 的目录和工作区路径对不上`)
  }
  if (problems.length > 0) throw new WorkspaceMoveError('verify-failed', problems.slice(0, 5).join('；'), { problems })
}

/** 搬后新建、改过或挪进来的每个文件的哈希（迁移记录自己里面的不算），供旧记录核对会话附属文件。 */
async function afterHashes(home, entries, moveDir) {
  const files = {}
  const add = async (path) => {
    const info = await lstat(path)
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await add(join(path, name))
    } else {
      files[relHome(home, path)] = sha256(await readFile(path))
    }
  }
  const inRecord = path => path === moveDir || path.startsWith(moveDir + sep)
  for (const entry of entries) {
    if ((entry.op === 'create' || entry.op === 'replace') && !inRecord(entry.path)) await add(entry.path)
    if (entry.op === 'move' && !inRecord(entry.to)) await add(entry.to)
  }
  return files
}

/**
 * 照预览搬。会先重新预览一次：有阻碍，或预览之后登记表、日志、要改的工作台文件变过，就不动手。
 * @param {object} options 参数。
 * @param {string} options.home DSH_HOME。
 * @param {object} options.plan planWorkspaceMove 的结果。
 * @param {(home: string) => boolean | Promise<boolean>} [options.appRunning] App 是否正在用这个 DSH_HOME（默认 dshAppRunning）。
 * @param {{ writeFile?: typeof writeFile, rename?: typeof rename }} [options.io] 写文件和改名用的函数（测试用来模拟写失败和进程半路被结束）。
 * @returns {Promise<{ moveId: string, moveDir: string }>} 这次迁移的记录。
 * @throws {WorkspaceMoveError} 有阻碍、预览过期、自查不过时；做到一半出错时先倒回原样，再抛原来的错误。
 */
export async function applyWorkspaceMove({ home, plan, appRunning = dshAppRunning, io = {} }) {
  home = resolve(home)
  const fsio = { writeFile: io.writeFile ?? writeFile, rename: io.rename ?? rename }
  // 传进来的预览里那条 app-running 不算：在 App 里预览时它总在；动手前重新预览会按现在的情况再查一次。
  const blocking = plan.blockers.filter(item => item.code !== 'app-running')
  if (blocking.length > 0) throw new WorkspaceMoveError(blocking[0].code, blocking[0].message, { blockers: blocking })
  const fresh = await planWorkspaceMove({ home, workspaceId: plan.source.workspaceId, targetPath: plan.target.path, appRunning })
  if (fresh.blockers.length > 0) throw new WorkspaceMoveError(fresh.blockers[0].code, fresh.blockers[0].message, { blockers: fresh.blockers })
  const ids = list => JSON.stringify(list.map(item => item.id))
  if (fresh.fingerprint.registry !== plan.fingerprint.registry
    || Object.keys(fresh.fingerprint.files).length !== Object.keys(plan.fingerprint.files).length
    || Object.entries(fresh.fingerprint.files).some(([rel, hash]) => plan.fingerprint.files[rel] !== hash)
    || JSON.stringify(fresh.workbench) !== JSON.stringify(plan.workbench)
    || JSON.stringify(fresh.result) !== JSON.stringify(plan.result) || ids(fresh.sessions) !== ids(plan.sessions)) {
    throw new WorkspaceMoveError('stale-plan', '预览之后登记表、会话日志或工作台数据变了，请重新预览。')
  }
  const where = locations(home)
  const moveId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${randomUUID().slice(0, 8)}`
  const moveDir = join(where.moves, moveId)
  const before = join(moveDir, 'before')
  await mkdir(where.moves, { recursive: true, mode: 0o700 })
  await mkdir(moveDir, { mode: 0o700 })
  await mkdir(before, { mode: 0o700 })
  await writeFile(join(moveDir, 'plan.json'), `${JSON.stringify(fresh, null, 2)}\n`)
  const journal = createJournal(moveDir)
  await journal.setStatus('applying')
  const backup = async (path) => {
    const copy = join(before, relHome(home, path))
    await mkdir(dirname(copy), { recursive: true })
    await copyFile(path, copy)
    return copy
  }
  const replace = async (path, text) => {
    const mode = (await stat(path)).mode & 0o777
    await journal.record({ op: 'replace', path, backup: await backup(path), mode, hash: sha256(text) })
    await writeAtomically(fsio, path, text, mode)
  }
  try {
    // 1) 暂存：新会话目录先写进迁移记录里的 staging/，会话根目录这时一个都不碰。
    //    进程在这一步没了，App 看到的还是原样（只多一个迁移记录）。
    const staging = join(moveDir, 'staging')
    await journal.record({ op: 'create', path: staging })
    await mkdir(staging)
    const commits = []
    for (const session of fresh.sessions) {
      const oldDir = join(home, session.from)
      const stagedDir = join(staging, basename(session.to))
      await mkdir(stagedDir, { mode: (await stat(oldDir)).mode & 0o777 })
      const hashes = {}
      for (const name of await readdir(oldDir)) {
        const log = parseLogFileName(name)
        if (log === undefined) {
          await cp(join(oldDir, name), join(stagedDir, name), { recursive: true, errorOnExist: true, force: false })
          continue
        }
        const bytes = await readFile(join(oldDir, name))
        const mode = (await stat(join(oldDir, name))).mode & 0o777
        const rewritten = rewriteHeaderCwd(bytes, log.compression, session.fromCwd, fresh.result.path)
        hashes[name] = sha256(rewritten)
        await writeAtomically(fsio, join(stagedDir, name), rewritten, mode)
      }
      commits.push({ oldDir, stagedDir, finalDir: join(home, session.to), parked: join(before, relHome(home, oldDir)), hashes, tree: await treeHashes(oldDir) })
    }

    // 2) 提交会话：每个会话先把旧目录挪进 before/，再把新目录挪进去。任何时刻同一个会话不会有两份
    //    （有两份时 App 列不出会话）；进程在两次改名之间没了，这个会话只是暂时不见，倒回时挪回来。
    const targetProjectDir = join(where.sessions, fresh.internal.targetProject)
    try {
      await lstat(targetProjectDir)
    } catch (error) {
      if (!isMissing(error)) throw error
      await journal.record({ op: 'mkdir', path: targetProjectDir })
      await mkdir(targetProjectDir)
    }
    for (const item of commits) {
      await mkdir(dirname(item.parked), { recursive: true })
      await journal.record({ op: 'move', from: item.oldDir, to: item.parked, tree: item.tree })
      await fsio.rename(item.oldDir, item.parked)
      if (await present(item.finalDir)) throw new WorkspaceMoveError('target-session-exists', '目标会话目录已被占用。')
      await journal.record({ op: 'move', from: item.stagedDir, to: item.finalDir, hashes: item.hashes })
      await fsio.rename(item.stagedDir, item.finalDir)
    }
    for (const projectDir of new Set(commits.map(item => dirname(item.oldDir)))) {
      if ((await readdir(projectDir)).length > 0) continue
      await journal.record({ op: 'rmdir', path: projectDir })
      await rmdir(projectDir)
    }

    // 3) 工作台自己的数据，4) 最后换登记表（一次原子改名）。
    for (const { id: sessionId } of fresh.sessions) {
      for (const name of CHECKPOINT_FILES) {
        const path = join(where.data, 'checkpoints', sessionId, name)
        const bytes = await readOrUndefined(path)
        if (bytes === undefined) continue
        const { text, fields } = rewriteCheckpointFile(name, bytes.toString('utf8'), fresh.source.path, fresh.result.path)
        if (fields > 0) await replace(path, text)
        else await backup(path)
      }
    }
    const memory = fresh.internal.memory
    if (memory.action === 'move') {
      const oldDir = join(where.data, 'memory', memory.from)
      const newDir = join(where.data, 'memory', memory.to)
      const text = (await readFile(join(oldDir, 'MEMORY.md'))).toString('utf8')
      const content = memoryHeader(memory.toProject) + text.slice(memoryHeader(memory.fromProject).length)
      const staged = join(staging, '.memory')
      await mkdir(staged, { mode: 0o700 })
      await writeAtomically(fsio, join(staged, 'MEMORY.md'), content, 0o600)
      if (await present(newDir)) throw new WorkspaceMoveError('stale-plan', '目标记忆目录已被占用。')
      await journal.record({ op: 'move', from: staged, to: newDir, tree: { '': null, 'MEMORY.md': sha256(content) } })
      await fsio.rename(staged, newDir)
      const parked = join(before, relHome(home, oldDir))
      await mkdir(dirname(parked), { recursive: true })
      await journal.record({ op: 'move', from: oldDir, to: parked, tree: await treeHashes(oldDir) })
      await fsio.rename(oldDir, parked)
    }
    if (fresh.workbench.trust.action !== 'none') {
      const path = join(where.data, TRUST_FILE)
      const raw = (await readFile(path)).toString('utf8')
      const value = JSON.parse(raw)
      value.workspaces = fresh.workbench.trust.action === 'replace'
        ? value.workspaces.map(entry => (entry.path === fresh.source.path ? { ...entry, path: fresh.result.path } : entry))
        : value.workspaces.filter(entry => entry.path !== fresh.source.path)
      await replace(path, formatJson(value, jsonStyle(raw, JSON.parse(raw)) ?? { indent: 2, newline: '\n' }))
    }
    if (fresh.workbench.folders.action === 'merge') {
      const path = join(where.data, FOLDERS_FILE)
      const raw = (await readFile(path)).toString('utf8')
      const value = JSON.parse(raw)
      const settings = value.workspaces ?? {}
      mergeFolderSettings(settings, fresh.source.workspaceId, fresh.result.workspaceId)
      value.workspaces = settings
      await replace(path, formatJson(value, jsonStyle(raw, JSON.parse(raw)) ?? { indent: 2, newline: '\n' }))
    }

    const registryRaw = await readFile(where.registry, 'utf8')
    const registry = JSON.parse(registryRaw)
    const table = registry.tables.workspaces
    const now = new Date().toISOString()
    if (fresh.target.kind === 'workspace') {
      table[fresh.result.workspaceId] = { ...table[fresh.result.workspaceId], sessionIds: fresh.result.sessionIds, updatedAt: now }
      delete table[fresh.source.workspaceId]
      registry.global.workspaceIds = registry.global.workspaceIds.filter(id => id !== fresh.source.workspaceId)
      if (registry.global.defaultWorkspaceId === fresh.source.workspaceId) registry.global.defaultWorkspaceId = fresh.result.workspaceId
    } else {
      table[fresh.source.workspaceId] = { ...table[fresh.source.workspaceId], path: fresh.result.path, title: fresh.result.title, updatedAt: now }
    }
    await replace(where.registry, formatJson(registry, jsonStyle(registryRaw, JSON.parse(registryRaw))))

    await verifyMoved(home, fresh, moveDir)
    await writeFile(join(moveDir, 'after.json'), `${JSON.stringify({ files: await afterHashes(home, journal.state.entries, moveDir) }, null, 2)}\n`)
    await journal.setStatus('done')
    return { moveId, moveDir }
  } catch (error) {
    try {
      await rollback(home, fresh, moveDir, journal, 'rolled-back')
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `会话迁移失败，倒回原样时也出错了；迁移记录在 ${moveDir}`)
    }
    throw error
  }
}

/**
 * 撤回前的检查：记录是不是「做完」，需要放回的目录和字段是否仍能还原。搬过去的会话日志只在末尾追加过（DSH 打开新会话时补的记录、
 * 在新位置接着聊的轮次）不算变过，撤回时这段跟着回到原处。
 * @returns {Promise<object>} undoable、reason 等（见 workspaceMoveUndoCheck），另带 moveDir、plan、journalState、appended 给 undoWorkspaceMove 用。
 */
async function undoState({ home, moveId, failedApply = false }) {
  const moveDir = await moveRecordDirectory(home, moveId)
  const journalState = await readRecord(home, join(moveDir, 'journal.json'))
  if (journalState.status !== 'done') return { undoable: false, reason: 'not-undoable', status: journalState.status }
  const plan = await readRecord(home, join(moveDir, 'plan.json'))
  const inspection = await inspectRollback(home, plan, moveDir, journalState, !failedApply)
  const { changed, appended } = inspection
  if (changed.length > 0) {
    const inSession = (rel, item) => [item.to, item.from, relHome(home, join(moveDir, 'before', item.from))]
      .some(dir => rel === dir || rel.startsWith(dir + sep))
    const sessions = plan.sessions.filter(item => changed.some(rel => inSession(rel, item))).map(item => item.id)
    return { undoable: false, reason: 'changed-since-move', changed, sessions, conflict: inspection.conflict }
  }
  return { undoable: true, moveDir, plan, journalState, appended, inspection }
}

/**
 * 撤回前只读地查一遍。界面点「撤销」时先查，不用等 DSH 退出才知道撤不了；undoWorkspaceMove 动手前也用同一个检查。
 * @param {{ home: string, moveId: string }} options DSH_HOME 和 applyWorkspaceMove 返回的 moveId。
 * @returns {Promise<{ undoable: true, appended?: string[] } | { undoable: false, reason: 'not-undoable', status: string }
 *   | { undoable: false, reason: 'changed-since-move', changed: string[], sessions: string[], conflict?: {code: string, count?: number} }>}
 *   可以撤回（appended 是搬后在日志末尾追加过、撤回时一起带回原处的会话 id）；或者不能撤回的原因：
 *   changed 是改写过、删掉或新出现的文件（相对 DSH_HOME），sessions 是其中属于被搬会话的会话 id。
 */
export async function workspaceMoveUndoCheck({ home, moveId }) {
  home = resolve(home)
  const state = await undoState({ home, moveId })
  if (state.reason === 'not-undoable') return { undoable: false, reason: state.reason, status: state.status }
  if (state.reason === 'changed-since-move') return { undoable: false, reason: state.reason, changed: state.changed, sessions: state.sessions, ...(state.conflict && { conflict: state.conflict }) }
  const appended = [...new Set(state.appended.map(item => item.session.id))]
  return appended.length === 0 ? { undoable: true } : { undoable: true, appended }
}

/**
 * 撤回一次已经做完的迁移：倒着撤每一步，回到搬之前的样子。搬后在会话日志末尾追加的内容接到原件后面一起回到原处；
 * 工作区登记和设置按条目还原，检查点和记忆保留续写内容。
 * @param {object} options 参数。
 * @param {string} options.home DSH_HOME。
 * @param {string} options.moveId applyWorkspaceMove 返回的 moveId。
 * @param {(home: string) => boolean | Promise<boolean>} [options.appRunning] App 是否正在用这个 DSH_HOME（默认 dshAppRunning）。
 * @param {boolean} [options.failedApply] 迁移后的 App 核对失败时按失败回滚，保留迁移前的更新时间。
 * @returns {Promise<{ status: 'undone' | 'rolled-back' }>} 结果。
 * @throws {WorkspaceMoveError} App 在运行、记录不是「做完」、搬后又变过、撤完和原来不一致时。
 */
export async function undoWorkspaceMove({ home, moveId, appRunning = dshAppRunning, failedApply = false }) {
  home = resolve(home)
  if (await appRunning(home)) throw new WorkspaceMoveError('app-running', 'DSH App 正在运行。请先退出 App，再撤回。')
  const state = await undoState({ home, moveId, failedApply })
  if (state.reason === 'not-undoable') throw new WorkspaceMoveError('not-undoable', `这次迁移的状态是 ${state.status}，不能撤回。`)
  if (state.reason === 'changed-since-move') throw rollbackConflict(state)
  const { moveDir, plan, journalState } = state
  return rollback(home, plan, moveDir, createJournal(moveDir, journalState), failedApply ? 'rolled-back' : 'undone', state.inspection)
}

/**
 * 做到一半没做完的迁移：journal 的状态还是 applying，也就是搬的进程半路没了。下次打开 App 时据此提示用户倒回。
 * @param {string} home DSH_HOME。
 * @returns {Promise<{ moveId: string, status: string, source: object, target: object, steps: number }[]>} 按 moveId 排序。
 */
export async function pendingWorkspaceMoves(home) {
  home = resolve(home)
  const moves = locations(home).moves
  if (!(await dataPath(home, moves, true))) return []
  let names
  try {
    names = (await readdir(moves, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const pending = []
  for (const moveId of names.sort()) {
    const journalPath = join(moves, moveId, 'journal.json')
    if (!(await dataPath(home, journalPath))) continue // 不是迁移记录（比如小进程的请求），或者还没开始动手
    const journal = await readRecord(home, journalPath)
    if (journal.status !== 'applying') continue
    const plan = await readRecord(home, join(moves, moveId, 'plan.json'))
    pending.push({ moveId, status: journal.status, source: plan.source, target: plan.target, steps: journal.entries.length })
  }
  return pending
}

/**
 * 把一次做到一半的迁移倒回原样（照 journal 倒着撤）。这次迁移写下的东西之后又被改过（例如日志被改写）就不倒回，
 * 登记、设置和检查点使用与撤销相同的字段核对；已经放回的目录和写入进度保存在 journal。
 * @param {object} options 参数。
 * @param {string} options.home DSH_HOME。
 * @param {string} options.moveId 迁移记录。
 * @param {(home: string) => boolean | Promise<boolean>} [options.appRunning] App 是否正在用这个 DSH_HOME（默认 dshAppRunning）。
 * @returns {Promise<{ status: 'rolled-back' | 'undone' }>} 结果。
 * @throws {WorkspaceMoveError} App 在运行、记录不是 applying、写下的东西又被改过、倒回以后和原来不一致时。
 */
export async function recoverWorkspaceMove({ home, moveId, appRunning = dshAppRunning }) {
  home = resolve(home)
  if (await appRunning(home)) throw new WorkspaceMoveError('app-running', 'DSH App 正在运行。请先退出 App，再倒回。')
  const moveDir = await moveRecordDirectory(home, moveId)
  const journalState = await readRecord(home, join(moveDir, 'journal.json'))
  if (journalState.status !== 'applying') throw new WorkspaceMoveError('not-recoverable', `这次迁移的状态是 ${journalState.status}，不用倒回。`)
  const plan = await readRecord(home, join(moveDir, 'plan.json'))
  return rollback(home, plan, moveDir, createJournal(moveDir, journalState), 'rolled-back')
}

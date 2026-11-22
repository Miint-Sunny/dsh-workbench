/**
 * dsh-workbench/checkpoints 行的宿主端：回到某条消息之前（计划第 10 项，第 37 件）。
 * 每个顶层轮次的 turn/start 给合格会话存一份工作区检查点：git 仓库里存整个工作树的快照
 * （lib/checkpoints-git.js）；不在 git 里的目录记 files 种类，文件工具改文件前整份捕获
 * （lib/checkpoints-files.js）。记录走 lib/checkpoints-store.js。第一个工具执行前等检查点
 * 存完（最多 waitSeconds 秒，超时放行）；路由 list / preview / restore / undo / config 照
 * 接口文档（docs/plans/2026-11-06-检查点接口.md）请求和响应一字不差；启动时和每天清一次
 * 过期的、归档满天数的、会话已不在的检查点。挂接的钩子照官方 dsh-workspace-changes
 * （G 调研 Q1），不写新的会话事件类型。
 */
import { dirname, join } from 'node:path'
import { lstat, mkdir } from 'node:fs/promises'
import { registerFeature } from './features.js'
import { workbenchDataDir } from './data-dir.js'
import { createCheckpointsStore } from './checkpoints-store.js'
import {
  DAY_MS, eligibility, fullBy, parseCheckpointsConfig, readCheckpointsConfig, sessionExpired,
  writeCheckpointsConfig,
} from './checkpoints-state.js'
import {
  canonicalPath, createGitRunner, diffNumstat, hasContentFilters, hasFilterAttributes,
  hasLineEndingRewrites, isInside, locateWorkspace, planGit, resolveGitExecutable, restoreTree,
  snapshotTree, treeComplete,
} from './checkpoints-git.js'
import {
  captureFile, captureNow, filesStateNow, planFilesRestore, previewFiles, relativeInside,
  restoreFiles, restoreTargets,
} from './checkpoints-files.js'

export const name = '@miint-sunny/dsh-workbench/checkpoints'

/** 会话 ID 的字符集：拼进检查点目录名，只放字母、数字、短横线和下划线（照 review 的做法）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** preview 的文件列表最多列多少条（接口文档：files 最多 50 条，total 是全量）。 */
const PREVIEW_FILES_CAP = 50

/** 一 MiB 的字节数。 */
const MIB = 1024 * 1024

/** 文件工具改文件前触发的三个钩子（G 调研 Q1 表第 44 行）。 */
export const FS_INTENTS = ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/**
 * 失败回答的 detail：git、文件系统、配置校验抛出的原始报错。网页端把它原样附在自己按界面语言写的句子后面；
 * 宿主写的中文 message 只供日志和排查，网页端不显示。
 * @param {unknown} error 抛出的值。
 * @returns {string} 原始报错。
 */
const errorDetail = error => String(error?.message ?? error)

/**
 * 会话 ID 和轮次号的基本校验，出错给接口文档 bad-request 的 message。
 * @param {string} sessionId 会话 ID。
 * @param {number} [turn] 轮次号。
 * @returns {string | undefined} 不合法时的原因；合法时 undefined。
 */
const badCoordinate = (sessionId, turn) => {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return '会话 ID 不合法。'
  if (turn !== undefined && (!Number.isSafeInteger(turn) || turn < 1)) return '轮次号不合法。'
  return undefined
}

/**
 * 建一个检查点服务：钩子（turn/start、tools/pre-execute、三个 fs/*-intent、session/disposed、
 * domain/changed）和路由都调它。不 import @deepseek-ai 包，靠注入的 subprocess / fs / agents /
 * sessionPersistence 工作，测试给假的。
 * @param {object} options 注入项。
 * @param {{ spawn: Function, resolveExecutable: Function }} options.subprocess 跑 git 的服务。
 * @param {{ processPath: (target: object) => string }} [options.fs] 把文件工具的目标换成进程路径（files 种类用）。
 * @param {{ get: (id: string) => { status?: string } | undefined }} options.agents 会话运行态。
 * @param {{ list: () => Promise<{ header: { id: string } }[]> }} [options.sessionPersistence] 持久会话清单（对账清理用）。
 * @param {string} options.dataRoot 检查点根目录（`$DSH_HOME/dsh-workbench/checkpoints`）。
 * @param {string} [options.configDir] 配置目录；缺省是 dataRoot 的上一层（workbenchDataDir）。
 * @param {() => number} [options.clock] 时间戳，测试注入固定的。
 * @param {{ warn: Function, info: Function }} [options.logger] 日志。
 * @returns {object} 服务：list / preview / restore / undo、config 路由处理、钩子入口、清理和卸载。
 */
export function createCheckpointsService(options) {
  const { subprocess, fs, agents, sessionPersistence, dataRoot, clock = Date.now } = options
  const logger = options.logger ?? console
  const configDir = options.configDir ?? join(dataRoot, '..')
  const store = createCheckpointsStore(dataRoot)
  const configOf = () => readCheckpointsConfig(configDir)

  // git 运行器只解析一次；解析不出可用的 git 时记住 null：新轮次记 files 种类，git 种类的
  // 检查点答 git-unavailable。
  let runnerPromise
  const runner = () => {
    runnerPromise ??= resolveGitExecutable(subprocess, undefined).then(async executable => {
      if (executable === null) {
        logger.warn?.('@miint-sunny/dsh-workbench/checkpoints: 找不到可用的 git，只能记文件工具改过的文件')
        return null
      }
      // 钩子空目录固定放在数据目录下（建好不删），不在系统临时目录里每次启动留一个。
      const hooksDir = join(dataRoot, '.no-hooks')
      await mkdir(hooksDir, { recursive: true })
      return createGitRunner(subprocess, executable, { hooksDir })
    })
    return runnerPromise
  }

  /** 每个会话一条串行队列（照官方 enqueue 写法）：存检查点、捕获文件、恢复都排在这里。 */
  const queues = new Map()
  let closing = false
  // Startup pruning and workspace notifications both rewrite the archive index.
  // Serialize them and keep their settlement observable during row teardown.
  let archiveWork = Promise.resolve()
  const queueArchive = task => {
    if (closing) return Promise.resolve()
    const operation = archiveWork.then(task)
    archiveWork = operation.catch(() => {})
    return operation
  }
  const chainTask = (sessionId, task) => {
    // 前一个任务不管成败，这一个都接着跑；链条本身不保留失败。
    const next = (queues.get(sessionId) ?? Promise.resolve()).then(task, task)
    const settledTask = next.catch(() => {})
    queues.set(sessionId, settledTask)
    void settledTask.then(() => { if (queues.get(sessionId) === settledTask) queues.delete(sessionId) })
    return next
  }
  const enqueue = (sessionId, task) =>
    chainTask(sessionId, task).catch(error => {
      logger.warn?.(`dsh-workbench/checkpoints: ${sessionId} 的检查点没存上：${String(error?.stack ?? error)}`)
    })
  const settled = sessionId => queues.get(sessionId) ?? Promise.resolve()

  // 会话头：turn/start 时记下，list / restore 判断合格性用；会话释放时放掉。
  const headers = new Map()
  // files 种类的会话这一轮的捕获（不在 git 里的目录、或有内容过滤器的仓库）：{ turn, seq, time, root, captures }。
  const filesTurns = new Map()
  // 这一轮的检查点还在排队的会话：种类还没定下来，fs/*-intent 最多再等 waitSeconds（第 40 件 #8）。
  const pendingTurns = new Set()
  // 警告只记一次的仓库根（数据目录在仓库里、有内容过滤器）。
  const warnedRoots = new Set()
  // tools/pre-execute 收到的 exec → 会话 ID；fs/*-intent 的 actor 就是同一个 exec（G 调研 Q1）。
  const mutations = new WeakMap()
  // 正在恢复的会话（busy）；占用大小只在写入后重算，缓存到下一次写入。
  const working = new Set()
  const sizes = new Map()
  // 恢复/撤销进行中的会话 → 完成时解决的 promise（恢复锁，第 40 件 #5）。
  const restoreLocks = new Map()

  /**
   * 给一个合格会话存这一轮的检查点：git 仓库里快照整个工作树；不在仓库里（或没有 git）
   * 记 files 种类，这一轮文件工具碰到的文件在改之前捕获。两种仓库整个不存：数据目录在
   * 仓库里面（快照和恢复都会缠上别的会话的存储，第 40 件 #12）；仓库里有内容过滤器
   * （filter= 属性，包括 lfs——快照会跑仓库里的 clean/smudge 命令，第 40 件 #7），后者改按
   * files 种类存（files 种类不跑 git）。
   * @param {string} sessionId 会话 ID。
   * @param {number} turn 轮次号。
   * @param {number} seq turn/start 事件的序号。
   * @param {string} cwd 会话工作目录。
   * @returns {Promise<void>}
   */
  const storeCheckpoint = async (sessionId, turn, seq, cwd) => {
    try {
      const config = configOf()
      const meta = await store.readMeta(sessionId)
      filesTurns.delete(sessionId)
      // 大小只在写入后重算：这一轮先按缓存（重启后第一次现算一次）判断，满了不再存新的，
      // 但要把 full 记进 meta（上限调小后 list 也要能答出已满）。
      const size = sizes.get(sessionId) ?? await store.sizeBytes(sessionId)
      if (fullBy(size, config.maxStoreMB)) {
        if (meta !== undefined && meta.full !== true) await store.writeMeta(sessionId, { ...meta, full: true })
        return
      }
      const git = await runner()
      const workspace = git === null ? null : await locateWorkspace(git, cwd, store.sessionDir(sessionId), dataRoot)
      let kind
      let root
      if (workspace === null) {
        kind = 'files'
        root = await canonicalPath(cwd)
      } else if (workspace.excludes.length > 0) {
        // 检查点数据目录在这个仓库里面：快照范围是整个仓库，恢复会回退别的项目的文件、
        // 删掉别的会话的存储。整个仓库不存检查点，警告每个仓库一次。
        if (!warnedRoots.has(workspace.root)) {
          warnedRoots.add(workspace.root)
          logger.warn?.(`dsh-workbench/checkpoints: 检查点目录在仓库里面（${workspace.root}），这个仓库不存检查点`)
        }
        return
      } else if (await hasFilterAttributes(git, workspace)) {
        // 有内容过滤器：git 种类的快照和恢复都会跑仓库里配置的过滤器命令，改按 files 种类存。
        if (!warnedRoots.has(workspace.root)) {
          warnedRoots.add(workspace.root)
          logger.info?.(`dsh-workbench/checkpoints: 仓库里有内容过滤器（${workspace.root}），按文件工具改过的文件存`)
        }
        kind = 'files'
        root = await canonicalPath(cwd)
      } else {
        kind = 'git'
        root = workspace.root
        const tree = await snapshotTree(git, workspace)
        await store.appendEntry(sessionId, { turn, seq, time: clock(), kind, tree })
      }
      if (kind === 'files') {
        const time = clock()
        filesTurns.set(sessionId, { turn, seq, time, root, captures: {} })
        await store.appendEntry(sessionId, { turn, seq, time, kind, root, captures: {} })
      }
      // 存完重算这一会话的占用，满了记进 meta，list 照它回答；上限调大了要能解除。
      const bytes = await store.sizeBytes(sessionId)
      sizes.set(sessionId, bytes)
      const full = fullBy(bytes, config.maxStoreMB)
      if (full) logger.info?.(`dsh-workbench/checkpoints: ${sessionId} 的检查点已满（${bytes} 字节），新的轮次不再存`)
      if (meta === undefined || meta.cwd !== cwd || meta.root !== root || meta.kind !== kind || full !== (meta.full === true)) {
        await store.writeMeta(sessionId, { cwd, root, kind, full })
      }
    } finally {
      pendingTurns.delete(sessionId)
    }
  }

  /**
   * files 种类：这一轮第一次碰到一个路径时捕获它改之前的内容，追加一条只带这个路径的
   * 增量记录（读记录时同一轮的合起来，第 40 件 #15——整张表每个文件抄一遍会翻倍增长）。
   * 不是 files 种类的会话、工作目录外的路径不记。
   * @param {string} sessionId 会话 ID。
   * @param {string} path 文件工具要改的进程路径。
   * @returns {Promise<void>}
   */
  const captureTarget = async (sessionId, path) => {
    const state = filesTurns.get(sessionId)
    if (state === undefined) return
    const rel = relativeInside(state.root, await canonicalPath(path))
    if (rel === undefined || state.captures[rel] !== undefined) return
    const capture = await captureFile(join(state.root, rel), store.capturesDir(sessionId), configOf().maxFileMB * MIB)
    if (capture === undefined) return
    state.captures[rel] = capture
    sizes.delete(sessionId)
    await store.appendEntry(sessionId, { turn: state.turn, seq: state.seq, time: state.time, kind: 'files', root: state.root, captures: { [rel]: capture } })
  }

  /**
   * session/event 钩子：turn/start 时给合格会话排队存检查点（监听器本身不 await，
   * session/event 不会等它）。
   * @param {{ id: string, header: object }} session 会话。
   * @param {{ type: string, seq: number, data?: { turn?: number } }} event 会话事件。
   * @returns {void}
   */
  const onSessionEvent = (session, event) => {
    if (event.type !== 'turn/start') return
    const header = session?.header
    headers.set(session.id, header)
    if (!eligibility(header, configOf()).eligible) {
      filesTurns.delete(session.id)
      pendingTurns.delete(session.id)
      return
    }
    pendingTurns.add(session.id)
    enqueue(session.id, () => storeCheckpoint(session.id, event.data.turn, event.seq, header.cwd))
  }

  /**
   * tools/pre-execute 钩子（waterfall）：记下 exec 属于哪个会话，等这个会话排着的检查点
   * 存完，最多 waitSeconds 秒，超时放行并记一条日志。这个会话正在恢复/撤销时一直等到做完
   * （恢复锁，不受 waitSeconds 限制，第 40 件 #5——恢复进行中放行写工具，恢复会把它写
   * 的覆盖掉）；必须 return next()。
   * @param {{ agent?: { session?: { id: string } } }} exec 工具执行请求。
   * @param {Function} next 链上下一个监听器。
   * @returns {Promise<*>} next() 的决定。
   */
  const onPreExecute = async (exec, next) => {
    const sessionId = exec?.agent?.session?.id
    if (sessionId !== undefined && headers.has(sessionId)) {
      mutations.set(exec, sessionId)
      const lock = restoreLocks.get(sessionId)
      if (lock !== undefined) await lock
      const waitSeconds = configOf().waitSeconds
      let timer
      const timedOut = new Promise(resolve => {
        timer = setTimeout(() => resolve(true), waitSeconds * 1000)
        timer.unref?.()
      })
      const late = await Promise.race([settled(sessionId).then(() => false), timedOut])
      clearTimeout(timer)
      if (late) logger.warn?.(`dsh-workbench/checkpoints: ${sessionId} 的检查点 ${waitSeconds} 秒内没存完，先放行工具执行`)
    }
    return next()
  }

  /**
   * fs/write-intent、fs/edit-intent、fs/delete-intent 钩子（waterfall，注册时 prepend）：
   * 先 await next() 拿到放行的 intent，再在提供方真正改文件之前捕获，最后原样交回 intent。
   * 捕获只在这一轮是 files 种类（或检查点还在排队、种类没定）时等，最多再等 waitSeconds：
   * git 种类的会话不捕获不等，一个永远不结束的任务不能拖住别的会话的文件工具（第 40 件 #8）。
   * 等超了的捕获不再记——排队排到时文件早被改过，记下来的就不是「改动前」（第 40 件 #8）。
   * @param {object} target 文件工具的目标（FsTarget）。
   * @param {object | undefined} actor tools/pre-execute 收到的同一个 exec。
   * @param {Function} next 链上下一个监听器。
   * @returns {Promise<*>} next() 给的 intent。
   */
  const onFsIntent = async (target, actor, next) => {
    const intent = await next()
    const sessionId = actor === undefined ? undefined : mutations.get(actor)
    if (sessionId === undefined || fs === undefined) return intent
    if (!filesTurns.has(sessionId) && !pendingTurns.has(sessionId)) return intent
    let path
    try {
      path = fs.processPath(target)
    } catch (error) {
      // 非本地目标（远程会话的 fs）解析不出进程路径：不记，也别把异常带进文件工具。
      logger.warn?.(`dsh-workbench/checkpoints: ${sessionId} 的文件目标解析不出进程路径，没记：${String(error?.message ?? error)}`)
      return intent
    }
    const waitSeconds = configOf().waitSeconds
    const deadline = clock() + waitSeconds * 1000
    let timer
    const timedOut = new Promise(resolve => {
      timer = setTimeout(() => resolve(true), waitSeconds * 1000)
      timer.unref?.()
    })
    const late = await Promise.race([
      chainTask(sessionId, async () => {
        if (clock() > deadline) {
          logger.warn?.(`dsh-workbench/checkpoints: ${sessionId} 的捕获没赶上（排队的检查点超过 ${waitSeconds} 秒），没记这一条`)
          return
        }
        await captureTarget(sessionId, path)
      }).then(() => false),
      timedOut,
    ])
    clearTimeout(timer)
    if (late) logger.warn?.(`dsh-workbench/checkpoints: ${sessionId} 的捕获 ${waitSeconds} 秒内没排上，先放行文件工具`)
    return intent
  }

  /** session/disposed 钩子：只放内存状态和排着的活，不删磁盘数据（检查点要跨重启）。 */
  const onSessionDisposed = sessionId => {
    headers.delete(sessionId)
    filesTurns.delete(sessionId)
    pendingTurns.delete(sessionId)
    // A detached Session can still have a write in flight; the queue retires on settlement.
    sizes.delete(sessionId)
    working.delete(sessionId)
  }

  /**
   * list 路由的处理：只读记录文件，不碰 git，所以便宜；检查点还在不在（失效）留到
   * preview / restore 才核对。undo 只在还没过期时给（第 40 件 #1）：files 种类读文件真核对
   * （afterCaptures）；git 种类核对要快照整棵树，太贵，用内存标记——恢复之后这个会话又存过
   * 检查点或捕获过文件就当可能过期（undo 路由再用树核对兜底）。
   * @param {string} sessionId 会话 ID。
   * @returns {Promise<Response>} `{ ok, eligible, full, entries, undo }`。
   */
  const list = async sessionId => {
    const problem = badCoordinate(sessionId)
    if (problem !== undefined) return json({ ok: false, reason: 'bad-request', message: problem }, 400)
    const meta = await store.readMeta(sessionId)
    const entries = await store.readEntries(sessionId)
    const header = headers.get(sessionId)
    // 会话活着按它的头判断；重启后没头但有 meta（存过检查点）也当合格，否则答不合格。
    const eligible = header !== undefined ? eligibility(header, configOf()).eligible : meta !== undefined
    const restorePoint = await store.readRestore(sessionId)
    // 撤销点之后有任何一条检查点（轮次开始的时间）就当过期：恢复之后新开的轮次一定晚于
    // 恢复时间。只看盘上的数据，App 重启后也成立，不用读文件、不用快照；undo 路由里
    // afterTree / afterCaptures 的真核对留着兜底（手改文件这类不存检查点的改动）。
    const stale = restorePoint !== undefined && entries.some(entry => entry.time > restorePoint.time)
    const undo = restorePoint !== undefined && !stale ? { time: restorePoint.time, turn: restorePoint.turn } : null
    return json({
      ok: true,
      eligible,
      full: meta?.full === true,
      entries: entries.map(entry => ({ turn: entry.turn, seq: entry.seq, time: entry.time, kind: entry.kind })),
      undo,
    })
  }

  /** 两个「路径 → 状态」表是不是一样（撤销的过期核对用）。 */
  const sameState = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      const left = a[key]
      const right = b[key]
      const same = left === undefined || right === undefined
        ? left === right
        : left.kind === right.kind && left.sha1 === right.sha1 && left.mode === right.mode
      if (!same) return false
    }
    return true
  }

  /**
   * 会话工作目录和它在仓库根之内的祖先（恢复删空目录时绝不清它们，第 40 件 #10）。
   * @param {string} root 仓库根。
   * @param {string} cwd 会话工作目录。
   * @returns {Promise<Set<string>>} 绝不删的绝对目录。
   */
  const keepDirsOf = async (root, cwd) => {
    const keep = new Set()
    let dir = await canonicalPath(cwd)
    while (isInside(root, dir) && dir !== root) {
      keep.add(dir)
      dir = dirname(dir)
    }
    return keep
  }

  /**
   * git 种类的会话工作目录已不在任何 git 仓库里（仓库被删除或移走）：答 409 not-in-repo，带上
   * 记录里的工作目录，一个文件都不碰。
   * @param {string} cwd 会话工作目录（meta.cwd）。
   * @returns {Response} 失败回答。
   */
  const notInRepo = cwd => json({ ok: false, reason: 'not-in-repo', cwd, message: `工作目录 ${cwd} 已不在 git 仓库中。` }, 409)

  /**
   * 打开一个会话一轮的恢复材料。git 种类要定位仓库、核对检查点整棵树都在（treeComplete，
   * 缺一个对象就答 expired，不碰文件，第 40 件 #6）；files 种类只读记录。files 用条目自己
   * 的 root（第 40 件 #2），旧记录没有就回落到 meta。
   * @param {string} sessionId 会话 ID。
   * @param {number} turn 轮次号。
   * @returns {Promise<{ response: Response } | { kind: 'git', meta: object, entry: object, git: object, workspace: object } | { kind: 'files', meta: object, entries: object[], entry: object, root: string }>} 恢复材料或错误回答。
   */
  const openForRestore = async (sessionId, turn) => {
    const meta = await store.readMeta(sessionId)
    const entries = await store.readEntries(sessionId)
    const entry = entries.find(item => item.turn === turn)
    if (meta === undefined || entry === undefined) {
      const header = headers.get(sessionId)
      const reason = header !== undefined && !eligibility(header, configOf()).eligible ? 'not-eligible' : 'no-checkpoint'
      return { response: json({ ok: false, reason, message: '此轮没有检查点。' }, 404) }
    }
    if (entry.kind === 'files') return { kind: 'files', meta, entries, entry, root: entry.root ?? meta.root }
    const git = await runner()
    if (git === null) {
      return { response: json({ ok: false, reason: 'git-unavailable', message: '未找到可用的 git。' }, 503) }
    }
    const workspace = await locateWorkspace(git, meta.cwd, store.sessionDir(sessionId), dataRoot)
    if (workspace === null) return { response: notInRepo(meta.cwd) }
    if (!await treeComplete(git, workspace, entry.tree)) {
      return { response: json({ ok: false, reason: 'expired', message: '此轮的检查点已失效：仓库中的对应内容已被清理。' }, 410) }
    }
    return { kind: 'git', meta, entry, git, workspace }
  }

  /**
   * git 种类的预览：用 planGit 算计划（和恢复共用同一个，第 40 件 #13），先列删除、再列
   * 恢复、最后列跳过。
   * @param {{ meta: object, entry: object, git: object, workspace: object }} opened openForRestore 的结果。
   * @returns {Promise<object>} 预览的响应体。
   */
  const previewGit = async ({ meta, entry, git, workspace }) => {
    const nowTree = await snapshotTree(git, workspace)
    const plan = await planGit(git, workspace, nowTree, entry.tree)
    const numstat = await diffNumstat(git, workspace, nowTree, entry.tree)
    // 行数：改名在 numstat 里是一条（path 是新路径），操作表里是删旧加新，旧的那条记 0/0。
    const counts = new Map()
    for (const record of numstat) {
      counts.set(record.path, record)
      if (record.oldPath !== undefined && !counts.has(record.oldPath)) counts.set(record.oldPath, { ...record, added: 0, deleted: 0 })
    }
    const notes = []
    if (plan.gitignoreChanged) notes.push('gitignore-changed')
    // 内容过滤器（filter=）和换行改写（text/eol 属性、core.autocrlf）都走同一条说明。
    if (await hasContentFilters(git, workspace, plan.raw.map(item => item.path))
      || await hasLineEndingRewrites(git, workspace, plan.raw.map(item => item.path))) notes.push('lfs-or-filters')
    const row = (path, extra) => {
      const record = counts.get(path)
      return { path, added: record?.added ?? 0, deleted: record?.deleted ?? 0, binary: record?.binary ?? false, ...extra }
    }
    const files = []
    for (const path of plan.deletes) files.push(row(path, { action: 'delete' }))
    for (const path of plan.writes) files.push(row(path, { action: 'restore' }))
    for (const item of plan.skipped) files.push(row(item.path, { action: 'skip', reason: item.reason }))
    const cwdInside = meta.cwd === workspace.root || await canonicalPath(meta.cwd) === workspace.root
    return { root: workspace.root, cwdInside, kind: 'git', files, notes }
  }

  /**
   * preview 路由的处理：算会变的文件列表（弹窗打开时现算，列的就是点「恢复文件」后真会
   * 变的文件，和恢复共用计划）；`counts` 另给每种动作的数量（第 40 件 #13）。
   * @param {string} sessionId 会话 ID。
   * @param {number} turn 轮次号。
   * @returns {Promise<Response>} `{ ok, root, cwdInside, kind, files, total, truncated, counts, notes }`。
   */
  const preview = async (sessionId, turn) => {
    const problem = badCoordinate(sessionId, turn)
    if (problem !== undefined) return json({ ok: false, reason: 'bad-request', message: problem }, 400)
    const opened = await openForRestore(sessionId, turn)
    if ('response' in opened) return opened.response
    const body = opened.kind === 'files'
      ? {
        root: opened.root,
        cwdInside: opened.root === await canonicalPath(opened.meta.cwd),
        kind: 'files',
        files: await previewFiles(opened.root, store.capturesDir(sessionId), restoreTargets(opened.entries, turn), configOf().maxFileMB * MIB),
        notes: ['nongit'],
      }
      : await previewGit(opened)
    const total = body.files.length
    const listed = body.files.slice(0, PREVIEW_FILES_CAP)
    const counts = { restore: 0, delete: 0, skip: 0 }
    for (const file of body.files) counts[file.action] += 1
    return json({
      ok: true, root: body.root, cwdInside: body.cwdInside, kind: body.kind,
      files: listed, total, truncated: total > listed.length, counts, notes: body.notes,
    })
  }

  /**
   * 恢复类操作（restore / undo）的公共骨架：会话运行中拒绝（running）、同一个会话同时
   * 只做一件事（busy）、排进这个会话的串行队列做，排到了再查一次运行中（第 40 件 #5：
   * 排队等的时候会话可能开跑了，这时恢复一个文件都不碰）。期间挂一把恢复锁：恢复没做完，
   * 这个会话的 tools/pre-execute 一直等（不受 waitSeconds 限制），恢复进行中新的一轮不
   * 抢着写。期间别的错误由路由按 failed 答。
   * @param {string} sessionId 会话 ID。
   * @param {() => Promise<Response>} work 要做的事。
   * @returns {Promise<Response>} work 的回答或 running / busy。
   */
  const mutate = async (sessionId, work) => {
    if (agents.get(sessionId)?.status === 'running') {
      return json({ ok: false, reason: 'running', message: '会话进行中，结束后才能回到这一轮开始前。' }, 409)
    }
    if (working.has(sessionId)) {
      return json({ ok: false, reason: 'busy', message: '正在处理另一个检查点，请稍后重试。' }, 409)
    }
    working.add(sessionId)
    let releaseLock
    const lock = new Promise(resolve => { releaseLock = resolve })
    restoreLocks.set(sessionId, lock)
    try {
      return await chainTask(sessionId, async () => {
        if (agents.get(sessionId)?.status === 'running') {
          return json({ ok: false, reason: 'running', message: '会话进行中，结束后才能回到这一轮开始前。' }, 409)
        }
        return await work()
      })
    } finally {
      releaseLock()
      restoreLocks.delete(sessionId)
      working.delete(sessionId)
      sizes.delete(sessionId)
    }
  }

  /**
   * restore 路由的处理：恢复前先把现在的状态存成「恢复前」检查点（每个会话只留最近一次），
   * 再恢复，恢复完把「刚恢复完的状态」也记进撤销点（撤销的过期判断用）。git 种类恢复整个
   * 仓库（不清会话工作目录和祖先）；files 种类按共用计划写回第 N 轮及以后碰过的文件（跟
   * 着符号链接出工作区的、现在超上限的都不碰）。做到一半失败时把已经改了哪些写进回答，
   * 撤销点留在盘上。
   * @param {string} sessionId 会话 ID。
   * @param {number} turn 轮次号。
   * @returns {Promise<Response>} `{ ok, restored, skipped }`。
   */
  const restore = async (sessionId, turn) => {
    const problem = badCoordinate(sessionId, turn)
    if (problem !== undefined) return json({ ok: false, reason: 'bad-request', message: problem }, 400)
    return mutate(sessionId, async () => {
      const opened = await openForRestore(sessionId, turn)
      if ('response' in opened) return opened.response
      const config = configOf()
      if (opened.kind === 'files') {
        const maxBytes = config.maxFileMB * MIB
        const capturesDir = store.capturesDir(sessionId)
        const targets = restoreTargets(opened.entries, turn)
        const plan = await planFilesRestore(opened.root, capturesDir, targets, maxBytes)
        const actionable = plan.filter(item => item.action !== 'skip').map(item => item.path)
        // 没有要改的文件（「恢复并分叉」不看预览照样调恢复）：不写撤销点，此前那次恢复还能撤销。
        if (actionable.length === 0) {
          const result = await restoreFiles(opened.root, capturesDir, targets, maxBytes, plan)
          return json({ ok: true, restored: result.restored, skipped: result.skipped })
        }
        // 撤销点只存真会动的路径的「现在」，跳过的那些反正不会动。
        const undoCaptures = await captureNow(opened.root, capturesDir, actionable, maxBytes)
        await store.writeRestore(sessionId, { time: clock(), turn, kind: 'files', root: opened.root, captures: undoCaptures })
        let result
        try {
          // 存撤销点用的就是上面那份计划，传进去不再算一遍。
          result = await restoreFiles(opened.root, capturesDir, targets, maxBytes, plan)
        } catch (error) {
          return json(interruptedFailure('restore', error), 500)
        }
        const afterCaptures = await filesStateNow(opened.root, actionable, maxBytes)
        await store.writeRestore(sessionId, { time: clock(), turn, kind: 'files', root: opened.root, captures: undoCaptures, afterCaptures })
        return json({ ok: true, restored: result.restored, skipped: result.skipped })
      }
      const { entry, meta, git, workspace } = opened
      const nowTree = await snapshotTree(git, workspace)
      const plan = await planGit(git, workspace, nowTree, entry.tree)
      // 和要回到的一样，没有要写要删的：同上，不写撤销点。
      if (plan.writes.length === 0 && plan.deletes.length === 0) return json({ ok: true, restored: 0, skipped: plan.skipped })
      // 撤销点先落盘再动工作区：做到一半失败时它还在。
      await store.writeRestore(sessionId, { time: clock(), turn: entry.turn, kind: 'git', root: workspace.root, tree: nowTree })
      const keepDirs = await keepDirsOf(workspace.root, meta.cwd)
      let result
      try {
        result = await restoreTree(git, workspace, entry.tree, { nowTree, keepDirs, plan })
      } catch (error) {
        return json(interruptedFailure('restore', error), 500)
      }
      await store.writeRestore(sessionId, { time: clock(), turn: entry.turn, kind: 'git', root: workspace.root, tree: nowTree, afterTree: result.afterTree })
      return json({ ok: true, restored: result.restored, skipped: result.skipped })
    })
  }

  /**
   * 写回做到一半失败的回答体（500 failed）：operation 是哪一种写回，changed 是已经改动的路径
   * （error.changedPaths，没有时为空数组），detail 是原始报错。句子由网页端按界面语言写；
   * message 只供日志和排查。撤销点都留在盘上。
   * @param {'restore' | 'undo'} operation 恢复还是撤销。
   * @param {unknown} error 写回时抛出的值。
   * @returns {{ ok: false, reason: 'failed', operation: 'restore' | 'undo', changed: string[], detail: string, message: string }} 回答体。
   */
  const interruptedFailure = (operation, error) => {
    const changed = Array.isArray(error?.changedPaths) ? error.changedPaths : []
    const detail = errorDetail(error)
    const changedNote = changed.length > 0 ? `已修改：${changed.join('、')}。` : '尚未修改任何文件。'
    const message = `${operation === 'restore' ? '恢复' : '撤销'}中途失败：${detail}。${changedNote}撤销点已保留，可撤销。`
    return { ok: false, reason: 'failed', operation, changed, detail, message }
  }

  /**
   * undo 路由的处理：撤销点只在「现在的工作区和刚恢复完的一致」时能用（第 40 件 #1），
   * 不一致答 409 undo-stale（用 restore.json 里记的 afterTree / afterCaptures 核对，旧撤销点
   * 没有核对依据就不核）。保留原撤销目标，部分失败时更新实际状态供重试；全部成功后
   * 清掉撤销点（list 的 undo 回到 null），要再回去走正常的恢复。
   * @param {string} sessionId 会话 ID。
   * @returns {Promise<Response>} `{ ok, restored, skipped }`。
   */
  const undo = async sessionId => {
    const problem = badCoordinate(sessionId)
    if (problem !== undefined) return json({ ok: false, reason: 'bad-request', message: problem }, 400)
    return mutate(sessionId, async () => {
      const restorePoint = await store.readRestore(sessionId)
      if (restorePoint === undefined) return json({ ok: false, reason: 'no-checkpoint', message: '没有可撤销的恢复。' }, 404)
      const meta = await store.readMeta(sessionId)
      if (meta === undefined) return json({ ok: false, reason: 'no-checkpoint', message: '当前会话没有检查点。' }, 404)
      const config = configOf()
      if (restorePoint.captures !== undefined) {
        const root = restorePoint.root ?? meta.root
        const maxBytes = config.maxFileMB * MIB
        const paths = Object.keys(restorePoint.captures)
        if (restorePoint.afterCaptures !== undefined
          && !sameState(restorePoint.afterCaptures, await filesStateNow(root, paths, maxBytes))) {
          return json({ ok: false, reason: 'undo-stale', message: '恢复后工作区已有改动，无法撤销；撤销点已保留。' }, 409)
        }
        const capturesDir = store.capturesDir(sessionId)
        let result
        try {
          result = await restoreFiles(root, capturesDir, new Map(Object.entries(restorePoint.captures)), maxBytes)
        } catch (error) {
          await store.writeRestore(sessionId, { ...restorePoint, afterCaptures: await filesStateNow(root, paths, maxBytes) })
          return json(interruptedFailure('undo', error), 500)
        }
        if (result.skipped.length > 0) {
          await store.writeRestore(sessionId, { ...restorePoint, afterCaptures: await filesStateNow(root, paths, maxBytes) })
          return json({ ok: false, reason: 'failed', restored: result.restored, skipped: result.skipped, message: '撤销未完成，撤销点已保留，可在排除失败原因后重试。' }, 500)
        }
        await store.clearRestore(sessionId)
        return json({ ok: true, restored: result.restored, skipped: result.skipped })
      }
      const git = await runner()
      if (git === null) return json({ ok: false, reason: 'git-unavailable', message: '未找到可用的 git。' }, 503)
      const workspace = await locateWorkspace(git, meta.cwd, store.sessionDir(sessionId), dataRoot)
      if (workspace === null) return notInRepo(meta.cwd)
      const nowTree = await snapshotTree(git, workspace)
      if (restorePoint.afterTree !== undefined && nowTree !== restorePoint.afterTree) {
        return json({ ok: false, reason: 'undo-stale', message: '恢复后工作区已有改动，无法撤销；撤销点已保留。' }, 409)
      }
      if (!await treeComplete(git, workspace, restorePoint.tree)) {
        return json({ ok: false, reason: 'expired', message: '恢复前的检查点已失效：仓库中的对应内容已被清理。' }, 410)
      }
      const keepDirs = await keepDirsOf(workspace.root, meta.cwd)
      let result
      try {
        result = await restoreTree(git, workspace, restorePoint.tree, { nowTree, keepDirs })
      } catch (error) {
        await store.writeRestore(sessionId, { ...restorePoint, afterTree: await snapshotTree(git, workspace) })
        return json(interruptedFailure('undo', error), 500)
      }
      if (result.skipped.length > 0) {
        await store.writeRestore(sessionId, { ...restorePoint, afterTree: result.afterTree })
        return json({ ok: false, reason: 'failed', restored: result.restored, skipped: result.skipped, message: '撤销未完成，撤销点已保留，可在排除失败原因后重试。' }, 500)
      }
      await store.clearRestore(sessionId)
      return json({ ok: true, restored: result.restored, skipped: result.skipped })
    })
  }

  /** config 路由的处理：GET 读、POST 校验后写，回答 `{ ok, config }`（照接口文档）。 */
  const configFetch = async request => {
    if (request.method === 'GET') return json({ ok: true, config: readCheckpointsConfig(configDir) })
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, reason: 'bad-request', message: '请求体不是 JSON。' }, 400)
    }
    let config
    try {
      config = parseCheckpointsConfig(body)
    } catch (error) {
      const detail = errorDetail(error)
      return json({ ok: false, reason: 'bad-request', detail, message: detail }, 400)
    }
    try {
      writeCheckpointsConfig(configDir, config)
    } catch (error) {
      // 校验过了还写不进（磁盘满、权限）：是服务器的事，不是请求的事。
      const detail = errorDetail(error)
      return json({ ok: false, reason: 'failed', detail, message: `配置保存失败：${detail}` }, 500)
    }
    return json({ ok: true, config })
  }

  /**
   * 清理：启动时一次，之后每天一次（照 lib/review/index.js 的做法）。①检查点都超过
   * keepDays 的会话目录整个删（「列表是空的」不算过期，按目录修改时间判，第 40 件 #14）；
   * ②归档满 keepDays 天的再删（归档时间由 domain/changed 记在 archived.json）；③对账
   * sessionPersistence，会话不在了的目录删。删一个会话的目录要走这个会话自己的写队列，
   * 到队头再核一遍——不然清理撞上正在存的检查点（第一次快照 jsonl 还没落盘）会把目录
   * 连着新检查点一起删掉。占用上限不在这里管（存的时候置 full）。
   * @returns {Promise<void>}
   */
  const cleanup = () => queueArchive(async () => {
    const config = configOf()
    const now = clock()
    const sessions = await store.listSessionIds()
    const archived = await store.readArchived()
    const live = sessionPersistence === undefined ? null : new Set((await sessionPersistence.list()).map(item => item.header.id))
    const keep = { ...archived }
    for (const sessionId of sessions) {
      const entries = await store.readEntries(sessionId)
      const expired = sessionExpired(entries, now, config.keepDays, await store.sessionMtime(sessionId))
      const archivedOld = keep[sessionId] !== undefined && now - keep[sessionId] >= config.keepDays * DAY_MS
      const gone = live !== null && !live.has(sessionId)
      if (!expired && !archivedOld && !gone) continue
      // 到这个会话的写队列队头再删：正在存的检查点排在删除前面，删的时候按最新状态
      // 重新核一遍，不误删（gone 的不用核，会话已经不在了）。
      await chainTask(sessionId, async () => {
        const stillExpired = sessionExpired(await store.readEntries(sessionId), clock(), config.keepDays, await store.sessionMtime(sessionId))
        if (gone || stillExpired || archivedOld) {
          await store.removeSession(sessionId)
          delete keep[sessionId]
          sizes.delete(sessionId)
        }
      }).catch(error => {
        logger.warn?.(`dsh-workbench/checkpoints: 清 ${sessionId} 没删成：${String(error?.stack ?? error)}`)
      })
    }
    await store.writeArchived(keep)
  })

  /**
   * domain/changed 钩子：归档、取消归档都从 workspace 域的全局记录看（G 调研 Q4），记下
   * 每个会话被归档的时间，满 keepDays 天的由清理删。
   * @param {{ domain?: string, table?: string, operation?: string, value?: { archivedSessionIds?: string[] } }} change 域变化。
   * @returns {void | Promise<void>} workspace 全局归档列表的写入完成时兑现，其余变化直接返回。
   */
  const onDomainChanged = change => {
    if (change?.domain !== 'workspace' || change?.table !== '' || change?.operation !== 'put') return
    const ids = change.value?.archivedSessionIds
    if (!Array.isArray(ids)) return
    return queueArchive(async () => {
      try {
        const sessions = await store.listSessionIds()
        const archived = await store.readArchived()
        for (const id of sessions) {
          if (ids.includes(id) && archived[id] === undefined) archived[id] = clock()
        }
        // 取消归档的把时间记号去掉（下次再归档重新起算）。
        for (const id of Object.keys(archived)) {
          if (!ids.includes(id)) delete archived[id]
        }
        await store.writeArchived(archived)
      } catch (error) {
        logger.warn?.(`dsh-workbench/checkpoints: 记归档时间没成：${String(error?.stack ?? error)}`)
      }
    })
  }

  /** 等最后一笔清理、归档及会话写入完成后，才释放内存状态。 */
  const dispose = async () => {
    closing = true
    await archiveWork
    await Promise.all(queues.values())
    headers.clear()
    filesTurns.clear()
    pendingTurns.clear()
    warnedRoots.clear()
    queues.clear()
    sizes.clear()
    working.clear()
  }

  return {
    list, preview, restore, undo, configFetch,
    onSessionEvent, onPreExecute, onFsIntent, onSessionDisposed, onDomainChanged,
    cleanup, dispose,
  }
}

/**
 * 注册检查点的五个路由（`/api/dsh-workbench.checkpoints.*`，`/api` 通道进来前已过鉴权）。
 * @param {object} scope 带有 connection 服务的插件作用域。
 * @param {object} service 检查点服务。
 * @returns {void}
 */
export function registerCheckpointsRoutes(scope, service) {
  scope.effect(() => scope.connection.fetch.register({
    path: '/api/dsh-workbench.checkpoints.list',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => {
      let sessionId
      try {
        sessionId = new URL(request.url).searchParams.get('sessionId')
      } catch {
        // 地址解析不了：按缺参数处理，list 答 bad-request。
        sessionId = null
      }
      return service.list(sessionId)
    },
  }), 'dsh-workbench: checkpoints list route')
  for (const [suffix, handler] of [['preview', service.preview], ['restore', service.restore], ['undo', service.undo]]) {
    scope.effect(() => scope.connection.fetch.register({
      path: `/api/dsh-workbench.checkpoints.${suffix}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, reason: 'bad-request', message: '请求体不是 JSON。' }, 400)
        }
        if (typeof body !== 'object' || body === null) {
          return json({ ok: false, reason: 'bad-request', message: '请求体不是 JSON 对象。' }, 400)
        }
        try {
          return await handler(body.sessionId, body.turn)
        } catch (error) {
          const detail = errorDetail(error)
          return json({ ok: false, reason: 'failed', detail, message: `处理请求时出错：${detail}` }, 500)
        }
      },
    }), `dsh-workbench: checkpoints ${suffix} route`)
  }
  scope.effect(() => scope.connection.fetch.register({
    path: '/api/dsh-workbench.checkpoints.config',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: service.configFetch,
  }), 'dsh-workbench: checkpoints config route')
}

/**
 * 装上检查点的宿主端：钩子（session/event、tools/pre-execute、三个 fs/*-intent、
 * session/disposed、domain/changed）、路由和清理。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function applyCheckpoints(ctx) {
  ctx.inject(['subprocess', 'fs', 'agents', 'sessionPersistence'], scope => {
    const service = createCheckpointsService({
      subprocess: scope.subprocess,
      fs: scope.fs,
      agents: scope.agents,
      sessionPersistence: scope.sessionPersistence,
      dataRoot: join(workbenchDataDir(process.env), 'checkpoints'),
      logger: scope.logger,
    })
    scope.on('session/event', service.onSessionEvent)
    scope.on('tools/pre-execute', service.onPreExecute)
    // 放到最外层（prepend）：先 await next() 拿放行的 intent，再在改文件之前捕获。
    for (const event of FS_INTENTS) scope.on(event, service.onFsIntent, { prepend: true })
    scope.on('session/disposed', session => service.onSessionDisposed(session?.id))
    scope.on('domain/changed', service.onDomainChanged)
    scope.effect(() => () => service.dispose(), '@miint-sunny/dsh-workbench/checkpoints: release memory state')
    // 行启动时清一次，之后每天一次；清理尽力而为，失败不影响别的。
    const prune = () => {
      service.cleanup().catch(error => {
        scope.logger?.warn(`dsh-workbench/checkpoints: 清理没做完：${String(error?.stack ?? error)}`)
      })
    }
    prune()
    const timer = setInterval(prune, DAY_MS)
    scope.effect(() => () => clearInterval(timer), '@miint-sunny/dsh-workbench/checkpoints: cleanup timer')
    scope.inject(['connection'], connectionScope => {
      registerCheckpointsRoutes(connectionScope, service)
    })
  })
}

/**
 * 注册 checkpoints 行（cordis.patch.yml 里 id 为 dsh-workbench-checkpoints 的行）。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => registerFeature('checkpoints'), '@miint-sunny/dsh-workbench/checkpoints: feature registration')
  applyCheckpoints(ctx)
}

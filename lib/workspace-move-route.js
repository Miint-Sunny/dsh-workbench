/**
 * 会话迁移（feat#187）的路由：工作区设置里「更换文件夹…」要的预览、开始、撤销、恢复，以及 DSH 重新打开后要提示的结果。
 * 挂在 workspace-folders 行上（对话框是同一个）。POST 会让小进程在 DSH 退出后移动会话，所以和那一行一样只收 JSON 正文，
 * 并带上只由 GET 回答的令牌（令牌挡什么、挡不住什么见 lib/workspace-trust.js 文件头）。
 * - GET  /api/dsh-workbench.workspace-move：令牌、DSH 的运行方式、没提示过的结果、停在中途的迁移、近期做完的迁移
 * - GET  /api/dsh-workbench.workspace-move?requestId=…：一次请求现在的样子；DSH 没退出时（等退出、等超时）界面靠它更新。
 *   回答都带 hostId（每次宿主启动换一个），界面据此判断 DSH 是否重开过
 * - POST { action: 'plan', workspaceId, path }：预览。完整的预览留在宿主内存里，界面只拿 planId 和要显示的部分，
 *   开始时也只认 planId，要移动哪些会话不由网页决定
 * - POST { action: 'start', planId }：写下请求、起小进程（lib/workspace-move-launch.js），小进程请 DSH 退出：
 *   桌面 App 用 AppleScript（走 App 自己的退出确认），web 等命令发 SIGINT，终端里的由用户自己退出
 * - POST { action: 'undo-check', moveId }：撤销前只读检查
 * - POST { action: 'undo' | 'recover', moveId }：撤销做完的迁移、恢复停在中途的迁移，同样由小进程在 DSH 退出后执行
 * - POST { action: 'ack', requestId }：这条结果已经提示过，以后不再列出
 * - POST { action: 'reveal', requestId }：在访达里显示这次的迁移记录（没有迁移记录时显示请求目录；只在 macOS）
 */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { workbenchDataDir } from './data-dir.js'
import { displayFolder } from './workspace-folders-model.js'
import { dataPath, pendingWorkspaceMoves, planWorkspaceMove, validWorkspaceMoveId as validId, workspaceMoveUndoCheck, WorkspaceMoveError } from './workspace-move.js'
import { currentProcessFacts, dshProcessFacts, helperProcessAlive, requestsDir, startWorkspaceMoveHelper } from './workspace-move-launch.js'

const execFileAsync = promisify(execFile)
const ROUTE = '/api/dsh-workbench.workspace-move'
/** 顶层页面带令牌的请求头。 */
export const MOVE_TOKEN_HEADER = 'x-dsh-workbench-move'
const TERMINAL = new Set(['finished', 'gave-up', 'failed'])
/** 宿主内存里最多留几份预览；更早的作废，界面重新预览。 */
const KEPT_PLANS = 8
/** 界面会显示的提醒；其余（比如目录不在旧文件夹、App 本来就不显示的会话）用户没法据此做决定，不显示。 */
const SHOWN_WARNINGS = new Set(['subfolder-sessions', 'memory-conflict', 'memory-unreadable'])
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const isMissing = error => error?.code === 'ENOENT'

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** 迁移没改的工作台文件，按功能归类（mcp-visibility.json 是 MCP 项目规则，approval-rules.json 是放行规则，pages/ 是网页发布）。 */
export function untouchedKind(file) {
  if (file === 'mcp-visibility.json') return 'mcp'
  if (file === 'approval-rules.json') return 'rules'
  if (file.startsWith('pages/') || file.startsWith('pages\\')) return 'pages'
  return 'other'
}

/**
 * 预览里给界面看的部分（完整的预览见 docs/research/2026-11-19-会话迁移设计.md 第 6 节）。
 * App 在运行（app-running）不算阻碍：它就是「退出并迁移」这一步，小进程在 DSH 退出后会重新预览。
 * @param {object} plan planWorkspaceMove 的结果。
 * @param {string[]} homes 主目录的写法（显示 ~ 用）。
 * @returns {object} source、target、result、counts、carries（跟着迁移的工作台数据）、untouched（仍指向原文件夹的工作台数据种类）、blockers、warnings。
 */
export function planView(plan, homes) {
  const display = path => displayFolder(path, homes)
  const moved = new Set(plan.sessions.map(item => item.id))
  const carries = [
    ...plan.workbench.checkpoints.length > 0 ? ['checkpoints'] : [],
    ...plan.workbench.memory.action === 'move' ? ['memory'] : [],
    ...plan.workbench.trust.action === 'none' ? [] : ['trust'],
    ...plan.workbench.folders.action === 'merge' ? ['folders'] : [],
  ]
  return {
    source: { workspaceId: plan.source.workspaceId, title: plan.source.title, display: display(plan.source.path) },
    target: {
      kind: plan.target.kind, title: plan.target.title, display: display(plan.target.path),
      sessions: plan.target.kind === 'workspace' ? plan.result.sessionIds.filter(id => !moved.has(id)).length : 0,
    },
    result: { title: plan.result.title },
    counts: plan.counts,
    carries,
    untouched: [...new Set(plan.workbench.untouched.map(item => untouchedKind(item.file)))],
    blockers: plan.blockers.filter(item => item.code !== 'app-running').map(item => (item.sessionId === undefined ? { code: item.code } : { code: item.code, sessionId: item.sessionId })),
    warnings: plan.warnings.filter(item => SHOWN_WARNINGS.has(item.code)).map(item => (item.count === undefined ? { code: item.code } : { code: item.code, count: item.count })),
  }
}

/**
 * 小进程的参数：等谁、怎么请 DSH 退出、搬完怎么重开、用哪个 App 可执行文件核对。
 * 桌面 App 由小进程用 AppleScript 请它退出（和菜单里的退出一样，有进行中的任务时 App 会先确认）；
 * 包标识读不到时由用户自己退出。核对用 App 的可执行文件：桌面是宿主的父进程，App 自带的 dsh 命令起的 DSH 是它自己。
 * @param {object} facts currentProcessFacts() 的结果。
 * @param {(app: string) => Promise<string | undefined>} bundleIdOf 读 App 包的标识。
 * @returns {Promise<{ kind: string, wait: object, quit: object, relaunch: object, appBinary: string | null }>} 参数。
 */
export async function helperOptions(facts, bundleIdOf) {
  const plan = dshProcessFacts(facts)
  const inApp = path => typeof path === 'string' && path.includes('.app/Contents/MacOS/')
  if (plan.kind === 'desktop') {
    const bundleId = plan.relaunch.kind === 'open-app' ? await bundleIdOf(plan.relaunch.app) : undefined
    return {
      ...plan,
      quit: bundleId === undefined ? { kind: 'none' } : { kind: 'applescript', bundleId },
      appBinary: inApp(facts.parentExecutable) ? facts.parentExecutable : null,
    }
  }
  return { ...plan, appBinary: inApp(facts.execPath) ? facts.execPath : null }
}

/** 读 App 包的 CFBundleIdentifier；读不到时 undefined（由用户自己退出）。 */
async function bundleIdOf(app) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents', 'Info.plist')])
    return stdout.trim() || undefined
  } catch {
    return undefined // 不是 macOS，或者 Info.plist 读不了：不用 AppleScript
  }
}

/**
 * 挂迁移的路由。
 * @param {object} scope 带 connection、workspaceRegistry 服务的宿主作用域。
 * @param {{ dshHome: string, homes: string[], undoDays: number, facts?: () => object, bundleIdOf?: (app: string) => Promise<string | undefined>, start?: typeof startWorkspaceMoveHelper, reveal?: (path: string) => Promise<void> }} options
 *   DSH 的数据目录、主目录的写法、做完多少天内还能撤销；其余是测试替身：进程事实、读包标识、起小进程、在访达里显示。
 * @returns {() => void} 撤销函数。
 */
export function applyWorkspaceMoveRoute(scope, { dshHome, homes, undoDays, facts = currentProcessFacts, bundleIdOf: readBundleId = bundleIdOf, start = startWorkspaceMoveHelper, reveal = path => execFileAsync('/usr/bin/open', ['-R', path]).then(() => {}) }) {
  const token = randomBytes(32).toString('base64url')
  /** 这次宿主启动的编号（不是秘密）：界面据此判断 DSH 是否重开过。 */
  const hostId = randomUUID()
  const plans = new Map()
  let launching = false
  const launched = new Map()
  const display = path => displayFolder(path, homes)
  const withinUndoPeriod = time => Date.now() - time <= undoDays * 86_400_000
  const movesDir = join(workbenchDataDir({ DSH_HOME: dshHome }), 'workspace-moves')
  const fromApp = request => (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
    && request.headers.get(MOVE_TOKEN_HEADER) === token

  // 目录别名和普通杂项文件不作为宿主写下的记录。
  const physical = async (path, directory = false) => {
    try {
      return await dataPath(dshHome, path, directory)
    } catch (error) {
      if (error.code === 'data-format') return false
      throw error
    }
  }
  const readRecord = async path => await physical(path) ? readJson(path) : undefined
  const directories = async root => {
    if (!(await physical(root, true))) return []
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(item => item.isDirectory() && validId(item.name)).map(item => item.name).sort()
  }

  /** 一份迁移记录里给界面看的：从哪到哪、几个会话。读不到时 undefined。 */
  const moveSummary = async (moveId) => {
    const plan = await readRecord(join(movesDir, moveId, 'plan.json'))
    if (plan === undefined) return undefined
    return { source: { title: plan.source.title, display: display(plan.source.path) }, target: { title: plan.result.title, display: display(plan.target.path) }, sessions: plan.sessions.length, workspaceId: plan.result.workspaceId }
  }

  /** 一次请求现在的样子。小进程刚起、还没写 status.json 时按起它时的 pid 判断活着没有。 */
  const requestView = async (requestId) => {
    const dir = join(requestsDir(dshHome), requestId)
    const request = await readRecord(join(dir, 'request.json'))
    if (request === undefined) return undefined
    const status = (await readRecord(join(dir, 'status.json'))) ?? { phase: 'not-started' }
    const terminal = TERMINAL.has(status.phase)
    const running = !terminal && await helperProcessAlive(status.pid ?? request.helperPid ?? launched.get(requestId) ?? request.launcherPid, status.updatedAt ?? request.helperStartedAt ?? request.createdAt)
    const recordedId = status.moveId ?? request.moveId
    const moveId = validId(recordedId) ? recordedId : undefined
    const summary = request.plan !== undefined
      ? { source: { title: request.plan.source.title, display: display(request.plan.source.path) }, target: { title: request.plan.result.title, display: display(request.plan.target.path) }, sessions: request.plan.sessions.length }
      : moveId === undefined ? {} : (await moveSummary(moveId)) ?? {}
    return {
      requestId, action: request.action, phase: status.phase, running,
      // 小进程没走完就没了（被结束、机器重启）：结果按「中断」提示，停在中途的迁移另由 interrupted 列出
      outcome: status.outcome ?? (terminal || running ? undefined : 'interrupted'),
      ...status.quitError === undefined ? {} : { quitError: true },
      ...moveId === undefined ? {} : { moveId },
      ...status.checked === undefined ? {} : { checked: status.checked },
      ...status.checkError === undefined ? {} : { checkError: status.checkError },
      ...status.relaunched === undefined ? {} : { relaunched: status.relaunched },
      ...(status.conflict && { conflict: status.conflict }),
      ...status.message === undefined ? {} : { message: status.message },
      ...status.blockers === undefined ? {} : { blockers: status.blockers.map(item => item.code) },
      acknowledged: await physical(join(dir, 'ack.json')),
      ...summary,
    }
  }

  /** 已经有结果或仍在执行的请求，供重开的宿主读取。 */
  const requestViews = async () => {
    const views = []
    for (const name of await directories(requestsDir(dshHome))) {
      const view = await requestView(name)
      if (view !== undefined && (view.running || !view.acknowledged)) views.push(view)
    }
    return views
  }

  /** 做完、还没撤销的迁移，每个工作区只留最近一次；undoable 只看时间，又改过的情况要等 undo-check。 */
  const records = async () => {
    const latest = new Map()
    for (const moveId of await directories(movesDir)) {
      if (moveId === 'requests') continue
      const journal = await readRecord(join(movesDir, moveId, 'journal.json'))
      if (journal?.status !== 'done') continue
      const summary = await moveSummary(moveId)
      if (summary === undefined) continue
      const done = (await stat(join(movesDir, moveId, 'journal.json'))).mtime
      const at = done.toISOString()
      if (!latest.has(summary.workspaceId) || latest.get(summary.workspaceId).at <= at) {
        latest.set(summary.workspaceId, { moveId, workspaceId: summary.workspaceId, at, from: summary.source.display, sessions: summary.sessions, undoable: withinUndoPeriod(done.getTime()) })
      }
    }
    return [...latest.values()]
  }

  /** 起小进程；同一时间只允许一个还在跑的请求。 */
  const launch = async (options) => {
    if (launching) return json({ ok: false, reason: 'busy' })
    launching = true
    try {
      const running = (await requestViews()).find(view => view.running)
      if (running) return json({ ok: false, reason: 'busy', requestId: running.requestId })
      const { kind, wait, quit, relaunch, appBinary } = await helperOptions(facts(), readBundleId)
      const started = await start({ home: dshHome, ...options, wait, quit, relaunch, appBinary })
      launched.clear()
      launched.set(started.requestId, started.pid)
      return json({ ok: true, requestId: started.requestId, kind, hostId })
    } finally {
      launching = false
    }
  }

  const undoCheck = async moveId => {
    try {
      if (!(await physical(join(movesDir, moveId, 'journal.json')))) return { undoable: false, reason: 'no-move' }
      const journal = await stat(join(movesDir, moveId, 'journal.json'))
      if (!withinUndoPeriod(journal.mtimeMs)) return { undoable: false, reason: 'not-undoable' }
      return await workspaceMoveUndoCheck({ home: dshHome, moveId })
    } catch (error) {
      if (isMissing(error)) return { undoable: false, reason: 'no-move' }
      throw error
    }
  }

  const handlers = {
    plan: async (body) => {
      if (typeof body.workspaceId !== 'string' || typeof body.path !== 'string' || body.path === '') return json({ ok: false, reason: 'bad-request' }, 400)
      if (!scope.workspaceRegistry.list().some(item => item.id === body.workspaceId)) return json({ ok: false, reason: 'no-workspace' }, 404)
      let plan
      try {
        plan = await planWorkspaceMove({ home: dshHome, workspaceId: body.workspaceId, targetPath: body.path })
      } catch (error) {
        if (error instanceof WorkspaceMoveError) return json({ ok: false, reason: error.code, display: display(body.path) })
        throw error
      }
      const planId = randomUUID()
      plans.set(planId, plan)
      for (const old of [...plans.keys()].slice(0, Math.max(0, plans.size - KEPT_PLANS))) plans.delete(old)
      return json({ ok: true, planId, kind: dshProcessFacts(facts()).kind, preview: planView(plan, homes) })
    },
    start: async (body) => {
      const plan = typeof body.planId === 'string' ? plans.get(body.planId) : undefined
      if (plan === undefined) return json({ ok: false, reason: 'stale-plan' })
      if (plan.blockers.some(item => item.code !== 'app-running')) return json({ ok: false, reason: 'blocked' })
      return launch({ action: 'move', plan })
    },
    'undo-check': async (body) => {
      if (!validId(body.moveId)) return json({ ok: false, reason: 'bad-request' }, 400)
      const check = await undoCheck(body.moveId)
      return json({
        ok: true, undoable: check.undoable, ...check.undoable ? {} : { reason: check.reason },
        ...(check.conflict && { conflict: check.conflict }),
        ...check.appended === undefined ? {} : { appended: check.appended },
        ...check.sessions === undefined ? {} : { sessions: check.sessions, others: check.changed.length > 0 && check.sessions.length === 0 },
      })
    },
    undo: async (body) => {
      if (!validId(body.moveId)) return json({ ok: false, reason: 'bad-request' }, 400)
      const check = await undoCheck(body.moveId)
      if (!check.undoable) return json({ ok: false, reason: check.reason })
      return launch({ action: 'undo', moveId: body.moveId })
    },
    recover: async (body) => {
      if (!validId(body.moveId)) return json({ ok: false, reason: 'bad-request' }, 400)
      if (!(await pendingWorkspaceMoves(dshHome)).some(item => item.moveId === body.moveId)) return json({ ok: false, reason: 'not-recoverable' })
      return launch({ action: 'recover', moveId: body.moveId })
    },
    ack: async (body) => {
      if (!validId(body.requestId)) return json({ ok: false, reason: 'bad-request' }, 400)
      const dir = join(requestsDir(dshHome), body.requestId)
      const view = await requestView(body.requestId)
      if (view?.running) return json({ ok: false, reason: 'busy' })
      if (view === undefined) return json({ ok: false, reason: 'no-request' }, 404)
      try {
        await writeFile(join(dir, 'ack.json'), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      return json({ ok: true })
    },
    reveal: async (body) => {
      if (!validId(body.requestId)) return json({ ok: false, reason: 'bad-request' }, 400)
      const view = await requestView(body.requestId)
      if (view === undefined) return json({ ok: false, reason: 'no-request' }, 404)
      if (process.platform !== 'darwin') return json({ ok: false, reason: 'unsupported' })
      const record = view.moveId !== undefined && await physical(join(movesDir, view.moveId, 'journal.json'))
      await reveal(record ? join(movesDir, view.moveId) : join(requestsDir(dshHome), body.requestId))
      return json({ ok: true })
    },
  }

  const off = scope.connection.fetch.register({
    path: ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        const requestId = new URL(request.url).searchParams.get('requestId')
        if (requestId !== null) {
          if (!validId(requestId)) return json({ ok: false, reason: 'bad-request' }, 400)
          const view = await requestView(requestId)
          return view === undefined ? json({ ok: false, reason: 'no-request' }, 404) : json({ ok: true, hostId, request: view })
        }
        const interrupted = (await pendingWorkspaceMoves(dshHome)).map(item => ({
          moveId: item.moveId, workspaceId: item.source.workspaceId, source: { title: item.source.title, display: display(item.source.path) }, target: { display: display(item.target.path) },
        }))
        const views = await requestViews()
        return json({ ok: true, token, hostId, kind: dshProcessFacts(facts()).kind, reveal: process.platform === 'darwin',
          results: views.filter(view => !view.running), runningRequests: views.filter(view => view.running).map(view => view.requestId),
          interrupted, records: await records() })
      }
      if (!fromApp(request)) return json({ ok: false, reason: 'forbidden' }, 403)
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, reason: 'bad-request' }, 400)
      }
      const handler = typeof body?.action === 'string' && Object.hasOwn(handlers, body.action) ? handlers[body.action] : undefined
      if (handler === undefined) return json({ ok: false, reason: 'bad-request' }, 400)
      return handler(body)
    },
  })
  return () => {
    plans.clear()
    void off?.()
  }
}

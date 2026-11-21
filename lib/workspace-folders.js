/**
 * dsh-workbench/workspace-folders 行的宿主端（feat#159）：工作区的子文件夹和外部文件夹，以及它们落到会话上的可写目录。
 *
 * 落地方式是官方的 `ctx.sandboxPolicy.registerWritableRoot(session, dir)`：它只对活着的会话、只在「工作区内修改」下起作用，
 * 不进会话日志、重启和分叉后不保留，所以设置存在工作台的数据目录（lib/workspace-folders-store.js），按会话头的 cwd 找到工作区，
 * 在这几处把登记对一遍：
 * - 会话加载时（agent/created，含恢复、分叉、子智能体）；挂载这一行时，对已经加载的会话（agents.list()）各一次；
 * - 组装系统提示词时：一个不出文字的 context 排在官方沙箱说明（SANDBOX_POLICY）前一位。rc.3 的 context 按 order 依次同步求值，
 *   组装时和发请求前的刷新（refreshContext）都是，所以沙箱说明写的就是刚对好的目录。rc.3 发请求前那次刷新本来就在 agent/pre-step
 *   之后，没有这个 context 时模型看到的、日志记下的也已是新的（2026-11-17 隔离宿主新旧对照）；它让组装那一刻和 pre-step 拿到的也一致；
 * - 每次请求前（agent/pre-step）；设置改了以后，对开着的会话马上重登。
 * 模型每次请求前拿到的沙箱说明里有这些目录，那段说明官方会记进会话日志。哪些目录、怎么分类见 lib/workspace-folders-model.js；
 * 外部文件夹不收根目录、主目录和它的上级、DSH 的数据目录（含它里面的和它的上级），设置文件被手改过也不登记。
 *
 * 子智能体：会话头的 cwd 是父会话的（rc.3 dsh-subagent 的 childSessionMeta），模型传给 subagent 工具的 cwd 只经
 * workingDirectory.set 改工作目录，所以按会话头算出的可写目录和父会话一样：借不到别的工作区的目录，也不会漏登父会话的。
 *
 * 路由挂在 DSH 共用的 /api 通道上（进来前已过 Host/Origin 栅栏和登录检查）。POST 会扩大模型能写的范围，所以照工作区信任的做法
 * 再加一道：只收 JSON 正文，并带上只由 GET 回答的令牌（见 lib/workspace-trust.js 文件头的说明）。令牌挡的是别的网页和预览框；
 * 能在本机执行命令的程序（包括「工作区内修改」下模型运行的 bash）可以直接调用 DSH 的本机接口，令牌挡不住，DSH 官方的接口也是这样。
 * - GET  /api/dsh-workbench.workspace-folders?workspaceId=…：主文件夹、子文件夹、外部文件夹和令牌
 * - POST /api/dsh-workbench.workspace-folders：`{ action: 'classify' | 'add-external', workspaceId, path }`、
 *   `{ action: 'remove-external', workspaceId, path }`、`{ action: 'set-writable', workspaceId, subfolderId, writable }`
 * 子文件夹的添加和移除走官方的 `workspaces.create`、`workspaces.delete`（网页端调），这里只存「只读 / 可写」。
 */
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { workbenchDataDir } from './data-dir.js'
import { registerFeature } from './features.js'
import { createFoldersStore } from './workspace-folders-store.js'
import { displayFolder, externalRefusal, folderList, resolvePickedFolder, usableFolder, usableRoots, writableRootsFor } from './workspace-folders-model.js'
import { applyWorkspaceMoveRoute } from './workspace-move-route.js'

export const name = '@miint-sunny/dsh-workbench/workspace-folders'

const ROUTE = '/api/dsh-workbench.workspace-folders'
/** 顶层页面带令牌的请求头。 */
export const FOLDERS_TOKEN_HEADER = 'x-dsh-workbench-folders'
/** 组装系统提示词时先对一遍登记的 context，排在官方沙箱说明（SANDBOX_POLICY）前面一位。 */
const SYNC_CONTEXT = 'workbench:workspace-folders'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** realpath，失败时原样返回。 */
function realOr(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * 让活着的会话登记的可写目录和设置保持一致。每个会话记着自己登记了哪些目录和对应的撤销函数。
 * @param {{ register: (session: object, dir: string) => () => void, rootsFor: (agent: object) => string[], warn?: (message: string) => void }} deps
 *   官方的登记函数、一个会话现在应该登记哪些目录、记警告。
 * @returns {{ sync: (agent: object) => void, drop: (agent: object) => void, syncAll: () => void, dispose: () => void, registered: (agent: object) => string[] }} 同步器。
 */
export function createRootSync({ register, rootsFor, warn = () => {} }) {
  const byAgent = new Map()
  const sync = (agent) => {
    let want
    try {
      want = rootsFor(agent)
    } catch (error) {
      warn(`workspace folders: cannot compute writable folders: ${error?.message ?? error}`)
      return
    }
    const have = byAgent.get(agent) ?? new Map()
    byAgent.set(agent, have)
    for (const [dir, dispose] of [...have]) {
      if (want.includes(dir)) continue
      have.delete(dir)
      dispose()
    }
    for (const dir of want) {
      if (have.has(dir)) continue
      try {
        have.set(dir, register(agent.session, dir))
      } catch (error) {
        warn(`workspace folders: cannot register ${dir}: ${error?.message ?? error}`)
      }
    }
  }
  const drop = (agent) => {
    const have = byAgent.get(agent)
    byAgent.delete(agent)
    for (const dispose of have?.values() ?? []) dispose()
  }
  return {
    sync,
    drop,
    syncAll() {
      for (const agent of [...byAgent.keys()]) sync(agent)
    },
    dispose() {
      for (const agent of [...byAgent.keys()]) drop(agent)
    },
    registered: agent => [...byAgent.get(agent)?.keys() ?? []],
  }
}

/**
 * 挂这一行的登记同步和路由。
 * @param {object} scope 带 connection、sandboxPolicy、workspaceRegistry、systemPrompt、agents 服务的宿主作用域。
 * @param {{ dataDir: string, home: string, dshHome: string }} options 数据目录、主目录、DSH 的数据目录（$DSH_HOME）。
 * @returns {() => void} 撤销函数：撤掉路由、context 和这一行登记的全部可写目录。
 */
export function applyWorkspaceFolders(scope, { dataDir, home, dshHome }) {
  const store = createFoldersStore(dataDir)
  const homes = [...new Set([home, realOr(home)])]
  const dshHomes = [...new Set([dshHome, realOr(dshHome)])]
  const refuse = path => externalRefusal(path, { homes, dshHomes })
  const token = randomBytes(32).toString('base64url')
  const warn = message => scope.logger?.warn?.(message)
  const registry = () => scope.workspaceRegistry.list().map(workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title }))
  const rootsFor = agent => usableRoots(writableRootsFor({ cwd: realOr(agent.session?.header?.cwd ?? ''), workspaces: registry(), settings: store.read(), refuse }))
  const sync = createRootSync({
    register: (session, dir) => scope.sandboxPolicy.registerWritableRoot(session, dir),
    rootsFor,
    warn,
  })
  /** 在组装系统提示词和挂载时对一遍：出错只记警告，不能让这一步请求或这一行的挂载失败。 */
  const syncQuietly = (agent) => {
    try {
      sync.sync(agent)
    } catch (error) {
      warn(`workspace folders: cannot sync writable folders: ${error?.message ?? error}`)
    }
  }
  const offs = [
    scope.on('agent/created', ({ agent }) => { sync.sync(agent) }),
    scope.on('agent/pre-step', (payload, next) => {
      sync.sync(payload.agent)
      return next()
    }, { prepend: true }),
    scope.on('agent/disposed', ({ agent }) => { sync.drop(agent) }),
    // 为什么排在这里见文件头。返回空串：rc.3 渲染时滤掉空文字（renderContextSections），说明里不多一段。
    scope.systemPrompt.context({
      name: SYNC_CONTEXT,
      order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') - 1,
      text: (context) => {
        const agent = context?.agent
        // Read-only compositions also assemble this context, but never own writable roots.
        if (agent && scope.agents.get(agent.id) === agent) syncQuietly(agent)
        return ''
      },
    }),
  ]
  for (const agent of scope.agents.list()) syncQuietly(agent)

  /** 对话框要的列表，路径带显示写法；失效和登记用同一个判据（usableFolder），被拒绝的外部文件夹带原因。 */
  const listBody = (workspace, workspaces) => {
    const list = folderList({ workspace, workspaces, settings: store.read(), exists: usableFolder, refuse })
    const titleOf = id => workspaces.find(candidate => candidate.id === id)?.title ?? ''
    return {
      ok: true,
      workspace: { id: workspace.id, title: workspace.title, path: workspace.path, display: displayFolder(workspace.path, homes), missing: list.main.missing },
      subfolders: list.subfolders.map(row => ({ id: row.id, title: titleOf(row.id), path: row.path, display: displayFolder(row.path, homes), writable: row.writable, missing: row.missing })),
      externals: list.externals.map(row => ({ path: row.path, display: displayFolder(row.path, homes), missing: row.missing, ...row.refused === undefined ? {} : { refused: row.refused } })),
    }
  }
  /** 改完设置：清掉已删工作区的条目，开着的会话马上重登，回答新的列表。 */
  const changed = (workspace, workspaces) => {
    store.prune(workspaces.map(candidate => candidate.id))
    sync.syncAll()
    return json(listBody(workspace, workspaces))
  }
  /** POST 只认顶层页面：JSON 正文，带上 GET 才拿得到的令牌。 */
  const fromApp = request => (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
    && request.headers.get(FOLDERS_TOKEN_HEADER) === token

  const offRoute = scope.connection.fetch.register({
    path: ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const workspaces = registry()
      const find = id => (typeof id === 'string' && id !== '' ? workspaces.find(candidate => candidate.id === id) : undefined)
      if (request.method === 'GET') {
        const id = new URL(request.url).searchParams.get('workspaceId')
        if (id === null || id === '') return json({ ok: false, reason: 'bad-request' }, 400)
        const workspace = find(id)
        if (workspace === undefined) return json({ ok: false, reason: 'no-workspace' }, 404)
        return json({ ...listBody(workspace, workspaces), token })
      }
      if (!fromApp(request)) return json({ ok: false, reason: 'forbidden' }, 403)
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, reason: 'bad-request' }, 400)
      }
      const workspace = find(body?.workspaceId)
      if (workspace === undefined) return json({ ok: false, reason: 'no-workspace' }, 404)
      const action = body.action
      if (action === 'classify' || action === 'add-external') {
        if (typeof body.path !== 'string') return json({ ok: false, reason: 'bad-request' }, 400)
        const list = folderList({ workspace, workspaces, settings: store.read(), exists: usableFolder })
        const listed = [...list.subfolders.map(row => row.path), ...list.externals.map(row => row.path)]
        const result = resolvePickedFolder({ main: realOr(workspace.path), picked: body.path, listed, refuse })
        const located = result.path === undefined ? {} : { path: result.path, display: displayFolder(result.path, homes) }
        if (result.error !== undefined) return json({ ok: false, reason: result.error, ...located })
        if (action === 'classify') return json({ ok: true, kind: result.kind, ...located })
        if (result.kind !== 'external') return json({ ok: false, reason: 'not-external', ...located })
        store.addExternal(workspace.id, result.path)
        return changed(workspace, workspaces)
      }
      if (action === 'remove-external') {
        if (typeof body.path !== 'string') return json({ ok: false, reason: 'bad-request' }, 400)
        store.removeExternal(workspace.id, body.path)
        return changed(workspace, workspaces)
      }
      if (action === 'set-writable') {
        if (typeof body.subfolderId !== 'string' || typeof body.writable !== 'boolean') return json({ ok: false, reason: 'bad-request' }, 400)
        const list = folderList({ workspace, workspaces, settings: store.read(), exists: usableFolder })
        if (!list.subfolders.some(row => row.id === body.subfolderId)) return json({ ok: false, reason: 'not-subfolder' }, 400)
        store.setWritable(workspace.id, body.subfolderId, body.writable)
        return changed(workspace, workspaces)
      }
      return json({ ok: false, reason: 'bad-request' }, 400)
    },
  })
  return () => {
    void offRoute?.()
    for (const off of offs) void off?.()
    sync.dispose()
  }
}

/**
 * 注册 workspace-folders 行：文件夹和权限，以及更换主文件夹时的会话迁移（lib/workspace-move-route.js）。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dataDir?: string, dshHome?: string, moveUndoDays?: number }} [config] 行配置；moveUndoDays 是迁移做完多少天内还提供「撤销」（默认 30）；
 *   dataDir 覆盖数据目录、dshHome 覆盖 DSH 的数据目录（测试用）。
 * @throws {TypeError} moveUndoDays 不是正整数时，挂载时就报错。
 */
export function apply(ctx, config = {}) {
  const undoDays = config.moveUndoDays ?? 30
  if (!Number.isSafeInteger(undoDays) || undoDays < 1) throw new TypeError(`workspace-folders: moveUndoDays must be a positive integer, got ${JSON.stringify(config.moveUndoDays)}`)
  ctx.effect(() => registerFeature('workspace-folders'), '@miint-sunny/dsh-workbench/workspace-folders: feature registration')
  ctx.inject(['connection', 'sandboxPolicy', 'workspaceRegistry', 'systemPrompt', 'agents'], (scope) => {
    const home = homedir()
    // 工作台的数据目录是 $DSH_HOME/dsh-workbench（lib/data-dir.js），它的上一级就是 DSH 的数据目录。
    const dshHome = config.dshHome ?? dirname(workbenchDataDir())
    scope.effect(() => applyWorkspaceFolders(scope, { dataDir: config.dataDir ?? workbenchDataDir(), home, dshHome }), '@miint-sunny/dsh-workbench/workspace-folders: writable folders and routes')
    scope.effect(() => applyWorkspaceMoveRoute(scope, { dshHome, homes: [...new Set([home, realOr(home)])], undoDays }), '@miint-sunny/dsh-workbench/workspace-folders: workspace move routes')
  })
}

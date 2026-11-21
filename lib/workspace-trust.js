/**
 * dsh-workbench/workspace-trust 行的宿主端（feat#121）：dsh-better-sidebar 的桌面端 HTML 预览要内联本地资源时，
 * 只为已信任的工作区、在边界以内读取。信任记录在 lib/workspace-trust-store.js，边界检查和读取在
 * lib/workspace-trust-read.js，路由路径解码在 lib/workspace-trust-route.js。
 *
 * 路由挂在 DSH 共用的 /api 通道上，进来之前已过 Host/Origin 栅栏和登录检查，只接受本人。桌面壳转发 dsh-app:
 * 请求时会删掉 origin、sec-fetch-site 和 cookie 再换上宿主端的 cookie，只在带了 Origin 且不是 dsh-app://app 时
 * 回 403（app.asar lib/main.js forwardWebRequest），所以两条 POST 不单靠这一处：还要 JSON 正文和一个令牌。
 * 令牌每个宿主进程随机生成，只由 GET 列表回答；沙箱里的预览页读不到这个回答（cors 请求带 Origin: null 被拒，
 * no-cors 的 <script> 拿到的是 JSON，不执行），也发不出带自定义头的跨源请求（要预检，预检带 Origin: null）。
 * - GET  /api/dsh-workbench.workspace-trust：已信任的工作区列表
 * - POST /api/dsh-workbench.workspace-trust：`{ action: 'status', sessionId, documentPath }`、`{ action: 'trust', sessionId }`、`{ action: 'revoke', path }`
 * - POST /api/dsh-workbench.workspace-trust.resource：`{ document, resource }`（/sidebar/html/ 之后的那段），
 *   通过时回字节，不通过时 403 `{ ok: false, reason, display }`
 * 设计见 docs/plans/2026-11-13-工作区信任.md。
 */
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import nodePath, { isAbsolute, relative, resolve, sep } from 'node:path'
import { workbenchDataDir } from './data-dir.js'
import { registerFeature } from './features.js'
import { createTrustStore } from './workspace-trust-store.js'
import { decodePreviewRoute } from './workspace-trust-route.js'
import { documentInWorkspace, readTrustedResource } from './workspace-trust-read.js'

export const name = '@miint-sunny/dsh-workbench/workspace-trust'

const ROUTE = '/api/dsh-workbench.workspace-trust'
/** 顶层页面带令牌的请求头。 */
export const TRUST_TOKEN_HEADER = 'x-dsh-workbench-trust'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** child 是否在 parent 之内或就是 parent。 */
function within(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 主目录下这三个目录本身不能信任：下载或随手放进来的任何 HTML 都会自动享有这份信任。它们下面的子目录可以。 */
const BROAD_HOME_FOLDERS = ['Downloads', 'Desktop', 'Documents']

/**
 * 不能设为信任的目录：任何一个根（各盘符的根、UNC 共享的根，判断是 dirname(p) === p）、主目录和主目录的上级，
 * 以及主目录下的 Downloads、Desktop、Documents 本身。它们包含的文件太多。
 * @param {string} path 工作区根的真实路径。
 * @param {string} home 主目录。
 * @param {typeof nodePath} [pathApi] 路径规则，缺省按本机；测试传 path.win32、path.posix。
 * @returns {'too-broad' | undefined} 拒绝原因。
 */
export function trustRefusal(path, home, pathApi = nodePath) {
  // Windows 路径不分大小写；那三个目录名在 macOS 上也按不分大小写比，宁可多拒。
  const windows = pathApi.sep === '\\'
  const fold = value => (windows ? value.toLowerCase() : value)
  const target = fold(pathApi.resolve(path)), base = fold(pathApi.resolve(home))
  if (pathApi.dirname(target) === target) return 'too-broad'
  const rel = pathApi.relative(target, base)
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel))) return 'too-broad'
  const lower = target.toLowerCase()
  if (BROAD_HOME_FOLDERS.some(name => lower === pathApi.join(base, name).toLowerCase())) return 'too-broad'
  return undefined
}

/** realpath，失败时原样返回。 */
function realOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** 显示用的路径：主目录下的写成 ~ 开头。 */
function displayPath(path, homes) {
  for (const home of homes) {
    if (resolve(path) === resolve(home)) return '~'
    if (within(home, path)) return `~/${relative(home, path).split(sep).join('/')}`
  }
  return path
}

/** 宿主端的上限。并发闸门是主要的保护（同时最多读 4 个，每个最多 16 MiB）；每个文档的额度是浏览器一侧上限之外的兜底。 */
export const DEFAULT_TRUST_LIMITS = { maxActive: 4, maxQueued: 64, maxResources: 1024, maxBytes: 256 * 1024 * 1024, windowMs: 60_000 }

/**
 * 读文件的闸门：同时最多 maxActive 个在读，最多 maxQueued 个排队，再来的直接拒绝（错误的 code 是 limit）。
 * 一个页面把同一个大文件带不同查询串引用上千次时，宿主端也不会同时把它们读进内存。
 * @param {{ maxActive: number, maxQueued: number }} limits 上限。
 * @returns {{ run: <T>(task: () => Promise<T>) => Promise<T> }} 闸门。
 */
export function createReadGate({ maxActive, maxQueued }) {
  let active = 0
  const waiting = []
  const start = (entry) => {
    active++
    Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
      active--
      const next = waiting.shift()
      if (next !== undefined) start(next)
    })
  }
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        const entry = { task, resolve, reject }
        if (active < maxActive) start(entry)
        else if (waiting.length < maxQueued) waiting.push(entry)
        else reject(Object.assign(new Error('workspace trust: read queue is full'), { code: 'limit' }))
      })
    },
  }
}

/**
 * 每个文档（会话 + 文档路径）在一个时间窗里能读的资源个数和字节数。
 * @param {{ maxResources: number, maxBytes: number, windowMs: number }} limits 上限。
 * @param {() => number} [clock] 时钟（测试用）。
 * @returns {{ take: (key: string) => boolean, charge: (key: string, bytes: number) => boolean }} 额度。
 */
function createDocumentBudget({ maxResources, maxBytes, windowMs }, clock = Date.now) {
  const entries = new Map()
  const entryOf = (key) => {
    const now = clock()
    let entry = entries.get(key)
    if (entry === undefined || now - entry.since > windowMs) {
      if (entries.size > 512) for (const [k, e] of entries) if (now - e.since > windowMs) entries.delete(k)
      entry = { since: now, count: 0, bytes: 0 }
      entries.set(key, entry)
    }
    return entry
  }
  return {
    take(key) {
      const entry = entryOf(key)
      if (entry.count >= maxResources) return false
      entry.count++
      return true
    },
    charge(key, bytes) {
      const entry = entryOf(key)
      if (entry.bytes + bytes > maxBytes) return false
      entry.bytes += bytes
      return true
    },
  }
}

/**
 * 注册两条路由。
 * @param {object} scope 带 connection 服务的插件作用域。
 * @param {{ dataDir: string, home: string, workspaceRootOf: (sessionId: string) => Promise<string | undefined> }} options
 *   数据目录、主目录、会话的工作区根（会话 header 的 cwd）。
 * @returns {() => void} 注销函数。
 */
export function applyWorkspaceTrustRoutes(scope, { dataDir, home, workspaceRootOf, limits: overrides = {} }) {
  const limits = { ...DEFAULT_TRUST_LIMITS, ...overrides }
  const gate = createReadGate(limits)
  const budget = createDocumentBudget(limits)
  const store = createTrustStore(dataDir)
  const token = randomBytes(32).toString('base64url')
  const homes = [home, realOr(home)]
  const listBody = () => ({ ok: true, workspaces: store.list().map(entry => ({ ...entry, display: displayPath(entry.path, homes) })) })
  /** POST 只认顶层页面：JSON 正文，带上 GET 才拿得到的令牌。 */
  const fromApp = request => (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
    && request.headers.get(TRUST_TOKEN_HEADER) === token
  /** 会话的工作区根和它的真实路径；取不到时 undefined。 */
  const rootOf = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const root = await workspaceRootOf(sessionId)
    if (typeof root !== 'string' || !isAbsolute(root)) return undefined
    try {
      return { root, realRoot: realpathSync(root) }
    } catch {
      return undefined
    }
  }

  const disposers = [
    scope.connection.fetch.register({
      path: ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') return json({ ...listBody(), token })
        if (!fromApp(request)) return json({ ok: false, reason: 'forbidden' }, 403)
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, reason: 'bad-request' }, 400)
        }
        const action = body?.action
        if (action === 'revoke') {
          if (typeof body.path !== 'string') return json({ ok: false, reason: 'bad-request' }, 400)
          store.revoke(body.path)
          return json(listBody())
        }
        if (action !== 'status' && action !== 'trust') return json({ ok: false, reason: 'bad-request' }, 400)
        // trust 只收会话 id：工作区根由宿主端从会话 header 取，网页端给不了任意路径。
        if (typeof body.sessionId !== 'string' || body.path !== undefined) return json({ ok: false, reason: 'bad-request' }, 400)
        const documentPath = body.documentPath
        if (action === 'status' && documentPath !== undefined && (typeof documentPath !== 'string' || documentPath.includes('\0')
          || !(isAbsolute(documentPath) || documentPath.startsWith('~/') || documentPath.startsWith('~\\')))) {
          return json({ ok: false, reason: 'bad-request' }, 400)
        }
        const located = await rootOf(body.sessionId)
        if (located === undefined) return json({ ok: false, reason: 'no-workspace' }, 400)
        // 显示会记下的真实路径，和设置页一致（cwd 是指向更大目录的链接时，不让人误以为只信任了链接本身）。
        const display = displayPath(located.realRoot, homes)
        if (action === 'status') return json({
          ok: true, ...located, display, trusted: store.isTrusted(located.realRoot),
          documentInside: documentPath !== undefined && await documentInWorkspace({ realRoot: located.realRoot, documentPath, home }),
        })
        const refusal = homes.map(value => trustRefusal(located.realRoot, value)).find(Boolean)
        if (refusal !== undefined) return json({ ok: false, reason: refusal, display }, 400)
        store.trust(located.realRoot)
        return json(listBody())
      },
    }),
    scope.connection.fetch.register({
      path: `${ROUTE}.resource`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (!fromApp(request)) return json({ ok: false, reason: 'forbidden' }, 403)
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, reason: 'bad-request' }, 400)
        }
        const documentRef = decodePreviewRoute(body?.document), resourceRef = decodePreviewRoute(body?.resource)
        if (documentRef === null || resourceRef === null) return json({ ok: false, reason: 'bad-request' }, 400)
        if (documentRef.sessionId !== resourceRef.sessionId) return json({ ok: false, reason: 'other-session' }, 403)
        const key = `${documentRef.sessionId}\0${documentRef.path}`
        if (!budget.take(key)) return json({ ok: false, reason: 'limit' }, 429)
        const root = await workspaceRootOf(documentRef.sessionId)
        let result
        try {
          result = await gate.run(() => readTrustedResource({
            root, documentPath: documentRef.path, resourcePath: resourceRef.path, isTrusted: path => store.isTrusted(path), home,
            admitBytes: size => budget.charge(key, size),
          }))
        } catch (error) {
          if (error?.code === 'limit') return json({ ok: false, reason: 'limit' }, 429)
          throw error
        }
        if (!result.ok) return json(result, result.reason === 'limit' ? 429 : 403)
        return new Response(result.bytes, {
          status: 200,
          headers: { 'content-type': result.mediaType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
        })
      },
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) void dispose?.()
  }
}

/**
 * 会话的工作区根：live 会话读 header 的 cwd，冷会话问持久层（和 lib/pages.js 同一个来源）。
 * @param {object} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<string | undefined>} 工作区根。
 */
async function headerWorkspaceRoot(ctx, sessionId) {
  const live = ctx.get?.('sessions')?.get(sessionId)
  if (typeof live?.header?.cwd === 'string') return live.header.cwd
  try {
    return (await ctx.get?.('sessionPersistence')?.stat(sessionId))?.header?.cwd
  } catch {
    return undefined
  }
}

/**
 * 注册 workspace-trust 行。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dataDir?: string }} [config] 行配置；dataDir 覆盖数据目录（测试用）。
 */
export function apply(ctx, config = {}) {
  ctx.effect(() => registerFeature('workspace-trust'), '@miint-sunny/dsh-workbench/workspace-trust: feature registration')
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => applyWorkspaceTrustRoutes(scope, {
      dataDir: config.dataDir ?? workbenchDataDir(),
      home: homedir(),
      workspaceRootOf: sessionId => headerWorkspaceRoot(ctx, sessionId),
    }), '@miint-sunny/dsh-workbench/workspace-trust: routes')
  })
}

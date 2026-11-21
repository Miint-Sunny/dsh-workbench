/**
 * 审阅面板宿主 HTTP 路由 `/api/dsh-workbench.git-review`：
 * - 挂在 DSH 共用的 `/api` 通道上（进来前已过 Host/Origin 校验与登录检查）；
 * - 照 `lib/workspace-trust.js` 的做法，POST 要求 `application/json` 且携带每个宿主进程随机生成、只由 GET 回答的令牌头，防止沙箱预览页跨站调用；
 * - 严格按白名单校验查询串和请求体字段，错误回答统一 `{ ok: false, code, detail? }`。
 */
import { randomBytes } from 'node:crypto'

export const GIT_REVIEW_ROUTE = '/api/dsh-workbench.git-review'
export const GIT_REVIEW_TOKEN_HEADER = 'x-dsh-workbench-git-review'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const REPO_ID_RE = /^[0-9a-f]{16}$/
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const UNDO_ID_RE = /^[0-9a-f-]{8,64}$/i

const ERROR_STATUS = new Map([
  ['bad-path', 400], ['stale', 409], ['too-large', 413], ['git-unavailable', 503],
])

const ALLOWED_GET_DIFF_KEYS = new Set([
  'sessionId',
  'repo',
  'scope',
  'base',
  'from',
  'to',
  'includeUncommitted',
])

const ALLOWED_POST_KEYS = {
  stage: new Set(['action', 'sessionId', 'repo', 'scope', 'version', 'path', 'hunk']),
  unstage: new Set(['action', 'sessionId', 'repo', 'scope', 'version', 'path', 'hunk']),
  revert: new Set(['action', 'sessionId', 'repo', 'scope', 'version', 'path', 'hunk']),
  undo: new Set(['action', 'sessionId', 'repo', 'undoId']),
  commit: new Set(['action', 'sessionId', 'repo', 'message', 'push']),
  push: new Set(['action', 'sessionId', 'repo']),
  'create-branch': new Set(['action', 'sessionId', 'repo', 'name']),
  'generate-message': new Set(['action', 'sessionId', 'repo']),
  'cancel-generate': new Set(['action', 'requestId', 'sessionId', 'repo']),
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

const reply = (result) => {
  if (result.ok) return json(result, 200)
  return json(
    { ok: false, code: result.code, ...(result.detail !== undefined ? { detail: result.detail } : {}) },
    result.status ?? 400,
  )
}

const badRequest = () => json({ ok: false, code: 'bad-request' }, 400)

const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)
const validBase = base => base === null || (base !== '' && base.trim() === base && !/[\x00-\x20\x7f]/.test(base))
const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 连接服务拥有路由，subprocess 服务挂载期间才接受 Git 操作。
 * @param {object} scope 提供日志的宿主作用域。
 * @returns {{ route: object, mount: (service: object) => () => Promise<void> }} 路由与服务卸载入口。
 */
export function createGitReviewEndpoint(scope) {
  let backend
  const token = randomBytes(32).toString('base64url')

  const fromApp = request =>
    (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
    && request.headers.get(GIT_REVIEW_TOKEN_HEADER) === token

  async function handleGet(request, service) {
    let params
    try {
      params = new URL(request.url).searchParams
    } catch {
      return badRequest()
    }
    const keys = [...new Set(params.keys())]
    if (keys.length === 0) return badRequest()
    for (const key of keys) {
      if (params.getAll(key).length !== 1) return badRequest()
    }

    if (params.has('requestId')) {
      if (keys.length !== 1) return badRequest()
      const requestId = params.get('requestId')
      if (!REQUEST_ID_RE.test(requestId ?? '')) return badRequest()
      return reply(service.generationStatus(requestId))
    }

    const sessionId = params.get('sessionId')
    if (!SESSION_ID_RE.test(sessionId ?? '')) return badRequest()

    if (keys.length === 1) {
      const res = await service.status(sessionId, request.signal)
      if (!res.ok) return reply(res)
      return json({ ...res, token }, 200)
    }

    const repo = params.get('repo')
    if (!REPO_ID_RE.test(repo ?? '')) return badRequest()

    if (params.has('branches')) {
      if (keys.length !== 3 || !keys.includes('repo') || params.get('branches') !== '1') return badRequest()
      return reply(await service.branches(sessionId, repo, request.signal))
    }

    if (params.has('commits')) {
      const validKeys = keys.every(k => ['sessionId', 'repo', 'commits', 'base'].includes(k))
      if (!validKeys || params.get('commits') !== '1') return badRequest()
      const base = params.get('base')
      if (!validBase(base)) return badRequest()
      return reply(await service.commits(sessionId, repo, base ?? undefined, request.signal))
    }

    if (params.has('scope')) {
      if (!keys.every(k => ALLOWED_GET_DIFF_KEYS.has(k))) return badRequest()
      const scopeName = params.get('scope')
      if (!['unstaged', 'staged', 'uncommitted', 'branch'].includes(scopeName ?? '')) return badRequest()
      if (scopeName !== 'branch' && keys.length !== 3) return badRequest()
      if (!validBase(params.get('base'))) return badRequest()
      for (const endpoint of ['from', 'to']) {
        if (params.has(endpoint) && !/^[0-9a-f]{7,64}$/i.test(params.get(endpoint))) return badRequest()
      }
      const inc = params.get('includeUncommitted')
      if (inc !== null && inc !== '1' && inc !== '0') return badRequest()
      return reply(await service.diff({
        sessionId,
        repo,
        scope: scopeName,
        base: params.get('base') ?? undefined,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        includeUncommitted: inc === '1',
      }, request.signal))
    }

    return badRequest()
  }

  async function handlePost(request, service) {
    let body
    try {
      body = await request.json()
    } catch {
      return badRequest()
    }
    if (!isPlainObject(body) || typeof body.action !== 'string') return badRequest()
    const allowed = Object.hasOwn(ALLOWED_POST_KEYS, body.action) ? ALLOWED_POST_KEYS[body.action] : undefined
    if (allowed === undefined) return badRequest()
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) return badRequest()
    }

    if (body.action === 'cancel-generate') {
      if (!matches(body.requestId, REQUEST_ID_RE)) return badRequest()
      if (body.sessionId !== undefined && !matches(body.sessionId, SESSION_ID_RE)) return badRequest()
      if (body.repo !== undefined && !matches(body.repo, REPO_ID_RE)) return badRequest()
      return reply(await service.cancelGenerate({
        requestId: body.requestId,
        sessionId: body.sessionId,
        repo: body.repo,
      }, request.signal))
    }

    if (!matches(body.sessionId, SESSION_ID_RE) || !matches(body.repo, REPO_ID_RE)) {
      return badRequest()
    }

    if (body.action === 'stage' || body.action === 'unstage' || body.action === 'revert') {
      if (typeof body.scope !== 'string' || typeof body.version !== 'string') return badRequest()
      if (body.path !== undefined && typeof body.path !== 'string') return badRequest()
      if (body.hunk !== undefined && typeof body.hunk !== 'string') return badRequest()
      return reply(await service[body.action]({
        sessionId: body.sessionId,
        repo: body.repo,
        scope: body.scope,
        version: body.version,
        path: body.path,
        hunk: body.hunk,
      }, request.signal))
    }

    if (body.action === 'undo') {
      if (!matches(body.undoId, UNDO_ID_RE)) return badRequest()
      return reply(await service.undo({
        sessionId: body.sessionId,
        repo: body.repo,
        undoId: body.undoId,
      }, request.signal))
    }

    if (body.action === 'commit') {
      if (typeof body.message !== 'string') return badRequest()
      if (body.push !== undefined && typeof body.push !== 'boolean') return badRequest()
      return reply(await service.commit({
        sessionId: body.sessionId,
        repo: body.repo,
        message: body.message,
        push: body.push ?? false,
      }, request.signal))
    }

    if (body.action === 'push') {
      return reply(await service.push({
        sessionId: body.sessionId,
        repo: body.repo,
      }, request.signal))
    }

    if (body.action === 'create-branch') {
      if (typeof body.name !== 'string') return badRequest()
      return reply(await service.createBranch({
        sessionId: body.sessionId,
        repo: body.repo,
        name: body.name,
      }, request.signal))
    }

    if (body.action === 'generate-message') {
      return reply(await service.generateMessage({
        sessionId: body.sessionId,
        repo: body.repo,
      }, request.signal))
    }

    return badRequest()
  }

  const route = {
    path: GIT_REVIEW_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'POST' && !fromApp(request)) return json({ ok: false, code: 'forbidden' }, 403)
      if (request.method !== 'POST' && request.method !== 'GET') return json({ ok: false, code: 'bad-request' }, 405)
      if (!backend) {
        return json({ ok: false, code: 'git-unavailable', detail: 'Git 审阅需要提供 spawn 和 resolveExecutable 的 subprocess 服务。' }, 503)
      }
      const { service, pending } = backend
      const task = request.method === 'GET' ? handleGet(request, service) : handlePost(request, service)
      pending.add(task)
      try {
        return await task
      } catch (error) {
        const status = ERROR_STATUS.get(error?.code)
        if (status) return json({ ok: false, code: error.code }, status)
        scope.logger?.warn?.(`dsh-workbench git-review 失败：${String(error?.stack ?? error)}`)
        return json({ ok: false, code: 'not-found' }, 500)
      } finally {
        pending.delete(task)
      }
    },
  }
  return {
    route,
    mount(service) {
      const current = { service, pending: new Set() }
      backend = current
      return async () => {
        if (backend === current) backend = undefined
        await Promise.allSettled(current.pending)
      }
    },
  }
}

/**
 * 将一个 Git 审阅服务绑定到连接路由。
 * @param {object} scope 连接作用域。
 * @param {object} service Git 审阅服务。
 * @returns {() => Promise<void>} 注销路由并等待已接受的请求。
 */
export function registerGitReviewRoute(scope, service) {
  const endpoint = createGitReviewEndpoint(scope)
  const retire = endpoint.mount(service)
  const unregister = scope.connection.fetch.register(endpoint.route)
  return async () => {
    const drained = retire()
    await unregister()
    await drained
  }
}

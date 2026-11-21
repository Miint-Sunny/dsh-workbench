/**
 * 网页发布（dsh-workbench/pages）的路由，挂在 DSH 共用的 `/api` 通道上（进来前已查 Host、
 * Origin、登录 cookie，只放本人）：
 *   GET  list    全部页面（最近更新在前，损坏的排最后）
 *   GET  html    某一版的 HTML（iframe 用）；HEAD 也回答（空 body）
 *   POST delete  删除页面（挪进回收目录）
 *   POST restore 从回收目录恢复
 *   POST publish 发布（文件预览里的「发布为页面」用；走和工具同一个读文件与内联）
 *
 * 计划规定路由不收文件路径；publish 是唯一例外：path 和工具的 path 一样，要经过
 * lib/pages-read.js 的工作区包含检查（realpath 之后必须在工作区根之内）才会被读，
 * README 的「网页发布」一节写明了这条。
 * 本模块不 import 任何 @deepseek-ai 包。
 */
import { publishHtml } from './pages-publish.js'
import { PagesError } from './pages-error.js'

/** 会话 ID 的字符集（照 review 路由的写法）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** 页面 id 的字符集（和存储的 id 生成一致）。 */
const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** PagesError 的 code 到 HTTP 状态：读不到是 404，用法和限额是 400，其余 500。 */
const STATUS_OF_CODE = {
  'not-found': 404,
  'session-not-found': 404,
  'invalid-body': 400,
  'invalid-page': 400,
  'page-ids-exhausted': 409,
  'trash-ids-exhausted': 409,
  'not-a-relative-path': 400,
  'outside-workspace': 400,
  'not-a-file': 400,
  'not-html': 400,
  'html-too-large': 400,
  'asset-too-large': 400,
  'page-too-large': 400,
  'too-many-assets': 400,
  'assets-too-large': 400,
  'unknown-asset-type': 400,
  'no-workspace': 400,
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** html 路由的响应头：沙箱加 nosniff（照 DSH /api/file 的写法）。直接打开这个地址也不运行页面里的脚本（fix#173）。 */
const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': 'sandbox',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'cache-control': 'no-store',
}

/**
 * 注册 pages 的全部路由。
 * @param {object} scope 带有 connection 服务的插件作用域（进来前已过鉴权）。
 * @param {{ store: object, workspaceRootOf: (sessionId: string) => Promise<string | undefined> }} services 存储和取会话工作区根的函数。
 * @returns {() => void} 注销函数。
 */
export function applyPagesRoutes(scope, { store, workspaceRootOf }) {
  const disposers = []
  const keep = (disposer) => {
    disposers.push(disposer)
    return disposer
  }

  keep(scope.connection.fetch.register({
    path: '/api/dsh-workbench.pages.list',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => json(store.listPages()),
  }))

  keep(scope.connection.fetch.register({
    path: '/api/dsh-workbench.pages.html',
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: (request) => {
      const params = new URL(request.url).searchParams
      const page = params.get('page')
      const v = params.get('v')
      if (page === null || !PAGE_ID_PATTERN.test(page)) return json({ ok: false, message: '页面 id 不合法。' }, 400)
      if (v === null || !/^\d+$/.test(v) || Number(v) < 1) return json({ ok: false, message: '版本号不合法。' }, 400)
      const found = store.readVersion(page, Number(v))
      if (found === undefined) return json({ ok: false, message: '页面或版本不存在。' }, 404)
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: htmlHeaders })
      return new Response(found.html, { status: 200, headers: htmlHeaders })
    },
  }))

  /** POST 路由的公共处理：解析请求体，调 action，把结果翻成 JSON。 */
  const post = (action) => async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, message: '请求体不是 JSON。' }, 400)
    }
    if (typeof body !== 'object' || body === null) return json({ ok: false, message: '请求体不是 JSON 对象。' }, 400)
    try {
      return json(await action(body, request))
    } catch (error) {
      if (error instanceof PagesError) {
        const status = STATUS_OF_CODE[error.code] ?? 500
        return json({ ok: false, code: error.code, message: error.message }, status)
      }
      if (error instanceof Error && /不存在|不合法|已存在|损坏/.test(error.message)) {
        return json({ ok: false, message: error.message }, 400)
      }
      return json({ ok: false, message: '处理请求时出错，请重试。' }, 500)
    }
  }

  keep(scope.connection.fetch.register({
    path: '/api/dsh-workbench.pages.delete',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: post((body) => {
      const page = body.page
      if (typeof page !== 'string' || !PAGE_ID_PATTERN.test(page)) throw new PagesError('invalid-page', `页面 id 不合法。`)
      if (!store.deletePage(page)) throw new PagesError('not-found', `页面 ${page} 不存在。`)
      return { ok: true }
    }),
  }))

  keep(scope.connection.fetch.register({
    path: '/api/dsh-workbench.pages.restore',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: post((body) => {
      const page = body.page
      if (typeof page !== 'string' || !PAGE_ID_PATTERN.test(page)) throw new PagesError('invalid-page', `页面 id 不合法。`)
      if (!store.restorePage(page)) throw new PagesError('not-found', `回收目录中不存在页面 ${page}。`)
      return { ok: true }
    }),
  }))

  keep(scope.connection.fetch.register({
    path: '/api/dsh-workbench.pages.publish',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: post(async (body, request) => {
      const allowed = new Set(['sessionId', 'path', 'page'])
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new PagesError('invalid-body', `未知参数：${key}。`)
      }
      const { sessionId, path, page } = body
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new PagesError('invalid-body', '会话 ID 不合法。')
      }
      if (typeof path !== 'string' || path === '') throw new PagesError('invalid-body', 'path 必须是工作区中的相对路径。')
      if (page !== undefined && (typeof page !== 'string' || !PAGE_ID_PATTERN.test(page))) {
        throw new PagesError('invalid-body', '页面 id 不合法。')
      }
      const workspaceRoot = await workspaceRootOf(sessionId)
      if (workspaceRoot === undefined) throw new PagesError('session-not-found', `会话 ${sessionId} 不存在。`)
      const { meta, version, warnings } = await publishHtml(store, {
        sessionId,
        path,
        workspaceRoot,
        pageId: page,
        signal: request.signal,
      })
      return { ok: true, page: { id: meta.id, title: meta.title, n: version.n, size: version.size, updatedAt: meta.updatedAt }, warnings }
    }),
  }))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

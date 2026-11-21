/** 回退、撤销回退和已回退状态三个路由。挂在 DSH 共用的 `/api` 通道上（进来前已查 Host、Origin、登录 cookie，且只放本人）；参数只收会话、序号和下标这类坐标，不收文件路径——路径由宿主按自己的改动记录解析。 */

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** 会话 ID 的字符集：会拼进记录目录名，只放字母、数字、短横线和下划线。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** 收的四个字段。 */
const ALLOWED_KEYS = new Set(['sessionId', 'seq', 'fileIndex', 'hunkIndex'])

/** 一看就是想传文件路径的字段名，单独给一句直话。 */
const PATH_KEYS = ['path', 'filePath', 'file', 'target']

/** 核对会话 ID 和序号，出错给能显示的原因。 */
const checkIdAndSeq = (bad, sessionId, seq) => {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return bad('会话 ID 不合法。')
  if (!Number.isSafeInteger(seq) || seq < 0) return bad('改动事件的序号不合法。')
  return undefined
}

/**
 * 解析路由的请求体坐标。
 * @param {unknown} body 请求体。
 * @returns {{ ok: true, value: { sessionId: string, seq: number, fileIndex: number, hunkIndex: number | null } } | { ok: false, message: string }} 合法的坐标（改动处下标缺省是 null，即整个文件）；不合法时给能显示的原因。
 */
export function parseCoordinate(body) {
  const bad = (message) => ({ ok: false, message })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('请求体不是 JSON 对象。')
  for (const key of PATH_KEYS) {
    if (key in body) return bad('不接受文件路径，仅接受会话、序号和下标。')
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) return bad(`未知参数：${key}。`)
  }
  const { sessionId, seq, fileIndex, hunkIndex } = body
  const idFailure = checkIdAndSeq(bad, sessionId, seq)
  if (idFailure !== undefined) return idFailure
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return bad('文件下标不合法。')
  if (hunkIndex !== undefined && hunkIndex !== null
    && (!Number.isSafeInteger(hunkIndex) || hunkIndex < 0)) return bad('改动处下标不合法。')
  return { ok: true, value: { sessionId, seq, fileIndex, hunkIndex: hunkIndex ?? null } }
}

/**
 * 解析已回退状态路由的查询串坐标（sessionId、seq 两个）。
 * @param {string} url 请求的完整地址。
 * @returns {{ ok: true, value: { sessionId: string, seq: number } } | { ok: false, message: string }} 合法坐标或能显示的原因。
 */
export function parseStateQuery(url) {
  const bad = (message) => ({ ok: false, message })
  let params
  try {
    params = new URL(url).searchParams
  } catch {
    return bad('请求地址不合法。')
  }
  for (const key of PATH_KEYS) {
    if (params.has(key)) return bad('不接受文件路径，仅接受会话、序号和下标。')
  }
  for (const key of params.keys()) {
    if (key !== 'sessionId' && key !== 'seq') return bad(`未知参数：${key}。`)
  }
  const seqText = params.get('seq')
  const idFailure = checkIdAndSeq(bad, params.get('sessionId'), seqText === null || seqText === '' ? undefined : Number(seqText))
  if (idFailure !== undefined) return idFailure
  return { ok: true, value: { sessionId: params.get('sessionId'), seq: Number(seqText) } }
}

/**
 * 一个路由的公共处理：解析请求体，按方法调服务，把结果翻成 JSON 响应。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文，只用来记日志。
 * @param {object} service 改动审阅服务。
 * @param {'revert' | 'undo'} method 动作。
 * @param {Request} request 进来的请求。
 */
async function handle(ctx, service, method, request) {
  let body
  try {
    body = await request.json()
  } catch {
    // 请求体不是 JSON：按参数错误回答，不往下走。
    return json({ ok: false, reason: 'invalid-body', message: '请求体不是 JSON。' }, 400)
  }
  const parsed = parseCoordinate(body)
  if (!parsed.ok) return json({ ok: false, reason: 'invalid-body', message: parsed.message }, 400)
  let result
  try {
    result = method === 'revert'
      ? await service.revert(parsed.value, request.signal)
      : await service.undo(parsed.value)
  } catch (error) {
    ctx.logger?.warn(`dsh-workbench review ${method} 失败：${String(error?.stack ?? error)}`)
    return json({ ok: false, reason: 'error', message: '处理请求时出错，请重试。' }, 500)
  }
  if (result.ok) return json({ ok: true, display: result.display, description: result.description })
  return json({ ok: false, reason: result.reason, message: result.message }, result.status)
}

/**
 * 注册 `POST /api/dsh-workbench.review.revert` 和 `POST /api/dsh-workbench.review.undo`。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} service 改动审阅服务。
 */
export function registerReviewRoutes(ctx, service) {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-workbench.review.revert',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handle(ctx, service, 'revert', request),
    }), 'dsh-workbench: review revert route')
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-workbench.review.undo',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handle(ctx, service, 'undo', request),
    }), 'dsh-workbench: review undo route')
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-workbench.review.state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const parsed = parseStateQuery(request.url)
        if (!parsed.ok) return json({ ok: false, reason: 'invalid-query', message: parsed.message }, 400)
        return json(await service.state(parsed.value))
      },
    }), 'dsh-workbench: review state route')
  })
}

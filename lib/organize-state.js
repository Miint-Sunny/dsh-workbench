/**
 * 会话整理（dsh-workbench/organize）的宿主端：标签、标为未读的数据存取和读写路由。
 * 状态是 `$DSH_HOME/dsh-workbench/organize.json`（目录见 lib/data-dir.js），读写都走
 * `/api` 通道（进来前已查 Host、Origin、登录 cookie，只放本人）。本模块不 import
 * 任何 @deepseek-ai 包，`node --test` 直接可跑。
 *
 * 标签 id 固定六个、颜色固定（网页端按同一个 id 画点），只有名字能改。文件损坏
 * （JSON 坏了或形状不对）时读接口按默认状态回答并带 reason: 'corrupt'，不覆盖坏
 * 文件；第一次写之前先把它改名成 organize.json.bad（已有一份就加时间戳）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchDataDir } from './data-dir.js'

/** 标签 id，顺序也是「会话」页里的显示顺序（红、橙、黄、绿、蓝、紫）。 */
export const LABEL_IDS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']

/** 标签的默认名字（和网页端 organize.js 的 ORGANIZE_DEFAULT_NAMES 一致，改的时候一起改）。 */
export const DEFAULT_LABEL_NAMES = {
  red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色',
}

/** 状态文件最多记多少个会话（assignments 和 unread 合起来按会话 id 去重算）。 */
export const MAX_SESSIONS = 5000

/** 一次操作最多带多少个会话 id；每个会话 id 的最长长度。 */
export const MAX_BATCH = 200
export const MAX_SESSION_ID = 200

/** 标签名去首尾空白后的最长长度。 */
export const MAX_NAME = 20

/** 默认状态：六个默认名字的标签，没有标签、没有未读。 */
export function defaultOrganizeState() {
  return {
    version: 1,
    labels: LABEL_IDS.map(id => ({ id, name: DEFAULT_LABEL_NAMES[id] })),
    assignments: {},
    unread: [],
  }
}

/**
 * 校验并规范化状态文件的内容。
 * @param {unknown} value 文件里解析出来的 JSON。
 * @returns {object} 规范化后的状态。
 * @throws {Error} 形状不对时（按损坏处理）。
 */
export function parseOrganizeState(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('organize state must be an object')
  if (value.version !== 1) throw new Error('organize state version must be 1')
  if (!Array.isArray(value.labels) || value.labels.length !== LABEL_IDS.length) {
    throw new Error(`organize state labels must be the ${LABEL_IDS.length} labels`)
  }
  const seen = new Set()
  const names = new Set()
  const labels = []
  for (const label of value.labels) {
    if (typeof label !== 'object' || label === null || typeof label.id !== 'string' || typeof label.name !== 'string') {
      throw new Error('organize state labels entries must be { id, name }')
    }
    if (!LABEL_IDS.includes(label.id) || seen.has(label.id)) throw new Error(`organize state label ${label.id} is not one of the six`)
    const name = label.name.trim()
    if (name === '' || name.length > MAX_NAME) throw new Error(`organize state label ${label.id} name is invalid`)
    if (names.has(name)) throw new Error('organize state label names must be unique')
    seen.add(label.id)
    names.add(name)
    labels.push({ id: label.id, name })
  }
  if (typeof value.assignments !== 'object' || value.assignments === null || Array.isArray(value.assignments)) {
    throw new Error('organize state assignments must be an object')
  }
  const assignments = {}
  for (const [id, labelId] of Object.entries(value.assignments)) {
    if (id === '' || id.length > MAX_SESSION_ID) throw new Error('organize state assignments keys must be session ids')
    if (!LABEL_IDS.includes(labelId)) throw new Error('organize state assignments values must be label ids')
    assignments[id] = labelId
  }
  if (!Array.isArray(value.unread)) throw new Error('organize state unread must be an array')
  const unread = new Set()
  for (const id of value.unread) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_SESSION_ID) throw new Error('organize state unread entries must be session ids')
    unread.add(id)
  }
  const sessions = new Set([...Object.keys(assignments), ...unread])
  if (sessions.size > MAX_SESSIONS) throw new Error(`organize state lists more than ${MAX_SESSIONS} sessions`)
  return { version: 1, labels, assignments, unread: [...unread] }
}

/** 会话 id 数组的基本校验：非空字符串数组、最多 MAX_BATCH 个、每个最长 MAX_SESSION_ID。 */
function sessionIdsProblem(value) {
  if (!Array.isArray(value) || value.length === 0) return 'sessionIds.empty'
  if (value.length > MAX_BATCH) return 'sessionIds.tooMany'
  for (const id of value) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_SESSION_ID) return 'sessionIds.bad'
  }
  return undefined
}

/** 新的 assignments / unread 超过会话数上限时的失败码。 */
function commit(state, assignments, unread) {
  const sessions = new Set([...Object.keys(assignments), ...unread])
  if (sessions.size > MAX_SESSIONS) return { ok: false, code: 'sessions.tooMany' }
  return { ok: true, state: { version: 1, labels: state.labels, assignments, unread } }
}

/**
 * 校验并应用一个写操作。纯函数：不改动传入的状态。
 * @param {object} state 当前状态（parseOrganizeState 规范化过的形状）。
 * @param {unknown} body 请求体（`op` 区分三种操作）。
 * @returns {{ok: true, state: object} | {ok: false, code: string}} 新状态，或给网页端翻译的失败码。
 */
export function organizeApply(state, body) {
  if (typeof body !== 'object' || body === null) return { ok: false, code: 'body.bad' }
  if (body.op === 'setLabel') {
    const problem = sessionIdsProblem(body.sessionIds) ?? (body.labelId === null || LABEL_IDS.includes(body.labelId) ? undefined : 'labelId.bad')
    if (problem !== undefined) return { ok: false, code: problem }
    const assignments = { ...state.assignments }
    for (const id of body.sessionIds) {
      if (body.labelId === null) delete assignments[id]
      else assignments[id] = body.labelId
    }
    return commit(state, assignments, state.unread)
  }
  if (body.op === 'renameLabel') {
    if (!LABEL_IDS.includes(body.labelId)) return { ok: false, code: 'labelId.bad' }
    if (typeof body.name !== 'string') return { ok: false, code: 'name.bad' }
    const name = body.name.trim()
    if (name === '') return { ok: false, code: 'name.empty' }
    if (name.length > MAX_NAME) return { ok: false, code: 'name.tooLong' }
    const labels = state.labels.map(label => (label.id === body.labelId ? { ...label, name } : { ...label }))
    if (new Set(labels.map(label => label.name)).size !== labels.length) return { ok: false, code: 'name.duplicate' }
    return { ok: true, state: { version: 1, labels, assignments: state.assignments, unread: state.unread } }
  }
  if (body.op === 'setUnread') {
    const problem = sessionIdsProblem(body.sessionIds)
    if (problem !== undefined) return { ok: false, code: problem }
    if (typeof body.unread !== 'boolean') return { ok: false, code: 'unread.bad' }
    const unread = new Set(state.unread)
    for (const id of body.sessionIds) {
      if (body.unread) unread.add(id)
      else unread.delete(id)
    }
    return commit(state, state.assignments, [...unread])
  }
  return { ok: false, code: 'op.bad' }
}

/**
 * 读数据目录里的状态。文件不存在用默认状态；JSON 坏了或形状不对按默认状态回答并带
 * corrupt: true（不改文件，写之前才备份）。
 * @param {string} dir 数据目录。
 * @returns {{state: object, corrupt: boolean}} 当前状态和文件是否损坏。
 */
export function readOrganizeState(dir) {
  let raw
  try {
    raw = readFileSync(join(dir, 'organize.json'), 'utf8')
  } catch {
    return { state: defaultOrganizeState(), corrupt: false }
  }
  try {
    return { state: parseOrganizeState(JSON.parse(raw)), corrupt: false }
  } catch {
    return { state: defaultOrganizeState(), corrupt: true }
  }
}

/**
 * 把状态写进数据目录（原子写：先写临时文件再改名）。
 * @param {string} dir 数据目录。
 * @param {object} state organizeApply 产出的状态。
 * @returns {void}
 */
export function writeOrganizeState(dir, state) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'organize.json')
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temp, file)
}

/**
 * 把损坏的状态文件改名备份成 organize.json.bad（已有一份就加时间戳）。写第一个操作
 * 之前调用，坏数据留在备份里。
 * @param {string} dir 数据目录。
 * @returns {string | undefined} 备份后的路径；文件本来就不存在（已被备份过）时 undefined。
 */
export function backupOrganizeFile(dir) {
  const file = join(dir, 'organize.json')
  if (!existsSync(file)) return undefined
  const plain = `${file}.bad`
  const target = existsSync(plain) ? `${file}.${Date.now()}.bad` : plain
  renameSync(file, target)
  return target
}

/**
 * 带排队的数据文件：同一进程里的写操作排成一条链（读、算、写之间不插进别的写），
 * 第一个写在文件损坏时先备份。读不加锁（写是同步的，读到的总是完整状态）。
 * @param {string} dir 数据目录。
 * @returns {{read: () => {state: object, corrupt: boolean}, apply: (body: unknown) => Promise<{ok: true, state: object} | {ok: false, code: string}>}} 存取接口。
 */
export function createOrganizeFile(dir) {
  let chain = Promise.resolve()
  return {
    read: () => readOrganizeState(dir),
    apply(body) {
      const run = () => {
        const current = readOrganizeState(dir)
        if (current.corrupt) backupOrganizeFile(dir)
        const result = organizeApply(current.state, body)
        if (result.ok) writeOrganizeState(dir, result.state)
        return result
      }
      // 前一个写不管成败，这一个都接着跑；链条本身不保留失败。
      const next = chain.then(run, run)
      chain = next.catch(() => {})
      return next
    },
  }
}

/** 失败码给网页端翻译用；message 是技术原因，进日志和网页端的兜底文案。 */
const CODE_MESSAGES = {
  'body.bad': 'request body must be JSON',
  'op.bad': 'op must be setLabel, renameLabel or setUnread',
  'sessionIds.empty': 'sessionIds must be a non-empty array',
  'sessionIds.tooMany': `sessionIds must list at most ${MAX_BATCH} sessions`,
  'sessionIds.bad': 'sessionIds entries must be non-empty strings of at most 200 characters',
  'labelId.bad': 'labelId must be one of the six labels or null',
  'name.bad': 'name must be a string',
  'name.empty': 'name must not be blank',
  'name.tooLong': `name must be at most ${MAX_NAME} characters after trimming`,
  'name.duplicate': 'name must not duplicate another label',
  'unread.bad': 'unread must be a boolean',
  'sessions.tooMany': `the state file lists more than ${MAX_SESSIONS} sessions`,
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/**
 * 注册 organize 行的路由：GET/POST /api/dsh-workbench.organize。GET 回答当前状态；
 * POST 校验并应用一个操作。成功都回答 `{ ok: true, state }`（GET 碰到损坏文件回答
 * 默认状态并带 `{ ok: false, reason: 'corrupt' }`）。
 * @param {object} scope 带有 connection 服务的插件作用域（进来前已过鉴权）。
 * @param {object} [options] 注入项：dir 覆盖数据目录（测试用）。
 * @returns {() => void} 注销函数。
 */
export function applyOrganizeRoutes(scope, options = {}) {
  const dir = options.dir ?? workbenchDataDir(process.env)
  const file = createOrganizeFile(dir)
  return scope.connection.fetch.register({
    path: '/api/dsh-workbench.organize',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        const { state, corrupt } = file.read()
        return corrupt ? json({ ok: false, reason: 'corrupt', state }) : json({ ok: true, state })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, code: 'body.bad', message: CODE_MESSAGES['body.bad'] }, 400)
      }
      const result = await file.apply(body)
      if (result.ok !== true) {
        return json({ ok: false, code: result.code, message: CODE_MESSAGES[result.code] ?? result.code }, 400)
      }
      return json({ ok: true, state: result.state })
    },
  })
}

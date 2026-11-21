/** 按需刷新会话摘要。仅官方服务读取日志；本模块只读日志元数据并写自己的缓存。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { DIGEST_VERSION } from './usage-digest.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => value === null || typeof value === 'string'
const numeric = (value, keys) => object(value) && keys.every(k => Number.isFinite(value[k]))
const maybeNumeric = (value, keys) => keys.every(k => value[k] === null || Number.isFinite(value[k]))
function valid(entry) {
  const d = entry?.digest
  if (entry?.version !== DIGEST_VERSION || typeof entry.key !== 'string' || !object(d) || typeof d.deleted !== 'boolean') return false
  const s = d.session
  if (!numeric(s, ['created','req','turns','lastPrompt','snap']) || typeof s.s !== 'string' || typeof s.ws !== 'string' || !text(s.preset) || !text(s.title)) return false
  if (!['rows', 'tools', 'retryLog', 'turnEnds'].every(k => Array.isArray(d[k]))) return false
  if (!d.rows.every(r => numeric(r, ['t','input','rd','wr','out','reas','prompt','retries','attempts']) && r.s === s.s
    && maybeNumeric(r, ['ttft','dur','dec','turn','gap','hit']) && ['main','attempt','compaction'].includes(r.kind)
    && [r.m,r.p,r.preset].every(text) && [null,'first','resume','system','header'].includes(r.reason)
    && (r.comp === undefined || numeric(r.comp, ['sys','tools','inject','msg','reas','res','comp'])))) return false
  if (!d.tools.every(r => numeric(r, ['t','ms','tok']) && r.s === s.s && typeof r.name === 'string' && typeof r.err === 'boolean')) return false
  if (!d.retryLog.every(r => numeric(r, ['t']) && r.s === s.s && [r.p,r.code,r.why].every(text) && maybeNumeric(r, ['status']))) return false
  return d.turnEnds.every(r => numeric(r, ['t']) && r.s === s.s && [r.p,r.kind,r.code].every(text))
}

/**
 * 创建缓存。冷会话使用官方 location 的文件元数据，活会话使用对象身份和 seq。
 * 持久层没有可复用文件位置时，revision 只在当前服务实例内复用。
 * 一个会话读取失败时留着上次的摘要，其他会话照常；被删除的会话留下数字，不留标题。
 * @param {object} options dir、sessionQuery、digest，变更观察所需的 sessionPersistence、sessions，以及可选的 logger。
 * @returns {{refresh: function(AbortSignal=): Promise<object[]>, unreadable: function(): number}} 共享刷新入口，单个调用取消不影响其他调用；上一轮读取失败的会话数。
 */
export function createUsageStore({ dir, sessionQuery, digest, sessionPersistence, sessions, logger = console }) {
  const cache = new Map(), identities = new WeakMap(), epoch = randomUUID()
  let loaded, flight, unreadable = 0
  const file = id => join(dir, `${hash(id)}.json`)
  async function load() {
    let names
    try { names = await readdir(dir) } catch (e) { if (e.code === 'ENOENT') return; throw e }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      let entry
      try { entry = JSON.parse(await readFile(join(dir, name), 'utf8')) } catch (e) { if (e instanceof SyntaxError || e.code === 'ENOENT') continue; throw e }
      if (valid(entry) && name === `${hash(entry.digest.session.s)}.json`) cache.set(entry.digest.session.s, entry)
    }
  }
  async function save(id, entry, signal) {
    signal.throwIfAborted()
    await mkdir(dir, { recursive: true })
    const target = file(id), temp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(entry)}\n`, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(temp, target)
      cache.set(id, entry)
    } finally { await rm(temp, { force: true }) }
  }
  async function keyOf(record, persisted, signal) {
    const live = sessions?.get(record.header.id)
    if (live) {
      if (!identities.has(live)) identities.set(live, randomUUID())
      return `live:${identities.get(live)}:${live.seq}`
    }
    if (record.live) throw new Error('usage source changed')
    const snapshot = persisted.get(record.header.id)
    if (!snapshot) throw new Error('usage source unavailable')
    if (snapshot.location?.kind === 'jsonl' && record.formatStatus === 'current') {
      const info = await stat(snapshot.location.path, { bigint: true })
      signal.throwIfAborted()
      return hash([snapshot.location.path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'))
    }
    if (!identities.has(sessionPersistence)) identities.set(sessionPersistence, randomUUID())
    return hash(`${epoch}:${identities.get(sessionPersistence)}:${snapshot.revision}`)
  }
  async function run(signal) {
    loaded ??= load().catch(error => { loaded = undefined; throw error })
    await loaded
    signal.throwIfAborted()
    const records = await sessionQuery.listSessions(signal)
    const persisted = new Map((await sessionPersistence?.list({ signal }) ?? []).map(s => [s.header.id, s]))
    const present = new Set(records.map(r => r.header.id))
    let failed = 0
    for (const record of records) {
      signal.throwIfAborted()
      const id = record.header.id
      try {
        const key = await keyOf(record, persisted, signal), previous = cache.get(id)
        // 被删除时标题已经清掉，会话重新出现要重读。
        if (previous?.key !== key || previous.digest.deleted) {
          const source = await sessionQuery.readSession(id)
          signal.throwIfAborted()
          await save(id, { version: DIGEST_VERSION, key, digest: { ...digest(source), deleted: false } }, signal)
        }
      } catch (error) {
        if (signal.aborted) throw error
        failed++
        logger.warn?.(`dsh-workbench/usage: 会话 ${id} 读取失败：${String(error?.message ?? error)}`)
      }
      await setImmediate()
    }
    for (const [id, previous] of cache) {
      if (present.has(id) || previous.digest.deleted) continue
      const session = { ...previous.digest.session, title: null }
      await save(id, { ...previous, digest: { ...previous.digest, session, deleted: true } }, signal)
    }
    signal.throwIfAborted()
    unreadable = failed
    return [...cache.values()].map(e => e.digest)
  }
  function refresh(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController(), next = { controller, users: 0 }
      // 取消不能撤销已提交的 rename；下一轮须等旧轮的提交和清理结束。
      const previous = flight?.promise.catch(() => {})
      next.promise = Promise.resolve(previous).then(() => run(controller.signal)).finally(() => { if (flight === next) flight = undefined })
      flight = next
    }
    const current = flight
    current.users++
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, value) => {
        if (settled) return
        settled = true; signal?.removeEventListener('abort', abort); current.users--
        if (current.users === 0) current.controller.abort()
        fn(value)
      }
      const abort = () => done(reject, signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      current.promise.then(value => done(resolve, value), error => done(reject, error))
    })
  }
  return { refresh, unreadable: () => unreadable }
}

/**
 * 读磁盘上的摘要，只取请求行。不刷新，给只需要大致统计的页面用（缓存寿命）。
 * @param {string} dir 摘要目录。
 * @returns {Promise<object[]>} 所有有效摘要的请求行；目录不存在时是空的。
 */
export async function readDigestRows(dir) {
  let names
  try { names = await readdir(dir) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  const rows = []
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    let entry
    try { entry = JSON.parse(await readFile(join(dir, name), 'utf8')) } catch (e) { if (e instanceof SyntaxError || e.code === 'ENOENT') continue; throw e }
    if (valid(entry)) rows.push(...entry.digest.rows)
  }
  return rows
}

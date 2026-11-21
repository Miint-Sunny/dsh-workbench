/**
 * 新会话卡片的宿主存档：`$DSH_HOME/dsh-workbench/session-cards.json`。只记两样会话日志里
 * 查不方便的东西：上一次选的模型（默认选项的规则要用），和从卡片开出来的会话挂在哪个会话、
 * 哪张卡下（宿主据此认出「新会话」：给它回报、不让它再提卡）。卡片本身和决定都在父会话的
 * 日志里，这份存档丢了只影响这两样。
 */
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readJsonConfig, registerJsonConfigRoute, writeJsonConfig } from './data-dir.js'
import { defaultOwnSessionPrefs, ownSessionPrefsOf } from './session-cards-state.js'

// 同一宿主内的行重载共用进行中的动作；只有父会话拒绝记账才需要留下回执。
const activeDeliveries = new Set()
const unwrittenReceipts = new Map()

/** 按 profile、父会话和卡片隔离。文件名不直接使用日志中的 ID。 */
export function askDelivery(dir, sessionId, cardId) {
  const filename = createHash('sha256').update(JSON.stringify([sessionId, cardId])).digest('hex') + '.json'
  const directory = join(dir, 'session-card-receipts')
  const file = join(directory, filename)
  return {
    claim() {
      if (activeDeliveries.has(file)) return false
      activeDeliveries.add(file)
      return true
    },
    release() { activeDeliveries.delete(file) },
    read() {
      if (unwrittenReceipts.has(file)) return unwrittenReceipts.get(file)
      let saved
      try {
        saved = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
      const record = saved?.record
      if (saved?.sessionId !== sessionId || record?.cardId !== cardId
        || (record.action !== 'here' && record.action !== 'start')
        || (record.action === 'start' && (typeof record.childId !== 'string' || !isRecord(record.options)))
        || (record.remember !== undefined && record.remember !== (record.action === 'start' ? 'always-new' : 'always-here'))
        || typeof saved.notSaved !== 'boolean') throw new Error('invalid session card delivery receipt')
      return saved
    },
    save(receipt) {
      // 即使存回执的磁盘也暂时不可写，本次宿主运行期间仍不能再次执行动作。
      unwrittenReceipts.set(file, receipt)
      writeJsonConfig(directory, filename, receipt)
      unwrittenReceipts.delete(file)
    },
    clear() {
      unwrittenReceipts.delete(file)
      try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    },
  }
}

/** 卡片 A 设置文件名（放在 `$DSH_HOME/dsh-workbench/` 下）。 */
export const SESSION_CARDS_PREFS_FILE = 'session-cards-prefs.json'
/** 卡片 A 设置的 GET/POST 路由。 */
export const SESSION_CARDS_PREFS_PATH = '/api/dsh-workbench.session-cards.prefs'

/** 最多记多少个开出来的会话，多了丢最早开的。 */
export const MAX_CHILDREN = 500

/** 空存档。 */
export function emptyCardsStore() {
  return { version: 1, lastModel: null, children: {} }
}

/** 普通对象。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读存档：形状不对的部分丢掉，不抛错（存档是文件边界，坏了按空的来）。
 * @param {unknown} value 文件里的 JSON。
 * @returns {{version: 1, lastModel: {provider: string, model: string} | null, children: Record<string, {parentId: string, cardId: string, title: string, startedAt: number}>}} 存档。
 */
export function parseCardsStore(value) {
  const store = emptyCardsStore()
  if (!isRecord(value)) return store
  const model = value.lastModel
  if (isRecord(model) && typeof model.provider === 'string' && typeof model.model === 'string') {
    store.lastModel = { provider: model.provider, model: model.model }
  }
  if (isRecord(value.children)) {
    for (const [id, link] of Object.entries(value.children)) {
      if (isRecord(link) && typeof link.parentId === 'string' && typeof link.cardId === 'string'
        && typeof link.title === 'string' && Number.isFinite(link.startedAt)) {
        store.children[id] = { parentId: link.parentId, cardId: link.cardId, title: link.title, startedAt: link.startedAt }
      }
    }
  }
  return store
}

/**
 * 记下一个开出来的会话，超过上限丢最早开的。
 * @param {object} store 存档。
 * @param {string} childId 新会话。
 * @param {{parentId: string, cardId: string, title: string, startedAt: number}} link 它挂在哪。
 * @returns {object} 新存档。
 */
export function withChild(store, childId, link) {
  const children = { ...store.children, [childId]: { ...link } }
  const ids = Object.keys(children)
  if (ids.length > MAX_CHILDREN) {
    ids.sort((a, b) => children[a].startedAt - children[b].startedAt)
    for (const id of ids.slice(0, ids.length - MAX_CHILDREN)) delete children[id]
  }
  return { ...store, children }
}

/**
 * 忘掉一个开出来的会话（开到一半失败的）。
 * @param {object} store 存档。
 * @param {string} childId 新会话。
 * @returns {object} 新存档；本来就没有时原样返回。
 */
export function withoutChild(store, childId) {
  if (!Object.hasOwn(store.children, childId)) return store
  const children = { ...store.children }
  delete children[childId]
  return { ...store, children }
}

/**
 * 文件存档：读一次，改了就整份原子替换。
 * @param {string} file 存档路径。
 * @returns {object} 存档接口。
 */
export function createCardsStore(file) {
  let store
  try {
    store = parseCardsStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    store = emptyCardsStore()
  }
  let pendingRemoval = false
  const save = (next) => {
    writeJsonConfig(dirname(file), basename(file), next)
    store = next
    pendingRemoval = false
  }
  return {
    /** 上一次选的模型；没有时 undefined。 */
    lastModel: () => store.lastModel ?? undefined,
    /** 记下这次选的模型。 */
    setLastModel(model) {
      save({ ...store, lastModel: { provider: model.provider, model: model.model } })
    },
    /** 这个会话是不是从卡片开出来的；是的话它挂在哪。 */
    linkOf: id => (Object.hasOwn(store.children, id) ? store.children[id] : undefined),
    /** 记下一个开出来的会话。 */
    addChild(childId, link) {
      save(withChild(store, childId, link))
    },
    /** 忘掉一个开到一半失败的会话。 */
    removeChild(childId) {
      const next = withoutChild(store, childId)
      if (next === store && !pendingRemoval) return
      // 这个会话已启动失败，立即停止识别和回报；写盘暂时失败时保留待删状态。
      store = next
      pendingRemoval = true
      save(next)
    },
  }
}

/**
 * 读卡片 A 的「模型提议另开会话时」设置（session-cards-prefs.json）；没有或坏了当 ask，不写回。
 * @param {string} dir 数据目录。
 * @returns {{ownSession: 'ask' | 'always-new' | 'always-here'}} 设置。
 */
export const readOwnSessionPrefs = dir => readJsonConfig(dir, SESSION_CARDS_PREFS_FILE, ownSessionPrefsOf, defaultOwnSessionPrefs)

/**
 * 原子写卡片 A 的设置（session-cards-prefs.json）。
 * @param {string} dir 数据目录。
 * @param {unknown} prefs 要写的设置。
 * @returns {void}
 */
export const writeOwnSessionPrefs = (dir, prefs) => writeJsonConfig(dir, SESSION_CARDS_PREFS_FILE, ownSessionPrefsOf(prefs))

/**
 * 注册卡片 A 设置的 GET/POST 路由：GET 回当前设置，POST 校验并保存。
 * @param {object} scope 带有 connection 服务的插件作用域（进来前已过鉴权）。
 * @param {object} [options] 注入项：dir 覆盖数据目录（测试用）。
 * @returns {() => void} 注销函数。
 */
export function applySessionCardsPrefsRoutes(scope, options = {}) {
  return registerJsonConfigRoute(scope, {
    path: SESSION_CARDS_PREFS_PATH,
    file: SESSION_CARDS_PREFS_FILE,
    parse: ownSessionPrefsOf,
    fallback: defaultOwnSessionPrefs,
    dir: options.dir,
  })
}

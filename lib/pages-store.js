/**
 * 网页发布（dsh-workbench/pages）的存储：`<数据目录>/pages/<页面 id>/meta.json` 加
 * `v<N>.html`。页面 id 是标题转的短 slug 加 4 位数字；.issued 里的空文件永久保留已经用过的 id。删除不真删，
 * 整个目录挪进 `pages/.trash/<id>-<删除时间>/`，30 天后清掉。
 *
 * meta 损坏（JSON 坏了或形状不对）时那个页面在 listPages 里列为「损坏」（corrupt: true），
 * 不影响别的页面，也不覆盖它，直到下一次对它加版本才重写。
 * 写入都走先写临时文件再改名；同一个 store 实例里的写排队（一条 promise 链），不并发写。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PagesError } from './pages-error.js'

/** 回收目录里页面保留的天数。 */
export const TRASH_MAX_AGE_DAYS = 30

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 页面 id 的合法字符（也是目录名安全字符）。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 标题转成短 slug：ASCII 字母数字留成一段一段、小写、连字符接起来，最长 24 个字符；
 * 一个可用字符都没有（纯中文、纯符号）就用 page。
 * @param {string} title 页面标题。
 * @returns {string} slug。
 */
export function slugOfTitle(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return slug === '' ? 'page' : slug
}

/**
 * 校验 meta 的形状（读回来和测试用）：id、标题、时间、来源和版本清单都齐。
 * @param {unknown} value 读出来的 JSON。
 * @returns {{ id: string, title: string, createdAt: number, updatedAt: number, source: { sessionId: string, path: string }, versions: { n: number, createdAt: number, size: number, assets: { scripts: number, styles: number, images: number } }[] }} meta；形状不对时抛错。
 */
export function parseMeta(value) {
  if (typeof value !== 'object' || value === null) throw new Error('pages meta is not an object')
  const { id, title, createdAt, updatedAt, source, versions } = value
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('pages meta id is invalid')
  if (typeof title !== 'string' || title === '') throw new Error('pages meta title is invalid')
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) throw new Error('pages meta timestamps are invalid')
  if (typeof source !== 'object' || source === null || typeof source.sessionId !== 'string' || typeof source.path !== 'string') {
    throw new Error('pages meta source is invalid')
  }
  if (!Array.isArray(versions) || versions.length === 0) throw new Error('pages meta versions are invalid')
  for (const version of versions) {
    if (typeof version !== 'object' || version === null) throw new Error('pages meta version is invalid')
    if (!Number.isSafeInteger(version.n) || version.n < 1) throw new Error('pages meta version n is invalid')
    if (!Number.isSafeInteger(version.createdAt)) throw new Error('pages meta version createdAt is invalid')
    if (!Number.isSafeInteger(version.size)) throw new Error('pages meta version size is invalid')
    const assets = version.assets
    if (typeof assets !== 'object' || assets === null
      || !Number.isSafeInteger(assets.scripts) || !Number.isSafeInteger(assets.styles) || !Number.isSafeInteger(assets.images)) {
      throw new Error('pages meta version assets are invalid')
    }
  }
  return value
}

/** 随机选择起点，轮流试完四位后缀，每个候选只试一次。 */
function chooseNumberedName(prefix, available) {
  const start = Math.floor(Math.random() * 9000)
  for (let offset = 0; offset < 9000; offset++) {
    const name = `${prefix}-${1000 + (start + offset) % 9000}`
    if (available(name)) return name
  }
}

/**
 * 建一个页面存储。
 * @param {string} dir 数据目录（一般是 `$DSH_HOME/dsh-workbench/pages`；测试给临时目录）。
 */
export function createPagesStore(dir) {
  const issuedDir = join(dir, '.issued')
  const trashDir = join(dir, '.trash')
  let indexedTrash = false

  // wx 同时防止两个宿主分配同一个 id。标记只含编号，不保留页面正文或标题元数据。
  const reserveId = (id) => {
    try {
      writeFileSync(join(issuedDir, id), '', { flag: 'wx' })
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
  }

  // 旧库没有编号记录。第一次分配或清回收目录之前，先把旧回收目录里的编号记下来。
  const indexTrash = () => {
    if (indexedTrash) return
    mkdirSync(issuedDir, { recursive: true })
    let names
    try {
      names = readdirSync(trashDir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      names = []
    }
    for (const name of names) {
      // 回收目录可叫 id、id-删除时间，重名时后面再加四位数字。meta 坏了也要保留可能的编号。
      const candidates = [name, name.replace(/-\d+$/, ''), name.replace(/-\d+-\d{4}$/, '')]
        .filter(id => ID_PATTERN.test(id) && /-\d{4}$/.test(id))
      if (candidates.length === 0) continue
      let metaId
      try { metaId = JSON.parse(readFileSync(join(trashDir, name, 'meta.json'), 'utf8')).id } catch {}
      for (const id of candidates.includes(metaId) ? [metaId] : new Set(candidates)) reserveId(id)
    }
    indexedTrash = true
  }

  /** 写操作排队：一条 promise 链，同一个 store 里不并发写。 */
  let tail = Promise.resolve()
  const enqueue = (job) => {
    const next = tail.then(job, job)
    tail = next.catch(() => {})
    return next
  }

  /**
   * 原子写：先写临时文件再改名。
   * @param {string} path 目标文件。
   * @param {string} text 内容。
   */
  const writeAtomic = (path, text) => {
    const temp = `${path}.tmp`
    writeFileSync(temp, text)
    renameSync(temp, path)
  }

  /**
   * 读一个页面的 meta；目录不在、meta 坏了都返回 undefined（listPages 另有损坏标记）。
   * @param {string} id 页面 id。
   * @returns {{ meta?: object, corrupt?: boolean }} meta 或损坏标记。
   */
  const readMeta = (id) => {
    const metaPath = join(dir, id, 'meta.json')
    let raw
    try {
      raw = readFileSync(metaPath, 'utf8')
    } catch {
      return {}
    }
    try {
      return { meta: parseMeta(JSON.parse(raw)) }
    } catch {
      return { corrupt: true }
    }
  }

  /**
   * 新建页面（第 1 版）。随机选起点，最多探完同一 slug 的全部四位后缀。
   * @param {{ title: string, sessionId: string, path: string, html: string, assets: { scripts: number, styles: number, images: number }, now?: number }} input 新页面。
   * @returns {Promise<{ meta: object }>} 建好的 meta（第 1 版）。
   */
  const createPage = ({ title, sessionId, path, html, assets, sourceRevision, now = Date.now() }) => enqueue(() => {
    const base = slugOfTitle(title)
    indexTrash()
    const id = chooseNumberedName(base, candidate => !existsSync(join(dir, candidate)) && reserveId(candidate))
    if (id === undefined) throw new PagesError('page-ids-exhausted', `页面编号前缀 ${base} 的四位编号已用完。请改用含有其他英文字母或数字的标题。`)
    mkdirSync(join(dir, id))
    writeAtomic(join(dir, id, 'v1.html'), html)
    const meta = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      source: { sessionId, path },
      versions: [{ n: 1, createdAt: now, size: Buffer.byteLength(html), assets, ...(sourceRevision ? { sourceRevision } : {}) }],
    }
    writeAtomic(join(dir, id, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    return { meta }
  })

  /**
   * 给已有页面加一版（n 递增），来源跟着换成这次发布的文件；给了 title 也一并更新（发布是改标题
   * 的唯一入口）。页面不存在、meta 坏了、id 不合法时抛错。
   * @param {string} id 页面 id。
   * @param {{ sessionId: string, path: string, html: string, assets: { scripts: number, styles: number, images: number }, title?: string, now?: number }} input 这一版。
   * @returns {Promise<{ meta: object }>} 加完的 meta。
   */
  const addVersion = (id, { sessionId, path, html, assets, title, sourceRevision, now = Date.now() }) => enqueue(() => {
    if (!ID_PATTERN.test(id)) throw new Error(`页面 id 不合法：${id}`)
    const { meta, corrupt } = readMeta(id)
    if (corrupt === true) throw new Error(`页面 ${id} 的 meta.json 损坏，不能加版；先删除它再重新发布。`)
    if (meta === undefined) throw new Error(`页面 ${id} 不存在。`)
    const n = (meta.versions[meta.versions.length - 1]?.n ?? 0) + 1
    writeAtomic(join(dir, id, `v${n}.html`), html)
    meta.source = { sessionId, path }
    if (title !== undefined && title !== '') meta.title = title
    meta.versions.push({ n, createdAt: now, size: Buffer.byteLength(html), assets, ...(sourceRevision ? { sourceRevision } : {}) })
    meta.updatedAt = now
    writeAtomic(join(dir, id, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    return { meta }
  })

  /**
   * 全部页面，最近更新在前；meta 坏了的排在最后、带 corrupt: true（目录的修改时间当更新时间）。
   * @returns {{ pages: ({ id: string, corrupt: true, updatedAt: number } | ({ id: string, corrupt?: false, dir: string } & object))[] }} 页面条目（好的带完整 meta 和目录绝对路径 dir）。
   */
  const listPages = () => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return { pages: [] }
    }
    const pages = []
    for (const name of names) {
      if (name === '.trash' || name.startsWith('.')) continue
      try {
        if (!statSync(join(dir, name)).isDirectory()) continue
      } catch {
        continue
      }
      const { meta, corrupt } = readMeta(name)
      if (meta !== undefined) pages.push({ ...meta, corrupt: false, dir: join(dir, name) })
      else if (corrupt === true) {
        let updatedAt = 0
        try {
          updatedAt = statSync(join(dir, name)).mtimeMs
        } catch { /* 目录同时被删掉就按 0 */ }
        pages.push({ id: name, corrupt: true, updatedAt })
      }
    }
    // 损坏的页面恒排最后：时间读不出来（meta 坏了），也不挡正常的页面。
    pages.sort((a, b) => ((a.corrupt === true ? 1 : 0) - (b.corrupt === true ? 1 : 0)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return { pages }
  }

  /**
   * 读某一版的 HTML。
   * @param {string} id 页面 id。
   * @param {number} n 版本号。
   * @returns {{ html: string, meta: object } | undefined} 内容和 meta；页面或版本不存在时 undefined。
   */
  const readVersion = (id, n) => {
    if (!ID_PATTERN.test(id) || !Number.isSafeInteger(n) || n < 1) return undefined
    const { meta } = readMeta(id)
    if (meta === undefined) return undefined
    try {
      return { html: readFileSync(join(dir, id, `v${n}.html`), 'utf8'), meta }
    } catch {
      return undefined
    }
  }

  /**
   * 删除页面：整个目录挪进回收目录 `.trash/<id>-<删除时间>/`，不真删；挪完顺手清一次过期的。
   * @param {string} id 页面 id。
   * @param {{ now?: number }} [options] 时间（测试注入）。
   * @returns {boolean} 删掉了；页面不存在时 false。
   */
  const deletePage = (id, { now = Date.now() } = {}) => {
    if (!ID_PATTERN.test(id)) return false
    const from = join(dir, id)
    try {
      statSync(from)
    } catch {
      return false
    }
    indexTrash()
    reserveId(id) // 旧版创建的在用页面可能还没有标记。
    mkdirSync(trashDir, { recursive: true })
    let name = `${id}-${now}`
    if (existsSync(join(trashDir, name))) {
      name = chooseNumberedName(name, candidate => !existsSync(join(trashDir, candidate)))
      if (name === undefined) throw new PagesError('trash-ids-exhausted', `页面 ${id} 在这次删除时间下的回收记录已满，请重试删除。`)
    }
    renameSync(from, join(trashDir, name))
    purgeTrash({ now })
    return true
  }

  /**
   * 从回收目录恢复页面（按 meta.id 核实归属，候选里挑名字最大的那个挪回去）。
   * 页面已存在同名目录时抛错。
   * @param {string} id 页面 id。
   * @returns {boolean} 恢复了；回收目录里没有它时 false。
   */
  const restorePage = (id) => {
    if (!ID_PATTERN.test(id)) return false
    let names
    try {
      names = readdirSync(trashDir)
    } catch {
      return false
    }
    const hits = names.filter(name => {
      if (name !== id && !name.startsWith(`${id}-`)) return false
      try {
        return parseMeta(JSON.parse(readFileSync(join(trashDir, name, 'meta.json'), 'utf8'))).id === id
      } catch {
        return false
      }
    }).sort()
    if (hits.length === 0) return false
    if (existsSync(join(dir, id))) throw new Error(`页面 ${id} 已存在，不能恢复成同一个 id`)
    renameSync(join(trashDir, hits[hits.length - 1]), join(dir, id))
    return true
  }

  /**
   * 清回收目录里超过 maxAgeDays 的页面（默认 30 天）。删除时间按回收目录名里带的毫秒数算
   * （`<id>-<删除时间>`，重名冲突时后面多一段数字）；名字解析不出来的按目录修改时间兜底。
   * @param {{ maxAgeDays?: number, now?: number }} [options] 天数和时间（测试注入）。
   * @returns {number} 清掉的目录数。
   */
  const purgeTrash = ({ maxAgeDays = TRASH_MAX_AGE_DAYS, now = Date.now() } = {}) => {
    let names
    try {
      names = readdirSync(trashDir)
    } catch {
      return 0
    }
    indexTrash()
    let removed = 0
    for (const name of names) {
      const path = join(trashDir, name)
      const named = /-(\d+)(?:-\d{4})?$/.exec(name)
      let deletedAt
      try {
        deletedAt = named === null ? statSync(path).mtimeMs : Number(named[1])
      } catch {
        continue
      }
      if (now - deletedAt <= maxAgeDays * DAY_MS) continue
      try {
        rmSync(path, { recursive: true, force: true })
        removed += 1
      } catch {
        // 删不掉留着下一轮；清回收是尽力而为。
      }
    }
    return removed
  }

  return { createPage, addVersion, listPages, readVersion, deletePage, restorePage, purgeTrash, dir }
}

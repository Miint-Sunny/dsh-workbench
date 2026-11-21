/**
 * 检查点（dsh-workbench/checkpoints）的磁盘存储，布局照接口文档「存储」一节：
 * `数据目录/checkpoints/<会话 id>/` 下 meta.json、checkpoints.jsonl、objects/、restore.json
 * （files 种类再加 captures/，第二步接上）；归档时间记在 `checkpoints/archived.json`。
 *
 * 所有整文件写都是先写临时文件再改名；追加用 appendFile（一行一条完整的 JSON）；同一个
 * 会话的写排成一条 promise 链，不并发。坏的 jsonl 行跳过并回调一次 onCorrupt，不让整个
 * 会话读不出来。本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeRelative } from './checkpoints-files.js'

/**
 * 一条检查点记录（checkpoints.jsonl 的一行）。git 种类带 tree；files 种类带 captures
 * （相对工作目录的路径 → { kind, sha1?, mode? }）和这一条自己的 root（恢复按条目自己的
 * 走，不被后来轮次的 meta 改写；旧记录没有 root，读的时候回落到 meta）。
 * @typedef {Object} CheckpointEntry
 * @property {number} turn 轮次号（turn/start 的 data.turn）。
 * @property {number} seq turn/start 事件的序号。
 * @property {number} time 存下时的毫秒时间戳。
 * @property {'git' | 'files'} kind 存法：git 仓库的树，或文件工具改过的文件副本。
 * @property {string} [root] 这一条自己的恢复范围根目录（绝对路径）。
 * @property {string} [tree] git 种类：tree 对象 id。
 * @property {Record<string, { kind: string, sha1: string }>} [captures] files 种类：路径到捕获。
 */

/** 一个 files 种类的捕获是不是合法：file 带 40 位 SHA-1 和权限位，absent、oversized 不带内容。 */
const isCapture = capture => typeof capture === 'object' && capture !== null
  && (capture.kind === 'absent' || capture.kind === 'oversized'
    || (capture.kind === 'file' && typeof capture.sha1 === 'string' && /^[0-9a-f]{40}$/.test(capture.sha1)
      && Number.isSafeInteger(capture.mode)))

/** 路径 → 捕获的表是不是合法（路径要是工作目录里的安全相对路径，坏记录不能把恢复写到外面）。 */
const isCaptures = captures => typeof captures === 'object' && captures !== null && !Array.isArray(captures)
  && Object.entries(captures).every(([path, capture]) => safeRelative(path) && isCapture(capture))

/** jsonl 一行是不是一条合法的检查点记录。 */
function isEntry(value) {
  if (typeof value !== 'object' || value === null) return false
  if (!Number.isSafeInteger(value.turn) || !Number.isSafeInteger(value.seq) || !Number.isSafeInteger(value.time)) return false
  if (value.root !== undefined && typeof value.root !== 'string') return false
  if (value.kind === 'git') return typeof value.tree === 'string' && value.tree !== ''
  if (value.kind === 'files') return isCaptures(value.captures)
  return false
}

/**
 * restore.json 的形状核对：git 种类带 tree，files 种类带 captures；带 kind / root /
 * afterTree / afterCaptures（撤销的过期判断用，第 40 件 #1）的是新写法，旧记录没有这些
 * 字段也照常能撤销（没有核对依据就不核）。
 */
function isRestore(value) {
  return typeof value === 'object' && value !== null
    && Number.isSafeInteger(value.time) && Number.isSafeInteger(value.turn)
    && ((typeof value.tree === 'string' && value.tree !== '') || isCaptures(value.captures))
    && (value.kind === undefined || value.kind === 'git' || value.kind === 'files')
    && (value.root === undefined || typeof value.root === 'string')
    && (value.afterTree === undefined || typeof value.afterTree === 'string')
    && (value.afterCaptures === undefined || isCaptures(value.afterCaptures))
}

/**
 * 建一个检查点存取器。
 * @param {string} root 检查点根目录（`$DSH_HOME/dsh-workbench/checkpoints`；测试给临时目录）。
 * @returns 访问器：目录路径、meta / jsonl / restore / archived 的读写、会话目录的删和列。
 */
export function createCheckpointsStore(root) {
  const sessionDir = sessionId => join(root, sessionId)

  /** 同一个会话的写排成一条链：读、算、写之间不插进同一个会话的别的写。 */
  const chains = new Map()
  const queued = (sessionId, task) => {
    const run = () => task()
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(run, run)
    chains.set(sessionId, next.catch(() => {}))
    return next
  }

  /** 先写临时文件再改名的整文件写。 */
  const atomicWrite = async (file, text) => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  }

  return {
    /** 根目录。 */
    root,
    /** 一个会话的目录。 */
    sessionDir,

    /**
     * 写一个会话的 meta.json（先写临时文件再改名，排队）。
     * @param {string} sessionId 会话 ID。
     * @param {{ cwd: string, root: string, kind: 'git' | 'files', full?: boolean }} meta 会话元数据。
     */
    writeMeta(sessionId, meta) {
      return queued(sessionId, () => atomicWrite(join(sessionDir(sessionId), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`))
    },

    /**
     * 读一个会话的 meta.json。
     * @param {string} sessionId 会话 ID。
     * @returns {Promise<{ cwd: string, root: string, kind: string, full?: boolean } | undefined>} 元数据；文件不存在或损坏时 undefined。
     */
    async readMeta(sessionId) {
      let raw
      try {
        raw = await readFile(join(sessionDir(sessionId), 'meta.json'), 'utf8')
      } catch {
        return undefined
      }
      try {
        const meta = JSON.parse(raw)
        if (typeof meta !== 'object' || meta === null) return undefined
        if (typeof meta.cwd !== 'string' || typeof meta.root !== 'string') return undefined
        if (meta.kind !== 'git' && meta.kind !== 'files') return undefined
        return meta
      } catch {
        // JSON 坏了当没有这份 meta：checkpoints.jsonl 还在，恢复按条目走。
        return undefined
      }
    },

    /**
     * 往 checkpoints.jsonl 追加一条记录（排队；一行一条完整 JSON，appendFile 原子性够用）。
     * @param {string} sessionId 会话 ID。
     * @param {CheckpointEntry} entry 记录。
     */
    appendEntry(sessionId, entry) {
      return queued(sessionId, async () => {
        await mkdir(sessionDir(sessionId), { recursive: true })
        await appendFile(join(sessionDir(sessionId), 'checkpoints.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
      })
    },

    /**
     * 读一个会话的全部检查点：按 turn 升序；同一个 turn 的 files 记录合起来（开头一条空的、
     * 之后每碰一个文件一条增量，合并成整张捕获表，同路径取最后那次——不然 jsonl 会每个文件
     * 重复整张表，第 40 件 #15），git 记录取最后一条（重开的轮次以最新的为准）。坏行跳过，
     * 每行回调一次 onCorrupt。
     * @param {string} sessionId 会话 ID。
     * @param {(line: string) => void} [onCorrupt] 坏行的回调（整行原文）。
     * @returns {Promise<CheckpointEntry[]>} 排好序的记录。
     */
    async readEntries(sessionId, onCorrupt) {
      let raw
      try {
        raw = await readFile(join(sessionDir(sessionId), 'checkpoints.jsonl'), 'utf8')
      } catch {
        return []
      }
      const byTurn = new Map()
      for (const line of raw.split('\n')) {
        if (line === '') continue
        let value
        try {
          value = JSON.parse(line)
        } catch {
          onCorrupt?.(line)
          continue
        }
        if (!isEntry(value)) {
          onCorrupt?.(line)
          continue
        }
        const previous = byTurn.get(value.turn)
        if (previous !== undefined && value.kind === 'files' && previous.kind === 'files') {
          byTurn.set(value.turn, { ...value, captures: { ...previous.captures, ...value.captures } })
        } else {
          byTurn.set(value.turn, value)
        }
      }
      return [...byTurn.entries()].sort((left, right) => left[0] - right[0]).map(([, entry]) => entry)
    },

    /**
     * 写一个会话的 restore.json（最近一次恢复的撤销点，先写临时文件再改名，排队）。
     * @param {string} sessionId 会话 ID。
     * @param {{ time: number, turn: number, tree?: string, captures?: Record<string, object> }} restore 撤销点：git 种类带 tree，files 种类带 captures。
     */
    writeRestore(sessionId, restore) {
      return queued(sessionId, () => atomicWrite(join(sessionDir(sessionId), 'restore.json'), `${JSON.stringify(restore, null, 2)}\n`))
    },

    /**
     * 读一个会话的 restore.json。
     * @param {string} sessionId 会话 ID。
     * @returns {Promise<{ time: number, turn: number, tree?: string, captures?: Record<string, object> } | undefined>} 撤销点；没有或损坏时 undefined。
     */
    async readRestore(sessionId) {
      let raw
      try {
        raw = await readFile(join(sessionDir(sessionId), 'restore.json'), 'utf8')
      } catch {
        return undefined
      }
      try {
        const restore = JSON.parse(raw)
        return isRestore(restore) ? restore : undefined
      } catch {
        return undefined
      }
    },

    /**
     * 删一个会话的 restore.json（撤销成功后调用）。
     * @param {string} sessionId 会话 ID。
     */
    clearRestore(sessionId) {
      return queued(sessionId, async () => {
        await rm(join(sessionDir(sessionId), 'restore.json'), { force: true })
      })
    },

    /**
     * 列出根目录下有检查点目录的会话 ID（archived.json 不是目录，不算；点开头的目录是根
     * 目录里的非会话目录，比如运行器的 `.no-hooks`，不算——清理按这份列表删「会话不在了」的目录）。
     * @returns {Promise<string[]>} 会话 ID。
     */
    async listSessionIds() {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        // 根目录不存在：还没有任何检查点。
        return []
      }
      return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
    },

    /**
     * 整个删掉一个会话的检查点目录（清理用；archived 记录由调用方维护）。
     * @param {string} sessionId 会话 ID。
     */
    async removeSession(sessionId) {
      await rm(sessionDir(sessionId), { recursive: true, force: true })
    },

    /**
     * 读 archived.json（会话 id → 归档时的毫秒时间戳）。
     * @returns {Promise<Record<string, number>>} 归档记录；文件不存在或损坏时空对象。
     */
    async readArchived() {
      let raw
      try {
        raw = await readFile(join(root, 'archived.json'), 'utf8')
      } catch {
        return {}
      }
      try {
        const value = JSON.parse(raw)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
        const archived = {}
        for (const [id, time] of Object.entries(value)) {
          if (typeof id === 'string' && Number.isSafeInteger(time)) archived[id] = time
        }
        return archived
      } catch {
        // 坏了当没有记录：归档时间会从下一次 domain/changed 重新记。
        return {}
      }
    },

    /**
     * 写 archived.json（先写临时文件再改名）。
     * @param {Record<string, number>} archived 会话 id → 归档时的毫秒时间戳。
     */
    writeArchived(archived) {
      return atomicWrite(join(root, 'archived.json'), `${JSON.stringify(archived, null, 2)}\n`)
    },

    /** 一个会话 files 种类的副本目录。 */
    capturesDir: sessionId => join(sessionDir(sessionId), 'captures'),

    /**
     * 会话目录的修改时间（清理的过期判断用；目录里创建新条目会刷新它）。
     * @param {string} sessionId 会话 ID。
     * @returns {Promise<number | undefined>} 毫秒时间戳；目录不存在时 undefined。
     */
    async sessionMtime(sessionId) {
      try {
        return Math.floor((await stat(sessionDir(sessionId))).mtimeMs)
      } catch {
        return undefined
      }
    },

    /**
     * 算一个会话检查点占用的总大小：整个会话目录（objects/、captures/、jsonl、meta、
     * restore 都算，第 40 件 #15——jsonl 不算的话 files 种类翻倍增长不占上限）。
     * @param {string} sessionId 会话 ID。
     * @returns {Promise<number>} 字节数；目录不存在时 0。
     */
    async sizeBytes(sessionId) {
      let total = 0
      const walk = async dir => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) await walk(path)
          else if (entry.isFile()) total += (await stat(path)).size
        }
      }
      await walk(sessionDir(sessionId))
      return total
    },
  }
}

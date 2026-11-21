/** 回退记录的存取：每条记录一个 JSON 文件，放在插件数据目录（默认 $DSH_HOME/dsh-workbench/review/，见 index.js）下，按会话分目录。记录文件里存回退前后文件的完整内容，「撤销回退」靠它；记录按天数清理（prune），DSH 重启不影响。 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 记录里一份文件状态：文件（内容原样）或不在。
 * @typedef {{ kind: 'file', text: string } | { kind: 'absent' }} FileState
 */

/**
 * 一个改动处（hunk），撤销「回退这一处」时正向应用用。字段同 DSH workspace-changes 的差异。
 * @typedef {Object} RevertHunk
 * @property {number} oldStart 开始前的 1 起行号。
 * @property {number} oldLines 开始前一侧的行数。
 * @property {number} newStart 结束时的 1 起行号。
 * @property {number} newLines 结束时一侧的行数。
 * @property {string[]} lines 每行带 `+`、`-` 或空格前缀。
 */

/**
 * 一条回退记录，按坐标存在 `数据目录/<会话>/<序号>.<文件下标>[.<改动处下标>].json`。
 * @typedef {Object} RevertRecord
 * @property {'revert'} kind 记录种类，读回时核对。
 * @property {string} sessionId 会话 ID。
 * @property {number} seq 改动事件的序号。
 * @property {number} fileIndex 文件在改动摘要里的下标。
 * @property {number | null} hunkIndex 改动处下标；null 表示整个文件。
 * @property {string} path 文件的绝对路径（按改动摘要解析好的）。
 * @property {string} display 文件的显示路径。
 * @property {string} description 指代这处回退的说法（「第 3–7 行这一处」或「整个文件」）。
 * @property {FileState} before 回退前的文件状态。
 * @property {FileState} after 回退后的文件状态（整个文件的撤销回退先核对现在还是它）。
 * @property {RevertHunk} [hunk] 一处的回退才带：改动处本身，撤销时正向应用。
 * @property {number} [appliedAt] 一处的回退才带：回退时应用到的 0 起位置，撤销时当定位线索。
 * @property {number} savedAt 存下时的时间戳（毫秒），按天数清理用；由 save 盖上。
 */

/** 记录是否是合法的文件状态。 */
const isFileState = (state) =>
  typeof state === 'object' && state !== null
  && (state.kind === 'absent' || (state.kind === 'file' && typeof state.text === 'string'))

/** 改动处是否是撤销「回退这一处」要用的完整样子。 */
const isHunk = (hunk) =>
  typeof hunk === 'object' && hunk !== null
  && Number.isSafeInteger(hunk.oldStart) && Number.isSafeInteger(hunk.newStart)
  && Array.isArray(hunk.lines) && hunk.lines.every((line) => typeof line === 'string')

/** 读一个记录文件并核对形状；坐标和路径来源见 fileOf。 */
async function readRecord(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const record = JSON.parse(raw)
    const shaped = record.kind === 'revert' && typeof record.sessionId === 'string'
      && Number.isSafeInteger(record.seq) && Number.isSafeInteger(record.fileIndex)
      && (record.hunkIndex === null || Number.isSafeInteger(record.hunkIndex))
      && typeof record.path === 'string' && typeof record.display === 'string' && typeof record.description === 'string'
      && isFileState(record.before) && isFileState(record.after)
      && Number.isSafeInteger(record.savedAt)
      && (record.hunkIndex === null ? record.hunk === undefined : isHunk(record.hunk))
    return shaped ? record : undefined
  } catch {
    // JSON 坏了按没有这条记录处理：记录是插件自己的数据，坏到解析不了只能放弃这条回退的撤销。
    return undefined
  }
}

/**
 * 建一个回退记录存取器。
 * @param {string} root 记录目录（插件数据目录，如 $DSH_HOME/dsh-workbench/review）。
 * @param {{ clock?: () => number }} [options] clock 供 save 盖时间戳，测试注入固定的。
 * @returns 记录存取器：save / load / remove / list / prune，都返回 Promise。
 */
export function createRevertStore(root, { clock = Date.now } = {}) {
  const fileOf = ({ sessionId, seq, fileIndex, hunkIndex }) =>
    join(root, sessionId, `${seq}.${fileIndex}${hunkIndex === null ? '' : `.${hunkIndex}`}.json`)
  return {
    /**
     * 存一条记录：先写临时文件再改名，读到一半的读者看到的总是完整的旧记录或新记录；savedAt 由这里盖上。
     * @param {RevertRecord} record 要存的记录（不含 savedAt）。
     */
    async save(record) {
      const file = fileOf(record)
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      await writeFile(temp, `${JSON.stringify({ ...record, savedAt: clock() }, null, 2)}\n`, 'utf8')
      await rename(temp, file)
    },
    /**
     * 按坐标读一条记录。
     * @param {{ sessionId: string, seq: number, fileIndex: number, hunkIndex: number | null }} coord 回退时的坐标。
     * @returns {Promise<RevertRecord | undefined>} 记录；坐标没有记录、或文件损坏不是合法记录时是 undefined。
     */
    async load(coord) {
      return readRecord(fileOf(coord))
    },
    /**
     * 列一个会话某一轮已经回退的坐标，页面重新打开后照它显示「已回退」和「撤销回退」。
     * @param {string} sessionId 会话 ID。
     * @param {number} seq 改动事件的序号。
     * @returns {Promise<{ fileIndex: number, hunkIndex: number | null, display: string, description: string }[]>} 按文件下标、改动处下标排好（整文件在同文件的一处前面）。
     */
    async list(sessionId, seq) {
      let entries
      try {
        entries = await readdir(join(root, sessionId))
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
      const reverts = []
      for (const name of entries) {
        const match = /^(\d+)\.(\d+)(?:\.(\d+))?\.json$/.exec(name)
        if (match === null || Number(match[1]) !== seq) continue
        const coord = {
          sessionId, seq,
          fileIndex: Number(match[2]),
          hunkIndex: match[3] === undefined ? null : Number(match[3]),
        }
        const record = await readRecord(fileOf(coord))
        // 坏记录跳过，不挡着别的坐标。
        if (record !== undefined) reverts.push({ fileIndex: coord.fileIndex, hunkIndex: coord.hunkIndex, display: record.display, description: record.description })
      }
      return reverts.sort((left, right) =>
        left.fileIndex - right.fileIndex || (left.hunkIndex ?? -1) - (right.hunkIndex ?? -1))
    },
    /**
     * 删一条记录（撤销回退成功后调用）。
     * @param {{ sessionId: string, seq: number, fileIndex: number, hunkIndex: number | null }} coord 回退时的坐标。
     */
    async remove(coord) {
      await rm(fileOf(coord), { force: true })
    },
    /**
     * 按天数清理：删掉 savedAt 早于截止时间的记录；解析不了的也删（清理就是收这些垃圾的地方）。
     * 尽力而为不抛错：一条删不掉不影响其余的。
     * @param {number} cutoffMs 截止时间戳（毫秒），比它早的删。
     */
    async prune(cutoffMs) {
      let sessions
      try {
        sessions = await readdir(root)
      } catch {
        // 记录目录不存在或读不了（比如权限），这轮清理放弃，明天再来。
        return
      }
      for (const sessionId of sessions) {
        let entries
        try {
          entries = await readdir(join(root, sessionId))
        } catch {
          // 单个会话目录读不了就跳过它，不挡着其余的。
          continue
        }
        for (const name of entries) {
          if (!name.endsWith('.json')) continue
          const file = join(root, sessionId, name)
          try {
            const record = await readRecord(file)
            if (record === undefined || record.savedAt < cutoffMs) await rm(file, { force: true })
          } catch {
            // 这一条读不了或删不了就留着，下一轮清理再看它。
          }
        }
      }
    },
  }
}

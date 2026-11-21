/** 改动审阅的宿主服务：核对坐标，按 DSH 的改动记录反向应用，写回文件，留回退记录，撤销回退。所有原因都用能直接显示给用户的文字返回；会话运行中一律拒绝，免得和正在改同一文件的模型互相踩。 */

import { lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { canonicalPath } from '../checkpoints-git.js'
import { linesToText, textToLines } from './lines.js'
import { forwardHunk, reverseHunk, reverseHunks } from './revert.js'
import { describeRevert, hunkRange, revertConflictMessage, runningMessage } from './copy.js'

// All review services and sessions share a queue for the normalized file target.
const fileQueues = new Map()
async function serialPath(path, operation) {
  const normalized = resolve(path)
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const task = (fileQueues.get(key) ?? Promise.resolve()).then(operation)
  const settled = task.catch(() => {})
  fileQueues.set(key, settled)
  try { return await task } finally { if (fileQueues.get(key) === settled) fileQueues.delete(key) }
}

/** 记录的目标必须仍是原来的规范路径；缺失目标允许恢复，链接不能代替目标或父目录。 */
async function checkPath(path) {
  if (await canonicalPath(dirname(path)) !== dirname(path)) throw new Error('review path changed')
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) throw new Error('review path changed')
    if (!entry.isFile()) throw new Error('review target is not a regular file')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** 默认文件操作不跟随链接；原子替换保留已捕获权限。 */
const defaultIo = () => ({
  readFile: async (path) => {
    await checkPath(path)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) throw new Error('review target is not a regular file')
      return await file.readFile('utf8')
    } finally { await file.close() }
  },
  writeFile: async (path, text, mode) => {
    await checkPath(path)
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.dwb-review-${randomUUID()}`
    try {
      await writeFile(temp, text, { encoding: 'utf8', mode, flag: 'wx' })
      await checkPath(path)
      await rename(temp, path)
    } finally { await rm(temp, { force: true }) }
  },
  modeOf: async (path) => {
    try {
      return (await stat(path)).mode & 0o777
    } catch {
      return undefined
    }
  },
  deleteFile: async (path) => { await checkPath(path); await rm(path, { force: true }) },
})

/** 读文件现在的状态：不在也算一种状态。在的带上权限位（撤销回退要照原样恢复）。 */
async function readState(io, path) {
  try {
    const [text, mode] = await Promise.all([io.readFile(path), io.modeOf(path)])
    return { kind: 'file', text, mode }
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
}

/** 把一种文件状态写回去：不在就删掉文件；带着记录里的权限位新建（比如撤销对新建文件的回退，恢复模型建文件时的 0600）。 */
async function writeState(io, path, state) {
  if (state.kind === 'absent') await io.deleteFile(path)
  else await io.writeFile(path, state.text, state.mode)
}

/** 两种文件状态是否一致（撤销回退前核对用）。 */
const sameState = (left, right) =>
  left.kind === right.kind && (left.kind === 'absent' || left.text === right.text)

/**
 * 建改动审阅服务。
 * @param {object} deps 依赖，测试注入假的。
 * @param {{ summary(sessionId: string, seq: number): object | undefined, diff(sessionId: string, seq: number, index: number, signal?: AbortSignal): Promise<object | undefined> }} deps.changes DSH 的改动记录服务（ctx.workspaceChanges）。
 * @param {(sessionId: string) => boolean} deps.isRunning 会话是否正在运行一轮。
 * @param {ReturnType<typeof import('./store.js').createRevertStore>} deps.store 回退记录存取器。
 * @param {object} [deps.io] 文件读写，默认用宿主文件系统。
 * @param {(cwd: string, path: string) => string | Promise<string>} [deps.resolvePath] 从改动摘要解析文件绝对路径，默认先规范工作目录。
 * @returns {{ revert(coord: object, signal?: AbortSignal): Promise<object>, undo(coord: object): Promise<object>, state(coord: object): Promise<object> }} 服务；revert/undo 成功返回 { ok: true, display, description }，失败返回 { ok: false, status, reason, message }；state 返回 { ok: true, reverts }。
 */
export function createReviewService({ changes, isRunning, store, io = defaultIo(), resolvePath = async (cwd, path) => resolve(await realpath(cwd), path) }) {
  const fail = (status, reason, message) => ({ ok: false, status, reason, message })

  return {
    /**
     * 回退一处改动或整个文件：核对改动记录和文件现状，反向应用，写回，留回退记录。
     * @param {{ sessionId: string, seq: number, fileIndex: number, hunkIndex: number | null }} coord 坐标；hunkIndex 为 null 是整个文件。
     * @param {AbortSignal} [signal] 取消信号，透传给改动记录服务。
     */
    async revert({ sessionId, seq, fileIndex, hunkIndex }, signal) {
      if (isRunning(sessionId)) return fail(409, 'running', runningMessage('revert'))
      const summary = changes.summary(sessionId, seq)
      if (summary === undefined) {
        return fail(404, 'summary-gone', '本轮改动已不可用：DSH 重启后，无法再查看或回退重启前各轮的改动。')
      }
      const file = summary.files[fileIndex]
      if (file === undefined) return fail(404, 'file-index', '文件下标超出本轮改动的范围。')
      let diff
      try {
        diff = await changes.diff(sessionId, seq, fileIndex, signal)
      } catch (error) {
        return fail(500, 'read-failed', `读取本轮改动失败：${error?.message ?? error}`)
      }
      if (diff === undefined) {
        return fail(404, 'summary-gone', '本轮改动已不可用：DSH 重启后，无法再查看或回退重启前各轮的改动。')
      }
      if (diff.kind !== 'text') {
        return diff.kind === 'binary'
          ? fail(409, 'binary', '二进制文件，无法显示改动或回退。')
          : fail(409, 'oversized', '文件超过大小上限，无法显示改动或回退。')
      }
      const hunk = hunkIndex === null ? null : diff.hunks[hunkIndex] ?? null
      if (hunkIndex !== null && hunk === null) return fail(404, 'hunk-index', '改动处下标超出该文件的范围。')
      const path = await resolvePath(summary.cwd, file.path)
      return serialPath(path, async () => {
        if (isRunning(sessionId)) return fail(409, 'running', runningMessage('revert'))
        let current
        try {
          current = await readState(io, path)
        } catch (error) {
          return fail(500, 'read-failed', `读取 ${file.display} 失败：${error?.message ?? error}`)
        }
        const currentLines = current.kind === 'file' ? textToLines(current.text) : []
        const whole = hunk === null
        let target
        let appliedAt
        if (whole && !diff.after) {
          // 这一轮删掉了这个文件：现在必须也不在才对得上，回退就是把这一轮开始前的内容写回去。
          if (current.kind !== 'absent') return fail(409, 'conflict', revertConflictMessage(file.display, true))
          const restored = reverseHunks([], diff.hunks)
          if (!restored.ok) return fail(409, 'conflict', revertConflictMessage(file.display, true))
          target = { kind: 'file', text: linesToText(restored.lines) }
        } else if (whole) {
          const reversed = reverseHunks(currentLines, diff.hunks)
          if (!reversed.ok) return fail(409, 'conflict', revertConflictMessage(file.display, true))
          if (!diff.before && reversed.lines.length !== 0) {
            // 这一轮新建的文件：回退整个文件是删掉它。改动处之外还有行，说明这一轮之后又加过，删掉会把它们一起丢掉。
            return fail(409, 'conflict', revertConflictMessage(file.display, true))
          }
          target = diff.before ? { kind: 'file', text: linesToText(reversed.lines) } : { kind: 'absent' }
        } else {
          const reversed = reverseHunk(currentLines, hunk)
          if (!reversed.ok) {
            return fail(409, 'conflict', revertConflictMessage(file.display, false,
              current.kind === 'absent' ? undefined : hunkRange(hunk), current.kind === 'absent'))
          }
          target = { kind: 'file', text: linesToText(reversed.lines) }
          appliedAt = reversed.at
        }
        if (target.kind === 'file' && current.kind === 'file') target.mode = current.mode
        const coord = { sessionId, seq, fileIndex, hunkIndex }
        const record = {
          kind: 'revert', ...coord, path,
          display: file.display, description: describeRevert(hunk),
          before: current, after: target,
          ...(hunk === null ? {} : { hunk, appliedAt }),
        }
        try {
          await store.save(record)
          await writeState(io, path, target)
        } catch (error) {
          // 写文件失败就撤掉刚存的记录；撤不掉也无所谓，留下的记录对不上现状，撤销时会被拒绝。
          await store.remove(coord).catch(() => { /* 见左侧注释 */ })
          return fail(500, 'write-failed', `回退 ${file.display} 时写文件失败：${error?.message ?? error}`)
        }
        return { ok: true, display: file.display, description: record.description }
      })
    },

    /**
     * 撤销一处回退，删掉记录。「这一处」按这一处正向应用（在现在的行里找回退时写回去的行，换回这一轮结束时的行），同一文件后来回退的别处不碍事；「整个文件」保持整文件核对，现在还是回退后的样子才撤销。回退时写回去的行找不到了就拒绝。
     * 只依赖记录和文件现状，改动记录不在了（DSH 重启过）也能撤销。
     * @param {{ sessionId: string, seq: number, fileIndex: number, hunkIndex: number | null }} coord 回退时的坐标。
     */
    async undo(coord) {
      if (isRunning(coord.sessionId)) return fail(409, 'running', runningMessage('undo'))
      const initial = await store.load(coord)
      if (initial === undefined) return fail(404, 'no-record', '未找到该回退记录。')
      return serialPath(initial.path, async () => {
        if (isRunning(coord.sessionId)) return fail(409, 'running', runningMessage('undo'))
        const record = await store.load(coord)
        if (record === undefined) return fail(404, 'no-record', '未找到该回退记录。')
        if (resolve(record.path) !== resolve(initial.path)) return fail(409, 'undo-changed', '回退记录已变更，请重新加载。')
        let current
        try {
          current = await readState(io, record.path)
        } catch (error) {
          return fail(500, 'read-failed', `读取 ${record.display} 失败：${error?.message ?? error}`)
        }
        let target
        if (record.hunkIndex === null) {
          if (!sameState(current, record.after)) {
            return fail(409, 'undo-changed', `无法撤销回退：回退后 ${record.display} 已被修改。`)
          }
          target = record.before
        } else if (sameState(current, record.after)) {
          // 回退之后文件没再动过：按记录原样写回，连末行换行的细节都和回退前一致。
          target = record.before
        } else {
          const currentLines = current.kind === 'file' ? textToLines(current.text) : []
          const redone = forwardHunk(currentLines, record.hunk, record.appliedAt)
          if (!redone.ok) {
            return fail(409, 'undo-changed', `无法撤销回退：回退后 ${record.display} 已被修改，未找到回退时写回的行。`)
          }
          // 回退前文件不在、正向应用完也没有行（这一轮删掉的文件又被回退整段补了回来）：把文件删掉，回到回退前的状态。
          target = redone.lines.length === 0 && record.before.kind === 'absent'
            ? { kind: 'absent' }
            : { kind: 'file', text: linesToText(redone.lines) }
        }
        try {
          await writeState(io, record.path, target)
        } catch (error) {
          return fail(500, 'write-failed', `撤销回退 ${record.display} 时写文件失败：${error?.message ?? error}`)
        }
        await store.remove(coord)
        return { ok: true, display: record.display, description: record.description }
      })
    },

    /**
     * 一个会话某一轮已经回退的坐标，页面重新打开后照它显示「已回退」和「撤销回退」。
     * @param {{ sessionId: string, seq: number }} coord 会话和序号。
     * @returns {Promise<{ ok: true, reverts: { fileIndex: number, hunkIndex: number | null, display: string, description: string }[] }>} 按文件下标、改动处下标排好的坐标。
     */
    async state({ sessionId, seq }) {
      return { ok: true, reverts: await store.list(sessionId, seq) }
    },
  }
}

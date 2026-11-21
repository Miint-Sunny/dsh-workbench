/**
 * 审阅面板回退备份与废纸篓恢复：
 * - 备份存放在独立目录 `$DSH_HOME/dsh-workbench/git-review/`（不与 lib/review/store.js 混放）；
 * - 回退前保存完整文件内容与权限位，撤销时逐字节与权限位核对；
 * - 未跟踪文件回退移入废纸篓目录，撤销时核对原路径仍不存在后再移回。
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isInside } from '../checkpoints-git.js'
import { assertPathInsideRepo, safeRelativePath } from './git.js'

const UNDO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const assertUndoId = (undoId) => {
  if (typeof undoId !== 'string' || !UNDO_ID_RE.test(undoId)) {
    throw Object.assign(new Error('invalid undoId'), { code: 'bad-request' })
  }
}

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

const validFileState = (s) => {
  if (!isPlainObject(s)) return false
  if (s.kind === 'absent') return true
  if (s.kind === 'symlink') return typeof s.target === 'string'
  if (s.kind === 'file') return typeof s.base64 === 'string' && Number.isInteger(s.mode) && s.mode >= 0 && s.mode <= 0o7777
  return false
}

const validIndexState = (s) => {
  if (s === undefined) return true
  if (!isPlainObject(s)) return false
  if (s.kind === 'absent') return true
  return s.kind === 'entry' && /^(100644|100755|120000)$/.test(s.mode) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.oid) && typeof s.base64 === 'string'
}

const validEntry = (entry) => {
  if (!isPlainObject(entry) || !safeRelativePath(entry.path)) return false
  if (entry.kind === 'trashed') return typeof entry.trashPath === 'string'
  if (entry.kind === 'file-revert') {
    return validFileState(entry.worktreeBefore)
      && validFileState(entry.worktreeAfter)
      && validIndexState(entry.indexBefore)
      && validIndexState(entry.indexAfter) && (entry.indexBefore === undefined) === (entry.indexAfter === undefined)
  }
  return false
}

const validRecord = (record) =>
  isPlainObject(record)
  && record.kind === 'git-review-revert'
  && UNDO_ID_RE.test(record.undoId ?? '')
  && typeof record.sessionId === 'string'
  && typeof record.repoId === 'string'
  && typeof record.repoRoot === 'string'
  && Array.isArray(record.entries)
  && record.entries.every(validEntry)
  && Number.isSafeInteger(record.savedAt)

/**
 * 捕获仓库内某路径当前的完整工作区状态（文件内容逐字节与权限位，或符号链接，或缺失）。
 * @param {string} repoRoot 仓库根目录。
 * @param {string} relPath 仓库内相对路径。
 * @param {number} maxBackupBytes 单个文件备份字节上限。
 * @returns {Promise<object>} 文件状态快照。
 */
export async function captureFileState(repoRoot, relPath, maxBackupBytes, { privateCopy = false } = {}) {
  const { absolutePath } = await assertPathInsideRepo(repoRoot, relPath, { allowEscapingLeafSymlink: privateCopy })
  let info
  try {
    info = await lstat(absolutePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (info.isSymbolicLink()) {
    return { kind: 'symlink', target: await readlink(absolutePath) }
  }
  if (!info.isFile()) {
    throw Object.assign(new Error('cannot back up non-regular file'), { code: 'bad-path' })
  }
  if (info.size > maxBackupBytes) {
    throw Object.assign(new Error('backup target exceeds maxBackupBytes'), { code: 'too-large' })
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const realInfo = await handle.stat()
    if (!realInfo.isFile()) {
      throw Object.assign(new Error('cannot back up non-regular file'), { code: 'bad-path' })
    }
    if (realInfo.size > maxBackupBytes) {
      throw Object.assign(new Error('backup target exceeds maxBackupBytes'), { code: 'too-large' })
    }
    const chunks = []
    let count = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length
      if (count > maxBackupBytes) throw Object.assign(new Error('backup exceeds size limit'), { code: 'too-large' })
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, count)
    return {
      kind: 'file',
      base64: bytes.toString('base64'),
      mode: realInfo.mode & 0o7777,
    }
  } finally {
    await handle.close()
  }
}

/**
 * 逐字节及权限位比对两份文件状态（不用哈希）。
 * @param {object} left 状态一。
 * @param {object} right 状态二。
 * @returns {boolean} 完全一致时返回 true。
 */
export function sameFileState(left, right) {
  if (left?.kind !== right?.kind) return false
  if (left.kind === 'absent') return true
  if (left.kind === 'symlink') return left.target === right.target
  if (left.kind === 'file') return left.base64 === right.base64 && left.mode === right.mode
  return false
}

/** Compare the captured bytes to the file that supplied the displayed diff. */
export function capturedFingerprint(state) {
  if (state.kind === 'absent') return 'absent'
  const hash = createHash('sha256')
  if (state.kind === 'symlink') return 'link:' + hash.update(state.target).digest('hex')
  return 'file:' + (constants.S_IFREG | state.mode) + ':' + hash.update(state.base64, 'base64').digest('hex')
}

const stale = () => Object.assign(new Error('file changed during operation'), { code: 'stale' })

// link creates the destination only if absent. A concurrent editor's replacement wins.
async function moveExclusive(from, to) {
  const st = await lstat(from)
  if (st.isSymbolicLink()) {
    // link(2) follows a source symlink on some platforms. Re-create the link itself.
    await symlink(await readlink(from, { encoding: 'buffer' }), to)
      .catch(error => { throw error.code === 'EEXIST' ? stale() : error })
  } else {
    if (!st.isFile()) throw stale()
    try {
      await link(from, to)
    } catch (error) {
      if (error.code === 'EEXIST') throw stale()
      if (error.code !== 'EXDEV') throw error
      const temp = join(dirname(to), '.dwb-gr-' + randomUUID())
      try {
        await copyFile(from, temp, constants.COPYFILE_EXCL)
        await chmod(temp, st.mode & 0o7777)
        await link(temp, to).catch(error => { throw error.code === 'EEXIST' ? stale() : error })
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    }
  }
  await unlink(from)
}

async function validateLinkTarget(root, path, text) {
  const target = await realpath(resolve(dirname(path), text)).catch(error => {
    if (error.code === 'ENOENT') throw Object.assign(stale(), { targetMissing: true })
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw stale()
    throw error
  })
  const rel = relative(root, target).split(sep).join('/')
  if (rel && !safeRelativePath(rel)) throw Object.assign(new Error('symlink outside working tree'), { code: 'bad-path' })
}

/** Write to a vacant path. The complete file and its original mode become visible together. */
export async function restoreFileState(repoRoot, relPath, state, { privateCopy = false } = {}) {
  if (state.kind === 'absent') return
  const { absolutePath, canonicalRoot } = await assertPathInsideRepo(repoRoot, relPath)
  await mkdir(dirname(absolutePath), { recursive: true })
  if (state.kind === 'symlink') {
    if (!privateCopy) await validateLinkTarget(canonicalRoot, absolutePath, state.target)
    await symlink(state.target, absolutePath).catch(error => { throw error.code === 'EEXIST' ? stale() : error })
    return
  }
  const temp = join(dirname(absolutePath), '.dwb-gr-' + randomUUID())
  try {
    await writeFile(temp, Buffer.from(state.base64, 'base64'), { mode: 0o600, flag: 'wx' })
    await chmod(temp, state.mode)
    await assertPathInsideRepo(repoRoot, relPath)
    await link(temp, absolutePath).catch(error => { throw error.code === 'EEXIST' ? stale() : error })
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

// Retain the displaced inode until the checked replacement has been installed.
async function withClaimedPath(root, path, action) {
  // Sibling entries may already have moved the link target. Only claim the leaf,
  // then compare its link text or file bytes to the previously verified source.
  const { absolutePath } = await assertPathInsideRepo(root, path, { allowEscapingLeafSymlink: true })
  const held = join(dirname(path), '.dwb-gr-' + randomUUID())
  const saved = join(root, held)
  await rename(absolutePath, saved).catch(error => { throw error.code === 'ENOENT' ? stale() : error })
  try {
    await action(held, saved)
  } catch (error) {
    try {
      await assertPathInsideRepo(root, path)
      await moveExclusive(saved, absolutePath)
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `concurrent change preserved at ${held}`)
    }
    throw error
  }
}

/** Replace only the exact bytes and mode that the caller observed. */
export async function replaceFileState(root, path, before, after) {
  if (before.kind === 'absent') return restoreFileState(root, path, after)
  await withClaimedPath(root, path, async (held, saved) => {
    const limit = before.kind === 'file' ? Buffer.byteLength(before.base64, 'base64') : 0
    let actual
    try {
      actual = await captureFileState(root, held, limit, { privateCopy: true })
    } catch (error) {
      if (error.code === 'too-large') throw stale()
      throw error
    }
    if (!sameFileState(actual, before)) throw stale()
    await restoreFileState(root, path, after)
    await unlink(saved)
  })
}

/** Fingerprint a trash item without following its target or loading large files into memory. */
export async function trashFingerprint(path) {
  const st = await lstat(path)
  if (st.isSymbolicLink()) return 'link:' + createHash('sha256').update(await readlink(path, { encoding: 'buffer' })).digest('hex')
  if (!st.isFile()) throw Object.assign(new Error('expected regular file'), { code: 'bad-path' })
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    return 'file:' + st.mode + ':' + hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Allocate a private item name in the configured trash directory. */
export async function trashPathFor(repoRoot, relPath, trashDir, undoId) {
  await mkdir(trashDir, { recursive: true })
  const dir = await realpath(trashDir)
  if (isInside(repoRoot, dir)) throw new Error('trashDir must be outside repository')
  return join(dir, `dsh-git-review-${undoId}-${randomUUID().slice(0, 8)}-${basename(relPath).replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)}`)
}

/** Validate persisted paths even for records saved by older builds. */
export async function verifyTrashPath(entry, trashDir, undoId) {
  const dir = await realpath(trashDir)
  if (dirname(entry.trashPath) !== dir || !basename(entry.trashPath).startsWith('dsh-git-review-' + undoId + '-')) throw stale()
}

export async function moveFileToTrash(root, entry) {
  await withClaimedPath(root, entry.path, async (_held, saved) => {
    if (entry.fingerprint && await trashFingerprint(saved) !== entry.fingerprint) throw stale()
    await moveExclusive(saved, entry.trashPath)
  })
}

export async function restoreFileFromTrash(root, entry) {
  const { absolutePath } = await assertPathInsideRepo(root, entry.path)
  await mkdir(dirname(absolutePath), { recursive: true })
  const dir = dirname(entry.trashPath)
  // A relative symlink in the trash has a different target until it is moved back.
  const held = join(dir, '.dwb-gr-' + randomUUID())
  await rename(entry.trashPath, held).catch(error => { throw error.code === 'ENOENT' ? stale() : error })
  try {
    if (entry.fingerprint && await trashFingerprint(held) !== entry.fingerprint) throw stale()
    if ((await lstat(held)).isSymbolicLink()) {
      await validateLinkTarget(root, absolutePath, await readlink(held))
    }
    await moveExclusive(held, absolutePath)
  } catch (error) {
    await moveExclusive(held, entry.trashPath)
    throw error
  }
}

/**
 * 创建回退备份存取器，独立存放在 `$DSH_HOME/dsh-workbench/git-review/`。
 * @param {string} root 备份目录绝对路径。
 * @param {{ clock?: () => number }} [options] 时钟注入（测试用）。
 */
export function createGitReviewStore(root, { clock = Date.now } = {}) {
  const fileOf = (undoId) => {
    assertUndoId(undoId)
    return join(root, `${undoId}.json`)
  }

  return {
    async save(record) {
      const file = fileOf(record.undoId)
      await mkdir(root, { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify({ ...record, savedAt: clock() }, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        })
        await rename(temp, file)
      } finally {
        await unlink(temp).catch(() => {})
      }
    },

    async load(undoId) {
      let file
      try {
        file = fileOf(undoId)
      } catch {
        return undefined
      }
      let handle
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        if (!(await handle.stat()).isFile()) return undefined
        const parsed = JSON.parse(await handle.readFile('utf8'))
        return validRecord(parsed) && parsed.undoId === undoId ? parsed : undefined
      } catch (error) {
        if (error instanceof SyntaxError || ['ELOOP', 'ENOENT'].includes(error.code)) return undefined
        throw error
      } finally {
        await handle?.close()
      }
    },

    async remove(undoId) {
      const file = fileOf(undoId)
      await unlink(file).catch((error) => {
        if (error?.code !== 'ENOENT') throw error
      })
    },

    async prune(cutoffMs) {
      let names
      try {
        names = await readdir(root)
      } catch {
        return
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const id = name.slice(0, -5)
        if (!UNDO_ID_RE.test(id)) continue
        const record = await this.load(id)
        if (record && record.savedAt < cutoffMs) await this.remove(id)
      }
    },
  }
}

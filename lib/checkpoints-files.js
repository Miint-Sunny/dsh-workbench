/**
 * 检查点的 files 种类（不在 git 里的目录）：文件工具（写入、编辑、应用补丁、删除）改一个
 * 文件之前，把这一轮第一次碰到的路径整份捕获（照官方 dsh-workspace-changes 的 captureFile，
 * G 调研 Q3「非 git 目录」），按内容 SHA-1 存进 `captures/`；恢复到第 N 轮开始前时，对第 N
 * 轮及以后碰过的每个路径取最早那一轮的「改动前」捕获写回，`absent` 就删。命令行改的文件
 * 不经过文件工具，不记。预览和恢复共用一个恢复计划（planFilesRestore）：目录符号链接出
 * 工作区的跳过（unsafe-path）、现在超过上限的文件不改不删（oversized）、副本内容对不上
 * 的不写回（changed-after）。本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { canonicalPath, isInside } from './checkpoints-git.js'

/** git 判断二进制时看的前几个字节数（照官方）。 */
const BINARY_PROBE_BYTES = 8_000

/**
 * 捕获里的路径是不是安全的相对路径（相对会话工作目录、`/` 分隔、不越界）。jsonl 是磁盘
 * 文件，读回来要核对，免得坏记录把恢复写到工作目录外面。
 * @param {string} path 路径。
 * @returns {boolean} 安全时 true。
 */
export function safeRelative(path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\\')) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * 进程路径换成相对工作目录的 `/` 路径；不在工作目录里的答 undefined（工作目录外的文件不记）。
 * @param {string} root 会话工作目录（规范拼法）。
 * @param {string} absolute 文件的绝对路径（规范拼法）。
 * @returns {string | undefined} 相对路径。
 */
export function relativeInside(root, absolute) {
  const rel = relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const posix = rel.split(sep).join('/')
  return safeRelative(posix) ? posix : undefined
}

/**
 * 有界地读一个路径：最多读 maxBytes + 1 字节。不存在（或父路径不是目录）答 absent；不是普通文件（目录等）答
 * undefined；超过上限答 oversized（不留内容）；否则带上内容和权限位。
 * @param {string} absolute 文件的绝对路径。
 * @param {number} maxBytes 字节上限。
 * @returns {Promise<{ kind: 'file', bytes: Buffer, mode: number } | { kind: 'absent' } | { kind: 'oversized' } | { kind: 'unsafe' } | undefined>} 读到的；符号链接记 unsafe。
 * @throws 打开或读失败（不是「不存在」）时。
 */
async function readBounded(absolute, maxBytes) {
  let handle
  try {
    const entry = await lstat(absolute)
    if (entry.isSymbolicLink()) return { kind: 'unsafe' }
    if (!entry.isFile()) return undefined
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === 'ELOOP') return { kind: 'unsafe' }
    if (error?.code === 'EISDIR') return undefined
    // 父路径不是目录（ENOTDIR）时这个路径同样不可能有文件，和不存在一样记 absent。
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    return { kind: 'absent' }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return undefined
    const probe = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < probe.length) {
      const { bytesRead } = await handle.read(probe, length, probe.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) return { kind: 'oversized' }
    return { kind: 'file', bytes: probe.subarray(0, length), mode: info.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

/** 内容的 SHA-1（副本的文件名）。 */
const sha1Of = bytes => createHash('sha1').update(bytes).digest('hex')

/** 捕获副本临时文件名的自增序号（并发捕获同一内容时不互相踩）。 */
let captureSeq = 0

/**
 * 存一个路径此刻的内容（照官方 captureFile）：超过上限记 oversized（不存内容），不存在记
 * absent，不是普通文件答 undefined 不记；副本按内容 SHA-1 命名，先写临时文件、校验大小、
 * 再改名过去——崩溃留下的半截副本会被完整内容顶掉，不能按名字信任（第 40 件 #15）。
 * @param {string} absolute 文件的绝对路径。
 * @param {string} directory captures/ 目录（不存在就建）。
 * @param {number} maxBytes 单个文件的字节上限。
 * @returns {Promise<{ kind: 'file', sha1: string, mode: number } | { kind: 'absent' } | { kind: 'oversized' } | undefined>} 捕获。
 * @throws 读写失败（不是「不存在」）时。
 */
export async function captureFile(absolute, directory, maxBytes) {
  const read = await readBounded(absolute, maxBytes)
  if (read?.kind === 'unsafe') return undefined
  if (read?.kind !== 'file') return read
  const sha1 = sha1Of(read.bytes)
  await mkdir(directory, { recursive: true })
  const final = join(directory, sha1)
  const temp = join(directory, `.tmp-${sha1.slice(0, 12)}-${process.pid}-${captureSeq++}`)
  try {
    await writeFile(temp, read.bytes)
    const written = await stat(temp)
    if (written.size !== read.bytes.length) throw new Error(`capture copy of ${absolute} truncated on write`)
    // 改名是原子的；同名旧副本（可能被截断过）被完整内容顶掉。
    await rename(temp, final)
  } finally {
    await rm(temp, { force: true })
  }
  return { kind: 'file', sha1, mode: read.mode }
}

/** 两个捕获是不是同一个内容（都不存在、或副本哈希相同）；oversized 永远不算相同。 */
export function sameCapture(a, b) {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind
  return a.kind === 'file' && b.kind === 'file' && a.sha1 === b.sha1 && a.mode === b.mode
}

/**
 * 恢复到第 N 轮开始前要写回的目标：第 N 轮及以后碰过的每个路径，取最早碰过它的那一轮
 * 的「改动前」捕获（纯函数）。
 * @param {{ turn: number, kind: string, captures?: Record<string, object> }[]} entries 检查点记录（按 turn 升序）。
 * @param {number} turn 第 N 轮。
 * @returns {Map<string, object>} 路径 → 捕获。
 */
export function restoreTargets(entries, turn) {
  const targets = new Map()
  for (const entry of entries) {
    if (entry.turn < turn || entry.kind !== 'files') continue
    for (const [path, capture] of Object.entries(entry.captures ?? {})) {
      if (!targets.has(path) && safeRelative(path)) targets.set(path, capture)
    }
  }
  return targets
}

/** 文本的行数（最后一行没有换行也算一行；空文本是 0 行）。 */
const linesOf = text => (text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'))

/**
 * 「现在 → 检查点」的行数：去掉首尾相同的行，中间整段算改动。单处改动是准数；多处分散的
 * 改动会把中间没变的行也算进去（只多不少）。二进制（前 8000 字节里有 NUL）两边都记 0。
 * @param {Buffer | null} now 现在的内容；不存在是 null。
 * @param {Buffer | null} target 检查点的内容；不存在是 null。
 * @returns {{ added: number, deleted: number, binary: boolean }} 恢复会加回去的行数和拿掉的行数。
 */
export function lineCounts(now, target) {
  const binary = [now, target].some(bytes => bytes !== null && bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
  if (binary) return { added: 0, deleted: 0, binary: true }
  const before = linesOf(now === null ? '' : now.toString('utf8'))
  const after = linesOf(target === null ? '' : target.toString('utf8'))
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  return { added: endAfter - start, deleted: endBefore - start, binary: false }
}

/** 写回用的临时文件名自增序号（同一个进程里两次写回不互相踩）。 */
let restoreSeq = 0

/**
 * 按恢复计划把目标写回工作目录：file 从副本写回（先写临时文件、设好权限再改名，失败时把
 * 临时文件清掉，不在工作目录里留 *.dwb-restore-*），absent 就删。计划里跳过的（unsafe-path、
 * oversized、changed-after）原样列进 skipped，一个字节都不碰。做完逐个核对（只读不存），
 * 和目标不同的记 changed-after。plan 传进来就用它、不再算一遍（第 41 件第 3 项）：调用方
 * 存撤销点用的就是这一份，两次各算一遍的话，窗口里改过的路径会写回、却不在撤销点里。
 * @param {string} root 会话工作目录。
 * @param {string} capturesDir captures/ 目录。
 * @param {Map<string, object>} targets 路径 → 捕获。
 * @param {number} maxBytes 核对时读的字节上限。
 * @param {{ path: string, target: object, action: string, reason?: string, current?: object, wanted?: Buffer }[]} [plan] planFilesRestore 的结果；不传就自己算。
 * @returns {Promise<{ restored: number, skipped: { path: string, reason: string }[], changed: string[] }>} 写回加删除成功的文件数、没恢复的路径和原因、实际动过的路径。
 */
export async function restoreFiles(root, capturesDir, targets, maxBytes, plan) {
  plan ??= await planFilesRestore(root, capturesDir, targets, maxBytes)
  const skipped = []
  for (const item of plan) {
    if (item.action === 'skip') skipped.push({ path: item.path, reason: item.reason })
  }
  const written = []
  for (const item of plan) {
    if (item.action === 'skip') continue
    const absolute = join(root, item.path)
    try {
      if (item.action === 'delete') {
        await rm(absolute, { force: true })
      } else {
        await mkdir(dirname(absolute), { recursive: true })
        let temp
        try {
          temp = `${absolute}.dwb-restore-${process.pid}-${restoreSeq++}`
          await writeFile(temp, item.wanted)
          await chmod(temp, item.target.mode)
          await rename(temp, absolute)
          temp = undefined
        } finally {
          if (temp !== undefined) await rm(temp, { force: true })
        }
      }
      written.push(item.path)
    } catch {
      // 这一项写不回（父路径变成了文件、没权限等）：下面的核对会把它记成 changed-after。
    }
  }
  // 核对：逐个再读一次，和目标不同的路径如实列出来（计划里跳过的已经记过）。
  let restored = 0
  for (const item of plan) {
    if (item.action === 'skip') continue
    const now = await readBounded(join(root, item.path), maxBytes)
    const same = item.action === 'delete'
      ? now === undefined || now.kind === 'absent'
      : now?.kind === 'file' && sha1Of(now.bytes) === item.target.sha1 && now.mode === item.target.mode
    if (!same && !skipped.some(entry => entry.path === item.path)) skipped.push({ path: item.path, reason: 'changed-after' })
    else if (same && written.includes(item.path)) restored += 1
  }
  return { restored, skipped, changed: written }
}

/**
 * files 种类的恢复计划（预览和恢复共用同一个，第 40 件 #3 #4 #13）：逐个路径定 action。
 * 三种不碰：父目录经符号链接解析出了工作区（unsafe-path，跟着链接写会改到外面的文件）；
 * 现在的文件超过上限（oversized，改了或删了都存不进「恢复前」检查点，找不回）；副本内容
 * 和记录的 SHA-1 对不上（changed-after，被截断的副本写回只会毁文件）。和现在一样的路径
 * 不列（内容连权限位都相同才一样）。
 * @param {string} root 会话工作目录。
 * @param {string} capturesDir captures/ 目录。
 * @param {Map<string, object>} targets restoreTargets 的结果。
 * @param {number} maxBytes 单个文件的字节上限。
 * @returns {Promise<{ path: string, target: object, action: 'restore' | 'delete' | 'skip', reason?: string, current?: object, wanted?: Buffer }[]>} 按路径排的计划。
 */
export async function planFilesRestore(root, capturesDir, targets, maxBytes) {
  const plan = []
  // root 先按符号链接解析成规范拼法再比（macOS 的临时目录就在 /var → /private/var 上）。
  const base = await canonicalPath(root)
  for (const [path, target] of [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const absolute = join(base, path)
    // 先看父目录（不在的按最近的存在祖先解析）：经符号链接指到工作区外面的，这一条不碰。
    const parent = await canonicalPath(dirname(absolute))
    if (!isInside(base, parent)) {
      plan.push({ path, target, action: 'skip', reason: 'unsafe-path' })
      continue
    }
    if (target.kind === 'oversized') {
      plan.push({ path, target, action: 'skip', reason: 'oversized' })
      continue
    }
    const current = await readBounded(absolute, maxBytes)
    if (current?.kind === 'unsafe') {
      plan.push({ path, target, action: 'skip', reason: 'unsafe-path' })
      continue
    }
    if (current?.kind === 'oversized') {
      plan.push({ path, target, action: 'skip', reason: 'oversized' })
      continue
    }
    if (target.kind === 'absent') {
      if (current === undefined || current.kind === 'absent') continue
      plan.push({ path, target, action: 'delete', current })
      continue
    }
    const copy = join(capturesDir, target.sha1)
    let wanted = null
    try {
      wanted = await readFile(copy)
    } catch {
      wanted = null
    }
    if (wanted === null || sha1Of(wanted) !== target.sha1) {
      plan.push({ path, target, action: 'skip', reason: 'changed-after' })
      continue
    }
    if (current?.kind === 'file' && sha1Of(current.bytes) === target.sha1 && current.mode === target.mode) continue
    plan.push({ path, target, action: 'restore', current, wanted })
  }
  return plan
}

/**
 * 预览：按计划列出会变的文件，先列删除、再列恢复、最后列跳过（第 40 件 #13），和恢复
 * 做的事一字不差。
 * @param {string} root 会话工作目录。
 * @param {string} capturesDir captures/ 目录。
 * @param {Map<string, object>} targets restoreTargets 的结果。
 * @param {number} maxBytes 单个文件的字节上限。
 * @returns {Promise<{ path: string, action: string, added: number, deleted: number, binary: boolean, reason?: string }[]>} 文件列表。
 */
export async function previewFiles(root, capturesDir, targets, maxBytes) {
  const plan = await planFilesRestore(root, capturesDir, targets, maxBytes)
  const files = []
  const rowsOf = item => {
    const now = item.current?.kind === 'file' ? item.current.bytes : null
    const target = item.action === 'delete' ? null : (item.wanted ?? null)
    return lineCounts(now, target)
  }
  for (const item of plan) {
    if (item.action === 'delete') files.push({ path: item.path, action: 'delete', ...rowsOf(item) })
  }
  for (const item of plan) {
    if (item.action === 'restore') files.push({ path: item.path, action: 'restore', ...rowsOf(item) })
  }
  for (const item of plan) {
    if (item.action === 'skip') files.push({ path: item.path, action: 'skip', added: 0, deleted: 0, binary: false, reason: item.reason })
  }
  return files
}

/**
 * 把这些路径各捕获一份此刻的内容（恢复前的撤销点）。不是普通文件的路径（目录等）不记。
 * @param {string} root 会话工作目录。
 * @param {string} capturesDir captures/ 目录。
 * @param {Iterable<string>} paths 相对路径。
 * @param {number} maxBytes 单个文件的字节上限。
 * @returns {Promise<Record<string, object>>} 路径 → 捕获。
 */
export async function captureNow(root, capturesDir, paths, maxBytes) {
  const captures = {}
  for (const path of paths) {
    const capture = await captureFile(join(root, path), capturesDir, maxBytes)
    if (capture !== undefined) captures[path] = capture
  }
  return captures
}

/**
 * 一组路径此刻的状态（撤销的过期核对用，第 40 件 #1）：每个路径答 { kind, sha1?, mode? }，
 * 不存在的记 absent、超上限的记 oversized；不是普通文件（目录等）不记（和捕获的口径一致）。
 * @param {string} root 会话工作目录。
 * @param {Iterable<string>} paths 相对路径。
 * @param {number} maxBytes 单个文件的字节上限。
 * @returns {Promise<Record<string, object>>} 路径 → 状态。
 */
export async function filesStateNow(root, paths, maxBytes) {
  const state = {}
  for (const path of paths) {
    const read = await readBounded(join(root, path), maxBytes)
    if (read === undefined || read.kind === 'unsafe') continue
    state[path] = read.kind === 'file' ? { kind: 'file', sha1: sha1Of(read.bytes), mode: read.mode } : { kind: read.kind }
  }
  return state
}

/**
 * Git 差异解析、未跟踪文件构建、以及按单块构造安全补丁的工具模块。
 * 按 unified diff 的 hunk 行数计数推进，不会被文件内容里的 `diff --git ` 或 `@@ ` 行混淆；
 * 补丁构造完全来自宿主刚算出的 diff 结构，不接收任何客户端传来的补丁文本。
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { parseNumstat } from '../checkpoints-git.js'
import { assertPathInsideRepo } from './git.js'

const RAW_STATUS_MAP = {
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  U: 'conflict',
}

/**
 * 解析 `git diff --raw -M -z --no-abbrev` 输出。
 * @param {string} output NUL 分隔的 raw 差异输出。
 * @param {{ numstat?: boolean }} [options] 同一条 Git 命令附带 --numstat 时，合入对应对象的增删行数。
 * @returns {{ oldMode: string, newMode: string, oldSha: string, newSha: string, status: string, path: string, oldPath?: string, added?: number, deleted?: number, binary?: boolean }[]} 条目列表。
 */
export function parseDiffRaw(output, { numstat = false } = {}) {
  if (!output) return []
  const queue = output.split('\0')
  if (queue.at(-1) !== '') {
    throw new Error('diff --raw output is not NUL-terminated')
  }
  queue.pop()
  const entries = []
  while (queue.length > 0) {
    if (numstat && !queue[0].startsWith(':')) break
    const meta = queue.shift()
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(meta)
    if (!match) throw new Error(`malformed diff --raw record: ${meta}`)
    const [, oldMode, newMode, oldSha, newSha, rawCode] = match
    const letter = rawCode[0]
    let oldPath
    let path
    if (letter === 'R' || letter === 'C') {
      oldPath = queue.shift()
      path = queue.shift()
    } else {
      path = queue.shift()
    }
    if (path === undefined || ((letter === 'R' || letter === 'C') && oldPath === undefined)) {
      throw new Error('malformed diff --raw path record')
    }
    const status = RAW_STATUS_MAP[letter] ?? 'modified'
    entries.push({
      oldMode,
      newMode,
      oldSha,
      newSha,
      status,
      path,
      ...(status === 'renamed' ? { oldPath } : {}),
    })
  }
  if (numstat) {
    const stats = parseNumstat(queue.length ? queue.join('\0') + '\0' : '')
    if (stats.length !== entries.length) throw new Error('incomplete staged line counts')
    for (const [i, stat] of stats.entries()) {
      const entry = entries[i]
      if (entry.path !== stat.path || entry.oldPath !== stat.oldPath) throw new Error('mismatched staged line counts')
      Object.assign(entry, stat)
    }
  }
  return entries
}

/** 将 Git C 风格引号路径反转义；若未加引号则原样返回。 */
function unquoteGitPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const inner = value.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = inner[++i]
    if (next === undefined) break
    if (next >= '0' && next <= '7') {
      const oct = inner.slice(i, i + 3)
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(Number.parseInt(oct, 8))
        i += 2
        continue
      }
    }
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
    if (Object.hasOwn(escapes, next)) bytes.push(escapes[next])
    else bytes.push(...Buffer.from(next, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 构造 `diff --git a/... b/...` 表头中使用的路径，必要时加上 C 风格引号。 */
function formatPatchPath(prefix, relPath) {
  const full = `${prefix}${relPath}`
  if (!/[\x00-\x1f\x7f"\\]/.test(full)) return full
  const escaped = full
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\t', '\\t')
  return `"${escaped}"`
}

/** 从 `--- a/...` / `+++ b/...` 剥离前缀。 */
function stripHeaderPrefix(raw, expectedPrefix) {
  const unquoted = unquoteGitPath(raw.replace(/\t$/, ''))
  if (unquoted === '/dev/null') return null
  if (unquoted.startsWith(expectedPrefix)) return unquoted.slice(expectedPrefix.length)
  return unquoted
}

/** 解析 `diff --git ...` 行；优先用 rawEntries 精确匹配以防文件名含空格或 ` b/`。 */
function matchHeaderPaths(headerLine, rawEntries) {
  const rest = headerLine.slice('diff --git '.length)
  for (const entry of rawEntries) {
    const left = entry.oldPath ?? entry.path
    const right = entry.path
    const plain = `a/${left} b/${right}`
    const quoted = `${formatPatchPath('a/', left)} ${formatPatchPath('b/', right)}`
    if (rest === plain || rest === quoted) {
      return { oldPath: left, path: right }
    }
  }
  const quotedBoth = /^("(?:\\.|[^"])+") ("(?:\\.|[^"])+")$/.exec(rest)
  if (quotedBoth) {
    return {
      oldPath: stripHeaderPrefix(quotedBoth[1], 'a/'),
      path: stripHeaderPrefix(quotedBoth[2], 'b/'),
    }
  }
  const sep = rest.indexOf(' b/')
  if (sep > 0 && rest.startsWith('a/')) {
    return { oldPath: rest.slice(2, sep), path: rest.slice(sep + 3) }
  }
  return { oldPath: null, path: null }
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * 解析 `git diff --unified=3` 文本。按 hunk 行数计数消费正文行，不会误判正文里似头部的行。
 * @param {string} text unified diff 文本。
 * @param {{ path: string, oldPath?: string }[]} [rawEntries] 供路径消歧用的 raw 列表。
 * @returns {{ path: string, oldPath?: string, binary: boolean, hunks: object[] }[]} 每个文件的解析结果。
 */
export function parseUnifiedDiff(text, rawEntries = []) {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()

  const files = []
  let current = null
  let inBinaryPatch = false
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      inBinaryPatch = false
      const headerPaths = matchHeaderPaths(line, rawEntries)
      current = {
        path: headerPaths.path ?? '',
        ...(headerPaths.oldPath && headerPaths.oldPath !== headerPaths.path ? { oldPath: headerPaths.oldPath } : {}),
        binary: false,
        hunks: [],
        oldMode: undefined,
        newMode: undefined,
      }
      files.push(current)
      i++
      continue
    }

    if (current === null) {
      i++
      continue
    }

    if (inBinaryPatch) {
      i++
      continue
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line)
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1])
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2])
      const newStart = Number(hunkMatch[3])
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4])
      let oldRem = oldLines
      let newRem = newLines
      let oldNo = oldStart
      let newNo = newStart
      const parsedLines = []
      const rawLines = []
      i++

      while ((oldRem > 0 || newRem > 0) && i < lines.length) {
        const bodyLine = lines[i]
        if (bodyLine.startsWith('\\')) {
          rawLines.push(bodyLine)
          i++
          continue
        }
        if (bodyLine.startsWith(' ')) {
          rawLines.push(bodyLine)
          parsedLines.push({ kind: 'context', old: oldNo++, new: newNo++, text: bodyLine.slice(1) })
          oldRem--
          newRem--
          i++
        } else if (bodyLine.startsWith('-')) {
          rawLines.push(bodyLine)
          parsedLines.push({ kind: 'delete', old: oldNo++, text: bodyLine.slice(1) })
          oldRem--
          i++
        } else if (bodyLine.startsWith('+')) {
          rawLines.push(bodyLine)
          parsedLines.push({ kind: 'add', new: newNo++, text: bodyLine.slice(1) })
          newRem--
          i++
        } else {
          break
        }
      }
      // Hunk 末尾行若缺少换行，`\ No newline at end of file` 会紧跟在计数归零之后出现。
      if (i < lines.length && lines[i].startsWith('\\')) {
        rawLines.push(lines[i])
        i++
      }

      // subprocess 提供 UTF-8 文本。含替换字符的块无法保证逐字节还原。
      if (rawLines.some(line => line.includes('\uFFFD'))) current.binary = true
      current.hunks.push({
        id: `h${current.hunks.length}`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: parsedLines,
        rawHeader: line,
        rawLines,
      })
      continue
    }

    if (line.startsWith('rename from ')) {
      current.oldPath = unquoteGitPath(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      current.path = unquoteGitPath(line.slice('rename to '.length))
    } else if (line.startsWith('new file mode ')) {
      current.newMode = line.slice('new file mode '.length).trim()
    } else if (line.startsWith('deleted file mode ')) {
      current.oldMode = line.slice('deleted file mode '.length).trim()
    } else if (line.startsWith('old mode ')) {
      current.oldMode = line.slice('old mode '.length).trim()
    } else if (line.startsWith('new mode ')) {
      current.newMode = line.slice('new mode '.length).trim()
    } else if (line.startsWith('--- ')) {
      const p = stripHeaderPrefix(line.slice(4), 'a/')
      if (p !== null && !current.oldPath && current.path && p !== current.path) current.oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = stripHeaderPrefix(line.slice(4), 'b/')
      if (p !== null) current.path = p
    } else if (/^Binary files .+ differ$/.test(line)) {
      current.binary = true
    } else if (line === 'GIT binary patch') {
      current.binary = true
      inBinaryPatch = true
    }
    i++
  }

  return files
}

/** 从同一个文件描述符计算摘要，仅在文件未超预览上限时保留内容。 */
async function readWorktreeState(repoRoot, path, previewBytes, signal) {
  signal?.throwIfAborted()
  const { absolutePath, leafEscapes } = await assertPathInsideRepo(repoRoot, path, { allowEscapingLeafSymlink: true })
  let info
  try {
    info = await lstat(absolutePath)
  } catch (error) {
    if (error.code === 'ENOENT') return { fingerprint: 'absent', size: 0 }
    throw error
  }
  if (info.isSymbolicLink()) {
    const bytes = await readlink(absolutePath, { encoding: 'buffer' })
    const fingerprint = `link:${createHash('sha256').update(bytes).digest('hex')}`
    return { fingerprint, size: bytes.length, newMode: '120000', leafEscapes, bytes: bytes.length <= previewBytes ? bytes : undefined }
  }
  if (!info.isFile()) return { fingerprint: `special:${info.mode}:${info.ino}`, size: 0 }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw Object.assign(new Error('worktree file changed during read'), { code: 'stale' })
    }
    const hash = createHash('sha256')
    let chunks = opened.size <= previewBytes && previewBytes >= 0 ? [] : null
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      hash.update(chunk)
      size += chunk.length
      if (size > previewBytes) chunks = null
      chunks?.push(chunk)
    }
    const fingerprint = `file:${opened.mode}:${hash.digest('hex')}`
    return { fingerprint, size, newMode: opened.mode & 0o111 ? '100755' : '100644', bytes: chunks && Buffer.concat(chunks, size) }
  } finally {
    await handle.close()
  }
}

/** 写入前复核工作区内容和权限；缺失路径使用固定标记。 */
export async function fingerprintWorktreePath(root, path, signal) {
  return (await readWorktreeState(root, path, -1, signal)).fingerprint
}

/** 已跟踪文件仅需大小和摘要，正文由 Git 取得。 */
export async function inspectWorktreeFile(root, path, signal) {
  return readWorktreeState(root, path, -1, signal)
}

/** 为未跟踪文件生成差异，超出剩余预览预算时只返回元数据和摘要。 */
export async function readUntrackedFileDiff(repoRoot, relPath, maxFileBytes, signal) {
  const { bytes, size, newMode, leafEscapes, fingerprint } = await readWorktreeState(repoRoot, relPath, maxFileBytes, signal)
  if (fingerprint === 'absent') throw Object.assign(new Error('file disappeared during review'), { code: 'stale' })
  if (!newMode || leafEscapes || !bytes) {
    return {
      file: { path: relPath, status: 'untracked', binary: !newMode || Boolean(leafEscapes), tooLarge: size > maxFileBytes, added: 0, deleted: 0, hunks: [], newMode },
      fingerprint, size,
    }
  }
  if (bytes.includes(0) || !isUtf8(bytes)) {
    return {
      file: {
        path: relPath,
        status: 'untracked',
        binary: true,
        tooLarge: false,
        added: 0,
        deleted: 0,
        hunks: [],
        newMode,
      },
      fingerprint, size,
    }
  }

  if (bytes.length === 0) {
    return {
      file: {
        path: relPath,
        status: 'untracked',
        binary: false,
        tooLarge: false,
        added: 0,
        deleted: 0,
        hunks: [],
        newMode,
      },
      fingerprint, size,
    }
  }

  const text = bytes.toString('utf8')
  const endsWithNewline = text.endsWith('\n')
  const contentLines = endsWithNewline ? text.slice(0, -1).split('\n') : text.split('\n')
  const hunk = {
    id: 'h0',
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: contentLines.length,
    lines: contentLines.map((lineText, idx) => ({ kind: 'add', new: idx + 1, text: lineText })),
    rawHeader: `@@ -0,0 +1,${contentLines.length} @@`,
    rawLines: [
      ...contentLines.map(lineText => `+${lineText}`),
      ...(endsWithNewline ? [] : ['\\ No newline at end of file']),
    ],
  }

  return {
    file: {
      path: relPath,
      status: 'untracked',
      binary: false,
      tooLarge: false,
      added: contentLines.length,
      deleted: 0,
      hunks: [hunk],
      newMode,
    },
    fingerprint, size,
  }
}

/**
 * 仅从宿主刚算出的文件和 hunk 结构构造供 `git apply` 使用的单块补丁文本。
 * @param {object} file 内部文件差异对象。
 * @param {object} hunk 内部 hunk 对象。
 * @returns {string} 可直接送入 `git apply` 标准输入的补丁文本。
 */
export function buildSingleHunkPatch(file, hunk) {
  const pathA = formatPatchPath('a/', file.path)
  const pathB = formatPatchPath('b/', file.path)
  const header = [`diff --git ${pathA} ${pathB}`]

  if (file.status === 'added' || file.status === 'untracked') {
    header.push(`new file mode ${file.newMode || '100644'}`)
    header.push('--- /dev/null')
    header.push(`+++ ${pathB}`)
  } else if (file.status === 'deleted') {
    header.push(`deleted file mode ${file.oldMode || '100644'}`)
    header.push(`--- ${pathA}`)
    header.push('+++ /dev/null')
  } else {
    header.push(`--- ${pathA}`)
    header.push(`+++ ${pathB}`)
  }

  header.push(hunk.rawHeader)
  header.push(...hunk.rawLines)
  return `${header.join('\n')}\n`
}

/**
 * 剥离宿主内部字段（rawHeader / rawLines / oldMode / newMode 等），输出第 8 节接口规定的文件对象。
 * @param {object} file 内部文件差异对象。
 * @returns {object} 接口对外的文件对象。
 */
export function stripInternalFields(file) {
  let added = 0
  let deleted = 0
  const hunks = file.binary || file.tooLarge
    ? []
    : file.hunks.map((hunk) => {
        for (const line of hunk.lines) {
          if (line.kind === 'add') added++
          else if (line.kind === 'delete') deleted++
        }
        return {
          id: hunk.id,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: hunk.lines,
        }
      })

  return {
    path: file.path,
    ...(file.status === 'renamed' && file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    status: file.status,
    binary: Boolean(file.binary),
    tooLarge: Boolean(file.tooLarge),
    added,
    deleted,
    hunks,
  }
}

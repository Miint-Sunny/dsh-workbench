/**
 * 会话迁移（feat#187）用到的会话日志格式，照 DSH 0.2.2 的 dsh-session-persistence-jsonl：
 * 日志是 `sessions/<项目目录名>/<会话目录名>/session.v<N>.jsonl.zstd`（不压缩时没有 `.zstd`）。
 * zstd 日志由多个各自带校验和的帧首尾相接组成，第一帧只放会话头这一行；不压缩时第一行是会话头。
 * 项目目录名由会话头的 cwd 算出（format.ts projectKey），打开会话时 DSH 核对日志所在目录和
 * 会话头 cwd 对得上（index.ts assertStoredIdentity），所以换目录要「换会话头 + 挪目录」一起做。
 * 本模块只做纯函数，不读写磁盘，不 import 任何 @deepseek-ai 包。
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const SAFE_UNIT = /^[A-Za-z0-9._-]$/

/** 一个 UTF-16 码元写成 `~XXXX`（DSH 的转义写法）。 */
const escapeUnit = code => '~' + code.toString(16).toUpperCase().padStart(4, '0')

/**
 * 项目目录名：DSH 的 projectKey。分隔符（/ \ :）连着的只记一个 `-`，安全字符照写，其余按 UTF-16 码元转义；
 * 去掉开头的 `-`，空了写 root，最长 251 个字符，前后各加 `--`。
 * @param {string} cwd 会话头里的目录。
 * @returns {string} 目录名。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else {
      readable += ch !== '~' && SAFE_UNIT.test(ch) ? ch : escapeUnit(code)
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 会话目录名：DSH 的 encodeSegment。安全字符照写，其余（含 `~`）按 UTF-16 码元转义；`.` 和 `..` 整段转义。
 * @param {string} id 会话 id。
 * @returns {string} 目录名。
 */
export function encodeSegment(id) {
  if (typeof id !== 'string' || id === '') throw new Error('cannot encode an empty path segment')
  if (id === '.') return '~002E'
  if (id === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    out += ch !== '~' && SAFE_UNIT.test(ch) ? ch : escapeUnit(id.charCodeAt(i))
  }
  return out
}

/**
 * 认日志文件名：`session.jsonl`、`session.v4.jsonl.zstd` 这类。
 * @param {string} name 文件名。
 * @returns {{ version: number, compression: 'zstd' | 'none' } | undefined} 不是日志时 undefined；没写版本的旧日志 version 为 -1。
 */
export function parseLogFileName(name) {
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
  if (match === null) return undefined
  return { version: match[1] === undefined ? -1 : Number(match[1]), compression: match[2] ? 'zstd' : 'none' }
}

/**
 * 从 start 开始的那一个 zstd 帧在哪里结束（RFC 8878 的帧结构；跳过帧也算一帧）。
 * @param {Buffer} buf 日志字节。
 * @param {number} start 帧的开头。
 * @returns {{ end: number, skippable: boolean }} 帧的结束位置，以及是不是跳过帧。
 * @throws {Error} 不是 zstd 帧或帧不完整时。
 */
function frameAt(buf, start) {
  let p = start
  if (p + 4 > buf.length) throw new Error('truncated zstd frame')
  const magic = buf.readUInt32LE(p)
  if (magic >>> 4 === 0x184D2A5) {
    if (p + 8 > buf.length) throw new Error('truncated skippable frame')
    p += 8 + buf.readUInt32LE(p + 4)
    if (p > buf.length) throw new Error('truncated skippable frame')
    return { end: p, skippable: true }
  }
  if (magic !== ZSTD_MAGIC) throw new Error('not a zstd frame')
  p += 4
  const descriptor = buf[p++]
  const fcsFlag = descriptor >> 6, singleSegment = (descriptor >> 5) & 1, checksum = (descriptor >> 2) & 1, dictFlag = descriptor & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  for (let last = 0; !last;) {
    if (p + 3 > buf.length) throw new Error('truncated zstd block')
    const blockHeader = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    last = blockHeader & 1
    const type = (blockHeader >> 1) & 3
    if (type === 3) throw new Error('reserved zstd block type')
    p += type === 1 ? 1 : blockHeader >>> 3
  }
  if (checksum) p += 4
  if (p > buf.length) throw new Error('truncated zstd frame')
  return { end: p, skippable: false }
}

/**
 * 依次给出每个 zstd 帧的结束位置。
 * @param {Buffer} buf 日志字节。
 * @returns {{ end: number, skippable: boolean }[]} 帧。
 * @throws {Error} 有帧不是 zstd 帧或不完整时。
 */
export function zstdFrames(buf) {
  const frames = []
  for (let start = 0; start < buf.length;) {
    const frame = frameAt(buf, start)
    frames.push(frame)
    start = frame.end
  }
  return frames
}

/** 一段 zstd 帧解开后的文字；有截断、不是 zstd 帧或解不开时抛错。 */
function decodeFrames(buf) {
  let start = 0
  const parts = []
  for (const frame of zstdFrames(buf)) {
    if (!frame.skippable) parts.push(zstdDecompressSync(buf.subarray(start, frame.end)))
    start = frame.end
  }
  return Buffer.concat(parts)
}

/**
 * 日志从 offset 开始的那一段是不是完整的事件：压缩时是一个或几个完整的 zstd 帧（offset 正好在帧边界上，最后一帧完整结束），
 * 解开以后是整行；不压缩时以换行结束。会话迁移撤回时据此判断搬后在末尾追加的内容能不能原样接到搬前原件后面。
 * @param {Buffer} buf 日志现在的字节。
 * @param {number} offset 搬时写下的日志长度。
 * @param {'zstd' | 'none'} compression 压缩方式。
 * @returns {boolean} 是完整的追加。
 */
export function completeTail(buf, offset, compression) {
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= buf.length) return false
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(compression === 'zstd' ? decodeFrames(bytes) : bytes)
  try {
    const prefix = decode(buf.subarray(0, offset))
    const tail = decode(buf.subarray(offset))
    if (!prefix.endsWith('\n') || !tail.endsWith('\n')) return false
    const last = JSON.parse(prefix.slice(prefix.lastIndexOf('\n', prefix.length - 2) + 1, -1))
    let seq = last.type === 'session' ? 0 : last.seq + 1
    for (const line of tail.slice(0, -1).split('\n')) {
      const event = JSON.parse(line)
      if (typeof event?.type !== 'string' || !event.type || event.type === 'session'
        || !Number.isSafeInteger(event.seq) || event.seq !== seq++ || !Number.isSafeInteger(event.time)
        || !Object.hasOwn(event, 'data')) return false
    }
    return true
  } catch {
    return false // 帧、UTF-8 或 JSON 不完整时保留现场。
  }
}

/** 会话头那一行的字节长度（压缩时是第一帧的长度）和内容。 */
function headerPart(buf, compression) {
  if (compression === 'zstd') {
    if (buf.length === 0) throw new Error('session log has no header frame')
    const first = frameAt(buf, 0)
    if (first.skippable) throw new Error('session log has no header frame')
    const line = zstdDecompressSync(buf.subarray(0, first.end)).toString('utf8')
    if (line.indexOf('\n') !== line.length - 1) throw new Error('first zstd frame is not exactly one header line')
    return { line, bytes: first.end }
  }
  const newline = buf.indexOf(0x0A)
  if (newline === -1) throw new Error('session log has no header line')
  return { line: buf.subarray(0, newline + 1).toString('utf8'), bytes: newline + 1 }
}

/**
 * 只读会话头：压缩时只解第一帧，后面的帧不碰（扫全部会话时用，日志再大也只解一小段）。
 * @param {Buffer} buf 日志字节。
 * @param {'zstd' | 'none'} compression 压缩方式。
 * @returns {Record<string, unknown>} 会话头。
 */
export function readHeader(buf, compression) {
  return JSON.parse(headerPart(buf, compression).line)
}

/**
 * 读整份日志：每一帧都解压后接起来，会话头单独解析。
 * @param {Buffer} buf 日志字节。
 * @param {'zstd' | 'none'} compression 压缩方式。
 * @returns {{ header: Record<string, unknown>, headerLine: string, headerBytes: number, text: string }} 日志内容。
 */
export function readLog(buf, compression) {
  const { line, bytes } = headerPart(buf, compression)
  let text
  if (compression === 'zstd') {
    let start = 0
    const parts = []
    for (const frame of zstdFrames(buf)) {
      if (!frame.skippable) parts.push(zstdDecompressSync(buf.subarray(start, frame.end)))
      start = frame.end
    }
    text = Buffer.concat(parts).toString('utf8')
  } else {
    text = buf.toString('utf8')
  }
  return { header: JSON.parse(line), headerLine: line, headerBytes: bytes, text }
}

/**
 * 只换会话头里的 cwd：压缩时重新压第一帧（带校验和），之后的字节原样接上；不压缩时换第一行。
 * @param {Buffer} buf 日志字节。
 * @param {'zstd' | 'none'} compression 压缩方式。
 * @param {string} fromCwd 会话头里现在的目录，必须一字不差。
 * @param {string} toCwd 新目录。
 * @returns {Buffer} 新日志。
 * @throws {Error} 会话头的目录不是 fromCwd，或会话头里认不出唯一的 cwd 字段时。
 */
export function rewriteHeaderCwd(buf, compression, fromCwd, toCwd) {
  const { line, bytes } = headerPart(buf, compression)
  const header = JSON.parse(line)
  if (header.cwd !== fromCwd) throw new Error(`session header cwd is ${JSON.stringify(header.cwd)}, not ${JSON.stringify(fromCwd)}`)
  const field = `"cwd":${JSON.stringify(fromCwd)}`
  if (line.split(field).length !== 2) throw new Error('session header cwd field is not written exactly once')
  const nextLine = line.replace(field, () => `"cwd":${JSON.stringify(toCwd)}`)
  const next = JSON.parse(nextLine)
  for (const key of new Set([...Object.keys(header), ...Object.keys(next)])) {
    if (key !== 'cwd' && JSON.stringify(header[key]) !== JSON.stringify(next[key])) throw new Error(`session header field ${key} changed`)
  }
  const head = compression === 'zstd'
    ? zstdCompressSync(Buffer.from(nextLine, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    : Buffer.from(nextLine, 'utf8')
  return Buffer.concat([head, buf.subarray(bytes)])
}

/**
 * 日志里还开着的轮次和后台任务：turn/start 没有对应 turn/end，job/registered 没有对应 job/settled。
 * @param {string} text 整份日志的文本。
 * @returns {{ openTurns: number[], openJobs: string[] }} 按出现顺序。
 */
export function sessionActivity(text) {
  const turns = new Set()
  const jobs = new Set()
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue } // 坏行不影响判断：DSH 读日志时自己会报损坏
    if (event?.type === 'turn/start') turns.add(event.data?.turn)
    else if (event?.type === 'turn/end') turns.delete(event.data?.turn)
    else if (event?.type === 'job/registered') jobs.add(event.data?.jobId)
    else if (event?.type === 'job/settled') jobs.delete(event.data?.jobId)
  }
  return { openTurns: [...turns], openJobs: [...jobs] }
}

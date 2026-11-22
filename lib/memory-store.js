/** 同项目记忆：Git 公共目录/真实工作区标识、限额、版本检查和原子写入。 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { realpath, open, mkdir, lstat, writeFile, rename, unlink, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { delegatedSession } from './session-scope.js'

const git = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')

/** 行配置：总文件字节上限和精确排除的预设名；whale-* 始终排除。 */
export function parseMemoryConfig(value = {}) {
  const { maxBytes = 16_384, skipPresets = ['whale', 'whale-dream'] } = value
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('memory maxBytes must be a positive safe integer')
  if (!Array.isArray(skipPresets) || skipPresets.some(p => typeof p !== 'string' || !p.trim())) throw new Error('memory skipPresets must be non-empty preset names')
  return { maxBytes, skipPresets: [...new Set(skipPresets)] }
}

/** 工具和提示词共用的顶层会话、当前预设和目录条件。 */
export function memoryEligible(state, config) {
  if (delegatedSession(state)) return false
  return typeof state?.cwd === 'string' && state.cwd !== '' && !config.skipPresets.includes(state.agentPreset) && !state.agentPreset?.startsWith('whale-')
}

/** 只执行 Git 的目录查询；不读项目内容，不运行项目 hooks。 */
export async function memoryProject(cwd) {
  const workspace = await realpath(cwd)
  const env = { ...process.env, LC_ALL: 'C' }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  let path = workspace, kind = 'workspace'
  try {
    const { stdout } = await git('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { env, maxBuffer: 64 * 1024 })
    path = await realpath(resolve(workspace, stdout.trim())); kind = 'git'
  } catch (error) {
    if (error.code !== 128 || !error.stderr?.includes('not a git repository')) throw error
  }
  return { key: memoryKey(kind, path), path, kind }
}

/**
 * 记忆目录名：项目种类和真实路径的 SHA-256（会话迁移按旧路径找旧记忆时也用它）。
 * @param {'workspace' | 'git'} kind 工作区目录，或 Git 公共目录。
 * @param {string} path 真实路径。
 * @returns {string} 目录名。
 */
export const memoryKey = (kind, path) => digest(`${kind}\0${path}`)

/**
 * 记忆文件开头的项目说明；读的时候必须和当前项目一字不差。
 * @param {{ path: string, kind: string }} project 项目。
 * @returns {string} 开头几行。
 */
export const memoryHeader = project => `# 项目记忆\n\n项目路径：${JSON.stringify(project.path)}${project.kind === 'git' ? '（Git 公共目录）' : ''}\n\n`

/**
 * 固定文件名的项目记忆。revision 来自整份文件；锁仅占写入事务，没有等待定时器。
 * @param {{root:string,maxBytes:number}} options 私有记忆根目录和含头部的字节上限。
 * @returns {object} view(cwd)、write(cwd,{content,revision})。
 */
export function createMemoryStore({ root, maxBytes }) {
  async function location(cwd) {
    const project = await memoryProject(cwd)
    const directory = join(root, project.key)
    try { if (!(await lstat(directory)).isDirectory()) throw new Error('项目记忆目录不能是链接或文件。') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return { project, directory, file: join(directory, 'MEMORY.md') }
  }
  const header = memoryHeader
  async function read(where) {
    let handle
    try { handle = await open(where.file, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (error.code === 'ENOENT') return { ...where, exists: false, content: '', bytes: 0, revision: 'empty' }
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('项目记忆必须是普通文件。')
      if (stat.size > maxBytes) throw new Error(`记忆文件超过 ${maxBytes} 字节，请先在文件中整理内容。`)
      const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maxBytes || bytesRead > stat.size) throw new Error('项目记忆在读取时变大，请重试。')
      const text = buffer.subarray(0, bytesRead).toString('utf8'), prefix = header(where.project)
      if (!text.startsWith(prefix)) throw new Error('记忆的项目路径头部不匹配，请保留文件开头的项目说明。')
      return { ...where, exists: true, content: text.slice(prefix.length), bytes: Buffer.byteLength(text), revision: digest(text) }
    } finally { await handle.close() }
  }
  return {
    async view(cwd) { return read(await location(cwd)) },
    async write(cwd, { content, revision }) {
      if (typeof content !== 'string' || typeof revision !== 'string') throw new Error('需要 content 和最近 memory_view 返回的 revision。')
      const where = await location(cwd)
      const text = header(where.project) + content.trimEnd() + '\n'
      if (Buffer.byteLength(text) > maxBytes) throw new Error(`记忆最多 ${maxBytes} 字节（含项目说明），请先整理、合并重复内容再写。`)
      await mkdir(where.directory, { recursive: true, mode: 0o700 })
      const lock = join(where.directory, '.write-lock')
      try { await mkdir(lock) }
      catch (error) { if (error.code === 'EEXIST') throw new Error('另一处正在写项目记忆，请重新读取后再试；进程异常退出遗留的 .write-lock 需手动清理。'); throw error }
      const temporary = join(where.directory, `.${randomUUID()}.tmp`)
      try {
        if ((await read(where)).revision !== revision) throw new Error('项目记忆已变化，请重新 memory_view 后合并再写。')
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
        await rename(temporary, where.file)
        return { ...where, exists: true, content: text.slice(header(where.project).length), bytes: Buffer.byteLength(text), revision: digest(text) }
      } finally {
        try {
          try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
        } finally { await rmdir(lock) }
      }
    },
  }
}

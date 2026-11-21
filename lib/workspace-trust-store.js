/**
 * 工作区信任（dsh-workbench/workspace-trust）的信任记录：`<数据目录>/workspace-trust.json`，
 * 形如 `{ "version": 1, "workspaces": [{ "path": "/workspace/project", "trustedAt": "…" }] }`，path 是工作区根的真实路径。
 * 每次判断都重读文件（很小），别的窗口或手改之后立即生效；文件坏了按全部没信任处理，不写回。
 * 写入先写临时文件再改名（lib/data-dir.js 的 writeJsonConfig）。本模块不 import 任何 @deepseek-ai 包。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { writeJsonConfig } from './data-dir.js'

/** 信任记录的文件名。 */
export const TRUST_FILE = 'workspace-trust.json'

/**
 * 校验并规范化文件内容。
 * @param {unknown} value 读出来的 JSON。
 * @returns {{ path: string, trustedAt: string }[]} 条目。
 * @throws {Error} 形状不对时。
 */
function parse(value) {
  if (value === null || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.workspaces)) throw new Error('bad trust file')
  return value.workspaces.map((entry) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || !isAbsolute(entry.path)
      || typeof entry.trustedAt !== 'string' || Number.isNaN(Date.parse(entry.trustedAt))) throw new Error('bad trust entry')
    return { path: entry.path, trustedAt: entry.trustedAt }
  })
}

/**
 * 建一份信任记录。
 * @param {string} dir 数据目录。
 * @param {{ clock?: () => number }} [options] 时钟（测试用）。
 * @returns {{ list: () => { path: string, trustedAt: string }[], isTrusted: (path: string) => boolean, trust: (path: string) => void, revoke: (path: string) => boolean }} 记录。
 */
export function createTrustStore(dir, { clock = Date.now } = {}) {
  const read = () => {
    try {
      return parse(JSON.parse(readFileSync(join(dir, TRUST_FILE), 'utf8')))
    } catch {
      return []
    }
  }
  const save = (workspaces) => writeJsonConfig(dir, TRUST_FILE, { version: 1, workspaces })
  return {
    list: read,
    isTrusted: (path) => read().some(entry => entry.path === path),
    trust(path) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('workspace path must be absolute')
      const workspaces = read()
      if (workspaces.some(entry => entry.path === path)) return
      save([...workspaces, { path, trustedAt: new Date(clock()).toISOString() }])
    },
    revoke(path) {
      const workspaces = read()
      const kept = workspaces.filter(entry => entry.path !== path)
      if (kept.length === workspaces.length) return false
      save(kept)
      return true
    },
  }
}

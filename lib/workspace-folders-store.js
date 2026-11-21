/**
 * 工作区文件夹和权限（dsh-workbench/workspace-folders，feat#159）的设置文件：`<数据目录>/workspace-folders.json`，
 * 形如 `{ "version": 1, "workspaces": { "<工作区 id>": { "externals": ["/abs"], "writableSubfolders": ["<子文件夹的工作区 id>"] } } }`。
 * 按工作区 id 存：官方「删除工作区」后再添加同一目录得到的是新工作区，旧设置不跟过去。
 * 官方的 registerWritableRoot 不写进会话日志、重启后要重新登记，所以要工作台自己存；会话加载时按这里重新登记。
 * 每次都重读文件（很小）；文件坏了按空设置处理，不写回。写入先写临时文件再改名（lib/data-dir.js 的 writeJsonConfig）。
 * 本模块不 import 任何 @deepseek-ai 包。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { writeJsonConfig } from './data-dir.js'

/** 设置文件的文件名。 */
export const FOLDERS_FILE = 'workspace-folders.json'

const isId = value => typeof value === 'string' && value !== ''
const isDir = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')

/**
 * 校验并规范化文件内容。
 * @param {unknown} value 读出来的 JSON。
 * @returns {Record<string, { externals: string[], writableSubfolders: string[] }>} 设置。
 * @throws {Error} 形状不对时。
 */
function parse(value) {
  if (value === null || typeof value !== 'object' || value.version !== 1 || value.workspaces === null
    || typeof value.workspaces !== 'object' || Array.isArray(value.workspaces)) throw new Error('bad folders file')
  const settings = {}
  for (const [id, entry] of Object.entries(value.workspaces)) {
    const externals = entry?.externals ?? []
    const writableSubfolders = entry?.writableSubfolders ?? []
    if (!isId(id) || !Array.isArray(externals) || !externals.every(isDir)
      || !Array.isArray(writableSubfolders) || !writableSubfolders.every(isId)) throw new Error('bad folders entry')
    settings[id] = { externals: [...externals], writableSubfolders: [...writableSubfolders] }
  }
  return settings
}

/**
 * 建一份设置文件的读写。
 * @param {string} dir 数据目录。
 * @returns {{ read: () => object, addExternal: (id: string, path: string) => void, removeExternal: (id: string, path: string) => boolean, setWritable: (mainId: string, subId: string, writable: boolean) => void, prune: (knownIds: string[]) => void }} 读写方法。
 */
export function createFoldersStore(dir) {
  const read = () => {
    try {
      return parse(JSON.parse(readFileSync(join(dir, FOLDERS_FILE), 'utf8')))
    } catch {
      return {}
    }
  }
  /** 存回去；没有任何设置的工作区不留条目。 */
  const save = (settings) => {
    const workspaces = Object.fromEntries(Object.entries(settings)
      .filter(([, entry]) => entry.externals.length > 0 || entry.writableSubfolders.length > 0))
    writeJsonConfig(dir, FOLDERS_FILE, { version: 1, workspaces })
  }
  const edit = (id, change) => {
    if (!isId(id)) throw new Error('workspace id must be a non-empty string')
    const settings = read()
    const entry = settings[id] ?? { externals: [], writableSubfolders: [] }
    if (change(entry) === false) return false
    settings[id] = entry
    save(settings)
    return true
  }
  return {
    read,
    addExternal(id, path) {
      if (!isDir(path)) throw new Error('external folder must be an absolute path')
      edit(id, entry => (entry.externals.includes(path) ? false : void entry.externals.push(path)))
    },
    removeExternal(id, path) {
      return edit(id, (entry) => {
        const kept = entry.externals.filter(dir => dir !== path)
        if (kept.length === entry.externals.length) return false
        entry.externals = kept
        return true
      })
    },
    setWritable(mainId, subId, writable) {
      if (!isId(subId)) throw new Error('subfolder workspace id must be a non-empty string')
      edit(mainId, (entry) => {
        const has = entry.writableSubfolders.includes(subId)
        if (has === writable) return false
        entry.writableSubfolders = writable ? [...entry.writableSubfolders, subId] : entry.writableSubfolders.filter(id => id !== subId)
        return true
      })
    },
    prune(knownIds) {
      const known = new Set(knownIds)
      const settings = read()
      let changed = false
      for (const [id, entry] of Object.entries(settings)) {
        if (!known.has(id)) {
          delete settings[id]
          changed = true
          continue
        }
        const kept = entry.writableSubfolders.filter(sub => known.has(sub))
        if (kept.length !== entry.writableSubfolders.length) {
          entry.writableSubfolders = kept
          changed = true
        }
      }
      if (changed) save(settings)
    },
  }
}

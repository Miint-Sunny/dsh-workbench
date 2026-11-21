import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './temp-dir.mjs'

/** 空工作区的 workspace v2 登记表，不需要桌面 App。 */
export async function emptyWorkspace(root) {
  const home = realpathSync(root ?? await tempDir('dwb-empty-move-'))
  const id = 'w1'
  const old = join(home, '旧文件夹')
  const work = join(home, 'new folder')
  for (const path of [old, work, join(home, 'sessions'), join(home, 'storages')]) mkdirSync(path)
  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], defaultWorkspaceId: id },
    tables: { workspaces: { [id]: { title: '旧文件夹', path: old, sessionIds: [] } } },
  }
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify(registry))
  return { home, old, work, id }
}

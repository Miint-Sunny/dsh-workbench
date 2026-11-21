/** 工作区迁移修改的登记、信任和文件夹字段。倒回时从备份和预览推导差异，保留当前文件里的其他值。 */
import { isDeepStrictEqual as equal } from 'node:util'

/** 把缺少的成员插回原有相邻成员之间，保留当前列表的顺序。 */
function insertOriginal(list, item, before) {
  if (list.includes(item)) return
  const index = before.indexOf(item)
  const next = before.slice(index + 1).find(key => list.includes(key))
  const prev = before.slice(0, index).reverse().find(key => list.includes(key))
  const at = next !== undefined ? list.indexOf(next) : prev !== undefined ? list.indexOf(prev) + 1 : Math.min(index, list.length)
  list.splice(at, 0, item)
}

export function restoreRegistry(value, before, plan, { retry, time, undo }) {
  const from = plan.source.workspaceId, to = plan.result.workspaceId
  const table = value.tables.workspaces, original = before.tables.workspaces[from]
  const row = table[to]
  if (!row || (row.path !== plan.result.path && !(retry && from === to && row.path === original.path))) return { code: 'path-changed' }
  if (Object.entries(table).some(([id, record]) => id !== from && record.path === original.path)) return { code: 'original-occupied' }
  if (plan.target.kind !== 'workspace') {
    if (row.path === original.path) return
    const extra = row.sessionIds.filter(id => !plan.result.sessionIds.includes(id))
    if (extra.length) return { code: 'new-sessions', count: extra.length }
    row.path = original.path
    if (row.title === plan.result.title) copyField(row, original, 'title')
    if (undo) row.updatedAt = time
    else copyField(row, original, 'updatedAt')
    return
  }
  if (Object.hasOwn(table, from)) {
    // 登记表整份原子改名；源行已经在原位时，这一步尚未发布或已还原。
    if (retry && table[from].path === original.path && value.global.workspaceIds.includes(from)) return
    return { code: 'original-occupied' }
  }
  table[from] = original
  insertOriginal(value.global.workspaceIds, from, before.global.workspaceIds)
  const added = new Set(plan.result.sessionIds.filter(id => !before.tables.workspaces[to].sessionIds.includes(id)))
  row.sessionIds = row.sessionIds.filter(id => !added.has(id))
  if (before.global.defaultWorkspaceId === from && value.global.defaultWorkspaceId === to) value.global.defaultWorkspaceId = from
}

function copyField(record, original, key) {
  if (Object.hasOwn(original, key)) record[key] = original[key]
  else delete record[key]
}

export function restoreTrust(value, before, plan) {
  const list = value.workspaces, from = plan.source.path, to = plan.result.path
  const original = before.workspaces.find(entry => entry.path === from)
  const source = list.find(entry => entry.path === from)
  if (source && !equal(source, original)) return { code: 'original-occupied' }
  if (plan.workbench.trust.action === 'replace') {
    const index = list.findIndex(entry => entry.path === to)
    if (index < 0) return source ? undefined : { code: 'trust-changed' }
    if (!equal(list[index], { ...original, path: to })) return { code: 'trust-changed' }
    if (source) list.splice(index, 1)
    else list[index] = original
  } else if (!source) {
    const paths = list.map(entry => entry.path)
    insertOriginal(paths, from, before.workspaces.map(entry => entry.path))
    list.splice(paths.indexOf(from), 0, original)
  }
}

/** 合并时目标接收源设置，其他工作区对源的引用转向目标。 */
export function mergeFolderSettings(settings, from, to) {
  const source = settings[from] ?? {}, target = settings[to] ?? {}
  settings[to] = {
    externals: [...new Set([...(target.externals ?? []), ...(source.externals ?? [])])],
    writableSubfolders: [...new Set([...(target.writableSubfolders ?? []), ...(source.writableSubfolders ?? [])])].filter(id => id !== to && id !== from),
  }
  delete settings[from]
  for (const entry of Object.values(settings)) {
    if (entry.writableSubfolders?.includes(from)) entry.writableSubfolders = [...new Set(entry.writableSubfolders.map(id => id === from ? to : id))]
  }
}

export function restoreFolders(value, before, plan) {
  const original = before.workspaces, after = structuredClone(original), current = value.workspaces
  mergeFolderSettings(after, plan.source.workspaceId, plan.result.workspaceId)
  for (const id of new Set([...Object.keys(original), ...Object.keys(after)])) {
    if (equal(original[id], after[id])) continue
    if (equal(current[id], after[id])) {
      copyField(current, original, id)
      continue
    }
    if (equal(current[id], original[id])) continue
    if (!after[id] || !current[id]) return { code: 'folders-changed' }
    const old = original[id] ?? {}
    for (const key of new Set([...Object.keys(old), ...Object.keys(after[id])])) {
      if (equal(old[key], after[id][key])) continue
      if (equal(current[id][key], after[id][key])) copyField(current[id], old, key)
      else if (['externals', 'writableSubfolders'].includes(key)) {
        const previous = old[key] ?? [], written = after[id][key] ?? []
        const list = (current[id][key] ?? []).filter(item => !written.includes(item) || previous.includes(item))
        for (const item of previous) if (!written.includes(item)) insertOriginal(list, item, previous)
        if (list.length || old[key]) current[id][key] = list
        else delete current[id][key]
      }
    }
    if (!original[id] && !Object.keys(current[id]).length) delete current[id]
  }
}

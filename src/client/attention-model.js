/** Project only the interaction currently selected by the official Session status owner. */
export function createAttentionStore(read, now = Date.now) {
  let snapshot = { phase: 'loading', rows: [] }, tracked = new Map(), generation, established = false, suspended = false, order = 0
  let unconfirmed = new Map()
  const listeners = new Set()
  const publish = (phase, rows) => {
    const keys = ['id', 'key', 'kind', 'title', 'cwd', 'child', 'parentId', 'receivedAt', 'unconfirmed']
    if (phase === snapshot.phase && rows.length === snapshot.rows.length
      && rows.every((row, i) => keys.every(key => row[key] === snapshot.rows[i][key]))) return
    snapshot = { phase, rows }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    update: () => {
      const value = read()
      const connected = value.connected && value.generation !== undefined
      if (!connected || !value.ready) {
        if (established && !suspended) unconfirmed = new Map(snapshot.rows.map(row => [row.id, row]))
        suspended = true
        publish(!connected && established ? 'offline' : 'loading', snapshot.rows)
        return
      }
      const baseline = !established || suspended || generation !== value.generation
      if (baseline) { if (established && !suspended) unconfirmed = new Map(snapshot.rows.map(row => [row.id, row])); tracked = new Map(); order = 0 }
      const synchronizing = baseline || unconfirmed.size > 0
      const archived = new Set(value.archivedIds), next = new Map(), rows = []
      const ids = new Set([...value.list.ids, ...value.statuses.keys()])
      for (const id of ids) {
        const pending = value.statuses.get(id)?.pendingInteraction
        if (!pending || !['approval', 'question', 'plan-review'].includes(pending.kind) || archived.has(id)) continue
        const entry = value.list.byId[id]
        const address = !entry || entry.origin === 'subagent' ? value.addressFor(id) : undefined
        const parentId = address?.parentSessionId ?? (entry?.origin === 'subagent' ? entry.parentSessionId : undefined)
        const parent = parentId === undefined ? undefined : value.list.byId[parentId]
        if (!entry && !parent || parentId !== undefined && archived.has(parentId)) continue
        const previous = tracked.get(id)
        const observation = previous?.key === pending.key ? previous : { key: pending.key, order: order++, receivedAt: synchronizing ? null : now() }
        unconfirmed.delete(id)
        next.set(id, observation)
        rows.push({ id, key: pending.key, kind: pending.kind, title: entry?.displayTitle ?? null,
          cwd: entry?.cwd ?? parent?.cwd ?? '', child: entry?.origin === 'subagent' || address !== undefined,
          parentId, receivedAt: observation.receivedAt, order: observation.order })
      }
      rows.sort((left, right) => left.order - right.order)
      tracked = next; generation = value.generation; established = true; suspended = false
      for (const [id, old] of unconfirmed) {
        if (archived.has(id) || old.parentId && archived.has(old.parentId) || !value.list.byId[id] && !(old.parentId && value.list.byId[old.parentId])) unconfirmed.delete(id)
      }
      publish(unconfirmed.size ? 'syncing' : 'ready', [...rows, ...[...unconfirmed.values()].map(row => ({ ...row, unconfirmed: true }))])
    },
  }
}

/** Filter without changing the official interaction order or unread marks. */
export function attentionFilter(rows, { kind = 'all', query = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase()
  return rows.filter(row => (kind === 'all' || kind === row.kind) && `${row.title ?? ''} ${row.cwd}`.toLocaleLowerCase().includes(needle))
}

/** Choose the next still-pending visible Session; unknown or disconnected state cannot navigate. */
export function attentionNext(snapshot, currentId, filter) {
  if (snapshot.phase !== 'ready') return undefined
  const rows = attentionFilter(snapshot.rows, filter)
  return rows[(rows.findIndex(row => row.id === currentId) + 1) % rows.length]?.id
}

/** Dictionary key for why attentionNext found nothing; a state that is not ready never claims the list is empty. */
export function attentionNextNotice(snapshot) {
  if (snapshot.phase !== 'ready') return 'attention.unavailable'
  return snapshot.rows.length ? 'attention.noMatch' : 'attention.empty'
}

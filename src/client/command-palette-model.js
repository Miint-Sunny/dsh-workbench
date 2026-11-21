/** Build a directory without retaining or opening any session. */
export function paletteItems({
  commands = [],
  sessions = [],
  archivedIds = [],
  actions = [],
  rightEntries = [],
  panels = [],
  hasSession = true,
}) {
  const archived = new Set(archivedIds)
  return [
    ...(hasSession ? commands : []).map((row) => ({
      id: `command:${row.name}`,
      kind: 'command',
      name: row.name,
      label: row.label ?? `/${row.name}`,
      detail: row.description ?? '',
    })),
    ...sessions
      .filter((row) => row.origin !== 'subagent' && !row.blank && !archived.has(row.id))
      .map((row) => ({
        id: `session:${row.id}`,
        kind: 'session',
        name: row.id,
        label: row.displayTitle,
        updatedAt: row.updatedAt ?? 0,
        status: row.status,
        detail: (row.cwd ?? '')
          .replace(/[/\\]+$/, '')
          .split(/[/\\]/)
          .at(-1),
        search: row.cwd ?? '',
      })),
    ...actions
      .filter((row) => hasSession || !row.requiresSession)
      .map((row) => ({
        ...row,
        id: `action:${row.id}`,
        name: row.id,
        kind: 'action',
        detail: row.detail ?? '',
      })),
    ...(hasSession ? rightEntries : []).map((row) => ({
      ...row,
      id: `right:${row.providerId}:${row.id}`,
      kind: 'right',
      name: row.kind,
      detail: row.detail ?? '',
    })),
    ...panels.map((row) => ({
      ...row,
      id: `panel:${row.id}`,
      kind: 'panel',
      name: row.id,
      detail: row.detail ?? '',
    })),
  ]
}

const PALETTE_GROUP_ORDER = ['session', 'action', 'right', 'panel', 'command']
export const PALETTE_FILTERS = ['all', 'session', 'action', 'interface', 'command', 'shortcut']

/**
 * The shortcut tab lists every command, then the read-only fixed keys. Held modifiers narrow to the rows
 * that use them; a pressed combination narrows to its matches.
 */
export function paletteShortcutItems(catalog, fixed, captured, held) {
  const rows = [
    ...catalog.map((shortcut) => ({ shortcut, fixed: false })),
    ...fixed.map((shortcut) => ({ shortcut, fixed: true })),
  ]
  if (held) return rows.filter(({ shortcut }) => held.every((key) => shortcut.keys?.includes(key))).map(paletteShortcutRow)
  if (!captured) return rows.map(paletteShortcutRow)
  const conflicts = new Set(captured.conflicts)
  return rows.filter(({ shortcut }) => conflicts.has(shortcut.id)).map(paletteShortcutRow)
}

/** Commands a text search in the overview can also run: those not already listed as an action or a sidebar entry. */
export function paletteSearchableCommands(catalog, items) {
  const listed = new Set(items.flatMap((row) => (row.shortcut ? [row.shortcut.id] : [])))
  return catalog.filter((row) => !listed.has(row.id)).map((shortcut) => paletteShortcutRow({ shortcut, fixed: false }))
}

function paletteShortcutRow({ shortcut, fixed }) {
  return { id: `shortcut:${shortcut.id}`, name: shortcut.id, label: shortcut.label,
    kind: 'shortcut', detail: '', shortcut, fixed }
}

/**
 * What a key means while the shortcut tab listens for keys. Tab, Enter and the arrows still move through the
 * list and Esc stops listening. Every other key is a query, and a modifier on its own reports what is held.
 */
export function paletteKeyCapture(event) {
  const { key, code, ctrlKey, altKey, shiftKey, metaKey } = event
  if (event.isComposing || event.keyCode === 229 || !code || key === 'AltGraph' || key === 'Process') return { type: 'pass' }
  const modifiers = [ctrlKey && 'control', altKey && 'alt', shiftKey && 'shift', metaKey && 'meta'].filter(Boolean)
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key) || /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(code)) {
    return { type: 'modifier', modifiers }
  }
  if (!ctrlKey && !altKey && !metaKey) {
    if (key === 'Escape') return { type: 'exit' }
    if (key === 'Tab' || !shiftKey && ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
      return { type: 'pass' }
    }
  }
  return { type: 'binding', binding: { code, modifiers } }
}

/** DSH 0.2.2-rc.1 exposes native menu invocation on the registry. */
export function paletteShortcutInvocation(shortcuts, id, context) {
  const registry = shortcuts.registry
  const owner = typeof shortcuts.invoke === 'function' ? shortcuts : registry
  const command = registry?.commands?.get?.(id)
  if (typeof owner?.invoke !== 'function' || owner === registry && !command) return {}
  if (command) {
    if (context.modal !== null && !command.modals.includes(context.modal)) return {}
    const resolution = command.resolve({ ...context, source: 'menu' })
    if (resolution.status !== 'handled') {
      return { reason: /^[a-z-]+$/u.test(resolution.reason ?? '') ? undefined : resolution.reason }
    }
  }
  return { run: () => owner.invoke(id, context) }
}

/** The official shortcut window searches aliases and the key combination; rows here match the same way. */
function paletteShortcutNames(shortcut) {
  if (!shortcut) return []
  const keys = (shortcut.keys ?? []).filter((key) => key !== '+')
  const aria = shortcut.aria?.replace('Meta', 'Cmd')
  return [
    ...(shortcut.aliases ?? []),
    ...(keys.length ? [keys.join('+'), keys.join('')] : []),
    ...(aria ? [aria, aria.replaceAll('+', '')] : []),
  ]
}

function paletteSearchNames(row) {
  return [row.label, ...(row.kind === 'command' ? [row.name] : []), ...paletteShortcutNames(row.shortcut)].map((value) =>
    value.toLocaleLowerCase(),
  )
}

/** Rank names before words, substrings, and explanatory text. */
function paletteMatchRank(row, needle) {
  const names = paletteSearchNames(row)
  if (names.some((name) => name.startsWith(needle))) return 0
  if (names.some((name) => name.split(/[\s/\\._:+-]+/).some((word) => word.startsWith(needle))))
    return 1
  if (names.some((name) => name.includes(needle))) return 2
  return `${row.detail} ${row.search ?? ''}`.toLocaleLowerCase().includes(needle) ? 3 : Infinity
}

/** Filter and rank the already loaded directory; a slash always narrows to commands. */
export function paletteFilter(items, query, kind = 'all') {
  const slash = kind !== 'shortcut' && query.trimStart().startsWith('/')
  const needle = (slash ? query.trimStart().slice(1) : query).trim().toLocaleLowerCase()
  const accepted = slash ? 'command' : kind
  return items
    .filter(
      (row) =>
        (accepted === 'all' && (needle !== '' || row.kind !== 'shortcut')) ||
        row.kind === accepted ||
        (accepted === 'interface' && ['right', 'panel'].includes(row.kind)),
    )
    .map((row, index) => ({ row, index, rank: needle ? paletteMatchRank(row, needle) : 0 }))
    .filter((match) => Number.isFinite(match.rank))
    .sort(
      (a, b) =>
        (kind === 'shortcut' ? Boolean(b.row.shortcut.keys?.length) - Boolean(a.row.shortcut.keys?.length) : 0) ||
        a.rank - b.rank ||
        (a.row.kind === 'session' && b.row.kind === 'session'
          ? b.row.updatedAt - a.row.updatedAt
          : 0) ||
        (!needle
          ? PALETTE_GROUP_ORDER.indexOf(a.row.kind) - PALETTE_GROUP_ORDER.indexOf(b.row.kind)
          : 0) ||
        a.index - b.index,
    )
    .map((match) => match.row)
}

const PALETTE_GROUP_LIMIT = 5
const PALETTE_ROW_HEIGHT = 34
const PALETTE_LIST_PADDING = 12
const PALETTE_LIST_MAX_HEIGHT = 430
const PALETTE_LIST_VIEWPORT_SHARE = 0.52

/** Rows that fit the result list at this window height. Matches `.dwb-cmd-results`. */
export function paletteCapacity(windowHeight) {
  const height = Math.min(windowHeight * PALETTE_LIST_VIEWPORT_SHARE, PALETTE_LIST_MAX_HEIGHT)
  return Math.floor((height - PALETTE_LIST_PADDING) / PALETTE_ROW_HEIGHT)
}

/** Give unused rows to the first groups that still hide some. A title or a more button costs one row. */
function fillPaletteGroups(groups, capacity) {
  const cost = (group) => 1 + group.items.length + (group.items.length < group.rows.length ? 1 : 0)
  let spare = capacity - groups.reduce((sum, group) => sum + cost(group), 0)
  for (const group of groups) {
    if (spare <= 0) return
    const hidden = group.rows.length - group.items.length
    if (hidden === 0) continue
    const added = Math.min(spare, hidden)
    group.items = group.rows.slice(0, group.items.length + added)
    spare += added === hidden ? 1 - added : -added
  }
}

/**
 * Exact leading names break ties between groups; each group retains its own ranking and expansion.
 * Only the overview limits groups; a filter or a slash query shows one kind, so every match is listed.
 */
export function paletteGroups(items, query, kind = 'all', expanded = new Set(), capacity = 0) {
  const groups = new Map()
  const overview = kind === 'all' && !query.trimStart().startsWith('/')
  for (const row of paletteFilter(items, query, kind)) {
    if (!groups.has(row.kind)) groups.set(row.kind, { id: row.kind, rows: [], items: [], total: 0 })
    const group = groups.get(row.kind)
    group.total++
    group.rows.push(row)
    if (!overview || expanded.has(row.kind) || group.items.length < PALETTE_GROUP_LIMIT) group.items.push(row)
  }
  const result = [...groups.values()]
  const needle = query.trim().replace(/^\//, '').toLocaleLowerCase()
  if (needle) {
    result.sort((a, b) =>
      paletteMatchRank(a.items[0], needle) - paletteMatchRank(b.items[0], needle)
      || Number(paletteSearchNames(b.items[0]).includes(needle))
        - Number(paletteSearchNames(a.items[0]).includes(needle)))
  }
  fillPaletteGroups(result, result.length === 1 ? Infinity : capacity)
  return result.map(({ rows: _rows, ...group }) => group)
}

/** Opening an unfiltered palette selects New session without waiting for command discovery. */
export function paletteDefaultSelection(groups, query, kind) {
  const rows = groups.flatMap((group) => group.items)
  if (
    !query.trim() &&
    ['all', 'action'].includes(kind) &&
    rows.some((row) => row.id === 'action:session.new')
  )
    return 'action:session.new'
  return rows[0]?.id
}

/** Own one open directory generation and its optional native recording session. */
export function createPaletteController(deps) {
  let state = {
    open: false,
    items: [],
    shortcuts: [],
    fixed: [],
    kind: 'all',
    recording: false,
    captured: undefined,
    held: undefined,
    loading: false,
    error: false,
    notice: undefined,
    noticeDetail: undefined,
    hasSession: false,
  }
  let generation = 0,
    request,
    target,
    commands = [],
    stopWatching,
    stopFixed
  let recordingQueue = Promise.resolve(), recordingRevision = 0
  const listeners = new Set()
  const publish = (patch) => {
    state = { ...state, ...('notice' in patch ? { noticeDetail: undefined } : {}), ...patch }
    for (const listener of listeners) listener()
  }
  const sameTarget = () => {
    const current = deps.target()
    return current?.id === target?.id && current?.binding === target?.binding
  }
  const entries = () => {
    const { shortcuts = [], ...source } = deps.entries()
    return { shortcuts, items: paletteItems({ ...source, commands, hasSession: target !== undefined }) }
  }
  const captureBinding = (input) => {
    if (!state.recording) return
    try {
      const { keys, conflicts } = deps.describeBinding(input)
      publish({ captured: { input, keys, conflicts }, held: undefined, notice: undefined })
    } catch {
      publish({ notice: 'shortcutCaptureFailed' })
    }
  }
  /** Keys come from the official formatter: it labels the modifiers of any binding, so the letter is dropped. */
  const holdModifiers = (modifiers) => {
    if (!state.recording || !modifiers.length && !state.held) return
    try {
      publish({ held: modifiers.length ? deps.describeBinding({ code: 'KeyA', modifiers }).keys.slice(0, -1) : undefined })
    } catch {
      publish({ held: undefined })
    }
  }
  const setRecording = (value) => {
    if (value === state.recording || value && (!state.open || state.kind !== 'shortcut')) return
    const stamp = ++recordingRevision
    recordingQueue = recordingQueue.then(() => deps.recording(value)).catch((error) => {
      deps.recordingError?.(error)
      if (stamp !== recordingRevision || !state.open) return
      if (value) setRecording(false)
      publish({ notice: 'shortcutRecordingFailed' })
    })
    publish({ recording: value, captured: undefined, held: undefined, notice: undefined })
  }
  const watchFixedShortcuts = (active) => {
    stopFixed?.()
    stopFixed = active ? deps.watchFixedShortcuts?.(() => {
      publish({ fixed: deps.fixedShortcuts?.() ?? [] })
      if (state.captured) captureBinding(state.captured.input)
    }) : undefined
    publish({ fixed: active ? deps.fixedShortcuts?.() ?? [] : [] })
  }
  const close = () => {
    generation++
    request?.abort()
    stopWatching?.()
    stopWatching = undefined
    commands = []
    setRecording(false)
    watchFixedShortcuts(false)
    publish({ open: false, items: [], shortcuts: [], loading: false, error: false, notice: undefined })
  }
  const open = async () => {
    request?.abort()
    request = new AbortController()
    const signal = request.signal,
      stamp = ++generation
    target = deps.target()
    commands = []
    publish({
      open: true,
      ...entries(),
      kind: state.open ? state.kind : 'all',
      loading: target !== undefined,
      error: false,
      notice: undefined,
      hasSession: target !== undefined,
    })
    if (!stopWatching && deps.watch)
      stopWatching = deps.watch(
        () => controller.refresh(),
        () => {
          void open()
        },
        close,
      )
    if (target === undefined) return
    try {
      const result = await deps.commands(target, signal)
      if (stamp !== generation || signal.aborted || !sameTarget()) return
      commands = result
      publish({ ...entries(), loading: false })
    } catch {
      if (stamp === generation && !signal.aborted) publish({ loading: false, error: true })
    }
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open,
    close,
    toggle: () => (state.open ? close() : open()),
    setKind: (kind) => {
      if (kind === state.kind) return
      setRecording(false)
      publish({ kind, notice: undefined })
      watchFixedShortcuts(kind === 'shortcut')
    },
    /** The ⌘/ entry: open on the shortcut tab, move to it, or close when already there. */
    showShortcuts: () => {
      if (state.open && state.kind === 'shortcut') {
        close()
        return
      }
      if (!state.open) void open()
      controller.setKind('shortcut')
    },
    setRecording,
    captureBinding,
    holdModifiers,
    compose: (text) => {
      if (!state.open || !text.trim()) return
      close()
      deps.startSession(text)
    },
    refresh: () => {
      if (!state.open) return
      if (!sameTarget()) {
        void open()
        return
      }
      const next = entries()
      const input = next.shortcuts !== state.shortcuts ? state.captured?.input : undefined
      publish(next)
      if (input) captureBinding(input)
    },
    choose: async (id) => {
      if (!state.open) return
      const index = entries()
      const rows = state.kind === 'shortcut'
        ? paletteShortcutItems(index.shortcuts, state.fixed)
        : [...index.items, ...paletteSearchableCommands(index.shortcuts, index.items)]
      const row = rows.find((item) => item.id === id)
      if (row === undefined) {
        publish({ notice: 'unavailable' })
        return
      }
      if (row.kind === 'shortcut') {
        if (row.fixed) {
          publish({ notice: 'shortcutFixed' })
          return
        }
        let stamp = generation
        try {
          const invocation = deps.shortcutInvocation(row.name)
          if (!invocation.run) {
            publish({ notice: 'shortcutUnavailable', noticeDetail: invocation.reason })
            return
          }
          close()
          stamp = generation
          // Closing hands focus back to where the palette opened from. Wait for that, or a command that focuses its own field loses it.
          await deps.afterClose?.()
          if (stamp !== generation) return
          if (await invocation.run() === false) throw new Error('shortcut not invoked')
        } catch {
          if (stamp !== generation) return
          if (!state.open) {
            void open()
            controller.setKind('shortcut')
          }
          publish({ notice: 'shortcutUnavailable' })
        }
        return
      }
      if (row.kind === 'session') {
        close()
        deps.openSession(row.name)
        return
      }
      if (row.kind === 'action') {
        if (row.requiresSession && (!sameTarget() || target === undefined)) {
          publish({ notice: 'target' })
          return
        }
        close()
        deps.openAction(row.name)
        return
      }
      if (row.kind === 'panel') {
        close()
        deps.openPanel(row.name)
        return
      }
      if (row.kind === 'right') {
        if (!sameTarget() || target === undefined) {
          publish({ notice: 'target' })
          return
        }
        close()
        deps.openRight(row.name)
        return
      }
      if (!sameTarget() || target === undefined) {
        publish({ notice: 'target' })
        return
      }
      if (state.loading) return
      const stamp = generation,
        selected = target,
        signal = request.signal
      publish({ loading: true, notice: undefined })
      try {
        const available = await deps.commands(selected, signal)
        if (stamp !== generation || signal.aborted) return
        if (!sameTarget()) {
          publish({ loading: false, notice: 'target' })
          return
        }
        if (deps.target().running) {
          publish({ loading: false, notice: 'running' })
          return
        }
        if (!available.some((item) => item.name === row.name)) {
          publish({ loading: false, notice: 'unavailable' })
          return
        }
        const input = deps.input(selected),
          snapshot = input.state.getSnapshot()
        if (
          snapshot.phase !== 'plain' ||
          snapshot.draft !== '' ||
          snapshot.attachmentIds.length ||
          snapshot.occurrences.length
        ) {
          publish({ loading: false, notice: 'draft' })
          return
        }
        close()
        const closedGeneration = generation
        if (
          !(await deps.focusInput(selected, input)) ||
          generation !== closedGeneration ||
          !sameTarget()
        )
          return
        const fresh = input.state.getSnapshot()
        if (
          deps.target().running ||
          fresh.phase !== 'plain' ||
          fresh.draft !== '' ||
          fresh.attachmentIds.length ||
          fresh.occurrences.length
        ) {
          deps.refused(input, 'draft')
          return
        }
        // Focus restoration must finish before setting the draft, or it restores the old caret at zero.
        input.actions.setDraft(`/${row.name}`)
      } catch {
        if (stamp === generation && !signal.aborted) publish({ loading: false, error: true })
      }
    },
  }
  return controller
}

/** Terminal input and unrelated modals keep their keys even when Desktop dispatch bypasses region filtering. */
export function paletteShortcutEnabled({ region, modal, ownDialog }, open, recording = false) {
  return !recording && region !== 'terminal' && (modal == null || modal === 'sidebar' || (open && ownDialog))
}

/** A persisted blank draft is not an opened conversation, even while the composer retains it. */
export function paletteHasMainSession(entry) {
  return entry !== undefined && entry.blank !== true && entry.retainedBy?.mainView > 0
}

/**
 * ⌘/ 交给谁。焦点在侧边栏时官方也记成 modal（'sidebar'），但那不是弹窗，照常开面板。
 * @param {string|null|undefined} modal 官方快捷键上下文里的 modal。
 * @param {boolean} paletteOpen 命令面板是否开着。
 * @returns {'official'|'palette'} 走官方的快捷键窗口，或走命令面板的「快捷键」页。
 */
export function shortcutsCommandOwner(modal, paletteOpen) {
  if (modal === 'settings' || modal === 'shortcuts') return 'official'
  return modal != null && modal !== 'sidebar' && !paletteOpen ? 'official' : 'palette'
}

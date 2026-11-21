import { groupNewTabEntries, readNewTabLayout, writeNewTabLayout, readNewTabEntries, guideTabShouldClose, NEW_TAB_GUIDE_TYPE } from './new-tab-model.js'
import { newTabEntryPin, addNewTabPin, removeNewTabPin, moveNewTabPin, createNewTabPinStore, NEW_TAB_PIN_LIMIT, NEW_TAB_PINS_STORAGE } from './new-tab-model.js'
import { mountModuleStyle } from './style.js'

const NEW_TAB_INJECT = ['shortcuts', 'contextMenus']
const NEW_TAB_PIN_MENU = 'dsh-workbench-new-tab-pin'
const NEW_TAB_ZH = {
  'newTab.title': '新标签页', 'newTab.layout': '排版', 'newTab.common': '常用',
  'newTab.list': '列表', 'newTab.columns': '两列', 'newTab.workspace': '工作区',
  'newTab.conversation': '对话', 'newTab.inspect': '检查', 'newTab.settings': '设置',
  'newTab.other': '其他', 'newTab.pinned': '已置顶',
  'newTab.pin': '置顶', 'newTab.unpin': '取消置顶',
  'newTab.pinLimit': '最多 {limit} 个',
  'newTab.pinLimitHidden': '最多 {limit} 个，其中 {hidden} 个仅在其他会话中显示',
}
const NEW_TAB_EN = {
  'newTab.title': 'New tab', 'newTab.layout': 'Layout', 'newTab.common': 'Frequent',
  'newTab.list': 'List', 'newTab.columns': 'Two columns', 'newTab.workspace': 'Workspace',
  'newTab.conversation': 'Conversation', 'newTab.inspect': 'Inspection', 'newTab.settings': 'Settings',
  'newTab.other': 'Other', 'newTab.pinned': 'Pinned',
  'newTab.pin': 'Pin', 'newTab.unpin': 'Unpin',
  'newTab.pinLimit': 'Up to {limit} pins',
  'newTab.pinLimitHidden': 'Up to {limit} pins. {hidden} only appear in other sessions.',
}
const NEW_TAB_ICONS = {
  files: 'IconFolderOpenOutlineRegular', git: 'IconBranchOutlineRegular', 'forge-panel': 'IconCompareSplitOutlineRegular', browser: 'IconGlobeOutlineRegular', terminal: 'IconCodeOutlineRegular',
  subagent: 'IconChecklistOutlineRegular', sidechat: 'IconQueueOutlineRegular',
  wbcontext: 'IconContextInjectionOutlineRegular', wblocalreview: 'IconSearchOutlineRegular',
  wbdesign: 'IconEditOutlineRegular', 'session-inspector-log': 'IconDataOutlineRegular',
  wbmcp: 'IconCordisPluginOutlineRegular', wbrules: 'IconShieldOutlineRegular',
}
const NEW_TAB_CSS = `
.dwb-nt-tab-title{display:contents}
.dwb-nt-root{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:10px 16px 24px;container:dwb-new-tab/inline-size;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}
.dwb-nt-switch{display:flex;justify-content:flex-end;margin-bottom:10px}
.dwb-nt-heading{margin:16px 8px 4px;font-size:14px;font-weight:400;color:var(--dsw-alias-label-tertiary);line-height:20px}
.dwb-nt-group:first-of-type>.dwb-nt-heading{margin-top:0}
.dwb-nt-row{display:flex;align-items:center;gap:10px;width:100%;height:34px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer;box-sizing:border-box}
.dwb-nt-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-nt-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dwb-nt-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0;flex:none;color:var(--dsw-alias-label-secondary)}.dwb-nt-icon svg{display:block;width:16px;height:16px}
.dwb-nt-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:20px}
.dwb-nt-keys{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.dwb-nt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dwb-nt-grid>.dwb-nt-row{height:40px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md)}
.dwb-nt-favorites{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:16px}
.dwb-nt-favorites>.dwb-nt-row{flex-direction:column;justify-content:center;gap:6px;height:68px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dwb-nt-favorites .dwb-nt-title{flex:none;max-width:100%;text-align:center}.dwb-nt-favorites .dwb-nt-keys{display:none}
.dwb-nt-favorites>.dwb-nt-row[data-dwb-nt-dragging=true]{opacity:.4}
.dwb-nt-favorites>.dwb-nt-row[data-dwb-nt-over=true]{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.dwb-nt-limit{padding:2px 8px 6px;max-inline-size:min(240px,80vw);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:normal}
.dwb-nt-terminal{cursor:default}.dwb-nt-terminal-main{display:flex!important;align-items:center;justify-content:flex-start;gap:10px;flex:1;min-width:0;height:100%!important;padding:0!important;border:0!important;font:inherit!important;color:inherit!important;background:transparent!important}.dwb-nt-terminal-main .dwb-nt-title{text-align:start}.dwb-nt-shell{display:inline-flex!important;align-items:center;justify-content:center;padding:0!important;min-width:22px!important;width:22px;height:22px!important;min-height:22px!important}.dwb-nt-shell svg{display:block}
@container dwb-new-tab (max-width:420px){.dwb-nt-favorites{grid-template-columns:repeat(3,minmax(0,1fr))}.dwb-nt-grid{grid-template-columns:minmax(0,1fr)}}
`

/** The terminal provider discovers shells only while its compact menu is open. */
function NewTabTerminal({ entry, shortcut, tab, sessionId, app, menu }) {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ phase: 'loading' })
  // Context access returns a fresh service facade; the loader stays stable for this session.
  const loadShells = useCallback(signal => app.ctx.get('webTerminals').launchShells(sessionId, signal), [app.ctx, sessionId])
  const t = app.ctx.locale.bind('sidebarTerminal')
  useEffect(() => {
    if (!open) return
    const lifetime = new AbortController()
    Promise.resolve().then(() => loadShells(lifetime.signal)).then(
      choices => { if (!lifetime.signal.aborted) setState({ phase: 'ready', choices }) },
      error => { if (!lifetime.signal.aborted) setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => lifetime.abort()
  }, [open, attempt, loadShells])
  const items = state.phase === 'ready'
    ? state.choices.shells.map(shell => ({ id: shell.path, label: shell.name }))
    : state.phase === 'loading' ? [{ id: 'loading', label: t('shellLoading'), disabled: true }]
      : [{ id: 'failed', label: t('failed', { message: state.message }), disabled: true }, { id: 'retry', label: t('retry') }]
  return h('div', { className: 'dwb-nt-row dwb-nt-terminal', 'data-dwb-nt-kind': 'terminal' },
    h(ui.Button, { variant: 'ghost', className: 'dwb-nt-terminal-main', 'aria-keyshortcuts': shortcut?.aria, ...menu,
      onClick: () => tab.actions.openTab('terminal', { replaceTab: true }),
    }, h('span', { className: 'dwb-nt-icon', 'aria-hidden': true }, h(ui.IconCodeOutlineRegular, { size: 16 })),
    h('span', { className: 'dwb-nt-title' }, entry.title())),
    h(ui.Menu, { open, portal: true, autoFocus: true, align: 'end',
      items: items.length ? items : [{ id: 'empty', label: t('shellEmpty'), disabled: true }],
      selectedId: state.phase === 'ready' ? state.choices.selectedShell : undefined,
      onClose: () => setOpen(false),
      onSelect: path => {
        if (state.phase === 'failed') { setState({ phase: 'loading' }); setAttempt(value => value + 1); return }
        app.ctx.get('webTerminals').selectShell(path)
        setOpen(false)
        tab.actions.openTab('terminal', { replaceTab: true, params: { shellPath: path } })
      },
      anchor: h(ui.Button, { variant: 'ghost', className: 'dwb-nt-shell', 'aria-label': t('shell'),
        'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => { setState({ phase: 'loading' }); setOpen(value => !value) },
      }, h(ui.IconChevronDownOutlineRegular, { size: 14 })),
    }),
    shortcut?.keys?.length ? h('span', { className: 'dwb-nt-keys' }, h(ui.ShortcutKeys, { keys: shortcut.keys })) : null)
}

function NewTabPage({ sessionId, useTabInfo, matched: entries, app, pinStore }) {
  const { tab } = useTabInfo(), { ctx, t } = app
  const [layout, setLayout] = useState(readNewTabLayout)
  const [drag, setDrag] = useState(null)
  const pins = React.useSyncExternalStore(pinStore.subscribe, pinStore.getSnapshot)
  const id = React.useId()
  const { favorites, hidden, groups } = groupNewTabEntries(entries, layout, pins, kind => {
    const definition = ctx.sidebarRightTabs.get(kind)
    return definition !== undefined && (definition.priority ?? 'extension') === 'extension'
  })
  const shortcuts = ctx.shortcuts.catalog.getSnapshot()
  const chooseLayout = value => { setLayout(value); writeNewTabLayout(value) }
  const renderEntry = (entry, pin) => {
    const key = pin ?? newTabEntryPin(entry)
    const Icon = ui[NEW_TAB_ICONS[entry.kind]] ?? entry.icon ?? ui.IconCordisPluginOutlineRegular
    const shortcut = shortcuts.find(row => row.id === (entry.commandId ?? (entry.kind === 'terminal' ? 'terminal.new' : undefined)))
    const menu = event => {
      const keyboard = event.type === 'keydown'
      if (keyboard && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
        if (!pin || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const index = favorites.findIndex(row => row.pin === pin)
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        const target = favorites[index + direction]?.pin
        if (target !== undefined) pinStore.update(current => moveNewTabPin(current, pin, target))
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      const bounds = event.currentTarget.getBoundingClientRect()
      ctx.contextMenus.open(
        { kind: NEW_TAB_PIN_MENU, value: { key, pinned: pin !== undefined, hidden } },
        { x: keyboard ? bounds.left : event.clientX, y: keyboard ? bounds.bottom : event.clientY },
      )
    }
    const contextMenu = layout === 'common' ? { onContextMenu: menu, onKeyDown: menu } : undefined
    if (!pin && entry.kind === 'terminal') return h(NewTabTerminal, { key, entry, shortcut, tab, sessionId, app, menu: contextMenu })
    const dragProps = pin ? {
      draggable: true,
      'data-dwb-nt-dragging': drag?.source === pin,
      'data-dwb-nt-over': drag?.target === pin,
      onDragStart: event => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', pin)
        setDrag({ source: pin, target: undefined })
      },
      onDragOver: event => {
        if (!drag || drag.source === pin) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (drag.target !== pin) setDrag({ ...drag, target: pin })
      },
      onDrop: event => {
        if (!drag) return
        event.preventDefault()
        pinStore.update(current => moveNewTabPin(current, drag.source, pin))
        setDrag(null)
      },
      onDragEnd: () => setDrag(null),
    } : undefined
    return h(ui.Button, { variant: 'ghost', key, type: 'button', className: 'dwb-nt-row',
      'data-dwb-nt-kind': entry.kind,
      'aria-keyshortcuts': pin ? [shortcut?.aria, 'Alt+ArrowLeft Alt+ArrowRight'].filter(Boolean).join(' ') : shortcut?.aria,
      ...contextMenu, ...dragProps,
      onClick: () => {
        tab.actions.openTab(entry.kind, { replaceTab: true })
        if (entry.kind !== 'terminal') tab.actions.close()
      },
    }, h('span', { className: 'dwb-nt-icon', 'aria-hidden': true }, h(Icon, { size: 16 })),
    h('span', { className: 'dwb-nt-title' }, entry.title()),
    !pin && shortcut?.keys?.length ? h('span', { className: 'dwb-nt-keys' }, h(ui.ShortcutKeys, { keys: shortcut.keys })) : null)
  }
  return h('div', { className: 'dwb-nt-root', 'aria-label': t('newTab.title') },
    h('div', { className: 'dwb-nt-switch' }, h(ui.SegmentedTabs, {
      size: 'sm', label: t('newTab.layout'), value: layout, onChange: chooseLayout,
      items: ['common', 'list', 'columns'].map(value => ({ id: `${id}-${value}`, value, label: t(`newTab.${value}`), panelId: `${id}-content` })),
    })),
    h('div', { id: `${id}-content` },
      favorites.length ? h('div', { className: 'dwb-nt-favorites', role: 'group', 'aria-label': t('newTab.pinned') },
        favorites.map(({ entry, pin }) => renderEntry(entry, pin))) : null,
      groups.map(group => h('section', { key: group.id, className: 'dwb-nt-group', 'data-dwb-nt-group': group.id },
        h('h3', { className: 'dwb-nt-heading' }, t(`newTab.${group.id}`)),
        h('div', { className: layout === 'columns' ? 'dwb-nt-grid' : undefined }, group.entries.map(entry => renderEntry(entry)))))))
}

/** 标签上的字和官方加号的提示一样叫新标签页。不带图标：选中时右端 30px 要留给关闭按钮，带图标最后一个字会被遮住。不在最前面就关掉，官方的加号才回得来。 */
function NewTabTitle({ useTabInfo, app }) {
  const { tab } = useTabInfo()
  const title = useRef(null)
  useEffect(() => {
    const selected = title.current?.closest('[role="tab"]')?.getAttribute('aria-selected')
    if (guideTabShouldClose({ visible: tab.visible, selected })) tab.actions.close()
  })
  return h('span', { ref: title, className: 'dwb-nt-tab-title' }, app.t('newTab.title'))
}

/** The official GuideBody owns the registry subscription and reevaluates this chain on entry changes. */
function applyNewTab(app) {
  const { ctx, t } = app
  const pinStore = createNewTabPinStore()
  const sync = event => { if (event.key === NEW_TAB_PINS_STORAGE || event.key === null) pinStore.reload() }
  window.addEventListener('storage', sync)
  const removeStyle = mountModuleStyle('dsh-workbench-new-tab', NEW_TAB_CSS + newTabSplitCss())
  const disposers = [
    ctx.slots.inject('sidebar.right.tab.guide', () => ctx.slots.register({
      name: 'sidebar.right.tab.guide', priority: -10, locale: '@miint-sunny/dsh-workbench',
      select: () => readNewTabEntries(ctx.sidebarRightTabs),
    }, props => h(NewTabPage, { ...props, app, pinStore }))),
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: NEW_TAB_GUIDE_TYPE, priority: -10, locale: '@miint-sunny/dsh-workbench',
    }, props => h(NewTabTitle, { ...props, app }))),
    ctx.contextMenus.register({
      id: NEW_TAB_PIN_MENU, target: NEW_TAB_PIN_MENU, order: 100,
      resolve: ({ key, pinned }) => [{
        id: pinned ? 'unpin' : 'pin',
        label: t(pinned ? 'newTab.unpin' : 'newTab.pin'),
        icon: { key: NEW_TAB_PIN_MENU },
        disabled: !pinned && pinStore.getSnapshot().length >= NEW_TAB_PIN_LIMIT,
        run: () => pinStore.update(pins => pinned ? removeNewTabPin(pins, key) : addNewTabPin(pins, key)),
      }],
    }),
    ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
      name: 'contextMenu.icon', key: NEW_TAB_PIN_MENU,
    }, props => h(ui.IconPinOutlineRegular, props))),
    ctx.slots.inject('contextMenu.content', () => ctx.slots.register({
      name: 'contextMenu.content', key: NEW_TAB_PIN_MENU, locale: '@miint-sunny/dsh-workbench',
    }, ({ target }) => {
      const { pinned, hidden } = target.value
      if (pinned || pinStore.getSnapshot().length < NEW_TAB_PIN_LIMIT) return null
      return h('div', { className: 'dwb-nt-limit' },
        t(hidden ? 'newTab.pinLimitHidden' : 'newTab.pinLimit', { limit: NEW_TAB_PIN_LIMIT, hidden }))
    })),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    window.removeEventListener('storage', sync)
    removeStyle()
  }
}

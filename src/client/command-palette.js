import { paletteGroups, paletteDefaultSelection, paletteShortcutEnabled, paletteHasMainSession, createPaletteController, shortcutsCommandOwner } from './command-palette-model.js'
import { PALETTE_FILTERS, paletteCapacity, paletteKeyCapture, paletteSearchableCommands, paletteShortcutInvocation, paletteShortcutItems } from './command-palette-model.js'
import { USAGE_PALETTE_SLOT, sessionStatusKey } from './features.js'
import { mountModuleStyle } from './style.js'

const PALETTE_INJECT = [
  'shortcuts',
  'commandUi',
  'conversation',
  'workspaces',
  'layout',
  'uiWorkspace',
  'sidebarRight',
  'sidebarRightTabs',
]
const PALETTE_ZH = {
  'palette.title': '命令面板',
  'palette.search': '搜索',
  'palette.placeholder': '搜索会话、操作和命令',
  'palette.close': '关闭',
  'palette.all': '全部',
  'palette.command': '命令',
  'palette.session': '会话',
  'palette.action': '操作',
  'palette.interface': '界面',
  'palette.recent': '最近更新',
  'palette.right': '右侧栏',
  'palette.panel': '侧边栏',
  'palette.loading': '正在读取…',
  'palette.error': '命令读取失败，可以重试；其他组仍可使用。',
  'palette.retry': '重试',
  'palette.empty': '无匹配结果',
  'palette.clear': '清除搜索',
  'palette.draft': '输入框已有内容或正在处理输入，请先处理草稿和附件。',
  'palette.target': '当前会话已变化，请重新选择。',
  'palette.unavailable': '此入口已不可用，请重新选择。',
  'palette.running': '会话正在运行，请结束后再添加命令。',
  'palette.more': '显示全部 {n} 项',
  'palette.select': '选择',
  'palette.open': '打开',
  'palette.execute': '执行',
  'palette.compose': '新建会话',
  'palette.insert': '添加到输入框',
  'palette.openRight': '在右侧栏打开',
  'palette.noSession': '打开会话后才能使用右侧栏和命令。',
  'palette.shortcut': '快捷键',
  'palette.shortcutSearch': '搜索快捷键',
  'palette.shortcutPress': '按下快捷键',
  'palette.shortcutByKeys': '按键搜索',
  'palette.shortcutExit': '退出按键搜索',
  'palette.shortcutEdit': '编辑快捷键',
  'palette.shortcutUnbound': '暂无快捷键',
  'palette.shortcutEmpty': '没有命令使用此组合',
  'palette.shortcutUnavailable': '无法执行此快捷键命令。',
  'palette.shortcutFixed': '请在对应界面按下此快捷键。',
  'palette.shortcutCaptureFailed': '无法读取此组合，请重新按下。',
  'palette.shortcutRecordingFailed': '无法按键搜索，请重试。',
}
const PALETTE_EN = {
  'palette.title': 'Command palette',
  'palette.search': 'Search',
  'palette.placeholder': 'Search sessions, actions, and commands',
  'palette.close': 'Close',
  'palette.all': 'All',
  'palette.command': 'Commands',
  'palette.session': 'Sessions',
  'palette.action': 'Actions',
  'palette.interface': 'Interface',
  'palette.recent': 'Recently updated',
  'palette.right': 'Right sidebar',
  'palette.panel': 'Sidebar',
  'palette.loading': 'Reading…',
  'palette.error': 'Commands could not be loaded. Retry, or use the other groups.',
  'palette.retry': 'Retry',
  'palette.empty': 'No matching results',
  'palette.clear': 'Clear search',
  'palette.draft':
    'The composer has content or is processing input. Finish the draft and attachments first.',
  'palette.target': 'The current session changed. Select an item again.',
  'palette.unavailable': 'This entry is no longer available. Select another item.',
  'palette.running': 'The session is running. Wait for it to finish before adding a command.',
  'palette.more': 'Show all {n} items',
  'palette.select': 'Select',
  'palette.open': 'Open',
  'palette.execute': 'Execute',
  'palette.compose': 'New session',
  'palette.insert': 'Add to composer',
  'palette.openRight': 'Open in right sidebar',
  'palette.noSession': 'Open a session to use its right sidebar and commands.',
  'palette.shortcut': 'Shortcuts',
  'palette.shortcutSearch': 'Search shortcuts',
  'palette.shortcutPress': 'Press a shortcut',
  'palette.shortcutByKeys': 'Search by keystrokes',
  'palette.shortcutExit': 'Exit keystroke search',
  'palette.shortcutEdit': 'Edit shortcuts',
  'palette.shortcutUnbound': 'No shortcut',
  'palette.shortcutEmpty': 'No command uses this combination',
  'palette.shortcutUnavailable': 'This shortcut command could not be run.',
  'palette.shortcutFixed': 'Press this shortcut in its original view.',
  'palette.shortcutCaptureFailed': 'Could not read this combination. Press it again.',
  'palette.shortcutRecordingFailed': 'Could not listen for shortcuts. Try again.',
}
const PALETTE_PANEL_ICONS = {
  'dsh-one-whale/main': 'FishLogo',
  plugins: 'IconCordisPluginOutlineRegular',
  schedules: 'IconClockOutlineRegular',
  'dsh-workbench-organize': 'IconFlatListOutlineRegular',
  'dsh-workbench-pages': 'IconGlobeOutlineRegular',
  'dsh-workbench-usage': 'IconDataOutlineRegular',
}

function paletteIcon(row) {
  if (row.kind === 'command') return ui.IconChecklistOutlineRegular
  if (row.kind === 'session') return ui.IconQueueOutlineRegular
  if (row.kind === 'action')
    return row.name === 'session.new'
      ? ui.IconNewChatOutlineRegular
      : ui.IconPanelLeftOutlineRegular
  if (row.kind === 'shortcut') return ui.IconPlayOutlineRegular
  if (row.kind === 'right')
    return ui[NEW_TAB_ICONS[row.name]] ?? row.icon ?? ui.IconCordisPluginOutlineRegular
  return ui[PALETTE_PANEL_ICONS[row.name]] ?? ui.IconCordisPluginOutlineRegular
}

function paletteActionLabel(row, t) {
  if (row?.kind === 'shortcut') return t('palette.execute')
  if (row?.kind === 'command') return t('palette.insert')
  if (row?.kind === 'right') return t('palette.openRight')
  if (row?.kind === 'action')
    return t(row.name === 'session.new' ? 'palette.compose' : 'palette.execute')
  return t('palette.open')
}

// dsh-ui-guard: DSH 没有键盘图标。线条照它的图标：16×16、1 px、currentColor。
const PaletteKeyboardIcon = () => h(
  'svg',
  { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', 'aria-hidden': true },
  h('rect', { x: 1.5, y: 3.5, width: 13, height: 9, rx: 2 }),
  h('path', { d: 'M4.25 6.25h.01M6.75 6.25h.01M9.25 6.25h.01M11.75 6.25h.01M5.5 9.75h5' }),
)

function PaletteDialog({ controller, app, editShortcuts }) {
  const t = app.t
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { kind, recording, captured, held } = snapshot
  const pressed = held ?? captured?.keys
  const shortcut = kind === 'shortcut'
  const loading = !shortcut && snapshot.loading
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(undefined),
    [expanded, setExpanded] = useState(new Set())
  const input = useRef(null),
    list = useRef(null),
    pointerMoved = useRef(false)
  const effectiveKind = !shortcut && query.trimStart().startsWith('/') ? 'command' : kind
  const groups = useMemo(
    () => paletteGroups(
      shortcut
        ? paletteShortcutItems(snapshot.shortcuts, snapshot.fixed, captured, held)
        : [...snapshot.items, ...(query.trim() ? paletteSearchableCommands(snapshot.shortcuts, snapshot.items) : [])],
      query, kind, expanded, paletteCapacity(window.innerHeight),
    ),
    [snapshot.items, snapshot.shortcuts, snapshot.fixed, shortcut, captured, held, query, kind, expanded],
  )
  const rows = groups.flatMap((group) => group.items)
  const indices = new Map(rows.map((row, index) => [row.id, index]))
  const activeId = rows.some((row) => row.id === selected)
    ? selected
    : paletteDefaultSelection(groups, query, kind)
  const active = rows.find((row) => row.id === activeId)
  useEffect(() => {
    if (snapshot.open) {
      setQuery('')
      setSelected(undefined)
      setExpanded(new Set())
      input.current?.focus()
    }
  }, [snapshot.open])
  useEffect(() => {
    if (!recording) return
    const composition = ui.observeComposition(document)
    const capture = (event) => {
      if (!controller.getSnapshot().recording || composition.guards(event) || event.getModifierState('AltGraph')) return
      const result = paletteKeyCapture(event)
      if (result.type === 'pass') return
      event.preventDefault()
      event.stopPropagation()
      if (result.type === 'modifier') controller.holdModifiers(result.modifiers)
      else if (!event.repeat) {
        if (result.type === 'binding') controller.captureBinding(result.binding)
        else controller.setRecording(false)
        setSelected(undefined)
      }
    }
    const release = (event) => {
      const result = paletteKeyCapture(event)
      if (result.type === 'modifier') controller.holdModifiers(result.modifiers)
    }
    const blur = () => controller.holdModifiers([])
    window.addEventListener('keydown', capture, true)
    window.addEventListener('keyup', release, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', capture, true)
      window.removeEventListener('keyup', release, true)
      window.removeEventListener('blur', blur)
      composition.dispose()
    }
  }, [controller, recording])
  useEffect(() => {
    // 指针选中的行已经在眼前，只有键盘和搜索换行时才滚动。
    if (pointerMoved.current) pointerMoved.current = false
    else list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [activeId, groups.length])
  if (!snapshot.open) return null
  const changeQuery = (value) => {
    setQuery(value)
    setSelected(undefined)
    setExpanded(new Set())
  }
  const changeKind = (value) => {
    if (value !== kind && (shortcut || value === 'shortcut')) setQuery('')
    controller.setKind(value)
    setSelected(undefined)
    setExpanded(new Set())
    input.current?.focus()
  }
  const choose = (row) => {
    void controller.choose(row.id)
  }
  const key = (event) => {
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const index = rows.findIndex((row) => row.id === activeId)
      if (rows.length)
        setSelected(
          rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].id,
        )
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && query === '' && !captured) {
      event.preventDefault()
      changeKind(
        PALETTE_FILTERS[
          (PALETTE_FILTERS.indexOf(kind) + (event.key === 'ArrowRight' ? 1 : PALETTE_FILTERS.length - 1)) %
            PALETTE_FILTERS.length
        ],
      )
    } else if (
      event.key === 'Enter' &&
      active &&
      !(active.kind === 'command' && loading)
    ) {
      event.preventDefault()
      choose(active)
    } else if (!shortcut && event.key === 'Tab' && !event.shiftKey && query.trim()) {
      event.preventDefault()
      controller.compose(query)
    }
  }
  const metadata = (row) => {
    if (row.kind === 'session') {
      if (row.status) return h('span', { className: 'dwb-cmd-meta dwb-cmd-waiting' }, t(row.status))
      const time = organizeTimeParts(row.updatedAt, Date.now())
      return h(
        'span',
        { className: 'dwb-cmd-meta' },
        time.kind === 'today'
          ? `${time.hh}:${time.mm}`
          : time.kind === 'yesterday'
            ? t('organize.time.yesterday')
            : t('organize.time.date', { month: time.month, day: time.day }),
      )
    }
    if (row.kind === 'command') return h('span', { className: 'dwb-cmd-meta' }, `/${row.name}`)
    if (row.shortcut?.keys?.length) {
      return h(ui.ShortcutKeys, { keys: row.shortcut.keys, className: 'dwb-cmd-meta' })
    }
    return row.kind === 'shortcut'
      ? h('span', { className: 'dwb-cmd-meta' }, t('palette.shortcutUnbound'))
      : null
  }
  const hint = (keys, label, className = '') =>
    h('span', { className: `dwb-cmd-hint ${className}` }, h(ui.ShortcutKeys, { keys }), label)
  return h(
    ui.Modal,
    {
      open: true,
      onClose: controller.close,
      title: t('palette.title'),
      closeLabel: t('palette.close'),
      headless: true,
      shortcutModal: 'other',
      className: 'dwb-cmd-modal',
    },
    h(
      'div',
      { className: shortcut ? 'dwb-cmd dwb-cmd-shortcut-mode' : 'dwb-cmd' },
      h(
        'div',
        { className: 'dwb-cmd-search' },
        h('div', { className: recording ? 'dwb-cmd-entry dwb-cmd-capturing' : 'dwb-cmd-entry' },
          h(ui.Input, {
            ref: input,
            className: 'dwb-cmd-input',
            icon: h(ui.IconSearchOutlineRegular, { size: 16 }),
            'aria-label': t(recording ? 'palette.shortcutPress' : shortcut ? 'palette.shortcutSearch' : 'palette.search'),
            placeholder: pressed ? '' : t(recording ? 'palette.shortcutPress' : shortcut ? 'palette.shortcutSearch' : 'palette.placeholder'),
            value: query,
            readOnly: recording,
            onChange: (event) => changeQuery(event.target.value),
            onKeyDown: key,
            role: 'combobox',
            'aria-expanded': true,
            'aria-controls': 'dwb-cmd-results',
            'aria-autocomplete': 'list',
            'aria-activedescendant': active ? `dwb-cmd-result-${indices.get(active.id)}` : undefined,
          }),
          pressed ? h('span', { className: 'dwb-cmd-captured-keys', role: 'status' },
            h(ui.ShortcutKeys, { keys: pressed })) : null,
        ),
        shortcut ? h(
          ui.Button,
          {
            variant: 'ghost',
            className: 'dwb-cmd-keys',
            'aria-label': t('palette.shortcutByKeys'),
            'aria-pressed': recording,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
              changeQuery('')
              controller.setRecording(!recording)
              input.current?.focus()
            },
          },
          h(PaletteKeyboardIcon),
        ) : null,
        h(
          ui.Button,
          {
            variant: 'ghost',
            className: 'dwb-cmd-close',
            'aria-label': t('palette.close'),
            onClick: controller.close,
          },
          h(ui.IconCloseOutlineRegular, { size: 16 }),
        ),
      ),
      h(
        'div',
        { className: 'dwb-cmd-filters' },
        h(ui.SegmentedTabs, {
          size: 'sm',
          label: t('palette.title'),
          value: effectiveKind,
          onChange: changeKind,
          items: PALETTE_FILTERS.map((value) => ({
            id: `dwb-cmd-filter-${value}`,
            panelId: 'dwb-cmd-results',
            value,
            label: t(`palette.${value}`),
          })),
        }),
      ),
      h(
        'div',
        { className: 'dwb-cmd-status', role: 'status' },
        loading ? t('palette.loading') : null,
      ),
      !shortcut && snapshot.error
        ? h(
            'p',
            { className: 'dwb-cmd-message', role: 'alert' },
            t('palette.error'),
            ' ',
            h(
              ui.Button,
              {
                variant: 'ghost',
                onClick: () => {
                  void controller.open()
                },
              },
              t('palette.retry'),
            ),
          )
        : null,
      snapshot.notice
        ? h('p', { className: 'dwb-cmd-message', role: 'alert' }, snapshot.noticeDetail ?? t(`palette.${snapshot.notice}`))
        : null,
      h(
        'div',
        {
          ref: list,
          id: 'dwb-cmd-results',
          className: 'dwb-cmd-results',
          role: 'listbox',
          'aria-label': t('palette.title'),
        },
        groups.map((group) =>
          h(
            'section',
            { key: group.id, role: 'group', 'aria-label': shortcut ? t('palette.shortcut') : undefined,
              'aria-labelledby': shortcut ? undefined : `dwb-cmd-group-${group.id}` },
            shortcut ? null : h(
              'h3',
              { id: `dwb-cmd-group-${group.id}`, className: 'dwb-cmd-group-title' },
              t(`palette.${group.id === 'session' && !query ? 'recent' : group.id}`),
              h('span', { className: 'dwb-cmd-count' }, group.total),
            ),
            group.items.map((row) =>
              h(
                ui.Button,
                {
                  key: row.id,
                  id: `dwb-cmd-result-${indices.get(row.id)}`,
                  variant: 'ghost',
                  type: 'button',
                  role: 'option',
                  tabIndex: -1,
                  'aria-selected': activeId === row.id,
                  'data-dwb-cmd-id': row.id,
                  className: 'dwb-cmd-row',
                  disabled: row.kind === 'command' && loading,
                  onMouseMove: () => {
                    if (activeId === row.id) return
                    pointerMoved.current = true
                    setSelected(row.id)
                  },
                  onClick: () => choose(row),
                },
                shortcut ? null : h(
                  'span',
                  { className: 'dwb-cmd-icon', 'aria-hidden': true },
                  h(paletteIcon(row), { size: 16 }),
                ),
                h('span', { className: 'dwb-cmd-name' }, row.label),
                shortcut ? null : h('span', { className: 'dwb-cmd-detail' }, row.detail),
                metadata(row),
              ),
            ),
            group.total > group.items.length
              ? h(
                  ui.Button,
                  {
                    variant: 'ghost',
                    className: 'dwb-cmd-more',
                    onClick: () => {
                      setExpanded((old) => new Set([...old, group.id]))
                      input.current?.focus()
                    },
                  },
                  h(ui.IconChevronDownOutlineRegular, { size: 14 }),
                  t('palette.more', { n: group.total }),
                )
              : null,
          ),
        ),
        !rows.length && !loading
          ? h(
              'div',
              { className: pressed ? 'dwb-cmd-empty dwb-cmd-key-empty' : 'dwb-cmd-empty', role: pressed ? 'status' : undefined },
              t('palette.empty'),
              pressed ? h('small', null, t('palette.shortcutEmpty')) : h(
                ui.Button,
                {
                  variant: 'ghost',
                  onClick: () => {
                    changeQuery('')
                    changeKind(shortcut ? 'shortcut' : 'all')
                  },
                },
                t('palette.clear'),
              ),
            )
          : null,
        !shortcut && !snapshot.hasSession
          ? h('p', { className: 'dwb-cmd-message' }, t('palette.noSession'))
          : null,
      ),
      h(
        'footer',
        { className: 'dwb-cmd-footer' },
        (!shortcut || rows.length > 1) ? h(
          'span',
          { className: 'dwb-cmd-hint dwb-cmd-optional' },
          h(ui.IconChevronUpOutlineRegular, { size: 12 }),
          h(ui.IconChevronDownOutlineRegular, { size: 12 }),
          t('palette.select'),
        ) : null,
        active ? hint(['Enter'], paletteActionLabel(active, t)) : null,
        !shortcut && query.trim() ? hint(['Tab'], t('palette.compose')) : null,
        hint(['Esc'], t(recording ? 'palette.shortcutExit' : 'palette.close')),
        shortcut && editShortcuts
          ? h(
              ui.Button,
              {
                variant: 'ghost',
                className: 'dwb-cmd-edit',
                onClick: () => editShortcuts(active?.kind === 'shortcut' && !active.fixed ? active.label : undefined),
              },
              t('palette.shortcutEdit'),
            )
          : null,
      ),
    ),
  )
}

const PALETTE_CSS = `
.dwb-cmd-modal[role="dialog"] {
  padding: 0;
  display: flex;
  width: min(640px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  overflow: hidden;
}
.dwb-cmd {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: calc(100dvh - 24px);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}
.dwb-cmd-search {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 44px;
  padding: 0 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dwb-cmd-entry {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}
.dwb-cmd-input {
  flex: 1;
  min-width: 0;
  border: 0 !important;
  border-radius: 0 !important;
  outline: none !important;
  box-shadow: none !important;
  background: transparent !important;
}
.dwb-cmd-captured-keys kbd {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 18px;
  height: 19px;
  padding-inline: 4px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  font-size: 12px;
}
.dwb-cmd-input input {
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  outline: none;
  box-shadow: none;
}
.dwb-cmd .dwb-cmd-input input::placeholder {
  color: var(--dsw-alias-label-secondary);
  opacity: 1;
}
.dwb-cmd-captured-keys {
  position: absolute;
  display: flex;
  align-items: center;
  inset-block: 0;
  inset-inline-start: 32px;
  pointer-events: none;
}
.dwb-cmd-input svg,
.dwb-cmd-icon svg,
.dwb-cmd-more svg,
.dwb-cmd-hint svg {
  display: block;
}
.dwb-cmd-edit {
  margin-inline-start: auto;
  height: 24px !important;
  min-height: 0 !important;
  padding: 0 6px !important;
  font-size: 12px !important;
  color: var(--dsw-alias-label-secondary) !important;
  white-space: nowrap;
}
.dwb-cmd-keys,
.dwb-cmd-close {
  flex: none;
  width: 24px;
  min-width: 24px !important;
  height: 24px !important;
  padding: 0 !important;
}
.dwb-cmd-keys[aria-pressed="true"] {
  background: var(--dsw-alias-button-ghost-active-fill) !important;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
}
.dwb-cmd-capturing input {
  caret-color: transparent;
}
.dwb-cmd-filters {
  flex: none;
  padding: 8px 14px 4px;
}
.dwb-cmd-status:empty {
  display: none;
}
.dwb-cmd-status,
.dwb-cmd-message {
  margin: 0;
  padding: 6px 14px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dwb-cmd-message button {
  height: 22px !important;
  min-height: 22px !important;
  padding: 0 6px !important;
  font-size: 12px !important;
}
.dwb-cmd-results {
  padding: 4px 6px 8px;
  overflow: auto;
  height: min(52dvh, 430px);
  scroll-padding: 4px;
}
.dwb-cmd-group-title {
  font-size: 12px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
  margin: 10px 8px 2px;
  line-height: 18px;
}
.dwb-cmd-results > section:first-child > .dwb-cmd-group-title {
  margin-top: 4px;
}
.dwb-cmd-count {
  margin-inline-start: 6px;
  font-variant-numeric: tabular-nums;
}
.dwb-cmd-row {
  display: flex !important;
  align-items: center;
  justify-content: flex-start !important;
  gap: 10px;
  width: 100%;
  height: 34px !important;
  min-height: 34px !important;
  padding: 0 8px !important;
  border: 0 !important;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit !important;
  font: inherit !important;
  text-align: start;
}
.dwb-cmd-row:hover {
  background: transparent !important;
}
.dwb-cmd-row[aria-selected="true"],
.dwb-cmd-row[aria-selected="true"]:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}
.dwb-cmd-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dwb-cmd-name {
  flex: none;
  max-width: 60%;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 20px;
}
.dwb-cmd-shortcut-mode .dwb-cmd-name {
  flex: 1;
  max-width: none;
}
.dwb-cmd-detail {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.dwb-cmd-meta {
  flex: none;
  margin-inline-start: auto;
  max-width: 40%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dwb-cmd-waiting {
  color: var(--dsw-alias-state-warn-primary);
}
.dwb-cmd-more {
  display: flex !important;
  justify-content: flex-start !important;
  align-items: center;
  gap: 10px;
  height: 30px !important;
  min-height: 30px !important;
  padding: 0 8px !important;
  color: var(--dsw-alias-label-tertiary) !important;
  font-size: 12px !important;
}
.dwb-cmd-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 8px;
  color: var(--dsw-alias-label-secondary);
}
.dwb-cmd-key-empty {
  flex-direction: column;
  gap: 4px;
}
.dwb-cmd-key-empty small {
  font-size: 12px;
}
.dwb-cmd-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  min-height: 34px;
  flex: none;
  padding: 4px 14px;
  box-sizing: border-box;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dwb-cmd-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
@media (max-width: 480px) {
  .dwb-cmd-detail,
  .dwb-cmd-optional {
    display: none;
  }
  .dwb-cmd-name {
    flex: 1;
    max-width: none;
  }
  .dwb-cmd-filters {
    padding-inline: 8px;
  }
  .dwb-cmd-filters [role="tablist"] {
    display: flex;
    overflow-x: auto;
  }
  .dwb-cmd-filters [role="tablist"] > [aria-hidden="true"] {
    display: none;
  }
  .dwb-cmd-filters [role="tab"] {
    flex: 1 0 auto;
    min-inline-size: 0;
    padding-inline: 2px !important;
    font-size: 12px !important;
    white-space: nowrap;
  }
  .dwb-cmd-filters [role="tab"][aria-selected="true"] {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .dwb-cmd-search {
    padding-inline: 10px;
  }
  .dwb-cmd-input input {
    font-size: 16px;
  }
  .dwb-cmd-footer {
    gap: 8px;
    padding-inline: 10px;
  }
}
`

/**
 * ⌘/ belongs to the official `shortcuts.open`. While this plugin runs, it lands on the palette's shortcut tab.
 * Nothing is written to the user's key preferences, so stopping the plugin restores the official behavior; so
 * does a registry this code cannot read. Settings and an open official window keep their official handling.
 */
function routeShortcutsCommand(ctx, controller) {
  let owned
  const restore = () => {
    if (!owned) return
    Object.assign(owned.command, { resolve: owned.resolve, modals: owned.modals })
    owned = undefined
  }
  const apply = () => {
    const command = ctx.shortcuts.registry?.commands?.get?.('shortcuts.open')
    if (!command || owned?.command === command) return
    restore()
    const { resolve, modals } = command
    owned = { command, resolve, modals }
    command.modals = [...new Set([...modals, 'sidebar', 'other'])]
    command.resolve = (context) => {
      return shortcutsCommandOwner(context.modal, controller.getSnapshot().open) === 'official'
        ? resolve(context) : { status: 'handled', run: () => controller.showShortcuts() }
    }
  }
  apply()
  const stop = ctx.shortcuts.catalog.subscribe(apply)
  return () => {
    stop()
    restore()
  }
}

/** Mount the entry point; index feeds are subscribed only during an open palette. */
export function applyCommandPalette(app) {
  const { ctx, t } = app
  const shortcuts = ctx.shortcuts
  let focusFrame,
    resolveFocus,
    navigationFrame,
    shortcutTarget,
    preparingShortcut = false,
    active = true
  const shortcutContext = () => {
    const target = shortcutTarget?.isConnected ? shortcutTarget : document.body
    const modal = [...document.querySelectorAll(ui.modalSelector)].findLast(node => !node.matches('.dwb-cmd-modal'))
    return {
      target,
      region: target?.closest('.xterm') ? 'terminal'
        : target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ? 'editable' : 'page',
      modal: modal ? modal.dataset.shortcutModal ?? 'other' : null,
    }
  }
  const currentTarget = () => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return undefined
    const id = ctx.uiSession.adapter.current.getSnapshot()?.key
    const entry = ctx.sessions.list.getSnapshot().byId[id]
    if (!paletteHasMainSession(entry)) return undefined
    const binding = id ? ctx.sessions.binding(id) : undefined
    if (
      !binding ||
      binding.session.getSnapshot().openState !== 'open' ||
      ctx.sessions.subagentAddress(id) !== undefined
    )
      return undefined
    return { id, binding, running: binding.session.getSnapshot().running }
  }
  const navigate = (action) => {
    cancelAnimationFrame(navigationFrame)
    navigationFrame = requestAnimationFrame(() => {
      if (active && !controller.getSnapshot().open) action()
    })
  }
  const startSession = (prompt) =>
    navigate(() =>
      prompt === undefined
        ? ctx.uiWorkspace.startSession()
        : ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' }),
    )
  const controller = createPaletteController({
    target: currentTarget,
    entries: () => {
      const catalog = shortcuts.catalog.getSnapshot()
      const shortcut = (id) => catalog.find((row) => row.id === id)
      const statuses = ctx.uiSession.sessionStatus.getSnapshot()
      return {
        shortcuts: catalog,
        sessions: Object.values(ctx.sessions.list.getSnapshot().byId).map((row) => ({
          ...row,
          status: sessionStatusKey(row, statuses.get(row.id)),
        })),
        archivedIds: ctx.workspaces.list.getSnapshot().archivedSessionIds,
        actions: ['session.new', 'sidebar.left.toggle', 'sidebar.right.toggle'].flatMap((id) => {
          const entry = shortcut(id)
          return entry
            ? [
                {
                  id,
                  label: entry.label,
                  shortcut: entry,
                  requiresSession: id === 'sidebar.right.toggle',
                },
              ]
            : []
        }),
        rightEntries: ctx.sidebarRightTabs
          .guide()
          .map((entry) => ({
            ...entry,
            label: entry.title(),
            detail: entry.description?.() ?? '',
            shortcut: shortcut(
              entry.commandId ?? (entry.kind === 'terminal' ? 'terminal.new' : undefined),
            ),
          })),
        panels: ['sidebar.panellist', USAGE_PALETTE_SLOT]
          .flatMap(name => ctx.slots.entriesOfSlot(name))
          .map(({ options }) => ({
            id: options.id,
            label: (typeof options.label === 'function' ? options.label() : options.label) ?? options.id,
          })),
      }
    },
    watch: (refresh, reload, close) => {
      const disposers = [
        ctx.sessions.list.subscribe(refresh),
        ctx.workspaces.list.subscribe(refresh),
        ctx.uiSession.adapter.current.subscribe(refresh),
        ctx.layout.panelInfo.subscribe(refresh),
        ctx.uiSession.sessionStatus.subscribe(refresh),
        ctx.sidebarRightTabs.subscribe(refresh),
        ctx.slots.subscribe('sidebar.panellist', refresh),
        ctx.slots.subscribe(USAGE_PALETTE_SLOT, refresh),
        shortcuts.catalog.subscribe(refresh),
        ctx.remote.$on('commands/change', reload),
        ctx.on('connection/reset', close),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
    commands: (target, signal) =>
      ctx.commandUi.candidates(target.binding.session, { query: '', position: 'leading', signal }),
    recording: active => shortcuts.recording(active),
    recordingError: error => ctx.logger.warn(error),
    describeBinding: binding => shortcuts.describeBinding(binding),
    fixedShortcuts: () => shortcuts.fixedCatalog?.getSnapshot() ?? [],
    watchFixedShortcuts: refresh => shortcuts.fixedCatalog?.subscribe(refresh),
    afterClose: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    shortcutInvocation: (id) => {
      // ⌘/ is routed here, so this row would only reopen the tab it is listed on.
      if (id === 'shortcuts.open' && referenceStore()?.actions?.open) return { run: () => editShortcuts() }
      // The palette's own row can be selected explicitly. Native input remains paused.
      preparingShortcut = true
      try {
        return paletteShortcutInvocation(shortcuts, id, shortcutContext())
      } finally {
        preparingShortcut = false
      }
    },
    input: (target) => ctx.conversation.input.for(target.binding.ctx),
    focusInput: (target, input) =>
      new Promise((resolve) => {
        resolveFocus?.(false)
        cancelAnimationFrame(focusFrame)
        resolveFocus = resolve
        focusFrame = requestAnimationFrame(() => {
          resolveFocus = undefined
          const current =
            !controller.getSnapshot().open && currentTarget()?.binding === target.binding
          if (current) input.focus()
          resolve(current)
        })
      }),
    refused: (input, reason) => input.notify('info', t(`palette.${reason}`)),
    openSession: (id) => {
      ctx.uiWorkspace.openSession(id)
    },
    openPanel: (id) => {
      ctx.layout.selectPanel(id)
    },
    openRight: (kind) => {
      ctx.sidebarRight.openTab(kind)
    },
    openAction: (id) => {
      if (id === 'session.new') startSession()
      else if (id === 'sidebar.left.toggle') ctx.layout.toggleSidebar()
      else if (id === 'sidebar.right.toggle') ctx.sidebarRight.toggleExpanded()
    },
    startSession,
  })
  /** The official window stays the place to change keys. It has no public entry, so reach its store through its overlay. */
  const referenceStore = () => ctx.slots.entriesOfSlot('shell.overlay')
    .find(({ options }) => options.id === 'shortcuts')?.store?.create?.()
  const editShortcuts = (label) => {
    const store = referenceStore()
    controller.close()
    store?.actions?.open?.()
    if (label) store?.actions?.search?.(label)
  }
  const removeStyle = mountModuleStyle('dsh-workbench-command-palette', PALETTE_CSS)
  const disposers = [
    () => {
      active = false
      cancelAnimationFrame(focusFrame)
      cancelAnimationFrame(navigationFrame)
      resolveFocus?.(false)
      controller.close()
      removeStyle()
    },
  ]
  const keep = (dispose) => disposers.push(dispose)
  keep(
    ctx.effect(
      () =>
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-workbench-command-palette' }, () =>
            h(PaletteDialog, { controller, app, editShortcuts: referenceStore()?.actions?.open ? editShortcuts : undefined }),
          ),
        ),
      '@miint-sunny/dsh-workbench/command-palette: dialog',
    ),
  )
  keep(
    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.panellist.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist.actions', id: 'dsh-workbench-command-palette', order: 40 },
            ({ onDismiss }) =>
              h(
                ui.MenuItemButton,
                {
                  icon: h(ui.IconSearchOutlineRegular, { size: 16 }),
                  onSelect: () => {
                    onDismiss()
                    queueMicrotask(() => {
                      if (active) {
                        shortcutTarget = document.activeElement
                        void controller.open()
                      }
                    })
                  },
                },
                t('palette.title'),
              ),
          ),
        ),
      '@miint-sunny/dsh-workbench/command-palette: menu',
    ),
  )
  keep(
    ctx.effect(
      () =>
        shortcuts.register({
          id: 'dsh-workbench.command-palette',
          label: () => t('palette.title'),
          aliases: [],
          // Desktop session.search owns Cmd+K; Web rejects it. Binding stays in the official preferences.
          defaults: {},
          regions: ['page', 'editable'],
          modals: ['sidebar', 'other'],
          resolve: (context) => {
            const { open, recording } = controller.getSnapshot()
            return paletteShortcutEnabled(
              {
                region: context.region,
                modal: context.modal,
                ownDialog: !!context.target?.closest?.('.dwb-cmd-modal'),
              },
              open,
              recording && !preparingShortcut,
            )
              ? {
                  status: 'handled',
                  run: () => {
                    if (!controller.getSnapshot().open) shortcutTarget = context.target
                    void controller.toggle()
                  },
                }
              : { status: 'pass' }
          },
        }),
      '@miint-sunny/dsh-workbench/command-palette: shortcut',
    ),
  )
  keep(routeShortcutsCommand(ctx, controller))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

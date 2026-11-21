import { createAttentionStore, attentionFilter, attentionNext, attentionNextNotice } from './attention-model.js'
import { registerOrganizeFilter } from './organize.js'
import { mainViewSessionId, sessionWorkspaceName } from './features.js'
import { mountModuleStyle } from './style.js'

const ATTENTION_INJECT = ['connection', 'workspaces', 'shortcuts', 'uiWorkspace', 'conversation']
const ATTENTION_ZH = {
  'attention.syncing': '连接已恢复，部分旧请求的状态尚待确认。可重新加载页面重新读取。', 'attention.unknown': '状态未知', 'attention.unknownCount': '待确认', 'attention.reload': '重新加载页面',
  'attention.title': '需要你处理', 'attention.next': '下一项', 'attention.nextShortcut': '下一个需要你处理的会话', 'attention.received': '收到时间',
  'attention.session': '会话', 'attention.workspace': '工作区', 'attention.status': '状态',
  'attention.all': '全部', 'attention.search': '搜索会话', 'attention.approval': '等待审批',
  'attention.question': '等待回答', 'attention.plan-review': '计划待审',
  'attention.empty': '当前没有需要处理的会话。', 'attention.noMatch': '无匹配会话',
  'attention.loading': '正在读取…', 'attention.offline': '连接已中断，显示上次收到的状态。重新连接后才能打开会话。',
  'attention.child': '子智能体请求', 'attention.timeHint': '收到时间只表示本次连接首次看到请求的时刻；连接前已存在的请求不显示时间。',
  'attention.clear': '取消筛选', 'attention.unavailable': '请求已解除或连接不可用，请查看最新列表。',
}
const ATTENTION_EN = {
  'attention.syncing': 'Connected. Some previous requests are not confirmed yet. Reload the page to read them again.', 'attention.unknown': 'Unknown status', 'attention.unknownCount': 'Unconfirmed', 'attention.reload': 'Reload page',
  'attention.title': 'Needs your action', 'attention.next': 'Next item', 'attention.nextShortcut': 'Next session needing your action', 'attention.received': 'Received at',
  'attention.session': 'Session', 'attention.workspace': 'Workspace', 'attention.status': 'Status',
  'attention.all': 'All', 'attention.search': 'Search sessions', 'attention.approval': 'Waiting for approval',
  'attention.question': 'Waiting for answer', 'attention.plan-review': 'Plan awaiting review',
  'attention.empty': 'No sessions need your action.', 'attention.noMatch': 'No matching sessions',
  'attention.loading': 'Reading…', 'attention.offline': 'Disconnected. Showing the last received state. Reconnect to open sessions.',
  'attention.child': 'Subagent request', 'attention.timeHint': 'Received at is when this connection first observed the request. Requests already pending on connection have no timestamp.',
  'attention.clear': 'Clear filter', 'attention.unavailable': 'The request was resolved or the connection is unavailable. Check the latest list.',
}

function AttentionLabel({ store, t }) {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  return h(Fragment, null, h('span', null, t('attention.title')), h('span', { className: 'dwb-attention-count' }, snapshot.phase === 'syncing' ? t('attention.unknownCount') : snapshot.phase === 'ready' || snapshot.rows.length ? String(snapshot.rows.length) : '—'))
}

function AttentionPage({ store, t, query, onQueryChange, onExit, open, next, setFilter }) {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [kind, setKind] = useState('all')
  const rows = useMemo(() => attentionFilter(snapshot.rows, { query, kind }), [snapshot.rows, query, kind])
  useEffect(() => { setFilter({ kind, query }); return () => setFilter({ kind: 'all', query: '' }) }, [kind, query])
  const key = event => {
    if (event.isComposing || event.nativeEvent?.isComposing) return
    if (event.key === 'Escape') { event.stopPropagation(); if (query) onQueryChange(''); else if (kind !== 'all') setKind('all'); else onExit() }
  }
  return h('section', { className: 'dwb-attention-page', onKeyDown: key },
    h('div', { className: 'dwb-attention-bar' }, h('h4', null, t('organize.panel')),
      h('label', { className: 'dwb-attention-search' }, h('span', { className: 'dwb-attention-icon', 'aria-hidden': true }, h(ui.IconSearchOutlineRegular, { size: 14 })),
        h('input', { type: 'search', value: query, 'aria-label': t('attention.search'), placeholder: t('attention.search'), onChange: event => onQueryChange(event.target.value) }))),
    h('div', { className: 'dwb-attention-bar' }, h('button', { type: 'button', onClick: onExit }, t('attention.all')),
      h('button', { type: 'button', 'aria-pressed': true }, h(AttentionLabel, { store, t })),
      h('span', { className: 'dwb-attention-grow' }),
      h('button', { type: 'button', disabled: snapshot.phase !== 'ready' || !rows.length, onClick: next },
        h('span', { className: 'dwb-attention-icon', 'aria-hidden': true }, h(ui.IconChevronRightOutlineRegular, { size: 14 })), h('span', null, t('attention.next')))),
    h('div', { className: 'dwb-attention-bar', role: 'group', 'aria-label': t('attention.status') },
      ...['all', 'approval', 'question', 'plan-review'].map(value => h('button', { key: value, type: 'button', 'aria-pressed': kind === value, onClick: () => setKind(value) }, t(`attention.${value}`)))),
    h('p', { className: 'dwb-attention-note', role: 'status' }, snapshot.phase !== 'ready' ? t(`attention.${snapshot.phase}`) : t('attention.timeHint')),
    snapshot.phase === 'syncing' ? h('button', { type: 'button', onClick: () => window.location.reload() }, t('attention.reload')) : null,
    !rows.length ? snapshot.phase !== 'ready' ? null : h('div', { className: 'dwb-attention-empty' }, h('p', null, t(query || kind !== 'all' ? 'attention.noMatch' : 'attention.empty')),
      query || kind !== 'all' ? h('button', { type: 'button', onClick: () => { onQueryChange(''); setKind('all') } }, t('attention.clear')) : null)
      : h('table', { className: 'dwb-attention-table' }, h('thead', null, h('tr', null,
        h('th', null, t('attention.session')), h('th', { className: 'dwb-attention-workspace' }, t('attention.workspace')),
        h('th', null, t('attention.status')), h('th', null, t('attention.received')))),
      h('tbody', null, ...rows.map(row => h('tr', { key: row.id, 'data-attention-session': row.id },
        h('td', null, h('button', { type: 'button', className: 'dwb-attention-open', disabled: snapshot.phase !== 'ready', onClick: () => open(row.id) },
          h('span', null, row.title ?? t('attention.child')), row.child && row.title ? h('span', { className: 'dwb-attention-note' }, t('attention.child')) : null),
          h('span', { className: 'dwb-attention-mobile-workspace' }, sessionWorkspaceName(row.cwd))),
        h('td', { className: 'dwb-attention-workspace' }, sessionWorkspaceName(row.cwd)),
        h('td', null, h('span', { className: 'dwb-attention-status' }, h('span', { className: 'dwb-attention-icon', 'aria-hidden': true },
          h(row.kind === 'approval' ? ui.IconShieldOutlineRegular : row.kind === 'question' ? ui.IconQueueOutlineRegular : ui.IconChecklistOutlineRegular, { size: 14 })), h('span', null, t(row.unconfirmed ? 'attention.unknown' : `attention.${row.kind}`)))),
        h('td', { className: 'dwb-attention-time' }, row.receivedAt === null ? '—' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(row.receivedAt)))))))
}

const ATTENTION_CSS = `
.dwb-attention-page{box-sizing:border-box;container-type:inline-size;width:100%;height:100%;min-height:0;overflow:auto;padding:16px 20px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dwb-attention-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:4px 0}.dwb-attention-bar h4{margin:0;font-size:14px;font-weight:500}.dwb-attention-grow{flex:1}
.dwb-attention-count{margin-inline-start:6px;font-variant-numeric:tabular-nums}.dwb-attention-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0;flex:none}.dwb-attention-icon svg{display:block}
.dwb-attention-bar button,.dwb-attention-empty button{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dwb-attention-bar button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-secondary)}.dwb-attention-bar button:disabled{opacity:.55;cursor:default}
.dwb-attention-search{margin-inline-start:auto;display:flex;align-items:center;gap:6px;min-width:120px;max-width:100%;padding:4px 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:7px}.dwb-attention-search input{min-width:0;border:0;background:transparent;color:inherit;font:inherit}
.dwb-attention-note,.dwb-attention-workspace,.dwb-attention-mobile-workspace{font-size:12px;color:var(--dsw-alias-label-secondary)}.dwb-attention-note{margin:8px 0;overflow-wrap:anywhere}.dwb-attention-empty{padding:20px 0}
.dwb-attention-table{border-collapse:collapse;table-layout:fixed;width:100%;margin-top:8px}.dwb-attention-table th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);text-align:start}.dwb-attention-table th:first-child{width:36%}.dwb-attention-table th:nth-child(2){width:22%}.dwb-attention-table th:last-child{width:16%}.dwb-attention-table th,.dwb-attention-table td{padding:9px 8px;border-bottom:1px solid var(--dsw-alias-border-l3);overflow-wrap:anywhere}
.dwb-attention-open{min-height:24px;display:flex;flex-direction:column;max-width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer;overflow-wrap:anywhere}.dwb-attention-open:disabled{cursor:default}.dwb-attention-status{display:inline-flex;align-items:center;gap:6px;font-size:12px}.dwb-attention-time{font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}.dwb-attention-mobile-workspace{display:none}
@container(max-width:550px){.dwb-attention-workspace{display:none}.dwb-attention-mobile-workspace{display:block}.dwb-attention-table th:first-child{width:40%}.dwb-attention-table th:last-child{width:23%}.dwb-attention-table th,.dwb-attention-table td{padding:8px 4px}}
@media(pointer:coarse){.dwb-attention-search input{font-size:16px}}
`

/** Subscribe to official stores only; no polling, log reads, new tools or answering capability. */
export function applyAttention(app) {
  const { ctx, t } = app
  let observedGeneration = ctx.connection.generation.getSnapshot(), listGeneration = observedGeneration, active = true
  const store = createAttentionStore(() => ({
    connected: ctx.connection.state.getSnapshot() === 'connected', generation: ctx.connection.generation.getSnapshot(),
    ready: listGeneration === ctx.connection.generation.getSnapshot() && ctx.sessions.list.getSnapshot().phase === 'ready' && ctx.workspaces.list.getSnapshot().phase === 'ready',
    list: ctx.sessions.list.getSnapshot(), statuses: ctx.uiSession.sessionStatus.getSnapshot(),
    archivedIds: ctx.workspaces.list.getSnapshot().archivedSessionIds, addressFor: id => ctx.sessions.subagentAddress(id),
  }))
  let activeFilter = { kind: 'all', query: '' }
  const inform = key => {
    const id = mainViewSessionId(ctx.sessions.list.getSnapshot().byId), binding = id && ctx.sessions.binding(id)
    if (binding) ctx.conversation.input.for(binding.ctx).notify('info', t(key))
  }
  const open = id => { store.update(); if (store.getSnapshot().phase === 'ready' && store.getSnapshot().rows.some(row => row.id === id)) ctx.uiWorkspace.openSession(id); else inform('attention.unavailable') }
  const next = () => {
    store.update()
    const id = attentionNext(store.getSnapshot(), mainViewSessionId(ctx.sessions.list.getSnapshot().byId), activeFilter)
    if (id) open(id); else inform(attentionNextNotice(store.getSnapshot()))
  }
  const removeStyle = mountModuleStyle('dsh-workbench-attention', ATTENTION_CSS)
  const disposers = [() => { active = false; removeStyle() }]
  const update = () => {
    const generation = ctx.connection.generation.getSnapshot()
    if (generation && generation !== observedGeneration) {
      observedGeneration = generation; listGeneration = undefined
      // The list baseline is reusable, but it does not certify pending-domain completeness.
      void ctx.sessions.refresh().then(() => { if (active && ctx.connection.generation.getSnapshot() === generation) { listGeneration = generation; store.update() } }).catch(() => { /* Keep loading when the official baseline read failed. */ })
    }
    store.update()
  }
  for (const source of [ctx.sessions.list, ctx.workspaces.list, ctx.uiSession.sessionStatus, ctx.connection.state, ctx.connection.generation]) {
    disposers.push(ctx.effect(() => source.subscribe(update), '@miint-sunny/dsh-workbench/attention: official state'))
  }
  store.update()
  disposers.push(registerOrganizeFilter({ id: 'attention', Label: () => h(AttentionLabel, { store, t }),
    View: props => h(AttentionPage, { ...props, store, t, open, next, setFilter: value => { activeFilter = value } }),
  }))
  disposers.push(ctx.effect(() => ctx.shortcuts.register({ id: 'dsh-workbench.attention.next', label: () => t('attention.nextShortcut'), aliases: [],
    // 官方注册时把全部平台的默认键都查一遍，查不过就抛错。primary+A 不带 Shift 只在 Mac 和 Windows 桌面端放行，
    // desktop:linux 和网页端都算保留键，所以只声明这两个。
    defaults: {
      'desktop:macos': { code: 'KeyA', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyA', modifiers: ['primary', 'alt'] },
    }, regions: ['page', 'editable'], modals: [],
    resolve: context => context.modal != null && context.modal !== 'sidebar' ? { status: 'pass' } : { status: 'handled', run: next },
  }), '@miint-sunny/dsh-workbench/attention: shortcut'))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

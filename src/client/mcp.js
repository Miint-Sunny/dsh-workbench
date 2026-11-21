/** 设置分类与右侧栏入口共用按需 MCP 页面。 */
import { mountModuleStyle } from './style.js'
const MCP_INJECT = ['contextMenus', 'sidebarRight', 'uiWorkspace']
const MCP_PAGE = 'dsh-workbench-mcp',
  MCP_KIND = 'wbmcp'
const MCP_STYLE = `
.dwb-mcp {
  padding: 16px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  container: mcp/inline-size;
}
.dwb-mcp * {
  box-sizing: border-box;
  min-width: 0;
}
.dwb-mcp h2,
.dwb-mcp h3,
.dwb-mcp p {
  margin: 0;
}
.dwb-mcp h2,
.dwb-mcp h3 {
  font-size: 14px;
  font-weight: 500;
}
:where(.dwb-mcp) button,
:where(.dwb-mcp) input:not([type="checkbox"]),
:where(.dwb-mcp) select {
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  padding: 4px 8px;
  min-height: 28px;
}
:where(.dwb-mcp) button {
  cursor: pointer;
}
:where(.dwb-mcp) button:disabled {
  opacity: 0.5;
}
.dwb-mcp :focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dwb-mcp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.dwb-mcp-head h2 {
  flex: 1;
}
.dwb-mcp-filters {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 130px;
  gap: 10px;
  margin-bottom: 12px;
}
.dwb-mcp-filters label {
  display: grid;
  gap: 4px;
}
.dwb-mcp-filters > input:not([type="checkbox"]) {
  grid-column: 1/-1;
  width: 100%;
}
.dwb-mcp-small {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dwb-mcp-notice {
  margin-block: 10px !important;
  padding-block: 8px;
  border-block: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dwb-mcp-list {
  margin: 14px 0 20px;
}
.dwb-mcp-server {
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dwb-mcp-summary {
  list-style: none;
  cursor: pointer;
  display: grid;
  grid-template-columns: minmax(100px, 1fr) auto 76px 55px 55px;
  align-items: center;
  gap: 10px;
  padding: 11px 0;
}
.dwb-mcp-summary::-webkit-details-marker {
  display: none;
}
.dwb-mcp-group-row {
  height: auto;
  min-height: 40px;
  overflow: visible;
}
.dwb-mcp-group-content {
  flex: 1;
  min-width: 0;
}
.dwb-mcp-group-layout {
  display: block;
  width: 100%;
}
.dwb-mcp-group-title {
  display: none;
}
.dwb-mcp-name {
  display: flex;
  align-items: center;
  gap: 7px;
  overflow-wrap: anywhere;
}
.dwb-mcp-phase {
  white-space: nowrap;
}
.dwb-mcp-target {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dwb-mcp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}
.dwb-mcp-table th,
.dwb-mcp-table td {
  text-align: start;
  padding: 7px 6px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.dwb-mcp-table th {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}
.dwb-mcp-table th:first-child {
  width: 44%;
}
.dwb-mcp-table tbody tr {
  cursor: context-menu;
}
.dwb-mcp-table tbody tr:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dwb-mcp-warn {
  color: var(--dsw-alias-state-warn-primary);
}
.dwb-mcp-rule {
  padding: 10px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  overflow-wrap: anywhere;
  cursor: context-menu;
}
.dwb-mcp-rule[data-stale="true"] {
  color: var(--dsw-alias-label-secondary);
}
.dwb-mcp-foot {
  display: grid;
  gap: 8px;
  margin-top: 18px;
}
@container mcp (max-width:500px) {
  .dwb-mcp-summary {
    grid-template-columns: minmax(70px, 1fr) auto 60px;
    gap: 6px;
  }
  .dwb-mcp-summary > .dwb-mcp-summary-call {
    display: none;
  }
  .dwb-mcp-table th:first-child {
    width: 40%;
  }
  .dwb-mcp-table th,
  .dwb-mcp-table td {
    padding: 6px 3px;
  }
  :where(.dwb-mcp) input:not([type="checkbox"]),
  :where(.dwb-mcp) select {
    font-size: 16px;
  }
  .dwb-mcp-filters {
    grid-template-columns: minmax(100px, 1fr) 115px;
  }
}
@container mcp (max-width:350px) {
  .dwb-mcp-filters {
    grid-template-columns: 1fr;
  }
  .dwb-mcp-summary {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .dwb-mcp-summary > .dwb-mcp-small:last-of-type {
    grid-column: 2;
  }
  .dwb-mcp-table,
  .dwb-mcp-table thead,
  .dwb-mcp-table tbody {
    display: block;
  }
  .dwb-mcp-table tr {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .dwb-mcp-table th:first-child,
  .dwb-mcp-table td:first-child {
    grid-column: 1/-1;
    width: auto;
  }
}
`
async function mcpRequest(action, body, signal) {
  const read = action === 'state',
    response = await fetch(
      '/api/dsh-workbench.mcp.' + action + (read ? '?' + new URLSearchParams(body) : ''),
      {
        method: read ? 'GET' : 'POST',
        ...(read
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal,
      },
    )
  const value = await response.json()
  if (!response.ok) throw new Error(value.error?.code ?? 'read-failed')
  return value
}
function mcpError(t, code) {
  return t(
    code === 'unverified'
      ? 'mcp.unverifiedError'
      : Object.hasOwn(MCP_ZH, 'mcp.' + code)
        ? 'mcp.' + code
        : 'mcp.read-failed',
  )
}
function McpPanel({ app, close }) {
  const { ctx, t } = app
  const [sessionId, setSession] = useState(
      () =>
        Object.entries(ctx.sessions.list.getSnapshot().byId ?? {}).find(
          ([, r]) => r.retainedBy?.mainView > 0,
        )?.[0] ?? '',
    ),
    [scope, setScope] = useState('session'),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, reload] = useState(0),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true)
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    setError('')
    void mcpRequest('state', sessionId ? { sessionId } : {}, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setData(value)
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(mcpError(t, e.message))
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [sessionId, revision])
  // 菜单项可能是切换会话之前打开的那份：执行时按现在选的会话和加载状态再核一次，不改别的会话。
  const latest = useRef(null)
  latest.current = { sessionId, loading }
  const change = async (target, hidden) => {
    const now = latest.current
    if (busy || !data?.sessionId || now.loading || (now.sessionId !== '' && now.sessionId !== data.sessionId)) return
    setBusy(true)
    setError('')
    try {
      setData(
        await mcpRequest('change', {
          sessionId: data.sessionId,
          scope,
          revision: data.revision,
          target,
          hidden,
        }),
      )
    } catch (e) {
      setError(mcpError(t, e.message))
    } finally {
      setBusy(false)
    }
  }
  const currentRules = data?.rules.filter((r) => r.scope === scope) ?? [],
    disabled =
      busy ||
      loading ||
      !data?.sessionId ||
      (sessionId !== '' && sessionId !== data.sessionId) ||
      data.excluded ||
      !!data.error ||
      !!data.scopeError
  const toolRule = (name) =>
    currentRules.find(
      (r) =>
        !r.stale && !r.retired && (r.hidden.includes(name) || (r.all && !r.shown.includes(name))),
    )
  const openSession = async (id) => {
    try {
      await ctx.sessions.refresh()
      close?.()
      ctx.uiWorkspace.openSession(id)
    } catch {
      setError(t('mcp.session-unavailable'))
    }
  }
  useEffect(
    () =>
      ctx.contextMenus.register({
        id: MCP_PAGE + '-' + (close ? 'settings' : 'sidebar'),
        target: 'workbench-mcp',
        order: 100,
        resolve: (target) => {
          if (target.owner !== (close ? 'settings' : 'sidebar')) return []
          if (target.kind === 'rule')
            return [
              {
                id: 'remove',
                label: t('mcp.remove'),
                icon: { key: 'dwb-mcp-remove' },
                disabled,
                run: () => change({ kind: 'remove', id: target.id }, false),
              },
            ]
          if (target.kind === 'server') {
            const server = data?.servers.find((s) => s.key === target.key)
            if (!server) return []
            const hidden = currentRules.some(
              (r) => r.serverKey === server.key && r.all && !r.retired && !r.stale,
            )
            return [
              {
                id: 'visibility',
                label: t(hidden ? 'mcp.show' : 'mcp.hide'),
                icon: { key: hidden ? 'dwb-mcp-show' : 'dwb-mcp-hide' },
                disabled:
                  disabled ||
                  !server.bulk ||
                  !server.serverName ||
                  server.serverName.includes('__'),
                run: () => change({ kind: 'server', key: server.key }, !hidden),
              },
            ]
          }
          const tool = data?.tools.find((s) => s.name === target.name),
            stat = data?.statistics.rows.find(
              (s) => s.serverKey === target.serverKey && s.name === target.name,
            ),
            hidden = !!toolRule(target.name)
          const rows = [
            {
              id: 'visibility',
              label: t(hidden ? 'mcp.show' : 'mcp.hide'),
              icon: { key: hidden ? 'dwb-mcp-show' : 'dwb-mcp-hide' },
              disabled: disabled || !tool?.restrictable,
              run: () => change({ kind: 'tool', name: target.name }, !hidden),
            },
          ]
          if (stat?.lastSessionId)
            rows.push({
              id: 'session',
              label: t('mcp.openSession'),
              icon: { key: 'dwb-mcp-session' },
              run: () => openSession(stat.lastSessionId),
            })
          return rows
        },
      }),
    [data, scope, busy, close, loading, sessionId],
  )
  const menu = (e, target) => {
    if (e.type === 'keydown' && e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.focus({ preventScroll: true })
    const r = e.currentTarget.getBoundingClientRect()
    ctx.contextMenus.open(
      { kind: 'workbench-mcp', value: { ...target, owner: close ? 'settings' : 'sidebar' } },
      {
        x: e.type === 'keydown' ? r.left : e.clientX,
        y: e.type === 'keydown' ? r.bottom : e.clientY,
      },
    )
  }
  const stats = data?.statistics.rows ?? [],
    groups = data
      ? [
          ...data.servers,
          ...['unverified', 'resources']
            .filter(
              (key) =>
                data.tools.some((r) => r.serverKey === key) ||
                stats.some((r) => r.serverKey === key),
            )
            .map((key) => ({ key, serverName: t('mcp.' + key) })),
        ]
      : []
  for (const stat of stats)
    if (!groups.some((g) => g.key === stat.serverKey))
      groups.push({ key: stat.serverKey, serverName: t('mcp.stale'), retired: true })
  const filtered = groups.filter((g) =>
    [
      g.serverName,
      g.entryId,
      g.target,
      ...data.tools.filter((r) => r.serverKey === g.key).map((r) => r.name),
      ...stats.filter((r) => r.serverKey === g.key).map((r) => r.name),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const titleOf = (id) => ctx.sessions.list.getSnapshot().byId?.[id]?.displayTitle ?? id
  const phaseOf = (g) =>
    g.enabled === false
      ? 'disabled'
      : ['active', 'pending', 'failed', 'unloading'].includes(g.phase)
        ? g.phase
        : g.phase === 'loading'
          ? 'loadingPhase'
          : 'unloaded'

  const renderTool = (tool, g) => {
    const stat = stats.find((r) => r.serverKey === g.key && r.name === tool.name)
    const detail = h(
      'td',
      null,
      tool.name,
      !tool.restrictable && tool.registered !== false
        ? h('p', { className: 'dwb-mcp-small' }, t('mcp.readonly'))
        : null,
      stat?.inFlight
        ? h('p', { className: 'dwb-mcp-small' }, stat.inFlight + ' ' + t('mcp.inFlight'))
        : null,
      stat?.incomplete
        ? h('p', { className: 'dwb-mcp-small' }, t('mcp.incomplete', { n: stat.incomplete }))
        : null,
      stat?.lastFailureAt
        ? h(
            'p',
            { className: 'dwb-mcp-small' },
            t('mcp.lastFailure') + ' · ' + workbenchClock(stat.lastFailureAt, app.clock),
          )
        : null,
    )
    return h(
      'tr',
      {
        key: tool.name,
        tabIndex: 0,
        onContextMenu: (e) => menu(e, { kind: 'tool', name: tool.name, serverKey: g.key }),
        onKeyDown: (e) => menu(e, { kind: 'tool', name: tool.name, serverKey: g.key }),
      },
      detail,
      h(
        'td',
        null,
        t(
          tool.registered === false
            ? 'mcp.unregistered'
            : tool.visible
              ? 'mcp.visible'
              : 'mcp.hidden',
        ),
      ),
      h('td', null, stat?.calls ?? 0),
      h('td', { className: stat?.failures ? 'dwb-mcp-warn' : '' }, stat?.failures ?? 0),
      h('td', null, stat?.completed ? (stat.durationMs / stat.completed).toFixed(1) + ' ms' : '—'),
    )
  }
  const renderGroup = (g) => {
    const tools = new Map(data.tools.filter((r) => r.serverKey === g.key).map((r) => [r.name, r]))
    for (const r of stats.filter((r) => r.serverKey === g.key))
      if (!tools.has(r.name))
        tools.set(r.name, {
          name: r.name,
          serverKey: g.key,
          registered: false,
          visible: false,
          restrictable: false,
        })
    const total = stats
      .filter((r) => r.serverKey === g.key)
      .reduce((a, r) => ({ calls: a.calls + r.calls, failures: a.failures + r.failures }), {
        calls: 0,
        failures: 0,
      })
    const matches = [...tools.values()].filter(
      (r) =>
        r.name.toLowerCase().includes(query.trim().toLowerCase()) ||
        [g.serverName, g.entryId, g.target]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    return h(
      'div',
      {
        key: g.key,
        className: 'dwb-mcp-server',
        onContextMenu: (e) => menu(e, { kind: 'server', key: g.key }),
        onKeyDown: (e) => {
          if (e.target.closest('tr')) return
          menu(e, { kind: 'server', key: g.key })
        },
      },
      h(
        WorkbenchDisclosure,
        {
          title: g.serverName ?? g.entryId,
          keepContentWhenOpen: true,
          rowClassName: 'dwb-mcp-group-row',
          contentClassName: 'dwb-mcp-group-content',
          contentLayoutClassName: 'dwb-mcp-group-layout',
          titleClassName: 'dwb-mcp-group-title',
          collapsedContent: h(
            'div',
            { className: 'dwb-mcp-summary' },
            h(
              'span',
              { className: 'dwb-mcp-name' },
              h(
                'span',
                null,
                g.serverName ?? g.entryId,
                h(
                  'div',
                  { className: 'dwb-mcp-target' },
                  g.entryId
                    ? (g.transport ?? 'MCP') + ' · ' + (g.target ?? t('mcp.unknownTarget'))
                    : '',
                ),
              ),
            ),
            h(
              'span',
              { className: 'dwb-mcp-small dwb-mcp-phase' },
              g.entryId ? t('mcp.phase') + ' · ' + t('mcp.' + phaseOf(g)) : '',
            ),
            h(
              'span',
              { className: 'dwb-mcp-small' },
              [...tools.values()].filter((r) => r.visible).length +
                '/' +
                tools.size +
                ' ' +
                t('mcp.visible'),
            ),
            h('span', { className: 'dwb-mcp-summary-call' }, total.calls + ' ' + t('mcp.calls')),
            h(
              'span',
              { className: 'dwb-mcp-summary-call' + (total.failures ? ' dwb-mcp-warn' : '') },
              total.failures + ' ' + t('mcp.failures'),
            ),
          ),
        },
        g.key === 'unverified' ? h('p', { className: 'dwb-mcp-small' }, t('mcp.grouping')) : null,
        h(
          'table',
          { className: 'dwb-mcp-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ...['tools', 'visible', 'calls', 'failures', 'average'].map((k) =>
                h('th', { key: k, scope: 'col' }, t('mcp.' + k)),
              ),
            ),
          ),
          h('tbody', null, ...matches.map((tool) => renderTool(tool, g))),
        ),
      ),
    )
  }
  return h(
    'div',
    { className: 'dwb-mcp', 'aria-busy': loading },
    h(
      'header',
      { className: 'dwb-mcp-head' },
      h(ui.IconCordisPluginOutlineRegular, { size: 16 }),
      h('h2', null, t('mcp.title')),
      h('button', { disabled: busy, onClick: () => reload((n) => n + 1) }, t('mcp.refresh')),
    ),
    loading ? h('p', { role: 'status' }, t('mcp.loading')) : null,
    error ? h('p', { className: 'dwb-mcp-notice', role: 'status' }, error) : null,
    data
      ? h(
          Fragment,
          null,
          h(
            'div',
            { className: 'dwb-mcp-filters' },
            h(WorkbenchSelect, {
              label: t('mcp.session'),
              value: data.sessionId ?? '',
              onChange: setSession,
              disabled: busy,
              options: [
                ...(!data.sessionId ? [{ id: '', label: t('mcp.noSession') }] : []),
                ...data.sessions.map((s) => ({ id: s.id, label: titleOf(s.id) })),
              ],
            }),
            h(WorkbenchSelect, {
              label: t('mcp.scope'),
              value: scope,
              onChange: setScope,
              disabled: busy,
              options: [
                { id: 'session', label: t('mcp.current') },
                { id: 'project', label: t('mcp.project') },
              ],
            }),
            h('input', {
              type: 'search',
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: t('mcp.filter'),
              'aria-label': t('mcp.filter'),
            }),
          ),
          data.project ? h('p', { className: 'dwb-mcp-small' }, data.project.path) : null,
          data.excluded ? h('p', { className: 'dwb-mcp-notice' }, t('mcp.excluded')) : null,
          data.error || data.scopeError
            ? h(
                'p',
                { className: 'dwb-mcp-notice', role: 'status' },
                mcpError(t, data.error ?? data.scopeError),
              )
            : null,
          h(
            'p',
            { className: 'dwb-mcp-small' },
            t('mcp.since', { time: workbenchClock(data.statistics.startedAt, app.clock) }),
          ),
          h(
            'div',
            { className: 'dwb-mcp-list' },
            !filtered.length
              ? h('p', null, t(query ? 'mcp.emptyMatch' : 'mcp.empty'))
              : filtered.map(renderGroup),
          ),
          h(
            'section',
            null,
            h('h3', null, t('mcp.rules')),
            currentRules.length
              ? currentRules.map((r) =>
                  h(
                    'div',
                    {
                      key: r.id,
                      className: 'dwb-mcp-rule',
                      tabIndex: 0,
                      'data-stale': r.stale,
                      onContextMenu: (e) => menu(e, { kind: 'rule', id: r.id }),
                      onKeyDown: (e) => menu(e, { kind: 'rule', id: r.id }),
                    },
                    h(
                      'p',
                      null,
                      r.serverName ??
                        t('mcp.' + (r.serverKey === 'resources' ? 'resources' : 'unverified')),
                      ' · ',
                      r.stale
                        ? t('mcp.stale')
                        : r.all
                          ? t('mcp.all')
                          : t('mcp.exact', { n: r.hidden.length }),
                    ),
                    r.shown.length
                      ? h(
                          'p',
                          { className: 'dwb-mcp-small' },
                          t('mcp.exceptions', { n: r.shown.length }),
                        )
                      : null,
                  ),
                )
              : h('p', { className: 'dwb-mcp-small' }, t('mcp.noRules')),
          ),
          h(
            'footer',
            { className: 'dwb-mcp-foot dwb-mcp-small' },
            h('p', null, t('mcp.measure')),
            h('p', null, t('mcp.effect')),
            data.statistics.droppedCalls || data.statistics.droppedPending
              ? h(
                  'p',
                  null,
                  t('mcp.limited', {
                    calls: data.statistics.droppedCalls,
                    pending: data.statistics.droppedPending,
                  }),
                )
              : null,
          ),
        )
      : null,
  )
}
function applyMcp(app) {
  const { ctx, t } = app,
    disposers = [],
    keep = (d) => disposers.push(d)
  keep(mountModuleStyle(MCP_PAGE, MCP_STYLE))
  keep(
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: MCP_PAGE,
          order: 30,
          label: () => t('mcp.title'),
          locale: '@miint-sunny/dsh-workbench',
        },
        (props) => h(McpPanel, { ...props, app }),
      ),
    ),
  )
  keep(
    ctx.slots.inject('settings.section.icon', () =>
      ctx.slots.register({ name: 'settings.section.icon', id: MCP_PAGE }, (props) =>
        h(ui.IconCordisPluginOutlineRegular, props),
      ),
    ),
  )
  keep(
    ctx.slots.inject('contextMenu.icon', function* () {
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-mcp-show' }, (props) =>
        h(ui.IconCheckOutlineRegular, props),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-mcp-hide' }, (props) =>
        h(ui.IconCloseOutlineRegular, props),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-mcp-remove' }, (props) =>
        h(ui.IconTrashOutlineRegular, props),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-mcp-session' }, (props) =>
        h(ui.IconQueueOutlineRegular, props),
      )
    }),
  )
  keep(
    ctx.sidebarRightTabs.register({
      id: MCP_PAGE,
      kind: MCP_KIND,
      title: () => t('mcp.title'),
      guide: [
        {
          id: 'mcp',
          order: 58,
          title: () => t('mcp.title'),
          description: () => t('mcp.guide'),
          icon: (props) => h(ui.IconCordisPluginOutlineRegular, props),
        },
      ],
    }),
  )
  keep(
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: MCP_PAGE, locale: '@miint-sunny/dsh-workbench' },
        (props) => h(McpPanel, { ...props, app }),
      ),
    ),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

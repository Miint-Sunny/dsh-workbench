/** 原生审批详情与设置列表。答复使用当前 PendingApproval，不查找或点击 DOM 按钮。 */
import { mountModuleStyle } from './style.js'
const RULES_INJECT = ['uiSession', 'contextMenus', 'sidebarRight'],
  RULES_PAGE = 'dsh-workbench-approval-rules',
  RULES_KIND = 'wbrules'
const RULES_STYLE = `
.dwb-rules,.dwb-rule-detail{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dwb-rules{height:100%;overflow:auto;padding:16px;box-sizing:border-box;container:rules/inline-size}.dwb-rules *,.dwb-rule-detail *{box-sizing:border-box;min-width:0}.dwb-rules h2,.dwb-rules h3,.dwb-rule-detail h3,.dwb-rules p,.dwb-rule-detail p{margin:0}.dwb-rules h2,.dwb-rules h3,.dwb-rule-detail h3{font-size:14px;font-weight:500}:where(.dwb-rules) button,:where(.dwb-rules) input:not([type=checkbox]),:where(.dwb-rule-detail) button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:4px 8px;min-height:28px}:where(.dwb-rules) button,:where(.dwb-rule-detail) button{cursor:pointer}:where(.dwb-rules) button:disabled,:where(.dwb-rule-detail) button:disabled{opacity:.5;cursor:default}.dwb-rules :focus-visible,.dwb-rule-detail :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.dwb-rules-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}.dwb-rules-head h2{flex:1}.dwb-rules-note{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin-block:10px!important}.dwb-rules-search{width:100%;margin:14px 0}.dwb-rules-row{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere;cursor:context-menu}.dwb-rules-row[data-enabled=false]{color:var(--dsw-alias-label-secondary)}.dwb-rules-row header{display:flex;align-items:start;gap:12px;justify-content:space-between}.dwb-rules-row code,.dwb-rule-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.dwb-rule-detail{display:grid;gap:8px}.dwb-rule-detail pre{margin:0;max-height:160px;overflow:auto}.dwb-rule-detail summary{cursor:pointer;min-height:28px}.dwb-rule-detail>button{justify-self:start}.dwb-rule-detail dialog{color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:18px;width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}.dwb-rule-detail dialog::backdrop{background:var(--dsw-alias-bg-mask-1)}.dwb-rule-detail dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px;margin-block:16px}.dwb-rule-detail dt{color:var(--dsw-alias-label-secondary)}.dwb-rule-detail dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.dwb-rules-actions{display:flex;justify-content:end;gap:8px;margin-top:16px;flex-wrap:wrap}.dwb-rule-detail fieldset{border:0;padding:0;margin:12px 0}.dwb-rule-detail label{display:flex;align-items:center;gap:8px;min-height:32px}:where(.dwb-rule-detail) input:not([type=checkbox]){accent-color:var(--dsw-alias-state-business-primary)}
@media(max-width:500px){.dwb-rule-detail dl{grid-template-columns:1fr;gap:4px}.dwb-rule-detail dd{margin-bottom:8px}:where(.dwb-rules) input:not([type=checkbox]){font-size:16px}}
`
async function rulesRequest(action, body = {}, signal) {
  const get = ['list', 'pending'].includes(action),
    response = await fetch(
      '/api/dsh-workbench.approval-rules.' + action + (get ? '?' + new URLSearchParams(body) : ''),
      {
        method: get ? 'GET' : 'POST',
        ...(get
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal,
      },
    )
  const value = await response.json()
  if (!response.ok) throw new Error(value.error?.code ?? 'write-failed')
  return value
}
function rulesError(t, code) {
  return t(Object.hasOwn(RULES_ZH, 'rules.' + code) ? 'rules.' + code : 'rules.fail')
}
function RuleApprovalDetail({ callId, sessionId, useChat, useSessionStatus, app }) {
  const t = app.t,
    root = useChat((snapshot) => {
      for (const node of snapshot.nodes.values()) {
        const r = node.kind === 'tool-call' ? node.data.root : null
        if (r?.callId === callId && !('kind' in r) && r.phase === 'start') return r
      }
      return null
    }),
    pending = useSessionStatus((snapshot) => snapshot.get(sessionId)?.pendingInteraction)
  const nativeArgs = useMemo(() => {
    try {
      return JSON.parse(root?.argsRaw ?? 'null')
    } catch {
      return null
    }
  }, [root?.argsRaw])
  const original = typeof nativeArgs?.command === 'string' ? nativeArgs.command : null
  const supported =
    root?.name === 'bash' &&
    pending?.kind === 'approval' &&
    pending.toolName === 'bash' &&
    pending.callId === callId &&
    typeof pending.answer === 'function'
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [options, setOptions] = useState([]),
    [revision, reload] = useState(0),
    dialog = useRef(null),
    button = useRef(null),
    sendLock = useRef(false),
    operation = useRef(null)
  useEffect(() => {
    if (!supported) {
      setData(null)
      return
    }
    const abort = new AbortController()
    setData(null)
    setError('')
    void rulesRequest('pending', { sessionId, callId }, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setData(value)
          setOptions(value.proposal?.pattern.required ?? [])
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(rulesError(t, e.message))
      })
    return () => abort.abort()
  }, [supported, pending?.key, sessionId, callId, revision])
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else if (dialog.current?.open) dialog.current.close()
  }, [open])
  const dismiss = () => {
    operation.current?.abort()
    setOpen(false)
    button.current?.focus()
  }
  const confirm = async () => {
    if (sendLock.current || !data?.eligible || !pending.answerable) return
    sendLock.current = true
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    try {
      const response = await rulesRequest(
        'create',
        { sessionId, callId, token: data.token, revision: data.revision, options },
        controller.signal,
      )
      if (controller.signal.aborted) return
      operation.current = null
      if (
        response.answerable &&
        pending.answerable &&
        app.ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction === pending
      ) {
        await pending.answer('allowed-once')
        dismiss()
      } else {
        setError(t('rules.withdrawn'))
        setData(null)
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(rulesError(t, e.message))
    } finally {
      if (operation.current === controller) operation.current = null
      sendLock.current = false
      setBusy(false)
    }
  }
  if (!supported || data?.reason === 'excluded') return original
  const proposal = data?.proposal
  // 受保护的目标永远建不了规则，规则说明和「刷新」对它没有用。
  const protectedTarget = data?.reason === 'protected-target'
  return h(
    'div',
    { className: 'dwb-rule-detail' },
    original ? h('pre', null, original) : null,
    nativeArgs
      ? h(
          WorkbenchDisclosure,
          { title: t('rules.native') },
          h('pre', null, JSON.stringify(nativeArgs, null, 2)),
        )
      : null,
    data && !protectedTarget ? h('p', { className: 'dwb-rules-note' }, t('rules.limit')) : null,
    !data && !error ? h('p', { role: 'status' }, t('rules.loading')) : null,
    data && !data.eligible
      ? h('p', { className: 'dwb-rules-note' }, rulesError(t, data.reason))
      : null,
    h(
      'button',
      {
        ref: button,
        type: 'button',
        disabled: busy || !data?.eligible || !pending.answerable,
        onClick: () => setOpen(true),
      },
      t('rules.create'),
    ),
    data && !data.eligible && !protectedTarget
      ? h(
          'button',
          { type: 'button', disabled: busy, onClick: () => reload((n) => n + 1) },
          t('rules.refresh'),
        )
      : null,
    error && !open ? h('p', { role: 'status' }, error) : null,
    h(
      'dialog',
      {
        ref: dialog,
        'aria-label': t('rules.preview'),
        onKeyDown: (e) => e.stopPropagation(),
        onCancel: (e) => {
          e.preventDefault()
          e.stopPropagation()
          dismiss()
        },
        onClick: (e) => {
          if (e.target === dialog.current) {
            const r = e.target.getBoundingClientRect()
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              dismiss()
          }
        },
      },
      h('h3', null, t('rules.preview')),
      h('p', { className: 'dwb-rules-note' }, t('rules.limit')),
      proposal
        ? h(
            Fragment,
            null,
            h(
              'dl',
              null,
              ...[
                ['project', proposal.project.path],
                ['cwd', proposal.cwd],
                ['executable', proposal.executable],
                ['sandbox', t('rules.mode.' + proposal.sandboxMode)],
                ['fixed', proposal.pattern.fixed.join(' ')],
              ].flatMap(([key, value]) => [
                h('dt', { key: key + '-name' }, t('rules.' + key)),
                h('dd', { key: key + '-value' }, value),
              ]),
            ),
            h(
              'fieldset',
              null,
              h('legend', null, t('rules.optional')),
              proposal.pattern.offered.length
                ? proposal.pattern.offered.map((value) =>
                    h(ui.Checkbox, {
                      key: value,
                      label: value,
                      checked: options.includes(value),
                      disabled: busy || proposal.pattern.required.includes(value),
                      onChange: (checked) =>
                        setOptions((old) =>
                          checked ? [...old, value] : old.filter((v) => v !== value),
                        ),
                    }),
                  )
                : h('p', null, t('rules.noOptional')),
            ),
            h('p', { className: 'dwb-rules-note' }, t('rules.scope')),
          )
        : null,
      error ? h('p', { role: 'status' }, error) : null,
      h(
        'div',
        { className: 'dwb-rules-actions' },
        h('button', { type: 'button', onClick: dismiss }, t(busy ? 'rules.close' : 'rules.cancel')),
        h(
          'button',
          { type: 'button', disabled: busy, onClick: () => reload((n) => n + 1) },
          t('rules.refresh'),
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: busy || !data?.eligible || !pending.answerable,
            onClick: confirm,
          },
          t('rules.confirm'),
        ),
      ),
    ),
  )
}
function ApprovalRulesPanel({ app, close }) {
  const { ctx, t } = app,
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [revision, reload] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    void rulesRequest('list', {}, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setData(value)
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(rulesError(t, e.message))
      })
    return () => abort.abort()
  }, [revision])
  const change = async (id, action) => {
    setBusy(true)
    setError('')
    try {
      setData(await rulesRequest('change', { id, action, revision: data.revision }))
    } catch (e) {
      setError(rulesError(t, e.message))
    } finally {
      setBusy(false)
    }
  }
  useEffect(
    () =>
      ctx.contextMenus.register({
        id: RULES_PAGE + '-' + (close ? 'settings' : 'sidebar'),
        target: 'workbench-approval-rule',
        order: 100,
        resolve: ({ id, owner }) => {
          if (owner !== (close ? 'settings' : 'sidebar')) return []
          const rule = data?.rules.find((r) => r.id === id)
          return rule
            ? [
                {
                  id: 'toggle',
                  label: t(rule.enabled ? 'rules.disable' : 'rules.enable'),
                  icon: { key: rule.enabled ? 'dwb-rules-disable' : 'dwb-rules-enable' },
                  disabled: busy,
                  run: () => change(id, rule.enabled ? 'disable' : 'enable'),
                },
                {
                  id: 'remove',
                  label: t('rules.remove'),
                  icon: { key: 'dwb-rules-remove' },
                  disabled: busy,
                  run: () => change(id, 'remove'),
                },
              ]
            : []
        },
      }),
    [data, busy, close],
  )
  const menu = (event, id) => {
    if (
      event.type === 'keydown' &&
      event.key !== 'ContextMenu' &&
      !(event.shiftKey && event.key === 'F10')
    )
      return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    const r = event.currentTarget.getBoundingClientRect()
    ctx.contextMenus.open(
      { kind: 'workbench-approval-rule', value: { id, owner: close ? 'settings' : 'sidebar' } },
      {
        x: event.type === 'keydown' ? r.left : event.clientX,
        y: event.type === 'keydown' ? r.bottom : event.clientY,
      },
    )
  }
  const rows =
    data?.rules.filter((r) =>
      [r.projectPath, r.cwd, r.executable, ...r.pattern.fixed, ...r.pattern.optional]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    ) ?? []
  return h(
    'div',
    { className: 'dwb-rules' },
    h(
      'header',
      { className: 'dwb-rules-head' },
      h(ui.IconShieldOutlineRegular, { size: 16 }),
      h('h2', null, t('rules.title')),
      h('button', { disabled: busy, onClick: () => reload((n) => n + 1) }, t('rules.refresh')),
    ),
    h('p', { className: 'dwb-rules-note' }, t('rules.limit')),
    error || data?.error ? h('p', { role: 'status' }, error || rulesError(t, data.error)) : null,
    data?.lastIssue ? h('p', { role: 'status' }, rulesError(t, data.lastIssue)) : null,
    h('input', {
      className: 'dwb-rules-search',
      type: 'search',
      value: query,
      onChange: (e) => setQuery(e.target.value),
      placeholder: t('rules.search'),
      'aria-label': t('rules.search'),
    }),
    !data
      ? h('p', { role: 'status' }, t('rules.loadingList'))
      : h(
          Fragment,
          null,
          h('p', { className: 'dwb-rules-note' }, t('rules.matches', { n: data.matches })),
          rows.length
            ? rows.map((r) =>
                h(
                  'article',
                  {
                    key: r.id,
                    className: 'dwb-rules-row',
                    tabIndex: 0,
                    'data-enabled': r.enabled,
                    onContextMenu: (e) => menu(e, r.id),
                    onKeyDown: (e) => menu(e, r.id),
                  },
                  h(
                    'header',
                    null,
                    h('code', null, [r.executable, ...r.pattern.fixed].join(' ')),
                    h('span', null, t(r.enabled ? 'rules.enabled' : 'rules.disabled')),
                  ),
                  h('p', { className: 'dwb-rules-note' }, r.projectPath),
                  h(
                    'p',
                    { className: 'dwb-rules-note' },
                    t('rules.sandbox') + ' · ' + t('rules.mode.' + r.sandboxMode),
                  ),
                  h('p', { className: 'dwb-rules-note' }, t('rules.cwd') + ' · ' + r.cwd),
                  h(
                    'p',
                    { className: 'dwb-rules-note' },
                    r.pattern.optional.length
                      ? t('rules.optional') + ' · ' + r.pattern.optional.join(' ')
                      : t('rules.noOptional'),
                  ),
                ),
              )
            : h('p', null, t(query ? 'rules.noMatch' : 'rules.empty')),
        ),
  )
}
function applyApprovalRules(app) {
  const { ctx, t } = app,
    disposers = [],
    keep = (d) => disposers.push(d)
  keep(mountModuleStyle(RULES_PAGE, RULES_STYLE))
  keep(
    ctx.slots.inject('conversation.approval.detail', () =>
      ctx.slots.register(
        {
          name: 'conversation.approval.detail',
          priority: -1,
          select: (props) => {
            const pending = ctx.uiSession.sessionStatus
              .getSnapshot()
              .get(props.sessionId)?.pendingInteraction
            return pending?.kind === 'approval' &&
              pending.toolName === 'bash' &&
              pending.callId === props.callId
              ? pending
              : null
          },
          locale: '@miint-sunny/dsh-workbench',
        },
        (props) => h(RuleApprovalDetail, { ...props, app }),
      ),
    ),
  )
  keep(
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: RULES_PAGE,
          order: 40,
          label: () => t('rules.title'),
          locale: '@miint-sunny/dsh-workbench',
        },
        (props) => h(ApprovalRulesPanel, { ...props, app }),
      ),
    ),
  )
  keep(
    ctx.slots.inject('settings.section.icon', () =>
      ctx.slots.register({ name: 'settings.section.icon', id: RULES_PAGE }, (props) =>
        h(ui.IconShieldOutlineRegular, props),
      ),
    ),
  )
  keep(
    ctx.slots.inject('contextMenu.icon', function* () {
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-rules-enable' }, (props) =>
        h(ui.IconCheckOutlineRegular, props),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-rules-disable' }, (props) =>
        h(ui.IconCloseOutlineRegular, props),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-rules-remove' }, (props) =>
        h(ui.IconTrashOutlineRegular, props),
      )
    }),
  )
  keep(
    ctx.sidebarRightTabs.register({
      id: RULES_PAGE,
      kind: RULES_KIND,
      title: () => t('rules.title'),
      guide: [
        {
          id: 'approval-rules',
          order: 59,
          title: () => t('rules.title'),
          description: () => t('rules.guide'),
          icon: (props) => h(ui.IconShieldOutlineRegular, props),
        },
      ],
    }),
  )
  keep(
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: RULES_PAGE, locale: '@miint-sunny/dsh-workbench' },
        (props) => h(ApprovalRulesPanel, { ...props, app }),
      ),
    ),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

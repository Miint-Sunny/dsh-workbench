/**
 * 模型页：打开「设置 → 模型」就是这一页，左边分类、右边提供商。已添加的点开进详情，没添加的点开进填写页，都只点一次。
 * 标题、搜索框和分类栏不动，只有右边的列表滚动（高度由 section.js 的 dms-fill 和 style.js 给）。
 */

/** DSH 自带的两条 DeepSeek 线路，不在 pi-ai 命名空间里。 */
const BUILT_IN_ROUTES = ['deepseek-account', 'deepseek-official']

/**
 * 交给 pickerEntries 的行：pi-ai 命名空间里的和两条 DeepSeek 内置线路，不含伴随条目（它们在原提供商的详情页里管理）。
 * DeepSeek 账号这一行只在已登录、账号列得出模型时才有，算已添加。
 * @param {object} snapshot 页面快照。
 * @returns {{ provider: string, configured: boolean, declared?: boolean, displayName?: string, defaultBaseURL?: string }[]} 行。
 */
function catalogRows(snapshot) {
  return snapshot.rows.filter(row => row.companionOf === undefined && (row.entry.settingsNs === 'llm-pi-ai' || BUILT_IN_ROUTES.includes(row.entry.provider)))
    .map(row => ({
      provider: row.entry.provider,
      configured: row.configured || row.entry.provider === 'deepseek-account',
      ...row.entry.declared === true ? { declared: true } : {},
      ...row.entry.displayName === undefined ? {} : { displayName: row.entry.displayName },
      ...row.entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: row.entry.defaultBaseURL },
    }))
}

/**
 * 「已添加」的行，照原来列表页：已配置的和已登录的 DeepSeek 账号，每条线路一行，顺序照目录拼接的顺序。
 * 只藏拼行时标出来的伴随条目（插件自己建的、原提供商已配置）；手写的同形条目、原提供商不在了的照常显示，能看、能删。
 * @param {object} snapshot 页面快照。
 * @returns {object[]} 拼好的行。
 */
function addedRows(snapshot) {
  return snapshot.rows.filter(row => (row.configured || row.entry.provider === 'deepseek-account') && row.companionOf === undefined)
}

/**
 * 点开一条线路去哪：已添加的进详情，预设进预先填好的自定义模型 API，其余进填写页并选好这一条。
 * @param {object} variant pickerEntries 给的线路。
 * @returns {object} go 的参数。
 */
function variantRoute(variant) {
  if (variant.added) return { page: 'detail', provider: variant.provider }
  if (variant.preset !== undefined) return { page: 'custom', preset: variant.preset.route }
  return { page: 'fill', family: variant.familyId, route: variant.route }
}

/**
 * 点整行打开哪一条：有已添加的进第一条已添加的，没有就进第一条的填写页。
 * @param {object} entry 条目。
 * @returns {object} 线路。
 */
function mainVariant(entry) {
  return entry.variants.find(variant => variant.added) ?? entry.variants[0]
}

const NO_ACCOUNT = { available: false, view: undefined, failed: false }
const noSubscribe = () => () => {}
const noAccount = () => NO_ACCOUNT

/**
 * DeepSeek 账号的登录状态（account.js）；没有账号功能时是 NO_ACCOUNT。
 * @param {object} app 插件的共享对象。
 * @returns {{ available: boolean, view?: object, failed: boolean }} 状态。
 */
function useAccount(app) {
  return useSyncExternalStore(app.account?.subscribe ?? noSubscribe, app.account?.getSnapshot ?? noAccount)
}

/**
 * 登录进行到哪一步，照官方登录框（dsh-client-ui-settings-account 的 SignInDialog.tsx）分成几种显示。DSH 以后新加的阶段按没在登录处理。
 * @param {{ view?: object, failed: boolean }} account 登录状态。
 * @returns {'idle' | 'starting' | 'waiting' | 'committing' | 'failed' | 'expired'} 显示用的阶段。
 */
function signInStage(account) {
  if (account.starting === true) return 'starting'
  if (account.failed) return 'failed'
  switch (account.view?.attempt?.phase) {
    case 'initializing': return 'starting'
    case 'waiting-browser':
    case 'exchanging': return 'waiting'
    case 'committing': return 'committing'
    case 'failed': return 'failed'
    case 'expired': return 'expired'
    default: return 'idle'
  }
}

const STAGE_TEXT = { idle: 'accountSignedOut', starting: 'accountStarting', waiting: 'accountWaiting', committing: 'accountWaiting', failed: 'accountFailed', expired: 'accountExpired' }

/**
 * 一行：图标、名字和标签、下面一行、右边。onOpen 给了时整行是一个按钮（盖在下面的透明按钮），线路按钮和登录按钮叠在它上面；
 * 这时看得见的文字不再给读屏，整行按钮的 label 写全名字、标签、说明和状态。
 */
function ProviderRowShell({ id, index, icon, name, tags, body, side, label, onOpen, disabled, card, active }) {
  return h('li', { className: card ? 'dms-pv dms-pv-card' : 'dms-pv', 'data-entry': id, 'data-index': index, 'data-active': active ? 'true' : undefined },
    onOpen === undefined ? null : h('button', { type: 'button', className: 'dms-pv-hit', 'aria-label': label, disabled, onClick: onOpen }),
    icon,
    h('span', { className: 'dms-main' },
      h('span', { className: 'dms-name', 'aria-hidden': onOpen === undefined ? undefined : 'true' }, name, (tags ?? []).map(tag => h('span', { key: tag, className: 'dms-tag' }, tag))),
      body),
    h('span', { className: 'dms-pv-side' }, side))
}

/** 状态：正常时只有绿点（文字在整行按钮的 label 里），有问题才写字。 */
function RowState({ status }) {
  if (status.tone === 'ok') return h('span', { className: 'dms-dot', 'data-tone': 'ok', 'aria-hidden': 'true' })
  return h('span', { 'aria-hidden': 'true' }, h(State, { status }))
}

/**
 * 已添加的一条线路下面写的说明：域名、几个模型、默认模型（照原来的列表卡片）。
 * @param {object} app 插件的共享对象。
 * @param {object} snapshot 页面快照。
 * @param {object} row 拼好的行。
 * @returns {string} 说明，可能为空。
 */
function addedMetaLine(app, snapshot, row) {
  const companions = snapshot.rows.filter(candidate => candidate.companionOf?.origin === row.entry.provider).map(candidate => candidate.entry.provider)
  const facts = catalogFactsOf(row.entry.provider, snapshot.catalog, companions)
  return [
    metaOf(row).domain,
    facts.count === undefined ? undefined : app.t('metaModels', { count: facts.count }),
    facts.defaultModel === undefined ? undefined : app.t('metaDefault', { model: facts.defaultModel }),
  ].filter(Boolean).join(' · ')
}

/** 「已添加」一行的数据与读屏标签。 */
function addedRowData(app, snapshot, row) {
  const meta = metaOf(row)
  const status = statusOf(app, snapshot, row)
  const tags = [meta.tag, row.entry.declared === true ? app.t('customTag') : undefined].filter(Boolean)
  const line = addedMetaLine(app, snapshot, row)
  return { meta, status, tags, line, label: [meta.name, ...tags, line, status.text].filter(Boolean).join(' ') }
}

/** 「已添加」里的一行：一条线路，内容照原来的列表卡片。 */
function AddedRow({ app, snapshot, row, go, index, active }) {
  const { meta, status, tags, line, label } = addedRowData(app, snapshot, row)
  return h(ProviderRowShell, {
    id: row.entry.provider, index, icon: h(Icon, { meta }), name: meta.name, tags, active,
    body: line.length === 0 ? null : h('span', { className: 'dms-meta', 'aria-hidden': 'true' }, line),
    side: h(Fragment, null, h(RowState, { status }), h(Chevron)),
    label,
    onOpen: () => go({ page: 'detail', provider: row.entry.provider }),
  })
}

/** 单线路条目在分类里的数据与读屏标签。 */
function singleEntryData(app, snapshot, entry, single) {
  const row = single.added ? snapshot.rows.find(candidate => candidate.entry.provider === single.provider) : undefined
  const status = row === undefined ? undefined : statusOf(app, snapshot, row)
  const tags = [single.tag, entry.kind === 'custom' ? app.t('customTag') : undefined].filter(Boolean)
  const line = row === undefined ? single.domain ?? '' : addedMetaLine(app, snapshot, row)
  return { status, tags, line, label: [entry.name, ...tags, line, status?.text].filter(Boolean).join(' ') }
}

/** 多线路条目在分类里的按钮文案、问题状态与整行读屏标签。 */
function multiEntryData(app, snapshot, entry) {
  const variants = entry.variants.map((variant) => {
    const row = variant.added ? snapshot.rows.find(candidate => candidate.entry.provider === variant.provider) : undefined
    const status = row === undefined ? undefined : statusOf(app, snapshot, row)
    const rawLabel = variant.label ?? variant.route
    const chipText = variant.added ? app.t('variantAdded', { label: rawLabel }) : rawLabel
    const chipLabel = [entry.name, chipText, status?.text].filter(Boolean).join(' ')
    return { variant, status, rawLabel, chipText, chipLabel }
  })
  const addedStatuses = variants.filter(item => item.status !== undefined)
  const problems = addedStatuses.filter(item => item.status.tone !== 'ok').map(item => ({
    ...item.status,
    text: app.t('variantStatus', { label: item.rawLabel, status: item.status.text }),
  }))
  const label = [entry.name, ...addedStatuses.map(item => app.t('variantStatus', { label: item.rawLabel, status: item.status.text }))].join(' ')
  return { variants, problems, label }
}

/** 分类里的一家：一条线路时写说明和状态，几条线路时每条一个按钮。 */
function EntryRow({ app, snapshot, entry, go, canAdd, index, active }) {
  const meta = { color: entry.family.color, initials: entry.family.initials }
  const single = entry.variants.length === 1 ? entry.variants[0] : undefined
  const main = mainVariant(entry)
  const open = () => go(variantRoute(main))
  if (single !== undefined) {
    const { status, tags, line, label } = singleEntryData(app, snapshot, entry, single)
    return h(ProviderRowShell, {
      id: entry.family.id, index, icon: h(Icon, { meta }), name: entry.name, tags, active,
      body: line.length === 0 ? null : h('span', { className: 'dms-meta', 'aria-hidden': 'true' }, line),
      side: h(Fragment, null, status === undefined ? null : h(RowState, { status }), h(Chevron)),
      label,
      onOpen: open, disabled: !single.added && !canAdd,
    })
  }
  const { variants, problems, label } = multiEntryData(app, snapshot, entry)
  return h(ProviderRowShell, {
    id: entry.family.id, index, icon: h(Icon, { meta }), name: entry.name, active,
    body: h(Fragment, null,
      h('span', { className: 'dms-chips' }, variants.map(({ variant, chipText, chipLabel }) => h('button', {
        key: variant.route, type: 'button', className: 'dms-chip', 'aria-label': chipLabel, disabled: !variant.added && !canAdd, onClick: () => go(variantRoute(variant)),
      }, chipText))),
      problems.length === 0 ? null : h('span', { className: 'dms-states', 'aria-hidden': 'true' }, problems.map(status => h(State, { key: status.text, status })))),
    side: h(Chevron),
    label,
    onOpen: open, disabled: !main.added && !canAdd,
  })
}

/** DeepSeek 账号：没登录时右边是「登录」，直接走官方的浏览器登录；登录后写「已登录」，点开是只读的账号页。 */
function AccountRow({ app, entry, account, go, index, active }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(undefined)
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => { liveRef.current = false }
  }, [])
  const attempt = account.view?.attempt
  useEffect(() => { setCopied(undefined) }, [attempt?.id, attempt?.authorizeUrl])
  useEffect(() => {
    if (copied === undefined) return undefined
    const timer = setTimeout(() => setCopied(undefined), 2000)
    return () => { clearTimeout(timer) }
  }, [copied])
  const meta = { color: entry.family.color, initials: entry.family.initials }
  const opens = entry.variants[0].added
  if (opens || account.view?.status === 'credential-stored') {
    return h(ProviderRowShell, {
      id: entry.family.id, index, icon: h(Icon, { meta }), name: entry.name, active,
      body: h('span', { className: 'dms-meta', 'aria-hidden': opens ? 'true' : undefined }, app.t('statusSignedIn')),
      side: opens ? h(Chevron) : null,
      label: `${entry.name} ${app.t('statusSignedIn')}`,
      onOpen: opens ? () => go({ page: 'detail', provider: entry.family.id }) : undefined,
    })
  }
  const stage = signInStage(account)
  const actionBusy = busy || account.starting === true || account.cancelling === true
  const run = async (action) => {
    setBusy(true)
    try { await action() } finally { if (liveRef.current) setBusy(false) }
  }
  const signIn = () => { void run(() => app.account.signIn()) }
  const waiting = stage === 'waiting' || stage === 'committing'
  const btnText = app.t(stage === 'idle' ? 'accountSignIn' : stage === 'failed' || stage === 'expired' ? 'accountRetry' : 'cancel')
  const side = stage === 'idle' || stage === 'failed' || stage === 'expired'
    ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: actionBusy, 'aria-label': `${entry.name} ${btnText}`, onClick: signIn }, btnText)
    : h(ui.Button, { variant: 'outline', size: 'sm', disabled: actionBusy || stage === 'committing' || attempt == null, 'aria-label': `${entry.name} ${btnText}`,
      onClick: () => { void run(() => app.account.cancel(attempt.id)) } }, btnText)
  return h(ProviderRowShell, {
    id: entry.family.id, index, icon: h(Icon, { meta }), name: entry.name, active, side,
    body: h('span', { className: 'dms-meta dms-meta-wrap' },
      h('span', { role: 'status', 'aria-live': 'polite' }, app.t(STAGE_TEXT[stage])),
      waiting && attempt?.authorizeUrl !== undefined
        ? h(Fragment, null, ' · ', h('button', { type: 'button', className: 'dms-link', onClick: () => { void app.account.copyLink(attempt.authorizeUrl).then((result) => { if (liveRef.current) setCopied(result) }) } },
          copied === undefined ? app.t('accountCopyLink') : app.t(copied === 'copied' ? 'accountCopied' : 'accountCopyFailed')))
        : null),
  })
}

/** 「自定义模型 API」：常用和全部的第一个。 */
function CustomEntryRow({ app, go, canAdd, index, active }) {
  return h(ProviderRowShell, {
    id: 'custom', index, card: true, active,
    icon: h('span', { className: 'dms-ico', style: { '--dms-c': '#4b4d52' }, 'aria-hidden': 'true' }, h(ui.IconPlusOutlineRegular, { size: 16 })),
    name: app.t('customEntry'),
    body: h('span', { className: 'dms-meta', 'aria-hidden': 'true' }, app.t('customEntryHint')),
    side: h(Chevron),
    label: `${app.t('customEntry')} ${app.t('customEntryHint')}`,
    onOpen: () => go({ page: 'custom' }), disabled: !canAdd,
  })
}

/** 「已添加」：一个可用的提供商都没有时，照原来列表页的条件和原文写空状态。 */
function EmptyAdded({ app, snapshot, go, onOther }) {
  const official = snapshot.rows.find(row => row.entry.provider === 'deepseek-official')
  return h('div', { className: 'dms-empty' },
    h('h3', { className: 'dms-empty-title' }, app.t('emptyTitle')),
    h('p', { className: 'dms-intro' }, app.t('emptyBody')),
    h('div', { className: 'dms-row' },
      official === undefined ? null : h(ui.Button, { variant: 'primary', onClick: () => go({ page: 'detail', provider: official.entry.provider }) }, app.t('emptyDeepSeek')),
      h(ui.Button, { variant: 'outline', onClick: onOther }, app.t('emptyOther'))))
}

/**
 * 这一项的整行操作能不能用：已添加的都能打开；没添加的要设置可写；DeepSeek 账号没登录时整行没有操作（登录是右边的按钮）。
 * @param {object} item 列表里的一项。
 * @param {boolean} canAdd 能不能添加。
 * @returns {boolean} 能用时为 true。
 */
function itemOpens(item, canAdd) {
  if (item.row !== undefined) return true
  if (item.custom) return canAdd
  const main = mainVariant(item.entry)
  if (item.entry.family.id === 'deepseek-account') return main.added
  return main.added || canAdd
}

/**
 * 列表里可打开一项的读屏名字，供键盘方向键高亮时播报。
 * @param {object} app 插件的共享对象。
 * @param {object} snapshot 页面快照。
 * @param {object} item 列表里的一项。
 * @returns {string} 读屏名字。
 */
function itemLabel(app, snapshot, item) {
  if (item.row !== undefined) return addedRowData(app, snapshot, item.row).label
  if (item.custom) return `${app.t('customEntry')} ${app.t('customEntryHint')}`
  if (item.entry.family.id === 'deepseek-account') return `${item.entry.name} ${app.t('statusSignedIn')}`
  if (item.entry.variants.length === 1) return singleEntryData(app, snapshot, item.entry, item.entry.variants[0]).label
  return multiEntryData(app, snapshot, item.entry).label
}

function ListPage({ app, snapshot, go, saved, notice }) {
  const [category, setCategoryState] = useState(() => app.memory?.category ?? 'common')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const [focused, setFocused] = useState(false)
  const [announced, setAnnounced] = useState('')
  const listRef = useRef(null)
  useEffect(() => {
    if (listRef.current !== null) listRef.current.scrollTop = 0
  }, [category, query])
  const account = useAccount(app)
  const canSignIn = account.available && account.view !== undefined
  const entries = useMemo(() => (snapshot.status === 'ready' ? pickerEntries(catalogRows(snapshot), { account: canSignIn }) : []), [snapshot, canSignIn])
  const setCategory = (next) => {
    if (app.memory !== undefined) app.memory.category = next
    setCategoryState(next)
    setQuery('')
    setActive(-1)
    setAnnounced('')
  }
  const title = h('h2', { className: 'dms-title' }, app.t('title'))
  if (snapshot.status === 'error') {
    return h(Fragment, null, title,
      h('p', { className: 'dms-note dms-err', role: 'alert' }, app.t('loadFailed', { message: snapshot.error ?? '' })),
      h('div', null, h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void app.store.load() } }, app.t('retry'))))
  }
  if (snapshot.status !== 'ready') {
    return h(Fragment, null, title,
      h('div', { className: 'dms-rows', 'aria-busy': 'true' }, h('div', { className: 'dms-skel' }), h('div', { className: 'dms-skel' }), h('div', { className: 'dms-skel' })))
  }
  const canAdd = snapshot.writable && snapshot.namespaces.has('llm-pi-ai')
  const categories = categoriesOf(entries)
  const searching = query.trim().length > 0
  const shown = searching ? 'all' : categories.includes(category) ? category : 'common'
  const added = addedRows(snapshot)
  const listed = shown === 'added' ? [] : searching ? searchEntries(entriesIn(entries, 'all'), query) : entriesIn(entries, shown)
  const items = shown === 'added' ? added.map(row => ({ row }))
    : [...!searching && (shown === 'common' || shown === 'all') ? [{ custom: true }] : [], ...listed.map(entry => ({ entry }))]
  const enabled = items.map((item, index) => (itemOpens(item, canAdd) ? index : -1)).filter(index => index >= 0)
  // 搜索时第一个结果预先选中，按 Enter 打开；方向键在能打开的项之间移动。
  const current = enabled.includes(active) ? active : searching ? enabled[0] ?? -1 : -1
  const openItem = (item) => {
    if (item.row !== undefined) go({ page: 'detail', provider: item.row.entry.provider })
    else if (item.custom) go({ page: 'custom' })
    else go(variantRoute(mainVariant(item.entry)))
  }
  const onKeyDown = (event) => {
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (enabled.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      const at = enabled.indexOf(current)
      const next = at < 0 ? enabled[step > 0 ? 0 : enabled.length - 1] : enabled[Math.max(0, Math.min(enabled.length - 1, at + step))]
      setActive(next)
      setAnnounced(itemLabel(app, snapshot, items[next]))
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault()
      openItem(items[current])
    }
  }
  const anyUsable = snapshot.rows.some(providerUsable)
  const savedRow = saved === undefined ? undefined : snapshot.rows.find(row => row.entry.provider === saved)
  const rowFor = (item, index) => {
    const shared = { key: item.row?.entry.provider ?? item.entry?.family.id ?? 'custom', app, go, index, active: focused && index === current }
    if (item.row !== undefined) return h(AddedRow, { ...shared, snapshot, row: item.row })
    if (item.custom) return h(CustomEntryRow, { ...shared, canAdd })
    if (item.entry.family.id === 'deepseek-account') return h(AccountRow, { ...shared, entry: item.entry, account })
    return h(EntryRow, { ...shared, snapshot, entry: item.entry, canAdd })
  }
  return h(Fragment, null,
    title,
    snapshot.writable ? null : h('p', { className: 'dms-note dms-warn' }, app.t('readOnly')),
    savedRow === undefined ? null : h('p', { className: 'dms-note dms-ok', role: 'status', 'aria-live': 'polite' }, app.t('saved', { provider: metaOf(savedRow).name })),
    notice === undefined ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, notice),
    h('div', { className: 'dms-searchbox' },
      h(ui.IconSearchOutlineRegular, { size: 16, className: 'dms-search-ico' }),
      h('input', {
        id: 'dms-provider-search', className: 'dms-searchinput', value: query, placeholder: app.t('search'), 'aria-label': app.t('search'),
        spellCheck: false, autoComplete: 'off', onKeyDown, onFocus: () => setFocused(true), onBlur: () => { setFocused(false); setAnnounced('') },
        onChange: (event) => { setQuery(event.target.value); setActive(-1); setAnnounced('') },
      })),
    h('span', { className: 'dms-sr', role: 'status', 'aria-live': 'polite' }, announced),
    h('div', { className: 'dms-pick' },
      h('ul', { className: 'dms-cats', 'aria-label': app.t('categories') }, categories.map(key => h('li', { key },
        h('button', { type: 'button', className: 'dms-cat', 'aria-pressed': key === shown ? 'true' : 'false', onClick: () => setCategory(key) },
          app.t(`cat${key}`), key === 'added' ? h('span', { className: 'dms-n' }, String(added.length)) : null)))),
      h('div', { className: 'dms-scroll', ref: listRef },
        shown === 'added' && !anyUsable ? h(EmptyAdded, { app, snapshot, go, onOther: () => setCategory('common') }) : null,
        searching && listed.length === 0
          ? h('div', { className: 'dms-empty' },
            h('p', { className: 'dms-intro' }, app.t('noMatch', { query: query.trim() })),
            h(ui.Button, { variant: 'outline', size: 'sm', disabled: !canAdd, onClick: () => go({ page: 'custom', name: query.trim() }) }, app.t('addWithCustom')))
          : h('ul', { className: 'dms-pvs', 'aria-label': app.t(`cat${shown}`) }, items.map(rowFor)))))
}

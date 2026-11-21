/** 添加模型提供商的填写页：在模型页（list.js）点开没添加的线路就到这里。目录里的提供商只要填 API 密钥；目录外的和火山方舟的预设走「自定义模型 API」。 */

/** 目录里的提供商：选好点开的那条线路（已添加的不能选），填密钥。 */
function FillStep({ app, snapshot, entry, route: opened, go }) {
  const firstFree = entry.variants.find(variant => variant.route === opened && !variant.added) ?? entry.variants.find(variant => !variant.added) ?? entry.variants[0]
  const [route, setRoute] = useState(firstFree.route)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(undefined)
  const [committed, setCommitted] = useState(false)
  const [share, setShare] = useState(undefined)
  const [committedRef, setCommittedRef] = useState(undefined)
  const variant = entry.variants.find(item => item.route === route) ?? firstFree
  const row = snapshot.rows.find(candidate => candidate.entry.provider === route)
  const namespace = snapshot.namespaces.get('llm-pi-ai')
  const keyed = row === undefined || needsKey(row)
  // 别的提供商在配置里点名了这个派生凭据名：直接存会盖掉它的密钥，先让人选共用还是单独存一把（TS-001、feat#174）。
  // 如果已经无冲突写好配置、只差存密钥，外部快照后来才新增占用者时不锁死重试。
  const ref = deriveKeyRef(route)
  const sharers = keyed && !(committed && share === undefined) ? credentialNamedBy(snapshot.rows, ref, route) : []
  const separate = useSeparateKeyRef(app, snapshot.rows, ref, sharers.length > 0, share === 'separate' ? committedRef : undefined)
  const choice = sharers.length === 0 ? undefined : shareChoiceOf(app, snapshot, ref, sharers, share, separate.ref)
  const showKey = keyed && (choice === undefined || choice.showKey)
  const keyFailure = showKey ? apiKeyFailure(keyDraft) : undefined
  const keyValue = keyDraft.trim()
  // 目录里要密钥的提供商，出了密钥框就得填（共用而对方还没存时，填的这把两边都用）。
  const keyMissing = showKey && keyValue.length === 0
  const ready = row !== undefined && namespace !== undefined && snapshot.writable && keyFailure === undefined && (choice === undefined || share !== undefined)
    && !(choice !== undefined && share === 'separate' && separate.pending) && !keyMissing && !busy
  const gate = !snapshot.writable ? app.t('readOnly') : choice !== undefined && share === undefined ? spaced(app.t('keyShareChoose', { provider: choice.provider })) : undefined
  const keyBox = !showKey ? null : h(Fragment, null,
    h(ApiKeyInput, {
      app, id: 'dms-new-key', bare: choice !== undefined, view: { state: 'unset', canClear: false }, draft: keyDraft === '' ? undefined : keyDraft, disabled: busy, invalid: keyFailure !== undefined,
      hint: keyFailure === undefined ? app.t('keyHintNew') : app.t(keyFailure), hintTone: keyFailure === undefined ? 'hint' : 'err',
      onDraft: next => setKeyDraft(typeof next === 'string' ? next : ''),
    }),
    variant.keyUrl === undefined ? null : h('p', { className: 'dms-hint' }, h(ExternalLink, { href: variant.keyUrl }, app.t('keyGet'))))
  const meta = routeMeta(route, row?.entry)
  // 模型来自安装包目录：读一次数一数有几个。DSH 本机回答，不发请求。
  const [catalogCount, setCatalogCount] = useState(undefined)
  useEffect(() => {
    let live = true
    setCatalogCount(undefined)
    void app.ops.discoverModels('llm-pi-ai', { provider: route }).then((answer) => { if (live && answer.kind === 'found') setCatalogCount(answer.models.length) })
    return () => { live = false }
  }, [route])
  const add = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      // 写好配置以后快照会重读，新凭据名再算一次会往上加；重试存密钥时用写配置那一刻定下的。
      const target = committedRef ?? choice?.target ?? ref
      if (!committed) {
        const value = choice !== undefined || keyValue.length > 0 ? { apiKeyEnv: target } : {}
        const written = await app.ops.writeSettings('llm-pi-ai', [{ op: 'set', path: [...row.entry.settingsPath], value }], namespace.revision)
        if (written.kind !== 'written') { setFailure(written.kind === 'conflict' ? app.t('conflict') : app.t('saveFailed', { message: written.message })); return }
        setCommitted(true)
        setCommittedRef(target)
      }
      if (showKey && keyValue.length > 0) {
        const stored = await app.ops.storeCredential(target, keyValue)
        if (stored !== undefined) { setFailure(app.t('saveFailed', { message: stored })); return }
      }
      await app.store.load()
      go({ page: 'detail', provider: route, saved: route })
    } finally {
      setBusy(false)
    }
  }
  return h(Fragment, null,
    h(Crumb, { label: app.t('back'), onClick: () => go({ page: 'list' }) }),
    h(HeadRow, { meta: entry.family, name: meta.name, tags: meta.tag === undefined ? [] : [meta.tag], domain: variant.domain }),
    entry.variants.length > 1 ? h('div', { className: 'dms-field' },
      h('div', { className: 'dms-label' }, entry.family.variantLabel ?? entry.family.name),
      h(ui.SegmentedControl, {
        label: entry.family.variantLabel ?? entry.family.name, value: route, disabled: busy || committed,
        options: entry.variants.map(item => ({ value: item.route, label: item.added ? app.t('variantAdded', { label: item.label }) : item.label, disabled: item.added, title: item.domain })),
        onChange: next => { setRoute(next); setShare(undefined); setKeyDraft(''); setFailure(undefined) },
      }),
      entry.family.variantNote === undefined ? null : h('p', { className: 'dms-hint' }, entry.family.variantNote)) : null,
    !keyed ? h('p', { className: 'dms-hint' }, app.t('keyNotNeeded'))
      : choice === undefined ? h('div', { className: 'dms-field' }, keyBox)
        : h('div', { className: 'dms-field' },
          h('div', { className: 'dms-label' }, app.t('keyField')),
          h('p', { id: 'dms-new-key-choice-notice', className: 'dms-hint' }, spaced(app.t('keyShareNotice', { ref, provider: choice.provider }))),
          h(KeyChoice, {
            id: 'dms-new-key-choice', label: app.t('keyField'), describedBy: 'dms-new-key-choice-notice', value: share, options: choice.options, detail: keyBox, disabled: busy || committed || !snapshot.writable,
            onChange: (next) => { setShare(next); setKeyDraft(''); setFailure(undefined) },
          })),
    h('p', { className: 'dms-hint' }, catalogCount === undefined ? app.t('modelsFromCatalogPlain') : app.t('modelsFromCatalog', { count: catalogCount })),
    h('div', { className: 'dms-foot' },
      failure !== undefined ? h('p', { className: 'dms-note dms-err', role: 'alert' }, failure)
        : gate !== undefined ? h('p', { className: 'dms-note' }, gate) : null,
      h(ui.Button, { variant: 'outline', disabled: busy, onClick: () => go({ page: 'list' }) }, app.t('cancel')),
      h(ui.Button, { variant: 'primary', disabled: !ready, onClick: () => { void add() } }, busy ? app.t('adding') : app.t('addAction'))))
}

/**
 * 自定义模型 API。协议默认自动，想手动指定才点「更改」。preset 是火山方舟的预设（catalog.js 的 PRESETS）：显示名称、Provider ID、API 地址和模型预先填好，
 * 顶上写成方舟的那一种，密钥框下给获取 API 密钥的链接和说明。
 */
function CustomStep({ app, snapshot, initialName, preset, go }) {
  const namespace = snapshot.namespaces.get('llm-pi-ai')
  const protocols = useMemo(() => protocolChoicesOf(app.schema, namespace), [namespace])
  const levels = useMemo(() => reasoningLevelsOf(app.schema, namespace), [namespace])
  const [openedAt] = useState(() => namespace?.revision)
  const [name, setName] = useState(preset?.name ?? initialName ?? '')
  const [routeId, setRouteId] = useState(() => preset?.route ?? routeIdFromName(initialName ?? ''))
  // 预设的 Provider ID 是起好的，改显示名称时不跟着变。
  const [routeTouched, setRouteTouched] = useState(preset !== undefined)
  const [baseURL, setBaseURL] = useState(preset?.baseURL ?? '')
  const [protocolMode, setProtocolMode] = useState('auto')
  const [chosen, setChosen] = useState(undefined)
  const [detected, setDetected] = useState(undefined)
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState(() => (preset?.models ?? []).map(id => ({ id })))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(undefined)
  const [committed, setCommitted] = useState(false)
  const [share, setShare] = useState(undefined)
  const [committedRef, setCommittedRef] = useState(undefined)
  const taken = snapshot.rows.map(row => row.entry.provider)
  const protocol = protocolMode === 'manual' && chosen !== undefined ? chosen : detected ?? protocolProbeOrder(baseURL, protocols)[0] ?? guessProtocol(baseURL, protocols)
  const reasoning = protocolReasoningLevels(protocol, levels)
  // 配置写好以后这个 ID 是这里刚建的：设置推送让页面重读，它出现在已有提供商里，不再算重名，存密钥失败后还能重试。
  const routeFailure = committed ? undefined : routeIdFailure(routeId, taken)
  const routeError = routeFailure === undefined ? undefined : app.t(routeFailure)
  // 这个 ID 派生出的凭据名已经有别的提供商在读：直接存会盖掉它的密钥，先让人选共用还是单独存一把，也可以换个 ID（TS-001、feat#174）。
  // 如果已经无冲突写好配置、只差存密钥，外部快照后来才新增占用者时不锁死重试。
  const ref = deriveKeyRef(routeId)
  const sharers = routeId.length === 0 || routeFailure !== undefined || (committed && share === undefined) ? [] : credentialUsers(snapshot.rows, ref, routeId)
  const separate = useSeparateKeyRef(app, snapshot.rows, ref, sharers.length > 0, share === 'separate' ? committedRef : undefined)
  const choice = sharers.length === 0 ? undefined : shareChoiceOf(app, snapshot, ref, sharers, share, separate.ref)
  const showKey = choice === undefined || choice.showKey
  // Gemini API 没有密钥不能用：DSH 照样会建，第一次请求才失败，所以这里先拦下（官方 rc.2 同样做法）。共用已经存好的那把时不用再填。
  const geminiNeedsKey = showKey && protocolNeedsKey(protocol)
  const keyRequired = geminiNeedsKey || choice?.keyRequired === true
  const url = baseURL.trim()
  const urlInvalid = url.length > 0 && !isHttpUrl(url)
  const keyFailure = showKey ? apiKeyFailure(keyDraft) : undefined
  const keyValue = keyDraft.trim()
  const modelFailure = validateModels(models) ?? validateReasoningEfforts(models, reasoning.levelsOnly ? reasoning.levels : undefined)
  const ready = namespace !== undefined && snapshot.writable && !busy && routeId.length > 0 && routeError === undefined && (choice === undefined || share !== undefined)
    && !(choice !== undefined && share === 'separate' && separate.pending)
    && url.length > 0 && !urlInvalid && models.length > 0 && modelFailure === undefined && keyFailure === undefined && protocols.includes(protocol)
    && (!keyRequired || keyValue.length > 0)
  const gate = ready || routeId.length === 0 || routeError !== undefined || urlInvalid || keyFailure !== undefined ? undefined
    : !snapshot.writable ? app.t('readOnly')
      : choice !== undefined && share === undefined ? spaced(app.t('keyShareChoose', { provider: choice.provider }))
        : url.length === 0 ? app.t('customNeedsBaseUrl')
          : modelFailure !== undefined ? app.t('modelRowFailure', { index: modelFailure.index + 1, message: app.t(modelFailure.key) })
            : models.length === 0 ? app.t('customNeedsModels') : undefined
  const preview = requestUrlPreview(url, protocol)
  const keyBox = !showKey ? null : h(ApiKeyInput, {
    app, id: 'dms-custom-key', bare: choice !== undefined, view: { state: 'unset', canClear: false }, draft: keyDraft === '' ? undefined : keyDraft, disabled: busy, invalid: keyFailure !== undefined,
    hint: keyFailure !== undefined ? app.t(keyFailure) : geminiNeedsKey && keyValue.length === 0 ? app.t('protocolNeedsKey') : app.t('keyHintNew'),
    hintTone: keyFailure === undefined ? 'hint' : 'err',
    onDraft: next => setKeyDraft(typeof next === 'string' ? next : ''),
  })
  const editName = (text) => {
    setName(text)
    if (!routeTouched) { setRouteId(routeIdFromName(text)); setShare(undefined) }
  }
  const create = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      // 写好配置以后快照会重读，新凭据名再算一次会往上加；重试存密钥时用写配置那一刻定下的。
      const target = committedRef ?? choice?.target ?? ref
      const typed = showKey && keyValue.length > 0
      if (!committed) {
        const profile = {
          ...name.trim().length === 0 ? {} : { displayName: name.trim() },
          ...choice !== undefined || typed ? { apiKeyEnv: target } : {},
          api: protocol, baseURL: url, models: models.map(model => ({ ...model })),
        }
        const written = await app.ops.writeSettings('llm-pi-ai', [{ op: 'set', path: ['providers', routeId], value: profile }], openedAt)
        if (written.kind !== 'written') { setFailure(written.kind === 'conflict' ? app.t('conflict') : app.t('saveFailed', { message: written.message })); return }
        setCommitted(true)
        setCommittedRef(target)
      }
      if (typed) {
        const stored = await app.ops.storeCredential(target, keyValue)
        if (stored !== undefined) { setFailure(app.t('saveFailed', { message: stored })); return }
      }
      await app.store.load()
      go({ page: 'detail', provider: routeId, saved: routeId })
    } finally {
      setBusy(false)
    }
  }
  const locked = busy || committed
  const presetMeta = preset === undefined ? undefined : routeMeta(preset.route, { displayName: preset.name, defaultBaseURL: preset.baseURL })
  // 火山方舟预设：密钥那一栏最后写这一种要用哪种 API 密钥、去哪里获取，有没有共用还是单独的选择都写。
  const presetKeyNote = preset?.keyNote === undefined ? null : h('p', { className: 'dms-hint' }, preset.keyNote)
  const presetKeyLink = preset?.keyUrl === undefined ? null : h('p', { className: 'dms-hint' }, h(ExternalLink, { href: preset.keyUrl }, app.t('keyGet')))
  return h(Fragment, null,
    h(Crumb, { label: app.t('back'), onClick: () => go({ page: 'list' }) }),
    presetMeta === undefined ? h('h2', { className: 'dms-title' }, app.t('customTitle'))
      : h(HeadRow, { meta: presetMeta, name: PRESET_FAMILY.name, tags: [preset.label], domain: presetMeta.domain }),
    h(Field, { id: 'dms-custom-name', label: app.t('displayName') },
      h(TextInput, { id: 'dms-custom-name', value: name, placeholder: 'MOSS Pro', disabled: locked, onChange: editName, autoFocus: true })),
    h(Field, { id: 'dms-custom-route', label: app.t('routeId'), error: routeError,
      hint: routeId.length > 0 && routeError === undefined ? app.t('routeIdHint', { ref }) : app.t('routeIdHintEmpty') },
    h(TextInput, { id: 'dms-custom-route', mono: true, value: routeId, placeholder: 'moss', disabled: locked, invalid: routeError !== undefined,
      onChange: (text) => { setRouteTouched(true); setRouteId(text.trim()); setShare(undefined) } })),
    h(Field, { id: 'dms-custom-url', label: app.t('baseUrl'), error: urlInvalid ? app.t('customBaseUrlInvalid') : undefined,
      hint: preview === undefined ? undefined : app.t('requestPreview', { url: preview }) },
    h(TextInput, { id: 'dms-custom-url', value: baseURL, placeholder: 'https://gateway.example/v1', disabled: locked, invalid: urlInvalid,
      onChange: (text) => { setBaseURL(text); setDetected(undefined) } })),
    protocolMode === 'auto'
      ? h('div', { className: 'dms-row' },
        h('span', { className: 'dms-hint' }, detected === undefined
          ? `${app.t('protocol')}：${app.t('protocolAuto', { name: protocolLabel(app, protocol) })}`
          : `${app.t('protocol')}：${app.t('protocolDetected', { name: protocolLabel(app, protocol) })}`),
        h('button', { type: 'button', className: 'dms-link', disabled: locked, onClick: () => { setChosen(protocol); setProtocolMode('manual') } }, app.t('changeProtocol')))
      : h('div', { className: 'dms-field' },
        h('div', { className: 'dms-label' }, app.t('protocol')),
        h(ui.SegmentedControl, { label: app.t('protocol'), value: protocol, disabled: locked,
          options: protocols.map(api => ({ value: api, label: protocolLabel(app, api) })), onChange: setChosen })),
    choice === undefined ? h('div', { className: 'dms-field' }, keyBox, presetKeyNote, presetKeyLink)
      : h('div', { className: 'dms-field' },
        h('div', { className: 'dms-label' }, app.t('keyField')),
        h('p', { id: 'dms-custom-key-choice-notice', className: 'dms-hint' }, spaced(app.t('keyShareNoticeId', { ref, provider: choice.provider }))),
        h(KeyChoice, {
          id: 'dms-custom-key-choice', label: app.t('keyField'), describedBy: 'dms-custom-key-choice-notice', value: share, options: choice.options, detail: keyBox, disabled: locked || !snapshot.writable,
          onChange: (next) => { setShare(next); setKeyDraft(''); setFailure(undefined) },
        }),
        presetKeyNote, presetKeyLink),
    h(ModelsEditor, {
      app, family: 'pi-ai', rows: models, inherited: false, showSource: false, onChange: setModels, reasoningLevels: reasoning.levels, levelsOnly: reasoning.levelsOnly, disabled: locked,
      discover: endpointDiscover(app, 'llm-pi-ai', { baseURL: url, ...!showKey || keyValue.length === 0 ? {} : { apiKey: keyValue } },
        protocolMode === 'manual' ? [protocol] : protocolProbeOrder(url, protocols), api => { if (protocolMode === 'auto') setDetected(api) }),
      // 没填地址时说明要先填；Gemini API 缺密钥时密钥框下已经说了，这里只禁用不再重复。
      discoverBlocked: url.length === 0 || urlInvalid ? app.t('fetchNeedsBaseUrl') : geminiNeedsKey && keyValue.length === 0 ? '' : undefined,
    }),
    h('div', { className: 'dms-foot' },
      failure !== undefined ? h('p', { className: 'dms-note dms-err', role: 'alert' }, failure)
        : gate !== undefined ? h('p', { className: 'dms-note' }, gate) : null,
      h(ui.Button, { variant: 'outline', disabled: busy, onClick: () => go({ page: 'list' }) }, app.t('cancel')),
      h(ui.Button, { variant: 'primary', disabled: !ready, onClick: () => { void create() } }, busy ? app.t('creating') : app.t('create'))))
}

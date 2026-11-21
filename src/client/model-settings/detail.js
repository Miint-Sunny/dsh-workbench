/** 提供商详情：API 密钥、检查连接、模型目录、高级设置和删除都在这一页。写入规则照 DSH 内置页：路径操作带 revision，密钥只写。 */

/** 页头只显示这几种状态：密钥状态、检查结果在页面下面各自的位置显示。 */
const HEADER_STATUS = new Set(['statusSignedIn', 'statusCatalogError', 'statusUnknown', 'statusNotRunning', 'statusNotRunningWhy'])

function DetailHeader({ app, snapshot, row, go, saved, notice }) {
  const meta = metaOf(row)
  const status = statusOf(app, snapshot, row)
  const headerStatus = HEADER_STATUS.has(status.key) ? status : undefined
  return h(Fragment, null,
    h(Crumb, { label: app.t('back'), onClick: () => go({ page: 'list' }) }),
    h(HeadRow, { meta, name: meta.name, tags: [meta.tag, row.entry.declared === true ? app.t('customTag') : undefined].filter(Boolean), domain: meta.domain },
      headerStatus === undefined ? null : h(State, { status: headerStatus })),
    snapshot.writable ? null : h('p', { className: 'dms-note dms-warn' }, app.t('readOnly')),
    saved ? h('p', { className: 'dms-note dms-ok', role: 'status', 'aria-live': 'polite' }, app.t('saved', { provider: meta.name })) : null,
    notice === undefined ? null : h('p', { className: `dms-note ${notice.ok ? 'dms-ok' : 'dms-err'}`, role: notice.ok ? 'status' : 'alert', 'aria-live': 'polite' }, notice.text))
}

/** DeepSeek 账号：和内置页一样只读，登录、退出在账号菜单里。 */
function AccountDetail({ app, snapshot, row, go }) {
  const group = snapshot.catalog?.groups.find(candidate => candidate.id === row.entry.provider)
  const defaultModel = snapshot.catalog?.default?.provider === row.entry.provider ? snapshot.catalog.default.model : undefined
  return h(Fragment, null,
    h(DetailHeader, { app, snapshot, row, go }),
    h('p', { className: 'dms-hint' }, app.t('accountNote')),
    h('div', { className: 'dms-sec' }, h('span', null, app.t('models'), ' ', h('span', { className: 'dms-meta' }, app.t('modelsCount', { count: group?.models.length ?? 0 })))),
    (group?.models ?? []).map(model => h('div', { key: model.id, className: 'dms-model', style: { cursor: 'default' } },
      h('span', { className: 'dms-main' }, h('span', { className: 'dms-idline' }, h('span', { className: 'dms-mono' }, model.id), model.id === defaultModel ? h('span', { className: 'dms-tag' }, app.t('defaultModel')) : null),
        model.name !== model.id ? h('span', { className: 'dms-meta' }, model.name) : null),
      h('span'), h('span'))))
}

const isRecordValue = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 目录外的模型实际发往哪里：每种协议一行。原提供商在自定义设置里写了地址时，它和安装包目录的地址都能选，并写明为什么要选；
 * 存着的地址已经不是可选的（例如原提供商删掉了自定义地址）时写出旧地址和保存后的新地址。读不到安装包目录时只写明这件事。
 */
function CompanionAddresses({ app, provider, providerName, apis, catalogMissing, override, choicesFor, addressFor, storedUrlOf, compatNoteFor, disabled, onChoose }) {
  if (catalogMissing) return h('p', { className: 'dms-note dms-err', role: 'alert' }, app.t('companionCatalogMissing'))
  const split = override !== undefined && apis.some(api => choicesFor(api).length > 1)
  return h('div', { className: 'dms-fold' },
    split ? h('p', { className: 'dms-hint' }, app.t('companionAddressNote', { provider: providerName })) : null,
    apis.map((api) => {
      const choices = choicesFor(api)
      const url = addressFor(api)
      const stored = storedUrlOf(api)
      const id = `dms-companion-url-${provider}-${api}`
      const label = app.t('companionAddress', { protocol: protocolLabel(app, api) })
      return h('div', { key: api, className: 'dms-field' },
        h('label', { className: 'dms-label', htmlFor: id }, label),
        choices.length > 1
          ? h('select', { id, className: 'dms-select dms-select-full', value: url, disabled, 'aria-label': label, onChange: event => onChoose(api, event.target.value) },
            choices.map(choice => h('option', { key: choice, value: choice },
              choice === override ? app.t('companionAddressOverride', { url: choice, provider: providerName }) : app.t('companionAddressCatalog', { url: choice }))))
          : h('span', { className: 'dms-mono dms-idle' }, url ?? '—'),
        stored !== undefined && url !== undefined && stored !== url && !choices.includes(stored)
          ? h('p', { className: 'dms-hint' }, app.t('companionAddressStale', { old: stored, url, provider: providerName })) : null,
        compatNoteFor(api) === undefined ? null : h('p', { className: 'dms-hint' }, compatNoteFor(api)))
    }))
}

function ProviderDetail({ app, snapshot, row, namespace, go, saved }) {
  const schema = app.schema
  const provider = row.entry.provider
  const path = row.entry.settingsPath
  const family = namespace.ns === 'llm-deepseek' ? 'deepseek' : 'pi-ai'
  const declared = row.entry.declared === true
  const meta = metaOf(row)
  const readOnly = !snapshot.writable
  const userOf = (view) => {
    const value = schema.getPath(view.user, path)
    return isRecordValue(value) ? value : undefined
  }
  const [base, setBase] = useState(() => ({ original: userOf(namespace), revision: namespace.revision }))
  const [draft, setDraft] = useState(() => structuredClone(base.original ?? {}))
  // 密钥的草稿：undefined 没动；字符串是新输入的；{ remove: true } 是要清除，removed 表示凭据已经清掉、配置还没写完。
  const [keyDraft, setKeyDraft] = useState(undefined)
  const keyDirty = keyDraft !== undefined
  // 换密钥时别的提供商也在用这个凭据名：选 both 两边一起换，only 只给这一家另起凭据名（feat#174）。
  const [replaceMode, setReplaceMode] = useState(undefined)
  // 配置已把这一家改点名到新凭据名、但后面的 storeCredential 失败且快照还没重读时记住它，防止切回旧凭据名或再次递增。
  const [committedKeyRef, setCommittedKeyRef] = useState(undefined)
  // ---- 目录外的模型（协议混合的提供商的伴随条目，Provider ID 为 <这一家>--<协议简称>）----
  // 只认插件自己建的（lib/companion.js 的 ownCompanion）；自定义的提供商不认，手写的同形条目不列出、不改、不跟着删。
  const companionsOf = (view) => {
    if (declared || family !== 'pi-ai') return {}
    const providers = schema.getPath(view.user, ['providers'])
    return Object.fromEntries(Object.entries(isRecordValue(providers) ? providers : {})
      .filter(([route, profile]) => ownCompanion(route, profile, origin => origin === provider) !== undefined))
  }
  /** 伴随条目里的模型摊成一列，每行记着自己的协议（__api）和保存时所在的条目（__from），写配置时都去掉。 */
  const companionRowsOf = companions => Object.entries(companions).flatMap(([route, profile]) =>
    modelDrafts(profile.models).map(model => ({ ...model, __api: parseCompanion(route).api, __from: route })))
  const companionModelOf = ({ __api, __from, ...model }) => model
  const [companionBase, setCompanionBase] = useState(() => companionsOf(namespace))
  const [companionDraft, setCompanionDraft] = useState(() => companionRowsOf(companionBase))
  // 伴随条目的地址这一页里选过的（协议 → 地址）。
  const [companionUrlChoice, setCompanionUrlChoice] = useState({})
  const fallback = schema.getPath(namespace.value, path) ?? {}
  const inheritedProfile = schema.getPath(namespace.base, path) ?? {}
  // 别处改了这份设置、这一页又没有未保存的修改时，直接换成最新的值。
  useEffect(() => {
    if (dirty || namespace.revision === base.revision) return
    const original = userOf(namespace)
    setBase({ original, revision: namespace.revision })
    setDraft(structuredClone(original ?? {}))
    setReplaceMode(undefined)
    setCommittedKeyRef(undefined)
    const companions = companionsOf(namespace)
    setCompanionBase(companions)
    setCompanionDraft(companionRowsOf(companions))
    setCompanionUrlChoice({})
  }, [namespace.revision])

  const [savedHere, setSavedHere] = useState(saved === provider)
  const [notice, setNotice] = useState(undefined)
  const [inherited, setInherited] = useState(undefined)
  // 打开详情时读一次安装包目录，只为拿每个模型默认的输入类型和「数据不全」的判断：DSH 本机回答，不发请求（官方页同样这样做）。
  useEffect(() => {
    if (family !== 'pi-ai' || declared) return undefined
    let live = true
    void app.ops.discoverModels(namespace.ns, { provider }).then((answer) => { if (live) setInherited(answer.kind === 'found' ? answer.models : []) })
    return () => { live = false }
  }, [provider])
  // 协议混合的提供商要知道目录里每个模型的协议、每种协议的地址和兼容开关：宿主端只读安装包目录，不发请求。
  // 读不到也记下来（{ ok: false }）：有伴随条目时要在页面上说，并且不让保存，免得沿用旧地址。
  const [catalogInfo, setCatalogInfo] = useState(undefined)
  useEffect(() => {
    if (family !== 'pi-ai' || declared || app.ops.catalogProtocols === undefined) return undefined
    let live = true
    void app.ops.catalogProtocols(provider)
      .then((answer) => { if (live) setCatalogInfo(answer?.ok === true ? answer : { ok: false }) })
      .catch(() => { if (live) setCatalogInfo({ ok: false }) })
    return () => { live = false }
  }, [provider])
  const ownModels = Array.isArray(draft.models) ? modelDrafts(draft.models) : undefined
  const rowsNow = ownModels ?? (family === 'deepseek' || declared ? modelDrafts(fallback.models) : (inherited ?? []).map(candidate => adoptCandidate(candidate, family)))
  const inputDefaults = useMemo(() => new Map((inherited ?? []).map(candidate => [candidate.id, candidate.inputModalities])), [inherited])
  const catalogIds = useMemo(() => (family === 'pi-ai' && !declared && inherited !== undefined ? new Set(inherited.map(candidate => candidate.id)) : undefined), [inherited])
  const group = snapshot.catalog?.groups.find(candidate => candidate.id === provider)
  const reasoningIds = useMemo(() => new Set((group?.models ?? []).filter(model => (model.reasoning?.efforts?.length ?? 0) > 0).map(model => model.id)), [group])
  const defaultModel = snapshot.catalog?.default?.provider === provider ? snapshot.catalog.default.model : undefined
  const protocol = draft.api ?? fallback.api
  const rootSchema = useMemo(() => schema.rehydrate(namespace.schema), [namespace.schema])
  // schema 允许的全部档位。目录里的提供商自己的模型沿用目录的档位，不给控件（照官方）；它的目录外模型在伴随条目上，按行用 schemaLevels。
  const schemaLevels = useMemo(() => reasoningLevelsOf(schema, namespace), [namespace.schema])
  const allLevels = declared ? schemaLevels : []
  const reasoning = protocolReasoningLevels(protocol, allLevels)
  const protocols = useMemo(() => declared ? protocolChoicesOf(schema, namespace) : [], [declared, namespace.schema])
  const setField = (key, text) => setDraft((current) => {
    const next = { ...current }
    if (text === undefined || text.trim().length === 0) delete next[key]
    else next[key] = text
    return next
  })

  // ---- API 密钥 ----
  const keyRef = keyRefOf(row)
  const effectiveKeyRef = committedKeyRef ?? keyRef
  // 自己的伴随条目用同一个凭据名，不算「别的提供商在用」：清除、换密钥对两边同时生效。
  const ownRoutes = new Set(Object.keys(companionsOf(namespace)))
  const notOwnCompanion = route => !ownRoutes.has(route)
  // 伴随条目的路由被别的条目占着（用户手写的、或我们建的被改了显示名）：协议 → 列表上看得到的名字。这种协议不可选，绝不写那个条目。
  const occupied = useMemo(() => {
    if (declared || family !== 'pi-ai') return {}
    const providers = schema.getPath(namespace.value, ['providers'])
    return Object.fromEntries(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].flatMap((api) => {
      const route = companionRoute(provider, api)
      if (!isRecordValue(providers) || providers[route] === undefined || ownRoutes.has(route)) return []
      const named = snapshot.rows.find(candidate => candidate.entry.provider === route)
      return [[api, named === undefined ? route : metaOf(named).name]]
    }))
  }, [namespace.value, snapshot.rows])
  const configuredRows = snapshot.rows.filter(candidate => candidate.configured === true)
  const otherUsers = ref => credentialUsers(configuredRows, ref, provider).filter(notOwnCompanion)
  const keyView = keyViewOf(row, otherUsers(keyRef))
  const showKey = needsKey(row) || protocolNeedsKey(protocol)
  const keyText = typeof keyDraft === 'string' ? keyDraft : ''
  const keyValue = keyText.trim()
  const keyFailure = apiKeyFailure(keyText)
  // 存这把新密钥会改到别的提供商也在用的凭据名（点名的，或已配置且按目录环境变量读取的非同源入口）：能改 apiKeyEnv 的命名空间让人选两边一起换或只换这一家，改不了的照旧拦下（TS-001、feat#174）。
  const canSetKeyRef = namespace.ns === 'llm-pi-ai' || namespace.ns === 'llm-deepseek' || schema.nodeAtPath(rootSchema, [...path, 'apiKeyEnv']) !== undefined
  const replaceSharers = keyValue.length > 0 ? credentialReplaceSharers(snapshot.rows, effectiveKeyRef, row).filter(notOwnCompanion) : []
  const keyTaken = canSetKeyRef ? undefined : keyRefTakenText(app, snapshot, effectiveKeyRef, replaceSharers, 'keyRefTakenSave')
  const replaceWith = canSetKeyRef && replaceSharers.length > 0 ? sharersLabel(app, snapshot, replaceSharers) : undefined
  const separate = useSeparateKeyRef(app, snapshot.rows, effectiveKeyRef, replaceWith !== undefined, committedKeyRef)
  const onlyRef = separate.ref
  const replaceChoice = replaceWith === undefined ? undefined : [
    { value: 'both', label: app.t('keyReplaceBoth'), note: spaced(app.t('keyReplaceBothNote', { provider: replaceWith })) },
    { value: 'only', label: spaced(app.t('keyReplaceOnly', { name: metaOf(row).name })), note: spaced(app.t('keyReplaceOnlyNote', { ref: onlyRef, provider: replaceWith })) },
  ]
  const replacePending = replaceChoice !== undefined && (replaceMode === undefined || (replaceMode === 'only' && separate.pending))
  // 清除后接上的环境变量：目录给的第一个不是登录凭据的名字。
  const envFallback = (row.entry.nativeAuth?.env ?? []).find(name => !/oauth/i.test(name) && name !== keyRef)
  const keyHint = keyHintOf(app, keyView, keyDraft, keyView.state === 'saved' ? envFallback : undefined)
  const clearBlocked = keyView.state === 'saved' && !keyView.canClear && otherUsers(keyRef).length > 0
    ? keyRefTakenText(app, snapshot, keyRef, otherUsers(keyRef), 'keyTakenNoClear') : undefined
  const geminiKeyMissing = protocolNeedsKey(protocol) && keyView.state === 'unset' && keyValue.length === 0

  // ---- 检查连接 ----
  const check = snapshot.checks.get(provider)
  const [checking, setChecking] = useState(false)
  // 先用 DSH 模型目录里这一家的模型（检查请求只认这些），目录里没有时才用这一页的模型行。
  const knownIds = group !== undefined && group.models.length > 0
    ? group.models.map(model => model.id)
    : rowsNow.map(model => model.id).filter(id => typeof id === 'string' && id.length > 0)
  const checkModel = pickCheckModel(knownIds, defaultModel)
  const runCheck = async () => {
    if (checkModel === undefined) { app.store.setCheck(provider, { ok: false, reason: 'noModel' }); return }
    setChecking(true)
    try {
      const result = await app.ops.check(provider, checkModel)
      app.store.setCheck(provider, { ...result, model: result.model ?? checkModel })
    } finally {
      setChecking(false)
    }
  }
  // 检查只用已保存的密钥：密钥有改动没保存时不让点，免得用旧密钥查出误导的结果。
  const checkBlocked = keyDirty ? app.t('keyCheckPending') : showKey && keyView.state === 'unset' ? app.t('checkNeedsKey') : undefined

  // ---- 自定义设置、协议、重试策略 ----
  const [customizedOpen, setCustomizedOpen] = useState(false)
  const [protocolMode, setProtocolMode] = useState('auto')
  const baseUrlShown = draft.baseURL ?? ''
  const urlNow = (draft.baseURL ?? fallback.baseURL ?? row.entry.defaultBaseURL ?? '').trim()
  const urlInvalid = baseUrlShown.trim().length > 0 && !isHttpUrl(baseUrlShown.trim())
  const preview = declared && protocol !== undefined ? requestUrlPreview(urlNow, protocol) : undefined
  const retryNode = useMemo(() => schema.nodeAtPath(rootSchema, [...path, 'retryPolicy']), [rootSchema])
  const retryDefaults = retryNode === undefined ? undefined : retryPolicyDefaults(schema, retryNode, schema.getPath(namespace.base, [...path, 'retryPolicy']))
  const retryFailure = retryNode === undefined || retryDefaults === undefined ? undefined
    : retryPolicyFailure(schema, retryNode, draft.retryPolicy, retryDefaults, (key, vars) => app.t(key, vars))

  // ---- 获取可用模型 ----
  // 自定义的提供商：手动选了协议就只问它；自动时先问已保存的协议，问不通再按地址猜的顺序换。
  const probeOrder = protocolMode === 'manual' && protocol !== undefined ? [protocol]
    : [...new Set([...protocol === undefined ? [] : [protocol], ...protocolProbeOrder(urlNow, protocols)])]
  const discover = family !== 'pi-ai' ? undefined
    : !declared ? catalogDiscover(app, namespace.ns, provider, meta.name, catalogInfo?.ok === true && catalogInfo.mixed === true ? { ...catalogInfo, occupied } : undefined)
      : endpointDiscover(app, namespace.ns, { provider, ...draft.baseURL === undefined ? {} : { baseURL: draft.baseURL }, ...keyValue.length > 0 ? { apiKey: keyValue } : {} },
        probeOrder,
        (api) => { if (protocolMode === 'auto' && api !== protocol) setField('api', api) })
  // 自定义的提供商：要清除密钥时不能拿它去问；Gemini API 没有密钥时问也是被拒。
  // 目录里的提供商由宿主端用已保存的密钥和地址去问：密钥或 API 地址有没保存的改动时，问出来的和页面上的对不上，先保存再问（和检查连接一样）。
  const savedUrlChanged = (draft.baseURL ?? '') !== (base.original?.baseURL ?? '')
  const discoverBlocked = keyDraft !== undefined && typeof keyDraft === 'object' ? app.t('keyRemovePending')
    : !declared && (keyValue.length > 0 || savedUrlChanged) ? app.t('fetchNeedsSave')
      : geminiKeyMissing && declared ? '' : undefined

  // 伴随条目的显示名 = 这一家的名字接协议名，对话的模型选择器里就显示它。
  const companionNameFor = api => app.t('companionName', { provider: meta.name, protocol: protocolLabel(app, api) })
  const catalogProtocols = catalogInfo?.ok === true ? catalogInfo.protocols ?? {} : undefined
  const textValue = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
  // 原提供商的自定义地址：用户层写的优先，其次是组合层（预设、bundle）给这一家写的；DSH 的 request.baseURL 就是这两层合起来的值。
  const overrideOf = profile => textValue(profile.baseURL) ?? textValue(inheritedProfile.baseURL)
  const storedUrlOf = api => companionBase[companionRoute(provider, api)]?.baseURL
  /** 这种协议的伴随条目能用的地址：原提供商的自定义地址、目录里这种协议的地址（lib/companion.js 的 addressChoices）。目录没读到时不给。 */
  const choicesFor = (api, profile) => (catalogProtocols === undefined ? [] : addressChoices(overrideOf(profile), catalogProtocols[api]?.base))
  /**
   * 这种协议的伴随条目该用的地址：这一页选过的优先；存着的正是保存时的默认地址（第一个可选地址）就跟着现在的默认走，
   * 例如在这一页给原提供商写上自定义地址时一起换过去；用户选过另一个的，还在可选范围里就保留，否则换成第一个（settledAddress）。
   */
  const addressFor = (api, profile) => {
    if (catalogProtocols === undefined) return undefined
    const choices = choicesFor(api, profile)
    if (companionUrlChoice[api] !== undefined) return settledAddress(companionUrlChoice[api], choices)
    const stored = storedUrlOf(api)
    return stored !== undefined && stored === choicesFor(api, base.original ?? {})[0] ? choices[0] : settledAddress(stored, choices)
  }
  const companionApis = [...new Set(companionDraft.map(model => model.__api))].sort()
  // 协议下拉里能选的：目录里能用的协议（地址统一、不要专用请求头）。
  const companionOptions = [...new Set([...Object.keys(catalogProtocols ?? {}), ...companionApis])]
  /** 保存后每种协议的模型（去掉 __api、__from）。 */
  const companionWanted = () => {
    const wanted = {}
    for (const model of companionDraft) (wanted[model.__api] ??= []).push(companionModelOf(model))
    return wanted
  }
  /** 写入时每种协议的地址和兼容开关；没有地址的协议不给（这时不让保存）。 */
  const companionEntriesFor = profile => Object.fromEntries(companionApis.flatMap((api) => {
    const url = addressFor(api, profile)
    return url === undefined ? [] : [[api, { baseURL: url, compat: catalogProtocols?.[api]?.compat ?? {} }]]
  }))
  const addressChanged = companionApis.some(api => storedUrlOf(api) !== undefined && addressFor(api, draft) !== undefined && addressFor(api, draft) !== storedUrlOf(api))
  // 兼容开关：条目里存的和现在的目录算出来的不一样（目录升级过、或早先建的没带）时计入待保存，保存时整份换成目录的。
  const sortedJson = value => JSON.stringify(Object.fromEntries(Object.entries(isRecordValue(value) ? value : {}).sort(([a], [b]) => a.localeCompare(b))))
  const compatStale = api => catalogProtocols?.[api] !== undefined && companionBase[companionRoute(provider, api)] !== undefined
    && sortedJson(companionBase[companionRoute(provider, api)].compat) !== sortedJson(catalogProtocols[api].compat)
  const compatText = compat => (Object.keys(compat).length === 0 ? app.t('compatNone') : Object.entries(compat).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', '))
  const companionDirty = addressChanged || companionApis.some(compatStale) || JSON.stringify(companionDraft) !== JSON.stringify(companionRowsOf(companionBase))
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.original ?? {}) || keyDirty || companionDirty
  const companionsInvolved = Object.keys(companionBase).length > 0 || companionDraft.length > 0
  // 有伴随条目时，目录读不到（或还在读）就不让保存：凭据名、地址都要按目录核对，不能只改一半。
  const companionBlock = !companionsInvolved ? undefined
    : catalogInfo === undefined ? ''
      : catalogInfo.ok !== true ? app.t('companionCatalogMissing')
        : companionApis.filter(api => occupied[api] !== undefined).map(api => app.t('companionOccupied', { protocol: protocolLabel(app, api), name: occupied[api] }))[0]
          ?? companionApis.filter(api => addressFor(api, draft) === undefined).map(api => app.t('companionNoAddress', { protocol: protocolLabel(app, api) }))[0]
  // 目录外的模型挂在我们手工声明的伴随条目上，和自定义的提供商一样能写推理等级；档位按各行自己的协议给（Gemini API 只收四档）。
  const companionReasoning = model => protocolReasoningLevels(model.__api, schemaLevels)
  const companionFailure = companionDraft.length === 0 ? undefined
    : validateModels(companionDraft.map(companionModelOf)) ?? validateReasoningByRow(companionDraft, companionReasoning)
  // ---- 协议混合的提供商手动添加模型（fix#205）----
  // 目录里的模型分属不同协议时，整家没有共同的协议，DSH 不知道目录外的模型走哪一种，写进这一家自己的模型目录会被拒绝保存。
  // 所以这时「添加模型」不往这一家自己的目录里加，改加到「目录外的模型」里，每行选协议，保存时写进那种协议的伴随条目。
  const mixedCatalog = family === 'pi-ai' && !declared && catalogInfo?.ok === true && catalogInfo.mixed === true
  const catalogModelIds = new Set(mixedCatalog ? (catalogInfo.models ?? []).map(model => model.id) : [])
  // 新加的一行先用获取列表时用的协议（LISTING_API），它不能用或被别的条目占着时用第一个能用的；一种都没有时不给加。
  const addableApis = Object.keys(catalogProtocols ?? {}).filter(api => occupied[api] === undefined).sort()
  const newCompanionApi = addableApis.includes(LISTING_API) ? LISTING_API : addableApis[0]
  // 这一家自己的模型目录里有安装包目录没有的模型 ID（例如改了某一行的 ID）：DSH 会拒绝保存，先在页面上写明怎么改，不让保存。
  const strayIds = mixedCatalog && Array.isArray(draft.models)
    ? modelDrafts(draft.models).map(model => model.id).filter(id => typeof id === 'string' && id.length > 0 && !catalogModelIds.has(id)) : []
  const strayFailure = strayIds.length === 0 ? undefined : app.t('modelOutsideCatalog', { ids: strayIds.join('、'), provider: meta.name })
  // 目录外的模型里填了安装包目录本来就有的 ID：能保存，只是重复了，提示改用「获取可用模型」加进这一家的目录。
  const catalogDuplicate = mixedCatalog ? companionDraft.find(model => typeof model.id === 'string' && catalogModelIds.has(model.id)) : undefined
  // 默认模型按「条目 + 模型 ID」认；协议改了还没保存时不能设为默认（条目还没建）。
  const savedDefault = snapshot.catalog?.default
  const isCompanionDefault = model => model.__from !== undefined && savedDefault?.provider === model.__from && savedDefault?.model === model.id
  const companionDefaultPending = model => (model.__from !== undefined && parseCompanion(model.__from)?.api !== model.__api ? 'setDefaultProtocolPending' : undefined)
  // 默认模型还在这一家已经删掉的伴随条目下（例如上次搬默认没成功），而这个模型现在在另一个条目里：写明，能一键改过去。
  // 只在默认模型指向的条目在配置里确实不存在时才算：手写的同形条目、被改了显示名的条目还在，默认设在那里是用户自己的选择。
  const providersNow = schema.getPath(namespace.value, ['providers'])
  const defaultRouteGone = savedDefault !== undefined && !(isRecordValue(providersNow) && providersNow[savedDefault.provider] !== undefined)
  const danglingDefault = !defaultRouteGone || parseCompanion(savedDefault.provider)?.origin !== provider ? undefined
    : companionRowsOf(companionBase).find(model => model.id === savedDefault.model)
  /** 把默认模型改到它现在所在的条目；成功、失败都写在页头。 */
  const moveDefault = async (model, route) => {
    const moved = await app.ops.setDefaultModel(route, model)
    if (moved.ok === true) {
      await app.store.load()
      setNotice({ ok: true, text: app.t('defaultMoved', { model, name: companionNameFor(parseCompanion(route).api) }) })
      return
    }
    const reason = app.t(`default${['notSavable', 'unknownModel'].includes(moved.reason) ? moved.reason : 'other'}`, { message: moved.message ?? '' })
    setNotice({ ok: false, text: app.t('defaultMoveFailed', { model, reason }) })
  }

  // ---- 设为默认模型 ----
  const savedIds = useMemo(() => new Set(modelDrafts(fallback.models ?? (inherited ?? [])).map(model => model.id)), [fallback.models, inherited])
  const setDefault = async (model, route = provider) => {
    setNotice(undefined)
    const result = await app.ops.setDefaultModel(route, model)
    if (result.ok === true) {
      await app.store.load()
      setNotice({ ok: true, text: app.t('defaultSaved', { model }) })
      return
    }
    const reason = app.t(`default${['notSavable', 'unknownModel'].includes(result.reason) ? result.reason : 'other'}`, { message: result.message ?? '' })
    setNotice({ ok: false, text: app.t('defaultFailed', { reason }) })
  }

  // ---- 保存 ----
  const [saveState, setSaveState] = useState({ busy: false })
  const modelFailure = validateModels(draft.models) ?? (allLevels.length > 0 ? validateReasoningEfforts(draft.models, reasoning.levelsOnly ? reasoning.levels : undefined) : undefined)
  /** 保存失败的原因：DSH 说某个模型缺协议时换成中文说明，其余照 DSH 的原话。 */
  const saveFailedText = (message) => {
    const missingApi = /model "([^"]+)" needs an api/.exec(String(message ?? ''))
    return missingApi === null ? app.t('saveFailed', { message }) : app.t('saveNeedsApi', { model: missingApi[1], provider: meta.name })
  }
  const save = async () => {
    if (modelFailure !== undefined) { setSaveState({ error: app.t('modelRowFailure', { index: modelFailure.index + 1, message: app.t(modelFailure.key) }) }); return }
    if (strayFailure !== undefined) { setSaveState({ error: strayFailure }); return }
    if (companionFailure !== undefined) { setSaveState({ error: app.t('modelRowFailure', { index: companionFailure.index + 1, message: app.t(companionFailure.key) }) }); return }
    if (companionBlock !== undefined) { setSaveState({ error: companionBlock }); return }
    if (urlInvalid) { setSaveState({ error: app.t('customBaseUrlInvalid') }); return }
    if (retryFailure !== undefined) { setSaveState({ error: retryFailure.message }); return }
    const removing = typeof keyDraft === 'object' && keyDraft !== null
    // 清除目录里的提供商存的派生凭据时，一并去掉配置里点名它的 apiKeyEnv，让它回到原生认证（照官方 rc.2 ProviderEditor.tsx:248-249）。
    const clearsDerivedRef = removing && family === 'pi-ai' && !declared && row.entry.nativeAuth !== undefined && draft.apiKeyEnv === deriveKeyRef(provider)
    let next = clearsDerivedRef ? Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'apiKeyEnv')) : draft
    // 只换这一家：配置改点名另起的凭据名，新密钥存到它下面；写配置以后快照可能重读或尚未重读，成功后再记住它（feat#174）。
    const keyTarget = replaceChoice !== undefined && replaceMode === 'only' ? onlyRef : effectiveKeyRef
    if (keyTarget !== effectiveKeyRef) next = { ...next, apiKeyEnv: keyTarget }
    // pi-ai 的配置只在要存 key 时才点名派生的凭据名，否则保留提供商自己的认证方式。
    if (family === 'pi-ai' && keyValue.length > 0 && row.apiKeyEnv === undefined && next.apiKeyEnv === undefined) next = { ...next, apiKeyEnv: effectiveKeyRef }
    if (path.length === 0) {
      const node = schema.nodeAtPath(rootSchema, [])
      const problem = node === undefined ? undefined : schema.validate(node, next)
      if (problem !== undefined) { setSaveState({ error: problem }); return }
    }
    setSaveState({ busy: true })
    if (removing && keyDraft.removed !== true) {
      const removed = await app.ops.removeCredential(keyView.ref)
      if (removed !== undefined) { setSaveState({ error: app.t('saveFailed', { message: removed }) }); return }
      setKeyDraft({ remove: true, removed: true })
    }
    // 原提供商和伴随条目的修改在同一次写入里完成；凭据名、地址变了，伴随条目同一次跟着改。
    const companionOps = !companionsInvolved ? [] : companionPlan({
      origin: provider, current: companionBase, wanted: companionWanted(),
      keyRef: companionKeyRef(provider, next, row.entry.nativeAuth?.env), entries: companionEntriesFor(next), nameFor: companionNameFor,
      taken: Object.keys(occupied).map(api => companionRoute(provider, api)),
    })
    // 默认模型在伴随条目里、这次换了协议：写入后把默认改到新条目（DSH 不会自己跟过去，会留在已经删掉的条目上）。
    const movedDefault = savedDefault === undefined ? undefined
      : companionDraft.find(model => model.__from === savedDefault.provider && model.id === savedDefault.model && parseCompanion(model.__from)?.api !== model.__api)
    const ops = [...pathOps(path, base.original, next), ...companionOps]
    if (ops.length > 0) {
      const written = await app.ops.writeSettings(namespace.ns, ops, base.revision)
      if (written.kind === 'conflict') { setSaveState({ conflict: true }); return }
      if (written.kind !== 'written') {
        setSaveState({ error: removing ? app.t('keyRemoveApplied') : saveFailedText(written.message) })
        return
      }
      if (keyTarget !== effectiveKeyRef) setCommittedKeyRef(keyTarget)
      const original = userOf(written.view)
      setBase({ original, revision: written.view.revision })
      setDraft(structuredClone(original ?? {}))
      if (companionOps.length > 0) {
        const companions = companionsOf(written.view)
        setCompanionBase(companions)
        setCompanionDraft(companionRowsOf(companions))
        setCompanionUrlChoice({})
      }
      // 配置写好了就搬默认，不等后面存密钥：存密钥失败时默认也已经跟过去；搬没成功时页头写明，页面上还留着「改过去」可以再点。
      if (movedDefault !== undefined) {
        await app.store.load()
        await moveDefault(movedDefault.id, companionRoute(provider, movedDefault.__api))
      }
    }
    if (keyValue.length > 0) {
      const stored = await app.ops.storeCredential(keyTarget, keyValue)
      if (stored !== undefined) { setSaveState({ error: app.t('saveFailed', { message: stored }) }); return }
    }
    if (keyDirty) app.store.setCheck(provider, undefined)
    setKeyDraft(undefined)
    setReplaceMode(undefined)
    setCommittedKeyRef(undefined)
    setSaveState({ busy: false })
    setSavedHere(true)
    await app.store.load()
  }
  const reload = async () => {
    await app.store.load()
    const fresh = app.store.getSnapshot().namespaces.get(namespace.ns) ?? namespace
    const original = userOf(fresh)
    setBase({ original, revision: fresh.revision })
    setDraft(structuredClone(original ?? {}))
    setKeyDraft(undefined)
    setReplaceMode(undefined)
    setCommittedKeyRef(undefined)
    setCompanionBase(companionsOf(fresh))
    setCompanionDraft(companionRowsOf(companionsOf(fresh)))
    setCompanionUrlChoice({})
    setSaveState({ busy: false })
  }
  const cancel = () => {
    // 凭据已经清掉、配置没写完时「取消」只丢下这一页的修改；凭据回不来，所以重新读一次让密钥框显示真实状态。
    if (typeof keyDraft === 'object' && keyDraft?.removed === true) void app.store.load()
    setDraft(structuredClone(base.original ?? {}))
    setKeyDraft(undefined)
    setReplaceMode(undefined)
    setCommittedKeyRef(undefined)
    setCompanionDraft(companionRowsOf(companionBase))
    setCompanionUrlChoice({})
    setSaveState({ busy: false })
  }

  // ---- 删除 ----
  // 别的提供商还在读这个凭据名（点名的，或目录给的环境变量名）时只删配置，凭据留着，确认框也照这个说（TS-001）。
  const credentialRef = row.apiKeyEnv === deriveKeyRef(provider) && row.credential?.configured === true && row.credential.writable === true
    && otherUsers(row.apiKeyEnv).length === 0 ? row.apiKeyEnv : undefined
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(undefined)
  const confirmDelete = async () => {
    setDeleting(true)
    setDeleteError(undefined)
    try {
      // 连同伴随条目一起删，同一次写入。按最新的配置找（这一页有未保存的修改时，页面上的那份不随别处的修改刷新），带上它的 revision。
      await app.store.load()
      const fresh = app.store.getSnapshot().namespaces.get(namespace.ns) ?? namespace
      const companions = Object.keys(companionsOf(fresh))
      // 先写配置，成功后才删凭据：写配置冲突或失败时，凭据原样留着。
      const written = await app.ops.writeSettings(namespace.ns, [{ op: 'unset', path: [...path] }, ...companions.map(route => ({ op: 'unset', path: ['providers', route] }))], fresh.revision)
      if (written.kind === 'conflict') { setDeleteError(app.t('conflict')); return }
      if (written.kind !== 'written') { setDeleteError(written.message); return }
      if (credentialRef !== undefined) {
        const removed = await app.ops.removeCredential(credentialRef)
        // 配置已经删了，这一页的提供商可能已经不在（自定义的提供商）：回到列表页，带着这条提示，写明留下的凭据名。
        if (removed !== undefined) {
          app.store.setCheck(provider, undefined)
          await app.store.load()
          go({ page: 'list', notice: app.t('deleteCredentialLeft', { ref: credentialRef, message: removed }) })
          return
        }
      }
      app.store.setCheck(provider, undefined)
      await app.store.load()
      go({ page: 'list' })
    } finally {
      setDeleting(false)
    }
  }

  const busy = saveState.busy === true || deleting
  const blockedSave = busy || readOnly || saveState.conflict === true || urlInvalid || keyFailure !== undefined || keyTaken !== undefined || replacePending
    || retryFailure !== undefined || modelFailure !== undefined || strayFailure !== undefined || companionFailure !== undefined || companionBlock !== undefined
  // 输入新密钥时，选项已经说了谁也在用这个凭据名，不再挂「不能在这里清除」。
  const keyError = keyFailure !== undefined ? app.t(keyFailure) : keyTaken ?? (replaceChoice === undefined ? clearBlocked : undefined)
  const shownHint = keyError !== undefined ? { text: keyError, tone: keyFailure !== undefined || keyTaken !== undefined ? 'err' : 'hint' }
    : geminiKeyMissing ? { text: app.t('protocolNeedsKey'), tone: 'hint' } : replaceChoice !== undefined ? undefined : keyHint
  return h(Fragment, null,
    h(DetailHeader, { app, snapshot, row, go, saved: savedHere && !dirty, notice }),
    row.entry.error === undefined || row.entry.active === false ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, row.entry.error),
    showKey ? h('div', { className: 'dms-field' },
      h(ApiKeyInput, {
        app, id: `dms-key-${provider}`, view: keyView, draft: keyDraft, disabled: readOnly || busy, invalid: keyFailure !== undefined,
        hint: shownHint?.text, hintTone: shownHint?.tone,
        onDraft: (next) => { setKeyDraft(next); setSaveState({ busy: false }); if (typeof next !== 'string' || next.trim().length === 0) setReplaceMode(undefined) },
      }),
      replaceChoice === undefined ? null : h(Fragment, null,
        h('p', { id: `dms-key-${provider}-choice-notice`, className: 'dms-hint' }, spaced(app.t('keyReplaceNotice', { ref: effectiveKeyRef, provider: replaceWith }))),
        h(KeyChoice, { id: `dms-key-${provider}-choice`, label: app.t('keyField'), describedBy: `dms-key-${provider}-choice-notice`, value: replaceMode, options: replaceChoice, disabled: readOnly || busy, onChange: setReplaceMode })),
      meta.keyUrl === undefined ? null : h('p', { className: 'dms-hint' }, h(ExternalLink, { href: meta.keyUrl }, app.t('keyGet'))))
      : h('p', { className: 'dms-hint' }, app.t('keyNotNeeded')),
    h('div', { className: 'dms-row' },
      h(ui.Button, { variant: 'outline', size: 'sm', disabled: checking || checkBlocked !== undefined, onClick: () => { void runCheck() } }, checking ? app.t('checking') : app.t('check')),
      checkBlocked !== undefined ? h('span', { className: 'dms-hint' }, checkBlocked)
        : check === undefined || !check.ok ? null
          : h(State, { status: { tone: 'ok', text: app.t('checkOk', { model: check.model, seconds: (check.ms / 1000).toFixed(1), time: formatClock(app, check.at) }) } })),
    checkBlocked === undefined && check !== undefined && !check.ok
      ? h('p', { className: 'dms-note dms-err', role: 'alert' }, app.t('checkFailedLine', { reason: reasonText(app, check, meta, false), model: check.model ?? '', time: formatClock(app, check.at) })) : null,
    h(ModelsEditor, {
      app, family, rows: rowsNow, inherited: ownModels === undefined && !declared, overridePending: ownModels !== undefined && base.original?.models === undefined,
      disabled: readOnly || busy,
      onChange: models => setDraft(current => ({ ...current, models })),
      onReset: declared ? undefined : () => setDraft((current) => { const next = { ...current }; delete next.models; return next }),
      reasoningLevels: reasoning.levels, levelsOnly: reasoning.levelsOnly, inputDefaults, reasoningIds, defaultModel, catalogIds, savedIds,
      onSetDefault: readOnly ? undefined : (model) => { void setDefault(model) },
      discover, discoverBlocked,
      // 协议混合的提供商：手动添加的模型放到下面的「目录外的模型」里，这里只留「获取可用模型」。
      hideAdd: mixedCatalog,
      extraRows: companionDraft,
      onAddCompanion: entries => setCompanionDraft(current => [...current, ...entries
        .filter(entry => !current.some(model => model.id === entry.id))
        .map(entry => ({ ...adoptCandidate(entry.candidate, 'pi-ai'), __api: entry.candidate.companionApi }))]),
      onRemoveExtra: id => setCompanionDraft(current => current.filter(model => model.id !== id)),
    }),
    strayFailure === undefined ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, strayFailure),
    // 协议混合的提供商：没有目录外的模型时也列出这一块，「添加模型」在这里。
    companionDraft.length === 0 && !mixedCatalog ? null : h(ModelsEditor, {
      app, family: 'pi-ai', rows: companionDraft, inherited: false, showSource: false, disabled: readOnly || busy,
      hideAdd: !mixedCatalog || newCompanionApi === undefined,
      newRow: newCompanionApi === undefined ? undefined : () => ({ id: '', __api: newCompanionApi }),
      heading: app.t('companionModels'),
      headingMeta: companionDraft.length === 0 ? app.t('companionModelsEmpty')
        : app.t('companionModelsMeta', { count: companionDraft.length, names: companionApis.map(companionNameFor).join('、') }),
      protocolOptions: companionOptions, catalogIds: new Set(), reasoningOf: companionReasoning,
      protocolBlocked: api => (occupied[api] === undefined ? undefined : app.t('protocolOccupied', { protocol: protocolLabel(app, api), name: occupied[api] })),
      isDefault: isCompanionDefault, defaultPendingFor: companionDefaultPending,
      savedIds: new Set(companionRowsOf(companionBase).map(model => model.id)),
      onChange: setCompanionDraft,
      onSetDefault: readOnly ? undefined : (id, model) => { if (model?.__from !== undefined) void setDefault(id, model.__from) },
    }),
    mixedCatalog && newCompanionApi === undefined ? h('p', { className: 'dms-hint' }, app.t('companionAddBlocked')) : null,
    catalogDuplicate === undefined ? null : h('p', { className: 'dms-hint' }, app.t('modelInCatalog', { id: catalogDuplicate.id })),
    danglingDefault === undefined || readOnly ? null : h('div', { className: 'dms-row' },
      h('p', { className: 'dms-note dms-warn' }, app.t('defaultDangling', { model: danglingDefault.id, name: companionNameFor(danglingDefault.__api) })),
      h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void moveDefault(danglingDefault.id, danglingDefault.__from) } }, app.t('defaultRepair'))),
    companionsInvolved && companionBlock !== undefined && companionBlock !== '' && catalogInfo?.ok === true ? h('p', { className: 'dms-note dms-err', role: 'alert' }, companionBlock) : null,
    companionsInvolved ? h(CompanionAddresses, {
      app, provider, providerName: meta.name, apis: companionApis, catalogMissing: catalogInfo !== undefined && catalogInfo.ok !== true,
      override: overrideOf(draft), choicesFor: api => choicesFor(api, draft), addressFor: api => addressFor(api, draft), storedUrlOf,
      compatNoteFor: api => (compatStale(api) ? app.t('companionCompatStale', { protocol: protocolLabel(app, api), compat: compatText(catalogProtocols[api].compat) }) : undefined),
      disabled: readOnly || busy, onChoose: (api, url) => setCompanionUrlChoice(current => ({ ...current, [api]: url })),
    }) : null,
    h('button', { type: 'button', className: 'dms-disc', 'aria-expanded': customizedOpen ? 'true' : 'false', onClick: () => setCustomizedOpen(!customizedOpen) },
      h(customizedOpen ? ui.IconChevronDownOutlineRegular : ui.IconChevronRightOutlineRegular, { size: 14, className: 'dms-disc-ico' }), app.t('customized'),
      customizedOpen ? null : h('span', { className: 'dms-meta' }, app.t('customizedSummary'))),
    customizedOpen ? h('div', { className: 'dms-fold' },
      declared ? h(Field, { id: `dms-name-${provider}`, label: app.t('displayName') },
        h(TextInput, { id: `dms-name-${provider}`, value: draft.displayName ?? '', placeholder: provider, disabled: readOnly || busy, onChange: text => setField('displayName', text) })) : null,
      h(Field, { id: `dms-url-${provider}`, label: app.t('baseUrl'), error: urlInvalid ? app.t('customBaseUrlInvalid') : undefined,
        hint: preview === undefined ? undefined : app.t('requestPreview', { url: preview }) },
      h(TextInput, { id: `dms-url-${provider}`, value: baseUrlShown, disabled: readOnly || busy, invalid: urlInvalid,
        placeholder: fallback.baseURL ?? row.entry.defaultBaseURL ?? app.t('baseUrlDefault'), onChange: text => setField('baseURL', text) })),
      declared && protocol !== undefined ? (protocolMode === 'auto'
        ? h('div', { className: 'dms-field' }, h('div', { className: 'dms-label' }, app.t('protocol')),
          h('div', { className: 'dms-row' }, h('span', null, protocolLabel(app, protocol)), h('span', { className: 'dms-hint' }, app.t('protocolOnFetch')),
            h('button', { type: 'button', className: 'dms-link', disabled: readOnly || busy, onClick: () => setProtocolMode('manual') }, app.t('changeProtocol'))))
        : h('div', { className: 'dms-field' }, h('div', { className: 'dms-label' }, app.t('protocol')),
          h(ui.SegmentedControl, { label: app.t('protocol'), value: protocol, disabled: readOnly || busy,
            options: protocols.map(api => ({ value: api, label: protocolLabel(app, api) })), onChange: api => setField('api', api) }))) : null,
      retryDefaults === undefined ? null : h(RetryPolicyEditor, {
        app, idBase: `dms-retry-${provider}`, policy: draft.retryPolicy, defaults: retryDefaults, failure: retryFailure, disabled: readOnly || busy,
        onChange: next => setDraft((current) => {
          const copy = { ...current }
          if (next === undefined) delete copy.retryPolicy
          else copy.retryPolicy = next
          return copy
        }),
      }),
      h('div', { className: 'dms-grid2' },
        h('div', { className: 'dms-field' }, h('div', { className: 'dms-label' }, app.t('routeId')), h('span', { className: 'dms-mono dms-idle' }, provider)),
        showKey ? h('div', { className: 'dms-field' }, h('div', { className: 'dms-label' }, app.t('credentialName')), h('span', { className: 'dms-mono dms-idle' }, effectiveKeyRef)) : null),
      h('p', { className: 'dms-hint' }, app.t('advancedHint'))) : null,
    retryFailure === undefined || customizedOpen ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, retryFailure.message),
    row.removable && !readOnly ? h('button', { type: 'button', className: 'dms-danger', style: { marginTop: '8px' }, disabled: busy, onClick: () => { setDeleteError(undefined); setDeleteOpen(true) } },
      app.t('deleteProvider', { provider: meta.name })) : null,
    dirty || saveState.conflict ? h('div', { className: 'dms-foot' },
      saveState.conflict ? h('div', { className: 'dms-banner', style: { marginRight: 'auto' } },
        h('p', { className: 'dms-note dms-warn' }, app.t('conflict')),
        h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void reload() } }, app.t('reload')))
        : saveState.error !== undefined ? h('p', { className: 'dms-note dms-err', role: 'alert' }, saveState.error)
          : replaceChoice !== undefined && replaceMode === undefined ? h('p', { className: 'dms-note' }, spaced(app.t('keyReplaceChoose', { provider: replaceWith }))) : null,
      h(ui.Button, { variant: 'outline', disabled: busy, onClick: cancel }, typeof keyDraft === 'object' && keyDraft?.removed === true ? app.t('close') : app.t('cancel')),
      h(ui.Button, { variant: 'primary', disabled: blockedSave, onClick: () => { void save() } }, saveState.busy ? app.t('saving') : app.t('save'))) : null,
    h(ui.Modal, {
      open: deleteOpen, onClose: () => { if (!deleting) setDeleteOpen(false) },
      closeLabel: app.t('close'),
      title: app.t('deleteTitle', { provider: meta.name }),
      description: [credentialRef === undefined ? app.t('deleteDescription', { provider: meta.name }) : app.t('deleteDescriptionWithCredential', { provider: meta.name }),
        ...ownRoutes.size === 0 ? [] : [app.t('deleteDescriptionWithCompanions', { names: [...ownRoutes].map(route => companionNameFor(parseCompanion(route).api)).join('、') })]].join(''),
      footer: h(Fragment, null,
        h(ui.Button, { variant: 'outline', disabled: deleting, onClick: () => setDeleteOpen(false) }, app.t('cancel')),
        h(ui.Button, { variant: 'outline', className: 'dms-btn-danger', disabled: deleting, onClick: () => { void confirmDelete() } },
          deleting ? app.t('deleting', { provider: meta.name }) : app.t('deleteProvider', { provider: meta.name }))),
    }, deleteError === undefined ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, deleteError)))
}

function DetailPage({ app, snapshot, provider, go, saved }) {
  const row = snapshot.rows.find(candidate => candidate.entry.provider === provider)
  if (row === undefined) {
    return h(Fragment, null,
      h(Crumb, { label: app.t('back'), onClick: () => go({ page: 'list' }) }),
      snapshot.status === 'ready' ? h('p', { className: 'dms-note' }, app.t('gone')) : h('div', { className: 'dms-skel', 'aria-busy': 'true' }))
  }
  if (row.entry.provider === 'deepseek-account') return h(AccountDetail, { app, snapshot, row, go })
  const namespace = snapshot.namespaces.get(row.entry.settingsNs)
  if (namespace === undefined) {
    return h(Fragment, null, h(DetailHeader, { app, snapshot, row, go }), h('p', { className: 'dms-hint' }, app.t('advancedHint')))
  }
  return h(ProviderDetail, { key: provider, app, snapshot, row, namespace, go, saved })
}

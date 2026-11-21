/** 模型目录：一行一个模型，点开编辑；继承的目录在第一次修改时整份写进用户层，规则照 DSH 内置页。 */

const CAPACITY_FIELDS = ['contextWindow', 'maxTokens']

/** 没有整行拖动预览时的替身：浏览器用自己的拖动影像，结束时照常收尾。 */
const NO_DRAG_PREVIEW = { start() {}, clear: () => true }
/**
 * 整行拖动预览，和 DSH 官方模型页、工作区排序用的是同一个（ui.useRowDragPreview，0.2.2-rc.3 起有）。
 * 旧版 DSH 没有时退回浏览器默认的拖动影像。用 let 是为了测试能换成记录调用的替身。
 */
let useRowDragPreview = typeof ui.useRowDragPreview === 'function' ? ui.useRowDragPreview : () => NO_DRAG_PREVIEW
/** 没有 ui.AnimatedRows 的旧版 DSH：行照常排，移动时没有动画。 */
function PlainRows({ className, children }) {
  return h('div', { className }, children)
}
/** 行移动、增删时的动画（遵循系统的减少动态效果设置），也和官方模型页、工作区排序同一个组件。 */
const RowsList = typeof ui.AnimatedRows === 'function' ? ui.AnimatedRows : PlainRows

/** 一行的推理档位编辑：开关加「档位 / API 参数值」若干行。levelsOnly（Gemini API）时参数值固定等于档位名，不能改。 */
function ReasoningEditor({ app, model, levels, levelsOnly = false, disabled, onChange, idBase }) {
  const entries = readEfforts(model)
  const on = entries !== undefined
  const used = new Set((entries ?? []).map(([level]) => level))
  const turnOn = () => onChange(withEfforts(model, INITIAL_EFFORTS.filter(([level]) => levels.includes(level)).map(([level, wire]) => [level, levelsOnly ? level : wire])))
  const replace = (index, next) => onChange(withEfforts(model, entries.map((entry, at) => at === index ? next : entry)))
  const remove = index => onChange(withEfforts(model, entries.filter((_, at) => at !== index)))
  const free = levels.filter(level => !used.has(level))
  return h('div', { className: 'dms-field' },
    h('div', { className: 'dms-label' }, h(ui.Switch, { checked: on, disabled, label: app.t('modelReasoning'), onChange: next => next ? turnOn() : onChange(withEfforts(model, undefined)) }), app.t('modelReasoning')),
    on ? h(Fragment, null,
      h('div', { className: 'dms-lv dms-hint' }, h('span', null, app.t('modelReasoningLevel')), h('span', null, app.t('modelReasoningValue')), h('span')),
      entries.map(([level, wire], index) => h('div', { key: `${idBase}-${index}`, className: 'dms-lv' },
        h('select', {
          className: 'dms-select', value: level, disabled, 'aria-label': app.t('modelReasoningLevel'),
          onChange: (event) => {
            const next = event.target.value
            const keep = !levelsOnly && typeof wire === 'string' && wire !== level && next !== 'off' && level !== 'off'
            replace(index, [next, next === 'off' ? null : keep ? wire : next])
          },
        }, [level, ...free].map(option => h('option', { key: option, value: option }, option))),
        h(TextInput, {
          id: `${idBase}-value-${index}`, mono: true, disabled: disabled || level === 'off' || levelsOnly, label: app.t('modelReasoningValue'),
          value: typeof wire === 'string' ? wire : '', placeholder: level === 'off' ? app.t('modelReasoningOffValuePlaceholder') : level,
          invalid: (level !== 'off' && !(typeof wire === 'string' && wire.length > 0)) || (levelsOnly && (wire !== level || !levels.includes(level))), onChange: text => replace(index, [level, text]),
        }),
        h(ui.Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => remove(index) }, app.t('modelReasoningRemove')))),
      free.length === 0 ? null : h('div', null, h(ui.Button, { variant: 'outline', size: 'sm', disabled, onClick: () => onChange(withEfforts(model, [...entries, [free[0], free[0] === 'off' ? null : free[0]]])) }, app.t('modelReasoningAdd'))),
      levelsOnly && entries.some(([level, wire]) => !levels.includes(level) || wire !== level) ? h('p', { className: 'dms-note dms-err', role: 'alert' }, app.t('modelReasoningLevelsOnly')) : null)
      : null)
}

/**
 * 目录里的提供商的「获取可用模型」：读一次安装包目录（DSH 本机回答，不发请求），再让插件宿主端向提供商请求一次，两份合在一起。
 * 只在点按钮时调用；请求失败也照样列出目录，第一行写明没查到和原因。
 * @param {object} app 插件的共享对象。
 * @param {string} ns 命名空间。
 * @param {string} provider Provider ID。
 * @param {string} providerName 显示名称。
 * @param {{ models: object[], protocols: Record<string, object>, unusable?: Record<string, string> } | undefined} companion 协议混合的提供商：目录里每个模型的协议、能用的协议、不能用的协议和原因；
 *   只在提供商返回里的模型按同类模型推出协议，能用时放进伴随条目，不能用时行上写明原因。
 * @returns {() => Promise<object>} 给 ModelsEditor 的 discover。
 */
function catalogDiscover(app, ns, provider, providerName, companion) {
  return async () => {
    const [catalog, live] = await Promise.all([app.ops.discoverModels(ns, { provider }), app.ops.discoverLive(provider)])
    const catalogModels = catalog.kind === 'found' ? catalog.models : []
    if (live.ok === true) {
      let host = live.url
      try { host = new URL(live.url).host } catch { /* 地址读不出来时照原样写。 */ }
      const merged = mergeCandidates(catalogModels, live.models, live.acceptsUnlisted)
      return {
        kind: 'found', candidates: companion === undefined ? merged : merged.map((candidate) => {
          if (candidate.blocked !== true) return candidate
          const api = inferApi(candidate.id, companion.models)
          if (companion.occupied?.[api] !== undefined) return { ...candidate, occupied: { api, name: companion.occupied[api] } }
          if (companion.protocols[api] === undefined) {
            const reason = companion.unusable?.[api]
            return reason === undefined ? candidate : { ...candidate, unusable: { reason, api } }
          }
          const { blocked, ...rest } = candidate
          return { ...rest, companionApi: api }
        }),
        source: app.t('sourceCatalogAndLive', { catalog: catalogModels.length, host, live: live.models.length, time: formatClock(app, live.at) }),
      }
    }
    if (catalog.kind !== 'found') {
      const why = discoveryFailure(catalog.message)
      return { kind: 'refused', text: app.t(why.key, why.vars) }
    }
    const reason = app.t(`live${['noKey', 'noCredentials', 'auth', 'status', 'network', 'timeout', 'unsupported', 'noBaseUrl', 'badKey', 'unknownProvider', 'noCatalog', 'badBaseUrl'].includes(live.reason) ? live.reason : 'other'}`, {
      status: live.status ?? '', host: live.host ?? '', seconds: live.seconds ?? 20, message: live.message ?? '',
    })
    return { kind: 'found', candidates: mergeCandidates(catalogModels, undefined, true), source: app.t('sourceCatalogOnly', { catalog: catalogModels.length, provider: providerName, reason }) }
  }
}

/**
 * 自定义地址的「获取可用模型」：按顺序换协议问，问通的那种告诉页面（自动识别协议）。
 * @param {object} app 插件的共享对象。
 * @param {string} ns 命名空间。
 * @param {object} request 地址、Provider ID、密钥等，不含协议。
 * @param {readonly string[]} order 依次问的协议（protocolProbeOrder 的结果）。
 * @param {(api: string) => void} [onDetected] 问通时的协议。
 * @returns {() => Promise<object>} 给 ModelsEditor 的 discover。
 */
function endpointDiscover(app, ns, request, order, onDetected) {
  return async () => {
    let first
    for (const api of order) {
      const answer = await app.ops.discoverModels(ns, { ...request, api })
      if (answer.kind === 'found') {
        onDetected?.(api)
        return {
          kind: 'found', candidates: mergeCandidates(undefined, answer.models, true),
          source: app.t('sourceLive', { url: listingUrl(request.baseURL, api), live: answer.models.length, time: formatClock(app, Date.now()) }),
        }
      }
      first ??= answer
      if (!worthAnotherProtocol(answer.message)) break
    }
    const why = discoveryFailure(first?.message ?? '')
    return { kind: 'refused', text: app.t(why.key, why.vars) }
  }
}

/**
 * 「获取可用模型」的选择器，放在对话框里：每个模型一行，点「+」加进列表，点「×」从列表删除。改动直接记进目录草稿，保存还是页面底栏的事。
 * 第一行写这份列表从哪来（安装包目录、提供商返回的列表，或两者）。只在提供商返回里有的行标出来；这一家不能加目录外的模型时「+」禁用。
 */
function ModelPicker({ app, picker, setPicker, rows, disabled, onAdd, onAddAll, onRemove, onRemoveAll, onClose }) {
  const entries = modelPickerEntries(picker.candidates, rows)
  const { visible, counts } = modelPickerView(entries, picker)
  const typeLabel = type => type === 'image' ? app.t('inputImage') : type === 'text' ? app.t('inputText') : type
  const addable = entry => !entry.added && entry.candidate !== undefined && entry.candidate.blocked !== true
  const canAdd = visible.some(addable)
  const canRemove = visible.some(entry => entry.added)
  const originNote = entry => entry.candidate?.origin !== 'provider' ? undefined
    : entry.candidate.blocked === true && entry.candidate.occupied !== undefined
      ? app.t('onlyFromProviderOccupied', { protocol: protocolLabel(app, entry.candidate.occupied.api), name: entry.candidate.occupied.name })
    : entry.candidate.blocked === true ? (entry.candidate.unusable === undefined ? app.t('onlyFromProviderBlocked')
      : app.t(`onlyFromProviderUnusable${entry.candidate.unusable.reason}`, { protocol: protocolLabel(app, entry.candidate.unusable.api) }))
    : entry.candidate.companionApi !== undefined ? app.t('onlyFromProviderVia', { protocol: protocolLabel(app, entry.candidate.companionApi) }) : app.t('onlyFromProvider')
  return h(ui.Modal, {
    open: true, onClose, title: app.t('fetchTitle'), closeLabel: app.t('close'), description: picker.source, className: 'dms-pdlg',
    footer: h(ui.Button, { variant: 'primary', onClick: onClose }, app.t('done')),
  },
  h('div', { className: 'dms-pbody' },
    h(TextInput, { id: 'dms-candidate-search', value: picker.query, onChange: query => setPicker({ ...picker, query }), placeholder: app.t('fetchSearch'), label: app.t('fetchSearch') }),
    h('div', { className: 'dms-pbar' },
      h(ui.SegmentedControl, {
        label: app.t('fetchTitle'), value: picker.tab, onChange: tab => setPicker({ ...picker, tab }),
        options: [['all', 'pickAll'], ['added', 'pickAdded'], ['notAdded', 'pickNotAdded']].map(([value, key]) => ({ value, label: app.t(key, { count: counts[value] }) })),
      }),
      h('div', { className: 'dms-row' },
        canAdd ? h(ui.Button, { variant: 'outline', size: 'sm', disabled, onClick: () => onAddAll(visible.filter(addable)) }, app.t('pickAddAll')) : null,
        canRemove ? h(ui.Button, { variant: 'outline', size: 'sm', disabled, onClick: () => onRemoveAll(visible) }, app.t('pickRemoveAll')) : null)),
    visible.length === 0 ? h('p', { className: 'dms-note' }, app.t(picker.query.trim().length > 0 ? 'fetchNoMatches' : picker.tab === 'added' ? 'pickEmptyAdded' : 'pickEmptyNotAdded'))
      : h('ul', { className: 'dms-plist' }, visible.map((entry) => {
        const note = originNote(entry)
        const label = entry.name !== undefined && entry.name !== entry.id ? entry.name : undefined
        return h('li', { key: entry.id, className: 'dms-prow', 'data-added': entry.added ? 'true' : 'false' },
          h('span', { className: 'dms-main' },
            h('span', { className: 'dms-mono' }, entry.id),
            label === undefined && note === undefined ? null : h('span', { className: 'dms-meta' }, [label, note].filter(Boolean).join(' · '))),
          h('span', { className: 'dms-caps' }, (entry.candidate?.inputModalities ?? []).map(type => h('span', { key: type, className: 'dms-tag' }, typeLabel(type)))),
          entry.added
            ? h('button', { type: 'button', className: 'dms-iconbtn', disabled, 'aria-label': `${app.t('removeModel')} ${entry.id}`, title: app.t('removeModel'), onClick: () => onRemove(entry.id) }, h(ui.IconCloseOutlineRegular, { size: 14 }))
            : h('button', { type: 'button', className: 'dms-iconbtn', disabled: disabled || !addable(entry), 'aria-label': `${app.t('addModel')} ${entry.id}`, title: app.t('addModel'), onClick: () => onAdd(entry) }, h(ui.IconPlusOutlineRegular, { size: 14 })))
      }))))
}

/**
 * 模型目录编辑器。
 * @param {object} props 见下面的解构。rows 是当前生效的行；inherited 表示还在用适配器默认目录；overridePending 表示这次刚开始自定义、还没保存；
 *   discover 是「获取可用模型」，由页面按提供商的种类给（目录里的提供商同时读目录、向提供商请求一次；自定义的提供商向它的地址请求）；
 *   catalogIds 是安装包目录里的模型 ID（自定义的提供商没有），用来标「数据不全」；savedIds 是已保存的模型 ID，只有这些能设为默认模型。
 *   isDefault 判断一行是不是默认模型（缺省按 defaultModel 比模型 ID；目录外的模型要连条目一起比）；defaultPendingFor 给出这一行暂时不能设为默认的文案键。
 *   reasoningOf 按行给出能用的推理档位 { levels, levelsOnly }（目录外的模型各行协议不同）；不给时所有行共用 reasoningLevels、levelsOnly。
 *   newRow 给出「添加模型」新加的那一行（目录外的模型要带上协议）；不给时是模型 ID 为空的一行。
 */
function ModelsEditor(props) {
  const { app, family, rows, inherited, overridePending = false, onChange, onReset, reasoningLevels = [], levelsOnly = false, reasoningOf, inputDefaults, reasoningIds, defaultModel,
    discover, discoverBlocked, catalogIds, savedIds, onSetDefault, isDefault: isDefaultOf, defaultPendingFor, disabled, title = true, showSource = true,
    heading, headingMeta, hideAdd = false, newRow, protocolOptions, protocolBlocked, extraRows = [], onAddCompanion, onRemoveExtra } = props
  const [expanded, setExpanded] = useState(() => new Set())
  const [buffers, setBuffers] = useState(() => new Map())
  const [picker, setPicker] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(undefined)
  const [menu, setMenu] = useState(undefined)
  const [drag, setDrag] = useState(undefined)
  const preview = useRowDragPreview('dms-drag-preview') ?? NO_DRAG_PREVIEW
  // 每行一个稳定的键：移动、删除时跟着行走，动画靠它认出同一行；展开状态和写到一半的容量文字也按这个键记，不按下标。
  // 这里自己的增删、移动在动手时就改好键；行数从外面变了（在选择器里删目录外的模型、恢复默认、取消）时，
  // 按模型 ID 把键对回同一个模型（ID 为空或重复的行拿新键），不按位置在末尾补上或截掉。
  const keySeq = useRef(0)
  const nextKey = () => `m${keySeq.current++}`
  const keys = useRef(null)
  const keyedRows = useRef(rows)
  // 这里自己发出去的改动（编辑、移动、增删）记下 ID 顺序；回来的行和它对得上就是自己的改动，键在动手时已改好。
  // 打字改模型 ID 也是自己的改动，所以不会因为 ID 变了换键、让输入框失焦。
  const emittedIds = useRef(null)
  const ids = rowIds(rows)
  const ownChange = emittedIds.current !== null && msSameIds(emittedIds.current, ids)
  if (ownChange) emittedIds.current = null
  if (keys.current === null) keys.current = rows.map(nextKey)
  else if (keys.current.length !== rows.length || (!ownChange && !msSameIds(rowIds(keyedRows.current), ids))) {
    keys.current = alignRowKeys(keyedRows.current, keys.current, rows, nextKey)
  }
  keyedRows.current = rows
  const emit = (next) => {
    emittedIds.current = rowIds(next)
    onChange(next)
  }
  const isDefaultModel = isDefaultOf ?? (model => model.id === defaultModel)
  // 一行能用的推理档位：目录外的模型按各自的协议给（reasoningOf），其余的行共用 reasoningLevels。
  const reasoningFor = model => reasoningOf?.(model) ?? { levels: reasoningLevels, levelsOnly }
  const failureOfRows = validateModels(rows.length === 0 && inherited ? undefined : rows) ?? validateReasoningByRow(rows, reasoningFor)

  const patch = (index, next) => emit(rows.map((model, at) => at === index ? patchModel(model, next) : model))
  const replace = (index, model) => emit(rows.map((current, at) => at === index ? model : current))
  const keyAt = index => keys.current[index]
  const toggle = index => setExpanded(current => { const next = new Set(current); if (!next.delete(keyAt(index))) next.add(keyAt(index)); return next })
  const bufferKey = (index, field) => `${keyAt(index)}:${field}`
  // 写到一半的容量文字只在它和这一行现在的值对得上时才显示：值被别处改了（恢复默认、取消、撤回）就改按值显示。
  const capacityText = (model, index, field) => {
    const text = buffers.get(bufferKey(index, field))
    if (text !== undefined && Object.is(parseCapacity(text), model[field])) return text
    return typeof model[field] === 'number' && !Number.isNaN(model[field]) ? formatCapacity(model[field]) : ''
  }
  const editCapacity = (index, field, text) => {
    setBuffers(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }
  const removeRow = (index) => {
    keys.current = keys.current.filter((_, at) => at !== index)
    emit(rows.filter((_, at) => at !== index))
  }
  const addRow = () => {
    const key = nextKey()
    keys.current = [...keys.current, key]
    setExpanded(current => new Set([...current, key]))
    emit([...rows, newRow?.() ?? { id: '' }])
  }
  /** 移动一行：键跟着行走，展开状态和写到一半的容量文字按键记，也跟着走。 */
  const move = (from, to) => {
    const next = moveModel(rows, from, to)
    if (next.every((row, at) => row === rows[at])) return
    keys.current = moveModel(keys.current, from, to)
    emit(next)
  }

  const fetchModels = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      const answer = await discover()
      if (answer.kind === 'refused') { setFailure(answer.text); return }
      if (answer.candidates.length === 0) { setFailure(app.t('fetchEmpty')); return }
      setPicker({ candidates: answer.candidates, source: answer.source, query: '', tab: defaultModelPickerTab(modelPickerEntries(answer.candidates, pickerRows)) })
    } finally {
      setBusy(false)
    }
  }
  // 选择器里「已添加」也算上目录外的模型（伴随条目里的）；要走伴随条目的行交给 onAddCompanion。
  const pickerRows = [...rows, ...extraRows]
  const addPicked = (entries) => {
    const usable = entries.filter(entry => entry.candidate?.blocked !== true)
    const companions = usable.filter(entry => entry.candidate?.companionApi !== undefined)
    if (companions.length > 0) onAddCompanion?.(companions)
    const own = usable.filter(entry => entry.candidate?.companionApi === undefined)
    if (own.length > 0) emit(addPickedModels(rows, own, family))
  }
  const removeById = (id) => {
    const index = rows.findIndex(row => row.id === id)
    if (index >= 0) removeRow(index)
    else onRemoveExtra?.(id)
  }
  const removePicked = (ids) => {
    setBuffers(new Map())
    setExpanded(new Set())
    // 只有确实要删这份目录里的行时才改它：只选中目录外的模型时调 onChange 会把继承的目录整份写进用户层（不再跟随安装包）。
    const own = new Set([...ids].filter(id => rows.some(row => row.id === id)))
    if (own.size > 0) {
      keys.current = keys.current.filter((_, at) => !own.has(rows[at]?.id))
      emit(removeModelsById(rows, own))
    }
    for (const id of ids) if (!rows.some(row => row.id === id)) onRemoveExtra?.(id)
  }

  const menuItems = (index) => {
    const model = rows[index]
    const items = []
    if (onSetDefault !== undefined) {
      const saved = typeof model.id === 'string' && savedIds?.has(model.id) === true
      const pending = saved ? defaultPendingFor?.(model) : undefined
      items.push({
        id: 'default', label: pending !== undefined ? app.t(pending) : saved ? app.t('setDefault') : app.t('setDefaultNeedsSave'),
        disabled: disabled || !saved || pending !== undefined || isDefaultModel(model),
      }, { type: 'separator', id: 'sep-default' })
    }
    items.push(
      { id: 'first', label: app.t('moveFirst'), disabled: disabled || index === 0 },
      { id: 'last', label: app.t('moveLast'), disabled: disabled || index === rows.length - 1 },
      { type: 'separator', id: 'sep-remove' },
      { id: 'remove', label: app.t('removeModel'), danger: true, disabled },
    )
    return items
  }
  const selectMenu = (id) => {
    const index = menu?.index
    setMenu(undefined)
    if (index === undefined) return
    if (id === 'default') onSetDefault?.(rows[index].id, rows[index])
    else if (id === 'first') move(index, 0)
    else if (id === 'last') move(index, rows.length - 1)
    else if (id === 'remove') removeRow(index)
  }
  /** 右键一行，或聚焦后按菜单键、Shift+F10，都打开这一行的菜单。 */
  const rowMenuProps = index => ({
    onContextMenu: (event) => {
      event.preventDefault()
      setMenu({ index, x: event.clientX, y: event.clientY })
    },
    onKeyDown: (event) => {
      if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect?.()
      setMenu({ index, x: rect?.left ?? 0, y: rect?.bottom ?? 0 })
    },
  })
  /** 拖动把手：一直看得见；拖动或聚焦后用上下方向键移动。 */
  const handle = (index, idText) => h('button', {
    type: 'button', className: 'dms-iconbtn dms-handle', draggable: !disabled, disabled,
    'aria-label': `${app.t('reorderModel')} ${idText}`, 'aria-description': app.t('reorderModelHelp'), 'aria-keyshortcuts': 'ArrowUp ArrowDown',
    onDragStart: (event) => {
      event.dataTransfer?.setData?.('application/x-dms-model-order', String(index))
      if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
      setDrag({ from: index })
      // 拖起来的是整行（把手所在的那一行），不是把手这个小按钮。
      preview.start(event, event.currentTarget?.closest?.('[data-row-key]') ?? undefined)
    },
    onDragEnd: () => {
      preview.clear()
      setDrag(undefined)
    },
    onKeyDown: (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      event.stopPropagation()
      move(index, index + (event.key === 'ArrowUp' ? -1 : 1))
    },
  }, h(ui.IconDragHandleOutlineRegular, { size: 14 }))
  const dropProps = index => ({
    onDragOver: (event) => {
      if (drag === undefined) return
      event.preventDefault()
      if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect?.()
      const half = rect === undefined || event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      if (drag.over !== index || drag.half !== half) setDrag({ ...drag, over: index, half })
    },
    onDrop: (event) => {
      if (drag === undefined) return
      event.preventDefault()
      const half = drag.over === index ? drag.half : 'before'
      const target = half === 'before' ? index : index + 1
      move(drag.from, drag.from < target ? target - 1 : target)
      setDrag(undefined)
    },
    // 指针离开这一行（不是进到它里面的元素）时收起插入线，拖出列表外也不会留着。
    onDragLeave: (event) => {
      if (drag === undefined || drag.over !== index) return
      const next = event.relatedTarget
      if (next != null && typeof event.currentTarget?.contains === 'function' && event.currentTarget.contains(next)) return
      setDrag({ from: drag.from })
    },
    'data-drop': drag !== undefined && drag.over === index && drag.from !== index ? drag.half : undefined,
    'data-dragging': drag?.from === index ? 'true' : undefined,
  })

  const typeLabel = type => type === 'image' ? app.t('inputImage') : type === 'text' ? app.t('inputText') : type
  const sourceText = inherited ? app.t('modelsInherited') : overridePending ? app.t('modelsCustomizedPending') : app.t('modelsCustomized')
  return h(Fragment, null,
    heading !== undefined ? h('div', { className: 'dms-sec' }, h('span', null, heading, ' ', h('span', { className: 'dms-meta' }, headingMeta ?? '')))
      : title ? h('div', { className: 'dms-sec' }, h('span', null, app.t('models'), ' ',
        h('span', { className: 'dms-meta' }, [app.t('modelsCount', { count: rows.length }), ...showSource ? [sourceText] : []].join(' · ')))) : null,
    rows.length === 0 && !inherited && showSource ? h('p', { className: 'dms-hint' }, app.t('modelsEmpty')) : null,
    // 外面这层给 AnimatedRows 退场动画的浮层定位（它要求父元素是定位元素）。
    rows.length === 0 ? null : h('div', { className: 'dms-models-wrap' }, h(RowsList, {
      className: 'dms-models', rowKeys: keys.current, ready: true, resetKey: '',
    }, rows.map((model, index) => {
      const types = inputTypesOf(model, family, inputDefaults?.get(model.id))
      const reasons = reasoningIds?.has(model.id) === true || readEfforts(model) !== undefined
      const reasoning = reasoningFor(model)
      const open = expanded.has(keys.current[index])
      const rowFailure = failureOfRows?.index === index ? app.t(failureOfRows.key) : undefined
      const rowKey = keys.current[index]
      const idBase = `dms-model-${index}`
      const idText = typeof model.id === 'string' && model.id.length > 0 ? model.id : app.t('modelId')
      const incomplete = modelDataIncomplete(model, catalogIds)
      const isDefault = isDefaultModel(model)
      if (!open) {
        return h('div', { key: rowKey, 'data-row-key': rowKey, className: 'dms-mrow', ...rowMenuProps(index), ...dropProps(index) },
          handle(index, idText),
          h('button', { type: 'button', className: 'dms-model', onClick: () => toggle(index), 'aria-expanded': 'false' },
            h('span', { className: 'dms-main' },
              h('span', { className: 'dms-idline' }, h('span', { className: 'dms-mono' }, idText),
                isDefault ? h('span', { className: 'dms-tag' }, app.t('defaultModel')) : null),
              protocolOptions !== undefined
                ? h('span', { className: 'dms-meta' }, [typeof model.name === 'string' && model.name !== model.id ? model.name : undefined, protocolLabel(app, model.__api)].filter(Boolean).join(' · '))
                : typeof model.name === 'string' && model.name !== model.id ? h('span', { className: 'dms-meta' }, model.name) : null,
              rowFailure === undefined ? null : h('span', { className: 'dms-note dms-err' }, rowFailure)),
            h('span', { className: 'dms-caps' }, types.map(type => h('span', { key: type, className: 'dms-tag' }, typeLabel(type))),
              reasons ? h('span', { className: 'dms-tag' }, app.t('capReasoning')) : null,
              incomplete ? h('span', { className: 'dms-tag' }, app.t('dataIncomplete')) : null),
            h(Chevron)),
          h('button', { type: 'button', className: 'dms-iconbtn', disabled, 'aria-label': `${app.t('removeModel')} ${idText}`, title: app.t('removeModel'), onClick: () => removeRow(index) },
            h(ui.IconCloseOutlineRegular, { size: 14 })))
      }
      return h('div', { key: rowKey, 'data-row-key': rowKey, className: 'dms-module', ...rowMenuProps(index), ...dropProps(index) },
        h('div', { className: 'dms-mtop' },
          handle(index, idText),
          h('button', { type: 'button', className: 'dms-mhead', onClick: () => toggle(index), 'aria-expanded': 'true' },
            h('span', { className: 'dms-idline' }, h('span', { className: 'dms-mono' }, idText),
              isDefault ? h('span', { className: 'dms-tag' }, app.t('defaultModel')) : null,
              incomplete ? h('span', { className: 'dms-tag' }, app.t('dataIncomplete')) : null),
            h(ui.IconChevronDownOutlineRegular, { size: 16, className: 'dms-chev' }))),
        // 目录外的模型：协议是按同类模型推出来的，这里看得见、能改；改了保存时就搬到那种协议的条目里。
        // 用下拉不用分段控件：四种协议名排成一行会把设置页撑宽（隔离 DSH 里 1100 宽时已经超出）。
        protocolOptions === undefined ? null : h('div', { className: 'dms-field' }, h('label', { className: 'dms-label', htmlFor: `${idBase}-api` }, app.t('protocol')),
          h('select', {
            id: `${idBase}-api`, className: 'dms-select dms-select-wide', value: model.__api, disabled, 'aria-label': `${app.t('protocol')} ${idText}`,
            onChange: event => replace(index, { ...model, __api: event.target.value }),
          }, [...protocolOptions].sort().map((api) => {
            // 这种协议的路由被别的条目占着：不可选，写明被谁占着（protocolBlocked 给出文字）。
            const blocked = api === model.__api ? undefined : protocolBlocked?.(api)
            return h('option', { key: api, value: api, disabled: blocked !== undefined }, blocked ?? protocolLabel(app, api))
          }))),
        h('div', { className: 'dms-grid2' },
          h(Field, { id: `${idBase}-name`, label: app.t('modelName') },
            h(TextInput, { id: `${idBase}-name`, value: typeof model.name === 'string' ? model.name : '', placeholder: app.t('modelNamePlaceholder'), disabled, onChange: text => patch(index, { name: text }) })),
          h(Field, { id: `${idBase}-id`, label: app.t('modelId') },
            h(TextInput, { id: `${idBase}-id`, mono: true, value: typeof model.id === 'string' ? model.id : '', disabled, invalid: rowFailure !== undefined && failureOfRows.key.startsWith('modelId'), onChange: text => replace(index, { ...model, id: text }) })),
          CAPACITY_FIELDS.map(field => h(Field, { key: field, id: `${idBase}-${field}`, label: app.t(field) },
            h(TextInput, { id: `${idBase}-${field}`, value: capacityText(model, index, field), placeholder: app.t('capacityPlaceholder'), disabled,
              invalid: Number.isNaN(model[field]), onChange: text => editCapacity(index, field, text) })))),
        h('div', { className: 'dms-field' },
          h('div', { className: 'dms-spread' },
            h('div', { className: 'dms-label' }, app.t('inputTypes')),
            h('button', { type: 'button', className: 'dms-danger', style: { fontSize: '12px' }, disabled, onClick: () => removeRow(index) }, app.t('removeModel'))),
          h('div', { className: 'dms-row' }, ['text', 'image'].map(type => h(ui.Checkbox, {
            key: type, label: typeLabel(type), checked: types.includes(type), disabled: disabled || (types.length === 1 && types.includes(type)),
            onChange: checked => replace(index, withInputTypes(model, family, checked ? [...new Set([...types, type])] : types.filter(item => item !== type))),
          })))),
        reasoning.levels.length > 0
          ? h(ReasoningEditor, { app, model, levels: reasoning.levels, levelsOnly: reasoning.levelsOnly, disabled, idBase, onChange: next => replace(index, next) })
          : null,
        // 推理等级只收某几档（Gemini API）的错，推理等级编辑里已经写了一遍，这里不再重复。
        rowFailure === undefined || (failureOfRows.key === 'modelReasoningLevelsOnly' && reasoning.levels.length > 0) ? null
          : h('p', { className: 'dms-note dms-err', role: 'alert' }, rowFailure))
    }))),
    menu === undefined ? null : h(ui.Menu, {
      open: true, anchor: null, anchorPoint: { x: menu.x, y: menu.y }, portal: true, autoFocus: true, contextual: true,
      'aria-label': app.t('rowMenu', { model: rows[menu.index]?.id ?? '' }),
      items: menuItems(menu.index), onSelect: selectMenu, onClose: () => setMenu(undefined),
    }),
    picker === undefined ? null : h(ModelPicker, {
      app, picker, setPicker, rows: pickerRows, disabled, onClose: () => setPicker(undefined),
      onAdd: entry => addPicked([entry]), onAddAll: addPicked, onRemove: removeById,
      onRemoveAll: entries => removePicked(new Set(entries.filter(entry => entry.added).map(entry => entry.id))),
    }),
    h('div', { className: 'dms-row' },
      hideAdd ? null : h(ui.Button, { variant: 'outline', size: 'sm', disabled, onClick: addRow }, app.t('addModel')),
      discover === undefined ? null : h(ui.Button, { variant: 'outline', size: 'sm', disabled: disabled || busy || discoverBlocked !== undefined, onClick: () => { void fetchModels() } }, busy ? app.t('fetching') : app.t('fetchModels')),
      inherited || onReset === undefined ? null : h(ui.Button, { variant: 'ghost', size: 'sm', disabled, onClick: onReset }, app.t('resetModels'))),
    discoverBlocked === undefined || discoverBlocked === '' ? null : h('p', { className: 'dms-hint' }, discoverBlocked),
    failure === undefined ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, failure))
}

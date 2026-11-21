/** 几个页面共用的小部件、取数和 schema 读取。 */

/**
 * 订阅页面数据。
 * @param {object} app 插件的共享对象。
 * @returns {object} 当前快照。
 */
function useSnapshot(app) {
  return useSyncExternalStore(app.store.subscribe, app.store.getSnapshot)
}

/**
 * 切换语言或词典晚到时重新渲染。
 * @param {object} app 插件的共享对象。
 */
function useLocaleRevision(app) {
  const locale = app.ctx.locale
  useSyncExternalStore(useCallback(listener => locale.subscribe(listener), [locale]), () => locale.getSnapshot().revision)
}

/** 列表行右侧的箭头，用 DSH 自己的图标。 */
function Chevron() {
  return h(ui.IconChevronRightOutlineRegular, { size: 16, className: 'dms-chev' })
}

/** 图标：首字母加品牌色。 */
function Icon({ meta, size }) {
  return h('span', { className: `dms-ico${size === undefined ? '' : ` dms-${size}`}`, style: { '--dms-c': meta.color }, 'aria-hidden': 'true' }, meta.initials)
}

/**
 * 一行在界面上的名字、标签、域名和图标。
 * @param {object} row 拼好的行。
 * @returns {object} routeMeta 的结果。
 */
function metaOf(row) {
  return routeMeta(row.entry.provider, row.entry)
}

/**
 * 检查失败的原因写成一句话。
 * @param {object} app 插件的共享对象。
 * @param {object} check 检查结果。
 * @param {object} meta 这一家的显示信息。
 * @param {boolean} short 列表上用短句。
 * @returns {string} 原因。
 */
function reasonText(app, check, meta, short) {
  const reason = ['auth', 'forbidden', 'rate', 'notFound', 'network', 'timeout', 'noModel'].includes(check.reason) ? check.reason : 'other'
  // 列表和头部只有一行：别的错误只写 HTTP 状态码，原文留给详情页的检查结果那一行。
  const message = short && reason === 'other'
    ? check.status !== undefined ? `HTTP ${check.status}` : (check.message ?? '').slice(0, 60)
    : check.message ?? ''
  return app.t(`${short ? 'short' : 'reason'}${reason}`, {
    status: check.status ?? 401, host: meta.domain ?? meta.name, seconds: check.seconds ?? 20, message,
  })
}

/**
 * 一行的状态：颜色和文字。
 * @param {object} app 插件的共享对象。
 * @param {object} snapshot 页面快照。
 * @param {object} row 拼好的行。
 * @returns {{ tone: string, text: string }} 状态。
 */
function statusOf(app, snapshot, row) {
  const check = snapshot.checks.get(row.entry.provider)
  const facts = catalogFactsOf(row.entry.provider, snapshot.catalog)
  const status = rowStatus(row, { check, catalogFailure: facts.failure })
  const text = status.key === 'statusCheckFailed'
    ? app.t('statusCheckFailed', { reason: reasonText(app, check, metaOf(row), true) })
    : app.t(status.key, status.vars)
  return { key: status.key, tone: status.tone, text }
}

function State({ status }) {
  return h('span', { className: 'dms-state', 'data-tone': status.tone }, status.text)
}

/** 详情页和填写页顶上的一行：图标、名字和标签、域名，下面可以再接一行状态。 */
function HeadRow({ meta, name, tags, domain, children }) {
  return h('div', { className: 'dms-row', style: { flexWrap: 'nowrap', alignItems: 'flex-start', minWidth: 0 } },
    h(Icon, { meta, size: 'lg' }),
    h('div', { className: 'dms-main' },
      h('h2', { className: 'dms-title dms-name', style: { fontSize: '16px' } }, name, tags.map(tag => h('span', { key: tag, className: 'dms-tag' }, tag))),
      domain === undefined ? null : h('span', { className: 'dms-meta' }, domain),
      children))
}

function Crumb({ label, onClick }) {
  return h('button', { type: 'button', className: 'dms-crumb', onClick }, h(ui.IconChevronLeftOutlineRegular, { size: 14 }), label)
}

/** 带标签、错误和说明的一块输入。 */
function Field({ id, label, extra, error, hint, children }) {
  return h('div', { className: 'dms-field' },
    h('div', { className: 'dms-label' }, h('label', { htmlFor: id }, label), extra ?? null),
    children,
    error ? h('p', { className: 'dms-note dms-err', role: 'alert' }, error) : null,
    hint ? h('p', { className: 'dms-hint' }, hint) : null)
}

function TextInput({ id, value, onChange, placeholder, invalid, disabled, mono, autoFocus, onKeyDown, inputRef, label }) {
  return h('input', {
    id, ref: inputRef, className: `dms-input${mono ? ' dms-mono' : ''}`, value, placeholder, disabled, autoFocus, onKeyDown,
    spellCheck: false, autoComplete: 'off', 'aria-invalid': invalid ? 'true' : undefined, 'aria-label': label,
    onChange: event => onChange(event.target.value),
  })
}

/** 外部链接，例如控制台的「获取 API 密钥」。 */
function ExternalLink({ href, children }) {
  return h('a', { className: 'dms-link', href, target: '_blank', rel: 'noreferrer noopener' }, children, h(ui.IconRightUpOutlineRegular, { size: 12 }))
}

/**
 * 按 DSH 的界面语言写时间。
 * @param {object} app 插件的共享对象。
 * @param {number} at 毫秒时间戳。
 * @returns {string} 例如 03:40。
 */
function formatClock(app, at) {
  const active = app.ctx.locale.getSnapshot().active
  return new Date(at).toLocaleTimeString(active === 'zh' ? 'zh-CN' : active, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * 详情页密钥框的状态：已配置、已检测到环境变量或未配置。
 * @param {object} row 拼好的行。
 * @returns {{ state: 'configured' | 'env' | 'unset', envName?: string }} 状态。
 */
function keyStateOf(row) {
  const info = row.apiKeyEnv !== undefined ? row.credential : row.derivedCredential
  if (info?.configured === true) return info.source === 'env' ? { state: 'env', envName: keyRefOf(row) } : { state: 'configured' }
  if (row.apiKeyEnv === undefined) {
    const detected = Object.entries(row.credentialChecks ?? {}).find(([, check]) => check.configured)
    if (detected !== undefined) return { state: 'env', envName: detected[0] }
  }
  return { state: 'unset' }
}

/**
 * 这一家要不要 API 密钥：配置里点名了凭据，或者目录说它读环境变量里的 key。
 * @param {object} row 拼好的行。
 * @returns {boolean} 需要时为 true。
 */
function needsKey(row) {
  return row.apiKeyEnv !== undefined || row.entry.declared === true || (row.entry.nativeAuth?.env ?? []).length > 0
}

/**
 * 在用同一个凭据名的提供商，写成列表上看得到的名字：一家写它的名字，几家写第一家加「等 N 个提供商」。
 * 伴随条目在列表上并进了原提供商，算成原提供商（用户看得到的那张卡片）。
 * @param {object} app 插件的共享对象。
 * @param {object} snapshot 页面快照。
 * @param {readonly string[]} users 使用它的路由标识符（credentialUsers 或 credentialNamedBy 的结果），至少一个。
 * @returns {string} 名字。
 */
function sharersLabel(app, snapshot, users) {
  const names = [...new Set(users.map((user) => {
    const named = snapshot.rows.find(candidate => candidate.entry.provider === user)
    const row = named?.companionOf === undefined ? named : snapshot.rows.find(candidate => candidate.entry.provider === named.companionOf.origin) ?? named
    return row === undefined ? user : metaOf(row).name
  }))]
  return names.length === 1 ? names[0] : spaced(app.t('keySharers', { provider: names[0], count: names.length, more: names.length - 1 }))
}

/**
 * 凭据名已被别的提供商使用时的说明；没有别人使用时 undefined。
 * @param {object} app 插件的共享对象。
 * @param {object} snapshot 页面快照。
 * @param {string} ref 凭据名。
 * @param {readonly string[]} users 使用它的路由标识符（credentialUsers 或 credentialNamedBy 的结果）。
 * @param {'keyRefTakenSave' | 'keyTakenNoClear'} key 哪一句：不能改凭据名的命名空间存密钥前用 keyRefTakenSave，别人也在用时不让清除用 keyTakenNoClear。
 * @returns {string | undefined} 说明。
 */
function keyRefTakenText(app, snapshot, ref, users, key) {
  if (users.length === 0) return undefined
  return spaced(app.t(key, { ref, provider: sharersLabel(app, snapshot, users) }))
}

/**
 * 中文和英文、数字之间留一个空格（DESIGN.md 的排版规矩）。提供商的名字可能是中文也可能是英文，
 * 所以带名字的句子在占位符两边不写空格，填好名字以后再按两边的字补。
 * @param {string} text 填好占位符的句子。
 * @returns {string} 补好空格的句子。
 */
function spaced(text) {
  return text.replace(/(\p{Script=Han})([A-Za-z0-9])/gu, '$1 $2').replace(/([A-Za-z0-9])(\p{Script=Han})/gu, '$1 $2')
}

/**
 * 两选一，照 DSH 的 role="radio" 按钮（dsh-client-ui-settings-account 的 OnboardingProcessStep）：整行可点，
 * 上下左右方向键换选项；还没选时 Tab 落在第一项。说明只在传了 note 的选项下出现，读屏软件把它当描述、不并进名字。
 * detail（比如密钥框）紧跟在选中的那一项下面，不放在整组最后，免得看着像属于别的选项。
 * @param {{ id: string, label: string, describedBy?: string, value: string | undefined, options: { value: string, label: string, note?: string }[], detail?: object, disabled?: boolean, onChange: (value: string) => void }} props
 *   id 用来拼各项名字和说明的 id；label 是整组的无障碍名称；describedBy 指向整组的冲突说明；value 是选中的那一项，undefined 时都没选。
 * @returns {object} React 元素。
 */
function KeyChoice({ id, label, describedBy, value, options, detail, disabled = false, onChange }) {
  const buttons = useRef([])
  const step = (index, delta) => {
    if (disabled) return
    const next = (index + delta + options.length) % options.length
    onChange(options[next].value)
    buttons.current[next]?.focus()
  }
  return h('div', { className: 'dms-opts', role: 'radiogroup', 'aria-label': label, 'aria-describedby': describedBy, 'aria-disabled': disabled ? 'true' : undefined },
    options.flatMap((option, index) => [
      h('button', {
        key: option.value, type: 'button', role: 'radio', className: 'dms-opt', disabled,
        ref: (element) => { buttons.current[index] = element },
        'aria-checked': value === option.value ? 'true' : 'false',
        'aria-labelledby': `${id}-${option.value}`, ...option.note === undefined ? {} : { 'aria-describedby': `${id}-${option.value}-note` },
        tabIndex: value === option.value || (value === undefined && index === 0) ? 0 : -1,
        onClick: () => { if (!disabled && option.value !== value) onChange(option.value) },
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); step(index, 1) }
          else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); step(index, -1) }
        },
      },
      h('span', { className: 'dms-radio', 'aria-hidden': 'true' }),
      h('span', { className: 'dms-opt-main' },
        h('span', { id: `${id}-${option.value}` }, option.label),
        option.note === undefined ? null : h('span', { className: 'dms-opt-note', id: `${id}-${option.value}-note` }, option.note))),
      value === option.value && detail !== undefined && detail !== null ? h('div', { key: `${option.value}-detail`, className: 'dms-under' }, detail) : null,
    ]))
}

/**
 * 「共用」时那一行说明：对方已经存了密钥就写用的是哪一把，没存就说填了两边都用。
 * @param {object} app 插件的共享对象。
 * @param {{ configured?: boolean, source?: string, masked?: string } | undefined} info 凭据名在凭据库里的状态（credentialInfoOf）。
 * @param {string} ref 共用的凭据名。
 * @param {string} provider 对方的名字（sharersLabel）。
 * @returns {{ note: string, needsKey: boolean }} 说明，以及这时还要不要填密钥。
 */
function shareNoteOf(app, info, ref, provider) {
  if (info?.configured !== true) return { note: spaced(app.t('keyShareUnsaved', { provider })), needsKey: true }
  if (info.source !== 'file') return { note: spaced(app.t('keyShareEnv', { ref, provider })), needsKey: false }
  return { note: spaced(info.masked ? app.t('keyShareSaved', { provider, masked: info.masked }) : app.t('keyShareSavedPlain', { provider })), needsKey: false }
}

/**
 * 顺次用 `credentials.describe` 跳过凭据库/环境里已经存在的名字（没人引用的旧凭据或环境变量，feat#174）。
 * 每批最多查 16 个候选（远低于服务端 64 的单批上限），找到第一个 `configured !== true` 的即停；查询失败时回退到只按当前行躲开的名字。
 * @param {(refs: string[]) => Promise<{ ok: boolean, value?: Record<string, { configured?: boolean }> }>} describeCredentials 查询接口。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 被占用的凭据名。
 * @returns {Promise<string>} 可用的新凭据名。
 */
async function probeSeparateKeyRef(describeCredentials, rows, ref) {
  const taken = []
  for (let batch = 0; batch < 16; batch += 1) {
    const candidates = []
    for (let index = 0; index < 16; index += 1) candidates.push(separateKeyRef(rows, ref, [...taken, ...candidates]))
    const answer = await describeCredentials(candidates)
    if (!answer?.ok) return separateKeyRef(rows, ref, taken)
    for (const candidate of candidates) {
      if (answer.value?.[candidate]?.configured !== true) return candidate
      taken.push(candidate)
    }
  }
  return separateKeyRef(rows, ref, taken)
}

/**
 * 为「单独存一把 / 只替换这一家」算新凭据名；有冲突且注入了 `describeCredentials` 时顺便查凭据库躲开未引用的旧凭据（feat#174）。
 * @param {object} app 插件的共享对象。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 原凭据名。
 * @param {boolean} active 当前是否存在凭据名冲突。
 * @param {string | undefined} fixed 已写进配置的凭据名（不再变动、不重查）。
 * @returns {{ ref: string, pending: boolean }} 新凭据名，以及是否还在等 `describeCredentials` 返回。
 */
function useSeparateKeyRef(app, rows, ref, active, fixed) {
  const fallback = separateKeyRef(rows, ref)
  const describe = app.ops?.describeCredentials
  const [resolved, setResolved] = useState(undefined)
  useEffect(() => {
    if (!active || fixed !== undefined || describe === undefined) return undefined
    let live = true
    void probeSeparateKeyRef(describe, rows, ref).then((next) => {
      if (live) setResolved({ ref, rows, value: next })
    })
    return () => { live = false }
  }, [active, fixed, ref, rows, describe])
  if (fixed !== undefined) return { ref: fixed, pending: false }
  if (!active || describe === undefined) return { ref: fallback, pending: false }
  if (resolved !== undefined && resolved.ref === ref && resolved.rows === rows) return { ref: resolved.value, pending: false }
  return { ref: fallback, pending: true }
}

/**
 * 添加提供商时凭据名被别的提供商用着：两个选项、选了以后存到哪个凭据名、选项下面要不要出密钥框（feat#174）。
 * 说明只写在选中的那一项下面。
 * @param {object} app 插件的共享对象。
 * @param {object} snapshot 页面快照。
 * @param {string} ref 这一家按规则会用的凭据名。
 * @param {readonly string[]} users 已经在用它的提供商（至少一个）。
 * @param {'share' | 'separate' | undefined} share 选了哪一项。
 * @param {string | undefined} [fixedSeparate] 已经写进配置的单独凭据名；写好配置后快照重读，再算会往上加，所以沿用它。
 * @returns {{ provider: string, options: object[], target: string | undefined, showKey: boolean, keyRequired: boolean }}
 *   provider 是对方的名字；target 没选时 undefined；showKey 表示要出密钥框，keyRequired 表示这个框必须填。
 */
function shareChoiceOf(app, snapshot, ref, users, share, fixedSeparate) {
  const provider = sharersLabel(app, snapshot, users)
  const shared = shareNoteOf(app, credentialInfoOf(snapshot.rows, ref), ref, provider)
  const separate = fixedSeparate ?? separateKeyRef(snapshot.rows, ref)
  return {
    provider,
    options: [
      { value: 'share', label: spaced(app.t('keyShareOption', { provider })), ...share === 'share' ? { note: shared.note } : {} },
      { value: 'separate', label: app.t('keySeparateOption'), ...share === 'separate' ? { note: spaced(app.t('keySeparateNote', { ref: separate, provider })) } : {} },
    ],
    target: share === 'share' ? ref : share === 'separate' ? separate : undefined,
    showKey: share === 'separate' || (share === 'share' && shared.needsKey),
    keyRequired: share === 'separate',
  }
}

/** 任何 dict 路由键都走到同一个配置节点，这个键不会和真的路由撞上。 */
const PROBE_ROUTE = '\u0000probe'

/**
 * 手工声明的路由能用的 API 协议，从 pi-ai 命名空间自己的 schema 读，和适配器接受的保持一致。
 * @param {object} schema 设置 schema 操作。
 * @param {object | undefined} namespace pi-ai 命名空间。
 * @returns {string[]} 协议标识符。
 */
function protocolChoicesOf(schema, namespace) {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  if (node?.type !== 'union' || node.list === undefined) return []
  return node.list.map(entry => entry.value).filter(value => typeof value === 'string')
}

/**
 * 手工声明的路由的模型能声明的推理档位，同样从 schema 读。
 * @param {object} schema 设置 schema 操作。
 * @param {object | undefined} namespace pi-ai 命名空间。
 * @returns {string[]} 档位，按升级顺序。
 */
function reasoningLevelsOf(schema, namespace) {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'models', '0', 'reasoningEfforts'])
  const keys = (node?.list ?? []).find(branch => branch.type === 'dict')?.sKey
  return (keys?.list ?? []).map(entry => entry.value).filter(value => typeof value === 'string')
}

/**
 * 协议的产品名。
 * @param {object} app 插件的共享对象。
 * @param {string} api 协议标识符。
 * @returns {string} 产品名；没起名的协议显示标识符。
 */
function protocolLabel(app, api) {
  const key = `protocol.${api}`
  const text = app.t(key)
  return text === key ? api : text
}

/**
 * 自动判断协议：地址的路径里有 anthropic 就先按 Anthropic Messages，否则按 OpenAI Chat Completions。
 * @param {string} baseURL API 地址。
 * @param {readonly string[]} choices 可用的协议。
 * @returns {string} 协议标识符。
 */
function guessProtocol(baseURL, choices) {
  const anthropic = /anthropic/i.test(baseURL) && choices.includes('anthropic-messages')
  if (anthropic) return 'anthropic-messages'
  return choices.includes('openai-completions') ? 'openai-completions' : choices[0] ?? 'openai-completions'
}

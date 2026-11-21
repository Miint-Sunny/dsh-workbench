/** 重试策略的编辑区，结构、选项和文案照 DSH 0.2.2-rc.2 官方 RetryPolicyEditor.tsx（MIT，见 NOTICE）。字段从 schema 读；没填的字段灰字显示默认值。 */

/** 字段名到文案键。 */
const RETRY_LABELS = {
  normal: 'retryModeNormal', always: 'retryModeAlways', maxRetries: 'retryMaxRetries', retryableCodes: 'retryCodes',
  backoff: 'retryBackoff', initialDelayMs: 'retryInitialDelay', maxDelayMs: 'retryMaxDelay', jitterRatio: 'retryJitter',
}

/** 内置错误码到文案键；不认识的错误码照原样显示。 */
const RETRY_CODE_LABELS = {
  EMPTY_RESPONSE: 'retryCodeEmptyResponse', RATE_LIMIT: 'retryCodeRateLimit', SERVER: 'retryCodeServer', TIMEOUT: 'retryCodeTimeout',
  TRANSPORT: 'retryCodeTransport', STREAM_CLOSED: 'retryCodeStreamClosed', MALFORMED_RESPONSE: 'retryCodeMalformedResponse', QUOTA: 'retryCodeQuota',
}

const textOfValue = value => (typeof value === 'number' || typeof value === 'string' ? String(value) : '')

/**
 * @param {object} props
 * @param {object} props.app 插件的共享对象。
 * @param {string} props.idBase 输入框 id 前缀。
 * @param {unknown} props.policy 草稿里的 `retryPolicy`。
 * @param {ReturnType<typeof retryPolicyDefaults>} props.defaults 默认值。
 * @param {{ message: string, path?: string[] } | undefined} props.failure 校验结果。
 * @param {boolean} props.disabled 禁用。
 * @param {(next: Record<string, unknown> | undefined) => void} props.onChange 改策略；undefined 表示用默认。
 */
function RetryPolicyEditor({ app, idBase, policy, defaults, failure, disabled, onChange }) {
  const current = typeof policy === 'object' && policy !== null && !Array.isArray(policy) ? policy : {}
  const branch = defaults.branch(current.mode)
  const mode = branch === undefined ? undefined : String(current.mode)
  // 输入时保留原文，`0.` 这种写到一半的值也看得见。
  const [texts, setTexts] = useState({})
  const [added, setAdded] = useState({})
  const [openFolds, setOpenFolds] = useState(() => new Set(Object.keys(current).filter(key => typeof current[key] === 'object' && current[key] !== null && !Array.isArray(current[key]))))
  const label = key => (RETRY_LABELS[key] === undefined ? key : app.t(RETRY_LABELS[key]))
  const invalidAt = path => failure?.path?.join('.') === path.join('.')
  const read = path => path.reduce((at, key) => (typeof at === 'object' && at !== null ? at[key] : undefined), current)

  const numberField = (root, path, node) => {
    const id = `${idBase}-${path.join('-')}`
    const key = path.join('.')
    return h('div', { key, className: 'dms-field' },
      h('label', { className: 'dms-label', htmlFor: id }, label(path.at(-1))),
      h('input', {
        id, className: 'dms-input', type: 'text', inputMode: node.meta?.step === 1 ? 'numeric' : 'decimal', disabled,
        value: texts[key] ?? textOfValue(read(path)), placeholder: textOfValue(defaults.value(root, path)), 'aria-invalid': invalidAt(path) ? 'true' : undefined,
        onChange: (event) => {
          const raw = event.target.value
          const trimmed = raw.trim()
          setTexts(previous => ({ ...previous, [key]: trimmed.length === 0 ? '' : raw }))
          const value = DECIMAL.test(trimmed) ? Number(trimmed) : trimmed
          onChange(withRetryField(current, path, value === '' ? undefined : value))
        },
      }))
  }

  const codesField = (root, path, node) => {
    const key = path.join('.')
    const strings = value => (Array.isArray(value) ? value.filter(code => typeof code === 'string') : [])
    const inherited = strings(defaults.value(root, path))
    const stored = read(path)
    const selected = Array.isArray(stored) ? strings(stored) : inherited
    // 这次加的自定义错误码取消勾选后仍留在列表里。
    const choices = [...new Set([...retryCodeChoices(node), ...inherited, ...selected, ...added[key] ?? []])]
    const select = (next) => {
      // 勾选的正好是继承的那几个时，保持继承，不写配置。
      const inherits = next.length === inherited.length && next.every(code => inherited.includes(code))
      onChange(withRetryField(current, path, inherits ? undefined : [...next]))
    }
    const draftCode = (texts[key] ?? '').trim()
    const add = () => {
      if (draftCode.length === 0) return
      setAdded(previous => ({ ...previous, [key]: [...new Set([...previous[key] ?? [], draftCode])] }))
      setTexts(previous => ({ ...previous, [key]: '' }))
      if (!selected.includes(draftCode)) select([...selected, draftCode])
    }
    return h('div', { key, className: 'dms-field', role: 'group', 'aria-label': label(path.at(-1)) },
      h('div', { className: 'dms-label' }, label(path.at(-1))),
      h('div', { className: 'dms-codes' }, choices.map(code => h(ui.Checkbox, {
        key: code, label: RETRY_CODE_LABELS[code] === undefined ? code : app.t(RETRY_CODE_LABELS[code]), checked: selected.includes(code),
        // 最后一个勾选的不能取消：DSH 要求至少一个错误码。
        disabled: disabled || (selected.length === 1 && selected.includes(code)),
        onChange: checked => select(choices.filter(value => (value === code ? checked : selected.includes(value)))),
      }))),
      h('div', { className: 'dms-row' },
        h('div', { style: { flex: '1 1 200px', minWidth: 0 } }, h(TextInput, {
          id: `${idBase}-code`, value: texts[key] ?? '', placeholder: app.t('retryCodeCustom'), label: app.t('retryCodeCustom'), disabled, mono: true,
          onChange: value => setTexts(previous => ({ ...previous, [key]: value })),
          onKeyDown: (event) => {
            // 输入法确认用的回车不算；回车只加错误码，不提交页面。
            if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return
            event.preventDefault()
            add()
          },
        })),
        h(ui.Button, { variant: 'outline', size: 'sm', disabled: disabled || draftCode.length === 0, onClick: add }, app.t('retryCodeAdd'))))
  }

  const fields = (root, owner, base) => retryFieldsOf(owner).map(([key, node]) => {
    const path = [...base, key]
    if (node.type === 'number') return numberField(root, path, node)
    if (node.type === 'array') return codesField(root, path, node)
    if (node.type === 'object') {
      const open = openFolds.has(key)
      return h('div', { key, className: 'dms-field' },
        h('button', {
          type: 'button', className: 'dms-disc dms-disc-sub', 'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpenFolds((previous) => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next }),
        }, h(open ? ui.IconChevronDownOutlineRegular : ui.IconChevronRightOutlineRegular, { size: 14, className: 'dms-disc-ico' }), label(key)),
        open ? h('div', { className: 'dms-grid3' }, fields(root, node, path)) : null)
    }
    return null
  })

  const selectId = `${idBase}-mode`
  return h('div', { className: 'dms-field' },
    h('label', { className: 'dms-label', htmlFor: selectId }, app.t('retryPolicy')),
    h('select', {
      id: selectId, className: 'dms-select dms-select-wide', value: mode ?? '', disabled,
      onChange: (event) => {
        const next = defaults.branch(event.target.value)
        setTexts({})
        if (next === undefined) { onChange(undefined); return }
        // 换模式时只留新模式声明的字段。
        const declared = new Set(retryFieldsOf(next).map(([key]) => key))
        onChange({ ...Object.fromEntries(Object.entries(current).filter(([key]) => declared.has(key))), mode: event.target.value })
      },
    },
    h('option', { value: '' }, app.t('retryModeDefault', { mode: label(defaults.mode) })),
    defaults.modes.map(value => h('option', { key: value, value }, label(value)))),
    mode === 'always' ? h('p', { className: 'dms-hint' }, app.t('retryAlwaysHint')) : null,
    branch === undefined ? null : h('div', { className: 'dms-sub' }, fields(branch, branch, [])),
    failure === undefined ? null : h('p', { className: 'dms-note dms-err', role: 'alert' }, failure.message))
}

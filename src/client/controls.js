/** 设置页同款下拉菜单，选择后恢复触发按钮焦点。触发按钮的读屏名称是设置名加当前选的值。 */
function WorkbenchSelect({ label, value, options, onChange, disabled = false }) {
  const [open, setOpen] = useState(false)
  const id = React.useId()
  const valueId = `${id}-value`
  return h(
    'div',
    { className: 'dwb-select-field' },
    h('span', { id }, label),
    h(ui.Menu, {
      open: open && !disabled,
      onClose: () => setOpen(false),
      items: options,
      selectedId: value,
      onSelect: (next) => {
        onChange(next)
        setOpen(false)
      },
      portal: true,
      autoFocus: true,
      minWidthFromAnchor: true,
      anchor: h(
        'button',
        {
          type: 'button',
          className: 'dwb-select-trigger',
          'aria-labelledby': `${id} ${valueId}`,
          'aria-haspopup': 'menu',
          'aria-expanded': open && !disabled,
          disabled,
          onClick: () => setOpen((current) => !current),
        },
        h('span', { id: valueId }, options.find((option) => option.id === value)?.label ?? value),
        h(ui.IconChevronDownOutlineRegular, { size: 16 }),
      ),
    }),
  )
}

/** 复用对话日期模板；记录列表保留月日，时间与对话一样使用 24 小时制。 */
function workbenchClock(time, t, now = Date.now()) {
  const date = new Date(time)
  const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
  const day = t(
    date.getFullYear() === new Date(now).getFullYear() ? 'clock.md' : 'clock.ymd',
    params,
  )
  const clock = [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
  return `${day} ${clock}`
}

/** 使用官方折叠行；Escape 收起当前区块并把焦点放回标题。 */
function WorkbenchDisclosure({ title, children, ...props }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  return h(
    'div',
    {
      ref: root,
      onKeyDown: (event) => {
        if (event.key !== 'Escape' || !open) return
        event.stopPropagation()
        setOpen(false)
        root.current?.querySelector('[data-disclosure-row]')?.focus()
      },
    },
    h(
      ui.DisclosureRow,
      {
        ...props,
        title,
        icon: h(ui.IconChevronRightOutlineRegular, { size: 14 }),
        open,
        expandable: true,
        expandOnRowClick: true,
        onToggle: () => setOpen((current) => !current),
      },
      children,
    ),
  )
}

/**
 * 工具行折叠时标题后面的部分，照 DSH 自己的工具行（rc.3 的 ToolRow、TeamCommandRow）：先一个读屏不念的
 * 分隔点，再接摘要，摘要过长时省略号截断。摘要为空时整段不出，标题后面也不留分隔点。
 * @param {unknown} summary 摘要：文字或元素。
 * @param {{error?: boolean, suffix?: unknown}} [options] error 为真时摘要用出错的颜色；suffix 是摘要后面
 *   不参与截断的元素（例如「打开」按钮）。
 * @returns {unknown} 交给 ui.DisclosureRow 的 collapsedContent；摘要为空时是 undefined。
 */
function toolRowSummary(summary, { error = false, suffix } = {}) {
  if (summary === undefined || summary === null || summary === '') return undefined
  return h(Fragment, null,
    h('span', { className: 'dwb-row-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
    h('span', { className: 'dwb-row-summary', 'data-error': error ? '' : undefined }, summary),
    suffix === undefined ? null : h('span', { className: 'dwb-row-suffix' }, suffix))
}

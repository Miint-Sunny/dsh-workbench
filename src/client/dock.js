/**
 * 任务清单停靠条（dsh-workbench/tasks 的网页部分）：同 id `todo`、更小优先级（-1）
 * 盖住官方的「任务」条；数据还是官方 todo_write 的 `todos` 投影。这一行关掉后，入口
 * 调用返回的撤销函数，官方条回到原位。
 *
 * 和官方条的差别（样稿「任务清单和收尾框」A、E）：运行中自动展开，进行中的一项
 * 加粗并保持在视野里，标题行带进度条；回合结束后收成一行，全部完成时打勾。收起
 * 或展开按会话记住。
 */

/** 各会话用户自己的收起/展开选择：undefined 跟随运行状态，true/false 是显式选择。 */
const openChoice = new Map()

/**
 * 标题行的进度文字：照 DSH 的「N 已完成 · N 进行中 · N 待处理」，全完成只写一句。
 * 纯函数。
 * @param {Array<{status: string}>} todos 任务清单。
 * @param {(key: string, params?: object) => string} t 词条函数。
 * @returns {string} 进度文字；空清单是空串。
 */
export function progressText(todos, t) {
  if (todos.length === 0) return ''
  const done = todos.filter(item => item.status === 'completed').length
  if (done === todos.length) return t('todo.progressDone', { n: done })
  const active = todos.filter(item => item.status === 'in_progress').length
  const pending = todos.length - done - active
  return [
    done > 0 ? `${done} ${t('todo.doneUnit')}` : '',
    active > 0 ? `${active} ${t('todo.activeUnit')}` : '',
    pending > 0 ? `${pending} ${t('todo.pendingUnit')}` : '',
  ].filter(Boolean).join(' · ')
}

/** 停靠条主体。词条经 app.t（插槽不传 t，只传 slot-catalog 里声明的 standardProps）。 */
function TasksDock(props) {
  const { app, useProjection, useSessionStatus, sessionId } = props
  const t = app.t
  const todos = useProjection('todos') ?? []
  const status = useSessionStatus(map => map.get(sessionId))
  const running = status?.running === true
  const [choice, setChoice] = useState(openChoice.get(sessionId))
  const open = running ? choice !== false : choice === true
  const done = todos.filter(item => item.status === 'completed').length
  const allDone = todos.length > 0 && done === todos.length
  const current = todos.findIndex(item => item.status === 'in_progress')
  const currentRef = useRef(null)
  useEffect(() => {
    // 展开时把进行中的一项保持在视野里（清单内部滚动时）。
    if (open && current >= 0) currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, current, todos])
  if (todos.length === 0) return null
  const toggle = () => {
    const next = !open
    openChoice.set(sessionId, next)
    setChoice(next)
  }
  return h('section', { className: 'dwb-todo', 'data-testid': 'dwb-todo-dock', 'aria-label': t('todo.title') },
    h('div', { className: 'dwb-todo-body' },
      h('button', {
        type: 'button', className: 'dwb-todo-head', onClick: toggle,
        // 按钮里有可见的标题和进度，名字就是它们；展开状态由 aria-expanded 报。
        'aria-expanded': open,
      },
        h('span', { className: 'dwb-todo-lead', 'data-done': allDone ? 'all' : undefined, 'aria-hidden': true },
          allDone ? h(ui.IconCheckOutlineRegular, { size: 16 }) : h(ui.IconChecklistOutlineRegular, { size: 16 })),
        h('span', { className: 'dwb-todo-title' }, t('todo.title')),
        h('span', { className: 'dwb-todo-progress' }, progressText(todos, t)),
        h('span', { className: 'dwb-todo-bar', 'aria-hidden': true },
          h('i', { style: { width: `${Math.round((done / todos.length) * 100)}%` } })),
        h('span', { className: 'dwb-todo-chevron', 'aria-hidden': true },
          open ? h(ui.IconChevronUpOutlineRegular, { size: 16 }) : h(ui.IconChevronDownOutlineRegular, { size: 16 }))),
      open ? h('ul', { className: 'dwb-todo-list' },
        todos.map((item, at) => h('li', {
          // 带下标：内容相同的两项 React 键也不能重复。
          key: `${at}:${item.content}`, className: 'dwb-todo-item', 'data-status': item.status,
          ref: at === current ? currentRef : undefined,
        },
          h('span', { className: 'dwb-todo-glyph', 'aria-hidden': true },
            item.status === 'completed' ? h(ui.IconCheckOutlineRegular, { size: 14 })
              : item.status === 'in_progress' ? h(ui.StateDot, { state: 'ongoing' })
                : h(ui.StateDot, { state: 'idle' })),
          h('span', { className: 'dwb-todo-content' }, item.content)))) : null))
}

/**
 * 挂任务功能的界面：盖住官方任务条、轮次末尾的收尾框、收尾工具的折叠行。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数（那一行关掉时入口调用）。
 */
function applyTasks(app) {
  const { ctx } = app
  const disposers = [
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'todo', order: 0, priority: -1 },
      (props) => h(TasksDock, { ...props, app }))),
    applyWrapUp(app),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

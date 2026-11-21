/** 项目记忆工具行：原生 DisclosureRow，展开查看日志里的正文和版本。 */
const MEMORY_ZH = {
  'memory.read': '读取项目记忆', 'memory.write': '写入项目记忆',
  'memory.empty': '还没有项目记忆', 'memory.size': '{bytes} 字节', 'memory.failed': '项目记忆操作失败',
}
const MEMORY_EN = {
  'memory.read': 'Read project memory', 'memory.write': 'Write project memory',
  'memory.empty': 'No project memory yet', 'memory.size': '{bytes} bytes', 'memory.failed': 'Project memory failed',
}

/** 两个工具共用一行结构，正文按纯文本显示，不执行记忆里的 HTML。 */
function MemoryToolRow({ phase, block, writing, t }) {
  const [open, setOpen] = useState(false)
  const preparing = phase === 'preparing' || block === undefined || !('kind' in block)
  const meta = block?.meta
  const details = (block?.content ?? []).map(item => item.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
  const failed = block?.isError === true
  let memoryText = details
  if (!failed && details) {
    // 旧日志或工具失败可能不是本行的 JSON 结果；这种情况下保留原文。
    try { const result = JSON.parse(details); if (typeof result.content === 'string') memoryText = result.content } catch { /* 保留非 JSON 的日志结果。 */ }
  }
  const title = t(writing ? 'memory.write' : 'memory.read')
  const summary = failed ? t('memory.failed') : meta?.exists === false ? t('memory.empty') : meta ? t('memory.size', { bytes: meta.bytes }) : ''
  return h('div', { 'data-tool': writing ? 'memory_write' : 'memory_view', 'data-state': preparing ? 'running' : failed ? 'error' : 'ok' },
    h(ui.DisclosureRow, {
      title, icon: h(failed ? ui.IconWarningOutlineRegular : writing ? ui.IconSaveOutlineRegular : ui.IconSearchOutlineRegular, { size: 14 }),
      open, expandable: !preparing && details !== '', expandOnRowClick: true,
      running: preparing, onToggle: () => setOpen(value => !value),
      collapsedContent: toolRowSummary(summary, { error: failed }),
    }, h('div', null,
      meta?.project ? h('p', { style: { overflowWrap: 'anywhere', fontSize: 12 } }, meta.project) : null,
      h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, memoryText || t('memory.empty')))))
}

/** 注册两个工具名的呈现；关闭功能行撤销两个槽位。 */
function applyMemory({ ctx, t }) {
  const disposers = [false, true].map(writing => ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: writing ? 'memory_write' : 'memory_view', locale: '@miint-sunny/dsh-workbench',
  }, props => h(MemoryToolRow, { ...props, writing, t }))), 'workbench memory tool row'))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * 计划全文行（dsh-workbench/plan）：把计划全文显示在对话里。待审时（提交计划的事件一落盘）
 * 全文直接显示在对话流里，无需等待本轮结束。做法照官方 goal 和 user-questions：
 * `ctx.uiConversation.events.register` 加一个事件定义（认官方 submittedPlan 的三种事件，只带
 * callId，不自己解析计划正文），`conversation.chat.node` 插槽按节点的 kind 渲染；正文从官方
 * `turnDataSource(轮次, 'submitted-plan')` 按 callId 取，和官方「打开计划」卡片同一个数据源。
 * 节点站在轮这一级（groupTree 'turn'），这一轮结束后不会被折叠进「已完成」。官方的紧凑卡片、
 * 待审面板、右侧栏 PlanPreview、「查看全文」一律不动；这一行是追加，插件页关掉即撤挂载，
 * 官方样子完整恢复。
 */
import { mountModuleStyle } from './style.js'

/** 计划全文行要的 DSH 服务：会话绑定、对话视图（事件定义和聊天快照里的计划节点）。 */
const PLAN_INJECT = ['sessions', 'uiConversation']

/** 本功能的中文界面文字（都是 DSH 词典里已有的叫法）。 */
export const PLAN_ZH = {
  'plan.row': '计划',
  'plan.state.pending': '计划待审',
  'plan.state.approved': '已批准',
  'plan.expand': '展开',
  'plan.collapse': '收起',
  'plan.copy': '复制',
  'plan.copied': '已复制',
  'plan.codeBlock': '代码块',
  'plan.wrap': '换行',
  'plan.unwrap': '不换行',
  'plan.footnotes': '脚注',
}

/** 本功能的英文界面文字，键和 PLAN_ZH 一一对应。 */
export const PLAN_EN = {
  'plan.row': 'Plan',
  'plan.state.pending': 'Plan review',
  'plan.state.approved': 'Approved',
  'plan.expand': 'Expand',
  'plan.collapse': 'Collapse',
  'plan.copy': 'Copy',
  'plan.copied': 'Copied',
  'plan.codeBlock': 'Code block',
  'plan.wrap': 'Wrap',
  'plan.unwrap': 'Do not wrap',
  'plan.footnotes': 'Footnotes',
}

const PLAN_CSS = `
.dwb-plan{--dwb-plan-fill:var(--dsw-static-neutral-50);box-sizing:border-box;width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dwb-plan-fill);overflow:hidden}
body[data-ds-dark-theme] .dwb-plan{--dwb-plan-fill:var(--dsw-static-neutral-850)}
.dwb-plan+.dwb-plan{margin-top:10px}
.dwb-plan-head{display:flex;align-items:center;gap:8px;padding:10px 14px;color:var(--dsw-alias-label-secondary)}
.dwb-plan-head>svg{flex:none}
.dwb-plan-eyebrow{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwb-plan-title{flex:1 1 auto;min-width:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-plan-state{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dwb-plan-state[data-tone=approved]{color:var(--dsw-alias-state-success-primary)}
.dwb-plan-state>svg{flex:none}
.dwb-plan-body{padding:2px 16px 14px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.75;overflow-wrap:anywhere}
.dwb-plan-body[data-collapsed]{box-sizing:content-box;max-height:176px;overflow-y:auto;overscroll-behavior:contain}
.dwb-plan-foot{display:flex;justify-content:center;padding:0 14px 10px}
`

/** 正文高过这个值才收起（CSS 像素）：样稿第一节的短计划实测 404，不收；第四节的长计划要收。收起后限高 176。 */
const PLAN_ROLLUP_HEIGHT = 480

/** exit_plan_mode 同意时工具结果的开头。结果只有这段文字没有结构化字段；文案变了只是不显示「已批准」，不会说错。 */
const PLAN_APPROVED_RESULT = 'Plan approved'

/**
 * 一个事件是不是提交计划。照官方 dsh-client-ui-plan 的 submittedPlan 认的三种事件
 * （tool/call、tool/ptc-dispatch-start、tool/ptc-dispatch，工具名 exit_plan_mode，计划要有
 * 首个 # 标题）；这里只用来认身份，正文渲染走 turnDataSource，不经过这里。
 * @param {{type: string, data: object}} event 会话日志事件。
 * @returns {{callId: string, markdown: string, title: string} | undefined} 认得的计划；别的 undefined。
 */
export function submittedPlanOf(event) {
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data) || data.name !== 'exit_plan_mode') return undefined
  const callId = event.type === 'tool/call' ? data.callId : data.subCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  let args = data.arguments
  if (event.type === 'tool/call') {
    if (typeof args !== 'string') return undefined
    try {
      args = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args) || typeof args.plan !== 'string') return undefined
  const title = /^#\s+(\S[^\r\n]*)/.exec(args.plan.trim())?.[1]
  return title === undefined ? undefined : { callId, markdown: args.plan, title }
}

/**
 * 这份计划要不要收起。按实际渲染的高度算，窄窗口里同一份计划更高，也算得对。
 * @param {number} height 正文实际高度。
 * @param {boolean} expanded 用户点开了。
 * @returns {{collapsed: boolean, showsToggle: boolean}} 现在收起没有、要不要显示「展开/收起」。
 */
export function planRollupState(height, expanded) {
  const showsToggle = height > PLAN_ROLLUP_HEIGHT
  return { collapsed: showsToggle && !expanded, showsToggle }
}

/**
 * 这一次 exit_plan_mode 的结果。一份被要求修改的计划不是「已批准」，所以要看工具结果，
 * 不能看「现在没在等审阅」。
 * @param {{locations: {getTurn: Function}, nodes: {get: Function}}} snapshot useChat 的 ChatSnapshot。
 * @param {number} turn 计划所在的轮次号。
 * @param {string} callId 工具调用 id。
 * @returns {'open' | 'approved' | 'closed'} 还没有结果、同意了、结束了但没同意（包括这一轮找不到这次调用）。
 */
export function planOutcomeOf(snapshot, turn, callId) {
  for (const key of snapshot.locations.getTurn(turn)) {
    const node = snapshot.nodes.get(key)
    const root = node?.kind === 'tool-call' ? node.data.root : undefined
    if (root === undefined || root.callId !== callId) continue
    if (root.kind !== 'tool-result') return 'open'
    const text = root.content[0]?.text
    return root.isError !== true && typeof text === 'string' && text.startsWith(PLAN_APPROVED_RESULT) ? 'approved' : 'closed'
  }
  return 'closed'
}

/**
 * 头部的状态词。只说确定的事：结束了但没同意的计划不写状态。
 * @param {'open' | 'approved' | 'closed'} outcome planOutcomeOf 的结果。
 * @param {boolean} reviewing 这个会话正在等计划审阅。
 * @returns {{key: string, tone: 'pending' | 'approved'} | undefined} 词典键和样子；没有状态时 undefined。
 */
export function planViewState(outcome, reviewing) {
  if (outcome === 'approved') return { key: 'plan.state.approved', tone: 'approved' }
  return outcome === 'open' && reviewing ? { key: 'plan.state.pending', tone: 'pending' } : undefined
}

/** 计划全文的事件定义：提交计划一落盘就在对话流里占一个位置，正文按 callId 现取。 */
export const planDefinition = {
  kind: 'dsh-workbench-plan',
  target: 'chat',
  match: (event) => {
    const plan = submittedPlanOf(event)
    return plan === undefined ? null : {
      id: plan.callId,
      role: event.type === 'tool/ptc-dispatch' ? 'update' : 'start',
    }
  },
  start: (_context, match) => ({ callId: submittedPlanOf(match.event).callId }),
  update: (context) => context.state,
  buildViewNode: (context) => {
    const start = context.start ?? context.matches[0]
    if (start === undefined) return null
    return {
      key: context.key,
      kind: 'dsh-workbench-plan',
      id: context.id,
      target: 'chat',
      // 站在提交计划事件的位置；groupTree 'turn' 让它站在轮这一级，这一轮结束后不折进「已完成」。
      anchorSeq: start.event.seq,
      location: start.location,
      groupTree: 'turn',
      visibility: 'visible',
      data: { callId: context.id },
    }
  },
}

/** 一份计划的全文卡。样子照 docs/mocks/2026-11-07-计划全文.html。 */
function PlanCard({ app, plan, turn, useChat, useSessionStatus, sessionId }) {
  const { t } = app
  const outcome = useChat(snapshot => planOutcomeOf(snapshot, turn, plan.callId))
  const reviewing = useSessionStatus(map => map.get(sessionId)?.pendingInteraction?.kind === 'plan-review')
  const [height, setHeight] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const content = useRef(null)
  // 量里面这层：收起时外层被限高，里面这层还是全文的高度。
  React.useLayoutEffect(() => {
    const element = content.current
    const measure = () => { setHeight(element.offsetHeight) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  // MarkdownText 按 labels 的引用决定要不要重新渲染；代码块和脚注要用它，不传会抛错。
  const labels = useMemo(() => ({
    code: {
      copyLabel: t('plan.copy'),
      copiedLabel: t('plan.copied'),
      toolbarLabels: { codeLabel: t('plan.codeBlock'), wrapLabel: t('plan.wrap'), unwrapLabel: t('plan.unwrap') },
    },
    footnotes: t('plan.footnotes'),
  }), [t])
  const state = planViewState(outcome, reviewing)
  const rollup = planRollupState(height, expanded)
  return h('article', { className: 'dwb-plan', 'data-plan-full-text': plan.callId, 'aria-label': plan.title },
    h('div', { className: 'dwb-plan-head' },
      h(ui.IconPlanOutlineRegular, { size: 16 }),
      h('span', { className: 'dwb-plan-eyebrow' }, t('plan.row')),
      h('span', { className: 'dwb-plan-title', title: plan.title }, plan.title),
      state === undefined ? null : h('span', { className: 'dwb-plan-state', 'data-tone': state.tone },
        state.tone === 'approved' ? h(ui.IconCheckCircleOutlineRegular, { size: 14 }) : h(ui.StateDot, { state: 'warning' }),
        t(state.key))),
    h('div', { className: 'dwb-plan-body', 'data-collapsed': rollup.collapsed ? '' : undefined },
      h('div', { ref: content },
        h(ui.MarkdownText, { text: plan.markdown, labels, textInteractionSource: true }))),
    rollup.showsToggle
      ? h('div', { className: 'dwb-plan-foot' },
        h(ui.Button, {
          variant: 'outline',
          size: 'sm',
          icon: h(rollup.collapsed ? ui.IconChevronDownOutlineRegular : ui.IconChevronUpOutlineRegular, { size: 14 }),
          'aria-expanded': !rollup.collapsed,
          onClick: () => { setExpanded(current => !current) },
        }, t(rollup.collapsed ? 'plan.expand' : 'plan.collapse')))
      : null)
}

/**
 * 对话流里的一处计划全文：节点带 callId，正文从官方 turnDataSource 按轮次取（和官方卡片
 * 同一个来源），快照还没有或这一轮还没有这份计划时不显示。useChat、useSessionStatus 是
 * DSH 给这个插槽的标准 hook。
 * @param {object} props 插槽的属性：node（数据只带 callId 和位置），加 DSH 给的 useChat、useSessionStatus 和本行注入的 usePlans、sessionId。
 * @returns {object | null} 这一份计划的全文卡。
 */
function PlanNodeView({ app, node, sessionId, usePlans, useChat, useSessionStatus }) {
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn.turn : undefined
  const plans = usePlans(String(turn))
  const plan = plans?.find(entry => entry.callId === node.data.callId)
  if (turn === undefined || plan === undefined) return null
  return h(PlanCard, { app, plan, turn, useChat, useSessionStatus, sessionId })
}

/**
 * 和官方计划卡片同一个数据源：本会话聊天快照里这一轮的 submitted-plan 节点（开放轮次也
 * 有，待审时全文就取得到）。快照还没建好时返回 undefined，渲染器按「没有值」处理，行不
 * 显示，不让这一轮崩掉。sessionId 跟着一起给组件。只在这个插槽真的渲染时才被调用，
 * 不用官方对话视图的页面不会走到这里。
 * @param {object} ctx 客户端上下文（要 sessions、uiConversation）。
 * @param {string} sessionId 会话 id。
 * @returns {{sessionId: string, keyedHooks: {plans: (turn: string) => object | undefined}}} 插槽的 inject 结果；组件拿到 usePlans。
 */
function planSources(ctx, sessionId) {
  const binding = ctx.sessions.binding(sessionId)
  const chat = binding === undefined ? undefined : ctx.uiConversation.binding(binding).target('chat')
  return {
    sessionId,
    keyedHooks: {
      plans: (turn) => chat?.getSnapshot()?.nodes.turnDataSource(Number(turn), 'submitted-plan'),
    },
  }
}

/**
 * 挂载计划全文行（插件页里这一行开着时调用）。
 * @param {{ctx: object, t: Function}} app 入口上下文。
 * @returns {() => void} 撤销函数；撤销后对话里只剩官方的「打开计划」卡片。
 */
export function applyPlan(app) {
  const { ctx } = app
  const disposers = [mountModuleStyle('dsh-workbench-plan', PLAN_CSS)]
  disposers.push(ctx.uiConversation.events.register(planDefinition))
  disposers.push(ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    {
      name: 'conversation.chat.node', key: 'dsh-workbench-plan', locale: '@miint-sunny/dsh-workbench',
      inject: (sessionId) => planSources(ctx, sessionId),
    },
    (props) => h(PlanNodeView, { app, ...props }))))
  return () => { for (const dispose of disposers) dispose() }
}

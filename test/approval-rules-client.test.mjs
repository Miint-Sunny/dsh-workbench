/**
 * 审批卡片上的规则区（fix#197）：在替身 React 里跑构建好的 lib/client.js，宿主只回答 approval-rules.pending。
 * 受保护的目标（工作区保护，feat#188）建不了规则，卡片上只写原因；别的不能建规则的原因照旧带规则说明和「刷新」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const SESSION = 's1'
const CALL = 'call-1'

/** 一张等审批的 bash 卡片；pending 请求回答 answer。 */
async function card(answer) {
  const client = loadClient(CLIENT, {
    fetch: async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const { react } = client
  const zh = client.get('RULES_ZH')
  const t = key => zh[key] ?? key
  const root = { callId: CALL, name: 'bash', phase: 'start', argsRaw: JSON.stringify({ command: 'rm -f ~/.dsh/sessions/probe' }) }
  const pending = { kind: 'approval', toolName: 'bash', callId: CALL, key: 'k1', answerable: true, answer: async () => {} }
  react.mount(react.React.createElement(client.get('RuleApprovalDetail'), {
    app: { t, ctx: {} },
    callId: CALL,
    sessionId: SESSION,
    useChat: select => select({ nodes: new Map([['n1', { kind: 'tool-call', data: { root } }]]) }),
    useSessionStatus: select => select(new Map([[SESSION, { pendingInteraction: pending }]])),
  }))
  await react.settle()
  const detail = react.one(node => node.props?.className === 'dwb-rule-detail', '规则区')
  // 关着的「建规则」对话框一直在树里，界面上看不见，只看对话框以外的部分。
  const shown = detail.children.filter(node => typeof node === 'string' || node.type !== 'dialog')
  const buttons = []
  const walk = nodes => {
    for (const node of nodes) {
      if (typeof node === 'string') continue
      if (node.type === 'button') buttons.push({ text: textOf(node), disabled: Boolean(node.props.disabled) })
      walk(node.children)
    }
  }
  walk(shown)
  return { t, text: shown.map(textOf).join(''), buttons }
}

test('受保护的目标：只写不能建规则的原因，不出规则说明和「刷新」', async () => {
  const { t, text, buttons } = await card({ eligible: false, reason: 'protected-target' })
  assert.ok(text.includes(t('rules.protected-target')))
  assert.ok(!text.includes(t('rules.limit')))
  assert.ok(!buttons.some(button => button.text === t('rules.refresh')))
  assert.deepEqual(buttons.filter(button => button.text === t('rules.create')), [{ text: t('rules.create'), disabled: true }])
})

test('别的原因建不了规则：照旧带规则说明，能「刷新」', async () => {
  const { t, text, buttons } = await card({ eligible: false, reason: 'unsupported-call' })
  assert.ok(text.includes(t('rules.unsupported-call')))
  assert.ok(text.includes(t('rules.limit')))
  assert.deepEqual(buttons.filter(button => button.text === t('rules.refresh')), [{ text: t('rules.refresh'), disabled: false }])
})

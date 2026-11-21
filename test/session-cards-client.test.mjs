/**
 * 新会话卡片的网页部分（feat#160 返工，审查第 2、6 条）：在构建好的 lib/client.js 里挂一张待处理的卡，
 * 宿主的两个路由换成替身。要用完全权限而当前会话不是时，点「开始」和按 ⌘↵ 都先弹官方的完全权限确认，
 * 确认了才发开始的请求；当前会话的权限是 custom 时，默认选项也能直接开始。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, textOf } from './react-harness.mjs'
import { validateStartOptions } from '../lib/session-cards-state.js'

const FULL = 'danger-full-access'
const CHOICES = {
  workspaces: [{ id: 'w1', title: 'repo', path: '/work/repo' }],
  presets: [{ id: 'standard', name: '标准模式' }],
  models: [{ provider: 'p', model: 'pro', name: 'Pro', efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' }],
  permissions: ['read-only', 'workspace-write', FULL].map(value => ({ value, name: value })),
  worktree: false,
}

/**
 * 挂一张待处理的卡。
 * @param {object} t 测试上下文。
 * @param {{proposed?: object, current?: object, lastModel?: object | null, contextFails?: (() => Response) | null, actFails?: (() => Response) | null, translate?: (key: string, params?: object) => string}} options
 *   模型定的选项、当前会话的选项、宿主记住的上一次选的模型；读选项、卡片动作的请求要失败时给出宿主的回答（抛错就是没连上）；
 *   词典替身（缺省只回键名，要看参数时换成带参数的）。
 */
async function mountCard(t, { proposed = {}, current = { workspaceId: 'w1', agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high', permission: 'workspace-write' }, lastModel = null, contextFails = null, actFails = null, translate = key => key } = {}) {
  const sent = []
  const fetch = async (url, init) => {
    const path = String(url)
    // 读的是 current 和 contextFails 现在的值：卡片挂上以后，测试可以改当前会话的选项或让读取失败。
    if (path.startsWith('api/dsh-workbench.session-cards.context?')) return contextFails ? contextFails() : Response.json({ ok: true, value: { current, lastModel, choices: CHOICES } })
    if (path === 'api/dsh-workbench.session-cards.act') {
      const body = JSON.parse(init.body)
      sent.push(body)
      if (actFails) return actFails()
      // 和宿主的 act 路由一样，开始前按模型目录核对选项，不在目录里的回 invalid-options。
      if (body.verb === 'start') {
        try {
          validateStartOptions(body.options, CHOICES)
        } catch (error) {
          if (error?.code !== 'invalid-options') throw error
          return Response.json({ ok: false, error: { code: 'invalid-options', field: error.field } }, { status: 400 })
        }
      }
      return Response.json({ ok: true, value: { childId: 'child-1' } })
    }
    throw new Error(`没准备的请求 ${path}`)
  }
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { fetch })
  const { react } = client
  const card = { id: 'c1', turn: 2, order: 0, title: '更正发布页', brief: '只改说明', options: proposed, state: 'pending' }
  const app = { t: translate, ctx: { remote: {}, uiWorkspace: { openSession() {} } } }
  react.mount(react.React.createElement(client.get('SessionCard'), { app, card, sessionId: 's-parent', latestTurn: 2, useSessionStatus: () => undefined }))
  t.after(() => react.unmount())
  await react.settle()
  const button = label => react.one(node => node.type === 'ui.Button' && textOf(node) === label, `「${label}」按钮`)
  const confirms = () => react.all(node => node.type === 'ui.Modal')
  return {
    client, react, sent, button, confirms,
    /** 卡片等待时当前会话的选项改了（比如在官方的权限菜单里换了权限）。 */
    setCurrent(next) { current = next },
    /** 之后再读选项时宿主这样回答。 */
    setContextFails(answer) { contextFails = answer },
    /** 按 ⌘↵：执行这个会话登记的推荐项。 */
    nextStep() {
      assert.equal(client.get('nextStepOf')('s-parent'), 'card:c1')
      assert.equal(client.get('runNextStep')('s-parent'), true)
    },
    /** 在确认框里勾上「我已了解风险」并启用。 */
    async confirm() {
      react.one(node => node.type === 'ui.Checkbox', '确认框的勾选').props.onChange()
      await react.settle()
      react.fire(button('scard.confirm.enable'), 'onClick')
      await react.settle()
    },
  }
}

test('while Handle in this session waits for the host, Start does not say it is starting', async (t) => {
  const gate = Promise.withResolvers()
  const card = await mountCard(t, { actFails: () => gate.promise.then(() => Response.json({ ok: true })) })
  card.react.fire(card.button('scard.here'), 'onClick')
  await card.react.settle()
  const labels = card.react.all(node => node.type === 'ui.Button').map(textOf)
  assert.ok(labels.includes('scard.start') && !labels.includes('scard.starting'), JSON.stringify(labels))
  gate.resolve()
  await card.react.settle()
  assert.deepEqual(card.sent.map(body => body.verb), ['here'])
})

test('Start with the full access the model proposed asks first; nothing starts until it is confirmed', async (t) => {
  const card = await mountCard(t, { proposed: { permission: FULL } })
  card.react.fire(card.button('scard.start'), 'onClick')
  await card.react.settle()
  assert.equal(card.confirms().length, 1)
  assert.deepEqual(card.sent, [])
  await card.confirm()
  assert.equal(card.confirms().length, 0)
  assert.equal(card.sent.length, 1)
  assert.equal(card.sent[0].verb, 'start')
  assert.equal(card.sent[0].options.permission, FULL)
})

test('⌘↵ on such a card asks the same; cancelling starts nothing', async (t) => {
  const card = await mountCard(t, { proposed: { permission: FULL } })
  card.nextStep()
  await card.react.settle()
  assert.equal(card.confirms().length, 1)
  card.react.fire(card.button('scard.confirm.cancel'), 'onClick')
  await card.react.settle()
  assert.equal(card.confirms().length, 0)
  assert.deepEqual(card.sent, [])
})

test('no question when this session already has full access, or the card does not use it', async (t) => {
  const already = await mountCard(t, { proposed: { permission: FULL }, current: { workspaceId: 'w1', agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, permission: FULL } })
  already.react.fire(already.button('scard.start'), 'onClick')
  await already.react.settle()
  assert.equal(already.confirms().length, 0)
  assert.equal(already.sent[0].options.permission, FULL)
})

/** 当前会话是完全权限时挂上的卡：默认选项就是完全权限，不用确认。 */
const FULL_SESSION = { workspaceId: 'w1', agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high', permission: FULL }

test('Start asks first when this session lost full access while the card waited', async (t) => {
  const card = await mountCard(t, { current: { ...FULL_SESSION } })
  card.setCurrent({ ...FULL_SESSION, permission: 'workspace-write' })
  card.react.fire(card.button('scard.start'), 'onClick')
  await card.react.settle()
  assert.equal(card.confirms().length, 1)
  assert.deepEqual(card.sent, [])
  await card.confirm()
  assert.equal(card.sent.length, 1)
  assert.equal(card.sent[0].options.permission, FULL)
})

test('⌘↵ asks the same after this session lost full access', async (t) => {
  const card = await mountCard(t, { current: { ...FULL_SESSION } })
  card.setCurrent({ ...FULL_SESSION, permission: 'read-only' })
  card.nextStep()
  await card.react.settle()
  assert.equal(card.confirms().length, 1)
  assert.deepEqual(card.sent, [])
})

test('Start starts nothing and says why when this session options cannot be read again', async (t) => {
  const card = await mountCard(t, { current: { ...FULL_SESSION } })
  card.setContextFails(() => Response.json({ ok: false, error: { code: 'session-not-found' } }, { status: 404 }))
  card.react.fire(card.button('scard.start'), 'onClick')
  await card.react.settle()
  assert.equal(card.confirms().length, 0)
  assert.deepEqual(card.sent, [])
  const alert = card.react.one(node => node.type === 'p' && node.props.role === 'alert', '失败说明')
  assert.equal(textOf(alert), 'scard.failed')
})

test('full access chosen in the options is confirmed there once; Start then goes ahead', async (t) => {
  const card = await mountCard(t)
  card.react.fire(card.button('scard.options'), 'onClick')
  await card.react.settle()
  const permission = card.react.one(node => node.type === 'ui.Menu' && node.props.items.some(item => item.id === FULL), '权限下拉')
  permission.props.onSelect(FULL)
  await card.react.settle()
  assert.equal(card.confirms().length, 1)
  await card.confirm()
  card.react.fire(card.button('scard.start'), 'onClick')
  await card.react.settle()
  assert.equal(card.confirms().length, 0)
  assert.equal(card.sent.length, 1)
  assert.equal(card.sent[0].options.permission, FULL)
})

test('a custom permission on this session still gives defaults that start (workspace write)', async (t) => {
  const card = await mountCard(t, { current: { workspaceId: 'w1', agentPreset: 'standard', model: { provider: 'p', model: 'pro' }, reasoningEffort: 'high' } })
  card.react.fire(card.button('scard.start'), 'onClick')
  await card.react.settle()
  assert.equal(card.confirms().length, 0)
  assert.equal(card.sent[0].options.permission, 'workspace-write')
})

test('a remembered model that was removed falls back to this session\'s model, and Start goes ahead', async (t) => {
  const card = await mountCard(t, { lastModel: { provider: 'p', model: 'gone' } })
  card.react.fire(card.button('scard.start'), 'onClick')
  await card.react.settle()
  assert.equal(card.sent.length, 1)
  assert.deepEqual(card.sent[0].options.model, { provider: 'p', model: 'pro' })
  assert.deepEqual(card.react.all(node => node.props.role === 'alert').map(textOf), [], 'no error under the card')
})

/** 带参数的词典替身：看得出原因里填的是哪一句。 */
const withParams = (key, params) => params === undefined ? key : `${key}(${Object.values(params).join('|')})`
/** 宿主答一个错误码。 */
const failing = (status, code) => () => Response.json({ ok: false, error: { code } }, { status })
/** 卡片上选项摘要那一行。 */
const summaryOf = card => card.react.all(node => node.props.className === 'dwb-scard-summary').map(textOf)

test('options that fail to load say why in the card\'s own words, not as the error code', async (t) => {
  const card = await mountCard(t, { contextFails: failing(404, 'session-unavailable'), translate: withParams })
  assert.deepEqual(summaryOf(card), ['scard.loadFailed(scard.error.session-unavailable)'])
})

test('a code the card has no words for gets one generic sentence; no connection says the connection failed', async (t) => {
  const unknown = await mountCard(t, { contextFails: failing(500, 'context-failed'), translate: withParams })
  assert.deepEqual(summaryOf(unknown), ['scard.loadFailed(scard.error.other)'])
  const offline = await mountCard(t, { contextFails: () => { throw new TypeError('fetch failed') }, translate: withParams })
  assert.deepEqual(summaryOf(offline), ['scard.loadFailed(scard.error.unknown)'])
})

test('a card action that fails with a code the card has no words for shows the same generic sentence', async (t) => {
  const card = await mountCard(t, { actFails: failing(500, 'act-failed'), translate: withParams })
  card.react.fire(card.button('scard.here'), 'onClick')
  await card.react.settle()
  assert.deepEqual(card.react.all(node => node.props.role === 'alert').map(textOf), ['scard.failed(scard.error.other)'])
})

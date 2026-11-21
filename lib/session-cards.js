/**
 * dsh-workbench/session-cards 行的宿主端（feat#160）：模型调 propose_session 提议把一件事
 * 另开一个会话做，这一轮末尾出一张卡片（网页端 src/client/session-cards.js），用户点「开始」
 * 才开会话。规矩都在工具和宿主里，不靠提示词：
 * - 一轮最多三张；同一件事（题目相同）不管上一张开了、在当前会话处理了还是关了，都不再提；
 * - 从卡片开出来的会话、子智能体不能提卡（新会话里工具也藏掉）；
 * - 用户这一轮亲口要求另开会话（userQuote 逐字出现在用户的话里，并且是「另开一个会话」这样
 *   的要求）、工作区和当前会话相同、权限不高于当前会话，才直接开，不出提议卡；不满足的照样
 *   出卡，等用户点「开始」，工具结果写明原因。
 * 开会话走官方会话控制器（和界面上新建的会话一样由它持有）：带工作区和 Agent 预设创建，
 * 再设模型和推理等级、权限，需要时借官方工作树服务新建工作树，最后把说明作为第一条消息
 * 发出。中途失败就归档新会话、从存档里删掉它；新建过的工作树交给官方工作树服务归档时的
 * 清理，删不掉的在失败原因里写明留在哪里。官方侧边栏没有会话层级，新会话只能开在同一个
 * 工作区里、手动排序时排在当前会话下面（实测见 feat160-166-结果）。
 * 新会话的 agent.ctx 上挂的东西（提示词段、工具限制、提问旁观）都记着撤销函数：新会话的
 * Agent 被释放时撤它那一组，这一行关掉时全撤，关掉以后不再回报。
 * 新会话停下来（做完、等待回答/审批/计划待审、出错、被停止）时，按宿主看到的状态向当前
 * 会话回报一次：一条来源是 workbench-session-report 的消息（照官方子智能体回报的 notice
 * 形式），当前会话空闲就开一轮，正在跑就排到这一轮之后（agent.followup）。
 * 卡片 A（ask: true）问用户要不要另开会话，也在这一轮末尾出卡，工具不等回答；设置为「总是……」时
 * 工具直接开会话或留在当前会话。卡片 A 开会话只用当前会话的设置，带不过去时不开。
 * 卡片和决定都在父会话日志里（tool/call、tool/result 的 meta、插件记录），投影从日志重建；
 * 宿主只另存上一次选的模型和「哪个会话是从哪张卡开出来的」（session-cards-store.js）。
 */
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { registerFeature } from './features.js'
import { workbenchDataDir } from './data-dir.js'
import { presetLocale } from './preset-locale.js'
import { SESSION_CARDS_HOST, fillCopy } from './session-cards-copy.js'
import { applySessionCardsPrefsRoutes, askDelivery, createCardsStore, readOwnSessionPrefs, writeOwnSessionPrefs } from './session-cards-store.js'
import {
  CARD_RECORD, MAX_REPORT_LAST, PROPOSE_TOOL, REPORT_SOURCE,
  cardDefaults, cardsFold, cardsInit, cardsViewOf, checkProposal, directStartBlock, parseCardsState, parseCardsView,
  proposalArgsOf, quoteFromUser, resolveProposedOptions, titleKey, validateStartOptions,
} from './session-cards-state.js'

export const name = '@miint-sunny/dsh-workbench/session-cards'
export const inject = ['tools', 'systemPrompt', 'connection', 'sessionProjections']

/** 投影名（网页端 useProjection 用同一个）。 */
const PROJECTION = 'workbenchSessionCards'
/** 当前会话不在任何工作区（只按目录开的）时，卡片上「同一个目录」这一项的 id。 */
const UNGROUPED = 'ungrouped'
/** 不在卡片里列出的预设：工作台内部用的只读审查。 */
const HIDDEN_PRESETS = ['dsh-workbench-readonly-review']
/** 会话 id 的样子。 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** 回报里一行摘要的长度上限（DSH 的 notice 摘要最多 120 字）。 */
const MAX_SUMMARY = 120
/** 新会话空闲多久才算停下来（排队的下一轮紧接着开始时不报）。 */
const SETTLE_MS = 400
/** 开一个新会话最多等多久（新建工作树要跑 git）。 */
const START_TIMEOUT_MS = 120_000
/** 开会话失败以后，最多等官方工作树服务的归档清理多久（超过就按工作树留着说）。 */
const CLEANUP_WAIT_MS = 20_000

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/** 深冻结一条消息（照本地审查的写法，交给 Agent 的消息不再被改）。 */
function freeze(value) {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/** 消息里的文字。 */
function textOfContent(content) {
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''
}

/** 宿主出错时给网页的代码。 */
class CardError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

/** 开会话中途失败：原因，加上新建以后没能删掉的工作树（有的话）。 */
class StartError extends Error {
  constructor(cause, worktree) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.worktree = worktree
  }
}

/**
 * 等一个结果，最多等 ms 毫秒；超时给 fallback。
 * @param {Promise<unknown>} promise 要等的。
 * @param {number} ms 毫秒。
 * @param {unknown} fallback 超时给的值。
 * @returns {Promise<unknown>} 结果或 fallback。
 */
async function within(promise, ms, fallback) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback) })])
  } finally {
    clearTimeout(timer)
  }
}

/** 去掉值为 undefined 的字段，保证内存对象和检查点 JSON 往返一致。 */
function compactOptions(options) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
}

/**
 * 注册 session-cards 行：功能登记、提示词段、propose_session 工具、workbenchSessionCards
 * 投影、两个卡片路由与设置路由、新会话的观察和回报。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{locale?: 'zh'|'en'}} [options] 行配置：宿主文字的语言，默认跟随 DSH。
 */
export function apply(ctx, options = {}) {
  const localeOf = () => presetLocale(ctx, options?.locale)
  const copy = () => SESSION_CARDS_HOST[localeOf()]
  ctx.effect(() => registerFeature('session-cards'), '@miint-sunny/dsh-workbench/session-cards: feature registration')
  ctx.systemPrompt.section({ name: 'workbench:session-cards', order: 2955, text: copy().prompt })
  ctx.effect(() => applySessionCardsPrefsRoutes(ctx), '@miint-sunny/dsh-workbench/session-cards: prefs route')

  ctx.inject(['sessionController', 'agents', 'agentPresets', 'workspaceRegistry'], async (scope) => {
    const store = createCardsStore(join(workbenchDataDir(), 'session-cards.json'))
    const projection = await scope.sessionProjections.register({
      key: PROJECTION,
      stateSchema: { parse: parseCardsState },
      init: () => cardsInit(),
      apply: cardsFold,
      wire: { viewSchema: { parse: parseCardsView }, view: cardsViewOf },
      stateVersion: 1,
    })
    /** 同一会话里已经放行、最终结果还没记入日志的提议。 */
    const acceptedNow = new WeakMap()
    /** 正在处理的卡（防连点）。 */
    const busyCards = new Set()
    /** 尚在读取父设置或启动子会话的 A 操作；行卸载时要等已发起的创建和回滚结束。 */
    const askOperations = new Set()
    /** 新会话这一阵的情况：childId → { last, reason, ended, timer }。 */
    const activity = new Map()
    /** 挂在新会话 agent.ctx 上的东西：Agent → 撤销函数（提示词段、工具限制、提问旁观）。 */
    const childRules = new Map()
    /** 这一行还开着；关掉以后在途的回报也不发。 */
    let alive = true

    /** 拿到会话的 Agent；没加载就让会话控制器加载。 */
    const agentOf = async (sessionId) => {
      const live = scope.agents.get(sessionId)
      if (live !== undefined) return live
      const resolved = await scope.sessionController.resolveAgent(sessionId)
      return 'agent' in resolved ? resolved.agent : undefined
    }

    /** 这个会话所在的工作区。 */
    const workspaceOfSession = sessionId => scope.workspaceRegistry.list().find(item => item.sessionIds.includes(sessionId))

    /** 现在能选的：工作区、预设、模型、权限、有没有工作树。 */
    const choicesOf = async (agent, { forAskStart = false } = {}) => {
      const workspaces = scope.workspaceRegistry.list().map(item => ({ id: item.id, title: item.title, path: item.path }))
      if (agent !== undefined && workspaceOfSession(agent.session.id) === undefined && typeof agent.session.header.cwd === 'string') {
        workspaces.push({ id: UNGROUPED, title: basename(agent.session.header.cwd), path: agent.session.header.cwd })
      }
      const presets = (await scope.agentPresets.list())
        .filter(preset => !HIDDEN_PRESETS.includes(preset.id) && (!forAskStart || preset.broken === undefined))
        .map(preset => ({ id: preset.id, ...(typeof preset.name === 'string' ? { name: preset.name } : {}) }))
      const catalog = await scope.sessionController.modelCatalog()
      const routable = new Set(catalog.routableProviders ?? catalog.groups.map(group => group.id))
      const models = catalog.groups.filter(group => routable.has(group.id)).flatMap(group => group.models.map(model => ({
        provider: group.id, model: model.id, name: model.name,
        efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
        ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
      })))
      const permissionPresets = ctx.get('permissionPresets')
      const permissions = (permissionPresets?.catalog?.().options ?? [])
        .filter(option => option.value !== 'custom')
        .map(option => ({ value: option.value, name: option.name }))
      return { workspaces, presets, models, permissions, worktree: ctx.get('worktrees') !== undefined }
    }

    /** 当前会话的选项（卡片默认和它一样）。 */
    const currentOf = (agent) => {
      const session = agent.session
      const workspace = workspaceOfSession(session.id)
      let model
      try {
        model = agent.model.current()
      } catch {
        model = undefined
      }
      let permission
      try {
        permission = ctx.get('permissionPresets')?.current?.(session)
      } catch {
        permission = undefined
      }
      return {
        workspaceId: workspace?.id ?? (typeof session.header.cwd === 'string' ? UNGROUPED : undefined),
        agentPreset: scope.agentPresets.presetForSession(session) ?? undefined,
        ...(model?.provider && model.model ? { model: { provider: model.provider, model: model.model } } : {}),
        ...(model?.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        ...(permission === undefined || permission === 'custom' ? {} : { permission }),
      }
    }

    /** 宿主日志里记一条警告。 */
    const warn = (what, error) => {
      try {
        scope.logger?.warn?.(`dsh-workbench session-cards: ${what}: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // 作用域或日志服务也可能正在卸载，仍要收完子会话并回答原来的结果。
      }
    }

    /** 撤掉挂在这个新会话上的东西（Agent 被释放、这一行关掉、开到一半失败时）。可以重复调。 */
    const detachChild = async (agent) => {
      const disposers = childRules.get(agent)
      if (disposers === undefined) return
      childRules.delete(agent)
      await Promise.all(disposers.reverse().map(async dispose => {
        try {
          await dispose()
        } catch (error) {
          warn(`could not detach ${agent.id}`, error)
        }
      }))
    }

    /**
     * 给新会话挂上它的规矩：提示词段、藏掉 propose_session、看着它的提问；撤销函数都记在 childRules。
     * 可以重复调；这一行关掉以后不再挂。
     */
    const attachChild = (agent) => {
      if (!alive || agent === undefined || childRules.has(agent) || store.linkOf(agent.id) === undefined) return
      const disposers = []
      childRules.set(agent, disposers)
      try {
        // 同名的作用域段盖住全局的「提议新会话」说明：新会话只看到它自己的规矩。
        disposers.push(agent.ctx.systemPrompt.section({ name: 'workbench:session-cards', order: 2955, text: copy().childPrompt }))
      } catch (error) {
        warn(`could not add the prompt section to ${agent.id}`, error)
      }
      try {
        disposers.push(agent.ctx.tools.restrict({ deny: [PROPOSE_TOOL] }))
      } catch {
        // 这个预设本来就看不到全局工具；工具里还有一道检查。
      }
      // 提问（等待回答、审批、计划审阅）在宿主上就是这一条 waterfall：只旁观，交给下一个处理。
      disposers.push(agent.ctx.on('user-questions/request', (request, next) => {
        const kinds = (request?.questions ?? []).map(question => question?.intent?.kind)
        void reportChild(agent.id, kinds.includes('approval') ? 'approval' : kinds.includes('plan-review') ? 'plan' : 'waiting')
        return next()
      }, { prepend: true }))
    }

    /** 回报一次：新会话的状态和最后一句，以 notice 形式交给开它的会话。这一行关着就不发。 */
    const reportChild = async (childId, state) => {
      if (!alive) return
      const link = store.linkOf(childId)
      if (link === undefined) return
      const text = copy()
      const last = (activity.get(childId)?.last ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_REPORT_LAST)
      const summary = fillCopy(text.reportSummary, { title: link.title, state: text.states[state] }).slice(0, MAX_SUMMARY)
      const message = freeze({
        id: randomUUID(),
        role: 'user',
        source: { kind: REPORT_SOURCE, form: 'notice', summary, senderSessionId: childId, cardId: link.cardId, state, last },
        content: [{ type: 'text', text: fillCopy(text.report, { title: link.title, state: text.states[state], last: last === '' ? text.noLast : last }) }],
      })
      try {
        const parent = await agentOf(link.parentId)
        // 等父会话加载的时候这一行可能被关掉了。
        if (!alive) return
        if (parent === undefined) throw new Error('parent session unavailable')
        parent.followup(message)
      } catch (error) {
        warn(`could not report ${childId}`, error)
      }
    }

    // 最终工具结果落盘后，投影接管这次提议；被拦下或取消的调用也应释放名额。
    scope.on('session/disposed', session => { acceptedNow.delete(session) })
    scope.on('session/event', (session, event) => {
      if (event.type === 'tool/result') {
        const message = event.data?.message
        releaseAccepted(session, message?.toolCallId ?? message?.source?.callId, event.data?.turn)
      } else if (event.type === 'turn/end' && acceptedNow.get(session)?.[0]?.turn === event.data?.turn) {
        acceptedNow.delete(session)
      }
      // 记录新会话最后一句以及这一轮怎么结束，供停下来时回报。
      if (store.linkOf(session.id) === undefined) return
      const entry = activity.get(session.id) ?? { last: '', reason: undefined, ended: false, timer: undefined }
      if (event.type === 'assistant/message') {
        const text = textOfContent(event.data?.message?.content).trim()
        if (text !== '') entry.last = text
      } else if (event.type === 'turn/end') {
        entry.reason = event.data?.reason?.kind
        entry.ended = true
      }
      activity.set(session.id, entry)
    })
    // 新会话停下来：空闲一小会儿还空闲，并且这期间有一轮结束了，才回报。
    scope.on('agent/status', ({ agent, status }) => {
      if (store.linkOf(agent.id) === undefined) return
      const entry = activity.get(agent.id) ?? { last: '', reason: undefined, ended: false, timer: undefined }
      activity.set(agent.id, entry)
      clearTimeout(entry.timer)
      if (status !== 'idle') return
      entry.timer = setTimeout(() => {
        if (agent.status !== 'idle' || !entry.ended) return
        entry.ended = false
        void reportChild(agent.id, entry.reason === 'error' ? 'error' : entry.reason === 'aborted' ? 'stopped' : 'done')
      }, SETTLE_MS)
    })
    scope.effect(() => () => { for (const entry of activity.values()) clearTimeout(entry.timer) }, 'session-cards report timers')

    /** 在侧边栏手动排序里把新会话排到当前会话下面；做不到就算了。 */
    const placeBelow = async (parentId, childId) => {
      try {
        const workspace = workspaceOfSession(childId)
        if (workspace === undefined || !workspace.sessionIds.includes(parentId)) return
        const order = workspace.sessionIds.filter(id => id !== childId)
        await workspace.insertSessionBefore(childId, order[order.indexOf(parentId) + 1])
      } catch {
        // 排序只是方便找，失败不影响新会话。
      }
    }

    /**
     * 新建过工作树的会话归档以后，等官方工作树服务的归档清理（rc.3：归档时清理这个会话自己建的、
     * 干净的、没有别的会话在用的工作树，分支留着；设了归档时保留就不清理）。
     * @param {object} session 归档的新会话。
     * @returns {Promise<boolean>} 工作树删掉了。
     */
    const worktreeRemoved = async (session) => {
      try {
        const worktrees = ctx.get('worktrees')
        if (typeof worktrees?.cleanupOf !== 'function') return false
        const attempt = await worktrees.cleanupOf(session, null)
        if (attempt === null || attempt === undefined) return false
        if (attempt.status !== 'scheduled') return attempt.status === 'removed'
        const settled = await within(worktrees.cleanupOf(session, attempt.revision), CLEANUP_WAIT_MS, null)
        return settled?.status === 'removed'
      } catch (error) {
        warn('could not read the worktree cleanup', error)
        return false
      }
    }

    /**
     * 开新会话：创建、设模型和推理等级、权限、需要时新建工作树、把说明作为第一条消息发出。
     * 中途失败：从存档里删掉它、撤掉挂上的规矩、归档（停下它在做的事）；新建过的工作树交给官方
     * 归档清理，删不掉就在抛出的 StartError 里带上工作树的位置。卡片留着可以重试。
     */
    const startChild = async (parent, card, chosen, signal, { rememberModel = true, beforePrompt } = {}) => {
      const workspaceRegistry = scope.workspaceRegistry
      const created = await scope.sessionController.create(chosen.workspaceId === UNGROUPED
        ? { cwd: parent.session.header.cwd, agentPreset: chosen.agentPreset }
        : { workspaceId: chosen.workspaceId, agentPreset: chosen.agentPreset })
      const childId = created.sessionId
      let child
      let worktree
      try {
        if (beforePrompt !== undefined) signal.throwIfAborted()
        store.addChild(childId, { parentId: parent.session.id, cardId: card.id, title: card.title, startedAt: Date.now() })
        child = await agentOf(childId)
        if (child === undefined) throw new Error('new session did not start')
        attachChild(child)
        await scope.sessionController.selectModel({
          sessionId: childId, provider: chosen.model.provider, model: chosen.model.model,
          ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
        })
        if (chosen.permission !== undefined) {
          const permissions = ctx.get('permissionPresets')
          if (permissions === undefined) throw new Error('permission presets unavailable')
          permissions.set(child.session, chosen.permission)
        }
        if (chosen.worktree) {
          const worktrees = ctx.get('worktrees')
          if (worktrees === undefined) throw new Error('worktrees unavailable')
          worktree = await worktrees.create(child, {}, signal)
        }
        await placeBelow(parent.session.id, childId)
        beforePrompt?.()
        const sent = await scope.sessionController.prompt({ requestId: `wbcard-${randomUUID()}`, sessionId: childId, mode: 'queue', content: [{ type: 'text', text: card.brief }] }, signal)
        if (sent?.accepted === false) throw new Error('first message was not accepted')
      } catch (error) {
        const forget = () => {
          try {
            store.removeChild(childId)
            return true
          } catch (storeError) {
            warn(`could not persist removal of ${childId}`, storeError)
            return false
          }
        }
        const removed = forget()
        clearTimeout(activity.get(childId)?.timer)
        activity.delete(childId)
        const detached = child === undefined ? undefined : detachChild(child)
        let archived = false
        try {
          await workspaceRegistry.archiveSession(childId, { stopActivity: true })
          archived = true
        } catch (archiveError) {
          // 归档不了就留着，用户能在侧边栏看到。
          warn(`could not archive ${childId}`, archiveError)
        }
        if (!removed) forget()
        const left = worktree !== undefined && !(archived && await worktreeRemoved(child.session))
        await detached
        throw new StartError(error, left ? worktree.path : undefined)
      }
      if (rememberModel) {
        try {
          store.setLastModel(chosen.model)
        } catch (error) {
          // 首条消息已提交；保存偏好失败不应把卡片留在可重试的状态。
          warn('could not save the last model', error)
        }
      }
      return childId
    }

    /** 模型看的工具结果：卡片 A、卡片 B 出卡、直接开，或者没能直接开、改成出卡（带原因）。 */
    const resultText = (value) => {
      const text = copy()
      const title = value?.card?.title ?? ''
      if (value?.card?.kind === 'ask') {
        const choice = value.card.ask?.choice
        if (choice === 'new') return fillCopy(text.askStartedAuto, { title })
        if (choice === 'here') return fillCopy(text.askHereAuto, { title })
        return fillCopy(text.askPending, { title })
      }
      if (value?.card?.started !== undefined) return fillCopy(text.startedNow, { title })
      if (typeof value?.notStarted === 'string') return fillCopy(text.notStarted, { title, reason: text.notStartedReasons[value.notStarted] ?? value.notStarted })
      return fillCopy(text.proposed, { title })
    }

    /** 模型看的拒绝理由。 */
    const rejection = (verdict) => {
      const text = copy()
      if (verdict.code === 'child') return text.rejectChild
      if (verdict.code === 'ask-limit') return text.rejectAskLimit
      if (verdict.code === 'limit') return text.rejectLimit
      return { pending: text.rejectPending, started: text.rejectStarted, here: text.rejectHere, dismissed: text.rejectDismissed }[verdict.state] ?? text.rejectPending
    }

    /** 已放行、日志里还没有的提议（日志里有了就不再算）。 */
    const acceptedFor = (session, state) => {
      const known = new Set(state.cards.map(card => card.id))
      return (acceptedNow.get(session) ?? []).filter(item => !known.has(item.callId) && item.turn === state.lastTurn)
    }

    /** 一次调用结束只释放自己占的名额，保留同轮仍在等待日志的调用。 */
    function releaseAccepted(session, callId, turn) {
      const list = acceptedNow.get(session)
      if (list === undefined) return
      const at = list.findIndex(item => item.turn === turn && item.callId === callId)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) acceptedNow.delete(session)
    }

    const requireLiveAsk = (agent, signal) => {
      signal?.throwIfAborted()
      if (!alive || scope.agents.get(agent.id) !== agent || scope.workspaceRegistry.archivedSessionIds?.includes(agent.id)) {
        throw new DOMException('Session is no longer active', 'AbortError')
      }
    }

    const withAskParent = async (agent, callerSignal, run) => {
      const controller = new AbortController()
      const signal = callerSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, callerSignal])
      const task = Promise.resolve().then(() => {
        requireLiveAsk(agent, signal)
        return run(signal)
      })
      const operation = { agent, controller, task }
      askOperations.add(operation)
      try {
        return await task
      } finally {
        askOperations.delete(operation)
      }
    }

    /** 预设和模型目录不接受 signal。只中止对只读答复的等待；已发起的创建、投递和回滚要等确切结果。 */
    const readAskChoices = async (agent, signal, options) => {
      signal.throwIfAborted()
      const cancelled = Promise.withResolvers()
      const abort = () => cancelled.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      try {
        return await Promise.race([choicesOf(agent, options), cancelled.promise])
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }

    /** A 没有选项面板。先核对一次，准备完成后、实际投递首条消息前再核对当时的父会话。 */
    const startAskChild = (agent, card, callId, callerSignal) => withAskParent(agent, callerSignal, async signal => {
      const choices = await readAskChoices(agent, signal, { forAskStart: true })
      requireLiveAsk(agent, signal)
      const current = currentOf(agent)
      let chosen
      try {
        chosen = compactOptions(validateStartOptions(cardDefaults({ current, choices }), choices))
        // 未选等级时让模型按自己的默认值运行，不把选择器显示的默认等级写成显式设置。
        if (current.reasoningEffort === undefined) delete chosen.reasoningEffort
      } catch (error) {
        if (error?.code === 'invalid-options') {
          const field = error.field
          return { notStarted: field === 'workspace' || field === 'permission' ? field : 'options' }
        }
        throw error
      }
      const blockedBy = parent => {
        if (chosen.agentPreset !== parent.agentPreset || chosen.model.provider !== parent.model?.provider
          || chosen.model.model !== parent.model?.model || chosen.reasoningEffort !== parent.reasoningEffort) return 'options'
        if (chosen.permission !== parent.permission) return 'permission'
        const permissions = ctx.get('permissionPresets')
        const resolve = typeof permissions?.resolve === 'function' ? name => permissions.resolve(name) : undefined
        return directStartBlock(chosen, parent, resolve)
      }
      const notStarted = blockedBy(current)
      if (notStarted !== undefined) return { notStarted }
      const beforePrompt = () => {
        requireLiveAsk(agent, signal)
        const reason = blockedBy(currentOf(agent))
        if (reason !== undefined) throw new CardError(reason)
      }
      try {
        const childId = await startChild(agent, { ...card, id: callId }, chosen, signal, { rememberModel: false, beforePrompt })
        return { childId, options: chosen }
      } catch (error) {
        if (error instanceof StartError && error.cause instanceof CardError) return { notStarted: error.cause.code }
        throw error
      }
    })

    /** 执行卡片 A（ask: true）：按设置直接开、在当前会话处理，或立即返回轮末待处理卡。 */
    const runAskProposal = async (agent, args, exec) => {
      const { ownSession } = readOwnSessionPrefs(workbenchDataDir())
      const card = { title: args.title, brief: args.brief }
      if (ownSession === 'always-new') {
        const started = await startAskChild(agent, card, exec.callId, exec.signal)
        if (started.childId !== undefined) {
          return { ok: true, card: { ...card, options: started.options, kind: 'ask', ask: { choice: 'new', auto: 'setting' }, started } }
        }
        return { ok: true, card: { ...card, options: {}, kind: 'ask' } }
      }
      if (ownSession === 'always-here') return withAskParent(agent, exec.signal, async signal => {
        let choices
        try {
          choices = await readAskChoices(agent, signal)
        } catch (error) {
          requireLiveAsk(agent, signal)
          warn('could not read the own-session options', error)
        }
        requireLiveAsk(agent, signal)
        let options = {}
        try {
          options = compactOptions(cardDefaults({ current: currentOf(agent), choices }))
        } catch (error) {
          // 没有子会话需要创建；即使连当前工作区也取不到，仍保留设置结果。
          warn('could not read the current session options', error)
        }
        return { ok: true, card: { ...card, options, kind: 'ask', ask: { choice: 'here', auto: 'setting' } } }
      })
      requireLiveAsk(agent, exec.signal)
      return { ok: true, card: { ...card, options: {}, kind: 'ask' } }
    }

    scope.effect(() => scope.tools.register(defineTool({
      name: PROPOSE_TOOL,
      description: copy().toolDescription,
      parameters: {
        title: { type: 'string', required: true, description: copy().title },
        brief: { type: 'string', required: true, description: copy().brief },
        ask: { type: 'boolean', description: copy().askParam },
        options: {
          type: 'object',
          description: copy().options,
          additionalProperties: false,
          properties: {
            workspace: { type: 'string', description: copy().workspace },
            worktree: { type: 'boolean', description: copy().worktree },
            agentPreset: { type: 'string', description: copy().agentPreset },
            model: { type: 'string', description: copy().model },
            reasoningEffort: { type: 'string', description: copy().reasoningEffort },
            permission: { type: 'string', description: copy().permission },
          },
        },
        userQuote: { type: 'string', description: copy().userQuote },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: resultText(value) }],
        presentationMeta: (_args, value) => value,
      },
      async execute(rawArgs, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new Error('propose_session needs a session')
        let args
        try {
          args = proposalArgsOf(rawArgs)
        } catch (error) {
          if (error?.code === 'ask-args') throw new Error(copy().rejectAskArgs, { cause: error })
          throw error
        }
        if (agent.session.header.origin === 'subagent') throw new Error(copy().rejectSubagent)
        const state = projection.stateOf(agent.session)
        const accepted = acceptedFor(agent.session, state)
        const verdict = checkProposal({
          cards: state.cards, turn: state.lastTurn, title: args.title,
          isChild: store.linkOf(agent.session.id) !== undefined, ask: args.ask === true, accepted,
        })
        if (!verdict.ok) throw new Error(rejection(verdict))
        // 在第一个 await 之前占住名额：同一步里并行的几次调用不会一起越过一轮一问／三张的上限。
        accepted.push({ callId: exec.callId, turn: state.lastTurn, key: titleKey(args.title), ask: args.ask === true })
        acceptedNow.set(agent.session, accepted)
        try {
          if (args.ask === true) return await runAskProposal(agent, args, exec)
          const choices = await choicesOf(agent)
          const proposed = resolveProposedOptions(args.options, choices)
          const card = { title: args.title, brief: args.brief, options: proposed }
          if (args.userQuote === undefined) return { ok: true, card }
          // 直接开：用户这一轮亲口要求另开会话，并且不越过当前会话（工作区相同、权限不更高，
          // 按当前会话实际的权限比）。不满足的照样出卡（选项照模型给的），等用户点「开始」。
          if (!quoteFromUser(args.userQuote, state.turnText)) return { ok: true, card, notStarted: 'quote' }
          const current = currentOf(agent)
          let chosen
          try {
            chosen = validateStartOptions(cardDefaults({ proposed, current, lastModel: store.lastModel(), choices }), choices)
          } catch (error) {
            if (error?.code === 'invalid-options') return { ok: true, card, notStarted: 'options' }
            throw error
          }
          const permissions = ctx.get('permissionPresets')
          const resolvePermission = typeof permissions?.resolve === 'function' ? name => permissions.resolve(name) : undefined
          const blocked = directStartBlock(chosen, current, resolvePermission)
          if (blocked !== undefined) return { ok: true, card, notStarted: blocked }
          const childId = await startChild(agent, { id: exec.callId, title: args.title, brief: args.brief }, chosen, exec.signal)
          return { ok: true, card: { ...card, started: { childId, options: chosen } } }
        } catch (error) {
          releaseAccepted(agent.session, exec.callId, state.lastTurn)
          if (error instanceof StartError && error.worktree !== undefined) throw new Error(`${error.message} ${fillCopy(copy().worktreeLeft, { path: error.worktree })}`, { cause: error })
          throw error
        }
      },
      presentCall: args => ({ card: 'generic', title: PROPOSE_TOOL, kind: 'other', rawInput: typeof args?.title === 'string' ? args.title : '' }),
    })), 'session-cards tool')

    // 工具先登记、再给已加载的新会话挂规矩：tools.restrict 认不出还没登记的全局工具（这一行
    // 关了再开时，新会话早已加载）。这一行关掉时先撤这些规矩，再撤工具。
    scope.effect(() => async () => {
      alive = false
      const operations = [...askOperations]
      for (const { controller } of operations) controller.abort()
      await Promise.allSettled([...operations.map(operation => operation.task), ...[...childRules.keys()].map(detachChild)])
    }, 'session-cards child rules')
    scope.on('agent/created', ({ agent }) => { attachChild(agent) })
    scope.on('agent/disposed', ({ agent }) => {
      for (const operation of askOperations) if (operation.agent === agent) operation.controller.abort()
      return detachChild(agent)
    })
    scope.on('workspace/session-archived', ({ sessionId }) => {
      for (const operation of askOperations) if (operation.agent.id === sessionId) operation.controller.abort()
    })
    for (const entry of scope.agents.list()) attachChild(scope.agents.get(entry.id))

    /** 网页送来的会话 id。 */
    const sessionIdOf = (value) => {
      if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new CardError('invalid-session')
      return value
    }

    /** 以用户的名义向父会话发「在当前会话处理」这一句；只认中英固定写法，别的照宿主语言。 */
    const sendHerePrompt = async (parent, card, body, signal) => {
      const allowed = Object.values(SESSION_CARDS_HOST).map(text => fillCopy(text.here, { title: card.title }))
      const words = allowed.includes(body.text) ? body.text : fillCopy(copy().here, { title: card.title })
      const sent = await scope.sessionController.prompt({ requestId: `wbcard-${randomUUID()}`, sessionId: parent.session.id, mode: 'queue', content: [{ type: 'text', text: words }] }, signal)
      if (sent?.accepted === false) throw new CardError('send-failed', 409)
    }

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-workbench.session-cards.context',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const query = new URL(request.url).searchParams
          const agent = await agentOf(sessionIdOf(query.get('sessionId')))
          if (agent === undefined) throw new CardError('session-unavailable', 404)
          const choices = await choicesOf(agent)
          return json({ ok: true, value: { current: currentOf(agent), lastModel: store.lastModel() ?? null, choices } })
        } catch (error) {
          return json({ ok: false, error: { code: error instanceof CardError ? error.code : 'context-failed' } }, error instanceof CardError ? error.status : 500)
        }
      },
    }), 'session-cards context route')

    /** 已被 DSH 接受的动作只补记，不再投递；重试须返回第一次的选择及偏好保存结果。 */
    const recordDelivery = (parent, attempt, receipt, retryVerb) => {
      try {
        // 投递期间父会话可能重新加载；记录应写进现在的会话实例。
        const session = scope.agents.get(parent.id)?.session ?? parent.session
        appendPluginRecord(session, CARD_RECORD, receipt.record)
      } catch (error) {
        warn('could not record the delivered card action', error)
        try { attempt.save(receipt) } catch (saveError) { warn('could not persist the delivery receipt', saveError) }
        throw new CardError('record-pending', 503)
      }
      if (retryVerb !== undefined) {
        try { attempt.clear() } catch (error) { warn('could not clear the delivery receipt', error) }
        if (receipt.record.action !== retryVerb) throw new CardError('card-decided', 409)
      }
      return json({ ok: true, ...(receipt.notSaved ? { notSaved: true } : {}),
        ...(receipt.record.action === 'start' ? { value: { childId: receipt.record.childId } } : {}) })
    }

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dsh-workbench.session-cards.act',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let lock
        let delivery
        /** 这次的动作（出错时按它给代码：开始失败、消息没发出）。 */
        let verb
        try {
          const body = await request.json()
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new CardError('invalid-input')
          verb = typeof body.verb === 'string' ? body.verb : undefined
          const parent = await agentOf(sessionIdOf(body.sessionId))
          if (parent === undefined) throw new CardError('session-unavailable', 404)
          const card = projection.stateOf(parent.session).cards.find(item => item.id === body.cardId)
          if (card === undefined) throw new CardError('card-not-found', 404)
          if (card.state !== 'pending') throw new CardError('card-decided', 409)
          let remember
          if (card.kind === 'ask') {
            requireLiveAsk(parent)
            if (body.verb !== 'start' && body.verb !== 'here') throw new CardError('invalid-input')
            if (body.remember !== undefined) {
              if (body.verb === 'start' && body.remember !== 'always-new') throw new CardError('invalid-input')
              if (body.verb === 'here' && body.remember !== 'always-here') throw new CardError('invalid-input')
              remember = body.remember
            }
          } else if (body.remember !== undefined) {
            throw new CardError('invalid-input')
          }
          if (card.kind === 'ask') {
            const attempt = askDelivery(workbenchDataDir(), parent.session.id, card.id)
            if (!attempt.claim()) throw new CardError('busy', 409)
            delivery = attempt

            const delivered = attempt.read()
            if (delivered !== undefined) return recordDelivery(parent, attempt, delivered, body.verb)

            let notSaved = false
            if (remember !== undefined) {
              try {
                writeOwnSessionPrefs(workbenchDataDir(), { ownSession: remember })
              } catch (error) {
                warn('could not save the own-session preference', error)
                notSaved = true
              }
            }
            const record = { cardId: card.id, action: body.verb, ...(remember === undefined ? {} : { remember }) }
            if (body.verb === 'here') {
              await sendHerePrompt(parent, card, body, request.signal)
            } else {
              // 页面刷新不该打断正在创建的会话。
              const started = await startAskChild(parent, card, card.id, AbortSignal.timeout(START_TIMEOUT_MS))
              if (started.notStarted !== undefined) {
                return json({ ok: false, error: { code: 'ask-not-inheritable', reason: started.notStarted } }, 409)
              }
              record.childId = started.childId
              record.options = started.options
            }
            return recordDelivery(parent, attempt, { sessionId: parent.session.id, record, notSaved })
          }
          const key = `${parent.session.id}\0${card.id}`
          if (busyCards.has(key)) throw new CardError('busy', 409)
          lock = key
          busyCards.add(lock)
          if (body.verb === 'dismiss') {
            appendPluginRecord(parent.session, CARD_RECORD, { cardId: card.id, action: 'dismiss' })
            return json({ ok: true })
          }
          if (body.verb === 'here') {
            await sendHerePrompt(parent, card, body, request.signal)
            appendPluginRecord(parent.session, CARD_RECORD, { cardId: card.id, action: 'here' })
            return json({ ok: true })
          }
          if (body.verb !== 'start') throw new CardError('invalid-input')
          let chosen
          try {
            chosen = validateStartOptions(body.options, await choicesOf(parent))
          } catch (error) {
            if (error?.code === 'invalid-options') return json({ ok: false, error: { code: 'invalid-options', field: error.field } }, 400)
            throw error
          }
          // 不跟网页请求一起取消：页面刷新不该把正在建的会话打断到一半。
          const childId = await startChild(parent, card, chosen, AbortSignal.timeout(START_TIMEOUT_MS))
          appendPluginRecord(parent.session, CARD_RECORD, { cardId: card.id, action: 'start', childId, options: chosen })
          return json({ ok: true, value: { childId } })
        } catch (error) {
          if (error instanceof CardError) return json({ ok: false, error: { code: error.code } }, error.status)
          warn(verb ?? 'act', error)
          // 新建的工作树没能删掉时，告诉网页它留在哪里。
          const worktree = error instanceof StartError && error.worktree !== undefined ? { worktree: error.worktree } : {}
          const code = verb === 'start' ? 'start-failed' : verb === 'here' ? 'send-failed' : 'act-failed'
          return json({ ok: false, error: { code, ...worktree } }, 500)
        } finally {
          delivery?.release()
          if (lock !== undefined) busyCards.delete(lock)
        }
      },
    }), 'session-cards act route')
  })
}

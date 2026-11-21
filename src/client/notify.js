/**
 * 系统通知（dsh-workbench/notify 的网页部分，计划第 3 项，样稿「系统通知」A、B）。
 *
 * 订阅 ctx.uiSession.sessionStatus（running、pendingInteraction、completionUnread）：
 * 会话完成、等待审批、等待回答、计划待审，而 DSH 不在前台时，发系统通知（网页的
 * Notification）；标题是会话名，正文只写状态（DSH 侧栏的词）。同一会话连续变化只留
 * 最新一条（新的通知出来前先关掉旧的）。点通知回到 DSH 并打开那个会话。
 *
 * 预设的排除：会话列表快照里只有这台客户端建过投影缓存的会话才带 agentPreset，所以
 * 要发通知又不知道预设时，先 refreshProjections 补齐再决定；还读不到就照常发，同时记
 * 一条日志（notificationsBetween 保持纯函数，补齐在 admitUnknownPresets）。
 *
 * 配置存宿主（/api/dsh-workbench.notify.config，文件在 $DSH_HOME/dsh-workbench/notify.json）：
 * 通知哪几种事件、不通知哪些预设的会话（默认排除指定预设）、DSH 在前台时也通知、
 * 通知里显示回复的第一句。配置页挂在插件页这一行的「配置」上（plugins.row.config）。
 */
import { settingsFormLabels } from './copy.js'
import { clientPlatform } from './features.js'

/** 事件键 → 词条键（完成、等待审批、等待回答、计划待审）。 */
const EVENT_KIND = { approval: 'approval', question: 'question', 'plan-review': 'planReview' }

/** 默认不通知的预设（和宿主 lib/notify-state.js 的 DEFAULT_EXCLUDED_PRESETS 一致，改的时候一起改）。 */
const DEFAULT_EXCLUDED_PRESETS = ['whale', 'whale-dream']

/** 客户端起手的默认配置（真正的配置从宿主读）。 */
export function defaultConfig() {
  return {
    events: { completed: true, approval: true, question: true, planReview: true },
    excludedPresets: [...DEFAULT_EXCLUDED_PRESETS],
    notifyForeground: false,
    showFirstLine: false,
  }
}

/**
 * 两个 sessionStatus 快照之间该发哪些通知。纯函数：前台判断、预设和标题的查表都由
 * 调用方注入，测试里好造。
 * @param {Map|null} prev 上一个快照（null 表示刚起步，不触发）。
 * @param {Map} next 当前快照（sessionId → {running, pendingInteraction}）。
 * @param {object} config 当前配置。
 * @param {boolean} frontmost DSH 是否在前台。
 * @param {(sessionId: string) => string | undefined} presetOf 会话 → 已知的预设 id。
 * @returns {{sessionId: string, event: string}[]} 该发的通知。
 */
export function notificationsBetween(prev, next, config, frontmost, presetOf) {
  if (prev === null) return []
  if (frontmost && !config.notifyForeground) return []
  const batch = []
  for (const [sessionId, status] of next) {
    const before = prev.get(sessionId)
    const event = eventEdgeOf(before, status)
    if (event === undefined) continue
    if (!config.events[event]) continue
    const preset = presetOf(sessionId)
    if (preset !== undefined && config.excludedPresets.includes(preset)) continue
    batch.push({ sessionId, event })
  }
  return batch
}

/** 一个会话这次变化落在哪种事件上（一次变化只报一种，等待类的变化优先于完成）。 */
function eventEdgeOf(before, status) {
  const interaction = status?.pendingInteraction
  if (interaction !== undefined) {
    const kind = EVENT_KIND[interaction.kind]
    if (kind !== undefined && before?.pendingInteraction?.key !== interaction.key) return kind
    return undefined
  }
  if (before?.running === true && status?.running === false) return 'completed'
  return undefined
}

/**
 * 候选里预设未知的（列表快照还没带 agentPreset）：先补齐再决定去留。已知预设的候选
 * notificationsBetween 已按排除表过滤过，直接保留。
 * @param {{sessionId: string, event: string}[]} candidates 候选通知。
 * @param {object} config 当前配置。
 * @param {{presetOf: (sessionId: string) => string | undefined, refreshPresetOf: (sessionId: string) => Promise<string | undefined>, onUnknownPreset: (sessionId: string) => void}} deps 查表、补齐和日志。
 * @returns {Promise<{sessionId: string, event: string}[]>} 去留之后的候选。
 */
export async function admitUnknownPresets(candidates, config, deps) {
  const admitted = []
  for (const item of candidates) {
    if (deps.presetOf(item.sessionId) !== undefined) {
      admitted.push(item)
      continue
    }
    const refreshed = await deps.refreshPresetOf(item.sessionId)
    if (refreshed !== undefined && config.excludedPresets.includes(refreshed)) continue
    if (refreshed === undefined) deps.onUnknownPreset(item.sessionId)
    admitted.push(item)
  }
  return admitted
}

/** 通知配置的读取器：宿主是真身，这里只是缓存；配置页保存成功后用宿主回答里的配置调 set，正在跑的监听下一次就用新的。 */
function createNotifyConfig(app) {
  let config = defaultConfig()
  const load = async () => {
    try {
      const response = await fetch('api/dsh-workbench.notify.config', { credentials: 'same-origin' })
      if (response.ok) {
        const body = await response.json()
        config = adoptConfig(body, config)
      }
    } catch {
      // 读不到就先用起手配置。
    }
    return config
  }
  return { load, get: () => config, set: (next) => { config = next } }
}

/** 从接口回答里挑认识的字段；不认识的忽略，缺的保持原值。 */
function adoptConfig(body, fallback) {
  if (typeof body !== 'object' || body === null) return fallback
  const events = { ...fallback.events }
  for (const key of Object.keys(events)) {
    if (typeof body.events?.[key] === 'boolean') events[key] = body.events[key]
  }
  const excludedPresets = Array.isArray(body.excludedPresets)
    ? body.excludedPresets.filter(preset => typeof preset === 'string' && preset !== '')
    : fallback.excludedPresets
  return {
    events,
    excludedPresets,
    notifyForeground: body.notifyForeground === true,
    showFirstLine: body.showFirstLine === true,
  }
}

/** DSH 在不在前台（别的程序在最前时页面没有焦点）。 */
function isFrontmost() {
  return document.hasFocus()
}

/** 发通知；同一会话只留最新一条。点通知回到 DSH 并打开那个会话。 */
function createNotifier(app) {
  const live = new Map()
  return {
    show(sessionId, title, body) {
      if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
      live.get(sessionId)?.close()
      const notification = new Notification(title, { body })
      notification.onclick = () => {
        try { window.focus() } catch { /* 拒绝聚焦就算了：打开会话仍会执行 */ }
        app.ctx.get('uiWorkspace')?.openSession(sessionId)
      }
      live.set(sessionId, notification)
      notification.onclose = () => { if (live.get(sessionId) === notification) live.delete(sessionId) }
    },
  }
}

/** 尽力读一条会话里最后一条回复的第一句（「在通知里显示回复的第一句」开着时用）。 */
async function replyFirstLine(app, sessionId) {
  const sessions = app.ctx.sessions
  if (sessions === undefined) return undefined
  let reference
  try {
    reference = sessions.retain(sessionId, { source: 'workbenchNotify' })
    await reference.ready
  } catch {
    reference?.release()
    return undefined
  }
  try {
    const entries = reference.binding.eventSource.getSnapshot().entries
    for (let at = entries.length - 1; at >= 0; at--) {
      const entry = entries[at]
      if (entry?.type !== 'assistant/message') continue
      const text = blocksText(entry.data?.message?.content)
      const line = text.trim().split('\n')[0] ?? ''
      return line === '' ? undefined : (line.length > 60 ? `${line.slice(0, 60)}…` : line)
    }
    return undefined
  } catch {
    return undefined
  } finally {
    reference.release()
  }
}

/** 从消息的内容块里拼文字。 */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

/** 会话用的预设（列表行里带着投影值；没有就 undefined，由 admitUnknownPresets 补齐）。 */
function presetReader(app) {
  const read = (sessionId) => {
    const summary = app.ctx.sessions?.list.getSnapshot().byId[sessionId]
    const preset = summary?.projectionValues?.agentPreset
    return typeof preset === 'string' ? preset : undefined
  }
  const refresh = async (sessionId) => {
    try {
      await app.ctx.sessions?.refreshProjections(sessionId)
    } catch {
      return undefined
    }
    return read(sessionId)
  }
  return { read, refresh }
}

/**
 * 订阅会话状态，按状态转换发通知；返回停订函数。
 * @param {object} app 入口上下文。
 * @param {object} configStore 配置读取器。
 * @returns {() => void} 停订函数。
 */
function startWatcher(app, configStore) {
  const notifier = createNotifier(app)
  const presets = presetReader(app)
  // 客户端守卫的 ctx 不暴露 logger，日志直接进网页控制台。
  const log = console
  let prev = null
  const onStatus = () => {
    const next = app.ctx.uiSession.sessionStatus.getSnapshot()
    const candidates = notificationsBetween(prev, next, configStore.get(), isFrontmost(), presets.read)
    prev = next
    void admitUnknownPresets(candidates, configStore.get(), {
      presetOf: presets.read,
      refreshPresetOf: presets.refresh,
      onUnknownPreset: (sessionId) => { log.warn(`dsh-workbench/notify: 会话 ${sessionId} 的预设没读到，照常通知`) },
    }).then((batch) => {
      for (const { sessionId, event } of batch) {
        const summary = app.ctx.sessions?.list.getSnapshot().byId[sessionId]
        const title = summary?.displayTitle ?? sessionId
        const state = app.t(`notify.state.${event}`)
        if (event === 'completed' && configStore.get().showFirstLine) {
          void replyFirstLine(app, sessionId).then(line => {
            notifier.show(sessionId, title, line === undefined ? state : `${state}：${line}`)
          })
        } else {
          notifier.show(sessionId, title, state)
        }
      }
    }).catch(error => { log.warn(`dsh-workbench/notify: 决定通知时出错：${error instanceof Error ? error.message : String(error)}`) })
  }
  const dispose = app.ctx.effect(() => app.ctx.uiSession.sessionStatus.subscribe(onStatus), '@miint-sunny/dsh-workbench/notify: session status watcher')
  return () => dispose()
}

// ---------- 配置页（插件页 → 工作台 → 系统通知 → 配置） ----------

/**
 * 配置页里写到操作系统的三句（概要、第一句的说明、权限说明）用哪组词条。插件页这一行的概要也用这组的 summary。
 * @param {'macos' | 'windows' | 'linux'} platform clientPlatform() 的结果。
 * @returns {{summary: string, showFirstLineHint: string, permissionInfo: string}} 词条键；Windows 以外的平台照 macOS 的原句。
 */
function notifyPageCopy(platform) {
  return platform === 'windows'
    ? { summary: 'notify.page.summaryWindows', showFirstLineHint: 'notify.page.showFirstLineHintWindows', permissionInfo: 'notify.page.permissionInfoWindows' }
    : { summary: 'notify.page.summary', showFirstLineHint: 'notify.page.showFirstLineHint', permissionInfo: 'notify.page.permissionInfo' }
}

/** 配置页。 */
function NotifyConfigPage(props) {
  const { app } = props
  const [loaded, setLoaded] = useState(undefined)
  const [draft, setDraft] = useState(undefined)
  const [presets, setPresets] = useState([])
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(undefined)
  useEffect(() => {
    void (async () => {
      const config = await app.notifyConfig.load()
      setLoaded(config)
      setDraft(config)
      const roster = await app.ctx.remote.agentPresets?.list?.()
      if (roster?.ok) setPresets(roster.value.presets)
    })()
  }, [])
  if (draft === undefined) return null
  const t = app.t
  const copy = notifyPageCopy(clientPlatform())
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded)
  const toggleEvent = (key) => setDraft(current => ({ ...current, events: { ...current.events, [key]: !current.events[key] } }))
  const togglePreset = (id) => setDraft(current => ({
    ...current,
    excludedPresets: current.excludedPresets.includes(id)
      ? current.excludedPresets.filter(preset => preset !== id)
      : [...current.excludedPresets, id],
  }))
  const toggleFlag = (key) => setDraft(current => ({ ...current, [key]: !current[key] }))
  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch('api/dsh-workbench.notify.config', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body?.ok !== true) throw new Error(body?.message ?? `HTTP ${response.status}`)
      const config = adoptConfig(body.config, draft)
      app.notifyConfig.set(config)
      setLoaded(config)
      setDraft(config)
      setFailed(undefined)
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  const eventRows = [['completed', 'notify.page.event.completed'], ['approval', 'notify.page.event.approval'], ['question', 'notify.page.event.question'], ['planReview', 'notify.page.event.planReview']]
  return h('div', { className: 'dwb-notify-page' },
    h('p', { className: 'dwb-notify-hint' }, t(copy.summary)),
    h('div', { className: 'dwb-notify-group' },
      h('h4', null, t('notify.page.events')),
      ...eventRows.map(([key, label]) => h(ui.Checkbox, {
        key, checked: draft.events[key], label: t(label), onChange: () => { toggleEvent(key); setFailed(undefined) },
      }))),
    h('div', { className: 'dwb-notify-group' },
      h('h4', null, t('notify.page.presets')),
      ...presets.map(preset => h(ui.Checkbox, {
        key: preset.id,
        checked: draft.excludedPresets.includes(preset.id),
        label: preset.name ?? preset.id,
        onChange: () => { togglePreset(preset.id); setFailed(undefined) },
      }))),
    h('div', { className: 'dwb-notify-group' },
      h('h4', null, t('notify.page.other')),
      h(ui.Checkbox, { checked: draft.notifyForeground, label: t('notify.page.notifyForeground'), onChange: () => { toggleFlag('notifyForeground'); setFailed(undefined) } }),
      h('div', null,
        h(ui.Checkbox, { checked: draft.showFirstLine, label: t('notify.page.showFirstLine'), onChange: () => { toggleFlag('showFirstLine'); setFailed(undefined) } }),
        h('p', { className: 'dwb-notify-hint' }, t(copy.showFirstLineHint)))),
    h('div', { className: 'dwb-notify-info' }, t(copy.permissionInfo)),
    h(ui.SettingsForm, {
      labels: settingsFormLabels(t, failed, 'notify.form.unavailable'),
      state: { available: true, writable: true, dirty, invalid: false, saving, failed: failed !== undefined },
      onSave: () => { void save() },
      onDiscard: () => { setDraft(loaded); setFailed(undefined) },
    }))
}

/** plugins.row.config 的条目：summary 一句话，page 是配置页。 */
function NotifyConfigEntry(props) {
  const { app, view } = props
  return view === 'summary' ? app.t(notifyPageCopy(clientPlatform()).summary) : h(NotifyConfigPage, { app })
}

/**
 * 挂通知功能：会话状态订阅 + 配置页；返回撤销函数（那一行关掉时入口调用）。
 * @param {object} app 入口准备的上下文。
 * @returns {() => void} 撤销函数。
 */
function applyNotify(app) {
  const { ctx } = app
  app.notifyConfig = createNotifyConfig(app)
  const stopWatcher = app.notifyConfig.load().then(() => startWatcher(app, app.notifyConfig)).catch(() => () => {})
  const disposers = [
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
      { name: 'plugins.row.config', key: '@miint-sunny/dsh-workbench#dsh-workbench-notify', locale: '@miint-sunny/dsh-workbench' },
      (props) => h(NotifyConfigEntry, { app, ...props }))),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    void stopWatcher.then(stop => stop())
  }
}

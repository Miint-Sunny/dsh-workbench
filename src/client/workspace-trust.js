/**
 * 工作区信任（dsh-workbench/workspace-trust，feat#121）的网页端。
 *
 * dsh-better-sidebar 打过工作台补丁后，它的 HtmlPreviewFrame 每次渲染都看 `globalThis.__dshWorkbenchHtmlPreviewFrame`：
 * 在时把预览交给这里的 WorkspaceTrustFrame（并把原来的预览框作为 Frame 传进来），不在时照原样渲染，原样渲染时
 * 自带的 fetchInlineResource 什么都不读。这里只在它会内联的时候（沙箱开着、桌面壳 `dsh-app:`）加一个外框：
 * 上面是说明条，下面是原来的预览框，并给它一个按工作区信任取资源的读取函数（fetchInlineResource 属性）。
 * 每次打开或切换文档都重新预检；本次回答回来前不挂预览框。信任或撤销后版本号加一，预览框重新挂载、重新内联。
 *
 * 浏览器一侧只做便宜的分类（不是同一个会话的 /sidebar/html/ 地址直接拦下；没信任时不发请求），
 * 边界检查和读取都在宿主端（lib/workspace-trust-read.js）。设计见 docs/plans/2026-11-13-工作区信任.md。
 */
import { classifyPreviewResource } from '../../lib/workspace-trust-route.js'
import { mountModuleStyle } from './style.js'
import { createConcurrencyGate, createTrustRecord, displayOfUrl, previewDocumentOf, previewInlines, previewInteractive, trustNoticeOf, TRUST_MAX_INFLIGHT } from './workspace-trust-model.js'

const WORKSPACE_TRUST_GLOBAL = '__dshWorkbenchHtmlPreviewFrame'
const WORKSPACE_TRUST_PAGE = 'dsh-workbench-workspace-trust'
const WORKSPACE_TRUST_API = 'api/dsh-workbench.workspace-trust'

/**
 * 宿主端信任状态在网页端的缓存。按会话和文档路径记状态；信任、撤销、重试之后，状态变了的文档版本号加一。
 * @param {(url: string, init?: object) => Promise<Response>} [request] fetch（测试注入）。
 * @returns {object} 状态缓存和请求方法。
 */
function createTrustClient(request = (url, init) => fetch(url, init)) {
  const documents = new Map()
  const keyOf = ref => JSON.stringify([ref.sessionId, ref.path])
  const pending = new Map()
  const listeners = new Set()
  const emit = () => { for (const listener of [...listeners]) listener() }
  // POST 要带的令牌只由 GET 列表回答（见 lib/workspace-trust.js）；宿主端重启后换了，就重新取一次再发。
  let token
  const readList = async () => {
    const response = await request(WORKSPACE_TRUST_API, { credentials: 'same-origin' })
    const value = await response.json()
    if (!response.ok || value?.ok !== true || !Array.isArray(value.workspaces)) throw new Error('list')
    if (typeof value.token === 'string') token = value.token
    return value.workspaces
  }
  const post = async (path, body, signal) => {
    if (token === undefined) await readList()
    const attempt = () => request(path, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-workbench-trust': token ?? '' }, body: JSON.stringify(body), signal,
    })
    let response = await attempt()
    if (response.status === 403) {
      const reason = await response.clone().json().then(value => value?.reason, () => undefined)
      if (reason === 'forbidden') {
        await readList()
        response = await attempt()
      }
    }
    return response
  }
  const send = async (path, body, signal) => {
    const response = await post(path, body, signal)
    let value
    try {
      value = await response.json()
    } catch {
      value = undefined
    }
    return { ok: response.ok, value }
  }
  const load = (documentRef, { bump = false } = {}) => {
    const key = keyOf(documentRef)
    const before = documents.get(key)
    // 首次预检还在途的文档也参与信任变更后的刷新。
    if (before === undefined) documents.set(key, { state: 'loading', documentRef, revision: 0 })
    const job = (async () => {
      let next
      try {
        const { ok, value } = await send(WORKSPACE_TRUST_API, { action: 'status', sessionId: documentRef.sessionId, documentPath: documentRef.path })
        if (!ok || value?.ok !== true) throw new Error('status')
        const trusted = value.trusted === true
        const documentInside = value.documentInside === true
        const changed = before?.state === 'ready' && (before.trusted !== trusted || before.documentInside !== documentInside || before.realRoot !== value.realRoot)
        next = { state: 'ready', documentRef, trusted, documentInside, root: value.root, realRoot: value.realRoot, display: value.display, revision: (before?.revision ?? 0) + (changed || bump ? 1 : 0) }
      } catch {
        next = { ...before, documentRef, state: 'error', revision: (before?.revision ?? 0) + (bump ? 1 : 0) }
      }
      // 撤销或重试可能已发出更新的查询；旧响应不能覆盖它，也不能交给等候中的资源读取器。
      if (pending.get(key) !== job) return pending.get(key) ?? documents.get(key)
      documents.set(key, next)
      pending.delete(key)
      emit()
      return next
    })()
    pending.set(key, job)
    return job
  }
  const reloadAll = () => Promise.all([...documents.values()].map(status => load(status.documentRef)))
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    status: ref => ref === null ? undefined : documents.get(keyOf(ref)),
    /** 状态回来之后的值；已有就直接给，正在读就等它。 */
    ready(documentRef) {
      const key = keyOf(documentRef)
      if (pending.has(key)) return pending.get(key)
      const known = documents.get(key)
      return known !== undefined ? Promise.resolve(known) : load(documentRef)
    },
    load,
    async trust(sessionId) {
      let result
      try {
        result = await send(WORKSPACE_TRUST_API, { action: 'trust', sessionId })
      } catch {
        return { ok: false, reason: 'failed' }
      }
      if (!result.ok || result.value?.ok !== true) return { ok: false, reason: typeof result.value?.reason === 'string' ? result.value.reason : 'failed' }
      await reloadAll()
      return { ok: true }
    },
    list: readList,
    async revoke(path) {
      const { ok, value } = await send(WORKSPACE_TRUST_API, { action: 'revoke', path })
      if (!ok || value?.ok !== true || !Array.isArray(value.workspaces)) throw new Error('revoke')
      await reloadAll()
      return value.workspaces
    },
    async readResource(document, resource, signal) {
      const response = await post(`${WORKSPACE_TRUST_API}.resource`, { document, resource }, signal)
      if (response.ok) {
        const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream'
        return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()), mediaType }
      }
      let value
      try {
        value = await response.json()
      } catch {
        value = undefined
      }
      return { ok: false, reason: typeof value?.reason === 'string' ? value.reason : 'error', display: typeof value?.display === 'string' ? value.display : undefined }
    },
  }
}

/** 这一行挂着时的状态缓存和文字；撤下时清空。 */
let workspaceTrustClient = null
let workspaceTrustT = key => key
const workspaceTrustListeners = new Set()
const subscribeWorkspaceTrust = listener => {
  workspaceTrustListeners.add(listener)
  return () => { workspaceTrustListeners.delete(listener) }
}
const publishWorkspaceTrust = () => { for (const listener of [...workspaceTrustListeners]) listener() }

/**
 * 给 better-sidebar 内联器的读取函数（一个文档、一个信任版本一份）。返回 undefined 表示不内联，引用保持原样。
 * @param {{ client: object, documentUrl: string, documentRef: object | null, record: object }} options 参数。
 * @returns {(url: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array, mediaType: string } | undefined>} 读取函数。
 */
function createTrustReader({ client, documentUrl, documentRef, record }) {
  const gate = createConcurrencyGate(TRUST_MAX_INFLIGHT)
  return async (url, signal) => {
    const target = classifyPreviewResource(url, documentUrl)
    if (target.kind === 'cross-origin') return undefined
    const display = displayOfUrl(url)
    if (target.kind !== 'route' || documentRef === null) {
      record.note({ reason: target.kind === 'route' ? 'other-route' : target.kind, display })
      return undefined
    }
    // 名额在任何等待之前同步占掉：内联器一次并发发出全部请求，也不会超过上限。
    if (!record.reserve()) {
      record.note({ reason: 'limit', display })
      return undefined
    }
    const status = await client.ready(documentRef)
    if (signal?.aborted) return undefined
    if (status?.state !== 'ready') {
      record.note({ reason: 'error', display })
      return undefined
    }
    // 没信任：不发请求，只记一笔，说明条按它计数。
    if (!status.trusted) {
      record.note({ reason: 'untrusted', display })
      return undefined
    }
    if (status.documentInside !== true || record.snapshot().items.some(item => item.reason === 'document-outside')) {
      record.note({ reason: 'document-outside', display })
      return undefined
    }
    let result
    try {
      result = await gate.run(() => (signal?.aborted ? Promise.reject(new Error('aborted')) : client.readResource(target.document, target.resource, signal)))
    } catch {
      if (!signal?.aborted) record.note({ reason: 'error', display })
      return undefined
    }
    if (!result.ok) {
      // 信任或文档真实位置可能已改变；同时刷新共享状态，避免其他预览沿用旧的判定。
      if (result.reason === 'untrusted' || result.reason === 'document-outside') void client.load(documentRef)
      record.note({ reason: result.reason, display: result.display ?? display })
      return undefined
    }
    if (!record.charge(result.bytes.byteLength)) {
      record.note({ reason: 'limit', display })
      return undefined
    }
    record.note({ display })
    return { bytes: result.bytes, mediaType: result.mediaType }
  }
}

/** 把含 {path} 的一句话拆开，路径单独用等宽字显示。 */
function trustSentence(key, path) {
  const [before, after = ''] = String(workspaceTrustT(key, { path: '{path}' })).split('{path}')
  // 路径单行显示，太长时从左边截断，保留结尾的目录名；完整路径放在 title 里。
  return [before, h('span', { key: 'path', className: 'dwb-wt-path dwb-wt-clip', title: path }, h('bdi', null, path)), after]
}

/** 说明条：一直显示在预览上方，不靠悬停。 */
function TrustNotice({ notice, status, documentRef, client }) {
  const t = workspaceTrustT
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const warn = notice.kind === 'blocked' || notice.kind === 'error'
  const icon = h(warn ? ui.IconWarningOutlineRegular : ui.IconInfoOutlineRegular, { size: 16 })
  const path = status?.display ?? status?.root ?? ''
  const trust = async () => {
    setBusy(true)
    setError('')
    const result = await client.trust(documentRef.sessionId)
    setBusy(false)
    if (!result.ok) setError(t(result.reason === 'too-broad' ? 'trust.error.tooBroad' : 'trust.error.failed'))
  }
  let title, body, action = null, list = null
  if (notice.kind === 'untrusted') {
    title = t('trust.notice.static')
    body = [...trustSentence('trust.notice.untrusted', path), error ? h('span', { key: 'error', className: 'dwb-wt-error', role: 'alert' }, ` ${error}`) : null]
    action = h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void trust() } }, t('trust.action.trust'))
  } else if (notice.kind === 'document-outside') {
    title = t('trust.notice.static')
    body = trustSentence('trust.notice.outside', path)
  } else if (notice.kind === 'error') {
    title = t('trust.notice.static')
    body = t('trust.notice.error')
    action = h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void client.load(documentRef, { bump: true }) } }, t('trust.action.retry'))
  } else {
    title = notice.blocked > 0 ? t('trust.notice.blocked', { count: notice.blocked }) : t('trust.notice.missing', { count: notice.missing })
    body = notice.reasons.map(([reason, count]) => `${t(`trust.reason.${reason}`)} ${count}`).join(' · ')
    action = h(ui.Button, { variant: 'ghost', size: 'sm', className: 'dwb-wt-toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
      t(open ? 'trust.action.hide' : 'trust.action.show'),
      h(open ? ui.IconChevronUpOutlineRegular : ui.IconChevronDownOutlineRegular, { size: 14 }))
    list = open
      ? h('ul', { className: 'dwb-wt-list' }, notice.items.map((item, index) => h('li', { key: index },
        h('span', { className: 'dwb-wt-item dwb-wt-clip', title: item.display ?? '' }, h('bdi', null, item.display ?? '')),
        h('span', { className: 'dwb-wt-reason' }, t(`trust.reason.${item.reason}`)))))
      : null
  }
  // 展开列表的按钮跟标题同一行；信任、重试这类主要操作放在说明文字下面，窄栏里也不挤占正文。
  const inline = notice.kind === 'blocked'
  return h('div', { className: `dwb-wt-notice${warn ? ' dwb-wt-warn' : ''}`, role: 'status', 'data-trust-notice': notice.kind },
    h('span', { className: 'dwb-wt-icon' }, icon),
    h('span', { className: 'dwb-wt-title' }, title),
    action && inline ? h('span', { className: 'dwb-wt-action' }, action) : null,
    h('span', { className: 'dwb-wt-body' }, body),
    action && !inline ? h('span', { className: 'dwb-wt-below' }, action) : null,
    list)
}

/** 会内联时的外框：说明条加原来的预览框。外框结构不随说明条变化，免得预览框重新挂载。 */
function TrustedPreview({ Frame, frameProps, baseUrl, client }) {
  const documentUrl = useMemo(() => {
    try {
      return new URL(frameProps.src, baseUrl).href
    } catch {
      return ''
    }
  }, [frameProps.src, baseUrl])
  const documentRef = useMemo(() => previewDocumentOf(documentUrl), [documentUrl])
  const cached = React.useSyncExternalStore(client.subscribe, () => client.status(documentRef))
  const [checked, setChecked] = useState(null)
  const status = checked?.client === client && checked.documentRef === documentRef ? cached : undefined
  useEffect(() => {
    if (documentRef === null) return
    let live = true
    void client.load(documentRef).then(() => {
      if (live) setChecked({ client, documentRef })
    })
    return () => { live = false }
  }, [client, documentRef])
  const revision = status?.revision ?? 0
  const record = useMemo(() => createTrustRecord(), [documentUrl, revision])
  const recorded = React.useSyncExternalStore(record.subscribe, record.snapshot)
  const reader = useMemo(() => createTrustReader({ client, documentUrl, documentRef, record }), [client, documentUrl, documentRef, record])
  const notice = trustNoticeOf(status, recorded)
  // 信任了、文件也在工作区里才运行脚本（dshInteractive）；否则 better-sidebar 补丁按官方静态预览渲染。
  // 状态回来之前不挂预览框，免得先按静态内联一遍再重来；模式变了换 key，让预览框按新的沙箱重新挂载。
  const known = status !== undefined && status.state !== 'loading'
  const interactive = previewInteractive(status, recorded)
  return h('div', { className: [frameProps.className, 'dwb-wt-box'].filter(Boolean).join(' ') },
    notice ? h(TrustNotice, { notice, status, documentRef, client }) : null,
    known || documentRef === null
      ? h(Frame, { ...frameProps, key: `trust-${revision}-${interactive ? 'run' : 'static'}`, className: 'dwb-wt-frame', fetchInlineResource: reader, dshInteractive: interactive || undefined })
      : null)
}

/**
 * better-sidebar 的预览框交过来的组件。不内联时原样渲染，什么都不加；订阅这一行的挂载状态，
 * 停用时立即卸载交互预览并重新挂载原来的静态预览。
 * @param {object} props better-sidebar 给 HtmlPreviewFrame 的属性，加上原来的预览框 Frame。
 * @returns {object} React 元素。
 */
function WorkspaceTrustFrame(props) {
  const { Frame, ...frameProps } = props
  const client = React.useSyncExternalStore(subscribeWorkspaceTrust, () => workspaceTrustClient)
  const baseUrl = frameProps.baseUrl ?? (typeof document === 'undefined' ? '' : document.baseURI)
  if (client === null || !previewInlines(frameProps, baseUrl)) return h(Frame, frameProps)
  return h(TrustedPreview, { Frame, frameProps, baseUrl, client })
}

/** 「设置 → 工作区信任」：已信任的工作区，能撤销。 */
function WorkspaceTrustSettings({ app }) {
  const t = app.t
  const client = workspaceTrustClient
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    client?.list().then(value => { if (live) setRows(value) }, () => { if (live) setError(t('trust.settings.loadFailed')) })
    return () => { live = false }
  }, [client, t])
  const revoke = async (path) => {
    setBusy(true)
    try {
      setRows(await client.revoke(path))
      setError('')
    } catch {
      setError(t('trust.settings.loadFailed'))
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'dwb-wt-page' },
    h('header', { className: 'dwb-wt-page-head' }, h(ui.IconFolderOpenOutlineRegular, { size: 16 }), h('h2', null, t('trust.settings.title'))),
    h('div', { className: 'dwb-wt-page-body' },
      h('p', { className: 'dwb-wt-note' }, t('trust.settings.description')),
      error ? h('p', { className: 'dwb-wt-alert', role: 'alert' }, error) : null,
      rows === null ? null
        : rows.length === 0 ? h('p', { className: 'dwb-wt-empty' }, t('trust.settings.empty'))
          : h('ul', { className: 'dwb-wt-trusted' }, rows.map(row => h('li', { key: row.path },
            h('div', { className: 'dwb-wt-trusted-text' },
              h('span', { className: 'dwb-wt-path dwb-wt-clip', title: row.path }, h('bdi', null, row.display ?? row.path)),
              h('span', { className: 'dwb-wt-note' }, t('trust.settings.trustedAt', { time: workbenchClock(Date.parse(row.trustedAt), app.clock) }))),
            h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void revoke(row.path) } }, t('trust.settings.revoke')))))))
}

const WORKSPACE_TRUST_STYLE = `
.dwb-wt-box { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.dwb-wt-frame { flex: 1; min-height: 0; width: 100%; border: none; background: var(--dsw-alias-bg-base); }
.dwb-wt-notice { flex: none; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; column-gap: 8px; row-gap: 2px; align-items: start;
  padding: 8px 10px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dwb-wt-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
  border-bottom-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.dwb-wt-icon { display: inline-flex; align-items: center; height: 18px; line-height: 0; color: var(--dsw-alias-label-tertiary); }
.dwb-wt-warn .dwb-wt-icon { color: var(--dsw-alias-state-warn-primary); }
.dwb-wt-icon svg { display: block; }
.dwb-wt-title { color: var(--dsw-alias-label-primary); font-weight: 500; min-width: 0; }
.dwb-wt-action { grid-column: 3; grid-row: 1; align-self: center; display: inline-flex; }
.dwb-wt-body { grid-column: 2 / span 2; min-width: 0; }
.dwb-wt-below { grid-column: 2 / span 2; display: flex; gap: 8px; margin-top: 4px; }
.dwb-wt-path { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); color: var(--dsw-alias-label-primary); }
.dwb-wt-clip { display: inline-block; max-width: 100%; vertical-align: bottom; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.dwb-wt-clip bdi { direction: ltr; unicode-bidi: isolate; }
.dwb-wt-error { color: var(--dsw-alias-state-warn-primary); }
.dwb-wt-toggle svg { display: block; }
.dwb-wt-list { grid-column: 2 / span 2; list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; max-height: 160px; overflow: auto; }
.dwb-wt-list li { display: flex; gap: 8px; min-width: 0; }
.dwb-wt-item { flex: 1; min-width: 0; font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); color: var(--dsw-alias-label-primary); }
.dwb-wt-reason { flex: none; color: var(--dsw-alias-label-tertiary); }
.dwb-wt-trusted { list-style: none; margin: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.dwb-wt-trusted li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; }
.dwb-wt-trusted li + li { border-top: 1px solid var(--dsw-alias-border-l2); }
.dwb-wt-trusted-text { display: grid; gap: 2px; min-width: 0; }
.dwb-wt-empty { margin: 0; color: var(--dsw-alias-label-secondary); }
.dwb-wt-page { padding: 16px; height: 100%; overflow: auto; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dwb-wt-page-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.dwb-wt-page-head h2 { margin: 0; font-size: 14px; font-weight: 500; }
.dwb-wt-page-body { display: grid; gap: 16px; max-width: 640px; }
.dwb-wt-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dwb-wt-alert { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
`

/**
 * 这一行（dsh-workbench-workspace-trust）开着时：设全局组件、样式和设置页；撤下时全部收回。
 * @param {{ ctx: object, t: (key: string, params?: object) => string, clock: Function }} app 客户端上下文。
 * @param {{ request?: Function }} [options] 测试注入 fetch。
 * @returns {() => void} 撤销函数。
 */
function applyWorkspaceTrust(app, options = {}) {
  const { ctx, t } = app
  const disposers = []
  const keep = dispose => disposers.push(dispose)
  const client = createTrustClient(options.request)
  workspaceTrustClient = client
  workspaceTrustT = t
  keep(mountModuleStyle(WORKSPACE_TRUST_PAGE, WORKSPACE_TRUST_STYLE))
  globalThis[WORKSPACE_TRUST_GLOBAL] = WorkspaceTrustFrame
  publishWorkspaceTrust()
  keep(() => {
    if (workspaceTrustClient !== client) return
    if (globalThis[WORKSPACE_TRUST_GLOBAL] === WorkspaceTrustFrame) delete globalThis[WORKSPACE_TRUST_GLOBAL]
    workspaceTrustClient = null
    publishWorkspaceTrust()
  })
  keep(ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: WORKSPACE_TRUST_PAGE, order: 41, label: () => t('trust.settings.title'), locale: '@miint-sunny/dsh-workbench' },
      props => h(WorkspaceTrustSettings, { ...props, app }),
    )))
  keep(ctx.slots.inject('settings.section.icon', () =>
    ctx.slots.register({ name: 'settings.section.icon', id: WORKSPACE_TRUST_PAGE }, props => h(ui.IconFolderOpenOutlineRegular, props))))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

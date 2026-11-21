/** 两块固定视口画板、事件驱动的定位桥和待发送草稿。 */
import { mountModuleStyle } from './style.js'
import { allowPagesScripts, pagesActiveContent, pagesScriptsAllowed } from '../../lib/pages-scripts.js'
const DESIGN_INJECT = ['sidebarRight', 'layout', 'contextMenus']
const DESIGN_PANEL = 'dsh-workbench-design',
  DESIGN_KIND = 'wbdesign'
let designApp = null,
  designCurrent = null
const designListeners = new Set()
function designOpen(page, version) {
  designCurrent = { page, version }
  for (const fn of designListeners) fn()
  designApp?.ctx.layout.selectPanel(DESIGN_PANEL)
}
/** 页面列表和发布预览仅在设计行开启时提供这个原生右键菜单。 */
function designPageMenu(event, page, version) {
  if (!designApp || !version) return
  if (
    event.type === 'keydown' &&
    event.key !== 'ContextMenu' &&
    !(event.shiftKey && event.key === 'F10')
  )
    return
  event.preventDefault()
  event.stopPropagation()
  const r = event.currentTarget.getBoundingClientRect()
  designApp.ctx.contextMenus.open(
    { kind: 'workbench-page', value: { page: page.id, version } },
    {
      x: event.type === 'keydown' ? r.left : event.clientX,
      y: event.type === 'keydown' ? r.bottom : event.clientY,
    },
  )
}
async function designRequest(action, body, signal) {
  const get = action === 'page'
  const response = await fetch(
    '/api/dsh-workbench.design.' + action + (get ? '?' + new URLSearchParams(body) : ''),
    {
      method: get ? 'GET' : 'POST',
      ...(get
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal,
    },
  )
  if (!response.ok) {
    let code = 'read-failed'
    try {
      code = (await response.json()).error?.code ?? code
    } catch {}
    throw new Error(code)
  }
  return action === 'export' ? response.blob() : response.json()
}
function designError(t, error) {
  const key = 'design.' + error.message
  return Object.hasOwn(DESIGN_ZH, key) ? t(key) : t('design.read-failed')
}
function designPrompt(data, t) {
  const targets = data.comments.map(({ text, ...target }) => target)
  return (
    t('design.prompt') +
    '\n\n' +
    data.comments.map((c, i) => i + 1 + '. ' + c.text).join('\n') +
    '\n\n' +
    t('design.promptData') +
    '\n' +
    JSON.stringify(
      {
        page: data.page,
        version: data.version,
        fingerprint: data.fingerprint,
        source: data.source,
        sourceRoot: data.sourceRoot,
        sourceFiles: data.sourceFiles,
        boards: data.boards,
        targets,
        parameters: data.params,
      },
      null,
      2,
    )
  )
}
function DesignFrame({ data, board, mode, comments, values, onMessage, controls }) {
  const frame = useRef(null),
    current = useRef(null),
    [url, setURL] = useState(null)
  current.current = { mode, comments, values, onMessage }
  useEffect(() => {
    const nonce = crypto.randomUUID(),
      pending = new Map(),
      expected = { nonce, board, version: data.version }
    let timer
    const send = (type, payload = {}) =>
      frame.current?.contentWindow?.postMessage({ type, ...expected, ...payload }, '*')
    const sync = () => {
      const c = current.current
      send('mode', { mode: c.mode })
      send('pins', {
        pins: c.comments
          .filter((p) => p.board === board)
          .map(({ id, selector, rect, tag }) => ({ id, selector, rect, tag, styles: {} })),
      })
      send('params', { values: designCSSValues(c.values, data.declarations) })
    }
    const listener = (event) => {
      if (event.source !== frame.current?.contentWindow) return
      const parsed = designMessage(event.data, expected, data.limits)
      if (!parsed) return
      if (parsed.type === 'ready') {
        clearTimeout(timer)
        sync()
      }
      if (parsed.type === 'locations' && parsed.probe && pending.has(parsed.probe)) {
        const settle = pending.get(parsed.probe)
        pending.delete(parsed.probe)
        settle.resolve(parsed.locations)
      }
      current.current.onMessage(board, parsed)
    }
    const control = {
      sync,
      locate: (requested) => {
        const probe = crypto.randomUUID()
        if (requested)
          send('pins', {
            pins: requested.map(({ id, selector, rect, tag }) => ({
              id,
              selector,
              rect,
              tag,
              styles: {},
            })),
          })
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(probe)
            reject(new Error('invalid-selection'))
          }, data.limits.bridgeReadyMs)
          pending.set(probe, {
            resolve: (value) => {
              clearTimeout(timeout)
              resolve(value)
            },
            reject: () => {
              clearTimeout(timeout)
              reject(new Error('invalid-selection'))
            },
          })
          send('locate', { probe })
        })
      },
    }
    controls.current[board] = control
    window.addEventListener('message', listener)
    const blob = URL.createObjectURL(
      new Blob(
        [
          designFrameHTML(data.html, {
            ...expected,
            declarations: data.declarations,
            limits: data.limits,
          }),
        ],
        { type: 'text/html;charset=utf-8' },
      ),
    )
    setURL(blob)
    timer = setTimeout(
      () => current.current.onMessage(board, { type: 'unavailable' }),
      data.limits.bridgeReadyMs,
    )
    return () => {
      clearTimeout(timer)
      window.removeEventListener('message', listener)
      for (const wait of pending.values()) wait.reject()
      if (controls.current[board] === control) delete controls.current[board]
      URL.revokeObjectURL(blob)
    }
  }, [data.fingerprint, data.version, board])
  useEffect(() => {
    controls.current[board]?.sync()
  }, [mode, comments, values])
  return url
    ? h('iframe', {
        ref: frame,
        src: url,
        sandbox: 'allow-scripts',
        title: designApp.t('design.' + board),
        referrerPolicy: 'no-referrer',
        'data-design-board': board,
      })
    : null
}
function DesignLauncher({ app }) {
  const [pages, setPages] = useState(null),
    [error, setError] = useState(false),
    [revision, reload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    void fetch('/api/dsh-workbench.pages.list', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw Error()
        return r.json()
      })
      .then((data) => setPages(data.pages.filter((p) => !p.corrupt)))
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [revision])
  return h(
    'div',
    { className: 'dwb-design dwb-design-list' },
    h('h2', null, app.t('design.choose')),
    h('button', { onClick: () => reload((n) => n + 1) }, app.t('design.refresh')),
    error
      ? h('p', { role: 'alert' }, app.t('design.read-failed'))
      : pages === null
        ? h('p', { role: 'status' }, app.t('design.loading'))
        : pages.length
          ? pages.map((p) =>
              h(
                'button',
                { key: p.id, onClick: () => designOpen(p.id, p.versions.at(-1).n) },
                p.title + ' · v' + p.versions.at(-1).n,
              ),
            )
          : h('p', null, app.t('design.empty')),
  )
}
function DesignPanel({ app }) {
  const [chosen, setChosen] = useState(designCurrent),
    [reload, reloadPage] = useState(0),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState(null),
    [dirty, setDirty] = useState(false),
    [previewValues, setPreviewValues] = useState({}),
    [mode, setMode] = useState('select'),
    [selection, setSelection] = useState(null),
    [comment, setComment] = useState(''),
    [editing, setEditing] = useState(null),
    [selectedId, setSelectedId] = useState(null),
    [view, setView] = useState({ x: 20, y: 44, z: 0.45 }),
    [status, setStatus] = useState({}),
    [locations, setLocations] = useState({}),
    [message, setMessage] = useState(null),
    [sending, setSending] = useState(false),
    // 这一版点过「运行脚本」没有：画板要运行页面，带脚本的页面点过才画（fix#173，见 lib/pages-scripts.js）。
    [scriptsAllowed, setScriptsAllowed] = useState(false)
  const t = app.t,
    viewport = useRef(null),
    world = useRef(null),
    overlay = useRef(null),
    controls = useRef({}),
    gesture = useRef(null),
    dialog = useRef(null),
    sendLock = useRef(false),
    reselect = useRef(null),
    adding = useRef(null),
    lifetime = useRef(null)
  useEffect(() => {
    const changed = () => setChosen({ ...designCurrent })
    designListeners.add(changed)
    return () => designListeners.delete(changed)
  }, [])
  useEffect(() => {
    if (!chosen) return
    const abort = new AbortController()
    lifetime.current = abort
    setData(null)
    setScriptsAllowed(false)
    setError('')
    setStatus({})
    setLocations({})
    setMessage(null)
    setSelection(null)
    setEditing(null)
    reselect.current = null
    void designRequest('page', { page: chosen.page, version: chosen.version }, abort.signal)
      .then((result) => {
        setScriptsAllowed(pagesScriptsAllowed(chosen.page, result.version))
        setData(result)
        setDraft(result.draft)
        setDirty(false)
        setPreviewValues(
          Object.fromEntries(
            result.declarations.map((d) => [d.name, result.draft.params[d.name] ?? d.default]),
          ),
        )
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(designError(t, e))
      })
    return () => abort.abort()
  }, [chosen?.page, chosen?.version, reload])
  // 只在换了页面数据时查一次：画板拖动、缩放时组件会频繁重画，页面最大 16 MiB。
  const dataActive = useMemo(() => data !== null && pagesActiveContent(data.html), [data])
  const scriptsGate = dataActive && !scriptsAllowed
  /** 「运行脚本」：记下这一版，画出画板。存不进浏览器存储时只在这次打开里运行。 */
  const runScripts = () => {
    allowPagesScripts(chosen.page, data.version)
    setScriptsAllowed(true)
  }
  const act = async (operation) => {
    setBusy(true)
    setError('')
    try {
      return await operation()
    } catch (e) {
      if (!lifetime.current?.signal.aborted) setError(designError(t, e))
    } finally {
      setBusy(false)
    }
  }
  const save = async (next) => {
    setDraft(next)
    setDirty(true)
    const saved = await designRequest(
      'save',
      {
        ...chosen,
        revision: next.revision,
        draft: { comments: next.comments, params: next.params },
      },
      lifetime.current?.signal,
    )
    setDraft(saved)
    setDirty(false)
    return saved
  }
  // 「重新选择」只给紧接着的那次选择用：编辑、删除、取消、Esc、放位置评论、换页面或版本都作废它，免得之后新建的选择改掉旧评论。
  const edit = (c) => {
    reselect.current = null
    setEditing(c.id)
    setSelectedId(c.id)
    setSelection({ ...c })
    setComment(c.text)
  }
  const remove = (c) => {
    reselect.current = null
    return act(() => save({ ...draft, comments: draft.comments.filter((x) => x.id !== c.id) }))
  }
  useEffect(
    () =>
      app.ctx.contextMenus.register({
        id: DESIGN_PANEL + '-comments',
        target: 'design-comment',
        order: 100,
        resolve: ({ id }) => {
          const c = draft?.comments.find((x) => x.id === id)
          return c
            ? [
                {
                  id: 'edit',
                  label: t('design.edit'),
                  icon: { key: 'dwb-design-edit' },
                  disabled: busy || sending,
                  run: () => edit(c),
                },
                {
                  id: 'reselect',
                  label: t('design.reselect'),
                  icon: { key: 'dwb-design-select' },
                  disabled: busy || sending,
                  run: () => {
                    reselect.current = id
                    setMode('select')
                    setSelectedId(id)
                  },
                },
                {
                  id: 'delete',
                  label: t('design.delete'),
                  icon: { key: 'dwb-design-delete' },
                  disabled: busy || sending,
                  run: () => remove(c),
                },
              ]
            : []
        },
      }),
    [draft, busy, sending],
  )
  useEffect(() => {
    if (message) dialog.current?.showModal()
    else if (dialog.current?.open) dialog.current.close()
  }, [message])
  const close = () => app.ctx.layout.selectPanel(null)
  const fit = () => {
    const r = viewport.current?.getBoundingClientRect()
    if (!r) return
    setView({
      x: 16,
      y: 40,
      z: Math.max(0.15, Math.min(1, (r.width - 32) / 1703, (r.height - 56) / 812)),
    })
  }
  // 画板第一次出来时适配一次：带脚本的页面要等点了「运行脚本」画板才挂上，之后用户自己的缩放不再被改。
  useEffect(() => {
    if (data && !scriptsGate) fit()
  }, [data?.fingerprint, scriptsGate])
  const zoom = (delta) =>
    setView((v) => {
      const r = viewport.current.getBoundingClientRect(),
        z = Math.max(0.15, Math.min(1.5, v.z + delta)),
        cx = r.width / 2,
        cy = r.height / 2
      return { x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z, z }
    })
  const onMessage = (board, value) => {
    if (value.type === 'escape') {
      reselect.current = null
      if (selection) setSelection(null)
      else close()
    } else if (value.type === 'ready') setStatus((s) => ({ ...s, [board]: 'ready' }))
    else if (value.type === 'error') setStatus((s) => ({ ...s, [board]: 'error' }))
    else if (value.type === 'unavailable')
      setStatus((s) => (s[board] ? s : { ...s, [board]: 'unavailable' }))
    else if (value.type === 'selection') {
      const id = reselect.current,
        c = draft?.comments.find((c) => c.id === id)
      setSelection({ board, ...value.selection })
      setEditing(c?.id ?? null)
      setComment(c?.text ?? '')
      reselect.current = null
    } else if (value.type === 'locations')
      setLocations((old) => ({
        ...old,
        ...Object.fromEntries(value.locations.map((p) => [p.id, p])),
      }))
  }
  const add = () =>
    act(async () => {
      // save 先把新评论放进本地草稿；保存失败后对同一个选区再点一次，沿用这条的 id 原地更新，不再追加一条。
      if (adding.current?.selection !== selection)
        adding.current = { selection, id: crypto.randomUUID() }
      const id = editing ?? adding.current.id,
        row = { ...selection, id, text: comment }
      const next = {
        ...draft,
        comments:
          editing || draft.comments.some((c) => c.id === id)
            ? draft.comments.map((c) => (c.id === id ? row : c))
            : [...draft.comments, row],
      }
      designDraft({ comments: next.comments, params: next.params }, data.declarations, data.limits)
      await save(next)
      setComment('')
      setSelection(null)
      setEditing(null)
    })
  const applyParams = () =>
    act(() =>
      save({
        ...draft,
        params: Object.fromEntries(
          Object.entries(designValues(previewValues, data.declarations)).filter(
            ([name, value]) => value !== data.declarations.find((d) => d.name === name).default,
          ),
        ),
      }),
    )
  const locateBatch = async (batch) => {
    if (batch.page !== data.page || batch.version !== data.version)
      throw new Error('version-changed')
    const needs = [
      ...new Set(batch.comments.filter((c) => c.selector !== null).map((c) => c.board)),
    ]
    for (const board of needs) {
      const control = controls.current[board]
      if (!control || !['ready', 'error'].includes(status[board]))
        throw new Error('invalid-selection')
      const comments = batch.comments.filter((c) => c.board === board),
        found = await control.locate(comments)
      for (const c of comments.filter((c) => c.selector !== null))
        if (!found.find((p) => p.id === c.id)?.valid) throw new Error('invalid-selection')
    }
  }
  const preview = () =>
    act(async () => {
      let current = dirty ? await save(draft) : draft
      await locateBatch(current)
      const ready = await designRequest(
        'prepare',
        { ...chosen, revision: current.revision },
        lifetime.current?.signal,
      )
      setDraft(ready)
      setMessage({ data: ready, text: designPrompt(ready, t) })
    })
  const send = async () => {
    if (sendLock.current || !message) return
    sendLock.current = true
    setSending(true)
    setError('')
    try {
      const checked = await designRequest(
        'prepare',
        { ...chosen, revision: message.data.revision },
        lifetime.current?.signal,
      )
      setMessage((old) => (old ? { ...old, data: checked } : null))
      await app.ctx.sessions.refresh()
      await app.ctx.sessions.using(
        checked.sessionId,
        { source: 'design-comments' },
        async (reference) => {
          await locateBatch(message.data)
          const result = await reference.binding.session.prompt(
            [{ type: 'text', text: message.text }],
            'queue',
            undefined,
            checked.requestId,
          )
          if (!result.ok) throw Error('send-uncertain')
        },
      )
      const cleared = await designRequest(
        'sent',
        { ...chosen, revision: checked.revision, requestId: checked.requestId },
        lifetime.current?.signal,
      )
      setDraft(cleared)
      setMessage(null)
      setError(t('design.sent'))
    } catch (e) {
      setError(
        e.message === 'send-uncertain' || !Object.hasOwn(DESIGN_ZH, 'design.' + e.message)
          ? t('design.requestUncertain')
          : designError(t, e),
      )
    } finally {
      sendLock.current = false
      setSending(false)
    }
  }
  const download = (preview) =>
    act(async () => {
      const blob = await designRequest('export', {
          ...chosen,
          ...(preview ? { params: previewValues } : {}),
        }),
        url = URL.createObjectURL(blob),
        link = document.createElement('a')
      link.href = url
      link.download = chosen.page + '-v' + chosen.version + (preview ? '--preview' : '') + '.html'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    })
  const menu = (e, c) => {
    if (e.type === 'keydown' && e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(c.id)
    const r = e.currentTarget.getBoundingClientRect()
    app.ctx.contextMenus.open(
      { kind: 'design-comment', value: { id: c.id } },
      { x: e.type === 'keydown' ? r.left : e.clientX, y: e.type === 'keydown' ? r.top : e.clientY },
    )
  }
  const down = (e) => {
    if (e.button !== 0 || !data) return
    const r = e.currentTarget.getBoundingClientRect()
    if (mode === 'position') {
      const x = (e.clientX - r.left - view.x) / view.z,
        y = (e.clientY - r.top - view.y) / view.z
      const entry = Object.entries(DESIGN_BOARDS).find(
        ([, b]) => x >= b.x && x <= b.x + b.width && y >= 0 && y <= b.height,
      )
      if (entry) {
        setSelection({
          board: entry[0],
          selector: null,
          tag: '',
          rect: { x: x - entry[1].x, y, width: 0, height: 0 },
          styles: {},
        })
        setEditing(null)
        setComment('')
        reselect.current = null
      }
      return
    }
    if (mode === 'pan') {
      gesture.current = { x: e.clientX, y: e.clientY, view }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }
  const move = (e) => {
    const g = gesture.current
    if (!g) return
    const x = g.view.x + e.clientX - g.x,
      y = g.view.y + e.clientY - g.y
    world.current.style.transform = `translate(${x}px,${y}px) scale(${g.view.z})`
    overlay.current.style.transform = `translate(${x}px,${y}px)`
  }
  const up = (e) => {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    setView({ ...g.view, x: g.view.x + e.clientX - g.x, y: g.view.y + e.clientY - g.y })
  }
  if (!chosen) return h(DesignLauncher, { app })
  return h(
    'div',
    {
      className: 'dwb-design',
      onKeyDown: (e) => {
        if (e.key === 'Escape' && !dialog.current?.open) {
          e.stopPropagation()
          reselect.current = null
          if (selection) setSelection(null)
          else close()
        }
      },
    },
    h(
      'header',
      { className: 'dwb-design-header' },
      h(ui.IconEditOutlineRegular, { size: 16 }),
      h('h2', null, data ? data.title + ' · v' + data.version : t('design.title')),
      h(
        'button',
        { disabled: busy || sending, onClick: () => reloadPage((n) => n + 1) },
        t('design.refresh'),
      ),
      h('button', { onClick: close }, t('design.close')),
    ),
    error ? h('p', { className: 'dwb-design-notice', role: 'status' }, error) : null,
    !data
      ? h('p', { className: 'dwb-design-state', role: 'status' }, error ? '' : t('design.loading'))
      : scriptsGate
        ? h(
            Fragment,
            null,
            h('div', { className: 'dwb-design-notice dwb-design-scripts', role: 'status' },
              h('span', null, t('design.scripts')),
              h('button', { onClick: runScripts }, t('design.runScripts'))),
            // 导出向宿主要文件，用不到画板，等确认时也能导出。
            h('div', { className: 'dwb-design-tools' },
              h('button', { disabled: busy, onClick: () => download(false) }, t('design.export'))),
          )
        : h(
          Fragment,
          null,
          data.latest !== data.version
            ? h('p', { className: 'dwb-design-notice' }, t('design.old'))
            : null,
          !data.sourceReady
            ? h('p', { className: 'dwb-design-notice' }, t('design.noSource'))
            : null,
          Object.values(status).includes('unavailable')
            ? h('p', { className: 'dwb-design-notice' }, t('design.fallback'))
            : null,
          Object.values(status).includes('error')
            ? h('p', { className: 'dwb-design-notice' }, t('design.frameError'))
            : null,
          h(
            'div',
            { className: 'dwb-design-tools' },
            ...['select', 'pan', 'position'].map((v) =>
              h(
                'button',
                { key: v, 'aria-pressed': mode === v, onClick: () => setMode(v) },
                t('design.' + v),
              ),
            ),
            h('button', { onClick: () => zoom(-0.1) }, t('design.out')),
            h('output', null, Math.round(view.z * 100) + '%'),
            h('button', { onClick: () => zoom(0.1) }, t('design.in')),
            h('button', { onClick: fit }, t('design.fit')),
            h('button', { disabled: busy, onClick: () => download(false) }, t('design.export')),
            h(
              WorkbenchDisclosure,
              { title: t('design.move') },
              h(
                'div',
                { className: 'dwb-design-actions' },
                ...Object.entries({
                  left: [40, 0],
                  right: [-40, 0],
                  up: [0, 40],
                  down: [0, -40],
                }).map(([key, [x, y]]) =>
                  h(
                    'button',
                    { key, onClick: () => setView((v) => ({ ...v, x: v.x + x, y: v.y + y })) },
                    t('design.' + key),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dwb-design-body' },
            h(
              'div',
              {
                className: 'dwb-design-viewport',
                ref: viewport,
                tabIndex: 0,
                'aria-label': t('design.title'),
                onPointerDown: down,
                onPointerMove: move,
                onPointerUp: up,
                onPointerCancel: up,
                onKeyDown: (e) => {
                  const delta = {
                    ArrowLeft: [40, 0],
                    ArrowRight: [-40, 0],
                    ArrowUp: [0, 40],
                    ArrowDown: [0, -40],
                  }[e.key]
                  if (delta) {
                    e.preventDefault()
                    setView((v) => ({ ...v, x: v.x + delta[0], y: v.y + delta[1] }))
                  }
                },
              },
              h(
                'div',
                {
                  ref: world,
                  className: 'dwb-design-world',
                  style: { transform: `translate(${view.x}px,${view.y}px) scale(${view.z})` },
                },
                ...Object.entries(DESIGN_BOARDS).map(([board, size]) =>
                  h(
                    'div',
                    {
                      key: board,
                      className: 'dwb-design-board',
                      style: { left: size.x, width: size.width, height: size.height },
                    },
                    h(DesignFrame, {
                      data,
                      board,
                      mode,
                      comments: draft.comments,
                      values: previewValues,
                      onMessage,
                      controls,
                    }),
                  ),
                ),
              ),
              h(
                'div',
                {
                  ref: overlay,
                  className: 'dwb-design-overlays',
                  style: { transform: `translate(${view.x}px,${view.y}px)` },
                },
                ...Object.entries(DESIGN_BOARDS).map(([board, b]) =>
                  h(
                    'span',
                    { key: board, className: 'dwb-design-label', style: { left: b.x * view.z } },
                    t('design.' + board),
                  ),
                ),
                ...draft.comments.map((c, i) => {
                  const p = locations[c.id]
                  if (p?.valid === false) return null
                  const rect = p?.rect ?? c.rect
                  return h(
                    'button',
                    {
                      key: c.id,
                      className: 'dwb-design-pin',
                      'aria-label': t('design.pin', { n: i + 1 }),
                      style: {
                        left: (DESIGN_BOARDS[c.board].x + rect.x) * view.z,
                        top: rect.y * view.z,
                      },
                      onClick: () => edit(c),
                    },
                    i + 1,
                  )
                }),
              ),
              mode !== 'select'
                ? h('div', { className: 'dwb-design-mask', 'data-mode': mode })
                : null,
            ),
            h(
              'aside',
              { className: 'dwb-design-side' },
              h(
                'section',
                null,
                h('h3', null, t('design.comments')),
                selection
                  ? h(
                      Fragment,
                      null,
                      h(
                        'p',
                        { className: 'dwb-design-small' },
                        t('design.' + selection.board) +
                          ' · ' +
                          (selection.selector ?? t('design.position')),
                      ),
                      h(
                        'label',
                        null,
                        t('design.comment'),
                        h('textarea', {
                          value: comment,
                          maxLength: data.limits.maxText,
                          onChange: (e) => setComment(e.target.value),
                        }),
                      ),
                      h(
                        'div',
                        { className: 'dwb-design-actions' },
                        h(
                          'button',
                          { disabled: busy || sending || !comment.trim(), onClick: add },
                          t(editing ? 'design.update' : 'design.add'),
                        ),
                        h(
                          'button',
                          {
                            onClick: () => {
                              reselect.current = null
                              setSelection(null)
                              setEditing(null)
                            },
                          },
                          t('design.cancel'),
                        ),
                      ),
                      h(
                        WorkbenchDisclosure,
                        { title: t('design.target') },
                        h('p', { className: 'dwb-design-small' }, t('design.untrusted')),
                        h(
                          'pre',
                          { className: 'dwb-design-pre' },
                          JSON.stringify(selection, null, 2),
                        ),
                      ),
                    )
                  : draft.comments.length
                    ? null
                    : h('p', { className: 'dwb-design-small' }, t('design.noComments')),
                ...draft.comments.map((c, i) =>
                  h(
                    'article',
                    {
                      key: c.id,
                      className: 'dwb-design-comment',
                      tabIndex: 0,
                      'data-selected': c.id === selectedId,
                      onClick: () => edit(c),
                      onContextMenu: (e) => menu(e, c),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') edit(c)
                        else menu(e, c)
                      },
                    },
                    h('p', null, i + 1 + '. ' + c.text),
                    h(
                      'p',
                      { className: 'dwb-design-small' },
                      t('design.' + c.board) + ' · ' + (c.selector ?? t('design.position')),
                    ),
                    locations[c.id]?.valid === false
                      ? h('p', null, t('design.invalidTarget'))
                      : null,
                  ),
                ),
              ),
              h(
                'section',
                null,
                h('h3', null, t('design.params')),
                h('p', { className: 'dwb-design-small' }, t('design.previewOnly')),
                data.declarations.length
                  ? data.declarations.map((d) =>
                      h(
                        'label',
                        { key: d.name },
                        d.label + ' (' + d.name + ')',
                        h('input', {
                          type: d.type === 'number' ? 'range' : 'color',
                          value: previewValues[d.name] ?? d.default,
                          ...(d.type === 'number'
                            ? { min: d.min, max: d.max, step: d.step }
                            : { maxLength: 9 }),
                          onChange: (e) => {
                            const value =
                              d.type === 'number' ? Number(e.target.value) : e.target.value
                            try {
                              designValues({ [d.name]: value }, data.declarations)
                              setPreviewValues((v) => ({ ...v, [d.name]: value }))
                            } catch {}
                          },
                          disabled: sending,
                        }),
                        d.type === 'number'
                          ? h(
                              'span',
                              { className: 'dwb-design-small' },
                              `${previewValues[d.name]} ${d.unit} (${d.min}–${d.max} · ${d.step})`,
                            )
                          : null,
                      ),
                    )
                  : h('p', { className: 'dwb-design-small' }, t('design.noParams')),
                data.declarations.length
                  ? h(
                      'div',
                      { className: 'dwb-design-actions' },
                      h(
                        'button',
                        { disabled: busy || sending, onClick: applyParams },
                        t('design.apply'),
                      ),
                      h(
                        'button',
                        { disabled: busy, onClick: () => download(true) },
                        t('design.exportPreview'),
                      ),
                    )
                  : null,
              ),
              h(
                'section',
                null,
                h('h3', null, t('design.pending')),
                h(
                  'p',
                  null,
                  t('design.stageCount', {
                    comments: draft.comments.length,
                    params: Object.keys(draft.params).length,
                  }),
                ),
                h(
                  'p',
                  { className: 'dwb-design-small' },
                  t(dirty ? 'design.unsaved' : 'design.saved'),
                ),
                h(
                  'div',
                  { className: 'dwb-design-actions' },
                  dirty
                    ? h(
                        'button',
                        { disabled: busy || sending, onClick: () => act(() => save(draft)) },
                        t('design.save'),
                      )
                    : null,
                  h(
                    'button',
                    {
                      disabled:
                        busy || sending || !data.sourceReady || data.latest !== data.version,
                      onClick: preview,
                    },
                    t('design.send'),
                  ),
                ),
              ),
            ),
          ),
        ),
    h(
      'dialog',
      {
        ref: dialog,
        'aria-label': t('design.preview'),
        onCancel: (e) => {
          e.preventDefault()
          setMessage(null)
        },
        onClick: (e) => {
          if (e.target === dialog.current) {
            const r = e.target.getBoundingClientRect()
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              setMessage(null)
          }
        },
      },
      h('h3', null, t('design.preview')),
      h('pre', { className: 'dwb-design-pre' }, message?.text),
      error ? h('p', { role: 'status' }, error) : null,
      h(
        'div',
        { className: 'dwb-design-actions' },
        h(
          'button',
          { onClick: () => setMessage(null) },
          t(sending ? 'design.close' : 'design.cancel'),
        ),
        h('button', { disabled: sending, onClick: send }, t('design.confirm')),
      ),
    ),
  )
}
function applyDesign(app) {
  designApp = app
  const { ctx, t } = app,
    disposers = [],
    keep = (d) => disposers.push(d)
  keep(mountModuleStyle('dsh-workbench-design', DESIGN_STYLE))
  keep(
    ctx.contextMenus.register({
      id: DESIGN_PANEL,
      target: 'workbench-page',
      order: 100,
      resolve: ({ page, version }) => [
        {
          id: 'design',
          label: t('design.open'),
          icon: { key: 'dwb-design-edit' },
          run: () => designOpen(page, version),
        },
      ],
    }),
  )
  keep(
    ctx.slots.inject('contextMenu.icon', function* () {
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-design-edit' }, (p) =>
        h(ui.IconEditOutlineRegular, p),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-design-select' }, (p) =>
        h(ui.IconSearchOutlineRegular, p),
      )
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dwb-design-delete' }, (p) =>
        h(ui.IconTrashOutlineRegular, p),
      )
    }),
  )
  keep(
    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: DESIGN_PANEL, locale: '@miint-sunny/dsh-workbench' }, () =>
        h(DesignPanel, { app }),
      ),
    ),
  )
  keep(
    ctx.sidebarRightTabs.register({
      id: DESIGN_PANEL,
      kind: DESIGN_KIND,
      title: () => t('design.title'),
      guide: [
        {
          id: 'design',
          order: 57,
          title: () => t('design.title'),
          description: () => t('design.guide'),
          icon: (p) => h(ui.IconEditOutlineRegular, p),
        },
      ],
    }),
  )
  keep(
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: DESIGN_PANEL, locale: '@miint-sunny/dsh-workbench' },
        () => h(DesignLauncher, { app }),
      ),
    ),
  )
  return () => {
    if (designApp === app) designApp = null
    for (const dispose of disposers.reverse()) dispose()
  }
}

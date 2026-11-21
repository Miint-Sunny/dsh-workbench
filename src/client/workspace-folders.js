/**
 * 工作区文件夹和权限（dsh-workbench/workspace-folders，feat#159）的网页端：侧边栏工作区那一行的右键菜单加「工作区设置…」，
 * 打开一个对话框（版式照 Antigravity 的项目设置）：名字（就地改名，用官方 workspaces.rename）和说明，文件夹列表，最后一行「添加文件夹」。
 * - 子文件夹：主文件夹里面另登记的工作区。添加用官方 workspaces.create，移除用官方 workspaces.delete（先确认，说明照官方删除工作区），
 *   「只读 / 可写」存到宿主端。
 * - 外部文件夹：存到宿主端，由宿主端给这个工作区的会话登记可写目录。
 * 选文件夹：桌面端用它的选择文件夹窗口（preload 的 __DSH_DIRECTORY_PICKER__），浏览器里请宿主打开（官方 uiWorkspace.pickDirectory），
 * 和官方「添加工作区」的原生做法一样。选好以后由宿主端解析真实路径并分类（lib/workspace-folders.js）。
 */
import { mountModuleStyle } from './style.js'
import { createMoveClient, createMoveNotices, MOVE_OVERLAY, MovePanel, moveTime, moveTitles } from './workspace-move.js'

/** 这一行要的 DSH 服务。 */
export const WORKSPACE_FOLDERS_INJECT = ['contextMenus', 'workspaces', 'uiWorkspace', 'sessions']

const FOLDERS_API = 'api/dsh-workbench.workspace-folders'
const FOLDERS_TOKEN_HEADER = 'x-dsh-workbench-folders'
const FOLDERS_MENU_ICON = 'dsh-workbench.workspace-folders'
const FOLDERS_OVERLAY = 'dsh-workbench-workspace-folders'
/** 宿主端的分类拒绝原因里有文案的那几种；其余的按「操作未完成」显示原因码。 */
const FOLDERS_PICK_ERRORS = ['ancestor', 'duplicate', 'missing', 'not-directory', 'invalid', 'too-broad', 'dsh-data']

/**
 * 打开选择文件夹的窗口。
 * @param {{ uiWorkspace: { pickDirectory: () => Promise<string | null> } }} ctx 客户端上下文。
 * @param {{ pick: () => Promise<string | null> } | undefined} [bridge] 桌面端的选择文件夹接口，缺省读全局的。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
export function pickDirectory(ctx, bridge = globalThis.__DSH_DIRECTORY_PICKER__) {
  if (bridge !== undefined && bridge !== null && typeof bridge.pick === 'function') return bridge.pick()
  return ctx.uiWorkspace.pickDirectory()
}

/**
 * 工作区右键菜单里的「工作区设置…」。
 * @param {{ t: (key: string) => string, open: (target: { workspaceId: string, displayTitle: string }) => void }} deps 文案、打开对话框。
 * @returns {(target: { workspaceId: string, displayTitle: string }) => object[]} contextMenus 的 resolve。
 */
export function foldersMenu({ t, open }) {
  return ({ workspaceId, displayTitle }) => [{
    id: 'workspace-settings', label: t('folders.menu'), icon: { key: FOLDERS_MENU_ICON },
    run: () => open({ workspaceId, displayTitle }),
  }]
}

/**
 * 和宿主路由说话。POST 要带只由 GET 回答的令牌；宿主重启换了令牌时（403 forbidden）重新拿一次再发。
 * @param {(url: string, init?: object) => Promise<Response>} [request] fetch（测试注入）。
 * @returns {object} load、classify、addExternal、removeExternal、setWritable；回答是宿主端的 JSON。
 */
export function createFoldersClient(request = (url, init) => fetch(url, init)) {
  let token
  const readJson = async (response) => {
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }
  const load = async (workspaceId) => {
    const response = await request(`${FOLDERS_API}?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: 'same-origin' })
    const value = await readJson(response)
    if (!response.ok || value?.ok !== true) throw new Error(value?.reason ?? `HTTP ${response.status}`)
    if (typeof value.token === 'string') token = value.token
    return value
  }
  const post = async (body) => {
    if (token === undefined) await load(body.workspaceId)
    const attempt = () => request(FOLDERS_API, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', [FOLDERS_TOKEN_HEADER]: token ?? '' }, body: JSON.stringify(body),
    })
    let response = await attempt()
    if (response.status === 403 && (await readJson(response.clone()))?.reason === 'forbidden') {
      await load(body.workspaceId)
      response = await attempt()
    }
    const value = await readJson(response)
    if (value?.ok !== true && typeof value?.reason !== 'string') throw new Error(`HTTP ${response.status}`)
    return value
  }
  return {
    load,
    classify: (workspaceId, path) => post({ action: 'classify', workspaceId, path }),
    addExternal: (workspaceId, path) => post({ action: 'add-external', workspaceId, path }),
    removeExternal: (workspaceId, path) => post({ action: 'remove-external', workspaceId, path }),
    setWritable: (workspaceId, subfolderId, writable) => post({ action: 'set-writable', workspaceId, subfolderId, writable }),
  }
}

/** 错误的文字。 */
const foldersReason = error => (error instanceof Error ? error.message : String(error))
/** 路径最后一段（移除按钮的无障碍标签用）。 */
const foldersLeaf = path => path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path

/**
 * 工作区设置对话框。
 * @param {{ app: { ctx: object, t: Function }, target: { workspaceId: string, displayTitle: string }, client: object, moves?: { client: object, notices: object, titleOf: Function }, close: () => void }} props
 *   moves 是更换文件夹（feat#187）要的：迁移的路由、对话框外的撤销和恢复、会话标题；没有时主文件夹那一行不显示「更换文件夹…」。
 * @returns {object} React 元素。
 */
function WorkspaceFoldersDialog({ app, target, client, moves, close }) {
  const { ctx, t } = app
  const workspaceId = target.workspaceId
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [name, setName] = useState(target.displayTitle)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameError, setRenameError] = useState('')
  const [pick, setPick] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [busyState, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [moveStatus, setMoveStatus] = useState(null)
  const [move, setMove] = useState(null)
  const returnToChange = useRef(false)
  const focusAfterMove = useCallback((button) => {
    if (button !== null && returnToChange.current) {
      returnToChange.current = false
      button.focus()
    }
  }, [])
  // 检查迁移内容、等 DSH 退出时，对话框里的其他操作都先停用
  const busy = busyState || (move !== null && (move.planning === true || move.waiting !== undefined))
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  const reload = useCallback(async () => {
    try {
      const value = await client.load(workspaceId)
      if (!live.current) return
      setData(value)
      setLoadError(false)
    } catch {
      if (live.current) setLoadError(true)
    }
  }, [client, workspaceId])
  useEffect(() => { void reload() }, [reload])
  /** 迁移的记录和停在中途的迁移；读不到时只是不显示它们，文件夹照常管理。 */
  const reloadMoves = useCallback(async () => {
    if (moves === undefined) return
    try {
      const value = await moves.client.status()
      if (live.current) setMoveStatus(value)
    } catch {
      // 迁移的路由没回答（这一行刚关、宿主重启中）：不显示迁移记录和恢复提示
    }
  }, [moves])
  useEffect(() => { void reloadMoves() }, [reloadMoves])

  const failed = reason => t('folders.error.failed', { reason })
  /** 跑一个操作：期间禁用按钮，出错写在列表下面。 */
  const perform = async (action) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      if (live.current) setError(failed(foldersReason(reason)))
    } finally {
      if (live.current) setBusy(false)
    }
  }
  /** 宿主端改完设置的回答：成功时换成新的列表。 */
  const adopt = (value) => {
    if (!live.current) return
    if (value.ok === true) setData(value)
    else setError(failed(value.reason))
  }

  const startRename = () => {
    setDraft(name)
    setRenameError('')
    setEditing(true)
  }
  const cancelRename = () => {
    setEditing(false)
    setRenameError('')
  }
  const saveRename = () => {
    const title = draft.trim()
    if (title === '' || title === name) {
      cancelRename()
      return
    }
    // 和官方重命名一样，先在本地查重名（按工作区 id 排除自己）。
    if (ctx.workspaces.list.getSnapshot().items.some(item => item.workspaceId !== workspaceId && item.title === title)) {
      setRenameError(t('folders.renameConflict', { name: title }))
      return
    }
    void perform(async () => {
      try {
        await ctx.workspaces.rename(workspaceId, title)
      } catch (reason) {
        const text = foldersReason(reason)
        if (live.current) setRenameError(text.includes('workspace/name-conflict') ? t('folders.renameConflict', { name: title }) : t('folders.renameFailed', { reason: text }))
        return
      }
      if (!live.current) return
      setName(title)
      setEditing(false)
    })
  }
  // 官方对话框在 document 上听 Esc，看到 defaultPrevented 就不关：改名时 Esc 只取消改名。
  const keepOpenOnEscape = (event) => {
    if (event.key === 'Escape') event.preventDefault()
  }

  const choose = async () => {
    setError('')
    setMove(null)
    setPick({ picking: true })
    setBusy(true)
    let picked
    try {
      picked = await pickDirectory(ctx)
    } catch (reason) {
      if (live.current) {
        setPick(null)
        setBusy(false)
        setError(t('folders.error.pick', { reason: foldersReason(reason) }))
      }
      return
    }
    if (!live.current) return
    if (typeof picked !== 'string' || picked === '') {
      setPick(null)
      setBusy(false)
      return
    }
    try {
      const result = await client.classify(workspaceId, picked)
      if (live.current) setPick(result)
    } catch (reason) {
      if (live.current) {
        setPick(null)
        setError(failed(foldersReason(reason)))
      }
    } finally {
      if (live.current) setBusy(false)
    }
  }
  const confirmAdd = () => perform(async () => {
    if (pick.kind === 'subfolder') {
      await ctx.workspaces.create({ path: pick.path })
      await reload()
    } else {
      adopt(await client.addExternal(workspaceId, pick.path))
    }
    if (live.current) setPick(null)
  })
  /** 更换文件夹：选新位置并检查迁移内容；取消选择时什么都不变。 */
  const changeFolder = async () => {
    setError('')
    setPick(null)
    setBusy(true)
    let picked
    try {
      picked = await pickDirectory(ctx)
    } catch (reason) {
      if (live.current) {
        setBusy(false)
        setError(t('folders.error.pick', { reason: foldersReason(reason) }))
      }
      return
    }
    if (!live.current) return
    setBusy(false)
    if (typeof picked === 'string' && picked !== '') await planMove(picked)
  }
  /** 请宿主预览：迁移的内容、阻碍；宿主拒绝时显示原因。 */
  const planMove = async (path) => {
    setMove({ planning: true, path })
    try {
      const value = await moves.client.plan(workspaceId, path)
      if (!live.current) return
      setMove(value.ok === true
        ? { path, display: value.preview.target.display, preview: value.preview, planId: value.planId, kind: value.kind }
        : { path, error: value.reason, ...value.display === undefined ? {} : { display: value.display } })
    } catch (reason) {
      if (live.current) setMove({ path, error: foldersReason(reason) })
    }
  }
  /** 「退出并迁移」：宿主起小进程，小进程请 DSH 退出；DSH 没退出时面板里显示进度和结果。 */
  const startMove = async () => {
    const current = move
    setBusy(true)
    try {
      const value = await moves.client.start(current.planId)
      if (!live.current) return
      setMove(value.ok === true ? { ...current, waiting: value.requestId, hostId: value.hostId, kind: value.kind } : { ...current, error: value.reason })
    } catch (reason) {
      if (live.current) setMove({ ...current, error: foldersReason(reason) })
    } finally {
      if (live.current) setBusy(false)
    }
  }
  /**
   * 小进程有了结果：在面板里显示。DSH 没重开过（放弃了、退出前出错）时标记为已提示；重开过的页面多半会重新加载，
   * 留给下次打开时的提示条。
   */
  const moveFinished = (view, restarted) => {
    if (!restarted && view.requestId !== undefined) void moves.client.ack(view.requestId).catch(() => {}) // 记不下时下次打开再提示一遍
    if (live.current) setMove({ result: view })
  }
  /** 撤销、恢复在对话框外进行（要退出 DSH）：先关掉工作区设置。 */
  const openOutside = (dialog) => {
    close()
    moves.notices.open(dialog)
  }
  const removeExternal = row => perform(async () => { adopt(await client.removeExternal(workspaceId, row.path)) })
  const removeSubfolder = row => perform(async () => {
    await ctx.workspaces.delete(row.id)
    if (live.current) setConfirming(null)
    await reload()
  })
  const setWritable = (row, value) => perform(async () => { adopt(await client.setWritable(workspaceId, row.id, value === 'writable')) })

  const iconButton = (label, onClick, Icon, extra = '') => h('button', {
    type: 'button', className: `dwb-wf-iconbtn${extra}`, 'aria-label': label, disabled: busy, onClick,
  }, h(Icon, { size: 14 }))
  /** 列表里的一行：图标、路径和说明、右边的标签或切换、移除按钮。 */
  const folderRow = ({ key, child = false, attached = false, display, note, warn = false, side, remove }) => h('div', { key, className: `dwb-wf-row${child ? ' dwb-wf-child' : ''}${attached ? ' dwb-mv-attached' : ''}` },
    h('span', { className: 'dwb-wf-glyph', 'aria-hidden': 'true' }, h(ui.IconFolderOpenOutlineRegular, { size: 16 })),
    h('span', { className: 'dwb-wf-text' },
      h('span', { className: 'dwb-wf-dir' }, display),
      h('span', { className: warn ? 'dwb-wf-note dwb-wf-warn' : 'dwb-wf-note' }, note)),
    side,
    remove === undefined ? h('span', { className: 'dwb-wf-spacer' }) : iconButton(t('folders.remove', { name: remove.name }), remove.onClick, ui.IconCloseOutlineRegular))
  const tag = text => h('span', { className: 'dwb-wf-tag' }, text)

  const rows = []
  if (data !== null) {
    const missing = data.workspace.missing
    const record = move === null ? moveStatus?.records?.find(item => item.workspaceId === workspaceId) : undefined
    const changeButton = moves === undefined || move !== null ? null
      : h(ui.Button, { ref: focusAfterMove, variant: missing ? 'primary' : 'outline', size: 'sm', disabled: busy, onClick: () => { void changeFolder() } }, t('move.change'))
    rows.push(folderRow({
      key: 'main', attached: record !== undefined, display: data.workspace.display, note: missing ? t('move.mainMissing') : t('folders.main'), warn: missing,
      side: h('span', { className: 'dwb-mv-side' }, tag(missing ? t('folders.main') : t('folders.followsSession')), changeButton),
    }))
    if (record !== undefined) {
      rows.push(h('div', { key: 'move-record', className: 'dwb-mv-record' },
        h('span', null, t('move.record', { time: moveTime(record.at), from: record.from })),
        record.undoable
          ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { openOutside({ type: 'undo', target: { moveId: record.moveId, sessions: record.sessions } }) } }, t('move.undo'))
          : null))
    }
    const stuck = moveStatus?.interrupted?.find(item => item.workspaceId === workspaceId)
    if (stuck !== undefined) {
      rows.push(h('div', { key: 'move-stuck', className: 'dwb-wf-panel', role: 'alert' },
        h('p', { className: 'dwb-wf-alert' }, t('move.recoverInline')),
        h('div', { className: 'dwb-wf-btns' },
          h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { openOutside({ type: 'recover', target: stuck }) } },
            t(moveStatus.kind === 'terminal' ? 'move.recoverConfirm.terminal' : 'move.recoverConfirm')))))
    }
    if (move !== null) {
      rows.push(h(MovePanel, {
        key: 'move', t, client: moves.client, titleOf: moves.titleOf, move, busy: busyState, reveal: moveStatus?.reveal === true,
        onRechoose: () => { void changeFolder() }, onRecheck: () => { void planMove(move.path) }, onStart: () => { void startMove() },
        onResult: moveFinished, onClose: () => { returnToChange.current = true; setMove(null); void reloadMoves() },
      }))
    }
    for (const row of data.subfolders) {
      rows.push(folderRow({
        key: `sub-${row.id}`, child: true, display: row.display, note: row.missing ? t('folders.notFound') : t('folders.subfolder'), warn: row.missing,
        side: h(ui.SegmentedControl, {
          id: `dwb-wf-${row.id}`, className: 'dwb-wf-seg', label: t('folders.writeAccess', { name: row.title }), disabled: busy,
          value: row.writable ? 'writable' : 'read-only',
          options: [{ value: 'read-only', label: t('folders.readOnly') }, { value: 'writable', label: t('folders.writable') }],
          onChange: value => { void setWritable(row, value) },
        }),
        remove: { name: row.title, onClick: () => { setConfirming(row) } },
      }))
      if (confirming?.id === row.id) {
        rows.push(h('div', { key: `confirm-${row.id}`, className: 'dwb-wf-panel', role: 'group', 'aria-label': t('folders.remove', { name: row.title }) },
          h('p', { className: 'dwb-wf-kind' }, t('folders.removeSubfolder', { name: row.title })),
          h('div', { className: 'dwb-wf-btns' },
            h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { setConfirming(null) } }, t('folders.cancel')),
            h(ui.Button, { variant: 'outline', size: 'sm', className: 'dwb-wf-danger', disabled: busy, onClick: () => { void removeSubfolder(row) } }, t('folders.confirmRemove')))))
      }
    }
    for (const row of data.externals) {
      // 失效的两种：找不到（含被换成符号链接），宿主拒绝的目录（设置文件被手改过）。宿主都不登记。
      const invalid = row.missing || row.refused !== undefined
      const note = row.refused !== undefined ? t(`folders.externalRefused.${row.refused}`) : row.missing ? t('folders.externalMissing') : t('folders.external')
      rows.push(folderRow({
        key: `ext-${row.path}`, display: row.display, note, warn: invalid,
        side: tag(invalid ? t('folders.externalTag') : t('folders.followsSession')),
        remove: { name: foldersLeaf(row.path), onClick: () => { void removeExternal(row) } },
      }))
    }
    if (pick === null) {
      rows.push(h('button', { key: 'add', type: 'button', className: 'dwb-wf-add', disabled: busy, onClick: () => { void choose() } },
        h(ui.IconPlusOutlineRegular, { size: 16 }), h('span', null, t('folders.add'))))
    } else if (pick.picking) {
      rows.push(h('div', { key: 'pick', className: 'dwb-wf-panel', role: 'status' }, t('folders.picking')))
    } else {
      const known = pick.ok === true || FOLDERS_PICK_ERRORS.includes(pick.reason)
      rows.push(h('div', { key: 'pick', className: 'dwb-wf-panel' },
        pick.display === undefined ? null : h('div', { className: 'dwb-wf-line' }, h('span', null, t('folders.picked')), h('span', { className: 'dwb-wf-dir' }, pick.display)),
        pick.ok === true
          ? h('p', { className: 'dwb-wf-kind' }, t(`folders.kind.${pick.kind}`, { name }))
          : h('p', { className: 'dwb-wf-alert', role: 'alert' }, known ? t(`folders.error.${pick.reason}`) : failed(pick.reason)),
        h('div', { className: 'dwb-wf-btns' },
          pick.ok === true ? h(ui.Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void choose() } }, t('folders.rechoose')) : null,
          pick.ok === true
            ? h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { void confirmAdd() } }, t('folders.confirmAdd'))
            : h(ui.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { void choose() } }, t('folders.rechoose')))))
    }
  }

  return h(ui.Modal, { open: true, onClose: close, title: name, closeLabel: t('folders.close'), headless: true, className: 'dwb-wf-modal' },
    h('div', { className: 'dwb-wf' },
      h('div', { className: 'dwb-wf-top' },
        h('div', { className: 'dwb-wf-head' },
          editing
            ? h('div', { className: 'dwb-wf-rename', onKeyDown: keepOpenOnEscape },
              h(ui.InlineEditor, {
                value: draft, label: t('folders.renameField'), className: 'dwb-wf-rename-input',
                onChange: (value) => { setDraft(value); setRenameError('') }, onSave: saveRename, onCancel: cancelRename,
              }))
            : h('h2', { className: 'dwb-wf-title' }, h('span', { className: 'dwb-wf-name' }, name), iconButton(t('folders.rename'), startRename, ui.IconEditOutlineRegular)),
          renameError ? h('p', { className: 'dwb-wf-alert', role: 'alert' }, renameError) : null,
          h('p', { className: 'dwb-wf-sub' }, t('folders.subtitle'))),
        h('button', { type: 'button', className: 'dwb-wf-iconbtn dwb-wf-close', 'aria-label': t('folders.close'), onClick: close }, h(ui.IconCloseOutlineRegular, { size: 14 }))),
      h('h3', { className: 'dwb-wf-heading' }, t('folders.heading')),
      loadError
        ? h('div', { className: 'dwb-wf-panel' },
          h('p', { className: 'dwb-wf-alert', role: 'alert' }, t('folders.loadFailed')),
          h('div', { className: 'dwb-wf-btns' }, h(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void reload() } }, t('folders.retry'))))
        : data === null
          ? h('p', { className: 'dwb-wf-sub', role: 'status' }, t('folders.loading'))
          : h('div', { className: 'dwb-wf-folders' }, rows),
      error ? h('p', { className: 'dwb-wf-alert', role: 'alert' }, error) : null))
}

/**
 * 样式。尺寸照样稿：对话框 560 像素宽，行内 13 像素字、说明 12 像素；颜色都取 DSH 的深浅色变量。
 * 文件夹卡片的圆角 = DSH 对话框的 28 像素 − 内边距 22 像素 = 6 像素（套在里面的圆角跟着外面的走）。
 * 「只读 / 可写」用官方的 SegmentedControl，格子压到 20 像素高（连官方 4 像素的内边距共 28 像素；它本来是设置页的 36 像素）。
 * 官方对话框自带 24 像素的下边距，这里的内容自己留边，去掉它。「添加文件夹」那一行和选好后的说明用文字色调出的 4% 叠色，
 * 深色下略亮、浅色下略暗，和样稿的 --surface 同向（DSH 对话框本身已经是抬高一层的颜色）。窄到 422 像素左右时，右边的标签和切换换到路径下面。
 */
const WORKSPACE_FOLDERS_STYLE = `
.dwb-wf-modal { width: min(560px, calc(100vw - 32px)); max-width: calc(100vw - 32px); }
[role="dialog"].dwb-wf-modal { padding-bottom: 0; }
.dwb-wf { display: grid; gap: 16px; padding: 20px 22px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; max-height: min(80dvh, 720px); overflow: auto; box-sizing: border-box; }
.dwb-wf-top { display: flex; align-items: flex-start; gap: 8px; }
.dwb-wf-head { flex: 1; min-width: 0; display: grid; gap: 4px; }
.dwb-wf-title { margin: 0; display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
.dwb-wf-name { min-width: 0; overflow-wrap: anywhere; }
.dwb-wf-sub { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dwb-wf-rename { min-width: 0; }
.dwb-wf-rename-input { width: 100%; font-size: 16px; font-weight: 600; }
.dwb-wf-heading { margin: 0; font-size: 14px; font-weight: 500; }
.dwb-wf-iconbtn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dwb-wf-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dwb-wf-iconbtn:disabled { opacity: .5; cursor: default; }
.dwb-wf-iconbtn svg { display: block; }
.dwb-wf-close { width: 28px; height: 28px; margin: -2px -6px 0 0; }
.dwb-wf-folders { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; overflow: hidden; }
.dwb-wf-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 24px; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dwb-wf-child { padding-left: 30px; }
.dwb-wf-glyph { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dwb-wf-glyph svg { display: block; }
.dwb-wf-text { display: grid; gap: 2px; min-width: 0; }
.dwb-wf-dir { font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dwb-wf-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dwb-wf-warn { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
.dwb-wf-tag { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dwb-wf-spacer { width: 24px; }
.dwb-wf-seg { min-width: 0; height: auto; }
.dwb-wf-seg [role="tab"] { height: 20px; min-height: 20px; padding: 0 9px; font-size: 12px; line-height: 20px; }
.dwb-wf-add { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: none; background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.dwb-wf-add:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dwb-wf-add:disabled { opacity: .5; cursor: default; }
.dwb-wf-add svg { display: block; }
.dwb-wf-panel { display: grid; gap: 8px; padding: 12px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 13px; }
.dwb-wf-folders > .dwb-wf-panel:last-child, .dwb-wf-folders > .dwb-wf-row:last-child { border-bottom: none; }
.dwb-wf-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.dwb-wf-kind { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dwb-wf-alert { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dwb-wf-btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.dwb-wf-danger { color: var(--dsw-alias-state-error-primary); }
@media (max-width: 480px) {
  .dwb-wf { padding: 16px; }
  .dwb-wf-row { grid-template-columns: 16px minmax(0, 1fr) 24px; }
  .dwb-wf-row > .dwb-wf-tag, .dwb-wf-row > .dwb-wf-seg, .dwb-wf-row > .dwb-mv-side { grid-column: 2; grid-row: 2; justify-self: start; }
  .dwb-wf-row > .dwb-wf-iconbtn, .dwb-wf-row > .dwb-wf-spacer { grid-column: 3; grid-row: 1; }
}
`

/**
 * 这一行（dsh-workbench-workspace-folders）开着时：样式、工作区右键菜单项和它的图标、对话框层；撤下时全部收回。
 * @param {{ ctx: object, t: (key: string, params?: object) => string }} app 客户端上下文。
 * @param {{ request?: Function }} [options] 测试注入 fetch。
 * @returns {() => void} 撤销函数。
 */
export function applyWorkspaceFolderSettings(app, options = {}) {
  const { ctx, t } = app
  const client = createFoldersClient(options.request)
  const moveClient = createMoveClient(options.request)
  const notices = createMoveNotices(app, moveClient)
  const moves = { client: moveClient, notices, titleOf: moveTitles(ctx) }
  let target = null
  const listeners = new Set()
  const show = (next) => {
    target = next
    for (const listener of [...listeners]) listener()
  }
  const source = {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => target,
  }
  const close = () => { show(null) }
  function Overlay() {
    const current = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    return current === null ? null : h(WorkspaceFoldersDialog, { key: current.workspaceId, app, target: current, client, moves, close })
  }
  const disposers = [
    mountModuleStyle(FOLDERS_OVERLAY, WORKSPACE_FOLDERS_STYLE),
    ctx.contextMenus.register({
      id: 'dsh-workbench.workspace-folders', target: 'workspace', order: 150,
      // 切换界面语言时重新取菜单项的文字。
      observe: () => [ctx.locale],
      resolve: foldersMenu({ t, open: show }),
    }),
    ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: FOLDERS_MENU_ICON }, props => h(ui.IconSettingsOutlineRegular, props))),
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: FOLDERS_OVERLAY }, Overlay)),
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: MOVE_OVERLAY }, notices.Overlay)),
    () => { notices.dispose() },
  ]
  void notices.start()
  return () => {
    close()
    for (const dispose of disposers.reverse()) dispose?.()
  }
}

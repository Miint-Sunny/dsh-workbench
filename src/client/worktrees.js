/** Explicit menu operations. The list comes from this row's route; better-sidebar, when present, only sets the order. */
import { mountModuleStyle } from './style.js';
const WORKTREES_INJECT = ['contextMenus'];
const WORKTREES_ZH = {
  'wt.title': '管理工作树', 'wt.close': '关闭', 'wt.refresh': '刷新', 'wt.create': '创建工作树', 'wt.name': '分支名称', 'wt.from': '本地基准',
  'wt.enter': '进入', 'wt.return': '返回原目录', 'wt.inspect': '检查清理条件', 'wt.trash': '移到废纸篓', 'wt.restore': '恢复工作树', 'wt.untrash': '从废纸篓取回',
  'wt.confirm': '确认操作', 'wt.cancel': '取消', 'wt.loading': '正在读取…', 'wt.current': '当前目录',
  'wt.hint': '新工作树不包含原目录中未提交、未跟踪或被忽略的文件。仅管理当前会话的工作树。',
  'wt.trashHint': '清理后保留分支和 Git 登记，该分支仍处于占用状态；从废纸篓取回后可继续使用。',
  'wt.restoreHint': '恢复检出只恢复记录的已提交内容，不能恢复丢失的未提交改动。',
  'wt.clean': '检查通过；执行时仍会重新核对。', 'wt.blocked': '暂不能清理：{reason}', 'wt.failed': '操作失败：{reason}',
  'wt.retry': '请修正列出的条件后刷新重试。', 'wt.empty': '没有工作树', 'wt.missing': '目录缺失', 'wt.trashed': '已移到废纸篓',
  'wt.interrupted': '存在未完成的创建记录，请先核对 Git 工作树列表；残留目录不会自动删除。',
  'wt.dirty': '有未提交、未跟踪或忽略文件', 'wt.unpublished': '有未发布的提交或没有 upstream', 'wt.in-use': '仍有会话使用',
  'wt.activity-unknown': '有活动任务或无法确认使用情况', 'wt.references': '被其他工作树的符号链接引用', 'wt.scan-incomplete': '扫描未完成', 'wt.locked': 'Git 工作树已锁定',
};
const WORKTREES_EN = {
  'wt.title': 'Manage worktrees', 'wt.close': 'Close', 'wt.refresh': 'Refresh', 'wt.create': 'Create worktree', 'wt.name': 'Branch name', 'wt.from': 'Local base',
  'wt.enter': 'Enter', 'wt.return': 'Return to source', 'wt.inspect': 'Check cleanup', 'wt.trash': 'Move to Trash', 'wt.restore': 'Restore worktree', 'wt.untrash': 'Restore from Trash',
  'wt.confirm': 'Confirm operation', 'wt.cancel': 'Cancel', 'wt.loading': 'Reading…', 'wt.current': 'Current directory',
  'wt.hint': "New worktrees do not include uncommitted, untracked or ignored files from the source. Only this session's worktrees are managed.",
  'wt.trashHint': 'Cleanup keeps the branch and Git registration; the branch stays occupied. Restore it from the Trash to continue using it.',
  'wt.restoreHint': 'Restore checkout recovers committed content only, not lost uncommitted changes.',
  'wt.clean': 'Checks passed. Execution will check again.', 'wt.blocked': 'Cleanup blocked: {reason}', 'wt.failed': 'Operation failed: {reason}',
  'wt.retry': 'Address the listed conditions, then refresh and retry.', 'wt.empty': 'No worktrees', 'wt.missing': 'Directory missing', 'wt.trashed': 'Moved to Trash',
  'wt.interrupted': 'A creation was interrupted. Inspect the Git list first; leftover directories are not deleted automatically.',
  'wt.dirty': 'uncommitted, untracked or ignored files', 'wt.unpublished': 'unpublished commits or no upstream', 'wt.in-use': 'a session still uses it',
  'wt.activity-unknown': 'active jobs or unknown usage', 'wt.references': 'links from other worktrees', 'wt.scan-incomplete': 'scan incomplete', 'wt.locked': 'Git worktree locked',
};
/** 只取 better-sidebar 的路径顺序。任何读不到的情况都返回空数组，由调用方按自己的列表原样显示。 */
export async function readSidebarWorktreePaths({ sessionId, signal } = {}) {
  try {
    const response = await fetch('sidebar/api/git.worktrees', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }), signal });
    if (!response.ok)
      return [];
    const body = await response.json();
    if (body?.ok !== true || !Array.isArray(body.value))
      return [];
    return body.value.map(row => row?.path).filter(path => typeof path === 'string');
  }
  catch {
    return [];
  }
}
/** 列出的路径按给定顺序在前，没列出的保持原相对顺序排在后面。返回新数组，不改传入的数组。 */
export function orderWorktreeEntries(entries, paths) {
  const rank = new Map();
  paths.forEach((path, i) => rank.set(path, i));
  const at = row => rank.get(row.path) ?? paths.length;
  return [...entries].sort((a, b) => at(a) - at(b));
}
function WorktreesDialog({ sessionId, app, close }) {
  const { t } = app, [data, setData] = useState(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [name, setName] = useState(''), [from, setFrom] = useState('HEAD'), [confirmation, setConfirmation] = useState(), [checks, setChecks] = useState({});
  const live = useRef(true), abort = useRef(new AbortController());
  useEffect(() => () => { live.current = false; abort.current.abort(); }, []);
  const call = async (body) => { const res = await fetch('api/dsh-workbench.worktrees', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }), signal: abort.current.signal }); const v = await res.json(); if (!v.ok)
    throw new Error(v.error); return v.value; };
  const load = async () => {
    const value = await call({ op: 'list' });
    const paths = await readSidebarWorktreePaths({ sessionId, signal: abort.current.signal });
    if (live.current)
      setData({ ...value, entries: orderWorktreeEntries(value.entries, paths) });
  };
  const run = async (body) => { setBusy(true); setError(''); try {
    if (body.op === 'inspect') {
      const c = await call(body);
      if (live.current)
        setChecks(v => ({ ...v, [body.id]: c }));
    }
    else {
      await call(body);
      if (live.current) {
        setChecks({});
        setConfirmation(undefined);
      }
      await load();
    }
  }
  catch (e) {
    if (live.current)
      setError(e.message);
  }
  finally {
    if (live.current)
      setBusy(false);
  } };
  useEffect(() => { setBusy(true); load().catch(e => { if (live.current)
    setError(e.message); }).finally(() => { if (live.current)
    setBusy(false); }); }, []);
  // 刷新后上一次的检查结论和确认框都作废，和 run 成功后一样；清理前要重新检查。
  const refresh = () => { setBusy(true); setError(''); setChecks({}); setConfirmation(undefined); load().catch(e => { if (live.current)
    setError(e.message); }).finally(() => { if (live.current)
    setBusy(false); }); };
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, onClick }, t(label));
  return h(ui.Modal, { open: true, onClose: close, title: t('wt.title'), closeLabel: t('wt.close'), className: 'dwb-wt-modal' }, h('div', { className: 'dwb-wt' }, h('p', null, t('wt.hint')), h('p', null, t('wt.trashHint')), h('div', { className: 'dwb-wt-bar' }, h('label', null, t('wt.name'), h('input', { value: name, onChange: e => setName(e.target.value), disabled: busy })), h('label', null, t('wt.from'), h('input', { value: from, onChange: e => setFrom(e.target.value), disabled: busy })), button('wt.create', () => run({ op: 'create', name, from }), !name.trim()), button('wt.refresh', refresh)), busy ? h('p', { role: 'status' }, t('wt.loading')) : null, error ? h('div', { role: 'alert' }, h('p', null, t('wt.failed', { reason: error })), h('p', null, t('wt.retry'))) : null, data?.unfinished.length ? h('p', { role: 'alert' }, t('wt.interrupted')) : null, ...(data?.entries ?? []).map(row => h('section', { key: row.id, className: 'dwb-wt-row', 'data-worktree-id': row.id }, h('strong', null, row.branch ?? 'HEAD'), h('div', { className: 'dwb-wt-path' }, row.path), h('div', null, row.path === data.current ? t('wt.current') : row.missing ? t('wt.missing') : row.trashed ? t('wt.trashed') : ''), row.baseCommit ? h('code', null, row.baseCommit) : null, h('div', { className: 'dwb-wt-bar' }, button('wt.enter', () => run({ op: 'enter', id: row.id }), row.invalid || row.missing || row.trashed || row.path === data.current), row.returnable ? button('wt.return', () => run({ op: 'return', id: row.id })) : null, row.managed && !row.missing && !row.invalid ? button('wt.inspect', () => run({ op: 'inspect', id: row.id })) : null, row.managed ? button(row.trashed ? 'wt.untrash' : row.missing ? 'wt.restore' : 'wt.trash', () => setConfirmation({ op: row.trashed ? 'untrash' : row.missing ? 'restore' : 'trash', id: row.id }), row.invalid || row.trashed && row.missing || !row.missing && !checks[row.id]?.safe) : null), checks[row.id] ? h('div', { role: 'status' }, checks[row.id].safe ? t('wt.clean') : t('wt.blocked', { reason: checks[row.id].blockers.map(x => t(`wt.${x}`)).join(', ') }), ...checks[row.id].references.map(ref => h('div', { key: ref.path, className: 'dwb-wt-path' }, ref.path))) : null)), data && !data.entries.length ? h('p', null, t('wt.empty')) : null, confirmation ? h('div', { className: 'dwb-wt-confirm' }, h('p', null, t(confirmation.op === 'restore' ? 'wt.restoreHint' : 'wt.trashHint')), button('wt.confirm', () => run({ ...confirmation, confirm: true })), button('wt.cancel', () => setConfirmation(undefined))) : null));
}
const WORKTREES_CSS = `.dwb-wt-modal{width:min(780px,calc(100vw - 24px));max-width:calc(100vw - 24px)}.dwb-wt{font-size:13px;line-height:1.5;max-height:70dvh;overflow:auto}.dwb-wt p{font-size:12px;color:var(--dsw-alias-label-secondary)}.dwb-wt-bar{display:flex;align-items:end;gap:8px;flex-wrap:wrap}.dwb-wt label{display:flex;flex-direction:column;gap:4px;min-width:min(180px,100%);flex:1 1 180px}.dwb-wt input{min-width:0;padding:5px;background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;font:inherit}.dwb-wt button{min-height:28px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}.dwb-wt button:disabled{opacity:.5;cursor:default}.dwb-wt-row{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l3)}.dwb-wt-path,.dwb-wt code{display:block;overflow-wrap:anywhere;font-size:12px}.dwb-wt-confirm{padding:12px 0}@media(pointer:coarse){.dwb-wt input{font-size:16px}}`;
export function applyWorktrees(app) {
  const { ctx, t } = app;
  let snapshot, listener;
  const source = { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; return () => { listener = undefined; }; } }, close = () => { snapshot = undefined; listener?.(); };
  const open = id => { snapshot = id; listener?.(); };
  const Panel = () => { const id = React.useSyncExternalStore(source.subscribe, source.getSnapshot); return id ? h(WorktreesDialog, { key: id, sessionId: id, app, close }) : null; };
  const removeStyle = mountModuleStyle('dsh-workbench-worktrees', WORKTREES_CSS);
  const stops = [() => { close(); removeStyle(); }];
  stops.push(ctx.effect(() => ctx.contextMenus.register({ id: 'dsh-workbench.worktrees', target: 'session', order: 325, resolve: ({ sessionId }) => [{ id: 'dsh-workbench.worktrees.open', label: t('wt.title'), icon: { key: 'dsh-workbench.worktrees' }, run: () => open(sessionId) }] }), 'worktrees menu'));
  stops.push(ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-workbench.worktrees' }, props => h(ui.IconBranchOutlineRegular, props))), 'worktrees icon'));
  stops.push(ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-workbench-worktrees' }, Panel)), 'worktrees panel'));
  return () => { for (const stop of stops.reverse())
    stop(); };
}

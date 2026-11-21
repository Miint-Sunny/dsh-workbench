/** Durable ownership and explicit user operations over the official worktree service. */
import { readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sameWorktreePath, normalizeWorktreePath, worktreeGit, registeredWorktrees, worktreeIdentity, inspectWorktree, moveWorktreeToTrash } from './worktrees-safety.js';
import { canonicalPath, isInside } from './checkpoints-git.js';
const exists = async (p) => { try {
  await lstat(p);
  return true;
}
catch (e) {
  if (e.code === 'ENOENT')
    return false;
  throw e;
} };
const idOf = (common, path) => createHash('sha256').update(normalizeWorktreePath(common) + '\0' + normalizeWorktreePath(path)).digest('hex');
function validRecord(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.owner !== 'string' || typeof r.source !== 'string' || !isAbsolute(r.source))
    return false;
  if (!r.path)
    return ['creating', 'interrupted'].includes(r.state) && typeof r.name === 'string';
  return [r.path, r.repositoryRoot, r.identity?.common].every(p => typeof p === 'string' && isAbsolute(p) && !p.includes('\0'))
    && Number.isSafeInteger(r.identity.dev) && Number.isSafeInteger(r.identity.ino) && (typeof r.branch === 'string' || r.borrowed && r.branch === undefined) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.baseCommit)
    && (!r.originalPath || (isAbsolute(r.originalPath) && isInside(r.repositoryRoot, r.originalPath)))
    && (!r.movePending || (isAbsolute(r.movePending) && ['trash', 'untrash'].includes(r.moveKind)));
}
export function createWorktreeManager(deps) {
  let chain = Promise.resolve();
  const file = join(deps.dataRoot, 'records.json');
  const read = async () => { try {
    const v = JSON.parse(await readFile(file, 'utf8'));
    if (v.version !== 1 || !Array.isArray(v.records) || !v.records.every(validRecord))
      throw new Error('invalid worktree records');
    return v.records;
  }
  catch (e) {
    if (e.code === 'ENOENT')
      return [];
    throw e;
  } };
  const save = async (records) => { await mkdir(deps.dataRoot, { recursive: true }); const tmp = join(deps.dataRoot, `records-${randomUUID()}.tmp`); await writeFile(tmp, JSON.stringify({ version: 1, records }) + '\n', { flag: 'wx', mode: 0o600 }); await rename(tmp, file); };
  const agentFor = id => { const a = deps.agent(id); if (!a)
    throw new Error('session-not-open'); if (/^whale(?:-|$)/.test(deps.preset(a) ?? ''))
    throw new Error('preset-excluded'); return a; };
  const idle = a => { if (a.status !== 'idle' || deps.jobs().some(j => ['running', 'stopping'].includes(j.status)))
    throw new Error('activity-unknown'); };
  const activity = () => { const paths = []; let unknown = false; for (const a of deps.agents()) {
    const cwd = deps.cwd(a);
    if (cwd)
      paths.push(cwd);
    else
      unknown = true;
  } if (deps.jobs().some(j => ['running', 'stopping'].includes(j.status)))
    unknown = true; return { activePaths: paths, unknownActivity: unknown, maxEntries: deps.maxEntries, signal: deps.signal }; };
  async function recoverMoves(records) { let changed = false; for (const r of records) {
    if (!r.movePending)
      continue;
    const old = await exists(r.path), moved = await exists(r.movePending);
    if (!old && moved) {
      const identity = await worktreeIdentity(deps.runner, r.movePending);
      if (!sameWorktreePath(identity.common, r.identity.common) || identity.ino !== r.identity.ino || identity.dev !== r.identity.dev)
        throw new Error('interrupted move identity changed');
      if (r.moveKind === 'untrash') {
        r.trashed = false;
        delete r.originalPath;
      }
      else {
        r.originalPath ??= r.path;
        r.trashed = true;
      }
      r.path = r.movePending;
      r.identity = identity;
      delete r.movePending;
      delete r.moveKind;
      changed = true;
    }
    else if (old && !moved) {
      delete r.movePending;
      delete r.moveKind;
      changed = true;
    }
    else
      throw new Error('interrupted move requires inspection');
  } if (changed)
    await save(records); }
  async function handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['op', 'sessionId', 'id', 'name', 'from', 'confirm'].includes(k)))
      throw new Error('invalid request');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(body.sessionId ?? ''))
      throw new Error('invalid session id');
    if (!['list', 'create', 'enter', 'return', 'inspect', 'trash', 'restore', 'untrash'].includes(body.op))
      throw new Error('unknown operation');
    const a = agentFor(body.sessionId), records = await read();
    await recoverMoves(records);
    const own = records.filter(r => r.owner === body.sessionId);
    const current = deps.cwd(a);
    if (!current)
      throw new Error('working-directory-unavailable');
    const source = own.find(r => sameWorktreePath(r.path, current))?.source ?? current;
    const repo = (await worktreeGit(deps.runner, source, ['rev-parse', '--show-toplevel'], deps.signal)).trim();
    const identity = await worktreeIdentity(deps.runner, repo, deps.signal);
    const listed = await registeredWorktrees(deps.runner, repo, deps.signal);
    const entries = listed.map(x => { const managed = own.find(r => sameWorktreePath(r.path, x.path) && sameWorktreePath(r.identity?.common, identity.common)); return { ...x, id: managed?.id ?? idOf(identity.common, x.path), managed: !!managed && !managed.borrowed, returnable: !!managed, trashed: !!managed?.trashed, baseCommit: managed?.baseCommit }; });
    for (const entry of entries) {
      try { const info = await lstat(entry.path); entry.invalid = info.isSymbolicLink() || !info.isDirectory(); }
      catch (error) { if (error.code === 'ENOENT') entry.missing = true; else throw error; }
    }
    for (const r of own)
      if (r.path && sameWorktreePath(r.identity?.common, identity.common) && !entries.some(x => x.id === r.id))
        entries.push({ id: r.id, path: r.path, branch: r.branch, baseCommit: r.baseCommit, managed: !r.borrowed, returnable: true, missing: true, trashed: !!r.trashed });
    if (body.op === 'list')
      return { current, source, entries, unfinished: own.filter(r => !r.path).map(r => ({ id: r.id, name: r.name, state: r.state })) };
    idle(a);
    if (body.op === 'create') {
      if (typeof body.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(body.name) || body.name.split('/').some(x => x === '..' || x === '.' || !x))
        throw new Error('invalid branch name');
      if (body.from !== undefined && (typeof body.from !== 'string' || body.from.length > 200 || body.from.startsWith('-')))
        throw new Error('invalid revision');
      const record = { id: randomUUID(), owner: body.sessionId, source: current, name: body.name, state: 'creating' };
      records.push(record);
      await save(records);
      try {
        const made = await deps.worktrees.create(a, { name: body.name, ...body.from ? { from: body.from } : {} }, deps.signal);
        Object.assign(record, made, { state: 'ready', identity: await worktreeIdentity(deps.runner, made.path, deps.signal) });
        await save(records);
        return { record };
      }
      catch (error) {
        record.state = 'interrupted';
        await save(records);
        throw error;
      }
    }
    const entry = entries.find(x => x.id === body.id), record = own.find(x => x.id === body.id);
    if (!entry)
      throw new Error('unknown worktree');
    if (body.op === 'enter') {
      if (entry.missing || entry.trashed)
        throw new Error('worktree unavailable');
      const actual = await worktreeIdentity(deps.runner, entry.path, deps.signal);
      if (!sameWorktreePath(actual.common, identity.common))
        throw new Error('repository identity changed');
      if (record && (actual.dev !== record.identity.dev || actual.ino !== record.identity.ino))
        throw new Error('worktree identity changed');
      if (!record) {
        records.push({ id: entry.id, owner: body.sessionId, source: current, path: entry.path, repositoryRoot: repo, branch: entry.branch, baseCommit: entry.head, identity: actual, borrowed: true });
        await save(records);
      }
      idle(a);
      return { cwd: await deps.setCwd(a, entry.path, deps.signal) };
    }
    if (!record)
      throw new Error('only owned worktrees can be changed');
    if (!sameWorktreePath(record.identity.common, identity.common))
      throw new Error('repository identity changed');
    if (body.op === 'return')
      return { cwd: await deps.setCwd(a, record.source, deps.signal) };
    if (body.op === 'inspect')
      return inspectWorktree(deps.runner, record, activity());
    if (record.borrowed)
      throw new Error('only created worktrees can be cleaned or restored');
    if (body.confirm !== true)
      throw new Error('confirmation required');
    if (body.op === 'trash') {
      if (deps.canTrash === false)
        throw new Error('Trash is not configured for this platform');
      if (record.trashed)
        throw new Error('already in Trash');
      const original = record.path;
      const destination = await moveWorktreeToTrash(deps.runner, record, { ...activity(), getActivity: () => { idle(a); return activity(); }, beforeMove: () => { idle(a); const state = activity(); if (state.unknownActivity || state.activePaths.some(path => isInside(record.path, path))) throw new Error('worktree became active'); }, trashRoot: deps.trashRoot, onPrepared: async (target) => { idle(a); record.movePending = target; record.moveKind = 'trash'; await save(records); } });
      record.originalPath = original;
      record.path = destination;
      record.trashed = true;
      delete record.movePending;
      delete record.moveKind;
      record.identity = await worktreeIdentity(deps.runner, destination);
      await save(records);
      return { record };
    }
    if (body.op === 'untrash') {
      if (!record.trashed || !record.originalPath || await exists(record.originalPath))
        throw new Error('restore destination unavailable');
      if (!sameWorktreePath(await canonicalPath(record.originalPath), resolve(record.originalPath)))
        throw new Error('restore directory identity changed');
      const check = await inspectWorktree(deps.runner, record, activity());
      if (!check.safe)
        throw new Error('restore blocked');
      record.movePending = record.originalPath;
      record.moveKind = 'untrash';
      await save(records);
      idle(a);
      await worktreeGit(deps.runner, record.repositoryRoot, ['worktree', 'move', '--', record.path, record.originalPath], deps.signal);
      record.path = record.originalPath;
      record.trashed = false;
      delete record.originalPath;
      delete record.movePending;
      delete record.moveKind;
      record.identity = await worktreeIdentity(deps.runner, record.path);
      await save(records);
      return { record };
    }
    if (record.trashed || await exists(record.path))
      throw new Error('restore requires a missing checkout');
    const restored = await deps.worktrees.restore(a, record, deps.signal);
    record.identity = await worktreeIdentity(deps.runner, record.path);
    await save(records);
    return { record, restored };
  }
  return { handle: body => { const run = chain.then(() => handle(body)); chain = run.catch(() => { }); return run; }, dispose: () => chain };
}

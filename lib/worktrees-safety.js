/** Read-only cleanup checks and Git-owned moves; no force remove, branch deletion or hooks. */
import { lstat, realpath, readdir, readlink, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, win32, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPath, isInside } from './checkpoints-git.js';
const pathApi = () => process.platform === 'win32' ? win32 : posix;
export const normalizeWorktreePath = path => pathApi().normalize(path);
export function sameWorktreePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = pathApi().resolve(left), b = pathApi().resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export async function worktreeGit(runner, cwd, args, signal) {
  const r = await runner.run(args, { cwd, signal, env: { GIT_NO_LAZY_FETCH: '1' } });
  if (r.truncated)
    throw new Error('git output incomplete');
  if (r.exitCode !== 0)
    throw new Error(`git failed: ${r.stderr.trim()}`);
  return r.stdout;
}
export async function registeredWorktrees(runner, cwd, signal) {
  const text = await worktreeGit(runner, cwd, ['worktree', 'list', '--porcelain', '-z'], signal), rows = [];
  let row;
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) {
      row = { path: normalizeWorktreePath(field.slice(9)) };
      rows.push(row);
    }
    else if (row && field.startsWith('HEAD '))
      row.head = field.slice(5);
    else if (row && field.startsWith('branch '))
      row.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (row && field.startsWith('locked'))
      row.locked = true;
  }
  return rows;
}
export async function worktreeIdentity(runner, path, signal) {
  const stat = await lstat(path), canonical = await realpath(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !sameWorktreePath(canonical, resolve(path)))
    throw new Error('worktree identity changed');
  const root = (await worktreeGit(runner, path, ['rev-parse', '--show-toplevel'], signal)).trim();
  if (!sameWorktreePath(await realpath(root), canonical))
    throw new Error('worktree identity is not a checkout root');
  const common = (await worktreeGit(runner, path, ['rev-parse', '--git-common-dir'], signal)).trim();
  return { dev: stat.dev, ino: stat.ino, common: await realpath(resolve(path, common)) };
}
/** Scan other registered worktrees without following links, including nested node_modules links. */
export async function worktreeReferences(roots, target, { maxEntries = 200000, signal } = {}) {
  let entries = 0;
  const references = [];
  async function walk(dir) {
    signal?.throwIfAborted();
    if (isInside(target, dir))
      return;
    const info = await lstat(dir);
    if (info.isSymbolicLink())
      throw new Error('registered worktree root is a link');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++entries > maxEntries)
        throw new Error('scan limit exceeded');
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const destination = await canonicalPath(resolve(dirname(path), await readlink(path)));
        if (isInside(target, destination))
          references.push({ path, target: destination });
      }
      else if (entry.isDirectory() && entry.name !== '.git')
        await walk(path);
    }
  }
  for (const root of new Set(roots)) {
    if (sameWorktreePath(root, target))
      continue;
    try {
      await walk(root);
    }
    catch (e) {
      if (e.code === 'ENOENT' && resolve(root) === root) {
        try {
          await lstat(root);
        }
        catch (missing) {
          if (missing.code === 'ENOENT')
            continue;
        }
      }
      throw e;
    }
  }
  return references;
}
/** Refuse ambiguity instead of treating an incomplete check as a clean checkout. */
export async function inspectWorktree(runner, record, { activePaths = [], unknownActivity = false, maxEntries = 200000, signal } = {}) {
  if (!isAbsolute(record.path) || !isAbsolute(record.repositoryRoot))
    throw new Error('invalid recorded path');
  const identity = await worktreeIdentity(runner, record.path, signal);
  if (identity.dev !== record.identity.dev || identity.ino !== record.identity.ino || !sameWorktreePath(identity.common, record.identity.common))
    throw new Error('worktree identity changed');
  const source = await worktreeIdentity(runner, record.repositoryRoot, signal);
  if (!sameWorktreePath(source.common, identity.common) || sameWorktreePath(record.path, record.repositoryRoot))
    throw new Error('repository identity changed');
  const listed = await registeredWorktrees(runner, record.repositoryRoot, signal), entry = listed.find(x => sameWorktreePath(x.path, record.path));
  if (!entry || entry.branch !== record.branch)
    throw new Error('worktree registration changed');
  const status = await worktreeGit(runner, record.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], signal);
  const blockers = [];
  if (entry.locked)
    blockers.push('locked');
  if (status)
    blockers.push('dirty');
  if (entry.head !== record.baseCommit) {
    const upstream = await runner.run(['rev-parse', '--verify', '@{upstream}'], { cwd: record.path, signal });
    if (upstream.exitCode !== 0 || upstream.truncated)
      blockers.push('unpublished');
    else if (Number((await worktreeGit(runner, record.path, ['rev-list', '--count', `${upstream.stdout.trim()}..HEAD`], signal)).trim()) !== 0)
      blockers.push('unpublished');
  }
  for (const path of activePaths)
    if (isInside(record.path, await canonicalPath(path))) {
      blockers.push('in-use');
      break;
    }
  if (unknownActivity)
    blockers.push('activity-unknown');
  let references = [];
  try {
    references = await worktreeReferences(listed.map(x => x.path), record.path, { maxEntries, signal });
  }
  catch (error) {
    signal?.throwIfAborted();
    blockers.push('scan-incomplete');
  }
  if (references.length)
    blockers.push('references');
  return { safe: blockers.length === 0, blockers, references, head: entry.head, branch: entry.branch, identity };
}
/** Move into Trash using Git so the branch and registration remain recoverable. */
export async function moveWorktreeToTrash(runner, record, options) {
  const check = await inspectWorktree(runner, record, options);
  if (!check.safe)
    throw new Error(`cleanup blocked: ${check.blockers.join(', ')}`);
  await mkdir(options.trashRoot, { recursive: true });
  const trashRoot = await realpath(options.trashRoot);
  if (isInside(record.path, trashRoot))
    throw new Error('Trash must be outside the checkout');
  const target = join(trashRoot, `dsh-worktree-${randomUUID()}`);
  await options.onPrepared?.(target);
  const finalCheck = await inspectWorktree(runner, record, { ...options, ...options.getActivity?.() });
  if (!finalCheck.safe)
    throw new Error(`cleanup blocked: ${finalCheck.blockers.join(', ')}`);
  options.beforeMove?.();
  await worktreeGit(runner, record.repositoryRoot, ['worktree', 'move', '--', record.path, target], options.signal);
  return target;
}

/** User-operated worktree management. No model tools or prompt contribution. */
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { registerFeature } from './features.js';
import { workbenchDataDir } from './data-dir.js';
import { resolveGitExecutable, createGitRunner } from './checkpoints-git.js';
import { createWorktreeManager } from './worktrees-service.js';
export const name = '@miint-sunny/dsh-workbench/worktrees';
export function apply(ctx, config = {}) {
  const maxEntries = config.maxScanEntries ?? 200000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new Error('maxScanEntries must be positive');
  if (!ctx.get('worktrees'))
    ctx.plugin(WorktreeService, config.runtime);
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(), 'workbench worktrees lifetime');
  ctx.inject(['worktrees', 'workingDirectory', 'agents', 'jobs', 'subprocess', 'connection', 'agentPresets'], scope => {
    let pending;
    const getManager = () => pending ??= (async () => {
      const dataRoot = join(workbenchDataDir(), 'worktrees'), hooksDir = join(dataRoot, 'no-hooks');
      await mkdir(hooksDir, { recursive: true });
      const subprocess = scope.subprocess;
      const executable = await resolveGitExecutable(subprocess, lifetime.signal);
      if (!executable)
        throw new Error('Git unavailable');
      const manager = createWorktreeManager({ dataRoot, canTrash: process.platform === 'darwin' || typeof config.trashRoot === 'string', trashRoot: config.trashRoot ?? join(homedir(), '.Trash'), maxEntries, signal: lifetime.signal, runner: createGitRunner(subprocess, executable, { hooksDir }), worktrees: scope.worktrees,
        agent: id => scope.agents.get(id), agents: () => scope.agents.list().map(x => scope.agents.get(x.id)).filter(Boolean), jobs: () => scope.jobs.list(), cwd: a => scope.workingDirectory.get(a.session), setCwd: (...args) => scope.workingDirectory.set(...args), preset: a => scope.agentPresets.presetForSession(a.session) });
      return manager;
    })().catch(error => { pending = undefined; throw error; });
    scope.effect(() => registerFeature('worktrees'), 'workbench worktrees feature');
    scope.effect(() => async () => { if (pending) {
      const manager = await pending.catch(() => undefined);
      await manager?.dispose();
    } }, 'workbench worktrees drain');
    scope.connection.fetch.register({ path: '/api/dsh-workbench.worktrees', methods: ['POST'], requestBody: 'buffered', async fetch(request) { try {
        return Response.json({ ok: true, value: await (await getManager()).handle(await request.json()) });
      }
      catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 400 });
      } } });
  });
}

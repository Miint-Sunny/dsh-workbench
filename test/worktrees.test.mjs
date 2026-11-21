import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, rename, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createGitRunner, resolveGitExecutable } from '../lib/checkpoints-git.js';
import { createLocalSubprocess } from './checkpoints-spawn.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import { registeredWorktrees, worktreeIdentity, inspectWorktree, moveWorktreeToTrash } from '../lib/worktrees-safety.js';
import { createWorktreeManager } from '../lib/worktrees-service.js';
async function fixture() {
  const root = resolve('.local/feat57-unit');
  await mkdir(root, { recursive: true });
  const dir = await tempDir('case-', root);
  const repo = join(dir, 'repo'), target = join(repo, '.agents/worktrees/target'), other = join(dir, 'other');
  await mkdir(repo);
  await mkdir(join(dir, 'hooks'));
  const sub = createLocalSubprocess({ home: join(dir, 'home') });
  const runner = createGitRunner(sub, await resolveGitExecutable(sub), { hooksDir: join(dir, 'hooks') });
  const git = async (cwd, args) => { const r = await runner.run(args, { cwd, env: { GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid' } }); assert.equal(r.exitCode, 0, r.stderr); return r.stdout.trim(); };
  await git(repo, ['init', '-b', 'main']);
  await writeFile(join(repo, '.gitignore'), 'ignored/\n.agents/\n');
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'fixture']);
  const baseCommit = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['worktree', 'add', '-b', 'task', target]);
  await git(repo, ['worktree', 'add', '-b', 'other', other]);
  const record = { id: 'fixture', owner: 'session-a', path: await realpath(target), repositoryRoot: await realpath(repo), branch: 'task', baseCommit };
  record.identity = await worktreeIdentity(runner, record.path);
  return { dir, repo, target, other, runner, git, record, inspect: (opts = {}) => inspectWorktree(runner, record, { activePaths: [], ...opts }) };
}
test('忽略文件与未提交内容均阻止清理，字节不变', async () => {
  const f = await fixture();
  await mkdir(join(f.target, 'ignored'));
  await writeFile(join(f.target, 'ignored', 'data'), 'keep');
  assert((await f.inspect()).blockers.includes('dirty'));
  await assert.rejects(moveWorktreeToTrash(f.runner, f.record, { activePaths: [], trashRoot: join(f.dir, 'Trash') }), /blocked/);
  assert.equal(await readFile(join(f.target, 'ignored', 'data'), 'utf8'), 'keep');
});
test('干净但没有发布的提交不能清理', async () => {
  const f = await fixture();
  await writeFile(join(f.target, 'file.txt'), 'commit\n');
  await f.git(f.target, ['commit', '-am', 'unpublished']);
  assert((await f.inspect()).blockers.includes('unpublished'));
});
test('其他工作树的嵌套链接和指向缺失子项的链接都能查到', async () => {
  const f = await fixture();
  await mkdir(join(f.other, 'mcp'));
  await symlink(join(f.target, 'node_modules'), join(f.other, 'mcp', 'node_modules'));
  const x = await f.inspect();
  assert(x.blockers.includes('references'));
  assert.equal(x.references[0].path, join(f.other, 'mcp', 'node_modules'));
});
test('目录换成链接、活动会话、来源不明的任务和未完成扫描均拒绝', async () => {
  const f = await fixture();
  assert((await f.inspect({ activePaths: [join(f.target, 'src')] })).blockers.includes('in-use'));
  assert((await f.inspect({ unknownActivity: true })).blockers.includes('activity-unknown'));
  assert((await f.inspect({ maxEntries: 1 })).blockers.includes('scan-incomplete'));
  await rename(f.target, join(f.dir, 'moved'));
  await symlink(join(f.dir, 'moved'), f.target);
  await assert.rejects(f.inspect(), /identity/);
});
test('移到废纸篓保留文件、分支和登记；源工作区的脏文件不变', async () => {
  const f = await fixture();
  await writeFile(join(f.repo, 'untracked'), 'source dirty');
  const trash = await moveWorktreeToTrash(f.runner, f.record, { activePaths: [], trashRoot: join(f.dir, 'Trash') });
  assert.equal(await readFile(join(trash, 'file.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(join(f.repo, 'untracked'), 'utf8'), 'source dirty');
  assert.equal(await f.git(f.repo, ['rev-parse', 'task']), f.record.baseCommit);
  assert((await f.git(f.repo, ['worktree', 'list', '--porcelain'])).includes(trash));
});
test('重启恢复移动日志；其他会话和任意路径请求不能清理它', async () => {
  const f = await fixture(), store = join(f.dir, 'store'), a = { id: 'session-a', status: 'idle' };
  await mkdir(store);
  const record = { ...f.record, source: f.repo };
  let prepared;
  await moveWorktreeToTrash(f.runner, record, { activePaths: [], trashRoot: join(f.dir, 'Trash'), onPrepared: async (path) => { prepared = path; await writeFile(join(store, 'records.json'), JSON.stringify({ version: 1, records: [{ ...record, movePending: path, moveKind: 'trash' }] })); } });
  let cwd = f.repo, preset = null;
  const manager = createWorktreeManager({ dataRoot: store, runner: f.runner, trashRoot: join(f.dir, 'Trash'), agent: id => ['session-a', 'session-b'].includes(id) ? a : undefined, agents: () => [a], jobs: () => [], cwd: () => cwd, preset: () => preset, setCwd: async (_, path) => { cwd = path; return path; }, worktrees: {} });
  const state = await manager.handle({ op: 'list', sessionId: 'session-a' });
  assert(state.entries.find(x => x.id === 'fixture').trashed);
  assert.equal(JSON.parse(await readFile(join(store, 'records.json'), 'utf8')).records[0].path, prepared);
  await assert.rejects(manager.handle({ op: 'trash', sessionId: 'session-b', id: 'fixture', confirm: true }), /unknown/);
  await assert.rejects(manager.handle({ op: 'trash', sessionId: 'session-a', id: 'fixture', path: f.target, confirm: true }), /invalid/);
  preset = 'whale';
  await assert.rejects(manager.handle({ op: 'list', sessionId: 'session-a' }), /preset-excluded/);
  preset = null;
  await manager.handle({ op: 'untrash', sessionId: 'session-a', id: 'fixture', confirm: true });
  assert.equal(await readFile(join(f.target, 'file.txt'), 'utf8'), 'base\n');
});
test('Git 登记的分支变化时拒绝清理；写入移动日志失败不搬目录', async () => {
  const f = await fixture();
  await assert.rejects(moveWorktreeToTrash(f.runner, f.record, { activePaths: [], trashRoot: join(f.dir, 'Trash'), onPrepared: () => { throw new Error('journal failure'); } }), /journal failure/);
  assert.equal(await readFile(join(f.target, 'file.txt'), 'utf8'), 'base\n');
  await f.git(f.target, ['branch', '-m', 'changed']);
  await assert.rejects(f.inspect(), /registration/);
});
test('写入清理意图后新出现的忽略文件不会被移走', async () => {
  const f = await fixture();
  await assert.rejects(moveWorktreeToTrash(f.runner, f.record, { activePaths: [], trashRoot: join(f.dir, 'Trash'), onPrepared: async () => { await mkdir(join(f.target, 'ignored')); await writeFile(join(f.target, 'ignored', 'late'), 'later'); } }), /blocked/);
  assert.equal(await readFile(join(f.target, 'ignored', 'late'), 'utf8'), 'later');
});

test('仍有 Git 登记的缺失检出会向界面标记 missing',async()=>{
 const f=await fixture(),store=join(f.dir,'store');await mkdir(store);await writeFile(join(store,'records.json'),JSON.stringify({version:1,records:[{...f.record,source:f.repo}]}));await rename(f.target,join(f.dir,'preserved'))
 const a={id:'session-a',status:'idle'},manager=createWorktreeManager({dataRoot:store,runner:f.runner,agent:()=>a,agents:()=>[a],jobs:()=>[],cwd:()=>f.repo,preset:()=>null})
 const value=await manager.handle({op:'list',sessionId:'session-a'});assert.equal(value.entries.find(x=>x.id==='fixture').missing,true)
})

test('W-007 equivalent Git registration and session paths retain ownership and cleanup checks', async () => {
  const f = await fixture(), store = join(f.dir, 'store');
  await mkdir(store);
  await writeFile(join(store, 'records.json'), JSON.stringify({ version: 1, records: [{ ...f.record, source: f.repo }] }));
  const runner = { async run(args, options) {
    const result = await f.runner.run(args, options);
    if (args[0] === 'worktree' && args[1] === 'list') result.stdout = result.stdout.replaceAll(`worktree ${f.record.path}\0`, `worktree ${f.record.path}/.\0`);
    return result;
  } };
  assert.equal((await inspectWorktree(runner, f.record)).safe, true);
  const a = { id: 'session-a', status: 'idle' };
  const manager = createWorktreeManager({ dataRoot: store, runner, agent: () => a, agents: () => [a], jobs: () => [], cwd: () => f.record.path + '/', preset: () => null });
  const value = await manager.handle({ op: 'list', sessionId: 'session-a' });
  assert.equal(value.source, f.repo);
  assert.equal(value.entries.find(x => x.id === 'fixture').managed, true);
  assert.equal(value.entries.filter(x => x.branch === 'task').length, 1);
});


test('W-007 Windows Git slash paths are returned in native form', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const runner = { run: async () => ({ exitCode: 0, stdout: 'worktree C:/repo/work/../task\0HEAD abc\0', stderr: '' }) };
    const rows = await registeredWorktrees(runner, 'C:/repo');
    assert.equal(rows[0].path, 'C:\\repo\\task');
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

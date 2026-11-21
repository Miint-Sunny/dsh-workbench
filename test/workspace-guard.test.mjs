import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createWorkspaceGuard, inspectToolExecution } from '../lib/workspace-guard.js'
import { WORKSPACE_GUARD_EN, WORKSPACE_GUARD_REASON_PREFIX, WORKSPACE_GUARD_ZH } from '../lib/workspace-guard-copy.js'
import { enabledFeatures } from '../lib/features.js'
import { parseApprovalRulesConfig } from '../lib/approval-rules-state.js'
import { createApprovalRuleStore } from '../lib/approval-rules-store.js'
import { createExecutableInspector } from '../lib/approval-rules-executable.js'
import { createApprovalRulesManager } from '../lib/approval-rules-manager.js'

function setupWorkspace(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dwb-wg-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'Users', 'alice')
  const dshHome = join(home, '.dsh')
  const docs = join(home, 'Documents')
  const dshWork = join(docs, 'dsh_work')
  const work = join(docs, 'work')
  const storages = join(dshHome, 'storages')
  const sessions = join(dshHome, 'sessions')
  const sessDir = join(sessions, '--Users-alice-Documents-dsh_work--', 's1')
  for (const dir of [storages, sessDir, dshWork, work]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(storages, 'workspace.json'), JSON.stringify({
    tables: { workspaces: { w1: { path: dshWork, title: 'dsh_work' }, w2: { path: work, title: 'work' } } },
  }))
  writeFileSync(join(work, 'README.md'), 'hello\n')
  symlinkSync(storages, join(docs, 'storages-link'))
  symlinkSync(dshWork, join(docs, 'dsh-work-link'))
  return { root, home, dshHome, docs, dshWork, work, storages, sessions }
}

function fakeHost({ cwd, workspaces, approvalPolicy = 'ask', agentPreset = null, origin = 'user' } = {}) {
  const preExecuteListeners = []
  const disposers = []
  const session = {
    id: 'sess-1',
    header: { id: 'sess-1', cwd, origin },
  }
  const agent = { id: 'sess-1', session }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return () => {
        const idx = disposers.indexOf(dispose)
        if (idx >= 0) disposers.splice(idx, 1)
        dispose?.()
      }
    },
    inject(_names, fn) {
      return fn(ctx)
    },
    get(name) {
      return ctx[name]
    },
    on(event, handler, opts = {}) {
      if (event === 'tools/pre-execute') {
        if (opts.prepend) preExecuteListeners.unshift(handler)
        else preExecuteListeners.push(handler)
        return () => {
          const i = preExecuteListeners.indexOf(handler)
          if (i >= 0) preExecuteListeners.splice(i, 1)
        }
      }
      return () => {}
    },
    workingDirectory: { get: () => cwd },
    workspaceRegistry: workspaces ? { list: () => workspaces.map((path, i) => ({ id: `w${i}`, path })) } : undefined,
    approval: {
      config: { policy: 'ask' },
      effectivePolicy: () => approvalPolicy,
      overrideOf: () => approvalPolicy,
    },
    agentPresets: { presetForSession: () => agentPreset },
    async dispatchPreExecute(exec) {
      let i = 0
      const run = () => {
        const listener = preExecuteListeners[i++]
        return listener ? listener(exec, run) : Promise.resolve({ kind: 'allow' })
      }
      return run()
    },
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose?.()
    },
  }
  return { ctx, agent, session, preExecuteListeners }
}

test('按路径判断的工具：write/edit/apply_patch/str_replace_editor/terminal_send 与只读放行', (t) => {
  const { home, dshHome, docs, work } = setupWorkspace(t)
  const opts = { dshHome, home, cwd: docs, env: { HOME: home, DSH_HOME: dshHome } }

  // write / edit 改写 storages 与 sessions（含 ~、$HOME、相对路径、符号链接）
  for (const name of ['write', 'edit']) {
    assert.equal(inspectToolExecution({ name, arguments: { file_path: '~/.dsh/storages/workspace.json' } }, opts)?.kind, 'dsh-data')
    assert.equal(inspectToolExecution({ name, arguments: { file_path: '$HOME/.dsh/sessions/s1/session.jsonl' } }, opts)?.kind, 'dsh-data')
    assert.equal(inspectToolExecution({ name, arguments: { file_path: '../../.dsh/storages/workspace.json' } }, { ...opts, cwd: work })?.kind, 'dsh-data')
    assert.equal(inspectToolExecution({ name, arguments: { file_path: join(docs, 'storages-link', 'workspace.json') } }, opts)?.kind, 'dsh-data')
    // 工作区里的普通文件不拦
    assert.equal(inspectToolExecution({ name, arguments: { file_path: join(work, 'README.md') } }, opts), null)
  }

  // apply_patch：Add/Update/Delete/Move to
  assert.equal(
    inspectToolExecution({
      name: 'apply_patch',
      arguments: { input: '*** Begin Patch\n*** Update File: ~/.dsh/storages/workspace.json\n@@\n-a\n+b\n*** End Patch' },
    }, opts)?.kind,
    'dsh-data',
  )
  assert.equal(
    inspectToolExecution({
      name: 'apply_patch',
      arguments: { input: '*** Begin Patch\n*** Add File: ~/.dsh/sessions/new/log.jsonl\n+hi\n*** End Patch' },
    }, opts)?.kind,
    'dsh-data',
  )
  assert.equal(
    inspectToolExecution({
      name: 'apply_patch',
      arguments: { input: '*** Begin Patch\n*** Update File: work/README.md\n*** Move to: ../.dsh/sessions/README.md\n@@\n-hello\n+world\n*** End Patch' },
    }, opts)?.kind,
    'dsh-data',
  )
  assert.equal(
    inspectToolExecution({
      name: 'apply_patch',
      arguments: { input: '*** Begin Patch\n*** Update File: work/README.md\n@@\n-hello\n+world\n*** End Patch' },
    }, opts),
    null,
  )

  // str_replace_editor：create/str_replace/insert 拦，view 放行
  assert.equal(inspectToolExecution({ name: 'str_replace_editor', arguments: { command: 'create', path: '~/.dsh/storages/x.json' } }, opts)?.kind, 'dsh-data')
  assert.equal(inspectToolExecution({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: '~/.dsh/sessions/x' } }, opts)?.kind, 'dsh-data')
  assert.equal(inspectToolExecution({ name: 'str_replace_editor', arguments: { command: 'view', path: '~/.dsh/storages/workspace.json' } }, opts), null)

  // read/grep/glob 只读工具放行
  for (const name of ['read', 'grep', 'glob']) {
    assert.equal(inspectToolExecution({ name, arguments: { file_path: '~/.dsh/storages/workspace.json', path: '~/.dsh/sessions' } }, opts), null)
  }

  // terminal_send 按命令判断
  assert.equal(inspectToolExecution({ name: 'terminal_send', arguments: { text: 'rm -rf ~/.dsh/sessions/s1\n' } }, opts)?.kind, 'dsh-data')
  assert.equal(inspectToolExecution({ name: 'terminal_send', arguments: { text: 'ls -la ~/.dsh/sessions\n' } }, opts), null)

  // 外层 run_code 不拦，内层 bash 要拦
  assert.equal(inspectToolExecution({ name: 'run_code', arguments: { code: 'rm -rf ~/.dsh/sessions' } }, opts), null)
  assert.equal(inspectToolExecution({ name: 'bash', parent: Symbol('ptc'), arguments: { command: 'rm -rf ~/.dsh/sessions/s1' } }, opts)?.kind, 'dsh-data')
})

test('审批卡片文案完全符合要求；能从 workspaceRegistry 或 workspace.json 读已登记工作区', async (t) => {
  const { home, dshHome, docs, dshWork, work } = setupWorkspace(t)
  const { ctx, agent } = fakeHost({ cwd: docs, workspaces: undefined }) // 故意不传 workspaceRegistry，测回退读 workspace.json
  const stop = createWorkspaceGuard(ctx, { dshHome, home, env: { HOME: home, DSH_HOME: dshHome } })
  t.after(stop)

  const resData = await ctx.dispatchPreExecute({
    agent,
    name: 'write',
    arguments: { file_path: join(dshHome, 'storages', 'workspace.json') },
  })
  assert.equal(resData.kind, 'ask')
  assert.ok(resData.reason.startsWith(WORKSPACE_GUARD_REASON_PREFIX))
  assert.equal(
    resData.displayReason.zh,
    '这一步会改动 DSH 的会话或工作区登记文件。App 运行时这些改动会被覆盖，还可能让会话打不开。要移动工作区，请在工作区设置中使用「更换文件夹…」。',
  )
  assert.equal(resData.displayReason.en, `${WORKSPACE_GUARD_EN['dshData.reason']} ${WORKSPACE_GUARD_EN.guidance}`)

  const resWs = await ctx.dispatchPreExecute({
    agent,
    name: 'bash',
    arguments: { command: `mv "${dshWork}" "${work}-2"` },
  })
  assert.equal(resWs.kind, 'ask')
  assert.equal(
    resWs.displayReason.zh,
    '这一步会移动或删除已登记的工作区文件夹，工作区里的会话会找不到工作目录。要移动工作区，请在工作区设置中使用「更换文件夹…」。',
  )
  assert.equal(resWs.displayReason.en, `${WORKSPACE_GUARD_EN['workspaceRoot.reason']} ${WORKSPACE_GUARD_EN.guidance}`)
})

test('交互策略要求人工确认，完全权限和子智能体的不询问策略拒绝执行', async (t) => {
  const { home, dshHome, docs, dshWork } = setupWorkspace(t)

  // read-only / workspace-write / auto (ask) -> 必须返回 ask 弹人工审批
  for (const policy of ['ask']) {
    const { ctx, agent } = fakeHost({ cwd: docs, workspaces: [dshWork], approvalPolicy: policy })
    const stop = createWorkspaceGuard(ctx, { dshHome, home, env: { HOME: home, DSH_HOME: dshHome } })
    const r = await ctx.dispatchPreExecute({
      agent,
      name: 'bash',
      arguments: { command: 'rm -rf ~/.dsh/sessions/s1' },
    })
    assert.equal(r.kind, 'ask')
    stop()
  }

  // danger-full-access (approval: 'never') 与子智能体 (approval: 'never') -> 返回 deny 阻止执行并附带原因和正确做法
  for (const [label, origin] of [['danger-full-access', 'user'], ['subagent', 'subagent']]) {
    const { ctx, agent } = fakeHost({ cwd: docs, workspaces: [dshWork], approvalPolicy: 'never', origin })
    const stop = createWorkspaceGuard(ctx, { dshHome, home, env: { HOME: home, DSH_HOME: dshHome } })
    const r = await ctx.dispatchPreExecute({
      agent,
      name: 'bash',
      arguments: { command: 'rm -rf ~/.dsh/sessions/s1' },
    })
    assert.equal(r.kind, 'deny', label)
    assert.equal(r.info?.code, 'PROTECTED_PATH_DENIED', label)
    assert.ok(r.reason.includes(WORKSPACE_GUARD_ZH['dshData.reason']), label)
    assert.ok(r.reason.includes(WORKSPACE_GUARD_ZH.guidance), label)
    stop()
  }
})

test('放行规则即使有完全匹配的规则，也不能代答工作台保护引发的审批请求', async (t) => {
  const { root, home, dshHome, docs, dshWork } = setupWorkspace(t)
  const config = parseApprovalRulesConfig({ executableRoots: ['/bin'] })
  const store = createApprovalRuleStore(join(root, 'approval-rules.json'), config)
  class LocalBashExecutor {
    resolve(r) { return { ...r, stdoutMaxBytes: 100 } }
    spawnSpec(r, argv) { return { argv, cwd: r.workdir, env: { PATH: '/bin:/usr/bin' } } }
  }

  let approvalListener
  const agent = {
    id: 's-rule',
    session: { id: 's-rule', header: { cwd: docs } },
    ctx: { on: (_ev, fn) => { approvalListener = fn; return () => {} } },
  }
  const hostCtx = {
    agents: { list: () => [agent], get: () => agent },
    agentPresets: { presetForSession: () => null, serviceFor: () => undefined },
    approval: { effectivePolicy: () => 'ask' },
    workingDirectory: { get: () => docs },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    shell: new LocalBashExecutor(),
    subprocess: { resolveExecutable: async (cmd) => (cmd === 'bash' ? '/bin/bash' : '/bin/rm') },
  }
  const args = { description: 'remove', command: `/bin/rm -rf ${dshWork}` }
  const candidate = await createExecutableInspector(config).inspect(hostCtx, { agent }, args, new AbortController().signal)
  const saved = await store.create(0, candidate, [], () => true)

  const manager = createApprovalRulesManager({ ctx: hostCtx, config, store })
  t.after(() => manager.dispose())
  await manager.start()

  const { ctx: guardCtx } = fakeHost({ cwd: docs, workspaces: [dshWork], approvalPolicy: 'ask' })
  const stopGuard = createWorkspaceGuard(guardCtx, { dshHome, home, env: { HOME: home, DSH_HOME: dshHome } })
  t.after(stopGuard)

  // 1. 先过工作台保护，拿它给的 reason
  const guardDecision = await guardCtx.dispatchPreExecute({ agent, name: 'bash', arguments: args })
  assert.equal(guardDecision.kind, 'ask')

  // 2. 没有保护 reason 时，放行规则确实会命中并自动允许
  manager.onEvent(agent.session, { type: 'tool/call', data: { name: 'bash', callId: 'c1', arguments: JSON.stringify(args) } })
  manager.onEvent(agent.session, { type: 'approval/asked', data: { toolName: 'bash', callId: 'c1', id: 'a1' } })
  assert.equal(await approvalListener({ agent, toolName: 'bash', callId: 'c1', signal: new AbortController().signal }, async () => 'rejected'), 'allowed-once')

  // 3. 带上工作台保护的 reason 后，放行规则不得代答，必须落回人工审批（next）
  manager.onEvent(agent.session, { type: 'tool/call', data: { name: 'bash', callId: 'c2', arguments: JSON.stringify(args) } })
  manager.onEvent(agent.session, { type: 'approval/asked', data: { toolName: 'bash', callId: 'c2', id: 'a2', reason: guardDecision.reason } })
  let fellThroughToManual = 0
  let inspectWhilePending
  let createError
  const outcome = await approvalListener(
    { agent, toolName: 'bash', callId: 'c2', reason: guardDecision.reason, signal: new AbortController().signal },
    async () => {
      fellThroughToManual++
      inspectWhilePending = await manager.inspect('s-rule', 'c2')
      try {
        await manager.create({
          sessionId: 's-rule',
          callId: 'c2',
          token: 't',
          revision: saved.revision,
          options: [],
        })
      } catch (error) {
        createError = error.code
      }
      return 'rejected'
    },
  )
  assert.equal(outcome, 'rejected')
  assert.equal(fellThroughToManual, 1)
  assert.deepEqual(inspectWhilePending, { eligible: false, reason: 'protected-target' })
  assert.equal(createError, 'request-ended')
})

test('功能开关：apply 开启并登记到 features；关掉（dispose）后不再拦截', async (t) => {
  const { home, dshHome, docs, dshWork } = setupWorkspace(t)
  const { ctx, agent } = fakeHost({ cwd: docs, workspaces: [dshWork], approvalPolicy: 'ask' })
  // 让 apply 使用测试里的 tools/dshHome
  ctx.tools = {}
  apply(ctx, { dshHome, home, env: { HOME: home, DSH_HOME: dshHome } })
  t.after(() => ctx.disposeAll())

  assert.ok(enabledFeatures().some(f => f.id === 'workspace-guard'))
  const blocked = await ctx.dispatchPreExecute({
    agent,
    name: 'bash',
    arguments: { command: 'rm -rf ~/.dsh/sessions/s1' },
  })
  assert.equal(blocked.kind, 'ask')

  // 关掉这一行
  ctx.disposeAll()
  assert.ok(!enabledFeatures().some(f => f.id === 'workspace-guard'))
  const afterDisable = await ctx.dispatchPreExecute({
    agent,
    name: 'bash',
    arguments: { command: 'rm -rf ~/.dsh/sessions/s1' },
  })
  assert.equal(afterDisable.kind, 'allow')
})

test('保护询问保留下游拒绝和取消', async t => {
  const { dshHome, home, work } = setupWorkspace(t)
  for (const decision of [{ kind: 'deny', reason: 'local policy' }, { kind: 'cancel' }]) {
    const { ctx, agent } = fakeHost({ cwd: work, workspaces: [work] })
    ctx.on('tools/pre-execute', () => decision)
    t.after(createWorkspaceGuard(ctx, { dshHome, home }))
    assert.deepEqual(await ctx.dispatchPreExecute({
      agent, name: 'write', arguments: { file_path: join(dshHome, 'sessions', 'note') },
    }), decision)
  }
})

test('分析预算耗尽时询问或拒绝，普通多行输入仍可执行', async t => {
  const { home, dshHome, work } = setupWorkspace(t)
  for (const [approvalPolicy, expected] of [['ask', 'ask'], ['never', 'deny']]) {
    const { ctx, agent } = fakeHost({ cwd: work, workspaces: [work], approvalPolicy })
    t.after(createWorkspaceGuard(ctx, { home, dshHome }))
    const inspect = command => ctx.dispatchPreExecute({ name: 'bash', agent, arguments: { command } })
    assert.equal((await inspect('cat README.md\n'.repeat(400))).kind, 'allow')
    const large = await inspect('echo ' + 'a'.repeat(256 * 1024))
    assert.equal(large.kind, expected)
    assert.match(large.reason, /verify|inspect/i)
    const nested = await inspect('echo $('.repeat(80) + 'pwd' + ')'.repeat(80))
    assert.equal(nested.kind, expected)
  }
})

test('登记表损坏时仍能读取和写普通文件，移动未知根目录要确认', async t => {
  const { home, dshHome, work, storages } = setupWorkspace(t)
  const { ctx, agent } = fakeHost({ cwd: work })
  t.after(createWorkspaceGuard(ctx, { home, dshHome }))
  for (const invalid of ['{', '{"tables":{}}', '{"tables":{"workspaces":{"w":{}}}}']) {
    writeFileSync(join(storages, 'workspace.json'), invalid)
    const inspect = command => ctx.dispatchPreExecute({ name: 'bash', agent, arguments: { command } })
    assert.equal((await inspect('ls')).kind, 'allow')
    assert.equal((await inspect('touch diary')).kind, 'allow')
    assert.equal((await inspect('mv ../work ../archive')).kind, 'ask')
  }
})

test('小鲸鱼的日记、工具和目录内文件照常使用，登记根目录本身受保护', async t => {
  const { home, dshHome } = setupWorkspace(t)
  const whale = join(home, 'Whale')
  mkdirSync(join(whale, 'room'), { recursive: true })
  const { ctx, agent } = fakeHost({ cwd: whale, workspaces: [whale], agentPreset: 'whale' })
  let reads = 0
  ctx.workspaceRegistry = { list() { reads++; return [{ path: whale }] } }
  t.after(createWorkspaceGuard(ctx, { home, dshHome }))
  for (const [name, args] of [
    ['read', { file_path: 'room/diary' }], ['say', { text: 'hello' }],
  ]) assert.equal((await ctx.dispatchPreExecute({ agent, name, arguments: args })).kind, 'allow')
  assert.equal(reads, 0, '读取日记和对话无需枚举全机登记目录')
  for (const [name, args] of [
    ['write', { file_path: 'room/diary' }],
    ['bash', { command: 'git status && mv room/draft room/entry' }],
  ]) assert.equal((await ctx.dispatchPreExecute({ agent, name, arguments: args })).kind, 'allow')
  assert.equal((await ctx.dispatchPreExecute({ agent, name: 'bash', arguments: { command: 'mv ../Whale ../archive' } })).kind, 'ask')
})

test('登记服务出错且回退文件尚不存在时，不能把已有工作区当成空表', async t => {
  const { home, work } = setupWorkspace(t)
  const { ctx, agent } = fakeHost({ cwd: work })
  ctx.workspaceRegistry = { list() { throw new Error('registry unavailable') } }
  t.after(createWorkspaceGuard(ctx, { home, dshHome: join(home, 'unavailable') }))
  const result = await ctx.dispatchPreExecute({ agent, name: 'bash', arguments: { command: 'mv ../work ../archive' } })
  assert.equal(result.kind, 'ask')
})

const app = process.env.DSH_PROTOCOL_APP ?? process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
const electron = join(app, 'Contents/MacOS/DeepSeek Harness')
test('随 App 发布的自动审查在两种监听顺序下都保留人工询问，审查失败则拒绝', {
  skip: existsSync(electron) ? false : '需要 DSH 桌面 App',
}, t => {
  const { home } = setupWorkspace(t)
  const fixture = fileURLToPath(new URL('./fixtures/workspace-guard-auto-review.mjs', import.meta.url))
  const reviewer = join(app, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js')
  execFileSync(electron, [fixture, reviewer, home], {
    env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 10000,
  })
})

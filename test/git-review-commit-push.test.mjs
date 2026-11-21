/**
 * 审阅面板宿主（提交、推送、建分支与提交信息生成）测试：
 * - 提交：空信息/游离 HEAD/冲突/锁/无暂存拒绝；仓库钩子照常运行；钩子失败返回最后 20 行；commit+push 各自返回状态
 * - 推送：本地裸仓库有上游、无上游（pushRemote / pushDefault / 唯一远程 / origin）自动设上游、非快进被拒、绝不传强推参数
 * - 建分支：游离 HEAD 建分支、空仓库改 HEAD 分支、check-ref-format 非法分支名拒绝、重名拒绝
 * - 生成提交信息：假模型测试、最近 10 条提交标题、超大差异降级为文件清单、取消生成、失败原因、只读内部预设隔离、commitModel 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import { parseGitReviewConfig } from '../lib/git-review/config.js'
import { createGitReviewGit } from '../lib/git-review/git.js'
import { createGitReviewStore } from '../lib/git-review/store.js'
import {
  COMMIT_MESSAGE_PRESET,
  mountCommitMessagePreset,
} from '../lib/git-review/commit-message.js'
import { createGitReviewService } from '../lib/git-review/service.js'

const write = (path, content) => writeFile(path, content, typeof content === 'string' ? 'utf8' : undefined)

async function mustGit(cwd, args, options) {
  const result = await runGit(cwd, args, options)
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

async function setupRepoIdentity(repo) {
  await mustGit(repo, ['config', 'user.name', 'dwb test'])
  await mustGit(repo, ['config', 'user.email', 'test@dsh-workbench'])
}

async function commitAll(repo, msg) {
  await mustGit(repo, ['add', '-A'])
  await mustGit(repo, [...COMMIT_IDENTITY, 'commit', '-qm', msg])
  return (await mustGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
}

async function setupCommitEnv(overrides = {}, commitEnv = {}) {
  const root = await tempDir('dwb-gr-cp-')
  const dataDir = join(root, 'git-review-data')
  const trashDir = join(root, 'trash')
  const home = join(root, 'git-home')
  await mkdir(home, { recursive: true })
  const baseSubprocess = createLocalSubprocess({ home })
  const spawnLog = []
  const subprocess = {
    resolveExecutable: (...args) => baseSubprocess.resolveExecutable(...args),
    spawn(spec) {
      spawnLog.push(spec.argv)
      return baseSubprocess.spawn(spec.argv.includes('commit') ? { ...spec, env: { ...commitEnv, ...spec.env } } : spec)
    },
  }
  const foldersMap = new Map()
  const modelsMap = new Map()
  const config = parseGitReviewConfig({
    gitReviewDataDir: dataDir,
    trashDir,
    ...overrides,
  })
  const git = createGitReviewGit({
    subprocess,
    dataDir,
    timeoutMs: config.gitTimeoutMs,
    maxDiffBytes: config.maxDiffBytes,
  })
  const store = createGitReviewStore(dataDir)
  let commitManager = null
  const service = createGitReviewService({
    config,
    git,
    store,
    isRunning: () => false,
    foldersOf: async (id) => foldersMap.get(id),
    resolveModel: (id) => modelsMap.get(id) ?? { provider: 'fake-provider', model: 'fake-model' },
    get commitMessageManager() {
      return commitManager
    },
  })
  return {
    root,
    config,
    git,
    store,
    service,
    spawnLog,
    setFolders: (id, dirs) => foldersMap.set(id, dirs),
    setModel: (id, m) => modelsMap.set(id, m),
    setCommitManager: (m) => { commitManager = m },
  }
}

test('commit：护栏检查、正常执行仓库钩子、钩子失败返回最后 20 行', async () => {
  const { root, service, setFolders } = await setupCommitEnv()
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])
  await setupRepoIdentity(repo)
  await write(join(repo, 'a.txt'), 'v1\n')
  await commitAll(repo, 'init')

  setFolders('s1', [repo])
  const repoId = (await service.status('s1')).repos[0].id

  // 1. 空信息拒绝
  const badMsg = await service.commit({ sessionId: 's1', repo: repoId, message: '   ', push: false })
  assert.equal(badMsg.ok, false)
  assert.equal(badMsg.code, 'bad-request')

  // 2. 没有已暂存改动拒绝（no-staged）
  await write(join(repo, 'a.txt'), 'v2\n')
  const noStaged = await service.commit({ sessionId: 's1', repo: repoId, message: 'update', push: false })
  assert.equal(noStaged.ok, false)
  assert.equal(noStaged.code, 'no-staged')

  // 3. 暂存后安装失败的 pre-commit 钩子（输出 30 行），应拦截并返回最后 20 行
  await mustGit(repo, ['add', 'a.txt'])
  const linesScript = Array.from({ length: 30 }, (_, i) => `echo "hook-line-${i + 1}" >&2`).join('\n')
  await write(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${linesScript}\nexit 1\n`)
  await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o755)

  const hookFail = await service.commit({ sessionId: 's1', repo: repoId, message: 'feat: try', push: false })
  assert.equal(hookFail.ok, false)
  assert.equal(hookFail.code, 'hook-failed')
  assert.equal(hookFail.detail.includes('hook-line-10\n'), false)
  assert.ok(hookFail.detail.includes('hook-line-11'))
  assert.ok(hookFail.detail.includes('hook-line-30'))
  assert.equal(hookFail.detail.split('\n').length <= 20, true)

  // 4. 钩子通过时提交成功（且验证钩子确实运行过）
  const ranMarker = join(root, 'COMMIT_HOOK_RAN')
  await write(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${ranMarker}"\nexit 0\n`)
  await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o755)

  const okRes = await service.commit({ sessionId: 's1', repo: repoId, message: 'feat: pass hook', push: false })
  assert.equal(okRes.ok, true)
  assert.match(okRes.sha, /^[0-9a-f]{40}$/)
  assert.equal(await readFile(ranMarker, 'utf8'), '')

  // 5. 游离 HEAD 不允许提交
  await mustGit(repo, ['checkout', '--detach', 'HEAD'])
  await write(join(repo, 'a.txt'), 'v3\n')
  await mustGit(repo, ['add', 'a.txt'])
  const detRes = await service.commit({ sessionId: 's1', repo: repoId, message: 'detached', push: false })
  assert.equal(detRes.ok, false)
  assert.equal(detRes.code, 'detached')
})

test('push 与 commit+push：本地裸仓库有上游、无上游（pushRemote/pushDefault/唯一远程/origin）、非快进拒绝且永不强推', async () => {
  const { root, service, spawnLog, setFolders } = await setupCommitEnv()
  const bareOrigin = join(root, 'origin.git')
  const bareBackup = join(root, 'backup.git')
  const repo = join(root, 'work')
  const peer = join(root, 'peer')
  await mkdir(repo, { recursive: true })
  await mustGit(root, ['init', '--bare', bareOrigin])
  await mustGit(root, ['init', '--bare', bareBackup])
  await mustGit(repo, ['init', '-b', 'main'])
  await setupRepoIdentity(repo)
  await write(join(repo, 'f.txt'), 'base\n')
  await commitAll(repo, 'init')
  await mustGit(repo, ['remote', 'add', 'origin', bareOrigin])

  setFolders('s1', [repo])
  const repoId = (await service.status('s1')).repos[0].id

  // 1. 没有上游，只有一个远程 origin：自动设上游并推送
  const firstPush = await service.push({ sessionId: 's1', repo: repoId })
  assert.deepEqual(firstPush, { ok: true, remote: 'origin', branch: 'main', createdUpstream: true })

  // 2. 再加第二个远程 backup，新开分支通过 branch.<name>.pushRemote 推到 backup
  await mustGit(repo, ['remote', 'add', 'backup', bareBackup])
  await mustGit(repo, ['checkout', '-b', 'topic'])
  await mustGit(repo, ['config', 'branch.topic.pushRemote', 'backup'])
  await write(join(repo, 'topic.txt'), 't1\n')
  await commitAll(repo, 'topic 1')
  const topicPush = await service.push({ sessionId: 's1', repo: repoId })
  assert.deepEqual(topicPush, { ok: true, remote: 'backup', branch: 'topic', createdUpstream: true })

  // 已有上游后再推：createdUpstream 为 false
  await write(join(repo, 'topic.txt'), 't2\n')
  await mustGit(repo, ['add', 'topic.txt'])
  const commitPushOk = await service.commit({ sessionId: 's1', repo: repoId, message: 'topic 2', push: true })
  assert.equal(commitPushOk.ok, true)
  assert.equal(commitPushOk.pushed, true)
  assert.equal(commitPushOk.pushError, undefined)

  // 3. 另一个克隆体向 origin/main 推入新提交，制造非快进冲突
  await mustGit(root, ['clone', bareOrigin, peer])
  await setupRepoIdentity(peer)
  await mustGit(peer, ['checkout', 'main'])
  await write(join(peer, 'peer.txt'), 'ahead on remote\n')
  await commitAll(peer, 'remote ahead')
  await mustGit(peer, ['push', 'origin', 'main'])

  await mustGit(repo, ['checkout', 'main'])
  await write(join(repo, 'local.txt'), 'diverge\n')
  await mustGit(repo, ['add', 'local.txt'])
  const commitPushFail = await service.commit({ sessionId: 's1', repo: repoId, message: 'diverge commit', push: true })
  assert.equal(commitPushFail.ok, true) // 提交本身成功
  assert.equal(commitPushFail.pushed, false)
  assert.equal(commitPushFail.pushError, 'push-rejected')

  const directPushFail = await service.push({ sessionId: 's1', repo: repoId })
  assert.equal(directPushFail.ok, false)
  assert.equal(directPushFail.code, 'push-rejected')
  assert.match(directPushFail.detail, /远程有新|快进/)

  // 确认自始至终从未向 git push 传过任何强推参数
  const pushCalls = spawnLog.filter(argv => argv.includes('push'))
  assert.ok(pushCalls.length >= 4)
  for (const argv of pushCalls) {
    assert.equal(argv.some(arg => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease') || arg.startsWith('+')), false, argv.join(' '))
  }
})

test('create-branch：游离 HEAD 建分支、空仓库建分支、非法名字与重名拒绝', async () => {
  const { root, service, setFolders } = await setupCommitEnv()
  const repo = join(root, 'repo')
  const empty = join(root, 'empty')
  await mkdir(repo, { recursive: true })
  await mkdir(empty, { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])
  await mustGit(empty, ['init', '-b', 'main'])
  await write(join(repo, 'a.txt'), '1\n')
  await commitAll(repo, 'init')
  await mustGit(repo, ['checkout', '--detach', 'HEAD'])

  setFolders('s1', [repo, empty])
  const st = await service.status('s1')
  const repoId = st.repos[0].id
  const emptyId = st.repos[1].id
  assert.equal(st.repos[0].detached, true)

  for (const bad of ['', '  ', '-opt', 'HEAD', '@', 'feat..bar', 'bad space', 'a~1', 'a/']) {
    const res = await service.createBranch({ sessionId: 's1', repo: repoId, name: bad })
    assert.equal(res.ok, false, bad)
    assert.equal(res.code, 'invalid-branch-name', bad)
  }

  const dup = await service.createBranch({ sessionId: 's1', repo: repoId, name: 'main' })
  assert.equal(dup.ok, false)
  assert.equal(dup.code, 'conflict')

  const shorthand = await service.createBranch({ sessionId: 's1', repo: repoId, name: '@{-1}' })
  assert.equal(shorthand.code, 'invalid-branch-name')

  const created = await service.createBranch({ sessionId: 's1', repo: repoId, name: 'feat/from-detached' })
  assert.deepEqual(created, { ok: true, branch: 'feat/from-detached' })

  const stAfter = await service.status('s1')
  assert.equal(stAfter.repos[0].detached, false)
  assert.equal(stAfter.repos[0].branch, 'feat/from-detached')

  // 空仓库也能改默认初始分支名
  const emptyBranch = await service.createBranch({ sessionId: 's1', repo: emptyId, name: 'trunk' })
  assert.deepEqual(emptyBranch, { ok: true, branch: 'trunk' })
  const stEmpty = await service.status('s1')
  assert.equal(stEmpty.repos[1].branch, 'trunk')
})

test('generate-message 与只读预设：假模型生成、最近 10 条标题、超限降级为文件清单、取消与失败、commitModel 覆盖', async () => {
  const { root, config, service, setFolders, setModel, setCommitManager } = await setupCommitEnv({
    maxCommitDiffBytes: 256,
    commitModel: 'deepseek-reasoner',
  })
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])
  for (let i = 1; i <= 12; i++) {
    await write(join(repo, 'log.txt'), `step-${i}\n`)
    await commitAll(repo, `chore: commit-${i}`)
  }

  setFolders('s1', [repo])
  setModel('s1', { provider: 'deepseek', model: 'deepseek-chat' })
  const repoId = (await service.status('s1')).repos[0].id

  // 1. 假 Cordis 宿主验证 mountCommitMessagePreset 的只读、无工具与内部预设登记
  const registeredPresets = []
  const createdAgents = []
  const scopeListeners = new Map()
  let nextReply = { text: 'feat: add staged greeting', delayMs: 0, failWith: null }

  const fakeScope = {
    agentPresets: {
      async register(def) { registeredPresets.push(def); return () => {} },
      presetForSession: (session) => session.preset,
      async mount() {},
    },
    agents: {
      async create({ sessionId, meta, agentOptions, signal, setup }) {
        const appended = []
        const ctxListeners = new Map()
        const restrictions = []
        const sections = []
        let runtimeContext = 'ambient project context'
        const session = {
          id: sessionId,
          preset: meta.agentPreset,
          append: (type, data) => appended.push({ type, data }),
          snapshotEvents: () => [],
        }
        const agentCtx = {
          tools: { restrict: (r) => restrictions.push(r) },
          effect: () => () => {},
          on: (ev, fn) => {
            if (!ctxListeners.has(ev)) ctxListeners.set(ev, [])
            ctxListeners.get(ev).push(fn)
          },
          systemPrompt: { section: (sec) => sections.push(sec), suppressRuntimeContext() { runtimeContext = '' } },
        }
        const agent = {
          id: sessionId,
          session,
          ctx: agentCtx,
          modelOptions: agentOptions,
          promptSeen: null,
          cancelled: false,
          idlePromise: null,
          followup(msg) {
            this.idlePromise = (async () => {
              const injected = { id: 'workspace', content: [{ type: 'text', text: 'ambient instructions' }] }
              const decision = await ctxListeners.get('agent/pre-step')[0]({}, () => ({ kind: 'enter', messages: [msg, injected] }))
              this.promptSeen = runtimeContext + decision.messages.map(message => message.content[0].text).join('\n')
              if (nextReply.delayMs > 0) {
                await new Promise((resolve, reject) => {
                  const timer = setTimeout(resolve, nextReply.delayMs)
                  signal?.addEventListener('abort', () => {
                    clearTimeout(timer)
                    reject(new Error('aborted'))
                  }, { once: true })
                })
              }
              if (nextReply.failWith) throw new Error(nextReply.failWith)
              const event = {
                type: 'assistant/message',
                data: {
                  message: { content: [{ type: 'text', text: nextReply.text }] },
                },
              }
              for (const fn of ctxListeners.get('session/event') ?? []) fn(session, event)
            })()
          },
          whenIdle() { return this.idlePromise ?? Promise.resolve() },
          cancel() { this.cancelled = true },
        }
        await setup(agentCtx, agent)
        createdAgents.push({ agent, appended, restrictions, sections, ctxListeners })
        return { agent, dispose: async () => {} }
      },
    },
    on(ev, fn) {
      if (!scopeListeners.has(ev)) scopeListeners.set(ev, [])
      scopeListeners.get(ev).push(fn)
      return () => {}
    },
    effect: (fn) => fn(),
  }

  const mounted = await mountCommitMessagePreset(fakeScope, config)
  setCommitManager(mounted.manager)

  // 校验预设已登记为内部只读预设
  assert.equal(registeredPresets.length, 1)
  assert.equal(registeredPresets[0].id, COMMIT_MESSAGE_PRESET)
  assert.deepEqual(registeredPresets[0].plugins, [])
  assert.ok(registeredPresets[0].name.includes('内部'))

  // 没有暂存改动时拒绝生成
  const noStaged = await service.generateMessage({ sessionId: 's1', repo: repoId })
  assert.equal(noStaged.ok, false)
  assert.equal(noStaged.code, 'no-staged')

  // 2. 小改动：prompt 含 diff 与最近 10 条（不含 commit-1、commit-2）
  await write(join(repo, 'greet.txt'), 'hello\n')
  await mustGit(repo, ['add', 'greet.txt'])
  const gen1 = await service.generateMessage({ sessionId: 's1', repo: repoId })
  assert.equal(gen1.ok, true)
  assert.ok(gen1.requestId)

  // 等待后台假模型结束
  await mounted.manager.whenSettled(gen1.requestId)
  const st1 = service.generationStatus(gen1.requestId)
  assert.deepEqual(st1, { ok: true, status: 'done', message: 'feat: add staged greeting' })

  const firstRun = createdAgents[0]
  assert.equal(firstRun.agent.modelOptions.model, 'deepseek-reasoner') // commitModel 覆盖生效
  assert.equal(firstRun.agent.modelOptions.provider, 'deepseek')
  assert.deepEqual(firstRun.restrictions, [{ allow: [] }])
  assert.ok(firstRun.appended.some(e => e.type === 'sandbox/mode' && e.data.mode === 'read-only'))
  assert.ok(firstRun.appended.some(e => e.type === 'approval/policy' && e.data.policy === 'never'))
  // 工具调用一律被 tools/pre-execute 拒绝
  const toolDeny = await firstRun.ctxListeners.get('tools/pre-execute')[0]({ name: 'bash' }, () => ({ kind: 'allow' }))
  assert.equal(toolDeny.kind, 'deny')
  // 手动选择该预设且没有对应活跃作业时，scope 的 pre-step 拒绝
  const fakeManualAgent = { id: 'manual-1', session: { preset: COMMIT_MESSAGE_PRESET, append() {} }, ctx: firstRun.agent.ctx }
  const manualPreStep = await scopeListeners.get('agent/pre-step')[0]({ agent: fakeManualAgent }, () => 'next')
  assert.deepEqual(manualPreStep, { kind: 'reject' })

  assert.doesNotMatch(firstRun.agent.promptSeen, /ambient project context|ambient instructions/)
  assert.ok(firstRun.agent.promptSeen.includes('chore: commit-12'))
  assert.ok(firstRun.agent.promptSeen.includes('chore: commit-3'))
  assert.equal(firstRun.agent.promptSeen.includes('chore: commit-2\n'), false)
  assert.ok(firstRun.agent.promptSeen.includes('+hello'))

  // 3. 大差异超过 maxCommitDiffBytes (120)：降级只给文件列表与行数，不贴 diff 正文
  await write(join(repo, 'big-staged.txt'), 'DIFF_BODY_SHOULD_NOT_APPEAR\n'.repeat(10))
  await mustGit(repo, ['add', 'big-staged.txt'])
  nextReply = { text: '```\nchore: add big staged file\n```', delayMs: 0, failWith: null }
  const gen2 = await service.generateMessage({ sessionId: 's1', repo: repoId })
  await mounted.manager.whenSettled(gen2.requestId)
  const st2 = service.generationStatus(gen2.requestId)
  assert.deepEqual(st2, { ok: true, status: 'done', message: 'chore: add big staged file' })
  const secondPrompt = createdAgents[1].agent.promptSeen
  assert.ok(secondPrompt.includes('big-staged.txt'))
  assert.equal(secondPrompt.includes('DIFF_BODY_SHOULD_NOT_APPEAR'), false)

  // 4. 取消生成（等假模型进入等待状态后再取消）
  nextReply = { text: 'never', delayMs: 5000, failWith: null }
  const gen3 = await service.generateMessage({ sessionId: 's1', repo: repoId })
  assert.equal(service.generationStatus(gen3.requestId).status, 'running')
  while (createdAgents.length < 3 || !createdAgents[2].agent.idlePromise) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const cancelRes = await service.cancelGenerate({ requestId: gen3.requestId })
  assert.deepEqual(cancelRes, { ok: true })
  assert.equal(service.generationStatus(gen3.requestId).status, 'cancelled')
  assert.equal(createdAgents[2].agent.cancelled, true)

  // 5. 模型失败返回 failed 与 reason
  nextReply = { text: '', delayMs: 0, failWith: 'provider timeout' }
  const gen4 = await service.generateMessage({ sessionId: 's1', repo: repoId })
  await mounted.manager.whenSettled(gen4.requestId)
  const st4 = service.generationStatus(gen4.requestId)
  assert.equal(st4.ok, true)
  assert.equal(st4.status, 'failed')
  assert.match(st4.reason, /provider timeout/)

  await mounted.manager.dispose()
})

async function initializedRepo(options, commitEnv) {
  const env = await setupCommitEnv(options, commitEnv)
  const repo = join(env.root, 'repo')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await setupRepoIdentity(repo)
  env.setFolders('s1', [repo])
  const id = (await env.service.status('s1')).repos[0].id
  return { ...env, repo, request: { sessionId: 's1', repo: id } }
}

async function generatedPrompt(env) {
  let prompt
  env.setCommitManager({ start(input) { prompt = input.prompt; return { requestId: 'test' } } })
  assert.equal((await env.service.generateMessage(env.request)).ok, true)
  return prompt
}

for (const maxCommitDiffBytes of [65536, 10]) {
  test(`提交信息过滤旧文件、新文件、改名和历史标题（差异上限 ${maxCommitDiffBytes}）`, async () => {
    const env = await initializedRepo({ maxCommitDiffBytes })
    const { repo } = env
    // 完整的密钥形状：标头、内容、结尾都有。只有标头的文字不算私钥（fix#175）。
    const marker = [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'Zm9vYmFy'.repeat(8), ['-----END', 'PRIVATE KEY-----'].join(' ')].join('\n')
    const context = 'unchanged\n'.repeat(12)
    await write(join(repo, 'ordinary.txt'), marker + '\n' + context + 'before\n')
    await write(join(repo, '.credentials'), 'credential fixture\n')
    await commitAll(repo, 'chore: fixture token=REDACTION_FIXTURE')
    await mustGit(repo, ['mv', '.credentials', 'renamed.txt'])
    await write(join(repo, '.env'), 'fixture env content\n')
    await write(join(repo, 'ordinary.txt'), marker + '\n' + context + 'staged key body\n')
    await write(join(repo, 'safe.txt'), 'safe sample\n')
    await mustGit(repo, ['add', '-A'])
    // 工作区内容与暂存区不同；模型只看经过筛选的暂存版本。
    await write(join(repo, 'ordinary.txt'), 'clean worktree\n')
    const prompt = await generatedPrompt(env)
    if (maxCommitDiffBytes === 10) {
      assert.match(prompt, /^- safe\.txt \(\+1 -0, content not sent\)$/m)
      assert.doesNotMatch(prompt, /safe sample/)
    } else {
      assert.match(prompt, /\+safe sample/)
    }
    assert.match(prompt, /^- \.env \([^)]*content not sent\)$/m)
    assert.match(prompt, /^- \.credentials -> renamed\.txt \([^)]*content not sent\)$/m)
    assert.match(prompt, /^- ordinary\.txt \([^)]*content not sent\)$/m)
    assert.doesNotMatch(prompt, /fixture env content|credential fixture|PRIVATE KEY|staged key body|REDACTION_FIXTURE/)
  })
}

test('生成提交信息保留令牌标识符、函数调用与箭头函数的差异', async () => {
  const env = await initializedRepo()
  const code = [
    'const token = randomUUID()',
    'const row = { token: last30.map(t => t.value), password: existingPassword }',
    'let refreshToken = credentialProviderForAccount42()',
    'refreshToken = credentialIdentifierForAccount42',
    'items.map(token => token.length)',
    'if (token === existingToken) refresh()',
  ]
  await write(join(env.repo, 'tokens.js'), code.join('\n'))
  await mustGit(env.repo, ['add', 'tokens.js'])
  const prompt = await generatedPrompt(env)
  for (const line of code) assert.ok(prompt.includes('+' + line), line)
})

for (const [name, content] of [
  ['引号内的凭据值', 'const token = "fixture value"'],
  ['长凭据串', 'API_KEY=' + 'aB3dE5'.repeat(6)],
  ['无数字的长凭据串', 'API_KEY=' + 'abcd'.repeat(8)],
]) {
  test(`生成提交信息列出含${name}的文件并省去正文`, async () => {
    const env = await initializedRepo()
    await write(join(env.repo, 'settings.txt'), content)
    await mustGit(env.repo, ['add', 'settings.txt'])
    const prompt = await generatedPrompt(env)
    assert.match(prompt, /^- settings\.txt \([^)]*content not sent\)$/m)
    assert.ok(!prompt.includes(content))
    assert.doesNotMatch(prompt, /exceeded size limit/i)
  })
}

test('生成提交信息省去源码中写死的配置行', async () => {
  const env = await initializedRepo()
  const value = 'aBc123'.repeat(6)
  await write(join(env.repo, 'embedded.js'), "const setting = 'API_KEY=" + value + "'")
  await write(join(env.repo, 'comment.js'), '// fixture token=' + value)
  await mustGit(env.repo, ['add', '-A'])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- embedded\.js .*content not sent/m)
  assert.match(prompt, /^- comment\.js .*content not sent/m)
  assert.ok(!prompt.includes(value))
})

test('生成提交信息允许只列出 .env', async () => {
  const env = await initializedRepo()
  await write(join(env.repo, '.env'), 'ENV_FIXTURE=1\n')
  await mustGit(env.repo, ['add', '.env'])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- \.env \([^)]*content not sent\)$/m)
  assert.doesNotMatch(prompt, /ENV_FIXTURE|Staged diff:|exceeded size limit/i)
})

test('生成提交信息从同一批暂存对象统计超限文件的新增、修改和删除行', async () => {
  const env = await initializedRepo({ maxFileBytes: 20 })
  const { repo } = env
  const prefix = 'LARGE_BODY common\n'.repeat(4)
  await write(join(repo, 'modified'), prefix + 'old line\n')
  await write(join(repo, 'deleted'), 'deleted body only\n'.repeat(4))
  await commitAll(repo, 'base')
  await mustGit(repo, ['rm', '--cached', 'deleted'])
  await write(join(repo, 'modified'), prefix + 'two\nreplacement lines\n')
  await write(join(repo, 'added'), prefix + 'unterminated')
  await write(join(repo, 'small'), 'reviewable\n')
  await mustGit(repo, ['add', 'added', 'modified', 'small'])
  const runDiff = env.git.runDiff
  env.git.runDiff = async (cwd, args, options) => {
    const result = await runDiff(cwd, args, options)
    if (args.includes('--raw')) {
      await write(join(repo, 'added'), 'restaged\n')
      await mustGit(repo, ['add', 'added'])
    }
    return result
  }
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- added \(\+5 -0, content not sent\)$/m)
  assert.match(prompt, /^- modified \(\+2 -1, content not sent\)$/m)
  assert.match(prompt, /^- deleted \(\+0 -4, content not sent\)$/m)
  assert.match(prompt, /\+reviewable/)
  assert.doesNotMatch(prompt, /LARGE_BODY|replacement lines|unterminated|restaged/)
})

test('生成提交信息保留超限 .env 的行数', async () => {
  const env = await initializedRepo({ maxFileBytes: 12 })
  await write(join(env.repo, '.env'), 'ENV_FIXTURE=staged\n'.repeat(3))
  await mustGit(env.repo, ['add', '.env'])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- \.env \(\+3 -0, content not sent\)$/m)
  assert.doesNotMatch(prompt, /ENV_FIXTURE/)
})

test('生成提交信息列出子模块并省去内容', async () => {
  const env = await initializedRepo()
  const { repo } = env
  await write(join(repo, 'tracked'), 'base')
  const commit = await commitAll(repo, 'initial')
  await mustGit(repo, ['update-index', '--add', '--cacheinfo', `160000,${commit},vendor-module`])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- vendor-module \([^)]*content not sent\)$/m)
  assert.ok(!prompt.includes(commit))
})

test('生成提交信息列出链接并省去目标', async () => {
  const env = await initializedRepo()
  await symlink('private-target', join(env.repo, 'shortcut'))
  await mustGit(env.repo, ['add', 'shortcut'])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- shortcut \([^)]*content not sent\)$/m)
  assert.doesNotMatch(prompt, /private-target/)
})

test('生成提交信息按数量报告路径含凭据的文件', async () => {
  const env = await initializedRepo()
  for (const path of ['token=PATH_FIXTURE', 'api_key=OTHER_FIXTURE', 'notes']) {
    await write(join(env.repo, path), path === 'notes' ? 'public note' : 'hidden body')
  }
  await mustGit(env.repo, ['add', '-A'])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /2 additional files.*not sent/i)
  assert.match(prompt, /\+public note/)
  assert.doesNotMatch(prompt, /PATH_FIXTURE|OTHER_FIXTURE|hidden body/)
})

test('改名时仍列出可发送的一端', async () => {
  const env = await initializedRepo()
  await write(join(env.repo, 'token=PATH_FIXTURE'), 'hidden body\n')
  await commitAll(env.repo, 'initial')
  await mustGit(env.repo, ['mv', 'token=PATH_FIXTURE', 'config.txt'])
  const prompt = await generatedPrompt(env)
  assert.match(prompt, /^- .*config\.txt .*content not sent/m)
  assert.doesNotMatch(prompt, /PATH_FIXTURE|hidden body/)
})

test('推送使用已配置的上游，即使本地没有上游跟踪引用', async () => {
  const { repo, root, service, request } = await initializedRepo()
  for (const name of ['origin', 'backup']) {
    const bare = join(root, name + '.git')
    await mustGit(root, ['init', '--bare', bare])
    await mustGit(repo, ['remote', 'add', name, bare])
  }
  await write(join(repo, 'file'), 'one')
  const sha = await commitAll(repo, 'one')
  await mustGit(repo, ['config', 'branch.main.remote', 'backup'])
  await mustGit(repo, ['config', 'branch.main.merge', 'refs/heads/review'])
  const result = await service.push(request)
  assert.deepEqual(result, { ok: true, remote: 'backup', branch: 'main', createdUpstream: false })
  assert.equal((await mustGit(join(root, 'backup.git'), ['rev-parse', 'refs/heads/review'])).stdout.trim(), sha)
})

test('显式分支推送不跟随标签或镜像其他引用', async () => {
  const { repo, root, service, request } = await initializedRepo()
  const bare = join(root, 'origin.git')
  await mustGit(root, ['init', '--bare', bare])
  await mustGit(repo, ['remote', 'add', 'origin', bare])
  await write(join(repo, 'file'), 'one')
  await commitAll(repo, 'one')
  await mustGit(repo, ['tag', '-am', 'release', 'release'])
  await mustGit(repo, ['config', 'push.followTags', 'true'])
  await mustGit(repo, ['config', 'remote.origin.mirror', 'true'])
  assert.equal((await service.push(request)).ok, true)
  assert.equal((await mustGit(bare, ['for-each-ref', '--format=%(refname)'])).stdout.trim(), 'refs/heads/main')
})

test('推送区分远端拒绝与传输失败，回复不回显传输诊断', async () => {
  const { repo, root, service, request } = await initializedRepo()
  const target = join(root, 'target')
  await mkdir(target)
  await mustGit(target, ['init', '-b', 'main'])
  await mustGit(repo, ['remote', 'add', 'origin', target])
  await write(join(repo, 'file'), 'one')
  await commitAll(repo, 'one')
  assert.equal((await service.push(request)).code, 'push-rejected')
  await mustGit(repo, ['remote', 'set-url', 'origin', join(root, 'transport-private-fixture')])
  const failed = await service.push(request)
  assert.equal(failed.code, 'push-failed')
  assert.doesNotMatch(JSON.stringify(failed), /transport-private-fixture/)
})

test('提交成功后推送超时仍报告已创建的提交', async () => {
  const { repo, git, root, service, request } = await initializedRepo()
  await mustGit(repo, ['remote', 'add', 'origin', join(root, 'unused.git')])
  await write(join(repo, 'file'), 'one')
  await mustGit(repo, ['add', 'file'])
  const run = git.run
  git.run = async (cwd, args, opts) => {
    if (args.includes('push')) throw new Error('git push timed out')
    return run(cwd, args, opts)
  }
  const result = await service.commit({ ...request, message: 'one', push: true })
  assert.equal(result.ok, true)
  assert.equal(result.pushError, 'push-failed')
  assert.equal(result.sha, (await mustGit(repo, ['rev-parse', 'HEAD'])).stdout.trim())
})

test('结构化 Git 输出不完整时拒绝使用过滤器清单', async () => {
  let reads = 0
  const root = await tempDir('dwb-gr-config-')
  const subprocess = {
    resolveExecutable: async () => 'git',
    spawn({ argv }) {
      if (argv.includes('status')) reads++
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: '', lossy: argv.includes('config') }) } },
      }
    },
  }
  const git = createGitReviewGit({ subprocess, dataDir: root, timeoutMs: 1000, maxDiffBytes: 1024 })
  await assert.rejects(git.runRead(root, ['status']), { code: 'too-large' })
  assert.equal(reads, 0)
})

test('全部暂存路径都含凭据时不发起模型请求', async () => {
  const { repo, service, request, setCommitManager } = await initializedRepo()
  await write(join(repo, 'ghp_' + 'aB3dE5'.repeat(6)), 'fixture')
  await mustGit(repo, ['add', '-A'])
  let starts = 0
  setCommitManager({ start() { starts++; return { requestId: 'unused' } } })
  const result = await service.generateMessage(request)
  assert.equal(result.code, 'no-reviewable-files')
  assert.equal(starts, 0)
})

test('内部预设注册失败时挂载报告失败', async () => {
  const scope = { agentPresets: { register: async () => { throw new Error('preset unavailable') } } }
  await assert.rejects(async () => mountCommitMessagePreset(scope, {}), /preset unavailable/)
})

test('暂存区已被其他操作锁定时拒绝推送', async () => {
  const { root, repo, request, service } = await initializedRepo()
  const bare = join(root, 'origin.git')
  await mustGit(root, ['init', '--bare', bare])
  await mustGit(repo, ['remote', 'add', 'origin', bare])
  await write(join(repo, 'hello'), 'hello')
  await commitAll(repo, 'one')
  await write(join(repo, '.git', 'index.lock'), 'lock')
  assert.equal((await service.push(request)).code, 'locked')
  assert.equal((await mustGit(bare, ['for-each-ref'])).stdout, '')
})

test('提交钩子的执行环境隔离仓库且保留显式 hooksPath', async () => {
  const { root, repo, request, service } = await initializedRepo({}, { GIT_DIR: './ambient-dir', GIT_WORK_TREE: './ambient-tree', GIT_INDEX_FILE: './ambient-index' })
  await write(join(repo, 'file'), 'content')
  await mustGit(repo, ['add', 'file'])
  const hooks = join(root, 'hooks')
  await mkdir(hooks)
  await mustGit(repo, ['config', 'core.hooksPath', hooks])
  await write(join(hooks, 'pre-commit'), '#!/bin/sh\ngit rev-parse --show-toplevel > hook-toplevel\n')
  await chmod(join(hooks, 'pre-commit'), 0o755)
  assert.equal((await service.commit({ ...request, message: 'created' })).ok, true)
  assert.equal((await readFile(join(repo, 'hook-toplevel'), 'utf8')).trim(), (await mustGit(repo, ['rev-parse', '--show-toplevel'])).stdout.trim())
})

for (const [name, remotes, branchRemote, defaultRemote, expected] of [
  ['分支设置优先于 pushDefault', ['origin', 'second'], 'origin', 'second', 'origin'],
  ['pushDefault 优先于 origin', ['origin', 'second'], null, 'second', 'second'],
  ['唯一远程可以不叫 origin', ['backup'], null, null, 'backup'],
  ['多个远程回落到 origin', ['backup', 'origin'], null, null, 'origin'],
]) {
  test(`没有上游时${name}`, async () => {
    const { repo, root, service, request } = await initializedRepo()
    await write(join(repo, 'file'), 'one')
    const sha = await commitAll(repo, 'one')
    for (const remote of remotes) {
      const bare = join(root, remote + '.git')
      await mustGit(root, ['init', '--bare', bare])
      await mustGit(repo, ['remote', 'add', remote, bare])
    }
    if (branchRemote) await mustGit(repo, ['config', 'branch.main.pushRemote', branchRemote])
    if (defaultRemote) await mustGit(repo, ['config', 'remote.pushDefault', defaultRemote])
    assert.deepEqual(await service.push(request), { ok: true, remote: expected, branch: 'main', createdUpstream: true })
    assert.equal((await mustGit(join(root, expected + '.git'), ['rev-parse', 'refs/heads/main'])).stdout.trim(), sha)
  })
}

test('Git 差异执行器统一禁用外部 diff 与 textconv', async () => {
  const { repo, git, spawnLog } = await initializedRepo()
  const diff = await git.runDiff(repo, ['diff-files', '--raw', '--'])
  assert.equal(diff.exitCode, 0)
  const argv = spawnLog.at(-1)
  assert.ok(argv.includes('--no-ext-diff'))
  assert.ok(argv.includes('--no-textconv'))
})

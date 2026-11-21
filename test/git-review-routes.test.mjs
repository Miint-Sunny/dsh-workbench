/**
 * 审阅面板 HTTP 路由与行挂载测试：
 * - 路由 `/api/dsh-workbench.git-review`（GET 与 POST，buffered）
 * - GET 令牌发放与 `cache-control: no-store`、五种 GET 查询形状、重复/未知查询键拒绝
 * - POST `application/json` + 令牌头校验（缺失/错误/非 JSON 头均 403 forbidden）、非法参数/多余字段拒绝（如 force）
 * - Request -> 真 Git 仓库 & 裸仓库 -> Response 端到端链路（stage / unstage / revert / undo / commit / push / create-branch / generate-message / cancel-generate）
 * - 通过 `lib/review/index.js` 的 `apply(ctx, config)` 挂载与卸载：并存 `review.*` 与 `git-review`，非法配置报错，卸载干净可重挂。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { COMMIT_IDENTITY, createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'
import { tempDir } from './helpers/temp-dir.mjs'
import { apply } from '../lib/review/index.js'
import { applyGitReview } from '../lib/git-review/index.js'
import { createFoldersStore } from '../lib/workspace-folders-store.js'
import { enabledFeatures } from '../lib/features.js'
import {
  GIT_REVIEW_ROUTE,
  GIT_REVIEW_TOKEN_HEADER,
  registerGitReviewRoute,
} from '../lib/git-review/routes.js'
import { parseGitReviewConfig } from '../lib/git-review/config.js'
import { createGitReviewGit } from '../lib/git-review/git.js'
import { createGitReviewStore } from '../lib/git-review/store.js'
import { createCommitMessageManager, mountCommitMessagePreset } from '../lib/git-review/commit-message.js'
import { createGitReviewService } from '../lib/git-review/service.js'

const write = (path, content) => writeFile(path, content, typeof content === 'string' ? 'utf8' : undefined)

async function mustGit(cwd, args) {
  const result = await runGit(cwd, args)
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

function fakePluginCtx(extraServices = {}) {
  const routes = new Map()
  const children = []
  const listeners = new Map()
  function makeScope(extra = {}) {
    const effects = []
    const scopeChildren = []
    return {
      ...extraServices,
      ...extra,
      connection: {
        fetch: {
          register(route) {
            assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
            routes.set(route.path, route)
            return async () => { routes.delete(route.path) }
          },
        },
      },
      get(name) { return this[name] },
      inject(deps, mount) {
        if (deps.some(name => !this[name])) return
        const child = makeScope()
        scopeChildren.push(child)
        children.push(child)
        child.ready = Promise.resolve(mount(child))
        return child
      },
      effect(fn) {
        const dispose = fn()
        if (dispose !== undefined) effects.push(dispose)
        return dispose
      },
      on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, [])
        listeners.get(ev).push(fn)
        return () => {}
      },
      async dispose() {
        await this.ready
        for (const c of scopeChildren.splice(0)) await c.dispose()
        for (const d of effects.splice(0).reverse()) {
          if (typeof d === 'function') await d()
          else await d
        }
      },
    }
  }
  const root = makeScope()
  return { ctx: root, routes, children }
}

const getReq = (query) =>
  new Request(`http://127.0.0.1:1${GIT_REVIEW_ROUTE}${query}`, { method: 'GET' })

const postReq = (body, opts = {}) => {
  const contentType = Object.hasOwn(opts, 'contentType') ? opts.contentType : 'application/json'
  return new Request(`http://127.0.0.1:1${GIT_REVIEW_ROUTE}`, {
    method: 'POST',
    headers: {
      ...(contentType !== undefined ? { 'content-type': contentType } : {}),
      ...(opts.token !== undefined ? { [GIT_REVIEW_TOKEN_HEADER]: opts.token } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('路由安全与参数校验：令牌头、application/json、查询参数与未知字段拦截', async () => {
  const root = await tempDir('dwb-gr-route-sec-')
  const dataDir = join(root, 'git-review')
  const trashDir = join(root, 'trash')
  const home = join(root, 'git-home')
  const repo = join(root, 'repo')
  await mkdir(home, { recursive: true })
  await mkdir(repo, { recursive: true })
  await mustGit(repo, ['init', '-b', 'main'])
  await write(join(repo, 'a.txt'), 'hello\n')
  await commitAll(repo, 'init')

  const subprocess = createLocalSubprocess({ home })
  const config = parseGitReviewConfig({ gitReviewDataDir: dataDir, trashDir })
  const git = createGitReviewGit({ subprocess, dataDir, timeoutMs: config.gitTimeoutMs, maxDiffBytes: config.maxDiffBytes })
  const service = createGitReviewService({
    config,
    git,
    store: createGitReviewStore(dataDir),
    isRunning: () => false,
    foldersOf: async (id) => (id === 's1' ? [repo] : undefined),
  })

  const { ctx, routes } = fakePluginCtx()
  const unregister = registerGitReviewRoute(ctx, service)
  try {
    const route = routes.get(GIT_REVIEW_ROUTE)
    assert.ok(route)
    assert.deepEqual(route.methods, ['GET', 'POST'])
    assert.equal(route.requestBody, 'buffered')

    const statusRes = await route.fetch(getReq('?sessionId=s1'))
    assert.equal(statusRes.status, 200)
    assert.equal(statusRes.headers.get('cache-control'), 'no-store')
    const statusBody = await statusRes.json()
    assert.equal(statusBody.ok, true)
    assert.equal(typeof statusBody.token, 'string')
    assert.ok(statusBody.token.length >= 20)
    const repoId = statusBody.repos[0].id

    // 缺少令牌、错误令牌、非 JSON Content-Type 一律 403 forbidden
    for (const opts of [
      {},
      { token: 'wrong-token' },
      { token: statusBody.token, contentType: 'text/plain' },
      { token: statusBody.token, contentType: undefined },
    ]) {
      const r = await route.fetch(postReq({ action: 'push', sessionId: 's1', repo: repoId }, opts))
      assert.equal(r.status, 403)
      assert.deepEqual(await r.json(), { ok: false, code: 'forbidden' })
    }

    // 坏 JSON、未知 action、多余字段（如 force）、坏 query
    const badJson = await route.fetch(postReq('{not-json', { token: statusBody.token }))
    assert.equal(badJson.status, 400)
    assert.equal((await badJson.json()).code, 'bad-request')

    for (const payload of [
      { action: 'unknown', sessionId: 's1', repo: repoId },
      { action: 'push', sessionId: 's1', repo: repoId, force: true },
      { action: 'stage', sessionId: 's1', repo: repoId, scope: 'unstaged', version: 'v', patch: 'evil' },
      { action: 'commit', sessionId: 's1', repo: repoId, message: 'x', extra: 1 },
      { action: 'undo', sessionId: 's1', repo: repoId, undoId: '../escape' },
    ]) {
      const r = await route.fetch(postReq(payload, { token: statusBody.token }))
      assert.equal(r.status, 400, JSON.stringify(payload))
      assert.deepEqual(await r.json(), { ok: false, code: 'bad-request' })
    }

    for (const badQuery of [
      '',
      '?sessionId=../escape',
      '?sessionId=s1&extra=1',
      '?sessionId=s1&sessionId=s2',
      '?sessionId=s1&repo=0123456789abcdef&branches=1&commits=1',
      '?sessionId=s1&repo=bad-repo-id&branches=1',
      '?requestId=../bad',
    ]) {
      const r = await route.fetch(getReq(badQuery))
      assert.equal(r.status, 400, badQuery)
      assert.deepEqual(await r.json(), { ok: false, code: 'bad-request' })
    }
  } finally {
    await unregister()
  }
  assert.equal(routes.size, 0)
})

test('路由端到端：GET/POST 全套动作通过 Request/Response 驱动真仓库、裸仓库与假模型', async () => {
  const root = await tempDir('dwb-gr-route-e2e-')
  const dataDir = join(root, 'git-review')
  const trashDir = join(root, 'trash')
  const home = join(root, 'git-home')
  const repo = join(root, 'repo')
  const bare = join(root, 'origin.git')
  await mkdir(home, { recursive: true })
  await mkdir(repo, { recursive: true })
  await mustGit(root, ['init', '--bare', bare])
  await mustGit(repo, ['init', '-b', 'main'])
  await setupRepoIdentity(repo)
  await write(join(repo, 'app.js'), 'const a = 1\nconst b = 2\n')
  await commitAll(repo, 'init')
  await mustGit(repo, ['remote', 'add', 'origin', bare])
  await mustGit(repo, ['push', '-u', 'origin', 'main'])

  await mustGit(repo, ['checkout', '-b', 'feat'])
  await write(join(repo, 'app.js'), 'const a = 10\nconst b = 2\n')
  const c1 = await commitAll(repo, 'feat one')
  await write(join(repo, 'app.js'), 'const a = 10\nconst b = 20\n')

  const subprocess = createLocalSubprocess({ home })
  const config = parseGitReviewConfig({ gitReviewDataDir: dataDir, trashDir })
  const git = createGitReviewGit({ subprocess, dataDir, timeoutMs: config.gitTimeoutMs, maxDiffBytes: config.maxDiffBytes })

  // 假 agentPresets + agents，验证生成提交信息路由端到端
  const fakePresetScope = {
    agentPresets: {
      async register() { return () => {} },
      presetForSession: (s) => s.preset,
      async mount() {},
    },
    agents: {
      async create({ sessionId, meta, setup }) {
        const listeners = []
        const agentCtx = {
          tools: { restrict() {} },
          effect: () => () => {},
          on: (ev, fn) => { if (ev === 'session/event') listeners.push(fn) },
          systemPrompt: { section() {}, suppressRuntimeContext() {} },
        }
        const session = { id: sessionId, preset: meta.agentPreset, append() {}, snapshotEvents: () => [] }
        let idle = Promise.resolve()
        const agent = {
          id: sessionId,
          session,
          ctx: agentCtx,
          followup() {
            idle = Promise.resolve().then(() => {
              for (const fn of listeners) {
                fn(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'feat: update b to 20' }] } } })
              }
            })
          },
          whenIdle: () => idle,
          cancel() {},
        }
        await setup(agentCtx, agent)
        return { agent, dispose: async () => {} }
      },
    },
  }
  const mountedPreset = await mountCommitMessagePreset(fakePresetScope, config)

  const service = createGitReviewService({
    config,
    git,
    store: createGitReviewStore(dataDir),
    isRunning: () => false,
    foldersOf: async (id) => (id === 's1' ? [repo] : undefined),
    resolveModel: () => ({ provider: 'fake', model: 'fake' }),
    commitMessageManager: mountedPreset.manager,
  })

  const { ctx, routes } = fakePluginCtx()
  const unregister = registerGitReviewRoute(ctx, service)
  try {
    const route = routes.get(GIT_REVIEW_ROUTE)
    const callGet = async (q) => {
      const r = await route.fetch(getReq(q))
      return { status: r.status, body: await r.json() }
    }
    const callPost = async (token, payload) => {
      const r = await route.fetch(postReq(payload, { token }))
      return { status: r.status, body: await r.json() }
    }

    const st = await callGet('?sessionId=s1')
    assert.equal(st.status, 200)
    const token = st.body.token
    const repoId = st.body.repos[0].id

    // branches & commits
    const br = await callGet(`?sessionId=s1&repo=${repoId}&branches=1`)
    assert.equal(br.status, 200)
    assert.equal(br.body.defaultBase, 'main')
    const cm = await callGet(`?sessionId=s1&repo=${repoId}&commits=1&base=main`)
    assert.equal(cm.status, 200)
    assert.equal(cm.body.commits[0].sha, c1)

    // diff unstaged -> stage hunk -> revert/undo -> unstage -> stage -> generate -> commit+push
    let diff = await callGet(`?sessionId=s1&repo=${repoId}&scope=unstaged`)
    assert.equal(diff.status, 200)
    assert.equal(diff.body.files[0].path, 'app.js')

    const revRes = await callPost(token, {
      action: 'revert',
      sessionId: 's1',
      repo: repoId,
      scope: 'unstaged',
      version: diff.body.version,
      path: 'app.js',
      hunk: 'h0',
    })
    assert.equal(revRes.status, 200)
    assert.ok(revRes.body.undoId)
    assert.equal(await readFile(join(repo, 'app.js'), 'utf8'), 'const a = 10\nconst b = 2\n')

    const undoRes = await callPost(token, {
      action: 'undo',
      sessionId: 's1',
      repo: repoId,
      undoId: revRes.body.undoId,
    })
    assert.deepEqual(undoRes, { status: 200, body: { ok: true } })
    assert.equal(await readFile(join(repo, 'app.js'), 'utf8'), 'const a = 10\nconst b = 20\n')

    diff = await callGet(`?sessionId=s1&repo=${repoId}&scope=unstaged`)
    assert.deepEqual(
      await callPost(token, { action: 'stage', sessionId: 's1', repo: repoId, scope: 'unstaged', version: diff.body.version, path: 'app.js', hunk: 'h0' }),
      { status: 200, body: { ok: true } },
    )

    const genRes = await callPost(token, { action: 'generate-message', sessionId: 's1', repo: repoId })
    assert.equal(genRes.status, 200)
    const requestId = genRes.body.requestId
    await mountedPreset.manager.whenSettled(requestId)
    const genStatus = await callGet(`?requestId=${requestId}`)
    assert.deepEqual(genStatus, { status: 200, body: { ok: true, status: 'done', message: 'feat: update b to 20' } })

    const commitRes = await callPost(token, {
      action: 'commit',
      sessionId: 's1',
      repo: repoId,
      message: genStatus.body.message,
      push: true,
    })
    assert.equal(commitRes.status, 200)
    assert.equal(commitRes.body.ok, true)
    assert.equal(commitRes.body.pushed, true)
    assert.match(commitRes.body.sha, /^[0-9a-f]{40}$/)

    // 游离 HEAD 建分支
    await mustGit(repo, ['checkout', '--detach', 'HEAD'])
    const cbRes = await callPost(token, { action: 'create-branch', sessionId: 's1', repo: repoId, name: 'from-detached' })
    assert.deepEqual(cbRes, { status: 200, body: { ok: true, branch: 'from-detached' } })
  } finally {
    await unregister()
    await mountedPreset.dispose()
  }
})

test('lib/review/index.js apply：同时挂载改动审阅和 Git 审阅路由，非法配置抛错，卸载干净可重挂', async () => {
  const dir = await tempDir('dwb-gr-wiring-')
  const subprocess = createLocalSubprocess({ home: join(dir, 'git-home') })
  const { ctx, routes, children } = fakePluginCtx({
    workspaceChanges: { summary: () => undefined, diff: async () => undefined },
    agents: { get: () => undefined },
    subprocess,
    workingDirectory: { get: () => undefined },
    agentPresets: { async register() { return () => {} }, presetForSession: () => null, async mount() {} },
  })

  try {
    assert.throws(
      () => apply(ctx, { dataDir: join(dir, 'review'), gitReviewDataDir: join(dir, 'git-review'), maxFileBytes: 0 }),
      /maxFileBytes 要是正整数/,
    )
    // 错误发生前登记过的功能行在清理后不再残留
    for (const c of children) await c.dispose()
    await ctx.dispose()
    assert.equal(enabledFeatures().some(f => f.id === 'review'), false)

    apply(ctx, {
      dataDir: join(dir, 'review'),
      gitReviewDataDir: join(dir, 'git-review'),
      trashDir: join(dir, 'trash'),
    })
    assert.deepEqual([...routes.keys()].sort(), [
      '/api/dsh-workbench.git-review',
      '/api/dsh-workbench.review.revert',
      '/api/dsh-workbench.review.state',
      '/api/dsh-workbench.review.undo',
    ])

    // 全部销毁后再次挂载不重路由冲突
    await ctx.dispose()
    assert.equal(routes.size, 0)
    assert.equal(enabledFeatures().some(f => f.id === 'review'), false)

    apply(ctx, {
      dataDir: join(dir, 'review'),
      gitReviewDataDir: join(dir, 'git-review'),
      trashDir: join(dir, 'trash'),
    })
    assert.equal(routes.size, 4)
  } finally {
    await ctx.dispose()
  }
  assert.equal(routes.size, 0)
})

function routeFixture(t, service) {
  const { ctx, routes } = fakePluginCtx()
  const close = registerGitReviewRoute(ctx, service)
  t.after(close)
  return { route: routes.get(GIT_REVIEW_ROUTE), close }
}

test('POST rejects JSON identifiers of the wrong type before dispatch', async t => {
  const { route } = routeFixture(t, {
    status: () => ({ ok: true }),
    push: () => ({ ok: true }),
    undo: () => ({ ok: true }),
    cancelGenerate: () => ({ ok: true }),
  })
  const { token } = await (await route.fetch(getReq('?sessionId=s1'))).json()
  const ids = { sessionId: 's1', repo: '0123456789abcdef' }
  for (const body of [
    { action: 'push', ...ids, sessionId: ['s1'] },
    { action: 'push', ...ids, repo: [ids.repo] },
    { action: 'undo', ...ids, undoId: ['12345678'] },
    { action: 'cancel-generate', requestId: ['job1'] },
    { action: 'cancel-generate', requestId: 'job1', sessionId: true },
  ]) {
    const response = await route.fetch(postReq(body, { token }))
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await response.json()).code, 'bad-request')
  }
})

test('GET rejects invalid branch selection and selectors on local changes', async t => {
  const { route } = routeFixture(t, {
    diff: () => ({ ok: true }), commits: () => ({ ok: true }),
  })
  const query = '?sessionId=s1&repo=0123456789abcdef&'
  for (const options of [
    'scope=staged&base=main', 'scope=unstaged&from=1234567', 'scope=uncommitted&includeUncommitted=1',
    'scope=branch&base=', 'scope=branch&from=main&to=main', 'commits=1&base=%20',
  ]) {
    const response = await route.fetch(getReq(query + options))
    assert.equal(response.status, 400, options)
    assert.equal((await response.json()).code, 'bad-request')
  }
})

test('a missing subprocess provider leaves an actionable status on the Git review route', async t => {
  const dir = await tempDir('dwb-gr-missing-provider-')
  for (const subprocess of [undefined, {}]) {
    const { ctx, routes } = fakePluginCtx({ agents: {}, subprocess })
    t.after(() => ctx.dispose())
    applyGitReview(ctx, { gitReviewDataDir: dir })
    const route = routes.get(GIT_REVIEW_ROUTE)
    assert.ok(route, 'the route can report the unavailable provider')
    const response = await route.fetch(getReq('?sessionId=s1'))
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.code, 'git-unavailable')
    assert.match(body.detail, /subprocess/)
    assert.equal((await route.fetch(postReq({ action: 'push' }))).status, 403)
  }
})

test('unmount waits for an accepted write and rejects late requests', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { route, close } = routeFixture(t, {
    status: () => ({ ok: true }),
    commit: async () => { entered.resolve(); await release.promise; return { ok: true, sha: '01234567' } },
  })
  const { token } = await (await route.fetch(getReq('?sessionId=s1'))).json()
  const body = { action: 'commit', sessionId: 's1', repo: '0123456789abcdef', message: 'save' }
  const writing = route.fetch(postReq(body, { token }))
  await entered.promise
  let drained = false
  const retiring = close().then(() => { drained = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(drained, false, 'unmount returned during a write')
    assert.equal((await route.fetch(getReq('?sessionId=s1'))).status, 503)
  } finally {
    release.resolve()
    await retiring
  }
  assert.equal((await writing).status, 200)
})

test('a live parent permits generation and unmount cancels and joins its child session', async t => {
  const dir = await tempDir('dwb-gr-parent-')
  const repo = join(dir, 'repo')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await write(join(repo, 'draft.txt'), 'staged text\n')
  await mustGit(repo, ['add', 'draft.txt'])
  const idle = Promise.withResolvers()
  let disposed = false
  const parent = {
    session: { id: 's1', header: { cwd: repo } },
    ctx: { effect: body => body() },
    model: { current: () => ({ provider: 'fake', model: 'fake' }) },
  }
  const { ctx, routes } = fakePluginCtx({
    subprocess: createLocalSubprocess(),
    agentPresets: { register: async () => () => {}, mount: async () => {}, presetForSession: s => s.preset },
    agents: {
      get: id => id === 's1' ? parent : undefined,
      async create({ sessionId, meta, setup }) {
        const agent = {
          id: sessionId, session: { preset: meta.agentPreset, append() {} },
          ctx: { tools: { restrict() {} }, effect: body => body(), on() {}, systemPrompt: { section() {}, suppressRuntimeContext() {} } },
          followup() {}, whenIdle: () => idle.promise, cancel: () => idle.resolve(),
        }
        await setup(agent.ctx, agent)
        return { agent, dispose: async () => { disposed = true } }
      },
    },
  })
  t.after(() => ctx.dispose())
  applyGitReview(ctx, { gitReviewDataDir: join(dir, 'data') })
  const route = routes.get(GIT_REVIEW_ROUTE)
  const { token, repos } = await (await route.fetch(getReq('?sessionId=s1'))).json()
  const started = await route.fetch(postReq({ action: 'generate-message', sessionId: 's1', repo: repos[0].id }, { token }))
  assert.equal(started.status, 200)
  const { requestId } = await started.json()
  const status = await (await route.fetch(getReq('?requestId=' + requestId))).json()
  assert.equal(status.status, 'running')
  await ctx.dispose()
  assert.equal(disposed, true)
})

for (const customBackups of [false, true]) test(`review discovers only usable workspace folders with custom backups=${customBackups}`, async t => {
  const dir = await realpath(await tempDir('dwb-gr-externals-'))
  const dshHome = join(dir, 'dsh-data')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const repo = join(dir, 'repo')
  const external = join(dir, 'external')
  const alias = join(dir, 'old-external')
  const moved = join(dir, 'moved')
  for (const path of [repo, external]) { await mkdir(path); await mustGit(path, ['init', '-b', 'main']) }
  await mkdir(moved)
  await symlink(moved, alias)
  const store = createFoldersStore(join(dshHome, 'dsh-workbench'))
  for (const path of [external, alias, dshHome]) store.addExternal('ws', path)
  const { ctx, routes } = fakePluginCtx({
    subprocess: createLocalSubprocess(),
    workspaceRegistry: { list: () => [{ id: 'ws', path: repo }] },
    agents: { get: () => ({ session: { header: { cwd: repo } } }) },
  })
  t.after(() => ctx.dispose())
  applyGitReview(ctx, customBackups ? { gitReviewDataDir: join(dir, 'separate-backups', 'git-review') } : {})
  const status = await (await routes.get(GIT_REVIEW_ROUTE).fetch(getReq('?sessionId=s1'))).json()
  assert.deepEqual(status.repos.map(r => r.name).sort(), ['external', 'repo'])
})

test('generation refuses to start after its parent lifetime has ended', async () => {
  let runs = 0
  const manager = createCommitMessageManager({ config: {}, runSession: () => { runs++; return 'description' } })
  try {
    assert.throws(() => manager.start({
      sessionId: 's1', repoId: 'repo',
      bindParent() { throw new Error('parent closed') },
    }), /parent closed/)
    assert.equal(runs, 0)
    assert.equal(manager.active.size, 0)
  } finally {
    await manager.dispose()
  }
})

test('losing the preset while preparing a message returns an unavailable result', async () => {
  const dir = await tempDir('dwb-gr-preset-replaced-')
  const repo = join(dir, 'repo')
  await mkdir(repo)
  await mustGit(repo, ['init', '-b', 'main'])
  await write(join(repo, 'a.txt'), 'data\n')
  await mustGit(repo, ['add', 'a.txt'])
  const config = parseGitReviewConfig({ gitReviewDataDir: join(dir, 'data') })
  const git = createGitReviewGit({ subprocess: createLocalSubprocess(), dataDir: config.gitReviewDataDir,
    timeoutMs: config.gitTimeoutMs, maxDiffBytes: config.maxDiffBytes })
  const manager = createCommitMessageManager({ config, runSession: () => 'unused' })
  const service = createGitReviewService({ config, git, foldersOf: async () => [repo], isRunning: () => false,
    resolveModel: () => { void manager.dispose(); return { provider: 'fake', model: 'fake' } },
    commitMessageManager: manager,
  })
  const { repos } = await service.status('s1')
  const result = await service.generateMessage({ sessionId: 's1', repo: repos[0].id })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-found')
})

for (const [code, expectedStatus] of [
  ['bad-path', 400], ['stale', 409], ['too-large', 413], ['git-unavailable', 503],
]) test(`Git review reports ${code} to the caller`, async t => {
  const { route } = routeFixture(t, {
    diff: async () => { throw Object.assign(new Error('read failed'), { code }) },
  })
  const response = await route.fetch(getReq('?sessionId=s1&repo=0123456789abcdef&scope=staged'))
  assert.equal(response.status, expectedStatus)
  assert.deepEqual(await response.json(), { ok: false, code })
})

test('unmount waits for backup pruning to finish', async t => {
  const dataDir = await tempDir('dwb-gr-prune-stop-')
  const { ctx } = fakePluginCtx({ agents: {}, subprocess: createLocalSubprocess() })
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const original = fs.readdir
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (dir === dataDir) { entered.resolve(); await release.promise }
    return original(dir, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  applyGitReview(ctx, { gitReviewDataDir: dataDir })
  await entered.promise
  let disposed = false
  const retiring = ctx.dispose().then(() => { disposed = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
  } finally {
    release.resolve()
    await retiring
  }
})

test('backup directory overlap fails before any review routes are mounted', async t => {
  const root = await tempDir('dwb-gr-config-')
  const { ctx, routes } = fakePluginCtx()
  t.after(() => ctx.dispose())
  assert.throws(() => apply(ctx, { dataDir: root, gitReviewDataDir: join(root, 'records') }), /gitReviewDataDir/)
  assert.equal(routes.size, 0)
})

/**
 * 审阅面板宿主总入口：
 * - 校验行配置（失败时阻止加载）；
 * - 注入 connection / agents / subprocess，挂上 `/api/dsh-workbench.git-review`；
 * - 可选注入 agentPresets 挂载内部只读「工作台提交信息（内部）」预设；
 * - 启动时和每天修剪独立目录 `$DSH_HOME/dsh-workbench/git-review/` 下超期备份。
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { workbenchDataDir } from '../data-dir.js'
import { externalRefusal, folderList, usableFolder } from '../workspace-folders-model.js'
import { createFoldersStore } from '../workspace-folders-store.js'
import { gitReviewDataDir, parseGitReviewConfig } from './config.js'
import { createGitReviewGit } from './git.js'
import { createGitReviewStore } from './store.js'
import { createGitReviewService } from './service.js'
import { mountCommitMessagePreset } from './commit-message.js'
import { createGitReviewEndpoint } from './routes.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 解析会话关联的工作区目录列表（主目录、注册子文件夹与外部文件夹）。 */
async function resolveSessionFolders(ctx, scope, foldersStore, refuseExternal, sessionId) {
  const liveAgent = scope.agents.get(sessionId)
  const liveSession = liveAgent?.session ?? ctx.get?.('sessions')?.get(sessionId)
  let cwd = liveSession
    ? (ctx.get?.('workingDirectory')?.get(liveSession) ?? liveSession.header?.cwd)
    : undefined
  if (typeof cwd !== 'string' || cwd === '') {
    try {
      cwd = (await ctx.get?.('sessionPersistence')?.stat(sessionId))?.header?.cwd
    } catch {
      cwd = undefined
    }
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined

  const folders = [cwd]
  const workspaces = ctx.get?.('workspaceRegistry')?.list?.()
  if (Array.isArray(workspaces) && workspaces.length > 0) {
    let canonical
    try {
      canonical = realpathSync.native(cwd)
    } catch {
      return []
    }
    const own = workspaces.find(ws => ws.path === canonical)
    if (own) {
      const list = folderList({
        workspace: own, workspaces, settings: foldersStore.read(), exists: usableFolder, refuse: refuseExternal,
      })
      for (const row of [...list.subfolders, ...list.externals]) {
        if (!row.missing && !row.refused) folders.push(row.path)
      }
    }
  }
  return folders
}

/**
 * 在 review 行上挂载 Git 审阅面板宿主端。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} [rawConfig] 行配置。
 */
export function applyGitReview(ctx, rawConfig = {}) {
  const config = parseGitReviewConfig(rawConfig)

  ctx.inject(['connection', 'agents'], (web) => {
    const endpoint = createGitReviewEndpoint(web)
    web.effect(() => web.connection.fetch.register(endpoint.route), 'dsh-workbench: git-review route')
    web.inject(['subprocess'], scope => mountGitReview(scope, ctx, config, endpoint))
  })
}

function mountGitReview(scope, ctx, config, endpoint) {
  if (typeof scope.subprocess?.spawn !== 'function' || typeof scope.subprocess?.resolveExecutable !== 'function') return

  const dataDir = gitReviewDataDir(config)
  const workspaceData = workbenchDataDir()
  const foldersStore = createFoldersStore(workspaceData)
  const protectedDirs = { homes: [homedir()], dshHomes: [dirname(workspaceData)] }
  const refuseExternal = path => externalRefusal(path, protectedDirs)
  const git = createGitReviewGit({
    subprocess: scope.subprocess,
    dataDir,
    timeoutMs: config.gitTimeoutMs,
    maxDiffBytes: config.maxDiffBytes,
  })
  const store = createGitReviewStore(dataDir)
  let commitManager = null

  if (typeof scope.inject === 'function') {
    scope.inject(['agentPresets', 'agents'], async (presetScope) => {
      if (!presetScope.agentPresets || !presetScope.agents) return
      const mounted = await mountCommitMessagePreset(presetScope, config)
      commitManager = mounted.manager
      presetScope.effect(() => async () => {
        if (commitManager === mounted.manager) commitManager = null
        await mounted.dispose()
      }, 'dsh-workbench: git-review commit-message preset')
    })
  }

  const service = createGitReviewService({
    config,
    git,
    store,
    isRunning: (sessionId) => scope.agents.get(sessionId)?.status === 'running',
    foldersOf: (sessionId) => resolveSessionFolders(ctx, scope, foldersStore, refuseExternal, sessionId),
    resolveModel: (sessionId) => scope.agents.get(sessionId)?.model?.current?.(),
    bindParentLifetime: (sessionId, onDispose) => {
      const agent = scope.agents.get(sessionId)
      if (!agent) throw Object.assign(new Error('parent session closed'), { code: 'parent-unavailable' })
      return agent.ctx.effect(() => onDispose, 'dsh-workbench: git-review commit-message parent lifetime')
    },
    get commitMessageManager() {
      return commitManager
    },
  })

  scope.effect(() => endpoint.mount(service), 'dsh-workbench: git-review operations')

  scope.effect(() => {
    let pruning
    const prune = () => {
      pruning ??= store.prune(Date.now() - config.keepDays * DAY_MS)
        .catch(error => scope.logger?.warn?.(`Git 审阅备份修剪失败：${error.message}`))
        .finally(() => { pruning = undefined })
    }
    prune()
    const timer = setInterval(prune, DAY_MS)
    timer.unref?.()
    return async () => {
      clearInterval(timer)
      await pruning
    }
  }, 'dsh-workbench: git-review prune timer')
}

export { DEFAULT_GIT_REVIEW_CONFIG, gitReviewDataDir, gitReviewTrashDir, parseGitReviewConfig } from './config.js'
export { GIT_REVIEW_ROUTE, GIT_REVIEW_TOKEN_HEADER, registerGitReviewRoute } from './routes.js'
export { createGitReviewService } from './service.js'

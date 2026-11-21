/**
 * dsh-workbench/review 行的宿主端：改动审阅（计划第 1 项）。向根行的功能登记处报到，
 * 组装服务（DSH 的改动记录 + 会话运行态 + 回退记录存储），注册回退/撤销/已回退状态路由，
 * 按天数清理回退记录。回退记录跟着 DSH 的数据目录走（lib/data-dir.js），DSH 重启不影响
 * 撤销回退；网页部分接管「第 N 轮改动」页（src/client/review.js）。
 */
import { join } from 'node:path'
import { workbenchDataDir } from '../data-dir.js'
import { registerFeature } from '../features.js'
import { createRevertStore } from './store.js'
import { createReviewService } from './service.js'
import { registerReviewRoutes } from './routes.js'
import { applyGitReview } from '../git-review/index.js'

export const name = '@miint-sunny/dsh-workbench/review'

/** 回退记录保留天数（行配置 keepDays）的默认值。 */
const DEFAULT_KEEP_DAYS = 30

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 行配置里的保留天数：缺省 30；给了就必须是正整数，否则行加载失败。
 * @param {number | undefined} value 行配置的 keepDays。
 * @returns {number} 保留天数。
 */
export function keepDaysOf(value) {
  if (value === undefined) return DEFAULT_KEEP_DAYS
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-workbench/review 的 keepDays 要是正整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 回退记录目录：配置给了 dataDir 用它；否则在插件数据目录（`$DSH_HOME/dsh-workbench`，见 lib/data-dir.js）下的 review/。临时 DSH 演练时 DSH_HOME 指着临时目录，记录不会写进真的 ~/.dsh。
 * @param {{ dataDir?: string }} config 行配置。
 * @param {{ DSH_HOME?: string }} [env] 环境变量，缺省用进程的；测试注入。
 * @returns {string} 记录目录的绝对路径。
 */
export function reviewDataDir(config = {}, env = process.env) {
  if (config.dataDir !== undefined) return config.dataDir
  return join(workbenchDataDir(env), 'review')
}

/**
 * 装上改动审阅的宿主端。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dataDir?: string, keepDays?: number }} [config] 行配置；dataDir 覆盖记录目录，keepDays 覆盖保留天数（默认 30）。
 */
export function applyReview(ctx, config = {}) {
  const keepDays = keepDaysOf(config.keepDays)
  ctx.inject(['workspaceChanges', 'agents'], (scope) => {
    const store = createRevertStore(reviewDataDir(config))
    const service = createReviewService({
      changes: scope.workspaceChanges,
      isRunning: (sessionId) => scope.agents.get(sessionId)?.status === 'running',
      store,
    })
    registerReviewRoutes(scope, service)
    // 行启动时清一次，之后每天一次；记录按存下的时间算年头，DSH 重启不清记录。
    const prune = () => {
      void store.prune(Date.now() - keepDays * DAY_MS)
    }
    prune()
    const timer = setInterval(prune, DAY_MS)
    scope.effect(() => () => {
      clearInterval(timer)
    }, 'dsh-workbench: review prune timer')
  })
}

/**
 * 注册 review 行（cordis.patch.yml 里 id 为 review 的行）：功能登记 + 宿主端。行配置（cordis.yml 里 review 行的 config）原样传下去。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ dataDir?: string, keepDays?: number }} [config] 行配置。
 */
export function apply(ctx, config) {
  applyGitReview(ctx, config)
  ctx.effect(() => registerFeature('review'), '@miint-sunny/dsh-workbench/review: feature registration')
  applyReview(ctx, config)
}

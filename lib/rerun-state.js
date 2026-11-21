/**
 * 重新生成和编辑重发（dsh-workbench/rerun）的宿主端：行配置的默认值、校验和存取路由。
 * 分叉、发送、归档都在客户端做（ctx.sessions.fork / prompt / uiWorkspace，见
 * src/client/rerun.js）；宿主端只存「分叉后归档原会话」这一个开关。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 *
 * 配置存 `$DSH_HOME/dsh-workbench/rerun.json`（目录见 lib/data-dir.js），读写都走
 * `/api` 通道（进来前已查 Host、Origin、登录 cookie，只放本人）。
 */
import { readJsonConfig, registerJsonConfigRoute, writeJsonConfig } from './data-dir.js'

/** 默认配置：分叉后不归档原会话（归档了也只在左栏恢复，先默认保守）。 */
export function defaultRerunConfig() {
  return { archiveOriginal: false }
}

/**
 * 校验并规范化网页端交来的配置（HTTP 请求体，要校验）。
 * @param {unknown} value 请求体里的配置。
 * @returns {{archiveOriginal: boolean}} 规范化后的配置。
 * @throws {Error} 形状不对时。
 */
export function parseRerunConfig(value) {
  if (typeof value !== 'object' || value === null) throw new Error('rerun config must be an object')
  const { archiveOriginal } = value
  if (typeof archiveOriginal !== 'boolean') throw new Error('rerun config archiveOriginal must be a boolean')
  return { archiveOriginal }
}

/** 读行配置（rerun.json）；文件不存在或坏了时用默认值，不写回。 */
export const readRerunConfig = dir => readJsonConfig(dir, 'rerun.json', parseRerunConfig, defaultRerunConfig)

/** 原子写行配置；config 要先经过 parseRerunConfig。 */
export const writeRerunConfig = (dir, config) => writeJsonConfig(dir, 'rerun.json', config)

/**
 * 注册 rerun 行的路由：GET/POST /api/dsh-workbench.rerun.config（回答见 lib/data-dir.js 的 registerJsonConfigRoute）。
 * @param {object} scope 带有 connection 服务的插件作用域（进来前已过鉴权）。
 * @param {object} [options] 注入项：dir 覆盖数据目录（测试用）。
 * @returns {() => void} 注销函数。
 */
export function applyRerunRoutes(scope, options = {}) {
  return registerJsonConfigRoute(scope, { path: '/api/dsh-workbench.rerun.config', file: 'rerun.json', parse: parseRerunConfig, fallback: defaultRerunConfig, dir: options.dir })
}

/**
 * 系统通知（dsh-workbench/notify）的宿主端：通知配置的存取路由和默认值；通知的
 * 状态转换在 src/client/notify.js（订阅的是客户端的 uiSession.sessionStatus）。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 *
 * 配置存 `$DSH_HOME/dsh-workbench/notify.json`（目录见 lib/data-dir.js），读写都走
 * `/api` 通道（进来前已查 Host、Origin、登录 cookie，只放本人）。
 */
import { readJsonConfig, registerJsonConfigRoute, writeJsonConfig } from './data-dir.js'

/** 通知哪几种事件的键（完成、等待审批、等待回答、计划待审）。 */
export const EVENT_KEYS = ['completed', 'approval', 'question', 'planReview']

/** 默认不通知的预设 ID。 */
export const DEFAULT_EXCLUDED_PRESETS = ['whale', 'whale-dream']

/** 默认配置：四种事件都通知、排除配置列出的预设、前台不发、通知不写回复内容。 */
export function defaultNotifyConfig() {
  return {
    events: { completed: true, approval: true, question: true, planReview: true },
    excludedPresets: [...DEFAULT_EXCLUDED_PRESETS],
    notifyForeground: false,
    showFirstLine: false,
  }
}

/**
 * 校验并规范化网页端交来的配置（HTTP 请求体，要校验）。
 * @param {unknown} value 请求体里的配置。
 * @returns {object} 规范化后的配置。
 * @throws {Error} 形状不对时。
 */
export function parseNotifyConfig(value) {
  if (typeof value !== 'object' || value === null) throw new Error('notify config must be an object')
  const { events, excludedPresets, notifyForeground, showFirstLine } = value
  if (typeof events !== 'object' || events === null) throw new Error('notify config events must be an object')
  const parsedEvents = {}
  for (const key of EVENT_KEYS) {
    if (typeof events[key] !== 'boolean') throw new Error(`notify config events.${key} must be a boolean`)
    parsedEvents[key] = events[key]
  }
  if (!Array.isArray(excludedPresets)) throw new Error('notify config excludedPresets must be an array')
  const presets = [...new Set(excludedPresets)]
  for (const preset of presets) {
    if (typeof preset !== 'string' || preset.trim() === '') throw new Error('notify config excludedPresets entries must be non-empty strings')
  }
  if (typeof notifyForeground !== 'boolean') throw new Error('notify config notifyForeground must be a boolean')
  if (typeof showFirstLine !== 'boolean') throw new Error('notify config showFirstLine must be a boolean')
  return { events: parsedEvents, excludedPresets: presets, notifyForeground, showFirstLine }
}

/** 读通知配置（notify.json）；文件不存在或坏了时用默认值，不写回。 */
export const readNotifyConfig = dir => readJsonConfig(dir, 'notify.json', parseNotifyConfig, defaultNotifyConfig)

/** 原子写通知配置；config 要先经过 parseNotifyConfig。 */
export const writeNotifyConfig = (dir, config) => writeJsonConfig(dir, 'notify.json', config)

/**
 * 注册 notify 行的路由：GET/POST /api/dsh-workbench.notify.config（回答见 lib/data-dir.js 的 registerJsonConfigRoute）。
 * @param {object} scope 带有 connection 服务的插件作用域（进来前已过鉴权）。
 * @param {object} [options] 注入项：dir 覆盖数据目录（测试用）。
 * @returns {() => void} 注销函数。
 */
export function applyNotifyRoutes(scope, options = {}) {
  return registerJsonConfigRoute(scope, { path: '/api/dsh-workbench.notify.config', file: 'notify.json', parse: parseNotifyConfig, fallback: defaultNotifyConfig, dir: options.dir })
}

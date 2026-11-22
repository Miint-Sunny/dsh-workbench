/**
 * 检查点（dsh-workbench/checkpoints）宿主端的纯函数：配置的默认值、校验和存取（读写和
 * notify、rerun 两行共用 lib/data-dir.js 的函数），加上会话合格性、按保留天数过期、
 * 占用上限的判断。配置存 `$DSH_HOME/dsh-workbench/checkpoints.json`（目录见 lib/data-dir.js）。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */
import { readJsonConfig, writeJsonConfig } from './data-dir.js'
import { DEFAULT_EXCLUDED_PRESETS } from './notify-state.js'
import { delegatedSession } from './session-scope.js'

/** 一天的毫秒数。 */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 默认配置：保留 14 天、每个会话最多占 2 GB、跳过配置列出的预设、第一个工具执行前最多等 5 秒、
 * 不在 git 里的目录单个文件最多存 2 MB。
 */
export function defaultCheckpointsConfig() {
  return {
    keepDays: 14,
    maxStoreMB: 2048,
    skipPresets: [...DEFAULT_EXCLUDED_PRESETS],
    waitSeconds: 5,
    maxFileMB: 2,
  }
}

/**
 * 校验并规范化网页端交来的配置（HTTP 请求体，要校验）。数字都要是正整数（waitSeconds 另
 * 有 1–60 的上限：更大的值会让 setTimeout 溢出成 1 毫秒，第 40 件 #9），skipPresets 是去
 * 重过的非空字符串数组。
 * @param {unknown} value 请求体里的配置。
 * @returns {{ keepDays: number, maxStoreMB: number, skipPresets: string[], waitSeconds: number, maxFileMB: number }} 规范化后的配置。
 * @throws {Error} 形状不对时。
 */
export function parseCheckpointsConfig(value) {
  if (typeof value !== 'object' || value === null) throw new Error('checkpoints config must be an object')
  const { keepDays, maxStoreMB, skipPresets, waitSeconds, maxFileMB } = value
  for (const [field, number] of [['keepDays', keepDays], ['maxStoreMB', maxStoreMB], ['maxFileMB', maxFileMB]]) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`checkpoints config ${field} must be a positive integer`)
  }
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 60) {
    throw new Error('checkpoints config waitSeconds must be an integer between 1 and 60')
  }
  if (!Array.isArray(skipPresets)) throw new Error('checkpoints config skipPresets must be an array')
  const presets = [...new Set(skipPresets)]
  for (const preset of presets) {
    if (typeof preset !== 'string' || preset.trim() === '') throw new Error('checkpoints config skipPresets entries must be non-empty strings')
  }
  return { keepDays, maxStoreMB, skipPresets: presets, waitSeconds, maxFileMB }
}

/** 读检查点配置（checkpoints.json）；文件不存在或坏了时用默认值，不写回。 */
export const readCheckpointsConfig = dir => readJsonConfig(dir, 'checkpoints.json', parseCheckpointsConfig, defaultCheckpointsConfig)

/** 原子写检查点配置；config 要先经过 parseCheckpointsConfig。 */
export const writeCheckpointsConfig = (dir, config) => writeJsonConfig(dir, 'checkpoints.json', config)

/**
 * 一个会话存不存检查点：要有工作目录；子智能体（origin 是 subagent 或 delegationDepth
 * 大于 0）不存；智能体预设被配置排除的不存。
 * @param {{ cwd?: string, origin?: string, delegationDepth?: number, agentPreset?: string }} header 会话头。
 * @param {{ skipPresets: string[] }} config 当前配置。
 * @returns {{ eligible: boolean, why: string }} 合不合格和原因（'cwd'、'subagent'、'preset'、''）。
 */
export function eligibility(header, config) {
  if (typeof header?.cwd !== 'string' || header.cwd === '') return { eligible: false, why: 'cwd' }
  if (delegatedSession(header)) return { eligible: false, why: 'subagent' }
  if (typeof header?.agentPreset === 'string' && config.skipPresets.includes(header.agentPreset)) {
    return { eligible: false, why: 'preset' }
  }
  return { eligible: true, why: '' }
}

/**
 * 一个会话的检查点是不是过了保留天数（清理①：整个会话目录删）。列表是空的（第一次快照
 * 还没写完）不算过期：没有条目就判不了，按目录修改时间判（第 40 件 #14）。有条目时两边
 * 都要旧——目录新说明最近还有活动（恢复、撤销都会碰目录），不删。
 * @param {{ time: number }[]} entries 检查点记录（带 time）。
 * @param {number} now 现在的毫秒时间戳。
 * @param {number} keepDays 保留天数。
 * @param {number} [dirMtime] 会话目录的修改时间（毫秒）；缺省只看条目。
 * @returns {boolean} 过期时 true。
 */
export function sessionExpired(entries, now, keepDays, dirMtime) {
  const cutoff = now - keepDays * DAY_MS
  if (entries.length === 0) return dirMtime !== undefined && dirMtime < cutoff
  if (entries.some(entry => entry.time >= cutoff)) return false
  return dirMtime === undefined || dirMtime < cutoff
}

/**
 * 一个会话的检查点占用是不是到了上限（满了之后新的轮次不再存）。
 * @param {number} sizeBytes objects/ 的字节数。
 * @param {number} maxStoreMB 配置的每个会话上限（MB）。
 * @returns {boolean} 超过上限时 true。
 */
export function fullBy(sizeBytes, maxStoreMB) {
  return sizeBytes > maxStoreMB * 1024 * 1024
}

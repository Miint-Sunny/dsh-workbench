/** 上下文页的按需读取、估算及响应限额；不读取部署凭据或 profile。 */
export function parseContextConfig(value = {}) {
  const defaults = { calibrationTolerance: .2, resultShare: .5, unusedToolShare: .2, baselineDays: 14, baselineMinDays: 3, zThreshold: 3, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, defaultThresholdRatio: .8, defaultHeadroomTokens: 65536, historyLimit: 40, toolLimit: 50, resultLimit: 12, maxConcurrentReads: 2, maxCachedSessions: 8, chunkEvents: 128 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('context config must be an object')
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`context config: unknown ${key}`)
  const config = { ...defaults, ...value }
  for (const key of ['baselineDays','baselineMinDays','historyLimit','toolLimit','resultLimit','maxConcurrentReads','maxCachedSessions','chunkEvents']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`context config: invalid ${key}`)
  for (const key of ['calibrationTolerance','defaultThresholdRatio','resultShare','unusedToolShare']) if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) throw new Error(`context config: invalid ${key}`)
  if (config.defaultThresholdRatio === 0 || !Number.isFinite(config.zThreshold) || config.zThreshold <= 0 || !Number.isSafeInteger(config.defaultHeadroomTokens) || config.defaultHeadroomTokens < 0) throw new Error('context config: invalid threshold')
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format(0)
  return config
}

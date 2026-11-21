/** 闲时压缩这一行的配置，可以在 cordis.yml 里改；用户在页面上改的设置不在这里，在 compaction-state.js。 */

const DEFAULTS = Object.freeze({
  dir: null,
  presets: ['standard', 'dsh-workbench-coding', 'dsh-workbench-full'],
  minCompactable: 20_000,
  lateMinutes: 5,
  timeoutMs: 120_000,
  cooldownMinutes: 30,
  retainRatio: 0.16,
  retainDivisor: 5,
  lifeRefreshMinutes: 10,
  idleChoices: [15, 30, 60, 120, 240],
  cacheNotes: { 'deepseek-official': 'hours-days' },
})

/**
 * 校验配置。未知的键和不合法的值直接报错，这一行加载失败。
 * @param {unknown} value 行的 config。
 * @returns {object} 补全默认值后的配置。
 */
export function parseCompactionConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('compaction config must be an object')
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`compaction config: unknown ${key}`)
  const config = { ...structuredClone(DEFAULTS), ...value }
  if (config.dir !== null && (typeof config.dir !== 'string' || config.dir === '')) throw new Error('compaction config: invalid dir')
  if (!Array.isArray(config.presets) || !config.presets.every(item => typeof item === 'string' && item)) throw new Error('compaction config: invalid presets')
  for (const key of ['minCompactable', 'lateMinutes', 'timeoutMs', 'cooldownMinutes', 'retainDivisor', 'lifeRefreshMinutes']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`compaction config: invalid ${key}`)
  if (!Array.isArray(config.idleChoices) || config.idleChoices.length === 0 || !config.idleChoices.every(item => Number.isSafeInteger(item) && item >= 1)) throw new Error('compaction config: invalid idleChoices')
  if (!Number.isFinite(config.retainRatio) || config.retainRatio <= 0 || config.retainRatio >= 1) throw new Error('compaction config: invalid retainRatio')
  if (typeof config.cacheNotes !== 'object' || config.cacheNotes === null || Array.isArray(config.cacheNotes)) throw new Error('compaction config: invalid cacheNotes')
  for (const note of Object.values(config.cacheNotes)) if (typeof note !== 'string') throw new Error('compaction config: invalid cacheNotes')
  return config
}

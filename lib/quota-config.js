/** 余额与额度（dsh-workbench/quota）的配置：默认值、校验、读文件；校验写法照 lib/usage-config.js（codex-usage 分支）。本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fail = field => { throw new Error(`quota config: invalid ${field}`) }

/**
 * 校验配置并补默认字段：`timeoutSeconds` 单次查询超时（默认 10）、`cacheSeconds` 结果缓存秒数（默认 300）。
 * @param {unknown} [value] quota.json 解析出的对象。
 * @returns {{timeoutSeconds: number, cacheSeconds: number}} 可序列化的配置。
 * @throws {Error} 形状不对时（行启动即报错）。
 */
export function parseQuotaConfig(value = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('object')
  const defaults = { timeoutSeconds: 10, cacheSeconds: 300 }
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) fail(key)
  const config = { ...defaults, ...value }
  for (const key of ['timeoutSeconds', 'cacheSeconds']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) fail(key)
  }
  return config
}

/**
 * 读数据目录里的 quota.json；只有文件不存在用默认值，别的问题（读不了、坏 JSON、校验不过）照实抛。
 * @param {string} dir 数据目录（`$DSH_HOME/dsh-workbench`）。
 * @returns {{timeoutSeconds: number, cacheSeconds: number}} 已校验配置。
 */
export function readQuotaConfig(dir) {
  let text
  try {
    text = readFileSync(join(dir, 'quota.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return parseQuotaConfig()
    throw error
  }
  return parseQuotaConfig(JSON.parse(text))
}

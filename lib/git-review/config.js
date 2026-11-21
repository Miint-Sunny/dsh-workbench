/**
 * 审阅面板 Git 宿主端配置校验与路径解析。
 * 配置挂载在 dsh-workbench-review 行上，缺省使用经过检验的默认值；非法配置在加载时报错。
 */
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { workbenchDataDir } from '../data-dir.js'

/** 默认配置：保留天数、文件/差异/备份/生成提交差异上限、提交数上限、Git 超时、模型覆盖。 */
export const DEFAULT_GIT_REVIEW_CONFIG = Object.freeze({
  keepDays: 30,
  maxFileBytes: 512 * 1024,
  maxDiffBytes: 4 * 1024 * 1024,
  maxBackupBytes: 16 * 1024 * 1024,
  maxCommitDiffBytes: 64 * 1024,
  maxCommits: 200,
  gitTimeoutMs: 30_000,
  commitModel: null,
})

const POSITIVE_INT_KEYS = [
  'keepDays',
  'maxFileBytes',
  'maxDiffBytes',
  'maxBackupBytes',
  'maxCommitDiffBytes',
  'maxCommits',
  'gitTimeoutMs',
]

const ALLOWED_KEYS = new Set([
  ...POSITIVE_INT_KEYS,
  'dataDir',
  'gitReviewDataDir',
  'trashDir',
  'commitModel',
  'locale',
])

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

const assertPositiveInt = (name, value) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-workbench/review 的 ${name} 要是正整数，收到 ${JSON.stringify(value)}`)
  }
}

const assertOptionalPath = (name, value) => {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '' || value.includes('\0'))) {
    throw new Error(`dsh-workbench/review 的 ${name} 要是非空路径字符串`)
  }
}

/** 尚未创建的存储目录，沿最近的已存在父目录解析其实际位置。 */
function storagePath(path) {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('gitReviewDataDir 与改动审阅目录不能经过悬空链接')
    }
    return join(storagePath(dirname(path)), basename(path))
  }
}

/**
 * 校验并规范化 Git 审阅行配置。
 * @param {unknown} [raw] 行配置对象。
 * @returns {object} 规范化后的配置。
 */
export function parseGitReviewConfig(raw = {}) {
  if (!isPlainObject(raw)) {
    throw new Error('dsh-workbench/review 的配置必须是对象')
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`dsh-workbench/review 不支持配置项 ${key}`)
    }
  }
  assertOptionalPath('dataDir', raw.dataDir)
  assertOptionalPath('gitReviewDataDir', raw.gitReviewDataDir)
  assertOptionalPath('trashDir', raw.trashDir)

  const config = { ...DEFAULT_GIT_REVIEW_CONFIG }
  for (const key of POSITIVE_INT_KEYS) {
    if (raw[key] !== undefined) {
      assertPositiveInt(key, raw[key])
      config[key] = raw[key]
    }
  }
  if (raw.dataDir !== undefined) config.dataDir = raw.dataDir
  if (raw.gitReviewDataDir !== undefined) config.gitReviewDataDir = raw.gitReviewDataDir
  if (raw.trashDir !== undefined) config.trashDir = raw.trashDir

  if (raw.commitModel !== undefined && raw.commitModel !== null) {
    if (typeof raw.commitModel !== 'string' || raw.commitModel.trim() === '' || raw.commitModel.length > 128) {
      throw new Error('dsh-workbench/review 的 commitModel 要是非空模型名（不超过 128 字符）或 null')
    }
    config.commitModel = raw.commitModel.trim()
  }

  if (raw.locale !== undefined) {
    if (raw.locale !== 'zh' && raw.locale !== 'en') {
      throw new Error('dsh-workbench/review 的 locale 必须是 zh 或 en')
    }
    config.locale = raw.locale
  }

  const reviewDir = storagePath(resolve(config.dataDir ?? join(workbenchDataDir(), 'review')))
  const gitDir = storagePath(gitReviewDataDir(config))
  const disjoint = [relative(gitDir, reviewDir), relative(reviewDir, gitDir)]
    .every(path => isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
  if (!disjoint) {
    throw new Error('gitReviewDataDir 必须与改动审阅的备份目录分开')
  }
  return config
}

/**
 * Git 审阅回退备份与无钩子空目录的根目录。不与改动审阅（lib/review/store.js）混放。
 * @param {{ gitReviewDataDir?: string, dataDir?: string }} [config] 行配置。
 * @param {{ DSH_HOME?: string }} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function gitReviewDataDir(config = {}, env = process.env) {
  if (config.gitReviewDataDir !== undefined) return resolve(config.gitReviewDataDir)
  if (config.dataDir !== undefined) return join(dirname(resolve(config.dataDir)), 'git-review')
  return join(workbenchDataDir(env), 'git-review')
}

/**
 * 未跟踪文件回退时的废纸篓目录。
 * @param {{ trashDir?: string }} [config] 行配置。
 * @param {{ XDG_DATA_HOME?: string }} [env] 环境变量。
 * @param {string} [platform] 操作系统平台。
 * @returns {string} 废纸篓目录绝对路径。
 */
export function gitReviewTrashDir(config = {}, env = process.env, platform = process.platform) {
  if (config.trashDir !== undefined) return resolve(config.trashDir)
  if (platform === 'darwin') return join(homedir(), '.Trash')
  const xdgData = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== ''
    ? env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share')
  return join(xdgData, 'Trash', 'files')
}

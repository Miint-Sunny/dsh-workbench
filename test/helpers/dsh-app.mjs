/**
 * 在 DSH App 自带的 Electron（ELECTRON_RUN_AS_NODE）里跑脚本：app.asar 里的官方包只有它读得了。
 * 会话迁移的测试用它造会话（dsh-app-seed.mjs）和核对（lib/workspace-move-appcheck.mjs）。
 * 机器上没有 App 时 APP_BINARY 不存在，用到它的测试应当跳过。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'

/** App 的可执行文件。 */
export const APP_BINARY = join(APP, 'Contents/MacOS/DeepSeek Harness')

/** 用到 App 的测试的 skip 选项。 */
export const NEEDS_APP = existsSync(APP_BINARY) ? false : '这台机器没有 DSH App'

/**
 * 在 App 的 Electron 里跑一个脚本文件，返回它打到标准输出的 JSON。
 * @param {string} script 脚本路径。
 * @param {Record<string, string>} env 额外的环境变量。
 * @returns {unknown} 解析后的输出。
 */
export function runInApp(script, env) {
  const output = execFileSync(APP_BINARY, [script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(output)
}

const SEED = new URL('./dsh-app-seed.mjs', import.meta.url).pathname
const APPCHECK = new URL('../../lib/workspace-move-appcheck.mjs', import.meta.url).pathname

/**
 * 用 App 的代码造一个 DSH_HOME：会话、工作区、归档、置顶，见 dsh-app-seed.mjs 的说明。
 * @param {string} home DSH_HOME。
 * @param {object} spec 场景。
 * @returns {{ folders: Record<string, string> }} 各文件夹的真实路径。
 */
export const seedHome = (home, spec) => runInApp(SEED, { DWB_SEED_HOME: home, DWB_SEED_SPEC: JSON.stringify(spec) })

/**
 * 用 App 的代码核对一个 DSH_HOME（lib/workspace-move-appcheck.mjs）。
 * @param {string} home DSH_HOME。
 * @returns {object} 核对报告。
 */
export const appCheck = home => runInApp(APPCHECK, { DWB_MOVE_HOME: home })

/**
 * 一棵目录里每个普通文件的 SHA-256（相对路径 → 哈希），用来比「逐字节一样」。
 * @param {string} root 目录。
 * @param {(rel: string) => boolean} [skip] 不比的相对路径。
 * @returns {Record<string, string>} 清单。
 */
export function treeHashes(root, skip = () => false) {
  const out = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = relative(root, path)
      if (skip(rel)) continue
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else out[rel] = createHash('sha256').update(stat.isSymbolicLink() ? 'link' : readFileSync(path)).digest('hex')
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/**
 * 测试用的临时目录：建好以后记下来，这条测试结束时（通过、失败都一样）删掉。
 * 测试文件各是一个进程，下面的 afterEach 挂在导入它的那个文件的每一条测试上，
 * 所以只在测试里面（或测试调用的夹具里）建；不要在模块顶层建一个所有测试共用的目录。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'node:test'

const made = []

/** 被测代码常有不等测试的后台写盘（检查点行启动时的清理就是），写在目录删掉以后会把它又建出来。 */
const QUIET_CHECKS = 2
const QUIET_MS = 15
const MAX_ROUNDS = 50

/** 删掉目录，隔一会儿再看一眼；又出现了就再删，连续 QUIET_CHECKS 次都没有才算删干净。 */
async function removeDir(dir) {
  for (let round = 0, quiet = 0; quiet < QUIET_CHECKS && round < MAX_ROUNDS; round++) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    await new Promise(resolve => setTimeout(resolve, QUIET_MS))
    quiet = existsSync(dir) ? 0 : quiet + 1
    if (quiet === QUIET_CHECKS) return
  }
  throw new Error(`Temporary directory did not stay removed: ${dir}`)
}

afterEach(async () => {
  await Promise.all(made.splice(0).map(removeDir))
})

/**
 * 建一个临时目录，这条测试结束时删掉。
 * @param {string} prefix 目录名的开头。
 * @param {string} [parent] 建在哪里，默认系统临时目录。
 * @returns {Promise<string>} 目录的路径。
 */
export async function tempDir(prefix, parent = tmpdir()) {
  const dir = await mkdtemp(join(parent, prefix))
  made.push(dir)
  return dir
}

/**
 * 同 tempDir，同步版。
 * @param {string} prefix 目录名的开头。
 * @param {string} [parent] 建在哪里，默认系统临时目录。
 * @returns {string} 目录的路径。
 */
export function tempDirSync(prefix, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, prefix))
  made.push(dir)
  return dir
}

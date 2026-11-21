/**
 * 检查点测试用的 subprocess 注入：把 node:child_process 包成 DSH subprocess 服务的形状
 * （spawn(spec) → { done, collected.stdout.readFrom(0) }，spec.env 里 undefined 表示删掉），
 * 直接跑真 git。环境从空白起（只给 PATH、TMPDIR 和一个临时 HOME，再叠 spec.env），不继承
 * 本机的 GIT_* 变量和全局 git 配置，测试结果不随本机状态变。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempDirSync } from './helpers/temp-dir.mjs'

/** 有界输出收集器：超出上限丢掉多余的字节并记 lossy（照 DSH collect-mode 的语义简化）。 */
function createCollector(maxBytes) {
  const chunks = []
  let length = 0
  let lossy = false
  return {
    push(chunk) {
      if (length >= maxBytes) {
        lossy = true
        return
      }
      if (length + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - length))
        length = maxBytes
        lossy = true
        return
      }
      chunks.push(chunk)
      length += chunk.length
    },
    readFrom(offset) {
      const all = Buffer.concat(chunks)
      return { text: all.subarray(offset).toString('utf8'), lossy }
    },
  }
}

/**
 * 建一个本地 subprocess 服务。
 * @param {{ home?: string }} [options] home 覆盖 HOME（默认现开一个临时目录，这条测试结束时删掉）。
 * @returns {{ resolveExecutable: Function, spawn: Function }} lib/checkpoints-git.js 认的形状。
 */
export function createLocalSubprocess(options = {}) {
  const home = options.home ?? tempDirSync('dwb-git-home-')
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  }
  return {
    async resolveExecutable(command) {
      if (command === 'git' && existsSync('/usr/bin/git')) return '/usr/bin/git'
      return command
    },
    spawn(spec) {
      const env = { ...baseEnv }
      for (const [name, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[name]
        else env[name] = String(value)
      }
      const stdinData = spec.stdio?.stdin !== undefined && spec.stdio.stdin !== 'ignore' ? spec.stdio.stdin.data : undefined
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd ?? process.cwd(),
        env,
        stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      if (stdinData !== undefined) {
        child.stdin.on('error', error => {
          // git 可能没读完标准输入就退出（EPIPE），输入已经给了，不算失败。
          if (error?.code !== 'EPIPE') throw error
        })
        child.stdin.end(stdinData)
      }
      const stdout = createCollector(spec.stdio?.stdout?.maxBytes ?? 8 * 1024 * 1024)
      const stderr = createCollector(spec.stdio?.stderr?.maxBytes ?? 16 * 1024)
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      spec.signal?.addEventListener('abort', () => {
        child.kill('SIGTERM')
        const killer = setTimeout(() => child.kill('SIGKILL'), Math.max(spec.graceMs ?? 2_000, 1))
        killer.unref()
      }, { once: true })
      const done = new Promise((resolveDone, rejectDone) => {
        child.on('error', rejectDone)
        child.on('close', exitCode => resolveDone({ exitCode }))
      })
      return { done, collected: { stdout, stderr } }
    },
  }
}

/**
 * 测试自己跑一条 git（init、commit 这类搭场景的命令），不经过被测代码的运行器；环境同样
 * 从空白起（HOME 指到临时目录，不读本机全局配置），用户信息用 -c 传。
 * @param {string} cwd 工作目录。
 * @param {string[]} args git 参数。
 * @param {{ stdin?: string, home?: string }} [options] 标准输入和 HOME。
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>} 退出码和输出。
 */
export function runGit(cwd, args, options = {}) {
  const argv = ['/usr/bin/git', ...args]
  if (!existsSync('/usr/bin/git')) argv[0] = 'git'
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C',
      },
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    if (options.stdin !== undefined) {
      child.stdin.on('error', error => {
        if (error?.code !== 'EPIPE') throw error
      })
      child.stdin.end(options.stdin)
    }
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => resolveRun({ exitCode: null, stdout: out, stderr: String(error) }))
    child.on('close', exitCode => resolveRun({ exitCode, stdout: out, stderr: err }))
  })
}

/** 搭场景要提交时的固定身份。 */
export const COMMIT_IDENTITY = ['-c', 'user.email=test@dsh-workbench', '-c', 'user.name=dwb test']

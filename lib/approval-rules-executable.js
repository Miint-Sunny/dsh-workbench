/** 用官方 subprocess 解析器定位程序，再核验实际文件；不执行待审批命令。 */
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { relative, isAbsolute, basename, join, sep, delimiter } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { policyHash, policyProject } from './policy-scope.js'
import { simpleArgv, approvalPattern, rulesFail } from './approval-rules-state.js'
const execMetadata = promisify(execFile)
const stamp = (s) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs])
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
const interpreter =
  /^(?:ba|da|z|fi|k)?sh$|^(?:node|nodejs|deno|bun|python[\d.]*|ruby|perl|php|lua[\d.]*|osascript|env|sudo|su|doas|xargs)$/i
function localBash(shell) {
  return ['LocalBashExecutor', 'SandboxBashExecutor'].includes(
    Object.getPrototypeOf(shell)?.constructor?.name,
  )
}
export function createExecutableInspector(config) {
  const files = new Map(),
    builtins = new Map()
  let active = 0
  async function file(path, signal) {
    signal?.throwIfAborted()
    const canonical = await realpath(path),
      roots = []
    for (const root of config.executableRoots)
      try {
        const actual = await realpath(root)
        if ((await stat(actual)).isDirectory()) roots.push(actual)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    if (!roots.some((root) => inside(root, canonical))) rulesFail('unverified-executable')
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (
        !before.isFile() ||
        !(before.mode & 0o111) ||
        before.size < 16 ||
        before.size > config.maxProgramBytes
      )
        rulesFail('unverified-executable')
      const key = stamp(before),
        cached = files.get(canonical)
      if (cached?.stamp === key) return cached.value
      const head = Buffer.alloc(16)
      await handle.read(head, 0, 16, 0)
      const magic = head.readUInt32BE(0),
        elf = magic === 0x7f454c46 && [1, 2].includes(head[4]) && [1, 2].includes(head[5]),
        macho = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic),
        fat =
          (magic === 0xcafebabe && head.readUInt32BE(4) > 0 && head.readUInt32BE(4) <= 16) ||
          (magic === 0xbebafeca && head.readUInt32LE(4) > 0 && head.readUInt32LE(4) <= 16)
      if (!elf && !macho && !fat) rulesFail('unverified-executable')
      const digest = createHash('sha256'),
        buffer = Buffer.alloc(131072)
      let offset = 0
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (!bytesRead) break
        offset += bytesRead
        if (offset > config.maxProgramBytes) rulesFail('unverified-executable')
        digest.update(buffer.subarray(0, bytesRead))
      }
      if (stamp(await handle.stat()) !== key) rulesFail('source-changed')
      const value = { path: canonical, hash: digest.digest('hex') }
      files.set(canonical, { stamp: key, value })
      while (files.size > config.maxFingerprintCache) files.delete(files.keys().next().value)
      return value
    } finally {
      await handle.close()
    }
  }
  async function inspect(ctx, req, args, signal) {
    if (active >= config.maxConcurrentChecks) rulesFail('check-busy')
    active++
    try {
      const shellService = ctx.agentPresets.serviceFor(req.agent, 'shell') ?? ctx.shell,
        subprocess = ctx.agentPresets.serviceFor(req.agent, 'subprocess') ?? ctx.subprocess
      if (!['darwin', 'linux'].includes(process.platform) || !localBash(shellService))
        rulesFail('unsupported-provider')
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some(
          (k) =>
            ![
              'description',
              'command',
              'workdir',
              'timeoutMs',
              'run_in_background',
              'sandbox_permissions',
              'justification',
            ].includes(k),
        ) ||
        args.sandbox_permissions !== undefined ||
        args.justification !== undefined ||
        args.run_in_background === true
      )
        rulesFail('unsupported-request')
      const argv = simpleArgv(args.command, config)
      if (interpreter.test(basename(argv[0]))) rulesFail('unverified-executable')
      const base = ctx.workingDirectory.get(req.agent.session),
        policy = ctx.sandboxPolicy.resolve({ session: req.agent.session })
      const workdir =
        args.workdir === undefined
          ? base
          : isAbsolute(args.workdir)
            ? args.workdir
            : join(base, args.workdir)
      const spec = shellService.resolve({
        command: args.command,
        workdir,
        dshEnv: {},
        sandboxPolicy: policy,
        signal,
      })
      const spawn = shellService.spawnSpec(
        spec,
        ['bash', '-c', args.command],
        spec.stdoutMaxBytes,
        signal,
      )
      if (
        !Array.isArray(spawn.argv) ||
        spawn.argv.length !== 3 ||
        spawn.argv[0] !== 'bash' ||
        spawn.argv[1] !== '-c' ||
        spawn.argv[2] !== args.command ||
        spawn.cwd !== spec.workdir
      )
        rulesFail('unsupported-provider')
      const overlay = spawn.env ?? {},
        ambient = process.env,
        keys = new Set([...Object.keys(ambient), ...Object.keys(overlay)])
      for (const key of keys)
        if (
          /^(?:BASH_ENV|ENV|BASHOPTS|SHELLOPTS|BASH_COMPAT|DEVELOPER_DIR)$|^BASH_FUNC_|^LD_|^DYLD_/.test(
            key,
          )
        )
          rulesFail('unverified-environment')
      if (basename(argv[0]) === 'git')
        for (const key of keys)
          if (key.startsWith('GIT_') && !(key === 'GIT_PAGER' && overlay[key] === 'cat'))
            rulesFail('unverified-environment')
      const pathValue = overlay.PATH ?? ambient.PATH ?? ''
      if (!pathValue || pathValue.split(delimiter).some((p) => !p || !isAbsolute(p)))
        rulesFail('unverified-environment')
      const shell = await file(await subprocess.resolveExecutable('bash', overlay, signal), signal)
      let reserved = builtins.get(shell.hash)
      if (!reserved) {
        const { stdout } = await execMetadata(
          shell.path,
          ['--noprofile', '--norc', '-c', 'compgen -b -k'],
          {
            cwd: '/',
            env: { PATH: '/usr/bin:/bin', BASH_ENV: '/dev/null', LC_ALL: 'C' },
            signal,
            timeout: config.lookupTimeoutMs,
            maxBuffer: 32768,
          },
        )
        reserved = new Set(stdout.trim().split(/\s+/))
        builtins.set(shell.hash, reserved)
        while (builtins.size > config.maxFingerprintCache)
          builtins.delete(builtins.keys().next().value)
      }
      if (!isAbsolute(argv[0]) && reserved.has(argv[0])) rulesFail('unverified-executable')
      const executable = await file(
          await subprocess.resolveExecutable(argv[0], overlay, signal),
          signal,
        ),
        programs = [executable]
      if (process.platform === 'darwin' && executable.path === '/usr/bin/git') {
        const { stdout } = await execMetadata('/usr/bin/xcode-select', ['--print-path'], {
          signal,
          timeout: config.lookupTimeoutMs,
          maxBuffer: 4096,
        })
        const actual = await file(join(stdout.trim(), 'usr/bin/git'), signal)
        if (actual.path !== executable.path) programs.push(actual)
      }
      const cwd = await realpath(spec.workdir),
        project = await policyProject(
          cwd,
          req.agent.session.header.cwd,
          config.lookupTimeoutMs,
          signal,
        )
      const identity = policyHash(
          JSON.stringify({
            programs,
            shell,
            path: pathValue,
            mode: policy.mode,
            provider: Object.getPrototypeOf(shellService).constructor.name,
          }),
        ),
        candidate = {
          project,
          cwd,
          executable: executable.path,
          programs,
          shell,
          identity,
          argv,
          pattern: approvalPattern(argv),
          sandboxMode: policy.mode,
        }
      return { ...candidate, fingerprint: policyHash(JSON.stringify({ candidate, args })) }
    } finally {
      active--
    }
  }
  return { file, inspect }
}

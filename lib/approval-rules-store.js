/** 人工规则与可信审计：原子修订、提交前检查、受限追加，无模型写入接口。 */
import { open, mkdir, writeFile, rename, unlink, rmdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rulesFail, approvalPattern, choosePattern, simpleArgv } from './approval-rules-state.js'
export function createApprovalRuleStore(file, config) {
  let queue = Promise.resolve(),
    auditQueue = Promise.resolve()
  function parse(value) {
    if (
      !value ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.rules) ||
      value.rules.length > config.maxRules
    )
      rulesFail('invalid-state')
    const ids = new Set()
    for (const r of value.rules) {
      if (
        !r ||
        typeof r.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(r.id) ||
        ids.has(r.id) ||
        typeof r.enabled !== 'boolean' ||
        typeof r.projectKey !== 'string' ||
        !r.projectKey ||
        !isAbsolute(r.projectPath ?? '') ||
        !isAbsolute(r.cwd ?? '') ||
        !isAbsolute(r.executable ?? '') ||
        typeof r.identity !== 'string' ||
        !r.identity ||
        !['read-only', 'workspace-write', 'danger-full-access'].includes(r.sandboxMode) ||
        !Number.isSafeInteger(r.createdAt) ||
        !r.pattern ||
        !Array.isArray(r.pattern.fixed) ||
        !Array.isArray(r.pattern.optional)
      )
        rulesFail('invalid-state')
      ids.add(r.id)
      if (
        r.pattern.fixed.length + r.pattern.optional.length > config.maxArgs ||
        r.pattern.fixed.some(
          (a) => typeof a !== 'string' || simpleArgv('x ' + a, config).length !== 2,
        ) ||
        r.pattern.optional.some((a) => !['--short', '--branch'].includes(a)) ||
        new Set(r.pattern.optional).size !== r.pattern.optional.length ||
        (r.pattern.optional.length &&
          (r.pattern.fixed.length !== 1 ||
            r.pattern.fixed[0] !== 'status' ||
            !/(?:^|\/)git$/.test(r.executable)))
      )
        rulesFail('invalid-state')
    }
    return value
  }
  async function read() {
    let h
    try {
      h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, revision: 0, rules: [] }
      throw e
    }
    try {
      const stat = await h.stat()
      if (!stat.isFile() || stat.size > config.maxStateBytes) rulesFail('invalid-state')
      const buffer = Buffer.alloc(stat.size + 1),
        { bytesRead } = await h.read(buffer, 0, buffer.length, 0)
      if (bytesRead > stat.size) rulesFail('invalid-state')
      let v
      try {
        v = JSON.parse(buffer.subarray(0, bytesRead).toString())
      } catch {
        rulesFail('invalid-state')
      }
      return parse(v)
    } finally {
      await h.close()
    }
  }
  function transaction(revision, mutate, valid = () => true) {
    const task = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const lock = file + '.lock',
        temp = file + '.' + randomUUID() + '.tmp'
      try {
        await mkdir(lock, { mode: 0o700 })
      } catch (e) {
        if (e.code === 'EEXIST') rulesFail('busy')
        throw e
      }
      try {
        const current = await read()
        if (current.revision !== revision) rulesFail('state-changed')
        if (!(await valid())) rulesFail('request-ended')
        const rules = mutate(current.rules)
        const next = parse({ version: 1, revision: revision + 1, rules })
        const text = JSON.stringify(next) + '\n'
        if (Buffer.byteLength(text) > config.maxStateBytes) rulesFail('state-limit')
        await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
        if (!(await valid())) rulesFail('request-ended')
        await rename(temp, file)
        return next
      } finally {
        await unlink(temp).catch((e) => {
          if (e.code !== 'ENOENT') throw e
        })
        await rmdir(lock)
      }
    })
    queue = task.catch(() => {})
    return task
  }
  function audit(record) {
    const task = auditQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const text = JSON.stringify({ version: 1, time: Date.now(), ...record }) + '\n'
      if (Buffer.byteLength(text) > config.maxStateBytes) rulesFail('audit-unavailable')
      const h = await open(
        join(dirname(file), 'approval-rules-audit.jsonl'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const stat = await h.stat()
        if (!stat.isFile() || stat.size + Buffer.byteLength(text) > config.maxAuditBytes)
          rulesFail('audit-unavailable')
        await h.writeFile(text)
        await h.sync()
      } finally {
        await h.close()
      }
    })
    auditQueue = task.catch(() => {})
    return task
  }
  return {
    read,
    audit,
    create: (revision, candidate, options, valid) =>
      transaction(
        revision,
        (rules) => {
          const pattern = choosePattern(approvalPattern(candidate.argv), options),
            same = rules.find(
              (r) =>
                r.projectKey === candidate.project.key &&
                r.cwd === candidate.cwd &&
                r.identity === candidate.identity &&
                JSON.stringify(r.pattern) === JSON.stringify(pattern),
            )
          const rule = {
            id: same?.id ?? randomUUID(),
            projectKey: candidate.project.key,
            projectPath: candidate.project.path,
            cwd: candidate.cwd,
            executable: candidate.executable,
            identity: candidate.identity,
            sandboxMode: candidate.sandboxMode,
            pattern,
            enabled: true,
            createdAt: same?.createdAt ?? Date.now(),
          }
          return [...rules.filter((r) => r.id !== rule.id), rule]
        },
        valid,
      ),
    change: (revision, id, action) =>
      transaction(revision, (rules) => {
        if (!['enable', 'disable', 'remove'].includes(action) || !rules.some((r) => r.id === id))
          rulesFail('invalid-input')
        return action === 'remove'
          ? rules.filter((r) => r.id !== id)
          : rules.map((r) => (r.id === id ? { ...r, enabled: action === 'enable' } : r))
      }),
    dispose: () => Promise.allSettled([queue, auditQueue]),
  }
}

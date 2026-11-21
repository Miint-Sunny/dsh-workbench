/** Shared privacy rules for public source exports and decompressed npm archives. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { homedir, hostname, userInfo } from 'node:os'

/** An unavailable optional OS identity source contributes no names. */
function optionalName(read) {
  try { return read().trim() } catch { return '' }
}

function hostForms(name) {
  const base = name.replace(/\.local$/i, '')
  return base ? [base, `${base}.local`] : []
}

let systemNames

/** Cache this process's names; account full names remain complete phrases. */
function localSystemNames() {
  if (systemNames) return systemNames
  const names = hostForms(optionalName(hostname))
  if (process.platform === 'darwin') {
    for (const [command, args, isHost] of [
      ['/usr/sbin/scutil', ['--get', 'ComputerName'], false],
      ['/usr/sbin/scutil', ['--get', 'LocalHostName'], true],
      ['/usr/bin/id', ['-F'], false],
    ]) {
      const name = optionalName(() => execFileSync(command, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 16 * 1024,
      }))
      names.push(...(isHost ? hostForms(name) : [name]))
    }
  }
  systemNames = [...new Set(names.filter(Boolean).map(name => name.toLowerCase()))]
  return systemNames
}

function entropy(value) {
  const counts = new Map()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  return -[...counts.values()].reduce((sum, count) => {
    const frequency = count / value.length
    return sum + frequency * Math.log2(frequency)
  }, 0)
}

/** Return locations and rule names only; never repeat the matched private text. */
export function privacyFindings(bytes, file = 'archive', { strictHomePaths = false, privateNames = [] } = {}) {
  const text = bytes.toString('utf8')
  const account = userInfo().username
  const literals = [account, homedir(), ...privateNames].filter(Boolean).map(value => value.toLowerCase())
  const localNames = localSystemNames()
  const privateDirectory = /(?:\.dsh\u002dlauncher\b|(?:^|[~\/\\])Whale(?:[\/\\]|$))/i
  const ownerWord = /\u4e3b\u4eba(?!公)/u
  const email = /(?<![A-Z0-9.!#$%&'*+=?^_`{|}~-])[A-Z0-9][A-Z0-9._%+-]{0,63}@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,24}(?![A-Z])/i
  const knownToken = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/
  const secretAssignment = /(?:api[_-]?key|access[_-]?token|secret|authorization|password)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+\/=-]{24,}/i
  const longToken = /(?:["'`]|^\s*)([A-Za-z0-9_-]{40,})(?:["'`]|\s*$)/g
  const findings = []
  text.split('\n').forEach((line, index) => {
    const lower = line.toLowerCase()
    const rules = []
    const containsName = value => value.length >= 5 ? lower.includes(value) : new RegExp(`(^|[^a-z0-9_])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i').test(line)
    if (literals.some(containsName)) rules.push('local-account')
    if (localNames.some(containsName)) rules.push('local-system-name')
    if (privateDirectory.test(line)) rules.push('private-directory')
    if (ownerWord.test(line)) rules.push('private-quotation')
    if (email.test(line.replace(/\bgit@[a-z0-9.-]+(?=[:/])/gi, ''))) rules.push('email')
    // Registry integrity values and plain hexadecimal digests are provenance, not credentials.
    const unknownToken = [...line.matchAll(longToken)].some(([, value]) => !/^(?:sha(?:1|256|384|512)-|[a-f0-9]{40,128}$)/i.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && entropy(value) > 4.3 && value !== 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789')
    if (knownToken.test(line) || secretAssignment.test(line) || unknownToken) rules.push('token-like')
    // npm artifacts preserve the older, stricter prohibition on any home path.
    if (strictHomePaths && /(?:\/users\/|\/home\/|[a-z]:\\users\\)/i.test(line)) rules.push('home-path')
    for (const rule of rules) findings.push({ file, line: index + 1, rule })
  })
  return findings
}

/** Fail a package test using the same rules as source export, including raw tar headers. */
export function assertNoPersonalBytes(bytes, label = 'npm archive', options = {}) {
  const findings = privacyFindings(bytes, label, { ...options, strictHomePaths: true })
  assert.equal(findings.length, 0, findings.map(item => `${item.file}:${item.line}: ${item.rule}`).join('\n'))
}

/** 用量页的合成数据：固定种子，约 70 天、几个会话。只用于测试和截图，不含任何真实用量。 */
import { digestSession } from '../../../lib/usage-digest.js'
import { fixture } from './events.mjs'
import { parseUsageConfig } from '../../../lib/usage-config.js'
import { buildOverview } from '../../../lib/usage-overview.js'

export const PAGE_NOW = Date.parse('2026-11-10T14:30:00+08:00')
const DAY = 86400e3

function random(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/**
 * @param {{idleDays?: number, now?: number}} [options] `idleDays`：最近这几天（含今天）没有任何记录；用来得到「今日、24 小时、7 天为零」的数据。
 * @returns {object} `buildOverview` 的结果。
 */
export function pageOverview({ idleDays = 0, now = PAGE_NOW } = {}) {
  const next = random(7)
  const main = digestSession(fixture()).rows.find(row => row.kind === 'main')
  const sessions = ['s1', 's2', 's3', 's4', 's5'].map((s, index) => ({ s, ws: ['api-server', 'docs-site', 'scratch', 'api-server', 'legacy-tool'][index], title: `任务 ${index + 1}` }))
  const rows = []
  const tools = []
  const retryLog = []
  const midnight = Date.parse('2026-11-10T00:00:00+08:00')
  for (let back = 69; back >= idleDays; back -= 1) {
    if (back % 9 === 4) continue
    const hours = 3 + Math.floor(next() * 6)
    for (let k = 0; k < hours; k += 1) {
      const hour = 8 + Math.floor(next() * (back === 0 ? 6 : 14))
      const t = midnight - back * DAY + hour * 3600e3 + Math.floor(next() * 3000e3)
      if (t > now) continue
      // s5（工作区 legacy-tool）和 gemini 模型只出现在 25 天以前，用来让短范围和「全部」的模型、工作区不同。
      const session = back >= 25 && next() < 0.4 ? sessions[4] : sessions[Math.floor(next() * 4)]
      const input = Math.floor(2000 + next() * 30000)
      const rd = Math.floor(input * (2 + next() * 12))
      const out = Math.floor(300 + next() * 4000)
      const turn = 1 + Math.floor((69 - back) / 3)
      rows.push({ ...main, t, s: session.s, m: back >= 25 && next() < 0.4 ? 'gemini-3-flash' : next() < 0.3 ? 'deepseek-v4-pro' : 'deepseek-v4-flash', kind: 'main', turn, input, rd, wr: 0, out, prompt: input + rd, hit: rd / (input + rd), ttft: 800 + Math.floor(next() * 2000), dec: 4000, retries: 0 })
      if (next() < 0.5) tools.push({ s: session.s, t: t + 20e3, name: ['bash', 'read_file', 'edit'][Math.floor(next() * 3)], ms: 400 + Math.floor(next() * 3000), err: next() < 0.05, tok: Math.floor(next() * 3000) })
      if (next() < 0.03) retryLog.push({ t: t + 5e3, s: session.s, p: 'opencode-go', code: 'RATE_LIMIT', why: 'overloaded', status: 429 })
      if (next() < 0.04) rows.push({ ...main, t: t + 30e3, s: session.s, kind: 'compaction', turn: null, input: 4000, rd: 0, wr: 0, out: 800, prompt: 4000 })
    }
  }
  const digests = sessions.map(session => ({
    session: { ...session, preset: null, created: 0, req: 0, turns: 0, lastPrompt: 0, snap: 0 },
    rows: rows.filter(row => row.s === session.s), tools: tools.filter(tool => tool.s === session.s), retryLog: retryLog.filter(entry => entry.s === session.s), turnEnds: [], deleted: false,
  }))
  return buildOverview(digests, parseUsageConfig({ timeZone: 'Asia/Shanghai' }), { now })
}

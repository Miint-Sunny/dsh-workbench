/** 用量摘要目录里的摘要文件：一个会话一份，请求行只填缓存寿命要的字段，其余填能过 usage-store.js 校验的值。 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DIGEST_VERSION } from '../../../lib/usage-digest.js'

const MIN = 60_000

/**
 * 写一个会话的摘要文件。
 * @param {string} dir 用量摘要目录。
 * @param {{id: string, preset: string|null, provider?: string, table: number[][]}} session 会话 id、会话头记的预设、路由，和 `[隔几分钟, 命中几次, 一共几次]` 的表。
 * @returns {Promise<void>}
 */
export async function writeDigest(dir, { id, preset, provider = 'opencode-go', table }) {
  const rows = []
  for (const [minutes, hit, total] of table) {
    for (let i = 0; i < total; i++) {
      rows.push({ t: rows.length, s: id, preset, m: 'm', p: provider, kind: 'main', prompt: 5000, input: 0, rd: 0, wr: 0, out: 0, reas: 0, retries: 0, attempts: 0, ttft: null, dur: null, dec: null, turn: null, gap: minutes * MIN, hit: i < hit ? 0.98 : 0, reason: null })
    }
  }
  const session = { s: id, ws: 'w', preset, title: null, created: 0, req: rows.length, turns: 0, lastPrompt: 0, snap: 0 }
  const entry = { version: DIGEST_VERSION, key: id, digest: { deleted: false, session, rows, tools: [], retryLog: [], turnEnds: [] } }
  await writeFile(join(dir, `${createHash('sha256').update(id).digest('hex')}.json`), JSON.stringify(entry))
}

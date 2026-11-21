/** 将 sessionQuery 的完整观察折叠成不含对话内容和费用的摘要。 */
import { basename } from 'node:path'

/** 持久摘要格式；字段或计算口径变化时递增。 */
export const DIGEST_VERSION = 1
const parts = () => ({ sys: 0, tools: 0, inject: 0, msg: 0, reas: 0, res: 0, comp: 0 })
function tokensOf(text) {
  let n = 0
  for (const c of text) n += /\p{Script=Han}/u.test(c) ? .6 : .3
  return n
}
function firstToken(stream) {
  for (const r of stream ?? []) {
    if (r.type === 'chunk') {
      const c = r.chunk
      if ((c.type === 'text-delta' || c.type === 'reasoning-delta') && c.text !== '' || c.type === 'tool-call-delta' && (c.argumentsDelta !== '' || c.name !== undefined)) return r.time
    } else if (r.time0 !== undefined) return r.time0
  }
}

/**
 * 折叠一次不可变的会话观察；继承段只恢复上下文，不产生统计记录。
 * @param {{session: object, inheritedEventCount: number, events: object[]}} source 官方 readSession 返回值。
 * @returns {object} 仅数字、标识、分类代码与允许的名称；价格留到查询时计算。
 */
export function digestSession({ session: header, inheritedEventCount, events }) {
  const rows = [], tools = [], retryLog = [], turnEnds = []
  const items = new Map(), calls = new Map(), starts = new Map(), retries = new Map(), attempts = new Map()
  let title = null, model = null, provider = null, toolsTok = 0, prevMsgT = null, sinceHeader = null, sinceSystem = false
  let lastPrompt = 0, snap = 0, nTurns = 0, nReq = 0
  for (let index = 0; index < events.length; index++) {
    const e = events[index], d = e.data ?? {}, inherited = index < inheritedEventCount
    if (e.type === 'session/end-seed') continue
    if (e.type === 'session/title') title = d.title ?? title
    if (e.surfaceOp && typeof e.surfaceOp === 'object') {
      for (const seq of items.keys()) if (seq >= e.surfaceOp.startSeq && seq <= e.surfaceOp.endSeq) items.delete(seq)
    }
    if (e.type === 'system/message') { items.set(e.seq, [{ cat: 'sys', n: tokensOf(JSON.stringify(d.message?.content ?? '')) }]); sinceSystem = true }
    if (e.type === 'developer/message') items.set(e.seq, [{ cat: 'tools', n: tokensOf(JSON.stringify(d.message?.content ?? '')) }])
    if (e.type === 'request/header') {
      if (d.header?.tools) toolsTok = tokensOf(JSON.stringify(d.header.tools))
      sinceHeader = d.reason ?? sinceHeader
    }
    if (e.type === 'request/context') { model = d.model ?? model; provider = d.provider ?? provider }
    if (e.type === 'user/message') {
      const kind = d.source?.kind ?? 'user'
      items.set(e.seq, [{ cat: kind === 'user' ? 'msg' : kind === 'compact-checkpoint' ? 'comp' : 'inject', n: tokensOf(JSON.stringify(d.content ?? '')) }])
    }
    if (e.type === 'tool/call') calls.set(d.callId, { name: d.name, t: e.time })
    if (e.type === 'tool/result') {
      const call = calls.get(d.message?.source?.callId ?? d.message?.toolCallId)
      const n = tokensOf(JSON.stringify(d.message?.content ?? ''))
      items.set(e.seq, [{ cat: 'res', n }])
      if (!inherited && call) tools.push({ s: header.id, t: e.time, name: call.name, ms: e.time - call.t, err: !!d.message?.isError, tok: Math.round(n) })
    }
    let comp
    if (e.type === 'assistant/message') {
      comp = parts(); comp.tools = toolsTok
      for (const arr of items.values()) for (const x of arr) comp[x.cat] += x.n
      snap = Object.values(comp).reduce((a, x) => a + x, 0)
      items.set(e.seq, (d.message?.content ?? []).map(b => ({ cat: b.type === 'reasoning' ? 'reas' : 'msg', n: tokensOf(b.type === 'text' || b.type === 'reasoning' ? b.text ?? '' : JSON.stringify(b)) })))
    }
    if (inherited) continue
    const step = `${d.turn}/${d.step}`
    if (e.type === 'llm/retry') {
      const message = d.failure?.message ?? ''
      retryLog.push({ t: e.time, s: header.id, p: d.provider ?? null, code: d.failure?.code ?? null, why: /\[([\w.-]+)\]/.exec(message)?.[1] ?? (/Endpoint is unavailable/.test(message) ? 'endpoint_unavailable' : null), status: /^(\d{3}):/.test(message) ? Number(message.slice(0, 3)) : null })
      retries.set(step, (retries.get(step) ?? 0) + 1)
    }
    let usage = d.usage
    if (e.type === 'assistant/attempt') {
      attempts.set(step, (attempts.get(step) ?? 0) + 1)
      for (const r of d.stream ?? []) if (r.type === 'chunk' && r.chunk?.type === 'usage') usage = r.chunk.usage ?? r.chunk
    }
    if (e.type === 'turn/start') nTurns++
    if (e.type === 'turn/end') {
      const state = d.status ?? d.reason ?? d.outcome ?? {}
      turnEnds.push({ t: e.time, s: header.id, kind: state.kind ?? null, code: state.error?.code ?? null, p: provider })
    }
    if (e.type === 'step/start') starts.set(step, e.time)
    if (!['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(e.type) || !usage) continue
    const kind = e.type === 'assistant/message' ? 'main' : e.type === 'assistant/attempt' ? 'attempt' : 'compaction'
    const m = kind === 'compaction' ? d.model : d.message?.source?.model ?? model
    const p = kind === 'compaction' ? d.provider : d.message?.source?.provider ?? provider
    const input = usage.inputTokens ?? 0, rd = usage.cacheReadTokens ?? 0, wr = usage.cacheWriteTokens ?? 0, out = usage.outputTokens ?? 0
    const prompt = input + rd + wr, start = starts.get(step), ft = firstToken(d.stream)
    rows.push({ t: e.time, s: header.id, preset: header.agentPreset ?? null, m: m ?? null, p: p ?? null, input, rd, wr, out, reas: usage.reasoningTokens ?? 0, prompt, ttft: start !== undefined && ft !== undefined ? ft - start : null, dur: start !== undefined ? e.time - start : null, dec: ft !== undefined ? e.time - ft : null, kind, turn: d.turn ?? null, gap: prevMsgT === null || start === undefined ? null : start - prevMsgT, reason: prevMsgT === null ? 'first' : sinceHeader === 'resume' ? 'resume' : sinceSystem ? 'system' : sinceHeader ? 'header' : null, hit: prompt ? rd / prompt : null, retries: retries.get(step) ?? 0, attempts: attempts.get(step) ?? 0, ...(comp ? { comp } : {}) })
    if (kind === 'main') { prevMsgT = e.time; sinceHeader = null; sinceSystem = false; lastPrompt = prompt; nReq++ }
  }
  return { session: { s: header.id, ws: basename(header.cwd ?? ''), preset: header.agentPreset ?? null, title, created: header.createdAt, req: nReq, turns: nTurns, lastPrompt, snap }, rows, tools, retryLog, turnEnds }
}

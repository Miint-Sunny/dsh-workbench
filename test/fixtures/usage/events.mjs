/** 手写日志：只含测试文字。分叉的分叉复制两段，末尾还有恢复时补的 end-seed。 */
export function fixture() {
  let seq = 0
  const events = []
  const add = (type, data = {}, extra = {}) => {
    const e = { type, data, seq: seq++, time: Date.parse('2026-11-06T01:00:00Z') + seq * 1000, ...extra }
    events.push(e); return e
  }
  const usage = { inputTokens: 10, cacheReadTokens: 90, outputTokens: 20 }
  add('system/message', { message: { content: 'S' } })
  add('request/header', { header: { tools: [{ name: 'look' }] }, reason: 'initial' })
  add('request/context', { model: 'deepseek-v4-flash', provider: 'opencode-go', contextWindow: 1000000 })
  add('assistant/message', { turn: 1, step: 1, message: { content: [{ type:'text', text:'inherited' }] }, usage })
  add('session/end-seed', { inherited: true })
  add('assistant/message', { turn: 2, step: 1, message: { content: [] }, usage })
  add('session/end-seed', { inherited: true })
  const inheritedEventCount = events.length - 1
  add('session/title', { title: '测试 (2)' })
  add('turn/start', { turn: 3 })
  add('step/start', { turn: 3, step: 1 })
  add('llm/retry', { turn: 3, step: 1, provider: 'opencode-go', failure: { code:'RATE_LIMIT', message:'429: [overloaded] synthetic' } })
  add('assistant/attempt', { turn:3, step:1, stream:[{ type:'chunk', time:100, chunk:{type:'usage', usage:{inputTokens:0, outputTokens:0}} }] })
  add('assistant/message', { turn:3, step:1, message:{content:[{type:'text',text:'answer'}]}, usage })
  add('session/end-seed', {})
  add('tool/call', { turn:3, callId:'call1', name:'look' })
  add('tool/result', { turn:3, message:{source:{callId:'call1'}, content:'result'} })
  add('compaction/summary', { turn:3, model:'deepseek-v4-flash', provider:'opencode-go', usage:{inputTokens:20, outputTokens:5}, content:'not retained' }, {surfaceOp:{op:'replace', startSeq:0,endSeq:15}})
  add('turn/end', { turn:3, status:{kind:'error',error:{code:'UPSTREAM'}} })
  add('request/context', { model:'unknown-model', provider:'unknown-provider' })
  add('turn/start', {turn:4})
  add('step/start', {turn:4,step:1})
  add('assistant/message', {turn:4,step:1,message:{content:[]},usage:{inputTokens:7,outputTokens:2}})
  add('assistant/message', {turn:4,step:2,message:{content:[{type:'text',text:'no usage'}]}})
  add('turn/end', {turn:4,status:{kind:'aborted'}})
  return { session:{id:'child',createdAt:events[0].time,cwd:'/example/workspace',agentPreset:'whale',isSeeded:true}, events, inheritedEventCount }
}

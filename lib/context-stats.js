/** 固定观察的数值投影；正文只参与官方估算，不进入结果或缓存。 */
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { quantile, robustZ, mad, shiftDay } from './usage-stats.js'
import { calendar } from './usage-config.js'
const contextParts = () => ({ sys: 0, builtin: 0, mcp: 0, mem: 0, skill: 0, rt: 0, other: 0, sub: 0, msg: 0, reas: 0, res: 0, comp: 0 })
/** 压缩能清掉的部分。工具定义、系统提示词、记忆文件、技能和运行时上下文压完还在。 */
const REDUCIBLE = ['res', 'reas', 'msg', 'comp', 'sub', 'other']
const INJECTED = { 'agent-instructions': 'mem', 'skill-catalog': 'skill', 'skill-invocation': 'skill', 'runtime-context': 'rt', 'time-context': 'rt', 'subagent-report': 'sub', 'subagent-settled': 'sub', 'agent-message': 'sub' }
const isMcp = name => name.startsWith('mcp__')
const sumParts = parts => Object.values(parts).reduce((a,b)=>a+b,0)
const schemaTokens = tools => tools.length ? Math.ceil(JSON.stringify(tools).length / 4) + 4 : 0
function messageOf(event) {
  if (event.type === 'user/message') return event.data
  if (['system/message','developer/message','assistant/message','tool/result'].includes(event.type)) return event.data.message
}
function categoryOf(event, block) {
  if (event.type === 'system/message') return 'sys'
  if (event.type === 'developer/message') return 'builtin'
  if (event.type === 'tool/result') return 'res'
  if (event.type === 'assistant/message') return block.type === 'reasoning' ? 'reas' : 'msg'
  const kind = event.data.source?.kind
  if (kind === 'compact-checkpoint') return 'comp'
  if (['user','user-rpc','user-cli','user-input'].includes(kind)) return 'msg'
  return INJECTED[kind] ?? 'other'
}
function priceEvent(event, estimateMessage) {
  const message = messageOf(event)
  if (!message) return null
  const content = typeof message.content === 'string' ? [{type:'text',text:message.content}] : message.content
  if (!Array.isArray(content)) throw new Error('context: invalid message content')
  const known = content.filter(b=>['text','reasoning','tool-call'].includes(b.type)), unknown = content.length-known.length, parts=contextParts()
  const role = message.role ?? (event.type==='assistant/message'?'assistant':event.type==='system/message'?'system':'user')
  const total = estimateMessage({...message,role,content:known})
  if (known.length === 0) parts[categoryOf(event,{})] = total
  else if (new Set(known.map(b=>categoryOf(event,b))).size===1) parts[categoryOf(event,known[0])]=total
  else {
    const overhead=estimateMessage({...message,role,content:[]})
    for(const block of known)parts[categoryOf(event,block)]+=Math.max(0,estimateMessage({...message,role,content:[block]})-overhead)
    parts[categoryOf(event,known[0])]+=total-sumParts(parts)
  }
  const source = event.type === 'user/message' ? event.data.source : undefined
  return {seq:event.seq,parts,unknown,turn:event.data.turn??null,time:event.time,files:source?.kind==='agent-instructions'?(source.changes??[]).filter(c=>c.action!=='remove').map(c=>c.path):null,catalog:source?.kind==='skill-catalog'?(source.entries??[]).map(e=>e.name):null,skill:source?.kind==='skill-invocation'?source.name??null:null}
}
const scaleParts = (parts, ratio) => Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,Math.round(v*ratio)]))
/** 页面上的分项：对得上时缩放到实际值，对不上时不缩放，多一个估算差额；压缩之后还没发请求时用当前的构成。 */
function displayOf({lastRequest,parts,raw,compactedSince}) {
  let view
  if (lastRequest===null) view={parts,since:0,gap:null}
  else if (compactedSince) view={parts:lastRequest.calibration==='aligned'?scaleParts(parts,lastRequest.ratio):parts,since:0,gap:null}
  else if (lastRequest.calibration==='aligned') view={parts:lastRequest.scaledParts,since:Math.max(0,Math.round((raw-lastRequest.raw)*lastRequest.ratio)),gap:null}
  else view={parts:lastRequest.parts,since:Math.max(0,raw-lastRequest.raw),gap:lastRequest.actual-lastRequest.raw}
  return {...view,ratio:lastRequest?.calibration==='aligned'?lastRequest.ratio:1,reducible:REDUCIBLE.reduce((n,k)=>n+view.parts[k],0)+view.since}
}
/** 未调用的工具按页面上的行分开，和这一行同一个比例；各工具分开估算，和可能略多，不超过这一行。 */
function unusedByRow(unused,{parts,ratio}) {
  const row=(key,list)=>({n:list.length,tokens:Math.min(parts[key],Math.round(list.reduce((n,t)=>n+t.tokens,0)*ratio))})
  return {mcp:row('mcp',unused.filter(t=>isMcp(t.name))),builtin:row('builtin',unused.filter(t=>!isMcp(t.name)))}
}
/** 工具定义按服务器汇总，技能和记忆文件只留名字。 */
function groupsOf(tools,nodes,limit) {
  const servers=new Map()
  for(const tool of tools.filter(t=>isMcp(t.name))){
    const server=tool.name.split('__')[1]
    if(!servers.has(server))servers.set(server,{server,tools:0,tokens:0,unused:0,unusedTokens:0,rows:[]})
    const group=servers.get(server)
    group.tools++;group.tokens+=tool.tokens;group.rows.push(tool)
    if(tool.calls===0){group.unused++;group.unusedTokens+=tool.tokens}
  }
  const mcp=[...servers.values()].sort((a,b)=>b.tokens-a.tokens).map(g=>({...g,rows:g.rows.slice(0,limit)}))
  const catalog=new Set(),loaded=new Set(),memory=new Set()
  for(const node of nodes.values()){
    for(const name of node.catalog??[])catalog.add(name)
    if(node.skill)loaded.add(node.skill)
    for(const path of node.files??[])memory.add(path)
  }
  return{mcp,builtin:tools.filter(t=>!isMcp(t.name)).slice(0,limit),skills:{catalog:catalog.size,loaded:[...loaded]},memory:[...memory]}
}
/** 用计价函数算这个模型每百万 token 的价。没有价格表时是 null。 */
function pricesOf(price,model,now) {
  if(!price||!model)return null
  const [row]=price([{t:now,m:model,input:1e6,rd:1e6,wr:0,out:1e6}])
  return row&&row.c>0?{miss:row.costIn,hit:row.costRd,out:row.costOut}:null
}

/**
 * 汇总已验证的观察；当前分布与最后一次请求的实际输入分开，避免错配校准。
 * @param {object} observation 官方 lease 的只读 header/events/cursor/inheritedEventCount。
 * @param {object} options 已校验 config、官方 estimateMessage、可选 measure、price（usage-config 的计价）和取消 signal。
 * @returns {Promise<object>} 只有数字、标识和工具/模型名的快照。
 */
export async function summarizeContext(observation,{config,estimateMessage,measure,price,signal=new AbortController().signal}) {
  const nodes=new Map(),calls=new Map(),used=new Map(),history=[],totals=contextParts()
  let definitions=[],toolParts={builtin:0,mcp:0},unknown=0,lastRequest=null,lastSurfaceSeq=null,model=null,provider=null,window=null,maxOutput=null,compactions=0,previousInput=null,awaitingCompaction=false,lastReduction=null,compacting=null
  const records=[]
  const addNode=(node,sign)=>{for(const key of Object.keys(totals))totals[key]+=sign*node.parts[key];unknown+=sign*node.unknown}
  const currentParts=()=>({...totals,builtin:totals.builtin+toolParts.builtin,mcp:totals.mcp+toolParts.mcp})
  const events=observation.events
  for(let i=0;i<events.length;i++){
    signal.throwIfAborted();if(i>0&&i%config.chunkEvents===0)await yieldLoop(undefined,{signal})
    const event=events[i],d=event.data??{}
    if(event.type==='request/header'){
      const header=d.header??{},nextModel=header.config?.model??model,nextProvider=header.config?.provider??provider
      if(nextModel!==model||nextProvider!==provider)window=null
      model=nextModel;provider=nextProvider;maxOutput=header.config?.maxTokens??null
      definitions=(header.tools??[]).map(tool=>({name:tool.name,tokens:Math.ceil(JSON.stringify(tool).length/4)}))
      toolParts={builtin:schemaTokens((header.tools??[]).filter(tool=>!isMcp(tool.name))),mcp:schemaTokens((header.tools??[]).filter(tool=>isMcp(tool.name)))}
    }
    if(event.type==='request/context'){model=d.model??model;provider=d.provider??provider;window=d.contextWindow??null}
    if(event.type==='tool/call') {calls.set(d.callId,d.name);used.set(d.name,(used.get(d.name)??0)+1)}
    if(i>=observation.inheritedEventCount){
      if(event.type==='compaction/start')compacting={at:event.time,kind:d.turn?'auto':d.sourceCommandId?'manual':'idle',before:lastRequest?.actual??null,after:null,shadowed:null,usage:null,model:null,provider:null,ok:false,error:null,cost:null}
      if(event.type==='compaction/summary'&&compacting){compacting.shadowed=d.shadowedTokenCount??null;compacting.model=d.model??null;compacting.provider=d.provider??null;if(d.usage)compacting.usage={input:d.usage.inputTokens??0,rd:d.usage.cacheReadTokens??0,wr:d.usage.cacheWriteTokens??0,out:d.usage.outputTokens??0}}
      if(event.type==='compaction/end'&&compacting){compacting.ok=d.error===undefined;compacting.error=d.error===undefined?null:String(d.error?.message??d.error).slice(0,160);records.push(compacting);compacting=null}
    }
    if(event.type==='user/message'&&d.source?.kind==='compact-checkpoint'&&event.surfaceOp&&typeof event.surfaceOp==='object'&&i>=observation.inheritedEventCount){compactions++;awaitingCompaction=true;previousInput=lastRequest?.actual??null}
    if(event.type==='assistant/message'&&d.usage&&['inputTokens','cacheReadTokens','cacheWriteTokens'].some(key=>Number.isFinite(d.usage[key]))&&i>=observation.inheritedEventCount){
      const actual=(d.usage.inputTokens??0)+(d.usage.cacheReadTokens??0)+(d.usage.cacheWriteTokens??0),parts=currentParts(),raw=sumParts(parts)
      const deviation=actual>0?Math.abs(raw-actual)/actual:raw===0?0:null
      const ratio=raw>0?actual/raw:actual===0?1:null
      const calibration=unknown?'unknown-media':deviation!==null&&deviation<=config.calibrationTolerance&&ratio!==null?'aligned':'divergent'
      lastRequest={seq:event.seq,time:event.time,model,provider,window,maxOutput,actual,raw,parts,ratio,deviation,calibration,scaledParts:calibration==='aligned'?Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,Math.round(v*ratio)])):null}
      history.push({seq:event.seq,time:event.time,input:actual,raw})
      if(records.length>0&&records.at(-1).after===null)records.at(-1).after=actual
      if(awaitingCompaction){lastReduction=previousInput===null?null:previousInput-actual;awaitingCompaction=false}
    }
    const node=priceEvent(event,estimateMessage)
    if(!node)continue
    if(event.surfaceOp&&typeof event.surfaceOp==='object')for(const [seq,old]of nodes)if(seq>=event.surfaceOp.startSeq&&seq<=event.surfaceOp.endSeq){addNode(old,-1);nodes.delete(seq)}
    if(event.type==='tool/result')node.tool=calls.get(d.message?.source?.callId??d.message?.toolCallId)??null
    nodes.set(event.seq,node);addNode(node,1);lastSurfaceSeq=event.seq
  }
  signal.throwIfAborted()
  const measurement=measure?.()
  if(measurement){const retained=new Set(measurement.nodes.map(n=>n.seq));for(const[seq,node]of nodes)if(!retained.has(seq)){addNode(node,-1);nodes.delete(seq)}}
  const parts=currentParts(),raw=sumParts(parts),total=unknown?null:measurement?.totalTokens??raw
  const tools=definitions.map(d=>({...d,calls:used.get(d.name)??0})).sort((a,b)=>b.tokens-a.tokens)
  const results=[...nodes.values()].filter(n=>n.parts.res>0).map(n=>({seq:n.seq,tool:n.tool,turn:n.turn,tokens:n.parts.res,unknownMedia:n.unknown})).sort((a,b)=>b.tokens-a.tokens)
  const day=calendar(config.timeZone),today=lastRequest?day(lastRequest.time).day:null,prior=new Map()
  for(const h of history){const date=day(h.time).day;if(today&&date<today&&date>=shiftDay(today,-config.baselineDays)){if(!prior.has(date))prior.set(date,[]);prior.get(date).push(h.input)}}
  const medians=[...prior.values()].map(a=>quantile(a,.5)),enough=medians.length>=config.baselineMinDays,z=enough?robustZ(lastRequest?.actual??0,medians):null
  const baseline={days:medians.length,requests:[...prior.values()].reduce((n,a)=>n+a.length,0),median:quantile(medians,.5),mad:mad(medians),z,available:enough,anomaly:enough&&(z!==null?Math.abs(z)>=config.zThreshold:mad(medians)===0&&(lastRequest?.actual??0)!==quantile(medians,.5))}
  const threshold=window&&maxOutput!==null?Math.max(0,Math.floor(Math.min(window*config.defaultThresholdRatio,window-maxOutput-config.defaultHeadroomTokens))):null
  const savingsAllowed=lastRequest?.calibration==='aligned'&&unknown===0
  const projected=observation.projections?.values?.contextPressure
  const occupied=projected?.projectedTokens??projected?.pressureTokens??total??null,capacity=projected?.contextWindow??window
  const pressure={used:occupied,window:capacity,percent:occupied===null||!capacity?null:Math.min(100,Math.round(occupied/capacity*100))}
  const display=displayOf({lastRequest,parts,raw,compactedSince:awaitingCompaction})
  const priced=records.slice(-config.historyLimit)
  if(price){const rows=price(priced.map(r=>({t:r.at,m:r.model,input:r.usage?.input??0,rd:r.usage?.rd??0,wr:r.usage?.wr??0,out:r.usage?.out??0})));priced.forEach((r,i)=>{if(r.usage)r.cost=rows[i].c})}
  const unused=tools.filter(t=>t.calls===0)
  return {sessionId:observation.header.id,preset:observation.projections?.values?.agentPreset??observation.header.agentPreset??null,origin:observation.header.origin??null,cursor:observation.cursor,model,provider,pressure,display:{...display,unused:unusedByRow(unused,display)},groups:groupsOf(tools,nodes,config.toolLimit),records:priced,prices:pricesOf(price,model,Date.now()),current:{seq:lastSurfaceSeq,raw,officialTokens:total,parts,unknownMedia:unknown,afterLastRequest:lastRequest!==null&&lastSurfaceSeq>=lastRequest.seq},lastRequest,window,maxOutput,threshold:{source:'default',tokens:threshold,remaining:threshold===null||total===null?null:threshold-total},baseline,compactions:{count:compactions,lastReduction},history:history.slice(-config.historyLimit),historyTotal:history.length,tools:{total:tools.length,unused:unused.length,unusedTokens:unused.reduce((n,t)=>n+t.tokens,0),rows:tools.slice(0,config.toolLimit),unusedRows:unused.slice(0,config.toolLimit)},results:{total:results.length,rows:results.slice(0,config.resultLimit)},findings:{resultsPriority:raw>0&&totals.res/raw>=config.resultShare,toolsPriority:raw>0&&unused.reduce((n,t)=>n+t.tokens,0)/raw>=config.unusedToolShare,resultsSaving:savingsAllowed?results.slice(0,3).reduce((n,r)=>n+r.tokens,0):null,toolsSaving:savingsAllowed?Math.min(toolParts.builtin+toolParts.mcp,unused.reduce((n,t)=>n+t.tokens,0)):null},estimator:'token-meter',countsIncludeInherited:true}
}

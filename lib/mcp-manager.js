/** 每个 Agent 独立持有限制；运行事件只更新计数和掩码，不扫描历史。 */
import{policyProject,whalePreset}from'./policy-scope.js'
import{McpCounters,isMcpName,groupMcpTool,mcpDenyNames,MCP_SHARED,mcpFail}from'./mcp-state.js'
export function createMcpManager({ctx,config,store,readServers}){
 let state={version:1,revision:0,rules:[]},stateError=null,servers=[],closed=false
 const agents=new Map(),entryHistory=new Map(),retired=new Set(),jobs=new Set(),counters=new McpCounters(config),abort=new AbortController()
 const install=next=>{if(next.revision>=state.revision)state=next}
 const track=promise=>{jobs.add(promise);promise.finally(()=>jobs.delete(promise)).catch(()=>{});return promise}
 const excluded=agent=>{const preset=ctx.agentPresets.presetForSession(agent.session);return whalePreset(preset)||config.skipPresets.includes(preset)}
 function inventory(){
  const current=readServers();const retireKeys=[]
  for(const item of current){const old=entryHistory.get(item.server.entryId);if(old&&(old.entry.deref()!==item.entry||old.key!==item.server.key)&&!retired.has(old.key)){retired.add(old.key);retireKeys.push(old.key)}entryHistory.set(item.server.entryId,{entry:new WeakRef(item.entry),key:item.server.key})}
  const ids=new Set(current.map(item=>item.server.entryId));for(const[id,old]of entryHistory)if(!ids.has(id)&&!state.rules.some(r=>r.serverKey===old.key))entryHistory.delete(id)
  servers=current.map(item=>item.server)
  if(retireKeys.length&&!closed)track(store.retire(retireKeys).then(next=>{install(next);applyAll()},()=>{stateError='save-failed';applyAll()}))
  return servers
 }
 function applyOne(record){
  if(closed)return;const agent=record.agent,view=ctx.tools.view(agent)
  const known=new Set([...view.restrictableNames].filter(isMcpName)),deny=excluded(agent)?[]:stateError==='invalid-state'||record.error||record.pending&&record.pending.cwd!==record.cwd?[...known].sort():mcpDenyNames(state.rules,{projectKey:record.project?.key,sessionId:agent.id,servers,known,retired})
  const signature=JSON.stringify(deny);if(record.signature===signature)return
  const previous=record.dispose,old=record.signature;record.signature=signature
  try{record.dispose=deny.length?agent.ctx.tools.restrict({deny}):undefined}catch(error){record.signature=old;throw error}
  previous?.()
 }
 function applyAll(){for(const record of agents.values())applyOne(record)}
 async function project(record,force=false){
  const cwd=ctx.workingDirectory.get(record.agent.session)
  if(record.pending?.cwd===cwd)return record.pending.promise
  if(!force&&record.cwd===cwd&&record.project&&!record.error)return
  const generation=Symbol();record.pending={cwd,generation,promise:null}
  const promise=(async()=>{
   try{const resolved=await policyProject(cwd,record.agent.session.header.cwd,config.gitTimeoutMs,abort.signal);if(!closed&&record.pending?.generation===generation){record.cwd=cwd;record.project=resolved;record.error=null}}
   catch{if(!closed&&record.pending?.generation===generation){record.cwd=cwd;record.error='scope-unavailable'}}
   finally{if(record.pending?.generation===generation)record.pending=null}
  })()
  if(record.pending?.generation===generation)record.pending.promise=promise
  return promise
 }
 async function attach(agent){
  if(closed||agents.has(agent.id))return
  const record={agent,signature:null,dispose:null,project:null,cwd:null,error:null};agents.set(agent.id,record)
  agent.ctx.effect(()=>()=>{record.dispose?.();agents.delete(agent.id)},'MCP visibility scope')
  agent.ctx.on('agent/pre-step',async(_request,next)=>{await project(record);applyOne(record);return next()},{prepend:true})
  await project(record);inventory();applyOne(record)
 }
 async function load(){try{install(await store.read());if(state.rules.some(r=>retired.has(r.serverKey)&&!r.retired))install(await store.retire([...retired]));stateError=null}catch{stateError='invalid-state'}inventory();applyAll()}
 function onTools(){if(closed)return;inventory();applyAll()}
 return{
  counters,agents,
  async start(){await load();for(const agent of ctx.agents.list())await attach(agent)},
  attach:agent=>track(attach(agent)),onTools,
  onEvent(session,event){if(closed)return;const preset=ctx.agentPresets.presetForSession(session)
   if(event.type==='agent-preset/selected'||event.type.startsWith('working-directory/')){const record=agents.get(session.id);if(record){const pending=project(record,true);applyOne(record);track(pending.then(()=>applyOne(record)))};return}
   if(whalePreset(preset)||config.skipPresets.includes(preset))return
   if(event.type==='tool/call'&&isMcpName(event.data.name))counters.call(session.id,event.data,event.time,groupMcpTool(event.data.name,servers)??(MCP_SHARED.includes(event.data.name)?'resources':'unverified'))
   if(event.type==='tool/result')counters.result(session.id,event.data,event.time)
  },
  async read(sessionId){
   await load()
   const missing=state.rules.filter(r=>!r.retired&&!['resources','unverified'].includes(r.serverKey)&&!servers.some(s=>s.key===r.serverKey)).map(r=>r.serverKey)
   if(missing.length){for(const key of missing)retired.add(key);try{install(await store.retire(missing))}catch{stateError='save-failed'}applyAll()}
   let record=sessionId?agents.get(sessionId):[...agents.values()].find(r=>!excluded(r.agent))??agents.values().next().value
   if(sessionId&&!record){const agent=ctx.agents.get(sessionId);if(agent){await attach(agent);record=agents.get(sessionId)}}
   if(record){await project(record,true);applyOne(record)}
   const inventoryState=await ctx.pluginInventory.list(),phase=new Map(inventoryState.entries.map(r=>[String(r.entryId),r]))
   const known=record?ctx.tools.view(record.agent):null,names=known?[...known.knownNames].filter(isMcpName):[]
   const toolRows=names.map(name=>({name,serverKey:groupMcpTool(name,servers)??(MCP_SHARED.includes(name)?'resources':'unverified'),visible:known.visible.has(name),restrictable:known.restrictableNames.has(name)}))
   return{revision:state.revision,error:stateError,scopeError:sessionId&&!record?'session-unavailable':record?.error??null,sessionId:record?.agent.id??null,project:record?.project??null,excluded:record?excluded(record.agent):false,sessions:[...agents.values()].map(r=>({id:r.agent.id,cwd:r.cwd,excluded:excluded(r.agent)})),servers:servers.map(s=>({...s,enabled:phase.get(s.entryId)?.enabled??s.enabled,phase:phase.get(s.entryId)?.fiberPhase??'unloaded'})),tools:toolRows,statistics:counters.snapshot(),rules:state.rules.filter(r=>record&&(r.scope==='session'?r.scopeKey===record.agent.id:r.scopeKey===record.project?.key)).map(r=>({...r,stale:r.retired||retired.has(r.serverKey)||!['resources','unverified'].includes(r.serverKey)&&!servers.some(s=>s.key===r.serverKey)}))}
  },
  async change(body){
   if(closed)mcpFail('disabled');await load();if(stateError)mcpFail(stateError)
   const record=agents.get(body.sessionId);if(!record)mcpFail('session-unavailable')
   await project(record,true);if(record.error)mcpFail(record.error);if(excluded(record.agent))mcpFail('excluded')
   if(!['project','session'].includes(body.scope)||!Number.isSafeInteger(body.revision)||typeof body.hidden!=='boolean'||!body.target||typeof body.target!=='object'||Array.isArray(body.target))mcpFail('invalid-input')
   const scopeKey=body.scope==='project'?record.project.key:record.agent.id,target=body.target,view=ctx.tools.view(record.agent)
   if(target.kind==='remove'){if(Object.keys(target).some(k=>!['kind','id'].includes(k))||!state.rules.some(r=>r.id===target.id&&r.scope===body.scope&&r.scopeKey===scopeKey))mcpFail('invalid-input');install(await store.remove(body.revision,target.id))}
   else{
    let serverKey,name,server
    if(target.kind==='server'){if(Object.keys(target).some(k=>!['kind','key'].includes(k)))mcpFail('invalid-input');server=servers.find(s=>s.key===target.key);if(!server||!server.bulk||!server.serverName||server.serverName.includes('__'))mcpFail('unverified');serverKey=server.key}
    else if(target.kind==='tool'){if(Object.keys(target).some(k=>!['kind','name'].includes(k)))mcpFail('invalid-input');name=target.name;if(!isMcpName(name)||!view.knownNames.has(name)||!view.restrictableNames.has(name))mcpFail('tool-unavailable');serverKey=groupMcpTool(name,servers)??(MCP_SHARED.includes(name)?'resources':'unverified');server=servers.find(s=>s.key===serverKey)}
    else mcpFail('invalid-input')
    const previous=state.rules.find(r=>r.scope===body.scope&&r.scopeKey===scopeKey&&r.serverKey===serverKey),rule={scope:body.scope,scopeKey,serverKey,entryId:server?.entryId??null,serverName:server?.serverName??null,all:previous?.all??false,hidden:[...previous?.hidden??[]],shown:[...previous?.shown??[]]}
    if(target.kind==='server'){rule.all=body.hidden;rule.hidden=[];rule.shown=[]}
    else if(body.hidden){rule.shown=rule.shown.filter(n=>n!==name);if(!rule.all&&!rule.hidden.includes(name))rule.hidden.push(name)}
    else{rule.hidden=rule.hidden.filter(n=>n!==name);if(rule.all&&!rule.shown.includes(name))rule.shown.push(name)}
    install(await store.change(body.revision,rule));retired.delete(serverKey)
   }
   applyAll();return this.read(body.sessionId)
  },
  async dispose(){closed=true;abort.abort();await Promise.allSettled([...jobs]);for(const r of agents.values())r.dispose?.();agents.clear();await store.dispose()},
 }
}

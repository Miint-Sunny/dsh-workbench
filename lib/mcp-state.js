/** MCP 名称归组、精确可见性掩码和不含原文的启动区间计数。 */
import{policyHash}from'./policy-scope.js'
export const MCP_SHARED=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']
export const isMcpName=name=>typeof name==='string'&&(/^mcp__[A-Za-z0-9_-]{1,59}$/.test(name)&&name.length<=64||MCP_SHARED.includes(name))
export function mcpFail(code){const error=new Error(code);error.code=code;throw error}
export function parseMcpConfig(input={}){
 const defaults={maxRules:256,maxTools:1024,maxPending:1024,maxStateBytes:1048576,gitTimeoutMs:3000,skipPresets:[]}
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))mcpFail('invalid-config')
 const out={...defaults,...input};for(const k of ['maxRules','maxTools','maxPending','maxStateBytes','gitTimeoutMs'])if(!Number.isSafeInteger(out[k])||out[k]<1||out[k]>defaults[k]*16)mcpFail('invalid-config')
 if(!Array.isArray(out.skipPresets)||out.skipPresets.length>128||out.skipPresets.some(s=>typeof s!=='string'||s.length>128))mcpFail('invalid-config');return out
}
const literal=(object,key)=>{const field=object&&Object.getOwnPropertyDescriptor(object,key);return field&&'value'in field?field.value:undefined}
/** 只取公开配置字段，不访问 headers、env、args 或 diagnostic。 */
export function mcpServer(entry,raw){
 const serverName=literal(raw,'serverName'),transport=literal(raw,'transport')
 let target=null,identity=null
 if(transport==='streamable-http'){const value=literal(raw,'url');if(typeof value==='string')try{const url=new URL(value);if(['http:','https:'].includes(url.protocol)){target=url.origin;identity=url.origin+url.pathname}}catch{}}
 if(transport==='stdio'){const value=literal(raw,'command');if(typeof value==='string'){const base=value.split(/[\\/]/).at(-1);target=/^[\w.@+-]{1,80}$/.test(base)?base:null;identity=value}}
 const name=typeof serverName==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(serverName)?serverName:null
 const key=policyHash(JSON.stringify([entry.entryId,entry.moduleName,name,transport,identity]))
 return{key,entryId:entry.entryId,serverName:name,transport:['stdio','streamable-http'].includes(transport)?transport:null,target,enabled:entry.enabled,bulk:!!name&&identity!==null,phase:entry.fiberPhase??'unloaded'}
}
/** 名称不证明来源。哈希名称和双下划线歧义一律保持未核实。 */
export function groupMcpTool(name,servers){
 if(!/^mcp__[A-Za-z0-9_-]+$/.test(name)||name.length>64||/_[a-f0-9]{12}$/.test(name))return null
 const candidates=servers.filter(s=>s.serverName&&name.startsWith('mcp__'+s.serverName+'__')&&/^[A-Za-z0-9_-]+$/.test(name.slice(s.serverName.length+7)))
 if(candidates.length!==1)return null
 const server=candidates[0],raw=name.slice(server.serverName.length+7)
 return server.bulk!==false&&!server.serverName.includes('__')&&!raw.includes('__')?server.key:null
}
export function mcpDenyNames(rules,{projectKey,sessionId,servers,known,retired=new Set()}){
 const applicable=rules.filter(r=>!r.retired&&!retired.has(r.serverKey)&&(r.scope==='project'?r.scopeKey===projectKey:r.scopeKey===sessionId)),denied=new Set()
 for(const name of known){if(!isMcpName(name))continue;const serverKey=groupMcpTool(name,servers)??(MCP_SHARED.includes(name)?'resources':'unverified')
  if(applicable.some(r=>r.serverKey===serverKey&&(r.hidden.includes(name)||r.all&&!r.shown.includes(name))))denied.add(name)
 }return [...denied].sort()
}
export class McpCounters{
 constructor(config,startedAt=Date.now()){this.config=config;this.startedAt=startedAt;this.rows=new Map();this.pending=new Map();this.droppedCalls=0;this.droppedPending=0}
 call(sessionId,data,time,serverKey='unverified'){
  if(!isMcpName(data.name))return
  const id=serverKey+'\0'+data.name
  if(!this.rows.has(id)){if(this.rows.size>=this.config.maxTools){this.droppedCalls++;return}this.rows.set(id,{serverKey,name:data.name,calls:0,completed:0,failures:0,incomplete:0,inFlight:0,durationMs:0,maxMs:0,lastAt:null,lastFailureAt:null,lastSessionId:null})}
  const row=this.rows.get(id),key=sessionId+'\0'+data.callId
  if(this.pending.has(key))return
  if(this.pending.size>=this.config.maxPending){const first=this.pending.keys().next().value;const old=this.pending.get(first);this.rows.get(old.id).inFlight--;this.rows.get(old.id).incomplete++;this.pending.delete(first);this.droppedPending++}
  row.calls++;row.inFlight++;row.lastAt=time;row.lastSessionId=sessionId;this.pending.set(key,{id,time,sessionId})
 }
 result(sessionId,data,time){
  const key=sessionId+'\0'+(data.message?.source?.callId??data.message?.toolCallId),pending=this.pending.get(key);if(!pending)return
  this.pending.delete(key);const row=this.rows.get(pending.id),ms=Math.max(0,time-pending.time);row.inFlight--;row.completed++;row.durationMs+=ms;row.maxMs=Math.max(row.maxMs,ms);row.lastAt=time
  if(data.message?.isError){row.failures++;row.lastFailureAt=time}
 }
 endSession(sessionId){for(const[key,value]of this.pending)if(value.sessionId===sessionId){const row=this.rows.get(value.id);row.inFlight--;row.incomplete++;this.pending.delete(key)}}
 snapshot(){return{startedAt:this.startedAt,rows:[...this.rows.values()].map(r=>({...r})),droppedCalls:this.droppedCalls,droppedPending:this.droppedPending}}
}

/** MCP 可见性只保存到工作台 JSON，修订检查与写入共用一次短文件锁。 */
import{mkdir,open,writeFile,rename,unlink,rmdir}from'node:fs/promises'
import{constants}from'node:fs'
import{dirname}from'node:path'
import{randomUUID}from'node:crypto'
import{policyHash}from'./policy-scope.js'
import{isMcpName,mcpFail}from'./mcp-state.js'
export function createMcpVisibilityStore(file,config){
 let queue=Promise.resolve()
 const normalize=rule=>{
  if(!rule||!['project','session'].includes(rule.scope)||typeof rule.scopeKey!=='string'||!rule.scopeKey||rule.scopeKey.length>128||typeof rule.serverKey!=='string'||!(/^[a-f\d]{64}$/.test(rule.serverKey)||['unverified','resources'].includes(rule.serverKey))||typeof rule.all!=='boolean')mcpFail('invalid-state')
  for(const key of ['hidden','shown'])if(!Array.isArray(rule[key])||rule[key].length>config.maxTools||rule[key].some(n=>!isMcpName(n)))mcpFail('invalid-state')
  if(['unverified','resources'].includes(rule.serverKey)&&rule.all)mcpFail('invalid-state')
  for(const key of ['entryId','serverName'])if(rule[key]!==undefined&&rule[key]!==null&&(typeof rule[key]!=='string'||rule[key].length>256))mcpFail('invalid-state')
  return{id:policyHash(JSON.stringify([rule.scope,rule.scopeKey,rule.serverKey])),scope:rule.scope,scopeKey:rule.scopeKey,serverKey:rule.serverKey,entryId:rule.entryId??null,serverName:rule.serverName??null,all:rule.all,hidden:[...new Set(rule.hidden)].sort(),shown:[...new Set(rule.shown)].sort(),retired:rule.retired===true}
 }
 async function read(){let handle;try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(error.code==='ENOENT')return{version:1,revision:0,rules:[]};throw error}
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>config.maxStateBytes)mcpFail('invalid-state');const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>stat.size)mcpFail('invalid-state');let value;try{value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'))}catch{mcpFail('invalid-state')}if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.rules)||value.rules.length>config.maxRules)mcpFail('invalid-state');const rules=value.rules.map(normalize);if(new Set(rules.map(r=>r.id)).size!==rules.length)mcpFail('invalid-state');return{version:1,revision:value.revision,rules}}
  finally{await handle.close()}
 }
 async function transaction(fn){const task=queue.then(async()=>{await mkdir(dirname(file),{recursive:true,mode:0o700});const lock=file+'.lock';try{await mkdir(lock,{mode:0o700})}catch(error){if(error.code==='EEXIST')mcpFail('busy');throw error}const temp=file+'.'+randomUUID()+'.tmp'
   try{const previous=await read(),next=await fn(previous);if(next===previous)return previous;if(next.rules.length>config.maxRules)mcpFail('state-limit');const value={version:1,revision:previous.revision+1,rules:next.rules.map(normalize)},text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>config.maxStateBytes)mcpFail('state-limit');await writeFile(temp,text,{flag:'wx',mode:0o600});await rename(temp,file);return value}
   finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e});await rmdir(lock)}
  });queue=task.catch(()=>{});return task}
 return{read,change:(revision,rule)=>transaction(state=>{if(state.revision!==revision)mcpFail('state-changed');const next=normalize({...rule,retired:false});return{rules:[...state.rules.filter(r=>r.id!==next.id),...next.all||next.hidden.length?[next]:[]]}}),remove:(revision,id)=>transaction(state=>{if(state.revision!==revision)mcpFail('state-changed');return{rules:state.rules.filter(r=>r.id!==id)}}),retire:keys=>transaction(state=>state.rules.some(r=>keys.includes(r.serverKey)&&!r.retired)?{rules:state.rules.map(r=>keys.includes(r.serverKey)?{...r,retired:true}:r)}:state),dispose:()=>queue}
}

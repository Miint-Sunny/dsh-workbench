/** MCP 页只读 Loader 的四个公开配置字段；可见性写入仅限工作台状态。 */
import{join}from'node:path'
import{registerFeature}from'./features.js'
import{workbenchDataDir}from'./data-dir.js'
import{parseMcpConfig,mcpServer,mcpFail}from'./mcp-state.js'
import{createMcpVisibilityStore}from'./mcp-store.js'
import{createMcpManager}from'./mcp-manager.js'
export const name='@miint-sunny/dsh-workbench/mcp'
export function apply(ctx,input){
 const config=parseMcpConfig(input)
 ctx.effect(()=>registerFeature('mcp'),'MCP page feature')
 ctx.inject(['tools','agents','agentPresets','workingDirectory','pluginInventory','loader','connection'],async scope=>{
  const store=createMcpVisibilityStore(join(workbenchDataDir(),'mcp-visibility.json'),config)
  const readServers=()=>[...scope.loader.entries()].filter(entry=>entry.options.name==='@deepseek-ai/dsh-mcp-client').map(entry=>({entry,server:mcpServer({entryId:String(entry.id),moduleName:entry.options.name,enabled:!entry.disabled},entry.options.config)}))
  const manager=createMcpManager({ctx:scope,config,store,readServers})
  scope.effect(()=>()=>manager.dispose(),'MCP visibility cleanup')
  scope.on('agent/created',({agent})=>manager.attach(agent))
  scope.on('agent/disposed',({agent})=>manager.counters.endSession(agent.id))
  scope.on('session/event',(session,event)=>manager.onEvent(session,event))
  scope.on('tools/change',()=>manager.onTools())
  await manager.start()
  for(const action of ['state','change'])scope.effect(()=>scope.connection.fetch.register({path:'/api/dsh-workbench.mcp.'+action,methods:[action==='state'?'GET':'POST'],requestBody:'buffered',async fetch(request){
   try{let body
    if(action==='state'){const query=new URL(request.url).searchParams;if([...query.keys()].some(k=>k!=='sessionId')||query.getAll('sessionId').length>1)mcpFail('invalid-input');body=Object.fromEntries(query)}
    else{body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['sessionId','scope','revision','target','hidden'].includes(k)))mcpFail('invalid-input')}
    if(body.sessionId!==undefined&&(typeof body.sessionId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId)))mcpFail('invalid-input')
    const value=action==='state'?await manager.read(body.sessionId):await manager.change(body)
    return Response.json(value,{headers:{'cache-control':'no-store'}})
   }catch(error){const known=['invalid-input','invalid-state','state-changed','state-limit','busy','session-unavailable','scope-unavailable','excluded','unverified','tool-unavailable','disabled','save-failed'],code=known.includes(error.code)?error.code:action==='change'?'save-failed':'read-failed';return Response.json({error:{code}},{status:code==='state-changed'||code==='busy'?409:400,headers:{'cache-control':'no-store'}})}
  }}),'MCP '+action)
 })
}

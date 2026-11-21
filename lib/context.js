/** 按需上下文页：固定观察、官方估算、数值响应；无模型调用或原文接口。 */
import { registerFeature } from './features.js'
import { parseContextConfig } from './context-config.js'
import { summarizeContext } from './context-stats.js'
import { createContextStore } from './context-store.js'
import { workbenchDataDir } from './data-dir.js'
import { priceRows, readUsageConfig } from './usage-config.js'
export const name = '@miint-sunny/dsh-workbench/context'
const reply = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store'}})

/** 注册读取路由，严格接受一个会话标识。 */
export function applyContextRoutes(ctx,store) {
  return ctx.connection.fetch.register({path:'/api/dsh-workbench.context',methods:['GET'],requestBody:'buffered',async fetch(request){
    const query=new URL(request.url).searchParams,id=query.get('sessionId')
    if([...query.keys()].some(k=>k!=='sessionId')||query.getAll('sessionId').length!==1||!id||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))return reply({error:{code:'invalid-session'}},400)
    try{return reply(await store.read(id,request.signal))}
    catch(error){return reply({error:{code:request.signal.aborted?'request-aborted':error.code==='SESSION_QUERY_SESSION_NOT_FOUND'?'session-not-found':'context-read-failed'}},request.signal.aborted?499:error.code==='SESSION_QUERY_SESSION_NOT_FOUND'?404:500)}
  }})
}

/** 新增独立功能行，卸载等待所有观察释放。 */
export function apply(ctx,options) {
  const config=parseContextConfig(options)
  ctx.effect(()=>registerFeature('context'),'workbench context feature')
  ctx.inject(['connection','sessionQuery','sessions','tokenMeter'],scope=>{
    const store=createContextStore({sessionQuery:scope.sessionQuery,config,aggregate:(lease,{signal})=>summarizeContext(lease,{
      config,signal,estimateMessage:message=>scope.tokenMeter.estimateMessage(message),
      price:rows=>priceRows(rows,readUsageConfig(workbenchDataDir())).rows,
      measure:()=>{
        const live=scope.sessions.get(lease.header.id)
        // 聚合过程中会话可能继续运行，只有相同 cut 才使用 live 节点。
        if(live&&live.seq===lease.cursor+1)return scope.tokenMeter.measure(live)
        if(live)return undefined
        const detached=scope.sessions.prepare(lease.header.id,{seed:lease.events,meta:lease.header,inheritedEventCount:lease.inheritedEventCount,eventState:'shared-frozen'})
        return scope.tokenMeter.measure(detached)
      },
    })})
    scope.effect(()=>()=>store.dispose(),'workbench context observations')
    scope.effect(()=>applyContextRoutes(scope,store),'workbench context route')
  })
}

/** 放行规则行：只在原生 approval/request 中代答，界面写入需真实待审批请求。 */
import{join}from'node:path'
import{registerFeature}from'./features.js'
import{workbenchDataDir}from'./data-dir.js'
import{parseApprovalRulesConfig,rulesFail}from'./approval-rules-state.js'
import{createApprovalRuleStore}from'./approval-rules-store.js'
import{createApprovalRulesManager}from'./approval-rules-manager.js'
export const name='@miint-sunny/dsh-workbench/approval-rules'
export function apply(ctx,input){
 const config=parseApprovalRulesConfig(input)
 ctx.effect(()=>registerFeature('approval-rules'),'approval rules feature')
 ctx.inject(['agents','approval','workingDirectory','agentPresets','shell','subprocess','sandboxPolicy','connection'],async scope=>{
  const store=createApprovalRuleStore(join(workbenchDataDir(),'approval-rules.json'),config),manager=createApprovalRulesManager({ctx:scope,config,store})
  scope.effect(()=>()=>manager.dispose(),'approval rule cleanup')
  scope.on('agent/created',({agent})=>manager.attach(agent))
  scope.on('agent/disposed',({agent})=>manager.detach(agent))
  scope.on('session/event',(session,event)=>manager.onEvent(session,event))
  await manager.start()
  for(const action of ['list','pending','create','change'])scope.effect(()=>scope.connection.fetch.register({path:'/api/dsh-workbench.approval-rules.'+action,methods:[['list','pending'].includes(action)?'GET':'POST'],requestBody:'buffered',async fetch(request){
   try{
    const query=new URL(request.url).searchParams;if(request.method==='GET'&&[...query.keys()].some(k=>query.getAll(k).length!==1))rulesFail('invalid-input')
    const body=request.method==='GET'?Object.fromEntries(query):await request.json(),allowed={list:[],pending:['sessionId','callId'],create:['sessionId','callId','token','revision','options'],change:['id','revision','action']}[action]
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))rulesFail('invalid-input')
    if(['pending','create'].includes(action)&&[body.sessionId,body.callId].some(id=>typeof id!=='string'||!id||id.length>128))rulesFail('invalid-input')
    const value=action==='list'?await manager.list():action==='pending'?await manager.inspect(body.sessionId,body.callId):action==='create'?await manager.create(body,request.signal):await manager.change(body)
    return Response.json(value,{headers:{'cache-control':'no-store'}})
   }catch(error){const known=['invalid-input','invalid-options','invalid-state','state-changed','state-limit','busy','request-ended','request-changed','source-changed','audit-unavailable','disabled'],code=known.includes(error.code)?error.code:'write-failed';return Response.json({error:{code}},{status:['state-changed','request-ended','request-changed','source-changed','busy'].includes(code)?409:400,headers:{'cache-control':'no-store'}})}
  }}),'approval rules '+action)
 })
}

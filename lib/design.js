/** 设计行：发布版本、草稿与发送前摘要校验；没有模型侧写入工具。 */
import{join}from'node:path'
import{registerFeature}from'./features.js'
import{workbenchDataDir}from'./data-dir.js'
import{designConfig}from'./design-protocol.js'
import{createDesignStore}from'./design-store.js'
export const name='@miint-sunny/dsh-workbench/design'
export function apply(ctx,input){
 const config=designConfig(input)
 ctx.effect(()=>registerFeature('design'),'design feature')
 ctx.inject(['workbenchPages','connection','sessions','sessionPersistence','workingDirectory'],scope=>{
  const store=createDesignStore(join(workbenchDataDir(),'design'),{pages:scope.workbenchPages,config,workspaceRootOf:async id=>{const live=scope.sessions.get(id);return live?scope.workingDirectory.get(live):(await scope.sessionPersistence.stat(id))?.header.cwd}})
  scope.effect(()=>()=>store.dispose(),'design pending writes')
  for(const action of ['page','save','prepare','sent','export'])scope.effect(()=>scope.connection.fetch.register({path:'/api/dsh-workbench.design.'+action,methods:[action==='page'?'GET':'POST'],requestBody:'buffered',async fetch(request){
   try{
    const query=new URL(request.url).searchParams
    if(request.method==='GET'&&[...query.keys()].some(k=>query.getAll(k).length!==1))throw new Error('invalid-page')
    const body=request.method==='GET'?Object.fromEntries(query):await request.json(),allowed={page:['page','version'],save:['page','version','revision','draft'],prepare:['page','version','revision'],sent:['page','version','revision','requestId'],export:['page','version','params']}[action]
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))throw new Error('invalid-page')
    const version=request.method==='GET'&&/^\d+$/.test(body.version)?Number(body.version):body.version
    if(action==='export'){const html=store.export(body.page,version,body.params);return new Response(html,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','content-security-policy':'sandbox allow-scripts','content-disposition':`attachment; filename="${body.page}-v${version}${body.params?'--preview':''}.html"`}})}
    const value=action==='page'?await store.open(body.page,version):action==='save'?await store.save(body.page,version,body.revision,body.draft):action==='prepare'?await store.prepare(body.page,version,body.revision):await store.sent(body.page,version,body.revision,body.requestId)
    return Response.json(value,{headers:{'cache-control':'no-store'}})
   }catch(e){const code=['invalid-page','invalid-draft','invalid-parameters','page-missing','page-too-large','draft-changed','source-changed','source-unavailable','version-changed','empty-draft'].includes(e.code??e.message)?e.code??e.message:'read-failed';return Response.json({error:{code}},{status:code.endsWith('changed')?409:400,headers:{'cache-control':'no-store'}})}
  }}),'design '+action)
 })
}

/** 独立审查作业、报告状态和有界事件流。读项目只发生在明确发起/核对时。 */
import { createLocalReviewStore } from './local-review-store.js'
import { captureReviewSnapshot,reviewSnapshotCurrent } from './local-review-snapshot.js'
import { LocalReviewError,reviewId,validateReviewFindings } from './local-review-state.js'
import { randomUUID } from 'node:crypto'

/** 不向页面发送源文件正文或完整 patch。 */
export function publicReview(record,active=false){
 const {snapshot,...meta}=record
 const interrupted=!active&&['capturing','running'].includes(meta.status)
 return{...meta,...interrupted?{status:'error',error:'interrupted'}:{},files:snapshot?.changed.map(path=>({path,lines:snapshot.files[path].lines,deleted:snapshot.files[path].deleted}))??meta.files??[],skipped:snapshot?.skipped??meta.skipped??[],fingerprint:snapshot?.fingerprint??meta.fingerprint??null}
}

export function createLocalReviewManager({dir,config,run,logger=console}){
 const store=createLocalReviewStore(dir,config),records=new Map(),active=new Map(),byParent=new Map(),listeners=new Set(),queues=new Map(),agents=new Set()
 let closed=false
 const notify=record=>{const value=publicReview(record,active.has(record.id));for(const listener of listeners)listener(value)}
 function trim(keep){while(records.size>config.maxCachedReports){const key=[...records.keys()].find(k=>!active.has(k)&&!queues.has(k)&&k!==keep);if(key===undefined)break;records.delete(key)}}
 async function get(id){if(records.has(id)){const record=records.get(id);records.delete(id);records.set(id,record);return record}const record=await store.read(id);records.set(id,record);trim(id);return record}
 async function update(id,mutate){const previous=queues.get(id)??Promise.resolve();const task=previous.then(async()=>{const record=await get(id);await mutate(record);record.revision=(record.revision??0)+1;await store.save(record);notify(record);return record});const settled=task.catch(()=>{});queues.set(id,settled);try{return await task}finally{if(queues.get(id)===settled)queues.delete(id);trim()}}
 return{
  get closed(){return closed}, get,active,agents,
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},
  async list(parentId){return(await store.list(parentId)).map(r=>publicReview(records.get(r.id)??r,active.has(r.id)))},
  async start(parent,{cwd,selection,model}){
   if(closed)throw new LocalReviewError('disabled')
   const existing=byParent.get(parent.id);if(existing){if(JSON.stringify(existing.record.selection)===JSON.stringify(selection))return publicReview(existing.record,true);throw new LocalReviewError('busy')}
   if(active.size>=config.maxActiveReviews)throw new LocalReviewError('busy')
   const record={id:reviewId(parent.id),parentId:parent.id,created:Date.now(),status:'capturing',revision:0,selection,model,findings:[],childCreated:false,stale:false,error:null}
   const controller=new AbortController(),done=Promise.withResolvers(),job={record,controller,done:done.promise}
   active.set(record.id,job);byParent.set(parent.id,job);records.set(record.id,record);trim()
   const releaseParent=parent.ctx.effect(()=>async()=>{controller.abort(new Error('parent disposed'));await done.promise},'local-review parent lifetime')
   try{await store.save(record)}catch(error){active.delete(record.id);byParent.delete(parent.id);trim();done.resolve();await releaseParent();throw error}
   job.promise=(async()=>{
    try{
     const snapshot=await captureReviewSnapshot(cwd,selection,config,{signal:controller.signal})
     await update(record.id,r=>{r.snapshot=snapshot;r.projectRoot=snapshot.root;r.files=snapshot.changed.map(path=>({path,lines:snapshot.files[path].lines,deleted:snapshot.files[path].deleted}));r.skipped=snapshot.skipped;r.fingerprint=snapshot.fingerprint})
     controller.signal.throwIfAborted()
     if(snapshot.changed.length){await update(record.id,r=>{r.status='running';r.childCreated=true});await run(record,controller.signal);controller.signal.throwIfAborted();if(!record.submitted)throw new LocalReviewError('missing-findings')}
     const current=await reviewSnapshotCurrent(snapshot,config,{signal:controller.signal});await update(record.id,r=>{r.status='completed';r.stale=!current;r.finished=Date.now()})
    }catch(error){await update(record.id,r=>{r.status=controller.signal.aborted?'cancelled':'error';r.error=controller.signal.aborted?'cancelled':error instanceof LocalReviewError?error.code:'review-failed';r.finished=Date.now()})}
    finally{active.delete(record.id);byParent.delete(parent.id);trim();done.resolve();await releaseParent();notify(record)}
   })().catch(()=>{record.status='error';record.error='storage-failed';notify(record);logger.warn('workbench local review: report could not be saved')})
   notify(record);return publicReview(record,true)
  },
  async submit(id,input){if(closed||!active.has(id)||active.get(id).controller.signal.aborted)throw new LocalReviewError('review-closed');return update(id,record=>{const findings=validateReviewFindings(input,record.snapshot,config),previous=new Map(record.findings.map(x=>[x.id,x]));record.findings=findings.map(f=>({...f,...previous.has(f.id)?{status:previous.get(f.id).status,requestId:previous.get(f.id).requestId}:{}}));record.submitted=true})},
  async inspect(id){const record=await get(id),value=publicReview(record,active.has(id));if(record.snapshot&&!active.has(id))value.stale=!await reviewSnapshotCurrent(record.snapshot,config);return value},
  async stop(id){const job=active.get(id);if(job){job.controller.abort(new Error('review stopped'));await job.done}},
  async change(id,findingId,status,revision){if(!['open','ignored','pending'].includes(status))throw new LocalReviewError('invalid-state');return update(id,record=>{if(record.revision!==revision)throw new LocalReviewError('report-changed');const finding=record.findings.find(x=>x.id===findingId);if(!finding)throw new LocalReviewError('finding-not-found');finding.status=status;if(status==='open')delete finding.requestId})},
  async prepare(id,findingId,cwd,revision){
   const record=await get(id);if(active.has(id)||record.revision!==revision)throw new LocalReviewError('report-changed')
   const finding=record.findings.find(x=>x.id===findingId);if(!finding||finding.status==='ignored')throw new LocalReviewError('finding-not-found')
   if(!record.snapshot||cwd!==record.snapshot.root||!await reviewSnapshotCurrent(record.snapshot,config)){await update(id,r=>{r.stale=true});throw new LocalReviewError('stale')}
   const updated=await update(id,r=>{if(r.revision!==revision)throw new LocalReviewError('report-changed');r.stale=false;const f=r.findings.find(x=>x.id===findingId);f.requestId??=randomUUID()})
   const currentFinding=updated.findings.find(f=>f.id===findingId)
   return{parentId:updated.parentId,revision:updated.revision,requestId:currentFinding.requestId,finding:{...currentFinding},root:updated.snapshot.root,fingerprint:updated.snapshot.fingerprint,partial:updated.status!=='completed'}
  },
  async accepted(parentId,requestId){for(const record of await store.list(parentId)){const finding=record.findings.find(f=>f.requestId===requestId);if(finding&&finding.status!=='pending')await update(record.id,r=>{r.findings.find(f=>f.id===finding.id).status='pending'})}},
  async dispose(){closed=true;for(const job of active.values())job.controller.abort(new Error('review disabled'));for(const agent of agents)agent.cancel({kind:'disposed'});await Promise.allSettled([...active.values()].map(j=>j.promise));await Promise.allSettled([...agents].map(a=>a.whenIdle()));await Promise.allSettled([...queues.values()]);for(const listener of [...listeners])listener(null);listeners.clear();records.clear()},
 }
}

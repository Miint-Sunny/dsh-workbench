/** 每份报告与不可变源快照分开存放；列表只读小的报告，不扫描会话日志。 */
import { mkdir,open,writeFile,rename,unlink,readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalReviewError,reviewHash,validReviewId } from './local-review-state.js'
export function createLocalReviewStore(root,config){
 const snapshots=new Map()
 const remember=(id,fingerprint)=>{snapshots.delete(id);snapshots.set(id,fingerprint);while(snapshots.size>config.maxCachedReports)snapshots.delete(snapshots.keys().next().value)}
 const pathOf=id=>{if(!validReviewId(id))throw new LocalReviewError('invalid-report');return join(root,id.slice(4,68),id)}
 const maxBytes=config.maxSnapshotBytes*4+config.maxPatchBytes*4+config.maxFindings*32000
 async function readJson(path){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size>maxBytes)throw new LocalReviewError('invalid-report');const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>stat.size)throw new LocalReviewError('invalid-report');return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'))}finally{await file.close()}}
 async function atomic(path,text){const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,text+'\n',{flag:'wx',mode:0o600});await rename(temp,path)}finally{try{await unlink(temp)}catch(error){if(error.code!=='ENOENT')throw error}}}
 return{
  async save(value){
   if(!validReviewId(value.id)||value.id.slice(4,68)!==reviewHash(value.parentId))throw new LocalReviewError('invalid-report')
   const target=pathOf(value.id);await mkdir(join(target,'..'),{recursive:true,mode:0o700})
   const{snapshot,...meta}=value
   if(snapshot){
    meta.hasSnapshot=true
    if(snapshots.get(value.id)!==snapshot.fingerprint){
     const text=JSON.stringify(snapshot);if(Buffer.byteLength(text)>maxBytes)throw new LocalReviewError('scope-too-large')
     let existing;try{existing=await readJson(target+'.snapshot.json')}catch(error){if(error.code!=='ENOENT')throw error}
     if(existing&&existing.fingerprint!==snapshot.fingerprint)throw new LocalReviewError('report-changed')
     if(!existing)await atomic(target+'.snapshot.json',text)
     remember(value.id,snapshot.fingerprint)
    }
   }
   const text=JSON.stringify(meta);if(Buffer.byteLength(text)>maxBytes)throw new LocalReviewError('scope-too-large');await atomic(target+'.json',text)
  },
  async read(id,includeSnapshot=true){
   let data;try{data=await readJson(pathOf(id)+'.json')}catch(error){if(error.code==='ENOENT')throw new LocalReviewError('report-not-found');throw error}
   if(data.id!==id||typeof data.parentId!=='string'||reviewHash(data.parentId)!==id.slice(4,68)||!Array.isArray(data.findings)||!['capturing','running','completed','cancelled','error'].includes(data.status))throw new LocalReviewError('invalid-report')
   if(includeSnapshot&&data.hasSnapshot){data.snapshot=await readJson(pathOf(id)+'.snapshot.json');if(data.snapshot.fingerprint!==data.fingerprint)throw new LocalReviewError('invalid-report');remember(id,data.snapshot.fingerprint)}
   return data
  },
  async list(parentId){let names;try{names=await readdir(join(root,reviewHash(parentId)))}catch(error){if(error.code==='ENOENT')return[];throw error}const ids=names.filter(n=>n.endsWith('.json')&&validReviewId(n.slice(0,-5))).sort().reverse().slice(0,config.maxReports);return Promise.all(ids.map(n=>this.read(n.slice(0,-5),false)))},
 }
}

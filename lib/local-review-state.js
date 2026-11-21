/** 本地审查的参数、结果校验与稳定标识。 */
import { createHash, randomUUID } from 'node:crypto'
export class LocalReviewError extends Error { constructor(code){super(code);this.code=code} }
export const reviewHash = value => createHash('sha256').update(value).digest('hex')
export const reviewId = parentId => `wbr-${reviewHash(parentId)}-${Date.now().toString(36)}-${randomUUID().replaceAll('-','')}`
export const validReviewId = id => typeof id==='string'&&/^wbr-[a-f0-9]{64}-[a-z0-9]{8,12}-[a-f0-9]{32}$/.test(id)
export function parseLocalReviewConfig(value={}) {
 const defaults={model:null,locale:'zh',maxActiveReviews:2,maxFiles:200,maxFileBytes:262144,maxSnapshotBytes:2097152,maxPatchBytes:262144,maxFindings:100,maxReports:40,maxCachedReports:4,gitTimeoutMs:10000}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalReviewError('invalid-config')
 for(const key of Object.keys(value))if(!Object.hasOwn(defaults,key))throw new LocalReviewError('invalid-config')
 const c={...defaults,...value}
 if(c.model!==null&&(typeof c.model!=='string'||!c.model.trim()||c.model.length>128)||!['zh','en'].includes(c.locale))throw new LocalReviewError('invalid-config')
 for(const key of ['maxActiveReviews','maxFiles','maxFileBytes','maxSnapshotBytes','maxPatchBytes','maxFindings','maxReports','maxCachedReports','gitTimeoutMs'])if(!Number.isSafeInteger(c[key])||c[key]<1)throw new LocalReviewError('invalid-config')
 return c
}
export function parseReviewInput(input='') {
 if(typeof input!=='string'||input.length>1024)throw new LocalReviewError('invalid-input')
 const tokens=input.trim().split(/\s+/).filter(Boolean);let mode='uncommitted',base=null
 if(tokens[0]==='uncommitted')tokens.shift()
 else if(tokens[0]==='--base'){tokens.shift();base=tokens.shift();if(!base||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base))throw new LocalReviewError('invalid-input');mode='branch'}
 const untracked=tokens[0]==='--untracked';if(untracked)tokens.shift()
 if(tokens.length)throw new LocalReviewError('invalid-input')
 return{mode,base,untracked}
}
export function safeReviewPath(path){return typeof path==='string'&&path.length>0&&path.length<=1024&&!/[\x00-\x1f\x7f\\\ufffd]/.test(path)&&!path.startsWith('/')&&!/^[A-Za-z]:/.test(path)&&!path.split('/').some(x=>x==='..'||x==='.'||x==='')}
export function validateReviewFindings(input,snapshot,config){
 if(!Array.isArray(input)||input.length>config.maxFindings)throw new LocalReviewError('invalid-findings')
 const seen=new Set(),result=[]
 for(const row of input){
  const file=row&&snapshot.files[row.path]
  if(!row||!safeReviewPath(row.path)||!file||!snapshot.changed.includes(row.path)||!Number.isSafeInteger(row.line)||row.line<1||row.line>file.lines||!['high','medium','low'].includes(row.severity))throw new LocalReviewError('invalid-findings')
  const end=row.endLine??row.line;if(!Number.isSafeInteger(end)||end<row.line||end>file.lines)throw new LocalReviewError('invalid-findings')
  for(const[key,max]of [['title',200],['description',4000],['evidence',2000],['validation',2000]])if(key==='title'||key==='description'||row[key]!==undefined){if(typeof row[key]!=='string'||!row[key].trim()||row[key].length>max)throw new LocalReviewError('invalid-findings')}
  const id=reviewHash(JSON.stringify([row.path,row.line,end,row.title,row.description])).slice(0,24);if(seen.has(id))continue;seen.add(id)
  result.push({id,path:row.path,line:row.line,endLine:end,severity:row.severity,title:row.title,description:row.description,evidence:row.evidence??'',validation:row.validation??'',status:'open'})
 }
 return result
}

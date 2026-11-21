/** 设计草稿与发送前校验；只写工作台自己的目录。 */
import{mkdir,open,writeFile,rename,unlink,realpath}from'node:fs/promises'
import{constants}from'node:fs'
import{join}from'node:path'
import{createHash,randomUUID}from'node:crypto'
import{designConfig,designDeclarations,designDraft,designCSSValues,designFail}from'./design-protocol.js'
import{readWorkspaceHtml,readWorkspaceAsset}from'./pages-read.js'
import{cspReportScriptTag}from'./pages-csp.js'
const hash=value=>createHash('sha256').update(value).digest('hex')
/** 导出来源固定为发布文件，选择桥从不写入它；可选参数副本仅增加已验证变量。 */
export function designExport(html,declarations,params){let output=html.replace(cspReportScriptTag(),'');if(params!==undefined){const css=Object.entries(designCSSValues(params,declarations)).map(([k,v])=>k+':'+v).join(';');const style='<style data-dsh-design-preview>:root{'+css+'}</style>';output=/<\/head\s*>/i.test(output)?output.replace(/<\/head\s*>/i,style+'</head>'):style+output}return output}
export function createDesignStore(dir,{pages,workspaceRootOf,config={}}){
 const limits=designConfig(config),queues=new Map();let closed=false
 const keyOf=(page,version)=>{if(typeof page!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(page)||!Number.isSafeInteger(version)||version<1)designFail('invalid-page');return page+'-v'+version}
 async function read(page,version){
  const key=keyOf(page,version),max=limits.maxComments*(limits.maxText+limits.maxMessageBytes)+65536
  try{const file=await open(join(dir,key+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);let result
   try{const stat=await file.stat();if(!stat.isFile()||stat.size>max)designFail('invalid-draft');const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>stat.size)designFail('invalid-draft');result=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'))}finally{await file.close()}
   if(result.page!==page||result.version!==version||!Number.isSafeInteger(result.revision)||result.revision<0)designFail('invalid-draft');return result
  }catch(e){if(e.code==='ENOENT')return{page,version,revision:0,comments:[],params:{}};throw e}
 }
 async function write(value){await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,keyOf(value.page,value.version)+'.json'),temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});await rename(temp,path)}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e})}return value}
 async function serial(page,version,operation){if(closed)designFail('read-failed');const key=keyOf(page,version),task=(queues.get(key)??Promise.resolve()).then(operation),settled=task.catch(()=>{});queues.set(key,settled);try{return await task}finally{if(queues.get(key)===settled)queues.delete(key)}}
 function published(page,version){keyOf(page,version);const found=pages.readVersion(page,version);if(!found)designFail('page-missing');if(Buffer.byteLength(found.html)>limits.maxHtmlBytes)designFail('page-too-large');const item=found.meta.versions.find(v=>v.n===version);return{...found,item,declarations:designDeclarations(found.html,limits)}}
 async function sourceRead(operation){try{return await operation()}catch{designFail('source-changed')}}
 async function sourceCurrent(found){const proof=found.item.sourceRevision;if(!proof||!Array.isArray(proof.files)||!proof.files.length||proof.files.length>65||!proof.source?.sessionId||!proof.source?.path)designFail('source-unavailable');const root=await workspaceRootOf(proof.source.sessionId);if(!root||await sourceRead(()=>realpath(root))!==proof.root)designFail('source-changed');for(const file of proof.files){if(typeof file.path!=='string'||!/^([a-f\d]{64})$/.test(file.hash))designFail('source-unavailable');const bytes=file.path===proof.source.path?(await sourceRead(()=>readWorkspaceHtml(file.path,root))).html:(await sourceRead(()=>readWorkspaceAsset(file.path,root))).bytes;if(hash(bytes)!==file.hash)designFail('source-changed')}return proof}
 return{
  async open(page,version){const found=published(page,version),saved=await read(page,version),draft={...saved,...designDraft({comments:saved.comments,params:saved.params},found.declarations,limits)};return{page,version,title:found.meta.title,html:found.html,fingerprint:hash(found.html),source:found.item.sourceRevision?.source??found.meta.source,sourceReady:!!found.item.sourceRevision,latest:found.meta.versions.at(-1).n,declarations:found.declarations,draft,limits}},
  async save(page,version,revision,data){return serial(page,version,async()=>{const found=published(page,version),old=await read(page,version);if(old.revision!==revision)designFail('draft-changed');return write({page,version,revision:revision+1,...designDraft(data,found.declarations,limits)})})},
  async prepare(page,version,revision){return serial(page,version,async()=>{const found=published(page,version);if(found.meta.versions.at(-1).n!==version)designFail('version-changed');const proof=await sourceCurrent(found),saved=await read(page,version);if(saved.revision!==revision)designFail('draft-changed');const draft=designDraft({comments:saved.comments,params:saved.params},found.declarations,limits);if(!draft.comments.length&&!Object.keys(draft.params).length)designFail('empty-draft');if(!saved.requestId){saved.requestId=randomUUID();saved.revision++;await write(saved)}return{...saved,sessionId:proof.source.sessionId,source:proof.source,sourceFiles:proof.files,sourceRoot:proof.root,fingerprint:hash(found.html),boards:{desktop:{width:1280,height:800},mobile:{width:375,height:812}}}})},
  async sent(page,version,revision,requestId){if(typeof requestId!=='string'||!/^[a-f\d-]{36}$/.test(requestId))designFail('invalid-draft');return serial(page,version,async()=>{const old=await read(page,version);if(old.revision!==revision||old.requestId!==requestId)designFail('draft-changed');return write({page,version,revision:revision+1,comments:[],params:{}})})},
  async dispose(){closed=true;await Promise.allSettled([...queues.values()])},
  export(page,version,params){const found=published(page,version);return designExport(found.html,found.declarations,params)},
 }
}

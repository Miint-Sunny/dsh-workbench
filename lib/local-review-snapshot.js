/** Git 只读快照：禁用外部 diff/textconv/fsmonitor，跳过内容过滤器与敏感文件。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { realpath,lstat,open } from 'node:fs/promises'
import { resolve,relative,isAbsolute,basename } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { LocalReviewError,reviewHash,safeReviewPath } from './local-review-state.js'
const execute=promisify(execFile)
function environment(){const env={...process.env,LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0'};for(const key of Object.keys(env))if(key.startsWith('GIT_')&&key!=='GIT_OPTIONAL_LOCKS')delete env[key];return env}
export async function reviewGit(cwd,args,config,signal){
 const options={cwd,env:environment(),signal,timeout:config.gitTimeoutMs,maxBuffer:Math.max(config.maxPatchBytes,config.maxFileBytes)+65536}
 const flags=['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.quotePath=false']
 try{
  let keys=''
  try{keys=(await execute('git',[...flags,'config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$'],options)).stdout}
  catch(error){if(error.code!==1)throw error}
  // 只读配置键，不读取过滤器命令；命令行覆盖也保护 name-only 的内容归一化路径。
  const drivers=[...new Set(keys.split('\0').filter(Boolean).map(key=>key.replace(/\.(clean|smudge|process|required)$/,'')))]
  const overrides=drivers.flatMap(key=>['-c',key+'.clean=','-c',key+'.smudge=','-c',key+'.process=','-c',key+'.required=false'])
  return(await execute('git',[...flags,...overrides,...args],options)).stdout
 }catch(error){if(signal?.aborted)throw signal.reason;throw new LocalReviewError(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'scope-too-large':'git-read-failed')}
}
const list=text=>text.split('\0').filter(Boolean)
export const sensitiveReviewPath=path=>/(^|\/)([^/]*\.env(?:\.[^/]*)?|\.envrc|\.credentials(?:\..*)?|(?:[^/]+\.)?credentials\.(?:json|ya?ml|ini|toml)|secrets?\.(?:json|ya?ml|toml|ini|env)|client_secret[^/]*\.json|service[-_]?account[^/]*\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.vault-token|\.aws|\.ssh|\.gnupg|\.docker|\.kube)(\/|$)/i.test(path)||/\.(?:pem|key|p12|pfx|keystore|jks|ppk|p8|tfvars)$/i.test(path)
// Fold JSON string escapes (including nested JSON) before inspecting either key format.
const KEY_MARKER = /-----(BEGIN|END) ([A-Z0-9 ]{0,64}PRIVATE KEY)-----/g
export function privateKeyContent(text) {
 if (!text.includes('PRIVATE KEY-----') && !text.includes('PuTTY-User-Key-File-')) return false
 const decoded = text.replace(/\\+([rn/])?/g, (raw, escape) =>
  escape === 'n' || escape === 'r' ? '\n' : escape === '/' ? '/' : raw)
 const putty = /PuTTY-User-Key-File-\d+:[ \t]+[\w@.+-]+\s+Encryption:[ \t]+[\w-]+/.exec(decoded)
 if (putty && /Private-Lines:[ \t]+[1-9]\d*\s+[A-Za-z0-9+/]{16}/.test(decoded.slice(putty.index + putty[0].length))) return true

 let begin
 for (const marker of decoded.matchAll(KEY_MARKER)) {
  if (marker[1] === 'BEGIN') {
   begin = marker
   continue
  }
  if (begin && begin[2] === marker[2]) {
   const body = decoded.slice(begin.index + begin[0].length, marker.index)
    .replace(/^\s*Proc-Type:\s*4,ENCRYPTED\s+DEK-Info:\s*[\w-]+,[\da-f]+\s+/i, '')
    .replace(/\s+/g, '')
   if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(body)) return true
  }
  begin = undefined
 }
 return false
}
async function currentFile(root,path,maxBytes){
 const absolute=resolve(root,path),rel=relative(root,absolute);if(!safeReviewPath(path)||isAbsolute(rel)||rel.startsWith('..'))throw new LocalReviewError('invalid-path')
 let info;try{info=await lstat(absolute)}catch(error){if(error.code==='ENOENT')return null;throw error}
 if(info.isSymbolicLink())throw new LocalReviewError('symlink');if(!info.isFile())throw new LocalReviewError('not-file');if(info.size>maxBytes)throw new LocalReviewError('large')
 const canonical=await realpath(absolute),inside=relative(root,canonical);if(inside.startsWith('..')||isAbsolute(inside))throw new LocalReviewError('outside-project')
 const handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const before=await handle.stat();if(before.size>maxBytes)throw new LocalReviewError('large');const buffer=Buffer.alloc(before.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>before.size)throw new LocalReviewError('stale');const bytes=buffer.subarray(0,bytesRead);if(bytes.includes(0)||!isUtf8(bytes))throw new LocalReviewError('binary');const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||await realpath(absolute)!==canonical)throw new LocalReviewError('stale');return{content:bytes.toString('utf8'),hash:reviewHash(bytes),bytes:bytes.length}}finally{await handle.close()}
}
async function changedPaths(root,base,selection,config,signal){
 const names=list(await reviewGit(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',base,'--'],config,signal)),tracked=new Set(names)
 if(selection.untracked)names.push(...list(await reviewGit(root,['ls-files','--others','--exclude-standard','-z'],config,signal)))
 return{names:[...new Set(names)].sort(),tracked}
}

/** 固定当前差异及完整文件文本，读取中发生改动则拒绝，不运行项目 hooks。 */
export async function captureReviewSnapshot(cwd,selection,config,{signal}={}){
 signal?.throwIfAborted();let root
 try{root=await realpath((await reviewGit(cwd,['rev-parse','--show-toplevel'],config,signal)).trim())}catch(error){if(signal?.aborted)throw error;throw new LocalReviewError('not-repository')}
 let head;try{head=(await reviewGit(root,['rev-parse','--verify','HEAD'],config,signal)).trim()}catch{throw new LocalReviewError('empty-repository')}
 let base=head
 if(selection.mode==='branch'){try{const branch=selection.base.replace(/^refs\/heads\//,'');const target=(await reviewGit(root,['rev-parse','--verify','--end-of-options',`refs/heads/${branch}^{commit}`],config,signal)).trim();base=(await reviewGit(root,['merge-base',head,target],config,signal)).trim()}catch(error){if(signal?.aborted)throw error;throw new LocalReviewError('unknown-base')}}
 const changes=await changedPaths(root,base,selection,config,signal),candidates=changes.names;if(candidates.length>config.maxFiles)throw new LocalReviewError('scope-too-large')
 const skipped=[],eligible=[]
 for(const path of candidates){if(!safeReviewPath(path))skipped.push({path,reason:'invalid-path'});else if(sensitiveReviewPath(path))skipped.push({path,reason:'sensitive'});else eligible.push(path)}
 const deletedPaths=new Set(list(await reviewGit(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--diff-filter=D','--name-only','-z',base,'--'],config,signal)))
 const addedPaths=new Set(list(await reviewGit(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--diff-filter=A','--name-only','-z',base,'--'],config,signal)))
 const filtered=new Set()
 if(eligible.length){const attrs=list(await reviewGit(root,['check-attr','-z','filter','--',...eligible],config,signal));for(let i=0;i<attrs.length;i+=3)if(!['unspecified','unset',''].includes(attrs[i+2]))filtered.add(attrs[i])}
 const files=Object.create(null);let bytes=0
 for(const path of eligible){
  signal?.throwIfAborted()
  if(filtered.has(path)){skipped.push({path,reason:'filter'});continue}
  try{
   if(deletedPaths.has(path)){let present=false;try{await lstat(resolve(root,path));present=true}catch(error){if(error.code!=='ENOENT')throw error}if(present)throw new LocalReviewError('untracked-replacement')}
   let previous
   if(changes.tracked.has(path)&&!addedPaths.has(path)){
    previous=await reviewGit(root,['show',`${base}:${path}`],config,signal)
    if(Buffer.byteLength(previous)>config.maxFileBytes)throw new LocalReviewError('large')
    if(privateKeyContent(previous))throw new LocalReviewError('sensitive')
   }
   let file=await currentFile(root,path,config.maxFileBytes),deleted=false
   if(file===null){const content=previous??await reviewGit(root,['show',`${base}:${path}`],config,signal);if(Buffer.byteLength(content)>config.maxFileBytes)throw new LocalReviewError('large');if(content.includes('\0'))throw new LocalReviewError('binary');file={content,hash:null,bytes:Buffer.byteLength(content)};deleted=true}
   if(privateKeyContent(file.content))throw new LocalReviewError('sensitive')
   bytes+=file.bytes;if(bytes>config.maxSnapshotBytes)throw new LocalReviewError('scope-too-large')
   files[path]={...file,deleted,lines:file.content===''?0:file.content.split('\n').length-Number(file.content.endsWith('\n'))}
  }catch(error){if(signal?.aborted||error.code==='scope-too-large')throw error;skipped.push({path,reason:error.code??'unreadable'})}
 }
 const changed=Object.keys(files),tracked=changes.tracked
 const trackedChanged=changed.filter(p=>tracked.has(p))
 let patch=trackedChanged.length?await reviewGit(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--no-color','--unified=3',base,'--',...trackedChanged],config,signal):''
 for(const path of changed)if(!tracked.has(path))patch+=`\nNew file: ${JSON.stringify(path)}\n${files[path].content}`
 if(Buffer.byteLength(patch)>config.maxPatchBytes)throw new LocalReviewError('scope-too-large')
 const snapshot={root,head,base,selection,candidates,changed,files,skipped,patch,bytes,fingerprint:reviewHash(JSON.stringify([head,base,changed.map(p=>[p,files[p].hash])]))}
 if(!await reviewSnapshotCurrent(snapshot,config,{signal}))throw new LocalReviewError('stale')
 return snapshot
}

/** 只在完成、刷新或准备修复时核对，不监听工作区。 */
export async function reviewSnapshotCurrent(snapshot,config,{signal}={}){
 try{
  if((await reviewGit(snapshot.root,['rev-parse','--verify','HEAD'],config,signal)).trim()!==snapshot.head)return false
  const {names:candidates}=await changedPaths(snapshot.root,snapshot.base,snapshot.selection,config,signal);if(JSON.stringify(candidates)!==JSON.stringify(snapshot.candidates))return false
  for(const path of snapshot.changed){if(snapshot.files[path].deleted){try{await lstat(resolve(snapshot.root,path));return false}catch(error){if(error.code==='ENOENT')continue;throw error}}const current=await currentFile(snapshot.root,path,config.maxFileBytes);if((current?.hash??null)!==snapshot.files[path].hash)return false}
  return true
 }catch(error){if(signal?.aborted)throw error;return false}
}

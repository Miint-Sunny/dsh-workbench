import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseLocalReviewConfig, parseReviewInput, validateReviewFindings, reviewId } from '../lib/local-review-state.js'
import { captureReviewSnapshot, reviewSnapshotCurrent } from '../lib/local-review-snapshot.js'
import { createLocalReviewStore } from '../lib/local-review-store.js'
const config=parseLocalReviewConfig()
async function project(t){const scratch=fileURLToPath(new URL('../.local/',import.meta.url));await mkdir(scratch,{recursive:true});const dir=await mkdtemp(join(scratch,'review-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const git=(...args)=>execFileSync('git',['-C',dir,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{stdio:'pipe'});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await writeFile(join(dir,'sample.js'),'export const value = 1\n');git('add','sample.js');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial');return{dir,git}}
test('review 参数只接受明确范围，不把分支名作为 shell',()=>{
 assert.deepEqual(parseReviewInput(''),{mode:'uncommitted',base:null,untracked:false})
 assert.deepEqual(parseReviewInput('--base main --untracked'),{mode:'branch',base:'main',untracked:true})
 for(const bad of ['--base','--base -c','--base main;touch-x','--base main --unknown','uncommitted && echo x'])assert.throws(()=>parseReviewInput(bad))
})
test('采集已暂存/未暂存；未跟踪需选择，凭据/二进制/符号链接被列为未审查',async t=>{
 const{dir,git}=await project(t);await writeFile(join(dir,'sample.js'),'export const value = 2\n');git('add','sample.js');await writeFile(join(dir,'sample.js'),'export const value = 3\n');await writeFile(join(dir,'extra.js'),'extra\n');await writeFile(join(dir,'.env'),'SYNTHETIC_SECRET=DO_NOT_SEND\n');await writeFile(join(dir,'blob.bin'),Buffer.from([0,1,2]));await symlink('sample.js',join(dir,'alias.js'))
 const index=await readFile(join(dir,'.git/index'));const first=await captureReviewSnapshot(dir,parseReviewInput(''),config)
 assert.deepEqual(first.changed,['sample.js']);assert(first.patch.includes('value = 3'));assert.equal(first.files['sample.js'].content,'export const value = 3\n')
 const all=await captureReviewSnapshot(dir,parseReviewInput('uncommitted --untracked'),config)
 assert(all.changed.includes('extra.js'));assert(all.skipped.some(x=>x.path==='.env'&&x.reason==='sensitive'));assert(all.skipped.some(x=>x.path==='blob.bin'&&x.reason==='binary'));assert(all.skipped.some(x=>x.path==='alias.js'&&x.reason==='symlink'))
 assert(!JSON.stringify(all).includes('DO_NOT_SEND'));assert.deepEqual(await readFile(join(dir,'.git/index')),index)
 assert.equal(await reviewSnapshotCurrent(all,config),true);await writeFile(join(dir,'sample.js'),'changed after review\n');assert.equal(await reviewSnapshotCurrent(all,config),false)
})
test('分支比较含已提交及未提交内容，内容过滤器不执行',async t=>{
 const{dir,git}=await project(t);git('branch','baseline');await writeFile(join(dir,'sample.js'),'committed\n');git('commit','-qam','second');await writeFile(join(dir,'sample.js'),'working\n')
 const data=await captureReviewSnapshot(dir,parseReviewInput('--base baseline'),config);assert(data.patch.includes('-export const value = 1'));assert(data.patch.includes('+working'))
 await writeFile(join(dir,'.gitattributes'),'sample.js filter=unsafe\n');git('config','filter.unsafe.clean','touch SHOULD_NOT_EXIST')
 const filtered=await captureReviewSnapshot(dir,parseReviewInput(''),config);assert(filtered.skipped.some(x=>x.path==='sample.js'&&x.reason==='filter'));await assert.rejects(readFile(join(dir,'SHOULD_NOT_EXIST')))
})
test('审查结果只接受快照文件和有效行，重复发现合并，描述作为纯文本',()=>{
 const snap={files:{'sample.js':{content:'line one\nline two\n',lines:2}},changed:['sample.js']}
 const finding={path:'sample.js',line:1,severity:'medium',title:'<script>plain text</script>',description:'trigger and impact'}
 assert.equal(validateReviewFindings([finding,finding],snap,config).length,1)
 for(const next of [{...finding,path:'../secret'},{...finding,path:'other.js'},{...finding,line:3},{...finding,severity:'critical'}])assert.throws(()=>validateReviewFindings([next],snap,config))
})
test('报告状态持久化，修复与忽略只改报告，不修改项目',async t=>{
 const{dir}=await project(t),store=createLocalReviewStore(join(dir,'reports'),config),record={id:reviewId('parent'),parentId:'parent',created:1,status:'completed',findings:[]}
 await store.save(record);assert.deepEqual(await store.read(record.id),record);const reopened=createLocalReviewStore(join(dir,'reports'),config);assert.equal((await reopened.list('parent')).length,1)
 await assert.rejects(store.read('../escape'))
})

test('审查作业可取消、重复开始共用作业，关闭父会话等待执行者停止',async t=>{
 const{dir}=await project(t);await writeFile(join(dir,'sample.js'),'changed\n');const entered=Promise.withResolvers();let stopParent,stopped=false
 const {createLocalReviewManager}=await import('../lib/local-review-manager.js');const manager=createLocalReviewManager({dir:join(dir,'.reports'),config,run:async(_r,signal)=>{entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));stopped=true}});t.after(()=>manager.dispose())
 const parent={id:'parent',ctx:{effect:fn=>{stopParent=fn();return()=>Promise.resolve()}}},args={cwd:dir,selection:parseReviewInput(''),model:{provider:'fake',model:'fake'}}
 const a=await manager.start(parent,args),b=await manager.start(parent,args);assert.equal(a.id,b.id);await entered.promise;await stopParent();assert.equal(stopped,true);assert.equal((await manager.get(a.id)).status,'cancelled')
})

test('报告重开后仍可准备和确认修复；变更文件拒绝旧请求，忽略与待验证可恢复',async t=>{
 const{dir}=await project(t);await writeFile(join(dir,'sample.js'),'changed\n');const {createLocalReviewManager}=await import('../lib/local-review-manager.js');let manager=createLocalReviewManager({dir:join(dir,'.reports'),config,run:async r=>manager.submit(r.id,[{path:'sample.js',line:1,severity:'low',title:'finding',description:'trigger'}])});t.after(()=>manager.dispose());const parent={id:'parent',ctx:{effect:()=>()=>Promise.resolve()}}
 const a=await manager.start(parent,{cwd:dir,selection:parseReviewInput(''),model:{provider:'fake',model:'fake'}});await manager.active.get(a.id).promise;let record=await manager.get(a.id);assert.equal(record.status,'completed');await manager.dispose()
 manager=createLocalReviewManager({dir:join(dir,'.reports'),config,run:()=>{throw Error('must not run')}});record=await manager.get(a.id);const draft=await manager.prepare(a.id,record.findings[0].id,dir,record.revision);await manager.accepted('parent',draft.requestId);assert.equal((await manager.get(a.id)).findings[0].status,'pending')
 await writeFile(join(dir,'sample.js'),'changed again\n');record=await manager.get(a.id);await assert.rejects(manager.prepare(a.id,record.findings[0].id,dir,record.revision),e=>e.code==='stale');assert.equal((await manager.inspect(a.id)).stale,true)
})

test('超大文件列为未审查；未知分支有明确错误',async t=>{
 const{dir}=await project(t);await writeFile(join(dir,'sample.js'),'x'.repeat(512));const snapshot=await captureReviewSnapshot(dir,parseReviewInput(''),{...config,maxFileBytes:128});assert.deepEqual(snapshot.changed,[]);assert.equal(snapshot.skipped[0].reason,'large');await assert.rejects(captureReviewSnapshot(dir,parseReviewInput('--base missing'),config),e=>e.code==='unknown-base')
})

test('暂存删除和分支内提交删除保留真实删除差异，不伪造新增文件',async t=>{
 const{dir,git}=await project(t);git('branch','base');git('rm','sample.js')
 let snapshot=await captureReviewSnapshot(dir,parseReviewInput(''),config)
 assert.equal(snapshot.files['sample.js'].deleted,true);assert(snapshot.patch.includes('deleted file mode'));assert(snapshot.patch.includes('+++ /dev/null'));assert(!snapshot.patch.includes('New file:'))
 git('commit','-qm','delete')
 snapshot=await captureReviewSnapshot(dir,parseReviewInput('--base base'),config)
 assert.equal(snapshot.files['sample.js'].deleted,true);assert(snapshot.patch.includes('deleted file mode'));assert(!snapshot.patch.includes('New file:'))
})
test('从索引删除后留下的未跟踪副本不会被当作受控文件读取',async t=>{
 const{dir,git}=await project(t);git('rm','--cached','sample.js');await writeFile(join(dir,'sample.js'),'UNTRACKED_PRIVATE_COPY\n')
 const snapshot=await captureReviewSnapshot(dir,parseReviewInput(''),config)
 assert(!JSON.stringify(snapshot).includes('UNTRACKED_PRIVATE_COPY'));assert(snapshot.skipped.some(s=>s.path==='sample.js'))
})
test('连续审查后旧报告被缓存淘汰，仍能从持久化报告重开',async t=>{
 const{dir}=await project(t);await writeFile(join(dir,'sample.js'),'changed\n')
 const{createLocalReviewManager}=await import('../lib/local-review-manager.js'),{reviewHash}=await import('../lib/local-review-state.js');const reports=join(dir,'reports');let manager
 manager=createLocalReviewManager({dir:reports,config:{...config,maxCachedReports:1},run:r=>manager.submit(r.id,[])});t.after(()=>manager.dispose())
 const parent={id:'parent',ctx:{effect:()=>()=>Promise.resolve()}},ids=[]
 for(let i=0;i<4;i++){const report=await manager.start(parent,{cwd:dir,selection:parseReviewInput(''),model:{provider:'fake',model:'fake'}});ids.push(report.id);await manager.active.get(report.id).promise}
 const file=join(reports,reviewHash(parent.id),ids[0]+'.json'),body=await readFile(file);await rm(file)
 await assert.rejects(manager.get(ids[0]),e=>e.code==='report-not-found')
 await writeFile(file,body);const old=await manager.get(ids[0]);assert.equal(old.status,'completed');assert(old.snapshot.files['sample.js'])
})

for (const mode of ['untracked', 'tracked', 'deleted']) {
 test(`TW-005 ${mode} credential variants never enter review files or patch`, async t => {
  const {dir,git}=await project(t)
  const names=['keys.env','keys.env.local','config/service.credentials.yaml','config/Service.CREDENTIALS.YML','cloud.credentials.json',
   'id_ecdsa','id_ecdsa_sk','id_ed25519_sk','.envrc','prod.env','app.env','.netrc','_netrc','.npmrc','.pypirc','.git-credentials','.pgpass','.vault-token','.docker/config.json','.kube/config','secrets.toml','.streamlit/secrets.toml','secret.json','client_secret_fixture.json','service-account.json','service_account_fixture.json','release.keystore','upload.jks','putty.ppk','AuthKey_fixture.p8','terraform.tfvars']
  await mkdir(join(dir,'config'))
  for(const name of names){await mkdir(dirname(join(dir,name)),{recursive:true});await writeFile(join(dir,name),'SYNTHETIC_TW005_DO_NOT_SEND=before\n')}
  if(mode!=='untracked'){
   git('add','--',...names);git('commit','-qm','credential filename fixtures')
   for(const name of names)if(mode==='deleted')await rm(join(dir,name));else await writeFile(join(dir,name),'SYNTHETIC_TW005_DO_NOT_SEND=after\n')
  }
  await writeFile(join(dir,'sample.js'),'export const value = 2\n')
  await writeFile(join(dir,'credentials.js'),'ordinary source\n')
  const snapshot=await captureReviewSnapshot(dir,parseReviewInput(mode==='untracked'?'--untracked':''),config)
  for(const name of names){
   assert.ok(snapshot.skipped.some(item=>item.path===name&&item.reason==='sensitive'),name)
   assert.equal(Object.hasOwn(snapshot.files,name),false)
   assert.equal(snapshot.changed.includes(name),false)
  }
  assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC_TW005_DO_NOT_SEND'),false)
  assert.ok(snapshot.patch.includes('value = 2'))
  if(mode==='untracked')assert.equal(snapshot.files['credentials.js'].content,'ordinary source\n')
 })
}


const syntheticBody = Buffer.from('SYNTHETIC_PRIVATE_BODY_NEVER_SEND').toString('base64')
function puttyBlock(version=3,algorithm='ssh-ed25519') {
 return ['PuTTY-User-Key-File-'+version+': '+algorithm,'Encryption: none','Comment: fixture',
  'Public-Lines: 1',syntheticBody,'Private-Lines: 1',syntheticBody,'Private-MAC: fixture',''].join('\n')
}
function pemBlock(type,body=syntheticBody,{eol='\n',indent='',headers=[]}={}){
 return [`${indent}${'-----BEGIN'} ${type}PRIVATE KEY-----`,...headers.map(h=>`${indent}${h}`),`${indent}${body}`,`${indent}${'-----END'} ${type}PRIVATE KEY-----`,''].join(eol)
}

for (const mode of ['untracked', 'tracked-before', 'tracked-after', 'deleted']) {
 test(`TW-005 rework private-key content in ${mode} files is never included in the snapshot or patch`,async t=>{
  const{dir,git}=await project(t)
  const blocks=[pemBlock(''),pemBlock('RSA '),pemBlock('EC '),pemBlock('OPENSSH '),pemBlock('ENCRYPTED '),puttyBlock()]
  const names=blocks.map((_,i)=>`notes-${i}.txt`)
  for(let i=0;i<names.length;i++)await writeFile(join(dir,names[i]),mode==='tracked-after'?'ordinary old text\n':blocks[i])
  if(mode!=='untracked'){
   git('add','--',...names);git('commit','-qm','private-key content fixtures')
   for(let i=0;i<names.length;i++)if(mode==='deleted')await rm(join(dir,names[i]));else await writeFile(join(dir,names[i]),mode==='tracked-before'?'ordinary replacement\n':blocks[i])
  }
  await writeFile(join(dir,'sample.js'),'export const value = 2\n')
  await writeFile(join(dir,'id_ecdsa.pub'),'ssh-ecdsa public fixture\n')
  const snapshot=await captureReviewSnapshot(dir,parseReviewInput(mode==='untracked'?'--untracked':''),config)
  for(const name of names){assert(snapshot.skipped.some(x=>x.path===name&&x.reason==='sensitive'),name);assert.equal(Object.hasOwn(snapshot.files,name),false)}
  assert.equal(JSON.stringify(snapshot).includes(syntheticBody),false)
  assert(snapshot.patch.includes('value = 2'))
  if(mode==='untracked')assert.equal(snapshot.files['id_ecdsa.pub'].content,'ssh-ecdsa public fixture\n')
 })
}

test('TW-005 rework the review runner receives no sensitive file body or patch',async t=>{
 const{dir}=await project(t)
 await writeFile(join(dir,'notes.txt'),pemBlock('OPENSSH '))
 await writeFile(join(dir,'.npmrc'),'SYNTHETIC_CREDENTIAL_BODY_NEVER_SEND\n')
 await writeFile(join(dir,'sample.js'),'export const value = 2\n')
 const{createLocalReviewManager}=await import('../lib/local-review-manager.js');let sent,manager
 manager=createLocalReviewManager({dir:join(dir,'.reports'),config,run:async record=>{sent=JSON.stringify(record.snapshot);await manager.submit(record.id,[])}})
 t.after(()=>manager.dispose())
 const report=await manager.start({id:'parent',ctx:{effect:()=>()=>Promise.resolve()}},{cwd:dir,selection:parseReviewInput('--untracked'),model:{provider:'fixture',model:'fixture'}})
 await manager.active.get(report.id).promise
 assert.equal((await manager.get(report.id)).status,'completed')
 assert.equal(typeof sent,'string')
 assert(!sent.includes(syntheticBody))
 assert(!sent.includes('SYNTHETIC_CREDENTIAL_BODY_NEVER_SEND'))
})

test('TW-005 rework newly staged files are filtered without requiring a nonexistent base version',async t=>{
 const{dir,git}=await project(t)
 await writeFile(join(dir,'new-private.txt'),puttyBlock(2,'ssh-rsa'))
 await writeFile(join(dir,'new-source.js'),'export const ordinary = true\n')
 git('add','new-private.txt','new-source.js')
 const snapshot=await captureReviewSnapshot(dir,parseReviewInput(''),config)
 assert(snapshot.skipped.some(x=>x.path==='new-private.txt'&&x.reason==='sensitive'))
 assert.equal(snapshot.files['new-source.js'].content,'export const ordinary = true\n')
 assert(!snapshot.patch.includes(syntheticBody))
})

for (const mode of ['untracked', 'tracked']) {
 test(`fix#175 full private-key blocks in ${mode} PEM, encrypted, PuTTY, YAML, JSON and escaped strings are skipped`,async t=>{
  const{dir,git}=await project(t)
  const sensitiveFixtures={
   'keys/pem-lf.txt':pemBlock('OPENSSH '),
   'keys/pem-crlf.txt':pemBlock('OPENSSH ',syntheticBody,{eol:'\r\n'}),
   'keys/rsa-encrypted.txt':pemBlock('RSA ',syntheticBody,{headers:['Proc-Type: 4,ENCRYPTED','DEK-Info: AES-128-CBC,ABCDEF','']}),
   'keys/pkcs8-encrypted.txt':pemBlock('ENCRYPTED '),
   'keys/putty-plain.txt':puttyBlock(),
   'keys/putty-indented.txt':'putty:\n'+puttyBlock().replace(/^/gm,'  '),
   'notes/with-key.md':`review notes before\n${pemBlock('OPENSSH ')}\nnotes after\n`,
   'config/tls.yml':`tls:\n  key: |\n${pemBlock('RSA ',syntheticBody,{indent:'    '})}`,
   'deploy/my-project-123456-0a1b2c3d4e5f.json':`${JSON.stringify({type:'service_account',private_key:pemBlock('')},null,2)}\n`,
   'src/inline-escaped-lf.js':`export const k = ${JSON.stringify(pemBlock(''))}\n`,
   'src/inline-escaped-crlf.js':`export const k = ${JSON.stringify(pemBlock('',syntheticBody,{eol:'\r\n'}))}\n`,
  }
  for(const[rel,content]of Object.entries(sensitiveFixtures)){
   await mkdir(dirname(join(dir,rel)),{recursive:true})
   await writeFile(join(dir,rel),mode==='tracked'?'ordinary placeholder\n':content)
  }
  if(mode==='tracked'){
   git('add','--',...Object.keys(sensitiveFixtures));git('commit','-qm','baseline ordinary files')
   for(const[rel,content]of Object.entries(sensitiveFixtures))await writeFile(join(dir,rel),content)
  }
  await writeFile(join(dir,'sample.js'),'export const value = 2\n')
  const snapshot=await captureReviewSnapshot(dir,parseReviewInput(mode==='untracked'?'--untracked':''),config)
  for(const rel of Object.keys(sensitiveFixtures)){
   assert(snapshot.skipped.some(entry=>entry.path===rel&&entry.reason==='sensitive'),rel)
   assert.equal(Object.hasOwn(snapshot.files,rel),false,rel)
  }
  assert.equal(JSON.stringify(snapshot).includes(syntheticBody),false)
  assert(snapshot.patch.includes('value = 2'))
 })

 test(`fix#175 header-only mentions in ${mode} source, tests and docs remain reviewable`,async t=>{
  const{dir,git}=await project(t)
  const reviewable={
   'snapshot-source.js':await readFile(new URL('../lib/local-review-snapshot.js',import.meta.url),'utf8'),
   'local-review-test.mjs':await readFile(new URL('./local-review.test.mjs',import.meta.url),'utf8'),
   'docs/pem-header.md':`Paste the block starting with ${'-----BEGIN'} OPENSSH PRIVATE KEY----- into the store.\n`,
   'docs/same-line-headers.md':`Format: ${'-----BEGIN'} RSA PRIVATE KEY----- ... ${'-----END'} RSA PRIVATE KEY-----\n`,
   'docs/putty-header.md':`Putty files start with ${['PuTTY-User-Key-File-3:', 'ssh-ed25519'].join(' ')} on line 1.\n`,
   'docs/mismatched-headers.md':`${'-----BEGIN'} RSA PRIVATE KEY-----\nexample\n${'-----END'} OPENSSH PRIVATE KEY-----\n`,
  }
  for(const[rel,content]of Object.entries(reviewable)){
   await mkdir(dirname(join(dir,rel)),{recursive:true})
   await writeFile(join(dir,rel),content)
  }
  if(mode==='tracked'){
   git('add','--',...Object.keys(reviewable));git('commit','-qm','header-only source and docs')
   for(const[rel,content]of Object.entries(reviewable))await writeFile(join(dir,rel),`${content}// reviewed\n`)
  }
  const snapshot=await captureReviewSnapshot(dir,parseReviewInput(mode==='untracked'?'--untracked':''),config)
  for(const[rel,content]of Object.entries(reviewable)){
   assert.ok(snapshot.changed.includes(rel),rel)
   assert.equal(snapshot.files[rel].content,mode==='tracked'?`${content}// reviewed\n`:content,rel)
   assert.equal(snapshot.skipped.some(entry=>entry.path===rel),false,rel)
  }
  assert(snapshot.patch.includes('snapshot-source.js'))
 })
}

test('serialized key blocks stay out of reviews while examples without a body stay visible', async t => {
 const {dir}=await project(t)
 const dummy=Buffer.from('fixture payload for a synthetic key, not a cryptographic key').toString('base64')
 const pem=pemBlock('RSA ',dummy).trim()
 const putty=['PuTTY-User-Key-File-3: ssh-ed25519','Encryption: none','Comment: fixture','Public-Lines: 1',dummy,'Private-Lines: 1',dummy,'Private-MAC: fixture'].join('\n')
 const sensitiveFiles={
  'folded.yaml':pem.replaceAll('\n',' '),
  'joined.toml':pem.replaceAll('\n',''),
  'nested.json':JSON.stringify({value:JSON.stringify({key:pem})}),
  'putty.json':JSON.stringify({key:putty}),
  'putty.yaml':"key: '"+putty+"'",
 }
 const reviewableFiles={
  'empty.md':pemBlock('RSA ',''),
  'putty-header.md':putty.split('\n')[0]+'\n',
  'markers.md':pemBlock('RSA ','...'),
 }
 for(const [name,value] of Object.entries({...sensitiveFiles,...reviewableFiles})) await writeFile(join(dir,name),value)
 const snapshot=await captureReviewSnapshot(dir,parseReviewInput('--untracked'),config)
 assert.deepEqual(snapshot.skipped.filter(row=>row.reason==='sensitive').map(row=>row.path).sort(),Object.keys(sensitiveFiles).sort())
 assert.deepEqual(snapshot.changed.sort(),Object.keys(reviewableFiles).sort())
 assert(!snapshot.patch.includes(dummy))
})

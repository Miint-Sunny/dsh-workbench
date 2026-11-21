import test from 'node:test'
import assert from 'node:assert/strict'
import{mkdir,mkdtemp,rm,writeFile,copyFile,chmod}from'node:fs/promises'
import{join}from'node:path'
import{fileURLToPath}from'node:url'
import{simpleArgv,approvalPattern,patternMatches,parseApprovalRulesConfig,ruleMatches}from'../lib/approval-rules-state.js'
import{createApprovalRuleStore}from'../lib/approval-rules-store.js'
import{createExecutableInspector}from'../lib/approval-rules-executable.js'
const config=parseApprovalRulesConfig()
async function temp(t){const base=fileURLToPath(new URL('../.local/',import.meta.url));await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'rules-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
test('简单 argv 保留参数边界；复合命令、展开、赋值、引号和转义一律拒绝',()=>{
 assert.deepEqual(simpleArgv('git status --short'),['git','status','--short'])
 for(const text of ['git status && echo x','git status; echo x','git status | cat','git status > out','echo $(id)','echo $HOME','echo ~','echo *','echo [a]','echo `id`','A=1 git status','git status\necho x','echo "two words"','echo a\\ b','(git status)','git status &'])assert.throws(()=>simpleArgv(text),{code:'not-simple'})
})
test('规则按完整 argv 匹配，git status 只有明确选中的有限尾参数',()=>{
 const proposal=approvalPattern(['git','status','--short']);assert.deepEqual(proposal.fixed,['status']);assert.deepEqual(proposal.required,['--short'])
 const pattern={fixed:proposal.fixed,optional:['--short','--branch']}
 assert(patternMatches(pattern,['status']));assert(patternMatches(pattern,['status','--branch','--short']))
 for(const args of [['status-anything'],['status','--short','--short'],['status','--ignored'],['status','--short','file']])assert.equal(patternMatches(pattern,args),false)
 assert.deepEqual(approvalPattern(['/bin/echo','hello']),{fixed:['hello'],required:[],offered:[]})
})
test('禁用、项目/目录、程序/环境变化都不命中',()=>{
 const candidate={project:{key:'p'},cwd:'/p',identity:'native-identity',argv:['git','status']},rule={enabled:true,projectKey:'p',cwd:'/p',identity:'native-identity',pattern:{fixed:['status'],optional:[]}}
 assert(ruleMatches(rule,candidate))
 for(const changed of [{...rule,enabled:false},{...rule,projectKey:'q'},{...rule,cwd:'/p/sub'},{...rule,identity:'new-program'}])assert.equal(ruleMatches(changed,candidate),false)
})
test('保存规则持久化、修订冲突、请求撤回不写入，审计只接受受信任结构',async t=>{
 const dir=await temp(t),store=createApprovalRuleStore(join(dir,'approval-rules.json'),config),candidate={project:{key:'p',path:'/p'},cwd:'/p',executable:'/bin/echo',identity:'id',sandboxMode:'workspace-write',argv:['echo','hello']}
 const first=await store.create(0,candidate,[],()=>true);assert.equal(first.rules.length,1);assert.equal((await createApprovalRuleStore(join(dir,'approval-rules.json'),config).read()).rules.length,1)
 await assert.rejects(store.create(0,candidate,[],()=>true),{code:'state-changed'})
 await assert.rejects(store.create(first.revision,candidate,[],()=>false),{code:'request-ended'})
 const changed=await store.change(first.revision,first.rules[0].id,'disable');assert.equal(changed.rules[0].enabled,false)
})
test('程序内容改变会改变身份，脚本包装与越界程序不会被当作原生二进制',async t=>{
 const dir=await temp(t),file=join(dir,'native');await copyFile('/bin/echo',file);await chmod(file,0o755)
 const inspect=createExecutableInspector({...config,executableRoots:[dir]});const before=await inspect.file(file);await writeFile(file,Buffer.concat([await(await import('node:fs/promises')).readFile(file),Buffer.from('changed')]));const after=await inspect.file(file);assert.notEqual(after.hash,before.hash)
 const script=join(dir,'wrapper');await writeFile(script,'#!/bin/sh\necho wrapper\n');await chmod(script,0o755);await assert.rejects(inspect.file(script),{code:'unverified-executable'});await assert.rejects(inspect.file('/bin/echo'),{code:'unverified-executable'})
})

test('写入途中撤回请求，临时文件不成为有效规则',async t=>{
 const dir=await temp(t),store=createApprovalRuleStore(join(dir,'rules.json'),config)
 const candidate={project:{key:'p',path:'/p'},cwd:'/p',executable:'/bin/echo',identity:'id',sandboxMode:'read-only',argv:['echo','hello']}
 let checks=0;await assert.rejects(store.create(0,candidate,[],()=>++checks===1),{code:'request-ended'})
 assert.deepEqual((await store.read()).rules,[])
})

test('规则在审计等待期间被停用或请求被撤回，都不能自动答复',async t=>{
 const dir=await temp(t),store=createApprovalRuleStore(join(dir,'rules.json'),config)
 class LocalBashExecutor {resolve(r){return{...r,stdoutMaxBytes:100}}spawnSpec(r,argv){return{argv,cwd:r.workdir,env:{GIT_PAGER:'cat'}}}}
 let listener
 const agent={id:'s',session:{id:'s',header:{cwd:dir}},ctx:{on:(_name,fn)=>{listener=fn;return()=>{}}}}
 const ctx={agents:{list:()=>[agent],get:()=>agent},agentPresets:{presetForSession:()=>null,serviceFor:()=>undefined},approval:{effectivePolicy:()=> 'ask'},workingDirectory:{get:()=>dir},sandboxPolicy:{resolve:()=>({mode:'read-only'})},shell:new LocalBashExecutor(),subprocess:{resolveExecutable:async command=>command==='bash'?'/bin/bash':command}}
 const args={description:'QA',command:'/bin/echo hello'},inspector=createExecutableInspector(config),candidate=await inspector.inspect(ctx,{agent},args,new AbortController().signal);let state=await store.create(0,candidate,[],()=>true)
 let release,entered
 const wrapped={...store,audit:async record=>{if(record.kind==='match-attempt'){entered.resolve();await release.promise}return store.audit(record)}}
 const{createApprovalRulesManager}=await import('../lib/approval-rules-manager.js'),manager=createApprovalRulesManager({ctx,config,store:wrapped});t.after(()=>manager.dispose());await manager.start()
 async function ask(id,signal){manager.onEvent(agent.session,{type:'tool/call',data:{name:'bash',callId:id,arguments:JSON.stringify(args)}});manager.onEvent(agent.session,{type:'approval/asked',data:{toolName:'bash',callId:id,id:'approval-'+id}});return listener({agent,toolName:'bash',callId:id,signal},async()=> 'rejected')}
 entered=Promise.withResolvers();release=Promise.withResolvers();const first=ask('one',new AbortController().signal);await entered.promise;state=await store.change(state.revision,state.rules[0].id,'disable');release.resolve();assert.equal(await first,'rejected')
 state=await store.change(state.revision,state.rules[0].id,'enable');entered=Promise.withResolvers();release=Promise.withResolvers();const controller=new AbortController(),second=ask('two',controller.signal);await entered.promise;controller.abort();release.resolve();assert.equal(await second,'cancelled')
 assert.equal((await manager.list()).matches,0)
})

test('审计后规则文件损坏时，不得用缓存许可自动答复',async t=>{
 const dir=await temp(t),file=join(dir,'rules.json'),store=createApprovalRuleStore(file,config)
 class LocalBashExecutor {resolve(r){return{...r,stdoutMaxBytes:100}}spawnSpec(r,argv){return{argv,cwd:r.workdir,env:{GIT_PAGER:'cat'}}}}
 let listener;const agent={id:'s',session:{id:'s',header:{cwd:dir}},ctx:{on:(_name,fn)=>{listener=fn;return()=>{}}}}
 const ctx={agents:{list:()=>[agent],get:()=>agent},agentPresets:{presetForSession:()=>null,serviceFor:()=>undefined},approval:{effectivePolicy:()=> 'ask'},workingDirectory:{get:()=>dir},sandboxPolicy:{resolve:()=>({mode:'read-only'})},shell:new LocalBashExecutor(),subprocess:{resolveExecutable:async command=>command==='bash'?'/bin/bash':command}}
 const args={description:'QA',command:'/bin/echo hello'},candidate=await createExecutableInspector(config).inspect(ctx,{agent},args,new AbortController().signal);await store.create(0,candidate,[],()=>true)
 const wrapped={...store,audit:async record=>{await store.audit(record);if(record.kind==='match-attempt')await writeFile(file,'{corrupt')}}
 const{createApprovalRulesManager}=await import('../lib/approval-rules-manager.js'),manager=createApprovalRulesManager({ctx,config,store:wrapped});t.after(()=>manager.dispose());await manager.start()
 manager.onEvent(agent.session,{type:'tool/call',data:{name:'bash',callId:'one',arguments:JSON.stringify(args)}});manager.onEvent(agent.session,{type:'approval/asked',data:{toolName:'bash',callId:'one',id:'approval-one'}})
 let manual=0;const outcome=await listener({agent,toolName:'bash',callId:'one',signal:new AbortController().signal},async()=>{manual++;return'rejected'});assert.equal(outcome,'rejected');assert.equal(manual,1)
})

test('保护路径引发的审批请求，即使规则匹配也不得自动代答，也不能保存新规则',async t=>{
 const dir=await temp(t),store=createApprovalRuleStore(join(dir,'rules.json'),config)
 class LocalBashExecutor {resolve(r){return{...r,stdoutMaxBytes:100}}spawnSpec(r,argv){return{argv,cwd:r.workdir,env:{GIT_PAGER:'cat'}}}}
 let listener;const agent={id:'s',session:{id:'s',header:{cwd:dir}},ctx:{on:(_name,fn)=>{listener=fn;return()=>{}}}}
 const ctx={agents:{list:()=>[agent],get:()=>agent},agentPresets:{presetForSession:()=>null,serviceFor:()=>undefined},approval:{effectivePolicy:()=> 'ask'},workingDirectory:{get:()=>dir},sandboxPolicy:{resolve:()=>({mode:'read-only'})},shell:new LocalBashExecutor(),subprocess:{resolveExecutable:async command=>command==='bash'?'/bin/bash':command}}
 const args={description:'QA',command:'/bin/echo hello'},candidate=await createExecutableInspector(config).inspect(ctx,{agent},args,new AbortController().signal);await store.create(0,candidate,[],()=>true)
 const{createApprovalRulesManager}=await import('../lib/approval-rules-manager.js'),manager=createApprovalRulesManager({ctx,config,store});t.after(()=>manager.dispose());await manager.start()
 const{WORKSPACE_GUARD_REASON_PREFIX}=await import('../lib/workspace-guard-copy.js')
 const guardReason=`${WORKSPACE_GUARD_REASON_PREFIX}protected`
 manager.onEvent(agent.session,{type:'tool/call',data:{name:'bash',callId:'guard-1',arguments:JSON.stringify(args)}})
 manager.onEvent(agent.session,{type:'approval/asked',data:{toolName:'bash',callId:'guard-1',id:'approval-guard-1',reason:guardReason}})
 let manual=0,inspected;const outcome=await listener({agent,toolName:'bash',callId:'guard-1',reason:guardReason,signal:new AbortController().signal},async()=>{manual++;inspected=await manager.inspect('s','guard-1');return'rejected'})
 assert.equal(outcome,'rejected');assert.equal(manual,1)
 assert.deepEqual(inspected,{eligible:false,reason:'protected-target'})
})

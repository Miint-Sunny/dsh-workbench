import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createMemoryStore, memoryProject, parseMemoryConfig, memoryEligible } from '../lib/memory-store.js'

async function fixture(t) { const root=await mkdtemp(join(tmpdir(),'dwb-memory-'));t.after(()=>rm(root,{recursive:true,force:true}));const a=join(root,'a'),b=join(root,'b');await mkdir(a);await mkdir(b);return{root,a,b,store:createMemoryStore({root:join(root,'data'),maxBytes:1024})} }
test('two sessions in the same project share a revision; other projects remain empty',async t=>{
 const{a,b,store}=await fixture(t);const first=await store.view(a);assert.equal(first.exists,false)
 const saved=await store.write(a,{content:'约定：测试用 node --test。',revision:first.revision})
 assert.equal((await store.view(a)).content,'约定：测试用 node --test。\n');assert.equal((await store.view(b)).exists,false)
 assert.match(await readFile(saved.file,'utf8'),/项目路径：/)
 await assert.rejects(store.write(a,{content:'旧会话写入',revision:first.revision}),/已变化/)
})
test('real git worktrees resolve the same common directory; symlinked workspace resolves the same key',async t=>{
 const{root,a,store}=await fixture(t);const git=(...args)=>execFileSync('git',['-C',a,...args],{stdio:'pipe'})
 git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture')
 const other=join(root,'worktree');git('worktree','add','-q','-b','fixture-worktree',other)
 assert.equal((await memoryProject(a)).key,(await memoryProject(other)).key)
 const link=join(root,'alias');await symlink(a,link);assert.equal((await memoryProject(a)).key,(await memoryProject(link)).key)
 const read=await store.view(a);await store.write(a,{content:'共享约定',revision:read.revision});assert.match((await store.view(other)).content,/共享约定/)
})
test('maxBytes counts UTF-8 and header, oversize preserves existing file',async t=>{
 const{a,store}=await fixture(t);const first=await store.view(a)
 await assert.rejects(store.write(a,{content:'中'.repeat(1000),revision:first.revision}),/先整理/)
 assert.equal((await store.view(a)).exists,false)
})
test('concurrent writes cannot silently overwrite one another; external edits invalidate revision',async t=>{
 const{a,store}=await fixture(t);const first=await store.view(a)
 const results=await Promise.allSettled(['甲','乙'].map(content=>store.write(a,{content,revision:first.revision})))
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const read=await store.view(a);await writeFile(read.file,(await readFile(read.file,'utf8'))+'用户补充\n')
 await assert.rejects(store.write(a,{content:'覆盖',revision:read.revision}),/已变化/)
})
test('memory file symlink is refused instead of reading another project',async t=>{
 const{a,b,store}=await fixture(t);const read=await store.view(a);await mkdir(join(read.file,'..'),{recursive:true});const outside=join(b,'private');await writeFile(outside,'其他项目');await symlink(outside,read.file)
 await assert.rejects(store.view(a),/链接|ELOOP/)
 assert.equal(await readFile(outside,'utf8'),'其他项目')
})
test('preset exclusions and configuration are explicit',()=>{
 const config=parseMemoryConfig();assert.equal(config.maxBytes,16384)
 for(const agentPreset of ['whale','whale-dream','whale-custom'])assert.equal(memoryEligible({cwd:'/project',agentPreset},config),false)
 assert.equal(memoryEligible({cwd:'/project',agentPreset:'coding'},config),true)
 assert.equal(memoryEligible({},config),false)
 for(const x of [{maxBytes:0},{maxBytes:1.2},{skipPresets:['']},{skipPresets:'whale'}])assert.throws(()=>parseMemoryConfig(x))
})

test('子智能体来源或正委派深度排除记忆，普通会话保留', () => {
  const config = parseMemoryConfig(), base = { cwd: '/project', agentPreset: 'coding' }
  assert.equal(memoryEligible({ ...base, origin: 'subagent' }, config), false)
  assert.equal(memoryEligible({ ...base, origin: 'subagent', delegationDepth: 0 }, config), false)
  assert.equal(memoryEligible({ ...base, delegationDepth: 1 }, config), false)
  assert.equal(memoryEligible({ ...base, delegationDepth: 3 }, config), false)
  assert.equal(memoryEligible({ ...base, delegationDepth: 0 }, config), true)
  assert.equal(memoryEligible(base, config), true)
})

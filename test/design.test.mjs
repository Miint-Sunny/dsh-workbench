import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {designDeclarations,designValues,designMessage,designDraft} from '../lib/design-protocol.js'
import {createDesignStore,designExport} from '../lib/design-store.js'
import {createPagesStore} from '../lib/pages-store.js'
import {publishHtml} from '../lib/pages-publish.js'
import {cspReportScriptTag} from '../lib/pages-csp.js'
const declarations=[{name:'--space',label:'Spacing',type:'number',min:0,max:40,step:2,unit:'px',default:16},{name:'--accent',label:'Color',type:'color',default:'#334455'}]
const html=()=>'<html><head><title>QA</title><script type="application/json" id="dsh-design-parameters">'+JSON.stringify(declarations)+'</script></head><body><h1>Fixture</h1></body></html>'
async function root(t){const base=fileURLToPath(new URL('../.local/',import.meta.url));await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'design-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
test('只接受声明的 CSS 变量、范围步长和固定值类型',()=>{assert.deepEqual(designDeclarations(html()),declarations);assert.deepEqual(designValues({'--space':20,'--accent':'#abcdef'},declarations),{'--space':20,'--accent':'#abcdef'});for(const input of [{'background':'red'},{'--space':21},{'--space':Infinity},{'--accent':'url(https://bad.invalid)'}])assert.throws(()=>designValues(input,declarations));assert.throws(()=>designDeclarations(html().replace('--space','background')))})
test('选择消息拒绝过期通道、过长/非有限字段、URL 样式；页面数据没有宿主动作',()=>{const expected={nonce:'channel',board:'desktop',version:1};const msg={type:'selection',...expected,selection:{selector:'#heading',tag:'h1',rect:{x:1,y:2,width:120,height:30},styles:{color:'rgb(1, 2, 3)'}}};assert(designMessage(msg,expected));for(const bad of [{...msg,nonce:'old'},{...msg,version:2},{...msg,selection:{...msg.selection,selector:'x'.repeat(2050)}},{...msg,selection:{...msg.selection,rect:{...msg.selection.rect,x:NaN}}},{...msg,selection:{...msg.selection,styles:{color:'url(secret)'}}},{...msg,type:'execute',command:'write'}])assert.equal(designMessage(bad,expected),null)})
test('批次草稿限制数量和声明参数，评论版本与画板有明确定位',()=>{const d=designDraft({comments:[{id:'c1',board:'mobile',selector:'#title',tag:'h1',rect:{x:2,y:3,width:30,height:40},styles:{},text:'Make it clearer'}],params:{'--space':20}},declarations);assert.equal(d.comments[0].board,'mobile');assert.throws(()=>designDraft({...d,comments:[{...d.comments[0],text:'x'.repeat(4001)}]},declarations));assert.throws(()=>designDraft({...d,params:{'--other':10}},declarations))})
test('发布版本保留来源摘要；草稿恢复、修订冲突、源文件变化和新版本拒绝旧发送',async t=>{const dir=await root(t),pages=createPagesStore(join(dir,'pages'));await writeFile(join(dir,'page.html'),html());const published=await publishHtml(pages,{sessionId:'session-qa',path:'page.html',workspaceRoot:dir});const store=createDesignStore(join(dir,'drafts'),{pages,workspaceRootOf:async()=>dir});let data=await store.open(published.meta.id,1);assert.equal(data.sourceReady,true);let saved=await store.save(published.meta.id,1,0,{comments:[],params:{'--space':20}});const reopened=createDesignStore(join(dir,'drafts'),{pages,workspaceRootOf:async()=>dir});assert.equal((await reopened.open(published.meta.id,1)).draft.params['--space'],20);await assert.rejects(store.save(published.meta.id,1,0,{comments:[],params:{}}),e=>e.code==='draft-changed');let ready=await store.prepare(published.meta.id,1,saved.revision);assert(ready.requestId);assert.equal((await store.prepare(published.meta.id,1,ready.revision)).requestId,ready.requestId);await writeFile(join(dir,'page.html'),html()+'changed');await assert.rejects(store.prepare(published.meta.id,1,ready.revision),e=>e.code==='source-changed');await publishHtml(pages,{sessionId:'session-qa',path:'page.html',workspaceRoot:dir});await assert.rejects(store.prepare(published.meta.id,1,ready.revision),e=>e.code==='version-changed')})
test('默认导出发布版本且移除工作台报告桥；参数副本只插入受限 CSS',()=>{const source=html()+cspReportScriptTag();const out=designExport(source,declarations);assert(!out.includes('dwb-csp'));assert(!out.includes('dsh-design-bridge'));assert(out.includes('<h1>Fixture</h1>'));const preview=designExport(source,declarations,{'--space':20});assert(preview.includes('--space:20px'));assert.throws(()=>designExport(source,declarations,{'--accent':'</style><script>bad</script>'}))})

test('源摘要包括内联资源，资源改变即拒绝旧批次',async t=>{const dir=await root(t),pages=createPagesStore(join(dir,'pages'));await writeFile(join(dir,'style.css'),'body{color:red}');await writeFile(join(dir,'page.html'),html().replace('</head>','<link rel="stylesheet" href="style.css"></head>'));const published=await publishHtml(pages,{sessionId:'qa',path:'page.html',workspaceRoot:dir});assert(published.version.sourceRevision.files.some(f=>f.path==='style.css'));const store=createDesignStore(join(dir,'drafts'),{pages,workspaceRootOf:async()=>dir});const draft=await store.save(published.meta.id,1,0,{comments:[],params:{'--space':20}});await writeFile(join(dir,'style.css'),'body{color:blue}');await assert.rejects(store.prepare(published.meta.id,1,draft.revision),e=>e.code==='source-changed')})

for (const missing of ['page.html', 'style.css', 'workspace']) {
 test(`W-008 missing ${missing} is source-changed and preserves the draft`,async t=>{
  const dir=await root(t),workspace=join(dir,'workspace');await mkdir(workspace)
  const pages=createPagesStore(join(dir,'pages'))
  await writeFile(join(workspace,'style.css'),'body{color:red}')
  await writeFile(join(workspace,'page.html'),html().replace('</head>','<link rel="stylesheet" href="style.css"></head>'))
  const published=await publishHtml(pages,{sessionId:'qa',path:'page.html',workspaceRoot:workspace})
  const store=createDesignStore(join(dir,'drafts'),{pages,workspaceRootOf:async()=>workspace})
  const draft=await store.save(published.meta.id,1,0,{comments:[],params:{'--space':20}})
  await rm(missing==='workspace'?workspace:join(workspace,missing),{recursive:true})
  await assert.rejects(store.prepare(published.meta.id,1,draft.revision),e=>e.code==='source-changed')
  assert.deepEqual((await store.open(published.meta.id,1)).draft,draft)
 })
}

test('W-008 workspace service failures keep their original classification',async t=>{
 const dir=await root(t),pages=createPagesStore(join(dir,'pages'));await writeFile(join(dir,'page.html'),html())
 const published=await publishHtml(pages,{sessionId:'qa',path:'page.html',workspaceRoot:dir})
 const failure=new Error('service unavailable')
 const store=createDesignStore(join(dir,'drafts'),{pages,workspaceRootOf:async()=>{throw failure}})
 await assert.rejects(store.prepare(published.meta.id,1,0),e=>e===failure)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {mcpServer,groupMcpTool,mcpDenyNames,McpCounters,parseMcpConfig} from '../lib/mcp-state.js'
import {createMcpVisibilityStore} from '../lib/mcp-store.js'
const config=parseMcpConfig()
const server=(id,name,url='https://example.invalid/mcp')=>mcpServer({entryId:id,moduleName:'@deepseek-ai/dsh-mcp-client',enabled:true,fiberPhase:'active'},{serverName:name,transport:'streamable-http',url})
async function root(t){const base=fileURLToPath(new URL('../.local/',import.meta.url));await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'mcp-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
test('MCP 公开字段不读取 headers/env/args；HTTP 仅显示 origin，不返回加载诊断原文',()=>{
 const raw={serverName:'qa',transport:'streamable-http',url:['https://person:password','example.invalid/mcp?key=private'].join('@'),get headers(){throw Error('credentials read')},get env(){throw Error('credentials read')},get args(){throw Error('arguments read')}}
 const value=mcpServer({entryId:'one',moduleName:'@deepseek-ai/dsh-mcp-client',enabled:true,fiberPhase:'failed',diagnostic:'password=private'},raw)
 assert.equal(value.target,'https://example.invalid');assert(!JSON.stringify(value).includes('password'));assert(!JSON.stringify(value).includes('private'));assert.equal(value.phase,'failed');assert(!('connected' in value))
})
test('只有无歧义规范名称可归组，长名称哈希和双下划线不误归属',()=>{
 const a=server('a','alpha'),b=server('b','alpha__beta')
 assert.equal(groupMcpTool('mcp__alpha__read',[a,b]),a.key)
 for(const name of ['mcp__alpha__beta__read','mcp__alpha__read_012345abcdef','mcp__missing__read'])assert.equal(groupMcpTool(name,[a,b]),null)
})
test('项目与会话隐藏取并集，只向 restrict 传当时可限制的精确名字，失效规则不复用',()=>{
 const s=server('a','alpha'),known=new Set(['mcp__alpha__read','mcp__alpha__write','mcp__other__run'])
 const rules=[{scope:'project',scopeKey:'p',serverKey:s.key,all:true,hidden:[],shown:['mcp__alpha__read']},{scope:'session',scopeKey:'s',serverKey:s.key,all:false,hidden:['mcp__alpha__read','mcp__alpha__gone'],shown:[]}]
 assert.deepEqual(mcpDenyNames(rules,{projectKey:'p',sessionId:'s',servers:[s],known}),['mcp__alpha__read','mcp__alpha__write'])
 assert.deepEqual(mcpDenyNames(rules.map(r=>({...r,retired:true})),{projectKey:'p',sessionId:'s',servers:[s],known}),[])
})
test('只记录本次启动后的普通调用，结果关联 callId，不保存参数或原错误',()=>{
 const counters=new McpCounters(config,100)
 counters.call('s',{callId:'c',name:'mcp__qa__read'},110,'server')
 counters.result('s',{message:{source:{callId:'c'},content:[{text:'SENSITIVE_RESULT'}],isError:true}},130)
 counters.result('s',{message:{source:{callId:'missing'}},isError:true},140)
 const snapshot=counters.snapshot();assert.equal(snapshot.startedAt,100);assert.equal(snapshot.rows[0].calls,1);assert.equal(snapshot.rows[0].failures,1);assert.equal(snapshot.rows[0].durationMs,20);assert(!JSON.stringify(snapshot).includes('SENSITIVE_RESULT'));assert.equal(snapshot.rows[0].completed,1)
})
test('可见性状态原子保存、重开恢复、修订冲突和退役规则',async t=>{
 const dir=await root(t),file=join(dir,'mcp-visibility.json'),store=createMcpVisibilityStore(file,config),s=server('a','alpha')
 const initial=await store.read();const first=await store.change(initial.revision,{scope:'project',scopeKey:'p',serverKey:s.key,entryId:s.entryId,serverName:s.serverName,all:true,hidden:[],shown:[]});assert.equal((await createMcpVisibilityStore(file,config).read()).rules[0].all,true)
 await assert.rejects(store.change(0,{...first.rules[0],all:false}),e=>e.code==='state-changed')
 await store.retire([s.key]);assert.equal((await store.read()).rules[0].retired,true)
})

test('分隔符两侧的单下划线也可能形成同名工具，不能归给较短服务器名',()=>{
 const shorter=server('one','alpha_'),longer=server('two','alpha__')
 assert.equal(groupMcpTool('mcp__alpha____read',[shorter,longer]),null)
})

test('较慢的读取不能覆盖刚保存的新规则',async t=>{
 const dir=await root(t),store=createMcpVisibilityStore(join(dir,'state.json'),config),entry={},configuration={},s=server('a','alpha'),masks=new Set(),names=new Set(['mcp__alpha__read'])
 const agent={id:'session-fixture',session:{header:{cwd:dir}},ctx:{effect:()=>()=>{},on:()=>()=>{},tools:{restrict:({deny})=>{const set=new Set(deny);masks.add(set);return()=>masks.delete(set)}}}}
 const view=()=>({knownNames:names,restrictableNames:names,visible:new Map([...names].filter(name=>![...masks].some(set=>set.has(name))).map(name=>[name,{}]))})
 const ctx={agents:{list:()=>[agent],get:id=>id===agent.id?agent:undefined},tools:{view},workingDirectory:{get:()=>dir},agentPresets:{presetForSession:()=>null},pluginInventory:{list:async()=>({entries:[]})}}
 let delay=false;const entered=Promise.withResolvers(),release=Promise.withResolvers()
 const wrapped={...store,read:async()=>{const value=await store.read();if(delay){delay=false;entered.resolve();await release.promise}return value}}
 const{createMcpManager}=await import('../lib/mcp-manager.js'),manager=createMcpManager({ctx,config,store:wrapped,readServers:()=>[{entry,configuration,server:s}]});t.after(()=>manager.dispose());await manager.start()
 delay=true;const oldRead=manager.read(agent.id);await entered.promise
 const saved=await manager.change({sessionId:agent.id,scope:'session',revision:0,target:{kind:'tool',name:'mcp__alpha__read'},hidden:true});assert.equal(saved.revision,1);assert(!view().visible.has('mcp__alpha__read'))
 release.resolve();await oldRead;assert(!view().visible.has('mcp__alpha__read'))
})

test('计数达到上限仍有明确遗漏数，未结束调用不被标成成功或失败',()=>{
 const counters=new McpCounters({...config,maxPending:1,maxTools:2},0)
 counters.call('one',{callId:'a',name:'mcp__qa__read'},1)
 counters.call('two',{callId:'b',name:'mcp__qa__read'},2)
 counters.result('one',{message:{source:{callId:'a'},isError:true}},3)
 counters.endSession('two')
 const value=counters.snapshot();assert.equal(value.droppedPending,1);assert.equal(value.rows[0].calls,2);assert.equal(value.rows[0].incomplete,2);assert.equal(value.rows[0].failures,0);assert.equal(value.rows[0].completed,0)
})
test('两个写入者不能用同一修订覆盖彼此；损坏状态不被默认空规则覆盖',async t=>{
 const dir=await root(t),file=join(dir,'state.json'),a=createMcpVisibilityStore(file,config),b=createMcpVisibilityStore(file,config),s=server('a','alpha')
 const rule={scope:'session',scopeKey:'one',serverKey:s.key,all:true,hidden:[],shown:[]}
 const result=await Promise.allSettled([a.change(0,rule),b.change(0,{...rule,scopeKey:'two'})]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
 const{writeFile,readFile}=await import('node:fs/promises');await writeFile(file,'{corrupt')
 await assert.rejects(a.change(1,rule),e=>e.code==='invalid-state');assert.equal(await readFile(file,'utf8'),'{corrupt')
})

// ---------- 网页端：切换会话、新会话的状态还没回来时，旧菜单不能改上一个会话（替身 React 里跑构建好的 lib/client.js） ----------

test('TC-006 切到会话 B、B 还在加载时，已经开着的菜单不改 A，新开的菜单禁用；B 回来后改的是 B', async (t) => {
 const {loadClient}=await import('./react-harness.mjs')
 const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})
 const stateOf=id=>({sessionId:id,revision:1,sessions:[{id:'A'},{id:'B'}],rules:[],servers:[],tools:[{name:'mcp__srv__x',serverKey:'srv',restrictable:true}],statistics:{rows:[]},project:null,excluded:false})
 let releaseB;const pendingB=new Promise(resolve=>{releaseB=resolve});const changes=[]
 const fetch=async(url,init={})=>{
  const path=String(url)
  if(path.startsWith('/api/dsh-workbench.mcp.state?')){const id=new URLSearchParams(path.split('?')[1]).get('sessionId');if(id==='B')await pendingB;return json(stateOf(id))}
  if(path==='/api/dsh-workbench.mcp.change'){const body=JSON.parse(init.body);changes.push([body.sessionId,body.target.name,body.hidden]);return json(stateOf(body.sessionId))}
  throw new Error('没准备的请求 '+path)
 }
 const client=loadClient(new URL('../lib/client.js',import.meta.url),{fetch})
 const menus=new Map()
 const app={t:key=>key,clock:key=>key,ctx:{
  sessions:{list:{getSnapshot:()=>({byId:{A:{retainedBy:{mainView:1}},B:{}}})},refresh:async()=>{}},
  contextMenus:{register(entry){menus.set(entry.id,entry);return()=>{if(menus.get(entry.id)===entry)menus.delete(entry.id)}},open(){}},
  uiWorkspace:{openSession(){}},
 }}
 const react=client.react
 react.mount(react.React.createElement(client.get('McpPanel'),{app}))
 t.after(()=>react.unmount())
 await react.settle()
 const item=()=>[...menus.values()][0].resolve({owner:'sidebar',kind:'tool',name:'mcp__srv__x',serverKey:'srv'}).find(row=>row.id==='visibility')
 const openBeforeSwitch=item()
 assert.equal(openBeforeSwitch.disabled,false)
 react.instancesOf(client.get('WorkbenchSelect'))[0].props.onChange('B')
 await react.settle()
 openBeforeSwitch.run()
 await react.settle()
 assert.deepEqual(changes,[],'B 加载中，开着的旧菜单不发 A 的修改')
 assert.equal(item().disabled,true,'加载中新开的菜单禁用')
 releaseB()
 await react.settle()
 openBeforeSwitch.run()
 await react.settle()
 assert.deepEqual(changes,[],'B 回来后，切换前打开的那份菜单也不再生效')
 item().run()
 await react.settle()
 assert.deepEqual(changes,[['B','mcp__srv__x',true]])
})

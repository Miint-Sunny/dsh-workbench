import test from 'node:test'
import assert from 'node:assert/strict'
import { parseContextConfig } from '../lib/context-config.js'
import { summarizeContext } from '../lib/context-stats.js'
import { createContextStore } from '../lib/context-store.js'
import { workLineChoices, CONTEXT_OFFICIAL_CHOICE } from '../src/client/context-model.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifeReader } from '../lib/compaction.js'
import { parseCompactionConfig } from '../lib/compaction-config.js'
import { writeDigest } from './fixtures/usage/digest-files.mjs'
const config = parseContextConfig({ timeZone: 'UTC', chunkEvents: 2 })
const estimateMessage = message => message.content.reduce((n,b)=>n+(b.type==='text'||b.type==='reasoning'?b.text.length:0),0)
function fixture() {
 const events=[]; const add=(type,data,extra={})=>events.push({seq:events.length,time:Date.parse('2026-11-06T10:00:00Z')+events.length,type,data,...extra})
 add('system/message',{message:{role:'system',content:[{type:'text',text:'secret-system'}]}})
 add('request/header',{header:{config:{provider:'fixture',model:'fixture',maxTokens:100},tools:[]}})
 add('request/context',{provider:'fixture',model:'fixture',contextWindow:100000})
 add('user/message',{role:'user',content:[{type:'text',text:'secret-user'}],source:{kind:'user-rpc'}},{surfaceOp:'append'})
 add('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'answer'}]},usage:{inputTokens:24}},{surfaceOp:'append'})
 return {header:{id:'fixture'},inheritedEventCount:0,cursor:events.length-1,events}
}
test('实际输入只对应本次请求之前的估算，当前 surface 包含响应且不泄露原文',async()=>{
 const result=await summarizeContext(fixture(),{config,estimateMessage})
 assert.equal(result.lastRequest.actual,24);assert.equal(result.lastRequest.raw,24)
 assert.equal(result.lastRequest.calibration,'aligned');assert.equal(result.current.raw,30)
 assert.equal(result.current.afterLastRequest,true);assert.equal(result.current.parts.sys,13)
 assert(!JSON.stringify(result).includes('secret-'))
})
test('替换去掉旧消息，继承调用仍计数，压缩次数只算自有事件，附件不按 base64 估算',async()=>{
 const obs=fixture(), es=obs.events;obs.inheritedEventCount=es.length
 es.push({seq:es.length,time:es[0].time,type:'tool/call',data:{name:'look',callId:'old'}})
 obs.inheritedEventCount=es.length
 es.push({seq:es.length,time:es[0].time,type:'compaction/summary',data:{}})
 es.push({seq:es.length,time:es[0].time,type:'user/message',surfaceOp:{op:'replace',startSeq:3,endSeq:4},data:{role:'user',source:{kind:'compact-checkpoint'},content:[{type:'text',text:'sum'}]}})
 es.push({seq:es.length,time:es[0].time,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user-rpc'},content:[{type:'image',data:'do-not-count-this-secret-data'}]}})
 const result=await summarizeContext(obs,{config,estimateMessage})
 assert.equal(result.current.parts.comp,3);assert.equal(result.current.parts.msg,0)
 assert.equal(result.compactions.count,1);assert.equal(result.current.unknownMedia,1)
 assert(!JSON.stringify(result).includes('do-not-count'))
})
test('偏差过大或缺实际用量时不校准，缺窗口或输出预算不造压缩线',async()=>{
 const obs=fixture();obs.events.at(-1).data.usage.inputTokens=1000
 let result=await summarizeContext(obs,{config,estimateMessage});assert.equal(result.lastRequest.calibration,'divergent');assert.equal(result.lastRequest.scaledParts,null)
 delete obs.events.at(-1).data.usage;delete obs.events[1].data.header.config.maxTokens
 result=await summarizeContext(obs,{config,estimateMessage});assert.equal(result.lastRequest,null);assert.equal(result.threshold.tokens,null)
})
test('缓存同一观察只聚合一次，更新 cursor 后重算，始终释放 lease',async()=>{
 let cursor=1,disposed=0,aggregated=0
 const query={async observeSession(){return{source:'live',header:{id:'a'},cursor,events:[],[Symbol.dispose](){disposed++}}}}
 const store=createContextStore({sessionQuery:query,config,aggregate:async lease=>{aggregated++;return{cursor:lease.cursor}}})
 assert.equal((await store.read('a')).cursor,1);await store.read('a');assert.equal(aggregated,1);assert.equal(disposed,2)
 cursor=2;assert.equal((await store.read('a')).cursor,2);assert.equal(aggregated,2);assert.equal(disposed,3);await store.dispose()
})
test('聚合失败和取消释放观察，排队请求可取消，卸载等待已有读取',async()=>{
 let release,entered,disposed=0;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r)
 const store=createContextStore({sessionQuery:{async observeSession(){return{source:'live',header:{id:'a'},cursor:1,events:[],[Symbol.dispose](){disposed++}}}},config:{...config,maxConcurrentReads:1},aggregate:async(_lease,{signal})=>{entered();await pending;signal.throwIfAborted();return{}}})
 const first=store.read('a');await ready;const cancel=new AbortController();const queued=store.read('b',cancel.signal);cancel.abort();await assert.rejects(queued)
 const stopping=store.dispose();release();await assert.rejects(first);await stopping;assert.equal(disposed,1)
})
test('上下文配置拒绝无效比例、限额与时区',()=>{
 for(const bad of [{calibrationTolerance:-1},{maxConcurrentReads:0},{chunkEvents:0},{timeZone:'bad/time'},{defaultThresholdRatio:2},{historyLimit:0}])assert.throws(()=>parseContextConfig(bad))
})

test('上下文路由拒绝多余参数和路径，失败响应不带内部信息',async()=>{
 const {applyContextRoutes}=await import('../lib/context.js');let route,read=0
 applyContextRoutes({connection:{fetch:{register(value){route=value;return()=>{}}}}},{async read(){read++;throw new Error('/private/secret')}})
 for(const query of ['','sessionId=a&sessionId=b','sessionId=../x','sessionId=a&path=x'])assert.equal((await route.fetch(new Request('http://local/api?'+query))).status,400)
 assert.equal(read,0);const response=await route.fetch(new Request('http://local/api?sessionId=a'));assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:{code:'context-read-failed'}})
})

test('只有已提交的摘要替换计入压缩次数，失败的摘要生成不算压缩',async()=>{
 const obs=fixture();obs.events.push({seq:5,time:obs.events[0].time,type:'compaction/summary',data:{}})
 const result=await summarizeContext(obs,{config,estimateMessage});assert.equal(result.compactions.count,0);assert.equal(result.compactions.lastReduction,null)
})

test('只报告输出用量的响应不能当成实际输入零，真实零输入不报偏差',async()=>{
 const obs=fixture();obs.events.at(-1).data.usage={outputTokens:3}
 let result=await summarizeContext(obs,{config,estimateMessage});assert.equal(result.lastRequest,null)
 obs.events=[{seq:0,time:0,type:'assistant/message',surfaceOp:'append',data:{message:{role:'assistant',content:[]},usage:{inputTokens:0}}}];obs.cursor=0
 result=await summarizeContext(obs,{config,estimateMessage});assert.equal(result.lastRequest.calibration,'aligned')
})

test('上下文资源地址拒绝坏转义与路径，普通 guide 使用所在会话',async()=>{
 const {contextAddressSession}=await import('../src/client/context.js')
 assert.equal(contextAddressSession('sidebar://wbcontext','session-a'),'session-a')
 assert.equal(contextAddressSession('dsh-resource://wbcontext/session-a'),'session-a')
 for(const address of ['dsh-resource://wbcontext/%','dsh-resource://wbcontext/..%2Fprivate','dsh-resource://wbcontext/'])assert.equal(contextAddressSession(address),undefined)
})

test('路由切换后的窗口未记录时不沿用旧窗口，最近实际用量保留自己的路由',async()=>{
 const obs=fixture();obs.events.push({seq:5,time:1,type:'request/header',data:{header:{config:{provider:'next',model:'next',maxTokens:200},tools:[]}}});obs.cursor=5
 const result=await summarizeContext(obs,{config,estimateMessage})
 assert.equal(result.model,'next');assert.equal(result.window,null);assert.equal(result.threshold.tokens,null)
 assert.equal(result.lastRequest.model,'fixture');assert.equal(result.lastRequest.window,100000)
})

test('同一路由的新请求系列保留窗口，并用于下一次实际请求的压缩线',async()=>{
 const obs=fixture(),header=structuredClone(obs.events.find(e=>e.type==='request/header').data)
 obs.events.push({seq:obs.events.length,time:1,type:'request/header',data:{...header,reason:'series'}})
 obs.events.push({seq:obs.events.length,time:2,type:'assistant/message',surfaceOp:'append',data:{message:{role:'assistant',content:[]},usage:{inputTokens:25}}});obs.cursor=obs.events.length-1
 const result=await summarizeContext(obs,{config,estimateMessage});assert.equal(result.window,100000);assert.equal(result.lastRequest.window,100000);assert.notEqual(result.threshold.tokens,null)
})

function richFixture() {
 const events=[];const add=(type,data,extra={})=>events.push({seq:events.length,time:Date.parse('2026-11-06T10:00:00Z')+events.length*1000,type,data,...extra})
 const user=(kind,text,source={})=>add('user/message',{role:'user',content:[{type:'text',text}],source:{kind,...source}},{surfaceOp:'append'})
 add('system/message',{message:{role:'system',content:[{type:'text',text:'s'.repeat(10)}]}})
 add('request/header',{header:{config:{provider:'go',model:'flash',maxTokens:384000},tools:[{name:'read',description:'x'.repeat(396)},{name:'mcp__github__get',description:'x'.repeat(796)},{name:'mcp__github__put',description:'x'.repeat(396)},{name:'mcp__fetch__fetch',description:'x'.repeat(796)}]}})
 add('request/context',{provider:'go',model:'flash',contextWindow:1000000})
 user('agent-instructions','m'.repeat(20),{changes:[{action:'add',path:'/home/x/AGENTS.md'},{action:'add',path:'/repo/CLAUDE.md'}]})
 user('skill-catalog','c'.repeat(30),{entries:[{name:'alpha',description:'secret-desc'},{name:'beta',description:'secret-desc'}]})
 user('skill-invocation','i'.repeat(40),{name:'alpha'})
 user('runtime-context','r'.repeat(5))
 user('time-context','t'.repeat(5))
 user('subagent-report','b'.repeat(50))
 user('tool-jobs','o'.repeat(60))
 user('user','u'.repeat(70))
 add('tool/call',{name:'mcp__github__get',callId:'c1'})
 add('tool/call',{name:'read',callId:'c2'})
 add('tool/result',{message:{role:'tool',toolCallId:'c1',source:{kind:'tool',callId:'c1'},content:[{type:'text',text:'q'.repeat(80)}]}},{surfaceOp:'append'})
 add('assistant/message',{message:{role:'assistant',content:[{type:'reasoning',text:'k'.repeat(90)},{type:'text',text:'a'.repeat(100)}]},usage:{inputTokens:400,cacheReadTokens:300}},{surfaceOp:'append'})
 return {header:{id:'rich',agentPreset:'standard'},inheritedEventCount:0,cursor:events.length-1,events,projections:{values:{contextPressure:{contextWindow:1000000,pressureTokens:700,projectedTokens:900}}}}
}
test('上下文页的分项：工具定义按内置和 MCP 分，注入按来源分，原文不外泄',async()=>{
 const result=await summarizeContext(richFixture(),{config,estimateMessage})
 const p=result.current.parts
 assert.equal(p.sys,10);assert.equal(p.mem,20);assert.equal(p.skill,70);assert.equal(p.rt,10);assert.equal(p.sub,50);assert.equal(p.other,60)
 assert.equal(p.msg,170);assert.equal(p.reas,90);assert.equal(p.res,80)
 assert(p.builtin>90&&p.builtin<130);assert(p.mcp>480&&p.mcp<560)
 assert(!JSON.stringify(result).includes('secret-desc'))
})
test('分组：MCP 按服务器汇总并记未调用，技能和记忆文件只有名字',async()=>{
 const result=await summarizeContext(richFixture(),{config,estimateMessage})
 const github=result.groups.mcp.find(g=>g.server==='github'),fetch=result.groups.mcp.find(g=>g.server==='fetch')
 assert.equal(github.tools,2);assert.equal(github.unused,1);assert.equal(fetch.tools,1);assert.equal(fetch.unused,1)
 assert.equal(result.groups.mcp[0].server,'github')
 assert.deepEqual(github.rows.map(r=>[r.name,r.calls]),[['mcp__github__get',1],['mcp__github__put',0]])
 assert.deepEqual(result.groups.builtin.map(r=>[r.name,r.calls]),[['read',1]])
 assert.deepEqual(result.groups.skills,{catalog:2,loaded:['alpha']})
 assert.deepEqual(result.groups.memory,['/home/x/AGENTS.md','/repo/CLAUDE.md'])
})
test('已用和窗口取官方投影，和输入框旁边的圆环一样',async()=>{
 const result=await summarizeContext(richFixture(),{config,estimateMessage})
 assert.equal(result.pressure.used,900);assert.equal(result.pressure.window,1000000);assert.equal(result.pressure.percent,0)
 const obs=richFixture();obs.projections.values.contextPressure={contextWindow:1000,pressureTokens:505};const second=await summarizeContext(obs,{config,estimateMessage})
 assert.equal(second.pressure.used,505);assert.equal(second.pressure.percent,51)
 const none=richFixture();delete none.projections;const third=await summarizeContext(none,{config,estimateMessage})
 assert.equal(third.pressure.used,third.current.officialTokens);assert.equal(third.pressure.window,1000000)
})
test('压缩能清掉的部分：对话、工具结果、推理和后来的注入算，工具定义、系统提示词、记忆文件、技能、运行时上下文不算',async()=>{
 const result=await summarizeContext(richFixture(),{config,estimateMessage})
 const d=result.display
 const blue=['res','reas','msg','comp','sub','other'].reduce((n,k)=>n+d.parts[k],0)
 assert.equal(d.reducible,blue+d.since)
 assert.equal(result.lastRequest.calibration,'divergent')
 assert.equal(d.gap,result.lastRequest.actual-result.lastRequest.raw)
})
test('估算对得上时按实际值缩放，上次请求之后单独一行',async()=>{
 const obs=fixture()
 obs.events.push({seq:obs.events.length,time:obs.events[0].time+99,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user-rpc'},content:[{type:'text',text:'later-msg!'}]}})
 obs.cursor=obs.events.length-1
 const result=await summarizeContext(obs,{config,estimateMessage})
 const d=result.display
 assert.equal(d.gap,null);assert.deepEqual(d.parts,result.lastRequest.scaledParts);assert.equal(d.since,16)
})
test('未调用的工具按行分开，和这一行同一个比例',async()=>{
 const loose=parseContextConfig({timeZone:'UTC',chunkEvents:2,calibrationTolerance:.9})
 const obs=richFixture();obs.events.find(e=>e.type==='request/header').data.header.tools.push({name:'write',description:'x'.repeat(396)})
 const result=await summarizeContext(obs,{config:loose,estimateMessage}),d=result.display
 assert.equal(result.lastRequest.calibration,'aligned');assert.equal(d.ratio,result.lastRequest.ratio);assert(d.ratio<1)
 const uncalled=result.tools.rows.filter(t=>t.calls===0),sum=list=>list.reduce((n,t)=>n+t.tokens,0)
 assert.equal(d.unused.mcp.n,2);assert.equal(d.unused.builtin.n,1)
 assert.equal(d.unused.mcp.tokens,Math.round(sum(uncalled.filter(t=>t.name.startsWith('mcp__')))*d.ratio))
 assert.equal(d.unused.builtin.tokens,Math.round(sum(uncalled.filter(t=>t.name==='write'))*d.ratio))
 const divergent=(await summarizeContext(richFixture(),{config,estimateMessage})).display
 assert.equal(divergent.ratio,1);assert.equal(divergent.unused.mcp.n,2);assert.equal(divergent.unused.builtin.n,0)
})
test('各工具分开估算的和超过这一行时，未调用的数字不超过这一行',async()=>{
 const obs=richFixture();obs.events.find(e=>e.type==='request/header').data.header.tools=Array.from({length:20},(_,i)=>({name:`mcp__a__a${String.fromCharCode(97+i)}`}))
 const d=(await summarizeContext(obs,{config,estimateMessage})).display
 assert.equal(d.unused.mcp.n,20);assert.equal(d.unused.mcp.tokens,d.parts.mcp)
})
test('压缩记录：按类型分，带前后大小；失败的也记',async()=>{
 const obs=richFixture(),es=obs.events,t=es[0].time
 const add=(type,data,extra={})=>es.push({seq:es.length,time:t+es.length*1000,type,data,...extra})
 add('compaction/start',{compactionId:'c1',turn:null})
 add('compaction/summary',{compactionId:'c1',shadowedTokenCount:500,provider:'go',model:'flash',usage:{inputTokens:10,cacheReadTokens:700,outputTokens:50}})
 add('compaction/end',{compactionId:'c1',turn:null})
 add('compaction/start',{compactionId:'c2',turn:{id:'t'}})
 add('compaction/end',{compactionId:'c2',turn:{id:'t'},error:{message:'429 capacity'}})
 add('compaction/start',{compactionId:'c3',turn:null,sourceCommandId:'cmd'})
 add('compaction/summary',{compactionId:'c3',sourceCommandId:'cmd',shadowedTokenCount:9,provider:'go',model:'flash'})
 add('compaction/end',{compactionId:'c3',turn:null,sourceCommandId:'cmd'})
 add('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'after'}]},usage:{inputTokens:50,cacheReadTokens:150}},{surfaceOp:'append'})
 obs.cursor=es.length-1
 const {records}=await summarizeContext(obs,{config,estimateMessage})
 assert.deepEqual(records.map(r=>[r.kind,r.ok]),[['idle',true],['auto',false],['manual',true]])
 assert.equal(records[0].before,700);assert.equal(records[0].shadowed,500);assert.deepEqual(records[0].usage,{input:10,rd:700,wr:0,out:50})
 assert.equal(records[2].after,200);assert.equal(records[0].after,null)
 assert.equal(records[1].error,'429 capacity')
})
test('计价函数把当前模型每百万 token 的价和压缩记录的费用带上',async()=>{
 const price=rows=>rows.map(r=>({...r,costIn:r.input/1e6,costRd:r.rd/1e6*.02,costOut:r.out/1e6*4,c:r.input/1e6+r.rd/1e6*.02+r.out/1e6*4}))
 const obs=richFixture(),es=obs.events,t=es[0].time
 es.push({seq:es.length,time:t+99000,type:'compaction/start',data:{compactionId:'c1',turn:null}})
 es.push({seq:es.length,time:t+99001,type:'compaction/summary',data:{compactionId:'c1',shadowedTokenCount:5,provider:'go',model:'flash',usage:{inputTokens:1000000,outputTokens:1000000}}})
 es.push({seq:es.length,time:t+99002,type:'compaction/end',data:{compactionId:'c1',turn:null}})
 const result=await summarizeContext(obs,{config,estimateMessage,price})
 assert.deepEqual(result.prices,{miss:1,hit:.02,out:4})
 assert.equal(result.records[0].cost,5)
})
const tiersOf=over=>workLineChoices({work:null,official:550_464,min:100_000,step:100_000,max:700_000,...over})
test('自动压缩于：档位从最低列到官方线以下，没设线时选中官方默认',()=>{
 const c=tiersOf()
 assert.deepEqual(c.tiers,[100_000,200_000,300_000,400_000,500_000]);assert.equal(c.selected,CONTEXT_OFFICIAL_CHOICE)
})
test('自动压缩于：设的线低于官方线才算数，不低于时显示官方默认，和实际走的线一样',()=>{
 assert.equal(tiersOf({work:300_000}).selected,'300000')
 assert.equal(tiersOf({work:600_000}).selected,CONTEXT_OFFICIAL_CHOICE)
 assert.equal(tiersOf({work:550_464}).selected,CONTEXT_OFFICIAL_CHOICE)
})
test('自动压缩于：官方线正好是一档时不重复列，比最低档还低时只剩官方默认',()=>{
 assert.deepEqual(tiersOf({official:500_000}).tiers,[100_000,200_000,300_000,400_000])
 assert.deepEqual(tiersOf({official:80_000}).tiers,[])
})
test('自动压缩于：不知道官方线时列到上限，设的线照样算数',()=>{
 const c=tiersOf({official:null,work:700_000})
 assert.equal(c.tiers.at(-1),700_000);assert.equal(c.selected,'700000')
})

test('C-007 记忆文件只显示最后两段，Windows 的反斜杠路径也一样',async t=>{
 const {loadClient,textOf}=await import('./react-harness.mjs')
 const client=loadClient(new URL('../lib/client.js',import.meta.url))
 const react=client.react,data={groups:{memory:['C:\\Users\\me\\repo\\AGENTS.md','/home/me/repo/CLAUDE.md']},display:{ratio:1}}
 react.mount(react.React.createElement(react.React.Fragment,null,client.get('contextExpansion')('mem',data,key=>key)))
 t.after(()=>react.unmount())
 assert.deepEqual(react.all(n=>n.props.className==='dwb-ctx-kid').map(textOf),['repo/AGENTS.md','repo/CLAUDE.md'])
})

test('TC-007 压缩中连续两次查到的还是压缩中，照样每 2 秒接着查，查到完成为止',async t=>{
 const {loadClient,textOf}=await import('./react-harness.mjs')
 const snapshot=await summarizeContext(fixture(),{config,estimateMessage})
 const states=['compacting','compacting','compacting','done'],seen=[]
 const comp=state=>({runtime:state==='done'?{state,at:Date.parse('2026-11-06T10:05:00Z'),before:5000,after:2000}:{state},settings:{work:null,idle:null,idleMinutes:30},root:false,live:true,presets:[],defaultPreset:'default'})
 const fetch=async url=>{
  const path=String(url)
  if(path.startsWith('/api/dsh-workbench.context?'))return new Response(JSON.stringify(snapshot),{status:200})
  if(path.startsWith('/api/dsh-workbench.compaction?')){const state=states[Math.min(seen.length,states.length-1)];seen.push(state);return new Response(JSON.stringify(comp(state)),{status:200})}
  throw new Error('没准备的请求 '+path)
 }
 // 只给包换计时器，测试自己拨钟，不真等 2 秒。
 const timers=new Map();let now=0,ids=0
 const setTimeout=(fn,ms)=>{timers.set(++ids,{fn,at:now+ms});return ids}
 const clearTimeout=id=>{timers.delete(id)}
 const client=loadClient(new URL('../lib/client.js',import.meta.url),{fetch,setTimeout,clearTimeout})
 const react=client.react
 const tick=async ms=>{now+=ms;for(const [id,timer] of [...timers].sort((a,b)=>a[1].at-b[1].at))if(timer.at<=now){timers.delete(id);await timer.fn()}await react.settle()}
 react.mount(react.React.createElement(client.get('ContextPanel'),{sessionId:snapshot.sessionId,app:{t:key=>key,ctx:{}},useTabInfo:()=>({tab:{visible:true}})}))
 t.after(()=>react.unmount())
 await react.settle()
 const caption=()=>react.all(n=>typeof n.props.className==='string'&&n.props.className.startsWith('dwb-ctx-cap')).map(textOf).join(' | ')
 assert.match(caption(),/context\.compacting/)
 await tick(2000);await tick(2000);await tick(2000)
 assert.deepEqual(seen.slice(0,4),['compacting','compacting','compacting','done'])
 assert.match(caption(),/context\.capDone/)
})

/** 没挂载的元素里的文字。 */
const elementText=el=>el==null||typeof el==='boolean'?'':typeof el==='string'||typeof el==='number'?String(el):Array.isArray(el)?el.map(elementText).join(''):elementText(el.props?.children)
/**
 * 使用合成请求分布：名单外预设有长间隔低命中样本，名单内预设使用 code 表。上下文页处于空闲 1 小时、已排定压缩的状态。
 * 文案键后面括号里是参数。
 */
async function lifePage(t,code){
 const {loadClient,textOf}=await import('./react-harness.mjs')
 const dir=await mkdtemp(join(tmpdir(),'context-life-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 await writeDigest(dir,{id:'excluded',preset:'custom-preset',table:[[2,12,12],[10,6,6],[20,6,6],[30,6,6],[40,1,5],[50,1,5],[70,0,8],[100,0,8],[150,0,8]]})
 await writeDigest(dir,{id:'code',preset:'standard',table:code})
 const life=await createLifeReader({dir,presets:parseCompactionConfig().presets,refreshMs:60_000})('opencode-go')
 const snapshot={...await summarizeContext(fixture(),{config,estimateMessage}),prices:{hit:0.2,miss:1,out:2}}
 const comp={runtime:{state:'armed',dueAt:Date.parse('2026-11-06T11:00:00Z')},settings:{work:null,idle:300_000,idleMinutes:60},live:true,allowed:true,root:true,presets:['standard'],defaultPreset:'standard',official:null,used:null,tiers:{step:100_000,min:100_000},idleMinutes:[15,30,60,120,240],minCompactable:20_000,life,note:null}
 const fetch=async url=>{
  const path=String(url)
  if(path.startsWith('/api/dsh-workbench.context?'))return new Response(JSON.stringify(snapshot),{status:200})
  if(path.startsWith('/api/dsh-workbench.compaction?'))return new Response(JSON.stringify(comp),{status:200})
  throw new Error('没准备的请求 '+path)
 }
 const client=loadClient(new URL('../lib/client.js',import.meta.url),{fetch})
 const react=client.react
 const tr=(key,vars)=>vars?`${key}(${Object.values(vars).join(',')})`:key
 react.mount(react.React.createElement(client.get('ContextPanel'),{sessionId:snapshot.sessionId,app:{t:tr,ctx:{}},useTabInfo:()=>({tab:{visible:true}})}))
 t.after(()=>react.unmount())
 await react.settle()
 const time=react.one(n=>n.type==='ui.Menu'&&n.props.items[0]?.id==='15','空闲时长的菜单')
 return {
  captions:react.all(n=>typeof n.props.className==='string'&&n.props.className.startsWith('dwb-ctx-cap')).map(textOf),
  lifeButton:react.all(n=>n.props.className==='dwb-ctx-life').map(textOf),
  times:time.props.items.map(item=>({id:item.id,dimmed:item.label.props.className.includes('is-dimmed'),text:elementText(item.label)})),
 }
}

test('名单外预设的长间隔不参与估计：写代码的会话隔得久的样本不够时，写样本不够，不写多久过期',async t=>{
 const page=await lifePage(t,[[2,40,40],[10,2,2]])
 assert(page.captions.includes('context.lifeUnknown'),page.captions.join(' | '))
 assert.deepEqual(page.lifeButton,[])
})

test('名单外预设的长间隔不参与估计：1 小时以上的空闲时长不变灰，状态行按缓存还在的价钱',async t=>{
 // 合成样本：短间隔足够确认下限，长间隔样本不足。
 const page=await lifePage(t,[[2,18,20],[10,3,3],[30,1,1],[40,1,1],[50,1,1],[150,0,2]])
 assert.deepEqual(page.lifeButton,['context.lifeAtLeast(15)'])
 assert.deepEqual(page.times.filter(o=>o.dimmed).map(o=>o.id),[])
 assert.deepEqual(page.times.filter(o=>o.text.includes('context.cold')).map(o=>o.id),[])
 assert.deepEqual(page.times.filter(o=>o.text.includes('context.warm')).map(o=>o.id),['15'])
 assert(page.captions.some(c=>c.startsWith('context.capArmed(')),page.captions.join(' | '))
 assert(!page.captions.some(c=>c.startsWith('context.capArmedCold')),page.captions.join(' | '))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageConfig } from '../lib/usage-config.js'
import { usageBreakdown } from '../lib/usage-breakdown.js'
import { buildOverview } from '../lib/usage-overview.js'
import { digestSession } from '../lib/usage-digest.js'
import { fixture } from './fixtures/usage/events.mjs'
import * as client from '../src/client/usage-model.js'
const now=Date.parse('2026-11-06T03:00:00Z'),config=parseUsageConfig({timeZone:'Asia/Shanghai'})
test('四个明细维度不受概览前六会话、前八工具的截断影响',()=>{
 const list=Array.from({length:9},(_,i)=>{const s=fixture();s.session.id=`s${i}`;s.session.agentPreset=i===0?'whale':'standard';const d=digestSession(s);d.tools[0].name=`tool${i}`;return{...d,deleted:false}})
 const data=buildOverview(list,config,{now})
 assert.ok(data.breakdown)
 assert.equal(data.breakdown.sessions.length,9);assert.equal(data.breakdown.tools.length,9)
 assert.equal(data.breakdown.models.length,2);assert.equal(data.breakdown.providers.length,2)
 assert.equal(data.breakdown.sessions.reduce((n,s)=>n+s.tokens,0),data.T.input+data.T.rd+data.T.wr+data.T.out)
 const filtered=buildOverview(list,config,{now,group:'whale'});assert.equal(filtered.breakdown.sessions.length,1)
 const empty=buildOverview([],config,{now});assert.deepEqual(empty.breakdown,{sessions:[],models:[],tools:[],providers:[]})
})
test('模型明细给出样本量、缓存比例、时延分位数与自身基线',()=>{
 const d={...digestSession(fixture()),deleted:false}
 const row=d.rows.find(r=>r.kind==='main');row.ttft=2000;row.dec=1000;row.out=100
 d.rows.push({...row,t:row.t-86400e3,input:1,rd:0,wr:0,out:1,prompt:1})
 const data=buildOverview([d],config,{now})
 assert.ok(data.breakdown)
 const model=data.breakdown.models.find(r=>r.name==='deepseek-v4-flash')
 assert.equal(model.retries,null);assert.equal(model.req,2);assert.equal(model.ttft.n,2);assert.equal(model.ttft.p50,2);assert.equal(model.baselineN,1)
 assert.equal(model.anomaly,true);assert.ok(model.hit>=0&&model.hit<=1)
})


function anomalyFixture() {
 const names=['small-mad','small-z','edge','large-stable'], rows=[], tools=[]
 for(const [index,name] of names.entries()) for(let day=3;day<=6;day++) {
  const current=day===6, t=Date.parse(`2026-11-0${day}T02:00:00Z`)
  const requestTokens=current?[100,100,500,9300][index]:[0,day-2,0,9300][index]
  const toolTokens=current?[10,1,5,84][index]:[0,(day-2)/100,0,84][index]
  rows.push({s:name,m:name,p:name,t,day:`2026-11-0${day}`,hour:10,kind:'main',input:requestTokens,rd:0,wr:0,out:0,prompt:requestTokens,c:0,ttft:1000,dec:1000})
  tools.push({s:name,name,t,tok:toolTokens,ms:100,err:false})
 }
 return {rows,tools,sessions:names.map(s=>({s,title:s})),retryLog:[],turnEnds:[],today:'2026-11-06',hour:11,config:{...config,anomalyMinShare:0.05}}
}

test('四维明细按各自今日总量筛异常，同时处理 z 和 MAD 为零，5% 边界保留',()=>{
 const input=anomalyFixture(), before=usageBreakdown({...input,config:{...input.config,anomalyMinShare:0}}), after=usageBreakdown(input)
 for(const dimension of ['sessions','models','providers']) {
  const byName=Object.fromEntries(after[dimension].map(row=>[row.name,row]))
  assert.equal(byName['small-mad'].anomaly,false,dimension+' small MAD=0')
  assert.equal(byName['small-z'].anomaly,false,dimension+' small z')
  assert.equal(byName.edge.anomaly,true,dimension+' exact 5%')
  assert.equal(byName['large-stable'].anomaly,false,dimension+' stable large')
  assert.ok(byName['small-z'].z>3);assert.equal(byName['small-mad'].z,null)
 }
 assert.equal(after.tools.find(r=>r.name==='small-mad').anomaly,true,'工具独立分母，10 / 100 达到门槛')
 assert.equal(after.tools.find(r=>r.name==='small-z').anomaly,false)
 assert.equal(after.tools.find(r=>r.name==='edge').anomaly,true)
 for(const dimension of Object.keys(after)) {
  assert.equal(after[dimension].length,before[dimension].length)
  for(const row of after[dimension]) {
   const old=before[dimension].find(r=>r.name===row.name)
   const {anomaly:_,...numbers}=row,{anomaly:__,...oldNumbers}=old
   assert.deepEqual(numbers,oldNumbers)
  }
  assert.equal(after[dimension][0].anomaly,true,'筛选后异常仍排在最前')
 }
})

test('今日总量为零不标明细异常，概览判断不受新配置影响',()=>{
 const input=anomalyFixture();for(const r of input.rows)if(r.day===input.today)r.input=0
 for(const t of input.tools)if(t.t>=Date.parse('2026-11-06T00:00:00Z'))t.tok=0
 const result=usageBreakdown(input);for(const rows of Object.values(result))assert.equal(rows.filter(r=>r.anomaly).length,0)
 const d={...digestSession(fixture()),deleted:false}
 const {breakdown:a,...oldOverview}=buildOverview([d],{...config,anomalyMinShare:0},{now})
 const {breakdown:b,...newOverview}=buildOverview([d],{...config,anomalyMinShare:1},{now})
 assert.deepEqual(newOverview,oldOverview)
})

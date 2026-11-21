import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttentionStore, attentionFilter, attentionNext, attentionNextNotice } from '../src/client/attention-model.js'
import { apply as applyAttention } from '../lib/attention.js'
import { enabledFeatures } from '../lib/features.js'

test('需要处理行不访问工具、提示词或预设服务，卸载移除功能登记', () => {
  const disposers=[]
  const ctx=new Proxy({effect:fn=>{const stop=fn();disposers.push(stop);return stop}}, {get:(target,key)=>{assert(key in target,`unexpected model service ${String(key)}`);return target[key]}})
  applyAttention(ctx);assert(enabledFeatures().some(x=>x.id==='attention'))
  for(const stop of disposers)stop()
  assert(!enabledFeatures().some(x=>x.id==='attention'))
})

const row = (id, extra = {}) => ({ id, displayTitle: id, cwd: `/projects/${id}`, ...extra })
const pending = (kind, key) => ({ pendingInteraction: { kind, key } })
function setup() {
  let now = 100, value = { connected: true, ready: true, generation: 1,
    list: { ids: ['a', 'b', 'c'], byId: { a: row('a'), b: row('b'), c: row('c') } }, statuses: new Map(), archivedIds: [], addressFor: () => undefined }
  const store = createAttentionStore(() => value, () => now)
  return { store, set: patch => { value = { ...value, ...patch }; store.update() }, clock: t => { now = t } }
}

test('三种等待按首次接收顺序集中显示，未读和运行不计入', () => {
  const h = setup(); h.store.update(); h.set({ statuses: new Map([['b', pending('question', 'q')], ['a', { running: true, completionUnread: true }]]) })
  h.clock(200); h.set({ statuses: new Map([['a', pending('approval', 'ap')], ['b', pending('question', 'q')], ['c', pending('plan-review', 'p')]]) })
  assert.deepEqual(h.store.getSnapshot().rows.map(x => [x.id, x.kind, x.receivedAt]), [['b', 'question', 100], ['a', 'approval', 200], ['c', 'plan-review', 200]])
})

test('首次基线与重连基线不伪造收到时间，不把断线说成零条', () => {
  const h = setup(); h.set({ statuses: new Map([['a', pending('approval', 'old')]]) })
  assert.equal(h.store.getSnapshot().rows[0].receivedAt, null)
  h.set({ connected: false, statuses: new Map() }); assert.equal(h.store.getSnapshot().phase, 'offline'); assert.equal(h.store.getSnapshot().rows.length, 1)
  h.set({ connected: true, ready: false, generation: 2 }); assert.equal(h.store.getSnapshot().phase, 'loading')
  h.set({ ready: true, list:{ids:['b'],byId:{b:row('b')}}, statuses: new Map([['b', pending('question', 'new')]]) })
  assert.deepEqual(h.store.getSnapshot().rows.map(x => [x.id,x.receivedAt]), [['b',null]])
})

test('重连沿用旧 ready 时，空 pending 不是完整基线，旧请求不报零或重写收到时间',()=>{
 const h=setup();h.store.update();h.set({statuses:new Map([['a',pending('question','q')]])});h.set({connected:false,statuses:new Map()})
 h.clock(123);h.set({connected:true,generation:2,ready:true});assert.equal(h.store.getSnapshot().phase,'syncing');assert.equal(h.store.getSnapshot().rows[0].unconfirmed,true)
 assert.equal(attentionNext(h.store.getSnapshot(),undefined,{}),undefined)
 h.set({statuses:new Map([['a',pending('question','q')]])});assert.equal(h.store.getSnapshot().phase,'ready');assert.equal(h.store.getSnapshot().rows[0].receivedAt,null)
 h.set({statuses:new Map()});assert.equal(h.store.getSnapshot().rows.length,0)
})

test('同一个请求的更新和打开会话不改变顺序；解除后立即移除', () => {
  const h=setup();h.store.update();h.set({statuses:new Map([['a',pending('question','q')]])});h.clock(500)
  h.set({list:{ids:['a'],byId:{a:row('a',{retainedBy:{mainView:1}})}},statuses:new Map([['a',{...pending('question','q'),completionUnread:false}]])})
  assert.equal(h.store.getSnapshot().rows[0].receivedAt,100)
  h.set({statuses:new Map([['a',{completionUnread:true}]])});assert.equal(h.store.getSnapshot().rows.length,0)
})

test('归档和删除不保留幽灵请求；下一项重新读最新的筛选结果', () => {
  const h=setup();h.set({statuses:new Map([['a',pending('approval','a')],['b',pending('question','b')],['c',pending('question','c')]])})
  h.set({archivedIds:['b'],list:{ids:['a','b'],byId:{a:row('a'),b:row('b')}}})
  assert.deepEqual(h.store.getSnapshot().rows.map(x=>x.id),['a'])
  assert.equal(attentionNext(h.store.getSnapshot(),'a',{}),'a')
  h.set({statuses:new Map()});assert.equal(attentionNext(h.store.getSnapshot(),'a',{}),undefined)
})

test('子智能体使用官方父子地址，列表中尚无子项时也不丢请求', () => {
  const h=setup();h.set({statuses:new Map([['child',pending('question','child-q')]]),addressFor:id=>id==='child'?{parentSessionId:'a',childSessionId:'child'}:undefined})
  const item=h.store.getSnapshot().rows[0];assert.equal(item.id,'child');assert.equal(item.parentId,'a');assert.equal(item.child,true);assert.equal(item.cwd,'/projects/a')
  h.set({archivedIds:['a']});assert.equal(h.store.getSnapshot().rows.length,0)
})

test('不认识的交互种类不伪装成审批；种类和搜索筛选互不改动状态', () => {
  const h=setup();h.set({statuses:new Map([['a',pending('approval','a')],['b',pending('question','b')],['c',pending('future-kind','c')]])})
  assert.deepEqual(attentionFilter(h.store.getSnapshot().rows,{kind:'question',query:'b'}).map(x=>x.id),['b'])
  assert.equal(attentionNext({...h.store.getSnapshot(),phase:'offline'},'a',{}),undefined)
  assert.equal(h.store.getSnapshot().rows.length,2)
})

test('一个会话只采用官方当前优先项，切换到下一种等待后更新', () => {
  const h=setup();h.set({statuses:new Map([['a',pending('plan-review','plan')]])})
  h.set({statuses:new Map([['a',pending('question','question')]])})
  assert.deepEqual(h.store.getSnapshot().rows.map(x=>x.key),['question'])
})

test('无变化的状态不会通知渲染；初次读取中保留未知状态', () => {
  const h=setup();let count=0;h.store.subscribe(()=>count++);h.set({ready:false});assert.equal(h.store.getSnapshot().phase,'loading')
  h.set({ready:true});const before=count;h.store.update();h.store.update();assert.equal(count,before)
})

test('连接代次先被清空时也保留收到时间，直到新连接基线到达', () => {
  const h=setup();h.store.update();h.set({statuses:new Map([['a',pending('question','q')]])})
  h.set({generation:undefined})
  assert.equal(h.store.getSnapshot().phase,'offline');assert.equal(h.store.getSnapshot().rows[0].receivedAt,100)
  h.set({generation:2});assert.equal(h.store.getSnapshot().rows[0].receivedAt,null)
})

test('下一项找不到时说清原因：没有待处理、被筛选挡住、状态未确认各说各的', () => {
  const row = { id: 'a', kind: 'approval', title: 'a', cwd: '/a' }
  assert.equal(attentionNextNotice({ phase: 'ready', rows: [] }), 'attention.empty')
  assert.equal(attentionNext({ phase: 'ready', rows: [row] }, undefined, { kind: 'question' }), undefined)
  assert.equal(attentionNextNotice({ phase: 'ready', rows: [row] }), 'attention.noMatch')
  assert.equal(attentionNextNotice({ phase: 'offline', rows: [] }), 'attention.unavailable')
  assert.equal(attentionNextNotice({ phase: 'syncing', rows: [row] }), 'attention.unavailable')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paletteItems, paletteFilter, paletteGroups, paletteDefaultSelection, createPaletteController } from '../src/client/command-palette-model.js'

const session = (id, label, updatedAt, detail = '') => ({ id, displayTitle: label, updatedAt, cwd: detail })
const action = { id: 'session.new', label: '新会话' }

test('索引合并五类来源，并排除归档、子智能体、空白和当前不可用项', () => {
  const rows = paletteItems({ commands: [{ name: 'review' }], sessions: [session('a','Alpha',1),{...session('blank','',2),blank:true},{...session('child','child',3),origin:'subagent'},session('archived','Old',4)], archivedIds: ['archived'], actions: [action], rightEntries: [{ id:'files',providerId:'native',kind:'files',label:'文件' }], panels:[{id:'usage',label:'用量主页'}] })
  assert.deepEqual(rows.map(r=>r.id), ['command:review','session:a','action:session.new','right:native:files','panel:usage'])
  const none = paletteItems({commands:[{name:'review'}],rightEntries:[{id:'files',providerId:'native',kind:'files',label:'文件'}],actions:[action,{id:'right-toggle',label:'右侧栏',requiresSession:true}],hasSession:false})
  assert.deepEqual(none.map(r=>r.id), ['action:session.new'])
})

test('前缀、词首、包含、说明和路径按四档排序，同档会话按更新时间', () => {
  const rows=paletteItems({sessions:[session('path','Other',100,'/work/alpha'),session('contains','Myalpha',90),session('word','Project alpha',80),session('older','Alpha old',1),session('newer','Alpha new',2)]})
  assert.deepEqual(paletteFilter(rows,'alpha').map(r=>r.name),['newer','older','word','contains','path'])
  assert.deepEqual(paletteFilter(rows,'','session').map(r=>r.name),['path','contains','word','newer','older'])
})

test('/ 前缀只检索命令；每组默认五项且可单独展开', () => {
  const rows=paletteItems({commands:Array.from({length:8},(_,i)=>({name:'command'+i})),sessions:Array.from({length:8},(_,i)=>session(String(i),'Session '+i,i)),actions:[action]})
  const groups=paletteGroups(rows,'','all')
  assert.deepEqual(groups.map(g=>[g.id,g.items.length,g.total]),[['session',5,8],['action',1,1],['command',5,8]])
  assert.equal(paletteDefaultSelection(groups,'','all'),'action:session.new')
  assert.equal(paletteGroups(rows,'','all',new Set(['session']))[0].items.length,8)
  assert.deepEqual(paletteGroups(rows,'/command7','all').map(g=>g.items.map(r=>r.id)),[['command:command7']])
})

test('命令加载失败保留其他组，Tab 创建草稿并原样保留输入，不发送', async () => {
  const created=[],reads=[];let watching=0,stops=0
  const target={id:'a',binding:{}}
  const c=createPaletteController({target:()=>target,entries:()=>({sessions:[session('a','A',1)],actions:[action]}),commands:async()=>{reads.push('read');throw Error('offline')},watch:()=>{watching++;return()=>{stops++;watching--}},startSession:prompt=>created.push(prompt)})
  assert.equal(watching,0);assert.equal(reads.length,0)
  await c.open();assert.equal(watching,1);assert.equal(c.getSnapshot().error,true);assert.equal(c.getSnapshot().items.filter(x=>x.kind!=='command').length,2)
  c.compose('  要保留的输入  ')
  assert.deepEqual(created,['  要保留的输入  ']);assert.equal(c.getSnapshot().open,false);assert.equal(watching,0);assert.equal(stops,1)
  c.refresh();assert.equal(reads.length,1);c.compose('不能在关闭后创建');assert.equal(created.length,1)
})

test('终端和其他弹窗保留自己的按键，面板自身允许再按一次关闭', async () => {
  const { paletteShortcutEnabled } = await import('../src/client/command-palette-model.js')
  assert.equal(paletteShortcutEnabled({region:'terminal',modal:null,ownDialog:false},false),false)
  assert.equal(paletteShortcutEnabled({region:'terminal',modal:'other',ownDialog:true},true),false)
  assert.equal(paletteShortcutEnabled({region:'editable',modal:'other',ownDialog:false},false),false)
  assert.equal(paletteShortcutEnabled({region:'editable',modal:'other',ownDialog:true},true),true)
  assert.equal(paletteShortcutEnabled({region:'page',modal:null,ownDialog:false},false),true)
})

test('空白草稿和仅被右侧栏保留的会话不提供当前会话入口', async () => {
  const { paletteHasMainSession } = await import('../src/client/command-palette-model.js')
  assert.equal(paletteHasMainSession({blank:true,retainedBy:{mainView:1}}),false)
  assert.equal(paletteHasMainSession({blank:false,retainedBy:{sidebar:1}}),false)
  assert.equal(paletteHasMainSession({blank:false,retainedBy:{mainView:1}}),true)
  assert.equal(paletteHasMainSession(undefined),false)
})

test('相同匹配档中精确名称的组优先，组内会话仍按最近更新排序', () => {
  const rows = paletteItems({sessions:[session('a','插件测试',20),session('b','插件',10)],panels:[{id:'plugins',label:'插件'}]})
  const groups = paletteGroups(rows,'插件','all')
  assert.deepEqual(groups.map(group=>group.id),['panel','session'])
  assert.deepEqual(groups[1].items.map(row=>row.name),['a','b'])
})

test('⌘/ 焦点在侧边栏时也进命令面板，设置页和快捷键窗口里仍走官方', async () => {
  const { shortcutsCommandOwner } = await import('../src/client/command-palette-model.js')
  assert.equal(shortcutsCommandOwner(null, false), 'palette')
  assert.equal(shortcutsCommandOwner(undefined, false), 'palette')
  assert.equal(shortcutsCommandOwner('sidebar', false), 'palette')
  assert.equal(shortcutsCommandOwner('settings', false), 'official')
  assert.equal(shortcutsCommandOwner('shortcuts', true), 'official')
  assert.equal(shortcutsCommandOwner('other', false), 'official')
  assert.equal(shortcutsCommandOwner('other', true), 'palette')
})

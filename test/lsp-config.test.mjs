import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseLspConfig,createLspPresetEntry,assertLspAdmission} from '../lib/lsp-config.js'

const paths={nodePath:'/runtime/node',serverPath:'/language/server.mjs',typescriptPath:'/language/tsserver.js'}
test('语言服务路径必须显式绝对定位，不能从试用目录猜默认值',()=>{
  assert.deepEqual(parseLspConfig(paths),paths)
  for(const key of Object.keys(paths))assert.throws(()=>parseLspConfig({...paths,[key]:'relative'}),/absolute/)
  assert.throws(()=>parseLspConfig({}),/nodePath/)
  assert.throws(()=>parseLspConfig({...paths,initializationOptions:{disableAutomaticTypingAcquisition:false}}),/Unknown/)
})
test('配置片段只有一个可关闭的隔离组，不覆盖现有编码预设列表',()=>{
  const entry=createLspPresetEntry(paths)
  assert.equal(entry.id,'dsh-workbench-lsp');assert.equal(entry.name,'cordis:group');assert.equal(entry.group,true)
  assert.deepEqual(entry.isolate,{lsp:true});assert.equal(entry.config[0].name,'@miint-sunny/dsh-workbench/lsp');assert.deepEqual(entry.config[0].config,paths)
})
test('chore136 LSP 缺包或版本不一致返回不可用；仅全局误挂仍拒绝',()=>{
  assert.throws(()=>assertLspAdmission(false,'0.2.2-rc.1',['0.2.2-rc.1','0.2.2-rc.1','0.2.2-rc.1']),/preset/)
  assert.equal(assertLspAdmission(true,'0.2.2-rc.1',['0.2.2-rc.1','0.2.3','0.2.2-rc.1']),false)
  assert.equal(assertLspAdmission(true,'0.2.3',[]),false)
  assert.equal(assertLspAdmission(true,'0.2.3',['0.2.3','0.2.3','0.2.3']),true)
})

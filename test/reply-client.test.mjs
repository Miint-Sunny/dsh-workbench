import test from 'node:test'
import assert from 'node:assert/strict'
import { REPLY_ZH, REPLY_EN, replyMessageText, replyKeyAction, replyMenuOf } from '../src/client/reply.js'

test('回复发出去的文字：引用每行加 >，空一行，再是回复', () => {
  assert.equal(replyMessageText('第 16 件要下次重启才生效', ' 可以重启 \n'), '> 第 16 件要下次重启才生效\n\n可以重启')
  assert.equal(replyMessageText('第一行\r\n第二行', '好'), '> 第一行\n> 第二行\n\n好')
})

test('回复框的按键：Enter 添加到输入框，⌘Enter 或 Ctrl+Enter 发送，Shift+Enter 换行，组词时不算', () => {
  assert.equal(replyKeyAction({ key: 'Enter' }), 'add')
  assert.equal(replyKeyAction({ key: 'Enter', metaKey: true }), 'send')
  assert.equal(replyKeyAction({ key: 'Enter', ctrlKey: true }), 'send')
  assert.equal(replyKeyAction({ key: 'Enter', shiftKey: true }), null)
  assert.equal(replyKeyAction({ key: 'Enter', isComposing: true }), null, '输入法选词的回车不能把回复发出去')
  assert.equal(replyKeyAction({ key: 'Enter', keyCode: 229 }), null)
  assert.equal(replyKeyAction({ key: 'a' }), null)
})

test('计划待审时：输入框被审阅面板占着，回车不添加，只留「发送回复」', () => {
  assert.equal(replyKeyAction({ key: 'Enter' }, { reviewing: true }), null)
  assert.equal(replyKeyAction({ key: 'Enter', metaKey: true }, { reviewing: true }), 'send')
  assert.equal(replyKeyAction({ key: 'Enter', ctrlKey: true }, { reviewing: true }), 'send')
  assert.deepEqual(replyMenuOf(true), { add: false, send: true })
})

test('不是待审时：按键和菜单都不变', () => {
  assert.equal(replyKeyAction({ key: 'Enter' }, { reviewing: false }), 'add')
  assert.deepEqual(replyMenuOf(false), { add: true, send: true })
  assert.equal(replyKeyAction({ key: 'Enter' }), 'add', '不传状态的老用法不变')
  assert.deepEqual(replyMenuOf(), { add: true, send: true })
})

test('中英文词典的键一样', () => {
  assert.deepEqual(Object.keys(REPLY_EN).sort(), Object.keys(REPLY_ZH).sort())
})

import * as reply from '../src/client/reply.js'
test('回复卡片把菜单一起定位，靠近顶部和底部也留在会话可见区',()=>{
  assert.equal(typeof reply.placeReplySurface,'function')
  const bounds={left:280,top:76,right:1280,bottom:900}
  const top=reply.placeReplySurface({left:430,right:700,top:80,bottom:100},{width:380,height:160},bounds)
  assert.equal(top.top,108)
  const bottom=reply.placeReplySurface({left:430,right:700,top:850,bottom:870},{width:380,height:160},bounds)
  assert.equal(bottom.top,682)
  const narrow=reply.placeReplySurface({left:5,right:50,top:80,bottom:100},{width:380,height:600},{left:0,top:0,right:320,bottom:300})
  assert.equal(narrow.width,304);assert.equal(narrow.maxHeight,284);assert.equal(narrow.left,8);assert.equal(narrow.top,8)
})
test('添加回复时尊重插入失败，重试不重复放入已经接受的引用',()=>{
  assert.equal(typeof reply.addReplyToInput,'function')
  const accepted=[];let bodyAllowed=false
  const actions={insertQuote:q=>{accepted.push(q);return true},captureInsertion:()=>({draftRev:1}),insertText:text=>{if(!bodyAllowed)return false;accepted.push(text);return true}}
  const first=reply.addReplyToInput(actions,'引用','回复',false)
  assert.deepEqual(first,{ok:false,quoteInserted:true})
  bodyAllowed=true
  assert.deepEqual(reply.addReplyToInput(actions,'引用','回复',first.quoteInserted),{ok:true,quoteInserted:true})
  assert.deepEqual(accepted,['引用','回复\n'])
})
test('只收拢消息末尾的空白越界，不改变真正跨来源的选区',()=>{
  assert.equal(typeof reply.shouldClampReplySelection,'function')
  const base={startsInSource:true,endsInSource:false,gapText:'\n  '}
  assert.equal(reply.shouldClampReplySelection(base),true)
  assert.equal(reply.shouldClampReplySelection({...base,gapText:'另一条消息'}),false)
  assert.equal(reply.shouldClampReplySelection({...base,endsInSource:true}),false)
  assert.equal(reply.shouldClampReplySelection({...base,startsInSource:false}),false)
})

test('挂载：盖住官方选区按钮和引用显示；撤销后样式、监听、覆盖都收干净', () => {
  const live = { style: 0, listeners: 0, entries: [] }
  globalThis.document = {
    createElement: () => ({ dataset: {}, remove() { live.style -= 1 } }),
    head: { appendChild() { live.style += 1 } },
  }
  globalThis.window = {
    addEventListener() { live.listeners += 1 },
    removeEventListener() { live.listeners -= 1 },
  }
  try {
    const ctx = {
      effect: body => body(),
      slots: {
        inject(name, mount) {
          const entry = mount()
          live.entries.push(entry)
          return () => { live.entries.splice(live.entries.indexOf(entry), 1) }
        },
        register: entry => entry,
      },
    }
    const dispose = reply.applyReply({ ctx, t: key => key })
    assert.deepEqual(live.entries.map(entry => [entry.name, entry.key, entry.priority]), [
      ['conversation.chat.text-interaction', 'quote', -1],
      ['conversation.user.text.node', 'quote', -1],
    ])
    assert.equal(live.style, 1)
    assert.equal(live.listeners, 1)
    dispose()
    assert.deepEqual(live, { style: 0, listeners: 0, entries: [] })
  } finally {
    delete globalThis.document
    delete globalThis.window
  }
})

test('能不能回复：照 0.2.2-rc.2 官方引用按钮，主会话和可续写的子智能体会话可以，快照里没有 parentAvailable 也一样', () => {
  assert.equal(reply.replyEnabled({ removed: false, subagent: null }), true)
  assert.equal(reply.replyEnabled({ removed: false, subagent: { address: { mode: 'continuable' } } }), true)
  assert.equal(reply.replyEnabled({ removed: false, subagent: { address: { mode: 'one-shot' } } }), false)
  assert.equal(reply.replyEnabled({ removed: false, subagent: { address: { mode: 'unknown' } } }), false)
  assert.equal(reply.replyEnabled({ removed: true, subagent: null }), false)
  assert.equal(reply.replyEnabled({ removed: true, subagent: { address: { mode: 'continuable' } } }), false)
})

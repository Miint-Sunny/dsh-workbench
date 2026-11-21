import test from 'node:test'
import assert from 'node:assert/strict'
import { OFFICIAL_HEAD, SEVEN_ITEMS, swapInstruction } from '../lib/compaction-prompt.js'

const official = `${OFFICIAL_HEAD} for this AI coding assistant. Condense the conversation ABOVE.`
const history = [Object.freeze({ role: 'system', content: [{ type: 'text', text: 'sys' }] }), Object.freeze({ role: 'user', content: [{ type: 'text', text: 'hi' }] })]
const options = (text = official) => ({ purpose: 'compaction', sessionId: 's', messages: [...history, { role: 'user', content: [{ type: 'text', text }] }] })
const lastText = messages => messages.at(-1).content[0].text

test('官方原文、没有补充时不换', () => {
  assert.equal(swapInstruction(options(), { selection: 'official', custom: '', locale: 'zh' }), undefined)
})

test('保留七项只换最后一条，前面的消息还是原来那些对象', () => {
  const messages = swapInstruction(options(), { selection: 'seven', custom: '', locale: 'zh' })
  assert.equal(lastText(messages), SEVEN_ITEMS.zh)
  assert.equal(messages.length, 3)
  assert.equal(messages[0], history[0])
  assert.equal(messages[1], history[1])
})

test('保留七项写了用户的七项，每一节都在', () => {
  for (const section of ['## 任务目标', '## 完整计划或审计', '## 上一步', '## 改过的文件', '## 关键决策', '## 踩过的坑', '## 下一步']) assert.ok(SEVEN_ITEMS.zh.includes(section), section)
  for (const section of ['## Goal', '## Full plan or audit', '## Last step', '## Changed files', '## Key decisions', '## Pitfalls', '## Next steps']) assert.ok(SEVEN_ITEMS.en.includes(section), section)
})

test('自定义用用户写的文字', () => {
  assert.equal(lastText(swapInstruction(options(), { selection: 'custom', custom: '只留目标', locale: 'zh' })), '只留目标')
})

test('自定义文字是空的时候不换，不发空说明', () => {
  assert.equal(swapInstruction(options(), { selection: 'custom', custom: '  ', locale: 'zh' }), undefined)
})

test('一次性的补充接在提示词后面，官方原文也能带', () => {
  assert.ok(lastText(swapInstruction(options(), { selection: 'official', custom: '', locale: 'zh', extra: '多留数据库的部分' })).startsWith(official))
  assert.ok(lastText(swapInstruction(options(), { selection: 'official', custom: '', locale: 'zh', extra: '多留数据库的部分' })).endsWith('多留数据库的部分'))
  const seven = lastText(swapInstruction(options(), { selection: 'seven', custom: '', locale: 'zh', extra: '多留数据库的部分' }))
  assert.ok(seven.startsWith(SEVEN_ITEMS.zh))
  assert.ok(seven.endsWith('多留数据库的部分'))
})

test('不是官方说明时一律不碰：示例助手自己的提示词、已经换过的请求', () => {
  for (const text of ['你是示例助手的压缩助手。', SEVEN_ITEMS.zh, '']) {
    assert.equal(swapInstruction(options(text), { selection: 'seven', custom: '', locale: 'zh', extra: '补充' }), undefined)
  }
})

test('最后一条的形状不对时不碰', () => {
  const bad = { purpose: 'compaction', messages: [...history, { role: 'assistant', content: [{ type: 'text', text: official }] }] }
  assert.equal(swapInstruction(bad, { selection: 'seven', custom: '', locale: 'zh' }), undefined)
  assert.equal(swapInstruction({ purpose: 'compaction', messages: [] }, { selection: 'seven', custom: '', locale: 'zh' }), undefined)
})

test('不是压缩请求时不碰', () => {
  assert.equal(swapInstruction({ ...options(), purpose: undefined }, { selection: 'seven', custom: '', locale: 'zh' }), undefined)
})

test('语言没有对应版本时用中文', () => {
  assert.equal(lastText(swapInstruction(options(), { selection: 'seven', custom: '', locale: 'fr' })), SEVEN_ITEMS.zh)
  assert.equal(lastText(swapInstruction(options(), { selection: 'seven', custom: '', locale: 'en' })), SEVEN_ITEMS.en)
})

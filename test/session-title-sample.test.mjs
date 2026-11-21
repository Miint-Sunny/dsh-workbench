/** 会话标题的取样和提示词（从 dsh-session-title-headtail 的 test/sample.test.mjs 搬来，feat#217）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clip, conversationOf, frameSample, humanSeqsOf, promptsSince, selectSample, systemPrompt, textOf, titleEffortOf } from '../lib/session-title-sample.js'

const human = (seq, text) => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const injected = (seq, text) => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: 'system' } } })
const assistant = (seq, text, extra = []) => ({
  type: 'assistant/message',
  seq,
  data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden thoughts' }, ...extra, ...(text ? [{ type: 'text', text }] : [])] } },
})
const limits = { tailMessages: 6, headMaxChars: 2000, messageMaxChars: 1500, maxInputChars: 8000 }

test('textOf keeps only text blocks', () => {
  assert.equal(textOf([{ type: 'reasoning', text: 'x' }, { type: 'text', text: ' a ' }, { type: 'tool-call', name: 'bash' }]), 'a')
  assert.equal(textOf(undefined), '')
})

test('conversationOf drops reasoning, tool-only replies, and injected messages', () => {
  const items = conversationOf([
    human(1, 'build a parser'),
    assistant(2, '', [{ type: 'tool-call', name: 'bash' }]),
    injected(3, 'system reminder'),
    assistant(4, 'done'),
    { type: 'turn/end', seq: 5, data: {} },
  ])
  assert.deepEqual(items, [
    { role: 'user', seq: 1, text: 'build a parser' },
    { role: 'assistant', seq: 4, text: 'done' },
  ])
})

test('selectSample keeps the head and the newest N items', () => {
  const events = [human(1, 'first')]
  for (let seq = 2; seq <= 21; seq += 1) events.push(seq % 2 === 0 ? assistant(seq, `a${seq}`) : human(seq, `u${seq}`))
  const sample = selectSample(conversationOf(events), { seq: 1, text: 'first' }, limits)
  assert.equal(sample.head.text, 'first')
  assert.deepEqual(sample.tail.map((item) => item.seq), [16, 17, 18, 19, 20, 21])
  assert.equal(sample.omitted, 14)
})

test('selectSample drops the oldest tail items first when over budget', () => {
  const big = 'x'.repeat(1500)
  const events = [human(1, 'first'), human(2, big), assistant(3, big), human(4, big), assistant(5, big), human(6, big), assistant(7, 'newest')]
  const sample = selectSample(conversationOf(events), { seq: 1, text: 'first' }, { ...limits, maxInputChars: 3200 })
  assert.equal(sample.tail.at(-1).text, 'newest')
  assert.equal(sample.head.text, 'first')
  const total = sample.head.text.length + sample.tail.reduce((n, item) => n + item.text.length, 0)
  assert.ok(total <= 3200, `total ${total}`)
  assert.ok(sample.omitted >= 3)
})

test('selectSample clips a single oversized newest message', () => {
  const sample = selectSample(conversationOf([human(1, 'first'), assistant(2, 'y'.repeat(5000))]), { seq: 1, text: 'first' }, { ...limits, messageMaxChars: 5000, maxInputChars: 1000 })
  assert.equal(sample.tail.length, 1)
  assert.ok(Array.from(sample.tail[0].text).length <= 1000)
})

test('clip counts code points and marks the cut', () => {
  assert.equal(clip('短文本', 10), '短文本')
  assert.equal(clip('一二三四五六', 4), '一二三…')
})

test('humanSeqsOf returns offered human seqs in ascending order', () => {
  const sample = { head: { seq: 1 }, tail: [{ role: 'assistant', seq: 4 }, { role: 'user', seq: 5 }, { role: 'user', seq: 9 }] }
  assert.deepEqual(humanSeqsOf(sample, [{ seq: 1 }, { seq: 5 }]), [1, 5])
})

test('frameSample is valid JSON after the header line and mentions omissions', () => {
  const text = frameSample({ head: { text: 'a "quoted" ask' }, tail: [{ role: 'user', text: 'next' }], omitted: 3 })
  assert.match(text, /3 earlier messages/)
  const payload = JSON.parse(text.slice(text.indexOf('\n') + 1))
  assert.equal(payload.first_request, 'a "quoted" ask')
  assert.deepEqual(payload.recent_conversation, [{ role: 'user', text: 'next' }])
})

test('promptsSince counts human prompts after the latest title source', () => {
  const events = [human(1, 'a'), assistant(2, 'b'), human(3, 'c'), injected(4, 'x'), human(5, 'd')]
  assert.equal(promptsSince(events, [1]), 2)
  assert.equal(promptsSince(events, []), 3)
})

test('titleEffortOf picks the first preferred effort the model declares', () => {
  const preferred = ['off', 'none', 'minimal', 'low']
  const efforts = (...ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })) } })
  assert.equal(titleEffortOf(efforts('off', 'low', 'high', 'max'), preferred), 'off')
  assert.equal(titleEffortOf(efforts('high', 'low', 'medium'), preferred), 'low')
  assert.equal(titleEffortOf(efforts('high', 'max'), preferred), undefined)
  assert.equal(titleEffortOf({}, preferred), undefined)
})

test('selectSample without context keeps only the opening message', () => {
  const items = conversationOf([human(1, 'first'), assistant(2, 'reply'), human(3, 'second')])
  const sample = selectSample(items, { seq: 1, text: 'first' }, limits, false)
  assert.deepEqual(sample, { head: { seq: 1, text: 'first' }, tail: [], omitted: 0 })
  assert.deepEqual(humanSeqsOf(sample, [{ seq: 1 }, { seq: 3 }]), [1])
})

test('frameSample and systemPrompt without context mention only the opening message', () => {
  const framed = frameSample({ head: { text: 'build a parser' }, tail: [], omitted: 0 })
  assert.deepEqual(JSON.parse(framed.split('\n').slice(1).join('\n')), { first_request: 'build a parser' })
  assert.doesNotMatch(framed, /recent_conversation/)
  const targets = { targetWords: 6, targetCjkCharacters: 12 }
  assert.doesNotMatch(systemPrompt(targets, false), /what the conversation is about now/)
  assert.match(systemPrompt(targets, true), /what the conversation is about now/)
})

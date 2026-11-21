import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompactionState } from '../lib/compaction-state.js'

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-compaction-state-'))
  try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('什么都没设时默认都关闭，提示词是官方原文，也不写文件', () => withDir(dir => {
  const state = createCompactionState({ dir })
  assert.deepEqual(state.effective('s1'), { work: null, idle: null, idleMinutes: 30, overridden: false })
  assert.deepEqual(state.prompt(), { selection: 'official', custom: '' })
  assert.equal(existsSync(join(dir, 'compaction.json')), false)
}))

test('改一个会话只影响这个会话，重开还在', () => withDir(dir => {
  createCompactionState({ dir }).setSession('s1', { idle: 300_000 })
  const state = createCompactionState({ dir })
  assert.deepEqual(state.effective('s1'), { work: null, idle: 300_000, idleMinutes: 30, overridden: true })
  assert.deepEqual(state.effective('s2'), { work: null, idle: null, idleMinutes: 30, overridden: false })
}))

test('改回和默认一样就不再算单独记', () => withDir(dir => {
  const state = createCompactionState({ dir })
  state.setSession('s1', { idle: 300_000, idleMinutes: 60 })
  state.setSession('s1', { idle: null })
  assert.deepEqual(state.effective('s1'), { work: null, idle: null, idleMinutes: 60, overridden: true })
  state.setSession('s1', { idleMinutes: 30 })
  assert.equal(state.effective('s1').overridden, false)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'compaction.json'), 'utf8')).sessions, {})
}))

test('恢复默认清掉这个会话的设置', () => withDir(dir => {
  const state = createCompactionState({ dir })
  state.setSession('s1', { work: 400_000 })
  state.resetSession('s1')
  assert.deepEqual(state.effective('s1'), { work: null, idle: null, idleMinutes: 30, overridden: false })
}))

test('改默认影响没单独设的会话，不影响单独设过的', () => withDir(dir => {
  const state = createCompactionState({ dir })
  state.setSession('s1', { idle: 200_000 })
  state.setDefaults({ idle: 300_000, work: 400_000 })
  assert.deepEqual(state.effective('s1'), { work: 400_000, idle: 200_000, idleMinutes: 30, overridden: true })
  assert.deepEqual(state.effective('s2'), { work: 400_000, idle: 300_000, idleMinutes: 30, overridden: false })
  assert.deepEqual(state.defaults(), { work: 400_000, idle: 300_000, idleMinutes: 30 })
}))

test('分叉的会话没单独设时跟原会话走，自己设了以自己为准', () => withDir(dir => {
  const state = createCompactionState({ dir })
  state.setSession('parent', { idle: 300_000 })
  assert.deepEqual(state.effective('child', 'parent'), { work: null, idle: 300_000, idleMinutes: 30, overridden: false })
  state.setSession('child', { idle: 400_000 })
  assert.equal(state.effective('child', 'parent').idle, 400_000)
}))

test('档位只收 100K 的整数倍，时长只收列出的几档，其余报错不写入', () => withDir(dir => {
  const state = createCompactionState({ dir })
  for (const bad of [{ idle: 50_000 }, { idle: 150_000 }, { work: 0 }, { work: -100_000 }, { idle: '300000' }, { idleMinutes: 7 }, { nope: 1 }]) {
    assert.throws(() => state.setSession('s1', bad), /invalid/)
    assert.throws(() => state.setDefaults(bad), /invalid/)
  }
  assert.equal(state.effective('s1').overridden, false)
  assert.equal(existsSync(join(dir, 'compaction.json')), false)
}))

test('会话 id 不合法时报错', () => withDir(dir => {
  const state = createCompactionState({ dir })
  for (const id of ['', '../x', 'a b', 'x'.repeat(201)]) assert.throws(() => state.setSession(id, { idle: 300_000 }), /invalid/)
}))

test('提示词三档能存能读，自定义文字选别的档也留着', () => withDir(dir => {
  const state = createCompactionState({ dir })
  state.setPrompt({ selection: 'custom', custom: '只保留目标' })
  assert.deepEqual(createCompactionState({ dir }).prompt(), { selection: 'custom', custom: '只保留目标' })
  state.setPrompt({ selection: 'seven' })
  assert.deepEqual(createCompactionState({ dir }).prompt(), { selection: 'seven', custom: '只保留目标' })
  state.setPrompt({ selection: 'official' })
  assert.equal(state.prompt().selection, 'official')
}))

test('自定义不能是空的，也不能太长', () => withDir(dir => {
  const state = createCompactionState({ dir, maxPromptChars: 100 })
  assert.throws(() => state.setPrompt({ selection: 'custom', custom: '   ' }), /invalid/)
  assert.throws(() => state.setPrompt({ selection: 'custom' }), /invalid/)
  assert.throws(() => state.setPrompt({ selection: 'custom', custom: 'x'.repeat(101) }), /invalid/)
  assert.throws(() => state.setPrompt({ selection: 'other' }), /invalid/)
  assert.equal(state.prompt().selection, 'official')
}))

test('文件坏了按默认回答并报出来，第一次写之前留一份 .bad', () => withDir(dir => {
  writeFileSync(join(dir, 'compaction.json'), '{bad json')
  const state = createCompactionState({ dir })
  assert.equal(state.reason(), 'corrupt')
  assert.equal(state.effective('s1').idle, null)
  assert.equal(readFileSync(join(dir, 'compaction.json'), 'utf8'), '{bad json')
  state.setSession('s1', { idle: 300_000 })
  assert.equal(readFileSync(join(dir, 'compaction.json.bad'), 'utf8'), '{bad json')
  assert.equal(createCompactionState({ dir }).reason(), null)
}))

test('形状不对也算坏文件', () => withDir(dir => {
  writeFileSync(join(dir, 'compaction.json'), JSON.stringify({ version: 1, defaults: { idle: 7 }, sessions: {} }))
  assert.equal(createCompactionState({ dir }).reason(), 'corrupt')
}))

test('会话数有上限，超过时丢最早的', () => withDir(dir => {
  const state = createCompactionState({ dir, maxSessions: 2 })
  state.setSession('a', { idle: 300_000 })
  state.setSession('b', { idle: 300_000 })
  state.setSession('c', { idle: 300_000 })
  assert.equal(state.effective('a').overridden, false)
  assert.equal(state.effective('b').overridden, true)
  assert.equal(state.effective('c').overridden, true)
}))

test('写文件走临时文件改名，不留临时文件', () => withDir(dir => {
  createCompactionState({ dir }).setSession('s1', { idle: 300_000 })
  assert.deepEqual(readdirSync(dir), ['compaction.json'])
}))

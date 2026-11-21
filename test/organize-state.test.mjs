/** organize 行宿主端纯函数：默认状态、文件形状校验、三种操作、损坏文件的处理、写入排队（lib/organize-state.js）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_BATCH, MAX_SESSIONS, backupOrganizeFile, createOrganizeFile, defaultOrganizeState,
  organizeApply, parseOrganizeState, readOrganizeState, writeOrganizeState,
} from '../lib/organize-state.js'

test('organize defaults: six labels with default names, nothing assigned', () => {
  assert.deepEqual(defaultOrganizeState(), {
    version: 1,
    labels: [
      { id: 'red', name: '红色' }, { id: 'orange', name: '橙色' }, { id: 'yellow', name: '黄色' },
      { id: 'green', name: '绿色' }, { id: 'blue', name: '蓝色' }, { id: 'purple', name: '紫色' },
    ],
    assignments: {},
    unread: [],
  })
})

test('organize parse: valid file round-trips, names trimmed, unread deduped', () => {
  const state = parseOrganizeState({
    version: 1,
    labels: [
      { id: 'red', name: ' 红色 ' }, { id: 'orange', name: '待回复' }, { id: 'yellow', name: '黄色' },
      { id: 'green', name: '绿色' }, { id: 'blue', name: '长期项目' }, { id: 'purple', name: '紫色' },
    ],
    assignments: { s1: 'red', s2: 'blue' },
    unread: ['s3', 's3', 's1'],
  })
  assert.deepEqual(state, {
    version: 1,
    labels: [
      { id: 'red', name: '红色' }, { id: 'orange', name: '待回复' }, { id: 'yellow', name: '黄色' },
      { id: 'green', name: '绿色' }, { id: 'blue', name: '长期项目' }, { id: 'purple', name: '紫色' },
    ],
    assignments: { s1: 'red', s2: 'blue' },
    unread: ['s3', 's1'],
  })
  // 不认识的多余字段丢弃（文件比代码旧时按认识的字段读）。
  assert.deepEqual(
    parseOrganizeState({ ...defaultOrganizeState(), extra: 'ignored' }),
    defaultOrganizeState(),
  )
})

test('organize parse: bad shapes throw', () => {
  const good = defaultOrganizeState()
  const cases = [
    null, 'nope', 42, [],
    { ...good, version: 2 },
    { ...good, labels: good.labels.slice(0, 5) },
    { ...good, labels: good.labels.map(label => (label.id === 'orange' ? { id: 'red', name: '红' } : label)) },
    { ...good, labels: good.labels.map(label => (label.id === 'red' ? { id: 'red', name: '橙色' } : label)) },
    { ...good, labels: good.labels.map(label => (label.id === 'red' ? { id: 'red', name: '' } : label)) },
    { ...good, labels: good.labels.map(label => (label.id === 'red' ? { id: 'red', name: 'x'.repeat(21) } : label)) },
    { ...good, labels: good.labels.map(label => (label.id === 'red' ? { id: 'scarlet', name: '红' } : label)) },
    { ...good, assignments: [] },
    { ...good, assignments: { s1: 'scarlet' } },
    { ...good, assignments: { '': 'red' } },
    { ...good, unread: 's1' },
    { ...good, unread: [42] },
    { ...good, unread: [''] },
  ]
  for (const value of cases) assert.throws(() => parseOrganizeState(value), undefined, JSON.stringify(value).slice(0, 60))
  // 会话数超上限也按损坏处理。
  const assignments = {}
  for (let at = 0; at < MAX_SESSIONS + 1; at += 1) assignments[`s${at}`] = 'red'
  assert.throws(() => parseOrganizeState({ ...good, assignments }))
})

test('organize apply setLabel: set, overwrite, clear; bad input fails with codes', () => {
  const state = defaultOrganizeState()
  const set = (body, from = state) => organizeApply(from, { op: 'setLabel', ...body })
  assert.deepEqual(set({ sessionIds: ['s1'], labelId: 'red' }).state.assignments, { s1: 'red' })
  assert.deepEqual(set({ sessionIds: ['s1'], labelId: 'blue' }).state.assignments, { s1: 'blue' })
  assert.deepEqual(set({ sessionIds: ['s1', 's2'], labelId: null }).state.assignments, {})
  // null 之外的非法 labelId、坏的 sessionIds 都拒绝，返回给网页端翻译的失败码。
  assert.deepEqual(set({ sessionIds: ['s1'], labelId: 'scarlet' }), { ok: false, code: 'labelId.bad' })
  for (const [body, code] of [
    [{ labelId: null }, 'sessionIds.empty'],
    [{ sessionIds: [], labelId: null }, 'sessionIds.empty'],
    [{ sessionIds: 's1', labelId: null }, 'sessionIds.empty'],
    [{ sessionIds: Array.from({ length: MAX_BATCH + 1 }, (_, at) => `s${at}`), labelId: null }, 'sessionIds.tooMany'],
    [{ sessionIds: [42], labelId: null }, 'sessionIds.bad'],
    [{ sessionIds: [''], labelId: null }, 'sessionIds.bad'],
    [{ sessionIds: ['x'.repeat(201)], labelId: null }, 'sessionIds.bad'],
  ]) {
    assert.deepEqual(set(body), { ok: false, code }, JSON.stringify(body).slice(0, 50))
  }
  // 操作不认识、请求体不是对象都拒绝。
  assert.deepEqual(organizeApply(state, { op: 'nope' }), { ok: false, code: 'op.bad' })
  assert.deepEqual(organizeApply(state, null), { ok: false, code: 'body.bad' })
  // 原状态不被改动。
  assert.deepEqual(state, defaultOrganizeState())
})

test('organize apply setLabel: total session count is capped', () => {
  let state = defaultOrganizeState()
  // 分批把 5000 个会话都标上（每批最多 200）。
  for (let batch = 0; batch < MAX_SESSIONS / MAX_BATCH; batch += 1) {
    const ids = Array.from({ length: MAX_BATCH }, (_, at) => `s${batch * MAX_BATCH + at}`)
    const result = organizeApply(state, { op: 'setLabel', sessionIds: ids, labelId: 'red' })
    assert.equal(result.ok, true)
    state = result.state
  }
  // 第 5001 个新会话拒绝；给已有的会话换标签不受影响。
  assert.deepEqual(
    organizeApply(state, { op: 'setLabel', sessionIds: ['new'], labelId: 'red' }),
    { ok: false, code: 'sessions.tooMany' },
  )
  assert.equal(organizeApply(state, { op: 'setLabel', sessionIds: ['s0'], labelId: 'blue' }).ok, true)
})

test('organize apply renameLabel: trim, validate, reject duplicates', () => {
  const state = defaultOrganizeState()
  const rename = (name, from = state) => organizeApply(from, { op: 'renameLabel', labelId: 'red', name })
  const renamed = rename(' 待回复 ')
  assert.deepEqual(renamed.state.labels[0], { id: 'red', name: '待回复' })
  assert.deepEqual(rename(''), { ok: false, code: 'name.empty' })
  assert.deepEqual(rename('   '), { ok: false, code: 'name.empty' })
  assert.deepEqual(rename('x'.repeat(21)), { ok: false, code: 'name.tooLong' })
  assert.deepEqual(rename('橙色'), { ok: false, code: 'name.duplicate' })
  assert.deepEqual(organizeApply(state, { op: 'renameLabel', labelId: 'scarlet', name: 'x' }), { ok: false, code: 'labelId.bad' })
  assert.deepEqual(organizeApply(state, { op: 'renameLabel', labelId: 'red', name: 42 }), { ok: false, code: 'name.bad' })
  assert.deepEqual(state, defaultOrganizeState())
})

test('organize apply setUnread: mark, idempotent, unmark; bad input fails', () => {
  const state = defaultOrganizeState()
  const mark = (sessionIds, unread, from = state) => organizeApply(from, { op: 'setUnread', sessionIds, unread })
  const marked = mark(['s1', 's2'], true).state
  assert.deepEqual(marked.unread, ['s1', 's2'])
  assert.deepEqual(mark(['s1'], true, marked).state.unread, ['s1', 's2'])
  assert.deepEqual(mark(['s1'], false, marked).state.unread, ['s2'])
  // 清掉没标过的也不报错。
  assert.deepEqual(mark(['gone'], false).state.unread, [])
  assert.deepEqual(mark(['s1'], 'yes'), { ok: false, code: 'unread.bad' })
  assert.deepEqual(mark([], true), { ok: false, code: 'sessionIds.empty' })
  // 未读的新会话也计入 5000 的上限。
  let unreadAll = state
  for (let batch = 0; batch < MAX_SESSIONS / MAX_BATCH; batch += 1) {
    const ids = Array.from({ length: MAX_BATCH }, (_, at) => `s${batch * MAX_BATCH + at}`)
    const result = mark(ids, true, unreadAll)
    assert.equal(result.ok, true)
    unreadAll = result.state
  }
  assert.deepEqual(mark(['new'], true, unreadAll), { ok: false, code: 'sessions.tooMany' })
})

test('organize storage: missing file gives defaults, corrupt file flags without touching the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-organize-'))
  try {
    assert.deepEqual(readOrganizeState(dir), { state: defaultOrganizeState(), corrupt: false })
    writeFileSync(join(dir, 'organize.json'), '{broken')
    assert.deepEqual(readOrganizeState(dir), { state: defaultOrganizeState(), corrupt: true })
    writeFileSync(join(dir, 'organize.json'), JSON.stringify({ version: 2 }))
    assert.equal(readOrganizeState(dir).corrupt, true)
    // 读不改文件：坏内容原样留着，等第一次写之前备份。
    assert.equal(readFileSync(join(dir, 'organize.json'), 'utf8'), JSON.stringify({ version: 2 }))
    writeOrganizeState(dir, defaultOrganizeState())
    assert.deepEqual(readOrganizeState(dir), { state: defaultOrganizeState(), corrupt: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('organize backup: renames to .bad, second time adds a timestamp, missing file is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-organize-backup-'))
  try {
    writeOrganizeState(dir, defaultOrganizeState())
    const first = backupOrganizeFile(dir)
    assert.equal(first, join(dir, 'organize.json.bad'))
    assert.equal(existsSync(join(dir, 'organize.json')), false)
    assert.equal(backupOrganizeFile(dir), undefined)
    writeOrganizeState(dir, defaultOrganizeState())
    const second = backupOrganizeFile(dir)
    assert.match(second, /organize\.json\.\d+\.bad$/)
    assert.equal(existsSync(join(dir, 'organize.json.bad')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('organize file: first write backs up a corrupt file, then writes fresh; writes queue in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-organize-file-'))
  try {
    writeFileSync(join(dir, 'organize.json'), '{broken')
    const file = createOrganizeFile(dir)
    const first = await file.apply({ op: 'setLabel', sessionIds: ['s1'], labelId: 'red' })
    assert.equal(first.ok, true)
    // 坏文件先备份再写新状态。
    assert.equal(readFileSync(join(dir, 'organize.json.bad'), 'utf8'), '{broken')
    assert.deepEqual(readOrganizeState(dir).state.assignments, { s1: 'red' })
    // 两个写操作并发发出：排队执行，后一个在前一个的状态上算（都生效）。
    const [a, b] = await Promise.all([
      file.apply({ op: 'setLabel', sessionIds: ['s2'], labelId: 'blue' }),
      file.apply({ op: 'setUnread', sessionIds: ['s3'], unread: true }),
    ])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    const { state } = readOrganizeState(dir)
    assert.deepEqual(state.assignments, { s1: 'red', s2: 'blue' })
    assert.deepEqual(state.unread, ['s3'])
    // 校验失败不改文件。
    const before = readOrganizeState(dir).state
    assert.equal((await file.apply({ op: 'setUnread', sessionIds: ['s4'], unread: 'x' })).ok, false)
    assert.deepEqual(readOrganizeState(dir).state, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

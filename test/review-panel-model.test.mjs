/** 审阅面板的纯函数：地址和入口参数、范围菜单、各范围能做的操作、回退确认、错误文案、审查发现的位置、评论消息、相对时间、选提交。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  commitSelection, composeScopeMessage, fileActions, hunkActions, parseReviewPanelAddress, placeFindings,
  reportScope, reviewAgo, reviewEntryOf, scopeMessageText, reviewErrorKey, reviewPanelAddress, revertAllSummary, scopeActions,
  scopeKey, scopeMenuEntries, severityCounts, splitPath, turnEntriesOf,
} from '../src/client/review-panel-model.js'

const repo = (over = {}) => ({
  id: '0123456789abcdef', name: 'app', kind: 'git', branch: 'feat/x', head: 'a1b2c3d', detached: false,
  upstream: 'origin/feat/x', remoteBranchMissing: false, ahead: 2, behind: 0, conflicts: 0,
  counts: { unstaged: 4, staged: 2, uncommitted: 4 }, ...over,
})
const file = (over = {}) => ({ path: 'src/a.ts', status: 'modified', binary: false, tooLarge: false, added: 1, deleted: 1, hunks: [{ id: 'h0' }], ...over })

test('地址：一个会话一个审阅标签，会话 id 编码后读得回来，别的地址不认', () => {
  assert.equal(reviewPanelAddress('s-1'), 'dsh-resource://wbreview/session/s-1')
  assert.equal(parseReviewPanelAddress(reviewPanelAddress('a/b c')), 'a/b c')
  for (const bad of ['dsh-resource://wbreview/session/', 'dsh-resource://wbreview/session/a/b', 'dsh-resource://changes-review/session/s/1/2', 'dsh-resource://wbreview/session/%E0%A4%A']) {
    assert.equal(parseReviewPanelAddress(bad), undefined, bad)
  }
})

test('入口参数：四种 Git 范围、轮次、文件下标和报告编号各自认得，不合法的丢掉', () => {
  assert.deepEqual(reviewEntryOf({ scope: 'staged' }), { scope: { kind: 'staged' } })
  assert.deepEqual(reviewEntryOf({ scope: 'branch', base: 'main' }), { scope: { kind: 'branch', base: 'main', includeUncommitted: false } })
  assert.deepEqual(reviewEntryOf({ scope: 'branch', base: 'main', includeUncommitted: true }), { scope: { kind: 'branch', base: 'main', includeUncommitted: true } })
  assert.deepEqual(reviewEntryOf({ scope: 'turn', seq: 42, turn: 3, index: 1 }), { scope: { kind: 'turn', seq: 42, turn: 3 }, index: 1 })
  const reportId = `wbr-${'a'.repeat(64)}-abcdefgh-${'b'.repeat(32)}`
  assert.deepEqual(reviewEntryOf({ reportId }), { reportId })
  assert.deepEqual(reviewEntryOf({ scope: 'turn', seq: -1, turn: 3 }), {})
  assert.deepEqual(reviewEntryOf({ scope: 'turn', seq: 1, turn: 0 }), {})
  assert.deepEqual(reviewEntryOf({ scope: 'all' }), {})
  assert.deepEqual(reviewEntryOf({ reportId: 'wbr-x', index: -2 }), {})
  assert.deepEqual(reviewEntryOf(undefined), {})
})

test('范围键：评论和已审阅按范围分开存，分支范围连基准、提交和是否含未提交一起算', () => {
  assert.equal(scopeKey({ kind: 'unstaged' }), 'unstaged')
  assert.equal(scopeKey({ kind: 'turn', seq: 7, turn: 2 }), 'turn:7')
  assert.notEqual(scopeKey({ kind: 'branch', base: 'main', includeUncommitted: false }), scopeKey({ kind: 'branch', base: 'main', includeUncommitted: true }))
  assert.notEqual(scopeKey({ kind: 'branch', base: 'main', from: 'a1', to: 'a1' }), scopeKey({ kind: 'branch', base: 'main' }))
})

test('轮次：只列有 workspace/changes 的轮，最近的在上面', () => {
  const turns = new Map([
    ['1', { turn: 1, data: new Map([['deliverables', { changes: { seq: 10 } }]]) }],
    ['2', { turn: 2, data: new Map([['deliverables', { calls: new Map() }]]) }],
    ['3', { turn: 3, data: new Map([['deliverables', { changes: { seq: 31 } }]]) }],
    ['4', { turn: 4 }],
  ])
  assert.deepEqual(turnEntriesOf(turns), [{ turn: 3, seq: 31 }, { turn: 1, seq: 10 }])
  assert.deepEqual(turnEntriesOf(undefined), [])
})

test('范围菜单：Git 范围带文件数，分支写基准，轮次带文件数或「已不可用」；不是 Git 仓库只能选轮次', () => {
  const turns = [{ turn: 5, seq: 50 }, { turn: 2, seq: 20 }]
  const turnFiles = new Map([[50, 3], [20, null]])
  const entries = scopeMenuEntries({ repo: repo(), base: 'main', turns, turnFiles })
  assert.deepEqual(entries.map(entry => entry.id), ['unstaged', 'staged', 'uncommitted', 'branch', 'sep', 'turn:50', 'turn:20'])
  assert.deepEqual(entries.slice(0, 4).map(entry => [entry.count ?? entry.base, entry.disabled]), [[4, false], [2, false], [4, false], ['main', false]])
  assert.deepEqual(entries.slice(5).map(entry => [entry.turn, entry.count, entry.unavailable]), [[5, 3, false], [2, undefined, true]])
  const notGit = scopeMenuEntries({ repo: repo({ kind: 'not-git', counts: { unstaged: 0, staged: 0, uncommitted: 0 } }), base: null, turns, turnFiles })
  assert.deepEqual(notGit.slice(0, 4).map(entry => [entry.id, entry.disabled, entry.reason]), [
    ['unstaged', true, 'not-git'], ['staged', true, 'not-git'], ['uncommitted', true, 'not-git'], ['branch', true, 'not-git'],
  ])
  assert.deepEqual(scopeMenuEntries({ repo: repo(), base: 'main', turns: [], turnFiles: new Map() }).map(entry => entry.id), ['unstaged', 'staged', 'uncommitted', 'branch'])
})

test('整个范围的操作：未暂存是全部暂存和全部回退，已暂存是全部取消暂存和提交，分支是创建变更请求', () => {
  const diff = { files: [file(), file({ path: 'b.ts' })] }
  assert.deepEqual(scopeActions({ scope: { kind: 'unstaged' }, repo: repo(), diff, running: false }), { stageAll: { disabled: false }, revertAll: { disabled: false } })
  assert.deepEqual(scopeActions({ scope: { kind: 'staged' }, repo: repo(), diff, running: false }), { unstageAll: { disabled: false }, commit: { disabled: false } })
  assert.deepEqual(scopeActions({ scope: { kind: 'uncommitted' }, repo: repo(), diff, running: false }), {})
  assert.deepEqual(scopeActions({ scope: { kind: 'branch', base: 'main' }, repo: repo(), diff, running: false }), { createChangeRequest: { disabled: false } })
  assert.deepEqual(scopeActions({ scope: { kind: 'turn', seq: 1, turn: 1 }, repo: repo(), diff, running: false }), {})
})

test('整个范围的操作：会话进行中只拦回退，暂存照常；有冲突、游离的 HEAD、没有文件时说明原因', () => {
  const diff = { files: [file()] }
  assert.deepEqual(scopeActions({ scope: { kind: 'unstaged' }, repo: repo(), diff, running: true }), { stageAll: { disabled: false }, revertAll: { disabled: true, reason: 'running' } })
  assert.deepEqual(scopeActions({ scope: { kind: 'unstaged' }, repo: repo({ conflicts: 2 }), diff, running: false }), { stageAll: { disabled: true, reason: 'conflict' }, revertAll: { disabled: true, reason: 'conflict' } })
  assert.deepEqual(scopeActions({ scope: { kind: 'staged' }, repo: repo({ detached: true, branch: null }), diff, running: false }), { unstageAll: { disabled: false }, commit: { disabled: true, reason: 'detached' } })
  assert.deepEqual(scopeActions({ scope: { kind: 'staged' }, repo: repo({ conflicts: 1 }), diff, running: false }).commit, { disabled: true, reason: 'conflict' })
  assert.deepEqual(scopeActions({ scope: { kind: 'unstaged' }, repo: repo(), diff: { files: [] }, running: false }), { stageAll: { disabled: true, reason: 'empty' }, revertAll: { disabled: true, reason: 'empty' } })
})

test('一个文件的操作：照第 3 节的表，冲突文件只剩更多操作', () => {
  const unstaged = { kind: 'unstaged' }
  assert.deepEqual(fileActions({ scope: unstaged, file: file(), running: false }), { stage: { disabled: false }, revert: { disabled: false } })
  assert.deepEqual(fileActions({ scope: unstaged, file: file(), running: true }), { stage: { disabled: false }, revert: { disabled: true, reason: 'running' } })
  assert.deepEqual(fileActions({ scope: { kind: 'staged' }, file: file(), running: true }), { unstage: { disabled: false } })
  assert.deepEqual(fileActions({ scope: { kind: 'uncommitted' }, file: file(), running: false }), { stage: { disabled: false }, revert: { disabled: false } })
  assert.deepEqual(fileActions({ scope: { kind: 'branch', base: 'main' }, file: file(), running: false }), { reviewed: true })
  assert.deepEqual(fileActions({ scope: { kind: 'turn', seq: 1, turn: 1 }, file: file(), running: false }), { revert: { disabled: false }, reviewed: true })
  assert.deepEqual(fileActions({ scope: unstaged, file: file({ status: 'conflict', hunks: [] }), running: false }), {})
  // 二进制和过大的文件不显示内容，但能整个文件操作。
  assert.deepEqual(fileActions({ scope: unstaged, file: file({ binary: true, hunks: [] }), running: false }), { stage: { disabled: false }, revert: { disabled: false } })
})

test('一处的操作：未暂存是暂存和回退，已暂存是取消暂存，未提交和分支没有；轮次只回退', () => {
  assert.deepEqual(hunkActions({ scope: { kind: 'unstaged' }, file: file(), running: false }), { stage: { disabled: false }, revert: { disabled: false } })
  assert.deepEqual(hunkActions({ scope: { kind: 'unstaged' }, file: file(), running: true }), { stage: { disabled: false }, revert: { disabled: true, reason: 'running' } })
  assert.deepEqual(hunkActions({ scope: { kind: 'staged' }, file: file(), running: false }), { unstage: { disabled: false } })
  assert.deepEqual(hunkActions({ scope: { kind: 'uncommitted' }, file: file(), running: false }), {})
  assert.deepEqual(hunkActions({ scope: { kind: 'branch', base: 'main' }, file: file(), running: false }), {})
  assert.deepEqual(hunkActions({ scope: { kind: 'turn', seq: 1, turn: 1 }, file: file(), running: true }), { revert: { disabled: true, reason: 'running' } })
})

test('全部回退的确认：按钮写清几个文件，未跟踪的文件单独列出（它们移到废纸篓）', () => {
  assert.deepEqual(revertAllSummary([file(), file({ path: 'docs/login.md', status: 'untracked' }), file({ path: 'x', status: 'conflict' })]), { count: 2, untracked: ['docs/login.md'] })
})

test('错误码对文案：第 8 节的错误码和宿主补的几种都有自己的话，没见过的落到通用的那句', () => {
  const codes = ['stale', 'running', 'locked', 'busy', 'conflict', 'not-git', 'no-staged', 'detached', 'hook-failed', 'push-rejected', 'push-failed', 'invalid-branch-name', 'not-found', 'too-large', 'bad-path', 'bad-request', 'git-unavailable', 'no-reviewable-files', 'forbidden', 'network']
  const keys = codes.map(code => reviewErrorKey(code))
  assert.equal(new Set(keys).size, codes.length)
  for (const key of keys) assert.match(key, /^rp\.err\./)
  assert.equal(reviewErrorKey('something-new'), 'rp.err.unknown')
  // 有些码在不同的动作里要说不同的话。
  assert.equal(reviewErrorKey('conflict', 'commits'), 'rp.err.notLinear')
  assert.equal(reviewErrorKey('conflict', 'create-branch'), 'rp.err.branchExists')
  assert.equal(reviewErrorKey('not-found', 'generate-message', 'no-model'), 'rp.err.noModel')
  assert.equal(reviewErrorKey('stale', 'undo'), 'rp.err.undoStale')
})

test('审查发现的位置：落在当前范围文件里的挂到那个文件，不在当前范围的计数；忽略的也挂上（收成一行）', () => {
  const report = {
    findings: [
      { id: 'f1', path: 'src/a.ts', line: 3, severity: 'high', status: 'open' },
      { id: 'f2', path: 'src/a.ts', line: 9, severity: 'low', status: 'ignored' },
      { id: 'f3', path: 'src/b.ts', line: 1, severity: 'medium', status: 'open' },
    ],
  }
  const placed = placeFindings(report, [file({ path: 'src/a.ts' })])
  assert.deepEqual([...placed.byFile.get('src/a.ts')].map(f => f.id), ['f1', 'f2'])
  assert.deepEqual(placed.outside.map(f => f.id), ['f3'])
  assert.deepEqual(placeFindings(undefined, [file()]), { byFile: new Map(), outside: [] })
})

test('报告的范围：未提交的审查对应「未提交」，和分支比的审查对应含未提交修改的分支范围', () => {
  assert.deepEqual(reportScope({ selection: { mode: 'uncommitted', base: null, untracked: false } }), { kind: 'uncommitted' })
  assert.deepEqual(reportScope({ selection: { mode: 'branch', base: 'main', untracked: true } }), { kind: 'branch', base: 'main', includeUncommitted: true })
  assert.deepEqual(reportScope({ selection: { mode: 'branch', base: 'refs/heads/main', untracked: false } }), { kind: 'branch', base: 'main', includeUncommitted: true })
})

test('各等级条数：只数没忽略的', () => {
  assert.deepEqual(severityCounts([{ severity: 'high', status: 'open' }, { severity: 'low', status: 'pending' }, { severity: 'low', status: 'ignored' }]), { high: 1, medium: 0, low: 1 })
})

test('评论消息：带范围、文件、行号和那一行的内容，按文件和行号排好；没有评论不发', () => {
  const message = composeScopeMessage({
    scopeText: '未暂存的改动',
    comments: [
      { display: 'src/b.ts', line: 2, snippet: 'b()', text: '改名' },
      { display: 'src/a.ts', line: 19, snippet: '  sessionStorage.removeItem(TARGET_KEY)', text: '先判断 url 是否存在，再删除。' },
    ],
  })
  assert.equal(message, [
    '请按下面的评论修改未暂存的改动：',
    '',
    '1. src/a.ts 第 19 行',
    '   >   sessionStorage.removeItem(TARGET_KEY)',
    '   先判断 url 是否存在，再删除。',
    '',
    '2. src/b.ts 第 2 行',
    '   > b()',
    '   改名',
  ].join('\n'))
  assert.equal(composeScopeMessage({ scopeText: '未暂存的改动', comments: [] }), undefined)
})

test('消息里的范围说法（给模型看，中文）：Git 范围写清是哪一种，分支写基准，选了提交写提交号', () => {
  assert.equal(scopeMessageText({ kind: 'unstaged' }, 'feat/x'), '未暂存的改动')
  assert.equal(scopeMessageText({ kind: 'staged' }, 'feat/x'), '已暂存的改动')
  assert.equal(scopeMessageText({ kind: 'uncommitted' }, 'feat/x'), '未提交的改动')
  assert.equal(scopeMessageText({ kind: 'branch', base: 'main' }, 'feat/x'), '分支 feat/x 相对 main 的改动')
  assert.equal(scopeMessageText({ kind: 'branch', base: 'main', includeUncommitted: true }, 'feat/x'), '分支 feat/x 相对 main 的改动（含未提交的修改）')
  assert.equal(scopeMessageText({ kind: 'branch', base: 'main', from: 'a1b2c3d4', to: 'a1b2c3d4' }, 'feat/x'), '分支 feat/x 上提交 a1b2c3d 的改动')
  assert.equal(scopeMessageText({ kind: 'branch', base: 'main', from: 'a1b2c3d4', to: 'f9e8d7c6' }, null), 'HEAD 上提交 a1b2c3d…f9e8d7c 的改动')
})

test('相对时间：照官方「变更」页的单位（刚刚、分钟、小时、天、月、年）', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  assert.deepEqual(reviewAgo('2026-11-20T11:59:40Z', now), { unit: 'now', n: 0 })
  assert.deepEqual(reviewAgo('2026-11-20T11:15:00Z', now), { unit: 'minutes', n: 45 })
  assert.deepEqual(reviewAgo('2026-11-20T10:00:00Z', now), { unit: 'hours', n: 2 })
  assert.deepEqual(reviewAgo('2026-11-17T12:00:00Z', now), { unit: 'days', n: 3 })
  assert.deepEqual(reviewAgo('2026-08-20T12:00:00Z', now), { unit: 'months', n: 3 })
  assert.deepEqual(reviewAgo('2024-11-20T12:00:00Z', now), { unit: 'years', n: 2 })
  assert.equal(reviewAgo('不是时间', now), undefined)
})

test('选提交：点一个看这一个，按住 Shift 再点连成一段（从旧到新），点「全部提交」回到全部', () => {
  // 宿主按 git log 的顺序给：新的在前。
  const commits = [{ sha: 'c3' }, { sha: 'c2' }, { sha: 'c1' }]
  assert.deepEqual(commitSelection(commits, undefined, 'c2', false), { from: 'c2', to: 'c2' })
  assert.deepEqual(commitSelection(commits, { from: 'c2', to: 'c2' }, 'c3', true), { from: 'c2', to: 'c3' })
  assert.deepEqual(commitSelection(commits, { from: 'c3', to: 'c3' }, 'c1', true), { from: 'c1', to: 'c3' })
  assert.deepEqual(commitSelection(commits, { from: 'c1', to: 'c3' }, 'c2', false), { from: 'c2', to: 'c2' })
  assert.equal(commitSelection(commits, { from: 'c2', to: 'c2' }, null, false), undefined)
  // 不在清单里的提交（列表变了）当没选。
  assert.equal(commitSelection(commits, undefined, 'zz', false), undefined)
})

test('路径拆成目录和文件名，目录用浅色显示', () => {
  assert.deepEqual(splitPath('src/auth/redirect.ts'), { dir: 'src/auth/', name: 'redirect.ts' })
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' })
})

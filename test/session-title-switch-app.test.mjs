/**
 * fix#226：停用「会话标题」这一行时 DSH 自带的模型起名（首条消息生成标题）自动回来，开着时用工作台的，全程不会两个提供方同时在册。
 * 在 DSH App 自带的 Electron 里用官方的 Loader、Include、标题服务和首条起名拼一棵真的配置树（test/fixtures/session-title-switch-app.mjs），
 * 补丁取自仓库里的 cordis.patch.yml。机器上没有 App 时跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEEDS_APP, runInApp } from './helpers/dsh-app.mjs'

const OURS = 'dsh-session-title-headtail'
const OFFICIAL = 'session-title-first-prompt-llm'
const repo = fileURLToPath(new URL('..', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/session-title-switch-app.mjs', import.meta.url))

let runs
const runsOnce = (t) => {
  if (runs) return runs
  const dir = mkdtempSync(join(tmpdir(), 'dwb-title-switch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  ;({ runs } = runInApp(fixture, { DWB_REPO: repo, DWB_DIR: dir, HOME: dir, DSH_HOME: join(dir, '.dsh') }))
  return runs
}
const byName = (t, name) => runsOnce(t).find(run => run.name === name)

/** 每一步结束时在册的提供方：都已注册好，不在收尾。 */
const settled = run => run.steps.map(({ step, current }) => [step, current === null ? null : current.closing ? `${current.id} (closing)` : current.id])

test('开着「会话标题」启动：工作台提供标题；关掉后 DSH 自带的首条起名接上，再开回来又是工作台的，快速关开、守卫重查也不乱', { skip: NEEDS_APP }, t => {
  const run = byName(t, 'enabled-at-boot')
  assert.deepEqual(settled(run), [
    ['boot', OURS], ['off', OFFICIAL], ['on', OURS], ['off', OFFICIAL], ['on', OURS], ['off-on', OURS], ['recheck', OURS],
  ])
})

test('停着「会话标题」启动：DSH 自带的首条起名在册；开起来换成工作台的，再关又换回去', { skip: NEEDS_APP }, t => {
  const run = byName(t, 'disabled-at-boot')
  assert.deepEqual(settled(run), [['boot', OFFICIAL], ['on', OURS], ['off', OFFICIAL]])
  assert.equal(run.registers.filter(entry => entry.id === OURS).length, 1)
})

test('整包和单装包混装、守卫拦住功能组时：会话标题这一行不加载，DSH 自带的首条起名照常', { skip: NEEDS_APP }, t => {
  const run = byName(t, 'mixed-install')
  assert.deepEqual(settled(run), [['boot', OFFICIAL]])
  assert.deepEqual(run.registers.map(entry => entry.id), [OFFICIAL])
  // 日志里只有混装冲突：守卫的警告，和状态行在插件页报的错。
  assert.deepEqual(run.problems.map(problem => problem.type).sort(), ['error', 'warn'])
  assert.ok(run.problems.every(problem => problem.text.includes('无法同时启用')), JSON.stringify(run.problems))
})

test('全程没有 already registered：每次注册时标题服务里都没有别的提供方，连收尾中的也没有', { skip: NEEDS_APP }, t => {
  for (const run of runsOnce(t).filter(item => item.name !== 'mixed-install')) {
    assert.deepEqual(run.registers.filter(entry => entry.error !== undefined), [], run.name)
    assert.deepEqual(run.registers.filter(entry => entry.before !== null), [], run.name)
    assert.deepEqual(run.problems, [], run.name)
    // 两个提供方轮流注册：DSH 自带的和工作台的都至少注册过一次。
    assert.ok(run.registers.some(entry => entry.id === OURS) && run.registers.some(entry => entry.id === OFFICIAL), run.name)
  }
})

test('混装那一次也没有撞车：唯一的一次注册时标题服务是空的', { skip: NEEDS_APP }, t => {
  const run = byName(t, 'mixed-install')
  assert.deepEqual(run.registers.filter(entry => entry.error !== undefined || entry.before !== null), [])
})

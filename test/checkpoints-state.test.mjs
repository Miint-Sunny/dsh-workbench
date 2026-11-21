/** 检查点的纯函数（lib/checkpoints-state.js）：配置默认值、校验、存取、合格性、过期、占用上限。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAY_MS, defaultCheckpointsConfig, eligibility, fullBy, parseCheckpointsConfig,
  readCheckpointsConfig, sessionExpired, writeCheckpointsConfig,
} from '../lib/checkpoints-state.js'

test('state：默认配置和示例助手的预设', () => {
  assert.deepEqual(defaultCheckpointsConfig(), {
    keepDays: 14, maxStoreMB: 2048, skipPresets: ['whale', 'whale-dream'], waitSeconds: 5, maxFileMB: 2,
  })
})

test('state：配置校验（正整数、预设字符串数组、去重），坏的抛错', () => {
  assert.deepEqual(parseCheckpointsConfig({ keepDays: 3, maxStoreMB: 10, skipPresets: ['a', 'a', 'b'], waitSeconds: 1, maxFileMB: 4 }), {
    keepDays: 3, maxStoreMB: 10, skipPresets: ['a', 'b'], waitSeconds: 1, maxFileMB: 4,
  })
  assert.deepEqual(parseCheckpointsConfig({ keepDays: 3, maxStoreMB: 10, skipPresets: [], waitSeconds: 60, maxFileMB: 1 }).skipPresets, [])
  for (const bad of [
    { keepDays: 0, maxStoreMB: 10, skipPresets: [], waitSeconds: 1, maxFileMB: 1 },
    { keepDays: 1.5, maxStoreMB: 10, skipPresets: [], waitSeconds: 1, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 'x', skipPresets: [], waitSeconds: 1, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 0 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 0.5, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 61, maxFileMB: 1 },
    // 3_000_000 秒会让 setTimeout 溢出成 1 毫秒，必须挡在配置校验。
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 3_000_000, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: '5', maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: 'whale', waitSeconds: 1, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [''], waitSeconds: 1, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, waitSeconds: 1, maxFileMB: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 1 },
    { keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 1, maxFileMB: 0 },
    null,
  ]) {
    assert.throws(() => parseCheckpointsConfig(bad), /checkpoints config/)
  }
  // waitSeconds 单独的区间错误也要说清楚是哪一个字段。
  assert.throws(() => parseCheckpointsConfig({ keepDays: 1, maxStoreMB: 10, skipPresets: [], waitSeconds: 3_000_000, maxFileMB: 1 }), /waitSeconds/)
})

test('state：配置读（缺文件、坏文件答默认）和写（原子覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-cfg-'))
  try {
    assert.deepEqual(readCheckpointsConfig(dir), defaultCheckpointsConfig())
    const config = parseCheckpointsConfig({ keepDays: 7, maxStoreMB: 100, skipPresets: [], waitSeconds: 2, maxFileMB: 3 })
    writeCheckpointsConfig(dir, config)
    assert.deepEqual(readCheckpointsConfig(dir), config)
    assert.equal(readFileSync(join(dir, 'checkpoints.json'), 'utf8'), `${JSON.stringify(config, null, 2)}\n`)
    writeFileSync(join(dir, 'checkpoints.json'), 'not json')
    assert.deepEqual(readCheckpointsConfig(dir), defaultCheckpointsConfig())
    // 坏文件不写回：读还是默认，文件原样。
    assert.equal(readFileSync(join(dir, 'checkpoints.json'), 'utf8'), 'not json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('state：合格性（cwd、子智能体、预设）', () => {
  const config = defaultCheckpointsConfig()
  assert.deepEqual(eligibility({ cwd: '/tmp/x' }, config), { eligible: true, why: '' })
  assert.deepEqual(eligibility({}, config), { eligible: false, why: 'cwd' })
  assert.deepEqual(eligibility({ cwd: '/tmp/x', origin: 'subagent' }, config), { eligible: false, why: 'subagent' })
  assert.deepEqual(eligibility({ cwd: '/tmp/x', delegationDepth: 1 }, config), { eligible: false, why: 'subagent' })
  assert.deepEqual(eligibility({ cwd: '/tmp/x', delegationDepth: 0 }, config), { eligible: true, why: '' })
  assert.deepEqual(eligibility({ cwd: '/tmp/x', agentPreset: 'whale' }, config), { eligible: false, why: 'preset' })
  assert.deepEqual(eligibility({ cwd: '/tmp/x', agentPreset: 'coding' }, config), { eligible: true, why: '' })
  // skipPresets 改了以后按新的算。
  assert.deepEqual(eligibility({ cwd: '/tmp/x', agentPreset: 'whale' }, { ...config, skipPresets: [] }), { eligible: true, why: '' })
})

test('state：按保留天数过期、占用上限', () => {
  const now = 20 * DAY_MS
  assert.equal(sessionExpired([{ time: 1 * DAY_MS }], now, 14), true)
  assert.equal(sessionExpired([{ time: 10 * DAY_MS }], now, 14), false)
  // 取最早没过期的那条：有一条新检查点就不过期。
  assert.equal(sessionExpired([{ time: 1 * DAY_MS }, { time: 19 * DAY_MS }], now, 14), false)
  // 边界：恰好满 keepDays 天（存的时间等于截止点）算没过期。
  assert.equal(sessionExpired([{ time: now - 14 * DAY_MS }], now, 14), false)
  assert.equal(sessionExpired([{ time: now - 14 * DAY_MS - 1 }], now, 14), true)
  // 列表是空的（第一次快照还没写完）不算过期：没有条目就判不了，交给目录修改时间。
  assert.equal(sessionExpired([], now, 14), false)

  assert.equal(fullBy(2048 * 1024 * 1024, 2048), false)
  assert.equal(fullBy(2048 * 1024 * 1024 + 1, 2048), true)
  assert.equal(fullBy(0, 2048), false)
})

test('state：过期结合目录修改时间（清理删正在用的目录那一条）', () => {
  const now = 20 * DAY_MS
  const cutoff = now - 14 * DAY_MS
  // 空列表：目录新（正在第一次快照）不过期；目录旧（残留的空目录）过期。
  assert.equal(sessionExpired([], now, 14, now - 1_000), false)
  assert.equal(sessionExpired([], now, 14, cutoff - 1), true)
  // 有条目：条目全旧但目录新（最近还有活动，比如刚恢复过）不过期；都旧才过期。
  assert.equal(sessionExpired([{ time: 1 * DAY_MS }], now, 14, now - 1_000), false)
  assert.equal(sessionExpired([{ time: 1 * DAY_MS }], now, 14, cutoff - 1), true)
  // 条目新（最近存过检查点）无论目录新旧都不过期。
  assert.equal(sessionExpired([{ time: 19 * DAY_MS }], now, 14, cutoff - 1), false)
})

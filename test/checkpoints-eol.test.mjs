/**
 * 第 40 件阶段三（说清楚）的回归测试：换行被 git 悄悄改写要有提示（e13，#11）——仓库的
 * `text`、`eol` 属性或 core.autocrlf 会让 CRLF 恢复成 LF，preview 的 notes 要带
 * `lfs-or-filters`（网页端已有这条说明）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCheckpointsService } from '../lib/checkpoints.js'
import { writeCheckpointsConfig } from '../lib/checkpoints-state.js'
import { createLocalSubprocess, runGit } from './checkpoints-spawn.mjs'

const write = (path, text) => writeFile(path, text, 'utf8')

/**
 * 搭一个 git 仓库的服务场景，带可选的 .gitattributes 和 core.autocrlf。
 * @param {{ attributes?: string, autocrlf?: string }} [options]
 * @returns 情景。
 */
async function eolScenario(options = {}) {
  const work = mkdtempSync(join(tmpdir(), 'dwb-eol-'))
  const repo = join(work, 'repo')
  const made = await runGit(work, ['init', repo])
  assert.equal(made.exitCode, 0, made.stderr)
  if (options.attributes !== undefined) await write(join(repo, '.gitattributes'), options.attributes)
  if (options.autocrlf !== undefined) {
    const set = await runGit(repo, ['config', 'core.autocrlf', options.autocrlf])
    assert.equal(set.exitCode, 0, set.stderr)
  }
  const home = join(work, 'dsh-home')
  writeCheckpointsConfig(join(home, 'dsh-workbench'), { keepDays: 14, maxStoreMB: 2048, skipPresets: [], waitSeconds: 5, maxFileMB: 2 })
  const service = createCheckpointsService({
    subprocess: createLocalSubprocess({ home: join(work, 'git-home') }),
    agents: { get: () => undefined },
    dataRoot: join(home, 'dsh-workbench', 'checkpoints'),
    configDir: join(home, 'dsh-workbench'),
    logger: { warn: () => {}, info: () => {} },
  })
  return { work, repo, service }
}

/** 起一轮并等检查点存完。 */
async function startTurn(service, cwd) {
  service.onSessionEvent({ id: 's1', header: { cwd } }, { type: 'turn/start', seq: 10, data: { turn: 1 } })
  await service.onPreExecute({ agent: { session: { id: 's1' } } }, () => 'ok')
}

test('换行：text=auto 时 CRLF 恢复成 LF，预览带 lfs-or-filters 提示（e13）', async () => {
  const scene = await eolScenario({ attributes: '* text=auto\n' })
  try {
    await write(join(scene.repo, 'win.txt'), 'line1\r\nline2\r\n')
    await startTurn(scene.service, scene.repo)
    await write(join(scene.repo, 'win.txt'), 'agent rewrote\n')
    const preview = await (await scene.service.preview('s1', 1)).json()
    assert.ok(preview.notes.includes('lfs-or-filters'), `notes 要带换行提示：${JSON.stringify(preview.notes)}`)
    const restored = await (await scene.service.restore('s1', 1)).json()
    assert.equal(restored.ok, true)
    // 字节确实被 git 改写（CRLF → LF）：提示是必要的。
    assert.equal(await readFile(join(scene.repo, 'win.txt'), 'utf8'), 'line1\nline2\n')
  } finally {
    await rm(scene.work, { recursive: true, force: true })
  }
})

test('换行：eol=lf 属性和 core.autocrlf=input 也提示；都没有时不提示', async () => {
  const withEol = await eolScenario({ attributes: '*.txt text eol=lf\n' })
  try {
    await write(join(withEol.repo, 'win.txt'), 'line1\r\nline2\r\n')
    await startTurn(withEol.service, withEol.repo)
    await write(join(withEol.repo, 'win.txt'), 'agent rewrote\n')
    const preview = await (await withEol.service.preview('s1', 1)).json()
    assert.ok(preview.notes.includes('lfs-or-filters'), `eol=lf 也要提示：${JSON.stringify(preview.notes)}`)
  } finally {
    await rm(withEol.work, { recursive: true, force: true })
  }
  const withCrlf = await eolScenario({ autocrlf: 'input' })
  try {
    await write(join(withCrlf.repo, 'win.txt'), 'line1\r\nline2\r\n')
    await startTurn(withCrlf.service, withCrlf.repo)
    await write(join(withCrlf.repo, 'win.txt'), 'agent rewrote\n')
    const preview = await (await withCrlf.service.preview('s1', 1)).json()
    assert.ok(preview.notes.includes('lfs-or-filters'), `core.autocrlf=input 也要提示：${JSON.stringify(preview.notes)}`)
  } finally {
    await rm(withCrlf.work, { recursive: true, force: true })
  }
  const plain = await eolScenario({})
  try {
    await write(join(plain.repo, 'a.txt'), 'a\n')
    await startTurn(plain.service, plain.repo)
    await write(join(plain.repo, 'a.txt'), 'b\n')
    const preview = await (await plain.service.preview('s1', 1)).json()
    assert.deepEqual(preview.notes, [], '没有属性、没有 autocrlf 时不提示')
  } finally {
    await rm(plain.work, { recursive: true, force: true })
  }
})

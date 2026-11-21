/** 检查点 files 种类的纯函数和磁盘操作（lib/checkpoints-files.js）：路径校验、目标计算、行数、捕获、预览、写回。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureFile, captureNow, lineCounts, planFilesRestore, previewFiles, relativeInside, restoreFiles,
  restoreTargets, safeRelative, sameCapture,
} from '../lib/checkpoints-files.js'

test('W-003: capture skips live and dangling links without following targets', async t => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-link-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  await writeFile(join(work, 'outside'), 'fixture')
  for (const target of ['outside', 'missing']) {
    const path = join(work, `link-${target}`)
    await symlink(join(work, target), path)
    assert.equal(await captureFile(path, join(work, 'captures'), 1024), undefined)
    const plan = await planFilesRestore(work, join(work, 'captures'), new Map([[`link-${target}`, { kind: 'absent' }]]), 1024)
    assert.equal(plan[0]?.reason, 'unsafe-path')
  }
})

test('files：safeRelative 只认工作目录里的 / 相对路径', () => {
  for (const good of ['a.txt', 'src/a.js', 'deep/er/file.md']) assert.equal(safeRelative(good), true, good)
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'a/./b']) assert.equal(safeRelative(bad), false, bad)
  assert.equal(relativeInside('/w', '/w/src/a.js'), 'src/a.js')
  assert.equal(relativeInside('/w', '/w'), undefined)
  assert.equal(relativeInside('/w', '/elsewhere/a.js'), undefined)
  assert.equal(relativeInside('/w', '/w-sibling/a.js'), undefined)
})

test('files：restoreTargets 取第 N 轮及以后最早碰过的那份', () => {
  const entries = [
    { turn: 1, kind: 'files', captures: { 'a.txt': { kind: 'file', sha1: '1'.repeat(40), mode: 420 } } },
    { turn: 2, kind: 'files', captures: { 'a.txt': { kind: 'file', sha1: '2'.repeat(40), mode: 420 }, 'b.txt': { kind: 'absent' } } },
    { turn: 3, kind: 'files', captures: { 'b.txt': { kind: 'file', sha1: '3'.repeat(40), mode: 420 }, 'c.bin': { kind: 'oversized' } } },
    { turn: 4, kind: 'git', tree: 't' },
  ]
  // 回到第 2 轮开始前：a 用第 2 轮的捕获（第 1 轮更早但在 N 之前，不算），b 用第 2 轮的 absent。
  const targets = restoreTargets(entries, 2)
  assert.deepEqual([...targets.keys()].sort(), ['a.txt', 'b.txt', 'c.bin'])
  assert.equal(targets.get('a.txt').sha1, '2'.repeat(40))
  assert.equal(targets.get('b.txt').kind, 'absent')
  assert.equal(targets.get('c.bin').kind, 'oversized')
  // 回到第 1 轮开始前：a 用第 1 轮的。
  assert.equal(restoreTargets(entries, 1).get('a.txt').sha1, '1'.repeat(40))
  // 之后没有碰过任何文件：空。
  assert.equal(restoreTargets(entries, 5).size, 0)
})

test('files：lineCounts（首尾相同的行之外整段算，二进制两边都是 0）', () => {
  const b = text => Buffer.from(text)
  assert.deepEqual(lineCounts(b('a\nb\nc\n'), b('a\nB\nc\n')), { added: 1, deleted: 1, binary: false })
  assert.deepEqual(lineCounts(b('a\nb\n'), b('a\nb\nc\nd\n')), { added: 2, deleted: 0, binary: false })
  // 现在没有（检查点有）：全部加回去；检查点没有（现在有）：全部拿掉。
  assert.deepEqual(lineCounts(null, b('x\ny\n')), { added: 2, deleted: 0, binary: false })
  assert.deepEqual(lineCounts(b('x\ny\nz'), null), { added: 0, deleted: 3, binary: false })
  assert.deepEqual(lineCounts(b('same\n'), b('same\n')), { added: 0, deleted: 0, binary: false })
  assert.deepEqual(lineCounts(Buffer.from([1, 0, 2]), b('text\n')), { added: 0, deleted: 0, binary: true })
})

test('files：captureFile 记 file（SHA-1、权限位、副本只写一次）、absent、oversized，目录不记', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const captures = join(work, 'captures')
    await writeFile(join(work, 'a.sh'), 'echo hi\n')
    await chmod(join(work, 'a.sh'), 0o755)
    const first = await captureFile(join(work, 'a.sh'), captures, 1024)
    assert.equal(first.kind, 'file')
    assert.match(first.sha1, /^[0-9a-f]{40}$/)
    assert.equal(first.mode, 0o755)
    assert.equal(await readFile(join(captures, first.sha1), 'utf8'), 'echo hi\n')
    // 同样内容再捕获：同一个副本，不报错。
    await writeFile(join(work, 'b.sh'), 'echo hi\n')
    const second = await captureFile(join(work, 'b.sh'), captures, 1024)
    assert.equal(second.sha1, first.sha1)
    assert.deepEqual(await readdir(captures), [first.sha1])
    assert.deepEqual(await captureFile(join(work, 'missing.txt'), captures, 1024), { kind: 'absent' })
    await writeFile(join(work, 'big.bin'), Buffer.alloc(2048, 7))
    assert.deepEqual(await captureFile(join(work, 'big.bin'), captures, 1024), { kind: 'oversized' })
    // 恰好等于上限的文件还算 file。
    await writeFile(join(work, 'edge.bin'), Buffer.alloc(1024, 7))
    assert.equal((await captureFile(join(work, 'edge.bin'), captures, 1024)).kind, 'file')
    await mkdir(join(work, 'dir'))
    assert.equal(await captureFile(join(work, 'dir'), captures, 1024), undefined)
    assert.equal(sameCapture({ kind: 'absent' }, { kind: 'absent' }), true)
    // 内容一样但权限位不同不算同一份（恢复时权限位也要写回）。
    assert.equal(sameCapture(first, second), false)
    assert.equal(sameCapture(first, { ...second, mode: first.mode }), true)
    assert.equal(sameCapture({ kind: 'oversized' }, { kind: 'oversized' }), false)
    assert.equal(sameCapture(first, { kind: 'absent' }), false)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('files：previewFiles 列会变的、跳过没变的；restoreFiles 写回内容和权限、删 absent、跳过 oversized', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const root = join(work, 'root')
    const captures = join(work, 'captures')
    await mkdir(join(root, 'src'), { recursive: true })
    // 检查点时的样子：plan.md 两行、run.sh 可执行、same.txt、src/new.js 还没有、big.bin 太大没存。
    await writeFile(join(root, 'plan.md'), '一\n二\n')
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\n')
    await chmod(join(root, 'run.sh'), 0o755)
    await writeFile(join(root, 'same.txt'), '不变\n')
    const targets = new Map(Object.entries(await captureNow(root, captures, ['plan.md', 'run.sh', 'same.txt', 'src/new.js'], 1024)))
    targets.set('big.bin', { kind: 'oversized' })
    assert.equal(targets.get('src/new.js').kind, 'absent')

    // 之后：plan.md 改了一行、run.sh 内容和权限都变、src/new.js 新建、big.bin 变了。
    await writeFile(join(root, 'plan.md'), '一\n改\n三\n')
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho changed\n')
    await chmod(join(root, 'run.sh'), 0o644)
    await writeFile(join(root, 'src', 'new.js'), 'x\ny\n')
    await writeFile(join(root, 'big.bin'), 'whatever')

    const preview = await previewFiles(root, captures, targets, 1024)
    // 先列删除、再列恢复、最后列跳过（第 40 件 #13）。
    assert.deepEqual(preview.map(file => [file.path, file.action, file.reason ?? '']), [
      ['src/new.js', 'delete', ''],
      ['plan.md', 'restore', ''],
      ['run.sh', 'restore', ''],
      ['big.bin', 'skip', 'oversized'],
    ])
    const plan = preview.find(file => file.path === 'plan.md')
    assert.deepEqual([plan.added, plan.deleted], [1, 2])
    const created = preview.find(file => file.path === 'src/new.js')
    assert.deepEqual([created.added, created.deleted], [0, 2])

    const result = await restoreFiles(root, captures, targets, 1024)
    // plan.md、run.sh 写回、src/new.js 删；same.txt 内容和权限都没变，不再原样重写（第 40 件 #13 的共用计划）。
    assert.equal(result.restored, 3)
    assert.deepEqual(result.skipped, [{ path: 'big.bin', reason: 'oversized' }])
    assert.equal(await readFile(join(root, 'plan.md'), 'utf8'), '一\n二\n')
    assert.equal(await readFile(join(root, 'run.sh'), 'utf8'), '#!/bin/sh\n')
    assert.equal(statSync(join(root, 'run.sh')).mode & 0o777, 0o755)
    await assert.rejects(readFile(join(root, 'src', 'new.js')), /ENOENT/)
    assert.equal(await readFile(join(root, 'big.bin'), 'utf8'), 'whatever')
    // 写回后再预览：只剩 oversized 那一项。
    assert.deepEqual((await previewFiles(root, captures, targets, 1024)).map(file => file.path), ['big.bin'])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('files：写不回去的路径记 changed-after，不算进 restored', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const root = join(work, 'root')
    const captures = join(work, 'captures')
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'a.txt'), '原来\n')
    const targets = new Map(Object.entries(await captureNow(root, captures, ['sub/a.txt'], 1024)))
    // 之后 sub 整个变成了文件：sub/a.txt 的父路径不是目录，写不回。
    await rm(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub'), '挡路的文件\n')
    const result = await restoreFiles(root, captures, targets, 1024)
    assert.equal(result.restored, 0)
    assert.deepEqual(result.skipped, [{ path: 'sub/a.txt', reason: 'changed-after' }])
    assert.equal(await readFile(join(root, 'sub'), 'utf8'), '挡路的文件\n')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

// ---- 第 40 件阶段一（记录要安全）的回归测试 ----

test('files：被截断的副本按名字不再被信任，再捕获一次会修好（先写临时文件再改名并校验大小）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const captures = join(work, 'captures')
    await writeFile(join(work, 'x'), 'content of x\n')
    const capture = await captureFile(join(work, 'x'), captures, 1 << 20)
    // 崩溃残留：同名副本只剩半截。
    await writeFile(join(captures, capture.sha1), 'content of')
    const again = await captureFile(join(work, 'x'), captures, 1 << 20)
    assert.equal(again.sha1, capture.sha1)
    assert.equal(await readFile(join(captures, capture.sha1), 'utf8'), 'content of x\n', '截断的副本被完整内容顶掉')
    // 目录里不留临时文件。
    assert.deepEqual(await readdir(captures), [capture.sha1])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('files：restoreFiles 用传进来的计划，计划之后改的文件不重算（第 41 件第 3 项）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const root = join(work, 'root')
    const captures = join(work, 'captures')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'x'), '检查点内容\n')
    const targets = new Map(Object.entries(await captureNow(root, captures, ['x'], 1024)))
    // 算计划时 x 和检查点一样：计划里没有它（不会动它）。
    const plan = await planFilesRestore(root, captures, targets, 1024)
    assert.deepEqual(plan, [])
    // 两次计划之间的窗口里 x 被改了：用传进来的计划执行，x 不重算、不动。
    await writeFile(join(root, 'x'), '窗口里改的\n')
    const result = await restoreFiles(root, captures, targets, 1024, plan)
    assert.equal(result.restored, 0)
    assert.equal(await readFile(join(root, 'x'), 'utf8'), '窗口里改的\n', '被改的路径不被写回')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('files：写回前核对副本内容，截断的副本不会被写回工作目录', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const root = join(work, 'root')
    const captures = join(work, 'captures')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'x'), 'content of x\n')
    const targets = new Map(Object.entries(await captureNow(root, captures, ['x'], 1 << 20)))
    await writeFile(join(captures, targets.get('x').sha1), 'content of')
    await writeFile(join(root, 'x'), '用户后来的内容\n')
    const result = await restoreFiles(root, captures, targets, 1 << 20)
    assert.equal(result.restored, 0)
    assert.deepEqual(result.skipped, [{ path: 'x', reason: 'changed-after' }])
    assert.equal(await readFile(join(root, 'x'), 'utf8'), '用户后来的内容\n', '截断的副本没有写回')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('files：写回失败不在工作目录里留 *.dwb-restore-* 文件', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dwb-files-'))
  try {
    const root = join(work, 'root')
    const captures = join(work, 'captures')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'x'), 'content of x\n')
    const targets = new Map(Object.entries(await captureNow(root, captures, ['x'], 1 << 20)))
    // 目标路径变成了删不掉的目录：rename 失败。
    await rm(join(root, 'x'))
    await mkdir(join(root, 'x'))
    const result = await restoreFiles(root, captures, targets, 1 << 20)
    assert.equal(result.restored, 0)
    const litter = (await readdir(root)).filter(name => name.includes('dwb-restore'))
    assert.deepEqual(litter, [], '失败后没有临时文件留下')
    assert.deepEqual(result.skipped, [{ path: 'x', reason: 'changed-after' }])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

/**
 * 工作区文件夹和权限（feat#159）的设置文件：`<数据目录>/workspace-folders.json`。registerWritableRoot 不进会话日志、
 * 重启后要重新登记，所以工作台自己存一份；这里锁住读写、坏文件、去重和清理已删的工作区。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFoldersStore, FOLDERS_FILE } from '../lib/workspace-folders-store.js'

function dir(t) {
  const path = mkdtempSync(join(tmpdir(), 'dwb-wf-store-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('没有文件时是空设置，读的时候不写文件', (t) => {
  const path = dir(t)
  assert.deepEqual(createFoldersStore(path).read(), {})
  assert.equal(existsSync(join(path, FOLDERS_FILE)), false)
})

test('文件坏了或形状不对时按空设置处理，不写回', (t) => {
  const path = dir(t)
  for (const text of ['{', '[]', '{"version":2,"workspaces":{}}', '{"version":1,"workspaces":{"w":{"externals":["relative"]}}}', '{"version":1,"workspaces":{"w":{"writableSubfolders":[1]}}}']) {
    writeFileSync(join(path, FOLDERS_FILE), text)
    assert.deepEqual(createFoldersStore(path).read(), {}, text)
    assert.equal(readFileSync(join(path, FOLDERS_FILE), 'utf8'), text)
  }
})

test('外部文件夹：添加后存下来（重新建一份 store 也读得到），重复添加不重复，移除后消失', (t) => {
  const path = dir(t)
  const store = createFoldersStore(path)
  store.addExternal('w-main', '/ext/a')
  store.addExternal('w-main', '/ext/b')
  store.addExternal('w-main', '/ext/a')
  assert.deepEqual(createFoldersStore(path).read(), { 'w-main': { externals: ['/ext/a', '/ext/b'], writableSubfolders: [] } })
  assert.equal(store.removeExternal('w-main', '/ext/a'), true)
  assert.equal(store.removeExternal('w-main', '/ext/a'), false)
  assert.deepEqual(store.read(), { 'w-main': { externals: ['/ext/b'], writableSubfolders: [] } })
  assert.deepEqual(JSON.parse(readFileSync(join(path, FOLDERS_FILE), 'utf8')).version, 1)
})

test('外部文件夹只收绝对路径', (t) => {
  const store = createFoldersStore(dir(t))
  assert.throws(() => store.addExternal('w-main', 'ext/a'), /absolute/)
  assert.throws(() => store.addExternal('', '/ext/a'), /workspace id/)
})

test('「只读 / 可写」：按主文件夹和子文件夹这一对存；切回只读后没有设置的工作区不留空条目', (t) => {
  const store = createFoldersStore(dir(t))
  store.setWritable('w-main', 'w-sub', true)
  store.setWritable('w-main', 'w-sub', true)
  assert.deepEqual(store.read(), { 'w-main': { externals: [], writableSubfolders: ['w-sub'] } })
  store.setWritable('w-main', 'w-sub', false)
  assert.deepEqual(store.read(), {})
})

test('清理：只留还登记着的工作区，和指向它们的「可写」', (t) => {
  const store = createFoldersStore(dir(t))
  store.addExternal('w-main', '/ext/a')
  store.setWritable('w-main', 'w-sub', true)
  store.setWritable('w-main', 'w-gone', true)
  store.addExternal('w-gone', '/ext/g')
  store.prune(['w-main', 'w-sub'])
  assert.deepEqual(store.read(), { 'w-main': { externals: ['/ext/a'], writableSubfolders: ['w-sub'] } })
})

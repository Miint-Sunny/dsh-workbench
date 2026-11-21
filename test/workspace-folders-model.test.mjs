/**
 * 工作区文件夹和权限（feat#159）的纯逻辑：选中的文件夹怎么分类（子文件夹、外部文件夹、主文件夹的上级、重复、找不到、符号链接），
 * 一个会话要登记哪些可写目录，哪些目录现在能登记，对话框的文件夹列表。
 * 分类和登记都按真实路径比较：DSH 的工作区登记的是真实路径，沙箱拒绝符号链接形式的可写目录（隔离宿主实测，见 docs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import {
  classifyFolder, resolvePickedFolder, writableRootsFor, usableRoots, folderList, displayFolder, externalRefusal,
} from '../lib/workspace-folders-model.js'

const main = '/work/main'

test('分类：主文件夹里面的是子文件夹，外面的是外部文件夹', () => {
  assert.deepEqual(classifyFolder({ main, picked: '/work/main/sub', listed: [] }), { kind: 'subfolder' })
  assert.deepEqual(classifyFolder({ main, picked: '/work/main/a/b/c', listed: [] }), { kind: 'subfolder' })
  assert.deepEqual(classifyFolder({ main, picked: '/work/other', listed: [] }), { kind: 'external' })
  assert.deepEqual(classifyFolder({ main, picked: '/elsewhere', listed: [] }), { kind: 'external' })
})

test('分类：名字前缀相同的兄弟目录不算子文件夹', () => {
  assert.deepEqual(classifyFolder({ main, picked: '/work/main2', listed: [] }), { kind: 'external' })
  assert.deepEqual(classifyFolder({ main, picked: '/work/main-old/x', listed: [] }), { kind: 'external' })
})

test('分类：主文件夹的上级目录（直到根）报 ancestor；主文件夹本身和已在列表里的报 duplicate', () => {
  assert.deepEqual(classifyFolder({ main, picked: '/work', listed: [] }), { error: 'ancestor' })
  assert.deepEqual(classifyFolder({ main, picked: '/', listed: [] }), { error: 'ancestor' })
  assert.deepEqual(classifyFolder({ main, picked: '/work/main', listed: [] }), { error: 'duplicate' })
  assert.deepEqual(classifyFolder({ main, picked: '/work/main/sub', listed: ['/work/main/sub'] }), { error: 'duplicate' })
  assert.deepEqual(classifyFolder({ main, picked: '/ext', listed: ['/ext'] }), { error: 'duplicate' })
})

test('分类：Windows 路径不分大小写', () => {
  const win = { main: 'C:\\Work\\Main', pathApi: path.win32 }
  assert.deepEqual(classifyFolder({ ...win, picked: 'c:\\work\\main\\Sub', listed: [] }), { kind: 'subfolder' })
  assert.deepEqual(classifyFolder({ ...win, picked: 'c:\\WORK', listed: [] }), { error: 'ancestor' })
  assert.deepEqual(classifyFolder({ ...win, picked: 'C:\\ext', listed: ['c:\\EXT'] }), { error: 'duplicate' })
})

/** 临时目录：main/sub、ext，和几种符号链接。 */
function tree(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dwb-wf-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'main', 'sub'), { recursive: true })
  mkdirSync(join(root, 'ext'), { recursive: true })
  writeFileSync(join(root, 'main', 'file.txt'), 'x')
  symlinkSync(join(root, 'main', 'sub'), join(root, 'to-sub'))
  symlinkSync(join(root, 'ext'), join(root, 'main', 'to-ext'))
  symlinkSync(join(root, 'ext'), join(root, 'to-ext'))
  symlinkSync(join(root, 'gone'), join(root, 'dangling'))
  return root
}

test('选中的路径先解析成真实路径再分类：外面指进来的链接是子文件夹，里面指出去的链接是外部文件夹', (t) => {
  const root = tree(t)
  const mainReal = join(root, 'main')
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: join(root, 'to-sub'), listed: [] }), { kind: 'subfolder', path: join(root, 'main', 'sub') })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: join(root, 'main', 'to-ext'), listed: [] }), { kind: 'external', path: join(root, 'ext') })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: join(root, 'to-ext'), listed: [join(root, 'ext')] }), { error: 'duplicate', path: join(root, 'ext') })
})

test('选中的路径：找不到、不是文件夹、相对路径、悬空链接都报错，不分类', (t) => {
  const root = tree(t)
  const mainReal = join(root, 'main')
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: join(root, 'nope'), listed: [] }), { error: 'missing' })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: join(root, 'dangling'), listed: [] }), { error: 'missing' })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: join(root, 'main', 'file.txt'), listed: [] }), { error: 'not-directory' })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: 'main/sub', listed: [] }), { error: 'invalid' })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: `${root}/main/\0sub`, listed: [] }), { error: 'invalid' })
  assert.deepEqual(resolvePickedFolder({ main: mainReal, picked: root, listed: [] }), { error: 'ancestor', path: root })
})

const workspaces = [
  { id: 'w-main', path: '/work/main' },
  { id: 'w-sub', path: '/work/main/sub' },
  { id: 'w-deep', path: '/work/main/sub/deep' },
  { id: 'w-other', path: '/work/other' },
]

test('要登记的可写目录：主文件夹的会话拿到它的外部文件夹', () => {
  const settings = { 'w-main': { externals: ['/ext/a', '/ext/b'], writableSubfolders: [] } }
  assert.deepEqual(writableRootsFor({ cwd: '/work/main', workspaces, settings }), ['/ext/a', '/ext/b'])
})

test('要登记的可写目录：子文件夹的会话，主文件夹「只读」时什么也不登记，「可写」时登记主文件夹', () => {
  const readOnly = { 'w-main': { externals: ['/ext/a'], writableSubfolders: [] } }
  assert.deepEqual(writableRootsFor({ cwd: '/work/main/sub', workspaces, settings: readOnly }), [])
  const writable = { 'w-main': { externals: ['/ext/a'], writableSubfolders: ['w-sub'] } }
  // 主文件夹的外部文件夹不给子文件夹的会话（样稿第 4 张表）。
  assert.deepEqual(writableRootsFor({ cwd: '/work/main/sub', workspaces, settings: writable }), ['/work/main'])
})

test('要登记的可写目录：切换「只读 / 可写」以后，登记的目录跟着变', () => {
  const settings = { 'w-main': { externals: [], writableSubfolders: ['w-sub'] } }
  assert.deepEqual(writableRootsFor({ cwd: '/work/main/sub', workspaces, settings }), ['/work/main'])
  settings['w-main'].writableSubfolders = []
  assert.deepEqual(writableRootsFor({ cwd: '/work/main/sub', workspaces, settings }), [])
})

test('要登记的可写目录：多层子文件夹各按自己的那一对设置；子文件夹自己的外部文件夹也给它的会话', () => {
  const settings = {
    'w-main': { externals: [], writableSubfolders: ['w-deep'] },
    'w-sub': { externals: ['/ext/s'], writableSubfolders: [] },
  }
  assert.deepEqual(writableRootsFor({ cwd: '/work/main/sub/deep', workspaces, settings }), ['/work/main'])
  assert.deepEqual(writableRootsFor({ cwd: '/work/main/sub', workspaces, settings }), ['/ext/s'])
})

test('要登记的可写目录：不是已登记工作区的目录、已删的工作区、不在主文件夹里的「子文件夹」都不算', () => {
  const settings = {
    'w-main': { externals: ['/ext/a'], writableSubfolders: ['w-other', 'w-gone'] },
    'w-gone': { externals: ['/ext/gone'], writableSubfolders: [] },
  }
  assert.deepEqual(writableRootsFor({ cwd: '/work/unregistered', workspaces, settings }), [])
  assert.deepEqual(writableRootsFor({ cwd: '/work/other', workspaces, settings }), [])
  assert.deepEqual(writableRootsFor({ cwd: undefined, workspaces, settings }), [])
})

test('能登记的目录：只留存在的、是文件夹的、写法就是真实路径的（符号链接或找不到的目录会让这个会话所有写操作都失败）', (t) => {
  const root = tree(t)
  const roots = [join(root, 'ext'), join(root, 'to-ext'), join(root, 'nope'), join(root, 'main', 'file.txt'), join(root, 'main')]
  assert.deepEqual(usableRoots(roots), [join(root, 'ext'), join(root, 'main')])
})

test('对话框的文件夹列表：主文件夹、嵌在里面的已登记工作区（按路径排）、外部文件夹，各带状态', () => {
  const settings = { 'w-main': { externals: ['/ext/b', '/ext/a'], writableSubfolders: ['w-deep'] } }
  const missing = new Set(['/ext/b'])
  const list = folderList({ workspace: workspaces[0], workspaces, settings, exists: dir => !missing.has(dir) })
  assert.deepEqual(list.main, { path: '/work/main', missing: false })
  assert.deepEqual(list.subfolders, [
    { id: 'w-sub', path: '/work/main/sub', writable: false, missing: false },
    { id: 'w-deep', path: '/work/main/sub/deep', writable: true, missing: false },
  ])
  assert.deepEqual(list.externals, [{ path: '/ext/b', missing: true }, { path: '/ext/a', missing: false }])
})

test('显示路径：主目录下的写成 ~ 开头，文件夹末尾带 /', () => {
  assert.equal(displayFolder('/Users/me/code/x', ['/Users/me']), '~/code/x/')
  assert.equal(displayFolder('/Users/me', ['/Users/me']), '~/')
  assert.equal(displayFolder('/opt/data', ['/Users/me']), '/opt/data/')
  assert.equal(displayFolder('/', ['/Users/me']), '/')
  assert.equal(displayFolder('/Users/meow/x', ['/Users/me']), '/Users/meow/x/')
})

// 返工（审查第 3 条）：外部文件夹拒绝范围太大的目录，照 lib/workspace-trust.js 的 trustRefusal 写。

test('外部文件夹不能是根目录、主目录或主目录的上级', () => {
  const dirs = { homes: ['/Users/me'], dshHomes: ['/srv/dsh'] }
  assert.equal(externalRefusal('/', dirs), 'too-broad')
  assert.equal(externalRefusal('/Users/me', dirs), 'too-broad')
  assert.equal(externalRefusal('/Users/me/', dirs), 'too-broad')
  assert.equal(externalRefusal('/Users', dirs), 'too-broad')
  assert.equal(externalRefusal('/Users/me/code', dirs), undefined)
  assert.equal(externalRefusal('/Users/meow', dirs), undefined, '名字前缀相同的兄弟目录不算')
  assert.equal(externalRefusal('/opt/data', dirs), undefined)
})

test('外部文件夹不能是 DSH 的数据目录（$DSH_HOME）本身、它里面的目录或它的上级', () => {
  const dirs = { homes: ['/Users/me'], dshHomes: ['/srv/dsh'] }
  assert.equal(externalRefusal('/srv/dsh', dirs), 'dsh-data')
  assert.equal(externalRefusal('/srv/dsh/dsh-workbench', dirs), 'dsh-data')
  assert.equal(externalRefusal('/srv/dsh/profiles/web', dirs), 'dsh-data')
  assert.equal(externalRefusal('/srv', dirs), 'dsh-data')
  assert.equal(externalRefusal('/srv/dsh-old', dirs), undefined)
  assert.equal(externalRefusal('/srv/other', dirs), undefined)
  assert.equal(externalRefusal('/Users/me/.dsh', { homes: ['/Users/me'], dshHomes: ['/Users/me/.dsh'] }), 'dsh-data', '默认的 ~/.dsh')
})

test('外部文件夹的拒绝：Windows 的盘符根、UNC 共享的根，路径不分大小写', () => {
  const refuse = target => externalRefusal(target, { homes: ['C:\\Users\\Me'], dshHomes: ['D:\\DSH'] }, path.win32)
  assert.equal(refuse('C:\\'), 'too-broad')
  assert.equal(refuse('e:\\'), 'too-broad')
  assert.equal(refuse('\\\\server\\share\\'), 'too-broad')
  assert.equal(refuse('\\\\server\\share'), 'too-broad')
  assert.equal(refuse('c:\\users\\me'), 'too-broad')
  assert.equal(refuse('C:\\USERS'), 'too-broad')
  assert.equal(refuse('d:\\dsh'), 'dsh-data')
  assert.equal(refuse('D:\\Dsh\\Profiles'), 'dsh-data')
  assert.equal(refuse('C:\\Users\\Me\\Code'), undefined)
  assert.equal(refuse('\\\\server\\share\\proj'), undefined)
  assert.equal(refuse('D:\\work'), undefined)
})

test('两个卷视图下目录身份相同，登记时仍拒绝主目录的上级及与数据目录重叠的目录', () => {
  const identities = new Map([
    ['/primary/people', '1:10'], ['/second/people', '1:10'],
    ['/primary/people/user', '1:11'], ['/second/people/user', '1:11'],
    ['/primary/store', '1:20'], ['/second/store', '1:20'],
    ['/primary/store/profile', '1:21'], ['/second/store/profile', '1:21'],
    ['/different/store/profile', '2:21'],
  ])
  const refuse = target => externalRefusal(target, {
    homes: ['/primary/people/user'],
    dshHomes: ['/primary/store/profile'],
    identityOf: dir => identities.get(dir),
  }, path.posix)
  const settings = { current: { externals: [
    '/second/people', '/second/people/user', '/second/store', '/second/store/profile',
    '/second/store/profile/cache', '/different/store/profile', '/second/store/notes',
  ] } }
  assert.equal(refuse('/second/people'), 'too-broad')
  assert.equal(refuse('/second/store/profile/cache'), 'dsh-data')
  assert.deepEqual(writableRootsFor({
    cwd: '/work/example', workspaces: [{ id: 'current', path: '/work/example' }], settings, refuse, pathApi: path.posix,
  }), ['/different/store/profile', '/second/store/notes'])
})

test('虚构数据目录的符号链接改指别处后，同一挂载重新核对其当前上级', t => {
  const root = tree(t)
  const original = join(root, 'original', 'store')
  const nextParent = join(root, 'relocated')
  const next = join(nextParent, 'nested', 'store')
  const link = join(root, 'profile-link')
  mkdirSync(original, { recursive: true })
  mkdirSync(next, { recursive: true })
  symlinkSync(original, link, 'dir')
  const dirs = { dshHomes: [link, original] }
  assert.equal(externalRefusal(nextParent, dirs), undefined)
  unlinkSync(link)
  symlinkSync(next, link, 'dir')
  assert.equal(externalRefusal(nextParent, dirs), 'dsh-data')
  assert.equal(externalRefusal(next, dirs), 'dsh-data')
})

test('选中的路径：外部文件夹是主目录、DSH 的数据目录或它里面的目录时报对应原因；主文件夹里面的子文件夹不受这条限制', (t) => {
  const root = tree(t)
  mkdirSync(join(root, 'home', '.dsh', 'dsh-workbench'), { recursive: true })
  mkdirSync(join(root, 'home', 'code'), { recursive: true })
  symlinkSync(join(root, 'home'), join(root, 'to-home'))
  const home = join(root, 'home'), dsh = join(root, 'home', '.dsh')
  const refuse = target => externalRefusal(target, { homes: [home], dshHomes: [dsh] })
  const pick = (picked, main = join(root, 'main')) => resolvePickedFolder({ main, picked, listed: [], refuse })
  assert.deepEqual(pick(home), { error: 'too-broad', path: home })
  assert.deepEqual(pick(join(root, 'to-home')), { error: 'too-broad', path: home }, '先解析符号链接再判断')
  assert.deepEqual(pick(dsh), { error: 'dsh-data', path: dsh })
  assert.deepEqual(pick(join(dsh, 'dsh-workbench')), { error: 'dsh-data', path: join(dsh, 'dsh-workbench') })
  assert.deepEqual(pick(join(home, 'code')), { kind: 'external', path: join(home, 'code') })
  assert.deepEqual(pick(root), { error: 'ancestor', path: root }, '主文件夹的上级照旧报 ancestor')
  // 主文件夹就是主目录时，里面的 .dsh 是子文件夹：添加走官方的 workspaces.create，和官方「添加工作区」一样。
  assert.deepEqual(pick(dsh, home), { kind: 'subfolder', path: dsh })
})

test('要登记的可写目录：设置文件被手改过，也不登记范围太大的目录和 DSH 的数据目录', () => {
  const refuse = target => externalRefusal(target, { homes: ['/Users/me'], dshHomes: ['/Users/me/.dsh'] })
  const spaces = [{ id: 'w-proj', path: '/Users/me/proj' }, { id: 'w-sub', path: '/Users/me/proj/sub' }]
  const settings = {
    'w-proj': { externals: ['/', '/Users', '/Users/me', '/Users/me/.dsh', '/Users/me/.dsh/dsh-workbench', '/Users/me/ok'], writableSubfolders: ['w-sub'] },
  }
  assert.deepEqual(writableRootsFor({ cwd: '/Users/me/proj', workspaces: spaces, settings, refuse }), ['/Users/me/ok'])
  // 子文件夹的「可写」登记的是主文件夹，那是 DSH 官方登记的工作区，不归这条管。
  assert.deepEqual(writableRootsFor({ cwd: '/Users/me/proj/sub', workspaces: spaces, settings, refuse }), ['/Users/me/proj'])
})

test('对话框的文件夹列表：设置文件里范围太大或 DSH 数据目录的外部文件夹标成失效，带原因', () => {
  const refuse = target => externalRefusal(target, { homes: ['/Users/me'], dshHomes: ['/Users/me/.dsh'] })
  const settings = { 'w-main': { externals: ['/', '/Users/me/.dsh/x', '/ext/a'] } }
  const list = folderList({ workspace: workspaces[0], workspaces, settings, exists: () => true, refuse })
  assert.deepEqual(list.externals, [
    { path: '/', missing: false, refused: 'too-broad' },
    { path: '/Users/me/.dsh/x', missing: false, refused: 'dsh-data' },
    { path: '/ext/a', missing: false },
  ])
})

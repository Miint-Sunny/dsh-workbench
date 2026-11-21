/** 网页发布的存储：建页面、加版、列表排序、损坏 meta、回收目录、原子写。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPagesStore, parseMeta, slugOfTitle, TRASH_MAX_AGE_DAYS } from '../lib/pages-store.js'

const assets = { scripts: 1, styles: 0, images: 2 }
const dirOf = () => mkdtempSync(join(tmpdir(), 'dwb-pages-store-'))

test('新页面在删除、回收过期和重启后也保留原页面的编号', async t => {
  const dir = dirOf()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  t.mock.method(Math, 'random', () => 0)
  const input = { title: 'Sales', sessionId: 's', path: 'a.html', html: '<p>A</p>', assets }
  const first = createPagesStore(dir)
  const { meta } = await first.createPage(input)
  assert.equal(first.deletePage(meta.id, { now: 1 }), true)
  assert.equal(first.purgeTrash({ now: Date.now() }), 1)
  const next = await createPagesStore(dir).createPage({ ...input, html: '<p>B</p>' })
  assert.notEqual(next.meta.id, meta.id)
  assert.equal(next.meta.versions[0].n, 1)
})

for (const state of ['live', 'trash', 'expired']) {
  test(`旧库升级后保留已经分配的页面编号（${state}）`, async t => {
    const dir = dirOf()
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    t.mock.method(Math, 'random', () => 0)
    const id = 'sales-1000'
    const source = { sessionId: 's', path: 'a.html' }
    const stored = state === 'live' ? join(dir, id) : join(dir, '.trash', id + '-1')
    mkdirSync(stored, { recursive: true })
    writeFileSync(join(stored, 'v1.html'), 'A')
    writeFileSync(join(stored, 'meta.json'), JSON.stringify({
      id, title: 'Sales', source, createdAt: 0, updatedAt: 0,
      versions: [{ n: 1, createdAt: 0, size: 1, assets }],
    }))
    const store = createPagesStore(dir)
    if (state === 'live') assert.equal(store.deletePage(id, { now: 1 }), true)
    if (state !== 'trash') assert.equal(store.purgeTrash({ now: Date.now() }), 1)
    const next = await createPagesStore(dir).createPage({ ...source, title: 'Sales', html: 'B', assets })
    assert.notEqual(next.meta.id, id)
    if (state === 'trash') {
      assert.equal(store.restorePage(id), true)
      assert.equal(store.readVersion(id, 1)?.html, 'A')
    }
  })
}

test('同一标题的四位编号全部已占用时，发布明确报错', async t => {
  const dir = dirOf()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (let n = 1000; n <= 9999; n++) writeFileSync(join(dir, 'sales-' + n), '')
  let draws = 0
  t.mock.method(Math, 'random', () => {
    if (++draws > 9000) throw new Error('编号搜索没有结束')
    return 0
  })
  await assert.rejects(createPagesStore(dir).createPage({ title: 'Sales', sessionId: 's', path: 'b.html', html: 'B', assets }),
    error => error.code === 'page-ids-exhausted' && /Sales|sales/.test(error.message))
})

test('删除时回收目录的时间和首选四位后缀都撞名，已有记录仍保留', async t => {
  const dir = dirOf()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createPagesStore(dir)
  const { meta } = await store.createPage({ title: 'Sales', sessionId: 's', path: 'a.html', html: 'A', assets })
  const trash = join(dir, '.trash')
  const name = meta.id + '-1234567890000'
  mkdirSync(join(trash, name), { recursive: true })
  mkdirSync(join(trash, name + '-1000'))
  let draws = 0
  t.mock.method(Math, 'random', () => {
    if (++draws > 9000) throw new Error('回收目录名称搜索没有结束')
    return 0
  })
  assert.equal(store.deletePage(meta.id, { now: 1234567890000 }), true)
  const saved = readdirSync(trash)
  assert.equal(saved.length, 3)
  assert.ok(saved.includes(name) && saved.includes(name + '-1000'))
})

test('slug：ASCII 转小写分段，纯中文退回 page，去尾连字符', () => {
  assert.equal(slugOfTitle('Sales Report'), 'sales-report')
  assert.equal(slugOfTitle('销售看板'), 'page')
  assert.equal(slugOfTitle('--API 文档 v2--'), 'api-v2')
  assert.equal(slugOfTitle('a'.repeat(40)).length, 24)
})

test('createPage/addVersion：id 是 slug 加 4 位数字，版本号递增，来源换成最新文件', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    const { meta } = await store.createPage({ title: 'Sales Report', sessionId: 's1', path: 'out/index.html', html: '<p>1</p>', assets, now: 1000 })
    assert.match(meta.id, /^sales-report-\d{4}$/)
    assert.equal(meta.versions.length, 1)
    assert.equal(meta.versions[0].n, 1)
    assert.equal(meta.versions[0].size, '<p>1</p>'.length)
    assert.equal(readFileSync(join(dir, meta.id, 'v1.html'), 'utf8'), '<p>1</p>')

    const second = await store.addVersion(meta.id, { sessionId: 's1', path: 'out/index.html', html: '<p>22</p>', assets, now: 2000 })
    assert.equal(second.meta.versions.length, 2)
    assert.equal(second.meta.versions[1].n, 2)
    assert.equal(second.meta.updatedAt, 2000)
    assert.equal(second.meta.source.path, 'out/index.html')

    // 换一个来源文件再加版：meta 的 source 跟着换
    const third = await store.addVersion(meta.id, { sessionId: 's2', path: 'other.html', html: '<p>3</p>', assets, now: 3000 })
    assert.equal(third.meta.source.sessionId, 's2')
    assert.equal(third.meta.source.path, 'other.html')
    assert.equal(existsSync(join(dir, meta.id, 'v3.html')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重名标题不冲突：两个「销售看板」各自成页', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    const a = await store.createPage({ title: '销售看板', sessionId: 's', path: 'a.html', html: 'a', assets, now: 1 })
    const b = await store.createPage({ title: '销售看板', sessionId: 's', path: 'b.html', html: 'b', assets, now: 2 })
    assert.notEqual(a.meta.id, b.meta.id)
    assert.match(a.meta.id, /^page-\d{4}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listPages：最近更新在前，带目录绝对路径；空目录答空列表', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    assert.deepEqual(store.listPages(), { pages: [] })
    const a = await store.createPage({ title: 'A', sessionId: 's', path: 'a.html', html: 'a', assets, now: 1000 })
    const b = await store.createPage({ title: 'B', sessionId: 's', path: 'b.html', html: 'b', assets, now: 2000 })
    await store.addVersion(a.meta.id, { sessionId: 's', path: 'a.html', html: 'a2', assets, now: 3000 })
    const { pages } = store.listPages()
    assert.deepEqual(pages.map(page => page.id), [a.meta.id, b.meta.id])
    assert.equal(pages[0].dir, join(dir, a.meta.id))
    assert.equal(pages[0].corrupt, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readVersion：读得到 HTML 和 meta；页面、版本、id 不存在都答 undefined', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    const { meta } = await store.createPage({ title: 'A', sessionId: 's', path: 'a.html', html: 'one', assets, now: 1 })
    await store.addVersion(meta.id, { sessionId: 's', path: 'a.html', html: 'two', assets, now: 2 })
    assert.equal(store.readVersion(meta.id, 2)?.html, 'two')
    assert.equal(store.readVersion(meta.id, 1)?.html, 'one')
    assert.equal(store.readVersion(meta.id, 3), undefined)
    assert.equal(store.readVersion('gone-1234', 1), undefined)
    assert.equal(store.readVersion('../escape', 1), undefined)
    assert.equal(store.readVersion('a!b', 1), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('meta 损坏：那个页面列为 corrupt 排最后，别的页面不受影响，也不被覆盖', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    const good = await store.createPage({ title: 'Good', sessionId: 's', path: 'g.html', html: 'g', assets, now: 1000 })
    const bad = await store.createPage({ title: 'Bad', sessionId: 's', path: 'b.html', html: 'b', assets, now: 9000 })
    writeFileSync(join(dir, bad.meta.id, 'meta.json'), '{nope')
    const { pages } = store.listPages()
    assert.equal(pages.length, 2)
    assert.equal(pages[0].id, good.meta.id)
    assert.equal(pages[0].corrupt, false)
    assert.equal(pages[1].id, bad.meta.id)
    assert.equal(pages[1].corrupt, true)
    assert.equal(typeof pages[1].updatedAt, 'number')
    // 损坏的文件没被重写，加版报错
    assert.equal(readFileSync(join(dir, bad.meta.id, 'meta.json'), 'utf8'), '{nope')
    await assert.rejects(store.addVersion(bad.meta.id, { sessionId: 's', path: 'b.html', html: 'x', assets, now: 1 }), /损坏/)
    assert.equal(store.readVersion(bad.meta.id, 1), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete/restore：挪进回收目录不真删，恢复回来还能读；30 天后清掉', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    const { meta } = await store.createPage({ title: 'A', sessionId: 's', path: 'a.html', html: 'one', assets, now: 1000 })
    assert.equal(store.deletePage(meta.id, { now: 5000 }), true)
    assert.equal(existsSync(join(dir, meta.id)), false)
    const trashed = readdirSync(join(dir, '.trash'))
    assert.equal(trashed.length, 1)
    assert.ok(trashed[0].startsWith(`${meta.id}-5000`), trashed[0])
    // list 里没有了；readVersion 没有了
    assert.deepEqual(store.listPages().pages.map(page => page.id), [])
    assert.equal(store.readVersion(meta.id, 1), undefined)
    // 再删一次：不存在了
    assert.equal(store.deletePage(meta.id, { now: 5001 }), false)
    // 恢复
    assert.equal(store.restorePage(meta.id), true)
    assert.equal(store.readVersion(meta.id, 1)?.html, 'one')
    assert.equal(readdirSync(join(dir, '.trash')).length, 0)
    assert.equal(store.restorePage(meta.id), false)

    // 回收过期清理：再删一个，把回收目录的时间拨到 31 天前
    assert.equal(store.deletePage(meta.id, { now: 10000 }), true)
    assert.equal(store.purgeTrash({ now: 10000 }), 0)
    assert.equal(store.purgeTrash({ now: 10000 + (TRASH_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000 }), 1)
    assert.equal(readdirSync(join(dir, '.trash')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore 撞上同名页面抛错；写入是原子改名的（目录里没有残留 .tmp）', async () => {
  const dir = dirOf()
  try {
    const store = createPagesStore(dir)
    const a = await store.createPage({ title: 'A', sessionId: 's', path: 'a.html', html: 'a', assets, now: 1 })
    store.deletePage(a.meta.id, { now: 2000 })
    // 手动占住同一个 id：恢复要抛错，不覆盖
    mkdirSync(join(dir, a.meta.id))
    assert.throws(() => store.restorePage(a.meta.id), /已存在/)
    rmSync(join(dir, a.meta.id), { recursive: true, force: true })
    assert.equal(store.restorePage(a.meta.id), true)
    // 原子写：临时文件都改名了，目录里只有 meta.json 和 v*.html
    const files = readdirSync(join(dir, a.meta.id)).sort()
    assert.deepEqual(files.filter(name => !/^v\d+\.html$/.test(name)), ['meta.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseMeta：形状不对抛错（坏 id、缺 source、空版本清单）', () => {
  const good = { id: 'page-1234', title: 'T', createdAt: 1, updatedAt: 1, source: { sessionId: 's', path: 'p' }, versions: [{ n: 1, createdAt: 1, size: 1, assets }] }
  assert.equal(parseMeta(good), good)
  for (const bad of [
    { ...good, id: '../escape' },
    { ...good, title: '' },
    { ...good, source: { sessionId: 1, path: 'p' } },
    { ...good, versions: [] },
    { ...good, versions: [{ n: 0, createdAt: 1, size: 1, assets }] },
    null,
  ]) {
    assert.throws(() => parseMeta(bad))
  }
})

test('TW-004 restoring a page cannot consume a different page with its ID as a prefix', async t => {
  const dir = dirOf(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createPagesStore(dir)
  const first = await store.createPage({ title: 'page', sessionId: 's', path: 'a.html', html: 'first', assets, now: 1 })
  const second = await store.createPage({ title: first.meta.id, sessionId: 's', path: 'b.html', html: 'second', assets, now: 1 })
  assert.ok(second.meta.id.startsWith(first.meta.id + '-'))
  store.deletePage(first.meta.id, { now: 100 })
  store.deletePage(second.meta.id, { now: 100 })
  assert.equal(store.restorePage(first.meta.id), true)
  assert.equal(store.readVersion(first.meta.id, 1).html, 'first')
  assert.equal(store.readVersion(first.meta.id, 1).meta.id, first.meta.id)
  assert.equal(store.restorePage(second.meta.id), true)
  assert.equal(store.readVersion(second.meta.id, 1).html, 'second')
  assert.deepEqual(readdirSync(join(dir, '.trash')), [])
})

test('TW-004 a corrupt trash candidate is preserved rather than restored under an unverified ID', async t => {
  const dir = dirOf(); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createPagesStore(dir)
  const { meta } = await store.createPage({ title: 'page', sessionId: 's', path: 'a.html', html: 'fixture', assets, now: 1 })
  store.deletePage(meta.id, { now: 100 })
  const trash = join(dir, '.trash', `${meta.id}-100`)
  writeFileSync(join(trash, 'meta.json'), '{broken')
  assert.equal(store.restorePage(meta.id), false)
  assert.equal(readFileSync(join(trash, 'v1.html'), 'utf8'), 'fixture')
  assert.equal(existsSync(join(dir, meta.id)), false)
})

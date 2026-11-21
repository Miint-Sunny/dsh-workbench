/**
 * fix#226：工作台顶替的 DSH 自带行（基础包里的 session-title-llm）等工作台的许可。守卫按同级行的 inject 提供许可，
 * 会话标题这一行开着时收回、停用时交还（lib/official-rows.js）。真跑 lib/bundle-guard.js 的 apply，宿主是下面的替身：
 * provide 的撤销函数返回的 promise 由测试决定什么时候结束，对应 cordis 等依赖它的那一行卸载完。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyGuard } from '../lib/bundle-guard.js'
import { claimOfficialRow, officialRowGrant } from '../lib/official-rows.js'

const full = 'dsh-workbench'
const GRANT = 'dsh-workbench.session-title-llm-allowed'
const official = (grant = GRANT) => ({ id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm', inject: [grant] })
const bundle = (name = full) => ({ id: name + '-bundle', name: 'cordis:group', group: true, inject: [name + '.bundle-allowed'], config: [{ id: full + '-session-title', name: `@miint-sunny/${name}/session-title` }] })

/** 替身守卫：记下提供和撤销；每次撤销的 promise 等 finish() 才结束；unload() 之后再 provide 照 cordis 抛 INACTIVE_EFFECT。 */
async function startGuard(rows, name = full) {
  const parent = { data: rows }
  const services = new Map()
  const log = []
  const pending = []
  const disposers = []
  let update
  let unloading = false
  const ctx = {
    fiber: { entry: { parent } },
    logger: { warn() {} },
    on(event, callback) { assert.equal(event, 'internal/update'); update = callback },
    effect(body) { const dispose = body(); disposers.push(dispose); return dispose },
    provide(key, value) {
      if (unloading) throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
      services.set(key, value)
      log.push(['provide', key])
      let disposed = false
      return () => {
        if (disposed) return undefined
        disposed = true
        services.delete(key)
        log.push(['withdraw', key])
        return new Promise(resolve => pending.push(resolve))
      }
    },
  }
  await applyGuard(ctx, { bundle: name })
  return {
    services, log, parent,
    recheck: () => update(),
    finish: () => { for (const resolve of pending.splice(0)) resolve() },
    unload: () => { unloading = true; for (const dispose of disposers.splice(0).reverse()) dispose() },
  }
}
const grants = log => log.filter(([, key]) => key.endsWith('-llm-allowed'))
const flush = () => new Promise(resolve => setImmediate(resolve))

test('许可的名字：顶替的 DSH 自带行 id 加 -allowed，前面是包名（整包和单装包各用自己的）', () => {
  assert.equal(officialRowGrant(full, 'session-title-llm'), GRANT)
  assert.equal(officialRowGrant(full + '-navigation', 'session-title-llm'), 'dsh-workbench-navigation.session-title-llm-allowed')
})

test('守卫只在同级有行的 inject 写着自己的许可时才提供；写的是别的包的许可、或没有这一行时都不提供', async () => {
  const guard = await startGuard([bundle(), official()])
  assert.equal(guard.services.get(GRANT), true)
  guard.unload()
  const other = await startGuard([bundle(), official('dsh-workbench-navigation.session-title-llm-allowed')])
  assert.equal(other.services.has(GRANT), false)
  other.unload()
  const none = await startGuard([bundle()])
  assert.deepEqual(grants(none.log), [])
  none.unload()
})

test('认领：撤掉许可，ready 等到 DSH 自带的那一行卸载完才结束；交还以后又提供许可', async () => {
  const guard = await startGuard([bundle(), official()])
  const claim = claimOfficialRow('session-title-llm')
  assert.equal(guard.services.has(GRANT), false)
  let ready = false
  void claim.ready.then(() => { ready = true })
  await flush()
  assert.equal(ready, false, '许可的撤销还没结束：DSH 自带的那一行还在卸载')
  guard.finish()
  await flush()
  assert.equal(ready, true)
  claim.release()
  assert.equal(guard.services.get(GRANT), true)
  claim.release()
  assert.deepEqual(grants(guard.log), [['provide', GRANT], ['withdraw', GRANT], ['provide', GRANT]], '交还只算一次')
  guard.unload()
})

test('两次认领重叠时，两次都交还以后才再提供许可；没人提供许可时认领马上就绪', async () => {
  const guard = await startGuard([bundle(), official()])
  const first = claimOfficialRow('session-title-llm')
  const second = claimOfficialRow('session-title-llm')
  guard.finish()
  await Promise.all([first.ready, second.ready])
  first.release()
  assert.equal(guard.services.has(GRANT), false)
  second.release()
  assert.equal(guard.services.get(GRANT), true)
  guard.unload()
  const lone = claimOfficialRow('another-official-row')
  await lone.ready
  lone.release()
})

test('守卫重查（同级重组）不会把许可撤了再给；认领期间重查也不会提前交还', async () => {
  const guard = await startGuard([bundle(), official()])
  await guard.recheck()
  await guard.recheck()
  assert.deepEqual(grants(guard.log), [['provide', GRANT]])
  const claim = claimOfficialRow('session-title-llm')
  guard.finish()
  await claim.ready
  await guard.recheck()
  assert.equal(guard.services.has(GRANT), false)
  claim.release()
  assert.deepEqual(grants(guard.log), [['provide', GRANT], ['withdraw', GRANT], ['provide', GRANT]])
  guard.unload()
})

test('同级不再有行要这份许可时撤回；守卫卸载以后交还许可什么都不做（DSH 自带的那一行跟着整棵树撤）', async () => {
  const guard = await startGuard([bundle(), official()])
  guard.parent.data = [bundle()]
  await guard.recheck()
  assert.equal(guard.services.has(GRANT), false)
  guard.parent.data = [bundle(), official()]
  await guard.recheck()
  assert.equal(guard.services.get(GRANT), true)
  const claim = claimOfficialRow('session-title-llm')
  guard.finish()
  await claim.ready
  guard.unload()
  assert.doesNotThrow(() => claim.release())
  assert.equal(guard.services.has(GRANT), false)
})

test('报告那一行（bundle-status）不提供许可', async () => {
  const services = new Map()
  const ctx = {
    fiber: { entry: { parent: { data: [bundle(), official()] } } },
    get: () => ({ conflict: undefined }),
    provide(key, value) { services.set(key, value); return () => services.delete(key) },
  }
  await applyGuard(ctx, { bundle: full, report: true })
  assert.equal(services.has(GRANT), false)
})

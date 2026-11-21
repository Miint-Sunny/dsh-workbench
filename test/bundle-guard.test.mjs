import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, workbenchBundleConflict } from '../lib/bundle-guard.js'

const full = 'dsh-workbench'
const usage = full + '-usage'
const navigation = full + '-navigation'
const overlap = full + '-overlap'
const usageIds = [full + '-usage', full + '-quota', full + '-context']
const group = (name, ids) => ({
  id: name + '-bundle',
  name: 'cordis:group',
  group: true,
  inject: [name + '.bundle-allowed'],
  config: ids.map(id => ({ id, name: name + '/' + id.slice(full.length + 1) })),
})

test('whole and small bundles both report the shared ids in either composition order', () => {
  const whole = group(full, [...usageIds, full + '-tasks'])
  const small = group(usage, usageIds)
  for (const rows of [[whole, small], [small, whole]]) {
    for (const name of [full, usage]) {
      const conflict = workbenchBundleConflict(rows, name)
      for (const part of [full, usage, ...usageIds, '保留整包', '小包']) assert(conflict.includes(part), part)
    }
  }
})

test('disjoint split bundles pass, while two split bundles report their actual shared row', () => {
  const rows = [group(usage, usageIds), group(navigation, [full + '-command-palette'])]
  for (const name of [usage, navigation]) assert.equal(workbenchBundleConflict(rows, name), undefined)
  rows.push(group(overlap, [full + '-quota']))
  for (const name of [usage, overlap]) {
    const conflict = workbenchBundleConflict(rows, name)
    for (const part of [usage, overlap, full + '-quota']) assert(conflict.includes(part), part)
    assert(!conflict.includes(full + '-context'))
  }
  assert.equal(workbenchBundleConflict(rows, navigation), undefined)
})

test('a guarded small bundle detects the flat rows of the pre-guard whole bundle', () => {
  const rows = [
    { id: full, name: full },
    ...usageIds.map(id => ({ id, name: full + '/' + id.slice(full.length + 1) })),
    group(usage, usageIds),
  ]
  const conflict = workbenchBundleConflict(rows, usage)
  for (const part of [full, usage, ...usageIds]) assert(conflict.includes(part), part)
})

test('a live conflict revokes permission and removing it requires a fresh mount', async () => {
  const whole = group(full, usageIds)
  const parent = { data: [whole] }
  const services = new Map()
  let update
  const ctx = {
    fiber: { entry: { parent } },
    logger: { warn() {} },
    effect: body => body(),
    on(event, callback) {
      assert.equal(event, 'internal/update')
      update = callback
    },
    provide(key, value) {
      services.set(key, value)
      return () => services.delete(key)
    },
  }
  const allowed = full + '.bundle-allowed'
  await apply(ctx, { bundle: full })
  assert.equal(services.get(allowed), true)
  parent.data = [whole, group(usage, usageIds)]
  await update()
  assert.equal(services.has(allowed), false)
  parent.data = [whole]
  await update()
  assert.equal(services.has(allowed), false)
  assert.match(services.get(full + '.bundle-state').conflict, /重启/)
})

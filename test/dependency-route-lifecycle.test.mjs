import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { applyReview } from '../lib/review/index.js'
import { applyCheckpoints } from '../lib/checkpoints.js'
import { tempDirSync } from './helpers/temp-dir.mjs'

// Model Cordis ownership: inject creates a child of its receiver; disposing a
// dependency child must dispose only that subtree, while the row stays mounted.
function contextTree(services) {
  const routes = new Map()
  const connection = { fetch: { register(route) {
    assert.equal(routes.has(route.path), false, `duplicate ${route.path}`)
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } }
  function scope() {
    const children = [], effects = []
    return { ...services, connection, children, on() {}, logger: { warn() {} },
      inject(deps, mount) { const child = scope(); children.push(child); mount(child); return child },
      effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
      async dispose() { for (const child of children) await child.dispose(); for (const dispose of effects.splice(0)) await dispose?.() },
    }
  }
  return { root: scope(), routes }
}

for (const feature of ['review', 'checkpoints']) {
  test(`W-011 ${feature} routes retire with their dependency scope and remount cleanly`, async () => {
    const dir = tempDirSync('dependency-routes-')
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    const tree = contextTree({ workspaceChanges: { summary: () => undefined }, agents: { get: () => undefined }, fs: {}, subprocess: {}, sessionPersistence: { list: async () => [] } })
    try {
      const mount = () => feature === 'review' ? applyReview(tree.root, { dataDir: join(dir, 'review') }) : applyCheckpoints(tree.root)
      mount()
      const count = tree.routes.size
      assert.ok(count >= 3)
      await tree.root.children[0].dispose()
      assert.equal(tree.routes.size, 0, 'dependency teardown must release its routes')
      mount()
      assert.equal(tree.routes.size, count)
      await tree.root.children.at(-1).dispose()
      assert.equal(tree.routes.size, 0)
    } finally {
      try { await tree.root.dispose() }
      finally {
        if (oldHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = oldHome
      }
    }
  })
}

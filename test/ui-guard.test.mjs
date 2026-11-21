import test from 'node:test'
import { pathToFileURL } from 'node:url'

test('界面的图标和用语跟 DSH 一致（dsh-ui-guard）', async t => {
  // 先用 DSH_UI_GUARD_PATH 指的守卫（本机检出里的 index.mjs），再找开发依赖。
  const local = process.env.DSH_UI_GUARD_PATH
  let guard
  try {
    guard = local ? pathToFileURL(local).href : import.meta.resolve('dsh-ui-guard')
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return t.skip('未找到 dsh-ui-guard：先 npm ci')
  }
  const { runGuardTest } = await import(guard)
  runGuardTest(t, new URL('..', import.meta.url))
})

/** 用量主页的测试和截图共用：在替身 React 里挂载构建好的 UsagePage，接口返回传入的概览数据。 */
import { loadClient } from './react-harness.mjs'
import { USAGE_ZH, USAGE_EN } from '../src/client/usage-copy.js'

/**
 * 按字典翻译，占位符 `{name}` 用参数替换。
 * @param {Record<string, string>} dictionary 字典。
 * @returns {(key: string, params?: object) => string} 翻译函数。
 */
export function usageTranslator(dictionary = USAGE_ZH) {
  return (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}
export { USAGE_ZH, USAGE_EN }

/**
 * 挂载用量页。
 * @param {object} data `buildOverview` 的结果。
 * @param {{store?: Record<string, string>, dictionary?: Record<string, string>}} [options] `store` 是 localStorage 里已有的值（范围、详情开关）。
 * @returns {Promise<{react: object, client: object, store: Record<string, string>}>} 已经读完数据的页面。
 */
export async function mountUsagePage(data, { store = {}, dictionary = USAGE_ZH } = {}) {
  const storage = { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = String(value) } }
  const window = { localStorage: storage, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }
  const document = { addEventListener() {}, removeEventListener() {}, querySelector: () => null }
  const fetch = async () => ({ ok: true, json: async () => data })
  const client = loadClient(new URL('../lib/client.js', import.meta.url), { window, document, fetch })
  client.set('usageT', usageTranslator(dictionary))
  client.set('usageStore', { has: () => false })
  client.set('usageCtx', { layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'dsh-workbench-usage' }) } }, uiWorkspace: { openSession() {} } })
  const { react } = client
  react.mount(react.React.createElement(client.get('UsagePage')))
  await react.settle()
  return { react, client, store }
}

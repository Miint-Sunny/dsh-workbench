import assert from 'node:assert/strict'
import test from 'node:test'
import { presetText } from '../lib/preset-copy.js'

test('chore139 sentence spacing follows the selector language', () => {
  const status = { ready: true, missing: [], mismatched: [] }
  for (const kind of ['coding', 'full']) {
    const zh = presetText('zh', kind, status, { mcpRows: [] }).description
    const en = presetText('en', kind, status, { mcpRows: [] }).description
    assert.match(zh, /。已启用 LSP。$/)
    assert.doesNotMatch(zh, /。\s/)
    assert.match(en, /\. LSP enabled\.$/)
  }
})

const cases = [
  ['enabled', { ready: true }, {}, { zh: /已启用 LSP/, en: /LSP enabled/ }],
  ['missing', { missing: ['@deepseek-ai/dsh-tool-lsp'] }, {}, { zh: /未安装/, en: /not installed/ }],
  ['mismatch', { mismatched: [{ name: '@deepseek-ai/dsh-lsp', version: '0.2.2-rc.2' }] }, {}, { zh: /版本.*不一致/, en: /version mismatch/ }],
  ['configuration', { configurationUnavailable: true }, {}, { zh: /未配置语言服务器/, en: /language server not configured/ }],
  ['mcp unavailable', { ready: true }, { mcpUnavailable: true }, { zh: /共享 MCP 未加载/, en: /Shared MCP not loaded/ }],
  ['mcp loaded', { ready: true }, { mcpRows: [{ config: {} }] }, { zh: /共享 MCP/, en: /Shared MCP/ }],
]
for (const locale of ['zh', 'en']) for (const [label, state, config, reason] of cases) {
  test(`chore138 ${locale} ${label} describes mode and status in at most two short sentences`, () => {
    for (const kind of ['coding', 'full']) {
      const status = { ready: false, appVersion: '0.2.8-rc.4', missing: [], mismatched: [], ...state }
      const text = presetText(locale, kind, status, { mcpRows: [], ...config })
      assert.match(text.description, reason[locale])
      assert.match(text.description, locale === 'zh' ? /标准模式/ : /Standard mode/)
      assert.doesNotMatch(text.description, /@deepseek|dsh plugin|nodePath|serverPath|typescriptPath|0\.2\./)
      assert((text.description.match(/[。.!?]/g) ?? []).length <= 2, text.description)
      assert(text.description.length <= (locale === 'zh' ? 100 : 220), text.description)
      assert.equal(/[\u3400-\u9fff]/.test(text.name), locale === 'zh')
      if (!status.ready) assert.doesNotMatch(text.description, /已启用 LSP|LSP enabled/)
      if (config.mcpUnavailable) assert.doesNotMatch(text.description, /已加载共享 MCP|Shared MCP loaded/)
    }
  })
}

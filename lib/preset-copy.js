/** Short selector copy; installation commands belong in the README. */
const copy = {
  zh: {
    names: { coding: '代码模式', full: '全开模式' },
    coding: '标准模式的工具，常用工具直接可用，其他工具按需加载。',
    full: '标准模式的工具，所有工具定义从一开始加载。',
    lsp: '已启用 LSP',
    missing: 'LSP 未启用（未安装对应包）',
    mismatch: 'LSP 未启用（包版本与 DSH 不一致）',
    config: 'LSP 未启用（未配置语言服务器）',
    imports: 'LSP 未启用（组件无法加载）',
    mcp: '已加载共享 MCP',
    mcpUnavailable: '共享 MCP 未加载',
    join: '；', end: '。',
  },
  en: {
    names: { coding: 'Code mode', full: 'Full mode' },
    coding: 'Standard mode tools; common tools are ready immediately and others load on demand.',
    full: 'Standard mode tools; all tool definitions load from the start.',
    lsp: 'LSP enabled',
    missing: 'LSP disabled (packages not installed)',
    mismatch: 'LSP disabled (package version mismatch)',
    config: 'LSP disabled (language server not configured)',
    imports: 'LSP disabled (components could not load)',
    mcp: 'Shared MCP loaded',
    mcpUnavailable: 'Shared MCP not loaded',
    join: '; ', end: '.',
  },
}

export function presetText(locale, kind, status, settings) {
  const words = copy[locale]
  const reason = status.ready ? 'lsp' : status.missing.length ? 'missing' : status.mismatched.length ? 'mismatch'
    : status.configurationUnavailable || settings.lspUnavailable ? 'config' : 'imports'
  const states = [words[reason]]
  if (settings.mcpUnavailable) states.push(words.mcpUnavailable)
  else if (settings.mcpRows.some(row => !row.disabled)) states.push(words.mcp)
  return { name: words.names[kind], description: words[kind] + (locale === 'zh' ? '' : ' ') + states.join(words.join) + words.end }
}

import {isAbsolute} from 'node:path'

export const lspPackages = ['@deepseek-ai/dsh-lsp', '@deepseek-ai/dsh-lsp-stdio', '@deepseek-ai/dsh-tool-lsp']

/** Validate host-owned executable/module paths without reading any profile or installing tools. */
export function parseLspConfig(options = {}) {
  const keys = ['nodePath', 'serverPath', 'typescriptPath']
  for (const key of Object.keys(options)) if (!keys.includes(key)) throw new Error(`Unknown LSP option: ${key}`)
  const config = {}
  for (const key of keys) {
    if (typeof options[key] !== 'string' || !isAbsolute(options[key])) throw new Error(`LSP ${key} must be an absolute path`)
    config[key] = options[key]
  }
  return config
}

/** Refuse global mounting; missing or mismatched optional packages simply are not ready. */
export function assertLspAdmission(scoped, appVersion, versions) {
  if (!scoped) throw new Error('LSP must be mounted inside the coding preset, in an isolated lsp group')
  return versions.length === 3 && versions.every(version => version === appVersion)
}

/** A single opt-in group to append to the existing coding preset, not a replacement preset. */
export function createLspPresetEntry(options) {
  return { id: 'dsh-workbench-lsp', name: 'cordis:group', group: true, isolate: { lsp: true },
    config: [{ id: 'dsh-workbench-lsp-runtime', name: '@miint-sunny/dsh-workbench/lsp', config: parseLspConfig(options) }] }
}

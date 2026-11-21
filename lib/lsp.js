/** Coding-preset-only LSP composition. Paths are explicit and packages follow the current App. */
import {scopeOf} from '@deepseek-ai/dsh-scope'
import {assertLspAdmission} from './lsp-config.js'
import {probeLspStatus} from './lsp-status.js'

export const name = '@miint-sunny/dsh-workbench/lsp'
export const inject = ['loader']

export async function apply(ctx, options) {
  if (scopeOf(ctx) === undefined) assertLspAdmission(false, '', [])
  const status = await probeLspStatus(ctx, options)
  if (!status.ready) return
  const { config, modules: [definition, provider, consumer] } = status
  ctx.plugin(definition.default)
  ctx.plugin(provider, { servers: { typescript: {
    command: config.nodePath, args: [config.serverPath, '--stdio'],
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact' },
    initializationOptions: { disableAutomaticTypingAcquisition: true, plugins: [], tsserver: { path: config.typescriptPath, useSyntaxServer: 'never' } },
    configuration: {},
  } } })
  ctx.plugin(consumer)
}

/** Probe optional profile packages before importing their implementations. */
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { parseLspConfig, lspPackages, assertLspAdmission } from './lsp-config.js'

/** Resolve from the active profile even when workbench itself is installed through link:. */
function profileBase(ctx) {
  const profile = ctx.get('profileContext')
  return profile ? pathToFileURL(join(profile.dir, 'package.json')).href : ctx.baseUrl
}

export async function probeLspStatus(ctx, options) {
  const appVersion = getDshRuntimeVersion()
  const status = { ready: false, appVersion, missing: [], mismatched: [] }
  const base = profileBase(ctx)
  const versions = []
  for (const pkg of lspPackages) {
    try {
      const manifest = await ctx.loader.internal.import(pkg + '/package.json', base, { type: 'json' })
      versions.push(manifest.default.version)
      if (manifest.default.version !== appVersion) status.mismatched.push({ name: pkg, version: manifest.default.version })
    } catch { status.missing.push(pkg) }
  }
  if (!assertLspAdmission(true, appVersion, versions)) return status
  try {
    status.config = parseLspConfig(options)
    for (const path of Object.values(status.config)) if (!statSync(path).isFile()) throw new Error('Language server paths must be files')
    accessSync(status.config.nodePath, constants.X_OK)
    accessSync(status.config.serverPath, constants.R_OK)
    accessSync(status.config.typescriptPath, constants.R_OK)
  } catch { return { ...status, configurationUnavailable: true } }
  try {
    status.modules = await Promise.all(lspPackages.map(pkg => ctx.loader.internal.import(pkg, base, {})))
    status.ready = true
  } catch { status.importUnavailable = true }
  return status
}

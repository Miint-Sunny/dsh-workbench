/** Host preference used by custom preset display fields; no profile files are read. */
export function presetLocale(ctx, explicit) {
  if (explicit === 'zh' || explicit === 'en') return explicit
  const preference = [...(ctx.get('loader')?.entries() ?? [])]
    .find(entry => entry.options.id === 'locale')?.options.config?.preference
  const language = preference || process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale
  return /^zh(?:[-_]|$)/i.test(language) ? 'zh' : 'en'
}

/** Invalidate the native roster using its existing settings notification seam.
 * Reuse the real revision: this is a display refresh, never a settings write.
 */
export function refreshPresetDisplay(ctx) {
  const descriptor = ctx.get('settings')?.describe().find(row => row.ns === 'agent-preset-registry')
  if (descriptor) ctx.emit('settings/document-updated', descriptor.ns, descriptor.revision)
}

export function watchPresetLocale(ctx) {
  ctx.on('settings/document-updated', ns => { if (ns === 'locale') refreshPresetDisplay(ctx) })
}

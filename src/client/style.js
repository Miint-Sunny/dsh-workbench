/** dsh-workbench 网页端的样式。颜色用 DSH 的 --dsw-alias-* 变量（跟随深浅色），任务条的位置和宽度照官方 TodoPanel 的算法。 */

const CSS = `
.dwb-select-field{display:grid;gap:6px;min-width:0}
.dwb-select-field>span:last-child{display:block;min-width:0}
.dwb-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dwb-select-trigger>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-select-trigger>svg{flex:none}
.dwb-select-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwb-select-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

.dwb-row-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.dwb-row-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.dwb-row-summary[data-error]{color:var(--dsw-alias-state-error-primary)}
.dwb-row-suffix{flex:none;display:inline-flex;align-items:center;margin-left:8px}
.dwb-row-link{margin:0;padding:0;border:none;background:none;font:inherit;color:inherit;cursor:pointer;text-decoration:underline dotted;text-decoration-thickness:1px;text-underline-offset:3px}
.dwb-row-link:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

.dwb-wrapup{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px 18px;display:grid;gap:16px;min-width:0}
.dwb-wrapup-head{display:flex;align-items:flex-start;gap:12px;min-width:0}
.dwb-wrapup-recap{flex:1 1 auto;min-width:0;margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dwb-wrapup-close{flex:none;margin:-3px -6px -3px 0}
.dwb-wrapup-ask{margin:4px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dwb-wrapup-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-start;min-width:0}
.dwb-wrapup-btn{max-width:100%}
.dwb-wrapup-btn[data-tone=secondary]{background:var(--dsw-alias-bg-module-platform)}
.dwb-wrapup-btn[data-tone=secondary]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-module-platform) 90%,var(--dsw-alias-label-primary) 10%)}
.dwb-wrapup-btn>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-next-keys{margin-left:6px;flex:none;color:inherit;opacity:.55}
.dwb-wrapup-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);display:flex;gap:6px;align-items:center}
.dwb-wrapup-note[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dwb-linklike{color:var(--dsw-alias-link);cursor:pointer;background:none;border:none;padding:0;font:inherit}
.dwb-linklike:disabled{opacity:.4;cursor:default}
.dwb-todo{box-sizing:border-box;flex:none;overflow:hidden;margin:0 auto;border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dwb-todo-body{display:flex;flex-direction:column;gap:8px;padding:6px 12px}
.dwb-todo-head{display:flex;align-items:center;gap:10px;width:100%;padding:0;border:none;background:transparent;text-align:left;cursor:pointer;font:inherit}
.dwb-todo-lead{display:grid;flex:none;place-items:center;color:var(--dsw-alias-label-tertiary)}
.dwb-todo-lead[data-done=all]{color:var(--dsw-alias-state-success-primary)}
.dwb-todo-title{flex:none;font-size:13px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dwb-todo-progress{flex:1 1 auto;min-width:0;overflow:hidden;font-size:13px;line-height:20px;font-weight:400;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap}
.dwb-todo-bar{flex:none;width:88px;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover-solid);overflow:hidden}
.dwb-todo-bar>i{display:block;height:100%;background:var(--dsw-alias-label-secondary);border-radius:2px}
.dwb-todo-chevron{display:grid;flex:none;place-items:center;color:var(--dsw-alias-label-tertiary)}
.dwb-todo-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0 2px 2px;list-style:none;max-height:180px;overflow-y:auto}
.dwb-todo-item{display:flex;align-items:center;gap:10px;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dwb-todo-item[data-status=completed]{color:var(--dsw-alias-label-tertiary)}
.dwb-todo-item[data-status=in_progress]{color:var(--dsw-alias-label-primary);font-weight:500}
.dwb-todo-glyph{display:grid;flex:none;place-items:center;width:16px;height:16px;color:var(--dsw-alias-label-dimmed)}
.dwb-todo-item[data-status=completed] .dwb-todo-glyph{color:var(--dsw-alias-state-success-primary)}
.dwb-todo-item[data-status=in_progress] .dwb-todo-glyph{color:var(--dsw-alias-link)}
.dwb-todo-content{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-notify-page{display:grid;gap:14px;padding:18px 24px 22px}
.dwb-notify-group{display:grid;gap:8px;justify-items:start}
.dwb-notify-group>h4{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary);justify-self:stretch}
.dwb-notify-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0;justify-self:stretch;display:grid;gap:2px}
.dwb-notify-info{background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
`

/** 把样式挂到文档上；返回移除函数。 */
function mountStyle(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-workbench'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-workbench: styles')
}

/**
 * 把一个功能行的样式挂到文档上，各功能行挂载时用；没有 document 的环境（node 里的测试）什么也不做。
 * @param {string} plugin style 元素的 data-plugin，例如 dsh-workbench-split。
 * @param {string} css 样式文字。
 * @returns {() => void} 移除函数。
 */
export function mountModuleStyle(plugin, css) {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = plugin
  style.textContent = css
  document.head.appendChild(style)
  return () => { style.remove() }
}

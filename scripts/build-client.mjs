/** 把 src/client/ 下的模块拼成 lib/client.js。DSH 的模块加载器把客户端入口当普通脚本拼进页面，不能有 import/export，所以这里去掉它们，全部放进同一个 factory 里。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORDER = [
  'src/client/features.js',
  'lib/review/copy.js',
  'src/client/style.js',
  'src/client/copy.js',
  'src/client/dock.js',
  'src/client/next-step.js',
  'src/client/wrapup.js',
  'lib/session-cards-state.js',
  'src/client/session-cards.js',
  'src/client/session-ask.js',
  'src/client/notify.js',
  'src/client/review.js',
  'src/client/split.js',
  'src/client/rerun.js',
  'src/client/reply.js',
  'src/client/plan.js',
  'lib/pages-csp.js',
  'lib/pages-scripts.js',
  'src/client/pages.js',
  'src/client/find.js',
  'src/client/organize.js',
  'src/client/checkpoints.js',
  'src/client/usage-model.js',
  'src/client/usage-charts.js',
  'src/client/usage-copy.js',
  'src/client/usage-style.js',
  'src/client/usage-chart-view.js',
  'src/client/usage.js',
  'src/client/memory.js',
  'src/client/controls.js',
  'src/client/context-copy.js',
  'src/client/context-model.js',
  'src/client/context.js',
  'src/client/local-review-copy.js',
  'src/client/local-review.js',
  'src/client/review-panel-copy.js',
  'src/client/review-panel-model.js',
  'src/client/review-panel.js',
  'lib/design-protocol.js',
  'lib/design-bridge.js',
  'src/client/design-copy.js',
  'src/client/design-style.js',
  'src/client/design.js',
  'src/client/mcp-copy.js',
  'src/client/mcp.js',
  'src/client/approval-rules-copy.js',
  'src/client/approval-rules.js',
  'src/client/new-tab-model.js',
  'src/client/new-tab.js',
  'src/client/command-palette-model.js',
  'src/client/command-palette.js',
  'src/client/attention-model.js',
  'src/client/attention.js',
  'src/client/worktrees.js',
  'src/client/turn-nav-model.js',
  'src/client/turn-nav.js',
  'src/client/browser-viewport-model.js',
  'src/client/browser-viewport.js',
  'lib/workspace-trust-route.js',
  'src/client/workspace-trust-model.js',
  'src/client/workspace-trust-copy.js',
  'src/client/workspace-trust.js',
  'src/client/session-header.js',
  'src/client/settings-icons.js',
  'src/client/workspace-move-copy.js',
  'src/client/workspace-move.js',
  'src/client/workspace-folders-copy.js',
  'src/client/workspace-folders.js',
  'src/client/preset-switch-model.js',
  'src/client/preset-switch-copy.js',
  'src/client/preset-switch.js',
  'lib/model-settings/key-ref.js',
  'lib/model-settings/companion.js',
  'src/client/model-settings/keys.js',
  'src/client/model-settings/protocol.js',
  'src/client/model-settings/models.js',
  'src/client/model-settings/retry.js',
  'src/client/model-settings/discovery.js',
  'src/client/model-settings/catalog.js',
  'src/client/model-settings/status.js',
  'src/client/model-settings/copy.js',
  'src/client/model-settings/style.js',
  'src/client/model-settings/store.js',
  'src/client/model-settings/account.js',
  'src/client/model-settings/nav.js',
  'src/client/model-settings/parts.js',
  'src/client/model-settings/api-key-input.js',
  'src/client/model-settings/retry-policy.js',
  'src/client/model-settings/list.js',
  'src/client/model-settings/add.js',
  'src/client/model-settings/models-editor.js',
  'src/client/model-settings/detail.js',
  'src/client/model-settings/section.js',
  'src/client/session-title.js',
  'src/client/main.js',
]

const body = ORDER.map((file) => {
  const source = readFileSync(join(root, file), 'utf8')
    .split('\n')
    .filter(line => !/^import\s.+\sfrom\s.+$/.test(line))
    .map(line => line.replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/, ''))
    .join('\n')
  return `  // ---- ${file} ----\n${source.replace(/^/gm, '  ').replace(/^ +$/gm, '')}`
}).join('\n')

const output = `/** dsh-workbench 的浏览器端：由 scripts/build-client.mjs 从 src/client 生成，不要手改。 */
window.__ModuleLoader__.load({
  id: '@miint-sunny/dsh-workbench',
  factory: require => {
  'use strict'
  const React = require('react')
  const ReactDOM = require('react-dom')
  const ui = require('@deepseek-ai/dsh-client-ui-primitives')
  const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
${body}
  return { inject: INJECT, apply: applyClient }
  },
})
`
const target = join(root, 'lib/client.js')
writeFileSync(target, output)
execFileSync(process.execPath, ['--check', target])
// npm pack --json keeps stdout machine-readable when this runs as prepack.
console.error(`lib/client.js：${output.split('\n').length} 行`)

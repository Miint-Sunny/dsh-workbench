/** 固定画板尺寸只用于预览；工具栏和图钉使用宿主像素。 */
const DESIGN_STYLE = `
.dwb-design {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  container: design/inline-size;
}
.dwb-design * {
  box-sizing: border-box;
  min-width: 0;
}
:where(.dwb-design) button,
:where(.dwb-design) input:not([type="checkbox"]),
:where(.dwb-design) textarea,
:where(.dwb-design) select {
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  padding: 4px 8px;
  min-height: 28px;
}
:where(.dwb-design) button {
  cursor: pointer;
}
:where(.dwb-design) button:disabled {
  opacity: 0.5;
  cursor: default;
}
:where(.dwb-design) button:hover:not(:disabled),
.dwb-design button[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dwb-design :focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dwb-design h2,
.dwb-design h3,
.dwb-design p {
  margin: 0;
}
.dwb-design h2,
.dwb-design h3 {
  font-size: 14px;
  font-weight: 500;
}
.dwb-design-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex-wrap: wrap;
}
.dwb-design-header h2 {
  flex: 1;
}
.dwb-design-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dwb-design-tools output {
  min-width: 44px;
  display: grid;
  place-items: center;
  font-variant-numeric: tabular-nums;
}
.dwb-design-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
}
.dwb-design-viewport {
  user-select: none;
  -webkit-user-select: none;
  position: relative;
  overflow: hidden;
  min-height: 320px;
  background: var(--dsw-alias-bg-layer-2);
  touch-action: none;
}
.dwb-design-world,
.dwb-design-overlays {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  width: 1703px;
  height: 812px;
}
.dwb-design-overlays {
  pointer-events: none;
}
.dwb-design-board {
  position: absolute;
  top: 0;
  background: white;
  box-shadow: 0 1px 5px #0003;
}
.dwb-design-board iframe {
  display: block;
  border: 0;
  width: 100%;
  height: 100%;
  background: white;
}
.dwb-design-label {
  position: absolute;
  top: -25px;
  white-space: nowrap;
  font-size: 12px;
}
.dwb-design-pin {
  position: absolute;
  pointer-events: auto;
  min-height: 24px !important;
  width: 24px;
  padding: 0 !important;
  border-radius: 50% !important;
  background: var(--dsw-alias-state-business-primary) !important;
  color: var(--dsw-alias-label-primary-foreground) !important;
  transform: translate(-50%, -50%);
}
.dwb-design-mask {
  position: absolute;
  inset: 0;
  cursor: grab;
}
.dwb-design-mask[data-mode="position"] {
  cursor: crosshair;
}
.dwb-design-side {
  border-left: 1px solid var(--dsw-alias-border-l2);
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.dwb-design-side section {
  display: grid;
  gap: 10px;
}
.dwb-design-side label {
  display: grid;
  gap: 5px;
}
.dwb-design-side textarea {
  width: 100%;
  min-height: 84px;
  resize: vertical;
}
.dwb-design-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dwb-design-small {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dwb-design-scripts {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dwb-design-scripts button {
  flex: none;
  white-space: nowrap;
}
.dwb-design-notice {
  font-size: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dwb-design-comment {
  padding: 10px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  overflow-wrap: anywhere;
  cursor: pointer;
}
.dwb-design-comment[data-selected="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dwb-design-pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  max-height: 280px;
  overflow: auto;
}
.dwb-design-state {
  padding: 24px;
}
.dwb-design dialog {
  color: inherit;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  padding: 18px;
  width: min(620px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  overflow: auto;
}
.dwb-design dialog::backdrop {
  background: var(--dsw-alias-bg-mask-1);
}
.dwb-design dialog pre {
  max-height: 55dvh;
}
.dwb-design-list {
  padding: 16px;
  display: grid;
  gap: 8px;
  align-content: start;
  overflow: auto;
}
.dwb-design-list button {
  text-align: start;
}
.dwb-design summary {
  cursor: pointer;
  min-height: 28px;
}
@container design (max-width:650px) {
  .dwb-design-body {
    grid-template-columns: 1fr;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .dwb-design-viewport {
    flex: none;
    height: 380px;
  }
  .dwb-design-side {
    border-left: 0;
    border-top: 1px solid var(--dsw-alias-border-l2);
    overflow: visible;
  }
  :where(.dwb-design) input:not([type="checkbox"]),
  :where(.dwb-design) textarea,
  :where(.dwb-design) select {
    font-size: 16px;
  }
  .dwb-design-header,
  .dwb-design-tools {
    padding-inline: 10px;
  }
}
`

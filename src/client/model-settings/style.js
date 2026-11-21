/** 页面样式。颜色、圆角都用 DSH 的 --dsw-* 变量，跟着 DSH 的深色、浅色主题走；数值照内置模型页（ModelsSection.module.css）。 */

const STYLE = `
.dms { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); container-type: inline-size; min-width: 0; }
.dms * { box-sizing: border-box; }
.dms-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; overflow-wrap: anywhere; }
.dms-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.dms-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dms-ok { color: var(--dsw-alias-state-success-primary); }
.dms-warn { color: var(--dsw-alias-state-warn-label); }
.dms-err { color: var(--dsw-alias-state-error-primary); }
.dms-idle { color: var(--dsw-alias-label-tertiary); }
.dms-rows { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dms-model:focus-visible, .dms-mhead:focus-visible, .dms-iconbtn:focus-visible, .dms-crumb:focus-visible, .dms-link:focus-visible,
.dms-danger:focus-visible, .dms-disc:focus-visible, .dms-chip:focus-visible, .dms-opt:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dms-ico { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; font-size: 12px; font-weight: 600; color: #fff;
  background: var(--dms-c, #5a5d64); letter-spacing: .02em; flex: 0 0 auto; }
.dms-ico.dms-lg { width: 40px; height: 40px; border-radius: 11px; font-size: 14px; }
.dms-main { display: flex; flex-direction: column; min-width: 0; }
.dms-name { font-size: 14px; line-height: 22px; font-weight: 500; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; overflow-wrap: anywhere; }
.dms-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dms-tag { font-size: 12px; line-height: 16px; font-weight: 400; color: var(--dsw-alias-label-secondary); border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs); padding: 1px 6px; white-space: nowrap; }
/* 状态只给圆点上色，文字用次要灰，和 DSH 内置页的凭据圆点一样。 */
.dms-state { font-size: 12px; line-height: 18px; display: inline-flex; gap: 6px; align-items: baseline; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary);
  --dms-tone: var(--dsw-alias-label-caption); }
.dms-state[data-tone="ok"] { --dms-tone: var(--dsw-alias-state-success-primary); }
.dms-state[data-tone="warn"] { --dms-tone: var(--dsw-alias-state-warn-primary); }
.dms-state[data-tone="err"] { --dms-tone: var(--dsw-alias-state-error-primary); }
.dms-state::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dms-tone); flex: 0 0 auto; transform: translateY(-1px); }
.dms-chev { color: var(--dsw-alias-label-caption); flex: none; }
.dms-crumb { align-self: flex-start; display: inline-flex; align-items: center; gap: 2px; border: 0; background: none; padding: 0; font: inherit;
  font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dms-crumb:hover { color: var(--dsw-alias-label-primary); }
.dms-link { display: inline-flex; align-items: center; gap: 2px; border: 0; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-business-primary); cursor: pointer; text-decoration: none; }
.dms-link:hover { text-decoration: underline; }
.dms-danger { align-self: flex-start; border: 0; background: none; padding: 0; font: inherit; font-size: 14px; color: var(--dsw-alias-state-error-primary); cursor: pointer; }
.dms-danger:disabled { opacity: .4; cursor: default; }
.dms-module { background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dms-sec { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; padding-top: 16px; flex-wrap: wrap; }
.dms-sec .dms-meta { font-weight: 400; }
.dms-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dms-label { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; align-items: center; }
.dms-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
/* 凭据名被占用时的两选一（feat#174）：选中只靠圆点，悬停只改底色；选项下面的密钥框和选项文字对齐。 */
.dms-opts { display: flex; flex-direction: column; gap: 2px; }
.dms-opt { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: start; width: 100%; padding: 6px 8px; border: 0; border-radius: 10px;
  background: none; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; }
.dms-opt:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dms-opt:disabled { color: var(--dsw-alias-label-caption); cursor: default; }
/* DSH 全局把圆角做成 superellipse（方圆形），单选的圆点要真正的圆。 */
.dms-radio { width: 14px; height: 14px; margin-top: 3px; border: 1px solid var(--dsw-alias-border-l4); border-radius: 50%; corner-shape: round; display: grid; place-items: center; }
.dms-opt[aria-checked="true"] .dms-radio { border-color: var(--dsw-alias-label-primary); }
.dms-opt[aria-checked="true"] .dms-radio::after { content: ""; width: 6px; height: 6px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary); }
.dms-opt-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dms-opt-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dms-under { display: flex; flex-direction: column; gap: 6px; padding-left: 30px; }
.dms-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.dms-spread { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.dms-end { display: flex; justify-content: flex-end; gap: 8px; align-items: center; flex-wrap: wrap; }
.dms-foot { position: sticky; bottom: 0; z-index: 1; display: flex; justify-content: flex-end; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 12px 0 4px; border-top: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-settings-card-fill); }
.dms-foot .dms-note { margin-right: auto; }
/* DSH 的设置滚动区底部有 24px 内边距，吸底栏停在内边距上方；往下补一块同色底，挡住从下面滚过去的内容。 */
.dms-foot::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 32px; background: inherit; }
.dms-skel { height: 72px; border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-interactive-bg-hover); }
.dms-empty { background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-lg); padding: 18px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.dms-empty-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; }
/* 模型页：标题、搜索框和分类栏不动，只有右边的提供商列表滚动。设置的内容区（SettingsRoot 的 .options）在高度确定的面板里，
   dms-fill 占满它，两栏这一块拿剩下的高度，列表在这一块里滚动；滚动条在列表自己的右边，样式是 DSH 全局的。 */
.dms.dms-fill { height: 100%; min-height: 0; }
.dms-fill > .dms-pick { flex: 1 1 0; min-height: 0; }
.dms-fill .dms-scroll { overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
.dms-searchbox { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); min-width: 0; flex: none; }
.dms-searchbox:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.dms-search-ico { flex: none; color: var(--dsw-alias-label-tertiary); }
.dms-searchinput { flex: 1; min-width: 0; height: 100%; border: 0; background: none; padding: 0; outline: none; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; }
.dms-searchinput::placeholder { color: var(--dsw-alias-label-dimmed); }
.dms-pick { display: grid; grid-template-columns: 112px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; }
.dms-cats { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; align-self: start; max-height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-width: none; }
.dms-cats::-webkit-scrollbar { display: none; }
.dms-cat { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; width: 100%; padding: 7px 12px; border: 0; border-radius: var(--dsw-radius-md); background: none;
  font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); cursor: pointer; text-align: left; white-space: nowrap; }
.dms-cat:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dms-cat[aria-pressed="true"] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); }
.dms-n { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dms-scroll { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
/* 一行提供商：整行是一个透明按钮（dms-pv-hit），看得见的内容叠在上面、不接鼠标，只有线路按钮和登录按钮接。悬停只改底色。 */
.dms-pvs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dms-pv { position: relative; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px;
  border-radius: var(--dsw-radius-lg); min-width: 0; }
.dms-pv-card { background: var(--dsw-alias-settings-card-fill); border: .5px solid var(--dsw-alias-settings-card-stroke); }
.dms-pv:has(> .dms-pv-hit:enabled):hover, .dms-pv[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.dms-pv-hit { position: absolute; inset: 0; width: 100%; margin: 0; padding: 0; border: 0; border-radius: inherit; background: none; font: inherit; color: inherit; cursor: pointer; }
.dms-pv-hit:disabled { cursor: default; }
.dms-pv-hit:focus-visible, .dms-cat:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dms-pv > :not(.dms-pv-hit) { position: relative; pointer-events: none; }
.dms-pv .dms-chip, .dms-pv .dms-pv-side button, .dms-pv .dms-link { pointer-events: auto; }
.dms-pv-side { display: flex; align-items: center; gap: 10px; }
/* 说明只占一行，放不下时省略（全文在整行按钮的 label 里，详情页也有）；「自定义模型 API」和等待登录链接行照常换行、不裁切。 */
.dms-pv .dms-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dms-pv-card .dms-meta, .dms-pv .dms-meta-wrap { white-space: normal; overflow: visible; }
.dms-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.dms-chip { font: inherit; font-size: 12px; line-height: 18px; padding: 0 7px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs);
  background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.dms-chip:enabled:hover { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.dms-chip:disabled { opacity: .45; cursor: default; }
.dms-states { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.dms-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
.dms-models { display: flex; flex-direction: column; gap: 2px; }
.dms-models > .dms-module { margin: 6px 0; }
/* 一行 = 点开编辑的主按钮 + 右边的删除按钮；悬停只改整行的底色。 */
.dms-mrow { display: grid; grid-template-columns: 24px minmax(0, 1fr) 28px; gap: 2px; align-items: center; padding: 0 8px 0 2px; border-radius: var(--dsw-radius-md); }
/* 拖动把手一直看得见，颜色比正文淡。拖动中的行变淡；落点画在两行之间的空隙里：一条直线，左端一个小箭头，
   不贴在圆角行的边上（贴边会跟着圆角弯）。样式照 DSH 0.2.2-rc.3 官方模型页 ModelsSection.module.css（MIT，见 NOTICE 和 README「第三方来源」），和工作区排序同一套。 */
.dms-handle { width: 24px; height: 28px; color: var(--dsw-alias-label-caption); cursor: grab; }
.dms-handle:active { cursor: grabbing; }
.dms-models-wrap { position: relative; }
.dms-mrow, .dms-models > .dms-module { position: relative; }
.dms [data-dragging="true"] { opacity: .5; }
.dms [data-drop] { z-index: 1; }
.dms [data-drop]::before { content: ""; position: absolute; left: 0; right: 0; height: 12px; background:
  linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,
  linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,
  linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat; }
/* 收起的行之间空 2px，线画在空隙正中；展开的行上下各多 6px 外边距。 */
.dms-mrow[data-drop="before"]::before { top: -7px; }
.dms-mrow[data-drop="after"]::before { bottom: -7px; }
.dms-module[data-drop="before"]::before { top: -10px; }
.dms-module[data-drop="after"]::before { bottom: -10px; }
/* 整行拖动预览的底色：WebKit 会把透明处填成白色，所以给一层和设置卡片一样的底。 */
.dms-drag-preview { background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-md); }
.dms-mtop { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 2px; align-items: center; margin-left: -10px; }
.dms-mrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dms-model { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 8px 4px 8px 6px; width: 100%;
  border: 0; border-radius: var(--dsw-radius-md); background: none; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.dms-idline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dms-mhead { display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%; border: 0; border-radius: var(--dsw-radius-sm); background: none;
  padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dms-iconbtn { flex: none; width: 28px; height: 28px; display: inline-grid; place-items: center; border: 0; border-radius: var(--dsw-radius-sm); background: none; padding: 0;
  color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dms-iconbtn:hover { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.dms-iconbtn:disabled { opacity: .4; cursor: default; }
.dms-mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.dms-caps { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.dms-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.dms-lv { display: grid; grid-template-columns: minmax(96px, 140px) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.dms-disc { display: flex; gap: 6px; align-items: center; border: 0; background: none; padding: 16px 0 0; width: 100%; text-align: left; font: inherit;
  font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dms-disc .dms-meta { font-weight: 400; }
.dms-disc-ico { flex: none; color: var(--dsw-alias-label-tertiary); }
.dms-select { height: 32px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: inherit;
  font: inherit; font-size: 13px; padding: 0 8px; max-width: 100%; }
.dms-select-wide { width: 100%; max-width: 320px; }
.dms-select-full { width: 100%; max-width: 100%; text-overflow: ellipsis; }
.dms-input { height: 32px; width: 100%; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 0 12px; }
.dms-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dms-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dms-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dms-input:disabled { opacity: .6; }
.dms-input.dms-mono { font-size: 12px; }
/* 输入框的底色和边框照官方模型页（ModelsSection.module.css 的 .input：layer-1 加 l4 边框）；设置面板本身是 layer-2，输入框用 layer-2 会看不见。
   密钥框：输入框和右边的眼睛、「清除」「撤销」在同一个框里。已保存时占位文字是打码预览，用正文颜色。 */
.dms-keyhead { justify-content: space-between; }
.dms-keybox { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 12px; border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.dms-keybox:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.dms-keybox.dms-keybad { border-color: var(--dsw-alias-state-error-primary); }
.dms-keybox.dms-keyoff { opacity: .7; }
.dms-keyinput { flex: 1; min-width: 0; height: 100%; border: 0; background: none; padding: 0; outline: none; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; }
.dms-keyinput::placeholder { color: var(--dsw-alias-label-dimmed); }
.dms-keysaved .dms-keyinput::placeholder { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
.dms-keyeye { width: 24px; height: 24px; }
.dms-keyact { flex: none; padding: 0 6px; }
/* 自定义设置和重试策略。 */
.dms-fold { display: flex; flex-direction: column; gap: 12px; padding-left: 20px; }
.dms-sub { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
.dms-sub > .dms-field > .dms-input { max-width: 200px; }
.dms-codes { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.dms-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.dms-disc.dms-disc-sub { padding-top: 0; font-size: 13px; }
/* 选择模型的对话框：DSH 的 Modal 默认只有 380 像素宽，这里要放下一行 ID、标签和按钮。内容挂在 body 下，不在 .dms 里面，所以类名都不靠 .dms。 */
.dms-pdlg.dms-pdlg { width: min(640px, 100%); max-height: 100%; }
.dms-pbody, .dms-pbody * { box-sizing: border-box; }
.dms-pbody { display: flex; flex-direction: column; gap: 12px; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dms-pbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.dms-plist { list-style: none; margin: 0 -8px; padding: 0 8px; display: flex; flex-direction: column; gap: 2px; max-height: min(46vh, 380px); overflow-y: auto; }
.dms-prow { display: grid; grid-template-columns: minmax(0, 1fr) auto 28px; gap: 10px; align-items: center; padding: 6px 8px; border-radius: var(--dsw-radius-md); }
.dms-prow[data-added="true"] { background: var(--dsw-alias-bg-module-platform); }
.dms-prow .dms-iconbtn { color: var(--dsw-alias-label-secondary); }
@media (max-width: 600px) {
  .dms-prow { grid-template-columns: minmax(0, 1fr) 28px; gap: 4px 10px; }
  .dms-prow .dms-caps { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
}
.dms-banner { background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-lg); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.dms-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dms-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* 按这一页实际能用的宽度换排法：rc.5 的设置对话框在窄窗口里仍保留左栏，内容区可能只有一两百像素。 */
@container (max-width: 460px) {
  .dms-pick { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  /* 窄时分类排成一行，照 DSH 设置页自己的窄导航条：放不下的露出半个、横向滑动，不显示滚动条。 */
  .dms-cats { flex-direction: row; max-height: none; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
  .dms-cats::-webkit-scrollbar { display: none; }
  .dms-cat { width: auto; padding: 7px 10px; }
  .dms-model { grid-template-columns: minmax(0, 1fr) auto; }
  .dms-model .dms-caps { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
  .dms-lv { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .dms-lv > :last-child { grid-column: 1 / -1; justify-self: start; }
  .dms-pv .dms-chev { display: none; }
}
`

/**
 * 把样式挂到页面上，插件卸载时摘掉。
 * @param {object} ctx 客户端上下文。
 */
function mountModelSettingsStyle(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-workbench-model-settings'
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-model-settings: styles')
}

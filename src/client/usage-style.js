/**
 * 用量主页的样式。字号只用 28、14、13、12。颜色全走 DSH 的主题变量，明暗主题都对；
 * 蓝色表示多少，黄色和橙色表示反常，构成条只有第一段上色（规则见 DESIGN.md）。
 * 页面宽度跟内容区走，所以断点用容器查询，不看窗口宽度。
 */
export const USAGE_CSS = `
.dwb-us-page{
  --dwb-us-t1:var(--dsw-alias-label-primary);--dwb-us-t2:var(--dsw-alias-label-secondary);--dwb-us-t3:var(--dsw-alias-label-tertiary);--dwb-us-cap:var(--dsw-alias-label-caption);
  --dwb-us-b1:var(--dsw-alias-border-l1);--dwb-us-b2:var(--dsw-alias-border-l2);
  --dwb-us-accent:#3987e5;--dwb-us-warn:var(--dsw-alias-state-warn-primary);--dwb-us-serious:var(--dsw-alias-state-error-primary);--dwb-us-retry:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);
  --dwb-us-g1:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent);--dwb-us-g2:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);--dwb-us-g3:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);--dwb-us-g4:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);--dwb-us-g5:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--dwb-us-g6:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);
  --dwb-us-bar:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);--dwb-us-last:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent);--dwb-us-track:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);--dwb-us-empty:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);
  --dwb-us-h0:color-mix(in srgb,var(--dwb-us-accent) 28%,transparent);--dwb-us-h1:color-mix(in srgb,var(--dwb-us-accent) 46%,transparent);--dwb-us-h2:color-mix(in srgb,var(--dwb-us-accent) 64%,transparent);--dwb-us-h3:color-mix(in srgb,var(--dwb-us-accent) 82%,transparent);--dwb-us-h4:var(--dwb-us-accent);
  --dwb-us-mono:ui-monospace,"SF Mono",Menlo,monospace;
  height:100%;min-height:0;overflow:auto;box-sizing:border-box;container:dwb-usage/inline-size;font-size:13px;line-height:20px;color:var(--dwb-us-t2);font-variant-numeric:tabular-nums;
}
.dwb-us-page *{box-sizing:border-box;min-width:0}
.dwb-us-glance{--dwb-us-t1:var(--dsw-alias-label-primary);--dwb-us-t2:var(--dsw-alias-label-secondary);--dwb-us-t3:var(--dsw-alias-label-tertiary);--dwb-us-warn:var(--dsw-alias-state-warn-primary);--dwb-us-serious:var(--dsw-alias-state-error-primary);position:relative;flex:1 1 100%;min-width:0;font-size:14px;line-height:22px;color:var(--dwb-us-t1);font-variant-numeric:tabular-nums}
.dwb-us-glance-main{all:unset;box-sizing:border-box;display:block;width:100%;min-height:36px;padding:7px 42px 7px calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));border-inline:var(--dsh-sidebar-paint-inset) solid transparent;background-clip:padding-box;border-radius:var(--dsw-radius-md);cursor:pointer}
.dwb-us-glance-main[aria-current=page]{background-color:var(--dsw-alias-interactive-bg-hover)}
.dwb-us-glance-main:focus-visible,.dwb-us-glance-toggle:focus-visible,.dwb-us-glance-rail:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dwb-us-glance-head{display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap);min-width:0}
.dwb-us-glance-head svg{width:16px;height:16px;flex:0 0 auto}
.dwb-us-glance-head span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-us-glance-head b{font-weight:500;white-space:nowrap}
.dwb-us-glance-head .dwb-us-dot{margin-right:0}
.dwb-us-glance-toggle{all:unset;position:absolute;top:4px;right:calc(var(--dsh-sidebar-paint-inset) + 4px);display:grid;place-items:center;width:28px;height:28px;border-radius:var(--dsw-radius-sm,8px);color:var(--dwb-us-t2);cursor:pointer}
.dwb-us-glance-toggle svg{width:16px;height:16px}
.dwb-us-glance-toggle:hover{background-color:var(--dsw-alias-interactive-bg-hover)}
.dwb-us-glance-body{display:grid;gap:1px;margin-top:6px;padding-left:22px;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-glance-body[data-reveal]{animation:dwb-us-glance-reveal 0s linear .12s backwards}
@keyframes dwb-us-glance-reveal{from{height:0;margin-top:0;overflow:hidden;visibility:hidden}}
.dwb-us-glance-row{display:flex;justify-content:space-between;gap:8px}
.dwb-us-glance-row b{font-weight:400;color:var(--dwb-us-t2);white-space:nowrap}
.dwb-us-glance-row[data-tone=warn]{color:var(--dwb-us-t1)}
.dwb-us-glance-row b[data-tone=warn]{color:var(--dwb-us-warn)}
.dwb-us-glance-row[data-gap]{margin-top:5px}
.dwb-us-glance-rail{all:unset;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);cursor:pointer}
.dwb-us-glance-rail svg{width:18px;height:18px}
.dwb-us-glance-rail[aria-current=page]{background-color:var(--dsw-alias-interactive-bg-hover)}
@media (hover:hover){.dwb-us-glance-main:hover,.dwb-us-glance-rail:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.dwb-us-page p{margin:0}
.dwb-us-pg{max-width:1280px;margin:0 auto;padding:14px 20px calc(26px + var(--dsh-frame-leading-clearance,0px));display:grid;gap:14px}
.dwb-us-top{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap}
.dwb-us-top h4{margin:0 6px 0 0;font-size:14px;font-weight:600;color:var(--dwb-us-t1)}
.dwb-us-grow{flex:1 1 0}
.dwb-us-verdict{all:unset;cursor:pointer;font-size:12px;line-height:18px;color:var(--dwb-us-t3);white-space:nowrap}
.dwb-us-verdict b{font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-verdict:focus-visible{outline:2px solid var(--dwb-us-accent);outline-offset:2px;border-radius:4px}
.dwb-us-refresh{all:unset;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 6px;border-radius:8px;font-size:12px;color:var(--dwb-us-t3);cursor:pointer}
.dwb-us-refresh svg{width:14px;height:14px;flex:0 0 auto}
.dwb-us-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwb-us-refresh:focus-visible{outline:2px solid var(--dwb-us-accent);outline-offset:1px}
.dwb-us-refresh[disabled]{opacity:.6;cursor:default}
.dwb-us-seg{width:fit-content;flex:0 0 auto}
.dwb-us-seg[role=tablist]{display:inline-grid}
.dwb-us-seg-none>[aria-hidden]{visibility:hidden}
.dwb-us-page .dwb-us-seg-narrow[role=tablist]{display:none}
.dwb-us-page .dwb-us-seg[role=tablist] [role=tab]{height:22px;padding:0 8px;font-size:12px;line-height:18px;white-space:nowrap}
.dwb-us-state{display:grid;gap:8px;justify-items:center;padding:64px 16px;text-align:center;color:var(--dwb-us-t3)}
.dwb-us-state b{font-size:14px;font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-cols{display:grid;grid-template-columns:228px minmax(0,1fr);gap:24px;align-items:start}
.dwb-us-main{display:grid;gap:24px}
.dwb-us-sec{display:grid;gap:8px}
.dwb-us-sh{display:flex;align-items:baseline;gap:4px 10px;flex-wrap:wrap}
.dwb-us-sh h5{margin:0;font-size:14px;font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-sh h5 span{font-weight:400;color:var(--dwb-us-cap)}
.dwb-us-sh>:last-child:not(h5):not(.dwb-us-cap){margin-left:auto;align-self:center}
.dwb-us-sh.dwb-us-sh-inline{align-items:center}
.dwb-us-sh.dwb-us-sh-inline>:last-child:not(h5){margin-left:0}
.dwb-us-cap{font-size:12px;line-height:18px;color:var(--dwb-us-cap)}
.dwb-us-tr{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwb-us-n{text-align:right;white-space:nowrap}
.dwb-us-mono,.dwb-us-page code{font-family:var(--dwb-us-mono);font-size:12px}
.dwb-us-sw{display:inline-block;flex:0 0 auto;width:8px;height:8px;border-radius:2px;margin-right:5px}
.dwb-us-stack{display:flex;gap:1.5px;height:6px;border-radius:3px;overflow:hidden}
.dwb-us-stack i{display:block;min-width:2px}
.dwb-us-stack-empty{background:var(--dwb-us-track)}
.dwb-us-dot{display:inline-block;flex:0 0 auto;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}

.dwb-us-side{display:grid;gap:10px}
.dwb-us-head{display:grid;gap:10px}
.dwb-us-hero{font-size:28px;line-height:34px;font-weight:600;color:var(--dwb-us-t1);letter-spacing:-.01em}
.dwb-us-hero span{font-size:13px;font-weight:400;color:var(--dwb-us-t3);letter-spacing:0}
.dwb-us-legend{display:flex;flex-wrap:wrap;gap:0 10px;font-size:12px;line-height:18px;color:var(--dwb-us-t3);margin-top:-4px}
.dwb-us-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 8px;padding-block:2px}
.dwb-us-grid3 b{display:block;font-weight:500;color:var(--dwb-us-t1);font-size:13px;line-height:18px}
.dwb-us-grid3 span{display:block;font-size:12px;line-height:16px;color:var(--dwb-us-cap)}
.dwb-us-side section{display:grid;gap:2px;border-top:.5px solid var(--dwb-us-b1);padding-top:9px}
.dwb-us-side h5{margin:0 0 3px;font-size:13px;font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-side h5 span{font-weight:400;color:var(--dwb-us-cap)}
.dwb-us-side section .dwb-us-stack{margin-bottom:3px}
.dwb-us-kv{display:flex;align-items:center;min-height:20px;font-size:12px;color:var(--dwb-us-t3);gap:6px}
.dwb-us-kv>span:first-child,.dwb-us-kv .dwb-us-tr{flex:1 1 auto}
.dwb-us-kv b{font-weight:400;color:var(--dwb-us-t2);white-space:nowrap}
.dwb-us-qh{font-size:12px;color:var(--dwb-us-t3);margin-top:4px}
.dwb-us-q{display:grid;grid-template-columns:38px minmax(0,1fr) 30px 72px;gap:6px;align-items:center;font-size:12px;line-height:18px;color:var(--dwb-us-cap)}
.dwb-us-qb{display:block;height:4px;border-radius:2px;background:var(--dwb-us-track);overflow:hidden}
.dwb-us-qb i{display:block;height:100%}
.dwb-us-qv{text-align:right;color:var(--dwb-us-t2)}
.dwb-us-qv.hi{color:var(--dwb-us-t1);font-weight:500}
.dwb-us-tg{display:grid;grid-template-columns:minmax(0,1fr) 30px 28px 42px;gap:6px;font-size:12px;line-height:19px;color:var(--dwb-us-t3);text-align:right}
.dwb-us-tg>:first-child{text-align:left}
.dwb-us-tg b{font-weight:400;color:var(--dwb-us-t2)}
.dwb-us-tg.th{color:var(--dwb-us-cap)}

.dwb-us-chart{container:dwb-us-chart/inline-size}
.dwb-us-chartbody{display:grid;gap:8px}
.dwb-us-ctl{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap}
.dwb-us-page .dwb-us-chart-toggle{height:26px;flex:0 0 auto}
.dwb-us-page .dwb-us-chart-toggle[aria-pressed=true]{background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}
.dwb-us-hscroll{overflow-x:auto;padding-bottom:6px;container-type:inline-size;scrollbar-width:thin;scroll-padding-left:40px}
.dwb-us-hgrid{display:inline-grid;gap:2px;align-items:stretch;vertical-align:top}
.dwb-us-axbg{position:sticky;left:0;z-index:1;background:var(--dsw-alias-bg-base)}
.dwb-us-rule{width:1px;justify-self:center;background:var(--dwb-us-b2)}
.dwb-us-yl{position:sticky;left:0;z-index:2;align-self:start;font-size:12px;line-height:14px;color:var(--dwb-us-cap);white-space:nowrap}
.dwb-us-month{align-self:center}
.dwb-us-month b{display:inline-block;position:sticky;left:40px;font-weight:400;font-size:12px;line-height:16px;color:var(--dwb-us-t2);white-space:nowrap}
.dwb-us-month.end{display:flex;justify-content:flex-end}
.dwb-us-month.end b{position:static}
.dwb-us-dn{font-size:12px;line-height:16px;color:var(--dwb-us-cap);text-align:center;white-space:nowrap}
.dwb-us-dn.today{color:var(--dwb-us-t1)}
.dwb-us-cell{all:unset;display:block;box-sizing:border-box;border-radius:2px;background:var(--dwb-us-empty);cursor:pointer}
.dwb-us-cell.dwb-us-l0{background:var(--dwb-us-h0)}.dwb-us-cell.dwb-us-l1{background:var(--dwb-us-h1)}.dwb-us-cell.dwb-us-l2{background:var(--dwb-us-h2)}.dwb-us-cell.dwb-us-l3{background:var(--dwb-us-h3)}.dwb-us-cell.dwb-us-l4{background:var(--dwb-us-h4)}
.dwb-us-cell.now{box-shadow:inset 0 0 0 1px var(--dwb-us-last)}
.dwb-us-cell.sel{box-shadow:inset 0 0 0 1.5px var(--dwb-us-t1)}
.dwb-us-cell:focus-visible{box-shadow:inset 0 0 0 2px var(--dwb-us-t1)}
.dwb-us-hfoot{display:flex;justify-content:flex-end;gap:4px 12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dwb-us-cap);min-height:18px}
.dwb-us-hl i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-left:2px;vertical-align:-1px}
.dwb-us-hl i:last-of-type{margin-right:3px}
.dwb-us-facts{display:grid;gap:4px;border-top:.5px solid var(--dwb-us-b1);padding-top:8px}
.dwb-us-factlabel{font-size:12px;line-height:16px;font-weight:500;color:var(--dwb-us-t2)}
.dwb-us-hstats{display:grid;grid-template-columns:repeat(6,minmax(max-content,1fr));gap:6px 14px}
.dwb-us-hstats span{display:block;font-size:12px;line-height:16px;color:var(--dwb-us-cap);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwb-us-hstats b{display:block;font-weight:500;color:var(--dwb-us-t1);font-size:13px;line-height:18px;white-space:nowrap}
.dwb-us-hstats b i{font-style:normal;white-space:nowrap}
.dwb-us-hstats[data-fit="3"]{grid-template-columns:repeat(3,minmax(max-content,1fr))}
.dwb-us-hstats[data-fit="4"]{grid-template-columns:repeat(4,minmax(max-content,1fr))}
.dwb-us-rchart{display:grid;grid-template-columns:38px minmax(0,1fr);column-gap:2px;padding-top:8px}
.dwb-us-ry,.dwb-us-rplot{position:relative;height:150px}
.dwb-us-ry span{position:absolute;left:0;transform:translateY(-50%);font-size:12px;line-height:16px;color:var(--dwb-us-cap);white-space:nowrap}
.dwb-us-gl{position:absolute;left:0;right:0;height:0;border-top:.5px solid var(--dwb-us-b1)}
.dwb-us-gl.base{border-top-color:var(--dwb-us-b2)}
.dwb-us-ds{position:absolute;top:0;bottom:0;width:0;border-left:.5px solid var(--dwb-us-b2)}
.dwb-us-rlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.dwb-us-rlay path{fill:none;vector-effect:non-scaling-stroke}
.dwb-us-rlay .band{fill:var(--dwb-us-g6);stroke:none}
.dwb-us-rlay .med{stroke:var(--dwb-us-g1);stroke-width:1;stroke-dasharray:3 2}
.dwb-us-rlay .cum{stroke-width:2;stroke-linejoin:round}
.dwb-us-rdot{position:absolute;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;pointer-events:none}
.dwb-us-rbars{position:absolute;inset:0;display:grid;grid-template-columns:repeat(var(--n),1fr);column-gap:var(--g);align-items:end}
.dwb-us-rcol{all:unset;box-sizing:border-box;display:flex;align-items:flex-end;height:100%;cursor:pointer}
.dwb-us-rcol[disabled]{cursor:default}
.dwb-us-rcol i{display:block;width:100%;border-radius:1px 1px 0 0;background:var(--dwb-us-bar)}
.dwb-us-rbars.blue .dwb-us-rcol i{background:var(--dwb-us-h3)}
.dwb-us-rcol.inbin i{background:var(--dwb-us-h4)}
.dwb-us-rbars .dwb-us-rcol.sel i{background:var(--dwb-us-t1)}
.dwb-us-rcol:focus-visible{outline:1px solid var(--dwb-us-t1)}
.dwb-us-rx{grid-column:2;position:relative;height:20px;overflow:hidden}
.dwb-us-rx span{position:absolute;top:3px;font-size:12px;line-height:16px;color:var(--dwb-us-cap);white-space:nowrap}
.dwb-us-rx span.date{color:var(--dwb-us-t2)}
@container (max-width:520px){.dwb-us-dn.minor{visibility:hidden}}
@container dwb-us-chart (max-width:680px){.dwb-us-hstats,.dwb-us-hstats[data-fit="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}.dwb-us-hstats[data-fit="4"]{grid-template-columns:repeat(2,minmax(0,1fr))}.dwb-us-hstats b{white-space:normal}}
@container dwb-us-chart (max-width:520px){.dwb-us-rbars{column-gap:0}.dwb-us-rx span.minor{display:none}}
@container dwb-us-chart (max-width:340px){.dwb-us-rx span.alt{display:none}}

.dwb-us-tb{display:grid}
.dwb-us-mr{display:grid;grid-template-columns:minmax(0,1fr) 62px 62px 42px minmax(112px,1.4fr);gap:0 8px;align-items:center;min-height:23px;border-top:.5px solid var(--dwb-us-b1);font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-mr .ml{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dwb-us-t3)}
.dwb-us-mr .bars{width:100%;height:18px;display:block}
.dwb-us-mh{min-height:20px;border-top:.5px solid var(--dwb-us-b2);color:var(--dwb-us-cap)}
.dwb-us-mh .ml{color:var(--dwb-us-cap)}
.dwb-us-mr.hot{padding:3px 0 5px}
.dwb-us-mr.hot .ml{color:var(--dwb-us-t1);font-weight:500;font-size:13px}
.dwb-us-mr.hot .dwb-us-n{color:var(--dwb-us-t1)}
.dwb-us-mr.hot .dwb-us-n.m{color:var(--dwb-us-t3)}
.dwb-us-mr.hot .dwb-us-n.z{font-weight:600}
.dwb-us-mr.dwb-us-t-strong .ml,.dwb-us-mr.dwb-us-t-strong .dwb-us-n:not(.m){color:var(--dwb-us-t1)}
.dwb-us-mr.dwb-us-t-mid .ml,.dwb-us-mr.dwb-us-t-mid .dwb-us-n:not(.m){color:var(--dwb-us-t2)}
.dwb-us-mr.dwb-us-t-low .ml{color:var(--dwb-us-t2)}
.dwb-us-mr p{grid-column:1/-1;color:var(--dwb-us-t3);padding-left:13px}
.dwb-us-lever{border-top:.5px solid var(--dwb-us-b2);padding:6px 0 2px;font-size:12px;line-height:18px;color:var(--dwb-us-t2);display:flex;align-items:baseline}
.dwb-us-lever b{font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-lg{display:flex;flex-wrap:wrap;gap:0 9px;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-lg i{display:inline-block;margin-right:4px;vertical-align:3px}
.dwb-us-lg .ln{width:12px;height:2px}
.dwb-us-lg .dash{background:repeating-linear-gradient(90deg,var(--dwb-us-g1) 0 3px,transparent 3px 5px)}
.dwb-us-lg .ar{width:12px;height:8px;background:var(--dwb-us-g6);vertical-align:0}
.dwb-us-lg .bar{width:6px;height:10px;border-radius:1px 1px 0 0;background:var(--dwb-us-bar);vertical-align:-1px}

.dwb-us-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.dwb-us-card{border:.5px solid var(--dwb-us-b2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;display:grid;gap:4px}
.dwb-us-card[role=button]{cursor:pointer}
.dwb-us-card[role=button]:hover{background:linear-gradient(var(--dsw-alias-interactive-bg-hover),var(--dsw-alias-interactive-bg-hover)),var(--dsw-alias-bg-layer-1)}
.dwb-us-card:focus-visible{outline:2px solid var(--dwb-us-accent);outline-offset:1px}
.dwb-us-ct{display:flex;justify-content:space-between;gap:8px}
.dwb-us-ct b{font-weight:500;color:var(--dwb-us-t1);flex:1 1 auto}
.dwb-us-ct strong{font-weight:600;color:var(--dwb-us-t1);flex:0 0 auto}
.dwb-us-cs{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:18px;color:var(--dwb-us-cap)}
.dwb-us-cs>span:last-child{flex:0 0 auto}
.dwb-us-cm{display:flex;flex-wrap:wrap;gap:0 8px;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-card svg{width:100%;height:18px;display:block}

.dwb-us-lg2{display:flex;flex-wrap:wrap;gap:0 9px;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-k{display:inline-block;width:8px;height:8px;border-radius:1.5px;margin-right:4px}
.dwb-us-ok{background:var(--dwb-us-g3)}.dwb-us-warn{background:var(--dwb-us-retry)}.dwb-us-bad{background:var(--dwb-us-serious)}.dwb-us-off{background:var(--dwb-us-empty)}
.dwb-us-pr{display:grid;grid-template-columns:112px minmax(0,1fr) auto;gap:2px 12px;align-items:center;border-top:.5px solid var(--dwb-us-b1);padding:5px 0}
.dwb-us-pn b{display:block;font-weight:500;color:var(--dwb-us-t1);line-height:18px}
.dwb-us-pn span{display:block;font-size:12px;line-height:16px;color:var(--dwb-us-cap)}
.dwb-us-ticks{display:flex;gap:2px;height:20px}
.dwb-us-ticks i{flex:1 1 0;border-radius:1.5px}
.dwb-us-ps{display:flex;gap:12px;font-size:12px;line-height:18px;color:var(--dwb-us-cap);white-space:nowrap}
.dwb-us-ps b{font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-pd{grid-column:1/-1;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-pd code{color:var(--dwb-us-t2)}

.dwb-us-pans{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px}
.dwb-us-pan{display:grid;gap:2px;align-content:start}
.dwb-us-pan h6{margin:0 0 3px;font-size:13px;line-height:20px;font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-pan h6 span{font-weight:400;font-size:12px;color:var(--dwb-us-cap);margin-left:8px}
.dwb-us-pan h6 b{font-weight:500}
.dwb-us-pan .dwb-us-stack{margin-bottom:3px}
.dwb-us-pan .dwb-us-cap{margin-top:3px}
.dwb-us-rw{display:flex;align-items:center;gap:6px;min-height:19px;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-rw .dwb-us-tr{flex:1 1 auto}
.dwb-us-rw .dwb-us-n{flex:0 0 auto;min-width:46px}
.dwb-us-rw.lead{color:var(--dwb-us-t1)}
.dwb-us-div{height:.5px;background:var(--dwb-us-b1);margin:3px 0}
.dwb-us-gb{display:grid;grid-template-columns:72px minmax(0,1fr) 32px 48px;gap:6px;align-items:center;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-gt{display:block;height:6px;border-radius:3px;background:var(--dwb-us-empty);overflow:hidden}
.dwb-us-gt i{display:block;height:100%}

.dwb-us-scroll{overflow-x:auto}
.dwb-us-tbl{width:100%;border-collapse:collapse;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-tbl th{font-weight:400;color:var(--dwb-us-cap);text-align:right;padding:0 0 2px 12px;white-space:nowrap}
.dwb-us-tbl td{text-align:right;padding:2px 0 2px 12px;border-top:.5px solid var(--dwb-us-b1);white-space:nowrap}
.dwb-us-tbl .tl{text-align:left;padding-left:0}
.dwb-us-tbl .hi{color:var(--dwb-us-t1)}

.dwb-us-months{border-left:1px solid var(--dwb-us-b2);padding-left:14px;display:grid;gap:14px}
.dwb-us-mo{display:grid;gap:2px}
.dwb-us-mh2{display:flex;justify-content:space-between;gap:2px 12px;flex-wrap:wrap;align-items:baseline}
.dwb-us-mh2 b{font-weight:500;color:var(--dwb-us-t1)}
.dwb-us-mw{display:grid;grid-template-columns:180px minmax(0,1fr) 54px 84px;gap:8px;align-items:center;font-size:12px;line-height:18px;color:var(--dwb-us-t3)}
.dwb-us-mb{display:block;height:6px}
.dwb-us-mb i{display:block;height:100%;background:var(--dwb-us-g2);border-radius:2px}
.dwb-us-mev{display:flex;flex-wrap:wrap;gap:0 12px;font-size:12px;line-height:18px;color:var(--dwb-us-cap)}

@container dwb-usage (max-width:860px){
  .dwb-us-cols{grid-template-columns:minmax(0,1fr);gap:20px}
  .dwb-us-side{display:contents}
  .dwb-us-head{order:0}
  .dwb-us-page .dwb-us-seg-narrow[role=tablist]{display:inline-grid}
  .dwb-us-page .dwb-us-seg-wide[role=tablist]{display:none}
  .dwb-us-main{order:1}
  .dwb-us-side section{order:2}
}
@container dwb-usage (max-width:640px){
  .dwb-us-pg{padding:12px 12px calc(20px + var(--dsh-frame-leading-clearance,0px))}
  .dwb-us-cards,.dwb-us-pans{grid-template-columns:minmax(0,1fr)}
  .dwb-us-mr{grid-template-columns:minmax(0,1fr) 58px 58px 40px}
  .dwb-us-mr .bars,.dwb-us-mr .sp{display:none}
  .dwb-us-pr{grid-template-columns:minmax(0,1fr)}
  .dwb-us-ps{white-space:normal;flex-wrap:wrap;gap:0 12px}
  .dwb-us-mw{grid-template-columns:minmax(0,1fr) 54px 84px}
  .dwb-us-mw .dwb-us-mb{display:none}
  .dwb-us-sh>:last-child:not(h5):not(.dwb-us-cap){margin-left:0}
  .dwb-us-grow{display:none}
}

.dwb-us-details{display:grid;gap:14px}
.dwb-us-detail-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dwb-us-detail-controls input{background:var(--dsw-alias-bg-layer-2);color:var(--dwb-us-t1);border:1px solid var(--dwb-us-b2);border-radius:var(--dsw-radius-sm);font:inherit;min-height:30px;padding:4px 8px;max-width:100%}
.dwb-us-tablewrap{overflow:auto;overscroll-behavior:contain}
.dwb-us-detail-table{width:100%;min-width:700px;border-collapse:collapse;font-size:13px;line-height:1.5}
.dwb-us-detail-table th,.dwb-us-detail-table td{padding:8px 10px;text-align:end;border-bottom:.5px solid var(--dwb-us-b1);white-space:nowrap}
.dwb-us-detail-table th:first-child,.dwb-us-detail-table td:first-child{text-align:start;white-space:normal;min-width:180px;max-width:280px;overflow-wrap:anywhere}
.dwb-us-detail-table th{font-size:12px;font-weight:400;color:var(--dwb-us-t3)}
.dwb-us-detail-table button,.dwb-us-detail-expanded header button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;min-height:24px}
.dwb-us-detail-table svg,.dwb-us-detail-expanded svg{width:14px;height:14px;flex:none}
.dwb-us-detail-table small{display:block;font-size:12px;color:var(--dwb-us-t3)}
.dwb-us-detail-table tr.hot td{color:var(--dwb-us-t1);padding-block:12px}
.dwb-us-detail-table .dwb-us-detail-alert{color:var(--dwb-us-t1)}
.dwb-us-detail-alert::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dwb-us-warn);margin-inline-end:5px}
.dwb-us-details th,.dwb-us-details small,.dwb-us-details .dwb-us-cap,.dwb-us-details input::placeholder{color:var(--dwb-us-t2)}
.dwb-us-views-scroll{overflow-x:auto;max-width:100%;overscroll-behavior-x:contain;padding-block:2px}
.dwb-us-detail-expanded{border-top:1px solid var(--dwb-us-b2);padding-top:14px;display:grid;gap:8px}
.dwb-us-detail-expanded header{display:flex;justify-content:space-between;align-items:center;gap:8px}.dwb-us-detail-expanded h5{font-size:14px;margin:0;font-weight:500}
.dwb-us-detail-expanded header button{width:28px;height:28px;justify-content:center;border-radius:var(--dsw-radius-sm)}
.dwb-us-details button:focus-visible,.dwb-us-details input:focus-visible,.dwb-us-tablewrap:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
@container dwb-usage (max-width:600px){.dwb-us-detail-controls input{font-size:16px;width:100%}}
`

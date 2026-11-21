/**
 * 客户端入口：读功能清单，按开着的行挂各功能的界面。插件页的行开关经 HMR 即时生效
 * （不用重启 DSH），所以清单变化时：少了哪一行就撤掉哪一行的界面（每个功能的挂载
 * 返回撤销函数），又出现就重新挂。重读清单的时机：页面加载、连接重置、窗口重新获得
 * 焦点（focus、visibilitychange）、插件管理的变更事件（plugin-manager/changed）。
 */

/** 客户端要用的 DSH 服务：共用的这几个，加上各功能自己要的（SPLIT_INJECT 等在各功能的模块里），去重。 */
const INJECT = [...new Set([
  'slots', 'locale', 'remote', 'sessions', 'uiSession',
  'remote.agentPresets', 'sidebarRightTabs',
  ...SPLIT_INJECT, ...RERUN_INJECT, ...PLAN_INJECT, ...PAGES_INJECT, ...FIND_INJECT, ...ORGANIZE_INJECT, ...CHECKPOINTS_INJECT, ...USAGE_INJECT, ...CONTEXT_INJECT, ...LREV_INJECT, ...REVIEW_PANEL_INJECT, ...DESIGN_INJECT, ...MCP_INJECT, ...RULES_INJECT, ...PALETTE_INJECT, ...NEW_TAB_INJECT, ...ATTENTION_INJECT, ...WORKTREES_INJECT, ...TURN_NAV_INJECT, ...SESSION_HEADER_INJECT, ...BROWSER_VIEWPORT_INJECT, ...WORKSPACE_FOLDERS_INJECT, ...SESSION_CARDS_INJECT, ...PRESET_SWITCH_INJECT,
])]

/** 各功能行的界面挂载（都返回撤销函数）。app 在 applyClient 里建好后再被调用。 */
const FEATURE_UI = {
  'new-tab': app => applyNewTab(app),
  'approval-rules': app => applyApprovalRules(app),
  mcp: app => applyMcp(app),
  design: app => applyDesign(app),
  'local-review': app => applyLocalReview(app),
  context: app => applyContext(app),
  compaction: app => applyCompactionSettings(app),
  worktrees: (app) => applyWorktrees(app),
  attention: (app) => applyAttention(app),
  'command-palette': (app) => applyCommandPalette(app),
  memory: (app) => applyMemory(app),
  tasks: (app) => applyTasks(app),
  notify: (app) => applyNotify(app),
  review: (app) => applyReview(app),
  split: (app) => applySplit(app),
  rerun: (app) => applyRerun(app),
  reply: (app) => applyReply(app),
  plan: (app) => applyPlan(app),
  pages: (app) => applyPages(app),
  find: (app) => applyFind(app),
  organize: (app) => applyOrganize(app),
  checkpoints: (app) => applyCheckpoints(app),
  usage: (app) => applyUsage(app),
  'turn-nav': (app) => applyTurnNav(app),
  'session-header': (app) => applySessionHeader(app),
  'browser-viewport': (app) => applyBrowserViewport(app),
  'workspace-trust': (app) => applyWorkspaceTrust(app),
  'settings-icons': (app) => applySettingsIcons(app),
  'workspace-folders': (app) => applyWorkspaceFolderSettings(app),
  'session-cards': (app) => applySessionCards(app),
  'preset-switch': (app) => applyPresetSwitch(app),
  'model-settings': (app) => applyModelSettings(app),
  'session-title': (app) => applySessionTitle(app),
}

/**
 * 客户端入口。
 * @param {object} ctx 客户端上下文。
 */
function applyClient(ctx) {
  ctx.effect(() => ctx.locale.register('@miint-sunny/dsh-workbench', {
    zh: { ...zh, ...SPLIT_ZH, ...RERUN_ZH, ...REPLY_ZH, ...PLAN_ZH, ...PAGES_ZH, ...FIND_ZH, ...ORGANIZE_ZH, ...CHECKPOINTS_ZH, ...USAGE_ZH, ...MEMORY_ZH, ...CONTEXT_ZH, ...LOCAL_REVIEW_ZH, ...REVIEW_PANEL_ZH, ...DESIGN_ZH, ...MCP_ZH, ...RULES_ZH, ...PALETTE_ZH, ...NEW_TAB_ZH, ...ATTENTION_ZH, ...WORKTREES_ZH, ...TURN_NAV_ZH, ...WORKSPACE_TRUST_ZH, ...SESSION_HEADER_ZH, ...BROWSER_VIEWPORT_ZH, ...WORKSPACE_FOLDERS_ZH, ...WORKSPACE_MOVE_ZH, ...SESSION_CARDS_ZH, ...PRESETSWITCH_ZH },
    en: { ...en, ...SPLIT_EN, ...RERUN_EN, ...REPLY_EN, ...PLAN_EN, ...PAGES_EN, ...FIND_EN, ...ORGANIZE_EN, ...CHECKPOINTS_EN, ...USAGE_EN, ...MEMORY_EN, ...CONTEXT_EN, ...LOCAL_REVIEW_EN, ...REVIEW_PANEL_EN, ...DESIGN_EN, ...MCP_EN, ...RULES_EN, ...PALETTE_EN, ...NEW_TAB_EN, ...ATTENTION_EN, ...WORKTREES_EN, ...TURN_NAV_EN, ...WORKSPACE_TRUST_EN, ...SESSION_HEADER_EN, ...BROWSER_VIEWPORT_EN, ...WORKSPACE_FOLDERS_EN, ...WORKSPACE_MOVE_EN, ...SESSION_CARDS_EN, ...PRESETSWITCH_EN },
  }), 'dsh-workbench: dictionaries')
  mountStyle(ctx)
  const store = createFeatureStore(ctx)
  const app = { ctx, store, t: ctx.locale.bind('@miint-sunny/dsh-workbench'), clock: ctx.locale.bind('chat') }
  const reload = () => { void store.load() }
  // 已挂的行：id → 撤销函数。清单少了就撤，撤了又出现就重挂（对齐逻辑见 features.js）。
  const mounted = new Map()
  let active = true
  const reconcile = () => {
    if (active) reconcileFeatures(mounted, id => store.has(id), FEATURE_UI, app)
  }
  ctx.effect(() => {
    const unsubscribe = store.subscribe(reconcile)
    return () => {
      active = false
      unsubscribe()
      const disposers = [...mounted.values()].reverse()
      mounted.clear()
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-workbench: feature lifecycle')
  ctx.effect(() => ctx.on('connection/reset', reload), 'dsh-workbench: refetch features on reconnect')
  ctx.effect(() => ctx.remote.$on('plugin-manager/changed', reload), 'dsh-workbench: refetch features on plugin changes')
  ctx.effect(() => {
    window.addEventListener('focus', reload)
    document.addEventListener('visibilitychange', reload)
    return () => {
      window.removeEventListener('focus', reload)
      document.removeEventListener('visibilitychange', reload)
    }
  }, 'dsh-workbench: refetch features on window focus')
  void store.load()
}

/**
 * 模型设置页的注册：用 `settings.section` 的 id `models`、priority -1 盖住 DSH 内置的模型页。这一行关掉或页面出错时，内置页自动回来。
 * 工作台的功能清单里有 model-settings 时由 applyModelSettings 挂上，入口 applyModelSettingsClient 是原来独立插件的入口，跑在子 fiber 里。
 */

const NS = 'dshModelSettings'

/** 模型设置页要用的 DSH 服务：设置页的槽位、语言、远程接口、设置镜像和 schema。只给这一行的子 fiber，不进工作台共用的 INJECT。DeepSeek 账号的登录另在 applyModelSettingsClient 里按需接（账号功能可以不在）。 */
const MODEL_SETTINGS_INJECT = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'remote.session', 'configForms', 'settingsSchema']

/** 登录用的官方服务：账号的远程接口、账号插件给的账号状态、深浅色。都在时才列出 DeepSeek 账号的「登录」。 */
const ACCOUNT_INJECT = ['remote.account', 'accountUi', 'theme']

/**
 * 填写页：按 family 从当前目录找这一家（已添加的标记跟着目录变）。目录里已经没有这一家时只写明、给返回。
 */
function FillRoute({ app, snapshot, family, route, go }) {
  const candidates = pickerEntries(catalogRows(snapshot)).filter(candidate => candidate.kind === 'catalog' || candidate.kind === 'other')
  const entry = candidates.find(candidate => candidate.family.id === family && candidate.variants.some(variant => variant.route === route))
    ?? candidates.find(candidate => candidate.family.id === family)
  if (entry === undefined) {
    return h(Fragment, null,
      h(Crumb, { label: app.t('back'), onClick: () => go({ page: 'list' }) }),
      h('p', { className: 'dms-note' }, app.t('gone')))
  }
  return h(FillStep, { key: `${family}/${route}`, app, snapshot, entry, route, go })
}

/** 这一页的路由：模型页（list）、填写页（fill）、自定义模型 API（custom）、某一条线路的详情（detail）。每次打开设置都从模型页开始。 */
function ModelsPage({ app }) {
  useLocaleRevision(app)
  const snapshot = useSnapshot(app)
  const [route, setRoute] = useState({ page: 'list' })
  const [saved, setSaved] = useState(undefined)
  const rootRef = useRef(null)
  useEffect(() => { if (snapshot.status === 'idle') void app.store.load() }, [snapshot.status])
  useEffect(() => {
    if (saved === undefined) return undefined
    const timer = setTimeout(() => setSaved(undefined), 6000)
    return () => { clearTimeout(timer) }
  }, [saved])
  const go = (next) => {
    setSaved(next.saved)
    setRoute(next)
  }
  // 填写页要等目录读完才知道这一家有哪些线路；读的时候先显示模型页。
  const shown = route.page === 'detail' || (route.page !== 'list' && snapshot.status === 'ready') ? route.page : 'list'
  useEffect(() => {
    for (let node = rootRef.current?.parentElement; node != null; node = node.parentElement) {
      if (node.getAttribute?.('role') === 'dialog') break
      if (node.scrollTop > 0) node.scrollTop = 0
    }
  }, [shown, route.provider, route.family, route.route, route.preset])
  const page = shown === 'detail' ? h(DetailPage, { app, snapshot, provider: route.provider, go, saved })
    : shown === 'fill' ? h(FillRoute, { app, snapshot, family: route.family, route: route.route, go })
      : shown === 'custom' ? h(CustomStep, { key: route.preset ?? route.name ?? '', app, snapshot, initialName: route.name, preset: PRESETS.find(preset => preset.route === route.preset), go })
        : h(ListPage, { app, snapshot, go, saved, notice: route.notice })
  // 模型页占满设置的内容区，只有右边的提供商列表滚动；别的页面照常整页滚动。
  return h('div', { ref: rootRef, className: shown === 'list' ? 'dms dms-fill' : 'dms' }, page)
}

/**
 * 模型设置页的入口（原来独立插件的入口）：词典、样式、数据、推送刷新、账号登录、导航去重和设置页注册，都登记在 ctx 上。
 * @param {object} ctx 子 fiber 的客户端上下文，已注入 MODEL_SETTINGS_INJECT。
 */
function applyModelSettingsClient(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh: MODEL_SETTINGS_ZH, en: MODEL_SETTINGS_EN }), 'dsh-model-settings: dictionaries')
  mountModelSettingsStyle(ctx)
  const t = ctx.locale.bind(NS)
  const store = createModelsStore(ctx)
  const account = createAccountLink({
    desktop: () => 'dshDesktop' in globalThis,
    streamBaseUrl: () => globalThis.__DSH_TRANSPORT__?.streamBaseUrl,
    origin: () => window.location.origin,
    open: () => window.open('about:blank', '_blank'),
    writeText: text => navigator.clipboard.writeText(text),
  })
  // memory：同一次打开 DSH 里记住模型页上次选的分类。
  const app = { ctx, store, ops: store.operations, schema: store.schema, t, memory: {}, account }
  // 别处改了设置、凭据或提供商时自动刷新，不轮询。
  ctx.effect(() => {
    const refresh = () => { store.refreshIfLoaded() }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('credentials/record-updated', refresh),
      ctx.remote.$on('credentials/reference-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-model-settings: pushed invalidations')
  // DeepSeek 账号：账号插件和它的远程接口都在时才接上；登录、退出后刷新一次，账号的模型目录跟着变。
  ctx.inject(ACCOUNT_INJECT, (inner) => {
    const viewOf = state => (state.failed ? undefined : state.view)
    account.bind({
      remote: inner.remote.account,
      view: () => viewOf(inner.accountUi.getSnapshot()),
      metadata: () => inner.accountUi.clientMetadata(ctx.locale.getSnapshot().active),
      colorScheme: () => inner.theme.getTheme().active.colorScheme,
    })
    inner.on('account-ui/change', (state, reset) => {
      account.changed(viewOf(state))
      if (reset) store.refreshIfLoaded()
    })
    inner.effect(() => () => { account.unbind() }, 'dsh-model-settings: account sign-in')
  })
  hideDuplicateNav(ctx, () => t('nav'))
  const Section = () => h(ModelsPage, { app })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'models', order: 10, priority: -1, label: () => t('nav'),
  }, Section))
}

/**
 * 「模型设置」这一行的网页端挂载：在子 fiber 里注入 MODEL_SETTINGS_INJECT，再跑 applyModelSettingsClient。
 * 撤销时 dispose 子 fiber，入口登记的 effect、监听、设置页、样式和导航去重随它一起撤；这些服务缺了或 DSH 改了，只影响这一行。
 * @param {{ ctx: object }} app 工作台网页端的入口上下文。
 * @returns {() => void} 撤销函数。
 */
function applyModelSettings(app) {
  const fiber = app.ctx.inject(MODEL_SETTINGS_INJECT, inner => applyModelSettingsClient(inner))
  return () => { fiber.dispose() }
}

/** 提供商的产品名、地区和套餐、分类、图标颜色，模型页右栏的条目和搜索。路由标识符来自 DSH 0.2.1-rc.5 的 pi-ai 目录；表里没有的路由显示原标识符。 */

/**
 * 火山方舟：不在 DSH 自带的目录里，三种都做成预先填好地址的自定义提供商（OpenAI Chat Completions），按 Agent Plan、Coding Plan、API 排。
 * 地址、获取 API 密钥的页面和模型名照方舟文档（2026-11-19 核对，docs/research/03-火山方舟.md）；两种套餐的地址没有模型列表接口，所以预先填 ark-code-latest。
 * route 是新建时建议的 Provider ID；已添加的按 API 地址认（presetMatching），不按 ID。
 */
export const PRESETS = [
  { label: 'Agent Plan', name: '火山方舟 Agent Plan', route: 'ark-agent-plan', baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3', api: 'openai-completions',
    models: ['ark-code-latest'], keyUrl: 'https://ark.volcengine.com/region:cn-beijing/subscription/agent-plan',
    keyNote: 'Agent Plan 使用专属 API 密钥，与火山方舟的其他 API 密钥不通用。' },
  { label: 'Coding Plan', name: '火山方舟 Coding Plan', route: 'ark-coding-plan', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', api: 'openai-completions',
    models: ['ark-code-latest'], keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey' },
  { label: 'API', name: '火山方舟', route: 'ark', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions',
    models: [], keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey' },
]

/**
 * 一家产品和它的各个变体。variant.tag 写在卡片名称后面；variant.label 是同一家几条线路并排时按钮上的字；keyUrl 是获取 API 密钥的控制台页面。
 * category：domestic 国内、intl 国际、aggregator 聚合平台、cloud 云服务。presets 是不在 DSH 目录里、做成自定义提供商的几种（PRESETS）。
 */
export const FAMILIES = [
  { id: 'google', name: 'Google Gemini', keywords: ['gemini', 'google', '谷歌'], category: 'intl', color: '#3f7ef3', initials: 'G',
    variants: [{ route: 'google', label: 'API 密钥', tag: 'API 密钥', domain: 'generativelanguage.googleapis.com', keyUrl: 'https://aistudio.google.com/apikey' }] },
  { id: 'openai', name: 'OpenAI', keywords: ['gpt', 'chatgpt', 'codex'], category: 'intl', color: '#202022', initials: 'AI', variantLabel: '登录方式',
    variants: [
      { route: 'openai', label: 'API 密钥', tag: 'API 密钥', domain: 'api.openai.com', keyUrl: 'https://platform.openai.com/api-keys' },
      { route: 'openai-codex', label: 'ChatGPT 账号登录', tag: 'ChatGPT 账号', domain: 'chatgpt.com' },
    ] },
  { id: 'anthropic', name: 'Anthropic', keywords: ['claude'], category: 'intl', color: '#c96a4a', initials: 'A',
    variants: [{ route: 'anthropic', domain: 'api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys' }] },
  { id: 'xiaomi', name: '小米 MiMo', keywords: ['xiaomi', 'mimo', '小米'], category: 'domestic', color: '#ff6a00', initials: 'Mi', variantLabel: '计费方式',
    variantNote: '按量计费和 Token Plan 使用不同的 API 密钥。',
    variants: [
      { route: 'xiaomi', label: '按量计费', tag: '按量计费', domain: 'api.xiaomimimo.com' },
      { route: 'xiaomi-token-plan-cn', label: 'Token Plan 国内', tag: 'Token Plan 国内', domain: 'token-plan-cn.xiaomimimo.com' },
      { route: 'xiaomi-token-plan-sgp', label: 'Token Plan 新加坡', tag: 'Token Plan 新加坡', domain: 'token-plan-sgp.xiaomimimo.com' },
      { route: 'xiaomi-token-plan-ams', label: 'Token Plan 阿姆斯特丹', tag: 'Token Plan 阿姆斯特丹', domain: 'token-plan-ams.xiaomimimo.com' },
    ] },
  { id: 'zhipu', name: '智谱 GLM Coding Plan', keywords: ['zhipu', 'glm', 'z.ai', 'zai', 'bigmodel', '智谱'], category: 'domestic', color: '#3859ff', initials: '智', variantLabel: '站点',
    variants: [
      { route: 'zai-coding-cn', label: '国内', tag: '国内', domain: 'open.bigmodel.cn', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
      { route: 'zai', label: '国际', tag: '国际', domain: 'api.z.ai' },
    ] },
  { id: 'kimi', name: 'Kimi', keywords: ['moonshot', 'kimi', '月之暗面'], category: 'domestic', color: '#16181d', initials: 'K', variantLabel: '站点',
    variants: [
      { route: 'moonshotai-cn', label: '国内', tag: '国内', domain: 'api.moonshot.cn', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
      { route: 'moonshotai', label: '国际', tag: '国际', domain: 'api.moonshot.ai' },
      { route: 'kimi-coding', label: 'Kimi Coding', tag: 'Kimi Coding', domain: 'api.kimi.com' },
    ] },
  { id: 'minimax', name: 'MiniMax', keywords: ['minimax', '稀宇'], category: 'domestic', color: '#d1475d', initials: 'M', variantLabel: '站点',
    variants: [
      { route: 'minimax-cn', label: '国内', tag: '国内', domain: 'api.minimaxi.com' },
      { route: 'minimax', label: '国际', tag: '国际', domain: 'api.minimax.io' },
    ] },
  { id: 'ark', name: '火山方舟', keywords: ['ark', 'volcengine', 'volces', '火山', '方舟', '豆包', 'doubao', 'coding plan', 'agent plan'], category: 'domestic', color: '#1664ff', initials: '方',
    variants: [], presets: PRESETS },
  { id: 'qwen', name: '通义千问 Token Plan', keywords: ['qwen', 'aliyun', 'dashscope', '通义', '阿里云', '百炼'], category: 'domestic', color: '#615ced', initials: '通', variantLabel: '站点',
    variants: [
      { route: 'qwen-token-plan-cn', label: '国内', tag: '国内', domain: 'token-plan.cn-beijing.maas.aliyuncs.com' },
      { route: 'qwen-token-plan', label: '国际', tag: '国际', domain: 'token-plan.ap-southeast-1.maas.aliyuncs.com' },
      { route: 'qwen-token-plan-individual', label: '国际个人版', tag: '国际个人版', domain: 'token-plan.ap-southeast-1.maas.aliyuncs.com' },
    ] },
  { id: 'deepseek-pi', name: 'DeepSeek（pi-ai）', keywords: ['deepseek', '深度求索'], category: 'domestic', color: '#4d6bfe', initials: 'DS',
    variants: [{ route: 'deepseek', domain: 'api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys' }] },
  { id: 'ant-ling', name: '蚂蚁百灵 Ling', keywords: ['ling', 'ant', 'bailing', '蚂蚁', '百灵'], category: 'domestic', color: '#1677ff', initials: 'L',
    variants: [{ route: 'ant-ling', domain: 'api.ant-ling.com' }] },
  { id: 'opencode', name: 'OpenCode', keywords: ['opencode', 'zen', 'go'], category: 'aggregator', color: '#3a3a3c', initials: 'OC', variantLabel: '套餐',
    variants: [
      { route: 'opencode-go', label: 'Go', name: 'OpenCode Go', domain: 'opencode.ai', keyUrl: 'https://opencode.ai/auth' },
      { route: 'opencode', label: 'Zen', name: 'OpenCode Zen', domain: 'opencode.ai', keyUrl: 'https://opencode.ai/auth' },
    ] },
  { id: 'openrouter', name: 'OpenRouter', keywords: ['openrouter'], category: 'aggregator', color: '#6467f2', initials: 'OR',
    variants: [{ route: 'openrouter', domain: 'openrouter.ai', keyUrl: 'https://openrouter.ai/settings/keys' }] },
  { id: 'vercel', name: 'Vercel AI Gateway', keywords: ['vercel', 'gateway'], category: 'aggregator', color: '#111111', initials: 'V',
    variants: [{ route: 'vercel-ai-gateway', domain: 'ai-gateway.vercel.sh' }] },
  { id: 'cloudflare-gateway', name: 'Cloudflare AI Gateway', keywords: ['cloudflare', 'gateway'], category: 'aggregator', color: '#f38020', initials: 'CF',
    variants: [{ route: 'cloudflare-ai-gateway', domain: 'gateway.ai.cloudflare.com' }] },
  { id: 'github-copilot', name: 'GitHub Copilot', keywords: ['github', 'copilot'], category: 'aggregator', color: '#24292f', initials: 'GH',
    variants: [{ route: 'github-copilot', domain: 'api.individual.githubcopilot.com' }] },
  { id: 'huggingface', name: 'Hugging Face', keywords: ['huggingface', 'hf'], category: 'aggregator', color: '#e8a400', initials: 'HF',
    variants: [{ route: 'huggingface', domain: 'router.huggingface.co' }] },
  { id: 'xai', name: 'xAI Grok', keywords: ['xai', 'grok'], category: 'intl', color: '#111111', initials: 'X',
    variants: [{ route: 'xai', domain: 'api.x.ai' }] },
  { id: 'mistral', name: 'Mistral', keywords: ['mistral'], category: 'intl', color: '#fa520f', initials: 'Ms',
    variants: [{ route: 'mistral', domain: 'api.mistral.ai' }] },
  { id: 'meta', name: 'Meta Llama API', keywords: ['meta', 'llama'], category: 'intl', color: '#0866ff', initials: 'Me',
    variants: [{ route: 'meta', domain: 'api.meta.ai' }] },
  { id: 'groq', name: 'Groq', keywords: ['groq'], category: 'intl', color: '#f55036', initials: 'Gq',
    variants: [{ route: 'groq', domain: 'api.groq.com' }] },
  { id: 'cerebras', name: 'Cerebras', keywords: ['cerebras'], category: 'intl', color: '#f15a29', initials: 'Ce',
    variants: [{ route: 'cerebras', domain: 'api.cerebras.ai' }] },
  { id: 'fireworks', name: 'Fireworks AI', keywords: ['fireworks'], category: 'intl', color: '#6720ff', initials: 'FW',
    variants: [{ route: 'fireworks', domain: 'api.fireworks.ai' }] },
  { id: 'together', name: 'Together AI', keywords: ['together'], category: 'intl', color: '#0f6fff', initials: 'T',
    variants: [{ route: 'together', domain: 'api.together.ai' }] },
  { id: 'baseten', name: 'Baseten', keywords: ['baseten'], category: 'intl', color: '#2a6f5b', initials: 'B',
    variants: [{ route: 'baseten', domain: 'inference.baseten.co' }] },
  { id: 'nvidia', name: 'NVIDIA NIM', keywords: ['nvidia', 'nim'], category: 'intl', color: '#76b900', initials: 'NV',
    variants: [{ route: 'nvidia', domain: 'integrate.api.nvidia.com' }] },
  { id: 'radius', name: 'Radius', keywords: ['radius'], category: 'intl', color: '#5a5d64', initials: 'R',
    variants: [{ route: 'radius', domain: 'radius.pi.dev' }] },
  { id: 'bedrock', name: 'Amazon Bedrock', keywords: ['aws', 'amazon', 'bedrock'], category: 'cloud', color: '#ff9900', initials: 'AWS',
    variants: [{ route: 'amazon-bedrock', domain: 'bedrock-runtime.amazonaws.com' }] },
  { id: 'azure', name: 'Azure OpenAI', keywords: ['azure', 'microsoft'], category: 'cloud', color: '#0078d4', initials: 'Az',
    variants: [{ route: 'azure', domain: 'openai.azure.com' }] },
  { id: 'vertex', name: 'Google Vertex AI', keywords: ['vertex', 'gcp', 'gemini', 'google cloud'], category: 'cloud', color: '#4a86e8', initials: 'V',
    variants: [{ route: 'google-vertex', label: 'Vertex AI', domain: 'aiplatform.googleapis.com' }] },
  { id: 'cloudflare-workers', name: 'Cloudflare Workers AI', keywords: ['cloudflare', 'workers'], category: 'cloud', color: '#f38020', initials: 'CF',
    variants: [{ route: 'cloudflare-workers-ai', domain: 'api.cloudflare.com' }] },
]

/** DSH 自带的两条 DeepSeek 线路：用 DSH 自己的设置（llm-deepseek）和账号，不在 pi-ai 目录里。按这个顺序排在国内和全部的最前面。 */
const BUILT_IN = {
  'deepseek-account': { name: 'DeepSeek 账号', color: '#4d6bfe', initials: 'DS', keywords: ['deepseek', '深度求索', '账号', 'account'] },
  'deepseek-official': { name: 'DeepSeek', tag: 'API 密钥', color: '#4d6bfe', initials: 'DS', domain: 'api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys',
    keywords: ['deepseek', '深度求索'] },
}

/** 左边的分类，按这个顺序显示；表外的目录路由有时在「全部」前面加「其他」（categoriesOf）。「已添加」按行列出，不按产品合并。 */
export const CATEGORIES = ['common', 'added', 'domestic', 'intl', 'aggregator', 'cloud', 'all']

/**
 * 「常用」的条目和顺序（feat#190），「自定义模型 API」由页面放在最前面。字符串是条目的 ID；带 routes 的只列这几条线路，
 * 可以借别家的线路（Gemini 借 Vertex AI，Vertex AI 同时还在「云服务」里）。目录里没有的跳过。
 */
export const COMMON = [
  'deepseek-account', 'deepseek-official', { id: 'opencode', routes: ['opencode-go'] }, 'kimi', 'zhipu', 'minimax', 'ark',
  'openai', { id: 'google', routes: ['google', 'google-vertex'] }, 'anthropic', 'xai',
]

const BY_ROUTE = new Map(FAMILIES.flatMap(family => family.variants.map(variant => [variant.route, { family, variant }])))
/** 带预设的那一家（火山方舟）。 */
export const PRESET_FAMILY = FAMILIES.find(family => family.presets !== undefined)

/**
 * 一条路由在卡片上怎么显示。
 * @param {string} route 路由标识符。
 * @param {{ displayName?: string, defaultBaseURL?: string }} [entry] DSH 目录里的这一行。
 * @returns {{ name: string, tag?: string, domain?: string, color: string, initials: string, keyUrl?: string, familyId?: string, known: boolean }}
 */
export function routeMeta(route, entry = {}) {
  const builtIn = BUILT_IN[route]
  if (builtIn !== undefined) {
    const { keywords: _keywords, ...meta } = builtIn
    return { ...meta, known: true }
  }
  const hit = BY_ROUTE.get(route)
  if (hit !== undefined) {
    const { family, variant } = hit
    return {
      name: variant.name ?? family.name,
      ...variant.name === undefined && variant.tag !== undefined ? { tag: variant.tag } : {},
      domain: variant.domain, color: family.color, initials: family.initials,
      ...variant.keyUrl === undefined ? {} : { keyUrl: variant.keyUrl },
      familyId: family.id, known: true,
    }
  }
  const name = entry.displayName !== undefined && entry.displayName.length > 0 ? entry.displayName : route
  const domain = hostFrom(entry.defaultBaseURL)
  // 按火山方舟预设建的自定义提供商：用方舟的图标和获取 API 密钥的页面，名字照它自己的显示名称。
  const preset = presetMatching(entry.defaultBaseURL)
  if (preset !== undefined) return { name, ...domain === undefined ? {} : { domain }, color: PRESET_FAMILY.color, initials: PRESET_FAMILY.initials, keyUrl: preset.keyUrl, known: false }
  return { name, ...domain === undefined ? {} : { domain }, color: '#5a5d64', initials: initialsOf(name), known: false }
}

/**
 * 比较 API 地址用的写法：协议、主机和去掉末尾斜杠的路径；主机不分大小写。
 * @param {string | undefined} url 地址。
 * @returns {string | undefined} 读不出来时为 undefined。
 */
function urlKey(url) {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url.trim())
    if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.username.length > 0 || parsed.password.length > 0) return undefined
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    // 地址写错了：不和任何预设相同。
    return undefined
  }
}

/**
 * API 地址和哪一种预设相同。
 * @param {string | undefined} url 自定义提供商的 API 地址。
 * @returns {(typeof PRESETS)[number] | undefined} 预设；都不同时为 undefined。
 */
export function presetMatching(url) {
  const key = urlKey(url)
  return key === undefined ? undefined : PRESETS.find(preset => urlKey(preset.baseURL) === key)
}

function hostFrom(url) {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    // 目录给的地址读不出来时不显示域名。
    return undefined
  }
}

/**
 * 没在表里的提供商用名字的头两个字符当图标。
 * @param {string} name 显示名称。
 * @returns {string} 一到两个字符，拉丁字母大写。
 */
export function initialsOf(name) {
  const latin = name.match(/[A-Za-z0-9]+/g)
  if (latin !== null && /^[A-Za-z]/.test(name)) return latin.slice(0, 2).map(word => word[0]).join('').toUpperCase() || name.slice(0, 2)
  return [...name.trim()][0] ?? '?'
}

/**
 * 一个条目：一家产品，带它在这里列出的线路。name 是条目上写的名字：只列一条线路、这条线路有自己的产品名时用它（OpenCode Go），否则用这一家的名字。
 * @param {object} family 这一家。
 * @param {object[]} variants 线路。
 * @param {'builtin' | 'catalog' | 'preset' | 'other' | 'custom'} kind 来源：内置、目录、预设、表外的目录路由、自定义。
 * @returns {object} 条目。
 */
function entryOf(family, variants, kind) {
  const name = variants.length === 1 && variants[0].name !== undefined ? variants[0].name : family.name
  return { family, name, variants, allAdded: variants.every(variant => variant.added), category: family.category, kind }
}

/**
 * 模型页右栏的条目：两条 DeepSeek 内置线路、按产品合并的目录路由、火山方舟的预设、表外的目录路由和自定义的提供商，按这个顺序（也是「全部」的顺序）。
 * 每条线路标明 added；已添加的带 provider（打开它的详情用的 Provider ID），预设的带 preset，familyId 是它自己那一家（打开填写页用）。
 * @param {readonly { provider: string, configured: boolean, declared?: boolean, displayName?: string, defaultBaseURL?: string }[]} rows DSH 目录拼好的行，不含协议混合的提供商的伴随条目。
 * @param {{ account?: boolean }} [options] account：DeepSeek 账号能登录（目录里还没有这一行时也列出，标成没添加）。
 * @returns {{ family: object, name: string, variants: object[], allAdded: boolean, category: string, kind: string }[]} 条目。
 */
export function pickerEntries(rows, { account = false } = {}) {
  const entries = []
  for (const [route, builtIn] of Object.entries(BUILT_IN)) {
    const own = rows.find(row => row.provider === route)
    if (own === undefined && !(route === 'deepseek-account' && account)) continue
    const added = own?.configured === true
    const family = { id: route, name: builtIn.name, keywords: builtIn.keywords, category: 'domestic', color: builtIn.color, initials: builtIn.initials }
    entries.push(entryOf(family, [{ route, ...builtIn.tag === undefined ? {} : { tag: builtIn.tag }, ...builtIn.domain === undefined ? {} : { domain: builtIn.domain },
      added, ...added ? { provider: route } : {}, familyId: route }], 'builtin'))
  }
  const catalog = rows.filter(row => row.declared !== true && BUILT_IN[row.provider] === undefined)
  const byRoute = new Map(catalog.map(row => [row.provider, row]))
  // 自定义的提供商：API 地址和预设相同的算那一种预设已添加，每种认第一个。
  const declared = rows.filter(row => row.declared === true && row.configured)
  const presetRow = new Map()
  const matchedRow = new Map()
  for (const preset of PRESETS) {
    const hit = declared.find(row => !presetRow.has(row.provider) && presetMatching(row.defaultBaseURL) === preset)
    if (hit !== undefined) {
      presetRow.set(hit.provider, preset)
      matchedRow.set(preset, hit)
    }
  }
  for (const family of FAMILIES) {
    if (family.presets !== undefined) {
      entries.push(entryOf(family, family.presets.map((preset) => {
        const hit = matchedRow.get(preset)
        return { route: preset.route, label: preset.label, domain: hostFrom(preset.baseURL), keyUrl: preset.keyUrl, preset,
          added: hit !== undefined, ...hit === undefined ? {} : { provider: hit.provider, ...hit.displayName === undefined ? {} : { displayName: hit.displayName } }, familyId: family.id }
      }), 'preset'))
      continue
    }
    const variants = family.variants.filter(variant => byRoute.has(variant.route)).map((variant) => {
      const added = byRoute.get(variant.route).configured
      return { ...variant, added, ...added ? { provider: variant.route } : {}, familyId: family.id }
    })
    if (variants.length > 0) entries.push(entryOf(family, variants, 'catalog'))
  }
  for (const row of catalog) {
    if (BY_ROUTE.has(row.provider)) continue
    const meta = routeMeta(row.provider, row)
    const family = { id: row.provider, name: meta.name, keywords: [row.provider], category: 'other', color: meta.color, initials: meta.initials }
    entries.push(entryOf(family, [{ route: row.provider, domain: meta.domain, added: row.configured, ...row.configured ? { provider: row.provider } : {}, familyId: row.provider }], 'other'))
  }
  for (const row of declared) {
    if (presetRow.has(row.provider)) continue
    const meta = routeMeta(row.provider, row)
    const family = { id: row.provider, name: meta.name, keywords: [row.provider], category: 'custom', color: meta.color, initials: meta.initials }
    entries.push(entryOf(family, [{ route: row.provider, domain: meta.domain, added: true, provider: row.provider, familyId: row.provider }], 'custom'))
  }
  return entries
}

/**
 * 左边要显示的分类：有表外的目录路由时在「全部」前面加「其他」。
 * @param {ReturnType<typeof pickerEntries>} entries 条目。
 * @returns {string[]} 分类。
 */
export function categoriesOf(entries) {
  return [...CATEGORIES.slice(0, -1), ...entries.some(entry => entry.category === 'other') ? ['other'] : [], 'all']
}

/**
 * 一个分类下的条目。「常用」照 COMMON 的顺序和线路；「全部」是所有条目；「已添加」按行列出，不在这里。
 * @param {ReturnType<typeof pickerEntries>} entries 条目。
 * @param {string} category 分类。
 * @returns {ReturnType<typeof pickerEntries>} 这一类的条目。
 */
export function entriesIn(entries, category) {
  if (category === 'all') return entries
  if (category === 'common') {
    const byId = new Map(entries.map(entry => [entry.family.id, entry]))
    const variants = entries.flatMap(entry => entry.variants)
    return COMMON.flatMap((spec) => {
      const { id, routes } = typeof spec === 'string' ? { id: spec, routes: undefined } : spec
      const home = byId.get(id)
      if (home === undefined) return []
      if (routes === undefined) return [home]
      const picked = routes.flatMap(route => variants.filter(variant => variant.route === route))
      return picked.length === 0 ? [] : [entryOf(home.family, picked, home.kind)]
    })
  }
  return entries.filter(entry => entry.category === category)
}

/**
 * 按产品名、中文名、别名、域名和路由标识符搜。名字开头相同的排最前，其次是别的关键词开头相同，再次是包含。
 * @param {ReturnType<typeof pickerEntries>} entries 候选。
 * @param {string} query 输入。
 * @returns {ReturnType<typeof pickerEntries>} 匹配的候选。
 */
export function searchEntries(entries, query) {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return entries
  const ranked = []
  entries.forEach((entry, index) => {
    const name = entry.family.name.toLowerCase()
    const keys = [name, ...(entry.family.keywords ?? []), ...entry.variants.flatMap(variant => [variant.route, variant.provider ?? '', variant.displayName ?? '', variant.domain ?? '', variant.label ?? ''])]
      .map(key => key.toLowerCase()).filter(key => key.length > 0)
    let rank
    if (name.startsWith(needle)) rank = 0
    else if (keys.some(key => key.startsWith(needle) || key.split(/[\s.\-（）()]+/).some(word => word.startsWith(needle)))) rank = 1
    else if (keys.some(key => key.includes(needle))) rank = 2
    if (rank !== undefined) ranked.push({ entry, index, rank })
  })
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index)
  return ranked.map(item => item.entry)
}

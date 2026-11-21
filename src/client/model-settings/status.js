/** 把 DSH 的提供商目录、设置和凭据拼成卡片上的状态；拼接规则照 DSH 0.2.1-rc.5 内置模型页（MIT，见 NOTICE 和 README「第三方来源」）。 */

import { deriveKeyRef } from '../../../lib/model-settings/key-ref.js'
import { companionKeyRef, ownCompanion } from '../../../lib/model-settings/companion.js'
import { protocolNeedsKey } from './protocol.js'

/**
 * 把已注册的路由和可配置的目录拼成一张表：DeepSeek 账号、DeepSeek 在前，其余按目录顺序。
 * @param {readonly { id: string, name: string }[]} registered `llm.listProviders` 的结果。
 * @param {readonly object[]} directory `llm.listConfigurableProviders` 的结果。
 * @returns {object[]} 目录行。
 */
export function joinDirectory(registered, directory) {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    ...entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: entry.defaultBaseURL },
    ...entry.baseURLEnv === undefined ? {} : { baseURLEnv: entry.baseURLEnv },
    ...entry.nativeAuth === undefined ? {} : { nativeAuth: entry.nativeAuth },
    ...entry.error === undefined ? {} : { error: entry.error },
  }))
  for (const provider of registered) {
    if (!declared.has(provider.id)) rows.push({ provider: provider.id, displayName: provider.name, settingsNs: '', settingsPath: [], active: true })
  }
  const rank = id => id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.provider) - rank(b.row.provider) || a.index - b.index).map(item => item.row)
}

/**
 * 还有哪些提供商从这个凭据名读 key：配置里点名了凭据的按点名的；没点名的按目录给的环境变量名和内置页派生的名字（页面也按这些名字找它的 key）。
 * 删除提供商、新建自定义提供商前查它：有别人在用，凭据就不删；新建的 ID 派生出这个名字时，要选共用还是单独存一把（feat#174）。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 凭据名。
 * @param {string} self 自己的路由标识符，不算在内。
 * @returns {string[]} 在用它的路由标识符。
 */
export function credentialUsers(rows, ref, self) {
  return rows.filter((row) => {
    const provider = row.entry.provider
    if (provider === self || provider === 'deepseek-account' || inheritsOriginKey(row, rows)) return false
    if (row.apiKeyEnv !== undefined) return row.apiKeyEnv === ref
    return deriveKeyRef(provider) === ref || (row.entry.nativeAuth?.env ?? []).includes(ref)
  }).map(row => row.entry.provider)
}

/**
 * 配置里显式点名了这个凭据名的别的提供商。目录里同一家的几个入口按 DSH 的设计共用一个环境变量名（例如 opencode 和 opencode-go），
 * 给其中一个存 key 本来就会换掉它们共用的那把；只有别人显式点名了它，按派生名给目录里的提供商存 key 才会悄悄盖掉别人的。
 * 伴随条目的凭据名是从原提供商继承来的（原提供商没点名时用目录的环境变量名），视同原提供商：原提供商自己没点名，它也不算点名。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 凭据名。
 * @param {string} self 自己的路由标识符，不算在内。
 * @returns {string[]} 点名了它的路由标识符。
 */
export function credentialNamedBy(rows, ref, self) {
  return rows.filter(row => row.entry.provider !== self && row.apiKeyEnv === ref && !inheritsOriginKey(row, rows)).map(row => row.entry.provider)
}

/**
 * 详情页替换密钥时算作「别的提供商也在用这个凭据名」的路由：
 * 1. 配置里显式点名了它的（含同目录的另一家，排除继承原提供商凭据名的伴随条目）；
 * 2. 已配置且按目录环境变量名（nativeAuth.env）或派生名读取它的提供商，排除同属目录里按 DSH 设计共用同一个环境变量名的兄弟入口（例如 opencode 与 opencode-go）。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 当前要写入的凭据名。
 * @param {object} selfRow 当前正在编辑的提供商行。
 * @returns {string[]} 需要提示「两边一起换还是只换这一家」的路由标识符。
 */
export function credentialReplaceSharers(rows, ref, selfRow) {
  const self = selfRow.entry.provider
  const selfCatalogEnv = selfRow.entry.declared !== true && (selfRow.entry.nativeAuth?.env ?? []).includes(ref)
  return rows.filter((row) => {
    const provider = row.entry.provider
    if (provider === self || provider === 'deepseek-account' || inheritsOriginKey(row, rows)) return false
    if (row.apiKeyEnv !== undefined) return row.apiKeyEnv === ref
    if (row.configured !== true) return false
    const readsEnv = deriveKeyRef(provider) === ref || (row.entry.nativeAuth?.env ?? []).includes(ref)
    if (!readsEnv) return false
    const peerCatalogEnv = row.entry.declared !== true && (row.entry.nativeAuth?.env ?? []).includes(ref)
    return !(selfCatalogEnv && peerCatalogEnv)
  }).map(row => row.entry.provider)
}

/**
 * 凭据名被别的提供商用着、这一家要单独存一把时的新凭据名：原名去掉 `_API_KEY` 加 `_2_API_KEY`，
 * 已经有哪一行点名、派生或按目录环境变量名读它，或者凭据库/环境里已经存在，就换成 3、4……（feat#174）。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 被占用的凭据名。
 * @param {Iterable<string>} [extraTaken] 额外已知已被占用的凭据名（例如 credentials.describe 查出的现有凭据或环境变量）。
 * @returns {string} 没有哪一行在读且未在 extraTaken 里出现过的凭据名。
 */
export function separateKeyRef(rows, ref, extraTaken = []) {
  const taken = new Set([...rows.flatMap(row => [row.apiKeyEnv, deriveKeyRef(row.entry.provider), ...row.entry.nativeAuth?.env ?? []]), ...extraTaken])
  const base = ref.endsWith('_API_KEY') ? ref.slice(0, -'_API_KEY'.length) : ref
  let n = 2
  while (taken.has(`${base}_${n}_API_KEY`)) n += 1
  return `${base}_${n}_API_KEY`
}

/**
 * 凭据库里这个凭据名的状态，从点名它、派生出它或检查过它的那一行取；选「共用」时据此判断对方存没存密钥（feat#174）。
 * @param {readonly object[]} rows 拼好的行。
 * @param {string} ref 凭据名。
 * @returns {{ configured?: boolean, source?: string, masked?: string } | undefined} 状态；没有哪一行带着它时 undefined。
 */
export function credentialInfoOf(rows, ref) {
  for (const row of rows) {
    if (row.apiKeyEnv === ref && row.credential !== undefined) return row.credential
    if (row.apiKeyEnv === undefined && deriveKeyRef(row.entry.provider) === ref && row.derivedCredential !== undefined) return row.derivedCredential
    if (row.credentialChecks?.[ref] !== undefined) return row.credentialChecks[ref]
  }
  return undefined
}

/**
 * 这一行是不是从原提供商继承凭据名的伴随条目：凭据名和原提供商实际在用的一样（lib/companion.js 的 companionKeyRef）。
 * @param {object} row 拼好的行。
 * @param {readonly object[]} rows 全部行。
 * @returns {boolean} 是时为 true。
 */
function inheritsOriginKey(row, rows) {
  if (row.companionOf === undefined) return false
  const origin = rows.find(candidate => candidate.entry.provider === row.companionOf.origin)
  if (origin === undefined) return false
  return row.apiKeyEnv === companionKeyRef(origin.entry.provider, { apiKeyEnv: origin.apiKeyEnv }, origin.entry.nativeAuth?.env)
}

/**
 * 标出伴随条目（协议混合的提供商的目录外模型，lib/companion.js）：只认插件自己建的（ownCompanion），并且原提供商是目录里的、已经配置。
 * 原提供商不在了的伴随条目不标，列表上照常显示成一家，能看、能删。
 * @param {readonly object[]} rows 拼好的行。
 * @param {(route: string) => unknown} profileOf 读这个 Provider ID 的配置。
 * @returns {object[]} 行；伴随条目带 `companionOf: { origin, api }`。
 */
export function markCompanions(rows, profileOf) {
  const byId = new Map(rows.map(row => [row.entry.provider, row]))
  const isCatalog = origin => byId.has(origin) && byId.get(origin).entry.declared !== true
  return rows.map((row) => {
    const parsed = ownCompanion(row.entry.provider, profileOf(row.entry.provider), isCatalog)
    return parsed !== undefined && byId.get(parsed.origin).configured === true ? { ...row, companionOf: parsed } : row
  })
}

/**
 * 这一家现在能不能用来对话：路由已注册，配置里点名的凭据也有值。
 * @param {object} row 拼好的行。
 * @returns {boolean} 能用时为 true。
 */
export function providerUsable(row) {
  if (!row.entry.active) return false
  if (row.entry.provider === 'deepseek-account') return row.accountAvailable === true
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/**
 * 这一行实际用来存 key 的凭据名：配置里写了就用配置的，没写就用内置页的派生规则。
 * @param {object} row 拼好的行。
 * @returns {string} 凭据名。
 */
export function keyRefOf(row) {
  return row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)
}

/**
 * 卡片和详情页头部的状态。按顺序取第一个成立的：检查失败、已登录、目录出错、密钥。
 * @param {object} row 拼好的行。
 * @param {{ check?: { ok: boolean, reason?: string, status?: number, message?: string }, catalogFailure?: string, credentialError?: string | null }} [extra] 这次打开设置后的检查结果和模型目录的错误。
 * @returns {{ tone: 'ok' | 'warn' | 'err' | 'idle', key: string, vars?: Record<string, string> }} 颜色和文案键。
 */
export function rowStatus(row, extra = {}) {
  if (extra.check?.ok === false) return { tone: 'err', key: 'statusCheckFailed' }
  if (row.entry.provider === 'deepseek-account') return { tone: 'ok', key: 'statusSignedIn' }
  // 配置在、DSH 却没有把它注册成路由：有原因写原因，没原因也说清是没在运行，不再落到下面的密钥状态。
  if (row.entry.active === false) {
    return row.entry.error === undefined ? { tone: 'err', key: 'statusNotRunning' } : { tone: 'err', key: 'statusNotRunningWhy', vars: { message: row.entry.error } }
  }
  if (row.entry.error !== undefined) return { tone: 'err', key: 'statusCatalogError', vars: { message: row.entry.error } }
  if (extra.catalogFailure !== undefined) return { tone: 'err', key: 'statusCatalogError', vars: { message: extra.catalogFailure } }
  const named = row.apiKeyEnv !== undefined
  const info = named ? row.credential : row.derivedCredential
  if (info?.configured === true) {
    return info.source === 'env'
      ? { tone: 'ok', key: 'statusEnv', vars: { name: keyRefOf(row) } }
      : { tone: 'ok', key: 'statusKeyConfigured' }
  }
  if (!named) {
    const detected = Object.entries(row.credentialChecks ?? {}).find(([, check]) => check.configured)
    if (detected !== undefined) return { tone: 'ok', key: 'statusEnv', vars: { name: detected[0] } }
    // Gemini API 没有密钥不能用，DSH 却照样注册它（官方 rc.2 protocol-rules.ts:1-5）。
    if (protocolNeedsKey(row.api)) return { tone: 'warn', key: 'statusKeyMissing' }
    if ((row.entry.nativeAuth?.env ?? []).length === 0) return { tone: 'ok', key: 'statusNoKeyNeeded' }
    if (row.credentialChecks === undefined) return { tone: 'idle', key: 'statusUnknown' }
    return { tone: 'warn', key: 'statusKeyMissing' }
  }
  if (info === undefined) return { tone: 'idle', key: 'statusUnknown' }
  return { tone: 'warn', key: 'statusKeyMissing' }
}

/**
 * 卡片第二行用的模型数和默认模型，来自 `session.modelCatalog`。
 * 协议混合的提供商的伴随条目在列表上不单列：它们的模型算进原提供商，默认模型在伴随条目里时也写在原提供商的卡片上。
 * @param {string} provider 路由标识符。
 * @param {{ default?: { provider: string, model: string }, groups?: { id: string, models: { id: string }[] }[], failures?: { id: string, message: string }[] } | undefined} catalog 模型目录。
 * @param {string[]} [companions] 这一家的伴随条目的路由标识符。
 * @returns {{ count?: number, defaultModel?: string, failure?: string }} 能读到的部分。
 */
export function catalogFactsOf(provider, catalog, companions = []) {
  if (catalog === undefined) return {}
  const own = [provider, ...companions]
  const groups = (catalog.groups ?? []).filter(candidate => own.includes(candidate.id))
  const failure = catalog.failures?.find(candidate => candidate.id === provider)
  return {
    ...groups.length === 0 ? {} : { count: groups.reduce((sum, group) => sum + group.models.length, 0) },
    ...own.includes(catalog.default?.provider) ? { defaultModel: catalog.default.model } : {},
    ...failure === undefined ? {} : { failure: failure.message },
  }
}

/** 名字里带 oauth 的引用是登录凭据，不当 API 密钥显示（照官方 rc.2 ProviderEditor.tsx:434）。 */
const isOauthRef = name => /oauth/i.test(name)

/**
 * 详情页密钥框的状态，照官方 rc.2：凭据文件里存着的显示打码预览、能清除；环境变量来的只说明来源；都没有时未配置。
 * @param {object} row 拼好的行。
 * @param {readonly string[]} users 还在用同一个凭据名的别的提供商（credentialUsers 的结果）；有人在用时不能在这里清除（TS-001）。
 * @returns {{ state: 'saved' | 'env' | 'unset', ref: string, masked?: string, envHint?: string, canClear: boolean }} 状态。
 */
export function keyViewOf(row, users) {
  const named = row.apiKeyEnv !== undefined
  const ref = keyRefOf(row)
  const info = named ? row.credential : row.derivedCredential
  if (info?.configured === true) {
    if (info.source === 'file') return { state: 'saved', ref, masked: info.masked ?? '', canClear: info.writable === true && users.length === 0 }
    return { state: 'env', ref, canClear: false }
  }
  if (!named) {
    const detected = Object.entries(row.credentialChecks ?? {}).find(([name, check]) => check.configured && !isOauthRef(name))
    if (detected !== undefined) return { state: 'env', ref: detected[0], canClear: false }
  }
  const envHint = named ? undefined : (row.entry.nativeAuth?.env ?? []).find(name => !isOauthRef(name))
  return { state: 'unset', ref, ...envHint === undefined ? {} : { envHint }, canClear: false }
}

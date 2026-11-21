/**
 * 余额与额度的提供方适配器：一家一个对象，`headers` 出请求头、`parse` 把响应解析成
 * 余额（balances）或套餐窗口（plan、windows），坏形状一律答 undefined（调用方按
 * unexpected 报）。写法改写自 @linxin666/dsh-usage 0.4.15 的 src/core/adapters.ts
 * （Apache-2.0，声明见 README「第三方来源」），改动：只留第一批三家；DeepSeek 读
 * balance_infos 的全部币种（dsh-usage 只取第一项，读数会在 CNY 和 USD 之间跳，调研 06
 * 第 7.3 节）；窗口/余额的输出字段换成余额与额度一行的响应字段（total、key、percent、
 * resetsAt）。本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */

/** 字符串/数字转有限数字，转不出答 undefined。 */
function toNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 非空字符串字段，答 undefined 表示没有。 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 提供方的百分比夹进可显示的 0–100；不是数字答 undefined。 */
function clampPercent(value) {
  if (value === undefined) return undefined
  return Math.max(0, Math.min(100, value))
}

/** 毫秒时间戳或 ISO 字符串归一成 ISO 8601，归不出答 undefined。 */
function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  const text = str(value)
  if (text === undefined) return undefined
  // 时间戳也会以字符串来（"1756428000"），走数字分支
  if (/^\d+$/.test(text)) return toIso(Number(text))
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 余额适配器的输出：全部币种各一条。 */
function parseDeepseek(status, body) {
  if (status !== 200 || typeof body !== 'object' || body === null) return undefined
  const infos = body.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) return undefined
  const balances = []
  for (const entry of infos) {
    if (typeof entry !== 'object' || entry === null) continue
    const currency = str(entry.currency)
    const total = str(entry.total_balance)
    if (currency !== undefined && total !== undefined) balances.push({ currency, total })
  }
  if (balances.length === 0) return undefined
  return { balances }
}

/** OpenCode Go 的窗口：rolling/weekly/monthly 对应 5 小时、每周、每月。 */
const OPENCODE_KEYS = [['rolling', '5h'], ['weekly', 'week'], ['monthly', 'month']]

function parseOpencode(status, body) {
  if (status !== 200 || typeof body !== 'object' || body === null) return undefined
  const usage = body.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const windows = []
  for (const [field, key] of OPENCODE_KEYS) {
    const row = usage[field]
    if (typeof row !== 'object' || row === null) continue
    const percent = toNum(row.percent)
    windows.push({
      key,
      percent: percent === undefined ? undefined : clampPercent(percent),
      // percent 0 的 resetsAt 是占位值（now + 窗口长度），丢弃（dsh-usage 的做法）
      resetsAt: percent === 0 ? undefined : toIso(row.resetsAt),
    })
  }
  if (windows.length === 0) return undefined
  return { windows }
}

/** GLM 的 unit 码到窗口键：3 是 5 小时滚动、6 是每周、5 是每月。 */
const GLM_UNIT_KEYS = { 3: '5h', 5: 'month', 6: 'week' }

/** CREDIT_LIMIT 行用 currentValue/usage 的精确比例，缺了退回接口自己的 percentage。 */
function glmCreditPercent(row) {
  const used = toNum(row.currentValue)
  const limit = toNum(row.usage)
  if (used !== undefined && limit !== undefined && limit > 0) return clampPercent((used / limit) * 100)
  return clampPercent(toNum(row.percentage))
}

function parseGlm(status, body) {
  if (status !== 200 || typeof body !== 'object' || body === null) return undefined
  if (body.success !== true) return undefined
  const data = body.data
  if (typeof data !== 'object' || data === null) return undefined
  const limits = data.limits
  if (!Array.isArray(limits)) return undefined
  const windows = []
  for (const entry of limits) {
    if (typeof entry !== 'object' || entry === null) continue
    const kind = str(entry.type)
    // TIME_LIMIT 是 MCP 请求次数的上限，不是套餐窗口；未知 unit 不硬猜窗口名
    if (kind === 'TIME_LIMIT') continue
    const key = GLM_UNIT_KEYS[toNum(entry.unit) ?? Number.NaN]
    if (key === undefined) continue
    if (kind !== 'TOKENS_LIMIT' && kind !== 'CREDIT_LIMIT') continue
    const percentage = kind === 'CREDIT_LIMIT' ? glmCreditPercent(entry) : clampPercent(toNum(entry.percentage))
    windows.push({ key, percent: percentage, resetsAt: toIso(entry.nextResetTime) })
  }
  if (windows.length === 0) return undefined
  return { plan: str(data.level), windows }
}

/**
 * 第一批三家。id 是 DSH 的 LLM 路由 id（凭据按它解析）；url 都指向各家自己的地址，
 * 查询只发给这里写的域名。
 */
export const QUOTA_ADAPTERS = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    kind: 'balance',
    url: 'https://api.deepseek.com/user/balance',
    headers: key => ({ authorization: `Bearer ${key}` }),
    parse: parseDeepseek,
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    kind: 'plan',
    url: 'https://opencode.ai/zen/go/v1/usage',
    headers: key => ({ authorization: `Bearer ${key}` }),
    parse: parseOpencode,
  },
  {
    id: 'zai-coding-cn',
    name: 'GLM Coding Plan',
    kind: 'plan',
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    // GLM 的认证头是裸 key，不带 Bearer（照 dsh-usage 的写法；调研 L：官方没写，社区两说，真实验证由 Claude 做）
    headers: key => ({ authorization: key, 'accept-language': 'en-US,en' }),
    parse: parseGlm,
  },
]

/**
 * 按 id 找适配器。
 * @param {string} id LLM 路由 id。
 * @returns {object | undefined} 适配器。
 */
export function adapterById(id) {
  return QUOTA_ADAPTERS.find(adapter => adapter.id === id)
}

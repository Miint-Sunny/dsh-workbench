/** 重试策略：照 DSH 0.2.2-rc.2 官方 RetryPolicyEditor.tsx 的默认值读取和校验（MIT，见 NOTICE）。字段和选项都从 schema 读，DSH 以后加字段或错误码页面自动跟上。 */

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 能写成数字的文字，包括 0.、.5、1e3。 */
export const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu

/** 初始延迟不能大于最大延迟：两个字段的路径。 */
const DELAY_ORDER = [['backoff', 'initialDelayMs'], ['backoff', 'maxDelayMs']]

/**
 * 一个模式分支的模式名。
 * @param {object} branch schema 节点。
 * @returns {string | undefined} 模式名。
 */
function modeOf(branch) {
  const mode = branch?.dict?.mode?.value
  return typeof mode === 'string' ? mode : undefined
}

/**
 * 一个分支里除 mode 以外的字段。
 * @param {object} node 对象节点。
 * @returns {[string, object][]} 字段名和节点。
 */
export function retryFieldsOf(node) {
  return Object.entries(node?.dict ?? {}).filter(([key]) => key !== 'mode')
}

/**
 * 错误码数组节点公布的内置选项：元素 union 里 const 分支的值。
 * @param {object} node 数组节点。
 * @returns {string[]} 错误码。
 */
export function retryCodeChoices(node) {
  return (node?.inner?.list ?? []).flatMap(branch => branch.type === 'const' && typeof branch.value === 'string' ? [branch.value] : [])
}

/**
 * 读 schema 里的模式和每个字段的默认值。
 * @param {object} schema 设置 schema 操作（getPath、nodeAtPath）。
 * @param {object} node `retryPolicy` 的 schema 节点（模式分支的 union）。
 * @param {unknown} inherited 组合层（不含用户层）的 `retryPolicy`。
 * @returns {{ modes: string[], mode: string, branch: (mode: unknown) => object | undefined, value: (branch: object, path: string[]) => unknown }} 默认值。
 */
export function retryPolicyDefaults(schema, node, inherited) {
  const branches = new Map((node?.list ?? []).flatMap((branch) => {
    const mode = modeOf(branch)
    return mode === undefined ? [] : [[mode, branch]]
  }))
  const modes = [...branches.keys()]
  const stored = schema.getPath(inherited, ['mode'])
  return {
    modes,
    mode: typeof stored === 'string' && branches.has(stored) ? stored : modes[0] ?? '',
    branch: mode => (typeof mode === 'string' ? branches.get(mode) : undefined),
    value: (branch, path) => {
      const value = schema.getPath(inherited, path)
      if (value !== undefined) return value
      return schema.nodeAtPath(branch, path)?.meta?.default
    },
  }
}

/**
 * 一个数字字段的问题。
 * @param {object} node 数字节点（meta 里的 min、max、step）。
 * @param {unknown} value 值。
 * @param {(key: string, vars?: object) => string} t 文案。
 * @returns {string | undefined} 原因。
 */
function numberFailure(node, value, t) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return t('retryValueNumber')
  const { min, max, step } = node.meta ?? {}
  if (step === 1 && !Number.isInteger(value)) return t('retryValueInteger')
  // Number.MIN_VALUE 是 schema 表示「必须大于 0」的写法。
  if (min === Number.MIN_VALUE && value <= 0) return t('retryValuePositive')
  if (typeof min === 'number' && value < min) return t('retryValueMin', { min })
  if (typeof max === 'number' && value > max) return t('retryValueMax', { max })
  return undefined
}

/**
 * 草稿里的重试策略哪里不对。DSH 对不合法的策略只记警告，所以必须在页面拦下。
 * @param {object} schema 设置 schema 操作（getPath、nodeAtPath、validate）。
 * @param {object} node `retryPolicy` 的 schema 节点。
 * @param {unknown} policy 草稿里的 `retryPolicy`；undefined 表示用默认。
 * @param {ReturnType<typeof retryPolicyDefaults>} defaults 默认值。
 * @param {(key: string, vars?: object) => string} t 文案。
 * @returns {{ message: string, path?: string[] } | undefined} 第一处问题和它的字段。
 */
export function retryPolicyFailure(schema, node, policy, defaults, t) {
  if (policy === undefined) return undefined
  const whole = () => {
    const message = schema.validate(node, policy)
    return message === undefined ? undefined : { message }
  }
  if (!isPlainObject(policy)) return whole()
  const branch = defaults.branch(policy.mode)
  if (branch === undefined) return whole()
  const read = path => schema.getPath(policy, path) ?? defaults.value(branch, path)
  const check = (owner, base) => {
    for (const [key, field] of retryFieldsOf(owner)) {
      const path = [...base, key]
      if (field.type === 'object') {
        const nested = check(field, path)
        if (nested !== undefined) return nested
      } else if (field.type === 'number') {
        const value = read(path)
        const message = value === undefined ? undefined : numberFailure(field, value, t)
        if (message !== undefined) return { message, path }
      } else if (field.type === 'array') {
        const stored = schema.getPath(policy, path)
        if (stored === undefined) continue
        if (!Array.isArray(stored) || stored.some(code => typeof code !== 'string' || code.length === 0)) return { message: t('retryCodesInvalid'), path }
        if (new Set(stored).size !== stored.length) return { message: t('retryCodesDuplicate'), path }
      }
    }
    return undefined
  }
  const failure = check(branch, [])
  if (failure !== undefined) return failure
  const [lowerPath, upperPath] = DELAY_ORDER
  const lower = read(lowerPath)
  const upper = read(upperPath)
  if (typeof lower === 'number' && typeof upper === 'number' && lower > upper) return { message: t('retryDelayOrder'), path: lowerPath }
  return whole()
}

/**
 * 把一个字段改进策略里；改成 undefined 就删掉，删空的对象也一起删。
 * @param {Record<string, unknown>} policy 当前策略。
 * @param {string[]} path 字段路径。
 * @param {unknown} value 新值。
 * @returns {Record<string, unknown>} 新策略。
 */
export function withRetryField(policy, path, value) {
  const [key, ...rest] = path
  if (key === undefined) return policy
  const result = { ...policy }
  const prior = result[key]
  const next = rest.length === 0 ? value : withRetryField(isPlainObject(prior) ? prior : {}, rest, value)
  if (next === undefined || (isPlainObject(next) && Object.keys(next).length === 0)) delete result[key]
  else result[key] = next
  return result
}

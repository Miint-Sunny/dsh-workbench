/**
 * 闲时压缩的设置：`$DSH_HOME/dsh-workbench/compaction.json`。压缩的三个下拉按会话记，只存和默认不同的项；
 * 提示词是全局设置。不写 profile：row 配置的保存会重写整个补丁文件。读的是内存，写走临时文件改名。
 * 文件损坏时按默认回答并带 reason，不覆盖坏文件；第一次写之前改名成 compaction.json.bad。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchDataDir } from './data-dir.js'

/** 新会话的默认：都关闭，和官方一样。 */
export const DEFAULT_SETTINGS = Object.freeze({ work: null, idle: null, idleMinutes: 30 })
/** 空闲时长能选的几档（分钟）。 */
export const IDLE_MINUTES = Object.freeze([15, 30, 60, 120, 240])
/** 档位的大小和最低档。 */
export const TIER_STEP = 100_000
export const TIER_MIN = 100_000
const SELECTIONS = ['official', 'seven', 'custom']
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

const invalid = what => new Error(`compaction state: invalid ${what}`)
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTier = value => value === null || (Number.isSafeInteger(value) && value >= TIER_MIN && value % TIER_STEP === 0)

function checkSettings(value, choices) {
  if (!isObject(value)) throw invalid('settings')
  for (const [key, item] of Object.entries(value)) {
    if (key === 'work' || key === 'idle') { if (!isTier(item)) throw invalid(key) } else if (key === 'idleMinutes') { if (!choices.includes(item)) throw invalid(key) } else throw invalid(key)
  }
}

function checkFile(value, choices) {
  if (!isObject(value) || value.version !== 1) throw invalid('file')
  checkSettings(value.defaults ?? {}, choices)
  if (!isObject(value.sessions ?? {})) throw invalid('sessions')
  for (const [id, settings] of Object.entries(value.sessions ?? {})) { if (!SESSION_ID.test(id)) throw invalid('session'); checkSettings(settings, choices) }
  const prompt = value.prompt ?? {}
  if (!isObject(prompt) || !SELECTIONS.includes(prompt.selection ?? 'official') || typeof (prompt.custom ?? '') !== 'string') throw invalid('prompt')
}

/**
 * 打开设置文件。
 * @param {{dir?: string, maxSessions?: number, maxPromptChars?: number, idleChoices?: number[]}} options 数据目录、两个上限和空闲时长能选的档。
 * @returns {object} effective、defaults、prompt、reason 和 setSession、resetSession、setDefaults、setPrompt。
 */
export function createCompactionState({ dir = workbenchDataDir(), maxSessions = 5000, maxPromptChars = 20_000, idleChoices = IDLE_MINUTES } = {}) {
  const file = join(dir, 'compaction.json')
  let corrupt = false
  let data = { version: 1, defaults: { ...DEFAULT_SETTINGS }, prompt: { selection: 'official', custom: '' }, sessions: {} }
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      checkFile(parsed, idleChoices)
      data = { version: 1, defaults: { ...DEFAULT_SETTINGS, ...parsed.defaults }, prompt: { selection: 'official', custom: '', ...parsed.prompt }, sessions: parsed.sessions ?? {} }
    } catch (error) {
      if (error.code !== undefined && error.code !== 'ENOENT') throw error
      corrupt = true
    }
  }

  function save() {
    mkdirSync(dir, { recursive: true })
    if (corrupt) {
      const bad = `${file}.bad`
      renameSync(file, existsSync(bad) ? `${bad}.${Date.now()}` : bad)
      corrupt = false
    }
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }

  /** 去掉和默认相同的项；空了就不再记这个会话。 */
  function store(id, settings) {
    const kept = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== data.defaults[key]))
    delete data.sessions[id]
    if (Object.keys(kept).length > 0) data.sessions[id] = kept
    const ids = Object.keys(data.sessions)
    for (const old of ids.slice(0, Math.max(0, ids.length - maxSessions))) delete data.sessions[old]
  }

  return {
    /**
     * 这个会话实际用的设置。
     * @param {string} id 会话 id。
     * @param {string} [parentId] 分叉来源：自己没设时跟它走。
     * @returns {{work: number|null, idle: number|null, idleMinutes: number, overridden: boolean}} 设置和有没有单独记。
     */
    effective(id, parentId) {
      const own = data.sessions[id]
      const inherited = own === undefined && parentId !== undefined ? data.sessions[parentId] : undefined
      return { ...data.defaults, ...inherited, ...own, overridden: own !== undefined }
    },
    /** @returns {{work: number|null, idle: number|null, idleMinutes: number}} 新会话的默认。 */
    defaults: () => ({ ...data.defaults }),
    /** @returns {{selection: string, custom: string, locale?: string}} 全局的压缩提示词设置。 */
    prompt: () => ({ ...data.prompt }),
    /** @returns {'corrupt'|null} 设置文件是否损坏。 */
    reason: () => (corrupt ? 'corrupt' : null),
    /**
     * 改一个会话。
     * @param {string} id 会话 id。
     * @param {object} patch work、idle、idleMinutes 里要改的项。
     * @returns {void}
     */
    setSession(id, patch) {
      if (typeof id !== 'string' || !SESSION_ID.test(id)) throw invalid('session')
      checkSettings(patch, idleChoices)
      store(id, { ...data.sessions[id], ...patch })
      save()
    },
    /**
     * 清掉一个会话的设置，回到默认。
     * @param {string} id 会话 id。
     * @returns {void}
     */
    resetSession(id) {
      if (typeof id !== 'string' || !SESSION_ID.test(id)) throw invalid('session')
      if (data.sessions[id] === undefined) return
      delete data.sessions[id]
      save()
    },
    /**
     * 改新会话的默认。
     * @param {object} patch work、idle、idleMinutes 里要改的项。
     * @returns {void}
     */
    setDefaults(patch) {
      checkSettings(patch, idleChoices)
      data.defaults = { ...data.defaults, ...patch }
      for (const [id, settings] of Object.entries(data.sessions)) store(id, settings)
      save()
    },
    /**
     * 改压缩提示词。选自定义时文字不能是空的。
     * @param {{selection: string, custom?: string, locale?: string}} patch 选哪档、自定义文字和提示词的语言。
     * @returns {void}
     */
    setPrompt({ selection, custom, locale }) {
      if (!SELECTIONS.includes(selection)) throw invalid('prompt selection')
      if (custom !== undefined && (typeof custom !== 'string' || custom.length > maxPromptChars)) throw invalid('prompt text')
      if (locale !== undefined && typeof locale !== 'string') throw invalid('prompt locale')
      const nextCustom = custom ?? data.prompt.custom
      if (selection === 'custom' && nextCustom.trim() === '') throw invalid('prompt text')
      data.prompt = { selection, custom: nextCustom, ...(locale === undefined ? {} : { locale }) }
      save()
    },
  }
}

/**
 * dsh-workbench 的数据目录：`$DSH_HOME/dsh-workbench`（`DSH_HOME` 没设时
 * `~/.dsh/dsh-workbench`）。插件自己的数据都在这下面（notify 的 notify.json、以后
 * 审阅行的回退记录）；不改任何配置。第 21 件第二步合并后，审阅行也用这个函数。
 * notify、rerun、检查点三行的 JSON 配置文件共用这里的读写，notify、rerun 两行共用这里的配置路由。
 */
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 解析数据目录。
 * @param {{DSH_HOME?: string}} env 进程环境（默认 process.env）。
 * @returns {string} 绝对路径。
 */
export function workbenchDataDir(env = process.env) {
  const home = env.DSH_HOME ? env.DSH_HOME : join(homedir(), '.dsh')
  return resolve(join(home, 'dsh-workbench'))
}

/**
 * 读数据目录里的一份行配置；文件不存在或坏了时用默认值回答，不写回（保存时才覆盖）。
 * @param {string} dir 数据目录。
 * @param {string} file 文件名，如 notify.json。
 * @param {(value: unknown) => object} parse 校验并规范化，形状不对时抛错。
 * @param {() => object} fallback 给出默认配置。
 * @returns {object} 当前配置。
 */
export function readJsonConfig(dir, file, parse, fallback) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  } catch {
    return fallback()
  }
  try {
    return parse(raw)
  } catch {
    return fallback()
  }
}

/**
 * 把行配置写进数据目录（原子写：先写临时文件再改名）。
 * @param {string} dir 数据目录。
 * @param {string} file 文件名。
 * @param {object} config 已经校验过的配置。
 * @returns {void}
 */
export function writeJsonConfig(dir, file, config) {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, file)
  const temp = `${target}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx')
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/**
 * 注册一份行配置的 GET/POST 路由：GET 回当前配置；POST 校验后写入，回 `{ ok: true, config }`；
 * 请求体不是 JSON、校验不过、写不进都回 400 `{ ok: false, message }`。检查点的配置路由错误回答
 * 带 reason、写不进回 500，在 lib/checkpoints.js 里单独写。
 * @param {object} scope 带有 connection 服务的插件作用域（进来前已过鉴权）。
 * @param {{ path: string, file: string, parse: (value: unknown) => object, fallback: () => object, dir?: string }} route 路由地址、文件名、校验和默认配置；dir 覆盖数据目录（测试用）。
 * @returns {() => void} 注销函数。
 */
export function registerJsonConfigRoute(scope, { path, file, parse, fallback, dir }) {
  return scope.connection.fetch.register({
    path,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const configDir = dir ?? workbenchDataDir(process.env)
      if (request.method === 'GET') return json(readJsonConfig(configDir, file, parse, fallback))
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, message: 'invalid request body' }, 400)
      }
      try {
        const config = parse(body)
        writeJsonConfig(configDir, file, config)
        return json({ ok: true, config })
      } catch (error) {
        return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 400)
      }
    },
  })
}

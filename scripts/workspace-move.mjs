#!/usr/bin/env node
/**
 * 会话迁移（feat#187）的命令行入口：DSH App 退出时，把一个工作区整组搬到另一个文件夹，或撤回。
 *
 *   node scripts/workspace-move.mjs plan  --from <工作区 id 或文件夹> --to <文件夹> [--home <DSH_HOME>] [--json]
 *   node scripts/workspace-move.mjs apply --from … --to … --yes [--home …]
 *   node scripts/workspace-move.mjs undo  --move <moveId> --yes [--home …]
 *   node scripts/workspace-move.mjs check [--home …]     用 App 自己的代码核对一遍
 *   node scripts/workspace-move.mjs list  [--home …]     以前的迁移和状态
 *
 * --home 默认 $DSH_HOME，没设时 ~/.dsh。apply 动手前后各用 App 自己的代码（lib/workspace-move-appcheck.mjs）
 * 核对一次：动手前读不了就不动；动手后核对不过（读不了，或被搬会话的事件变了）就自动撤回。
 * 机器上没有 DSH App 时跳过这两次核对，只做模块自己的自查。
 * 退出码：0 成功；1 出错；2 有阻碍或没加 --yes（什么都没改）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compareAppChecks, runAppCheck } from '../lib/workspace-move-check.js'
import { applyWorkspaceMove, planWorkspaceMove, undoWorkspaceMove } from '../lib/workspace-move.js'

const APP_BINARY = join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents/MacOS/DeepSeek Harness')

const [command, ...rest] = process.argv.slice(2)
const options = {}
for (let i = 0; i < rest.length; i++) {
  const name = rest[i].replace(/^--/, '')
  if (['json', 'yes'].includes(name)) options[name] = true
  else options[name] = rest[++i]
}
const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const say = text => process.stdout.write(`${text}\n`)
const kb = bytes => `${Math.ceil(bytes / 1024)} KB`

/** --from 可以是工作区 id，也可以是它的文件夹。 */
function workspaceIdOf(from) {
  const table = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).tables.workspaces
  if (table[from] !== undefined) return from
  let real
  try { real = realpathSync(from) } catch { real = from } // 旧文件夹可能已经不在了，按原样比
  const found = Object.entries(table).find(([, record]) => record.path === real || record.path === from)
  if (found === undefined) throw new Error(`没有这个工作区：${from}`)
  return found[0]
}

/** 用 App 自己的代码核对；机器上没有 App 时 undefined。 */
const appCheck = () => runAppCheck({ home, appBinary: APP_BINARY })

function describe(plan) {
  const target = plan.target.kind === 'workspace' ? `并进工作区「${plan.target.title}」` : '新文件夹，工作区改到这里'
  say(`要搬：「${plan.source.title}」（${plan.source.path}）→ ${plan.target.path}（${target}）`)
  say(`会话 ${plan.counts.sessions} 个（其中分叉 ${plan.counts.forks} 个、归档 ${plan.counts.archived} 个），子代理会话 ${plan.counts.subagents} 个，共 ${kb(plan.bytes)}`)
  say(`搬后：「${plan.result.title}」，${plan.result.sessionIds.length} 个会话`)
  const memory = { move: '搬过去', none: '没有', conflict: '新位置已有一份，不合并', unreadable: '开头对不上，不搬' }[plan.workbench.memory.action]
  const trust = { replace: '改成新路径', 'drop-source': '去掉旧路径', none: '不涉及' }[plan.workbench.trust.action]
  const fields = plan.workbench.checkpoints.reduce((sum, item) => sum + item.fields, 0)
  say(`工作台：检查点 ${plan.workbench.checkpoints.length} 个会话 ${fields} 处路径；记忆：${memory}；工作区信任：${trust}`)
  for (const item of plan.workbench.untouched) say(`不会跟过去：${item.file}（${item.mentions} 处提到旧路径）`)
  for (const item of plan.blockers) say(`阻碍：${item.message}`)
  for (const item of plan.warnings) say(`提醒：${item.message}`)
}


async function main() {
  if (command === 'plan' || command === 'apply') {
    if (!options.from || !options.to) throw new Error('要 --from 和 --to')
    const plan = await planWorkspaceMove({ home, workspaceId: workspaceIdOf(options.from), targetPath: options.to })
    if (command === 'plan' && options.json) {
      say(JSON.stringify(plan, null, 2))
      return plan.blockers.length > 0 ? 2 : 0
    }
    describe(plan)
    if (plan.blockers.length > 0) return 2
    if (command === 'plan') return 0
    if (!options.yes) {
      say('没有动手。确认无误后加 --yes 再跑一次。')
      return 2
    }
    const before = await appCheck()
    if (before !== undefined && !before.ok) {
      say(`没有动手：App 现在就读不了这个 DSH_HOME：${before.error}`)
      return 2
    }
    const { moveId, moveDir } = await applyWorkspaceMove({ home, plan })
    say(`moveId: ${moveId}`)
    say(`备份和记录：${moveDir}`)
    if (before === undefined) {
      say('这台没有 DSH App，没用 App 的代码核对。')
      return 0
    }
    const problem = compareAppChecks(before, await appCheck(), plan.sessions.map(item => item.id), plan)
    if (problem !== undefined) {
      await undoWorkspaceMove({ home, moveId, failedApply: true })
      say(`App 核对不通过，已自动撤回：${problem}`)
      return 1
    }
    say(`App 核对通过：${plan.sessions.length} 个会话按 App 的读法事件一条不差，都能以写方式打开。`)
    return 0
  }
  if (command === 'undo') {
    if (!options.move) throw new Error('要 --move')
    if (!options.yes) {
      say('没有动手。确认要撤回后加 --yes 再跑一次。')
      return 2
    }
    await undoWorkspaceMove({ home, moveId: options.move })
    say(`已撤回 ${options.move}。`)
    const report = await appCheck()
    if (report !== undefined) say(report.ok ? 'App 核对通过。' : `App 核对不通过：${report.error}`)
    return report === undefined || report.ok ? 0 : 1
  }
  if (command === 'check') {
    const report = await appCheck()
    if (report === undefined) throw new Error('这台没有 DSH App')
    say(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 1
  }
  if (command === 'list') {
    const moves = join(home, 'dsh-workbench', 'workspace-moves')
    for (const id of existsSync(moves) ? readdirSync(moves).sort() : []) {
      let status = '?'
      try { status = JSON.parse(readFileSync(join(moves, id, 'journal.json'), 'utf8')).status } catch { status = '记录不全' } // 列表只是看看，坏的照样列出来
      say(`${id}  ${status}`)
    }
    return 0
  }
  say('用法见文件开头：plan、apply、undo、check、list')
  return 1
}

main().then(code => process.exit(code), (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(error?.code === 'app-running' ? 2 : 1)
})

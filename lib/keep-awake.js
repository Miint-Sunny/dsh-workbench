/** macOS 工作期间防休眠：实时智能体事件与全局后台作业事件共用一个断言。 */
import { registerFeature } from './features.js'
import { createKeepAwake, parseKeepAwakeConfig, startCaffeinate } from './keep-awake-state.js'

export const name = '@miint-sunny/dsh-workbench/keep-awake'

/** 挂载事件订阅；非 macOS 不注册功能、订阅或路由。 */
export function apply(ctx, config) {
  const { graceMs, alsoOnBattery } = parseKeepAwakeConfig(config)
  if (process.platform !== 'darwin') return
  ctx.effect(() => registerFeature('keep-awake'), 'workbench keep-awake feature')
  ctx.inject(['agents', 'jobs'], scope => {
    const onError = error => scope.logger.warn(`dsh-workbench/keep-awake: ${error.message}`)
    const awake = createKeepAwake({ graceMs, start: () => startCaffeinate(process.pid, alsoOnBattery, onError), onError })
    scope.effect(() => () => awake.dispose(), 'workbench caffeinate cleanup')
    scope.on('agent/status', ({ agent, status }) => awake.set(agent, status === 'running'))
    scope.on('agent/created', ({ agent }) => awake.set(agent, agent.status === 'running'))
    scope.on('agent/disposed', ({ agent }) => awake.set(agent, false))
    const jobState = job => awake.set(`job:${job.id}`, job.status === 'running' || job.status === 'stopping')
    scope.jobs.events.subscribe({ owners: 'all' }, event => {
      if (event.type === 'removed') awake.set(`job:${event.job.id}`, false)
      else if (event.type === 'registered' || event.type === 'stopping' || event.type === 'settled') jobState(event.job)
    })
    // 热加载只读取一次服务内存表；后续完全由事件维护，不读取会话日志或进程表。
    for (const agent of scope.agents.list()) {
      awake.set(agent, agent.status === 'running')
      for (const job of scope.jobs.list(agent.id)) jobState(job)
    }
    for (const job of scope.jobs.list()) jobState(job)
  })
}

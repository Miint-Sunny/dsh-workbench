/** 上下文观察的有界并发与数值缓存；没有事件监听、定时器或持久数据库。 */
import { performance } from 'node:perf_hooks'

/** @param {object} options 官方 sessionQuery、已验证 config 和聚合函数。@returns {object} read 与等待清理的 dispose。 */
export function createContextStore({sessionQuery,config,aggregate}) {
  const cache=new Map(),waiting=new Set(),active=new Set(),lifetime=new AbortController()
  async function enter(signal){
    signal.throwIfAborted()
    if(active.size<config.maxConcurrentReads){const token={};active.add(token);return token}
    return new Promise((resolve,reject)=>{
      const item={resolve:token=>{signal.removeEventListener('abort',abort);resolve(token)},reject}
      const abort=()=>{waiting.delete(item);reject(signal.reason)}
      signal.addEventListener('abort',abort,{once:true});waiting.add(item)
    })
  }
  function leave(token){active.delete(token);const item=waiting.values().next().value;if(item){waiting.delete(item);const next={};active.add(next);item.resolve(next)}}
  const running=new Set()
  async function read(sessionId,caller){
    const signal=caller?AbortSignal.any([caller,lifetime.signal]):lifetime.signal
    const task=(async()=>{
      const token=await enter(signal);let lease
      const start=performance.now()
      try{
        lease=await sessionQuery.observeSession(sessionId,{projectionMode:'all',signal});signal.throwIfAborted()
        const observationMs=performance.now()-start,key=JSON.stringify([lease.source,lease.cursor,lease.revision]),cached=cache.get(sessionId)
        if(cached?.key===key){cache.delete(sessionId);cache.set(sessionId,cached);return{...cached.value,read:{source:lease.source,cached:true,observationMs,totalMs:performance.now()-start}}}
        const value=await aggregate(lease,{signal});signal.throwIfAborted()
        cache.delete(sessionId);cache.set(sessionId,{key,value});while(cache.size>config.maxCachedSessions)cache.delete(cache.keys().next().value)
        return{...value,read:{source:lease.source,cached:false,observationMs,totalMs:performance.now()-start}}
      }finally{try{lease?.[Symbol.dispose]()}finally{leave(token)}}
    })()
    running.add(task);try{return await task}finally{running.delete(task)}
  }
  return{read,async dispose(){lifetime.abort(new Error('context disposed'));await Promise.allSettled([...running]);cache.clear()}}
}

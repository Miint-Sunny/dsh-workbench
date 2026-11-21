/**
 * 网页端组件的测试环境：在替身 React 里执行构建好的 lib/client.js（和 DSH 的模块加载器一样调用 factory），
 * 再用 direct eval 取出包里的组件、读写模块级变量。替身只实现包里用到的部分：函数组件、key、Fragment、
 * useState、useReducer、useRef、useMemo、useCallback、useEffect、useLayoutEffect、useId、
 * useSyncExternalStore 和 createPortal。渲染结果是普通对象（宿主节点），测试按属性找节点，直接调用事件处理函数。
 * 和真 React 的差别：状态更新立即生效，在下一个宏任务里整棵重渲染（同一个宏任务里的更新合成一次，和 React 18 的批处理一致）；
 * effect 在每次渲染后同步执行；没有并发、Suspense 和 context。
 */
import { readFileSync } from 'node:fs'

const ELEMENT = Symbol('element')
const FRAGMENT = Symbol('Fragment')

/** 两组依赖逐项相同（Object.is）；没给依赖数组时每次都算变了。 */
function sameDeps(left, right) {
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * 节点里的文字，按顺序连起来。
 * @param {object | string} node 宿主节点或文字。
 * @returns {string} 文字。
 */
export function textOf(node) {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

/** 每个模拟的浏览器拥有自己的存储；传给另一个客户端可模拟刷新或共用同一浏览器。 */
export function createMemoryStorage() {
  const items = new Map()
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, String(value)) },
  }
}

/**
 * 替身 window：只有事件监听。
 * @returns {object} window 替身，`dispatchEvent({ type, ... })` 把事件交给监听者。
 */
export function createWindow() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    dispatchEvent(event) {
      for (const listener of [...listeners.get(event.type) ?? []]) listener(event)
      return true
    },
    listenerCount: type => listeners.get(type)?.size ?? 0,
  }
}

/**
 * 建一个替身 React 和它的渲染根。
 * @param {{ rect?: { width: number, height: number } }} [options] 宿主节点 getBoundingClientRect 的尺寸。
 * @returns {object} `React`、`ReactDOM`、`ui` 三个模块，和渲染、查找、触发事件的方法。
 */
export function createReact({ rect = { width: 1735, height: 868 } } = {}) {
  const instances = new Map()
  const hosts = new Map()
  const attached = new Map()
  let element = null
  let tree = []
  let current = null
  let pass = null
  let rendering = false
  let queued = false
  let dirty = false
  let failure
  let ids = 0

  function createElement(type, props, ...children) {
    const { key = null, ...rest } = props ?? {}
    if (children.length === 1) rest.children = children[0]
    else if (children.length > 1) rest.children = children
    return { [ELEMENT]: true, type, key: key === null ? null : String(key), props: rest }
  }
  const isElement = value => typeof value === 'object' && value !== null && value[ELEMENT] === true

  function hookAt(init) {
    if (current === null) throw new Error('钩子只能在组件里调用')
    const { inst } = current
    const index = current.index++
    if (index >= inst.hooks.length) inst.hooks.push(init())
    return inst.hooks[index]
  }
  function useState(initial) {
    const hook = hookAt(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    hook.set ??= (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next
      if (Object.is(value, hook.value)) return
      hook.value = value
      schedule()
    }
    return [hook.value, hook.set]
  }
  function useReducer(reducer, initialArg, init) {
    const hook = hookAt(() => ({ value: init === undefined ? initialArg : init(initialArg) }))
    hook.reducer = reducer
    hook.dispatch ??= (action) => {
      const value = hook.reducer(hook.value, action)
      if (Object.is(value, hook.value)) return
      hook.value = value
      schedule()
    }
    return [hook.value, hook.dispatch]
  }
  const useRef = initial => hookAt(() => ({ current: initial }))
  function useMemo(factory, deps) {
    const hook = hookAt(() => ({ ready: false, deps: undefined, value: undefined }))
    if (!hook.ready || !sameDeps(hook.deps, deps)) {
      hook.value = factory()
      hook.deps = deps
      hook.ready = true
    }
    return hook.value
  }
  const useCallback = (fn, deps) => useMemo(() => fn, deps)
  function useEffect(effect, deps) {
    const { inst } = current ?? {}
    const hook = hookAt(() => ({ effect: true, mounted: false, deps: undefined, cleanup: undefined }))
    if (!hook.mounted || !sameDeps(hook.deps, deps)) inst.queued.push({ hook, effect, deps })
  }
  const useId = () => hookAt(() => ({ id: `:t${++ids}:` })).id
  function useSyncExternalStore(subscribe, getSnapshot) {
    const value = getSnapshot()
    useEffect(() => subscribe(() => schedule()), [subscribe])
    return value
  }

  function hostNode(type) {
    const node = {
      type, props: {}, children: [], parent: null, open: false, style: {}, dataset: {}, posted: [],
      contentWindow: type === 'iframe' ? { postMessage: data => node.posted.push(data) } : undefined,
      get src() { return node.props.src ?? '' },
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: rect.width, bottom: rect.height, width: rect.width, height: rect.height }),
      focus() { api.focused = node },
      blur() {},
      scrollIntoView() {},
      setPointerCapture() {},
      releasePointerCapture() {},
      showModal() { node.open = true },
      close() { node.open = false },
      contains(other) {
        for (let at = other; at; at = at.parent) if (at === node) return true
        return false
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    return node
  }

  function renderList(children, path, out) {
    if (!Array.isArray(children)) {
      renderNode(children, `${path}/i0`, out)
      return
    }
    children.forEach((child, index) => {
      const name = isElement(child) && child.key !== null ? `k${child.key}` : `${Array.isArray(child) ? 'a' : 'i'}${index}`
      renderNode(child, `${path}/${name}`, out)
    })
  }
  function renderNode(node, path, out) {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      renderList(node, path, out)
      return
    }
    if (!isElement(node)) throw new TypeError(`不能渲染 ${Object.prototype.toString.call(node)}（${path}）`)
    if (node.type === FRAGMENT) renderList(node.props.children, path, out)
    else if (typeof node.type === 'function') renderComponent(node, path, out)
    else if (typeof node.type === 'string') renderHost(node, path, out)
    else throw new TypeError(`未知的元素类型（${path}）`)
  }
  function renderComponent({ type, props }, path, out) {
    let inst = instances.get(path)
    if (inst !== undefined && inst.type !== type) {
      unmount(path)
      inst = undefined
    }
    if (inst === undefined) {
      inst = { type, path, hooks: [], queued: [] }
      instances.set(path, inst)
    }
    inst.props = props
    inst.queued = []
    pass.instances.add(path)
    const outer = current
    current = { inst, index: 0 }
    let output
    try {
      output = type(props)
    } finally {
      current = outer
    }
    renderNode(output, `${path}>`, out)
    pass.effects.push(...inst.queued)
    inst.queued = []
  }
  function renderHost({ type, props }, path, out) {
    let node = hosts.get(path)
    if (node === undefined || node.type !== type) {
      node = hostNode(type)
      hosts.set(path, node)
    }
    pass.hosts.add(path)
    pass.nodes.push(node)
    node.props = props
    const children = []
    renderList(props.children, path, children)
    node.children = children
    for (const child of children) if (typeof child !== 'string') child.parent = node
    out.push(node)
  }
  function unmount(path) {
    const inst = instances.get(path)
    if (inst === undefined) return
    instances.delete(path)
    for (const hook of inst.hooks) {
      if (hook?.effect !== true || typeof hook.cleanup !== 'function') continue
      const cleanup = hook.cleanup
      hook.cleanup = undefined
      cleanup()
    }
  }
  function setRef(ref, value) {
    if (typeof ref === 'function') ref(value)
    else ref.current = value
  }
  function commit() {
    for (const path of [...hosts.keys()]) if (!pass.hosts.has(path)) hosts.delete(path)
    const live = new Set(pass.nodes)
    for (const [node, ref] of [...attached]) {
      if (live.has(node) && node.props.ref === ref) continue
      attached.delete(node)
      if (typeof ref === 'function') ref(null)
      else if (ref.current === node) ref.current = null
    }
    for (const node of pass.nodes) {
      const ref = node.props.ref
      if (ref === undefined || ref === null || attached.get(node) === ref) continue
      attached.set(node, ref)
      setRef(ref, node)
    }
    for (const path of [...instances.keys()]) if (!pass.instances.has(path)) unmount(path)
    const effects = pass.effects
    for (const { hook } of effects) {
      if (typeof hook.cleanup !== 'function') continue
      const cleanup = hook.cleanup
      hook.cleanup = undefined
      cleanup()
    }
    for (const item of effects) {
      item.hook.mounted = true
      item.hook.deps = item.deps
      const cleanup = item.effect()
      item.hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }
  function renderRoot() {
    pass = { instances: new Set(), hosts: new Set(), nodes: [], effects: [] }
    const out = []
    renderNode(element, 'r', out)
    tree = out
    commit()
  }
  function flush() {
    if (rendering) {
      dirty = true
      return
    }
    rendering = true
    try {
      for (let round = 0; ; round++) {
        if (round > 100) throw new Error('渲染停不下来（超过 100 轮）')
        dirty = false
        renderRoot()
        if (!dirty) break
      }
    } finally {
      rendering = false
    }
  }
  function schedule() {
    dirty = true
    if (rendering || queued) return
    queued = true
    // 和 React 18 一样把同一个宏任务里的更新合成一次渲染：请求回来后 then 和 finally 里的几次 setState 一起生效。
    setImmediate(() => {
      queued = false
      if (!dirty || rendering) return
      try {
        flush()
      } catch (error) {
        failure ??= error
      }
    })
  }

  function all(predicate) {
    const found = []
    const walk = (nodes) => {
      for (const node of nodes) {
        if (typeof node === 'string') continue
        if (predicate(node)) found.push(node)
        walk(node.children)
      }
    }
    walk(tree)
    return found
  }
  function one(predicate, what = '节点') {
    const found = all(predicate)
    if (found.length !== 1) throw new Error(`应当正好有一个${what}，找到 ${found.length} 个`)
    return found[0]
  }

  const uiParts = new Map()
  const ui = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined
      if (!uiParts.has(name)) {
        uiParts.set(name, /^[a-z]/.test(name)
          ? (name === 'writeClipboard' ? async () => true : () => undefined)
          : function UiPart({ children, ...props }) { return createElement(`ui.${name}`, props, children) })
      }
      return uiParts.get(name)
    },
  })

  const api = {
    React: {
      createElement, Fragment: FRAGMENT, useState, useReducer, useRef, useMemo, useCallback, useEffect,
      useLayoutEffect: useEffect, useId, useSyncExternalStore,
    },
    ReactDOM: { createPortal: children => children },
    ui,
    focused: null,
    /** 渲染一个元素做根；之后的状态更新在微任务里重渲染。 */
    mount(next) {
      element = next
      flush()
    },
    /** 换根元素（相当于父组件给了新属性）。 */
    update(next) {
      element = next
      flush()
    },
    /** 卸载整棵树，跑完所有清理函数。 */
    unmount() {
      element = null
      flush()
    },
    /**
     * 等固定几轮宏任务（rounds，默认 20），让内存里的请求和状态更新落定；渲染里抛的错在这里抛出。
     * 请求要走真实文件、子进程或网络时，回得快慢不定，几轮宏任务不一定够：要等那一头在途的请求回来
     * （做法见 workspace-trust-client.test.mjs 的 setup 里包的 settle）。
     */
    async settle(rounds = 20) {
      for (let round = 0; round < rounds; round++) {
        await new Promise(resolve => setImmediate(resolve))
        if (failure !== undefined) {
          const error = failure
          failure = undefined
          throw error
        }
        if (dirty && !rendering) flush()
      }
    },
    all,
    one,
    /** 某个组件当前的属性（组件按类型找，返回全部实例）。 */
    instancesOf: type => [...instances.values()].filter(inst => inst.type === type),
    /**
     * 在节点上触发事件处理函数，沿父节点冒泡，stopPropagation 停止。
     * @param {object} node 宿主节点。
     * @param {string} handler 属性名，例如 onClick。
     * @param {object} [init] 事件对象上的其他字段。
     * @returns {object} 事件对象。
     */
    fire(node, handler, init = {}) {
      if (handler === 'onClick' && node.props.disabled) throw new Error('点的是禁用的控件')
      let stopped = false
      const event = {
        type: handler.slice(2).toLowerCase(), key: '', button: 0, clientX: 0, clientY: 0, shiftKey: false, pointerId: 1,
        target: node, defaultPrevented: false,
        preventDefault() { event.defaultPrevented = true },
        stopPropagation() { stopped = true },
        ...init,
      }
      let called = false
      for (let at = node; at && !stopped; at = at.parent) {
        const fn = at.props[handler]
        if (typeof fn !== 'function') continue
        called = true
        event.currentTarget = at
        fn(event)
      }
      if (!called) throw new Error(`节点和它的上层都没有 ${handler}`)
      return event
    },
  }
  return api
}

/**
 * 在替身 React 里执行构建好的客户端包。
 * @param {URL} file 构建好的 lib/client.js。
 * @param {Record<string, unknown>} [globals] 包里按全局名字用到的浏览器对象（fetch、EventSource、URL…），没给的照用 Node 自己的；window 没给时用 createWindow()。
 * @returns {{ react: object, window: object, get: (name: string) => any, set: (name: string, value: unknown) => void }} 替身 React、window，和读写包内名字的方法。
 */
export function loadClient(file, globals = {}) {
  const react = createReact()
  const source = readFileSync(file, 'utf8')
  const tail = 'return { inject: INJECT, apply: applyClient }'
  const at = source.lastIndexOf(tail)
  if (at < 0) throw new Error('lib/client.js 的 factory 结尾变了，测试环境要跟着改')
  const patched = `${source.slice(0, at)}return { inject: INJECT, apply: applyClient, scope: (code, value) => eval(code) }${source.slice(at + tail.length)}`
  const window = globals.window ?? createWindow()
  let entry
  window.__ModuleLoader__ = { load: (value) => { entry = value } }
  const scope = { ...globals, window }
  new Function(...Object.keys(scope), patched)(...Object.values(scope))
  const modules = { react: react.React, 'react-dom': react.ReactDOM, '@deepseek-ai/dsh-client-ui-primitives': react.ui }
  const exports = entry.factory((name) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`包要的模块 ${name} 测试环境没准备`)
    return modules[name]
  })
  return {
    react,
    window,
    get: name => exports.scope(name),
    set: (name, value) => { exports.scope(`${name} = value`, value) },
  }
}

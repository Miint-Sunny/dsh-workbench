/**
 * DeepSeek 账号的登录，给模型页「DeepSeek 账号」那一行的「登录」按钮用，照官方 dsh-client-ui-settings-account 的 start() 和 BrowserLogin（MIT，见 NOTICE）：
 * 桌面端把登录交给 App 打开浏览器；网页端在点击时先开一个空白标签页，拿到授权地址后再跳过去。登录状态由官方账号插件的账号流给（account-ui/change），
 * 这里不另开账号流。账号功能（remote.account、accountUi）不在时 available 为 false，页面不列 DeepSeek 账号的登录。
 */

/**
 * 建一个登录状态和操作。section.js 在账号功能可用时 bind、不可用时 unbind。
 * @param {{ desktop: () => boolean, streamBaseUrl: () => string | undefined, origin: () => string, open: () => object | null, writeText: (text: string) => Promise<void> }} env
 *   浏览器环境：是不是桌面端、桌面端的流地址、页面的 origin、开空白标签页、写剪贴板。
 * @returns {object} getSnapshot、subscribe 给页面订阅；bind、unbind、changed 给 section.js；signIn、cancel、copyLink 给页面的按钮。
 */
function createAccountLink(env) {
  let bound
  let bindEpoch = 0
  let inFlight
  let state = { available: false, view: undefined, failed: false }
  const listeners = new Set()
  const publish = (patch, omit = []) => {
    const next = { ...state, ...patch }
    for (const key of omit) delete next[key]
    state = next
    for (const listener of listeners) listener()
  }
  // 网页端这次登录开的标签页，跟着它的登录尝试走：拿到授权地址时跳过去，失败、过期、取消时关掉。
  let tab = { popup: null, attempt: undefined, navigated: false }
  const closeTab = () => {
    tab.popup?.close()
    tab = { popup: null, attempt: undefined, navigated: false }
  }
  // 授权页按 DSH 当前的深浅色显示（官方 authorize-url.ts）。
  const withTheme = (url) => {
    const next = new URL(url)
    next.searchParams.set('theme', bound?.colorScheme() ?? 'light')
    return next.href
  }
  const follow = (view) => {
    const attempt = view?.attempt
    if (tab.popup === null || attempt == null || attempt.id !== tab.attempt) return
    if (attempt.phase === 'failed' || attempt.phase === 'expired' || attempt.phase === 'cancelled') {
      closeTab()
      return
    }
    if (attempt.phase === 'succeeded') {
      // 还没跳到授权页的标签页是空白的，登录已经在别处完成了，关掉。
      if (!tab.navigated) tab.popup.close()
      tab = { popup: null, attempt: undefined, navigated: false }
      return
    }
    if (attempt.authorizeUrl === undefined || tab.navigated) return
    tab.navigated = true
    try {
      if (!tab.popup.closed) tab.popup.location.replace(withTheme(attempt.authorizeUrl))
    } catch (error) {
      console.error('[dsh-model-settings] sign-in tab navigate failed', error)
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /**
     * 账号功能可用了。
     * @param {{ remote: object, view: () => object | undefined, metadata: () => object, colorScheme: () => 'light' | 'dark' }} next
     *   官方的 remote.account、当前账号状态、请求要带的客户端信息、当前深浅色。
     */
    bind(next) {
      bindEpoch++
      inFlight = undefined
      closeTab()
      bound = next
      publish({ available: true, view: next.view(), failed: false }, ['starting', 'cancelling'])
    },
    /** 账号功能不在了：关掉还在等的标签页。 */
    unbind() {
      bindEpoch++
      inFlight = undefined
      bound = undefined
      closeTab()
      publish({ available: false, view: undefined, failed: false }, ['starting', 'cancelling'])
    },
    /**
     * 官方账号插件推来新的账号状态。
     * @param {object | undefined} view AccountView；账号流断了时为 undefined。
     */
    changed(view) {
      if (bound === undefined) return
      const transitioned = view?.status !== state.view?.status
        || view?.attempt?.id !== state.view?.attempt?.id
        || view?.attempt?.phase !== state.view?.attempt?.phase
      publish(transitioned ? { view, failed: false } : { view })
      follow(view)
    },
    /** 发起登录。失败时 failed 为 true，页面写「登录失败」。 */
    async signIn() {
      const current = bound
      if (current === undefined || inFlight !== undefined) return
      const epoch = bindEpoch
      inFlight = 'signIn'
      publish({ failed: false, starting: true }, ['cancelling'])
      try {
        const desktop = env.desktop()
        const stream = env.streamBaseUrl()
        const origin = desktop && stream !== undefined ? new URL(stream).origin : env.origin()
        if (!desktop) {
          // 弹出窗口只能在点击里打开，所以先开空白页；浏览器拦了时页面还有「复制登录链接」。
          closeTab()
          const popup = env.open()
          if (popup !== null) popup.opener = null
          tab = { popup, attempt: undefined, navigated: false }
        }
        const result = await current.remote.startSignIn(current.metadata(), origin, desktop ? 'desktop' : 'web')
        if (epoch !== bindEpoch) return
        if (!result.ok) throw new Error(result.error?.message ?? 'account start failed')
        const latest = current.view()
        if (latest?.status !== 'credential-stored' && latest?.attempt?.id !== result.value?.attempt?.id) {
          publish({ view: result.value })
        }
        if (!desktop) {
          tab.attempt = result.value?.attempt?.id
          follow(result.value)
          follow(current.view())
        }
      } catch (error) {
        if (epoch !== bindEpoch) return
        // 发起失败（拒绝或连接断开）：页面写「登录失败」，可以重新登录；原因留在控制台。
        console.error('[dsh-model-settings] sign-in start failed', error)
        closeTab()
        publish({ failed: true })
      } finally {
        if (epoch === bindEpoch) {
          inFlight = undefined
          publish({}, ['starting'])
        }
      }
    },
    /**
     * 取消这一次登录。
     * @param {string} id 登录尝试的 ID。
     */
    async cancel(id) {
      const current = bound
      if (current === undefined || inFlight !== undefined) return
      const epoch = bindEpoch
      inFlight = 'cancel'
      publish({ cancelling: true })
      try {
        const result = await current.remote.cancelSignIn(id)
        if (epoch !== bindEpoch) return
        if (!result.ok) publish({ failed: true })
      } catch (error) {
        if (epoch !== bindEpoch) return
        // 取消没送到：页面写「登录失败」，可以重新登录；原因留在控制台。
        console.error('[dsh-model-settings] sign-in cancel failed', error)
        publish({ failed: true })
      } finally {
        if (epoch === bindEpoch) {
          inFlight = undefined
          publish({}, ['cancelling'])
        }
      }
    },
    /**
     * 复制授权地址，浏览器没打开时手动打开。
     * @param {string} url 授权地址。
     * @returns {Promise<'copied' | 'failed'>} 复制结果。
     */
    async copyLink(url) {
      try {
        await env.writeText(withTheme(url))
        return 'copied'
      } catch {
        // 剪贴板不可用：页面写「复制失败」。
        return 'failed'
      }
    },
  }
}

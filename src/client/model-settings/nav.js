/**
 * 藏起设置导航里重复的「模型」。DSH 0.2.1-rc.5 的设置导航按登记表逐条出一行，不按「同 id 低优先级遮住」去重，
 * 所以这一页盖住内置页后左边会有两行同名的「模型」，点哪行都打开这一页。这里只在设置对话框里找名字相同的导航按钮，
 * 有两个以上时藏起后面的；上游修好后只剩一个，这段什么都不做。
 * @param {object} ctx 客户端上下文。
 * @param {() => string} label 当前语言下「模型」的叫法。
 */
function hideDuplicateNav(ctx, label) {
  ctx.effect(() => {
    let frame = 0
    let panelObserver
    let observedPanel
    const hidden = new Set()
    const dedupe = () => {
      frame = 0
      const panel = document.querySelector('[data-shortcut-modal="settings"]')
      if (panel !== observedPanel) {
        panelObserver?.disconnect()
        observedPanel = panel ?? undefined
        if (panel !== null) {
          panelObserver = new MutationObserver(schedule)
          panelObserver.observe(panel, { childList: true, subtree: true })
        }
      }
      const nav = panel?.querySelector('nav')
      if (nav === undefined || nav === null) return
      const name = label()
      const twins = [...nav.querySelectorAll('button')].filter(button => button.textContent.trim() === name)
      twins.forEach((button, index) => {
        if (index === 0) return
        if (button.style.display !== 'none') {
          button.style.display = 'none'
          button.dataset.dmsHidden = 'true'
          hidden.add(button)
        }
      })
    }
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(dedupe) }
    // 设置对话框挂在 body 下、#root 旁边，所以 body 只看直接子节点就够了，不跟着聊天流式输出跑。
    const bodyObserver = new MutationObserver(schedule)
    bodyObserver.observe(document.body, { childList: true })
    schedule()
    return () => {
      bodyObserver.disconnect()
      panelObserver?.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
      for (const button of hidden) {
        button.style.display = ''
        delete button.dataset.dmsHidden
      }
    }
  }, 'dsh-model-settings: one Models nav row')
}

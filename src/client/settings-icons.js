/**
 * 「设置页图标」这一行（dsh-workbench-settings-icons）：给第三方的两个设置页补导航图标。
 * 养鱼（dsh-bili-whale，设置页 id bili-whale）和订阅（dsh-plugin-subscriptions，设置页 id subscriptions）
 * 自己没有注册图标，设置页导航里用的是默认的齿轮，和「通用设置」分不开。这里按设置页的 id 注册图标，不改第三方的代码。
 * 通用设置不注册，保留官方的齿轮。
 *
 * 让位于第三方自己的图标。2026-11-17 在隔离的 DSH（App 自带命令行的网页端）里，用两个探针插件扮演「第三方」和「我们」，
 * 把同一个 id 的两个 settings.section.icon 注册按优先级、先后、早晚摆成十种情形实测：
 * - 同一个 id 只显示一个图标（导航那一格里只有一个 svg），不会并排显示两个。
 * - 优先级不同：数字小的显示（DSH 的报错也这么说：lowest renders）。和谁先注册无关；第三方晚 1.5 秒才注册，打开设置页时显示的已经是它的。
 * - 优先级相同：后注册的那个抛出页面错误（list slot "settings.section.icon" already has an entry with id "…" at priority N），
 *   没有注册上，先注册的显示。所以不能和第三方用同一个数字，包括默认的 0：第三方晚于我们注册自己的图标时，抛错的是第三方。
 * - 不写优先级就是 0，两个真实的第三方将来注册图标也多半不写。我们用一个远大于 0、也避开 100、1000 这类常见整数的数，
 *   排在后面：第三方注册了就显示它的；没注册，才显示我们的。
 * 场景、截图和日志见 chore#163 的结果记录。
 */

/** 设置页图标的优先级：数字小的显示，第三方不写就是 0；取一个远大于 0 的数，让位于第三方自己注册的图标。 */
const SETTINGS_ICON_PRIORITY = 100000

/**
 * 养鱼的图标（鱼身、鱼尾、鱼眼）。
 * @param {{ size?: number }} props 设置页导航给的图标边长。
 * @returns {object} SVG 元素。
 */
function SettingsFishIcon({ size = 16 }) {
  // dsh-ui-guard: DSH 没有鱼图标。照 DSH 图标的画法自己画：16×16、描边 1、圆角连接、currentColor。
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M11 8C9.6 10.2 7.8 11.5 5.8 11.5C3.9 11.5 2.4 10.2 1.5 8C2.4 5.8 3.9 4.5 5.8 4.5C7.8 4.5 9.6 5.8 11 8Z' }),
    h('path', { d: 'M11 8L14.5 5.5V10.5L11 8Z' }),
    h('circle', { cx: 4.5, cy: 7.3, r: 0.6, fill: 'currentColor', stroke: 'none' }),
  )
}

/**
 * 订阅的图标（一张卡片：圆角矩形、一条横线、一小段短线）。
 * @param {{ size?: number }} props 设置页导航给的图标边长。
 * @returns {object} SVG 元素。
 */
function SettingsCardIcon({ size = 16 }) {
  // dsh-ui-guard: DSH 没有卡片图标。照 DSH 图标的画法自己画：16×16、描边 1、圆角连接、currentColor。
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z' }),
    h('path', { d: 'M1.5 6.5h13M4 10h3' }),
  )
}

/** 要补图标的第三方设置页：设置页 id，和画它的组件。 */
const SETTINGS_PAGE_ICONS = [
  { id: 'bili-whale', Icon: SettingsFishIcon },
  { id: 'subscriptions', Icon: SettingsCardIcon },
]

/**
 * 这一行（dsh-workbench-settings-icons）开着时：给养鱼和订阅两页注册设置页导航图标；撤下时收回，恢复默认的齿轮。
 * @param {{ ctx: object }} app 客户端上下文。
 * @returns {() => void} 撤销函数。
 */
function applySettingsIcons(app) {
  const { ctx } = app
  const disposers = SETTINGS_PAGE_ICONS.map(({ id, Icon }) =>
    ctx.slots.inject('settings.section.icon', () =>
      ctx.slots.register({ name: 'settings.section.icon', id, priority: SETTINGS_ICON_PRIORITY }, (props) => h(Icon, props))))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

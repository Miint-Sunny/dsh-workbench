/**
 * dsh-workbench 各功能行的登记处。同一包的各行共享同一个模块实例，所以用模块级
 * Map 存当前开着的行：功能行在自己的 apply 里报到，卸载（插件页关掉这一行）时由
 * 返回的注销函数除名。根行的 GET /api/dsh-workbench.features 按它回答客户端。
 *
 * 行的中文标题和说明记在 FEATURE_META（/api/dsh-workbench.features 用）和
 * locale/<行>/zh.json（插件页用，DSH 的行元数据机制）两处，改的时候一起改。
 * 本模块不 import 任何 @deepseek-ai 包，`node --test` 直接可跑。
 */

/** 各功能行的标题和说明（插件页的行说明也用这几句话）。 */
export const FEATURE_META = {
  'workspace-trust': {
    title: '工作区信任',
    description: '桌面端预览 HTML 时，只为已信任的工作区读取页面引用的本地样式、脚本、图片、字体、音视频和字幕，不读取点文件和工作区之外的文件；未信任的工作区不读取。需要 dsh-better-sidebar 打上工作台的补丁。',
  },
  'new-tab': { title: '新标签页', description: '按常用、列表或两列排列右侧栏入口；切换到其他标签时自动关闭，标签栏的加号保留。分栏按钮改用带加号的图标。' },
  'approval-rules': { title: '放行规则', description: '只代答符合项目规则的人工询问；不减少自动审查请求，不改变沙箱。需要 macOS 或 Linux。' },
  mcp: { title: 'MCP', description: '管理当前项目和会话的工具可见性，查看本次启动后观测到的普通调用。' },
  design: { title: '设计画布', description: '在已发布页面的桌面和手机画板上选取、评论和预览参数。' },
  'local-review': { title: '本地审查', description: '独立只读会话审查 Git 改动，发现显示在「审阅」的差异行下面，逐条预览并发送修复要求。' },
  compaction: { title: '闲时压缩', description: '空闲超过阈值时自动压缩，可按会话设置压缩线并选择压缩提示词。默认关闭，与官方一致。不在名单中的预设不受影响。' },
  context: { title: '上下文', description: '按需查看上下文构成、最近请求和压缩记录。' },
  worktrees: { title: '管理工作树', description: '创建、进入、恢复和检查工作树；清理移到废纸篓并保留分支。' },
  attention: { title: '需要你处理', description: '在会话页集中显示等待审批、等待回答和计划待审；处理完后自动移除。' },
  'command-palette': { title: '命令面板', description: '搜索会话、操作、右侧栏、侧边栏和命令；命令只填入草稿。' },
  memory: { title: '项目记忆', description: '用 memory_view、memory_write 读取和整理同项目已验证的事实；Git 工作树共享，记忆通过工具结果进入会话。' },
  'keep-awake': {
    title: '工作期间防休眠',
    description: '智能体或后台作业运行时保持系统唤醒；默认仅在接通电源时生效，全部空闲一分钟后释放。仅支持 macOS。',
  },
  usage: {
    title: '用量主页',
    description: '按会话日志统计 Token 用量、估算费用、缓存命中和请求状态。',
  },
  tasks: {
    title: '任务清单和收尾框',
    description: '运行中在输入框上方展开任务清单；回合结束时显示总结和下一步按钮。为模型添加 wrap_up 工具。',
  },
  notify: {
    title: '系统通知',
    description: '会话完成、等待审批、等待回答或计划待审且 DSH 不在前台时，发送系统通知。',
  },
  review: {
    title: '改动审阅',
    description: '右侧栏「审阅」：未暂存、已暂存、未提交、分支和每一轮的改动，可暂存、回退、提交和推送，按行添加评论发给模型。替换「第 N 轮改动」页；关闭后恢复 DSH 自带的只读页。',
  },
  split: {
    title: '侧边对话',
    description: '在右侧栏打开另一个会话，与当前会话并排，可在其中发送消息、审批和回答。会话菜单增加「在右侧栏打开」，右侧栏的「新标签页」增加「侧边对话」。',
  },
  rerun: {
    title: '重新生成和编辑重发',
    description: '在回答下方增加「重新生成」和「编辑消息」：从此消息之前分叉出新会话并在其中重发。原会话不变。',
  },
  reply: {
    title: '选中文字回复',
    description: '选中回答中的文字时，在「引用文本」旁增加「回复」：输入回复后连同引用添加到输入框，或直接发送。关闭后仅保留 DSH 自带的「引用文本」。',
  },
  plan: {
    title: '计划全文',
    description: '在对话中显示计划全文，选中文字即可回复；计划待审时发送回复即要求修改。关闭后恢复 DSH 自带的计划卡片和右侧栏预览。',
  },
  pages: {
    title: '网页发布',
    description: '将工作区中的 HTML 发布为带版本的页面，可在右侧栏和侧边栏的「页面」中查看。为模型添加 publish_page 工具。',
  },
  'session-header': {
    title: '会话顶栏',
    description: '将「更多操作」移至顶栏按钮的最左侧；「本会话的变更请求」平时收入「更多操作」菜单，变更请求需要处理时仍显示在顶栏。',
  },
  'preset-switch': {
    title: '切换 Agent 预设',
    description: '会话开始以后，可在会话顶栏的 Agent 预设标签上切换标准模式、代码模式和全开模式。会话空闲时才能切换；切换前确认，显示工具和系统提示词的变化、下一次请求缓存未命中的估算，可先压缩上下文。',
  },
  'turn-nav': {
    title: '轮次导航',
    description: '右侧栏展开时也显示对话的轮次导航，主区域宽度达到 380 像素即显示。指针所在的刻度放大；可拖动刻度连续跳转、用上下方向键逐轮移动，或为某一轮添加书签。',
  },
  find: {
    title: '会话里查找',
    description: '按 ⌘F（Windows 为 Ctrl+F）在当前会话中查找文字并高亮全部匹配，按回车跳到下一处。',
  },
  organize: {
    title: '会话整理',
    description: '为会话设置颜色标签或标为未读；侧边栏增加「会话」页，按日期和标签分组。',
  },
  checkpoints: {
    title: '回到某条消息之前',
    description: '每轮开始前保存工作区检查点，并在回答下方增加「回到这一轮开始前」：恢复文件、分叉会话，或两者同时进行。',
  },
  quota: {
    title: '余额与额度',
    description: '向提供商查询余额和额度：DeepSeek 的 API 余额，OpenCode Go 和 GLM Coding Plan 的额度窗口。仅在收到请求时查询，结果短暂缓存；密钥仅在宿主端使用。',
  },
  'workspace-folders': {
    title: '工作区文件夹和权限',
    description: '侧边栏工作区的右键菜单增加「工作区设置…」，可添加子文件夹和外部文件夹。子文件夹单独成为工作区，该工作区的会话默认不能写主文件夹，可设为可写；外部文件夹在「工作区内修改」权限下和主文件夹一样可写。DSH 不限制读取。',
  },
  'settings-icons': {
    title: '设置页图标',
    description: '为养鱼（dsh-bili-whale）和订阅（dsh-plugin-subscriptions）的设置页补上图标，换掉默认的齿轮；这两个插件自己提供图标时，使用它们的。',
  },
  'browser-viewport': {
    title: '浏览器视口尺寸',
    description: '在右侧栏浏览器的工具栏增加「视口尺寸」按钮：可选手机、平板、桌面或自定义尺寸，网页按该尺寸排版，再缩放进卡片；每张卡片各自记住。关闭后恢复官方的样子。',
  },
  'session-cards': {
    title: '新会话卡片',
    description: '模型认为某件事适合另开会话时，在这一轮末尾显示卡片：默认点「开始」才新建会话；用户在这一轮亲口要求另开会话、选项又不越过当前会话时，直接新建。你在这一轮交代的事适合单独做时，模型也可以先问要不要另开会话。新会话停下时向当前会话回报。为模型添加 propose_session 工具。',
  },
  'workspace-guard': {
    title: '保护 DSH 数据和工作区',
    description: '智能体要改动 DSH 的 storages、sessions 目录，或移动、删除已登记的工作区文件夹时，先请求人工审批；放行规则不代答，自动审查不放行。',
  },
  'session-title': {
    title: '会话标题',
    description: '自动起名只看首条消息；/retitle 或侧栏会话菜单的「重新起名」参考首条和最近的对话重算。关闭后恢复 DSH 自带的首条消息生成标题。',
  },
  'model-settings': {
    title: '模型设置',
    description: '替换「设置 → 模型」页：按分类列出提供商，点已添加的进入详情页，点未添加的进入填写页。提供商和 API 密钥仍保存在 DSH 中。关闭后恢复 DSH 自带的模型页。',
  },
}

/** 当前开着的行：id → 条目。 */
const features = new Map()

/**
 * 登记一个功能行。
 * @param {string} id 行 id（FEATURE_META 的键，如 'tasks'、'notify'）。
 * @returns {() => void} 注销函数，行卸载时调用。
 * @throws {Error} id 不在 FEATURE_META 里时。
 */
export function registerFeature(id) {
  const meta = FEATURE_META[id]
  if (meta === undefined) throw new Error(`unknown dsh-workbench feature: ${id}`)
  features.set(id, { id, title: meta.title, description: meta.description })
  return () => { features.delete(id) }
}

/**
 * 当前开着的行的快照，按登记顺序。
 * @returns {{id: string, title: string, description: string}[]} 行列表。
 */
export function enabledFeatures() {
  return [...features.values()].map(feature => ({ ...feature }))
}

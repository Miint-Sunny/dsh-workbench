/** 命令宿主没有浏览器 locale 参数，静态命令文案由行配置 locale 选择。页面使用客户端字典。 */
export const LOCAL_REVIEW_HOST = {
 zh:{description:'独立只读审查未提交改动或分支差异',started:'已开始独立只读审查。',preset:'工作台只读审查（内部）',presetDescription:'仅由 /review 创建，用于查看和解释固定快照；请勿直接选择。',failure:'无法开始审查，请在本地审查页检查范围和错误。'},
 en:{description:'Review uncommitted or branch changes in an independent read-only session',started:'Started an independent read-only review.',preset:'Workbench read-only review (internal)',presetDescription:'Created only by /review to inspect a fixed snapshot; do not select directly.',failure:'Unable to start review. Check the scope and error in Local review.'},
}

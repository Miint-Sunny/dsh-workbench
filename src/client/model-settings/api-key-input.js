/**
 * API 密钥框，照 DSH 0.2.2-rc.2 官方 ApiKeyInput（MIT，见 NOTICE）的行为：
 * 已保存的密钥只显示 DSH 给的打码预览，不能复制、剪切，看不到原文；输入就是替换，输入时可以点眼睛看刚输入的值；
 * 清除暂存到页面的「保存」时执行。官方只能在框里按 Backspace 或 Delete 清除，这里另放一个一直看得见的「清除」，按键也照样支持。
 *
 * draft 的三种值：undefined 没动；字符串是新输入的；`{ remove: true }` 是要清除（`removed` 表示已经清掉、等配置写完）。
 */

/**
 * @param {object} props
 * @param {object} props.app 插件的共享对象。
 * @param {string} props.id 输入框 id。
 * @param {{ state: 'saved' | 'env' | 'unset', masked?: string, canClear: boolean, envHint?: string, ref?: string }} props.view keyViewOf 的结果。
 * @param {undefined | string | { remove: true, removed?: true }} props.draft 草稿。
 * @param {(next: undefined | string | { remove: true }) => void} props.onDraft 改草稿。
 * @param {boolean} props.disabled 禁用。
 * @param {string | undefined} props.hint 框下面的一行说明。
 * @param {'hint' | 'warn' | 'err'} [props.hintTone] 说明的颜色。
 * @param {boolean} [props.invalid] 格式不对时标红。
 * @param {boolean} [props.bare] 不出「API 密钥」标签那一行，输入框用它当无障碍名称；放在上面已经有标签的选项下面时用（feat#174）。
 */
function ApiKeyInput({ app, id, view, draft, onDraft, disabled, hint, hintTone = 'hint', invalid = false, bare = false }) {
  const [revealed, setRevealed] = useState(false)
  const typed = typeof draft === 'string' ? draft : ''
  const removing = typeof draft === 'object' && draft !== null
  const saved = view.state === 'saved' && draft === undefined
  const canReveal = !saved && !removing && typed.length > 0 && !disabled
  const badge = view.state === 'saved' ? app.t('keyConfigured') : view.state === 'env' ? app.t('keyFromEnv') : app.t('keyUnset')
  const placeholder = removing ? app.t('keyRemovedPlaceholder')
    : saved ? view.masked ?? ''
      : view.state === 'env' ? app.t('keyPlaceholderEnv', { name: view.ref }) : app.t('keyPlaceholder')
  const clear = () => { setRevealed(false); onDraft({ remove: true }) }
  return h('div', { className: 'dms-field' },
    bare ? null : h('div', { className: 'dms-label dms-keyhead' }, h('label', { htmlFor: id }, app.t('keyField')),
      h(ui.Tag, { tone: view.state === 'unset' ? 'quiet' : 'neutral' }, badge)),
    h('div', { className: `dms-keybox${saved ? ' dms-keysaved' : ''}${invalid ? ' dms-keybad' : ''}${removing ? ' dms-keyoff' : ''}` },
      h('input', {
        id, className: 'dms-keyinput', type: canReveal && revealed ? 'text' : 'password', autoComplete: 'new-password', spellCheck: false,
        value: typed, placeholder, disabled: disabled || removing, 'aria-invalid': invalid ? 'true' : undefined, ...bare ? { 'aria-label': app.t('keyField') } : {},
        onCopy: (event) => { if (saved) event.preventDefault() },
        onCut: (event) => { if (saved) event.preventDefault() },
        onKeyDown: (event) => {
          if (saved && view.canClear && (event.key === 'Backspace' || event.key === 'Delete')) {
            event.preventDefault()
            clear()
          }
        },
        onChange: (event) => {
          setRevealed(false)
          onDraft(event.target.value === '' ? undefined : event.target.value)
        },
      }),
      canReveal ? h('button', {
        type: 'button', className: 'dms-iconbtn dms-keyeye', 'aria-label': app.t(revealed ? 'keyHide' : 'keyReveal'), 'aria-pressed': revealed ? 'true' : 'false',
        onClick: () => setRevealed(!revealed),
      }, h(revealed ? ui.IconEyeOffOutlineRegular : ui.IconEyeOutlineRegular, { size: 16 })) : null,
      saved && view.canClear && !disabled ? h('button', { type: 'button', className: 'dms-link dms-keyact', onClick: clear }, app.t('keyClear')) : null,
      removing && draft.removed !== true && !disabled ? h('button', { type: 'button', className: 'dms-link dms-keyact', onClick: () => onDraft(undefined) }, app.t('keyUndo')) : null),
    hint === undefined ? null : h('p', { className: hintTone === 'hint' ? 'dms-hint' : `dms-note dms-${hintTone}`, ...hintTone === 'err' ? { role: 'alert' } : {} }, hint))
}

/**
 * 密钥框下面那一行：改了什么、保存后会怎样；没改时说明还能用环境变量。
 * @param {object} app 插件的共享对象。
 * @param {object} view keyViewOf 的结果。
 * @param {undefined | string | { remove: true, removed?: true }} draft 草稿。
 * @param {string | undefined} envFallback 清除后接上的环境变量名。
 * @returns {{ text: string, tone: 'hint' | 'warn' } | undefined} 说明。
 */
function keyHintOf(app, view, draft, envFallback) {
  if (typeof draft === 'object' && draft !== null) {
    if (draft.removed === true) return { text: app.t('keyRemoveApplied'), tone: 'warn' }
    return { text: envFallback === undefined ? app.t('keyRemovePending') : app.t('keyRemovePendingEnv', { name: envFallback }), tone: 'warn' }
  }
  if (typeof draft === 'string' && draft.length > 0) return view.state === 'saved' ? { text: app.t('keyReplacePending'), tone: 'hint' } : undefined
  if (view.state === 'unset' && view.envHint !== undefined) return { text: app.t('keyHintEnvAlt', { name: view.envHint }), tone: 'hint' }
  return undefined
}

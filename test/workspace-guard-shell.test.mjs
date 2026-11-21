import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalizePath, classifyPathTarget } from '../lib/workspace-guard-paths.js'
import { inspectShellCommand } from '../lib/workspace-guard-shell.js'

function setupEnv(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dwb-wg-shell-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'Users', 'alice')
  const dshHome = join(home, '.dsh')
  const docs = join(home, 'Documents')
  const dshWork = join(docs, 'dsh_work')
  const work = join(docs, 'work')
  const other = join(home, 'other')
  const storages = join(dshHome, 'storages')
  const sessions = join(dshHome, 'sessions')
  const sessOld = join(sessions, '--Users-alice-Documents-dsh_work--')
  const sessNew = join(sessions, '--Users-alice-Documents-work--')

  for (const dir of [storages, join(sessOld, 's1'), sessNew, dshWork, join(dshWork, '.venv-asr'), work, other]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(storages, 'workspace.json'), JSON.stringify({
    tables: {
      workspaces: {
        w1: { path: dshWork, title: 'dsh_work', sessionIds: ['s1'] },
        w2: { path: work, title: 'work', sessionIds: [] },
      },
    },
  }))
  writeFileSync(join(work, 'AGENTS.md'), '# agents\n')
  writeFileSync(join(dshWork, '.DS_Store'), '')

  // Symlinks pointing to protected targets (existing & dangling)
  const linksDir = join(root, 'links')
  mkdirSync(linksDir, { recursive: true })
  symlinkSync(storages, join(linksDir, 'to-storages'))
  symlinkSync(sessions, join(linksDir, 'to-sessions'))
  symlinkSync(dshWork, join(linksDir, 'to-dsh-work'))
  symlinkSync(join(storages, 'nonexistent.json'), join(linksDir, 'dangling-storage'))

  const context = {
    dshHome,
    home,
    cwd: docs,
    workspaceRoots: [dshWork, work],
    env: { HOME: home, DSH_HOME: dshHome },
  }
  return { root, home, dshHome, docs, dshWork, work, other, storages, sessions, linksDir, context }
}

test('DS 时间线真实命令：复制登记表、搬会话目录并改登记表、复制回去、rm -rf', (t) => {
  const { dshHome, dshWork, work, context } = setupEnv(t)

  // 1. 复制登记表 (timeline line 135)
  const copyRegistryCmd =
    'ls -la ~/.dsh/sessions/--Users-alice-Documents-work--/; ' +
    'echo "=== 注册表备份 ==="; ' +
    'cp ~/.dsh/storages/workspace.json /tmp/workspace.json.bak-$(date +%H%M%S) && ' +
    'ls -la /tmp/workspace.json.bak-* | tail -2'
  assert.equal(inspectShellCommand(copyRegistryCmd, context)?.kind, 'dsh-data')

  // 2. 搬会话目录并改登记表 (timeline line 137 & 235)
  const moveSessionCmd = [
    "cd ~/.dsh && python3 - <<'EOF'",
    'import json, os, shutil, pathlib',
    `REG = pathlib.Path("${dshHome}/storages/workspace.json")`,
    `BASE = pathlib.Path("${dshHome}/sessions")`,
    'shutil.move(str(BASE / "--Users-alice-Documents-dsh_work--" / "s1"), str(BASE / "--Users-alice-Documents-work--" / "s1"))',
    'os.replace(REG.with_suffix(".json.tmp"), REG)',
    'EOF',
  ].join('\n')
  assert.equal(inspectShellCommand(moveSessionCmd, context)?.kind, 'dsh-data')

  // 3. 复制回去当安全副本 (timeline line 263 & 269)
  const copyBackCmd = [
    'cd ~/.dsh/sessions && SRC="--Users-alice-Documents-work--"; DST="--Users-alice-Documents-dsh_work--"',
    'for SID in session-a session-b; do',
    '  cp -Rp -- "$SRC/$SID" "$DST/$SID" && echo "ok: $SID"',
    'done',
  ].join('\n')
  assert.equal(inspectShellCommand(copyBackCmd, context)?.kind, 'dsh-data')

  // 4. rm -rf 保护目标 vs 工作区内部普通文件
  assert.equal(inspectShellCommand('rm -rf ~/.dsh/sessions/--Users-alice-Documents-dsh_work--', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('rm -rf ~/.dsh/storages/workspace.json', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('rm -rf ~/.dsh', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand(`rm -rf "${dshWork}"`, context)?.kind, 'workspace-root')
  assert.equal(inspectShellCommand(`mv "${dshWork}" "${work}-moved"`, context)?.kind, 'workspace-root')
  assert.equal(inspectShellCommand(`rmdir "${dshWork}"`, context)?.kind, 'workspace-root')
  assert.equal(inspectShellCommand(`rm -rf "${context.cwd}"`, context)?.kind, 'workspace-root')

  // 工作区内部普通文件删除/复制不拦 (timeline line 87-95 & line 12)
  const cleanInnerCmd = `TARGET="${dshWork}"; rm -rf "$TARGET/.venv-asr"; rm -f "$TARGET/.DS_Store"`
  assert.equal(inspectShellCommand(cleanInnerCmd, context), null)

  const copyInnerCmd = `cd "${work}" && cp AGENTS.md /tmp/AGENTS.md.bak && ls -la /tmp/AGENTS.md.bak`
  assert.equal(inspectShellCommand(copyInnerCmd, context), null)

  // 把别处文件 mv 进工作区根目录下不算搬走工作区根文件夹本身
  assert.equal(inspectShellCommand(`mv ./note.txt "${work}/"`, context), null)
  // 但用 -T 把工作区根路径本身当成覆盖目标则拦
  assert.equal(inspectShellCommand(`mv -T ./dir "${work}"`, context)?.kind, 'workspace-root')
})

test('只读命令不拦；危险 find、写重定向和未知命令按要写处理', (t) => {
  const { work, context } = setupEnv(t)

  // 只读命令放行
  assert.equal(inspectShellCommand('cat ~/.dsh/storages/workspace.json', context), null)
  assert.equal(inspectShellCommand('ls -la ~/.dsh/sessions/', context), null)
  assert.equal(inspectShellCommand('stat ~/.dsh/storages/workspace.json', context), null)
  assert.equal(inspectShellCommand('shasum ~/.dsh/storages/workspace.json', context), null)
  assert.equal(inspectShellCommand('find ~/.dsh -maxdepth 3 -iname "*workspace*" 2>/dev/null | head -20', context), null)
  assert.equal(
    inspectShellCommand(
      'ls ~/.dsh/sessions | head -5; echo "总数: $(ls ~/.dsh/sessions | wc -l)"; S=$(ls ~/.dsh/sessions | head -1); ls -la ~/.dsh/sessions/$S | head; grep -rl "dsh_work" ~/.dsh/sessions 2>/dev/null | wc -l',
      context,
    ),
    null,
  )
  assert.equal(
    inspectShellCommand('cd ~/.dsh/sessions/--Users-alice-Documents-dsh_work-- && zstd -dc s1/session.v4.jsonl.zstd | head -c 400', context),
    null,
  )
  assert.equal(inspectShellCommand("yq '.a' ~/.dsh/storages/workspace.json", context), null)
  assert.equal(inspectShellCommand('uniq ~/.dsh/storages/workspace.json', context), null)

  // 危险 find、写重定向与就地/输出写入必拦
  assert.equal(inspectShellCommand('find ~/.dsh/sessions -delete', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('find ~/.dsh/sessions -exec rm -rf {} +', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('find ~/.dsh/sessions | xargs rm -rf', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('cat /tmp/x > ~/.dsh/storages/workspace.json', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('echo "{}" >> ~/.dsh/storages/workspace.json', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand("yq -i '.a=1' ~/.dsh/storages/workspace.json", context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('uniq /tmp/a ~/.dsh/storages/workspace.json', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('export DST=~/.dsh/storages/workspace.json && cp /tmp/x "$DST"', context)?.kind, 'dsh-data')

  // 未知或脚本命令访问 storages/sessions 时宁可多问
  assert.equal(inspectShellCommand('custom-tool ~/.dsh/storages/workspace.json', context)?.kind, 'dsh-data')
  assert.equal(
    inspectShellCommand('cd ~/.dsh/storages && python3 -c "import json; print(json.load(open(\'workspace.json\')))"', context)?.kind,
    'dsh-data',
  )

  // 普通工具在工作区根路径上运行正常放行
  assert.equal(inspectShellCommand(`git -C "${work}" status`, context), null)
  assert.equal(inspectShellCommand(`pytest "${work}"`, context), null)
})

test('~、$HOME、$DSH_HOME、相对路径、符号链接、通配符、嵌套 shell 与 pwsh 全部还原后比对', (t) => {
  const { dshHome, dshWork, work, linksDir, context } = setupEnv(t)

  // ~ / $HOME / ${HOME} / $DSH_HOME
  assert.equal(inspectShellCommand('touch ~/.dsh/storages/new.json', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('touch "$HOME/.dsh/storages/new.json"', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('touch "${HOME}/.dsh/sessions/new-sess"', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('rm -rf "$DSH_HOME/sessions/s1"', context)?.kind, 'dsh-data')

  // 相对路径（包括 cd、..、. 以及 cwd 在工作区自身时）
  assert.equal(inspectShellCommand('cd ../.dsh && rm -rf sessions/s1', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('rm -rf ../dsh_work', { ...context, cwd: work })?.kind, 'workspace-root')
  assert.equal(inspectShellCommand('rm -rf .', { ...context, cwd: dshWork })?.kind, 'workspace-root')

  // 符号链接（含指向目录及悬空链接）
  assert.equal(inspectShellCommand(`touch "${join(linksDir, 'to-storages', 'x.json')}"`, context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand(`mkdir -p "${join(linksDir, 'to-sessions', 'new-dir')}"`, context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand(`echo x > "${join(linksDir, 'dangling-storage')}"`, context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand(`rm -rf "${join(linksDir, 'to-dsh-work')}"`, context)?.kind, 'workspace-root')
  assert.equal(inspectShellCommand(`mv "${join(linksDir, 'to-dsh-work')}" "${join(linksDir, 'renamed')}"`, context)?.kind, 'workspace-root')

  // canonicalizePath 对悬空链接同样解析到真实目标
  assert.equal(
    canonicalizePath(join(linksDir, 'dangling-storage'), context),
    join(dshHome, 'storages', 'nonexistent.json'),
  )
  assert.equal(
    classifyPathTarget(join(linksDir, 'dangling-storage'), 'write', context)?.kind,
    'dsh-data',
  )

  // 通配符、命令替换与嵌套 shell
  assert.equal(inspectShellCommand('rm -rf ~/.dsh/*', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand(`rm -rf "${context.cwd}/dsh_*"`, context)?.kind, 'workspace-root')
  assert.equal(inspectShellCommand("sudo bash -c 'rm -rf ~/.dsh/sessions/s1'", context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('echo "$(rm -rf ~/.dsh/sessions/s1)"', context)?.kind, 'dsh-data')

  // PowerShell (pwsh)
  assert.equal(inspectShellCommand(`Remove-Item "${dshWork}" -Recurse -Force`, context, { shell: 'pwsh' })?.kind, 'workspace-root')
  assert.equal(inspectShellCommand('Set-Content ~/.dsh/storages/workspace.json "{}"', context, { shell: 'pwsh' })?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('Get-Content ~/.dsh/storages/workspace.json', context, { shell: 'pwsh' }), null)
})

test('访达只在移走登记根目录时询问', t => {
  const { work, context } = setupEnv(t)
  const finder = (action, file) => `osascript -e 'tell application "Finder" to ${action} POSIX file "${file}"'`
  assert.equal(inspectShellCommand(finder('delete', work), context)?.kind, 'workspace-root')
  assert.equal(inspectShellCommand(finder('delete', join(work, 'draft')), context), null)
  assert.equal(inspectShellCommand(finder('reveal', work), context), null)
})

test('xargs 将可见的标准输入作为子命令参数', t => {
  const { work, context } = setupEnv(t)
  for (const [command, kind] of [
    ['xargs rm -rf <<< ~/.dsh/sessions', 'dsh-data'],
    [`printf '%s\\0' "${work}" | xargs -0 -I {} mv {} archive`, 'workspace-root'],
    [`xargs -I {} mv {} archive <<'PATHS'\n${work}\nPATHS`, 'workspace-root'],
    ['printf "%s\\n" ~/.dsh/sessions | xargs cat', null],
    ['xargs rm -rf <<< draft', null],
  ]) assert.equal(inspectShellCommand(command, context)?.kind ?? null, kind, command)
})

test('git 按实际工作目录及清理范围判断，预演和工作区内部清理放行', t => {
  const { work, context } = setupEnv(t)
  for (const [command, kind] of [
    ['git -C ~/.dsh clean -fdx', 'dsh-data'],
    ['git -C ~/.dsh -C storages add workspace.json', 'dsh-data'],
    ['git -C ~/.dsh clean -ndx', null],
    ['git -C ~/.dsh clean -fd -- scratch/', null],
    ['git -C ~/.dsh clean -fd -- sessions/', 'dsh-data'],
    [`git -C "${work}" clean -fdx`, null],
    [`git clean -fd -- "${work}"`, 'workspace-root'],
  ]) assert.equal(inspectShellCommand(command, context)?.kind ?? null, kind, command)
})

test('物理路径中的上一级按符号链接的目标计算', t => {
  const { linksDir, sessions, context } = setupEnv(t)
  symlinkSync(join(sessions, '--Users-alice-Documents-work--'), join(linksDir, 'session'))
  const path = join(linksDir, 'session') + '/../new-note'
  assert.equal(canonicalizePath(path, context), join(sessions, 'new-note'))
  assert.equal(inspectShellCommand(`touch "${path}"`, context)?.kind, 'dsh-data')
})

test('循环与带引号的赋值保留已知目录', t => {
  const { work, context } = setupEnv(t)
  for (const command of [
    'target="$DSH_HOME/sessions"; touch "$target/note"',
    'for folder in "$DSH_HOME/sessions"; do touch "$folder/note"; done',
    'for folder in scratch "$DSH_HOME/sessions"; do touch "$folder/note"; done',
  ]) assert.equal(inspectShellCommand(command, context)?.kind, 'dsh-data', command)
  assert.equal(inspectShellCommand(`target="${work}"; touch "$target/note"`, context), null)
})

test('子进程改目录不会改变下一条命令的位置', t => {
  const { work, storages, context } = setupEnv(t)
  for (const command of [
    `(cd "${work}" && ls); touch note`,
    `env -C "${work}" ls; touch note`,
    `cd "${work}" | cat; touch note`,
    `bash -c 'cd "${work}"'; touch note`,
  ]) assert.equal(inspectShellCommand(command, { ...context, cwd: storages })?.kind, 'dsh-data', command)
})

test('find 批量处理普通文件与清理整个目录的范围不同', t => {
  const { work, context } = setupEnv(t)
  assert.equal(inspectShellCommand('find . -type f -print0 | xargs -0 rm', { ...context, cwd: work }), null)
  assert.equal(inspectShellCommand('find ~/.dsh -type f -delete', context)?.kind, 'dsh-data')
  assert.equal(inspectShellCommand('find . -delete -type f', { ...context, cwd: work })?.kind, 'workspace-root')
})

test('文件描述符复制保持只读，文件重定向仍要检查目标', t => {
  const { storages, context } = setupEnv(t)
  const local = { ...context, cwd: storages }
  assert.equal(inspectShellCommand('ls 2>&1', local), null)
  assert.equal(inspectShellCommand('echo note >& saved', local)?.kind, 'dsh-data')
})

test('命令前缀的变量只在该命令的环境中生效', t => {
  const { context } = setupEnv(t)
  const cmd = 'dir="$DSH_HOME/sessions"; dir=scratch env; touch "$dir/note"'
  assert.equal(inspectShellCommand(cmd, context)?.kind, 'dsh-data')
})

test('无法确认的通配范围需要确认，工作区内的普通文件仍放行', t => {
  const { work, context } = setupEnv(t)
  const pattern = '{first,second}/*'
  assert.equal(classifyPathTarget('notes{draft}', 'write', { ...context, cwd: context.home }), null)
  assert.ok(classifyPathTarget('~/.dsh/{storages,sessions}/log', 'write', context))
  assert.equal(classifyPathTarget(join(work, 'drafts', pattern), 'write', context), null)
})

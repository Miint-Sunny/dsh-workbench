import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { appLaunchEnv, relaunchDsh } from '../lib/workspace-move-launch.js'
import { tempDir } from './helpers/temp-dir.mjs'

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

test('重开桌面 App 用的环境只带 launchd 给 App 的那几项，PATH 用 launchd 的值', () => {
  const env = appLaunchEnv({
    HOME: '/Users/a', USER: 'a', LOGNAME: 'a', SHELL: '/bin/zsh', TMPDIR: '/tmp/x/', SSH_AUTH_SOCK: '/tmp/ssh.sock',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x19:0x34', PATH: '/opt/homebrew/bin:/usr/bin',
    ELECTRON_RUN_AS_NODE: '1', NODE_CHANNEL_FD: '3', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://127.0.0.1:9', CLAUDECODE: '1', DSH_CLIENT_VERSION: '0.2.2',
  })
  assert.deepEqual(env, {
    HOME: '/Users/a', USER: 'a', LOGNAME: 'a', SHELL: '/bin/zsh', TMPDIR: '/tmp/x/', SSH_AUTH_SOCK: '/tmp/ssh.sock',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x19:0x34', PATH: LAUNCHD_PATH,
  })
})

test('重开桌面 App 用的环境：调用方没有的项不补，空值不带', () => {
  assert.deepEqual(appLaunchEnv({ HOME: '/Users/a', SSH_AUTH_SOCK: '' }), { HOME: '/Users/a', PATH: LAUNCHD_PATH })
})

test('open -a 重开时，新开的 App 拿不到宿主的 ELECTRON_RUN_AS_NODE 和其他变量', { skip: process.platform !== 'darwin' && 'open -a 只在 macOS 上有' }, async () => {
  const dir = await tempDir('dwb-move-relaunch-env-')
  const app = join(dir, 'EnvProbe.app')
  const out = join(dir, 'env.txt')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleExecutable</key><string>probe</string>',
    '<key>CFBundleIdentifier</key><string>local.dsh-workbench.test.relaunch-env</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>LSBackgroundOnly</key><true/>',
    '</dict></plist>', ''].join('\n'))
  const probe = join(app, 'Contents', 'MacOS', 'probe')
  writeFileSync(probe, `#!/bin/sh\nenv > '${out}.part' && mv '${out}.part' '${out}'\n`)
  chmodSync(probe, 0o755)

  const result = await relaunchDsh({ kind: 'open-app', app }, { dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DWB_RELAUNCH_PROBE: 'leak' } })
  assert.equal(result.relaunched, 'open-app')
  for (let i = 0; i < 80 && !(existsSync(out) && statSync(out).size > 0); i++) await sleep(250)
  const names = readFileSync(out, 'utf8').split('\n').map(line => line.split('=')[0])
  assert.ok(names.includes('HOME'), '新开的 App 应当有 HOME')
  assert.ok(!names.includes('ELECTRON_RUN_AS_NODE'), '带上它，DSH 会以 Node 方式启动后立刻退出')
  assert.ok(!names.includes('DWB_RELAUNCH_PROBE'), '调用方的其他变量不该带过去')
})

test('按命令重开时照旧带调用方的环境（web、终端里的 DSH 靠它运行）', async () => {
  const dir = await tempDir('dwb-move-relaunch-cmd-')
  const marker = join(dir, 'seen.txt')
  const result = await relaunchDsh(
    { kind: 'command', file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.DWB_RELAUNCH_PROBE || '')`], cwd: dir },
    { dir, env: { ...process.env, DWB_RELAUNCH_PROBE: 'kept' } },
  )
  assert.equal(result.relaunched, 'command')
  assert.equal(typeof result.relaunchedPid, 'number')
  for (let i = 0; i < 80 && !existsSync(marker); i++) await sleep(100)
  assert.equal(readFileSync(marker, 'utf8'), 'kept')
})

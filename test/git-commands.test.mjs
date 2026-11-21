import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, gitCommandMessage, gitCommandsConfig } from '../lib/git-commands.js'

function registered(options) {
  const commands = new Map()
  apply({ commands: { register: definition => commands.set(definition.name, definition) } }, options)
  return commands
}

function run(definition, rawInput = '') {
  const sent = []
  const result = definition.handler({ agent: { followup: message => sent.push(message) }, rawInput })
  return { result, sent }
}

test('四条命令都发一条普通用户消息，补充说明跟在后面', () => {
  const commands = registered()
  assert.deepEqual([...commands.keys()], ['commit', 'push', 'pr', 'fix-ci'])
  const { result, sent } = run(commands.get('commit'), '  只提交 README \n')
  assert.deepEqual(result, { kind: 'success' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.deepEqual(sent[0].source, { kind: 'user' })
  assert.match(sent[0].content[0].text, /^提交本会话的变更。[^]*不要推送。\n\n补充说明：只提交 README$/)
})

test('pr 的消息和官方按钮发的一样，没有补充说明时不多加内容', () => {
  assert.equal(run(registered().get('pr')).sent[0].content[0].text, '为本会话的变更创建变更请求')
})

test('修复检查要读失败日志，推送不允许强制', () => {
  const commands = registered()
  assert.match(run(commands.get('fix-ci')).sent[0].content[0].text, /gh run view --log-failed/)
  assert.match(run(commands.get('push')).sent[0].content[0].text, /不要强制推送/)
})

test('输入只留在用户消息里，命令事件不重复记录', () => {
  for (const definition of registered().values()) assert.equal(definition.recordInput, false)
})

test('英文配置换一份文案，配错了拒绝加载', () => {
  const commands = registered({ locale: 'en' })
  assert.equal(commands.get('push').description, 'Push the current branch')
  assert.match(run(commands.get('commit'), 'only the README').sent[0].content[0].text, /Do not push\.\n\nNotes: only the README$/)
  assert.throws(() => gitCommandsConfig({ locale: 'ja' }), /locale/)
  assert.throws(() => gitCommandsConfig({ names: [] }), /unknown field names/)
  assert.throws(() => gitCommandsConfig(null), /must be an object/)
})

test('空白的补充说明等于没有', () => {
  assert.equal(gitCommandMessage('固定', '补充：', ' \n '), '固定')
})

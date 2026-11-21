import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const directory = new URL('../src/client/', import.meta.url)
function declaredClasses(file) {
  const source = readFileSync(new URL(file, directory), 'utf8')
  const styles = [...source.matchAll(/const\s+[A-Z_]*(?:STYLE|CSS)[A-Z_]*\s*=\s*`([\s\S]*?)`/g)].map(match => match[1]).join('\n')
  return new Set([...styles.matchAll(/\.(dwb-[\w-]+)/g)].map(match => match[1]))
}

test('新标签页和命令面板的样式类不覆盖其他功能的样式表', () => {
  const files = readdirSync(directory).filter(file => file.endsWith('.js'))
  const classes = new Map(files.map(file => [file, declaredClasses(file)]))
  const collisions = []
  for (const owner of ['new-tab.js', 'command-palette.js']) {
    for (const [file, names] of classes) {
      if (file === owner) continue
      for (const name of classes.get(owner)) if (names.has(name)) collisions.push({ owner, file, name })
    }
  }
  assert.deepEqual(collisions, [])
})

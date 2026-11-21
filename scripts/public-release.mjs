/** Export the git-tracked files of the manifest that owns npm file lists as a standalone source tree. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privacyFindings } from './privacy.mjs'

const scriptRoot = fileURLToPath(new URL('..', import.meta.url))
const json = path => JSON.parse(readFileSync(path, 'utf8'))

function safePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => ['..', '.git', 'node_modules'].includes(part)) || path.includes('\\')) throw new Error(`Unsafe public path: ${path}`)
  return path
}

/** Read the single manifest and check each package.json against its npm file selection. */
export function readPublicManifest(root, { sync = false } = {}) {
  const manifest = json(join(root, 'public-files.json'))
  if (manifest.version !== 1 || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.directory) || !Array.isArray(manifest.sourceFiles) || !manifest.packageFiles || !Object.keys(manifest.packageFiles).length) throw new Error('Invalid public-files.json')
  for (const [directory, files] of Object.entries(manifest.packageFiles)) {
    safePath(directory)
    if (!Array.isArray(files) || !files.length) throw new Error(`No npm files for ${directory}`)
    files.forEach(safePath)
    const path = join(root, directory, 'package.json'), pkg = json(path)
    if (JSON.stringify(pkg.files) !== JSON.stringify(files)) {
      if (!sync) throw new Error(`${directory}/package.json files differ from public manifest; run npm run public:sync`)
      pkg.files = files
      writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
    }
  }
  return manifest
}

// An inherited GIT_DIR (git sets it for hooks) would make `git -C root` read another repository.
function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  })
}

/** Paths in the git index under root; files git does not track are never read. */
function trackedFiles(root) {
  const result = git(root, ['ls-files', '-z'])
  if (result.status !== 0) throw new Error(`Public files must come from a git checkout: ${result.error?.message ?? result.stderr.trim()}`)
  return result.stdout.split('\0').filter(Boolean)
}

/** Select tracked files under declared entries and reject symlinks, including symlinked parent directories. */
export function publicFiles(root, manifest = readPublicManifest(root)) {
  const tracked = trackedFiles(root), files = new Set()
  function select(path, { buildOutput = false } = {}) {
    safePath(path)
    const entry = path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.', prefix = entry === '.' ? '' : entry + '/'
    const selected = tracked.filter(file => file === entry || file.startsWith(prefix))
    // npm `files` may name a build output that .gitignore excludes, such as lib/, absent until a clean clone is built.
    // The trailing-slash form lets a `lib/` pattern match the directory before it exists.
    if (!selected.length && !(buildOutput && git(root, ['check-ignore', '--', entry, entry + '/']).status === 0)) {
      throw new Error(`Public entry has no file tracked by git${buildOutput ? ' and is not an ignored build output' : ''}: ${path}`)
    }
    for (const file of selected) {
      safePath(file)
      let cursor = root
      for (const part of file.split('/')) {
        cursor = join(cursor, part)
        if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Public symlink is not allowed: ${file}`)
      }
      if (!lstatSync(cursor).isFile()) throw new Error(`Public entry is not a regular file: ${file}`)
      files.add(file)
    }
  }
  for (const path of manifest.sourceFiles) select(path)
  for (const [directory, entries] of Object.entries(manifest.packageFiles)) {
    const inPackage = path => directory === '.' ? path : `${directory}/${path}`
    select(inPackage('package.json'))
    for (const path of entries) select(inPackage(path), { buildOutput: true })
  }
  return [...files].sort()
}

/** Inspect selected bytes; a missing file is an error, never a skipped check. */
export function scanPublic(root, files = publicFiles(root)) {
  return files.flatMap(file => [
    ...privacyFindings(Buffer.from(file), file),
    ...privacyFindings(readFileSync(join(root, file)), file),
  ])
}

/** Copy a privacy-checked selection into a new directory; existing exports are preserved. */
export function exportPublic({ root = scriptRoot, destination } = {}) {
  root = resolve(root)
  const manifest = readPublicManifest(root)
  destination = resolve(destination ?? join(homedir(), 'code/dsh-plugins/.public', manifest.directory))
  if (destination === root || relative(root, destination).split(/[\\/]/)[0] !== '..') throw new Error('Export must be outside the source directory')
  if (existsSync(destination)) throw new Error('Export destination already exists; move it aside before exporting again')
  const files = publicFiles(root, manifest), findings = scanPublic(root, files)
  if (findings.length) throw new Error(findings.map(item => `${item.file}:${item.line}: ${item.rule}`).join('\n'))
  mkdirSync(destination, { recursive: true })
  for (const file of files) {
    const output = join(destination, file)
    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(join(root, file), output)
  }
  return { destination, files: files.length, findings: 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = 'export', target] = process.argv.slice(2)
    if (command === 'export') console.log(JSON.stringify(exportPublic({ destination: target })))
    else if (command === 'sync') { readPublicManifest(scriptRoot, { sync: true }); console.log('npm files match public-files.json') }
    else if (command === 'check' || command === 'privacy') {
      const root = target ? resolve(target) : scriptRoot
      const files = publicFiles(root), findings = scanPublic(root, files)
      for (const item of findings) console.error(`${item.file}:${item.line}: ${item.rule}`)
      console.log(JSON.stringify({ files: files.length, findings: findings.length }))
      if (findings.length) process.exitCode = 1
    } else throw new Error('Usage: public-release.mjs export [destination] | check [source] | privacy [source] | sync')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

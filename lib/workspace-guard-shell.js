/**
 * Shell 命令分析器（feat#188）：解析 bash 与 PowerShell 命令、展开常见变量、追踪 cd，
 * 识别只读命令、移动/删除/写入命令，以及难以静态断定的脚本或未知命令。
 * 本模块只使用 Node 内置模块，不依赖 @deepseek-ai 包。
 */
import { basename, isAbsolute, resolve } from 'node:path'
import { buildProtectedContext, canonicalizePath, classifyPathTarget, expandPathVars } from './workspace-guard-paths.js'

const READONLY_COMMANDS = new Set([
  'ls', 'dir', 'vdir', 'tree', 'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'bat',
  'stat', 'file', 'wc', 'du', 'df', 'pwd', 'realpath', 'readlink', 'dirname', 'basename',
  'echo', 'printf', 'true', 'false', ':', 'test', '[', '[[',
  'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'md5', 'md5sum', 'cksum', 'b2sum',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'diff', 'cmp', 'comm',
  'cut', 'tr', 'fold', 'fmt', 'column', 'paste', 'join', 'rev', 'od', 'hexdump', 'strings',
  'lsof', 'ps', 'pgrep', 'date', 'uname', 'id', 'whoami', 'hostname', 'which', 'type', 'whereis',
  'printenv', 'set', 'unset', 'wait', 'sleep', 'seq', 'yes', 'expr', 'bc', 'jq',
  'zcat', 'gzcat', 'bzcat', 'xzcat', 'zstdcat',
])

const MOVE_DELETE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'srm', 'shred', 'trash', 'rmtrash', 'mv', 'rename',
])

const WRITE_COMMANDS = new Set([
  'cp', 'install', 'rsync', 'ditto', 'ln', 'touch', 'mkdir', 'truncate', 'dd', 'tee',
  'chmod', 'chown', 'chgrp', 'chflags', 'patch', 'unzip', 'zip', 'sqlite3',
])

const WRAPPERS = new Set([
  'command', 'builtin', 'exec', 'nohup', 'nice', 'ionice', 'timeout', 'time', 'caffeinate',
  'sudo', 'doas', 'env',
])

const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh'])

const SCRIPT_INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'osascript', 'swift',
])

const MUTATING_SCRIPT_VERBS = /\b(?:rmtree|move|rename|replace|remove|rmdir|unlink|rmSync|renameSync|rmdirSync|unlinkSync|fs\.rm|fs\.rmdir|fs\.rename|fs\.unlink)\b/

// One synchronous inspection shares these limits across substitutions, pipelines and loop values.
const MAX_COMMAND_CHARS = 128 * 1024
const MAX_NESTING = 32
const INSPECTION_LIMIT = Symbol('inspection-limit')
const unverified = () => ({ kind: 'unverified', target: '' })

function charge(state, amount) {
  state.budget.left -= amount
  if (state.budget.left < 0 || performance.now() > state.budget.deadline) throw INSPECTION_LIMIT
}

function childState(state) {
  return {
    ...state, dirStack: [...state.dirStack],
    varEnv: new Map(state.varEnv), loopCandidates: new Map(state.loopCandidates),
  }
}

const IGNORED_REDIR_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '-'])

/** 词法分析：将 bash 脚本拆成词、操作符、重定向与 heredoc 正文。 */
function tokenizeShell(input) {
  const tokens = []
  const pendingHeredocs = []
  let i = 0
  const len = input.length

  function readCommandSub(startIdx, level = 1) {
    if (level > MAX_NESTING) throw INSPECTION_LIMIT
    // startIdx points right after '$('
    let pos = startIdx
    let depth = 1
    let body = ''
    while (pos < len && depth > 0) {
      const ch = input[pos]
      if (ch === '\\' && pos + 1 < len) {
        body += ch + input[pos + 1]
        pos += 2
        continue
      }
      if (ch === "'") {
        const end = input.indexOf("'", pos + 1)
        const sliceEnd = end === -1 ? len : end + 1
        body += input.slice(pos, sliceEnd)
        pos = sliceEnd
        continue
      }
      if (ch === '"') {
        let q = pos + 1
        body += '"'
        while (q < len && input[q] !== '"') {
          if (input[q] === '\\' && q + 1 < len) {
            body += input[q] + input[q + 1]
            q += 2
          } else if (input[q] === '$' && input[q + 1] === '(') {
            const sub = readCommandSub(q + 2, level + 1)
            body += '$(' + sub.body + ')'
            q = sub.nextPos
          } else {
            body += input[q++]
          }
        }
        if (q < len) { body += '"'; q++ }
        pos = q
        continue
      }
      if (ch === '$' && input[pos + 1] === '(') {
        depth++
        body += '$('
        pos += 2
        continue
      }
      if (ch === ')') {
        depth--
        if (depth === 0) { pos++; break }
        body += ')'
        pos++
        continue
      }
      body += ch
      pos++
    }
    return { body, nextPos: pos }
  }

  function readBacktickSub(startIdx) {
    let pos = startIdx
    let body = ''
    while (pos < len) {
      const ch = input[pos]
      if (ch === '\\' && pos + 1 < len) {
        body += input[pos + 1]
        pos += 2
        continue
      }
      if (ch === '`') { pos++; break }
      body += ch
      pos++
    }
    return { body, nextPos: pos }
  }

  function readWord() {
    const parts = []
    let literal = ''
    let raw = ''
    let quoted = false
    const flushText = () => {
      if (literal) {
        parts.push({ kind: 'text', value: literal })
        literal = ''
      }
    }

    while (i < len) {
      const ch = input[i]
      if (/[ \t\r\n;|&()<>]/.test(ch)) break
      if (ch === '#' && raw === '') break
      if (ch === '\\') {
        raw += ch
        i++
        if (i < len) {
          if (input[i] === '\n') { i++; raw += '\n'; continue }
          literal += input[i]
          raw += input[i]
          i++
        }
        continue
      }
      if (ch === "'") {
        quoted = true
        i++
        const start = i
        while (i < len && input[i] !== "'") i++
        const seg = input.slice(start, i)
        literal += seg
        raw += `'${seg}'`
        if (i < len) i++
        continue
      }
      if (ch === '$' && input[i + 1] === "'") {
        quoted = true
        i += 2
        let seg = ''
        while (i < len && input[i] !== "'") {
          if (input[i] === '\\' && i + 1 < len) {
            seg += input[i + 1]
            i += 2
          } else {
            seg += input[i++]
          }
        }
        literal += seg
        raw += `$'${seg}'`
        if (i < len) i++
        continue
      }
      if (ch === '"') {
        quoted = true
        raw += '"'
        i++
        while (i < len && input[i] !== '"') {
          const dch = input[i]
          if (dch === '\\' && i + 1 < len && /[$`"\\\n]/.test(input[i + 1])) {
            raw += dch + input[i + 1]
            if (input[i + 1] !== '\n') literal += input[i + 1]
            i += 2
          } else if (dch === '$' && input[i + 1] === '(') {
            flushText()
            const sub = readCommandSub(i + 2)
            parts.push({ kind: 'cmdsub', body: sub.body })
            raw += `$(${sub.body})`
            i = sub.nextPos
          } else if (dch === '`') {
            flushText()
            const sub = readBacktickSub(i + 1)
            parts.push({ kind: 'cmdsub', body: sub.body })
            raw += `\`${sub.body}\``
            i = sub.nextPos
          } else if (dch === '$') {
            const v = readDollarVar()
            flushText()
            parts.push(v.part)
            raw += v.raw
          } else {
            literal += dch
            raw += dch
            i++
          }
        }
        if (i < len) { raw += '"'; i++ }
        continue
      }
      if (ch === '$' && input[i + 1] === '(') {
        flushText()
        const sub = readCommandSub(i + 2)
        parts.push({ kind: 'cmdsub', body: sub.body })
        raw += `$(${sub.body})`
        i = sub.nextPos
        continue
      }
      if (ch === '`') {
        flushText()
        const sub = readBacktickSub(i + 1)
        parts.push({ kind: 'cmdsub', body: sub.body })
        raw += `\`${sub.body}\``
        i = sub.nextPos
        continue
      }
      if (ch === '$') {
        const v = readDollarVar()
        flushText()
        parts.push(v.part)
        raw += v.raw
        continue
      }
      literal += ch
      raw += ch
      i++
    }
    flushText()
    return { type: 'word', raw, parts, quoted }
  }

  function readDollarVar() {
    if (input[i + 1] === '{') {
      const end = input.indexOf('}', i + 2)
      if (end !== -1) {
        const inner = input.slice(i + 2, end)
        const name = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
        const raw = input.slice(i, end + 1)
        i = end + 1
        return {
          raw,
          part: name ? { kind: 'var', name, raw } : { kind: 'text', value: raw },
        }
      }
    }
    const m = input.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/)
    if (m) {
      const raw = '$' + m[1]
      i += raw.length
      return { raw, part: { kind: 'var', name: m[1], raw } }
    }
    i++
    return { raw: '$', part: { kind: 'text', value: '$' } }
  }

  function consumePendingHeredocs() {
    while (pendingHeredocs.length > 0 && i < len) {
      const spec = pendingHeredocs.shift()
      let body = ''
      while (i < len) {
        const nl = input.indexOf('\n', i)
        const line = nl === -1 ? input.slice(i) : input.slice(i, nl)
        i = nl === -1 ? len : nl + 1
        const candidate = spec.stripTabs ? line.replace(/^\t+/, '') : line
        if (candidate === spec.delim) break
        body += line + '\n'
      }
      spec.token.body = body
    }
  }

  while (i < len) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    if (ch === '\n') {
      tokens.push({ type: 'op', value: '\n' })
      i++
      consumePendingHeredocs()
      continue
    }
    if (ch === '#') {
      const nl = input.indexOf('\n', i)
      i = nl === -1 ? len : nl
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      if (ch === ';' && input[i + 1] === ';') {
        const op = input[i + 2] === '&' ? ';;&' : ';;'
        tokens.push({ type: 'op', value: op })
        i += op.length
      } else if (ch === ';' && input[i + 1] === '&') {
        tokens.push({ type: 'op', value: ';&' })
        i += 2
      } else if (ch === '&' && (input[i + 1] === '>' || input[i + 1] === '&')) {
        if (input[i + 1] === '&') { tokens.push({ type: 'op', value: '&&' }); i += 2 }
        else if (input[i + 2] === '>') { tokens.push({ type: 'redir', op: '&>>' }); i += 3 }
        else { tokens.push({ type: 'redir', op: '&>' }); i += 2 }
      } else if (ch === '|' && (input[i + 1] === '|' || input[i + 1] === '&')) {
        tokens.push({ type: 'op', value: input.slice(i, i + 2) })
        i += 2
      } else {
        tokens.push({ type: 'op', value: ch })
        i++
      }
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }
    if ((ch === '{' || ch === '}') && (i + 1 >= len || /[ \t\r\n;|&()]/.test(input[i + 1]))) {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }
    // Optional fd prefix on redirections: 2> / 1>> / etc.
    const fdMatch = input.slice(i).match(/^(\d+)(>>|>&|>\|?|<>|<&|<<<|<<-?|<)/)
    if (fdMatch) {
      const op = fdMatch[2]
      i += fdMatch[0].length
      if (op === '<<' || op === '<<-') {
        while (i < len && (input[i] === ' ' || input[i] === '\t')) i++
        const delimWord = readWord()
        const token = { type: 'heredoc', op, body: '' }
        tokens.push(token)
        pendingHeredocs.push({ delim: wordTextStatic(delimWord), stripTabs: op === '<<-', token })
      } else {
        tokens.push({ type: 'redir', op, fd: Number(fdMatch[1]) })
      }
      continue
    }
    if (ch === '>' || ch === '<') {
      const rest = input.slice(i)
      if (rest.startsWith('<<<')) { tokens.push({ type: 'redir', op: '<<<' }); i += 3 }
      else if (rest.startsWith('<<-') || rest.startsWith('<<')) {
        const op = rest.startsWith('<<-') ? '<<-' : '<<'
        i += op.length
        while (i < len && (input[i] === ' ' || input[i] === '\t')) i++
        const delimWord = readWord()
        const token = { type: 'heredoc', op, body: '' }
        tokens.push(token)
        pendingHeredocs.push({ delim: wordTextStatic(delimWord), stripTabs: op === '<<-', token })
      } else if (rest.startsWith('>>') || rest.startsWith('>|') || rest.startsWith('<>') || rest.startsWith('>&') || rest.startsWith('<&')) {
        tokens.push({ type: 'redir', op: rest.slice(0, 2) })
        i += 2
      } else {
        tokens.push({ type: 'redir', op: ch })
        i++
      }
      continue
    }
    tokens.push(readWord())
  }
  return tokens
}

function wordTextStatic(word) {
  if (!word) return ''
  return word.parts.map(part => (part.kind === 'text' ? part.value : part.kind === 'var' ? part.raw : '')).join('')
}

function collectWordCmdSubs(word, out) {
  if (!word?.parts) return
  for (const part of word.parts) {
    if (part.kind === 'cmdsub') out.push(part.body)
  }
}

function expandWord(word, varEnv, context) {
  if (!word) return { text: '', dynamic: false }
  let text = ''
  let dynamic = false
  for (let idx = 0; idx < word.parts.length; idx++) {
    const part = word.parts[idx]
    if (part.kind === 'text') {
      text += part.value
    } else if (part.kind === 'cmdsub') {
      dynamic = true
      text += '__sub__'
    } else if (part.kind === 'var') {
      if (part.name === 'HOME' || part.name === 'DSH_HOME' || part.name === 'PWD') {
        text += expandPathVars('$' + part.name, { home: context.home, dshHome: context.dshHome, cwd: context.cwd, env: context.env })
      } else if (varEnv.has(part.name)) {
        const entry = varEnv.get(part.name)
        if (entry.dynamic) { dynamic = true; text += '__var__' }
        else text += entry.value
      } else {
        dynamic = true
        text += '__var__'
      }
    }
    if (text.length > MAX_COMMAND_CHARS) throw INSPECTION_LIMIT
  }
  if (context.budget) {
    context.budget.chars -= text.length
    if (context.budget.chars < 0) throw INSPECTION_LIMIT
  }
  return { text, dynamic }
}

/** 将 token 流切分成若干个 pipeline（按 ;、\n、&&、||、& 分隔），识别 for/case 关键结构。 */
function inspectTokens(tokens, state) {
  let idx = 0
  let inCase = false
  let expectCasePattern = false
  const caseStack = []

  const atEnd = () => idx >= tokens.length

  function skipCasePattern() {
    while (!atEnd()) {
      const tok = tokens[idx++]
      if (tok.type === 'op' && tok.value === ')') {
        expectCasePattern = false
        return
      }
      if (tok.type === 'word' && wordTextStatic(tok) === 'esac' && !tok.quoted) {
        inCase = caseStack.pop() ?? false
        expectCasePattern = false
        return
      }
    }
  }

  function nextSimpleCommand() {
    const words = []
    const redirs = []
    const heredocs = []
    let separator = ''

    while (!atEnd()) {
      const tok = tokens[idx]
      if (tok.type === 'op') {
        if (tok.value === '|' || tok.value === '|&') {
          idx++
          separator = tok.value
          break
        }
        if (tok.value === ';' || tok.value === '\n' || tok.value === '&' || tok.value === '&&' || tok.value === '||' || tok.value === '(' || tok.value === ')' || tok.value === '{' || tok.value === '}') {
          separator = tok.value
          idx++
          break
        }
        if (tok.value === ';;' || tok.value === ';&' || tok.value === ';;&') {
          idx++
          if (inCase) expectCasePattern = true
          break
        }
        idx++
        continue
      }
      if (tok.type === 'redir') {
        idx++
        const target = tokens[idx]?.type === 'word' ? tokens[idx++] : null
        redirs.push({ op: tok.op, fd: tok.fd, target })
        continue
      }
      if (tok.type === 'heredoc') {
        idx++
        heredocs.push(tok.body ?? '')
        continue
      }
      if (tok.type === 'word') {
        const plain = wordTextStatic(tok)
        // 控制关键字单独拆出
        if (words.length === 0 && !tok.quoted) {
          if (plain === 'if' || plain === 'then' || plain === 'elif' || plain === 'else' || plain === 'fi' || plain === 'do' || plain === 'done' || plain === 'while' || plain === 'until') {
            idx++
            continue
          }
          if (plain === 'case') {
            idx++
            // skip WORD in
            while (!atEnd()) {
              const t = tokens[idx++]
              if (t.type === 'word' && !t.quoted && wordTextStatic(t) === 'in') break
            }
            caseStack.push(inCase)
            inCase = true
            expectCasePattern = true
            return { kind: 'noop', pipeToNext: false }
          }
          if (plain === 'esac') {
            idx++
            inCase = caseStack.pop() ?? false
            expectCasePattern = false
            return { kind: 'noop', pipeToNext: false }
          }
          if (plain === 'for') {
            return readForLoop()
          }
        }
        words.push(tok)
        idx++
      }
    }
    return { kind: 'simple', words, redirs, heredocs, separator }
  }

  function readForLoop() {
    idx++ // consume 'for'
    const varWord = tokens[idx]?.type === 'word' ? tokens[idx++] : null
    const varName = varWord ? wordTextStatic(varWord) : ''
    const items = []
    if (tokens[idx]?.type === 'word' && !tokens[idx].quoted && wordTextStatic(tokens[idx]) === 'in') {
      idx++ // consume 'in'
      while (!atEnd()) {
        const t = tokens[idx]
        if (t.type === 'op' && (t.value === ';' || t.value === '\n')) { idx++; break }
        if (t.type === 'word' && !t.quoted && wordTextStatic(t) === 'do') break
        if (t.type === 'word') items.push(t)
        idx++
      }
    }
    return { kind: 'for-header', varName, items }
  }

  let pipelineInput
  let inPipeline = false
  const parents = []

  while (!atEnd()) {
    if (expectCasePattern) {
      skipCasePattern()
      continue
    }
    const node = nextSimpleCommand()
    if (node.kind === 'noop') { pipelineInput = undefined; inPipeline = false; continue }
    if (node.kind === 'for-header') {
      if (node.varName) {
        const expandedItems = node.items.map(w => expandWord(w, state.varEnv, state.context))
        const firstNonDyn = expandedItems.find(x => !x.dynamic)
        if (firstNonDyn) state.varEnv.set(node.varName, { value: firstNonDyn.text, dynamic: false })
        else state.varEnv.set(node.varName, { value: '', dynamic: true })
        // 如果列表里所有元素都要检查，依次把它们也作为后续变量候选记下来
        state.loopCandidates.delete(node.varName)
        if (expandedItems.length > 1) {
          state.loopCandidates.set(node.varName, expandedItems)
        }
      }
      pipelineInput = undefined
      inPipeline = false
      continue
    }

    const pipes = node.separator === '|' || node.separator === '|&'
    const local = pipes || inPipeline || node.separator === '&' ? childState(state) : state
    const hit = inspectSimpleCommand(node, local, pipelineInput)
    if (hit) return hit
    pipelineInput = pipes ? pipelineOutput(node.words, local) : undefined
    inPipeline = pipes
    if (node.separator === '(') {
      if (parents.length >= MAX_NESTING) throw INSPECTION_LIMIT
      parents.push(state)
      state = childState(state)
    } else if (node.separator === ')' && parents.length) {
      state = parents.pop()
    }
  }
  return null
}

function inspectSimpleCommand(node, state, pipelineInput) {
  const { words, redirs, heredocs } = node
  const cmdSubs = []
  for (const w of words) collectWordCmdSubs(w, cmdSubs)
  for (const r of redirs) collectWordCmdSubs(r.target, cmdSubs)
  for (const sub of cmdSubs) {
    const hit = inspectCommandText(sub, childState(state))
    if (hit) return hit
  }

  // 1. 先检查写重定向（>，>>，>|，<>，&>，&>>，N>，N>>）
  for (const r of redirs) {
    if (!['>', '>>', '>|', '>&', '<>', '&>', '&>>'].includes(r.op)) continue
    if (!r.target) continue
    const expanded = expandWord(r.target, state.varEnv, currentContext(state)).text
    if (r.op === '>&' && /^(?:\d+-?|-)$/.test(expanded)) continue
    if (IGNORED_REDIR_TARGETS.has(expanded) || /^&\d+$/.test(expanded)) continue
    const hit = classifyPathTarget(expanded, 'write', currentContext(state))
    if (hit) return hit
  }

  // 2. 分离前导 VAR=VAL 赋值
  let pos = words.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw))
  if (pos === -1) pos = words.length
  const callerState = state
  if (pos && pos < words.length) state = childState(state)
  for (const word of words.slice(0, pos)) {
    const name = word.raw.slice(0, word.raw.indexOf('='))
    const value = expandWord(word, state.varEnv, currentContext(state))
    state.varEnv.set(name, { value: value.text.slice(name.length + 1), dynamic: value.dynamic })
    state.loopCandidates.delete(name)
  }
  if (pos === words.length) return null

  for (const redir of redirs) {
    if (redir.fd !== undefined && redir.fd !== 0) continue
    if (redir.op === '<<<' && redir.target) {
      const value = expandWord(redir.target, state.varEnv, currentContext(state))
      pipelineInput = value.dynamic ? undefined : { text: value.text + '\n' }
    } else if (redir.op === '<') pipelineInput = undefined
  }
  if (heredocs.length) pipelineInput = { text: heredocs.at(-1) }
  const argvWords = words.slice(pos)
  const argvList = expandArgvWithLoops(argvWords, callerState)
  for (const argv of argvList) {
    const hit = inspectArgv(argv, heredocs, state, pipelineInput)
    if (hit) return hit
  }
  return null
}

function* expandArgvWithLoops(argvWords, state) {
  if (!state.loopCandidates.size) {
    const ctx = currentContext(state)
    yield argvWords.map(w => expandWord(w, state.varEnv, ctx).text)
    return
  }
  const names = new Set(argvWords.flatMap(w => w.parts.filter(p => p.kind === 'var').map(p => p.name)))
  const loops = [...names].filter(name => state.loopCandidates.has(name))
  if (loops.length > MAX_NESTING) throw INSPECTION_LIMIT
  const env = loops.length ? new Map(state.varEnv) : state.varEnv
  const ctx = currentContext(state)
  function* variants(index) {
    if (index === loops.length) {
      charge(state, argvWords.length)
      yield argvWords.map(w => expandWord(w, env, ctx).text)
      return
    }
    const name = loops[index]
    for (const item of state.loopCandidates.get(name)) {
      env.set(name, { value: item.text, dynamic: item.dynamic })
      yield* variants(index + 1)
    }
  }
  yield* variants(0)
}

function currentContext(state) {
  return { ...state.context, cwd: state.currentCwd }
}

function inspectArgv(rawArgv, heredocs, state, pipelineInput) {
  charge(state, rawArgv.length)
  if (state.depth >= MAX_NESTING) throw INSPECTION_LIMIT

  let argv = rawArgv
  let idx = 0

  // 剥离包装器（env, sudo, command, timeout, nice, ...）
  while (idx < argv.length) {
    const base = basename(argv[idx] ?? '')
    if (!WRAPPERS.has(base)) break
    if (base === 'command') {
      idx++
      let queryOnly = false
      while (idx < argv.length && argv[idx].startsWith('-') && argv[idx] !== '--') {
        if (argv[idx].includes('v') || argv[idx].includes('V')) queryOnly = true
        idx++
      }
      if (argv[idx] === '--') idx++
      if (queryOnly) return null
      continue
    }
    if (base === 'env') {
      state = childState(state)
      idx++
      while (idx < argv.length) {
        const a = argv[idx]
        if (a === '--') { idx++; break }
        if (a === '-C' || a === '--chdir') {
          if (argv[idx + 1]) state.currentCwd = canonicalizePath(argv[idx + 1], currentContext(state))
          idx += 2
          continue
        }
        if (a.startsWith('-C')) { state.currentCwd = canonicalizePath(a.slice(2), currentContext(state)); idx++; continue }
        if (a === '-u' || a === '--unset' || a === '-S') { idx += 2; continue }
        if (a.startsWith('-')) { idx++; continue }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { idx++; continue }
        break
      }
      continue
    }
    if (base === 'sudo' || base === 'doas') {
      idx++
      while (idx < argv.length && argv[idx].startsWith('-')) {
        const a = argv[idx]
        if (a === '--') { idx++; break }
        if (['-u', '-g', '-C', '-p', '-h', '-r', '-t'].includes(a)) { idx += 2; continue }
        idx++
      }
      continue
    }
    if (base === 'timeout' || base === 'nice') {
      idx++
      while (idx < argv.length && argv[idx].startsWith('-')) {
        if (['-s', '--signal', '-k', '--kill-after', '-n'].includes(argv[idx])) { idx += 2; continue }
        idx++
      }
      if (base === 'timeout' && argv[idx] && !argv[idx].startsWith('-')) idx++ // duration
      continue
    }
    idx++
    while (idx < argv.length && argv[idx].startsWith('-') && argv[idx] !== '--') idx++
    if (argv[idx] === '--') idx++
  }

  argv = argv.slice(idx)
  if (argv.length === 0) return null

  const cmd = basename(argv[0])
  const args = argv.slice(1)
  const ctx = currentContext(state)

  // cd / pushd / popd：更新当前工作目录
  if (cmd === 'cd' || cmd === 'pushd') {
    const target = args.find(a => !a.startsWith('-')) ?? state.context.home
    if (target && target !== '-') {
      state.dirStack.push(state.currentCwd)
      const expanded = expandPathVars(target, ctx)
      state.currentCwd = isAbsolute(expanded)
        ? resolve(expanded)
        : resolve(state.currentCwd, expanded)
    }
    return null
  }
  if (cmd === 'popd') {
    if (state.dirStack.length > 0) state.currentCwd = state.dirStack.pop()
    return null
  }

  // export / local / readonly / declare / typeset：更新环境映射并放行
  if (cmd === 'export' || cmd === 'local' || cmd === 'readonly' || cmd === 'declare' || cmd === 'typeset') {
    for (const a of args) {
      if (a.startsWith('-')) continue
      const eq = a.indexOf('=')
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.slice(0, eq))) {
        const name = a.slice(0, eq)
        const val = expandPathVars(a.slice(eq + 1), ctx)
        state.varEnv.set(name, { value: val, dynamic: val.includes('__var__') || val.includes('__sub__') })
        state.loopCandidates.delete(name)
      }
    }
    return null
  }

  // eval
  if (cmd === 'eval') {
    return inspectCommandText(args.join(' '), state)
  }

  // 嵌套 shell -c
  if (SHELL_BINS.has(cmd)) {
    // 找第一个包含 -c 的选项（在 '--' 之前）
    let dashC = -1
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--') break
      if (!args[i].startsWith('-')) break
      if (args[i] === '-c' || /^-[^-]*c/.test(args[i])) { dashC = i; break }
    }
    if (dashC !== -1 && args[dashC + 1] !== undefined) {
      return inspectCommandText(args[dashC + 1], childState(state))
    }
    return checkArgsAsWrite(args, ctx)
  }

  // 绝对放行的只读命令
  if (READONLY_COMMANDS.has(cmd)) return null

  // 条件只读：find
  if (cmd === 'find') return inspectFind(args, state, ctx)

  // 条件只读：xargs
  if (cmd === 'xargs') return inspectXargs(args, state, pipelineInput)

  // 条件只读：压缩工具 zstd / gzip / bzip2 / xz
  if (['zstd', 'gzip', 'bzip2', 'xz'].includes(cmd)) return inspectCompressTool(args, ctx)

  // 条件只读：sort / sed / yq / uniq / awk / tar / git / xattr / defaults / plutil
  if (cmd === 'sort') return inspectSort(args, ctx)
  if (cmd === 'sed') return inspectSed(args, ctx)
  if (cmd === 'yq') {
    let inPlace = false
    for (const a of args) {
      if (a === '--') break
      if (a === '-i' || a === '--inplace' || a === '--in-place' || /^-[^-]*i/.test(a)) {
        inPlace = true
        break
      }
    }
    return inPlace ? checkArgsAsWrite(args, ctx) : null
  }
  if (cmd === 'uniq') {
    const { operands } = splitOperands(args, new Set(['-f', '-s', '-w']))
    return operands.length >= 2 ? classifyPathTarget(operands[1], 'write', ctx) : null
  }
  if (['awk', 'gawk', 'mawk', 'nawk'].includes(cmd)) return inspectAwk(args, ctx)
  if (cmd === 'tar') return inspectTar(args, ctx)
  if (cmd === 'git') return inspectGit(args, ctx)
  if (cmd === 'xattr') {
    if (args.some(a => a === '-w' || a === '-d' || a === '-c')) return checkArgsAsWrite(args, ctx)
    return null
  }
  if (cmd === 'defaults') {
    const sub = args.find(a => !a.startsWith('-'))
    if (['read', 'read-type', 'domains', 'find'].includes(sub)) return null
    return checkArgsAsWrite(args, ctx)
  }
  if (cmd === 'plutil') {
    if (args.some(a => a === '-p' || a === '-lint')) return null
    return checkArgsAsWrite(args, ctx)
  }

  // gio trash/remove/move
  if (cmd === 'gio') {
    const sub = args[0]
    if (sub === 'trash' || sub === 'remove') return inspectDeleteOperands(args.slice(1), ctx)
    if (sub === 'move') return inspectMoveOperands(args.slice(1), ctx)
    if (['cat', 'info', 'list', 'tree'].includes(sub)) return null
    return checkArgsAsWrite(args.slice(1), ctx)
  }

  // 移动、改名、删除
  if (cmd === 'mv' || cmd === 'rename') return inspectMoveOperands(args, ctx)
  if (MOVE_DELETE_COMMANDS.has(cmd)) return inspectDeleteOperands(args, ctx)

  // 写入、复制、链接、改属性
  if (WRITE_COMMANDS.has(cmd)) return inspectWriteCommand(cmd, args, ctx)

  // 脚本解释器与未知命令（宁可多问）
  return inspectUnknownOrInterpreter(cmd, args, heredocs, ctx)
}

function splitOperands(args, valueFlags = new Set()) {
  const operands = []
  const flagValues = []
  let endOpts = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (endOpts) { operands.push(a); continue }
    if (a === '--') { endOpts = true; continue }
    if (valueFlags.has(a) && i + 1 < args.length) {
      flagValues.push([a, args[++i]])
      continue
    }
    if (a.startsWith('-')) continue
    operands.push(a)
  }
  return { operands, flagValues }
}

function inspectDeleteOperands(args, ctx) {
  const { operands } = splitOperands(args)
  for (const op of operands) {
    const hit = classifyPathTarget(op, 'move-or-delete', ctx)
    if (hit) return hit
  }
  // 如果当前目录就在 storages/ 或 sessions/ 内且带有相对路径操作数，也拦
  if (operands.some(op => !isAbsolute(expandPathVars(op, ctx)))) {
    const cwdHit = classifyPathTarget('.', 'write', ctx)
    if (cwdHit?.kind === 'dsh-data') return cwdHit
  }
  return null
}

function inspectMoveOperands(args, ctx) {
  let targetDir = null
  let noTargetDir = false
  const operands = []
  let endOpts = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (endOpts) { operands.push(a); continue }
    if (a === '--') { endOpts = true; continue }
    if (a === '-t' || a === '--target-directory') { targetDir = args[++i]; continue }
    if (a.startsWith('--target-directory=')) { targetDir = a.slice('--target-directory='.length); continue }
    if (a === '-T' || a === '--no-target-directory') { noTargetDir = true; continue }
    if (a.startsWith('-')) {
      if (a.includes('T')) noTargetDir = true
      continue
    }
    operands.push(a)
  }
  if (targetDir !== null) {
    for (const src of operands) {
      const hit = classifyPathTarget(src, 'move-or-delete', ctx)
      if (hit) return hit
    }
    return classifyPathTarget(targetDir, 'write', ctx)
  }
  if (operands.length <= 1) {
    return operands[0] ? classifyPathTarget(operands[0], 'move-or-delete', ctx) : null
  }
  const sources = operands.slice(0, -1)
  const dest = operands[operands.length - 1]
  for (const src of sources) {
    const hit = classifyPathTarget(src, 'move-or-delete', ctx)
    if (hit) return hit
  }
  // 目的路径按 move-or-delete 检查（当有 -T 时可能覆盖工作区根路径本身），否则按 write 仅拦 storages/sessions
  return classifyPathTarget(dest, noTargetDir ? 'move-or-delete' : 'write', ctx)
}

function inspectWriteCommand(cmd, args, ctx) {
  const valueFlags = new Set(['-t', '--target-directory', '-o', '--output', '-C'])
  const { operands, flagValues } = splitOperands(args, valueFlags)
  for (const [, val] of flagValues) {
    const hit = classifyPathTarget(val, 'write', ctx)
    if (hit) return hit
  }
  for (const op of operands) {
    if (cmd === 'dd' && (op.startsWith('of=') || op.startsWith('if='))) {
      const hit = classifyPathTarget(op.slice(3), 'write', ctx)
      if (hit) return hit
    }
    const hit = classifyPathTarget(op, 'write', ctx)
    if (hit) return hit
  }
  const cwdHit = classifyPathTarget('.', 'write', ctx)
  if (cwdHit?.kind === 'dsh-data') return cwdHit
  return null
}

function findsOnlyFiles(args) {
  const fileTest = args.findIndex((a, i) => a === '-type' && args[i + 1] === 'f')
  const action = args.findIndex(a => ['-delete', '-print', '-print0', '-exec', '-execdir', '-ok', '-okdir'].includes(a))
  return fileTest >= 0 && (action < 0 || fileTest < action) &&
    !args.some(a => ['!', '-not', '-o', '-or', ','].includes(a))
}

function inspectFind(args, state, ctx) {
  const roots = []
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '-H' || a === '-L' || a === '-P') { i++; continue }
    if (/^-[OD]/.test(a)) { i += a.length === 2 ? 2 : 1; continue }
    if (a.startsWith('-') || a === '!' || a === '(') break
    roots.push(a)
    i++
  }
  if (roots.length === 0) roots.push('.')

  let hasDelete = false
  const execCommands = []
  const outputFiles = []

  for (let j = i; j < args.length; j++) {
    const tok = args[j]
    if (tok === '-delete') hasDelete = true
    else if ((tok === '-fprint' || tok === '-fprint0' || tok === '-fprintf' || tok === '-fls') && args[j + 1]) {
      outputFiles.push(args[++j])
    } else if (tok === '-exec' || tok === '-execdir' || tok === '-ok' || tok === '-okdir') {
      const sub = []
      j++
      while (j < args.length && args[j] !== ';' && args[j] !== '+') sub.push(args[j++])
      if (sub.length > 0) execCommands.push(sub)
    }
  }

  for (const out of outputFiles) {
    const hit = classifyPathTarget(out, 'write', ctx)
    if (hit) return hit
  }
  if (hasDelete) {
    for (const root of roots) {
      const hit = classifyPathTarget(root, findsOnlyFiles(args) ? 'tree-contents' : 'move-or-delete', ctx)
      if (hit) return hit
    }
  }
  for (const sub of execCommands) {
    for (const root of roots) {
      const replaced = sub.map(part => part.replaceAll('{}', root))
      const hit = inspectArgv(replaced, [], { ...state, depth: state.depth + 1 })
      if (hit) return hit
    }
  }
  return null
}

// Recognize producers whose output can be inferred without reading any input file.
function pipelineOutput(words, state) {
  const ctx = currentContext(state)
  const expanded = words.map(w => expandWord(w, state.varEnv, ctx))
  if (expanded.some(w => w.dynamic)) return undefined
  const [command, ...args] = expanded.map(w => w.text)
  switch (basename(command ?? '')) {
    case 'echo':
      if (args[0]?.startsWith('-') || args.some(a => a.includes('\\'))) return undefined
      return { text: args.join(' ') + '\n' }
    case 'printf': {
      const [format, ...values] = args
      if (!format) return { text: '' }
      if (format === '%s\\n' || format === '%s\\0' || format === '%s') {
        const delimiter = format === '%s\\n' ? '\n' : format === '%s\\0' ? '\0' : ''
        return { text: values.join(delimiter) + delimiter }
      }
      if (!values.length && !format.includes('%') && !/\\(?![n0])/.test(format)) {
        return { text: format.replaceAll('\\n', '\n').replaceAll('\\0', '\0') }
      }
      return undefined
    }
    case 'find': {
      if (args.some(a => ['-printf', '-ls', '-exec', '-execdir', '-ok', '-okdir'].includes(a))) return undefined
      let i = 0
      while (['-H', '-L', '-P'].includes(args[i])) i++
      const roots = []
      while (i < args.length && !args[i].startsWith('-') && !['!', '('].includes(args[i])) roots.push(args[i++])
      return { roots: roots.length ? roots : ['.'], filesOnly: findsOnlyFiles(args) }
    }
    default: return undefined
  }
}

function inspectXargs(args, state, input) {
  let replace, delimiter
  let i = 0
  const valueFlags = new Set(['-d', '-E', '-I', '-L', '-n', '-P', '-s', '-a', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--arg-file'])
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (!arg.startsWith('-')) break
    const match = arg.match(/^(--[\w-]+)=(.*)$/) ?? arg.match(/^(-[dEILnPsa])(.+)$/)
    const flag = match?.[1] ?? arg
    i++
    const value = match?.[2] ?? (valueFlags.has(flag) ? args[i++] : undefined)
    if (flag === '-I' || flag === '--replace') replace = value ?? '{}'
    if (flag === '-0' || flag === '--null') delimiter = '\0'
    if (flag === '-d' || flag === '--delimiter') delimiter = value
    if (flag === '-a' || flag === '--arg-file') input = undefined
  }
  const sub = args.slice(i)
  if (!sub.length) return null
  const nested = { ...state, depth: state.depth + 1 }
  if (!input) {
    if (READONLY_COMMANDS.has(basename(sub[0]))) return null
    return inspectArgv(sub, [], nested) ?? unverified()
  }
  if (input.roots && input.filesOnly && !replace && MOVE_DELETE_COMMANDS.has(basename(sub[0])) && !['mv', 'rename'].includes(basename(sub[0]))) {
    const explicit = inspectArgv(sub, [], nested)
    if (explicit) return explicit
    for (const root of input.roots) {
      const hit = classifyPathTarget(root, 'tree-contents', currentContext(state))
      if (hit) return hit
    }
    return null
  }
  let items = input.roots
  if (!items) {
    if (!delimiter && /['"\\\\]/.test(input.text)) return READONLY_COMMANDS.has(basename(sub[0])) ? null : unverified()
    if (delimiter === '\\n' || (!delimiter && replace)) delimiter = '\n'
    if (delimiter && delimiter.length !== 1) return unverified()
    // Default xargs quoting and escapes need its own parser. Unknown input to a writer requires confirmation.
    if (!delimiter && /['"\\]/.test(input.text)) return READONLY_COMMANDS.has(basename(sub[0])) ? null : unverified()
    items = input.text.split(delimiter ?? /\s+/).filter(Boolean)
  }
  if (!replace) return inspectArgv([...sub, ...items], [], nested)
  for (const item of items) {
    charge(state, sub.length)
    const replaced = sub.map(arg => {
      if (!arg.includes(replace)) return arg
      if (arg.length * Math.max(item.length, 1) > MAX_COMMAND_CHARS) throw INSPECTION_LIMIT
      return arg.replaceAll(replace, () => item)
    })
    const hit = inspectArgv(replaced, [], nested)
    if (hit) return hit
  }
  return null
}

function inspectCompressTool(args, ctx) {
  let toStdout = false
  let listOrTest = false
  let forceMutate = false
  const outTargets = []
  const operands = []
  let endOpts = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (endOpts) { operands.push(a); continue }
    if (a === '--') { endOpts = true; continue }
    if (a === '--stdout' || a === '--to-stdout') { toStdout = true; continue }
    if (a === '--list' || a === '--test') { listOrTest = true; continue }
    if (a === '--rm') { forceMutate = true; continue }
    if (a === '-o' || a === '--output') { if (args[i + 1]) outTargets.push(args[++i]); forceMutate = true; continue }
    if (a.startsWith('-') && !a.startsWith('--')) {
      if (a.includes('c')) toStdout = true
      if (a.includes('l') || a.includes('t')) listOrTest = true
      if (a.includes('o')) forceMutate = true
      continue
    }
    if (!a.startsWith('-')) operands.push(a)
  }
  if ((toStdout || listOrTest) && !forceMutate) return null
  for (const t of [...outTargets, ...operands]) {
    const hit = classifyPathTarget(t, 'write', ctx)
    if (hit) return hit
  }
  return null
}

function inspectSort(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-o' || a === '--output') return args[i + 1] ? classifyPathTarget(args[i + 1], 'write', ctx) : null
    if (a.startsWith('--output=')) return classifyPathTarget(a.slice('--output='.length), 'write', ctx)
  }
  return null
}

function inspectSed(args, ctx) {
  const inPlace = args.some(a => a === '-i' || a === '--in-place' || /^-[^-]*i/.test(a) || a.startsWith('--in-place='))
  return inPlace ? checkArgsAsWrite(args, ctx) : null
}

function inspectAwk(args, ctx) {
  const inPlace = args.some(a => a === '-i' || a.startsWith('inplace'))
  if (inPlace) return checkArgsAsWrite(args, ctx)
  const program = args.find(a => !a.startsWith('-')) ?? ''
  if (/\bsystem\s*\(/.test(program) || /\b(?:print|printf)\b[^;\n]*>{1,2}/.test(program)) {
    return checkArgsAsWrite(args, ctx)
  }
  return null
}

function inspectTar(args, ctx) {
  let isList = false
  let isMutate = false
  for (const a of args) {
    if (a === '--list') isList = true
    else if (['--create', '--extract', '--get', '--append', '--update', '--delete'].includes(a)) isMutate = true
    else if (a.startsWith('-') && !a.startsWith('--')) {
      if (a.includes('t')) isList = true
      if (/[cxru]/.test(a)) isMutate = true
    }
  }
  if (isList && !isMutate) return null
  return inspectWriteCommand('tar', args, ctx)
}

function inspectGit(args, ctx) {
  let i = 0
  let workTree, gitDir
  while (i < args.length && args[i].startsWith('-')) {
    const option = args[i++]
    if (option === '-C' || option.startsWith('-C') || option === '--work-tree' || option.startsWith('--work-tree=') || option === '--git-dir' || option.startsWith('--git-dir=')) {
      const path = option.includes('=') ? option.slice(option.indexOf('=') + 1)
        : option.startsWith('-C') && option.length > 2 ? option.slice(2) : args[i++]
      if (!path) continue
      if (option.startsWith('-C')) ctx = { ...ctx, cwd: canonicalizePath(path, ctx) }
      else if (option.startsWith('--work-tree')) workTree = path
      else gitDir = path
    } else if (['-c', '--namespace', '--config-env'].includes(option)) i++
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub || ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'cat-file'].includes(sub)) {
    return inspectSort(rest, ctx)
  }
  if (workTree) ctx = { ...ctx, cwd: canonicalizePath(workTree, ctx) }
  if (sub === 'clean') {
    const { operands } = splitOperands(rest, new Set(['-e', '--exclude']))
    for (let n = 0; n < rest.length && rest[n] !== '--'; n++) {
      if (rest[n] === '-e' || rest[n] === '--exclude') { n++; continue }
      if (rest[n] === '--dry-run' || /^-[dfiqxX]*n[dfinqxX]*$/.test(rest[n])) return null
    }
    const base = canonicalizePath('.', ctx)
    for (const path of operands.length ? operands : ['.']) {
      const mode = canonicalizePath(path, ctx) === base ? 'tree-contents' : 'move-or-delete'
      const hit = classifyPathTarget(path, mode, ctx)
      if (hit) return hit
    }
    return null
  }
  if (sub === 'branch' && (!rest.length || rest.includes('--list'))) return null
  if (gitDir) {
    const hit = classifyPathTarget(gitDir, 'write', ctx)
    if (hit) return hit
  }
  if (sub === 'mv') return inspectMoveOperands(rest, ctx)
  if (sub === 'rm') return inspectDeleteOperands(rest, ctx)
  const hit = checkArgsAsWrite(rest, ctx)
  if (hit) return hit
  return classifyPathTarget('.', ['reset', 'checkout', 'restore', 'switch'].includes(sub) ? 'tree-contents' : 'write', ctx)
}

function checkArgsAsWrite(args, ctx) {
  for (const a of args) {
    if (a === '--') continue
    if (a.startsWith('-')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        const hit = classifyPathTarget(a.slice(eq + 1), 'write', ctx)
        if (hit) return hit
      }
      continue
    }
    const hit = classifyPathTarget(a, 'write', ctx)
    if (hit) return hit
  }
  return null
}

function extractInlineStrings(text) {
  const out = []
  for (const match of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    if (match[2]) out.push(match[2])
  }
  for (const match of text.matchAll(/(?:~\/|\$(?:HOME|DSH_HOME)|\/)[^\s'"`),;]+/g)) {
    out.push(match[0])
  }
  return out
}

function inspectUnknownOrInterpreter(cmd, args, heredocs, ctx) {
  const cwdHit = classifyPathTarget('.', 'write', ctx)
  if (cwdHit?.kind === 'dsh-data') return cwdHit

  const argHit = checkArgsAsWrite(args, ctx)
  if (argHit) return argHit

  const isInterp = SCRIPT_INTERPRETERS.has(cmd) || SCRIPT_INTERPRETERS.has(cmd.replace(/[\d.]+$/, ''))
  if (isInterp) {
    const inlineParts = [...heredocs]
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-c' || args[i] === '-e') && args[i + 1]) inlineParts.push(args[++i])
    }
    const body = inlineParts.join('\n')
    if (body) {
      const candidates = extractInlineStrings(body)
      for (const cand of candidates) {
        const hit = classifyPathTarget(cand, 'write', ctx)
        if (hit) return hit
      }
      if (MUTATING_SCRIPT_VERBS.test(body) || (cmd === 'osascript' && /\b(?:delete|move|set\s+name)\b/i.test(body))) {
        for (const cand of candidates) {
          const hit = classifyPathTarget(cand, 'move-or-delete', ctx)
          if (hit) return hit
        }
      }
    }
  }
  return null
}

const PWSH_READONLY = new Set([
  'get-content', 'gc', 'cat', 'type', 'get-childitem', 'gci', 'ls', 'dir',
  'get-item', 'gi', 'get-itemproperty', 'gp', 'get-filehash', 'select-string', 'sls',
  'test-path', 'resolve-path', 'rvpa', 'split-path', 'join-path', 'get-location', 'gl', 'pwd',
  'write-output', 'echo', 'write-host', 'measure-object', 'select-object', 'where-object',
  'sort-object', 'format-table', 'format-list', 'out-string',
])

const PWSH_DELETE_MOVE = new Set([
  'remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir',
  'move-item', 'mi', 'mv', 'move', 'rename-item', 'rni', 'ren',
])

const PWSH_WRITE = new Set([
  'copy-item', 'cpi', 'cp', 'copy', 'set-content', 'sc', 'add-content', 'ac',
  'out-file', 'new-item', 'ni', 'clear-content', 'clc', 'set-item', 'si',
])

function inspectPwsh(command, state) {
  charge(state, Math.ceil(command.length / 16))
  if (state.depth >= MAX_NESTING) throw INSPECTION_LIMIT
  const statements = command.split(/[;\r\n|]+|&&|\|\|/)
  for (const stmt of statements) {
    const trimmed = stmt.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // 检查 pwsh 输出重定向
    const redirMatch = trimmed.match(/>>?\s*("[^"]+"|'[^']+'|\S+)/)
    if (redirMatch) {
      const target = redirMatch[1].replace(/^['"]|['"]$/g, '')
      const hit = classifyPathTarget(target, 'write', currentContext(state))
      if (hit) return hit
    }
    const tokens = [...trimmed.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3])
    if (tokens.length === 0) continue
    const cmd = tokens[0].toLowerCase()
    const args = tokens.slice(1)
    const ctx = currentContext(state)

    if (['set-location', 'sl', 'cd', 'chdir'].includes(cmd)) {
      const target = args.find(a => !a.startsWith('-'))
      if (target) {
        const exp = expandPathVars(target, ctx)
        state.currentCwd = isAbsolute(exp) ? resolve(exp) : resolve(state.currentCwd, exp)
      }
      continue
    }
    if ((cmd === 'pwsh' || cmd === 'powershell') && args.some(a => /^-c(?:ommand)?$/i.test(a))) {
      const ci = args.findIndex(a => /^-c(?:ommand)?$/i.test(a))
      if (args[ci + 1]) {
        const hit = inspectPwsh(args[ci + 1], { ...state, depth: state.depth + 1 })
        if (hit) return hit
      }
      continue
    }
    if (PWSH_READONLY.has(cmd)) continue
    if (PWSH_DELETE_MOVE.has(cmd)) {
      const isMove = ['move-item', 'mi', 'mv', 'move'].includes(cmd)
      const paths = []
      let dest = null
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (/^-(?:literal)?path$/i.test(a) && args[i + 1]) { paths.push(args[++i]); continue }
        if (/^-dest(?:ination)?$/i.test(a) && args[i + 1]) { dest = args[++i]; continue }
        if (a.startsWith('-')) continue
        paths.push(a)
      }
      if (isMove && dest === null && paths.length > 1) dest = paths.pop()
      for (const p of paths) {
        const hit = classifyPathTarget(p, 'move-or-delete', ctx)
        if (hit) return hit
      }
      if (dest) {
        const hit = classifyPathTarget(dest, 'write', ctx)
        if (hit) return hit
      }
      continue
    }
    if (PWSH_WRITE.has(cmd)) {
      for (const a of args) {
        if (a.startsWith('-')) continue
        const hit = classifyPathTarget(a, 'write', ctx)
        if (hit) return hit
      }
      continue
    }
    const unknownHit = checkArgsAsWrite(args, ctx)
    if (unknownHit) return unknownHit
  }
  return null
}

function inspectCommandText(command, state) {
  if (state.depth >= MAX_NESTING) throw INSPECTION_LIMIT
  const tokens = tokenizeShell(command)
  charge(state, tokens.length)
  state.depth++
  try {
    return inspectTokens(tokens, state)
  } finally {
    state.depth--
  }
}

/**
 * 分析一条 shell 命令是否会写入/改动 DSH 的 storages/sessions，或移动/删除已登记工作区的根文件夹。
 * @param {string} command 命令正文。
 * @param {object} context 由 buildProtectedContext 或 { dshHome, home, cwd, workspaceRoots, env } 提供的上下文。
 * @param {{ shell?: 'bash' | 'pwsh' }} [options] shell 种类。
 * @returns {{ kind: 'dsh-data' | 'workspace-root' | 'unverified', target: string } | null} 命中目标或 null。
 */
export function inspectShellCommand(command, context, { shell = 'bash' } = {}) {
  if (typeof command !== 'string') return null
  if (command.length > MAX_COMMAND_CHARS) return unverified()
  if (!command.trim()) return null
  const ctx = context.storagesDirs ? context : buildProtectedContext(context)
  const budget = { left: 32 * 1024, chars: 2 * 1024 * 1024, deadline: performance.now() + 500 }
  const state = {
    context: { ...ctx, budget, physicalPaths: new Map() },
    currentCwd: ctx.cwd,
    depth: 0,
    budget,
    dirStack: [],
    varEnv: new Map(),
    loopCandidates: new Map(),
  }
  try {
    return shell === 'pwsh' ? inspectPwsh(command, state) : inspectCommandText(command, state)
  } catch (error) {
    if (error === INSPECTION_LIMIT) return unverified()
    throw error
  }
}

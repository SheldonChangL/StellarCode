// Per-file semantic facts for the v0.6 behavior graph.
//
// Extraction is deterministic and syntactic: it runs on masked text (comments and
// strings blanked, offsets preserved), so it never matches inside a string or a
// comment. It records facts, not relations: a call site says "inside symbol S on line
// L, `recv.name(...)` is invoked". Whether that names a repository symbol is decided
// later, over the whole index, by semantic-resolve.js. A shape that is not recognized
// produces no fact; nothing here guesses.

import { matchBracket, functionBodyOpen } from './js-ranges.js'

const JS_IDENT = '[A-Za-z_$][\\w$]*'
const PY_IDENT = '[A-Za-z_]\\w*'
const JS_KEYWORDS = new Set(['if','for','while','switch','catch','function','return','typeof','instanceof','new','delete','void','await','yield','import','require','super','in','of','do','else','try','with','case','throw','constructor','get','set','static','async','class','extends','export','default','const','let','var'])
const PY_KEYWORDS = new Set(['if','elif','while','for','def','class','return','lambda','and','or','not','in','is','with','assert','yield','await','print','del','global','nonlocal','raise','except','try','import','from','as','pass','super','isinstance','len','str','int','float','bool','list','dict','set','tuple','type','range','enumerate','zip','getattr','setattr','hasattr','sorted','min','max','sum','any','all','map','filter','open','repr','iter','next'])
const DEFINITION_PREFIX = /(?:^|[\s{};,*])(?:async|static|public|private|protected|readonly|override|abstract|get|set|declare)?\s*\*?\s*$/

function lineIndex(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return offset => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1 }
    return lo + 1
  }
}

export { matchBracket }

function splitTopLevel(text, separator = ',') {
  const parts = []
  let depth = 0, start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '{' || c === '[' || c === '<') depth++
    else if (c === ')' || c === '}' || c === ']' || (c === '>' && text[i - 1] !== '=')) depth = Math.max(0, depth - 1)
    else if (c === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1 }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

// A type annotation names one repository type only when it reduces to a single
// identifier (generic arguments, arrays of it, and null/undefined/None unions removed).
export function simpleTypeName(text) {
  if (!text) return null
  let value = String(text).trim().replace(/^readonly\s+/, '')
  value = value.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '')
  const parts = value.split('|').map(part => part.trim()).filter(part => part && !/^(null|undefined|None|void)$/.test(part))
  if (parts.length !== 1) return null
  const single = parts[0].replace(/\[\]$/, '').replace(/^Optional\[(.+)\]$/, '$1').trim()
  const quoted = single.replace(/^["'](.+)["']$/, '$1')
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(quoted) ? quoted : null
}

function innermostSymbol(symbols, line, kinds) {
  let best = null
  for (const symbol of symbols) {
    if (!kinds.has(symbol.kind) || symbol.startLine > line || symbol.endLine < line) continue
    if (!best || (symbol.endLine - symbol.startLine) <= (best.endLine - best.startLine)) best = symbol
  }
  return best
}

const CALLER_KINDS = new Set(['function', 'method', 'constant', 'class'])

function argumentShapes(argsText, ident) {
  const shape = new RegExp(`^(?:this\\.|self\\.)?${ident}(?:\\.${ident})?$`)
  return splitTopLevel(argsText).map(arg => shape.test(arg) ? arg : null)
}

// Executable scopes: functions, methods and function-valued constants. A class body is
// not a lookup scope (Python class attributes are not visible inside methods).
function isScope(symbol) {
  if (symbol.kind === 'function' || symbol.kind === 'method') return true
  return symbol.kind === 'constant' && (symbol.endLine > symbol.startLine || /=>|\bfunction\b/.test(symbol.signature ?? ''))
}

// Linear-time line -> innermost owner index, with parent links (larger enclosing symbol).
function scopeIndex(symbols, lineCount) {
  const owners = symbols.filter(s => CALLER_KINDS.has(s.kind))
    .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine) || a.startLine - b.startLine)
  const lineOwner = new Array(lineCount + 2).fill(null)
  const parent = new Map()
  for (const s of owners) {
    parent.set(s, lineOwner[s.startLine] ?? null)
    for (let l = Math.max(1, s.startLine); l <= Math.min(s.endLine, lineCount + 1); l++) lineOwner[l] = s
  }
  const ownerAt = (line, declared) => {
    let o = lineOwner[line] ?? null
    // A declaration is not inside itself: `export const x = new X()` is module scope.
    while (o && declared && o.name === declared && o.startLine === line) o = parent.get(o) ?? null
    return o
  }
  const scopeSymbol = o => { while (o && !isScope(o)) o = parent.get(o) ?? null; return o }
  const scopeParents = {}
  for (const s of owners) {
    if (!isScope(s) || s.qualifiedName in scopeParents) continue
    scopeParents[s.qualifiedName] = scopeSymbol(parent.get(s) ?? null)?.qualifiedName ?? null
  }
  return {
    callerOf: (line, declared = null) => ownerAt(line, declared)?.qualifiedName ?? null,
    callerSymbol: (line, declared = null) => ownerAt(line, declared),
    scopeOf: (line, declared = null) => scopeSymbol(ownerAt(line, declared))?.qualifiedName ?? null,
    scopeParents
  }
}

function addLocal(locals, scope, name) {
  if (!scope || !name) return
  if (!locals[scope]) locals[scope] = []
  if (!locals[scope].includes(name)) locals[scope].push(name)
}

// Binding names in a parameter or declaration pattern: `a`, `a = 1`, `a: T`, `{ a, b: c }`, `[a, ...b]`.
function patternNames(text, ident) {
  const names = []
  const visit = part => {
    part = part.trim().replace(/^\.\.\./, '')
    if (!part) return
    if (part.startsWith('{') || part.startsWith('[')) {
      const close = matchBracket(part, 0)
      const inner = part.slice(1, close > 0 ? close : part.length)
      for (const entry of splitTopLevel(inner)) {
        const colon = entry.match(new RegExp(`^${ident}\\s*:\\s*(.+)$`, 's'))
        visit(colon && part.startsWith('{') ? colon[1] : entry.replace(/=.*$/s, ''))
      }
      return
    }
    const m = part.match(new RegExp(`^(?:(?:public|private|protected|readonly|override)\\s+)*(${ident})`))
    if (m) names.push(m[1])
  }
  for (const part of splitTopLevel(text)) visit(part)
  return names
}

// ---------------------------------------------------------------- JavaScript / TypeScript

function jsParams(masked, symbol, lineStart) {
  // The parameter list is the first balanced (...) after the symbol name on its line.
  const lineOffset = lineStart(symbol.startLine)
  const at = masked.indexOf(symbol.name, lineOffset)
  if (at < 0) return []
  const open = masked.indexOf('(', at + symbol.name.length)
  if (open < 0 || open - at > 400) return []
  const close = matchBracket(masked, open)
  if (close < 0) return []
  const params = []
  for (const [index, raw] of splitTopLevel(masked.slice(open + 1, close)).entries()) {
    const m = raw.match(new RegExp(`^((?:(?:public|private|protected|readonly|override)\\s+)*)(\\.\\.\\.)?(${JS_IDENT})\\s*\\??\\s*(?::\\s*([^=]+))?`))
    if (!m || m[2]) continue
    params.push({ name: m[3], type: simpleTypeName(m[4]), index, property: Boolean(m[1].trim()) })
  }
  return params
}

function jsClassFacts(masked, symbol, lineStart, lineOf, symbols) {
  const offset = lineStart(symbol.startLine)
  const header = masked.slice(offset).match(new RegExp(`class\\s+${symbol.name}\\b([^{]*)\\{`))
  if (!header) return null
  const heritage = header[1]
  const ext = heritage.match(new RegExp(`\\bextends\\s+(${JS_IDENT}(?:\\.${JS_IDENT})*)`))
  const impl = heritage.match(/\bimplements\s+([^{]+)/)
  const open = offset + header.index + header[0].length - 1
  const close = matchBracket(masked, open)
  const fact = {
    name: symbol.qualifiedName,
    extends: ext ? [ext[1]] : [],
    implements: impl ? splitTopLevel(impl[1]).map(simpleTypeName).filter(Boolean) : [],
    fields: [],
    ctorParams: []
  }
  if (close < 0) return fact
  // Class-body statements at depth 0 relative to the class braces.
  let depth = 0, statementStart = open + 1
  const statements = []
  for (let i = open + 1; i < close; i++) {
    const c = masked[i]
    if (c === '{' || c === '(' || c === '[') { if (depth === 0 && c === '{') statements.push([statementStart, i]); depth++ }
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0 && c === '}') statementStart = i + 1 }
    else if (depth === 0 && (c === ';' || c === '\n')) { statements.push([statementStart, i]); statementStart = i + 1 }
  }
  const fieldRe = new RegExp(`^\\s*(?:(?:public|private|protected|readonly|static|declare|override)\\s+)*(?:#)?(${JS_IDENT})\\s*[?!]?\\s*(?::\\s*([^=;]+?))?\\s*(?:=\\s*(new\\s+(${JS_IDENT}(?:\\.${JS_IDENT})*)\\s*[<(])?(.*)|;|$)`, 's')
  for (const [from, to] of statements) {
    const text = masked.slice(from, to)
    if (/\(/.test(text.split('=')[0])) continue
    const m = text.match(fieldRe)
    if (!m || JS_KEYWORDS.has(m[1])) continue
    const type = simpleTypeName(m[2]) ?? null
    const line = lineOf(from + text.search(/\S/))
    if (m[4]) fact.fields.push({ name: m[1], type, newClass: m[4], line })
    else if (type) fact.fields.push({ name: m[1], type, line })
    else if (m[5] !== undefined && m[5].trim()) fact.fields.push({ name: m[1], unknown: true, line })
  }
  // `this.x = …` in every method: a field is typed only when every assignment agrees.
  const methods = symbols.filter(s => s.kind === 'method' && s.qualifiedName.startsWith(`${symbol.qualifiedName}.`) && !s.qualifiedName.slice(symbol.qualifiedName.length + 1).includes('.'))
  for (const method of methods) {
    const params = jsParams(masked, method, lineStart)
    const ctor = method.name === 'constructor'
    if (ctor) {
      fact.ctorParams = params.map(p => ({ name: p.name, type: p.type, index: p.index }))
      for (const p of params) if (p.property) fact.fields.push({ name: p.name, type: p.type, ctorParam: p.index, line: method.startLine })
    }
    const bodyStart = lineStart(method.startLine), bodyEnd = lineStart(method.endLine + 1)
    const body = masked.slice(bodyStart, bodyEnd)
    for (const m of body.matchAll(new RegExp(`\\bthis\\.(${JS_IDENT})\\s*=(?![=>])\\s*([^;\\n]*)`, 'g'))) {
      const line = lineOf(bodyStart + m.index)
      const rhs = m[2].trim()
      const created = rhs.match(new RegExp(`^new\\s+(${JS_IDENT}(?:\\.${JS_IDENT})*)\\s*[<(]`))
      const param = params.find(p => p.name === rhs.replace(/[;)]+$/, '').trim())
      if (created) fact.fields.push({ name: m[1], newClass: created[1], line })
      else if (param && ctor) fact.fields.push({ name: m[1], type: param.type, ctorParam: param.index, line })
      else if (param?.type) fact.fields.push({ name: m[1], type: param.type, line })
      else fact.fields.push({ name: m[1], unknown: true, line })
    }
  }
  return fact
}

// Member symbols the v0.5 parser does not emit: interface method signatures,
// class-property arrow functions, and methods of top-level object literals.
function jsExtraSymbols(masked, text, symbols, lineStart, lineOf, file) {
  const extra = []
  const textLines = text.split(/\r?\n/)
  const have = new Set(symbols.map(s => s.qualifiedName))
  const add = (qualifiedName, name, startOffset, endOffset, exported) => {
    if (have.has(qualifiedName)) return
    have.add(qualifiedName)
    const startLine = lineOf(startOffset)
    extra.push({ qualifiedName, name, kind: 'method', startLine, endLine: Math.max(startLine, lineOf(endOffset)), exported, signature: textLines[startLine - 1]?.trim().slice(0, 300) ?? null, sourceOffset: startOffset })
  }
  const membersAtDepth0 = (open, close, owner, exported, { interfaceBody = false } = {}) => {
    let depth = 0
    for (let i = open + 1; i < close; i++) {
      const c = masked[i]
      if (c === '{' || c === '(' || c === '[') { depth++; continue }
      if (c === '}' || c === ')' || c === ']') { depth--; continue }
      if (depth !== 0 || !/[A-Za-z_$]/.test(c) || /[\w$.]/.test(masked[i - 1] ?? '')) continue
      const rest = masked.slice(i, Math.min(close, i + 300))
      let m
      if (interfaceBody && (m = rest.match(new RegExp(`^(${JS_IDENT})\\s*\\??\\s*(?:<[^>]*>)?\\s*\\(`)))) {
        const parenOpen = i + m[0].length - 1
        const parenClose = matchBracket(masked, parenOpen)
        if (parenClose > 0) { add(`${owner}.${m[1]}`, m[1], i, parenClose, exported); i = parenClose; continue }
      }
      if (interfaceBody && (m = rest.match(new RegExp(`^(${JS_IDENT})\\s*\\??\\s*:\\s*\\(`)))) {
        add(`${owner}.${m[1]}`, m[1], i, i + m[0].length, exported); i += m[0].length - 1; continue
      }
      if (!interfaceBody && (m = rest.match(new RegExp(`^(?:(?:public|private|protected|static|override|async|get|set)\\s+)*\\*?\\s*(${JS_IDENT})\\s*(?:<[^<>()]*>)?\\s*\\(`))) && !JS_KEYWORDS.has(m[1]) || (!interfaceBody && m?.[1] === 'constructor')) {
        // Class method whose parameter list the v0.5 scanner cannot read (object types, defaults).
        const parenOpen = i + m[0].length - 1
        const parenClose = matchBracket(masked, parenOpen)
        // Structural body lookup: a return type may itself contain `{` (`Promise<{ id }>`).
        const brace = parenClose > 0 ? functionBodyOpen(masked, parenOpen) : -1
        if (brace >= 0 && brace - parenClose < 300) {
          const end = matchBracket(masked, brace)
          if (end > 0) { add(`${owner}.${m[1]}`, m[1], i, end, exported); i = end; continue }
        }
      }
      if (!interfaceBody && (m = rest.match(new RegExp(`^(?:(?:public|private|protected|readonly|static|override)\\s+)*(${JS_IDENT})\\s*(?::[^=;{]+)?=\\s*(?:async\\s*)?(?:function\\b[^(]*)?(\\([^()]*\\)|${JS_IDENT})\\s*(?::[^=;{]+)?(=>)?\\s*\\{`)))) {
        if (!m[3] && !/function/.test(m[0])) continue
        const brace = i + m[0].length - 1
        const end = matchBracket(masked, brace)
        if (end > 0) { add(`${owner}.${m[1]}`, m[1], i, end, exported); i = end; continue }
      }
    }
  }
  for (const symbol of symbols) {
    if (symbol.kind !== 'interface' && symbol.kind !== 'class') continue
    const offset = lineStart(symbol.startLine)
    const header = masked.slice(offset).match(new RegExp(`(?:interface|class)\\s+${symbol.name}\\b[^{]*\\{`))
    if (!header) continue
    const open = offset + header.index + header[0].length - 1
    const close = matchBracket(masked, open)
    if (close > 0) membersAtDepth0(open, close, symbol.qualifiedName, symbol.exported, { interfaceBody: symbol.kind === 'interface' })
  }
  // Top-level object literals: `const repo = { save(x) {…}, find: async (id) => {…} }`.
  for (const m of masked.matchAll(new RegExp(`(^|\\n)(export\\s+)?(?:const|let|var)\\s+(${JS_IDENT})\\s*(?::[^=]+)?=\\s*\\{`, 'g'))) {
    const open = m.index + m[0].length - 1
    const close = matchBracket(masked, open)
    if (close < 0) continue
    const owner = m[3]
    let depth = 0
    for (let i = open + 1; i < close; i++) {
      const c = masked[i]
      if (c === '{' || c === '(' || c === '[') { depth++; continue }
      if (c === '}' || c === ')' || c === ']') { depth--; continue }
      if (depth !== 0 || !/[A-Za-z_$]/.test(c) || /[\w$.]/.test(masked[i - 1] ?? '')) continue
      const rest = masked.slice(i, Math.min(close, i + 300))
      const method = rest.match(new RegExp(`^(?:async\\s+)?\\*?\\s*(${JS_IDENT})\\s*\\([^()]*\\)\\s*(?::[^{]+)?\\{`))
      const prop = rest.match(new RegExp(`^(${JS_IDENT})\\s*:\\s*(?:async\\s*)?(?:function\\b[^(]*\\([^()]*\\)|\\([^()]*\\)\\s*(?::[^=]+)?=>|${JS_IDENT}\\s*=>)\\s*\\{`))
      const hit = method ?? prop
      if (!hit || JS_KEYWORDS.has(hit[1])) continue
      const brace = i + hit[0].length - 1
      const end = matchBracket(masked, brace)
      if (end < 0) continue
      add(`${owner}.${hit[1]}`, hit[1], i, end, Boolean(m[2]))
      i = end
    }
  }
  return extra.map(s => ({ ...s, fileId: file.fileId }))
}

// Statement facts are matched on raw text (the specifier is a string, which masking
// blanks) but kept only where the keyword itself survives masking, i.e. not in a comment.
const live = (masked, index, word) => masked.startsWith(word, index)

function jsReexports(text, masked) {
  const reexports = [], stars = []
  for (const m of text.matchAll(new RegExp(`\\bexport\\s+(type\\s+)?(?:\\*\\s*(?:as\\s+(${JS_IDENT})\\s*)?|\\{([^}]*)\\})\\s*from\\s*["']([^"']+)["']`, 'g'))) {
    if (!live(masked, m.index, 'export')) continue
    const specifier = m[4]
    if (m[3] !== undefined) {
      for (const part of m[3].split(',').map(v => v.trim().replace(/^type\s+/, '')).filter(Boolean)) {
        const p = part.match(new RegExp(`^(${JS_IDENT}|default)(?:\\s+as\\s+(${JS_IDENT}|default))?$`))
        if (p) reexports.push({ specifier, imported: p[1], exported: p[2] ?? p[1] })
      }
    } else if (m[2]) reexports.push({ specifier, imported: '*', exported: m[2] })
    else stars.push(specifier)
  }
  return { reexports, stars }
}

// Barriers for `this`: bodies of `function` functions and of object-literal methods,
// where `this` is no longer the enclosing class instance.
function thisBarriers(masked) {
  const barriers = [], stack = []
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if (c === '{') {
      const before = masked.slice(Math.max(0, i - 300), i)
      const top = stack[stack.length - 1]
      let kind = 'block'
      if (/\bfunction\b[\s\w$*]*\([^()]*\)\s*(?::[^{};]*)?$/.test(before)) kind = 'fn'
      else if (top?.kind === 'object' && new RegExp(`(?:^|[\\s,{])(?:async\\s+)?\\*?\\s*(?:get\\s+|set\\s+)?${JS_IDENT}\\s*\\([^()]*\\)\\s*(?::[^{};]*)?$`).test(before)) kind = 'fn'
      else if (/[=(\[,:?]\s*$|\breturn\s*$|=>\s*\(\s*$/.test(before)) kind = 'object'
      stack.push({ open: i, kind })
    } else if (c === '}') {
      const top = stack.pop()
      if (top?.kind === 'fn') barriers.push([top.open, i])
    }
  }
  return barriers
}

const CALL_PREFIX_WORDS = new Set(['return', 'await', 'yield', 'typeof', 'void', 'case', 'throw', 'else', 'do', 'in', 'of', 'delete', 'instanceof'])

// A call site follows an operator, punctuation, a keyword or a line start. Text such as
// JSX children ("do not deleteAll(items)") has an ordinary word before it.
function callPrefixAllowed(before, jsx) {
  const trimmed = before.replace(/\s+$/, '')
  if (!trimmed) return true
  const last = trimmed[trimmed.length - 1]
  if (/[\w$]/.test(last)) {
    const word = trimmed.match(/[\w$]+$/)[0]
    return CALL_PREFIX_WORDS.has(word)
  }
  if (last === '>' && jsx && !/[=>]>$|=>$/.test(trimmed)) return false
  if (last === '.' ) return false
  return true
}

function extractJs({ text, masked, symbols, imports, file }) {
  const lineOf = lineIndex(masked)
  const starts = [0]
  for (let i = 0; i < masked.length; i++) if (masked.charCodeAt(i) === 10) starts.push(i + 1)
  const lineStart = line => starts[line - 1] ?? masked.length
  const maskedLines = masked.split('\n')
  const scopes = scopeIndex(symbols, maskedLines.length)
  const jsx = /\.(?:jsx|tsx)$/.test(file?.path ?? '')
  const facts = { language: 'js', imports: [], requires: [], exports: { named: [], defaultExpr: null }, reexports: [], stars: [], values: [], destructures: [], classes: [], params: {}, calls: [], news: [], refs: [], locals: {}, reassigned: [], scopeParents: scopes.scopeParents }

  for (const imp of imports) {
    if (!imp.importedNames?.length) continue
    // Commented-out import lines are not bindings.
    if (!/\b(?:import|export)\b/.test(maskedLines[imp.line - 1] ?? '')) continue
    facts.imports.push({ specifier: imp.specifier, line: imp.line, bindings: imp.importedNames.map(b => ({ imported: b.kind === 'namespace' ? '*' : b.importedName, local: b.localName, typeOnly: b.kind === 'type' })) })
  }
  for (const m of text.matchAll(new RegExp(`\\b(const|let|var)\\s+(${JS_IDENT}|\\{[^}]*\\})\\s*=\\s*require\\s*\\(\\s*["']([^"']+)["']\\s*\\)`, 'g'))) {
    if (!live(masked, m.index, m[1])) continue
    const line = lineOf(m.index)
    if (m[2].startsWith('{')) {
      const names = splitTopLevel(m[2].slice(1, -1)).map(part => part.match(new RegExp(`^(${JS_IDENT})(?:\\s*:\\s*(${JS_IDENT}))?$`))).filter(Boolean).map(p => ({ imported: p[1], local: p[2] ?? p[1] }))
      const scope = scopes.scopeOf(line)
      if (scope) for (const n of names) addLocal(facts.locals, scope, n.local)
      else facts.imports.push({ specifier: m[3], line, bindings: names })
    } else facts.requires.push({ local: m[2], specifier: m[3], line, scope: scopes.scopeOf(line, m[2]) })
  }
  const { reexports, stars } = jsReexports(text, masked)
  facts.reexports = reexports
  facts.stars = stars

  const dflt = masked.match(new RegExp(`\\bexport\\s+default\\s+(?:new\\s+(${JS_IDENT}(?:\\.${JS_IDENT})*)\\s*[<(]|(?:async\\s+)?(?:function|class)\\s+(${JS_IDENT})|(${JS_IDENT})\\s*(?:;|\\n|$))`))
  if (dflt) facts.exports.defaultExpr = dflt[1] ? { kind: 'new', className: dflt[1] } : { kind: 'ident', name: dflt[2] ?? dflt[3] }
  for (const m of masked.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1].split(',').map(v => v.trim().replace(/^type\s+/, '')).filter(Boolean)) {
      const p = part.match(new RegExp(`^(${JS_IDENT})(?:\\s+as\\s+(${JS_IDENT}|default))?$`))
      if (!p) continue
      if (p[2] === 'default') facts.exports.defaultExpr = { kind: 'ident', name: p[1] }
      else facts.exports.named.push({ local: p[1], exported: p[2] ?? p[1] })
    }
  }

  // Declarations: instance bindings (`const x = new X()`, `const x: X = …`), and every
  // other local name, so an untyped local or parameter shadows module bindings.
  for (const m of masked.matchAll(new RegExp(`\\b(const|let|var)\\s+(${JS_IDENT})\\s*(?::\\s*([^=;]+?))?\\s*=(?![=>])\\s*(?:await\\s+)?(?:new\\s+(${JS_IDENT}(?:\\.${JS_IDENT})*)\\s*[<(])?`, 'g'))) {
    const line = lineOf(m.index)
    const scope = scopes.scopeOf(line, m[2])
    const type = simpleTypeName(m[3])
    const newClass = m[4] ?? null
    if (type || newClass) facts.values.push({ name: m[2], type, newClass, line, scope, mutable: m[1] !== 'const' })
    else if (scope) addLocal(facts.locals, scope, m[2])
    // A module-level declaration that is itself an indexed symbol (`export const f = () => …`)
    // binds that symbol; any other untyped module value binds something unknown.
    else if (!symbols.some(s => s.name === m[2] && s.startLine === line)) facts.values.push({ name: m[2], unknown: true, line, scope: null })
  }
  for (const m of masked.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([{\\[][^=;]*[}\\]])\\s*(?::[^=;]+)?=(?![=>])\\s*(this\\.)?(${JS_IDENT})?`, 'g'))) {
    const line = lineOf(m.index)
    const scope = scopes.scopeOf(line)
    const bound = patternNames(m[1].startsWith('{') ? m[1] : m[1], JS_IDENT)
    const plain = m[1].startsWith('{') && m[3] && /^[\s,]*$/.test(masked.slice(m.index + m[0].length, m.index + m[0].length + 1))
    if (plain) {
      const names = splitTopLevel(m[1].slice(1, -1)).map(part => part.match(new RegExp(`^(${JS_IDENT})(?:\\s*:\\s*(${JS_IDENT}))?$`))).filter(Boolean).map(p => ({ imported: p[1], local: p[2] ?? p[1] }))
      if (names.length) facts.destructures.push({ from: m[2] ? `this.${m[3]}` : m[3], names, line, scope })
    }
    for (const name of bound) if (scope) addLocal(facts.locals, scope, name)
  }
  // Parameters, nested function names, catch bindings and arrow parameters are locals.
  for (const symbol of symbols) {
    if (!isScope(symbol)) continue
    const params = jsParams(masked, symbol, lineStart)
    const typed = params.filter(p => p.type)
    if (typed.length) facts.params[symbol.qualifiedName] = typed.map(p => ({ name: p.name, type: p.type }))
    for (const p of params) addLocal(facts.locals, symbol.qualifiedName, p.name)
  }
  for (const m of masked.matchAll(new RegExp(`\\bfunction\\s*\\*?\\s*(${JS_IDENT})\\s*\\(`, 'g'))) {
    const line = lineOf(m.index)
    addLocal(facts.locals, scopes.scopeOf(line, m[1]), m[1])
  }
  for (const m of masked.matchAll(new RegExp(`\\bcatch\\s*\\(\\s*(${JS_IDENT})`, 'g'))) addLocal(facts.locals, scopes.scopeOf(lineOf(m.index)), m[1])
  for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])(${JS_IDENT})\\s*=>`, 'g'))) addLocal(facts.locals, scopes.scopeOf(lineOf(m.index)), m[1])
  for (const m of masked.matchAll(/\(([^()]*)\)\s*(?::[^=;{()]+)?=>/g)) {
    const scope = scopes.scopeOf(lineOf(m.index))
    for (const name of patternNames(m[1], JS_IDENT)) addLocal(facts.locals, scope, name)
  }
  // Names reassigned anywhere (`x = …`, `x += …`): their declared type is not reliable.
  const reassigned = new Set()
  for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])(${JS_IDENT})\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|\\?\\?|&&|\\|\\|)?=(?![=>])`, 'g'))) {
    // Only a statement-level assignment rebinds a name; JSX attributes (`a={…}`), default
    // parameters and object/destructuring defaults are not reassignments.
    const before = masked.slice(Math.max(0, m.index - 30), m.index)
    if (!/(?:^|[;{}]|\n)\s*$/.test(before)) continue
    reassigned.add(m[1])
  }
  facts.reassigned = [...reassigned]

  for (const symbol of symbols) if (symbol.kind === 'class') { const c = jsClassFacts(masked, symbol, lineStart, lineOf, symbols); if (c) facts.classes.push(c) }

  const barriers = thisBarriers(masked)
  const callRe = new RegExp(`(?<![\\w$.])((?:this|super|${JS_IDENT})(?:\\s*\\??\\.\\s*${JS_IDENT})*)\\s*(?:<[^<>()]*>)?\\s*\\(`, 'g')
  for (const m of masked.matchAll(callRe)) {
    const chain = m[1].split(/\s*\??\.\s*/)
    const name = chain.at(-1)
    if (chain.length === 1 && JS_KEYWORDS.has(name)) continue
    const before = masked.slice(Math.max(0, m.index - 40), m.index)
    const open = m.index + m[0].length - 1
    const close = matchBracket(masked, open)
    if (close < 0) continue
    const after = masked.slice(close + 1, close + 200).match(/^\s*(\S)/)?.[1]
    if (/\bfunction\s*\*?\s*$/.test(before)) continue
    // `name(...) {` or `name(...): T {` at a statement start is a definition, not a call.
    if (chain.length === 1 && (after === '{' || after === ':') && DEFINITION_PREFIX.test(before)) continue
    const line = lineOf(m.index)
    if (/\bnew\s+$/.test(before)) { facts.news.push({ className: chain.join('.'), args: splitTopLevel(masked.slice(open + 1, close)).map(a => a.length <= 120 ? a : null), line, caller: scopes.callerOf(line), scope: scopes.scopeOf(line) }); continue }
    if (!callPrefixAllowed(before, jsx)) continue
    const caller = scopes.callerSymbol(line)
    if (chain[0] === 'this' || chain[0] === 'super') {
      // `this` inside a nested `function` or object-literal method is not the class instance.
      const callerStart = caller ? lineStart(caller.startLine) : 0
      const blockedAt = barriers.find(([from, to]) => from < m.index && to > m.index && lineOf(from) > (caller?.startLine ?? 0) && from > callerStart)
      if (blockedAt) continue
    }
    const args = argumentShapes(masked.slice(open + 1, close), JS_IDENT)
    facts.calls.push({ caller: caller?.qualifiedName ?? null, scope: scopes.scopeOf(line), line, chain, args: args.some(Boolean) ? args : undefined })
  }

  // Identifier uses of imported bindings that are not calls (types, constants, values).
  const locals = new Set(facts.imports.flatMap(imp => imp.bindings.map(b => b.local)))
  const importLines = new Set(facts.imports.map(imp => imp.line))
  for (const local of locals) {
    const seen = new Set()
    for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}(?![\\w$])(\\s*\\??\\.\\s*(${JS_IDENT}))?`, 'g'))) {
      const line = lineOf(m.index)
      if (importLines.has(line)) continue
      const next = masked.slice(m.index + m[0].length).match(/^\s*(\S)/)?.[1]
      if (next === '(') continue
      // An object key (`{ config: x }`) is a property name, not a use of the binding.
      const prev = masked.slice(Math.max(0, m.index - 20), m.index).match(/(\S)\s*$/)?.[1]
      if (!m[1] && next === ':' && (prev === '{' || prev === ',')) continue
      const caller = scopes.callerOf(line)
      if (!caller) continue
      const key = `${caller}|${m[2] ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      facts.refs.push({ local, member: m[2] ?? null, caller, scope: scopes.scopeOf(line), line })
    }
  }
  return facts
}

// ---------------------------------------------------------------- Python

export function maskPython(text) {
  let out = ''
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (c === '#') { while (i < text.length && text[i] !== '\n') { out += ' '; i++ } continue }
    const prefix = text.slice(i).match(/^[rRbBuUfF]{0,2}("""|'''|"|')/)
    if (prefix && (prefix[0].length === prefix[1].length || !/[\w]/.test(text[i - 1] ?? ''))) {
      const quote = prefix[1]
      out += ' '.repeat(prefix[0].length); i += prefix[0].length
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === '\\') { out += '  '; i += 2; continue }
        if (quote.length === 1 && text[i] === '\n') break
        out += text[i] === '\n' ? '\n' : ' '; i++
      }
      if (text.startsWith(quote, i)) { out += ' '.repeat(quote.length); i += quote.length }
      continue
    }
    out += c; i++
  }
  return out
}

function pyParams(masked, symbol, lineStart) {
  const offset = lineStart(symbol.startLine)
  const m = masked.slice(offset).match(new RegExp(`def\\s+${symbol.name}\\s*\\(`))
  if (!m) return []
  const open = offset + m.index + m[0].length - 1
  const close = matchBracket(masked, open)
  if (close < 0) return []
  const params = []
  for (const [index, raw] of splitTopLevel(masked.slice(open + 1, close)).entries()) {
    const p = raw.match(new RegExp(`^(${PY_IDENT})\\s*(?::\\s*([^=]+))?`))
    if (!p || raw.startsWith('*')) continue
    params.push({ name: p[1], type: simpleTypeName(p[2]), index })
  }
  return params
}

function extractPython({ text, symbols }) {
  const masked = maskPython(text)
  const lineOf = lineIndex(masked)
  const starts = [0]
  for (let i = 0; i < masked.length; i++) if (masked.charCodeAt(i) === 10) starts.push(i + 1)
  const lineStart = line => starts[line - 1] ?? masked.length
  const lines = masked.split('\n')
  const scopes = scopeIndex(symbols, lines.length)
  // Bracket depth at each line start: an `x = …` inside an open call is a keyword argument.
  const depthAtLine = new Int32Array(lines.length + 2)
  for (let i = 0, d = 0, line = 1; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') d++
    else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1)
    else if (c === '\n') depthAtLine[++line] = d
  }
  const statementLine = line => depthAtLine[line] === 0
  const facts = { language: 'py', imports: [], modules: [], values: [], destructures: [], classes: [], params: {}, calls: [], news: [], refs: [], decorators: [], locals: {}, assignCounts: {}, scopeParents: scopes.scopeParents }

  // `from m import a as b, (c, d)`, including parenthesized multi-line imports.
  for (const m of masked.matchAll(new RegExp(`(^|\\n)([ \\t]*)from\\s+([.\\w]+)\\s+import\\s+(\\([^)]*\\)|[^\\n]+)`, 'g'))) {
    const names = m[4].replace(/^\(|\)$/g, '').replace(/\\\n/g, ' ')
    const bindings = splitTopLevel(names.replace(/\n/g, ' ')).map(part => part.match(new RegExp(`^(${PY_IDENT})(?:\\s+as\\s+(${PY_IDENT}))?$`))).filter(Boolean).map(p => ({ imported: p[1], local: p[2] ?? p[1] }))
    const line = lineOf(m.index + m[1].length)
    const scope = m[2].length ? scopes.scopeOf(line) : null
    if (scope) { for (const b of bindings) addLocal(facts.locals, scope, b.local); continue }
    if (bindings.length) facts.imports.push({ specifier: m[3], line, bindings })
  }
  for (const m of masked.matchAll(new RegExp(`(^|\\n)([ \\t]*)import\\s+([^\\n]+)`, 'g'))) {
    const line = lineOf(m.index + m[1].length)
    const scope = m[2].length ? scopes.scopeOf(line) : null
    for (const part of splitTopLevel(m[3])) {
      const p = part.match(/^([\w.]+)(?:\s+as\s+(\w+))?$/)
      if (!p) continue
      const local = p[2] ?? p[1].split('.')[0]
      if (scope) addLocal(facts.locals, scope, local)
      else facts.modules.push({ module: p[1], local, full: Boolean(p[2]), line })
    }
  }

  for (const symbol of symbols) {
    if (symbol.kind === 'class') {
      const header = lines[symbol.startLine - 1]?.match(new RegExp(`class\\s+${symbol.name}\\s*(?:\\(([^)]*)\\))?`))
      const bases = header?.[1] ? splitTopLevel(header[1]).filter(b => !b.includes('=')).map(simpleTypeName).filter(Boolean) : []
      const fact = { name: symbol.qualifiedName, extends: bases, implements: [], fields: [], ctorParams: [] }
      const methods = symbols.filter(s => s.kind === 'method' && s.qualifiedName.startsWith(`${symbol.qualifiedName}.`) && s.qualifiedName.split('.').length === symbol.qualifiedName.split('.').length + 1)
      // Class-level annotations: `repo: Repository`.
      const indent = (lines[symbol.startLine - 1] ?? '').match(/^\s*/)[0].length
      for (let n = symbol.startLine; n < symbol.endLine; n++) {
        const raw = lines[n] ?? ''
        if (raw.match(/^\s*/)[0].length <= indent || methods.some(m => n + 1 >= m.startLine && n + 1 <= m.endLine)) continue
        const a = raw.match(new RegExp(`^\\s*(${PY_IDENT})\\s*:\\s*([^=]+?)\\s*(?:=|$)`))
        if (a && simpleTypeName(a[2])) fact.fields.push({ name: a[1], type: simpleTypeName(a[2]), line: n + 1 })
      }
      for (const method of methods) {
        const params = pyParams(masked, method, lineStart)
        if (method.name === '__init__') fact.ctorParams = params.filter(p => p.name !== 'self').map(p => ({ name: p.name, type: p.type, index: p.index - 1 }))
        for (let n = method.startLine; n <= method.endLine; n++) {
          if (!statementLine(n)) continue
          const a = (lines[n - 1] ?? '').match(new RegExp(`^\\s*self\\.(${PY_IDENT})\\s*(?::\\s*([^=]+?))?\\s*=(?!=)\\s*(.*)$`))
          if (!a) continue
          const type = simpleTypeName(a[2])
          const rhs = a[3].trim()
          const created = rhs.match(new RegExp(`^(${PY_IDENT}(?:\\.${PY_IDENT})*)\\s*\\(`))
          const param = params.find(p => p.name === rhs)
          if (type) fact.fields.push({ name: a[1], type, line: n })
          else if (created) fact.fields.push({ name: a[1], newClass: created[1], line: n })
          else if (param && method.name === '__init__') fact.fields.push({ name: a[1], type: param.type, ctorParam: param.index - 1, line: n })
          else if (param?.type) fact.fields.push({ name: a[1], type: param.type, line: n })
          else fact.fields.push({ name: a[1], unknown: true, line: n })
        }
      }
      facts.classes.push(fact)
    }
    if (symbol.kind === 'function' || symbol.kind === 'method') {
      const params = pyParams(masked, symbol, lineStart)
      const typed = params.filter(p => p.type)
      if (typed.length) facts.params[symbol.qualifiedName] = typed.map(p => ({ name: p.name, type: p.type }))
      for (const p of params) addLocal(facts.locals, symbol.qualifiedName, p.name)
      // A nested def binds its name in the enclosing scope.
      addLocal(facts.locals, scopes.scopeOf(symbol.startLine, symbol.name), symbol.name)
      // Call-form decorators directly above a def register that function.
      for (let n = symbol.startLine - 1; n >= 1; n--) {
        // A multi-line decorator `@router.post(\n  "/x",\n)`: continuation lines start
        // inside its brackets; walk up to the line that opens it.
        if (depthAtLine[n] > 0) continue
        const d = (lines[n - 1] ?? '').match(/^\s*@([\w.]+)\s*(\()?/)
        if (!d) break
        if (d[2]) facts.decorators.push({ target: symbol.qualifiedName, expression: d[1], line: n })
      }
    }
  }

  // Statement-level assignments. Every assigned name is local to its scope (or counted at
  // module scope); `x = Cls(...)` and annotated `x: T = …` also record an instance value.
  const count = (scope, name) => { const key = `${scope ?? ''}|${name}`; facts.assignCounts[key] = (facts.assignCounts[key] ?? 0) + 1 }
  for (let n = 1; n <= lines.length; n++) {
    if (!statementLine(n)) continue
    const raw = lines[n - 1]
    const single = raw.match(new RegExp(`^([ \\t]*)(${PY_IDENT})\\s*(?::\\s*([^=]+?))?\\s*(?:[-+*/%&|^@]|//|\\*\\*|<<|>>)?=(?!=)\\s*(?:await\\s+)?(?:(${PY_IDENT}(?:\\.${PY_IDENT})*)\\s*\\()?`))
    const tuple = raw.match(new RegExp(`^[ \\t]*(\\(?\\s*${PY_IDENT}(?:\\s*,\\s*\\*?${PY_IDENT})+\\s*\\)?)\\s*=(?!=)`))
    const scope = scopes.scopeOf(n, single?.[2])
    // A class-body assignment is a class attribute, not a module or function binding.
    if (!scope && scopes.callerSymbol(n, single?.[2])?.kind === 'class') continue
    if (single && !PY_KEYWORDS.has(single[2])) {
      count(scope, single[2])
      if (scope) addLocal(facts.locals, scope, single[2])
      const type = simpleTypeName(single[3])
      const newClass = single[4] ?? null
      facts.values.push({ name: single[2], type, newClass, line: n, scope, unknown: !type && !newClass })
    } else if (tuple) {
      for (const name of tuple[1].replace(/[()*\s]/g, '').split(',')) { count(scope, name); if (scope) addLocal(facts.locals, scope, name) }
    }
  }
  // Loop, comprehension, `with … as`, `except … as` and lambda bindings.
  for (const m of masked.matchAll(new RegExp(`\\bfor\\s+([\\w\\s,()*]+?)\\s+in\\b`, 'g'))) {
    const scope = scopes.scopeOf(lineOf(m.index))
    for (const name of m[1].replace(/[()*\s]/g, '').split(',').filter(Boolean)) { if (scope) addLocal(facts.locals, scope, name); else count(null, name) }
  }
  for (const m of masked.matchAll(new RegExp(`\\bas\\s+(${PY_IDENT})`, 'g'))) {
    const line = lineOf(m.index)
    if (/^\s*(?:from|import)\b/.test(lines[line - 1] ?? '')) continue
    const scope = scopes.scopeOf(line)
    if (scope) addLocal(facts.locals, scope, m[1]); else count(null, m[1])
  }
  for (const m of masked.matchAll(/\blambda\b([^:]*):/g)) {
    const scope = scopes.scopeOf(lineOf(m.index))
    for (const part of splitTopLevel(m[1])) { const name = part.replace(/[*=].*$/, '').replace(/^\*+/, '').trim(); if (name && scope) addLocal(facts.locals, scope, name) }
  }

  const callRe = new RegExp(`(?<![\\w.])((?:self|${PY_IDENT})(?:\\.${PY_IDENT})*)\\s*\\(`, 'g')
  for (const m of masked.matchAll(callRe)) {
    const chain = m[1].split('.')
    if (chain.length === 1 && PY_KEYWORDS.has(chain[0])) continue
    const before = masked.slice(Math.max(0, m.index - 20), m.index)
    if (/\b(?:def|class)\s+$/.test(before) || /@\s*$/.test(before)) continue
    const open = m.index + m[0].length - 1
    const close = matchBracket(masked, open)
    if (close < 0) continue
    const line = lineOf(m.index)
    const args = argumentShapes(masked.slice(open + 1, close), PY_IDENT)
    const caller = scopes.callerOf(line)
    const scope = scopes.scopeOf(line)
    facts.calls.push({ caller, scope, line, chain, args: args.some(Boolean) ? args : undefined })
    facts.news.push({ className: chain.join('.'), args: splitTopLevel(masked.slice(open + 1, close)).map(a => a.length <= 120 ? a : null), line, caller, scope, maybe: true })
  }

  const locals = new Set([...facts.imports.flatMap(imp => imp.bindings.map(b => b.local)), ...facts.modules.map(m => m.local)])
  const importLines = new Set([...facts.imports.map(i => i.line), ...facts.modules.map(m => m.line)])
  for (const local of locals) {
    const seen = new Set()
    for (const m of masked.matchAll(new RegExp(`(?<![\\w.])${local}(?!\\w)(\\.(${PY_IDENT}))?`, 'g'))) {
      const line = lineOf(m.index)
      if (importLines.has(line)) continue
      const rest = masked.slice(m.index + m[0].length)
      const next = rest.match(/^\s*(\S)/)?.[1]
      if (next === '(') continue
      // `name=` is a keyword argument or an assignment target, not a use.
      if (!m[1] && /^\s*=(?!=)/.test(rest)) continue
      const caller = scopes.callerOf(line)
      if (!caller) continue
      const key = `${caller}|${m[2] ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      facts.refs.push({ local, member: m[2] ?? null, caller, scope: scopes.scopeOf(line), line })
    }
  }
  return facts
}

export function extractSemanticFacts({ text, masked, symbols, imports, file }) {
  if (file.language === 'Python') return { facts: extractPython({ text, symbols }), extraSymbols: [] }
  const starts = [0]
  for (let i = 0; i < masked.length; i++) if (masked.charCodeAt(i) === 10) starts.push(i + 1)
  const extraSymbols = jsExtraSymbols(masked, text, symbols, line => starts[line - 1] ?? masked.length, lineIndex(masked), file)
  const all = [...symbols, ...extraSymbols]
  return { facts: extractJs({ text, masked, symbols: all, imports, file }), extraSymbols }
}

export { innermostSymbol }

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractSemanticFacts } from './semantic-extract.js'

function id(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex')
}

// A source location must be part of a symbol identity. Line number alone is not
// sufficient because valid (and especially generated/minified) JavaScript can
// contain multiple declarations with the same name on one physical line.
//
// We keep the human-friendly line in the ID input, but add the declaration's
// byte/character offset as the final discriminator so PRIMARY KEY collisions
// cannot occur for distinct declarations in the same file.
function makeSymbolId(file, kind, qualifiedName, startLine, sourceOffset) {
  return id([file.path, kind, qualifiedName, String(startLine), String(sourceOffset)])
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function stripCommentsAndStrings(text) {
  let out = ''
  let i = 0
  let state = 'code'
  let quote = ''
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { out += '  '; i += 2; state = 'lineComment'; continue }
      if (c === '/' && n === '*') { out += '  '; i += 2; state = 'blockComment'; continue }
      // A regex literal (`/"/g`) must not flip string state. It starts where an operand is
      // expected: after an operator/punctuator, at the start, or after a keyword.
      if (c === '/' && regexAllowed(out)) {
        let j = i + 1, inClass = false
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '\\') { j += 2; continue }
          if (text[j] === '[') inClass = true
          else if (text[j] === ']') inClass = false
          else if (text[j] === '/' && !inClass) break
          j++
        }
        if (j < text.length && text[j] === '/') {
          j++
          while (/[A-Za-z]/.test(text[j] ?? '')) j++
          out += ' '.repeat(j - i); i = j; continue
        }
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; out += ' '; i++; state = 'string'; continue }
      out += c; i++; continue
    }
    if (state === 'lineComment') {
      if (c === '\n') { out += '\n'; state = 'code' } else out += ' '
      i++; continue
    }
    if (state === 'blockComment') {
      if (c === '*' && n === '/') { out += '  '; i += 2; state = 'code'; continue }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
    if (state === 'string') {
      if (c === '\\') { out += '  '; i += 2; continue }
      if (c === quote) { out += ' '; i++; state = 'code'; continue }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
  }
  return out
}

const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'throw', 'delete', 'instanceof', 'new'])

// Scans backward from the end (constant work per `/`, not proportional to the file).
function regexAllowed(out) {
  let i = out.length - 1
  while (i >= 0 && /\s/.test(out[i])) i--
  if (i < 0) return true
  const last = out[i]
  if ('(,=:[!&|?{};+-*%<>~^'.includes(last)) return true
  if (!/[\w$]/.test(last)) return false
  let j = i
  while (j >= 0 && i - j < 12 && /[\w$]/.test(out[j])) j--
  return REGEX_KEYWORDS.has(out.slice(j + 1, i + 1))
}

function findBlockEnd(masked, openIndex) {
  let depth = 0
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    if (masked[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return masked.length - 1
}

function parseJSImportBindings(clause, typeOnly = false) {
  const bindings = []
  const add = (importedName, localName, kind = 'named') => {
    if (!importedName || !localName) return
    bindings.push({ importedName, localName, kind: typeOnly ? 'type' : kind })
  }
  const value = String(clause ?? '').trim()
  const named = value.match(/\{([\s\S]*?)\}/)
  if (named) {
    for (let part of named[1].split(',')) {
      part = part.trim()
      if (!part) continue
      let entryType = typeOnly
      if (part.startsWith('type ')) { entryType = true; part = part.slice(5).trim() }
      const match = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (match) bindings.push({ importedName: match[1], localName: match[2] ?? match[1], kind: entryType ? 'type' : 'named' })
    }
  }
  const namespace = value.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
  if (namespace) add('*', namespace[1], 'namespace')
  const first = value.split(',')[0].trim()
  if (first && !first.startsWith('{') && !first.startsWith('*')) add('default', first, 'default')
  return bindings
}

function parseJsTs(text, file) {
  const symbols = []
  const imports = []
  const masked = stripCommentsAndStrings(text)

  for (const match of text.matchAll(/\bimport\s+(type\s+)?([^"'`;]+?)\s+from\s+["']([^"']+)["']/g)) {
    imports.push({
      specifier: match[3],
      line: lineAt(text, match.index),
      sourceOffset: match.index,
      importedNames: parseJSImportBindings(match[2], Boolean(match[1]))
    })
  }
  // `export { a as b } from './m'` and `export * from './m'` are module dependencies too:
  // without them a barrel index is a dead end in the graph.
  for (const match of text.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{([^}]*)\})\s*from\s*["']([^"']+)["']/g)) {
    const importedNames = []
    for (let part of String(match[2] ?? '').split(',')) {
      part = part.trim().replace(/^type\s+/, '')
      const named = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (named && named[1] !== 'default') importedNames.push({ importedName: named[1], localName: named[2] ?? named[1], kind: match[1] ? 'type' : 'named' })
    }
    imports.push({ specifier: match[3], line: lineAt(text, match.index), sourceOffset: `re${match.index}`, importedNames })
  }
  for (const match of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    imports.push({ specifier: match[1], line: lineAt(text, match.index), sourceOffset: match.index, importedNames: [] })
  }
  for (const pattern of [/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of text.matchAll(pattern)) {
      imports.push({ specifier: match[1], line: lineAt(text, match.index), sourceOffset: match.index, importedNames: [] })
    }
  }

  const declarations = [
    { kind: 'function', re: /\b(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g },
    { kind: 'class', re: /\b(export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'interface', re: /\b(export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'type', re: /\b(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g },
    { kind: 'constant', re: /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g }
  ]

  for (const decl of declarations) {
    for (const match of masked.matchAll(decl.re)) {
      const name = match[2]
      const startLine = lineAt(masked, match.index)
      let endLine = startLine
      let brace = masked.indexOf('{', match.index + match[0].length)
      if (brace >= 0 && (decl.kind === 'function' || decl.kind === 'class' || decl.kind === 'interface')) {
        endLine = lineAt(masked, findBlockEnd(masked, brace))
      } else if (decl.kind === 'constant') {
        let cursor = match.index + match[0].length
        while (/\s/.test(masked[cursor] ?? '')) cursor++
        brace = masked[cursor] === '{' ? cursor : -1
        if (brace >= 0) endLine = lineAt(masked, findBlockEnd(masked, brace))
      }
      symbols.push({
        symbolId: makeSymbolId(file, decl.kind, name, startLine, match.index),
        fileId: file.fileId,
        qualifiedName: name,
        name,
        kind: decl.kind,
        startLine,
        endLine,
        exported: Boolean(match[1]),
        signature: text.split(/\r?\n/)[startLine - 1]?.trim().slice(0, 300) ?? null
      })

      if (decl.kind === 'class' && brace >= 0) {
        const end = findBlockEnd(masked, brace)
        const body = masked.slice(brace + 1, end)
        const methodRe = /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^={]+)?\s*\{/g
        // Only class-body members (depth 0): `name() {` inside a method body is an
        // object-literal method or a nested block, not a member of this class.
        const depthAt = new Int32Array(body.length + 1)
        for (let k = 0, d = 0; k < body.length; k++) { depthAt[k] = d; const ch = body[k]; if (ch === '{' || ch === '(' || ch === '[') d++; else if (ch === '}' || ch === ')' || ch === ']') d-- }
        for (const mm of body.matchAll(methodRe)) {
          const methodName = mm[1]
          if (depthAt[mm.index + Math.max(0, mm[0].indexOf(methodName))] !== 0) continue
          if (['if','for','while','switch','catch','constructor'].includes(methodName)) {
            if (methodName !== 'constructor') continue
          }
          const methodNameOffset = mm[0].indexOf(methodName)
          const absoluteIndex = brace + 1 + mm.index + Math.max(0, methodNameOffset)
          const methodLine = lineAt(masked, absoluteIndex)
          const openOffset = mm[0].lastIndexOf('{')
          const methodOpen = brace + 1 + mm.index + Math.max(0, openOffset)
          const methodEndLine = methodOpen >= 0 ? lineAt(masked, findBlockEnd(masked, methodOpen)) : methodLine
          symbols.push({
            symbolId: makeSymbolId(file, 'method', `${name}.${methodName}`, methodLine, absoluteIndex),
            fileId: file.fileId,
            qualifiedName: `${name}.${methodName}`,
            name: methodName,
            kind: 'method',
            startLine: methodLine,
            endLine: methodEndLine,
            exported: Boolean(match[1]),
            signature: text.split(/\r?\n/)[methodLine - 1]?.trim().slice(0, 300) ?? null
          })
        }
      }
    }
  }

  // exported variable declarations that are not arrow functions
  for (const match of masked.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    if (!symbols.some(s => s.name === name)) {
      const startLine = lineAt(masked, match.index)
      symbols.push({
        symbolId: makeSymbolId(file, 'constant', name, startLine, match.index), fileId: file.fileId,
        qualifiedName: name, name, kind: 'constant', startLine, endLine: startLine,
        exported: true, signature: text.split(/\r?\n/)[startLine - 1]?.trim().slice(0, 300) ?? null
      })
    }
  }

  const { facts, extraSymbols } = extractSemanticFacts({ text, masked, symbols, imports, file })
  for (const extra of extraSymbols) symbols.push({ ...extra, symbolId: makeSymbolId(file, extra.kind, extra.qualifiedName, extra.startLine, extra.sourceOffset), sourceOffset: undefined })
  return { symbols, imports, semantic: facts }
}

function pythonBlockEnd(lines, startIndex, indent) {
  let endLine = startIndex + 1
  for (let i = startIndex + 1; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) { endLine = i + 1; continue }
    const currentIndent = raw.match(/^\s*/)[0].replace(/\t/g, '    ').length
    if (currentIndent <= indent) break
    endLine = i + 1
  }
  return endLine
}

function parsePython(text, file) {
  const lines = text.split(/\r?\n/)
  const symbols = []
  const imports = []
  const classStack = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '    ').length
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop()

    let m = trimmed.match(/^class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/)
    if (m) {
      const name = m[1]
      symbols.push({
        symbolId: makeSymbolId(file, 'class', name, i + 1, i), fileId: file.fileId,
        qualifiedName: name, name, kind: 'class', startLine: i + 1, endLine: pythonBlockEnd(lines, i, indent),
        exported: !name.startsWith('_'), signature: trimmed.slice(0, 300)
      })
      classStack.push({ name, indent })
      continue
    }

    m = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/)
    if (m) {
      const name = m[1]
      const cls = classStack[classStack.length - 1]
      const qualifiedName = cls ? `${cls.name}.${name}` : name
      symbols.push({
        symbolId: makeSymbolId(file, cls ? 'method' : 'function', qualifiedName, i + 1, i), fileId: file.fileId,
        qualifiedName, name, kind: cls ? 'method' : 'function', startLine: i + 1, endLine: pythonBlockEnd(lines, i, indent),
        exported: !name.startsWith('_'), signature: trimmed.slice(0, 300)
      })
      continue
    }

    m = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/)
    if (m) {
      imports.push({ specifier: m[1], line: i + 1, sourceOffset: i, importedNames: m[2].split(',').map(v => v.trim().split(/\s+as\s+/)[0]) })
      continue
    }
    m = trimmed.match(/^import\s+(.+)$/)
    if (m) {
      for (const [partIndex, part] of m[1].split(',').entries()) {
        imports.push({ specifier: part.trim().split(/\s+as\s+/)[0], line: i + 1, sourceOffset: `${i}:${partIndex}`, importedNames: [] })
      }
    }
  }
  const { facts } = extractSemanticFacts({ text, symbols, imports, file })
  // Keep `as` aliases and parenthesized multi-line names that the line scan above cannot see.
  for (const imp of facts.imports) {
    const existing = imports.find(entry => entry.specifier === imp.specifier && entry.line === imp.line)
    const importedNames = imp.bindings.map(b => ({ importedName: b.imported, localName: b.local, kind: 'named' }))
    if (existing) existing.importedNames = importedNames
    else imports.push({ specifier: imp.specifier, line: imp.line, sourceOffset: `py${imp.line}`, importedNames })
  }
  return { symbols, imports, semantic: facts }
}

export async function parseFile(file) {
  const text = await fs.readFile(file.absPath, 'utf8')
  let parsed
  if (file.language === 'Python') parsed = parsePython(text, file)
  else parsed = parseJsTs(text, file)
  return { ...parsed, summary: deterministicSummary(file, parsed.symbols) }
}

export function deterministicSummary(file, symbols) {
  const exported = symbols.filter(s => s.exported).slice(0, 6)
  const classes = symbols.filter(s => s.kind === 'class').slice(0, 3)
  const funcs = symbols.filter(s => s.kind === 'function').slice(0, 4)
  const parts = []
  if (file.isTest) parts.push(`${file.language} test module`)
  else parts.push(`${file.language} module`)
  if (classes.length) parts.push(`classes: ${classes.map(s => s.name).join(', ')}`)
  if (funcs.length) parts.push(`functions: ${funcs.map(s => s.name).join(', ')}`)
  if (exported.length) parts.push(`exports: ${exported.map(s => s.name).join(', ')}`)
  return parts.join('; ').slice(0, 400)
}

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

function id(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex')
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

function parseJsTs(text, file) {
  const symbols = []
  const imports = []
  const masked = stripCommentsAndStrings(text)

  const importPatterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ]
  for (const pattern of importPatterns) {
    for (const match of text.matchAll(pattern)) {
      imports.push({ specifier: match[1], line: lineAt(text, match.index), importedNames: [] })
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
      const brace = masked.indexOf('{', match.index + match[0].length)
      if (brace >= 0 && (decl.kind === 'function' || decl.kind === 'class' || decl.kind === 'interface')) {
        endLine = lineAt(masked, findBlockEnd(masked, brace))
      }
      symbols.push({
        symbolId: id([file.path, decl.kind, name, String(startLine)]),
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
        for (const mm of body.matchAll(methodRe)) {
          const methodName = mm[1]
          if (['if','for','while','switch','catch','constructor'].includes(methodName)) {
            if (methodName !== 'constructor') continue
          }
          const absoluteIndex = brace + 1 + mm.index
          const methodLine = lineAt(masked, absoluteIndex)
          symbols.push({
            symbolId: id([file.path, 'method', `${name}.${methodName}`, String(methodLine)]),
            fileId: file.fileId,
            qualifiedName: `${name}.${methodName}`,
            name: methodName,
            kind: 'method',
            startLine: methodLine,
            endLine: methodLine,
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
        symbolId: id([file.path, 'constant', name, String(startLine)]), fileId: file.fileId,
        qualifiedName: name, name, kind: 'constant', startLine, endLine: startLine,
        exported: true, signature: text.split(/\r?\n/)[startLine - 1]?.trim().slice(0, 300) ?? null
      })
    }
  }

  return { symbols, imports }
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
        symbolId: id([file.path, 'class', name, String(i + 1)]), fileId: file.fileId,
        qualifiedName: name, name, kind: 'class', startLine: i + 1, endLine: i + 1,
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
        symbolId: id([file.path, cls ? 'method' : 'function', qualifiedName, String(i + 1)]), fileId: file.fileId,
        qualifiedName, name, kind: cls ? 'method' : 'function', startLine: i + 1, endLine: i + 1,
        exported: !name.startsWith('_'), signature: trimmed.slice(0, 300)
      })
      continue
    }

    m = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/)
    if (m) {
      imports.push({ specifier: m[1], line: i + 1, importedNames: m[2].split(',').map(v => v.trim().split(/\s+as\s+/)[0]) })
      continue
    }
    m = trimmed.match(/^import\s+(.+)$/)
    if (m) {
      for (const part of m[1].split(',')) imports.push({ specifier: part.trim().split(/\s+as\s+/)[0], line: i + 1, importedNames: [] })
    }
  }
  return { symbols, imports }
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

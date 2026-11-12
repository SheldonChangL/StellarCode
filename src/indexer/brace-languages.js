import path from 'node:path'

// Lexical tier for brace-delimited languages (Rust, Kotlin, Swift): declarations with exact
// line ranges, and import statements resolved to repository files where the language names
// a file. No semantic facts are produced, so these languages report `lexical-only`.
export const BRACE_LANGUAGES = new Set(['Rust', 'Kotlin', 'Swift'])

// ---------------------------------------------------------------- masking

// Index just past the string or character literal that starts at `i`, or `i` when no
// literal starts there. Interpolated code (`${...}`, `\(...)`) is part of the literal.
function literalEnd(text, i, language) {
  const n = text.length
  const c = text[i]
  const nested = (j, open, close) => {
    let depth = 1
    while (j < n && depth) {
      const ch = text[j]
      if (ch === open) depth++
      else if (ch === close) depth--
      else if (ch === '"' || ch === "'" || ch === '#') {
        const end = literalEnd(text, j, language)
        if (end > j) { j = end; continue }
      }
      j++
    }
    return j
  }
  // `j` is just past the opening quotes. `raw` strings have no escapes.
  const quoted = (j, triple, { raw = false, hashes = '' } = {}) => {
    const closer = (triple ? '"""' : '"') + hashes
    while (j < n) {
      if (text.startsWith(closer, j)) {
        j += closer.length
        while (triple && !hashes && text[j] === '"') j++
        return j
      }
      const ch = text[j]
      if (!triple && ch === '\n' && language !== 'Rust') return j // unterminated: recover
      if (ch === '\\' && !raw) {
        if (language === 'Swift' && text[j + 1] === '(') { j = nested(j + 2, '(', ')'); continue }
        j += 2
        continue
      }
      if (language === 'Kotlin' && ch === '$' && text[j + 1] === '{') { j = nested(j + 2, '{', '}'); continue }
      j++
    }
    return n
  }
  // 'x', '\n', '\u{1F600}'. A Rust lifetime (`'a`) has no closing quote and is not a literal.
  const character = at => {
    if (text[at + 1] === '\\') {
      let j = at + 1
      while (j < n && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      return text[j] === "'" ? j + 1 : i
    }
    if (text[at + 1] !== '\n' && text[at + 2] === "'") return at + 3
    const code = text.charCodeAt(at + 1)
    if (code >= 0xd800 && code <= 0xdbff && text[at + 3] === "'") return at + 4
    return i
  }

  if (language === 'Rust') {
    if ((c === 'r' || c === 'b' || c === 'c') && !/\w/.test(text[i - 1] ?? '')) {
      const raw = /^[bc]?r(#*)"/.exec(text.slice(i, i + 24))
      if (raw) {
        const end = text.indexOf(`"${raw[1]}`, i + raw[0].length)
        return end < 0 ? n : end + 1 + raw[1].length
      }
      if (c !== 'r' && text[i + 1] === '"') return quoted(i + 2, false)
      if (c === 'b' && text[i + 1] === "'") return character(i + 1)
    }
    if (c === '"') return quoted(i + 1, false)
    if (c === "'") return character(i)
    return i
  }
  if (language === 'Kotlin') {
    if (c === '"') return text.startsWith('"""', i) ? quoted(i + 3, true, { raw: true }) : quoted(i + 1, false)
    if (c === "'") return character(i)
    return i
  }
  // Swift
  if (c === '#') {
    let h = 0
    while (text[i + h] === '#') h++
    if (text[i + h] !== '"') return i
    const triple = text.startsWith('"""', i + h)
    return quoted(i + h + (triple ? 3 : 1), triple, { raw: true, hashes: '#'.repeat(h) })
  }
  if (c === '"') return text.startsWith('"""', i) ? quoted(i + 3, true) : quoted(i + 1, false)
  return i
}

// Comments and literals replaced by spaces; offsets and line breaks are unchanged. A literal
// keeps one `"` where it starts, so an expression that ends in one still has an operand.
export function maskBraceSource(text, language) {
  const out = text.split('')
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blank(i, j); i = j; continue
    }
    if (c === '/' && text[i + 1] === '*') {
      // Block comments nest in all three languages.
      let depth = 1, j = i + 2
      while (j < n && depth) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2 }
        else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2 }
        else j++
      }
      blank(i, j); i = j; continue
    }
    if (c === '"' || c === "'" || c === '#' || c === 'r' || c === 'b' || c === 'c') {
      const end = literalEnd(text, i, language)
      if (end > i) { blank(i, end); out[i] = '"'; i = end; continue }
    }
    i++
  }
  return out.join('')
}

// ---------------------------------------------------------------- structure

function lineIndex(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return offset => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1
    }
    return lo + 1
  }
}

function matchClose(masked, open) {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}' && --depth === 0) return i
  }
  return masked.length - 1
}

// Index of the `>` closing the `<` at `open` (`->` is not a bracket), or -1.
function angleClose(masked, open) {
  let depth = 0
  for (let i = open; i < Math.min(masked.length, open + 600); i++) {
    const c = masked[i]
    if (c === '<') depth++
    else if (c === '>' && masked[i - 1] !== '-' && --depth === 0) return i
    else if (c === '{' || c === ';') return -1
  }
  return -1
}

function previousCode(masked, index) {
  let p = index - 1
  while (p >= 0 && /\s/.test(masked[p])) p--
  return p
}

// A declaration header may continue on the next line (`class A(...)\n    : Base() {`).
function headerContinues(masked, newlineAt) {
  const p = previousCode(masked, newlineAt)
  const prev = masked[p]
  if (prev === ',' || prev === ':' || (prev === '>' && masked[p - 1] === '-')) return true
  let q = newlineAt + 1
  while (q < masked.length && /\s/.test(masked[q])) q++
  return /^(?:[{:=]|->|where\b|throws\b|rethrows\b|async\b|(?:@\w+(?:\([^)]*\))?\s+)?(?:(?:private|protected|internal|public)\s+)?constructor\b)/.test(masked.slice(q, q + 64))
}

// Scans a declaration header from `from` to where its body starts or the declaration ends:
// { open } for a `{` body, { expr } for an `= expression` body, { end } for no body.
function headerEnd(masked, from, { newlineEnds = false, exprBody = false } = {}) {
  let depth = 0
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') { if (--depth < 0) return { end: i - 1 } }
    else if (depth === 0) {
      if (c === '{') return { open: i }
      if (c === '}') return { end: i - 1 }
      if (c === ';') return { end: i }
      if (exprBody && c === '=' && masked[i + 1] !== '=' && !'=!<>'.includes(masked[i - 1])) return { expr: i + 1 }
      if (newlineEnds && c === '\n' && !headerContinues(masked, i)) return { end: Math.max(from, previousCode(masked, i)) }
    }
  }
  return { end: masked.length - 1 }
}

// Last index of the expression starting at `from`, for languages that end a statement at
// a line break: the line break ends it unless a bracket is open or an operator dangles.
function expressionEnd(masked, from) {
  let depth = 0, last = from - 1
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return last }
    else if (c === ';' && depth === 0) return last
    else if (c === '\n' && depth === 0) {
      const prev = masked[last] ?? ''
      const two = masked.slice(Math.max(0, last - 1), last + 1)
      let q = i + 1
      while (q < masked.length && /\s/.test(masked[q])) q++
      const continues = '=+-*/%&|,('.includes(prev) || two === '?:' || two === '->' ||
        /^(?:\.|\?\.|\?:|&&|\|\||else\b|as\b)/.test(masked.slice(q, q + 6))
      if (!continues) return last
    }
    if (!/\s/.test(c)) last = i
  }
  return masked.length - 1
}

// End of a `;`-terminated item (Rust), with every bracket kind balanced.
function statementEnd(masked, from) {
  let depth = 0
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return i - 1 }
    else if (c === ';' && depth === 0) return i
  }
  return masked.length - 1
}

// True where an item can start: after `{`, `}`, `;`, an attribute, or at the file start.
function itemStart(masked, index) {
  const p = previousCode(masked, index)
  if (p < 0 || '{};]'.includes(masked[p])) return true
  return /\b(?:unsafe|default)$/.test(masked.slice(Math.max(0, p - 8), p + 1))
}

function createContext(text, language) {
  const masked = maskBraceSource(text, language)
  const nest = new Int32Array(masked.length + 1)
  for (let i = 0, d = 0; i < masked.length; i++) {
    nest[i] = d
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') d++
    else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1)
  }
  const ctx = {
    masked, nest, language, decls: [], containers: [], imports: [],
    // `header` is a headerEnd() result; `container` describes the body it opens.
    declare({ kind, name, index, exported, header, endIndex, container }) {
      let end = endIndex ?? index
      if (header?.open !== undefined) {
        end = matchClose(masked, header.open)
        if (container) ctx.containers.push({ open: header.open, close: end, ...container })
      } else if (header?.expr !== undefined) end = expressionEnd(masked, header.expr)
      else if (header) end = header.end
      if (name) ctx.decls.push({ kind, name, index, end, exported })
    }
  }
  return ctx
}

// ---------------------------------------------------------------- Rust

const RUST_VIS = String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?`

function rustImplTarget(header) {
  let h = header.split(/\bwhere\b/)[0].trimStart()
  if (h.startsWith('<')) { const close = angleClose(h, 0); if (close >= 0) h = h.slice(close + 1) }
  let depth = 0, target = h
  for (let i = 0; i < h.length; i++) {
    const c = h[i]
    if (c === '<') depth++
    else if (c === '>' && h[i - 1] !== '-') depth--
    else if (depth === 0 && h.startsWith('for', i) && !/\w/.test(h[i - 1] ?? ' ') && !/\w/.test(h[i + 3] ?? ' ')) { target = h.slice(i + 3); break }
  }
  return /^[\s&]*(?:(?:mut|dyn)\s+)*(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)/.exec(target)?.[1] ?? null
}

function expandUseTree(tree, prefix = [], out = []) {
  const value = tree.trim()
  const brace = value.indexOf('{')
  if (brace >= 0) {
    let depth = 0, close = value.length
    for (let i = brace; i < value.length; i++) {
      if (value[i] === '{') depth++
      else if (value[i] === '}' && --depth === 0) { close = i; break }
    }
    const head = value.slice(0, brace).split('::').map(s => s.trim()).filter(Boolean)
    let start = brace + 1
    depth = 0
    for (let i = brace + 1; i <= close; i++) {
      const c = value[i]
      if (c === '{') depth++
      else if (c === '}' && i !== close) depth--
      if ((c === ',' && depth === 0) || i === close) {
        expandUseTree(value.slice(start, i), [...prefix, ...head], out)
        start = i + 1
      }
    }
    return out
  }
  const [pathText, alias] = value.split(/\s+as\s+/)
  const segments = pathText.split('::').map(s => s.trim()).filter(Boolean)
  if (segments.length && segments.every(s => /^(?:\*|[A-Za-z_]\w*)$/.test(s))) out.push({ path: [...prefix, ...segments], alias: alias?.trim() })
  return out
}

function extractRust(ctx) {
  const { masked } = ctx
  const pending = []
  for (const m of masked.matchAll(/\b((?:(?:pub(?:\s*\([^)]*\))?|default|const|async|unsafe|extern(?:\s*")?)\s+)*)fn\s+([A-Za-z_]\w*)/g)) {
    ctx.declare({ kind: 'function', name: m[2], index: m.index, exported: /\bpub\b/.test(m[1]),
      header: headerEnd(masked, m.index + m[0].length), container: { kind: 'function' } })
  }
  for (const m of masked.matchAll(new RegExp(String.raw`\b(${RUST_VIS})(?:unsafe\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)`, 'g'))) {
    const exported = Boolean(m[1])
    ctx.declare({ kind: m[2] === 'trait' ? 'interface' : 'class', name: m[3], index: m.index, exported,
      header: headerEnd(masked, m.index + m[0].length), container: { kind: 'type', name: m[3], memberExported: m[2] === 'trait' && exported } })
  }
  for (const m of masked.matchAll(/\bimpl\b/g)) {
    if (!itemStart(masked, m.index)) continue
    const header = headerEnd(masked, m.index + 4)
    if (header.open === undefined) continue
    const text = masked.slice(m.index + 4, header.open)
    ctx.containers.push({ open: header.open, close: matchClose(masked, header.open), kind: 'type', name: rustImplTarget(text), memberExported: /\sfor\s/.test(text.split(/\bwhere\b/)[0]) })
  }
  for (const m of masked.matchAll(new RegExp(String.raw`\b${RUST_VIS}mod\s+([A-Za-z_]\w*)\s*([;{])`, 'g'))) {
    if (m[2] === '{') {
      const open = m.index + m[0].length - 1
      ctx.containers.push({ open, close: matchClose(masked, open), kind: 'module' })
    } else pending.push({ path: ['self', m[1]], index: m.index, declaration: true })
  }
  for (const m of masked.matchAll(new RegExp(String.raw`\b(${RUST_VIS})(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:`, 'g'))) {
    if (m[2] === '_' || !itemStart(masked, m.index)) continue
    ctx.declare({ kind: 'constant', name: m[2], index: m.index, exported: Boolean(m[1]), endIndex: statementEnd(masked, m.index + m[0].length) })
  }
  for (const m of masked.matchAll(new RegExp(String.raw`\b(${RUST_VIS})type\s+([A-Za-z_]\w*)`, 'g'))) {
    if (!itemStart(masked, m.index)) continue
    ctx.declare({ kind: 'type', name: m[2], index: m.index, exported: Boolean(m[1]), endIndex: statementEnd(masked, m.index + m[0].length) })
  }
  for (const m of masked.matchAll(/\bmacro_rules!\s*([A-Za-z_]\w*)\s*\{/g)) {
    ctx.declare({ kind: 'function', name: m[1], index: m.index, exported: false, header: { open: m.index + m[0].length - 1 }, container: { kind: 'function' } })
  }
  for (const m of masked.matchAll(new RegExp(String.raw`\b${RUST_VIS}use\s+([^;]+);`, 'g'))) {
    if (!itemStart(masked, m.index)) continue
    for (const entry of expandUseTree(m[1])) pending.push({ ...entry, index: m.index })
  }

  // Inside an inline `mod m { ... }`, `self` is that module and each `super` climbs one
  // inline level first, so those paths name this file and are not file dependencies.
  const modules = ctx.containers.filter(c => c.kind === 'module')
  for (const [n, entry] of pending.entries()) {
    let inline = modules.filter(c => c.open < entry.index && entry.index < c.close).length
    const segments = [...entry.path]
    if (inline > 0) {
      if (entry.declaration || segments[0] === 'self') continue
      let climbed = false
      while (inline > 0 && segments[0] === 'super') { segments.shift(); inline--; climbed = true }
      if (climbed && segments[0] !== 'super') continue
    }
    let last = segments[segments.length - 1]
    const glob = last === '*'
    if (glob) segments.pop()
    if (segments[segments.length - 1] === 'self' && segments.length > 1) segments.pop()
    if (!segments.length) continue
    last = segments[segments.length - 1]
    ctx.imports.push({
      specifier: segments.join('::'), index: entry.index, sourceOffset: `rs${entry.index}:${n}`,
      importedNames: glob || entry.declaration ? [] : [{ importedName: last, localName: entry.alias ?? last, kind: 'named' }]
    })
  }
}

// ---------------------------------------------------------------- Kotlin

const KOTLIN_MODIFIERS = 'public|private|protected|internal|open|abstract|final|sealed|data|enum|inner|value|annotation|inline|suspend|override|operator|infix|tailrec|external|const|lateinit|actual|expect|companion|fun'
const KOTLIN_MODS = `((?:(?:${KOTLIN_MODIFIERS})\\s+)*)`
const NOT_A_NAME = new Set(['in', 'is', 'as', 'func', 'var', 'let', 'subscript', 'init', 'case', 'where'])

function extractKotlin(ctx) {
  const { masked, nest } = ctx
  const visible = mods => !/\bprivate\b/.test(mods)
  for (const m of masked.matchAll(new RegExp(`\\b${KOTLIN_MODS}(class|interface|object)\\s+([A-Za-z_]\\w*)`, 'g'))) {
    if (NOT_A_NAME.has(m[3]) || masked[m.index - 1] === ':') continue
    const header = headerEnd(masked, m.index + m[0].length, { newlineEnds: true })
    if (/\bcompanion\b/.test(m[1])) {
      if (header.open !== undefined) ctx.containers.push({ open: header.open, close: matchClose(masked, header.open), kind: 'module' })
      continue
    }
    ctx.declare({ kind: m[2] === 'interface' ? 'interface' : 'class', name: m[3], index: m.index, exported: visible(m[1]),
      header, container: { kind: 'type', name: m[3], exported: visible(m[1]) } })
  }
  for (const m of masked.matchAll(/\bcompanion\s+object\b(?!\s+[A-Za-z_])/g)) {
    const header = headerEnd(masked, m.index + m[0].length, { newlineEnds: true })
    if (header.open !== undefined) ctx.containers.push({ open: header.open, close: matchClose(masked, header.open), kind: 'module' })
  }
  for (const m of masked.matchAll(new RegExp(`\\b${KOTLIN_MODS}fun\\s+`, 'g'))) {
    let i = m.index + m[0].length
    if (masked[i] === '<') { const close = angleClose(masked, i); if (close < 0) continue; i = close + 1 }
    const paren = masked.indexOf('(', i)
    if (paren < 0) continue
    const head = masked.slice(i, paren)
    // Optional receiver type, then the name: `fun <T> List<T>.second(`.
    const name = /[\n{}=;]/.test(head) ? null : /(?:^|[.\s])(`[^`]+`|[A-Za-z_]\w*)\s*$/.exec(head)?.[1]
    if (!name) continue
    ctx.declare({ kind: 'function', name: name.replaceAll('`', ''), index: m.index, exported: visible(m[1]),
      header: headerEnd(masked, paren, { newlineEnds: true, exprBody: true }), container: { kind: 'function' } })
  }
  for (const m of masked.matchAll(new RegExp(`\\b${KOTLIN_MODS}typealias\\s+([A-Za-z_]\\w*)`, 'g'))) {
    ctx.declare({ kind: 'type', name: m[2], index: m.index, exported: visible(m[1]), endIndex: expressionEnd(masked, m.index + m[0].length) })
  }
  // Module-level properties and `const val` members; other properties are not symbols.
  for (const m of masked.matchAll(new RegExp(`\\b${KOTLIN_MODS}(?:val|var)\\s+(?:[A-Za-z_][\\w.]*\\.)?([A-Za-z_]\\w*)`, 'g'))) {
    if (nest[m.index] !== 0 && !/\bconst\b/.test(m[1])) continue
    ctx.declare({ kind: 'constant', name: m[2], index: m.index, exported: visible(m[1]), endIndex: expressionEnd(masked, m.index + m[0].length) })
  }
  for (const m of masked.matchAll(/^[ \t]*import[ \t]+([\w.`]+?)(\.\*)?(?:[ \t]+as[ \t]+(\w+))?[ \t]*;?[ \t\r]*$/gm)) {
    const specifier = m[1].replaceAll('`', '')
    const last = specifier.split('.').pop()
    ctx.imports.push({ specifier: m[2] ? `${specifier}.*` : specifier, index: m.index, sourceOffset: `kt${m.index}`,
      importedNames: m[2] ? [] : [{ importedName: last, localName: m[3] ?? last, kind: 'named' }] })
  }
}

// ---------------------------------------------------------------- Swift

const SWIFT_MODIFIERS = 'public|private|fileprivate|internal|open|package|final|static|class|override|mutating|nonmutating|convenience|required|indirect|lazy|weak|unowned|dynamic|nonisolated|isolated|distributed|consuming|borrowing'
const SWIFT_MODS = `((?:(?:${SWIFT_MODIFIERS})(?:\\(set\\))?\\s+)*)`

function extractSwift(ctx) {
  const { masked, nest } = ctx
  const visible = mods => !/\b(?:private|fileprivate)\b/.test(mods.replace(/\b(?:private|fileprivate)\(set\)/g, ''))
  for (const m of masked.matchAll(new RegExp(`\\b${SWIFT_MODS}(class|struct|enum|protocol|actor|extension)\\s+([A-Za-z_][\\w.]*)`, 'g'))) {
    const name = m[3].split('.').filter(Boolean).pop()
    if (!name || NOT_A_NAME.has(name) || masked[m.index - 1] === '.') continue
    const header = headerEnd(masked, m.index + m[0].length, { newlineEnds: true })
    if (header.open === undefined) continue
    const container = { kind: 'type', name, exported: visible(m[1]) }
    // An extension adds members to a type declared elsewhere; it is not a symbol itself.
    if (m[2] === 'extension') ctx.containers.push({ open: header.open, close: matchClose(masked, header.open), ...container })
    else ctx.declare({ kind: m[2] === 'protocol' ? 'interface' : 'class', name, index: m.index, exported: visible(m[1]), header, container })
  }
  for (const m of masked.matchAll(new RegExp(`\\b${SWIFT_MODS}func\\s+(\`[^\`\\n]+\`|[A-Za-z_]\\w*)\\s*(?=[<(])`, 'g'))) {
    let i = m.index + m[0].length
    if (masked[i] === '<') { const close = angleClose(masked, i); if (close < 0) continue; i = close + 1 }
    if (masked[i] !== '(') continue
    ctx.declare({ kind: 'function', name: m[2].replaceAll('`', ''), index: m.index, exported: visible(m[1]),
      header: headerEnd(masked, i, { newlineEnds: true }), container: { kind: 'function' } })
  }
  for (const m of masked.matchAll(new RegExp(`\\b${SWIFT_MODS}init\\s*[?!]?\\s*(?=[<(])`, 'g'))) {
    // `self.init(...)` and `Type.init(...)` are calls.
    if (!m[1] && '.(,=:'.includes(masked[previousCode(masked, m.index)] ?? '')) continue
    let i = m.index + m[0].length
    if (masked[i] === '<') { const close = angleClose(masked, i); if (close < 0) continue; i = close + 1 }
    const header = headerEnd(masked, i, { newlineEnds: true })
    if (header.open === undefined) continue
    ctx.declare({ kind: 'function', name: 'init', index: m.index, exported: visible(m[1]), header, container: { kind: 'function' } })
  }
  for (const m of masked.matchAll(new RegExp(`\\b${SWIFT_MODS}typealias\\s+([A-Za-z_]\\w*)`, 'g'))) {
    ctx.declare({ kind: 'type', name: m[2], index: m.index, exported: visible(m[1]), endIndex: expressionEnd(masked, m.index + m[0].length) })
  }
  // Module-level bindings and static members; instance properties are not symbols.
  for (const m of masked.matchAll(new RegExp(`\\b${SWIFT_MODS}(?:let|var)\\s+([A-Za-z_]\\w*)`, 'g'))) {
    if (!/\b(?:static|class)\b/.test(m[1])) {
      if (nest[m.index] !== 0) continue
      const before = masked.slice(Math.max(0, m.index - 12), m.index)
      if (/(?:\b(?:if|guard|while|case|for)\s+|,\s*)$/.test(before)) continue
    }
    ctx.declare({ kind: 'constant', name: m[2], index: m.index, exported: visible(m[1]), endIndex: expressionEnd(masked, m.index + m[0].length) })
  }
  for (const m of masked.matchAll(/^[ \t]*(?:@\w+[ \t]+)*import[ \t]+(?:(?:class|struct|enum|protocol|func|var|let|typealias)[ \t]+)?([\w.]+)/gm)) {
    ctx.imports.push({ specifier: m[1], index: m.index, sourceOffset: `sw${m.index}`, importedNames: [] })
  }
}

// ---------------------------------------------------------------- symbols

const EXTRACT = { Rust: extractRust, Kotlin: extractKotlin, Swift: extractSwift }

// Symbols carry `sourceOffset` instead of an id; the caller derives the id.
export function parseBraceLanguage(text, language) {
  const ctx = createContext(text, language)
  EXTRACT[language](ctx)
  const lineOf = lineIndex(text)
  const lines = text.split(/\r?\n/)
  const containers = ctx.containers.sort((a, b) => a.open - b.open)
  const decls = ctx.decls.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind))
  const symbols = []
  const stack = []
  let next = 0
  for (const decl of decls) {
    while (next < containers.length && containers[next].open < decl.index) stack.push(containers[next++])
    while (stack.length && stack[stack.length - 1].close < decl.index) stack.pop()
    // A stale outer entry can sit under a live one only if it also still encloses us.
    let owner = null
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].close < decl.index || stack[k].kind === 'module') continue
      owner = stack[k]
      break
    }
    let { kind } = decl
    let qualifiedName = decl.name
    let exported = decl.exported
    if (owner?.kind === 'function') {
      if (kind === 'constant' || kind === 'type') continue
      exported = false
    } else if (owner?.kind === 'type') {
      if (kind === 'function') kind = 'method'
      if (kind !== 'class' && kind !== 'interface' && owner.name) qualifiedName = `${owner.name}.${decl.name}`
      exported = language === 'Rust' ? exported || Boolean(owner.memberExported) : exported && owner.exported !== false
    } else if (language === 'Swift' && decl.name === 'init') continue
    const startLine = lineOf(decl.index)
    symbols.push({
      qualifiedName, name: decl.name, kind, startLine, endLine: Math.max(startLine, lineOf(decl.end)),
      exported, signature: lines[startLine - 1]?.trim().slice(0, 300) ?? null, sourceOffset: decl.index
    })
  }
  const imports = ctx.imports.map(({ index, ...entry }) => ({ ...entry, line: lineOf(index) }))
  return { symbols, imports }
}

// ---------------------------------------------------------------- import resolution

const indexes = new WeakMap()

function fileIndex(fileSet) {
  let index = indexes.get(fileSet)
  if (index) return index
  index = { kotlin: new Map(), crates: new Map() }
  for (const file of fileSet) {
    if (file.endsWith('.kt')) {
      const stem = path.posix.basename(file, '.kt')
      if (!index.kotlin.has(stem)) index.kotlin.set(stem, [])
      index.kotlin.get(stem).push(file)
    } else if (file.endsWith('/src/lib.rs')) {
      const crate = path.posix.basename(file.slice(0, -'/src/lib.rs'.length)).replaceAll('-', '_')
      if (!index.crates.has(crate)) index.crates.set(crate, [])
      index.crates.get(crate).push(file)
    }
  }
  indexes.set(fileSet, index)
  return index
}

// The directory holding a Rust module's child modules.
function rustChildDir(file) {
  const dir = path.posix.dirname(file)
  const name = path.posix.basename(file, '.rs')
  return ['mod', 'lib', 'main'].includes(name) ? dir : path.posix.join(dir, name)
}

const join = (dir, name) => (dir === '.' || dir === '' ? name : `${dir}/${name}`)

function rustModuleFile(dir, fileSet) {
  return [`${dir}.rs`, join(dir, 'mod.rs'), join(dir, 'lib.rs'), join(dir, 'main.rs')].find(c => fileSet.has(c)) ?? null
}

function resolveRustImport(source, specifier, fileSet) {
  const segments = specifier.split('::')
  const walk = (dir, rest) => {
    let found = null
    for (const segment of rest) {
      const candidate = [join(dir, `${segment}.rs`), join(dir, `${segment}/mod.rs`)].find(c => fileSet.has(c))
      if (!candidate) break
      found = candidate
      dir = join(dir, segment)
    }
    return found
  }
  let dir, rest
  if (segments[0] === 'crate') {
    dir = null
    for (let d = path.posix.dirname(source); ; d = path.posix.dirname(d)) {
      if (fileSet.has(join(d, 'lib.rs')) || fileSet.has(join(d, 'main.rs'))) { dir = d; break }
      if (d === '.' || d === '' || path.posix.basename(d) === 'src') break
    }
    if (dir === null) return null
    rest = segments.slice(1)
  } else if (segments[0] === 'self') {
    dir = rustChildDir(source)
    rest = segments.slice(1)
  } else if (segments[0] === 'super') {
    dir = rustChildDir(source)
    let k = 0
    while (segments[k] === 'super') { dir = path.posix.dirname(dir); k++ }
    rest = segments.slice(k)
  } else {
    // A child module of this file, else a crate of the same workspace.
    const child = walk(rustChildDir(source), segments)
    if (child) return child
    const roots = fileIndex(fileSet).crates.get(segments[0])
    if (roots?.length !== 1) return null
    dir = path.posix.dirname(roots[0])
    rest = segments.slice(1)
  }
  // An item that is not a module file is declared (or re-exported) by the module itself.
  const target = walk(dir, rest) ?? rustModuleFile(dir, fileSet)
  return target === source ? null : target
}

// Kotlin names a class, not a file: `com.app.data.Repo` is `**/com/app/data/Repo.kt` by
// convention. Trailing segments are dropped for nested classes and companion members.
function resolveKotlinImport(source, specifier, fileSet) {
  const segments = specifier.split('.')
  const { kotlin } = fileIndex(fileSet)
  for (let k = segments.length; k >= 2; k--) {
    const pkg = segments.slice(0, k - 1).join('/')
    const matches = (kotlin.get(segments[k - 1]) ?? []).filter(file => {
      const dir = path.posix.dirname(file)
      return dir === pkg || dir.endsWith(`/${pkg}`)
    })
    if (matches.length === 1) return matches[0] === source ? null : matches[0]
    if (matches.length > 1) return null
  }
  return null
}

// Resolved file path or null; undefined when `source` is not a brace-language file.
export function resolveBraceImport(source, specifier, fileSet) {
  if (source.endsWith('.rs')) return resolveRustImport(source, specifier, fileSet)
  if (source.endsWith('.kt')) return resolveKotlinImport(source, specifier, fileSet)
  if (source.endsWith('.swift')) return null // Swift imports name modules, never files
  return undefined
}

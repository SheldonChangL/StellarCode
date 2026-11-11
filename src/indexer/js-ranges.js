// Bounded deterministic JS/TS range scanning shared by the parser and semantic extraction.
// Not a JavaScript parser: it only locates balanced groups and function bodies, and
// returns -1 / null when the input cannot be read with confidence.

// Index of the bracket that closes the one at `open` ((), {} or []), or -1.
export function matchBracket(masked, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' }
  const stack = []
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]
    if (pairs[c]) stack.push(pairs[c])
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

// ---- bounded JS/TS body location -------------------------------------------------
// Function bodies are found structurally, never as "first `{` after the name": the
// parameter list is skipped as one balanced (...) group (so `{ params }` destructuring is
// not a body), then an optional return-type annotation, then the body `{`. Anything the
// scanner cannot read with confidence returns -1 and the caller keeps a one-line range.

const skipWs = (masked, i) => { while (i < masked.length && /\s/.test(masked[i])) i++; return i }

// Skip a TS return-type annotation starting at the `:`; returns the index of the first
// character after the type (where `{` / `=>` / `;` is expected), or -1.
export function skipReturnType(masked, colon, { arrow = false } = {}) {
  let i = skipWs(masked, colon + 1)
  let depth = 0
  let prev = ':'
  for (let steps = 0; i < masked.length && steps < 2000; i++, steps++) {
    const c = masked[i]
    if (c === '=' && masked[i + 1] === '>') {
      if (depth === 0 && arrow) return i
      i++; prev = '>'; continue
    }
    if (c === '(' || c === '[' || c === '<') { depth++; prev = c; continue }
    if (c === ')' || c === ']' || c === '>') { if (--depth < 0) return -1; prev = c; continue }
    if (c === '{') {
      // `{` right after an operator position starts an object type, otherwise the body.
      if (depth === 0 && !arrow && !/[:|&,<(=]/.test(prev)) return i
      const close = matchBracket(masked, i)
      if (close < 0) return -1
      i = close; prev = '}'; continue
    }
    if (depth === 0 && (c === ';' || (c === '=' && !arrow))) return i
    if (!/\s/.test(c)) prev = c
  }
  return -1
}

// Given the index of the parameter list `(`, return the body `{` index, -1 when there is
// no readable body (overload signature, unbalanced input).
export function functionBodyOpen(masked, parenOpen) {
  const close = matchBracket(masked, parenOpen)
  if (close < 0) return -1
  let i = skipWs(masked, close + 1)
  if (masked[i] === ':') { i = skipReturnType(masked, i); if (i < 0) return -1; i = skipWs(masked, i) }
  return masked[i] === '{' ? i : -1
}

// For `const f = <here>…`, recognise an arrow function and return { bodyOpen, endIndex }.
// bodyOpen is the `{` of a block body; endIndex is the last index of the function.
export function arrowFunctionRange(masked, start) {
  let i = skipWs(masked, start)
  if (/^async\b/.test(masked.slice(i, i + 6))) i = skipWs(masked, i + 5)
  const fn = masked.slice(i, i + 200).match(/^function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*(?:<[^()]*?>)?\s*\(/)
  if (fn) { // function expression `= async function (req) { … }`
    const bodyOpen = functionBodyOpen(masked, i + fn[0].length - 1)
    const end = bodyOpen >= 0 ? matchBracket(masked, bodyOpen) : -1
    return end < 0 ? null : { bodyOpen, endIndex: end }
  }
  if (masked[i] === '<') { // generic arrow `<T,>(x: T) =>`
    let depth = 0
    for (; i < masked.length; i++) { if (masked[i] === '<') depth++; else if (masked[i] === '>') { if (--depth === 0) break } else if (masked[i] === '\n' || masked[i] === ';') return null }
    i = skipWs(masked, i + 1)
  }
  if (masked[i] === '(') {
    const close = matchBracket(masked, i)
    if (close < 0) return null
    i = skipWs(masked, close + 1)
    if (masked[i] === ':') { i = skipReturnType(masked, i, { arrow: true }); if (i < 0) return null }
  } else {
    const ident = masked.slice(i).match(/^[A-Za-z_$][\w$]*/)
    if (!ident) return null
    i = skipWs(masked, i + ident[0].length)
  }
  if (masked[i] !== '=' || masked[i + 1] !== '>') return null
  i = skipWs(masked, i + 2)
  if (masked[i] === '{') { const end = matchBracket(masked, i); return end < 0 ? null : { bodyOpen: i, endIndex: end } }
  return { bodyOpen: -1, endIndex: expressionEnd(masked, i) }
}

// End of an expression-bodied arrow: stops at `;`, at a bracket that closes an outer
// group, or at a depth-0 newline that does not continue the expression.
function expressionEnd(masked, start) {
  let depth = 0, last = start
  for (let i = start; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return last }
    else if (depth === 0 && (c === ';' || c === ',')) return last
    else if (depth === 0 && c === '\n') {
      const before = masked.slice(Math.max(0, start), i).trimEnd().slice(-2)
      const next = masked.slice(i + 1).match(/^\s*(\S)/)?.[1] ?? ''
      if (!/[=(,?:&|+\-*/.]$/.test(before) && !/[.?:&|+\-*/]/.test(next)) return last
    }
    if (!/\s/.test(c)) last = i
  }
  return last
}

// `{` opening a class / interface body, skipping heritage generics (`extends Base<{ a: 1 }>`).
export function declarationBodyOpen(masked, from) {
  let angle = 0
  for (let i = from; i < masked.length && i - from < 2000; i++) {
    const c = masked[i]
    if (c === '<') angle++
    else if (c === '>' && masked[i - 1] !== '=') angle = Math.max(0, angle - 1)
    else if (c === '(') { const close = matchBracket(masked, i); if (close < 0) return -1; i = close }
    else if (c === '{') {
      if (angle === 0) return i
      const close = matchBracket(masked, i); if (close < 0) return -1; i = close
    } else if (c === ';' && angle === 0) return -1
  }
  return -1
}


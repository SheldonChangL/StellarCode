// Deterministic context-precision helpers: query-term weighting, symbol relevance,
// source-range deduplication and fair byte-budget allocation. Pure functions only;
// query-service.js supplies index rows and live source text.

// Light suffix stripping so "finishing" matches finishCleaning and "applies" matches
// applyX. Matching is substring-based, so a shorter stem only widens recall slightly.
export function stemTerm(term) {
  const t = String(term ?? '')
  if (t.length <= 4 || /[^a-z]/.test(t)) return t
  if (t.endsWith('ies') && t.length > 5) return t.slice(0, -3) + 'y'
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3)
  if (t.endsWith('ed') && t.length > 5 && !t.endsWith('eed')) return t.slice(0, -2)
  if (/(?:ss|sh|ch|x|z)es$/.test(t)) return t.slice(0, -2)
  if (t.endsWith('s') && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1)
  return t
}

// Inverse document frequency over indexed file documents (path, summary, symbol names).
// A term present in every file ("module", "scene" in a scene-heavy repo) carries little
// evidence; a rare term ("progression") carries a lot. The floor keeps common terms from
// vanishing entirely so tiny repositories behave as before.
export function termWeights(terms, documents) {
  const n = documents.length
  const weights = new Map()
  for (const term of terms) {
    let df = 0
    for (const doc of documents) if (STRONG_MATCHES.has(termMatch(doc, term))) df++
    const idf = df === 0 || n <= 1 ? 1 : Math.log((n + 1) / df) / Math.log(n + 1)
    weights.set(term, Number((0.25 + 0.75 * Math.max(0, Math.min(1, idf))).toFixed(4)))
  }
  return weights
}

// Identifier-aware term match on original-case text. A match must start at an
// identifier boundary (string start, non-alphanumeric, or a camelCase hump) to count
// fully: "rush" matches RushScene and rush/, but only weakly matches BrushTool.
export function termMatch(text, term) {
  const value = String(text ?? '')
  const lower = value.toLowerCase()
  if (!term) return null
  if (lower === term) return 'exact'
  let index = lower.indexOf(term)
  let found = null
  while (index >= 0) {
    const prev = value[index - 1]
    const boundary = index === 0 || !/[A-Za-z0-9]/.test(prev) || (/[a-z0-9]/.test(prev) && /[A-Z]/.test(value[index]))
    if (boundary) return index + term.length === lower.length ? 'suffix' : 'boundary'
    found = 'inner'
    index = lower.indexOf(term, index + 1)
  }
  if (found) return found
  // Identifiers abbreviate derived words: auth/authentication, init/initialization,
  // config/configuration. Compound identifiers in the query ("loginflow") are not derived words.
  if (term.length >= 6 && DERIVED_WORD.test(term)) {
    for (const word of value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []) {
      if (word.length >= 4 && word.length < term.length && term.startsWith(word.toLowerCase())) return 'abbrev'
    }
  }
  return null
}

const DERIVED_WORD = /(?:ation|ition|ment|ence|ance|ity|ure|ive|ion|at|iz)$/
const MATCH_POINTS = { exact: 10, suffix: 6, boundary: 3, abbrev: 1.5, inner: 1 }
const STRONG_MATCHES = new Set(['exact', 'suffix', 'boundary'])

export function weightedScore(text, terms, weights) {
  let score = 0
  for (const term of terms) {
    const match = termMatch(text, term)
    if (match) score += MATCH_POINTS[match] * (weights?.get(term) ?? 1)
  }
  return score
}

// Sum of weights of distinct query terms that occur at an identifier boundary.
export function termCoverage(text, terms, weights) {
  let covered = 0
  const matched = []
  for (const term of terms) {
    if (STRONG_MATCHES.has(termMatch(text, term))) { covered += weights?.get(term) ?? 1; matched.push(term) }
  }
  return { covered, matched }
}

// Narrow a long range to its densest window of evidence: lines that use the focus
// bindings or mention weighted query terms. Short ranges are returned unchanged.
export function focusRange(range, lines, { names = [], terms = [], weights, maxSpan = 60, windowLines = 40 } = {}) {
  const [start, end] = range
  if (!lines || end - start + 1 <= maxSpan) return range
  const nameRes = names.map(name => identifierPattern(name))
  const lineScores = []
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1] ?? ''
    let score = 0
    for (const re of nameRes) if (re.test(text)) score += 3
    for (const term of terms) if (STRONG_MATCHES.has(termMatch(text, term))) score += weights?.get(term) ?? 1
    lineScores.push(score)
  }
  let windowScore = lineScores.slice(0, windowLines).reduce((sum, value) => sum + value, 0)
  let bestScore = windowScore
  let bestOffset = 0
  for (let offset = 1; offset + windowLines <= lineScores.length; offset++) {
    windowScore += lineScores[offset + windowLines - 1] - lineScores[offset - 1]
    if (windowScore > bestScore) { bestScore = windowScore; bestOffset = offset }
  }
  return [start + bestOffset, Math.min(end, start + bestOffset + windowLines - 1)]
}

const BEHAVIOR_KINDS = new Set(['function', 'method'])
const DECLARATION_KINDS = new Set(['interface', 'type'])

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Whole-identifier pattern. \b fails for identifiers starting with `$` ($store, $).
export function identifierPattern(name, suffix = '') {
  return new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])${suffix}`)
}

// Rank the symbols of one file for a task. Signals, in order of strength:
// 1. distinct query terms in the symbol's own name (not the enclosing class/file name),
// 2. imported bindings to query-relevant targets that the symbol body actually uses,
// 3. distinct query terms in the symbol body,
// 4. intent compatibility (behavior over declarations for flow/editing/impact).
// Body and binding evidence are density-normalized: a 160-line setup method mentions
// almost every term and binding in a hub file, which is not evidence of relevance.
// Containers (a class whose methods also match) are demoted so the method range wins.
export const DENSITY_LINES = 40

export function rankFileSymbols({ symbols, lines, terms, weights, intent, bindings = [], relationQuery = false, constructionQuery = false, maxLines = 160 }) {
  if (!symbols.length) return []
  const scored = symbols.map(symbol => {
    const start = Math.max(1, Number(symbol.start_line))
    const end = Math.max(start, Number(symbol.end_line))
    const span = end - start + 1
    const density = Math.min(1, Math.sqrt(DENSITY_LINES / span))
    const body = lines ? lines.slice(start - 1, end).join('\n') : ''
    const name = String(symbol.name ?? '')
    const nameScore = weightedScore(name, terms, weights)
    const bodyHits = termCoverage(body, terms, weights)
    const usedBindings = []
    let bindingScore = 0
    for (const binding of bindings) {
      if (!binding.localName || !body) continue
      if (!identifierPattern(binding.localName).test(body)) continue
      const relevance = Math.max(0, Number(binding.relevance ?? 0))
      if (relevance <= 0) continue
      let strength = relevance
      if (new RegExp(`(?<![\\w$])${escapeRegex(binding.localName)}\\s*[.(]`).test(body)) strength += 1
      if (constructionQuery && new RegExp(`\\bnew\\s+${escapeRegex(binding.localName)}(?![\\w$])`).test(body)) strength += 4
      // "where X constructs/consumes/integrates Y": the relation itself is the question.
      if (relationQuery && binding.primary) strength *= 2
      bindingScore += strength
      usedBindings.push(binding)
    }
    const kind = String(symbol.kind ?? '')
    let kindScore = 0
    if (BEHAVIOR_KINDS.has(kind)) kindScore = intent === 'navigation' ? 1 : 3
    else if (DECLARATION_KINDS.has(kind)) kindScore = intent === 'navigation' ? -1 : -4
    else if (kind === 'constant' && intent === 'flow') kindScore = -2
    // Ranges beyond the per-target line cap cannot even be returned whole.
    const spanPenalty = span > maxLines ? 6 : 0
    // A type/interface name restates the concept but holds no behavior to trace or edit.
    const nameFactor = DECLARATION_KINDS.has(kind) && intent !== 'navigation' ? 1 : 3
    // Name evidence leads; binding and body evidence refine the choice between symbols.
    const score = nameScore * nameFactor + (bindingScore + bodyHits.covered * 2) * density + kindScore - spanPenalty
    return { symbol, score, nameScore, bodyTerms: bodyHits.matched, usedBindings, span }
  })
  // A container's evidence is its members' evidence, and its name usually restates the
  // file concept the file ranking already used. When any member carries evidence, the
  // container ranks below its evidenced members so the precise member range wins.
  // Innermost classes first, so a nested class is already demoted when its outer class reads it.
  const depth = entry => String(entry.symbol.qualified_name ?? '').split('.').length
  for (const entry of [...scored].sort((a, b) => depth(b) - depth(a) || String(a.symbol.qualified_name).localeCompare(String(b.symbol.qualified_name)))) {
    if (entry.symbol.kind !== 'class') continue
    const prefix = `${entry.symbol.qualified_name}.`
    const evidenced = scored.filter(other => String(other.symbol.qualified_name ?? '').startsWith(prefix) &&
      (other.nameScore > 0 || other.usedBindings.length || other.bodyTerms.length))
    if (evidenced.length) {
      entry.score = Math.min(...evidenced.map(child => child.score)) - 1
      entry.usedBindings = []
      entry.bodyTerms = []
    }
  }
  return scored
    .filter(entry => entry.nameScore > 0 || entry.usedBindings.length || entry.bodyTerms.length)
    .sort((a, b) => b.score - a.score || a.span - b.span || Number(a.symbol.start_line) - Number(b.symbol.start_line))
}

// Ranges are inclusive [start, end] line pairs.
export function overlapLines(a, b) {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1)
}

// Remove lines already grounded for the same path. Returns the largest remaining
// contiguous part, or null when the remainder is mostly duplicate or too small to help.
export function subtractTaken(range, taken = [], { minLines = 3, maxDuplicateRatio = 0.5 } = {}) {
  const length = range[1] - range[0] + 1
  let duplicate = 0
  for (const other of taken) duplicate += overlapLines(range, other)
  if (!duplicate) return range
  if (duplicate / length > maxDuplicateRatio) return null
  const covered = new Set()
  for (const other of taken) for (let n = Math.max(range[0], other[0]); n <= Math.min(range[1], other[1]); n++) covered.add(n)
  let best = null
  let current = null
  for (let n = range[0]; n <= range[1]; n++) {
    if (covered.has(n)) { current = null; continue }
    if (!current) current = [n, n]
    else current[1] = n
    if (!best || current[1] - current[0] > best[1] - best[0]) best = [...current]
  }
  return best && best[1] - best[0] + 1 >= minLines ? best : null
}

// Weighted max-min fair allocation. Each item asks for `desired` bytes; items that need
// less than their fair share are satisfied fully and return the surplus to the pool, so a
// small but important related function is never starved by an earlier giant range.
export function allocateBudget(items, maxBytes) {
  const allotted = items.map(() => 0)
  let remaining = Math.max(0, Math.floor(maxBytes))
  let active = items.map((item, index) => index).filter(index => items[index].desired > 0)
  while (active.length && remaining > 0) {
    const totalWeight = active.reduce((sum, index) => sum + (items[index].weight ?? 1), 0)
    const satisfied = active.filter(index => items[index].desired - allotted[index] <= remaining * (items[index].weight ?? 1) / totalWeight)
    if (satisfied.length) {
      for (const index of satisfied) {
        remaining -= items[index].desired - allotted[index]
        allotted[index] = items[index].desired
      }
      active = active.filter(index => !satisfied.includes(index))
      continue
    }
    // Nobody fits: split what is left by weight, in rank order, and stop.
    let left = remaining
    for (const [position, index] of active.entries()) {
      const share = position === active.length - 1 ? left : Math.floor(remaining * (items[index].weight ?? 1) / totalWeight)
      allotted[index] += Math.min(share, items[index].desired - allotted[index])
      left -= share
    }
    remaining = 0
  }
  return allotted
}

// Contiguous [from, to) slice of lines whose byte cost fits the budget and whose
// evidence score is highest; earliest wins ties, so an all-zero range keeps its head.
export function densestWindow(costs, rawScores, budget) {
  // Integer scores keep running sums exact, so "earliest wins ties" holds.
  const scores = rawScores.map(score => Math.round((score ?? 0) * 1000))
  let best = [0, 0]
  let bestScore = -1
  let from = 0
  let cost = 0
  let score = 0
  for (let to = 0; to < costs.length; to++) {
    cost += costs[to]
    score += scores[to] ?? 0
    while (cost > budget && from <= to) { cost -= costs[from]; score -= scores[from] ?? 0; from++ }
    if (from > to) continue
    if (score > bestScore || (score === bestScore && to + 1 - from > best[1] - best[0] && best[0] === from)) {
      bestScore = score
      best = [from, to + 1]
    }
  }
  return best
}

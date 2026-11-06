// Semantic slice seed selection (v0.6.1).
//
// The lexical ranker decides which files and ranges are context *targets*. Which symbol
// the semantic traversal *starts* from is a separate decision: a behavior or flow
// question must start from executable code, while a definition or impact question may
// start from a type or contract. This module picks a small bounded seed set (1–3) from
// the existing lexical candidates. It never rescores files, never reads benchmark answer
// keys, and uses semantic edges only as a tie-breaker (presence in the needed direction,
// never degree), so a hub symbol cannot win on edge count.

import { CONFIDENCE_VALUE } from '../indexer/semantic-resolve.js'
import { termCoverage } from './precision.js'
// Code evidence only: string literals, comments and JSX/HTML text describe the UI, not
// the behavior (a page component's labels restate every domain word of a query).
export function codeOnly(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/(^|\s)#[^\n]*/g, '$1 ')
    .replace(/("""|''')[\s\S]*?\1/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'/g, ' ')
    .replace(/>[^<>{}]*</g, '><')
}

const EXECUTABLE_KINDS = new Set(['function', 'method'])
const DECLARATION_KINDS = new Set(['interface', 'type', 'enum'])
export const SEED_LIMITS = { definition: 2, behavior: 2, consumer: 2, flow: 3 }
// A second/third seed must be about as relevant as the first.
const SIMILAR_SEED_RATIO = 0.85
// Semantic evidence in the needed direction only breaks near-ties (<= 10%).
const EDGE_TIE_BREAK = 1.1
// Lexical candidates considered: the context targets plus the top lexical files.
export const SEED_POOL_FILES = 20
// Bodies longer than this are discounted by sqrt(SEED_SPAN_LINES / span), at most 2x.
const SEED_SPAN_LINES = 80

// Executable = has a body that runs: functions, methods (not interface member
// signatures), and function-valued constants. Declaration-only = types, interfaces,
// interface members, enums, plain data constants and classes as a whole.
export function symbolNature(symbol, ownerKind = null) {
  const kind = String(symbol.kind ?? '')
  if (kind === 'method' && (ownerKind === 'interface' || ownerKind === 'type')) return 'declaration'
  if (EXECUTABLE_KINDS.has(kind)) return 'executable'
  if (kind === 'constant') {
    const multiLine = Number(symbol.end_line) > Number(symbol.start_line)
    return multiLine || /=>|\bfunction\b/.test(String(symbol.signature ?? '')) ? 'executable' : 'declaration'
  }
  if (DECLARATION_KINDS.has(kind)) return 'declaration'
  return kind === 'class' ? 'container' : 'declaration'
}

// Role eligibility. Returns a suitability factor, or 0 when the symbol may not be a seed.
export function seedSuitability(role, nature) {
  if (role === 'behavior' || role === 'flow') return nature === 'executable' ? 1 : 0
  if (role === 'definition') return nature === 'executable' ? 0.8 : 1
  return 1 // consumer: contracts, functions, classes and config are all valid seeds
}

const DIRECTIONS = {
  behavior: ['outgoing', 'incoming'],
  flow: ['outgoing'],
  consumer: ['incoming'],
  definition: ['incoming']
}

function hasHighEdge(db, symbolId, role) {
  for (const direction of DIRECTIONS[role] ?? ['incoming']) {
    const column = direction === 'outgoing' ? 'source_id' : 'target_id'
    const row = db.prepare(`SELECT 1 FROM edges WHERE ${column}=? AND edge_type IN ('CALLS','REGISTERS','CONSUMES','IMPLEMENTS') AND confidence>=? LIMIT 1`).get(symbolId, CONFIDENCE_VALUE.high)
    if (row) return true
  }
  return false
}

function symbolIdFor(db, path, symbol) {
  return db.prepare('SELECT symbol_id,signature FROM symbols WHERE file_id=? AND qualified_name=? AND start_line=? LIMIT 1').get(path, symbol.qualified_name, symbol.start_line)
}

// candidates: [{ path, fileScore, ranked: [{ symbol, score }], ownSymbols }] in lexical
// file order (fileScore is informational). Returns { seeds, considered } where each seed carries its reason.
export function selectSemanticSeeds(db, { role, candidates, terms = [], weights = new Map() }) {
  const limit = SEED_LIMITS[role] ?? 2
  const pool = []
  for (const candidate of candidates) {
    const kindOf = new Map(candidate.ownSymbols.map(s => [s.qualified_name, s.kind]))
    for (const entry of candidate.ranked) {
      const symbol = entry.symbol
      const qualified = String(symbol.qualified_name ?? '')
      const owner = qualified.includes('.') ? qualified.slice(0, qualified.lastIndexOf('.')) : null
      const row = symbolIdFor(db, candidate.path, symbol)
      if (!row) continue
      const nature = symbolNature({ ...symbol, signature: row.signature }, owner ? kindOf.get(owner) : null)
      const suitability = seedSuitability(role, nature)
      // Existing lexical relevance of the symbol (rankFileSymbols: name, body terms, used
      // bindings, kind). File rank already admitted the file to the pool; multiplying by
      // it again would hand the seed back to the lexical top file.
      // Seed relevance: weighted coverage of *distinct* query terms in the symbol's name
      // and code (strings, comments and UI text excluded), name terms counted twice. A
      // short helper whose name repeats one query word no longer outranks the function
      // that does the described behavior. The in-file lexical score still gates
      // eligibility (it must be > 0); long bodies are discounted gently.
      let lexical = 0
      if (entry.score > 0) {
        const name = termCoverage(String(symbol.name ?? ''), terms, weights)
        const body = candidate.lines ? candidate.lines.slice(Number(symbol.start_line) - 1, Number(symbol.end_line)).join('\n') : ''
        const code = body ? termCoverage(codeOnly(body), terms, weights).matched : (entry.bodyTerms ?? [])
        let covered = 0
        for (const term of new Set([...name.matched, ...code])) covered += weights.get(term) ?? 1
        const span = Math.max(1, Number(symbol.end_line) - Number(symbol.start_line) + 1)
        const spanFactor = span > SEED_SPAN_LINES ? Math.max(0.5, Math.sqrt(SEED_SPAN_LINES / span)) : 1
        lexical = (covered + name.covered) * spanFactor
      }
      pool.push({ path: candidate.path, symbol, symbolId: row.symbol_id, nature, suitability, lexical, nameScore: entry.nameScore ?? 0, bodyTerms: entry.bodyTerms ?? [], span: entry.span ?? null })
    }
  }
  const eligible = pool.filter(p => p.suitability > 0 && p.lexical > 0)
  for (const p of eligible) {
    p.semanticEvidence = hasHighEdge(db, p.symbolId, role)
    p.score = p.lexical * p.suitability * (p.semanticEvidence ? EDGE_TIE_BREAK : 1)
  }
  eligible.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || Number(a.symbol.start_line) - Number(b.symbol.start_line))
  const seeds = []
  for (const p of eligible) {
    if (seeds.length >= limit) break
    if (seeds.length && p.score < seeds[0].score * SIMILAR_SEED_RATIO) break
    // A symbol nested in (or containing) a chosen seed adds nothing new.
    const nested = seeds.some(s => s.path === p.path && Number(s.symbol.start_line) <= Number(p.symbol.end_line) && Number(p.symbol.start_line) <= Number(s.symbol.end_line))
    if (nested) continue
    seeds.push(p)
  }
  return {
    seeds: seeds.map(s => ({ path: s.path, symbol: s.symbol.qualified_name, kind: s.symbol.kind, nature: s.nature, lines: [Number(s.symbol.start_line), Number(s.symbol.end_line)], semanticEvidence: s.semanticEvidence })),
    considered: pool.length,
    candidateKeys: pool.map(p => `${p.path}#${p.symbol.qualified_name}`),
    candidatePaths: [...new Set(candidates.map(c => c.path))],
    ranking: eligible.map(p => ({ key: `${p.path}#${p.symbol.qualified_name}`, score: Number(p.score.toFixed(2)), name: Number(p.nameScore.toFixed(2)), body: p.bodyTerms, span: p.span, evidence: p.semanticEvidence })),
    ineligible: pool.filter(p => p.suitability === 0).map(p => `${p.path}#${p.symbol.qualified_name}:${p.nature}`),
    excludedDeclarations: pool.filter(p => p.suitability === 0).length
  }
}

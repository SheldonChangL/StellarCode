// Bounded semantic behavior slice for `stellar context` (v0.6).
//
// Starting from the context targets' symbols, the slice follows only stored
// high/medium-confidence semantic edges (CALLS, REGISTERS, IMPLEMENTS, CONSUMES),
// in the direction the task intent needs, to a fixed depth and edge budget. It
// returns the relations plus the neighbor ranges to ground; the caller turns those
// ranges into live source under the existing byte budget. No edge is invented here:
// the slice is a traversal of what the indexer resolved.

import { weightedScore } from './precision.js'

export const SEMANTIC_RELATIONS = ['CALLS', 'REGISTERS', 'IMPLEMENTS', 'CONSUMES']

// Per intent: which relations to follow in which direction, how deep, and how many
// edges to return. Navigation needs the owner only, so it expands nothing.
export const SLICE_PLANS = {
  // Navigation needs the owner. Its callees stay hints (v0.5.4 rule); a small incoming
  // slice shows where the owner is wired and used, which also covers impact-style
  // questions the intent classifier labels navigation.
  navigation: {
    maxEdges: 3,
    steps: [{ direction: 'incoming', relations: ['CALLS', 'REGISTERS'], depth: 1 }]
  },
  flow: {
    maxEdges: 6,
    steps: [
      { direction: 'outgoing', relations: ['CALLS', 'REGISTERS'], depth: 2 },
      { direction: 'incoming', relations: ['REGISTERS'], depth: 1 },
      // v0.6.1: a seed is often the step that does the work (a service method); the
      // entry side of the flow is its caller's caller (route -> controller -> service).
      // A shared step has many callers; keep the two most query-relevant per node instead of
      // dropping every caller of a node with more than one (the v0.6 `onlyUnique` rule).
      { direction: 'incoming', relations: ['CALLS', 'REGISTERS'], depth: 2, maxFanIn: 2 }
    ]
  },
  impact: {
    maxEdges: 8,
    steps: [{ direction: 'incoming', relations: ['CALLS', 'CONSUMES', 'IMPLEMENTS', 'REGISTERS'], depth: 1 }]
  },
  'editing-prep': {
    maxEdges: 6,
    steps: [
      { direction: 'outgoing', relations: ['CALLS', 'CONSUMES'], depth: 1 },
      { direction: 'incoming', relations: ['CALLS'], depth: 1 },
      { direction: 'both', relations: ['IMPLEMENTS'], depth: 1 }
    ]
  }
}

// v0.6.1 route variants. Every seed shares one edge budget, so more seeds never means
// more edges.
export const ROUTE_PLANS = {
  // "Where is X computed?": callers are grounded as before; the owner's callees are
  // reported as relations only (no source), so they stay hints (v0.5.4 rule). Same budget.
  'navigation-behavior': {
    maxEdges: 3,
    steps: [
      { direction: 'incoming', relations: ['CALLS', 'REGISTERS'], depth: 1 },
      { direction: 'outgoing', relations: ['CALLS'], depth: 1, ground: false }
    ]
  },
  // No decisive intent evidence: a small mixed-direction slice instead of guessing a
  // single direction (it is not "every direction": depth 1, 4 edges).
  mixed: {
    maxEdges: 4,
    steps: [
      { direction: 'outgoing', relations: ['CALLS', 'REGISTERS'], depth: 1 },
      { direction: 'incoming', relations: ['CALLS', 'REGISTERS'], depth: 1 }
    ]
  }
}

export function slicePlanFor(intent, { seedRole = null, intentConfidence = null } = {}) {
  if (intentConfidence === 'low') return { name: 'mixed', ...ROUTE_PLANS.mixed }
  if (intent === 'navigation' && seedRole === 'behavior') return { name: 'navigation-behavior', ...ROUTE_PLANS['navigation-behavior'] }
  const name = SLICE_PLANS[intent] ? intent : 'navigation'
  return { name, ...SLICE_PLANS[name] }
}

export const SEMANTIC_CAPABILITY = { TypeScript: 'semantic', JavaScript: 'semantic', Python: 'semantic-partial' }
const CONTAINER_KINDS = new Set(['class', 'interface', 'constant'])
const MAX_SEEDS = 40

export function semanticSliceEnabled(options = {}) {
  if (options.semantic === false) return false
  return process.env.STELLAR_SEMANTIC_SLICE !== '0'
}

function symbolRow(db, id) {
  return db.prepare(`SELECT s.symbol_id,s.file_id,s.qualified_name,s.name,s.kind,s.start_line,s.end_line,f.path,f.is_test,f.language,f.line_count
    FROM symbols s JOIN files f ON f.file_id=s.file_id WHERE s.symbol_id=?`).get(id)
}

function seedSymbols(db, targets, intent) {
  const seeds = new Map()
  for (const [origin, target] of targets.entries()) {
    const inFile = db.prepare('SELECT symbol_id,qualified_name,kind,start_line,end_line FROM symbols WHERE file_id=? ORDER BY start_line,qualified_name').all(target.path)
    let chosen = target.symbol ? inFile.filter(s => s.qualified_name === target.symbol) : []
    if (chosen.length > 1 && target.lines) chosen = chosen.filter(s => s.start_line <= target.lines[1] && s.end_line >= target.lines[0]).slice(0, 1)
    chosen = chosen.slice(0, 1)
    // Impact is about a module's contract: a method target stands for its owning
    // class or singleton, so callers of sibling methods are found too.
    if (intent === 'impact' && chosen[0]?.qualified_name.includes('.')) {
      const owner = inFile.find(s => s.qualified_name === chosen[0].qualified_name.slice(0, chosen[0].qualified_name.lastIndexOf('.')))
      if (owner && CONTAINER_KINDS.has(owner.kind)) chosen = [owner]
    }
    // A container (class, interface, object singleton) stands for its members.
    const container = chosen[0] && CONTAINER_KINDS.has(chosen[0].kind)
    const members = container ? inFile.filter(s => s.qualified_name.startsWith(`${chosen[0].qualified_name}.`)) : []
    const fileLevel = !chosen.length ? inFile : []
    for (const s of [...chosen, ...members, ...fileLevel]) {
      if (seeds.size >= MAX_SEEDS) break
      if (!seeds.has(s.symbol_id)) seeds.set(s.symbol_id, { ...s, path: target.path, origin })
    }
    if (!chosen.length && !seeds.has(target.path)) seeds.set(target.path, { symbol_id: target.path, path: target.path, qualified_name: null, file: true, origin })
  }
  return seeds
}

function edgesFor(db, ids, direction, relations) {
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const types = relations.map(() => '?').join(',')
  const column = direction === 'outgoing' ? 'source_id' : 'target_id'
  return db.prepare(`SELECT source_id,target_id,edge_type,confidence,source_file_id,metadata_json FROM edges
    WHERE ${column} IN (${marks}) AND edge_type IN (${types})`).all(...ids, ...relations).map(row => {
    let metadata = {}
    try { metadata = JSON.parse(row.metadata_json || '{}') } catch {}
    return { ...row, metadata, direction }
  })
}

function endpoint(db, id) {
  const symbol = symbolRow(db, id)
  if (symbol) return { path: symbol.path, symbol: symbol.qualified_name, kind: symbol.kind, lines: [Number(symbol.start_line), Number(symbol.end_line)], isTest: Boolean(symbol.is_test), language: symbol.language, lineCount: Number(symbol.line_count) }
  const file = db.prepare('SELECT path,is_test,language,line_count FROM files WHERE file_id=?').get(id)
  return file ? { path: file.path, symbol: null, kind: 'module', lines: null, isTest: Boolean(file.is_test), language: file.language, lineCount: Number(file.line_count) } : null
}

// Returns { edges, ground } where ground lists neighbor ranges to attach as source.
// `targets` are the semantic seeds (v0.6.1: chosen by semantic-seed.js, not the lexical top).
export function semanticSlice(db, { intent, targets, terms = [], weights = new Map(), trace = false, seedRole = null, intentConfidence = null }) {
  const plan = slicePlanFor(intent, { seedRole, intentConfidence })
  if (!plan.maxEdges || !targets.length) return { edges: [], ground: [], seeds: 0, more: false }
  const seeds = seedSymbols(db, targets, intent)
  const seedIds = [...seeds.keys()]
  const seedSet = new Set(seedIds)
  const candidates = []
  for (const step of plan.steps) {
    let frontier = seedIds
    const visited = new Set(seedIds)
    const originOf = new Map(seedIds.map(id => [id, seeds.get(id).origin]))
    for (let depth = 1; depth <= step.depth && frontier.length; depth++) {
      const directions = step.direction === 'both' ? ['outgoing', 'incoming'] : [step.direction]
      const next = []
      for (const direction of directions) {
        let rows = edgesFor(db, frontier, direction, step.relations)
        if (step.onlyUnique) {
          const byTarget = new Map()
          for (const row of rows) byTarget.set(row.target_id, (byTarget.get(row.target_id) ?? 0) + 1)
          rows = rows.filter(row => byTarget.get(row.target_id) === 1)
        }
        if (step.maxFanIn && direction === 'incoming') {
          const byTarget = new Map()
          for (const row of rows) { if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, []); byTarget.get(row.target_id).push(row) }
          rows = []
          for (const group of byTarget.values()) {
            const ranked = group.map(row => {
              const caller = endpoint(db, row.source_id)
              return { row, test: Boolean(caller?.isTest), relevance: caller ? weightedScore(`${caller.symbol ?? ''} ${caller.path}`, terms, weights) : 0, key: caller ? `${caller.path}#${caller.symbol ?? ''}` : row.source_id }
            }).filter(c => !c.test).sort((a, b) => b.relevance - a.relevance || a.key.localeCompare(b.key))
            rows.push(...ranked.slice(0, step.maxFanIn).map(c => c.row))
          }
        }
        for (const row of rows) {
          const neighborId = direction === 'outgoing' ? row.target_id : row.source_id
          // An edge inside one seed container (a class method calling its sibling) adds
          // nothing; an edge between two different targets is the chain itself and stays.
          const anchorId = direction === 'outgoing' ? row.source_id : row.target_id
          // Two distinct explicit seeds (different origins) linked by an edge are the chain
          // itself and stay, even in one file.
          if (seedSet.has(neighborId) && seedSet.has(anchorId) && seeds.get(neighborId)?.path === seeds.get(anchorId)?.path && seeds.get(neighborId)?.origin === seeds.get(anchorId)?.origin) continue
          const origin = originOf.get(anchorId) ?? 0
          candidates.push({ ...row, depth, neighborId, origin, ground: step.ground !== false })
          if (!visited.has(neighborId)) { visited.add(neighborId); originOf.set(neighborId, origin); next.push(neighborId) }
        }
      }
      frontier = next
    }
  }

  // Fan-in of a callee or consumed symbol: a helper used from everywhere (error builders, loggers, db)
  // says little about this behavior. Continuation: a neighbor that itself leads
  // further along the returned chain is worth more than a leaf.
  const fanIn = new Map()
  const fanInOf = id => {
    if (!fanIn.has(id)) fanIn.set(id, db.prepare(`SELECT COUNT(DISTINCT source_id) c FROM edges WHERE target_id=? AND edge_type IN ('CALLS','CONSUMES')`).get(id).c)
    return fanIn.get(id)
  }
  const continues = new Set(candidates.filter(c => c.direction === 'outgoing' && c.depth > 1).map(c => c.source_id))
  const seen = new Set()
  const scored = []
  for (const candidate of candidates) {
    const key = `${candidate.source_id}|${candidate.target_id}|${candidate.edge_type}`
    if (seen.has(key)) continue
    seen.add(key)
    const from = endpoint(db, candidate.source_id)
    const to = endpoint(db, candidate.target_id)
    if (!from || !to) continue
    const neighbor = candidate.direction === 'outgoing' ? to : from
    const anchor = candidate.direction === 'outgoing' ? from : to
    if (neighbor.isTest) continue
    const crossFile = neighbor.path !== anchor.path
    // A neighbor that is a member of the same seed (container expansion) is already
    // grounded; a link to a different seed connects two starting points and is not penalized.
    const anchorId = candidate.direction === 'outgoing' ? candidate.source_id : candidate.target_id
    const neighborIsSeed = seedSet.has(candidate.neighborId) && (!seedSet.has(anchorId) || seeds.get(candidate.neighborId)?.origin === seeds.get(anchorId)?.origin)
    const relevance = weightedScore(`${neighbor.symbol ?? ''} ${neighbor.path}`, terms, weights)
    // Structure decides the order: confidence, depth, cross-file; lexical relevance only breaks ties.
    // Impact asks who must change with the target: callers and consumers first,
    // implementations of a contract after them.
    const relationWeight = intent === 'impact' && candidate.edge_type === 'IMPLEMENTS' ? -12 : 0
    // Shared infrastructure (a db handle, a schema table) consumed everywhere is the
    // CONSUMES counterpart of a helper called everywhere: same fan-in discount.
    const utility = candidate.direction === 'outgoing' && (candidate.edge_type === 'CALLS' || candidate.edge_type === 'CONSUMES') ? Math.min(24, Math.max(0, Math.log2(fanInOf(candidate.target_id)) - 1) * 6) : 0
    const continuation = candidate.direction === 'outgoing' && continues.has(candidate.target_id) ? 12 : 0
    const depthCost = intent === 'flow' ? 10 : 20
    // The first target is the behavior owner; later targets are alternatives.
    const score = (candidate.metadata.confidence === 'high' ? 100 : 60) - candidate.origin * 12 - candidate.depth * depthCost + (crossFile ? 15 : 0) - (neighborIsSeed ? 30 : 0) + relationWeight - utility + continuation + Math.min(10, relevance)
    scored.push({ candidate, from, to, neighbor, score })
  }
  scored.sort((a, b) => b.score - a.score || a.neighbor.path.localeCompare(b.neighbor.path) || (a.candidate.metadata.line ?? 0) - (b.candidate.metadata.line ?? 0))
  const chosen = scored.slice(0, plan.maxEdges)

  const edges = chosen.map(({ candidate, from, to }) => ({
    relation: candidate.edge_type,
    direction: candidate.direction,
    from: { path: from.path, symbol: from.symbol, line: candidate.metadata.line ?? null },
    to: { path: to.path, symbol: to.symbol },
    confidence: candidate.metadata.confidence,
    depth: candidate.depth
  }))

  // Ground each neighbor once: a callee/implementation by its symbol range, a caller
  // or consumer by the window around the evidence line inside its symbol.
  const ground = []
  const grounded = new Set()
  for (const { candidate, neighbor } of chosen) {
    // A seed is grounded by the caller (as a target or as the slice's starting range),
    // unless this edge links it from a different seed: then the edge grounds it, so the
    // relation ("X used in Y") travels with the source.
    const linkAnchor = candidate.direction === 'outgoing' ? candidate.source_id : candidate.target_id
    if (seedSet.has(candidate.neighborId) && seeds.get(candidate.neighborId)?.origin === seeds.get(linkAnchor)?.origin) continue
    // Relation-only steps (navigation callees) never attach source.
    if (!candidate.ground) continue
    const evidenceLine = Number(candidate.metadata.line ?? 0)
    let lines
    if (candidate.direction === 'incoming' && evidenceLine) {
      const [start, end] = neighbor.lines ?? [1, neighbor.lineCount]
      lines = [Math.max(start, evidenceLine - 6), Math.min(end, evidenceLine + 8)]
    } else if (neighbor.lines) lines = neighbor.lines
    else if (evidenceLine) lines = [Math.max(1, evidenceLine - 3), Math.min(neighbor.lineCount, evidenceLine + 3)]
    else continue
    const key = `${neighbor.path}:${lines[0]}:${lines[1]}`
    if (grounded.has(key)) continue
    grounded.add(key)
    ground.push({
      path: neighbor.path,
      symbol: neighbor.symbol,
      lines,
      relation: candidate.edge_type,
      direction: candidate.direction,
      confidence: candidate.metadata.confidence,
      reason: candidate.direction === 'outgoing'
        ? `${chosenLabel(candidate, 'to', db)} used in ${chosenLabel(candidate, 'from', db)} (${candidate.edge_type})`
        : `${chosenLabel(candidate, 'from', db)} uses ${chosenLabel(candidate, 'to', db)} (${candidate.edge_type})`
    })
  }
  const result = { edges, ground, seeds: seedIds.length, plan: plan.name, more: scored.length > chosen.length }
  // Diagnostic only (benchmark funnel): the expanded seed set and every edge the
  // traversal admitted before the edge budget. Never part of the agent payload.
  if (trace) {
    const label = id => { const p = endpoint(db, id); return p ? (p.symbol ? `${p.path}#${p.symbol}` : p.path) : id }
    result.trace = {
      seeds: seedIds.map(label),
      admitted: scored.map(({ candidate }) => `${label(candidate.source_id)}|${candidate.edge_type}|${label(candidate.target_id)}`)
    }
  }
  return result
}

function chosenLabel(candidate, side, db) {
  const id = side === 'from' ? candidate.source_id : candidate.target_id
  const point = endpoint(db, id)
  return point?.symbol ?? point?.path ?? id
}

export function capabilityFor(languages) {
  const result = {}
  for (const language of languages) if (language) result[language] = SEMANTIC_CAPABILITY[language] ?? 'lexical-only'
  return result
}

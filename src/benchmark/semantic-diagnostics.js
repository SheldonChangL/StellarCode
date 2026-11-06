import fs from 'node:fs/promises'
import { contextForTask } from '../query/query-service.js'
import { loadBenchmarkTasks } from './tasks.js'
import { readProjectMetadata } from '../core/project.js'
import { openProjectStore } from '../storage/project-store.js'
import { STELLAR_CONTEXT_FLAGS } from './agents.js'

// Deterministic per-task view of the semantic slice the benchmark context command
// returns (same options as STELLAR_CONTEXT_FLAGS). Answer keys (expectedFiles,
// expectedSemanticEdges) are read here only to score the output after it is built.
export const DIAGNOSTIC_CONTEXT = { compact: true, depth: 1, maxFiles: 6, maxLines: 160, maxBytes: 12000, withSource: true }

const key = (path, symbol) => symbol ? `${path}#${symbol}` : path

export function semanticPathLength(edges, targets) {
  const out = new Map()
  for (const e of edges) {
    if (e.direction !== 'outgoing' || !['CALLS', 'REGISTERS'].includes(e.relation)) continue
    const from = key(e.from.path, e.from.symbol)
    if (!out.has(from)) out.set(from, [])
    out.get(from).push(key(e.to.path, e.to.symbol))
  }
  let longest = 0
  const walk = (node, length, seen) => {
    longest = Math.max(longest, length)
    for (const next of out.get(node) ?? []) if (!seen.has(next)) walk(next, length + 1, new Set([...seen, next]))
  }
  for (const t of targets) walk(key(t.path, t.symbol), 0, new Set([key(t.path, t.symbol)]))
  if (!longest && edges.some(e => e.direction === 'incoming')) longest = 1
  return longest
}

export async function indexedSemanticEdges(projectRoot, options = {}) {
  const { db } = await openProjectStore(projectRoot, await readProjectMetadata(projectRoot), options)
  try {
    const name = new Map(db.prepare('SELECT symbol_id,file_id,qualified_name FROM symbols').all().map(s => [s.symbol_id, key(s.file_id, s.qualified_name)]))
    return new Set(db.prepare(`SELECT source_id,target_id,edge_type FROM edges WHERE edge_type IN ('CALLS','IMPLEMENTS','REGISTERS','CONSUMES')`).all()
      .map(r => `${name.get(r.source_id) ?? r.source_id}|${r.edge_type}|${name.get(r.target_id) ?? r.target_id}`))
  } finally { db.close() }
}

// Undirected adjacency over the indexed semantic graph (diagnostics only).
export function semanticAdjacency(indexed) {
  const adj = new Map()
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) }
  for (const edge of indexed) { const [from, , to] = edge.split('|'); link(from, to); link(to, from) }
  return adj
}

// A required edge is reachable from the chosen seeds when one of its endpoints lies within
// `depth - 1` hops of a seed (the slice traverses at most `depth` = 2 edges from a seed).
export function seedReachable(requiredKey, seeds, adj, depth = 2) {
  const [from, , to] = requiredKey.split('|')
  const near = new Set(seeds)
  let frontier = [...seeds]
  for (let hop = 1; hop < depth; hop++) {
    const next = []
    for (const node of frontier) for (const n of adj.get(node) ?? []) if (!near.has(n)) { near.add(n); next.push(n) }
    frontier = next
  }
  return near.has(from) || near.has(to)
}

const ratio = (part, whole) => whole ? Number((part / whole).toFixed(4)) : null

// Required -> indexed -> reachable from seed -> admitted by traversal -> returned.
export function funnelSummary(rows) {
  const sum = field => rows.reduce((total, r) => total + (r[field] ?? 0), 0)
  const f = {
    requiredEdgeCount: sum('requiredEdges'),
    indexedRequiredEdgeCount: sum('requiredEdgesIndexed'),
    candidatePoolRequiredEdgeCount: sum('requiredEdgesInCandidatePool'),
    candidatePoolFileRequiredEdgeCount: sum('requiredEdgesFileInCandidatePool'),
    seedReachableRequiredEdgeCount: sum('requiredEdgesSeedReachable'),
    admittedRequiredEdgeCount: sum('requiredEdgesAdmitted'),
    returnedRequiredEdgeCount: sum('requiredEdgesReturned')
  }
  return {
    ...f,
    indexRecall: ratio(f.indexedRequiredEdgeCount, f.requiredEdgeCount),
    candidatePoolRecall: ratio(f.candidatePoolRequiredEdgeCount, f.indexedRequiredEdgeCount),
    seedReachabilityRecall: ratio(f.seedReachableRequiredEdgeCount, f.indexedRequiredEdgeCount),
    admissionRecall: ratio(f.admittedRequiredEdgeCount, f.seedReachableRequiredEdgeCount),
    routingRecall: ratio(f.returnedRequiredEdgeCount, f.indexedRequiredEdgeCount),
    contextRecall: ratio(f.returnedRequiredEdgeCount, f.requiredEdgeCount)
  }
}

export async function semanticDiagnostics(projectRoot, tasksFile, options = {}) {
  const { tasks } = await loadBenchmarkTasks(tasksFile)
  const indexed = await indexedSemanticEdges(projectRoot, options)
  const adj = semanticAdjacency(indexed)
  const rows = []
  for (const task of tasks) {
    // Only the prompt reaches the runtime; the answer key is compared afterwards.
    const ctx = await contextForTask(projectRoot, task.prompt, { ...options, ...DIAGNOSTIC_CONTEXT, semanticTrace: true })
    const trace = ctx.semanticTrace ?? { seeds: [], admitted: [] }
    const admitted = new Set(trace.admitted)
    const edges = ctx.semanticEvidence ?? []
    const returned = new Set(edges.map(e => `${key(e.from.path, e.from.symbol)}|${e.relation}|${key(e.to.path, e.to.symbol)}`))
    const grounded = [...ctx.targets, ...ctx.relatedEvidence].filter(e => e.source)
    const required = task.expectedSemanticEdges ?? []
    const requiredKeys = required.map(e => `${e.from}|${e.relation}|${e.to}`)
    rows.push({
      taskId: task.id,
      category: task.category,
      intent: ctx.intent,
      primary: ctx.targets[0] ? key(ctx.targets[0].path, ctx.targets[0].symbol) : null,
      topTargetExpected: ctx.targets[0] ? task.expectedFiles.includes(ctx.targets[0].path) : false,
      semanticEdges: edges.length,
      confidence: { high: edges.filter(e => e.confidence === 'high').length, medium: edges.filter(e => e.confidence === 'medium').length },
      relations: Object.fromEntries(['CALLS', 'REGISTERS', 'IMPLEMENTS', 'CONSUMES'].map(r => [r, edges.filter(e => e.relation === r).length])),
      groundedSemanticSymbols: ctx.relatedEvidence.filter(e => e.semantic && e.source).map(e => key(e.path, e.symbol)),
      sourceBytes: grounded.reduce((sum, e) => sum + Buffer.byteLength(e.source), 0),
      expectedFilesGrounded: task.expectedFiles.filter(file => grounded.some(e => e.path === file)).length,
      expectedFiles: task.expectedFiles.length,
      semanticPathLength: semanticPathLength(edges, ctx.targets),
      requiredEdges: required.length,
      requiredEdgesReturned: requiredKeys.filter(k => returned.has(k)).length,
      requiredEdgesIndexed: requiredKeys.filter(k => indexed.has(k)).length,
      // Ceiling of seed selection: a required edge whose endpoint symbol (or file) is not
      // among the lexical seed candidates cannot be reached by any seed choice.
      requiredEdgesInCandidatePool: requiredKeys.filter(k => indexed.has(k) && k.split('|').filter((_, i) => i !== 1).some(end => (trace.candidateKeys ?? []).includes(end))).length,
      requiredEdgesFileInCandidatePool: requiredKeys.filter(k => indexed.has(k) && k.split('|').filter((_, i) => i !== 1).some(end => (trace.candidatePaths ?? []).includes(end.split('#')[0]))).length,
      requiredEdgesSeedReachable: requiredKeys.filter(k => indexed.has(k) && seedReachable(k, trace.seeds, adj)).length,
      requiredEdgesAdmitted: requiredKeys.filter(k => indexed.has(k) && admitted.has(k)).length,
      lexicalTopPath: ctx.targets[0]?.path ?? null,
      semanticSeedPaths: [...new Set((ctx.semanticRoute?.seeds ?? []).map(s => s.path))],
      semanticSeedKinds: (ctx.semanticRoute?.seeds ?? []).map(s => s.kind),
      seedCount: ctx.semanticRoute?.seeds?.length ?? 0,
      seedRole: ctx.semanticRoute?.seedRole ?? null,
      intentConfidence: ctx.semanticRoute?.intentConfidence ?? null,
      seedContainsExpectedFile: (ctx.semanticRoute?.seeds ?? []).some(s => task.expectedFiles.includes(s.path)),
      intentMatchesCategory: ctx.intent === task.category,
      missingRequiredEdges: requiredKeys.filter(k => !returned.has(k))
    })
  }
  const annotated = rows.filter(r => r.requiredEdges)
  const sum = (list, field) => list.reduce((total, r) => total + r[field], 0)
  const summary = {
    tasks: rows.length,
    tasksWithSemanticEdges: rows.filter(r => r.semanticEdges).length,
    annotatedTasks: annotated.length,
    requiredEdges: sum(annotated, 'requiredEdges'),
    requiredEdgeRecallContext: sum(annotated, 'requiredEdges') ? sum(annotated, 'requiredEdgesReturned') / sum(annotated, 'requiredEdges') : null,
    requiredEdgeRecallIndex: sum(annotated, 'requiredEdges') ? sum(annotated, 'requiredEdgesIndexed') / sum(annotated, 'requiredEdges') : null,
    expectedFileGroundingRate: sum(rows, 'expectedFiles') ? sum(rows, 'expectedFilesGrounded') / sum(rows, 'expectedFiles') : null,
    funnel: funnelSummary(annotated),
    intentAgreement: rows.length ? `${rows.filter(r => r.intentMatchesCategory).length}/${rows.length}` : null,
    topTargetCorrect: `${rows.filter(r => r.topTargetExpected).length}/${rows.length}`,
    seedContainsExpectedFile: `${rows.filter(r => r.seedContainsExpectedFile).length}/${rows.length}`,
    medianSourceBytes: [...rows.map(r => r.sourceBytes)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null
  }
  return { schemaVersion: 1, contextFlags: STELLAR_CONTEXT_FLAGS, summary, tasks: rows }
}

export async function writeSemanticDiagnostics(projectRoot, tasksFile, { jsonFile, ...options } = {}) {
  const result = await semanticDiagnostics(projectRoot, tasksFile, options)
  if (jsonFile) await fs.writeFile(jsonFile, JSON.stringify(result, null, 2) + '\n')
  return result
}

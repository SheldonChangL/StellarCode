// First-turn context delivery experiment (v0.5.9). Pure helpers only; the runner supplies
// the StellarCode context output and the agent's observed reads.
//
// Delivery modes for the StellarCode condition:
//   pull              the agent decides to run `stellar context` itself (existing condition)
//   prefetch          the runner runs the same command before the agent starts and puts its
//                     grounded output into the initial task message
//   prefetch-contract prefetch plus an explicit, conservative grounding contract
// Prefetch input is built only from the task prompt and StellarCode output for the frozen
// repository snapshot. Benchmark metadata (category, expected files, match mode, answer key)
// never reaches these functions.
import crypto from 'node:crypto'

export const DELIVERY_MODES = ['pull', 'prefetch', 'prefetch-contract']
export const PREFETCH_MODES = new Set(['prefetch', 'prefetch-contract'])

// Deterministic Latin-square order: repetition r runs the condition list rotated by r-1,
// so every condition takes every position equally often across repetitions.
export function latinSquareOrder(modes, repetition) {
  const n = modes.length
  if (!n) return []
  const shift = ((Number(repetition) - 1) % n + n) % n
  return [...modes.slice(shift), ...modes.slice(0, shift)]
}

const sha12 = text => crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12)

// Stable text envelope from a compact `stellar context --with-source --json` result. Only
// fields a normal context call returns are used: no scores, no debug data. Every excerpt
// keeps its path, line range and a hash of the exact excerpt text, plus the snapshot commit.
export function buildContextEnvelope(context, { snapshotCommit = null } = {}) {
  const lines = ['<stellar-grounded-context>']
  if (snapshotCommit) lines.push(`Snapshot: ${snapshotCommit}`)
  lines.push(`Intent: ${context?.intent ?? 'unknown'}`)
  if (context?.contextMode) lines.push(`Context mode: ${context.contextMode}`)
  if (context?.confidence) lines.push(`Confidence: ${context.confidence}`)
  const excerpts = []
  const section = (title, items) => {
    const sourced = (items ?? []).filter(item => typeof item?.source === 'string' && item.source.length)
    if (!sourced.length) return
    lines.push('', `${title}:`)
    for (const item of sourced) {
      const [start, end] = Array.isArray(item.lines) ? item.lines : [null, null]
      const hash = sha12(item.source)
      const label = [item.symbol ? `symbol ${item.symbol}` : null, item.relation ? `relation ${item.relation}` : null, item.direction && item.direction !== 'none' ? `direction ${item.direction}` : null].filter(Boolean).join(', ')
      lines.push('', `[Source: ${item.path} lines ${start}-${end} sha256:${hash}${label ? ` | ${label}` : ''}]`)
      lines.push(item.source)
      excerpts.push({ path: item.path, startLine: start, endLine: end, bytes: Buffer.byteLength(item.source), sha256: hash, section: title })
    }
  }
  section('Targets', context?.targets)
  section('Related evidence', context?.relatedEvidence)
  const hints = (context?.relatedHints ?? []).filter(hint => hint?.path)
  if (hints.length) {
    lines.push('', 'Related hints (navigation metadata only; NOT inspected source):')
    for (const hint of hints) lines.push(`- ${hint.path}${hint.relation ? ` (${hint.relation})` : ''}`)
  }
  lines.push('</stellar-grounded-context>')
  const text = lines.join('\n')
  return {
    text,
    excerpts,
    hintPaths: hints.map(hint => hint.path),
    topTarget: context?.targets?.[0]?.path ?? null,
    sourceBytes: excerpts.reduce((sum, excerpt) => sum + excerpt.bytes, 0),
    payloadBytes: Buffer.byteLength(text)
  }
}

export const GROUNDING_CONTRACT = `The StellarCode excerpts above are live repository source already read from the current committed snapshot; each one is labeled with its path and line range. Do not re-read the exact same path and line range merely to verify it. Use repository tools only when required source is missing, when you need lines outside the supplied ranges, or when the supplied evidence does not answer the task. Related hints are navigation metadata only and are NOT inspected source: inspect a hinted file before listing it in your answer.`

// Merge [start,end] line ranges per path.
function mergedRanges(ranges) {
  const byPath = new Map()
  for (const range of ranges) {
    if (!range?.path || !Number.isFinite(Number(range.startLine)) || !Number.isFinite(Number(range.endLine))) continue
    if (!byPath.has(range.path)) byPath.set(range.path, [])
    byPath.get(range.path).push([Number(range.startLine), Number(range.endLine)])
  }
  for (const [file, list] of byPath) {
    list.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const [start, end] of list) {
      const last = merged.at(-1)
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    byPath.set(file, merged)
  }
  return byPath
}

// Later reads that overlap source the agent already had from the delivered context.
// Overlap is by line range, not filename. Duplicate bytes of a partially overlapping read
// are its bytes scaled by the overlapping share of its lines.
export function duplicateReads(contextRanges, laterReads, contextSourceBytes) {
  const context = mergedRanges(contextRanges)
  const files = new Set()
  let ranges = 0
  let bytes = 0
  for (const read of laterReads ?? []) {
    const spans = context.get(read.path)
    if (!spans) continue
    const start = Number(read.startLine), end = Number(read.endLine)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    let overlap = 0
    for (const [a, b] of spans) overlap += Math.max(0, Math.min(end, b) - Math.max(start, a) + 1)
    if (!overlap) continue
    files.add(read.path)
    ranges++
    bytes += Number(read.bytes ?? 0) * (overlap / (end - start + 1))
  }
  bytes = Math.round(bytes)
  return {
    duplicateReadFiles: files.size,
    duplicateReadRanges: ranges,
    duplicateReadBytes: bytes,
    duplicateReadPct: contextSourceBytes > 0 ? Number((bytes / contextSourceBytes * 100).toFixed(2)) : null
  }
}

// Mechanical post-context behavior class.
//   A accepted delivered context and answered (no repository inspection after it)
//   C re-read source that was already delivered (any duplicate range)
//   D ignored the context for broad search (two or more search calls after it)
//   B read additional, missing source only
export function verificationClass({ postContextToolCalls, duplicateReadRanges, postContextSearchCalls }) {
  if (!postContextToolCalls) return 'A'
  if (duplicateReadRanges > 0) return 'C'
  if (postContextSearchCalls >= 2) return 'D'
  return 'B'
}

// Of the delivered bytes for files the answer cites, the share not duplicate-read.
export function contextReuseRate(excerpts, answerFiles, duplicateReadsByPath) {
  const cited = new Set(answerFiles ?? [])
  let relevant = 0, duplicated = 0
  for (const excerpt of excerpts ?? []) {
    if (!cited.has(excerpt.path)) continue
    relevant += excerpt.bytes
  }
  for (const [file, value] of Object.entries(duplicateReadsByPath ?? {})) if (cited.has(file)) duplicated += value
  if (!relevant) return null
  return Number(Math.max(0, (relevant - Math.min(relevant, duplicated)) / relevant).toFixed(4))
}

// Per-path duplicate bytes, for contextReuseRate.
export function duplicateBytesByPath(contextRanges, laterReads) {
  const result = {}
  for (const read of laterReads ?? []) {
    const single = duplicateReads(contextRanges, [read], 0)
    if (single.duplicateReadBytes) result[read.path] = (result[read.path] ?? 0) + single.duplicateReadBytes
  }
  return result
}

// Turn metrics from per-model-call records [{turn, inputTokens, toolUses}] (turn is
// 1-based). availableTurn is the model turn after which delivered context was visible:
// 0 for prefetch (before turn 1), the turn that issued `stellar context` for pull, null
// when no context was delivered. Missing per-turn telemetry yields nulls, never estimates.
export function turnMetrics(turns, { availableTurn = null, firstRelevantTurn = null } = {}) {
  if (!Array.isArray(turns) || !turns.length) {
    return { modelTurns: null, initialTurnInputTokens: null, subsequentTurnInputTokens: null, turnsAfterGroundedContextAvailable: null, turnsBeforeFirstRelevantSource: null, turnsAfterFirstRelevantSource: null }
  }
  const ordered = [...turns].sort((a, b) => a.turn - b.turn)
  const known = ordered.every(turn => Number.isFinite(turn.inputTokens))
  return {
    modelTurns: ordered.length,
    initialTurnInputTokens: known ? ordered[0].inputTokens : null,
    subsequentTurnInputTokens: known ? ordered.slice(1).reduce((sum, turn) => sum + turn.inputTokens, 0) : null,
    // Exploration/verification after delivered context: model turns, after the context
    // became visible, that still called a tool.
    turnsAfterGroundedContextAvailable: availableTurn == null ? null : ordered.filter(turn => turn.turn > availableTurn && turn.toolUses > 0).length,
    turnsBeforeFirstRelevantSource: firstRelevantTurn,
    turnsAfterFirstRelevantSource: firstRelevantTurn == null ? null : ordered.filter(turn => turn.turn > firstRelevantTurn).length
  }
}

// Delivery metrics for one StellarCode-condition run. `result.metrics` comes from runAgent:
// interactions carry their model turn and kind, and source reads carry `via` and `turn`.
// For prefetch, `prefetch` holds the delivered envelope and its verified reads (turn 0).
// For pull, the delivered context is the first `stellar context` call's verified reads.
// expectedFiles is used only after the run, for the first-relevant-source turn metric.
export function deliveryMetrics({ condition, result, prefetch = null, expectedFiles = [], answerFiles = [] }) {
  const metrics = result?.metrics ?? {}
  const interactions = metrics.interactions ?? []
  const reads = metrics.sourceReads ?? []
  let contextRanges = []
  let laterReads = reads
  let availableTurn = null
  let topTarget = null
  if (prefetch) {
    contextRanges = prefetch.reads
    laterReads = reads.filter(read => read.via !== 'prefetch')
    availableTurn = 0
    topTarget = prefetch.envelope.topTarget
  } else {
    const first = interactions.find(interaction => interaction.kind === 'stellarContext')
    if (first) {
      availableTurn = first.turn ?? null
      topTarget = first.topTarget ?? null
      contextRanges = reads.filter(read => read.via === 'stellar-context' && read.turn === first.turn)
      laterReads = reads.filter(read => !contextRanges.includes(read))
    }
  }
  const contextSourceBytes = contextRanges.reduce((sum, read) => sum + Number(read.bytes ?? 0), 0)
  // Tool calls issued after the model could see the delivered context. Calls issued in the
  // same turn as the pull-mode context call were made before its result was visible.
  const post = availableTurn == null ? [] : interactions.filter(interaction => Number(interaction.turn ?? 0) > availableTurn)
  const postContextToolCalls = availableTurn == null ? null : post.length
  const postContextSearchCalls = availableTurn == null ? null : post.filter(interaction => interaction.search).length
  const duplicates = duplicateReads(contextRanges, laterReads.filter(read => availableTurn == null || Number(read.turn ?? 0) > availableTurn), contextSourceBytes)
  const expected = new Set(expectedFiles)
  const relevantTurns = reads.filter(read => expected.has(read.path)).map(read => Number(read.turn ?? NaN)).filter(Number.isFinite)
  const firstRelevantTurn = relevantTurns.length ? Math.min(...relevantTurns) : null
  return {
    deliveryMode: condition === 'stellar' ? 'pull' : condition,
    prefetchLocalMs: prefetch?.localMs ?? null,
    prefetchSourceBytes: prefetch ? prefetch.envelope.sourceBytes : null,
    prefetchPayloadBytes: prefetch ? prefetch.envelope.payloadBytes : null,
    contextTopTarget: topTarget,
    contextSourceBytes,
    groundedContextTurn: availableTurn,
    postContextToolCalls,
    postContextSearchCalls,
    ...duplicates,
    prefetchVerification: availableTurn == null ? null : duplicates.duplicateReadRanges > 0,
    solvedWithoutAdditionalRepoInspection: availableTurn == null ? null : postContextToolCalls === 0,
    verificationClass: availableTurn == null ? null : verificationClass({ postContextToolCalls, duplicateReadRanges: duplicates.duplicateReadRanges, postContextSearchCalls }),
    contextReuseRate: availableTurn == null ? null : contextReuseRate(contextRanges, answerFiles, duplicateBytesByPath(contextRanges, laterReads)),
    resultNumTurns: metrics.resultNumTurns ?? null,
    ...turnMetrics(metrics.turns, { availableTurn, firstRelevantTurn })
  }
}

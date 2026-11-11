// Delivery-experiment report: compares prefetch delivery modes with pull, per repository,
// using same-campaign pairs (same task and repetition). Repo median is the primary view.
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJsonl } from './report.js'
import { DELIVERY_MODES } from './delivery.js'

const finite = values => values.filter(v => v != null && v !== '').map(Number).filter(Number.isFinite)
function median(values) {
  const sorted = finite(values).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const mean = values => { const list = finite(values); return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null }
const pct = (part, whole) => whole ? Number((part / whole * 100).toFixed(2)) : null
const round = (value, digits = 2) => value == null ? null : Number(Number(value).toFixed(digits))
const reduction = (mode, pull) => pull ? round((1 - mode / pull) * 100) : null

function conditionStats(rows) {
  const n = rows.length
  const rate = key => n ? round(rows.filter(row => row[key] === true).length / n * 100) : null
  const classes = { A: 0, B: 0, C: 0, D: 0 }
  for (const row of rows) if (row.verificationClass in classes) classes[row.verificationClass]++
  const delivered = rows.reduce((sum, row) => sum + Number(row.contextSourceBytes ?? 0), 0)
  const duplicated = rows.reduce((sum, row) => sum + Number(row.duplicateReadBytes ?? 0), 0)
  const withContext = rows.filter(row => row.groundedContextTurn != null)
  return {
    runs: n,
    correctness: { answer: rate('answerSuccess'), groundedSuccess: rate('success'), discovery: rate('discoverySuccess'), grounding: rate('sourceGrounded') },
    inputTokens: { median: median(rows.map(r => r.inputTokens)), mean: round(mean(rows.map(r => r.inputTokens))), total: rows.reduce((s, r) => s + Number(r.inputTokens ?? 0), 0) },
    initialTurnInputTokens: { median: median(rows.map(r => r.initialTurnInputTokens)) },
    subsequentTurnInputTokens: { median: median(rows.map(r => r.subsequentTurnInputTokens)) },
    modelTurns: { median: median(rows.map(r => r.modelTurns)), mean: round(mean(rows.map(r => r.modelTurns))), total: rows.reduce((s, r) => s + Number(r.modelTurns ?? 0), 0), missing: rows.filter(r => r.modelTurns == null).length },
    toolCalls: { median: median(rows.map(r => r.toolCalls)), mean: round(mean(rows.map(r => r.toolCalls))), total: rows.reduce((s, r) => s + Number(r.toolCalls ?? 0), 0) },
    searchCalls: { median: median(rows.map(r => r.searchCalls)), mean: round(mean(rows.map(r => r.searchCalls))), total: rows.reduce((s, r) => s + Number(r.searchCalls ?? 0), 0) },
    sourceBytesRead: { median: median(rows.map(r => r.sourceBytesRead)), total: rows.reduce((s, r) => s + Number(r.sourceBytesRead ?? 0), 0) },
    turnsAfterGroundedContextAvailable: { median: median(rows.map(r => r.turnsAfterGroundedContextAvailable)), mean: round(mean(rows.map(r => r.turnsAfterGroundedContextAvailable))) },
    postContextToolCalls: { median: median(rows.map(r => r.postContextToolCalls)), mean: round(mean(rows.map(r => r.postContextToolCalls))) },
    duplicateReads: {
      runsWithDuplicate: rows.filter(r => r.prefetchVerification === true).length,
      verificationRate: withContext.length ? round(rows.filter(r => r.prefetchVerification === true).length / withContext.length * 100) : null,
      duplicateReadBytes: duplicated,
      deliveredSourceBytes: delivered,
      duplicateOfDeliveredPct: pct(duplicated, delivered),
      medianDuplicateReadPct: median(rows.map(r => r.duplicateReadPct))
    },
    solvedWithoutAdditionalRepoInspection: withContext.length ? round(rows.filter(r => r.solvedWithoutAdditionalRepoInspection === true).length / withContext.length * 100) : null,
    verificationClasses: classes,
    contextReuseRate: { median: median(rows.map(r => r.contextReuseRate)), measured: rows.filter(r => r.contextReuseRate != null).length },
    prefetchLocalMs: { median: median(rows.map(r => r.prefetchLocalMs)) },
    prefetchPayloadBytes: { median: median(rows.map(r => r.prefetchPayloadBytes)) },
    noContextRuns: n - withContext.length
  }
}

// Pairs a mode with pull by task and repetition. Aggregate reductions are 1 - sum(mode) /
// sum(pull) over the paired runs; per-task medians are reported beside them.
function pairedVsPull(pullRows, modeRows) {
  const key = row => `${row.taskId}#${row.repetition}`
  const pull = new Map(pullRows.map(row => [key(row), row]))
  const pairs = modeRows.filter(row => pull.has(key(row))).map(row => ({ mode: row, pull: pull.get(key(row)) }))
  const sum = (list, side, field) => list.reduce((s, pair) => s + Number(pair[side][field] ?? 0), 0)
  const turnPairs = pairs.filter(pair => pair.mode.modelTurns != null && pair.pull.modelTurns != null)
  const byTask = new Map()
  for (const pair of pairs) { if (!byTask.has(pair.mode.taskId)) byTask.set(pair.mode.taskId, []); byTask.get(pair.mode.taskId).push(pair) }
  const tasks = [...byTask.entries()].map(([taskId, list]) => ({
    taskId,
    category: list[0].mode.category,
    pullMedianInput: median(list.map(p => p.pull.inputTokens)), modeMedianInput: median(list.map(p => p.mode.inputTokens)),
    inputReductionPct: reduction(median(list.map(p => p.mode.inputTokens)), median(list.map(p => p.pull.inputTokens))),
    pullMedianTurns: median(list.map(p => p.pull.modelTurns)), modeMedianTurns: median(list.map(p => p.mode.modelTurns))
  }))
  return {
    pairs: pairs.length,
    inputReductionPct: reduction(sum(pairs, 'mode', 'inputTokens'), sum(pairs, 'pull', 'inputTokens')),
    modelTurnReductionPct: reduction(sum(turnPairs, 'mode', 'modelTurns'), sum(turnPairs, 'pull', 'modelTurns')),
    medianTurnDifference: turnPairs.length ? round(median(turnPairs.map(p => p.mode.modelTurns)) - median(turnPairs.map(p => p.pull.modelTurns))) : null,
    toolCallReductionPct: reduction(sum(pairs, 'mode', 'toolCalls'), sum(pairs, 'pull', 'toolCalls')),
    searchCallReductionPct: reduction(sum(pairs, 'mode', 'searchCalls'), sum(pairs, 'pull', 'searchCalls')),
    medianTaskInputReductionPct: median(tasks.map(t => t.inputReductionPct)),
    tasks
  }
}

async function loadCampaign(label, dir) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  const rows = {}
  for (const mode of DELIVERY_MODES) {
    const file = path.join(dir, `${mode}.jsonl`)
    try { rows[mode] = await readJsonl(file) } catch { rows[mode] = null }
  }
  let expected = new Map()
  try {
    const tasks = JSON.parse(await fs.readFile(manifest.tasksFile, 'utf8')).tasks
    expected = new Map(tasks.map(task => [task.id, new Set(task.expectedFiles)]))
  } catch {}
  return { label, dir, manifest, rows, expected }
}

// Top target of a task from the delivered context (identical for every condition of the
// same task: the context is deterministic for a prompt and snapshot).
function topTargetByTask(campaign) {
  const top = new Map()
  for (const mode of ['prefetch', 'prefetch-contract', 'pull']) for (const row of campaign.rows[mode] ?? []) if (row.contextTopTarget && !top.has(row.taskId)) top.set(row.taskId, row.contextTopTarget)
  return top
}

export async function deliveryReport(specs) {
  const campaigns = []
  for (const spec of specs) {
    const eq = spec.indexOf('=')
    const label = eq > 0 ? spec.slice(0, eq) : path.basename(path.dirname(path.resolve(spec)))
    campaigns.push(await loadCampaign(label, path.resolve(eq > 0 ? spec.slice(eq + 1) : spec)))
  }
  const modes = DELIVERY_MODES.filter(mode => campaigns.some(c => c.rows[mode]?.length))
  const byRepository = {}
  const pooled = Object.fromEntries(modes.map(mode => [mode, []]))
  const strata = {}
  for (const campaign of campaigns) {
    const repo = { label: campaign.label, runtimeCommit: campaign.manifest.runtime?.commit ?? null, runtimeDirty: campaign.manifest.runtime?.dirty ?? null, changedDuringCampaign: campaign.manifest.runtime?.changedDuringCampaign ?? null, taskHash: campaign.manifest.taskHash, repoCommit: campaign.manifest.projectCommit, conditions: {}, vsPull: {} }
    for (const mode of modes) if (campaign.rows[mode]) { repo.conditions[mode] = conditionStats(campaign.rows[mode]); pooled[mode].push(...campaign.rows[mode].map(row => ({ ...row, repository: campaign.label }))) }
    const top = topTargetByTask(campaign)
    for (const mode of modes.filter(m => m !== 'pull')) {
      if (!campaign.rows.pull || !campaign.rows[mode]) continue
      repo.vsPull[mode] = pairedVsPull(campaign.rows.pull, campaign.rows[mode])
      for (const correct of [true, false]) {
        const inStratum = row => { const t = top.get(row.taskId); return t != null && campaign.expected.get(row.taskId)?.has(t) === correct }
        const key = `${mode}:${correct ? 'topCorrect' : 'topWrong'}`
        ;(strata[key] ??= { pull: [], mode: [] })
        strata[key].pull.push(...campaign.rows.pull.filter(inStratum).map(r => ({ ...r, taskId: `${campaign.label}/${r.taskId}` })))
        strata[key].mode.push(...campaign.rows[mode].filter(inStratum).map(r => ({ ...r, taskId: `${campaign.label}/${r.taskId}` })))
      }
    }
    byRepository[campaign.label] = repo
  }
  const repoMedian = (mode, field) => median(Object.values(byRepository).map(repo => repo.vsPull[mode]?.[field]))
  const repoMedianVsPull = Object.fromEntries(modes.filter(m => m !== 'pull').map(mode => [mode, {
    inputReductionPct: repoMedian(mode, 'inputReductionPct'),
    modelTurnReductionPct: repoMedian(mode, 'modelTurnReductionPct'),
    medianTurnDifference: repoMedian(mode, 'medianTurnDifference'),
    toolCallReductionPct: repoMedian(mode, 'toolCallReductionPct'),
    searchCallReductionPct: repoMedian(mode, 'searchCallReductionPct')
  }]))
  const pooledConditions = Object.fromEntries(modes.map(mode => [mode, conditionStats(pooled[mode])]))
  const pooledVsPull = Object.fromEntries(modes.filter(m => m !== 'pull').map(mode => [mode, (() => {
    const key = row => `${row.repository}/${row.taskId}`
    const tag = rows => rows.map(row => ({ ...row, taskId: key(row) }))
    const result = pairedVsPull(tag(pooled.pull), tag(pooled[mode]))
    delete result.tasks
    return result
  })()]))
  const stratification = Object.fromEntries(Object.entries(strata).map(([key, value]) => {
    const result = pairedVsPull(value.pull, value.mode)
    return [key, { tasks: result.tasks.length, pairs: result.pairs, inputReductionPct: result.inputReductionPct, modelTurnReductionPct: result.modelTurnReductionPct, medianTaskInputReductionPct: result.medianTaskInputReductionPct }]
  }))
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      pairing: 'Same campaign, same task and repetition. Reductions are 1 - sum(mode)/sum(pull) over paired runs; positive means the mode used less.',
      modelTurns: 'One model turn per distinct assistant message id in the Claude stream (one provider call each). Per-turn input is that call\'s input + cache-read + cache-creation tokens. Missing telemetry is null, never estimated.',
      turnsAfterGroundedContextAvailable: 'Model turns that still called a tool after the delivered context was visible: after turn 0 for prefetch, after the turn that issued stellar context for pull.',
      duplicateReads: 'Later reads overlapping delivered line ranges (by range overlap, partial overlaps scaled by overlapping line share).',
      verificationClasses: 'A no post-context tool call; C re-read delivered source; D two or more post-context search calls; B other (additional missing source).',
      contextReuseRate: 'Delivered bytes of files cited in the answer that were not re-read, over delivered bytes of cited files. File-level; null when no cited file was delivered.',
      topTarget: 'Top target of the deterministic context for the task, compared with expectedFiles after the run.'
    },
    campaigns: campaigns.map(c => ({ label: c.label, dir: c.dir, runtimeCommit: c.manifest.runtime?.commit, taskHash: c.manifest.taskHash, repoCommit: c.manifest.projectCommit, modes: c.manifest.modes })),
    modes,
    repoMedianVsPull,
    pooled: { conditions: pooledConditions, vsPull: pooledVsPull },
    byRepository,
    stratification
  }
}

export async function writeDeliveryReport(specs, { jsonFile } = {}) {
  const report = await deliveryReport(specs)
  if (jsonFile) { await fs.mkdir(path.dirname(path.resolve(jsonFile)), { recursive: true }); await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n') }
  return report
}

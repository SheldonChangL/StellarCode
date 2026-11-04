import fs from 'node:fs/promises'
import path from 'node:path'
import { BENCHMARK_CATEGORIES } from './tasks.js'

// v0.5.6 generalization analysis. Everything here is benchmark/report tooling: it reads
// finished campaign reports and never influences StellarCode runtime behaviour.
//
// Methodology constants are fixed BEFORE any v0.5.6 holdout result is observed. Changing
// them after seeing results invalidates the holdout; bump GENERALIZATION_METHOD_VERSION
// and say why in the report if they ever change.
export const GENERALIZATION_METHOD_VERSION = 1
export const GENERALIZATION_SCHEMA_VERSION = 1
export const METHODOLOGY = Object.freeze({
  // Task-level win/loss uses the per-task median across repetitions. A reduction inside
  // (-5%, +5%) is neutral.
  neutralThresholdPct: 5,
  // Catastrophic regression: task-median Stellar input tokens more than 25% above the
  // baseline task median, or task-median Stellar tool calls more than 2x baseline (a
  // zero-tool baseline is treated as 1 so a single extra call is not catastrophic).
  catastrophicInputIncreasePct: 25,
  catastrophicToolCallMultiplier: 2,
  // Determinism: coefficient of variation (population stddev / mean) over repetitions of
  // the same task and condition. Needs >= 2 repetitions; reported, never a correctness gate.
  determinismMetrics: ['inputTokens', 'toolCalls', 'sourceBytesRead'],
  // v0.5.6 repo-level acceptance targets (prompt section 31/32). Not tuned after results.
  targets: {
    correctnessPct: 100,
    directional: { inputTokens: 20, toolCalls: 20, searchCalls: 30, sourceBytes: 30 },
    strong: { inputTokens: 30, toolCalls: 35, searchCalls: 50, sourceBytes: 50 }
  },
  primaryGeneralizationSignal: 'repo-median'
})

export const WIN_LOSS_METRICS = [
  ['inputTokens', 'InputTokens'],
  ['toolCalls', 'ToolCalls'],
  ['searchCalls', 'SearchCalls'],
  ['sourceBytesRead', 'SourceBytes']
]

const EFFICIENCY_METRICS = [
  ['inputTokens', 'inputTokenReductionPct'],
  ['toolCalls', 'toolCallReductionPct'],
  ['searchCalls', 'searchCallReductionPct'],
  ['sourceBytesRead', 'sourceBytesReductionPct'],
  ['filesOpened', 'filesOpenedReductionPct']
]

const CORRECTNESS_FIELDS = [
  ['discoverySuccess', 'discoveryRate'],
  ['sourceGrounded', 'sourceGroundingRate'],
  ['answerSuccess', 'answerSuccessRate'],
  ['success', 'groundedSuccessRate']
]

export const PROVIDER_DRIFT_NOTE = 'Absolute provider input-token values across campaigns are not directly comparable: provider-side context (system prompt, tool schema, cached framework context) can change between campaigns even with an identical agent and model version. Only same-campaign paired reductions are valid performance evidence.'

const finite = v => v != null && Number.isFinite(Number(v))
const num = v => finite(v) ? Number(v) : null
export function mean(values) { const v = values.filter(finite).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
export function median(values) { const v = values.filter(finite).map(Number).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
function sum(values) { return values.filter(finite).reduce((a, b) => a + Number(b), 0) }
export function reductionPct(base, next) {
  if (!finite(base) || !finite(next)) return null
  if (Number(base) === 0) return Number(next) === 0 ? 0 : null
  return (Number(base) - Number(next)) / Number(base) * 100
}
function rate(rows, field) {
  const usable = rows.filter(r => r[field] != null)
  return usable.length ? usable.filter(r => r[field] === true).length / usable.length * 100 : null
}
function fraction(count, total) { return `${count}/${total}` }

// population coefficient of variation; null when fewer than two observations.
export function coefficientOfVariation(values) {
  const v = values.filter(finite).map(Number)
  if (v.length < 2) return null
  const m = v.reduce((a, b) => a + b, 0) / v.length
  if (m === 0) return v.every(x => x === 0) ? 0 : null
  const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length
  return Math.sqrt(variance) / m
}

// --- pair normalisation ----------------------------------------------------------------

function side(raw = {}) {
  return {
    inputTokens: num(raw.inputTokens),
    toolCalls: num(raw.toolCalls),
    searchCalls: num(raw.searchCalls),
    filesOpened: num(raw.filesOpened),
    sourceBytesRead: num(raw.sourceBytesRead),
    expectedSourceBytes: num(raw.expectedSourceBytes),
    nonExpectedSourceBytes: num(raw.nonExpectedSourceBytes),
    firstRelevantMs: num(raw.firstRelevantMs),
    agentStartToFirstToolMs: num(raw.agentStartToFirstToolMs),
    firstToolDurationMs: num(raw.firstToolDurationMs),
    firstRelevantSourceCompletionMs: num(raw.firstRelevantSourceCompletionMs ?? raw.firstRelevantMs),
    discoverySuccess: raw.discoverySuccess ?? null,
    sourceGrounded: raw.sourceGrounded ?? null,
    answerSuccess: raw.answerSuccess ?? null,
    success: raw.success ?? null
  }
}

// Pairs carry repository/agent identity so pooled views can never mix two campaigns'
// pairs under one key.
function normalizePairs(report, campaign) {
  return (report.pairs ?? []).map(p => ({
    repository: campaign.repository,
    agent: campaign.agent,
    campaignId: campaign.id,
    taskId: p.taskId,
    repetition: p.repetition ?? 1,
    category: p.category ?? 'navigation',
    baseline: side(p.baseline),
    stellar: side(p.stellar)
  }))
}

// --- campaign loading ------------------------------------------------------------------

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
async function exists(file) { try { await fs.access(file); return true } catch { return false } }

// Accepts `name=path/report.json` or `path/report.json`. Reads the manifest beside the
// report when present. v4 reports (v0.5.4/v0.5.5) are upgraded by re-reading their JSONL
// rows when available; otherwise fields absent from v4 pairs stay null (reported n/a).
export async function loadCampaign(spec, { rebuild } = {}) {
  const eq = spec.indexOf('=')
  const label = eq > 0 && !/^[A-Za-z]:[\\/]/.test(spec) ? spec.slice(0, eq) : null
  const reportFile = path.resolve(label ? spec.slice(eq + 1) : spec)
  let report = await readJson(reportFile)
  const dir = path.dirname(reportFile)
  const manifest = await exists(path.join(dir, 'manifest.json')) ? await readJson(path.join(dir, 'manifest.json')) : null
  const sourceSchemaVersion = report.schemaVersion ?? null
  let upgradedFromJsonl = false
  if ((report.schemaVersion ?? 0) < 5 && rebuild) {
    const baseline = path.join(dir, 'baseline.jsonl'), stellar = path.join(dir, 'stellar.jsonl')
    if (await exists(baseline) && await exists(stellar)) { report = await rebuild(baseline, stellar); upgradedFromJsonl = true }
  }
  const loaded = campaignFromReport(report, { label, reportFile, manifest, sourceSchemaVersion, upgradedFromJsonl })
  // Identity must never fall back to a shared placeholder: two unlabelled reports would merge
  // under "unknown" and hide each other's regressions.
  if (loaded.campaign.repository === 'unknown' || loaded.campaign.agent === 'unknown') {
    throw new Error(`${reportFile}: cannot determine ${loaded.campaign.repository === 'unknown' ? 'repository' : 'agent'}; pass NAME=path with a manifest beside the report`)
  }
  // A campaign without a manifest never finished (quota, Ctrl-C, crash): unverifiable.
  if (!manifest) { loaded.campaign.invalidReasons.push('no manifest.json beside the report (aborted or incomplete campaign)'); loaded.campaign.valid = false }
  return loaded
}

export function campaignFromReport(report, { label = null, reportFile = null, manifest = null, sourceSchemaVersion = report.schemaVersion ?? null, upgradedFromJsonl = false } = {}) {
  const meta = { ...(report.campaign ?? {}), ...(manifest ? manifestCampaign(manifest) : {}) }
  const firstPair = report.pairs?.[0]
  const repository = label ?? meta.repository ?? (meta.projectRoot ? path.basename(meta.projectRoot) : null) ?? 'unknown'
  const agent = meta.agent ?? firstPair?.agent ?? 'unknown'
  const campaign = {
    id: `${repository}::${agent}::${meta.campaignStartedAt ?? reportFile ?? ''}`,
    repository, agent,
    agentVersion: meta.agentVersion ?? null,
    model: meta.model ?? null,
    runtimeCommit: meta.runtimeCommit ?? null,
    runtimePackageVersion: meta.runtimePackageVersion ?? null,
    runtimeDirty: meta.runtimeDirty ?? null,
    runtimeChangedDuringCampaign: meta.runtimeChangedDuringCampaign ?? null,
    repoCommit: meta.repoCommit ?? null,
    taskHash: meta.taskHash ?? null,
    campaignStartedAt: meta.campaignStartedAt ?? null,
    repeat: meta.repeat ?? null,
    projectRoot: meta.projectRoot ?? null,
    repositoryIdentity: meta.repositoryIdentity ?? null,
    runtimeVerified: meta.runtimeCommit != null && meta.runtimeDirty === false,
    reportFile, sourceSchemaVersion, upgradedFromJsonl
  }
  campaign.invalidReasons = []
  if (campaign.runtimeDirty === true) campaign.invalidReasons.push('runtime source was dirty at campaign start')
  if (campaign.runtimeChangedDuringCampaign === true) campaign.invalidReasons.push('runtime source changed during the campaign')
  campaign.valid = campaign.invalidReasons.length === 0
  return { campaign, report, pairs: normalizePairs(report, campaign) }
}

function manifestCampaign(m) {
  return {
    repository: m.repository ?? undefined,
    repositoryIdentity: m.repositoryIdentity ?? undefined,
    projectRoot: m.projectRoot,
    agent: m.agent, agentVersion: m.agentVersion, model: m.model ?? null,
    runtimeCommit: m.runtime?.commit ?? undefined,
    runtimePackageVersion: m.runtime?.packageVersion ?? undefined,
    runtimeDirty: m.runtime?.dirty ?? undefined,
    runtimeChangedDuringCampaign: m.runtime?.changedDuringCampaign ?? undefined,
    repoCommit: m.projectCommit,
    taskHash: m.taskHash ?? undefined,
    campaignStartedAt: m.startedAt ?? m.createdAt,
    repeat: m.repeat
  }
}

// --- per-task summaries ----------------------------------------------------------------

function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) { const k = keyFn(item); const list = map.get(k) ?? []; list.push(item); map.set(k, list) }
  return map
}

export function taskStats(pairs) {
  const byTask = groupBy(pairs, p => `${p.repository}\u0000${p.agent}\u0000${p.taskId}`)
  return [...byTask.values()].map(list => {
    const first = list[0]
    const stat = { repository: first.repository, agent: first.agent, taskId: first.taskId, category: first.category, pairedRuns: list.length }
    for (const [field] of [...WIN_LOSS_METRICS, ['filesOpened'], ['firstRelevantMs']]) {
      const b = median(list.map(p => p.baseline[field])), s = median(list.map(p => p.stellar[field]))
      stat[field] = { baselineMedian: b, stellarMedian: s, reductionPct: reductionPct(b, s) }
    }
    stat.stellarGroundedSuccessRate = rate(list.map(p => p.stellar), 'success')
    stat.baselineGroundedSuccessRate = rate(list.map(p => p.baseline), 'success')
    stat.determinism = {}
    for (const field of METHODOLOGY.determinismMetrics) {
      stat.determinism[field] = {
        baselineCv: coefficientOfVariation(list.map(p => p.baseline[field])),
        stellarCv: coefficientOfVariation(list.map(p => p.stellar[field]))
      }
    }
    return stat
  }).sort((a, b) => `${a.repository}/${a.agent}/${a.taskId}`.localeCompare(`${b.repository}/${b.agent}/${b.taskId}`))
}

export function classifyChange(reduction, threshold = METHODOLOGY.neutralThresholdPct) {
  if (reduction == null) return 'n/a'
  if (reduction >= threshold) return 'win'
  if (reduction <= -threshold) return 'loss'
  return 'neutral'
}

function stellarSideWorse(baseline, stellar) {
  // Baseline 0 and Stellar > 0 has no finite reduction but is unambiguously a loss.
  return finite(baseline) && finite(stellar) && Number(baseline) === 0 && Number(stellar) > 0
}

export function winLossDistribution(stats) {
  const result = {}
  for (const [field, label] of WIN_LOSS_METRICS) {
    const counts = { win: 0, neutral: 0, loss: 0, 'n/a': 0 }
    for (const s of stats) {
      const m = s[field]
      const kind = m.reductionPct == null && stellarSideWorse(m.baselineMedian, m.stellarMedian) ? 'loss' : classifyChange(m.reductionPct)
      counts[kind]++
    }
    result[label.charAt(0).toLowerCase() + label.slice(1)] = { wins: counts.win, neutral: counts.neutral, losses: counts.loss, notApplicable: counts['n/a'], tasks: stats.length }
  }
  return result
}

export function catastrophicRegressions(stats) {
  const out = []
  for (const s of stats) {
    const input = s.inputTokens, tools = s.toolCalls
    if (finite(input.baselineMedian) && finite(input.stellarMedian) && input.baselineMedian > 0 &&
        input.stellarMedian > input.baselineMedian * (1 + METHODOLOGY.catastrophicInputIncreasePct / 100)) {
      out.push(regression(s, 'inputTokens', input))
    }
    if (finite(tools.baselineMedian) && finite(tools.stellarMedian) &&
        tools.stellarMedian > Math.max(1, tools.baselineMedian) * METHODOLOGY.catastrophicToolCallMultiplier) {
      out.push(regression(s, 'toolCalls', tools))
    }
  }
  return out
}

function regression(s, metric, m) {
  return {
    repository: s.repository, agent: s.agent, taskId: s.taskId, category: s.category, metric,
    baselineMedian: m.baselineMedian, stellarMedian: m.stellarMedian,
    deltaPct: m.reductionPct == null ? null : -m.reductionPct,
    stellarGroundedSuccessRate: s.stellarGroundedSuccessRate
  }
}

export function determinismSummary(stats) {
  const result = {}
  for (const field of METHODOLOGY.determinismMetrics) {
    const b = stats.map(s => s.determinism[field].baselineCv).filter(finite)
    const st = stats.map(s => s.determinism[field].stellarCv).filter(finite)
    const pairedTasks = stats.filter(s => finite(s.determinism[field].baselineCv) && finite(s.determinism[field].stellarCv))
    result[field] = {
      tasksWithRepetitions: pairedTasks.length,
      baselineMedianCv: median(b),
      stellarMedianCv: median(st),
      tasksWhereStellarLessVariable: pairedTasks.filter(s => s.determinism[field].stellarCv < s.determinism[field].baselineCv).length
    }
  }
  result.note = 'Coefficient of variation across repetitions of the same task and condition. Describes run-to-run stability only; it is not a correctness measure.'
  return result
}

// --- aggregation primitives ------------------------------------------------------------

function sideAggregate(rows) {
  const out = { runs: rows.length }
  for (const [field, key] of CORRECTNESS_FIELDS) out[key] = rate(rows, field)
  for (const [field] of EFFICIENCY_METRICS) out[`mean_${field}`] = mean(rows.map(r => r[field]))
  out.meanFirstRelevantMs = mean(rows.map(r => r.firstRelevantMs))
  out.medianFirstRelevantMs = median(rows.map(r => r.firstRelevantMs))
  const precisionRows = rows.filter(r => finite(r.expectedSourceBytes) && finite(r.nonExpectedSourceBytes))
  const expected = sum(precisionRows.map(r => r.expectedSourceBytes)), total = expected + sum(precisionRows.map(r => r.nonExpectedSourceBytes))
  out.expectedFileSourcePrecision = precisionRows.length && total > 0 ? expected / total : null
  return out
}

// Paired comparison of one pool of pairs: reductions of per-run means.
export function pairedSummary(pairs) {
  if (!pairs.length) return { status: 'n/a', pairedRuns: 0, tasks: 0 }
  const baseline = sideAggregate(pairs.map(p => p.baseline)), stellar = sideAggregate(pairs.map(p => p.stellar))
  const result = { status: 'measured', pairedRuns: pairs.length, tasks: new Set(pairs.map(p => `${p.repository}/${p.agent}/${p.taskId}`)).size }
  for (const [field, key] of EFFICIENCY_METRICS) result[key] = reductionPct(baseline[`mean_${field}`], stellar[`mean_${field}`])
  // Only pairs where both sides reached a relevant source: per-side medians over their own
  // non-null runs would compare different run sets (survivorship).
  const frPairs = pairs.filter(p => finite(p.baseline.firstRelevantMs) && finite(p.stellar.firstRelevantMs))
  result.firstRelevantPairs = frPairs.length
  result.firstRelevantReductionPct = reductionPct(median(frPairs.map(p => p.baseline.firstRelevantMs)), median(frPairs.map(p => p.stellar.firstRelevantMs)))
  result.correctness = Object.fromEntries(CORRECTNESS_FIELDS.map(([, key]) => [key, { baseline: baseline[key], stellar: stellar[key] }]))
  result.precision = { baseline: baseline.expectedFileSourcePrecision, stellar: stellar.expectedFileSourcePrecision }
  return result
}

function correctnessMeetsTarget(summary) {
  if (summary.status !== 'measured') return null
  return CORRECTNESS_FIELDS.every(([, key]) => summary.correctness[key].stellar === METHODOLOGY.targets.correctnessPct)
}

const REDUCTION_KEYS = ['inputTokenReductionPct', 'toolCallReductionPct', 'searchCallReductionPct', 'sourceBytesReductionPct', 'filesOpenedReductionPct', 'firstRelevantReductionPct']

function unitWeighted(units) {
  const out = { units: units.length }
  for (const key of REDUCTION_KEYS) {
    const values = units.map(u => u[key]).filter(finite)
    out[key] = { mean: mean(values), median: median(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, n: values.length }
  }
  out.precision = {
    baselineMedian: median(units.map(u => u.precision?.baseline)),
    stellarMedian: median(units.map(u => u.precision?.stellar))
  }
  return out
}

// --- the cross-repository report -------------------------------------------------------

export function crossRepositoryReport(loaded, { generatedAt = new Date().toISOString() } = {}) {
  const campaigns = loaded.map(l => l.campaign)
  markConflictingCampaigns(campaigns)
  const valid = loaded.filter(l => l.campaign.valid)
  const pairs = valid.flatMap(l => l.pairs)
  const agents = [...new Set(valid.map(l => l.campaign.agent))].sort()
  const repositories = [...new Set(valid.map(l => l.campaign.repository))].sort()

  // One unit = one repository x agent campaign. If a repository has several campaigns for
  // the same agent they are pooled into one unit (their pairs are disjoint by campaignId).
  const campaignUnits = []
  for (const agent of agents) for (const repository of repositories) {
    const unitPairs = pairs.filter(p => p.agent === agent && p.repository === repository)
    if (!unitPairs.length) continue
    campaignUnits.push({ repository, agent, ...pairedSummary(unitPairs) })
  }

  const byRepository = {}
  for (const repository of repositories) {
    const repoLoaded = valid.filter(l => l.campaign.repository === repository)
    const repoPairs = pairs.filter(p => p.repository === repository)
    const byAgent = {}
    for (const agent of agents) {
      const unit = campaignUnits.find(u => u.repository === repository && u.agent === agent)
      if (!unit) continue
      const stats = taskStats(repoPairs.filter(p => p.agent === agent))
      byAgent[agent] = {
        ...unit,
        meetsCorrectnessTarget: correctnessMeetsTarget(unit),
        categories: categoryTable(repoPairs.filter(p => p.agent === agent)),
        taskDistribution: distribution(stats),
        coverage: coverageOf(repoLoaded.filter(l => l.campaign.agent === agent)),
        campaign: repoLoaded.filter(l => l.campaign.agent === agent).map(l => publicCampaign(l.campaign))
      }
    }
    byRepository[repository] = byAgent
  }

  const byAgent = {}
  for (const agent of agents) {
    const agentPairs = pairs.filter(p => p.agent === agent)
    const units = campaignUnits.filter(u => u.agent === agent)
    const stats = taskStats(agentPairs)
    const categories = categoryAcrossRepos(agentPairs)
    const catastrophicTasks = catastrophicRegressions(stats)
    const card = scorecard(units, categories, catastrophicTasks)
    byAgent[agent] = {
      repositories: units.map(u => u.repository),
      runWeighted: pairedSummary(agentPairs),
      repoWeighted: unitWeighted(units),
      byCategory: categories,
      winLoss: winLossDistribution(stats),
      catastrophicRegressionTasks: catastrophicTasks,
      determinism: determinismSummary(stats),
      scorecard: { ...card, distinctRepositoryIdentities: distinctIdentities(valid.filter(l => l.campaign.agent === agent).map(l => l.campaign)), campaignsWithoutRuntimeVerification: valid.filter(l => l.campaign.agent === agent && !l.campaign.runtimeVerified).map(l => l.campaign.repository) },
      suggestedDecision: suggestedDecision({ scorecard: { ...card, distinctRepositoryIdentities: distinctIdentities(valid.filter(l => l.campaign.agent === agent).map(l => l.campaign)) } }),
      agentScope: agents.length === 1 ? `${agent}-only` : 'multi-agent'
    }
  }

  const allStats = taskStats(pairs)
  const catastrophic = catastrophicRegressions(allStats)
  return {
    schemaVersion: GENERALIZATION_SCHEMA_VERSION,
    methodVersion: GENERALIZATION_METHOD_VERSION,
    generatedAt,
    methodology: METHODOLOGY,
    notes: {
      providerDrift: PROVIDER_DRIFT_NOTE,
      weighting: 'runWeighted pools every paired run, so repositories with more tasks or repetitions weigh more. repoWeighted treats each repository x agent campaign as one unit and reports mean and median of per-campaign reductions; repo median is the primary generalization signal.',
      precision: 'Expected-file source precision is a focus proxy. A non-expected file is not necessarily useless.',
      missingValues: 'null means not applicable / not measured (rendered n/a), never zero.'
    },
    repositories: repositories.map(repository => ({ repository, agents: agents.filter(a => campaignUnits.some(u => u.repository === repository && u.agent === a)) })),
    campaigns: campaigns.map(publicCampaign),
    invalidCampaigns: campaigns.filter(c => !c.valid).map(c => ({ id: c.id, repository: c.repository, agent: c.agent, reasons: c.invalidReasons })),
    overall: {
      note: 'Pools all agents. Prefer byAgent for agent-specific claims; agents are never summed into one score.',
      runWeighted: pairedSummary(pairs),
      repoWeighted: unitWeighted(campaignUnits)
    },
    byRepository,
    byCategory: categoryAcrossRepos(pairs),
    byAgent,
    crossAgentConsistency: crossAgentConsistency(campaignUnits, agents, repositories),
    taskDistribution: distribution(allStats),
    winLoss: winLossDistribution(allStats),
    catastrophicRegressionTasks: catastrophic,
    determinism: determinismSummary(allStats),
    coverage: coverageOf(valid),
    excludedCoverage: coverageOf(loaded.filter(l => !l.campaign.valid)),
    comparabilityWarnings: comparabilityWarnings(campaigns),
    taskStats: allStats
  }
}

function publicCampaign(c) {
  const { reportFile, ...rest } = c
  return { ...rest, reportFile }
}

function distribution(stats) {
  const byCategory = {}
  for (const category of categoriesOf(stats.map(s => s.category))) byCategory[category] = stats.filter(s => s.category === category).length
  return { tasks: stats.length, byCategory }
}

function categoriesOf(list) { return [...BENCHMARK_CATEGORIES, ...[...new Set(list)].filter(c => !BENCHMARK_CATEGORIES.includes(c)).sort()] }

function categoryTable(pairs) {
  const out = {}
  for (const category of categoriesOf(pairs.map(p => p.category))) out[category] = pairedSummary(pairs.filter(p => p.category === category))
  return out
}

function categoryAcrossRepos(pairs) {
  const out = {}
  for (const category of categoriesOf(pairs.map(p => p.category))) {
    const catPairs = pairs.filter(p => p.category === category)
    const units = []
    for (const key of new Set(catPairs.map(p => `${p.repository}\u0000${p.agent}`))) {
      const [repository, agent] = key.split('\u0000')
      units.push({ repository, agent, ...pairedSummary(catPairs.filter(p => p.repository === repository && p.agent === agent)) })
    }
    const pooled = pairedSummary(catPairs)
    out[category] = {
      status: pooled.status,
      repoCount: new Set(catPairs.map(p => p.repository)).size,
      taskCount: new Set(catPairs.map(p => `${p.repository}/${p.taskId}`)).size,
      pairedRunCount: catPairs.length,
      runWeighted: pooled,
      repoWeighted: unitWeighted(units)
    }
  }
  return out
}

function coverageOf(loaded) {
  const totals = { campaigns: loaded.length, baselineRuns: 0, stellarRuns: 0, pairedAvailableRuns: 0, pairedRuns: 0, excludedFailedPairs: 0, unpairedBaseline: 0, unpairedStellar: 0, campaignsWithoutCoverage: 0 }
  for (const { report } of loaded) {
    const c = report.coverage
    if (!c) { totals.campaignsWithoutCoverage++; continue }
    for (const key of Object.keys(totals)) if (key in c) totals[key] += Number(c[key] ?? 0)
  }
  totals.coverageGaps = totals.excludedFailedPairs + totals.unpairedBaseline + totals.unpairedStellar
  totals.note = 'Pairs with a failed invocation on either side are coverage gaps and are excluded from every performance aggregate.'
  return totals
}

function crossAgentConsistency(units, agents, repositories) {
  if (agents.length < 2) return { status: 'n/a', reason: 'Only one agent completed campaigns; cross-agent consistency needs at least two.', agents }
  const shared = repositories.filter(r => agents.every(a => units.some(u => u.repository === r && u.agent === a)))
  const result = { status: 'measured', agents, sharedRepositories: shared.length }
  for (const key of ['inputTokenReductionPct', 'toolCallReductionPct', 'searchCallReductionPct', 'sourceBytesReductionPct']) {
    const allPositive = shared.filter(r => agents.every(a => (units.find(u => u.repository === r && u.agent === a)?.[key] ?? -Infinity) > 0))
    const measured = shared.filter(r => agents.every(a => finite(units.find(u => u.repository === r && u.agent === a)?.[key])))
    const agreeing = measured.filter(r => new Set(agents.map(a => Math.sign(units.find(u => u.repository === r && u.agent === a)[key]))).size === 1)
    result[key] = { repositoriesAllAgentsPositive: fraction(allPositive.length, shared.length), repositoriesDirectionAgrees: fraction(agreeing.length, measured.length), positiveRepositories: allPositive }
  }
  return result
}

function identityKey(c) { return c.repositoryIdentity?.rootCommits?.length ? c.repositoryIdentity.rootCommits.join(',') : null }

// Distinct repositories by root commit; a repository without recorded identity counts by name.
function distinctIdentities(campaigns) {
  return new Set(campaigns.map(c => identityKey(c) ?? `name:${c.repository}`)).size
}

// Same repository + agent but a different task set or repository commit cannot be pooled:
// task ids would collide across different prompts. Every campaign in such a group is excluded.
function markConflictingCampaigns(campaigns) {
  const groups = new Map()
  for (const c of campaigns.filter(c => c.valid)) { const k = `${c.repository}\u0000${c.agent}`; groups.set(k, [...(groups.get(k) ?? []), c]) }
  for (const list of groups.values()) {
    for (const field of ['taskHash', 'repoCommit']) {
      if (new Set(list.map(c => c[field] ?? '(unrecorded)')).size <= 1) continue
      for (const c of list) { c.invalidReasons.push(`${field} differs from another ${c.repository}/${c.agent} campaign; not the same holdout`); c.valid = false }
    }
  }
}

export function comparabilityWarnings(campaigns) {
  const warnings = []
  const byIdentity = new Map()
  for (const c of campaigns) { const k = identityKey(c); if (k) byIdentity.set(k, new Set([...(byIdentity.get(k) ?? []), c.repository])) }
  for (const names of byIdentity.values()) if (names.size > 1) warnings.push({ field: 'repositoryIdentity', values: [...names].sort(), message: 'Different repository labels share one root commit: they are the same repository and count once toward the repository gate.' })
  const byName = new Map()
  for (const c of campaigns) { const k = identityKey(c); if (k) byName.set(c.repository, new Set([...(byName.get(c.repository) ?? []), k])) }
  for (const [name, ids] of byName) if (ids.size > 1) warnings.push({ field: 'repositoryIdentity', repository: name, values: [...ids], message: `Label ${name} is used for repositories with different root commits.` })
  const distinct = (list, field) => [...new Set(list.map(c => c[field]).filter(v => v != null))]
  const runtime = distinct(campaigns, 'runtimeCommit')
  if (runtime.length > 1) warnings.push({ field: 'runtimeCommit', values: runtime, message: 'Campaigns ran different StellarCode runtime commits; cross-repository results do not describe one frozen runtime.' })
  if (campaigns.some(c => c.runtimeCommit == null)) warnings.push({ field: 'runtimeCommit', values: campaigns.filter(c => c.runtimeCommit == null).map(c => c.id), message: 'Some campaigns do not record their runtime commit (pre-v0.5.6 manifest); runtime identity cannot be verified for them.' })
  for (const agent of distinct(campaigns, 'agent')) {
    const group = campaigns.filter(c => c.agent === agent)
    for (const field of ['agentVersion', 'model']) {
      const values = [...new Set(group.map(c => c[field] ?? '(default)'))]
      if (values.length > 1) warnings.push({ field, agent, values, message: `${agent} campaigns used different ${field} values; per-agent aggregates mix them.` })
    }
  }
  const byRepo = new Map()
  for (const c of campaigns) { const list = byRepo.get(c.repository) ?? []; list.push(c); byRepo.set(c.repository, list) }
  for (const [repository, list] of byRepo) {
    for (const field of ['repoCommit', 'taskHash']) {
      const values = [...new Set(list.map(c => c[field] ?? '(unrecorded)'))]
      if (values.length > 1) warnings.push({ field, repository, values, message: `Campaigns for ${repository} differ in ${field}; they are not the same holdout.` })
    }
  }
  const starts = campaigns.map(c => c.campaignStartedAt).filter(Boolean)
  if (new Set(starts).size > 1) warnings.push({ field: 'campaignStartedAt', values: [...new Set(starts)].sort(), message: PROVIDER_DRIFT_NOTE })
  return warnings
}

// Honest scorecard: counts against fixed targets, never a blended score.
export function scorecard(units, byCategory, catastrophic) {
  const t = METHODOLOGY.targets
  const meets = (key, target) => units.filter(u => finite(u[key]) && u[key] >= target).length
  const repeatedCatastrophic = repeatedCatastrophicPatterns(catastrophic)
  const categories = Object.entries(byCategory).filter(([c]) => BENCHMARK_CATEGORIES.includes(c))
  return {
    repositories: units.length,
    repositoriesMeetingCorrectnessTarget: fraction(units.filter(u => correctnessMeetsTarget(u) === true).length, units.length),
    repositoriesMeetingInputTarget: fraction(meets('inputTokenReductionPct', t.directional.inputTokens), units.length),
    repositoriesMeetingToolTarget: fraction(meets('toolCallReductionPct', t.directional.toolCalls), units.length),
    repositoriesMeetingSearchTarget: fraction(meets('searchCallReductionPct', t.directional.searchCalls), units.length),
    repositoriesMeetingSourceByteTarget: fraction(meets('sourceBytesReductionPct', t.directional.sourceBytes), units.length),
    repositoriesMeetingStrongInputTarget: fraction(meets('inputTokenReductionPct', t.strong.inputTokens), units.length),
    repositoriesMeetingStrongToolTarget: fraction(meets('toolCallReductionPct', t.strong.toolCalls), units.length),
    repositoriesMeetingStrongSearchTarget: fraction(meets('searchCallReductionPct', t.strong.searchCalls), units.length),
    repositoriesMeetingStrongSourceByteTarget: fraction(meets('sourceBytesReductionPct', t.strong.sourceBytes), units.length),
    repoMedianInputReductionPct: median(units.map(u => u.inputTokenReductionPct)),
    repoMedianToolReductionPct: median(units.map(u => u.toolCallReductionPct)),
    repoMedianSearchReductionPct: median(units.map(u => u.searchCallReductionPct)),
    repoMedianSourceByteReductionPct: median(units.map(u => u.sourceBytesReductionPct)),
    categoriesWithPositiveMedianInputReduction: fraction(categories.filter(([, c]) => (c.repoWeighted.inputTokenReductionPct.median ?? -Infinity) > 0).length, BENCHMARK_CATEGORIES.length),
    categoriesRepresentedInAtLeastTwoRepos: fraction(categories.filter(([, c]) => c.repoCount >= 2).length, BENCHMARK_CATEGORIES.length),
    catastrophicRegressionTasks: catastrophic.length,
    repeatedCatastrophicPatterns: repeatedCatastrophic
  }
}

// A catastrophic regression is "repeated" when the same metric regresses catastrophically
// in the same category in at least two repositories. This is a mechanical flag for the
// human diagnosis; it does not by itself establish a generic root cause.
export function repeatedCatastrophicPatterns(catastrophic) {
  const groups = groupBy(catastrophic, c => `${c.agent}\u0000${c.category}\u0000${c.metric}`)
  return [...groups.values()].map(list => ({ agent: list[0].agent, category: list[0].category, metric: list[0].metric, repositories: [...new Set(list.map(c => c.repository))].sort(), tasks: list.map(c => `${c.repository}/${c.taskId}`) }))
    .filter(g => g.repositories.length >= 2)
}

// Mechanical application of the v0.5.6 decision rules (prompt sections 55-57). The final
// written decision may add judgement (e.g. classifying a regression as isolated) but must
// cite this result.
export function suggestedDecision(agentSummary) {
  const s = agentSummary.scorecard
  const [okRepos, unitRepos] = s.repositoriesMeetingCorrectnessTarget.split('/').map(Number)
  const totalRepos = Math.min(unitRepos, s.distinctRepositoryIdentities ?? unitRepos)
  const [catsTwoRepos] = s.categoriesRepresentedInAtLeastTwoRepos.split('/').map(Number)
  const reasons = []
  const confirmed = totalRepos >= 3 && okRepos === unitRepos &&
    (s.repoMedianInputReductionPct ?? -Infinity) >= 20 &&
    (s.repoMedianToolReductionPct ?? -Infinity) >= 20 &&
    (s.repoMedianSearchReductionPct ?? -Infinity) >= 30 &&
    s.repeatedCatastrophicPatterns.length === 0 && catsTwoRepos === BENCHMARK_CATEGORIES.length
  if (totalRepos < 3) reasons.push(`only ${totalRepos} distinct repositories completed (need >= 3)`)
  if (okRepos !== unitRepos) reasons.push(`${totalRepos - okRepos} repositories below 100% grounded correctness`)
  if ((s.repoMedianInputReductionPct ?? -Infinity) < 20) reasons.push('repo-median input reduction < 20%')
  if ((s.repoMedianToolReductionPct ?? -Infinity) < 20) reasons.push('repo-median tool-call reduction < 20%')
  if ((s.repoMedianSearchReductionPct ?? -Infinity) < 30) reasons.push('repo-median search reduction < 30%')
  if (s.repeatedCatastrophicPatterns.length) reasons.push('repeated catastrophic regression pattern across repositories')
  if (catsTwoRepos !== BENCHMARK_CATEGORIES.length) reasons.push('not every category is represented in >= 2 repositories')
  if (confirmed) return { decision: 'GENERALIZATION CONFIRMED', reasons: [] }
  const correctnessFailures = unitRepos - okRepos
  const consistentlyWorse = (s.repoMedianInputReductionPct ?? 0) < 0 && (s.repoMedianToolReductionPct ?? 0) < 0
  if (correctnessFailures >= 2 || consistentlyWorse) return { decision: 'GENERALIZATION NOT CONFIRMED', reasons }
  return { decision: 'PARTIAL GENERALIZATION', reasons }
}

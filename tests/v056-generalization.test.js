import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  campaignFromReport, crossRepositoryReport, taskStats, winLossDistribution, catastrophicRegressions,
  coefficientOfVariation, classifyChange, comparabilityWarnings, suggestedDecision, METHODOLOGY, loadCampaign
} from '../src/benchmark/generalization.js'
import { benchmarkReport } from '../src/benchmark/report.js'
import { compareCampaigns, generalizationHtml } from '../src/benchmark/generalization-report.js'
import { latencyDecomposition, runtimeFingerprint } from '../src/benchmark/campaign.js'
import { lintTaskSet } from '../src/benchmark/tasklint.js'
import { embeddedSourceBytes, percentile } from '../src/benchmark/latency.js'

const ok = { discoverySuccess: true, sourceGrounded: true, answerSuccess: true, success: true }
function pair(taskId, category, repetition, b, s) {
  return { taskId, category, repetition,
    baseline: { toolCalls: 10, searchCalls: 4, filesOpened: 4, sourceBytesRead: 1000, expectedSourceBytes: 500, nonExpectedSourceBytes: 500, ...ok, ...b },
    stellar: { toolCalls: 5, searchCalls: 1, filesOpened: 2, sourceBytesRead: 400, expectedSourceBytes: 300, nonExpectedSourceBytes: 100, ...ok, ...s } }
}
function fakeReport({ repository, agent = 'claude', tasks, repeat = 1, base = 1000, stellar = 600, category = i => ['navigation', 'flow', 'impact', 'editing-prep'][i % 4], meta = {} }) {
  const pairs = []
  for (let i = 0; i < tasks; i++) for (let r = 1; r <= repeat; r++) pairs.push(pair(`${repository}-t${i}`, category(i), r, { inputTokens: base }, { inputTokens: stellar }))
  return { schemaVersion: 5, campaign: { repository, agent, agentVersion: '1.0', model: null, runtimeCommit: 'abc', repoCommit: `${repository}-commit`, taskHash: `${repository}-hash`, campaignStartedAt: '2026-11-04T00:00:00Z', ...meta }, pairs,
    coverage: { baselineRuns: pairs.length, stellarRuns: pairs.length, pairedAvailableRuns: pairs.length, pairedRuns: pairs.length, excludedFailedPairs: 0, unpairedBaseline: 0, unpairedStellar: 0 } }
}
const load = report => campaignFromReport(report)

test('v0.5.6 cross-repo: run-weighted differs from repo-weighted when task counts differ', () => {
  // big repo: 20 tasks, 10% reduction; two small repos: 2 tasks, 60% reduction.
  const r = crossRepositoryReport([
    load(fakeReport({ repository: 'big', tasks: 20, base: 1000, stellar: 900 })),
    load(fakeReport({ repository: 'small-a', tasks: 2, base: 1000, stellar: 400 })),
    load(fakeReport({ repository: 'small-b', tasks: 2, base: 1000, stellar: 400 }))
  ])
  const run = r.byAgent.claude.runWeighted.inputTokenReductionPct
  const repo = r.byAgent.claude.repoWeighted.inputTokenReductionPct
  assert.ok(Math.abs(run - (1 - (20 * 900 + 4 * 400) / (24 * 1000)) * 100) < 1e-9)
  assert.equal(repo.median, 60)
  assert.ok(Math.abs(repo.mean - (10 + 60 + 60) / 3) < 1e-9)
  assert.notEqual(Math.round(run), Math.round(repo.median))
  assert.equal(r.byAgent.claude.repoWeighted.units, 3)
  assert.deepEqual(r.repositories.map(x => x.repository), ['big', 'small-a', 'small-b'])
})

test('v0.5.6 category aggregation spans repositories and keeps n/a categories null', () => {
  const r = crossRepositoryReport([
    load(fakeReport({ repository: 'a', tasks: 4 })),
    load(fakeReport({ repository: 'b', tasks: 2, category: i => ['flow', 'impact'][i] }))
  ])
  assert.equal(r.byCategory.flow.repoCount, 2)
  assert.equal(r.byCategory.flow.taskCount, 2)
  assert.equal(r.byCategory.navigation.repoCount, 1)
  assert.equal(r.byCategory['editing-prep'].taskCount, 1)
  assert.equal(r.byCategory.flow.runWeighted.inputTokenReductionPct, 40)
  const empty = crossRepositoryReport([load(fakeReport({ repository: 'c', tasks: 1, category: () => 'flow' }))])
  assert.equal(empty.byCategory.impact.status, 'n/a')
  assert.equal(empty.byCategory.impact.repoWeighted.inputTokenReductionPct.median, null)
  assert.equal(r.byAgent.claude.scorecard.categoriesRepresentedInAtLeastTwoRepos, '2/4')
})

test('v0.5.6 agents never contaminate each other', () => {
  const r = crossRepositoryReport([
    load(fakeReport({ repository: 'a', agent: 'claude', tasks: 4, stellar: 500 })),
    load(fakeReport({ repository: 'a', agent: 'codex', tasks: 4, stellar: 1200 }))
  ])
  assert.equal(r.byAgent.claude.runWeighted.inputTokenReductionPct, 50)
  assert.equal(r.byAgent.codex.runWeighted.inputTokenReductionPct, -20)
  assert.equal(r.byRepository.a.claude.pairedRuns, 4)
  assert.equal(r.byRepository.a.codex.pairedRuns, 4)
  assert.equal(r.byAgent.claude.winLoss.inputTokens.losses, 0)
  assert.equal(r.byAgent.codex.winLoss.inputTokens.losses, 4)
  assert.equal(r.crossAgentConsistency.status, 'measured')
  assert.equal(r.crossAgentConsistency.inputTokenReductionPct.repositoriesAllAgentsPositive, '0/1')
  assert.equal(crossRepositoryReport([load(fakeReport({ repository: 'a', tasks: 1 }))]).crossAgentConsistency.status, 'n/a')
})

test('v0.5.6 coverage gaps never enter performance aggregates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-gap-'))
  try {
    const row = (mode, taskId, inputTokens, exitCode = 0) => JSON.stringify({ taskId, repetition: 1, category: 'flow', categorySource: 'explicit', mode, agent: 'claude', exitCode, inputTokens, toolCalls: 1, searchCalls: 0, sourceBytesRead: 10, verified: true, success: true })
    await fs.writeFile(path.join(dir, 'baseline.jsonl'), [row('baseline', 'ok', 1000), row('baseline', 'gap', 1000), row('baseline', 'unpaired', 1000)].join('\n') + '\n')
    // Stellar side of "gap" failed (quota); its baseline must not be compared against anything.
    await fs.writeFile(path.join(dir, 'stellar.jsonl'), [row('stellar', 'ok', 500), row('stellar', 'gap', 1, 1)].join('\n') + '\n')
    const report = await benchmarkReport(path.join(dir, 'baseline.jsonl'), path.join(dir, 'stellar.jsonl'))
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report))
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 3, agent: 'claude', projectRoot: '/x/repo', projectCommit: 'c', runtime: { commit: 'r', dirty: false } }))
    const r = await compareCampaigns([`repo=${path.join(dir, 'report.json')}`])
    assert.equal(r.overall.runWeighted.pairedRuns, 1)
    assert.equal(r.overall.runWeighted.inputTokenReductionPct, 50)
    assert.equal(r.coverage.excludedFailedPairs, 1)
    assert.equal(r.coverage.unpairedBaseline, 1)
    assert.equal(r.coverage.coverageGaps, 2)
    assert.deepEqual(r.taskStats.map(t => t.taskId), ['ok'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('v0.5.6 catastrophic regressions are listed even when the aggregate looks good', () => {
  const report = fakeReport({ repository: 'a', tasks: 9, stellar: 300 })
  report.pairs.push(pair('bad-input', 'flow', 1, { inputTokens: 100 }, { inputTokens: 140 }))
  report.pairs.push(pair('bad-tools', 'impact', 1, { inputTokens: 100, toolCalls: 3 }, { inputTokens: 90, toolCalls: 7 }))
  report.pairs.push(pair('edge-input', 'flow', 1, { inputTokens: 100 }, { inputTokens: 125 }))
  const r = crossRepositoryReport([load(report)])
  assert.ok(r.byAgent.claude.runWeighted.inputTokenReductionPct > 50)
  const list = r.catastrophicRegressionTasks
  assert.deepEqual(list.map(c => `${c.taskId}:${c.metric}`).sort(), ['bad-input:inputTokens', 'bad-tools:toolCalls'])
  const bad = list.find(c => c.taskId === 'bad-input')
  assert.equal(bad.baselineMedian, 100); assert.equal(bad.stellarMedian, 140); assert.ok(Math.abs(bad.deltaPct - 40) < 1e-9)
  assert.equal(bad.stellarGroundedSuccessRate, 100)
})

test('v0.5.6 repeated catastrophic pattern needs the same category and metric in two repositories', () => {
  const mk = repo => { const r = fakeReport({ repository: repo, tasks: 1 }); r.pairs.push(pair(`${repo}-x`, 'impact', 1, { inputTokens: 100 }, { inputTokens: 200 })); return load(r) }
  const r = crossRepositoryReport([mk('a'), mk('b')])
  assert.equal(r.byAgent.claude.scorecard.repeatedCatastrophicPatterns.length, 1)
  assert.deepEqual(r.byAgent.claude.scorecard.repeatedCatastrophicPatterns[0].repositories, ['a', 'b'])
})

test('v0.5.6 win/neutral/loss uses a fixed ±5% neutral band', () => {
  assert.equal(METHODOLOGY.neutralThresholdPct, 5)
  assert.equal(classifyChange(5), 'win'); assert.equal(classifyChange(4.99), 'neutral')
  assert.equal(classifyChange(-4.99), 'neutral'); assert.equal(classifyChange(-5), 'loss'); assert.equal(classifyChange(null), 'n/a')
  const pairs = [[100, 80], [100, 97], [100, 103], [100, 120], [0, 3]].map(([b, s], i) => ({ repository: 'r', agent: 'a', taskId: `t${i}`, category: 'flow', repetition: 1, baseline: { inputTokens: b, toolCalls: b, searchCalls: null, sourceBytesRead: b }, stellar: { inputTokens: s, toolCalls: s, searchCalls: null, sourceBytesRead: s } }))
  const wl = winLossDistribution(taskStats(pairs))
  assert.deepEqual(wl.inputTokens, { wins: 1, neutral: 2, losses: 2, notApplicable: 0, tasks: 5 })
  assert.equal(wl.searchCalls.notApplicable, 5)
})

test('v0.5.6 determinism coefficient of variation', () => {
  assert.equal(coefficientOfVariation([100, 100, 100]), 0)
  const high = coefficientOfVariation([50, 100, 150])
  assert.ok(Math.abs(high - Math.sqrt(5000 / 3) / 100) < 1e-12)
  assert.ok(high > 0.4)
  assert.equal(coefficientOfVariation([100]), null)
  const pairs = [100, 100, 100].map((v, i) => ({ repository: 'r', agent: 'a', taskId: 't', category: 'flow', repetition: i + 1, baseline: { inputTokens: [50, 100, 150][i] }, stellar: { inputTokens: v } }))
  const [stat] = taskStats(pairs)
  assert.equal(stat.determinism.inputTokens.stellarCv, 0)
  assert.ok(stat.determinism.inputTokens.baselineCv > 0.4)
})

test('v0.5.6 reads v4 reports; fields absent from v4 are n/a, never zero', async () => {
  const v4 = { schemaVersion: 4, coverage: { pairedRuns: 1 }, pairs: [{ key: 't#1', taskId: 't', repetition: 1, category: 'navigation', baseline: { inputTokens: 1000, toolCalls: 4, searchCalls: 2, filesOpened: 2, firstRelevantMs: 5000, ...ok }, stellar: { inputTokens: 500, toolCalls: 2, searchCalls: 0, filesOpened: 1, firstRelevantMs: 4000, ...ok, expectedSourceBytes: 10, nonExpectedSourceBytes: 0 } }] }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-v4-'))
  try {
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(v4))
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, agent: 'claude', agentVersion: '2.1', projectRoot: '/x/reefmori', projectCommit: 'c1', createdAt: '2026-11-03T00:00:00Z', repeat: 1 }))
    const loaded = await loadCampaign(path.join(dir, 'report.json'), { rebuild: benchmarkReport })
    assert.equal(loaded.campaign.repository, 'reefmori')
    assert.equal(loaded.campaign.sourceSchemaVersion, 4)
    assert.equal(loaded.campaign.upgradedFromJsonl, false)
    assert.equal(loaded.campaign.runtimeCommit, null)
    const r = crossRepositoryReport([loaded])
    assert.equal(r.byAgent.claude.runWeighted.inputTokenReductionPct, 50)
    assert.equal(r.byAgent.claude.runWeighted.sourceBytesReductionPct, null)
    assert.equal(r.taskStats[0].sourceBytesRead.reductionPct, null)
    assert.equal(r.byAgent.claude.runWeighted.precision.baseline, null)
    assert.equal(r.byAgent.claude.winLoss.sourceBytes.notApplicable, 1)
    assert.ok(r.comparabilityWarnings.some(w => w.field === 'runtimeCommit' && /do not record/.test(w.message)))
    assert.match(generalizationHtml(r), /n\/a/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('v0.5.6 comparability warnings flag agent, model, runtime and holdout mismatches', () => {
  const base = { repository: 'a', agent: 'claude', agentVersion: '1', model: 'm', runtimeCommit: 'r1', repoCommit: 'c', taskHash: 'h', campaignStartedAt: 't1' }
  const fields = list => comparabilityWarnings(list).map(w => w.field)
  assert.deepEqual(fields([base, { ...base, repository: 'b', repoCommit: 'd', taskHash: 'i' }]), [])
  const w = fields([base, { ...base, agentVersion: '2', model: 'n', runtimeCommit: 'r2', taskHash: 'other', campaignStartedAt: 't2' }])
  for (const f of ['runtimeCommit', 'agentVersion', 'model', 'taskHash', 'campaignStartedAt']) assert.ok(w.includes(f), f)
})

test('v0.5.6 dirty or changed runtime invalidates a campaign and excludes it', () => {
  const dirty = load(fakeReport({ repository: 'a', tasks: 2, meta: { runtimeDirty: true } }))
  const changed = load(fakeReport({ repository: 'b', tasks: 2, meta: { runtimeChangedDuringCampaign: true } }))
  const clean = load(fakeReport({ repository: 'c', tasks: 2 }))
  assert.equal(dirty.campaign.valid, false); assert.equal(changed.campaign.valid, false)
  const r = crossRepositoryReport([dirty, changed, clean])
  assert.equal(r.invalidCampaigns.length, 2)
  assert.deepEqual(Object.keys(r.byRepository), ['c'])
})

test('v0.5.6 scorecard and mechanical decision follow the fixed rules', () => {
  const three = ['a', 'b', 'c'].map(repository => load(fakeReport({ repository, tasks: 4, stellar: 500 })))
  const r = crossRepositoryReport(three)
  const card = r.byAgent.claude.scorecard
  assert.equal(card.repositoriesMeetingCorrectnessTarget, '3/3')
  assert.equal(card.repositoriesMeetingInputTarget, '3/3')
  assert.equal(card.categoriesWithPositiveMedianInputReduction, '4/4')
  assert.equal(r.byAgent.claude.suggestedDecision.decision, 'GENERALIZATION CONFIRMED')
  assert.equal(r.byAgent.claude.agentScope, 'claude-only')
  const two = crossRepositoryReport(three.slice(0, 2))
  assert.equal(two.byAgent.claude.suggestedDecision.decision, 'PARTIAL GENERALIZATION')
  const failing = fakeReport({ repository: 'd', tasks: 4 }); failing.pairs[0].stellar.success = false
  const bad = fakeReport({ repository: 'e', tasks: 4 }); bad.pairs[0].stellar.answerSuccess = false
  const worse = crossRepositoryReport([three[0], load(failing), load(bad)])
  assert.equal(worse.byAgent.claude.scorecard.repositoriesMeetingCorrectnessTarget, '1/3')
  assert.equal(worse.byAgent.claude.suggestedDecision.decision, 'GENERALIZATION NOT CONFIRMED')
  assert.equal(suggestedDecision({ scorecard: { ...card, repoMedianInputReductionPct: -10, repoMedianToolReductionPct: -5 } }).decision, 'GENERALIZATION NOT CONFIRMED')
})

test('v0.5.6 latency decomposition attributes the first relevant source to its tool call', () => {
  const metrics = { timing: { firstEventMs: 700, firstModelEventMs: 3100 }, interactions: [
    { sequence: 1, kind: 'stellarContext', startedAtMs: 3200, completedAtMs: 4200, durationMs: 1000 },
    { sequence: 2, kind: 'nativeSourceRead', startedAtMs: 6000, completedAtMs: 6050, durationMs: 50 }] }
  const d = latencyDecomposition(metrics, 4201)
  assert.equal(d.agentStartToFirstToolMs, 3200)
  assert.equal(d.firstToolDurationMs, 1000)
  assert.equal(d.stellarContextDurationMs, 1000)
  assert.equal(d.firstRelevantToolSequence, 1)
  assert.equal(d.firstRelevantSourceCompletionMs, 4201)
  assert.equal(latencyDecomposition({}, null).agentStartToFirstToolMs, null)
})

test('v0.5.6 runtime fingerprint detects content changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-fp-'))
  try {
    await fs.mkdir(path.join(dir, 'src', 'query'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', 'query', 'a.js'), 'export const a = 1\n')
    await fs.writeFile(path.join(dir, 'package.json'), '{"version":"0.5.5"}')
    const a = await runtimeFingerprint(dir)
    assert.equal(a.packageVersion, '0.5.5'); assert.equal(a.commit, null); assert.equal(a.dirty, null)
    await fs.writeFile(path.join(dir, 'src', 'query', 'a.js'), 'export const a = 2\n')
    assert.notEqual((await runtimeFingerprint(dir)).contentHash, a.contentHash)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('v0.5.6 task-set lint catches filename leaks, missing files and thin flows', async () => {
  const { makeWorkspace } = await import('./helpers.js')
  const w = await makeWorkspace()
  try {
    const file = path.join(w.base, 'tasks.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, tasks: [
      { id: 'leak', category: 'navigation', prompt: 'Open AuthService.ts and explain login.', expectedFiles: ['src/auth/AuthService.ts'], expectedMatch: 'any' },
      { id: 'missing', category: 'impact', prompt: 'Which consumers need review?', expectedFiles: ['src/nope.ts'], expectedMatch: 'any' },
      { id: 'thin-flow', category: 'flow', prompt: 'Trace the login flow.', expectedFiles: ['src/auth/AuthService.ts'], expectedMatch: 'all' },
      { id: 'good', category: 'editing-prep', prompt: 'Before changing token persistence, what should be inspected?', expectedFiles: ['src/auth/AuthService.ts', 'src/auth/TokenStore.ts'], expectedMatch: 'all' }
    ] }))
    const result = await lintTaskSet(file, { repoRoot: w.repo })
    assert.equal(result.ok, false)
    const checks = result.errors.map(e => `${e.task}:${e.check}`)
    assert.ok(checks.includes('leak:leak')); assert.ok(checks.includes('missing:exists')); assert.ok(checks.includes('thin-flow:flow'))
    assert.ok(!checks.some(c => c.startsWith('good:')))
    assert.match(result.sha256, /^[0-9a-f]{64}$/)
    assert.equal(result.distribution.flow, 1)
  } finally { await w.cleanup() }
})

test('v0.5.6 latency helpers: percentile and embedded source bytes', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95), 19)
  assert.equal(percentile([], 50), null)
  assert.equal(embeddedSourceBytes({ targets: [{ path: 'a', source: 'abc' }], relatedEvidence: [{ source: 'é' }], hint: { source: 5 } }), 5)
})

test('v0.5.6 review fixes: identity, aborted campaigns, signal-killed runs, holdout conflicts, paired first-relevant', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-review-'))
  try {
    // Unlabelled report with no manifest cannot fall back to "unknown".
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({ schemaVersion: 4, pairs: [] }))
    await assert.rejects(() => loadCampaign(path.join(dir, 'report.json')), /cannot determine repository/)
    await assert.rejects(() => loadCampaign(`x=${path.join(dir, 'report.json')}`), /cannot determine agent/)
    // A labelled campaign with known agent but no manifest (aborted) loads but is excluded.
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(fakeReport({ repository: 'x', tasks: 1 })))
    const aborted = await loadCampaign(path.join(dir, 'report.json'))
    assert.equal(aborted.campaign.valid, false)
    assert.match(aborted.campaign.invalidReasons.join(), /no manifest/)
    // Signal-killed run (exitCode null) is a coverage gap, never performance evidence.
    const row = (mode, taskId, exitCode) => JSON.stringify({ taskId, repetition: 1, category: 'flow', mode, agent: 'claude', exitCode, inputTokens: mode === 'stellar' ? 10 : 1000, toolCalls: 1, searchCalls: 0, sourceBytesRead: 1, verified: true, success: true })
    await fs.writeFile(path.join(dir, 'baseline.jsonl'), row('baseline', 'a', 0) + '\n' + row('baseline', 'b', 0) + '\n')
    await fs.writeFile(path.join(dir, 'stellar.jsonl'), row('stellar', 'a', 0) + '\n' + row('stellar', 'b', null) + '\n')
    const report = await benchmarkReport(path.join(dir, 'baseline.jsonl'), path.join(dir, 'stellar.jsonl'))
    assert.equal(report.coverage.pairedRuns, 1)
    assert.equal(report.coverage.excludedFailedPairs, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }

  // Two labels with one root commit count once toward the repository gate.
  const id = rootCommits => ({ repositoryIdentity: { rootCommits } })
  const three = [['a', ['r1']], ['a-clone', ['r1']], ['b', ['r2']]].map(([repository, roots]) => load(fakeReport({ repository, tasks: 4, stellar: 500, meta: id(roots) })))
  const r = crossRepositoryReport(three)
  assert.equal(r.byAgent.claude.scorecard.distinctRepositoryIdentities, 2)
  assert.ok(r.comparabilityWarnings.some(w => w.field === 'repositoryIdentity'))
  assert.notEqual(r.byAgent.claude.suggestedDecision.decision, 'GENERALIZATION CONFIRMED')

  // Same repo + agent with a different task hash is excluded, not pooled.
  const c1 = load(fakeReport({ repository: 'a', tasks: 2 }))
  const c2 = load(fakeReport({ repository: 'a', tasks: 2, meta: { taskHash: 'other', campaignStartedAt: 't2' } }))
  const conflict = crossRepositoryReport([c1, c2])
  assert.equal(conflict.invalidCampaigns.length, 2)
  assert.equal(conflict.overall.runWeighted.pairedRuns, 0)

  // First-relevant reduction compares only pairs where both sides reached relevant source.
  const fr = fakeReport({ repository: 'a', tasks: 3 })
  fr.pairs[0].baseline.firstRelevantMs = 1000; fr.pairs[0].stellar.firstRelevantMs = 800
  fr.pairs[1].baseline.firstRelevantMs = 100000; fr.pairs[1].stellar.firstRelevantMs = null
  fr.pairs[2].baseline.firstRelevantMs = null; fr.pairs[2].stellar.firstRelevantMs = 5
  const frr = crossRepositoryReport([load(fr)]).overall.runWeighted
  assert.equal(frr.firstRelevantPairs, 1)
  assert.ok(Math.abs(frr.firstRelevantReductionPct - 20) < 1e-9)

  // Cross-agent: n/a on both agents is not "direction agrees".
  const na = fakeReport({ repository: 'a', agent: 'claude', tasks: 1 }); na.pairs[0].baseline.searchCalls = null
  const nb = fakeReport({ repository: 'a', agent: 'codex', tasks: 1 }); nb.pairs[0].baseline.searchCalls = null
  assert.equal(crossRepositoryReport([load(na), load(nb)]).crossAgentConsistency.searchCallReductionPct.repositoriesDirectionAgrees, '0/0')
})

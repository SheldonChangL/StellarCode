// v0.6 holdout report: baseline vs stellar-lexical vs stellar (semantic slice), per
// repository, paired by task and repetition inside one campaign. Repo median of the
// per-repository paired reductions is the primary aggregate (validation/v0.6/HOLDOUT_PLAN.md).
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJsonl } from './report.js'

export const SEMANTIC_CONDITIONS = ['baseline', 'stellar-lexical', 'stellar']
// Missing / not-applicable values stay out of aggregates: Number(null) is 0, so null,
// undefined and '' must be dropped before coercion or an unavailable metric reads as 0.
const finite = values => values.filter(v => v != null && v !== '').map(Number).filter(Number.isFinite)
export function median(values) {
  const sorted = finite(values).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const round = (value, digits = 2) => value == null || !Number.isFinite(value) ? null : Number(Number(value).toFixed(digits))
const rate = (rows, key) => rows.length ? round(rows.filter(row => row[key] === true).length / rows.length * 100) : null
const reduction = (mode, comparison) => comparison ? round((1 - mode / comparison) * 100) : null

function stats(rows) {
  const sum = field => rows.reduce((s, r) => s + Number(r[field] ?? 0), 0)
  const pce = rows.map(r => r.postContextExplorationTurns).filter(v => v != null)
  return {
    runs: rows.length,
    answerSuccess: rate(rows, 'answerSuccess'),
    groundedSuccess: rate(rows, 'success'),
    inputTokens: { median: median(rows.map(r => r.inputTokens)), total: sum('inputTokens') },
    modelTurns: { median: median(rows.map(r => r.modelTurns)), total: sum('modelTurns') },
    postContextExplorationTurns: { median: median(pce), mean: pce.length ? round(pce.reduce((a, b) => a + b, 0) / pce.length) : null, total: pce.reduce((a, b) => a + b, 0), measured: pce.length },
    searchCalls: { median: median(rows.map(r => r.searchCalls)), total: sum('searchCalls') },
    toolCalls: { median: median(rows.map(r => r.toolCalls)), total: sum('toolCalls') },
    sourceBytesRead: { median: median(rows.map(r => r.sourceBytesRead)), total: sum('sourceBytesRead') },
    contextSourceBytes: { median: median(rows.map(r => r.contextSourceBytes)) },
    semanticEdgesReturned: { median: median(rows.map(r => r.semanticEdgesReturned)) }
  }
}

const key = row => `${row.taskId}#${row.repetition}`

// 1 - sum(a)/sum(b) over runs present in both conditions (and, for a nullable metric,
// measured in both).
export function paired(aRows, bRows, field) {
  const b = new Map(bRows.map(row => [key(row), row]))
  const pairs = aRows.filter(row => b.has(key(row))).map(row => [row, b.get(key(row))]).filter(([x, y]) => x[field] != null && y[field] != null)
  const sa = pairs.reduce((s, [x]) => s + Number(x[field]), 0)
  const sb = pairs.reduce((s, [, y]) => s + Number(y[field]), 0)
  return { pairs: pairs.length, a: sa, b: sb, reductionPct: reduction(sa, sb) }
}

const METRICS = ['postContextExplorationTurns', 'inputTokens', 'searchCalls', 'toolCalls', 'sourceBytesRead', 'modelTurns']

function compare(a, b) {
  return Object.fromEntries(METRICS.map(metric => [metric, paired(a, b, metric)]))
}

// Task-level catastrophes for `stellar` vs `baseline`: task-median input > 25% worse,
// task-median tools > 2x, or a lower answer/grounded success rate.
export function catastrophes(stellarRows, baselineRows) {
  const byTask = rows => { const map = new Map(); for (const row of rows) { if (!map.has(row.taskId)) map.set(row.taskId, []); map.get(row.taskId).push(row) } return map }
  const s = byTask(stellarRows), b = byTask(baselineRows)
  const found = []
  for (const [taskId, list] of s) {
    const base = b.get(taskId)
    if (!base) continue
    const si = median(list.map(r => r.inputTokens)), bi = median(base.map(r => r.inputTokens))
    const st = median(list.map(r => r.toolCalls)), bt = median(base.map(r => r.toolCalls))
    const reasons = []
    if (bi && si > bi * 1.25) reasons.push(`input +${round((si / bi - 1) * 100)}%`)
    if (bt && st > bt * 2) reasons.push(`tools ${st} vs ${bt}`)
    if ((rate(list, 'answerSuccess') ?? 0) < (rate(base, 'answerSuccess') ?? 0)) reasons.push(`answer ${rate(list, 'answerSuccess')}% vs ${rate(base, 'answerSuccess')}%`)
    if ((rate(list, 'success') ?? 0) < (rate(base, 'success') ?? 0)) reasons.push(`grounded ${rate(list, 'success')}% vs ${rate(base, 'success')}%`)
    if (reasons.length) found.push({ taskId, category: list[0].category, reasons })
  }
  return found
}

async function loadCampaign(label, dir) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  const rows = {}
  for (const condition of SEMANTIC_CONDITIONS) {
    try { rows[condition] = await readJsonl(path.join(dir, `${condition}.jsonl`)) } catch { rows[condition] = [] }
  }
  return { label, dir, manifest, rows }
}

export async function semanticReport(specs) {
  const campaigns = []
  for (const spec of specs) {
    const eq = spec.indexOf('=')
    const label = eq > 0 ? spec.slice(0, eq) : path.basename(path.dirname(path.resolve(spec)))
    campaigns.push(await loadCampaign(label, path.resolve(eq > 0 ? spec.slice(eq + 1) : spec)))
  }
  const byRepository = {}
  for (const c of campaigns) {
    const r = c.rows
    byRepository[c.label] = {
      runtimeCommit: c.manifest.runtime?.commit ?? null,
      runtimeDirty: c.manifest.runtime?.dirty ?? null,
      changedDuringCampaign: c.manifest.runtime?.changedDuringCampaign ?? null,
      taskHash: c.manifest.taskHash ?? null,
      repoCommit: c.manifest.project?.commit ?? c.manifest.projectCommit ?? null,
      conditions: Object.fromEntries(SEMANTIC_CONDITIONS.map(condition => [condition, stats(r[condition])])),
      semanticVsLexical: compare(r.stellar, r['stellar-lexical']),
      semanticVsBaseline: compare(r.stellar, r.baseline),
      lexicalVsBaseline: compare(r['stellar-lexical'], r.baseline),
      correctnessGate: {
        answer: (stats(r.stellar).answerSuccess ?? 0) >= (stats(r.baseline).answerSuccess ?? 0),
        grounded: (stats(r.stellar).groundedSuccess ?? 0) >= (stats(r.baseline).groundedSuccess ?? 0)
      },
      catastrophes: catastrophes(r.stellar, r.baseline)
    }
  }
  const repoMedian = (comparison, metric) => median(Object.values(byRepository).map(repo => repo[comparison][metric].reductionPct))
  return {
    schemaVersion: 1,
    methodology: 'Paired by task and repetition within one campaign per repository; reduction = 1 - sum(a)/sum(b); repo median across repositories is primary.',
    repositories: Object.keys(byRepository),
    repoMedian: {
      semanticVsLexical: Object.fromEntries(METRICS.map(metric => [metric, repoMedian('semanticVsLexical', metric)])),
      semanticVsBaseline: Object.fromEntries(METRICS.map(metric => [metric, repoMedian('semanticVsBaseline', metric)])),
      lexicalVsBaseline: Object.fromEntries(METRICS.map(metric => [metric, repoMedian('lexicalVsBaseline', metric)]))
    },
    byRepository
  }
}

// Human-readable view: unavailable values (null internally) print as n/a, never 0.
export const formatValue = (value, suffix = '') => value == null || !Number.isFinite(Number(value)) ? 'n/a' : `${value}${suffix}`

export function formatSemanticReportMarkdown(report) {
  const lines = ['# Semantic report', '', '## Repo median reductions', '', `| Metric | ${['semanticVsLexical', 'semanticVsBaseline', 'lexicalVsBaseline'].join(' | ')} |`, '|---|---|---|---|']
  for (const metric of METRICS) lines.push(`| ${metric} | ${['semanticVsLexical', 'semanticVsBaseline', 'lexicalVsBaseline'].map(c => formatValue(report.repoMedian[c][metric], '%')).join(' | ')} |`)
  for (const [repo, data] of Object.entries(report.byRepository)) {
    lines.push('', `## ${repo}`, '', '| Metric | semantic vs lexical | semantic vs baseline | lexical vs baseline |', '|---|---|---|---|')
    for (const metric of METRICS) lines.push(`| ${metric} | ${['semanticVsLexical', 'semanticVsBaseline', 'lexicalVsBaseline'].map(c => `${formatValue(data[c][metric].reductionPct, '%')} (${data[c][metric].pairs} pairs)`).join(' | ')} |`)
  }
  return lines.join('\n') + '\n'
}

export async function writeSemanticReport(specs, { jsonFile, markdownFile } = {}) {
  const report = await semanticReport(specs)
  if (jsonFile) await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n')
  if (markdownFile) await fs.writeFile(markdownFile, formatSemanticReportMarkdown(report))
  return report
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { loadCampaign, crossRepositoryReport } from './generalization.js'
import { benchmarkReport } from './report.js'

export async function compareCampaigns(specs) {
  if (!specs.length) throw new Error('compare needs at least one report.json')
  const loaded = []
  for (const spec of specs) loaded.push(await loadCampaign(spec, { rebuild: benchmarkReport }))
  return crossRepositoryReport(loaded)
}

export async function writeComparison(specs, { jsonFile, htmlFile } = {}) {
  const report = await compareCampaigns(specs)
  if (jsonFile) { await fs.mkdir(path.dirname(path.resolve(jsonFile)), { recursive: true }); await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n') }
  if (htmlFile) { await fs.mkdir(path.dirname(path.resolve(htmlFile)), { recursive: true }); await fs.writeFile(htmlFile, generalizationHtml(report)) }
  return report
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = v => v == null ? 'n/a' : `${Number(v).toFixed(1)}%`
const share = v => v == null ? 'n/a' : `${(Number(v) * 100).toFixed(1)}%`
const cls = v => v == null ? '' : v >= 0 ? 'good' : 'bad'
const cell = v => `<td class="${cls(v)}">${pct(v)}</td>`

export function generalizationHtml(r) {
  const repoRows = Object.entries(r.byRepository).flatMap(([repo, agents]) => Object.entries(agents).map(([agent, u]) =>
    `<tr><td>${esc(repo)}</td><td>${esc(agent)}</td><td>${u.pairedRuns}</td><td>${u.tasks}</td><td>${pct(u.correctness.groundedSuccessRate.stellar)}</td>${cell(u.inputTokenReductionPct)}${cell(u.toolCallReductionPct)}${cell(u.searchCallReductionPct)}${cell(u.sourceBytesReductionPct)}${cell(u.filesOpenedReductionPct)}${cell(u.firstRelevantReductionPct)}<td>${share(u.precision.baseline)} → ${share(u.precision.stellar)}</td></tr>`)).join('')
  const agentBlocks = Object.entries(r.byAgent).map(([agent, a]) => {
    const rw = a.runWeighted, pw = a.repoWeighted
    const catRows = Object.entries(a.byCategory).map(([c, v]) => `<tr><td>${esc(c)}</td><td>${v.repoCount}</td><td>${v.taskCount}</td><td>${v.pairedRunCount}</td><td>${pct(v.runWeighted.correctness?.groundedSuccessRate?.stellar)}</td>${cell(v.repoWeighted.inputTokenReductionPct.median)}${cell(v.repoWeighted.toolCallReductionPct.median)}${cell(v.repoWeighted.searchCallReductionPct.median)}${cell(v.repoWeighted.sourceBytesReductionPct.median)}<td>${share(v.runWeighted.precision?.baseline)} → ${share(v.runWeighted.precision?.stellar)}</td></tr>`).join('')
    const wl = Object.entries(a.winLoss).map(([m, v]) => `<tr><td>${esc(m)}</td><td class="good">${v.wins}</td><td>${v.neutral}</td><td class="bad">${v.losses}</td><td>${v.notApplicable}</td></tr>`).join('')
    const cat = a.catastrophicRegressionTasks.map(c => `<tr><td>${esc(c.repository)}</td><td>${esc(c.taskId)}</td><td>${esc(c.category)}</td><td>${esc(c.metric)}</td><td>${c.baselineMedian}</td><td>${c.stellarMedian}</td><td class="bad">+${pct(c.deltaPct)}</td><td>${pct(c.stellarGroundedSuccessRate)}</td></tr>`).join('') || '<tr><td colspan="8">none</td></tr>'
    const det = ['inputTokens', 'toolCalls', 'sourceBytesRead'].map(m => `<tr><td>${m}</td><td>${a.determinism[m].tasksWithRepetitions}</td><td>${a.determinism[m].baselineMedianCv?.toFixed(3) ?? 'n/a'}</td><td>${a.determinism[m].stellarMedianCv?.toFixed(3) ?? 'n/a'}</td><td>${a.determinism[m].tasksWhereStellarLessVariable}</td></tr>`).join('')
    const card = Object.entries(a.scorecard).filter(([k]) => k !== 'repeatedCatastrophicPatterns').map(([k, v]) => `<tr><td>${esc(k)}</td><td>${typeof v === 'number' ? pct(v) : esc(v)}</td></tr>`).join('')
    return `<section class="card"><h2>${esc(agent)} <small class="muted">${esc(a.agentScope)}</small></h2>
<p><b>Mechanical decision:</b> ${esc(a.suggestedDecision.decision)} ${a.suggestedDecision.reasons.length ? `<span class="muted">(${esc(a.suggestedDecision.reasons.join('; '))})</span>` : ''}</p>
<table><thead><tr><th>Aggregate</th><th>Input</th><th>Tools</th><th>Search</th><th>Source bytes</th><th>Files opened</th><th>First relevant</th></tr></thead><tbody>
<tr><td>Run-weighted (${rw.pairedRuns} pairs)</td>${cell(rw.inputTokenReductionPct)}${cell(rw.toolCallReductionPct)}${cell(rw.searchCallReductionPct)}${cell(rw.sourceBytesReductionPct)}${cell(rw.filesOpenedReductionPct)}${cell(rw.firstRelevantReductionPct)}</tr>
<tr><td>Repo-weighted mean (${pw.units} repos)</td>${cell(pw.inputTokenReductionPct.mean)}${cell(pw.toolCallReductionPct.mean)}${cell(pw.searchCallReductionPct.mean)}${cell(pw.sourceBytesReductionPct.mean)}${cell(pw.filesOpenedReductionPct.mean)}${cell(pw.firstRelevantReductionPct.mean)}</tr>
<tr><td><b>Repo median</b></td>${cell(pw.inputTokenReductionPct.median)}${cell(pw.toolCallReductionPct.median)}${cell(pw.searchCallReductionPct.median)}${cell(pw.sourceBytesReductionPct.median)}${cell(pw.filesOpenedReductionPct.median)}${cell(pw.firstRelevantReductionPct.median)}</tr></tbody></table>
<h3>Scorecard</h3><table><tbody>${card}</tbody></table>
<h3>By category (repo median reductions)</h3><table><thead><tr><th>Category</th><th>Repos</th><th>Tasks</th><th>Pairs</th><th>Grounded success</th><th>Input</th><th>Tools</th><th>Search</th><th>Bytes</th><th>Precision</th></tr></thead><tbody>${catRows}</tbody></table>
<h3>Task win / neutral / loss (±${r.methodology.neutralThresholdPct}% neutral)</h3><table><thead><tr><th>Metric</th><th>Wins</th><th>Neutral</th><th>Losses</th><th>n/a</th></tr></thead><tbody>${wl}</tbody></table>
<h3>Catastrophic regressions</h3><table><thead><tr><th>Repo</th><th>Task</th><th>Category</th><th>Metric</th><th>Baseline median</th><th>Stellar median</th><th>Delta</th><th>Stellar grounded</th></tr></thead><tbody>${cat}</tbody></table>
<h3>Determinism (median per-task CV)</h3><table><thead><tr><th>Metric</th><th>Tasks</th><th>Baseline CV</th><th>Stellar CV</th><th>Tasks Stellar less variable</th></tr></thead><tbody>${det}</tbody></table></section>`
  }).join('')
  const warnings = r.comparabilityWarnings.map(w => `<li><b>${esc(w.field)}</b>${w.repository ? ` (${esc(w.repository)})` : ''}${w.agent ? ` (${esc(w.agent)})` : ''}: ${esc(w.message)}</li>`).join('') || '<li>none</li>'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StellarCode Generalization</title><style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b1020;color:#e8edf7;margin:0;padding:24px}.wrap{max-width:1180px;margin:auto}.card{background:#121a2c;border:1px solid #25314a;border-radius:14px;padding:20px;margin-bottom:16px;overflow-x:auto}.good{color:#7ee787}.bad{color:#ff7b72}.muted{color:#9ba7bd}table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px}th,td{padding:7px;border-bottom:1px solid #25314a;text-align:left}</style></head><body><div class="wrap">
<section class="card"><h1>StellarCode cross-repository generalization</h1><p class="muted">Generated ${esc(r.generatedAt)} · method v${r.methodVersion} · ${r.repositories.length} repositories · ${Object.keys(r.byAgent).length} agent(s)</p><p class="muted">${esc(r.notes.providerDrift)}</p><p class="muted">${esc(r.notes.weighting)}</p></section>
<section class="card"><h2>Repository matrix</h2><table><thead><tr><th>Repository</th><th>Agent</th><th>Pairs</th><th>Tasks</th><th>Stellar grounded</th><th>Input</th><th>Tools</th><th>Search</th><th>Bytes</th><th>Files</th><th>First relevant</th><th>Precision</th></tr></thead><tbody>${repoRows}</tbody></table></section>
${agentBlocks}
<section class="card"><h2>Coverage</h2><pre>${esc(JSON.stringify(r.coverage, null, 2))}</pre><h2>Comparability warnings</h2><ul>${warnings}</ul>${r.invalidCampaigns.length ? `<h2 class="bad">Invalid campaigns (excluded)</h2><pre>${esc(JSON.stringify(r.invalidCampaigns, null, 2))}</pre>` : ''}</section>
</div></body></html>`
}

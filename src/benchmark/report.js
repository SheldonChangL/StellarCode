import fs from 'node:fs/promises'
import path from 'node:path'

export async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${file}:${i + 1}: ${error.message}`) }
  })
}

function mean(values) { const v=values.filter(Number.isFinite);return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0 }
function sum(values) { return values.filter(Number.isFinite).reduce((a,b)=>a+b,0) }
function median(values) { const v=values.filter(Number.isFinite);if(!v.length)return null;const s=[...v].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2 }
function pctReduction(base, next) { return base === 0 ? 0 : ((base - next) / base) * 100 }
function ratio(success, verified) { return verified ? success/verified*100 : null }
function n(v){return Number(v??0)}

function normalizeRow(row) {
  return {
    ...row,
    inputTokens:n(row.inputTokens ?? row.discoveryTokens),
    outputTokens:n(row.outputTokens),
    toolCalls:n(row.toolCalls ?? row.discoveryToolCalls),
    searchCalls:n(row.searchCalls),
    filesOpened:n(Array.isArray(row.filesOpened)?row.filesOpened.length:row.filesOpened),
    sourceBytesRead:n(row.sourceBytesRead),
    firstRelevantMs: row.firstRelevantMs == null ? (row.durationToRelevantMs == null ? null : n(row.durationToRelevantMs)) : n(row.firstRelevantMs),
    verified: row.verified ?? (row.success != null),
    success: row.success == null ? null : Boolean(row.success),
    discoveryVerified: row.discoveryVerified ?? (row.discoverySuccess != null),
    discoverySuccess: row.discoverySuccess == null ? null : Boolean(row.discoverySuccess),
    sourceGroundingVerified: row.sourceGroundingVerified ?? (row.sourceGrounded != null),
    sourceGrounded: row.sourceGrounded == null ? null : Boolean(row.sourceGrounded),
    answerVerified: row.answerVerified ?? (row.answerSuccess != null) ?? (row.success != null),
    answerSuccess: row.answerSuccess == null ? (row.success == null ? null : Boolean(row.success)) : Boolean(row.answerSuccess)
  }
}

function aggregate(rows) {
  const normalized=rows.map(normalizeRow)
  const verifiedRows=normalized.filter(r=>r.verified && r.success!=null)
  const discoveryRows=normalized.filter(r=>r.discoveryVerified && r.discoverySuccess!=null)
  const groundingRows=normalized.filter(r=>r.sourceGroundingVerified && r.sourceGrounded!=null)
  const answerRows=normalized.filter(r=>r.answerVerified && r.answerSuccess!=null)
  const navigation=normalized.filter(r=>r.category==='navigation' || !r.category)
  return {
    runs: normalized.length,
    verifiedRuns: verifiedRows.length,
    successRate: ratio(verifiedRows.filter(r=>r.success).length,verifiedRows.length),
    discoveryRate: ratio(discoveryRows.filter(r=>r.discoverySuccess).length,discoveryRows.length),
    sourceGroundingRate: ratio(groundingRows.filter(r=>r.sourceGrounded).length,groundingRows.length),
    answerSuccessRate: ratio(answerRows.filter(r=>r.answerSuccess).length,answerRows.length),
    totalInputTokens: sum(normalized.map(r=>r.inputTokens)),
    avgInputTokens: mean(normalized.map(r=>r.inputTokens)),
    totalOutputTokens: sum(normalized.map(r=>r.outputTokens)),
    avgOutputTokens: mean(normalized.map(r=>r.outputTokens)),
    totalToolCalls: sum(normalized.map(r=>r.toolCalls)),
    avgToolCalls: mean(normalized.map(r=>r.toolCalls)),
    totalSearchCalls: sum(normalized.map(r=>r.searchCalls)),
    avgSearchCalls: mean(normalized.map(r=>r.searchCalls)),
    totalFilesOpened: sum(normalized.map(r=>r.filesOpened)),
    avgFilesOpened: mean(normalized.map(r=>r.filesOpened)),
    totalSourceBytesRead: sum(normalized.map(r=>r.sourceBytesRead)),
    medianFirstRelevantMs: median(normalized.map(r=>r.firstRelevantMs).filter(v=>v!=null)),
    totalCostUsd: sum(normalized.map(r=>r.costUsd==null?0:Number(r.costUsd))),
    navigationInputTokens: sum(navigation.map(r=>r.inputTokens)),
    navigationRuns: navigation.length
  }
}

function pairRows(baselineRows, stellarRows) {
  const key=r=>`${r.taskId}#${r.repetition??1}`
  const base=new Map(baselineRows.map(r=>[key(r),normalizeRow(r)]))
  const stellar=new Map(stellarRows.map(r=>[key(r),normalizeRow(r)]))
  const keys=[...base.keys()].filter(k=>stellar.has(k)).sort()
  return keys.map(k=>({key:k,baseline:base.get(k),stellar:stellar.get(k)}))
}

export async function benchmarkReport(baselineFile, stellarFile) {
  const baselineRows=await readJsonl(baselineFile), stellarRows=await readJsonl(stellarFile)
  const baseline = aggregate(baselineRows)
  const stellar = aggregate(stellarRows)
  const paired=pairRows(baselineRows,stellarRows)
  const delta = {
    inputTokenReductionPct: pctReduction(baseline.avgInputTokens, stellar.avgInputTokens),
    navigationInputTokenReductionPct: pctReduction(baseline.navigationInputTokens/Math.max(1,baseline.navigationRuns), stellar.navigationInputTokens/Math.max(1,stellar.navigationRuns)),
    toolCallReductionPct: pctReduction(baseline.avgToolCalls, stellar.avgToolCalls),
    searchCallReductionPct: pctReduction(baseline.avgSearchCalls, stellar.avgSearchCalls),
    filesOpenedReductionPct: pctReduction(baseline.avgFilesOpened, stellar.avgFilesOpened),
    sourceBytesReductionPct: pctReduction(baseline.totalSourceBytesRead/Math.max(1,baseline.runs), stellar.totalSourceBytesRead/Math.max(1,stellar.runs)),
    firstRelevantReductionPct: baseline.medianFirstRelevantMs==null||stellar.medianFirstRelevantMs==null?null:pctReduction(baseline.medianFirstRelevantMs, stellar.medianFirstRelevantMs),
    discoveryRateDeltaPoints: baseline.discoveryRate==null||stellar.discoveryRate==null?null:stellar.discoveryRate-baseline.discoveryRate,
    sourceGroundingRateDeltaPoints: baseline.sourceGroundingRate==null||stellar.sourceGroundingRate==null?null:stellar.sourceGroundingRate-baseline.sourceGroundingRate,
    answerSuccessRateDeltaPoints: baseline.answerSuccessRate==null||stellar.answerSuccessRate==null?null:stellar.answerSuccessRate-baseline.answerSuccessRate,
    successRateDeltaPoints: baseline.successRate==null||stellar.successRate==null?null:stellar.successRate-baseline.successRate
  }
  const correctnessVerified=baseline.verifiedRuns===baseline.runs && stellar.verifiedRuns===stellar.runs && baseline.runs>0 && stellar.runs>0
  const acceptance = {
    overallInputTokens: delta.inputTokenReductionPct >= 20,
    navigationInputTokens: delta.navigationInputTokenReductionPct >= 50,
    toolCalls: delta.toolCallReductionPct >= 40,
    firstRelevantTime: delta.firstRelevantReductionPct != null && delta.firstRelevantReductionPct >= 40,
    sourceGrounding: correctnessVerified && stellar.sourceGroundingRate != null && stellar.sourceGroundingRate >= 95,
    answerCorrectness: correctnessVerified && delta.answerSuccessRateDeltaPoints != null && delta.answerSuccessRateDeltaPoints >= -5,
    groundedSuccessRate: correctnessVerified && delta.successRateDeltaPoints >= -5
  }
  const correctnessGate={
    baselineGroundedSuccess:correctnessVerified && baseline.successRate===100 && baseline.sourceGroundingRate===100 && baseline.answerSuccessRate===100,
    stellarGroundedSuccess:correctnessVerified && stellar.successRate===100,
    stellarDiscovery:correctnessVerified && stellar.discoveryRate===100,
    stellarSourceGrounding:correctnessVerified && stellar.sourceGroundingRate===100,
    stellarAnswerCorrectness:correctnessVerified && stellar.answerSuccessRate===100
  }
  return {
    schemaVersion:3,
    baselineFile:path.resolve(baselineFile),stellarFile:path.resolve(stellarFile),
    baseline,stellar,delta,correctnessVerified,acceptance,correctnessGate,
    passGate:Object.values(correctnessGate).every(Boolean),
    mvpThresholdsMet:Object.values(acceptance).every(Boolean),
    pairs:paired.map(({key,baseline:b,stellar:s})=>({key,taskId:b.taskId,repetition:b.repetition??1,baseline:{inputTokens:b.inputTokens,toolCalls:b.toolCalls,searchCalls:b.searchCalls,filesOpened:b.filesOpened,firstRelevantMs:b.firstRelevantMs,discoverySuccess:b.discoverySuccess,sourceGrounded:b.sourceGrounded,answerSuccess:b.answerSuccess,success:b.success},stellar:{inputTokens:s.inputTokens,toolCalls:s.toolCalls,searchCalls:s.searchCalls,filesOpened:s.filesOpened,firstRelevantMs:s.firstRelevantMs,discoverySuccess:s.discoverySuccess,sourceGrounded:s.sourceGrounded,answerSuccess:s.answerSuccess,success:s.success},inputTokenReductionPct:pctReduction(b.inputTokens,s.inputTokens)}))
  }
}

function fmt(v,digits=1){return v==null?'n/a':Number(v).toLocaleString(undefined,{maximumFractionDigits:digits})}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function deltaClass(v){return v>=0?'good':'bad'}

export function benchmarkReportHtml(report) {
  const mark=v=>v==null?'?':v?'✓':'✕'
  const rows=report.pairs.map(p=>`<tr><td>${esc(p.taskId)}</td><td>${p.repetition}</td><td>${fmt(p.baseline.inputTokens,0)}</td><td>${fmt(p.stellar.inputTokens,0)}</td><td class="${deltaClass(p.inputTokenReductionPct)}">${fmt(p.inputTokenReductionPct)}%</td><td>${fmt(p.baseline.toolCalls,0)} → ${fmt(p.stellar.toolCalls,0)}</td><td>${mark(p.stellar.discoverySuccess)}</td><td>${mark(p.stellar.sourceGrounded)}</td><td>${mark(p.stellar.answerSuccess)}</td><td>${mark(p.stellar.success)}</td></tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StellarCode Token Benchmark</title><style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b1020;color:#e8edf7;margin:0;padding:32px}.wrap{max-width:1180px;margin:auto}.hero,.card{background:#121a2c;border:1px solid #25314a;border-radius:16px;padding:22px;margin-bottom:18px}.hero h1{margin:0 0 8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.metric{background:#0d1526;border:1px solid #25314a;border-radius:12px;padding:16px}.metric b{font-size:28px;display:block}.good{color:#7ee787}.bad{color:#ff7b72}.muted{color:#9ba7bd}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px;border-bottom:1px solid #25314a;text-align:left}code{background:#0d1526;padding:2px 5px;border-radius:5px}</style></head><body><div class="wrap"><section class="hero"><h1>StellarCode Token Efficiency</h1><div class="muted">Source-grounded A/B benchmark · Baseline vs Stellar-assisted repository navigation</div><h2 class="${report.passGate?'good':'bad'}">${report.passGate?'PASS':'NOT YET PROVEN'}</h2></section><section class="grid"><div class="metric"><span>Input token reduction</span><b class="${deltaClass(report.delta.inputTokenReductionPct)}">${fmt(report.delta.inputTokenReductionPct)}%</b><small>target ≥ 20%</small></div><div class="metric"><span>Navigation token reduction</span><b class="${deltaClass(report.delta.navigationInputTokenReductionPct)}">${fmt(report.delta.navigationInputTokenReductionPct)}%</b><small>target ≥ 50%</small></div><div class="metric"><span>Tool call reduction</span><b class="${deltaClass(report.delta.toolCallReductionPct)}">${fmt(report.delta.toolCallReductionPct)}%</b><small>target ≥ 40%</small></div><div class="metric"><span>Time to relevant source</span><b class="${deltaClass(report.delta.firstRelevantReductionPct??-1)}">${fmt(report.delta.firstRelevantReductionPct)}%</b><small>target ≥ 40%</small></div></section><section class="card"><h2>Three-layer correctness</h2><table><thead><tr><th>Layer</th><th>Baseline</th><th>Stellar</th><th>Meaning</th></tr></thead><tbody><tr><td>Discovery</td><td>${fmt(report.baseline.discoveryRate)}%</td><td>${fmt(report.stellar.discoveryRate)}%</td><td>Expected implementation was located</td></tr><tr><td>Source grounding</td><td>${fmt(report.baseline.sourceGroundingRate)}%</td><td>${fmt(report.stellar.sourceGroundingRate)}%</td><td>Expected source was actually read</td></tr><tr><td>Answer correctness</td><td>${fmt(report.baseline.answerSuccessRate)}%</td><td>${fmt(report.stellar.answerSuccessRate)}%</td><td>Final answer identified the expected file</td></tr><tr><td><b>Grounded success</b></td><td><b>${fmt(report.baseline.successRate)}%</b></td><td><b>${fmt(report.stellar.successRate)}%</b></td><td>Answer correct AND source-grounded</td></tr></tbody></table><p class="muted">${report.correctnessVerified?'Every run has an answer key.':'Correctness is not fully verified. Add expectedFiles to every task before claiming token savings.'}</p></section><section class="card"><h2>Per-task results</h2><table><thead><tr><th>Task</th><th>Run</th><th>Baseline tokens</th><th>Stellar tokens</th><th>Reduction</th><th>Tool calls</th><th>Discover</th><th>Read source</th><th>Answer</th><th>Grounded</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2>Gate</h2><pre>${esc(JSON.stringify({correctness:report.correctnessGate,performance:report.acceptance},null,2))}</pre></section></div></body></html>`
}

export async function writeBenchmarkReport(baselineFile,stellarFile,{jsonFile,htmlFile}={}) {
  const report=await benchmarkReport(baselineFile,stellarFile)
  if(jsonFile)await fs.writeFile(jsonFile,JSON.stringify(report,null,2)+'\n')
  if(htmlFile)await fs.writeFile(htmlFile,benchmarkReportHtml(report))
  return report
}

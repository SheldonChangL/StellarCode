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
    success: row.success == null ? null : Boolean(row.success)
  }
}

function aggregate(rows) {
  const normalized=rows.map(normalizeRow)
  const verifiedRows=normalized.filter(r=>r.verified && r.success!=null)
  const navigation=normalized.filter(r=>r.category==='navigation' || !r.category)
  return {
    runs: normalized.length,
    verifiedRuns: verifiedRows.length,
    successRate: ratio(verifiedRows.filter(r=>r.success).length,verifiedRows.length),
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
    successRateDeltaPoints: baseline.successRate==null||stellar.successRate==null?null:stellar.successRate-baseline.successRate
  }
  const correctnessVerified=baseline.verifiedRuns===baseline.runs && stellar.verifiedRuns===stellar.runs && baseline.runs>0 && stellar.runs>0
  const acceptance = {
    overallInputTokens: delta.inputTokenReductionPct >= 20,
    navigationInputTokens: delta.navigationInputTokenReductionPct >= 50,
    toolCalls: delta.toolCallReductionPct >= 40,
    firstRelevantTime: delta.firstRelevantReductionPct != null && delta.firstRelevantReductionPct >= 40,
    successRate: correctnessVerified && delta.successRateDeltaPoints >= -5
  }
  return {
    schemaVersion:2,
    baselineFile:path.resolve(baselineFile),stellarFile:path.resolve(stellarFile),
    baseline,stellar,delta,correctnessVerified,acceptance,
    passGate:Object.values(acceptance).every(Boolean),
    mvpThresholdsMet:Object.values(acceptance).every(Boolean),
    pairs:paired.map(({key,baseline:b,stellar:s})=>({key,taskId:b.taskId,repetition:b.repetition??1,baseline:{inputTokens:b.inputTokens,toolCalls:b.toolCalls,searchCalls:b.searchCalls,filesOpened:b.filesOpened,firstRelevantMs:b.firstRelevantMs,success:b.success},stellar:{inputTokens:s.inputTokens,toolCalls:s.toolCalls,searchCalls:s.searchCalls,filesOpened:s.filesOpened,firstRelevantMs:s.firstRelevantMs,success:s.success},inputTokenReductionPct:pctReduction(b.inputTokens,s.inputTokens)}))
  }
}

function fmt(v,digits=1){return v==null?'n/a':Number(v).toLocaleString(undefined,{maximumFractionDigits:digits})}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function deltaClass(v){return v>=0?'good':'bad'}

export function benchmarkReportHtml(report) {
  const rows=report.pairs.map(p=>`<tr><td>${esc(p.taskId)}</td><td>${p.repetition}</td><td>${fmt(p.baseline.inputTokens,0)}</td><td>${fmt(p.stellar.inputTokens,0)}</td><td class="${deltaClass(p.inputTokenReductionPct)}">${fmt(p.inputTokenReductionPct)}%</td><td>${fmt(p.baseline.toolCalls,0)} → ${fmt(p.stellar.toolCalls,0)}</td><td>${p.baseline.success==null?'?':p.baseline.success?'✓':'✕'} / ${p.stellar.success==null?'?':p.stellar.success?'✓':'✕'}</td></tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StellarCode Token Benchmark</title><style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b1020;color:#e8edf7;margin:0;padding:32px}.wrap{max-width:1100px;margin:auto}.hero,.card{background:#121a2c;border:1px solid #25314a;border-radius:16px;padding:22px;margin-bottom:18px}.hero h1{margin:0 0 8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.metric{background:#0d1526;border:1px solid #25314a;border-radius:12px;padding:16px}.metric b{font-size:28px;display:block}.good{color:#7ee787}.bad{color:#ff7b72}.muted{color:#9ba7bd}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px;border-bottom:1px solid #25314a;text-align:left}code{background:#0d1526;padding:2px 5px;border-radius:5px}</style></head><body><div class="wrap"><section class="hero"><h1>StellarCode Token Efficiency</h1><div class="muted">A/B benchmark · Baseline vs Stellar-assisted repository navigation</div><h2 class="${report.passGate?'good':'bad'}">${report.passGate?'PASS':'NOT YET PROVEN'}</h2></section><section class="grid"><div class="metric"><span>Input token reduction</span><b class="${deltaClass(report.delta.inputTokenReductionPct)}">${fmt(report.delta.inputTokenReductionPct)}%</b><small>target ≥ 20%</small></div><div class="metric"><span>Navigation token reduction</span><b class="${deltaClass(report.delta.navigationInputTokenReductionPct)}">${fmt(report.delta.navigationInputTokenReductionPct)}%</b><small>target ≥ 50%</small></div><div class="metric"><span>Tool call reduction</span><b class="${deltaClass(report.delta.toolCallReductionPct)}">${fmt(report.delta.toolCallReductionPct)}%</b><small>target ≥ 40%</small></div><div class="metric"><span>Time to relevant file</span><b class="${deltaClass(report.delta.firstRelevantReductionPct??-1)}">${fmt(report.delta.firstRelevantReductionPct)}%</b><small>target ≥ 40%</small></div></section><section class="card"><h2>Correctness</h2><p>Baseline: <b>${fmt(report.baseline.successRate)}%</b> · Stellar: <b>${fmt(report.stellar.successRate)}%</b> · Delta: <b>${fmt(report.delta.successRateDeltaPoints)} points</b></p><p class="muted">${report.correctnessVerified?'Every run has an answer key.':'Correctness is not fully verified. Add expectedFiles to every task before claiming token savings.'}</p></section><section class="card"><h2>Per-task results</h2><table><thead><tr><th>Task</th><th>Run</th><th>Baseline tokens</th><th>Stellar tokens</th><th>Reduction</th><th>Tool calls</th><th>Correct</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2>Gate</h2><pre>${esc(JSON.stringify(report.acceptance,null,2))}</pre></section></div></body></html>`
}

export async function writeBenchmarkReport(baselineFile,stellarFile,{jsonFile,htmlFile}={}) {
  const report=await benchmarkReport(baselineFile,stellarFile)
  if(jsonFile)await fs.writeFile(jsonFile,JSON.stringify(report,null,2)+'\n')
  if(htmlFile)await fs.writeFile(htmlFile,benchmarkReportHtml(report))
  return report
}

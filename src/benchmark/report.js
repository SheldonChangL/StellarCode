import fs from 'node:fs/promises'
import path from 'node:path'
import { BENCHMARK_CATEGORIES } from './tasks.js'
import { campaignFromReport, taskStats, winLossDistribution, catastrophicRegressions, determinismSummary, median as medianOf, METHODOLOGY, PROVIDER_DRIFT_NOTE } from './generalization.js'

export const REPORT_SCHEMA_VERSION = 5
export const LATENCY_FIELDS = ['firstEventMs','firstModelEventMs','agentStartToFirstToolMs','firstToolDurationMs','stellarContextDurationMs','firstRelevantToolStartedAtMs','firstRelevantToolDurationMs','firstRelevantSourceCompletionMs']

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
function optionalReduction(base, next) { return base == null || next == null ? null : pctReduction(base, next) }
function optionalNumber(v) { return v == null || !Number.isFinite(Number(v)) ? null : Number(v) }
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
    // Rows written before v0.5.5 carry no category; they were all navigation tasks.
    category:row.category ?? 'navigation',
    categorySource:row.categorySource ?? (row.category ? 'explicit' : 'legacy-default'),
    expectedSourceBytes:optionalNumber(row.expectedSourceBytes),
    nonExpectedSourceBytes:optionalNumber(row.nonExpectedSourceBytes),
    ...Object.fromEntries(LATENCY_FIELDS.map(field=>[field,optionalNumber(row[field])])),
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
  const navigation=normalized.filter(r=>r.category==='navigation')
  const precisionRows=normalized.filter(r=>r.expectedSourceBytes!=null && r.nonExpectedSourceBytes!=null)
  const expectedSourceBytes=sum(precisionRows.map(r=>r.expectedSourceBytes))
  const nonExpectedSourceBytes=sum(precisionRows.map(r=>r.nonExpectedSourceBytes))
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
    navigationRuns: navigation.length,
    // Benchmark proxy for context focus, not semantic correctness (see sourceCoverage).
    precisionRuns: precisionRows.length,
    expectedSourceBytes: precisionRows.length ? expectedSourceBytes : null,
    nonExpectedSourceBytes: precisionRows.length ? nonExpectedSourceBytes : null,
    expectedFileSourcePrecision: precisionRows.length && expectedSourceBytes+nonExpectedSourceBytes>0 ? expectedSourceBytes/(expectedSourceBytes+nonExpectedSourceBytes) : null
  }
}

function pairRows(baselineRows, stellarRows) {
  const key=r=>`${r.taskId}#${r.repetition??1}`
  const base=new Map(baselineRows.map(r=>[key(r),normalizeRow(r)]))
  const stellar=new Map(stellarRows.map(r=>[key(r),normalizeRow(r)]))
  const keys=[...base.keys()].filter(k=>stellar.has(k)).sort()
  return keys.map(k=>({key:k,baseline:base.get(k),stellar:stellar.get(k)}))
}

function pairDelta(baseline, stellar) {
  return {
    inputTokenReductionPct: pctReduction(baseline.avgInputTokens, stellar.avgInputTokens),
    toolCallReductionPct: pctReduction(baseline.avgToolCalls, stellar.avgToolCalls),
    searchCallReductionPct: pctReduction(baseline.avgSearchCalls, stellar.avgSearchCalls),
    sourceBytesReductionPct: pctReduction(baseline.totalSourceBytesRead/Math.max(1,baseline.runs), stellar.totalSourceBytesRead/Math.max(1,stellar.runs))
  }
}

// Per-category view of the same paired runs. A category without tasks reports n/a
// (null), never zero, so an absent category cannot look like a failed or perfect one.
function categoryBreakdown(paired) {
  const result={}
  for(const category of [...BENCHMARK_CATEGORIES,...new Set(paired.map(p=>p.baseline.category).filter(c=>!BENCHMARK_CATEGORIES.includes(c)))]) {
    const pairs=paired.filter(p=>p.baseline.category===category)
    if(!pairs.length){result[category]={status:'n/a',pairedRuns:0,tasks:0,inputTokenReductionPct:null,toolCallReductionPct:null,searchCallReductionPct:null,sourceBytesReductionPct:null,baseline:null,stellar:null};continue}
    const baseline=aggregate(pairs.map(p=>p.baseline)),stellar=aggregate(pairs.map(p=>p.stellar))
    const pick=v=>({sourceGroundingRate:v.sourceGroundingRate,answerSuccessRate:v.answerSuccessRate,successRate:v.successRate,expectedFileSourcePrecision:v.expectedFileSourcePrecision})
    result[category]={status:'measured',pairedRuns:pairs.length,tasks:new Set(pairs.map(p=>p.baseline.taskId)).size,...pairDelta(baseline,stellar),baseline:pick(baseline),stellar:pick(stellar)}
  }
  return result
}

const MEDIAN_METRICS=[['inputTokens','InputTokens'],['toolCalls','ToolCalls'],['searchCalls','SearchCalls'],['firstRelevantMs','FirstRelevantMs'],['sourceBytesRead','SourceBytes']]

// Medians across repetitions per task resist a single stochastic agent run; reductions
// compare the paired baseline and Stellar medians of the same task.
function taskSummaries(paired) {
  const byTask=new Map()
  for(const pair of paired) {
    const list=byTask.get(pair.baseline.taskId)??[];list.push(pair);byTask.set(pair.baseline.taskId,list)
  }
  return [...byTask.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([taskId,pairs])=>{
    const summary={taskId,category:pairs[0].baseline.category,pairedRuns:pairs.length}
    for(const [field,label] of MEDIAN_METRICS) {
      const baseline=median(pairs.map(p=>p.baseline[field]).filter(v=>v!=null))
      const stellar=median(pairs.map(p=>p.stellar[field]).filter(v=>v!=null))
      summary[`baselineMedian${label}`]=baseline
      summary[`stellarMedian${label}`]=stellar
      summary[`median${label}ReductionPct`]=optionalReduction(baseline,stellar)
    }
    const precision=side=>{
      const rows=pairs.map(p=>p[side]).filter(r=>r.expectedSourceBytes!=null&&r.nonExpectedSourceBytes!=null)
      const expected=sum(rows.map(r=>r.expectedSourceBytes)),total=expected+sum(rows.map(r=>r.nonExpectedSourceBytes))
      return rows.length&&total>0?expected/total:null
    }
    summary.baselineExpectedFileSourcePrecision=precision('baseline')
    summary.stellarExpectedFileSourcePrecision=precision('stellar')
    summary.stellarGroundedSuccessRate=ratio(pairs.filter(p=>p.stellar.success).length,pairs.length)
    return summary
  })
}

function taskMedianDelta(summaries) {
  const result={tasks:summaries.length}
  for(const [,label] of MEDIAN_METRICS) {
    const usable=summaries.filter(s=>s[`baselineMedian${label}`]!=null&&s[`stellarMedian${label}`]!=null)
    const baseline=sum(usable.map(s=>s[`baselineMedian${label}`])),stellar=sum(usable.map(s=>s[`stellarMedian${label}`]))
    // Sum of per-task medians: every task weighs by its own typical size, outliers do not.
    result[`sumOfMedians${label}ReductionPct`]=usable.length?pctReduction(baseline,stellar):null
    // Median of per-task reductions: the typical task's improvement.
    result[`medianTask${label}ReductionPct`]=median(usable.map(s=>s[`median${label}ReductionPct`]))
  }
  return result
}

async function attributionFor(rows, mode, runDirectory) {
  const totals={benchmarkPrompt:0,stellarContextRequest:0,stellarContextResponse:0,stellarSourceRequest:0,stellarSourceResponse:0,nativeSourceReads:0,otherToolInputs:0,otherToolOutputs:0,knownTotal:0,unattributedVsProvider:0,providerInputTokens:0}
  for(const row of rows) {
    const file=path.join(runDirectory,'diagnostics',encodeURIComponent(row.taskId),`${mode}-${row.repetition??1}`,'token-attribution.json')
    try {
      const value=JSON.parse(await fs.readFile(file,'utf8'))
      totals.providerInputTokens+=Number(value.providerReported?.inputTokens??0)
      for(const key of Object.keys(totals)) if(key in value.estimated)totals[key]+=Number(value.estimated[key]??0)
    } catch {}
  }
  return totals
}

export async function benchmarkReport(baselineFile, stellarFile) {
  const baselineRows=await readJsonl(baselineFile), stellarRows=await readJsonl(stellarFile)
  const availablePairs=pairRows(baselineRows,stellarRows)
  // A/B performance must compare the same task/repetition on both sides. Provider quota
  // failures and interrupted invocations are reported as coverage gaps, not silently mixed
  // into unequal aggregate samples. A completed agent run with incorrect/ungrounded output
  // remains in the comparison because correctness failures are product evidence.
  // A row that records exitCode must have exited 0; a null exitCode means the agent was
  // killed by a signal (truncated run). Only legacy rows without the field count as ok.
  const completed=row=>!('exitCode' in row) || row.exitCode===0
  const paired=availablePairs.filter(({baseline,stellar}) => completed(baseline) && completed(stellar))
  // Both sides of a pair must be judged under one category, or category metrics and the
  // navigation gate would compare different task sets. An explicit category wins over the
  // legacy default (rows written before v0.5.5 carry none); a true conflict is counted.
  let categoryMismatchedPairs=0
  for(const pair of paired) {
    if(pair.baseline.category===pair.stellar.category)continue
    const explicit=[pair.baseline,pair.stellar].filter(row=>row.categorySource==='explicit').map(row=>row.category)
    if(new Set(explicit).size!==1)categoryMismatchedPairs++
    const category=new Set(explicit).size===1?explicit[0]:pair.baseline.category
    pair.baseline={...pair.baseline,category};pair.stellar={...pair.stellar,category}
  }
  const pairedBaseline=paired.map(pair=>pair.baseline)
  const pairedStellar=paired.map(pair=>pair.stellar)
  const baseline = aggregate(pairedBaseline)
  const stellar = aggregate(pairedStellar)
  const coverage={
    baselineRuns:baselineRows.length,
    stellarRuns:stellarRows.length,
    pairedAvailableRuns:availablePairs.length,
    pairedRuns:paired.length,
    excludedFailedPairs:availablePairs.length-paired.length,
    unpairedBaseline:Math.max(0,baselineRows.length-availablePairs.length),
    unpairedStellar:Math.max(0,stellarRows.length-availablePairs.length)
  }
  const runDirectory=path.dirname(baselineFile)
  const attribution={baseline:await attributionFor(pairedBaseline,'baseline',runDirectory),stellar:await attributionFor(pairedStellar,'stellar',runDirectory),estimator:'ceil(UTF-8 bytes / 4); estimates attribute visible prompt and tool traffic only. Provider input includes cached conversation, tool schema, and framework context.'}
  const delta = {
    inputTokenReductionPct: pctReduction(baseline.avgInputTokens, stellar.avgInputTokens),
    // Rows whose benchmark category is navigation. Before v0.5.5 every task was labelled
    // navigation, so historical reports measured all tasks here; with explicit categories it
    // measures real navigation tasks only. No navigation rows => null (n/a), not 0.
    navigationInputTokenReductionPct: baseline.navigationRuns&&stellar.navigationRuns ? pctReduction(baseline.navigationInputTokens/baseline.navigationRuns, stellar.navigationInputTokens/stellar.navigationRuns) : null,
    toolCallReductionPct: pctReduction(baseline.avgToolCalls, stellar.avgToolCalls),
    searchCallReductionPct: pctReduction(baseline.avgSearchCalls, stellar.avgSearchCalls),
    filesOpenedReductionPct: pctReduction(baseline.avgFilesOpened, stellar.avgFilesOpened),
    sourceBytesReductionPct: pctReduction(baseline.totalSourceBytesRead/Math.max(1,baseline.runs), stellar.totalSourceBytesRead/Math.max(1,stellar.runs)),
    firstRelevantReductionPct: baseline.medianFirstRelevantMs==null||stellar.medianFirstRelevantMs==null?null:pctReduction(baseline.medianFirstRelevantMs, stellar.medianFirstRelevantMs),
    discoveryRateDeltaPoints: baseline.discoveryRate==null||stellar.discoveryRate==null?null:stellar.discoveryRate-baseline.discoveryRate,
    sourceGroundingRateDeltaPoints: baseline.sourceGroundingRate==null||stellar.sourceGroundingRate==null?null:stellar.sourceGroundingRate-baseline.sourceGroundingRate,
    answerSuccessRateDeltaPoints: baseline.answerSuccessRate==null||stellar.answerSuccessRate==null?null:stellar.answerSuccessRate-baseline.answerSuccessRate,
    successRateDeltaPoints: baseline.successRate==null||stellar.successRate==null?null:stellar.successRate-baseline.successRate,
    expectedFileSourcePrecisionDeltaPoints: baseline.expectedFileSourcePrecision==null||stellar.expectedFileSourcePrecision==null?null:(stellar.expectedFileSourcePrecision-baseline.expectedFileSourcePrecision)*100
  }
  const summaries=taskSummaries(paired)
  const campaign=await campaignMetadata(path.dirname(baselineFile),pairedBaseline[0]??baselineRows[0]??null)
  const correctnessVerified=baseline.verifiedRuns===baseline.runs && stellar.verifiedRuns===stellar.runs && baseline.runs>0 && stellar.runs>0
  const acceptance = {
    overallInputTokens: delta.inputTokenReductionPct >= 20,
    navigationInputTokens: delta.navigationInputTokenReductionPct == null ? null : delta.navigationInputTokenReductionPct >= 50,
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
  const correctnessPass=Object.values(correctnessGate).every(Boolean)
  // null marks a gate that does not apply to this run (no navigation-category tasks).
  const efficiencyPass=Object.values(acceptance).every(v=>v===true||v===null) && Object.values(acceptance).some(v=>v===true)
  const overallPass=correctnessPass && efficiencyPass
  const report={
    schemaVersion:REPORT_SCHEMA_VERSION,
    campaign,
    baselineFile:path.resolve(baselineFile),stellarFile:path.resolve(stellarFile),
    baseline,stellar,delta,correctnessVerified,acceptance,correctnessGate,attribution,coverage,
    categories:categoryBreakdown(paired),
    categoryMismatchedPairs,
    taskSummaries:summaries,
    taskMedianDelta:taskMedianDelta(summaries),
    gateNotes:{
      thresholds:'Unchanged from v0.5.4.',
      navigationInputTokens:'Evaluated on navigation-category paired runs only; null (not applicable) when a run has no navigation tasks. Task files without categories default to navigation, which preserves pre-v0.5.5 numbers.',
      expectedFileSourcePrecision:'Benchmark proxy for context focus (expected-file unique source bytes / all unique source bytes). Not semantic correctness and not a gate.'
    },
    correctnessPass,efficiencyPass,overallPass,
    // Backward-compatible aliases. passGate now means the overall A/B gate rather than
    // correctness-only, which prevents a token-regressing run from being labelled PASS.
    passGate:overallPass,
    mvpThresholdsMet:efficiencyPass,
    pairs:paired.map(({key,baseline:b,stellar:s})=>({key,taskId:b.taskId,repetition:b.repetition??1,category:b.category,classifiedIntent:s.classifiedIntent??null,baseline:pairSide(b),stellar:pairSide(s),inputTokenReductionPct:pctReduction(b.inputTokens,s.inputTokens)}))
  }
  // v0.5.6 single-campaign generalization views, computed from the same paired runs.
  const stats=taskStats(campaignFromReport(report).pairs)
  report.methodology=METHODOLOGY
  report.winLoss=winLossDistribution(stats)
  report.catastrophicRegressionTasks=catastrophicRegressions(stats)
  report.determinism=determinismSummary(stats)
  report.firstRelevantDecomposition=firstRelevantDecomposition(paired)
  report.notes={providerDrift:PROVIDER_DRIFT_NOTE}
  return report
}

function pairSide(r) {
  return {inputTokens:r.inputTokens,toolCalls:r.toolCalls,searchCalls:r.searchCalls,filesOpened:r.filesOpened,sourceBytesRead:r.sourceBytesRead,firstRelevantMs:r.firstRelevantMs,
    ...Object.fromEntries(LATENCY_FIELDS.map(field=>[field,r[field]])),
    discoverySuccess:r.discoverySuccess,sourceGrounded:r.sourceGrounded,answerSuccess:r.answerSuccess,success:r.success,expectedSourceBytes:r.expectedSourceBytes,nonExpectedSourceBytes:r.nonExpectedSourceBytes}
}

// Median of each latency component per condition. Components are milliseconds from agent
// process spawn; null (n/a) when the runs predate v0.5.6 telemetry.
function firstRelevantDecomposition(paired) {
  const out={}
  for(const side of ['baseline','stellar']) {
    out[side]={}
    for(const field of LATENCY_FIELDS)out[side][field]=medianOf(paired.map(p=>p[side][field]))
    out[side].runsWithTelemetry=paired.filter(p=>p[side].agentStartToFirstToolMs!=null).length
  }
  out.note='firstRelevantMs is measured from agent process spawn to completion of the first tool call that read an expected file. It therefore includes agent startup, provider latency for every model turn before that call, and tool execution.'
  return out
}

async function campaignMetadata(dir,firstRow) {
  let manifest=null
  try{manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))}catch{}
  return {
    repository:manifest?.repository??(manifest?.projectRoot?path.basename(manifest.projectRoot):null),
    agent:manifest?.agent??firstRow?.agent??null,
    agentVersion:manifest?.agentVersion??firstRow?.agentVersion??null,
    model:manifest?.model??firstRow?.model??null,
    runtimeCommit:manifest?.runtime?.commit??null,
    runtimePackageVersion:manifest?.runtime?.packageVersion??null,
    runtimeDirty:manifest?.runtime?.dirty??null,
    runtimeChangedDuringCampaign:manifest?.runtime?.changedDuringCampaign??null,
    runtimeContentHash:manifest?.runtime?.contentHash??null,
    repoCommit:manifest?.projectCommit??firstRow?.projectCommit??null,
    taskHash:manifest?.taskHash??null,
    campaignStartedAt:manifest?.startedAt??manifest?.createdAt??null,
    repeat:manifest?.repeat??null,
    environment:manifest?.environment??null,
    manifestSchemaVersion:manifest?.schemaVersion??null
  }
}

function fmt(v,digits=1){return v==null?'n/a':Number(v).toLocaleString(undefined,{maximumFractionDigits:digits})}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function deltaClass(v){return v>=0?'good':'bad'}

export function benchmarkReportHtml(report) {
  const mark=v=>v==null?'?':v?'✓':'✕'
  const rows=report.pairs.map(p=>`<tr><td>${esc(p.taskId)}</td><td>${p.repetition}</td><td>${fmt(p.baseline.inputTokens,0)}</td><td>${fmt(p.stellar.inputTokens,0)}</td><td class="${deltaClass(p.inputTokenReductionPct)}">${fmt(p.inputTokenReductionPct)}%</td><td>${fmt(p.baseline.toolCalls,0)} → ${fmt(p.stellar.toolCalls,0)}</td><td>${mark(p.stellar.discoverySuccess)}</td><td>${mark(p.stellar.sourceGrounded)}</td><td>${mark(p.stellar.answerSuccess)}</td><td>${mark(p.stellar.success)}</td></tr>`).join('')
  const pct=v=>v==null?'n/a':`${fmt(v)}%`
  const share=v=>v==null?'n/a':`${fmt(v*100)}%`
  const categoryRows=Object.entries(report.categories??{}).map(([name,c])=>`<tr><td>${esc(name)}</td><td>${c.pairedRuns||'n/a'}</td><td>${pct(c.inputTokenReductionPct)}</td><td>${pct(c.toolCallReductionPct)}</td><td>${pct(c.searchCallReductionPct)}</td><td>${pct(c.stellar?.sourceGroundingRate)}</td><td>${pct(c.stellar?.answerSuccessRate)}</td><td>${share(c.baseline?.expectedFileSourcePrecision)} → ${share(c.stellar?.expectedFileSourcePrecision)}</td></tr>`).join('')
  const medianRows=(report.taskSummaries??[]).map(t=>`<tr><td>${esc(t.taskId)}</td><td>${esc(t.category)}</td><td>${fmt(t.baselineMedianInputTokens,0)} → ${fmt(t.stellarMedianInputTokens,0)}</td><td class="${deltaClass(t.medianInputTokensReductionPct??-1)}">${pct(t.medianInputTokensReductionPct)}</td><td>${fmt(t.baselineMedianToolCalls,1)} → ${fmt(t.stellarMedianToolCalls,1)}</td><td>${fmt(t.baselineMedianSourceBytes,0)} → ${fmt(t.stellarMedianSourceBytes,0)}</td><td>${share(t.baselineExpectedFileSourcePrecision)} → ${share(t.stellarExpectedFileSourcePrecision)}</td></tr>`).join('')
  const attributionRows=Object.keys(report.attribution.stellar).filter(key=>!['providerInputTokens'].includes(key)).map(key=>`<tr><td>${esc(key)}</td><td>${fmt(report.attribution.baseline[key],0)}</td><td>${fmt(report.attribution.stellar[key],0)}</td></tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StellarCode Token Benchmark</title><style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b1020;color:#e8edf7;margin:0;padding:32px}.wrap{max-width:1180px;margin:auto}.hero,.card{background:#121a2c;border:1px solid #25314a;border-radius:16px;padding:22px;margin-bottom:18px}.hero h1{margin:0 0 8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.metric{background:#0d1526;border:1px solid #25314a;border-radius:12px;padding:16px}.metric b{font-size:28px;display:block}.good{color:#7ee787}.bad{color:#ff7b72}.muted{color:#9ba7bd}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px;border-bottom:1px solid #25314a;text-align:left}code{background:#0d1526;padding:2px 5px;border-radius:5px}</style></head><body><div class="wrap"><section class="hero"><h1>StellarCode Token Efficiency</h1><div class="muted">Source-grounded A/B benchmark · Baseline vs Stellar-assisted repository navigation</div><h2 class="${report.overallPass?'good':'bad'}">${report.overallPass?'PASS':'NOT YET PROVEN'}</h2><div class="muted">Paired runs: ${report.coverage?.pairedRuns??report.pairs.length} · Correctness: ${report.correctnessPass?'PASS':'FAIL'} · Efficiency: ${report.efficiencyPass?'PASS':'FAIL'}</div></section><section class="grid"><div class="metric"><span>Input token reduction</span><b class="${deltaClass(report.delta.inputTokenReductionPct)}">${fmt(report.delta.inputTokenReductionPct)}%</b><small>target ≥ 20%</small></div><div class="metric"><span>Navigation token reduction</span><b class="${deltaClass(report.delta.navigationInputTokenReductionPct)}">${fmt(report.delta.navigationInputTokenReductionPct)}%</b><small>target ≥ 50%</small></div><div class="metric"><span>Tool call reduction</span><b class="${deltaClass(report.delta.toolCallReductionPct)}">${fmt(report.delta.toolCallReductionPct)}%</b><small>target ≥ 40%</small></div><div class="metric"><span>Time to relevant source</span><b class="${deltaClass(report.delta.firstRelevantReductionPct??-1)}">${fmt(report.delta.firstRelevantReductionPct)}%</b><small>target ≥ 40%</small></div></section><section class="card"><h2>Token attribution</h2><p class="muted">Estimated attribution; provider input is reported separately. ${esc(report.attribution.estimator)}</p><table><thead><tr><th>Category</th><th>Baseline estimated</th><th>Stellar estimated</th></tr></thead><tbody>${attributionRows}</tbody></table></section><section class="card"><h2>Three-layer correctness</h2><table><thead><tr><th>Layer</th><th>Baseline</th><th>Stellar</th><th>Meaning</th></tr></thead><tbody><tr><td>Discovery</td><td>${fmt(report.baseline.discoveryRate)}%</td><td>${fmt(report.stellar.discoveryRate)}%</td><td>Expected implementation was located</td></tr><tr><td>Source grounding</td><td>${fmt(report.baseline.sourceGroundingRate)}%</td><td>${fmt(report.stellar.sourceGroundingRate)}%</td><td>Expected source was actually read</td></tr><tr><td>Answer correctness</td><td>${fmt(report.baseline.answerSuccessRate)}%</td><td>${fmt(report.stellar.answerSuccessRate)}%</td><td>Final answer identified the expected file</td></tr><tr><td><b>Grounded success</b></td><td><b>${fmt(report.baseline.successRate)}%</b></td><td><b>${fmt(report.stellar.successRate)}%</b></td><td>Answer correct AND source-grounded</td></tr></tbody></table></section><section class="card"><h2>By benchmark category</h2><p class="muted">Category is the task author's label; n/a means no tasks of that category. Expected-file source precision is a focus proxy, not semantic correctness.</p><table><thead><tr><th>Category</th><th>Paired runs</th><th>Input tokens</th><th>Tool calls</th><th>Search calls</th><th>Stellar grounding</th><th>Stellar answer</th><th>Expected-file precision</th></tr></thead><tbody>${categoryRows}</tbody></table></section><section class="card"><h2>Per-task medians</h2><table><thead><tr><th>Task</th><th>Category</th><th>Median input tokens</th><th>Reduction</th><th>Median tool calls</th><th>Median source bytes</th><th>Expected-file precision</th></tr></thead><tbody>${medianRows}</tbody></table></section><section class="card"><h2>Per-task results</h2><table><thead><tr><th>Task</th><th>Run</th><th>Baseline tokens</th><th>Stellar tokens</th><th>Reduction</th><th>Tool calls</th><th>Discover</th><th>Read source</th><th>Answer</th><th>Grounded</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2>Gate</h2><pre>${esc(JSON.stringify({correctness:report.correctnessGate,performance:report.acceptance},null,2))}</pre></section></div></body></html>`
}

export async function writeBenchmarkReport(baselineFile,stellarFile,{jsonFile,htmlFile}={}) {
  const report=await benchmarkReport(baselineFile,stellarFile)
  if(jsonFile)await fs.writeFile(jsonFile,JSON.stringify(report,null,2)+'\n')
  if(htmlFile)await fs.writeFile(htmlFile,benchmarkReportHtml(report))
  return report
}

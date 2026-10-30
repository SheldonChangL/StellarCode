import fs from 'node:fs/promises'

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${file}:${i + 1}: ${error.message}`) }
  })
}

function mean(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0 }
function median(values) { if(!values.length)return 0;const s=[...values].sort((a,b)=>a-b);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2 }
function pctReduction(base, next) { return base === 0 ? 0 : ((base - next) / base) * 100 }

function aggregate(rows) {
  return {
    tasks: rows.length,
    successRate: mean(rows.map(r => r.success ? 1 : 0)) * 100,
    avgToolCalls: mean(rows.map(r => Number(r.discoveryToolCalls ?? r.toolCalls ?? 0))),
    avgDiscoveryTokens: mean(rows.map(r => Number(r.discoveryTokens ?? 0))),
    medianFirstRelevantMs: median(rows.map(r => Number(r.firstRelevantMs ?? r.durationToRelevantMs ?? 0))),
    avgFilesOpened: mean(rows.map(r => Number(r.filesOpened ?? 0)))
  }
}

export async function benchmarkReport(baselineFile, stellarFile) {
  const baseline = aggregate(await readJsonl(baselineFile))
  const stellar = aggregate(await readJsonl(stellarFile))
  const delta = {
    toolCallReductionPct: pctReduction(baseline.avgToolCalls, stellar.avgToolCalls),
    discoveryTokenReductionPct: pctReduction(baseline.avgDiscoveryTokens, stellar.avgDiscoveryTokens),
    firstRelevantReductionPct: pctReduction(baseline.medianFirstRelevantMs, stellar.medianFirstRelevantMs),
    successRateDeltaPoints: stellar.successRate - baseline.successRate
  }
  const acceptance = {
    discoveryToolCalls: delta.toolCallReductionPct >= 50,
    discoveryTokens: delta.discoveryTokenReductionPct >= 40,
    firstRelevantTime: delta.firstRelevantReductionPct >= 50,
    successRate: delta.successRateDeltaPoints >= -5
  }
  return { baseline, stellar, delta, acceptance, mvpThresholdsMet: Object.values(acceptance).every(Boolean) }
}

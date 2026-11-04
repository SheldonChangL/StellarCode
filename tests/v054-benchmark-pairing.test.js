import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { benchmarkPrompt } from '../src/benchmark/agents.js'
import { benchmarkReport } from '../src/benchmark/report.js'

test('v0.5.4 Stellar benchmark contract distinguishes grounded related evidence from hints', () => {
  const task={prompt:'Trace the login flow'}
  const stellar=benchmarkPrompt(task,'stellar')
  const baseline=benchmarkPrompt(task,'baseline')
  assert.match(stellar,/relatedEvidence/)
  assert.match(stellar,/relatedHints/)
  assert.match(stellar,/Do not re-read/)
  assert.match(stellar,/never list a hinted file/i)
  assert.doesNotMatch(baseline,/relatedEvidence|relatedHints/)
})

function row(taskId,repetition,overrides={}) {
  return {
    schemaVersion:2,taskId,repetition,category:'navigation',exitCode:0,
    inputTokens:100,outputTokens:10,toolCalls:4,searchCalls:2,filesOpened:4,
    sourceBytesRead:4000,firstRelevantMs:100,
    verified:true,success:true,
    discoveryVerified:true,discoverySuccess:true,
    sourceGroundingVerified:true,sourceGrounded:true,
    answerVerified:true,answerSuccess:true,
    ...overrides
  }
}

test('v0.5.4 benchmark aggregate uses only comparable paired runs and exposes explicit gates', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-report-pairs-'))
  try {
    const baselineFile=path.join(dir,'baseline.jsonl')
    const stellarFile=path.join(dir,'stellar.jsonl')
    const baseline=[
      row('paired',1),
      row('baseline-only',1,{inputTokens:10000,toolCalls:100,sourceBytesRead:999999})
    ]
    const stellar=[row('paired',1,{inputTokens:40,toolCalls:2,searchCalls:0,filesOpened:1,sourceBytesRead:500,firstRelevantMs:50})]
    await fs.writeFile(baselineFile,baseline.map(v=>JSON.stringify(v)).join('\n')+'\n')
    await fs.writeFile(stellarFile,stellar.map(v=>JSON.stringify(v)).join('\n')+'\n')

    const report=await benchmarkReport(baselineFile,stellarFile)
    // v0.5.6 bumped the report contract to 5 (campaign metadata, win/loss, determinism,
    // latency decomposition); every v4 field asserted below is unchanged.
    assert.equal(report.schemaVersion,5)
    assert.deepEqual(report.coverage,{
      baselineRuns:2,stellarRuns:1,pairedAvailableRuns:1,pairedRuns:1,
      excludedFailedPairs:0,unpairedBaseline:1,unpairedStellar:0
    })
    assert.equal(report.baseline.runs,1)
    assert.equal(report.baseline.avgInputTokens,100)
    assert.equal(report.stellar.avgInputTokens,40)
    assert.equal(report.correctnessPass,true)
    assert.equal(report.efficiencyPass,true)
    assert.equal(report.overallPass,true)
    assert.equal(report.passGate,report.overallPass)
  } finally {
    await fs.rm(dir,{recursive:true,force:true})
  }
})

test('v0.5.4 failed provider invocation is excluded as coverage gap, not A/B performance evidence', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-report-failed-pair-'))
  try {
    const baselineFile=path.join(dir,'baseline.jsonl')
    const stellarFile=path.join(dir,'stellar.jsonl')
    await fs.writeFile(baselineFile,JSON.stringify(row('quota',1))+'\n')
    await fs.writeFile(stellarFile,JSON.stringify(row('quota',1,{exitCode:1,success:false,sourceGrounded:false,answerSuccess:false}))+'\n')
    const report=await benchmarkReport(baselineFile,stellarFile)
    assert.equal(report.coverage.pairedAvailableRuns,1)
    assert.equal(report.coverage.pairedRuns,0)
    assert.equal(report.coverage.excludedFailedPairs,1)
    assert.equal(report.correctnessPass,false)
    assert.equal(report.overallPass,false)
  } finally {
    await fs.rm(dir,{recursive:true,force:true})
  }
})

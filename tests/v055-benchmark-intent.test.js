import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadBenchmarkTasks } from '../src/benchmark/tasks.js'
import { runBenchmark } from '../src/benchmark/runner.js'
import { benchmarkReport, benchmarkReportHtml } from '../src/benchmark/report.js'
import { benchmarkPrompt } from '../src/benchmark/agents.js'
import { sourceCoverage } from '../src/benchmark/evidence.js'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { makeWorkspace } from './helpers.js'

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(),prefix))
}

test('v0.5.5 benchmark tasks keep explicit categories; missing category is legacy navigation', async () => {
  const dir=await tempDir('stellar-categories-')
  try {
    const file=path.join(dir,'tasks.json')
    const tasks=['navigation','flow','impact','editing-prep'].map(category=>({id:`t-${category}`,category,prompt:'Find login.',expectedFiles:['a.ts']}))
    // The id says "flow" but the category is absent: ids are metadata, never a category source.
    tasks.push({id:'legacy-flow',prompt:'Trace login.',expectedFiles:['a.ts']})
    await fs.writeFile(file,JSON.stringify({version:1,tasks}))
    const loaded=(await loadBenchmarkTasks(file)).tasks
    assert.deepEqual(loaded.map(t=>t.category),['navigation','flow','impact','editing-prep','navigation'])
    assert.deepEqual(loaded.map(t=>t.categorySource),['explicit','explicit','explicit','explicit','legacy-default'])
    await fs.writeFile(file,JSON.stringify({version:1,tasks:[{id:'x',category:'refactoring',prompt:'p'}]}))
    await assert.rejects(()=>loadBenchmarkTasks(file),/Unknown benchmark category/)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('v0.5.5 benchmark category never reaches the agent prompt or StellarCode', () => {
  const task={prompt:'Trace how cleaning applies progression.'}
  for(const mode of ['baseline','stellar']) {
    assert.equal(benchmarkPrompt({...task,category:'flow',id:'cleaning-progression-flow',expectedFiles:['x.ts']},mode),benchmarkPrompt(task,mode))
  }
})

test('v0.5.5 category survives load, run row and report with classified intent alongside', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    await syncProject(w.repo,{dirs:w.dirs})
    const tasksFile=path.join(w.base,'tasks.json')
    // Author category "flow" while the prompt classifies as navigation: both are recorded, separately.
    await fs.writeFile(tasksFile,JSON.stringify({version:1,tasks:[{id:'auth',enabled:true,category:'flow',prompt:'Find the login implementation.',expectedFiles:['src/auth/AuthService.ts'],expectedMatch:'any'}]},null,2))
    const fake=path.join(w.base,'fake-codex.mjs')
    await fs.writeFile(fake,`#!/usr/bin/env node
import {execSync} from 'node:child_process'
const a=process.argv.slice(2)
if(a.includes('--version')){console.log('codex fake 1.0');process.exit(0)}
if(a.includes('--help')){console.log('--json --sandbox --ephemeral --ignore-user-config --ignore-rules');process.exit(0)}
const s=(a[a.length-1]||'').includes('Benchmark condition: STELLAR')
const run=(id,command)=>{console.log(JSON.stringify({type:'item.started',item:{id,type:'command_execution',command}}));const output=execSync(command,{encoding:'utf8'});console.log(JSON.stringify({type:'item.completed',item:{id,type:'command_execution',command,aggregated_output:output,exit_code:0,status:'completed'}}))}
console.log(JSON.stringify({type:'thread.started',thread_id:'x'}))
if(s)run('1','stellar source src/auth/AuthService.ts --lines 1:20 --json')
else{run('1','sed -n 1,40p src/auth/AuthService.ts');run('2','sed -n 1,20p src/auth/TokenStore.ts')}
console.log(JSON.stringify({type:'item.completed',item:{id:'3',type:'agent_message',text:JSON.stringify({summary:'login',files:['src/auth/AuthService.ts'],symbols:['login']})}}))
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:s?400:1000,cached_input_tokens:0,output_tokens:10,reasoning_output_tokens:0}}))
`)
    await fs.chmod(fake,0o755)
    const result=await runBenchmark({projectRoot:w.repo,tasksFile,agent:'codex',mode:'both',outDir:path.join(w.base,'run'),stellarBin:path.resolve('bin/stellar.js'),env:{...process.env,STELLAR_DATA_DIR:w.dirs.data,STELLAR_BENCH_CODEX_BIN:fake}})
    for(const file of Object.values(result.files)) {
      const row=JSON.parse((await fs.readFile(file,'utf8')).trim())
      assert.equal(row.category,'flow')
      assert.equal(row.benchmarkCategory,'flow')
      assert.equal(row.categorySource,'explicit')
      assert.equal(row.classifiedIntent,'navigation')
      assert.ok(row.expectedSourceBytes>0)
      assert.equal(row.expectedSourceBytes+row.nonExpectedSourceBytes,row.sourceBytesRead)
    }
    const baselineRow=JSON.parse((await fs.readFile(result.files.baseline,'utf8')).trim())
    assert.ok(baselineRow.nonExpectedSourceBytes>0,'TokenStore read counts as non-expected source')
    const report=await benchmarkReport(result.files.baseline,result.files.stellar)
    assert.equal(report.categories.flow.status,'measured')
    assert.equal(report.categories.flow.pairedRuns,1)
    assert.equal(report.categories.navigation.status,'n/a')
    assert.equal(report.categories.navigation.inputTokenReductionPct,null)
    assert.equal(report.categories.impact.status,'n/a')
    assert.equal(report.categories['editing-prep'].status,'n/a')
    // No navigation tasks: the navigation gate does not apply rather than failing with 0%.
    assert.equal(report.delta.navigationInputTokenReductionPct,null)
    assert.equal(report.acceptance.navigationInputTokens,null)
    assert.equal(report.pairs[0].category,'flow')
    assert.equal(report.pairs[0].classifiedIntent,'navigation')
    assert.equal(report.stellar.expectedFileSourcePrecision,1)
    assert.ok(report.baseline.expectedFileSourcePrecision<1)
    assert.match(benchmarkReportHtml(report),/By benchmark category/)
  } finally {await w.cleanup()}
})

function row(taskId,repetition,overrides={}) {
  return {
    schemaVersion:3,taskId,repetition,category:'flow',exitCode:0,
    inputTokens:100,outputTokens:10,toolCalls:4,searchCalls:2,filesOpened:2,sourceBytesRead:1000,firstRelevantMs:100,
    expectedSourceBytes:500,nonExpectedSourceBytes:500,
    verified:true,success:true,discoveryVerified:true,discoverySuccess:true,
    sourceGroundingVerified:true,sourceGrounded:true,answerVerified:true,answerSuccess:true,
    ...overrides
  }
}

test('v0.5.5 per-task medians resist one stochastic repetition', async () => {
  const dir=await tempDir('stellar-medians-')
  try {
    const baseline=[
      row('a',1,{inputTokens:1000,toolCalls:10}),row('a',2,{inputTokens:1200,toolCalls:12}),row('a',3,{inputTokens:9000,toolCalls:60}),
      row('b',1,{category:'navigation',inputTokens:400}),row('b',2,{category:'navigation',inputTokens:400}),row('b',3,{category:'navigation',inputTokens:400})
    ]
    const stellar=[
      row('a',1,{inputTokens:500,toolCalls:2}),row('a',2,{inputTokens:600,toolCalls:3}),row('a',3,{inputTokens:20000,toolCalls:40,expectedSourceBytes:900,nonExpectedSourceBytes:100}),
      row('b',1,{category:'navigation',inputTokens:100}),row('b',2,{category:'navigation',inputTokens:300}),row('b',3,{category:'navigation',inputTokens:200})
    ]
    const baselineFile=path.join(dir,'baseline.jsonl'),stellarFile=path.join(dir,'stellar.jsonl')
    await fs.writeFile(baselineFile,baseline.map(v=>JSON.stringify(v)).join('\n')+'\n')
    await fs.writeFile(stellarFile,stellar.map(v=>JSON.stringify(v)).join('\n')+'\n')
    const report=await benchmarkReport(baselineFile,stellarFile)
    const a=report.taskSummaries.find(t=>t.taskId==='a')
    assert.equal(a.category,'flow')
    assert.equal(a.pairedRuns,3)
    assert.equal(a.baselineMedianInputTokens,1200)
    assert.equal(a.stellarMedianInputTokens,600)
    assert.equal(a.medianInputTokensReductionPct,50)
    assert.equal(a.baselineMedianToolCalls,12)
    assert.equal(a.stellarMedianToolCalls,3)
    assert.equal(a.medianToolCallsReductionPct,75)
    assert.equal(a.stellarExpectedFileSourcePrecision,(500+500+900)/3000)
    const b=report.taskSummaries.find(t=>t.taskId==='b')
    assert.equal(b.medianInputTokensReductionPct,50)
    // The mean is dominated by the one 20000-token run; the median view is not.
    assert.ok(report.delta.inputTokenReductionPct<0)
    assert.equal(report.taskMedianDelta.medianTaskInputTokensReductionPct,50)
    assert.equal(report.taskMedianDelta.sumOfMediansInputTokensReductionPct,(1600-800)/1600*100)
    // Aggregates are kept for backward compatibility; categories are reported separately.
    assert.equal(report.categories.flow.pairedRuns,3)
    assert.equal(report.categories.navigation.pairedRuns,3)
    assert.equal(report.delta.navigationInputTokenReductionPct,50)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('v0.5.5 expected-file source precision counts unique bytes once', async () => {
  const dir=await tempDir('stellar-precision-')
  try {
    // Each file is one line; bytes include the trailing newline.
    await fs.writeFile(path.join(dir,'A.ts'),'a'.repeat(99)+'\n')
    await fs.writeFile(path.join(dir,'B.ts'),'b'.repeat(99)+'\n')
    await fs.writeFile(path.join(dir,'C.ts'),'c'.repeat(199)+'\n')
    const reads=[
      {path:'A.ts',startLine:1,endLine:1},{path:'A.ts',startLine:1,endLine:1},
      {path:'B.ts',startLine:1,endLine:1},
      {path:'C.ts',startLine:1,endLine:1},{path:'C.ts',startLine:1,endLine:1}
    ]
    const coverage=await sourceCoverage(dir,reads,['A.ts','B.ts'])
    assert.equal(coverage.expectedSourceBytes,200)
    assert.equal(coverage.nonExpectedSourceBytes,200)
    assert.equal(coverage.uniqueSourceBytesRead,400)
    assert.equal(coverage.expectedFileSourcePrecision,0.5)
    assert.equal((await sourceCoverage(dir,[],['A.ts'])).expectedFileSourcePrecision,null)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('v0.5.5 rows without precision fields report n/a precision, not zero', async () => {
  const dir=await tempDir('stellar-legacy-precision-')
  try {
    const legacy=overrides=>{const value=row('legacy',1,overrides);delete value.expectedSourceBytes;delete value.nonExpectedSourceBytes;delete value.category;return value}
    const baselineFile=path.join(dir,'baseline.jsonl'),stellarFile=path.join(dir,'stellar.jsonl')
    await fs.writeFile(baselineFile,JSON.stringify(legacy({}))+'\n')
    await fs.writeFile(stellarFile,JSON.stringify(legacy({inputTokens:40}))+'\n')
    const report=await benchmarkReport(baselineFile,stellarFile)
    assert.equal(report.stellar.expectedFileSourcePrecision,null)
    assert.equal(report.taskSummaries[0].category,'navigation')
    assert.equal(report.delta.navigationInputTokenReductionPct,60)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('v0.5.5 both sides of a pair are judged under one category', async () => {
  const dir=await tempDir('stellar-pair-category-')
  try {
    // Baseline written before v0.5.5 (no category); Stellar rows carry explicit categories.
    const legacy=(id,tokens)=>{const value=row(id,1,{inputTokens:tokens});delete value.category;return value}
    const baselineFile=path.join(dir,'baseline.jsonl'),stellarFile=path.join(dir,'stellar.jsonl')
    await fs.writeFile(baselineFile,[legacy('t1',1000),legacy('t2',100000)].map(v=>JSON.stringify(v)).join('\n')+'\n')
    await fs.writeFile(stellarFile,[row('t1',1,{category:'navigation',categorySource:'explicit',inputTokens:900}),row('t2',1,{category:'flow',categorySource:'explicit',inputTokens:90000})].map(v=>JSON.stringify(v)).join('\n')+'\n')
    const report=await benchmarkReport(baselineFile,stellarFile)
    assert.equal(report.baseline.navigationRuns,1)
    assert.equal(report.stellar.navigationRuns,1)
    assert.equal(report.delta.navigationInputTokenReductionPct,10)
    assert.equal(report.categories.flow.pairedRuns,1)
    assert.equal(report.categoryMismatchedPairs,0)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

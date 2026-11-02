import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { initBenchmarkConfig, loadBenchmarkTasks } from '../src/benchmark/tasks.js'
import { runBenchmark } from '../src/benchmark/runner.js'
import { benchmarkReport, benchmarkReportHtml } from '../src/benchmark/report.js'
import { appDirectories } from '../src/platform/paths.js'
import { initializeProject } from '../src/core/project.js'
import { makeWorkspace } from './helpers.js'

test('v0.5.1 app directories support benchmark isolation overrides', () => {
  const dirs=appDirectories({platform:'linux',home:'/tmp/home',env:{STELLAR_DATA_DIR:'/x/data',STELLAR_CACHE_DIR:'/x/cache',STELLAR_LOG_DIR:'/x/logs'}})
  assert.deepEqual(dirs,{data:'/x/data',cache:'/x/cache',logs:'/x/logs'})
})

test('v0.5.1 benchmark init creates disabled answer-key template', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    const result=await initBenchmarkConfig(w.repo)
    assert.equal(result.created,true)
    const raw=JSON.parse(await fs.readFile(result.file,'utf8'))
    assert.equal(raw.version,1)
    assert.ok(raw.tasks.every(t=>t.enabled===false))
    await assert.rejects(()=>loadBenchmarkTasks(result.file),/No enabled benchmark tasks/)
  } finally { await w.cleanup() }
})

test('v0.5.1 runs paired Codex A/B sessions and reports real usage fields', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    const tasksFile=path.join(w.base,'tasks.json')
    await fs.writeFile(tasksFile,JSON.stringify({version:1,tasks:[{id:'auth',enabled:true,category:'navigation',prompt:'Find the login implementation.',expectedFiles:['src/auth/AuthService.ts'],expectedMatch:'any'}]},null,2))
    const fake=path.join(w.base,'fake-codex.mjs')
    await fs.writeFile(fake,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes('--version')){console.log('codex fake 1.0');process.exit(0)}if(a.includes('--help')){console.log('--json --sandbox --ephemeral --ignore-user-config --ignore-rules');process.exit(0)}const p=a[a.length-1]||'';const s=p.includes('Benchmark condition: STELLAR');const emit=o=>console.log(JSON.stringify(o));emit({type:'thread.started',thread_id:'x'});if(!s){emit({type:'item.started',item:{id:'1',type:'command_execution',command:'rg login src'}});await new Promise(r=>setTimeout(r,60));emit({type:'item.started',item:{id:'2',type:'command_execution',command:'sed -n 1,140p src/auth/AuthService.ts'}})}else{emit({type:'item.started',item:{id:'1',type:'command_execution',command:'stellar context "Find login" --json src/auth/AuthService.ts'}});await new Promise(r=>setTimeout(r,8))}emit({type:'item.completed',item:{id:'3',type:'agent_message',text:JSON.stringify({summary:'login',files:['src/auth/AuthService.ts'],symbols:['login']})}});emit({type:'turn.completed',usage:{input_tokens:s?450:1000,cached_input_tokens:s?100:200,output_tokens:50,reasoning_output_tokens:0}});`)
    await fs.chmod(fake,0o755)
    const out=path.join(w.base,'run')
    const result=await runBenchmark({projectRoot:w.repo,tasksFile,agent:'codex',mode:'both',outDir:out,stellarBin:path.resolve('bin/stellar.js'),env:{...process.env,STELLAR_BENCH_CODEX_BIN:fake}})
    const report=await benchmarkReport(result.files.baseline,result.files.stellar)
    assert.equal(report.correctnessVerified,true)
    assert.equal(report.baseline.successRate,100)
    assert.equal(report.stellar.successRate,100)
    assert.ok(report.delta.inputTokenReductionPct>50)
    assert.ok(report.delta.toolCallReductionPct>=50)
    assert.ok(report.delta.firstRelevantReductionPct>40)
    assert.equal(report.passGate,true)
    assert.match(benchmarkReportHtml(report),/StellarCode Token Efficiency/)
  } finally { await w.cleanup() }
})

test('v0.5.1 normalizes Claude cache usage into effective input tokens', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    const tasksFile=path.join(w.base,'tasks-claude.json')
    await fs.writeFile(tasksFile,JSON.stringify({version:1,tasks:[{id:'auth',enabled:true,category:'navigation',prompt:'Find the login implementation.',expectedFiles:['src/auth/AuthService.ts']}]},null,2))
    const fake=path.join(w.base,'fake-claude.mjs')
    await fs.writeFile(fake,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes('--version')){console.log('claude fake 1.0');process.exit(0)}if(a.includes('--help')){console.log('--output-format --permission-mode --allowedTools --setting-sources --strict-mcp-config --mcp-config');process.exit(0)}const p=a.find(v=>v.includes('Benchmark condition:'))||'';const s=p.includes('STELLAR');const emit=o=>console.log(JSON.stringify(o));if(!s){emit({type:'assistant',message:{content:[{type:'tool_use',name:'Grep',input:{pattern:'login',path:'src'}}]}});await new Promise(r=>setTimeout(r,50));emit({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'src/auth/AuthService.ts'}}]}})}else{emit({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'stellar context login --json src/auth/AuthService.ts'}}]}});await new Promise(r=>setTimeout(r,5))}emit({type:'result',result:JSON.stringify({summary:'x',files:['src/auth/AuthService.ts'],symbols:['login']}),structured_output:{summary:'x',files:['src/auth/AuthService.ts'],symbols:['login']},total_cost_usd:s?0.01:0.02,usage:{input_tokens:10,cache_creation_input_tokens:s?100:500,cache_read_input_tokens:s?50:300,output_tokens:20}});`)
    await fs.chmod(fake,0o755)
    const result=await runBenchmark({projectRoot:w.repo,tasksFile,agent:'claude',mode:'both',outDir:path.join(w.base,'claude-run'),stellarBin:path.resolve('bin/stellar.js'),env:{...process.env,STELLAR_BENCH_CLAUDE_BIN:fake}})
    const baseline=JSON.parse((await fs.readFile(result.files.baseline,'utf8')).trim())
    const stellar=JSON.parse((await fs.readFile(result.files.stellar,'utf8')).trim())
    assert.equal(baseline.inputTokens,810)
    assert.equal(stellar.inputTokens,160)
    assert.equal(baseline.success,true)
    assert.equal(stellar.success,true)
  } finally { await w.cleanup() }
})

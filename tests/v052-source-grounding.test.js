import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { contextForTask, sourceExcerpt } from '../src/query/query-service.js'
import { runBenchmark } from '../src/benchmark/runner.js'
import { benchmarkReport } from '../src/benchmark/report.js'
import { makeWorkspace } from './helpers.js'

test('v0.5.2 context returns a bounded source-grounding read plan', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const context=await contextForTask(w.repo,'Find the login implementation',{dirs:w.dirs,sync:false})
    const auth=context.primary.find(v=>v.path==='src/auth/AuthService.ts')
    assert.ok(auth)
    assert.deepEqual(auth.symbols.find(s=>s.qualifiedName==='AuthService.login')?.lines,[7,11])
    assert.equal(context.sourceGrounding.required,true)
    assert.equal(auth.read.required,true)
    assert.ok(Array.isArray(auth.read.lines))
    assert.match(auth.read.command,/stellar source/)
    const excerpt=await sourceExcerpt(w.repo,'src/auth/AuthService.ts',{dirs:w.dirs,sync:false,lines:auth.read.lines})
    assert.equal(excerpt.sourceOfTruth,true)
    assert.match(excerpt.content,/login\(/)
    assert.ok(excerpt.lineCount<=220)
  } finally { await w.cleanup() }
})

test('v0.5.2 correct-looking answer without a source read fails grounded success', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    await syncProject(w.repo,{dirs:w.dirs})
    const tasksFile=path.join(w.base,'tasks.json')
    await fs.writeFile(tasksFile,JSON.stringify({version:1,tasks:[{id:'auth',enabled:true,category:'navigation',prompt:'Find login.',expectedFiles:['src/auth/AuthService.ts']}]},null,2))
    const fake=path.join(w.base,'fake-codex-no-read.mjs')
    await fs.writeFile(fake,`#!/usr/bin/env node\nimport {execSync} from 'node:child_process';import {readFileSync} from 'node:fs';const a=process.argv.slice(2);if(a.includes('--version')){console.log('codex fake 1.0');process.exit(0)}if(a.includes('--help')){console.log('--json --sandbox --ephemeral --ignore-user-config --ignore-rules');process.exit(0)}const p=a[a.length-1]||'';const s=p.includes('Benchmark condition: STELLAR');const emit=o=>{console.log(JSON.stringify(o));if(o.type==='item.started'&&o.item?.command){try{const output=execSync(o.item.command,{encoding:'utf8'});console.log(JSON.stringify({type:'item.completed',item:{...o.item,aggregated_output:output,exit_code:0,status:'completed'}}))}catch(e){console.log(JSON.stringify({type:'item.completed',item:{...o.item,aggregated_output:String(e.stderr),exit_code:1,status:'failed'}}))}}if(o.type==='assistant'){for(const b of o.message.content){let output='';if(b.name==='Read')output=readFileSync(b.input.file_path,'utf8');if(b.name==='Bash')output=execSync(b.input.command,{encoding:'utf8'});console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:b.id,content:output}]}}))}}};if(s){emit({type:'item.started',item:{id:'1',type:'command_execution',command:'stellar context "Find login" --json'}})}else{emit({type:'item.started',item:{id:'1',type:'command_execution',command:'sed -n 1,80p src/auth/AuthService.ts'}})}emit({type:'item.completed',item:{id:'2',type:'agent_message',text:JSON.stringify({summary:'login',files:['src/auth/AuthService.ts'],symbols:['login']})}});emit({type:'turn.completed',usage:{input_tokens:s?300:600,cached_input_tokens:0,output_tokens:20}});`)
    await fs.chmod(fake,0o755)
    const result=await runBenchmark({projectRoot:w.repo,tasksFile,agent:'codex',mode:'both',outDir:path.join(w.base,'run'),stellarBin:path.resolve('bin/stellar.js'),env:{...process.env,STELLAR_DATA_DIR:w.dirs.data,STELLAR_BENCH_CODEX_BIN:fake}})
    const stellar=JSON.parse((await fs.readFile(result.files.stellar,'utf8')).trim())
    assert.equal(stellar.discoverySuccess,true)
    assert.equal(stellar.answerSuccess,true)
    assert.equal(stellar.sourceGrounded,false)
    assert.equal(stellar.success,false)
    const report=await benchmarkReport(result.files.baseline,result.files.stellar)
    assert.equal(report.stellar.answerSuccessRate,100)
    assert.equal(report.stellar.sourceGroundingRate,0)
    assert.equal(report.stellar.successRate,0)
    assert.equal(report.passGate,false)
  } finally { await w.cleanup() }
})

test('v0.5.2 reinstalling agent rule upgrades an existing StellarCode section', async () => {
  const w=await makeWorkspace()
  try {
    const { installAgentRule } = await import('../src/core/agent-rule.js')
    const file=path.join(w.repo,'AGENTS.md')
    await fs.writeFile(file,'# Project\n\n## StellarCode repository navigation\nOld rule: trust summaries.\n\n## Other\nKeep this.\n')
    const changed=await installAgentRule(w.repo)
    assert.ok(changed.includes('AGENTS.md'))
    const text=await fs.readFile(file,'utf8')
    assert.match(text,/metadata is navigation evidence/)
    assert.doesNotMatch(text,/trust summaries/)
    assert.match(text,/## Other\nKeep this\./)
  } finally { await w.cleanup() }
})

test('v0.5.2 benchmark trace records source evidence without copying source content', async () => {
  const w=await makeWorkspace()
  const prior=process.env.STELLAR_BENCH_TRACE_FILE
  try {
    const trace=path.join(w.base,'trace.jsonl')
    process.env.STELLAR_BENCH_TRACE_FILE=trace
    const { traceCliResult } = await import('../src/core/benchmark-trace.js')
    traceCliResult('source',['src/auth/AuthService.ts','--lines','7:11'],{path:'src/auth/AuthService.ts',lines:[7,11],lineCount:5,content:'SECRET SOURCE',sourceOfTruth:true})
    const row=JSON.parse((await fs.readFile(trace,'utf8')).trim())
    assert.equal(row.command,'source')
    assert.equal(row.result.path,'src/auth/AuthService.ts')
    assert.equal(row.result.sourceOfTruth,true)
    assert.equal('content' in row.result,false)
  } finally {
    if(prior===undefined) delete process.env.STELLAR_BENCH_TRACE_FILE
    else process.env.STELLAR_BENCH_TRACE_FILE=prior
    await w.cleanup()
  }
})

test('compact context is bounded and progressively omits related files', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const verbose=await contextForTask(w.repo,'Find the login implementation',{dirs:w.dirs,sync:false})
    const compact=await contextForTask(w.repo,'Find the login implementation',{dirs:w.dirs,sync:false,compact:true,maxFiles:2,maxLines:60,maxBytes:4000})
    assert.ok(compact.targets.length<=2)
    assert.ok(compact.targets.every(target=>target.lines[1]-target.lines[0]+1<=60))
    assert.equal('related' in compact,false)
    assert.equal('queryProfile' in compact,false)
    assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(verbose)))
    assert.ok(compact.targets[0].symbol)
  } finally {await w.cleanup()}
})

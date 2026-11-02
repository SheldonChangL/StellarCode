import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runAgent, benchmarkPrompt } from '../src/benchmark/agents.js'

test('raw stdout and stderr persist byte-for-byte with the actual prompt before evaluation', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-raw-test-'))
  try {
    const fake=path.join(dir,'codex')
    const raw='{"type":"thread.started","thread_id":"test"}\r\nnot-json\n'
    await fs.writeFile(fake,`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(raw)});process.stderr.write('diagnostic failure\\n');process.exitCode=1`,{mode:0o755})
    const task={prompt:'Locate entry point',expectedFiles:[]}
    const diagnosticDir=path.join(dir,'diagnostics')
    await runAgent({agent:'codex',task,mode:'stellar',cwd:dir,env:{...process.env,STELLAR_BENCH_CODEX_BIN:fake},diagnosticDir})
    assert.equal(await fs.readFile(path.join(diagnosticDir,'raw-events.jsonl'),'utf8'),raw)
    assert.equal(await fs.readFile(path.join(diagnosticDir,'stdout.log'),'utf8'),raw)
    assert.equal(await fs.readFile(path.join(diagnosticDir,'stderr.log'),'utf8'),'diagnostic failure\n')
    const info=JSON.parse(await fs.readFile(path.join(diagnosticDir,'diagnostic.json'),'utf8'))
    assert.equal(info.promptSent,benchmarkPrompt(task,'stellar'))
    assert.equal(info.cwd,dir)
    assert.equal(info.PATH,process.env.PATH)
    assert.equal('env' in info,false)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

import { makeWorkspace } from './helpers.js'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { prepareBenchmarkSnapshot } from '../src/benchmark/snapshot.js'
import { execFileSync } from 'node:child_process'

test('detached worktree uses the original UUID and prebuilt index without any DB writes', async () => {
  const w=await makeWorkspace()
  try {
    const {metadata}=await initializeProject(w.repo)
    await syncProject(w.repo,{dirs:w.dirs})
    const worktree=path.join(w.base,'detached')
    const commit=execFileSync('git',['-C',w.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
    execFileSync('git',['-C',w.repo,'worktree','add','--detach',worktree,commit])
    const env={...process.env,STELLAR_DATA_DIR:w.dirs.data}
    const snapshot=await prepareBenchmarkSnapshot(w.repo,worktree,w.base,commit,env)
    assert.equal(snapshot.projectId,metadata.projectId)
    const before=await fs.readFile(snapshot.indexFile)
    const result=JSON.parse(execFileSync(process.execPath,[path.resolve('bin/stellar.js'),'context','Find login','--json'],{cwd:worktree,env:{...env,STELLAR_DATA_DIR:path.join(w.base,'must-not-create'),STELLAR_BENCH_INDEX_FILE:snapshot.indexFile},encoding:'utf8'}))
    assert.ok(result.primary.some(p=>p.path==='src/auth/AuthService.ts'))
    await assert.rejects(fs.access(path.join(w.base,'must-not-create')))
    assert.deepEqual(await fs.readFile(snapshot.indexFile),before)
    assert.equal(JSON.parse(await fs.readFile(path.join(worktree,'.stellar/project.json'))).projectId,metadata.projectId)
    assert.equal((await fs.readdir(w.base)).some(p=>p==='benchmark-index.db-wal'),false)
  } finally {await w.cleanup()}
})

import { completedEvidence } from '../src/benchmark/evidence.js'

test('grounding needs successful source output: native reads, Stellar source, and file tools count equally', async () => {
  const w=await makeWorkspace()
  try {
    const file='src/auth/AuthService.ts', source=await fs.readFile(path.join(w.repo,file),'utf8')
    for(const input of [`cat ${file}`,`sed -n '1,100p' ${file}`,`python -c "open('${file}').read()"`,{name:'read_file',path:file}]) {
      const evidence=await completedEvidence({input,output:source,cwd:w.repo,ok:true,atMs:123,via:'native'})
      assert.ok(evidence.reads.some(r=>r.path===file))
      assert.equal(evidence.reads[0].atMs,123)
    }
    const stellar=await completedEvidence({input:`stellar source ${file} --lines 1:100 --json`,output:JSON.stringify({path:file,sourceOfTruth:true,content:source.split('\n').map((s,i)=>`${i+1}: ${s}`).join('\n')}),cwd:w.repo,ok:true,via:'stellar'})
    assert.ok(stellar.reads.length)
    for(const [input,output,ok] of [[`cat ${file}`,'permission denied',false],[`cat ${file}`,'',true],[`stellar context login`,JSON.stringify({primary:[{path:file}]}),true]]) {
      assert.equal((await completedEvidence({input,output,ok,cwd:w.repo})).reads.length,0)
    }
  } finally {await w.cleanup()}
})

test('Stellar-only contract includes context, source-of-truth, read source and source command without an answer key', () => {
  const task={prompt:'Find the entry point',expectedFiles:['private-answer-key.ts']}
  const stellar=benchmarkPrompt(task,'stellar'), baseline=benchmarkPrompt(task,'baseline')
  for(const text of ['stellar context','source-of-truth','read source','stellar source']) {
    assert.ok(stellar.includes(text));assert.ok(!baseline.includes(text))
  }
  assert.ok(!stellar.includes('private-answer-key'))
  assert.ok(!baseline.includes('private-answer-key'))
})

test('only a started read command cannot establish grounding', async () => {
  const w=await makeWorkspace()
  try {
    const fake=path.join(w.base,'fake')
    await fs.writeFile(fake,`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'item.started',item:{id:'r',type:'command_execution',command:'cat src/auth/AuthService.ts'}}))`,{mode:0o755})
    const result=await runAgent({agent:'codex',task:{prompt:'Read implementation'},mode:'baseline',cwd:w.repo,env:{...process.env,STELLAR_BENCH_CODEX_BIN:fake}})
    assert.deepEqual(result.metrics.filesOpened,[])
    assert.equal(result.metrics.sourceBytesRead,0)
  } finally {await w.cleanup()}
})

test('bounded source output does not count repeated lines elsewhere in the file', async () => {
  const w=await makeWorkspace()
  try {
    const file='repeated.ts'
    const content='const sharedDeclaration = true;\nconst firstOnly = true;\nconst sharedDeclaration = true;\nconst secondOnly = true;\n'
    await fs.writeFile(path.join(w.repo,file),content)
    for(const output of ['1: const sharedDeclaration = true;\n2: const firstOnly = true;','const sharedDeclaration = true;\nconst firstOnly = true;']) {
      const evidence=await completedEvidence({input:`read ${file}`,output,ok:true,cwd:w.repo,atMs:10})
      assert.deepEqual(evidence.reads.map(({startLine,endLine})=>[startLine,endLine]),[[1,2]])
      assert.equal(evidence.reads[0].bytes,Buffer.byteLength(content.split('\n').slice(0,2).join('\n')+'\n'))
    }
  } finally {await w.cleanup()}
})

import { runBenchmark } from '../src/benchmark/runner.js'
import { benchmarkReport } from '../src/benchmark/report.js'

test('a failed debug sample retains its worktree, real executable and metadata-only diagnostic', async () => {
  const w=await makeWorkspace();let retained
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs})
    const tasksFile=path.join(w.base,'tasks.json')
    await fs.writeFile(tasksFile,JSON.stringify({version:1,tasks:[{id:'entry',prompt:'Find login',expectedFiles:['src/auth/AuthService.ts']}]}))
    const fake=path.join(w.base,'fake')
    await fs.writeFile(fake,`#!/usr/bin/env node\nif(process.argv.includes('--version'))console.log('test');else if(process.argv.includes('--help'))console.log('--json --sandbox --ephemeral --ignore-user-config --ignore-rules');else console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}))`,{mode:0o755})
    const result=await runBenchmark({projectRoot:w.repo,tasksFile,agent:'codex',mode:'stellar',outDir:path.join(w.base,'out'),keepWorktreeOnFailure:true,env:{...process.env,STELLAR_DATA_DIR:w.dirs.data,STELLAR_BENCH_CODEX_BIN:fake}})
    const diagnostic=JSON.parse(await fs.readFile(path.join(result.outDir,'diagnostics/entry/stellar-1/diagnostic.json')))
    retained=path.dirname(diagnostic.worktreeRoot)
    assert.equal(diagnostic.worktreeRetained,true)
    assert.equal(diagnostic.projectResolved,true)
    assert.equal(diagnostic.stellarAvailable,true)
    assert.equal(diagnostic.stellarVersion,'StellarCode 0.5.2')
    const status=JSON.parse(execFileSync(diagnostic.stellarExecutable,['status','--json'],{cwd:diagnostic.worktreeRoot,encoding:'utf8'}))
    assert.equal(status.projectId,diagnostic.projectId)
    assert.deepEqual(diagnostic.filesActuallyRead,[])
    assert.deepEqual(diagnostic.sourceRangesRead,[])
    assert.equal(diagnostic.success,false)
  } finally {if(retained)await fs.rm(retained,{recursive:true,force:true});await w.cleanup()}
})

test('correctness gate requires all layers at 100 percent independently of performance targets', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-gate-'))
  try {
    const baseline=path.join(dir,'baseline'),stellar=path.join(dir,'stellar')
    const row={taskId:'test',verified:true,success:true,discoverySuccess:true,sourceGrounded:true,answerSuccess:true,inputTokens:100}
    await fs.writeFile(baseline,JSON.stringify(row)+'\n');await fs.writeFile(stellar,JSON.stringify(row)+'\n')
    let report=await benchmarkReport(baseline,stellar)
    assert.equal(report.passGate,true);assert.equal(report.mvpThresholdsMet,false)
    await fs.writeFile(stellar,JSON.stringify({...row,sourceGrounded:false,success:false})+'\n')
    report=await benchmarkReport(baseline,stellar);assert.equal(report.passGate,false)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

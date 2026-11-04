import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareBenchmarkSnapshot } from './snapshot.js'
import { runAgent, commandVersion } from './agents.js'
import { loadBenchmarkTasks, benchmarkConfigPath } from './tasks.js'
import { StellarError } from '../core/errors.js'
import { sourceCoverage } from './evidence.js'
import { classifyIntent } from '../query/intent.js'
import { runtimeFingerprint, fileSha256, latencyDecomposition, repositoryIdentity } from './campaign.js'

const execFileAsync=promisify(execFile)

async function git(root,args) { return (await execFileAsync('git',['-C',root,...args],{maxBuffer:10*1024*1024})).stdout.trim() }

function shellQuote(value) {return "'"+String(value).replaceAll("'", "'\\''")+"'"}

async function writeShim(binDir, mode, stellarBin, snapshot) {
  await fs.mkdir(binDir,{recursive:true})
  const file=path.join(binDir,process.platform==='win32'?'stellar.cmd':'stellar')
  if(process.platform==='win32') {
    const body=mode==='stellar' ? `@echo off\r\n"${process.execPath}" "${stellarBin}" %*\r\n` : '@echo off\r\necho StellarCode disabled for baseline benchmark 1>&2\r\nexit /b 64\r\n'
    await fs.writeFile(file,body)
  } else {
    const body=mode==='stellar' ? `#!/bin/sh\n${snapshot ? `export STELLAR_BENCH_INDEX_FILE=${shellQuote(snapshot.indexFile)}\n` : ''}exec ${shellQuote(process.execPath)} ${shellQuote(stellarBin)} "$@"\n` : '#!/bin/sh\necho "StellarCode disabled for baseline benchmark" >&2\nexit 64\n'
    await fs.writeFile(file,body,{mode:0o755})
  }
  return file
}

function normalizePath(value) { return String(value).replaceAll('\\','/').replace(/^\.\//,'') }

function answerFiles(structured) {
  return Array.isArray(structured?.files) ? structured.files.map(normalizePath) : []
}

function judgePaths(task, paths) {
  if (!task.expectedFiles.length) return {verified:false,success:null,matched:[],missing:[],observed:[...new Set(paths)]}
  const got=new Set(paths.map(normalizePath))
  const matched=task.expectedFiles.filter(v=>got.has(v))
  const success=task.expectedMatch==='all' ? matched.length===task.expectedFiles.length : matched.length>0
  return {verified:true,success,matched,missing:task.expectedFiles.filter(v=>!got.has(v)),observed:[...got]}
}

function judgeAnswer(task, structured) {
  const verdict=judgePaths(task,answerFiles(structured))
  return {...verdict,answerFiles:verdict.observed}
}

async function sanitizeStellarAgentRules(root) {
  for (const name of ['AGENTS.md','CLAUDE.md']) {
    const file = path.join(root, name)
    try {
      const text = await fs.readFile(file, 'utf8')
      const cleaned = text
        .replace(/\n?## StellarCode repository navigation\n[\s\S]*?(?=\n## |$)/g, '')
        .trimEnd() + '\n'
      if (cleaned !== text) await fs.writeFile(file, cleaned)
    } catch {}
  }
}

async function makeWorktree(root, base) {
  const head=await git(root,['rev-parse','HEAD'])
  const worktree=path.join(base,'repo')
  await execFileAsync('git',['-C',root,'worktree','add','--detach','--quiet',worktree,head],{maxBuffer:10*1024*1024})
  await sanitizeStellarAgentRules(worktree)
  return {head,worktree,cleanup:async()=>{try{await execFileAsync('git',['-C',root,'worktree','remove','--force',worktree])}catch{};await fs.rm(base,{recursive:true,force:true})}}
}

export async function benchmarkDoctor({agents=['claude','codex'],env=process.env}={}) {
  const results=[]
  for(const agent of agents)results.push(await commandVersion(agent,env))
  return results
}

export async function runBenchmark({projectRoot,tasksFile,agent='codex',mode='both',model,limit,repeat=1,outDir,stellarBin,env=process.env,onProgress,keepWorktreeOnFailure=false,repository}) {
  const configFile=tasksFile ?? await benchmarkConfigPath(projectRoot)
  const {tasks:allTasks}=await loadBenchmarkTasks(configFile)
  const tasks=Number(limit)>0?allTasks.slice(0,Number(limit)):allTasks
  const modes=mode==='both'?['baseline','stellar']:[mode]
  if(tasks.some(t=>t.category==='edit'))throw new StellarError('v0.5.1 benchmark run supports read-only navigation tasks only; edit benchmarks are not yet implemented.','BENCHMARK_EDIT_UNSUPPORTED',2)
  if(!['claude','codex'].includes(agent))throw new StellarError('--agent must be claude or codex','USAGE',2)
  if(!modes.every(v=>['baseline','stellar'].includes(v)))throw new StellarError('--mode must be baseline, stellar, or both','USAGE',2)
  const agentInfo=(await benchmarkDoctor({agents:[agent],env}))[0]
  if(!agentInfo.available)throw new StellarError(`${agent} CLI is unavailable: ${agentInfo.error??agentInfo.version??'not found'}`,'BENCHMARK_AGENT_UNAVAILABLE',2)
  if(agentInfo.compatible===false)throw new StellarError(`${agent} CLI is missing benchmark-required flags: ${agentInfo.missingFlags.join(', ')}. Upgrade the CLI or use a compatible version.`,'BENCHMARK_AGENT_INCOMPATIBLE',2)
  const commit=await git(projectRoot,['rev-parse','HEAD'])
  const dirty=await git(projectRoot,['status','--porcelain']).then(v=>v?v.split(/\r?\n/).filter(line=>{const p=line.slice(3).trim().replaceAll('\\','/');return p!=='.stellar'&&!p.startsWith('.stellar/')}).length:0)
  const destination=outDir??path.join(projectRoot,'.stellar','benchmark','runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${agent}`)
  await fs.mkdir(destination,{recursive:true})
  const files={baseline:path.join(destination,'baseline.jsonl'),stellar:path.join(destination,'stellar.jsonl')}
  await Promise.all(Object.values(files).map(f=>fs.writeFile(f,'')))
  const packageRoot=path.resolve(fileURLToPath(new URL('../../',import.meta.url)))
  stellarBin=stellarBin??path.join(packageRoot,'bin','stellar.js')
  // Campaign identity is recorded for comparability only; none of it reaches the agent or
  // StellarCode. The runtime fingerprint must not change while the campaign runs.
  const startedAt=new Date().toISOString()
  const runtime=await runtimeFingerprint(packageRoot)
  const taskHash=await fileSha256(configFile)
  const assertRuntimeUnchanged=async()=>{
    const now=await runtimeFingerprint(packageRoot)
    if(now.contentHash!==runtime.contentHash){
      await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({schemaVersion:3,invalid:true,reason:'runtime source changed during campaign',startedAt,runtime:{...runtime,changedDuringCampaign:true,contentHashAfter:now.contentHash}},null,2)+'\n')
      throw new StellarError('StellarCode runtime source changed during the benchmark campaign; the campaign is invalid.','BENCHMARK_RUNTIME_CHANGED',2)
    }
  }
  let completed=0,total=tasks.length*modes.length*repeat
  for(let r=1;r<=repeat;r++) {
    for(let i=0;i<tasks.length;i++) {
      const task=tasks[i]
      const ordered=mode==='both' && (i+r)%2===1?[...modes].reverse():modes
      for(const condition of ordered) {
        await assertRuntimeUnchanged()
        const base=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-bench-'))
        const {worktree,cleanup}=await makeWorktree(projectRoot,base)
        let failed=true
        const diagnosticDir=path.join(destination,'diagnostics',encodeURIComponent(task.id),`${condition}-${r}`)
        await fs.mkdir(diagnosticDir,{recursive:true,mode:0o700})
        await fs.writeFile(path.join(diagnosticDir,'diagnostic.json'),JSON.stringify({mode:condition,taskId:task.id,projectRoot,worktreeRoot:worktree,agentVersion:agentInfo.version},null,2)+'\n',{mode:0o600})
        try {
          const dirs={data:path.join(base,'stellar-data'),cache:path.join(base,'stellar-cache'),logs:path.join(base,'stellar-logs')}
          const snapshot=condition==='stellar'?await prepareBenchmarkSnapshot(projectRoot,worktree,base,commit,env):null
          const binDir=path.join(base,'bin');const stellarExecutable=await writeShim(binDir,condition,stellarBin,snapshot)
          const childEnv={...env,PATH:`${binDir}${path.delimiter}${env.PATH??''}`,STELLAR_DATA_DIR:dirs.data,STELLAR_CACHE_DIR:dirs.cache,STELLAR_LOG_DIR:dirs.logs,STELLAR_BENCH_TRACE_FILE:'',STELLAR_BENCH_INDEX_FILE:snapshot?.indexFile??''}
          let preflight={stellarAvailable:false,stellarVersion:null,projectResolved:false}
          if(condition==='stellar') {
            const checks=[]
            for(const args of [['--version'],['status','--json'],['projects','--json']]) {
              const {stdout,stderr}=await execFileAsync(stellarExecutable,args,{cwd:worktree,env:childEnv})
              checks.push({command:['stellar',...args],stdout,stderr})
            }
            const status=JSON.parse(checks[1].stdout)
            if(status.projectId!==snapshot.projectId || status.lastIndexedHead!==commit)throw new Error('Benchmark preflight project/index mismatch')
            preflight={stellarAvailable:true,stellarVersion:checks[0].stdout.trim(),projectResolved:true,projectId:status.projectId,indexFile:status.dbPath,checks}
          }
          onProgress?.({phase:'start',task:task.id,mode:condition,repetition:r,completed,total})
          const result=await runAgent({agent,task:{prompt:task.prompt},mode:condition,cwd:worktree,env:childEnv,model,maxTurns:task.maxTurns,diagnosticDir,diagnostic:{mode:condition,taskId:task.id,agentVersion:agentInfo.version,stellarExecutable,projectRoot,worktreeRoot:worktree,...preflight,snapshot}})
          const discoveryPaths=[...new Set(result.metrics.filesMentioned??[])]
          const sourceReadPaths=[...new Set(result.metrics.filesOpened??[])]
          const discovery=judgePaths(task,discoveryPaths)
          const grounding=judgePaths(task,sourceReadPaths)
          const answer=judgeAnswer(task,result.metrics.structured)
          const groundedSuccess=result.exitCode===0 && answer.success===true && grounding.success===true
          const firstRelevantCandidates=(result.metrics.sourceReads??[]).filter(read=>task.expectedFiles.includes(read.path)).map(read=>read.atMs).filter(v=>v!=null&&Number.isFinite(v))
          const firstRelevantMs=firstRelevantCandidates.length?Math.min(...firstRelevantCandidates):null
          const coverage=await sourceCoverage(worktree,result.metrics.sourceReads??[],task.expectedFiles)
          const latency=latencyDecomposition(result.metrics,firstRelevantMs)
          // Diagnostic only: what StellarCode's deterministic classifier infers from the prompt,
          // recorded next to the author's category to measure classification accuracy later.
          const classifiedIntent=classifyIntent(task.prompt).intent
          const row={
            schemaVersion:4,taskId:task.id,repetition:r,category:task.category,categorySource:task.categorySource,benchmarkCategory:task.category,classifiedIntent,mode:condition,agent,agentVersion:agentInfo.version,model:model??null,signal:result.signal??null,
            projectCommit:commit,projectDirtyCount:dirty,exitCode:result.exitCode,durationMs:result.durationMs,firstRelevantMs,firstRelevantSourceMs:firstRelevantMs,...latency,
            inputTokens:result.metrics.usage.inputTokens,uncachedInputTokens:result.metrics.usage.uncachedInputTokens,cachedInputTokens:result.metrics.usage.cachedInputTokens,cacheWriteInputTokens:result.metrics.usage.cacheWriteInputTokens,
            outputTokens:result.metrics.usage.outputTokens,reasoningOutputTokens:result.metrics.usage.reasoningOutputTokens,costUsd:result.metrics.costUsd,
            toolCalls:result.metrics.toolCalls,searchCalls:result.metrics.searchCalls,stellarCalls:result.metrics.stellarCalls,filesOpened:sourceReadPaths.length,filesOpenedList:sourceReadPaths,filesActuallyRead:sourceReadPaths,sourceReads:result.metrics.sourceReads??[],rawSourceBytesRead:result.metrics.sourceBytesRead,sourceBytesRead:coverage.uniqueSourceBytesRead,...coverage,
            verified:answer.verified,success:groundedSuccess,
            discoveryVerified:discovery.verified,discoverySuccess:result.exitCode===0?discovery.success:false,discoveredExpectedFiles:discovery.matched,
            sourceGroundingVerified:grounding.verified,sourceGrounded:result.exitCode===0?grounding.success:false,groundedExpectedFiles:grounding.matched,
            answerVerified:answer.verified,answerSuccess:result.exitCode===0?answer.success:false,matchedExpectedFiles:answer.matched,missingExpectedFiles:answer.missing,answerFiles:answer.answerFiles??[],
            final:result.metrics.structured??result.metrics.finalText,stderr:result.exitCode===0?'':result.stderr.slice(0,4000)
          }
          failed=!groundedSuccess
          const diagnosticFile=path.join(diagnosticDir,'diagnostic.json')
          const diagnostic=JSON.parse(await fs.readFile(diagnosticFile,'utf8'))
          await fs.writeFile(diagnosticFile,JSON.stringify({...diagnostic,worktreeRetained:failed&&keepWorktreeOnFailure,commands:result.commands,
            stellarContextCalls:result.commands.filter(c=>/\bstellar\s+context\b/.test(c)),stellarSourceCalls:result.commands.filter(c=>/\bstellar\s+source\b/.test(c)),
            filesActuallyRead:sourceReadPaths,sourceRangesRead:result.metrics.sourceReads,nativeSourceReads:result.metrics.sourceReads.filter(read=>read.via!=='stellar'),firstRelevantSourceMs:firstRelevantMs,
            discoverySuccess:row.discoverySuccess,sourceGrounded:row.sourceGrounded,answerSuccess:row.answerSuccess,success:row.success},null,2)+'\n')
          await fs.appendFile(files[condition],JSON.stringify(row)+'\n')
          completed++;onProgress?.({phase:'done',task:task.id,mode:condition,repetition:r,completed,total,row})
        } catch(error) {
          const file=path.join(diagnosticDir,'diagnostic.json')
          const diagnostic=JSON.parse(await fs.readFile(file,'utf8'))
          await fs.writeFile(file,JSON.stringify({...diagnostic,error:error.message,worktreeRetained:keepWorktreeOnFailure},null,2)+'\n')
          throw error
        } finally { if(!failed||!keepWorktreeOnFailure)await cleanup() }
      }
    }
  }
  await assertRuntimeUnchanged()
  const manifest={schemaVersion:3,createdAt:new Date().toISOString(),startedAt,completedAt:new Date().toISOString(),repository:repository??path.basename(projectRoot),repositoryIdentity:await repositoryIdentity(projectRoot),agent,agentVersion:agentInfo.version,model:model??null,projectRoot,projectCommit:commit,projectDirtyCount:dirty,tasksFile:configFile,taskHash,taskCount:tasks.length,repeat,modes,files,
    runtime:{...runtime,changedDuringCampaign:false},environment:{os:`${os.type()} ${os.release()} ${os.arch()}`,platform:process.platform,node:process.version},isolation:{freshAgentSession:true,detachedWorktree:true,stellarRulesRemovedFromWorktree:true,stellarContractInjectedViaPrompt:true,stableProjectIdentity:true,readOnlyIndexSnapshot:true,userMcpConfigIgnored:true,stellarIndexPreparedBeforeTimedRun:true,sourceGroundingRequired:true,rawAgentTelemetryPersisted:true}}
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  return {outDir:destination,files,manifest}
}

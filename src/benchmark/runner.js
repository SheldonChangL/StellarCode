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
import { sourceCoverage, completedEvidence } from './evidence.js'
import { stellarContextArgs } from './agents.js'
import { DELIVERY_MODES, PREFETCH_MODES, latinSquareOrder, buildContextEnvelope, deliveryMetrics } from './delivery.js'
import { classifyIntent } from '../query/intent.js'
import { runtimeFingerprint, fileSha256, latencyDecomposition, repositoryIdentity } from './campaign.js'

const execFileAsync=promisify(execFile)

async function git(root,args) { return (await execFileAsync('git',['-C',root,...args],{maxBuffer:10*1024*1024})).stdout.trim() }

function shellQuote(value) {return "'"+String(value).replaceAll("'", "'\\''")+"'"}

async function writeShim(binDir, mode, stellarBin, snapshot) {
  await fs.mkdir(binDir,{recursive:true})
  const file=path.join(binDir,process.platform==='win32'?'stellar.cmd':'stellar')
  if(process.platform==='win32') {
    const body=mode!=='baseline' ? `@echo off\r\nset STELLAR_SEMANTIC_SLICE=${mode==='stellar-lexical'?'0':'1'}\r\n"${process.execPath}" "${stellarBin}" %*\r\n` : '@echo off\r\necho StellarCode disabled for baseline benchmark 1>&2\r\nexit /b 64\r\n'
    await fs.writeFile(file,body)
  } else {
    const body=mode!=='baseline' ? `#!/bin/sh\n${snapshot ? `export STELLAR_BENCH_INDEX_FILE=${shellQuote(snapshot.indexFile)}\n` : ''}export STELLAR_SEMANTIC_SLICE=${mode==='stellar-lexical'?'0':'1'}\nexec ${shellQuote(process.execPath)} ${shellQuote(stellarBin)} "$@"\n` : '#!/bin/sh\necho "StellarCode disabled for baseline benchmark" >&2\nexit 64\n'
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

// `stellar-lexical` is the v0.6 comparison condition: the same runtime, index and prompt
// as `stellar`, with the semantic slice switched off inside the stellar shim.
export const BENCHMARK_CONDITIONS = ['baseline', 'stellar', 'stellar-lexical', ...DELIVERY_MODES]

// --mode both | delivery | a condition | a comma-separated list of conditions.
export function parseBenchmarkModes(mode) {
  if (mode === 'both') return ['baseline', 'stellar']
  if (mode === 'delivery') return [...DELIVERY_MODES]
  return String(mode ?? '').split(',').map(value => value.trim()).filter(Boolean)
}

// Order of conditions within one task and repetition. The original two-condition design
// alternates by task and repetition; any other set uses a deterministic Latin square.
export function conditionOrder(modes, mode, taskIndex, repetition) {
  if (mode === 'both') return (taskIndex + repetition) % 2 === 1 ? [...modes].reverse() : modes
  return latinSquareOrder(modes, repetition)
}

export async function runBenchmark({projectRoot,tasksFile,agent='codex',mode='both',model,limit,repeat=1,outDir,stellarBin,env=process.env,onProgress,keepWorktreeOnFailure=false,repository,taskIds}) {
  const configFile=tasksFile ?? await benchmarkConfigPath(projectRoot)
  const {tasks:loadedTasks}=await loadBenchmarkTasks(configFile)
  // A fixed subset is selected by id; the task file itself (and its hash) stays unchanged.
  const wanted=taskIds?.length?new Set(taskIds):null
  if(wanted){const missing=[...wanted].filter(id=>!loadedTasks.some(task=>task.id===id));if(missing.length)throw new StellarError(`Unknown task ids: ${missing.join(', ')}`,'USAGE',2)}
  const allTasks=wanted?loadedTasks.filter(task=>wanted.has(task.id)):loadedTasks
  const tasks=Number(limit)>0?allTasks.slice(0,Number(limit)):allTasks
  const modes=parseBenchmarkModes(mode)
  if(tasks.some(t=>t.category==='edit'))throw new StellarError('v0.5.1 benchmark run supports read-only navigation tasks only; edit benchmarks are not yet implemented.','BENCHMARK_EDIT_UNSUPPORTED',2)
  if(!['claude','codex'].includes(agent))throw new StellarError('--agent must be claude or codex','USAGE',2)
  if(!modes.length||!modes.every(v=>BENCHMARK_CONDITIONS.includes(v))||new Set(modes).size!==modes.length)throw new StellarError(`--mode must be both, delivery, or a list of ${BENCHMARK_CONDITIONS.join('|')}`,'USAGE',2)
  const agentInfo=(await benchmarkDoctor({agents:[agent],env}))[0]
  if(!agentInfo.available)throw new StellarError(`${agent} CLI is unavailable: ${agentInfo.error??agentInfo.version??'not found'}`,'BENCHMARK_AGENT_UNAVAILABLE',2)
  if(agentInfo.compatible===false)throw new StellarError(`${agent} CLI is missing benchmark-required flags: ${agentInfo.missingFlags.join(', ')}. Upgrade the CLI or use a compatible version.`,'BENCHMARK_AGENT_INCOMPATIBLE',2)
  const commit=await git(projectRoot,['rev-parse','HEAD'])
  const dirty=await git(projectRoot,['status','--porcelain']).then(v=>v?v.split(/\r?\n/).filter(line=>{const p=line.slice(3).trim().replaceAll('\\','/');return p!=='.stellar'&&!p.startsWith('.stellar/')}).length:0)
  const destination=outDir??path.join(projectRoot,'.stellar','benchmark','runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${agent}`)
  await fs.mkdir(destination,{recursive:true})
  const files=Object.fromEntries((mode==='both'?['baseline','stellar']:modes).map(condition=>[condition,path.join(destination,`${condition}.jsonl`)]))
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
      const ordered=conditionOrder(modes,mode,i,r)
      for(const [orderIndex,condition] of ordered.entries()) {
        await assertRuntimeUnchanged()
        const base=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-bench-'))
        const {worktree,cleanup}=await makeWorktree(projectRoot,base)
        let failed=true
        const diagnosticDir=path.join(destination,'diagnostics',encodeURIComponent(task.id),`${condition}-${r}`)
        await fs.mkdir(diagnosticDir,{recursive:true,mode:0o700})
        await fs.writeFile(path.join(diagnosticDir,'diagnostic.json'),JSON.stringify({mode:condition,taskId:task.id,projectRoot,worktreeRoot:worktree,agentVersion:agentInfo.version},null,2)+'\n',{mode:0o600})
        try {
          const dirs={data:path.join(base,'stellar-data'),cache:path.join(base,'stellar-cache'),logs:path.join(base,'stellar-logs')}
          const snapshot=condition!=='baseline'?await prepareBenchmarkSnapshot(projectRoot,worktree,base,commit,env):null
          const binDir=path.join(base,'bin');const stellarExecutable=await writeShim(binDir,condition,stellarBin,snapshot)
          const childEnv={...env,PATH:`${binDir}${path.delimiter}${env.PATH??''}`,STELLAR_DATA_DIR:dirs.data,STELLAR_CACHE_DIR:dirs.cache,STELLAR_LOG_DIR:dirs.logs,STELLAR_BENCH_TRACE_FILE:'',STELLAR_BENCH_INDEX_FILE:snapshot?.indexFile??''}
          let preflight={stellarAvailable:false,stellarVersion:null,projectResolved:false}
          if(condition!=='baseline') {
            const checks=[]
            for(const args of [['--version'],['status','--json'],['projects','--json']]) {
              const {stdout,stderr}=await execFileAsync(stellarExecutable,args,{cwd:worktree,env:childEnv})
              checks.push({command:['stellar',...args],stdout,stderr})
            }
            const status=JSON.parse(checks[1].stdout)
            if(status.projectId!==snapshot.projectId || status.lastIndexedHead!==commit)throw new Error('Benchmark preflight project/index mismatch')
            preflight={stellarAvailable:true,stellarVersion:checks[0].stdout.trim(),projectResolved:true,projectId:status.projectId,indexFile:status.dbPath,checks}
          }
          // Prefetch: the runner itself runs the exact command the pull condition asks the
          // agent to run, from the task prompt alone, before the agent starts.
          let prefetch=null
          if(PREFETCH_MODES.has(condition)) {
            const args=stellarContextArgs(task.prompt)
            const t0=performance.now()
            const {stdout}=await execFileAsync(stellarExecutable,args,{cwd:worktree,env:childEnv,maxBuffer:64*1024*1024})
            const localMs=Math.round(performance.now()-t0)
            const envelope=buildContextEnvelope(JSON.parse(stdout),{snapshotCommit:commit})
            // Same verbatim-source check as a pull-mode context call: only excerpts that match
            // the working tree count as inspected source; hints never do.
            const evidence=await completedEvidence({input:`stellar ${args.join(' ')}`,output:stdout,ok:true,cwd:worktree,atMs:0,via:'prefetch'})
            prefetch={envelope,localMs,reads:evidence.reads.map(read=>({...read,turn:0})),discovered:evidence.discovered}
            await fs.writeFile(path.join(diagnosticDir,'prefetch-envelope.txt'),envelope.text)
          }
          onProgress?.({phase:'start',task:task.id,mode:condition,repetition:r,completed,total})
          const result=await runAgent({agent,task:{prompt:task.prompt},mode:condition,cwd:worktree,env:childEnv,model,maxTurns:task.maxTurns,diagnosticDir,envelope:prefetch?.envelope.text??null,diagnostic:{mode:condition,taskId:task.id,agentVersion:agentInfo.version,stellarExecutable,projectRoot,worktreeRoot:worktree,...preflight,snapshot}})
          if(prefetch) {
            // Delivered source was supplied to the model before turn 1: it counts as read.
            result.metrics.sourceReads=[...prefetch.reads,...(result.metrics.sourceReads??[])]
            result.metrics.filesOpened=[...new Set([...prefetch.reads.map(read=>read.path),...(result.metrics.filesOpened??[])])].sort()
            result.metrics.filesMentioned=[...new Set([...prefetch.discovered,...(result.metrics.filesMentioned??[])])].sort()
          }
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
          const delivery=condition==='baseline'?{}:deliveryMetrics({condition,result,prefetch,expectedFiles:task.expectedFiles,answerFiles:answer.answerFiles??[]})
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
            final:result.metrics.structured??result.metrics.finalText,stderr:result.exitCode===0?'':result.stderr.slice(0,4000),
            conditionOrder:orderIndex+1,...delivery
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

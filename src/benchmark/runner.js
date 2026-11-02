import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initializeProject } from '../core/project.js'
import { syncProject } from '../indexer/sync.js'
import { runAgent, commandVersion } from './agents.js'
import { loadBenchmarkTasks, benchmarkConfigPath } from './tasks.js'
import { StellarError } from '../core/errors.js'

const execFileAsync=promisify(execFile)

async function git(root,args) { return (await execFileAsync('git',['-C',root,...args],{maxBuffer:10*1024*1024})).stdout.trim() }

async function writeShim(binDir, mode, stellarBin) {
  await fs.mkdir(binDir,{recursive:true})
  const file=path.join(binDir,process.platform==='win32'?'stellar.cmd':'stellar')
  if(process.platform==='win32') {
    const body=mode==='stellar' ? `@echo off\r\n"${process.execPath}" "${stellarBin}" %*\r\n` : '@echo off\r\necho StellarCode disabled for baseline benchmark 1>&2\r\nexit /b 64\r\n'
    await fs.writeFile(file,body)
  } else {
    const body=mode==='stellar' ? `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stellarBin)} "$@"\n` : '#!/bin/sh\necho "StellarCode disabled for baseline benchmark" >&2\nexit 64\n'
    await fs.writeFile(file,body,{mode:0o755})
  }
  return file
}

function answerFiles(structured) {
  return Array.isArray(structured?.files) ? structured.files.map(v=>String(v).replaceAll('\\','/').replace(/^\.\//,'')) : []
}

function judge(task, structured) {
  if (!task.expectedFiles.length) return {verified:false,success:null,matched:[],missing:[]}
  const got=new Set(answerFiles(structured))
  const matched=task.expectedFiles.filter(v=>got.has(v))
  const success=task.expectedMatch==='all' ? matched.length===task.expectedFiles.length : matched.length>0
  return {verified:true,success,matched,missing:task.expectedFiles.filter(v=>!got.has(v)),answerFiles:[...got]}
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

export async function runBenchmark({projectRoot,tasksFile,agent='codex',mode='both',model,limit,repeat=1,outDir,stellarBin,env=process.env,onProgress}) {
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
  let completed=0,total=tasks.length*modes.length*repeat
  for(let r=1;r<=repeat;r++) {
    for(let i=0;i<tasks.length;i++) {
      const task=tasks[i]
      const ordered=mode==='both' && (i+r)%2===1?[...modes].reverse():modes
      for(const condition of ordered) {
        const base=await fs.mkdtemp(path.join(os.tmpdir(),'stellar-bench-'))
        const {worktree,cleanup}=await makeWorktree(projectRoot,base)
        try {
          const dirs={data:path.join(base,'stellar-data'),cache:path.join(base,'stellar-cache'),logs:path.join(base,'stellar-logs')}
          const binDir=path.join(base,'bin');await writeShim(binDir,condition,stellarBin)
          const childEnv={...env,PATH:`${binDir}${path.delimiter}${env.PATH??''}`,STELLAR_DATA_DIR:dirs.data,STELLAR_CACHE_DIR:dirs.cache,STELLAR_LOG_DIR:dirs.logs}
          if(condition==='stellar') {
            const init=await initializeProject(worktree)
            await syncProject(worktree,{force:true,dirs})
            void init
          }
          onProgress?.({phase:'start',task:task.id,mode:condition,repetition:r,completed,total})
          const result=await runAgent({agent,task,mode:condition,cwd:worktree,env:childEnv,model,maxTurns:task.maxTurns})
          const verdict=judge(task,result.metrics.structured)
          const row={
            schemaVersion:1,taskId:task.id,repetition:r,category:task.category,mode:condition,agent,agentVersion:agentInfo.version,model:model??null,
            projectCommit:commit,projectDirtyCount:dirty,exitCode:result.exitCode,durationMs:result.durationMs,firstRelevantMs:result.metrics.firstRelevantMs,
            inputTokens:result.metrics.usage.inputTokens,uncachedInputTokens:result.metrics.usage.uncachedInputTokens,cachedInputTokens:result.metrics.usage.cachedInputTokens,cacheWriteInputTokens:result.metrics.usage.cacheWriteInputTokens,
            outputTokens:result.metrics.usage.outputTokens,reasoningOutputTokens:result.metrics.usage.reasoningOutputTokens,costUsd:result.metrics.costUsd,
            toolCalls:result.metrics.toolCalls,searchCalls:result.metrics.searchCalls,stellarCalls:result.metrics.stellarCalls,filesOpened:result.metrics.filesOpened.length,filesOpenedList:result.metrics.filesOpened,sourceBytesRead:result.metrics.sourceBytesRead,
            verified:verdict.verified,success:result.exitCode===0?verdict.success:false,matchedExpectedFiles:verdict.matched,missingExpectedFiles:verdict.missing,answerFiles:verdict.answerFiles??[],
            final:result.metrics.structured??result.metrics.finalText,stderr:result.exitCode===0?'':result.stderr.slice(0,4000)
          }
          await fs.appendFile(files[condition],JSON.stringify(row)+'\n')
          completed++;onProgress?.({phase:'done',task:task.id,mode:condition,repetition:r,completed,total,row})
        } finally { await cleanup() }
      }
    }
  }
  const manifest={schemaVersion:1,createdAt:new Date().toISOString(),agent,agentVersion:agentInfo.version,model:model??null,projectRoot,projectCommit:commit,projectDirtyCount:dirty,tasksFile:configFile,taskCount:tasks.length,repeat,modes,files,isolation:{freshAgentSession:true,detachedWorktree:true,stellarRulesRemovedFromWorktree:true,userMcpConfigIgnored:true,stellarIndexBuiltBeforeTimedRun:true}}
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  return {outDir:destination,files,manifest}
}

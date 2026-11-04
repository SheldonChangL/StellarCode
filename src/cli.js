#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { initializeProject } from './core/project.js'
import { openProjectStore, projectMeta } from './storage/project-store.js'
import { syncProject } from './indexer/sync.js'
import { resolveProject } from './core/runtime.js'
import { resolveAnyProject } from './core/global-runtime.js'
import { searchProject, fileDetail, related, impact, contextForTask, symbolLookup, architectureOverview, sourceExcerpt } from './query/query-service.js'
import { createWebServer } from './web/server.js'
import { createGlobalWebServer } from './web/global-server.js'
import { startMcpServer } from './mcp/server.js'
import { VERSION_LABEL } from './core/version.js'
import { benchmarkReport, writeBenchmarkReport } from './benchmark/report.js'
import { initBenchmarkConfig, benchmarkConfigPath } from './benchmark/tasks.js'
import { runBenchmark, benchmarkDoctor } from './benchmark/runner.js'
import { writeComparison } from './benchmark/generalization-report.js'
import { runLocalLatency } from './benchmark/latency.js'
import { lintTaskSet } from './benchmark/tasklint.js'
import { decomposeDiagnosticDirectory } from './benchmark/campaign.js'
import { readJsonl } from './benchmark/report.js'
import { installAgentRule, AGENT_RULE } from './core/agent-rule.js'
import { appDirectories } from './platform/paths.js'
import { projectSummaries, removeRegisteredProject, garbageCollect, reconcileProjects } from './storage/registry.js'
import { StellarError } from './core/errors.js'
import { traceCliResult } from './core/benchmark-trace.js'

function help() {
  console.log(`${VERSION_LABEL}\n\nUsage:\n  stellar init [path] [--dry-run] [--install-agent-rule]\n  stellar projects [--json]\n  stellar ui [--port 7432]\n  stellar scan [path] [--json]\n  stellar sync [path] [--json]\n  stellar status [path] [--project NAME_OR_ID] [--json]\n  stellar search <query> [path] [--project NAME_OR_ID] [--json]\n  stellar find <query> [path] [--project NAME_OR_ID] [--json]  # alias\n  stellar file <relative-path> [project-path] [--project NAME_OR_ID] [--json]\n  stellar symbol <query> [project-path] [--project NAME_OR_ID] [--json]\n  stellar related <path-or-symbol> [project-path] [--project NAME_OR_ID] [--json]\n  stellar impact <path-or-symbol> [project-path] [--project NAME_OR_ID] [--depth N] [--json]\n  stellar context <task> [project-path] [--compact] [--with-source] [--max-files N] [--max-lines N] [--max-bytes N] [--project NAME_OR_ID] [--json]\n  stellar source <relative-path> [project-path] [--project NAME_OR_ID] [--lines START:END] [--json]\n  stellar architecture [project-path] [--project NAME_OR_ID] [--json]\n  stellar remove <project> [--purge] [--json]\n  stellar gc [--purge-orphaned] [--json]\n  stellar mcp [project-path]\n  stellar serve [project-path] [--port 7432]  # legacy single-project when path is supplied; otherwise global UI\n  stellar agent-rule\n  stellar benchmark init [project-path] [--force]\n  stellar benchmark doctor [--agent claude|codex|all] [--json]\n  stellar benchmark run [project-path] --agent claude|codex [--mode baseline|stellar|both] [--model MODEL] [--repeat N] [--limit N] [--tasks FILE] [--out DIR] [--keep-worktree-on-failure] [--json]\n  stellar benchmark report <baseline.jsonl> <stellar.jsonl> [--html FILE] [--json-out FILE]\n  stellar benchmark compare [NAME=]<report.json>... [--html FILE] [--json-out FILE]\n  stellar benchmark latency [project-path] --tasks FILE [--repeat N] [--json-out FILE]\n  stellar benchmark lint-tasks <tasks.json> [--repo PATH] [--commit REV] [--json]\n  stellar benchmark first-relevant <run-dir> [--json-out FILE]\n\nGlobal v0.5 workflow:\n  Run 'stellar init' once per repo. Then run 'stellar ui' from anywhere.\n`)
}

function hasFlag(args, flag) { return args.includes(flag) }
function flagValue(args, flag, fallback) { const i=args.indexOf(flag); return i>=0 && args[i+1] ? args[i+1] : fallback }
function positional(args) { const out=[]; for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){if(!['--json','--dry-run','--install-agent-rule','--purge','--purge-orphaned','--force','--keep-worktree-on-failure','--compact','--with-source'].includes(args[i]))i++;continue}out.push(args[i])} return out }
function print(value, json = false) {
  traceCliResult(process.argv[2], process.argv.slice(3), value)
  if (json) console.log(JSON.stringify(value, null, 2))
  else if (typeof value === 'string') console.log(value)
  else console.log(JSON.stringify(value, null, 2))
}
function projectReference(args, fallback) { return flagValue(args, '--project', fallback) }

async function cmdInit(args) {
  const pos = positional(args)
  const root = path.resolve(pos[0] ?? process.cwd())
  const dryRun = hasFlag(args, '--dry-run')
  const result = await initializeProject(root, { dryRun })
  if (dryRun) {
    console.log(`Dry run: would initialize ${root}\nProject ID: ${result.metadata.projectId}\nNo files were written.`)
    return
  }
  const { db, registration } = await openProjectStore(root, result.metadata)
  db.close()
  let rules=[]
  if (hasFlag(args, '--install-agent-rule')) rules = await installAgentRule(root)
  console.log(`${result.created ? 'Initialized' : 'Already initialized'} StellarCode project\nProject: ${root}\nProject ID: ${result.metadata.projectId}\nIndex DB: ${registration.db_path}${rules.length?`\nAgent rule: ${rules.join(', ')}`:''}`)
}

async function cmdProjects(args) {
  if(process.env.STELLAR_BENCH_INDEX_FILE) {
    const {root,metadata}=await resolveProject()
    const {db,registration}=await openProjectStore(root,metadata)
    const meta=projectMeta(db);db.close()
    return print([{projectId:metadata.projectId,path:root,dbPath:registration.db_path,lastIndexedHead:meta.last_indexed_head,readOnly:true}],hasFlag(args,'--json'))
  }
  const rows = await projectSummaries()
  if (hasFlag(args,'--json')) return print(rows,true)
  if (!rows.length) return console.log('No StellarCode projects registered. Run `stellar init` inside a repository.')
  const nameWidth = Math.min(28, Math.max(4, ...rows.map(r=>r.name.length)))
  console.log(`${'NAME'.padEnd(nameWidth)}  STATUS     FILES  LAST INDEXED  PATH`)
  for (const row of rows) {
    const when = row.lastIndexedAt ? new Date(row.lastIndexedAt).toLocaleString() : 'never'
    console.log(`${row.name.slice(0,nameWidth).padEnd(nameWidth)}  ${row.status.padEnd(10)} ${String(row.counts.files).padStart(5)}  ${when.padEnd(18)} ${row.path}`)
  }
}

async function cmdStatus(args) {
  const pos = positional(args)
  const ref = projectReference(args, pos[0] ?? process.cwd())
  const { root, metadata } = await resolveAnyProject(ref)
  const { db, registration } = await openProjectStore(root, metadata)
  const meta = projectMeta(db)
  const counts = {
    files: db.prepare('SELECT COUNT(*) c FROM files').get().c,
    symbols: db.prepare('SELECT COUNT(*) c FROM symbols').get().c,
    edges: db.prepare('SELECT COUNT(*) c FROM edges').get().c,
    warnings: db.prepare('SELECT COUNT(*) c FROM index_warnings').get().c
  }
  db.close()
  const result = { root, projectId:metadata.projectId, graphVersion:meta.graph_version, lastIndexedHead:meta.last_indexed_head, dbPath:registration.db_path, counts, appDirectories:appDirectories() }
  print(result, hasFlag(args,'--json'))
}

async function queryRoot(args, fallback) {
  const ref = projectReference(args, fallback)
  return (await resolveAnyProject(ref)).root
}

async function main() {
  const [, , command, ...args] = process.argv
  if (!command || ['help','--help','-h'].includes(command)) return help()
  if (command === '--version' || command === '-v') return console.log(VERSION_LABEL)
  if (command === 'init') return cmdInit(args)
  if (command === 'projects') return cmdProjects(args)
  if (command === 'ui') {
    await reconcileProjects()
    const {server,url}=await createGlobalWebServer({port:Number(flagValue(args,'--port',7432))})
    console.log(`✦ StellarCode Global\n${url}\nAll registered projects are available from this one service.\nPress Ctrl+C to stop.`)
    const stop=()=>server.close(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop)
    return
  }
  if (command === 'scan' || command === 'sync') {
    const pos=positional(args)
    const root = await queryRoot(args, pos[0] ?? process.cwd())
    const result = await syncProject(root, { force: command === 'scan' })
    return print(result, hasFlag(args,'--json'))
  }
  if (command === 'status') return cmdStatus(args)
  if (command === 'find' || command === 'search') {
    const pos=positional(args); if(!pos[0])throw new StellarError(`${command} requires a query`,'USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    return print(await searchProject(root,pos[0],{limit:10}),hasFlag(args,'--json'))
  }
  if (command === 'file') {
    const pos=positional(args); if(!pos[0])throw new StellarError('file requires a project-relative path','USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    return print(await fileDetail(root,pos[0]),hasFlag(args,'--json'))
  }
  if (command === 'symbol') {
    const pos=positional(args); if(!pos[0])throw new StellarError('symbol requires a query','USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    return print(await symbolLookup(root,pos[0]),hasFlag(args,'--json'))
  }
  if (command === 'related') {
    const pos=positional(args); if(!pos[0])throw new StellarError('related requires a target','USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    return print(await related(root,pos[0]),hasFlag(args,'--json'))
  }
  if (command === 'impact') {
    const pos=positional(args); if(!pos[0])throw new StellarError('impact requires a target','USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    return print(await impact(root,pos[0],{depth:Number(flagValue(args,'--depth',3))}),hasFlag(args,'--json'))
  }
  if (command === 'context') {
    const pos=positional(args); if(!pos[0])throw new StellarError('context requires a task string','USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    return print(await contextForTask(root,pos[0],{compact:hasFlag(args,'--compact'),depth:Number(flagValue(args,'--depth',0)),maxFiles:Number(flagValue(args,'--max-files',3)),maxLines:Number(flagValue(args,'--max-lines',300)),maxBytes:Number(flagValue(args,'--max-bytes',12000)),withSource:hasFlag(args,'--with-source')}),hasFlag(args,'--json'))
  }
  if (command === 'source') {
    const pos=positional(args); if(!pos[0])throw new StellarError('source requires a project-relative path','USAGE',2)
    const root=await queryRoot(args,pos[1]??process.cwd())
    const result=await sourceExcerpt(root,pos[0],{lines:flagValue(args,'--lines',undefined)})
    if(!result)throw new StellarError(`Indexed source file not found: ${pos[0]}`,'SOURCE_NOT_FOUND',2)
    return print(result,hasFlag(args,'--json'))
  }
  if (command === 'architecture') {
    const pos=positional(args);const root=await queryRoot(args,pos[0]??process.cwd())
    return print(await architectureOverview(root),hasFlag(args,'--json'))
  }
  if (command === 'remove') {
    const pos=positional(args);if(!pos[0])throw new StellarError('remove requires a project name or UUID','USAGE',2)
    return print(await removeRegisteredProject(pos[0],{purge:hasFlag(args,'--purge')}),hasFlag(args,'--json'))
  }
  if (command === 'gc') return print(await garbageCollect({purgeOrphaned:hasFlag(args,'--purge-orphaned')}),hasFlag(args,'--json'))
  if (command === 'serve') {
    const pos=positional(args)
    if (!pos[0]) {
      const {server,url}=await createGlobalWebServer({port:Number(flagValue(args,'--port',7432))})
      console.log(`✦ StellarCode Global\n${url}\nPress Ctrl+C to stop.`)
      const stop=()=>server.close(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop)
      return
    }
    const root=(await resolveProject(pos[0])).root
    await syncProject(root)
    const {server,url}=await createWebServer(root,{port:Number(flagValue(args,'--port',7432))})
    console.log(`✦ StellarCode Universe (legacy single-project mode)\n${url}\nProject: ${root}\nPress Ctrl+C to stop.`)
    const stop=()=>server.close(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop)
    return
  }
  if (command === 'mcp') {
    const pos=positional(args)
    const root = pos[0] ? (await resolveAnyProject(pos[0])).root : null
    return startMcpServer({projectPath:root})
  }
  if (command === 'agent-rule') return console.log(AGENT_RULE)
  if (command === 'benchmark') {
    const pos=positional(args), sub=pos[0]
    if(sub==='init') {
      const root=await queryRoot(args,pos[1]??process.cwd())
      const result=await initBenchmarkConfig(root,{force:hasFlag(args,'--force')})
      return print({...result,message:result.created?'Benchmark task template created. Edit expectedFiles and set enabled=true for real tasks.':'Benchmark task file already exists.'},hasFlag(args,'--json'))
    }
    if(sub==='doctor') {
      const requested=flagValue(args,'--agent','all')
      const agents=requested==='all'?['claude','codex']:[requested]
      return print(await benchmarkDoctor({agents}),hasFlag(args,'--json'))
    }
    if(sub==='run') {
      const root=await queryRoot(args,pos[1]??process.cwd())
      const agent=flagValue(args,'--agent',null)
      if(!agent)throw new StellarError('benchmark run requires --agent claude|codex','USAGE',2)
      const result=await runBenchmark({
        projectRoot:root,agent,repository:flagValue(args,'--repository',undefined),mode:flagValue(args,'--mode','both'),model:flagValue(args,'--model',undefined),repeat:Number(flagValue(args,'--repeat',1)),limit:Number(flagValue(args,'--limit',0)),
        keepWorktreeOnFailure:hasFlag(args,'--keep-worktree-on-failure'),tasksFile:flagValue(args,'--tasks',undefined),outDir:flagValue(args,'--out',undefined),
        onProgress:hasFlag(args,'--json')?undefined:e=>{if(e.phase==='start')console.error(`[${e.completed+1}/${e.total}] ${e.mode} ${e.task}`)}
      })
      if(result.files.baseline&&result.files.stellar) {
        try {
          const report=await writeBenchmarkReport(result.files.baseline,result.files.stellar,{jsonFile:path.join(result.outDir,'report.json'),htmlFile:path.join(result.outDir,'report.html')})
          result.report={passGate:report.passGate,delta:report.delta,correctnessVerified:report.correctnessVerified}
        } catch {}
      }
      return print(result,hasFlag(args,'--json'))
    }
    if(sub==='report'&&pos[1]&&pos[2]) {
      const report=await writeBenchmarkReport(pos[1],pos[2],{jsonFile:flagValue(args,'--json-out',undefined),htmlFile:flagValue(args,'--html',undefined)})
      return print(report,true)
    }
    if(sub==='compare') {
      const specs=pos.slice(1)
      if(!specs.length)throw new StellarError('Usage: stellar benchmark compare [NAME=]<report.json>... [--html FILE] [--json-out FILE]','USAGE',2)
      return print(await writeComparison(specs,{jsonFile:flagValue(args,'--json-out',undefined),htmlFile:flagValue(args,'--html',undefined)}),true)
    }
    if(sub==='latency') {
      const tasksFile=flagValue(args,'--tasks',null)
      if(!tasksFile)throw new StellarError('benchmark latency requires --tasks FILE','USAGE',2)
      const root=path.resolve(pos[1]??process.cwd())
      const result=await runLocalLatency({projectRoot:root,tasksFile:path.resolve(tasksFile),repeat:Number(flagValue(args,'--repeat',5)),onProgress:e=>console.error(`[${e.done}/${e.total}] ${e.task}`)})
      const out=flagValue(args,'--json-out',undefined)
      if(out)await fs.writeFile(out,JSON.stringify(result,null,2)+'\n')
      return print(result,true)
    }
    if(sub==='lint-tasks'&&pos[1]) {
      const result=await lintTaskSet(pos[1],{repoRoot:flagValue(args,'--repo',null),commit:flagValue(args,'--commit','HEAD')})
      if(!result.ok)process.exitCode=1
      return print(result,true)
    }
    if(sub==='first-relevant'&&pos[1]) {
      const runDir=path.resolve(pos[1]),rows=[]
      const tasks=JSON.parse(await fs.readFile(JSON.parse(await fs.readFile(path.join(runDir,'manifest.json'),'utf8')).tasksFile,'utf8')).tasks
      for(const mode of ['baseline','stellar']) {
        for(const row of await readJsonl(path.join(runDir,`${mode}.jsonl`))) {
          const task=tasks.find(t=>t.id===row.taskId)
          const decomposition=await decomposeDiagnosticDirectory(path.join(runDir,'diagnostics',encodeURIComponent(row.taskId),`${mode}-${row.repetition??1}`),{expectedFiles:task?.expectedFiles??[],firstRelevantMs:row.firstRelevantMs})
          rows.push({mode,taskId:row.taskId,repetition:row.repetition??1,category:row.category??null,firstRelevantMs:row.firstRelevantMs??null,durationMs:row.durationMs??null,toolCalls:row.toolCalls??null,...(decomposition??{decomposition:'unavailable'})})
        }
      }
      const out=flagValue(args,'--json-out',undefined),result={runDir,rows}
      if(out)await fs.writeFile(out,JSON.stringify(result,null,2)+'\n')
      return print(result,true)
    }
    throw new StellarError('Usage: stellar benchmark init|doctor|run|report|compare|latency|lint-tasks|first-relevant ...','USAGE',2)
  }
  throw new StellarError(`Unknown command: ${command}`,'USAGE',2)
}

main().catch(error=>{
  if (error instanceof StellarError) {
    console.error(`StellarCode: ${error.message}`)
    process.exitCode=error.exitCode
  } else {
    console.error(error.stack||error.message)
    process.exitCode=1
  }
})

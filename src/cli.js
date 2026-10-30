#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { initializeProject, readProjectMetadata, findProjectRoot } from './core/project.js'
import { openProjectStore, projectMeta } from './storage/project-store.js'
import { syncProject } from './indexer/sync.js'
import { resolveProject } from './core/runtime.js'
import { searchProject, fileDetail, related, impact, contextForTask, symbolLookup, architectureOverview } from './query/query-service.js'
import { createWebServer } from './web/server.js'
import { startMcpServer } from './mcp/server.js'
import { benchmarkReport } from './benchmark/report.js'
import { installAgentRule, AGENT_RULE } from './core/agent-rule.js'
import { appDirectories } from './platform/paths.js'
import { StellarError } from './core/errors.js'

function help() {
  console.log(`StellarCode 0.4.0\n\nUsage:\n  stellar init [path] [--dry-run] [--install-agent-rule]\n  stellar scan [path] [--json]\n  stellar sync [path] [--json]\n  stellar status [path] [--json]\n  stellar search <query> [path] [--json]\n  stellar find <query> [path] [--json]  # alias\n  stellar file <relative-path> [project-path] [--json]\n  stellar symbol <query> [project-path] [--json]\n  stellar related <path-or-symbol> [project-path] [--json]\n  stellar impact <path-or-symbol> [project-path] [--depth N] [--json]\n  stellar context <task> [project-path] [--json]\n  stellar architecture [project-path] [--json]\n  stellar serve [path] [--port 7432]\n  stellar mcp [path]\n  stellar agent-rule\n  stellar benchmark report <baseline.jsonl> <stellar.jsonl>\n`)
}

function hasFlag(args, flag) { return args.includes(flag) }
function flagValue(args, flag, fallback) { const i=args.indexOf(flag); return i>=0 && args[i+1] ? args[i+1] : fallback }
function positional(args) { const out=[]; for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){if(!['--json','--dry-run','--install-agent-rule'].includes(args[i]))i++;continue}out.push(args[i])} return out }
function print(value, json = false) {
  if (json) console.log(JSON.stringify(value, null, 2))
  else if (typeof value === 'string') console.log(value)
  else console.log(JSON.stringify(value, null, 2))
}

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

async function cmdStatus(args) {
  const rootArg = positional(args)[0] ?? process.cwd()
  const { root, metadata } = await resolveProject(rootArg)
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

async function main() {
  const [, , command, ...args] = process.argv
  if (!command || ['help','--help','-h'].includes(command)) return help()
  if (command === 'init') return cmdInit(args)
  if (command === 'scan' || command === 'sync') {
    const root = (await resolveProject(positional(args)[0] ?? process.cwd())).root
    const result = await syncProject(root, { force: command === 'scan' })
    return print(result, hasFlag(args,'--json'))
  }
  if (command === 'status') return cmdStatus(args)
  if (command === 'find' || command === 'search') {
    const pos=positional(args); if(!pos[0])throw new StellarError(`${command} requires a query`,'USAGE',2)
    return print(await searchProject(pos[1]??process.cwd(),pos[0],{limit:10}),hasFlag(args,'--json'))
  }
  if (command === 'file') {
    const pos=positional(args); if(!pos[0])throw new StellarError('file requires a project-relative path','USAGE',2)
    return print(await fileDetail(pos[1]??process.cwd(),pos[0]),hasFlag(args,'--json'))
  }
  if (command === 'symbol') {
    const pos=positional(args); if(!pos[0])throw new StellarError('symbol requires a query','USAGE',2)
    return print(await symbolLookup(pos[1]??process.cwd(),pos[0]),hasFlag(args,'--json'))
  }
  if (command === 'related') {
    const pos=positional(args); if(!pos[0])throw new StellarError('related requires a target','USAGE',2)
    return print(await related(pos[1]??process.cwd(),pos[0]),hasFlag(args,'--json'))
  }
  if (command === 'impact') {
    const pos=positional(args); if(!pos[0])throw new StellarError('impact requires a target','USAGE',2)
    return print(await impact(pos[1]??process.cwd(),pos[0],{depth:Number(flagValue(args,'--depth',3))}),hasFlag(args,'--json'))
  }
  if (command === 'context') {
    const pos=positional(args); if(!pos[0])throw new StellarError('context requires a task string','USAGE',2)
    return print(await contextForTask(pos[1]??process.cwd(),pos[0],{limit:8}),hasFlag(args,'--json'))
  }
  if (command === 'architecture') {
    const root=(await resolveProject(positional(args)[0]??process.cwd())).root
    return print(await architectureOverview(root),hasFlag(args,'--json'))
  }
  if (command === 'serve') {
    const root=(await resolveProject(positional(args)[0]??process.cwd())).root
    await syncProject(root)
    const {server,url}=await createWebServer(root,{port:Number(flagValue(args,'--port',7432))})
    console.log(`✦ StellarCode Universe\n${url}\nProject: ${root}\nPress Ctrl+C to stop.`)
    const stop=()=>server.close(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop)
    return
  }
  if (command === 'mcp') {
    const root=(await resolveProject(positional(args)[0]??process.cwd())).root
    return startMcpServer({projectPath:root})
  }
  if (command === 'agent-rule') return console.log(AGENT_RULE)
  if (command === 'benchmark') {
    const pos=positional(args)
    if(pos[0]!=='report'||!pos[1]||!pos[2])throw new StellarError('Usage: stellar benchmark report <baseline.jsonl> <stellar.jsonl>','USAGE',2)
    return print(await benchmarkReport(pos[1],pos[2]),true)
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

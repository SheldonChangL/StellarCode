import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeProject, readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { syncProject } from '../src/indexer/sync.js'
import { reconcileProjects, projectSummaries, projectRegistration, garbageCollect } from '../src/storage/registry.js'
import { createGlobalWebServer } from '../src/web/global-server.js'
import { handleMcpMessage } from '../src/mcp/server.js'
import { makeWorkspace } from './helpers.js'

async function initAndScan(w) {
  const init = await initializeProject(w.repo)
  const { db } = await openProjectStore(w.repo, init.metadata, { dirs:w.dirs })
  db.close()
  await syncProject(w.repo, { dirs:w.dirs, force:true })
  return init.metadata
}

test('v0.5 registry automatically transitions missing -> orphaned without deleting index', async () => {
  const w=await makeWorkspace()
  try {
    const meta=await initAndScan(w)
    const before=await projectRegistration(meta.projectId,{dirs:w.dirs})
    await fs.access(before.db_path)
    await fs.rm(w.repo,{recursive:true,force:true})
    const now=Date.now()
    let rec=await reconcileProjects({dirs:w.dirs,nowMs:now,orphanAfterMs:1000})
    assert.equal(rec.projects[0].status,'missing')
    assert.ok(rec.projects[0].missing_since)
    rec=await reconcileProjects({dirs:w.dirs,nowMs:now+1500,orphanAfterMs:1000})
    assert.equal(rec.projects[0].status,'orphaned')
    await fs.access(before.db_path)
  } finally { await w.cleanup() }
})

test('moving a registered repo is recovered automatically when StellarCode is used at the new path', async () => {
  const w=await makeWorkspace()
  try {
    const meta=await initAndScan(w)
    const moved=path.join(w.base,'repo-moved')
    await fs.rename(w.repo,moved)
    const movedMeta=await readProjectMetadata(moved)
    assert.equal(movedMeta.projectId,meta.projectId)
    const {db}=await openProjectStore(moved,movedMeta,{dirs:w.dirs});db.close()
    const row=await projectRegistration(meta.projectId,{dirs:w.dirs})
    assert.equal(row.repo_path,moved)
    assert.notEqual(row.status,'missing')
  } finally { await w.cleanup() }
})

test('global UI lists projects and lazily syncs a selected repository', async () => {
  const w=await makeWorkspace();let server
  try {
    const meta=await initAndScan(w)
    const created=await createGlobalWebServer({dirs:w.dirs,port:0,host:'127.0.0.1',syncMinIntervalMs:0,reconcileIntervalMs:60_000});server=created.server
    const dashboard=await (await fetch(created.url+'/')).text()
    assert.match(dashboard,/Your indexed codebases/)
    let projects=await (await fetch(created.url+'/api/projects')).json()
    assert.equal(projects.length,1)
    assert.equal(projects[0].projectId,meta.projectId)
    const universe=await (await fetch(`${created.url}/project/${meta.projectId}`)).text()
    assert.match(universe,/version">0\.5/)

    await fs.writeFile(path.join(w.repo,'src','lazy-added.ts'),'export function lazyAdded(){ return 1 }\n')
    const graph=await (await fetch(`${created.url}/api/projects/${meta.projectId}/graph`)).json()
    assert.ok(graph.nodes.some(node=>node.id==='src/lazy-added.ts'))

    projects=await (await fetch(created.url+'/api/projects')).json()
    assert.equal(projects[0].status,'active')
  } finally { if(server)await new Promise(resolve=>server.close(resolve));await w.cleanup() }
})

test('global UI marks a deleted repository missing and refuses project queries while preserving registry', async () => {
  const w=await makeWorkspace();let server
  try {
    const meta=await initAndScan(w)
    const created=await createGlobalWebServer({dirs:w.dirs,port:0,host:'127.0.0.1',syncMinIntervalMs:0,reconcileIntervalMs:60_000});server=created.server
    await fs.rm(w.repo,{recursive:true,force:true})
    const response=await fetch(`${created.url}/api/projects/${meta.projectId}/graph`)
    assert.equal(response.status,404)
    const projects=await (await fetch(created.url+'/api/projects')).json()
    assert.equal(projects[0].status,'missing')
  } finally { if(server)await new Promise(resolve=>server.close(resolve));await w.cleanup() }
})

test('global MCP can discover projects and query by project UUID outside a repo', async () => {
  const w=await makeWorkspace()
  try {
    const meta=await initAndScan(w)
    const projects=await handleMcpMessage({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'stellar_projects',arguments:{}}},{defaultProject:null,queryOptions:{dirs:w.dirs}})
    assert.equal(projects.result.isError,false)
    assert.equal(projects.result.structuredContent.result[0].projectId,meta.projectId)
    const search=await handleMcpMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'stellar_search',arguments:{query:'login',projectId:meta.projectId}}},{defaultProject:null,queryOptions:{dirs:w.dirs}})
    assert.equal(search.result.isError,false)
    assert.ok(search.result.structuredContent.result.some(row=>row.path==='src/auth/AuthService.ts'))
  } finally { await w.cleanup() }
})

test('gc preserves orphan indexes by default and purges only when explicitly requested', async () => {
  const w=await makeWorkspace()
  try {
    const meta=await initAndScan(w)
    const row=await projectRegistration(meta.projectId,{dirs:w.dirs})
    await fs.rm(w.repo,{recursive:true,force:true})
    const now=Date.now()
    await reconcileProjects({dirs:w.dirs,nowMs:now,orphanAfterMs:0})
    let result=await garbageCollect({dirs:w.dirs,nowMs:now,orphanAfterMs:0})
    assert.equal(result.purged,0)
    await fs.access(row.db_path)
    let summaries=await projectSummaries({dirs:w.dirs,nowMs:now,orphanAfterMs:0})
    assert.equal(summaries.length,1)
    result=await garbageCollect({dirs:w.dirs,nowMs:now,orphanAfterMs:0,purgeOrphaned:true})
    assert.equal(result.purged,1)
    summaries=await projectSummaries({dirs:w.dirs,nowMs:now,orphanAfterMs:0})
    assert.equal(summaries.length,0)
    await assert.rejects(fs.access(row.db_path))
  } finally { await w.cleanup() }
})

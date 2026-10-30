import test from 'node:test'
import assert from 'node:assert/strict'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { createWebServer } from '../src/web/server.js'
import { makeWorkspace } from './helpers.js'

test('local read-only API and universe shell are served from real index', async () => {
  const w=await makeWorkspace();let server
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const created=await createWebServer(w.repo,{port:0,host:'127.0.0.1',dirs:w.dirs});server=created.server
    const html=await (await fetch(created.url+'/')).text();assert.match(html,/StellarCode Universe/)
    const graph=await (await fetch(created.url+'/api/graph')).json();assert.equal(graph.nodes.length,8);assert.ok(graph.edges.length>0)
    const detail=await (await fetch(created.url+'/api/file?path='+encodeURIComponent('src/auth/AuthService.ts'))).json();assert.equal(detail.name,'AuthService.ts')
    const impacts=await (await fetch(created.url+'/api/impact?target='+encodeURIComponent('src/auth/TokenStore.ts'))).json();assert.ok(impacts.direct>0)
  } finally { if(server)await new Promise(r=>server.close(r));await w.cleanup() }
})

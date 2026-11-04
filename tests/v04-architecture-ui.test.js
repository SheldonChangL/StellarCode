import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { classifyArchitecture, hierarchyForPath } from '../src/query/architecture.js'
import { architectureOverview, graphData, contextForTask } from '../src/query/query-service.js'
import { createWebServer } from '../src/web/server.js'
import { makeWorkspace } from './helpers.js'
import { VERSION_LABEL } from '../src/core/version.js'

const execFileAsync = promisify(execFile)


test('installed CLI wrapper suppresses only the sqlite experimental warning on help', async () => {
  const bin = new URL('../bin/stellar.js', import.meta.url)
  const result = await execFileAsync(process.execPath, [bin.pathname, 'help'])
  assert.equal(result.stdout.split('\n')[0], VERSION_LABEL)
  assert.equal(result.stderr, '')
})

test('v0.4 architecture classifier separates app entry from nested module entry', () => {
  const app = classifyArchitecture({ path:'src/index.ts', name:'index.ts', is_test:0 })
  const barrel = classifyArchitecture({ path:'src/lib/llm/index.ts', name:'index.ts', is_test:0 })
  assert.equal(app.role, 'application-entry')
  assert.equal(barrel.role, 'module-entry')
  assert.deepEqual(hierarchyForPath('src/lib/llm/index.ts'), { galaxy:'src', module:'src/lib/llm' })
})

test('v0.4 graph exposes galaxy/module hierarchy and architecture roles', async () => {
  const w=await makeWorkspace()
  try {
    await fs.mkdir(path.join(w.repo,'src','lib','llm'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'src','lib','llm','index.ts'),"export function createProvider() { return 'ok' }\n")
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const graph=await graphData(w.repo,{dirs:w.dirs,sync:false})
    assert.ok(graph.galaxies.some(g=>g.id==='src'))
    assert.ok(graph.modules.some(m=>m.id==='src/lib/llm'))
    assert.equal(graph.nodes.find(n=>n.id==='src/index.ts').role,'application-entry')
    assert.equal(graph.nodes.find(n=>n.id==='src/lib/llm/index.ts').role,'module-entry')
    const overview=await architectureOverview(w.repo,{dirs:w.dirs,sync:false})
    assert.equal(overview.entries[0]?.path,'src/index.ts')
    assert.ok(!overview.entries.some(e=>e.path==='src/lib/llm/index.ts'))
  } finally { await w.cleanup() }
})

test('architecture context returns an app entry plus structural core instead of nested barrel files', async () => {
  const w=await makeWorkspace()
  try {
    await fs.mkdir(path.join(w.repo,'src','lib','llm'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'src','lib','llm','index.ts'),"export function provider() {}\n")
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const context=await contextForTask(w.repo,'找出這個專案的主要入口與核心模組',{dirs:w.dirs,sync:false})
    assert.equal(context.primary[0]?.path,'src/index.ts')
    assert.equal(context.primary[0]?.role,'application-entry')
    assert.ok(!context.primary.slice(0,2).some(v=>v.path==='src/lib/llm/index.ts'))
  } finally { await w.cleanup() }
})

test('v0.4 web shell is galaxy-first and architecture API is available', async () => {
  const w=await makeWorkspace();let server
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const created=await createWebServer(w.repo,{port:0,host:'127.0.0.1',dirs:w.dirs});server=created.server
    const html=await (await fetch(created.url+'/')).text()
    assert.match(html,/StellarCode Universe/)
    assert.match(html,/version">0\.5/)
    const architecture=await (await fetch(created.url+'/api/architecture')).json()
    assert.ok(Array.isArray(architecture.entries))
    assert.ok(Array.isArray(architecture.modules))
  } finally { if(server)await new Promise(resolve=>server.close(resolve));await w.cleanup() }
})

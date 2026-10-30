import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeProject, readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { syncProject } from '../src/indexer/sync.js'
import { searchProject, fileDetail, related, impact, contextForTask } from '../src/query/query-service.js'
import { makeWorkspace, snapshotGraph } from './helpers.js'

test('full index extracts known TS/JS/Python symbols and dependencies', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    const r=await syncProject(w.repo,{dirs:w.dirs,force:true})
    assert.equal(r.files,8)
    assert.ok(r.symbols>=20)
    const metadata=await readProjectMetadata(w.repo)
    const {db}=await openProjectStore(w.repo,metadata,{dirs:w.dirs})
    const names=db.prepare('SELECT qualified_name FROM symbols ORDER BY qualified_name').all().map(r=>r.qualified_name)
    for(const expected of ['AuthService','AuthService.login','AuthService.refreshToken','TokenStore','SessionManager','SessionManager.restore','create_session']) assert.ok(names.includes(expected),expected)
    const dep=db.prepare("SELECT 1 ok FROM edges WHERE source_id='src/auth/AuthService.ts' AND target_id='src/auth/TokenStore.ts' AND edge_type='imports'").get()
    assert.ok(dep?.ok)
    const testEdge=db.prepare("SELECT 1 ok FROM edges WHERE source_id='tests/auth/AuthService.test.ts' AND target_id='src/auth/AuthService.ts' AND edge_type='tests'").get()
    assert.ok(testEdge?.ok)
    db.close()
  } finally { await w.cleanup() }
})

test('incremental sync is graph-equivalent to clean full reindex', async () => {
  const w=await makeWorkspace()
  try {
    const init=await initializeProject(w.repo)
    await syncProject(w.repo,{dirs:w.dirs,force:true})
    await fs.appendFile(path.join(w.repo,'src/auth/AuthService.ts'),'\nexport const AUTH_VERSION = 2\n')
    await fs.writeFile(path.join(w.repo,'src/auth/Session.ts'),"import { TokenStore } from './TokenStore'\nexport function restoreSession(store: TokenStore) { return store.read() }\n")
    await fs.rm(path.join(w.repo,'src/ui/LoginPage.tsx'))
    const inc=await syncProject(w.repo,{dirs:w.dirs})
    assert.equal(inc.added,1);assert.equal(inc.modified,1);assert.equal(inc.deleted,1)
    const metadata=await readProjectMetadata(w.repo)
    let opened=await openProjectStore(w.repo,metadata,{dirs:w.dirs})
    const incremental=snapshotGraph(opened.db)
    const dbDir=path.dirname(opened.registration.db_path);opened.db.close()
    await fs.rm(dbDir,{recursive:true,force:true})
    await syncProject(w.repo,{dirs:w.dirs,force:true})
    opened=await openProjectStore(w.repo,metadata,{dirs:w.dirs})
    const full=snapshotGraph(opened.db);opened.db.close()
    assert.deepEqual(incremental,full)
  } finally { await w.cleanup() }
})



test('warm no-change sync preserves graph version and reparses nothing', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo)
    const first=await syncProject(w.repo,{dirs:w.dirs,force:true})
    const second=await syncProject(w.repo,{dirs:w.dirs})
    assert.equal(second.noChange,true)
    assert.equal(second.changedFiles,0)
    assert.equal(second.graphVersion,first.graphVersion)
  } finally { await w.cleanup() }
})

test('query service narrows search, related, impact and context', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const opts={dirs:w.dirs}
    const hits=await searchProject(w.repo,'refresh token',{...opts,limit:10})
    assert.ok(hits.some(h=>h.path==='src/auth/AuthService.ts'))
    const detail=await fileDetail(w.repo,'src/auth/AuthService.ts',opts)
    assert.ok(detail.dependsOn.some(d=>d.path==='src/auth/TokenStore.ts'))
    const rel=await related(w.repo,'src/auth/AuthService.ts',opts)
    assert.ok(rel.incoming.some(d=>d.path==='src/ui/LoginPage.tsx'))
    const imp=await impact(w.repo,'src/auth/TokenStore.ts',{...opts,depth:3})
    assert.ok(imp.nodes.some(n=>n.path==='src/auth/AuthService.ts'))
    const ctx=await contextForTask(w.repo,'fix refresh token retry after 401',{...opts,limit:8})
    assert.ok(ctx.primary.some(v=>v.path==='src/auth/AuthService.ts'))
    assert.ok(ctx.tests.some(v=>v.path==='tests/auth/AuthService.test.ts'))
    assert.ok(ctx.primary.length+ctx.related.length+ctx.tests.length<=8)
  } finally { await w.cleanup() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeProject, readProjectMetadata } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { contextForTask } from '../src/query/query-service.js'
import { INDEXER_VERSION } from '../src/core/constants.js'
import { makeWorkspace } from './helpers.js'

test('v0.5.4 JS named import bindings create imported-symbol references', async () => {
  const w=await makeWorkspace()
  try {
    await fs.writeFile(path.join(w.repo,'src','helper.ts'),'export function createSession(user) {\n  return user\n}\n')
    await fs.writeFile(path.join(w.repo,'src','flow.ts'),"import { createSession as makeSession } from './helper'\nexport function loginFlow(user) {\n  return makeSession(user)\n}\n")
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const {db}=await openProjectStore(w.repo,await readProjectMetadata(w.repo),{dirs:w.dirs})
    try {
      const row=db.prepare(`SELECT e.metadata_json FROM edges e JOIN symbols s ON s.symbol_id=e.target_id
        WHERE e.source_id='src/flow.ts' AND e.edge_type='references' AND s.name='createSession'`).get()
      assert.ok(row)
      const metadata=JSON.parse(row.metadata_json)
      assert.equal(metadata.importedName,'createSession')
      assert.equal(metadata.localName,'makeSession')
    } finally {db.close()}
  } finally {await w.cleanup()}
})

test('v0.5.4 flow context grounds only an imported symbol actually used by the primary symbol', async () => {
  const w=await makeWorkspace()
  try {
    await fs.writeFile(path.join(w.repo,'src','helper.ts'),'export function createSession(user) {\n  return user\n}\nexport function unusedHelper() {\n  return false\n}\n')
    await fs.writeFile(path.join(w.repo,'src','flow.ts'),"import { createSession, unusedHelper } from './helper'\nexport function loginFlow(user) {\n  return createSession(user)\n}\n")
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const ctx=await contextForTask(w.repo,'Trace the loginFlow flow',{dirs:w.dirs,sync:false,compact:true,depth:1,withSource:true,maxFiles:6,maxLines:160,maxBytes:12000})
    assert.equal(ctx.intent,'flow')
    assert.ok(ctx.targets.some(t=>t.path==='src/flow.ts'&&t.source))
    assert.ok(ctx.relatedEvidence.some(t=>t.path==='src/helper.ts'&&t.symbol==='createSession'&&t.source))
    assert.ok(!ctx.relatedEvidence.some(t=>t.symbol==='unusedHelper'))
    assert.ok(ctx.groundedFiles.includes('src/helper.ts'))
  } finally {await w.cleanup()}
})

test('v0.5.4 navigation keeps unrelated neighbors as hints, not grounded evidence', async () => {
  const w=await makeWorkspace()
  try {
    await fs.writeFile(path.join(w.repo,'src','helper.ts'),'export function helper() { return 1 }\n')
    await fs.writeFile(path.join(w.repo,'src','feature.ts'),"import { helper } from './helper'\nexport function loginFeature() { return helper() }\n")
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const ctx=await contextForTask(w.repo,'Find loginFeature',{dirs:w.dirs,sync:false,compact:true,depth:1,withSource:true,maxFiles:6})
    assert.equal(ctx.intent,'navigation')
    assert.equal(ctx.relatedEvidence.length,0)
    assert.ok(ctx.relatedHints.some(h=>h.path==='src/helper.ts'))
  } finally {await w.cleanup()}
})


test('v0.5.4 depth zero never auto-attaches related evidence', async () => {
  const w=await makeWorkspace()
  try {
    await fs.writeFile(path.join(w.repo,'src','helper.ts'),'export function createSession(user) { return user }\n')
    await fs.writeFile(path.join(w.repo,'src','flow.ts'),"import { createSession } from './helper'\nexport function loginFlow(user) { return createSession(user) }\n")
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const ctx=await contextForTask(w.repo,'Trace the loginFlow flow',{dirs:w.dirs,sync:false,compact:true,depth:0,withSource:true,maxFiles:6})
    assert.equal(ctx.relatedEvidence.length,0)
    assert.equal(ctx.relatedHints.length,0)
  } finally {await w.cleanup()}
})

test('v0.5.4 indexer version mismatch triggers deterministic semantic reindex', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const metadata=await readProjectMetadata(w.repo)
    const store=await openProjectStore(w.repo,metadata,{dirs:w.dirs})
    store.db.prepare('UPDATE project_meta SET indexer_version=0').run();store.db.close()
    const result=await syncProject(w.repo,{dirs:w.dirs})
    assert.equal(result.semanticReindex,true)
    assert.equal(result.indexerVersion,INDEXER_VERSION)
    const verify=await openProjectStore(w.repo,metadata,{dirs:w.dirs})
    try {assert.equal(verify.db.prepare('SELECT indexer_version FROM project_meta').get().indexer_version,INDEXER_VERSION)} finally {verify.db.close()}
  } finally {await w.cleanup()}
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appDirectories } from '../src/platform/paths.js'
import { initializeProject, readProjectMetadata } from '../src/core/project.js'
import { registerProject, projectRegistration } from '../src/storage/registry.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { makeWorkspace } from './helpers.js'

test('platform adapter resolves standard application data locations', () => {
  assert.equal(appDirectories({platform:'darwin',home:'/Users/dev'}).data, path.join('/Users/dev','Library','Application Support','StellarCode'))
  assert.equal(appDirectories({platform:'linux',home:'/home/dev',env:{}}).data, path.join('/home/dev','.local','share','stellarcode'))
  assert.equal(appDirectories({platform:'win32',home:'C:\\Users\\dev',env:{LOCALAPPDATA:'C:\\Users\\dev\\AppData\\Local'}}).data, path.join('C:\\Users\\dev\\AppData\\Local','StellarCode'))
})

test('init is idempotent and repo metadata is tiny/path-independent', async () => {
  const w=await makeWorkspace()
  try {
    const a=await initializeProject(w.repo)
    const b=await initializeProject(w.repo)
    assert.equal(a.metadata.projectId,b.metadata.projectId)
    const file=path.join(w.repo,'.stellar','project.json')
    const stat=await fs.stat(file)
    assert.ok(stat.size<2048)
    const raw=await fs.readFile(file,'utf8')
    assert.ok(!raw.includes(w.repo))
    const {db}=await openProjectStore(w.repo,a.metadata,{dirs:w.dirs});db.close()
  } finally { await w.cleanup() }
})

test('moving a repo keeps UUID and refreshes registry path', async () => {
  const w=await makeWorkspace()
  try {
    const init=await initializeProject(w.repo)
    await registerProject(w.repo,init.metadata,{dirs:w.dirs})
    const moved=path.join(w.base,'repo-moved')
    await fs.rename(w.repo,moved)
    const metadata=await readProjectMetadata(moved)
    assert.equal(metadata.projectId,init.metadata.projectId)
    await registerProject(moved,metadata,{dirs:w.dirs})
    const row=await projectRegistration(metadata.projectId,{dirs:w.dirs})
    assert.equal(row.repo_path,moved)
  } finally { await w.cleanup() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { contextForTask } from '../src/query/query-service.js'
import { completedEvidence } from '../src/benchmark/evidence.js'
import { makeWorkspace } from './helpers.js'

test('v0.5.4 a read reported through the realpath of a symlinked cwd counts as source grounding', async () => {
  const real=await fs.mkdtemp(path.join(os.tmpdir(),'ev-real-'))
  const link=real+'-link'
  try {
    await fs.symlink(real,link)
    await fs.mkdir(path.join(real,'src'))
    await fs.writeFile(path.join(real,'src','a.ts'),'export function login(user) {\n  return check(user.password)\n}\n')
    const output='1\texport function login(user) {\n2\t  return check(user.password)\n3\t}\n'
    // cwd is the symlink spelling; the agent reports the resolved path (macOS /var vs /private/var).
    const e=await completedEvidence({input:{file_path:path.join(await fs.realpath(real),'src','a.ts')},output,cwd:link,ok:true,atMs:0,via:'Read'})
    assert.equal(e.reads.length,1)
    assert.equal(e.reads[0].path,'src/a.ts')
  } finally { await fs.rm(link,{force:true}); await fs.rm(real,{recursive:true,force:true}) }
})

test('v0.5.4 compact context --with-source returns bounded live excerpts that count as reads', async () => {
  const w=await makeWorkspace()
  try {
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const plain=await contextForTask(w.repo,'Find the login implementation',{dirs:w.dirs,sync:false,compact:true,maxFiles:2})
    assert.ok(plain.targets.every(t=>t.source===undefined),'source stays opt-in')
    const ctx=await contextForTask(w.repo,'Find the login implementation',{dirs:w.dirs,sync:false,compact:true,maxFiles:2,maxBytes:600,withSource:true})
    const auth=ctx.targets.find(t=>t.path==='src/auth/AuthService.ts')
    assert.ok(auth?.source)
    assert.match(auth.source,/login\(/)
    const total=ctx.targets.reduce((n,t)=>n+Buffer.byteLength(t.source??''),0)
    assert.ok(total<=600,`excerpt budget respected (${total})`)
    const e=await completedEvidence({input:'stellar context "Find login" --compact --with-source --json',output:JSON.stringify(ctx),cwd:w.repo,ok:true,atMs:0,via:'stellar'})
    assert.ok(e.reads.some(r=>r.path==='src/auth/AuthService.ts'))
    // Without --with-source, context stays navigation-only even if paths appear in output.
    const nav=await completedEvidence({input:'stellar context "Find login" --compact --json',output:JSON.stringify(plain),cwd:w.repo,ok:true,atMs:0,via:'stellar'})
    assert.equal(nav.reads.length,0)
  } finally { await w.cleanup() }
})

test('v0.5.4 the exact STELLAR benchmark-prompt context command parses and returns source via the CLI', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { benchmarkPrompt } = await import('../src/benchmark/agents.js')
  const run = promisify(execFile)
  const w=await makeWorkspace()
  try {
    const env={...process.env,STELLAR_DATA_DIR:w.dirs.data,STELLAR_CACHE_DIR:w.dirs.cache,STELLAR_LOG_DIR:w.dirs.logs}
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const prompt=benchmarkPrompt({prompt:'Find the login implementation'},'stellar')
    const command=prompt.match(/stellar context "[^"]*"[^.]*?--json/)[0]
    const args=[...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m=>m[1]??m[2]).slice(1)
    const cli=fileURLToPath(new URL('../src/cli.js', import.meta.url))
    const { stdout }=await run(process.execPath,[cli,...args],{cwd:w.repo,env})
    const result=JSON.parse(stdout)
    assert.ok(result.targets.length>=1 && result.targets.length<=6)
    assert.ok(result.targets.filter(t=>t.kind==="related").every(t=>t.source===undefined),"related targets are path-only")
    assert.ok(result.targets.some(t=>/login\(/.test(t.source??'')))
  } finally { await w.cleanup() }
})

test('v0.5.4 tsconfig path aliases (with comments/trailing commas) resolve into import edges', async () => {
  const { loadPathAliases } = await import('../src/indexer/sync.js')
  const { openProjectStore } = await import('../src/storage/project-store.js')
  const { readProjectMetadata } = await import('../src/core/project.js')
  const w=await makeWorkspace()
  try {
    await fs.writeFile(path.join(w.repo,'tsconfig.json'),'{\n  // comment\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["./src/*"], },\n  },\n}\n')
    await fs.mkdir(path.join(w.repo,'src','ui'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'src','ui','LoginButton.ts'),"import { AuthService } from '@/auth/AuthService'\nexport const go = () => new AuthService()\n")
    const aliases=await loadPathAliases(w.repo)
    assert.deepEqual(aliases.map(a=>[a.prefix,a.targets[0]]),[['@/','src/*']])
    await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
    const { db }=await openProjectStore(w.repo,await readProjectMetadata(w.repo),{dirs:w.dirs})
    try {
      const edge=db.prepare(`SELECT 1 ok FROM edges e JOIN files s ON s.file_id=e.source_id JOIN files t ON t.file_id=e.target_id
        WHERE e.edge_type='imports' AND s.path='src/ui/LoginButton.ts' AND t.path='src/auth/AuthService.ts'`).get()
      assert.ok(edge,'alias import produces an imports edge')
    } finally { db.close() }
  } finally { await w.cleanup() }
})

test('v0.5.4 scanner skips files ignored by git (.gitignore and .git/info/exclude)', async () => {
  const { scanRepository } = await import('../src/indexer/scanner.js')
  const w=await makeWorkspace()
  try {
    await fs.mkdir(path.join(w.repo,'.qa'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'.qa','qa.js'),'export const x = 1\n')
    await fs.mkdir(path.join(w.repo,'scratch'),{recursive:true})
    await fs.writeFile(path.join(w.repo,'scratch','tmp.ts'),'export const y = 2\n')
    await fs.appendFile(path.join(w.repo,'.git','info','exclude'),'\n.qa/\n')
    await fs.writeFile(path.join(w.repo,'.gitignore'),'scratch/\n')
    const { files }=await scanRepository(w.repo)
    const paths=files.map(f=>f.path)
    assert.ok(!paths.includes('.qa/qa.js'))
    assert.ok(!paths.includes('scratch/tmp.ts'))
    assert.ok(paths.includes('src/auth/AuthService.ts'))
  } finally { await w.cleanup() }
})

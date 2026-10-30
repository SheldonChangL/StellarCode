import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

export async function makeWorkspace() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-test-'))
  const repo = path.join(base, 'repo')
  const fixture = new URL('../fixtures/sample/', import.meta.url)
  await fs.cp(fixture, repo, { recursive:true })
  await execFileAsync('git',['-C',repo,'init','-q'])
  await execFileAsync('git',['-C',repo,'config','user.email','stellar@test.local'])
  await execFileAsync('git',['-C',repo,'config','user.name','Stellar Test'])
  await execFileAsync('git',['-C',repo,'add','.'])
  await execFileAsync('git',['-C',repo,'commit','-qm','fixture'])
  const dirs = {
    data:path.join(base,'data'), cache:path.join(base,'cache'), logs:path.join(base,'logs')
  }
  return { base, repo, dirs, cleanup:()=>fs.rm(base,{recursive:true,force:true}) }
}

export function snapshotGraph(db) {
  const clean = rows => rows.map(r=>Object.fromEntries(Object.entries(r))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {
    files: clean(db.prepare('SELECT file_id,path,name,language,content_hash,is_test FROM files').all()),
    symbols: clean(db.prepare('SELECT file_id,qualified_name,name,kind,start_line,end_line,exported FROM symbols').all()),
    edges: clean(db.prepare("SELECT source_id,target_id,edge_type FROM edges WHERE edge_type IN ('imports','tests','contains','references')").all())
  }
}

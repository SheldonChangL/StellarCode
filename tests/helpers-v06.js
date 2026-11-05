import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initializeProject, readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { syncProject } from '../src/indexer/sync.js'

const run = promisify(execFile)

export async function semanticRepo(files) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-v06-'))
  const repo = path.join(base, 'repo')
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
    await fs.writeFile(path.join(repo, file), text)
  }
  await run('git', ['-C', repo, 'init', '-q'])
  await run('git', ['-C', repo, 'config', 'user.email', 'stellar@test.local'])
  await run('git', ['-C', repo, 'config', 'user.name', 'Stellar Test'])
  await run('git', ['-C', repo, 'add', '.'])
  await run('git', ['-C', repo, 'commit', '-qm', 'fixture'])
  const dirs = { data: path.join(base, 'data'), cache: path.join(base, 'cache'), logs: path.join(base, 'logs') }
  await initializeProject(repo)
  const sync = await syncProject(repo, { dirs, force: true })
  return { base, repo, dirs, sync, cleanup: () => fs.rm(base, { recursive: true, force: true }) }
}

export async function semanticEdges(w) {
  const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
  const name = id => {
    const s = db.prepare('SELECT qualified_name,file_id FROM symbols WHERE symbol_id=?').get(id)
    return s ? `${s.file_id}#${s.qualified_name}` : id
  }
  const rows = db.prepare(`SELECT source_id,target_id,edge_type,metadata_json FROM edges WHERE edge_type IN ('CALLS','IMPLEMENTS','REGISTERS','CONSUMES')`).all()
  const edges = rows.map(r => { const m = JSON.parse(r.metadata_json); return { type: r.edge_type, from: name(r.source_id), to: name(r.target_id), confidence: m.confidence, line: m.line, expression: m.expression } })
  db.close()
  return edges
}


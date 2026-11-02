import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { readProjectMetadata, projectIndexDirectory } from '../core/project.js'
import { appDirectories } from '../platform/paths.js'

// Consume an existing index. Never initialize or scan the benchmark worktree.
export async function prepareBenchmarkSnapshot(projectRoot, worktree, base, commit, env) {
  const metadata=await readProjectMetadata(projectRoot)
  const originalDb=path.join(projectIndexDirectory(appDirectories({env}).data,metadata.projectId),'index.db')
  const source=new DatabaseSync(originalDb,{readOnly:true})
  const indexFile=path.join(base,'benchmark-index.db')
  try {
    const meta=source.prepare('SELECT * FROM project_meta').get()
    if(meta?.project_id!==metadata.projectId || meta.last_indexed_head!==commit) throw new Error('Benchmark requires a prebuilt index for the selected project UUID and commit; sync the original project first.')
    for(const row of source.prepare('SELECT path,content_hash FROM files').all()) {
      const content=await fs.readFile(path.join(worktree,row.path))
      const hash=crypto.createHash('sha256').update(content).digest('hex')
      if(hash!==row.content_hash) throw new Error(`Benchmark index differs from committed source: ${row.path}. Sync a clean original project first.`)
    }
    await backup(source,indexFile)
  } finally {source.close()}
  const snapshot=new DatabaseSync(indexFile)
  try {snapshot.exec('PRAGMA journal_mode=DELETE')} finally {snapshot.close()}
  await fs.chmod(indexFile,0o444)
  await fs.mkdir(path.join(worktree,'.stellar'),{recursive:true})
  await fs.writeFile(path.join(worktree,'.stellar','project.json'),JSON.stringify(metadata,null,2)+'\n')
  return {projectId:metadata.projectId,originalDb,indexFile,commit}
}

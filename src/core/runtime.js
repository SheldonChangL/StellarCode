import path from 'node:path'
import { findProjectRoot, readProjectMetadata } from './project.js'
import { openProjectStore } from '../storage/project-store.js'
import { syncProject } from '../indexer/sync.js'
import { StellarError } from './errors.js'

export async function resolveProject(input = process.cwd()) {
  const start = path.resolve(input)
  const root = await findProjectRoot(start)
  if (!root) throw new StellarError(`No StellarCode project found from ${start}. Run 'stellar init'.`, 'PROJECT_NOT_FOUND', 2)
  const metadata = await readProjectMetadata(root)
  return { root, metadata }
}

export async function withFreshProjectDb(input, fn, options = {}) {
  const { root, metadata } = await resolveProject(input)
  if (options.sync !== false && !process.env.STELLAR_BENCH_INDEX_FILE) await syncProject(root, options)
  const { db, registration } = await openProjectStore(root, metadata, options)
  try {
    return await fn({ db, root, metadata, registration })
  } finally {
    db.close()
  }
}

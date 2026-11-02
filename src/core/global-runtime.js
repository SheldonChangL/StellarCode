import fs from 'node:fs/promises'
import path from 'node:path'
import { findProjectRoot, readProjectMetadata } from './project.js'
import { resolveRegisteredProject, markProjectAccess, reconcileProjects } from '../storage/registry.js'
import { syncProject } from '../indexer/sync.js'
import { StellarError } from './errors.js'

async function directoryExists(value) {
  try { return (await fs.stat(value)).isDirectory() } catch { return false }
}

export async function resolveAnyProject(reference = null, options = {}) {
  if (reference) {
    const candidate = path.resolve(String(reference))
    if (await directoryExists(candidate)) {
      const root = await findProjectRoot(candidate)
      if (root) {
        const metadata = await readProjectMetadata(root)
        return { root, metadata, projectId: metadata.projectId, source: 'path' }
      }
    }
    const row = await resolveRegisteredProject(reference, options)
    if (!await directoryExists(row.repo_path)) {
      await reconcileProjects(options)
      throw new StellarError(`Project '${row.display_name}' is ${row.status === 'orphaned' ? 'orphaned' : 'missing'}: ${row.repo_path}`, 'PROJECT_UNAVAILABLE', 2)
    }
    const metadata = await readProjectMetadata(row.repo_path).catch(() => null)
    if (!metadata || metadata.projectId !== row.project_id) {
      await reconcileProjects(options)
      throw new StellarError(`Project identity mismatch at ${row.repo_path}.`, 'PROJECT_IDENTITY_MISMATCH', 2)
    }
    return { root: row.repo_path, metadata, projectId: row.project_id, registration: row, source: 'registry' }
  }

  const root = await findProjectRoot(process.cwd())
  if (root) {
    const metadata = await readProjectMetadata(root)
    return { root, metadata, projectId: metadata.projectId, source: 'cwd' }
  }
  throw new StellarError('No project selected and current directory is not a StellarCode project. Use a project name/UUID or run `stellar projects`.', 'PROJECT_NOT_SELECTED', 2)
}

export async function ensureFreshProject(reference, options = {}) {
  const resolved = await resolveAnyProject(reference, options)
  await markProjectAccess(resolved.projectId, options)
  let sync = null
  if (options.sync !== false) sync = await syncProject(resolved.root, options)
  return { ...resolved, sync }
}

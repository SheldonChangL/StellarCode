import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { PROJECT_SCHEMA_VERSION } from './constants.js'
import { StellarError } from './errors.js'

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)
  while (true) {
    try {
      await fs.access(path.join(current, '.stellar', 'project.json'))
      return current
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function readProjectMetadata(root) {
  const file = path.join(root, '.stellar', 'project.json')
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    throw new StellarError(`Not a StellarCode project: ${root}. Run 'stellar init'.`, 'PROJECT_NOT_INITIALIZED', 2)
  }
  const parsed = JSON.parse(raw)
  if (!parsed.projectId || parsed.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new StellarError(`Invalid .stellar/project.json in ${root}`, 'PROJECT_METADATA_INVALID', 2)
  }
  return parsed
}

export async function initializeProject(root, { dryRun = false } = {}) {
  const abs = path.resolve(root)
  const stellarDir = path.join(abs, '.stellar')
  const metadataPath = path.join(stellarDir, 'project.json')
  try {
    const existing = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    if (existing.projectId) return { root: abs, metadata: existing, created: false }
  } catch {}

  const metadata = {
    projectId: crypto.randomUUID(),
    schemaVersion: PROJECT_SCHEMA_VERSION
  }
  if (!dryRun) {
    await fs.mkdir(stellarDir, { recursive: true })
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  return { root: abs, metadata, created: true, dryRun }
}

export function projectIndexDirectory(appDataDir, projectId) {
  return path.join(appDataDir, 'projects', projectId)
}

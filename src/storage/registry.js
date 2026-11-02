import fs from 'node:fs/promises'
import path from 'node:path'
import { openDatabase, migrateRegistry, migrateProject } from './db.js'
import { appDirectories } from '../platform/paths.js'
import { projectIndexDirectory } from '../core/project.js'
import { StellarError } from '../core/errors.js'

export const DEFAULT_ORPHAN_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_IDLE_AFTER_MS = 15 * 60 * 1000

export async function openRegistry(options = {}) {
  const dirs = options.dirs ?? appDirectories(options)
  const db = await openDatabase(path.join(dirs.data, 'registry.db'))
  migrateRegistry(db)
  return { db, dirs }
}

export async function registerProject(root, metadata, options = {}) {
  const { db, dirs } = await openRegistry(options)
  const now = new Date().toISOString()
  const absRoot = path.resolve(root)
  const dbPath = path.join(projectIndexDirectory(dirs.data, metadata.projectId), 'index.db')
  const displayName = path.basename(absRoot)

  // A path may be re-initialized after its old .stellar metadata was deleted. Keep the
  // old per-project DB on disk, but let the new UUID own the live registry path.
  const conflict = db.prepare('SELECT project_id FROM projects WHERE repo_path=? AND project_id<>?').get(absRoot, metadata.projectId)
  if (conflict) db.prepare('DELETE FROM projects WHERE project_id=?').run(conflict.project_id)

  db.prepare(`
    INSERT INTO projects(project_id,display_name,repo_path,db_path,status,created_at,last_seen_at,last_accessed_at,missing_since,orphaned_at,last_error)
    VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL)
    ON CONFLICT(project_id) DO UPDATE SET
      display_name=excluded.display_name,
      repo_path=excluded.repo_path,
      db_path=excluded.db_path,
      status=CASE WHEN projects.status='active' THEN 'active' ELSE 'idle' END,
      last_seen_at=excluded.last_seen_at,
      missing_since=NULL,
      orphaned_at=NULL,
      last_error=NULL
  `).run(metadata.projectId, displayName, absRoot, dbPath, 'idle', now, now, now)
  const row = db.prepare('SELECT * FROM projects WHERE project_id=?').get(metadata.projectId)
  db.close()
  return { ...row, dirs }
}

export async function projectRegistration(projectId, options = {}) {
  const { db, dirs } = await openRegistry(options)
  const row = db.prepare('SELECT * FROM projects WHERE project_id=?').get(projectId)
  db.close()
  return row ? { ...row, dirs } : null
}

export async function listProjects(options = {}) {
  const { db } = await openRegistry(options)
  const rows = db.prepare('SELECT * FROM projects ORDER BY COALESCE(last_accessed_at,last_seen_at) DESC, display_name COLLATE NOCASE').all()
  db.close()
  return rows
}

export async function resolveRegisteredProject(selector, options = {}) {
  const value = String(selector ?? '').trim()
  if (!value) throw new StellarError('Project selector is required.', 'PROJECT_SELECTOR_REQUIRED', 2)
  const { db, dirs } = await openRegistry(options)
  let rows = db.prepare(`SELECT * FROM projects WHERE project_id=? OR repo_path=? OR display_name=? COLLATE NOCASE`).all(value, path.resolve(value), value)
  if (!rows.length && value.length >= 6) rows = db.prepare('SELECT * FROM projects WHERE project_id LIKE ?').all(`${value}%`)
  db.close()
  if (!rows.length) throw new StellarError(`Unknown StellarCode project: ${value}`, 'PROJECT_NOT_REGISTERED', 2)
  if (rows.length > 1) throw new StellarError(`Ambiguous project selector '${value}'. Use the project UUID.`, 'PROJECT_AMBIGUOUS', 2)
  return { ...rows[0], dirs }
}

async function metadataMatches(row) {
  try {
    const raw = await fs.readFile(path.join(row.repo_path, '.stellar', 'project.json'), 'utf8')
    return JSON.parse(raw).projectId === row.project_id
  } catch {
    return false
  }
}

export async function reconcileProjects(options = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const orphanAfterMs = options.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS
  const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS
  const { db, dirs } = await openRegistry(options)
  const rows = db.prepare('SELECT * FROM projects').all()
  const updates = []
  for (const row of rows) {
    const present = await metadataMatches(row)
    if (present) {
      const accessedMs = row.last_accessed_at ? Date.parse(row.last_accessed_at) : 0
      const status = row.status === 'active' && nowMs - accessedMs <= idleAfterMs ? 'active' : 'idle'
      db.prepare(`UPDATE projects SET status=?,last_seen_at=?,missing_since=NULL,orphaned_at=NULL,last_error=NULL WHERE project_id=?`)
        .run(status, now, row.project_id)
      updates.push({ projectId: row.project_id, status, previousStatus: row.status })
      continue
    }
    const missingSince = row.missing_since ?? now
    const missingMs = nowMs - Date.parse(missingSince)
    const status = missingMs >= orphanAfterMs ? 'orphaned' : 'missing'
    const orphanedAt = status === 'orphaned' ? (row.orphaned_at ?? now) : null
    db.prepare(`UPDATE projects SET status=?,missing_since=?,orphaned_at=?,last_error=? WHERE project_id=?`)
      .run(status, missingSince, orphanedAt, 'Repository path is unavailable or its project UUID no longer matches.', row.project_id)
    if (status === 'orphaned') {
      // Cache is reconstructable and safe to reclaim automatically. The durable index is
      // deliberately preserved until the user explicitly purges it.
      await fs.rm(path.join(dirs.cache, row.project_id), { recursive: true, force: true }).catch(() => {})
    }
    updates.push({ projectId: row.project_id, status, previousStatus: row.status })
  }
  const result = db.prepare('SELECT * FROM projects ORDER BY COALESCE(last_accessed_at,last_seen_at) DESC, display_name COLLATE NOCASE').all()
  db.close()
  return { projects: result, updates, dirs }
}

export async function markProjectAccess(projectId, options = {}) {
  const { db } = await openRegistry(options)
  const now = new Date(options.nowMs ?? Date.now()).toISOString()
  db.prepare(`UPDATE projects SET status='active',last_accessed_at=?,last_seen_at=?,missing_since=NULL,orphaned_at=NULL,last_error=NULL WHERE project_id=?`)
    .run(now, now, projectId)
  const row = db.prepare('SELECT * FROM projects WHERE project_id=?').get(projectId)
  db.close()
  return row ?? null
}

export async function markProjectIndexed(projectId, { gitHead = null, indexedAt = null, ...options } = {}) {
  const { db } = await openRegistry(options)
  const now = indexedAt ?? new Date().toISOString()
  db.prepare(`UPDATE projects SET last_indexed_at=?,last_git_head=?,last_seen_at=?,status='active',last_error=NULL WHERE project_id=?`)
    .run(now, gitHead, now, projectId)
  db.close()
}

export async function projectSummaries(options = {}) {
  const reconciled = await reconcileProjects(options)
  const result = []
  for (const row of reconciled.projects) {
    let counts = { files: 0, symbols: 0, edges: 0, graphVersion: 0 }
    try {
      const db = await openDatabase(row.db_path)
      migrateProject(db)
      const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_meta'").get()
      if (hasMeta) {
        counts = {
          files: db.prepare('SELECT COUNT(*) c FROM files').get().c,
          symbols: db.prepare('SELECT COUNT(*) c FROM symbols').get().c,
          edges: db.prepare('SELECT COUNT(*) c FROM edges').get().c,
          graphVersion: db.prepare('SELECT COALESCE(MAX(graph_version),0) v FROM project_meta').get().v
        }
      }
      db.close()
    } catch {}
    result.push({
      projectId: row.project_id,
      name: row.display_name,
      path: row.repo_path,
      status: row.status,
      lastSeenAt: row.last_seen_at,
      lastAccessedAt: row.last_accessed_at,
      lastIndexedAt: row.last_indexed_at,
      lastGitHead: row.last_git_head,
      missingSince: row.missing_since,
      orphanedAt: row.orphaned_at,
      dbPath: row.db_path,
      counts
    })
  }
  return result
}

export async function removeRegisteredProject(selector, { purge = false, ...options } = {}) {
  const row = await resolveRegisteredProject(selector, options)
  const { db, dirs } = await openRegistry(options)
  db.prepare('DELETE FROM projects WHERE project_id=?').run(row.project_id)
  db.close()
  const removed = { projectId: row.project_id, name: row.display_name, path: row.repo_path, registryRemoved: true, purged: false }
  if (purge) {
    await fs.rm(projectIndexDirectory(dirs.data, row.project_id), { recursive: true, force: true })
    await fs.rm(path.join(dirs.cache, row.project_id), { recursive: true, force: true })
    removed.purged = true
  }
  return removed
}

export async function garbageCollect(options = {}) {
  const { projects, dirs } = await reconcileProjects(options)
  const result = { compacted: 0, cacheRemoved: 0, purged: 0, orphaned: 0, missing: 0 }
  for (const row of projects) {
    if (row.status === 'orphaned') result.orphaned++
    if (row.status === 'missing') result.missing++
    if (['missing', 'orphaned'].includes(row.status)) {
      const cachePath = path.join(dirs.cache, row.project_id)
      try { await fs.rm(cachePath, { recursive: true, force: true }); result.cacheRemoved++ } catch {}
    }
    if (options.purgeOrphaned && row.status === 'orphaned') {
      await removeRegisteredProject(row.project_id, { ...options, dirs, purge: true })
      result.purged++
      continue
    }
    try {
      const db = await openDatabase(row.db_path)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
      db.close()
      result.compacted++
    } catch {}
  }
  return result
}

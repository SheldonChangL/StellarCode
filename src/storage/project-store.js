import path from 'node:path'
import { openDatabase, migrateProject } from './db.js'
import { registerProject } from './registry.js'

export async function openProjectStore(root, metadata, options = {}) {
  const registration = await registerProject(root, metadata, options)
  const db = await openDatabase(registration.db_path)
  migrateProject(db)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO project_meta(project_id,display_name,repo_path,created_at,last_seen_at,last_indexed_head,graph_version,schema_version)
    VALUES(?,?,?,?,?,NULL,0,1)
    ON CONFLICT(project_id) DO UPDATE SET
      display_name=excluded.display_name,
      repo_path=excluded.repo_path,
      last_seen_at=excluded.last_seen_at
  `).run(metadata.projectId, path.basename(root), root, now, now)
  return { db, registration }
}

export function projectMeta(db) {
  return db.prepare('SELECT * FROM project_meta LIMIT 1').get()
}

export function nextGraphVersion(db) {
  const meta = projectMeta(db)
  const next = (meta?.graph_version ?? 0) + 1
  db.prepare('UPDATE project_meta SET graph_version=?, last_seen_at=?').run(next, new Date().toISOString())
  return next
}

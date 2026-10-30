import path from 'node:path'
import { openDatabase, migrateRegistry } from './db.js'
import { appDirectories } from '../platform/paths.js'
import { projectIndexDirectory } from '../core/project.js'

export async function openRegistry(options = {}) {
  const dirs = options.dirs ?? appDirectories(options)
  const db = await openDatabase(path.join(dirs.data, 'registry.db'))
  migrateRegistry(db)
  return { db, dirs }
}

export async function registerProject(root, metadata, options = {}) {
  const { db, dirs } = await openRegistry(options)
  const now = new Date().toISOString()
  const dbPath = path.join(projectIndexDirectory(dirs.data, metadata.projectId), 'index.db')
  const displayName = path.basename(root)
  db.prepare(`
    INSERT INTO projects(project_id,display_name,repo_path,db_path,status,created_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET
      display_name=excluded.display_name,
      repo_path=excluded.repo_path,
      db_path=excluded.db_path,
      last_seen_at=excluded.last_seen_at
  `).run(metadata.projectId, displayName, root, dbPath, 'idle', now, now)
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
  const rows = db.prepare('SELECT * FROM projects ORDER BY last_seen_at DESC').all()
  db.close()
  return rows
}

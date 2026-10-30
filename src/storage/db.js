import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_SCHEMA_VERSION } from '../core/constants.js'

export async function openDatabase(file) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;')
  return db
}

export function migrateRegistry(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      db_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repo_path ON projects(repo_path);
  `)
  db.prepare(`INSERT INTO schema_meta(key,value) VALUES('schema_version',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(DB_SCHEMA_VERSION))
}

export function migrateProject(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_meta (
      project_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_indexed_head TEXT,
      graph_version INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      extension TEXT,
      language TEXT,
      size_bytes INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      modified_at TEXT,
      summary TEXT,
      summary_hash TEXT,
      importance REAL NOT NULL DEFAULT 0,
      is_test INTEGER NOT NULL DEFAULT 0,
      is_generated INTEGER NOT NULL DEFAULT 0,
      git_activity INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
    CREATE TABLE IF NOT EXISTS symbols (
      symbol_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0,
      signature TEXT,
      summary TEXT,
      FOREIGN KEY(file_id) REFERENCES files(file_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE TABLE IF NOT EXISTS unresolved_imports (
      import_id TEXT PRIMARY KEY,
      source_file_id TEXT NOT NULL,
      specifier TEXT NOT NULL,
      imported_names TEXT,
      line INTEGER,
      FOREIGN KEY(source_file_id) REFERENCES files(file_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_imports_source ON unresolved_imports(source_file_id);
    CREATE TABLE IF NOT EXISTS edges (
      edge_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 1,
      source_file_id TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
    CREATE TABLE IF NOT EXISTS changes (
      change_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      commit_sha TEXT,
      metadata_json TEXT
    );
    CREATE TABLE IF NOT EXISTS change_files (
      change_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      added_lines INTEGER NOT NULL DEFAULT 0,
      deleted_lines INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(change_id,file_id)
    );
    CREATE TABLE IF NOT EXISTS rename_hints (
      old_path TEXT NOT NULL,
      new_path TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY(old_path,new_path,detected_at)
    );
    CREATE TABLE IF NOT EXISTS index_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_version INTEGER NOT NULL,
      path TEXT,
      code TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `)
  db.prepare(`INSERT INTO schema_meta(key,value) VALUES('schema_version',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(DB_SCHEMA_VERSION))
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

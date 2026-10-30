import path from 'node:path'
import crypto from 'node:crypto'
import { scanRepository } from './scanner.js'
import { parseFile } from './parser.js'
import { gitActivity, gitHead, gitRenameHints, gitStatus } from './git.js'
import { nextGraphVersion, openProjectStore, projectMeta } from '../storage/project-store.js'
import { withTransaction } from '../storage/db.js'
import { readProjectMetadata } from '../core/project.js'
import { SUPPORTED_EXTENSIONS } from '../core/constants.js'

function edgeId(source, target, type) {
  return crypto.createHash('sha1').update(`${source}|${target}|${type}`).digest('hex')
}

function importId(source, specifier, line, sourceOffset = '') {
  return crypto.createHash('sha1').update(`${source}|${specifier}|${line}|${sourceOffset}`).digest('hex')
}

function previousMap(db) {
  const rows = db.prepare('SELECT path,size_bytes,line_count,content_hash,modified_at FROM files').all()
  return new Map(rows.map(row => [row.path, {
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    contentHash: row.content_hash,
    modifiedAt: row.modified_at
  }]))
}

function resolveJSImport(sourcePath, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier))
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`,
    `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx')
  ]
  return candidates.find(c => fileSet.has(c)) ?? null
}

function resolvePythonImport(sourcePath, specifier, fileSet) {
  let module = specifier
  let baseDir = path.posix.dirname(sourcePath)
  if (module.startsWith('.')) {
    let dots = 0
    while (module[dots] === '.') dots++
    module = module.slice(dots)
    for (let i = 1; i < dots; i++) baseDir = path.posix.dirname(baseDir)
  } else {
    baseDir = ''
  }
  const modulePath = module.replaceAll('.', '/')
  const base = path.posix.normalize(path.posix.join(baseDir, modulePath))
  const candidates = [`${base}.py`, path.posix.join(base, '__init__.py')]
  return candidates.find(c => fileSet.has(c)) ?? null
}

function resolveImport(source, specifier, fileSet) {
  return source.endsWith('.py')
    ? resolvePythonImport(source, specifier, fileSet)
    : resolveJSImport(source, specifier, fileSet)
}

function rebuildEdges(db) {
  db.exec('DELETE FROM edges')
  const insert = db.prepare(`INSERT OR REPLACE INTO edges(edge_id,source_id,target_id,edge_type,weight,confidence,source_file_id,metadata_json)
    VALUES(?,?,?,?,?,?,?,?)`)
  const files = db.prepare('SELECT file_id,path,is_test FROM files').all()
  const fileSet = new Set(files.map(f => f.path))
  const fileByPath = new Map(files.map(f => [f.path, f]))
  const imports = db.prepare('SELECT source_file_id,specifier,imported_names,line FROM unresolved_imports').all()

  for (const row of db.prepare('SELECT symbol_id,file_id FROM symbols').all()) {
    insert.run(edgeId(row.file_id, row.symbol_id, 'contains'), row.file_id, row.symbol_id, 'contains', 1, 1, row.file_id, null)
  }

  for (const imp of imports) {
    const targetPath = resolveImport(imp.source_file_id, imp.specifier, fileSet)
    if (!targetPath) continue
    const target = fileByPath.get(targetPath)
    insert.run(edgeId(imp.source_file_id, target.file_id, 'imports'), imp.source_file_id, target.file_id, 'imports', 1, 1, imp.source_file_id,
      JSON.stringify({ specifier: imp.specifier, line: imp.line }))
    const sourceFile = fileByPath.get(imp.source_file_id)
    if (sourceFile?.is_test) {
      insert.run(edgeId(imp.source_file_id, target.file_id, 'tests'), imp.source_file_id, target.file_id, 'tests', 1, 0.95, imp.source_file_id,
        JSON.stringify({ via: 'import', line: imp.line }))
    }
    let importedNames = []
    try { importedNames = JSON.parse(imp.imported_names || '[]') } catch {}
    for (const name of importedNames) {
      const symbol = db.prepare('SELECT symbol_id FROM symbols WHERE file_id=? AND name=? LIMIT 1').get(target.file_id, name)
      if (symbol) {
        insert.run(edgeId(imp.source_file_id, symbol.symbol_id, 'references'), imp.source_file_id, symbol.symbol_id, 'references', 1, 0.9, imp.source_file_id,
          JSON.stringify({ importedName: name, line: imp.line }))
      }
    }
  }
}

function normalize(value, max) {
  return max <= 0 ? 0 : Math.min(1, value / max)
}

function updateImportance(db, gitCounts) {
  const files = db.prepare('SELECT file_id,path FROM files').all()
  const stats = files.map(file => {
    const inbound = db.prepare(`SELECT COUNT(*) c FROM edges WHERE target_id=? AND edge_type IN ('imports','tests')`).get(file.file_id).c
    const outbound = db.prepare(`SELECT COUNT(*) c FROM edges WHERE source_id=? AND edge_type='imports'`).get(file.file_id).c
    const symbolCount = db.prepare('SELECT COUNT(*) c FROM symbols WHERE file_id=?').get(file.file_id).c
    const activity = gitCounts.get(file.path) ?? 0
    return { ...file, inbound, outbound, symbolCount, activity, centrality: inbound + outbound }
  })
  const maxInbound = Math.max(0, ...stats.map(v => v.inbound))
  const maxOutbound = Math.max(0, ...stats.map(v => v.outbound))
  const maxSymbols = Math.max(0, ...stats.map(v => v.symbolCount))
  const maxActivity = Math.max(0, ...stats.map(v => v.activity))
  const maxCentrality = Math.max(0, ...stats.map(v => v.centrality))
  const update = db.prepare('UPDATE files SET importance=?, git_activity=? WHERE file_id=?')
  for (const s of stats) {
    const score = 0.30 * normalize(s.inbound, maxInbound) +
      0.20 * normalize(s.outbound, maxOutbound) +
      0.20 * normalize(s.activity, maxActivity) +
      0.15 * normalize(s.symbolCount, maxSymbols) +
      0.15 * normalize(s.centrality, maxCentrality)
    update.run(Number(score.toFixed(6)), s.activity, s.file_id)
  }
}

function recordWorkingChange(db, graphVersion, changedPaths) {
  if (!changedPaths.length) return
  const changeId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO changes(change_id,occurred_at,source,reason,commit_sha,metadata_json) VALUES(?,?,?,?,?,?)`)
    .run(changeId, now, 'working-tree', null, null, JSON.stringify({ graphVersion }))
  const insert = db.prepare('INSERT OR IGNORE INTO change_files(change_id,file_id,added_lines,deleted_lines) VALUES(?,?,0,0)')
  for (const p of changedPaths) {
    const file = db.prepare('SELECT file_id FROM files WHERE path=?').get(p)
    if (file) insert.run(changeId, file.file_id)
  }
}

export async function syncProject(root, options = {}) {
  const started = performance.now()
  const metadata = await readProjectMetadata(root)
  const { db, registration } = await openProjectStore(root, metadata, options)
  const previous = previousMap(db)
  const metaBefore = projectMeta(db)

  // Fast path for already-indexed Git repositories: if HEAD is unchanged and Git reports
  // no supported source-file changes, the graph cannot be stale. This avoids walking 10k+
  // files on every AI query while still detecting tracked edits and untracked source files.
  let head = null
  let status = []
  if (!options.force && previous.size > 0) {
    head = await gitHead(root)
    if (head) {
      status = await gitStatus(root)
      const relevant = status.filter(entry => {
        const p = String(entry.path || '').replaceAll('\\', '/')
        if (p === '.stellar' || p.startsWith('.stellar/')) return false
        return SUPPORTED_EXTENSIONS.has(path.extname(p).toLowerCase())
      })
      if (head === metaBefore?.last_indexed_head && relevant.length === 0) {
        const total = db.prepare('SELECT COUNT(*) c FROM files').get().c
        const symbols = db.prepare('SELECT COUNT(*) c FROM symbols').get().c
        const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c
        db.close()
        return {
          projectId: metadata.projectId, graphVersion: metaBefore?.graph_version ?? 0, added: 0, modified: 0, deleted: 0,
          changedFiles: 0, files: total, symbols, edges, warnings: [], git: { head, statusCount: status.length },
          durationMs: Math.round(performance.now() - started), dbPath: registration.db_path, noChange: true, fastPath: 'git-clean'
        }
      }
    }
  }

  const scanned = await scanRepository(root, { previousByPath: options.force ? new Map() : previous, ignores: options.ignores })
  const current = new Map(scanned.files.map(f => [f.path, f]))
  const oldPaths = new Set(previous.keys())
  const added = []
  const modified = []
  const deleted = []
  for (const file of scanned.files) {
    const prev = previous.get(file.path)
    if (!prev) added.push(file)
    else if (prev.contentHash !== file.contentHash) modified.push(file)
    oldPaths.delete(file.path)
  }
  deleted.push(...oldPaths)
  const changedFiles = [...added, ...modified]
  const warnings = [...scanned.warnings]
  if (!head) head = await gitHead(root)
  if (!options.force && changedFiles.length === 0 && deleted.length === 0 && head === metaBefore?.last_indexed_head) {
    const total = db.prepare('SELECT COUNT(*) c FROM files').get().c
    const symbols = db.prepare('SELECT COUNT(*) c FROM symbols').get().c
    const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c
    db.close()
    return {
      projectId: metadata.projectId, graphVersion: metaBefore?.graph_version ?? 0, added: 0, modified: 0, deleted: 0,
      changedFiles: 0, files: total, symbols, edges, warnings, git: { head, statusCount: 0 },
      durationMs: Math.round(performance.now() - started), dbPath: registration.db_path, noChange: true
    }
  }
  const gitCounts = await gitActivity(root)
  const renames = await gitRenameHints(root)
  if (!status.length) status = await gitStatus(root)

  const parsed = []
  for (const file of changedFiles) {
    try {
      parsed.push({ file, facts: await parseFile(file) })
    } catch (error) {
      warnings.push({ path: file.path, code: 'PARSE_FAILED', message: error.message })
    }
  }

  let graphVersion
  withTransaction(db, () => {
    graphVersion = nextGraphVersion(db)
    for (const p of deleted) db.prepare('DELETE FROM files WHERE path=?').run(p)

    const upsertFile = db.prepare(`
      INSERT INTO files(file_id,path,name,extension,language,size_bytes,line_count,content_hash,modified_at,summary,summary_hash,importance,is_test,is_generated,git_activity)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET
        path=excluded.path,name=excluded.name,extension=excluded.extension,language=excluded.language,
        size_bytes=excluded.size_bytes,line_count=excluded.line_count,content_hash=excluded.content_hash,
        modified_at=excluded.modified_at,summary=excluded.summary,summary_hash=excluded.summary_hash,
        is_test=excluded.is_test,is_generated=excluded.is_generated
    `)
    const insertSymbol = db.prepare(`INSERT INTO symbols(symbol_id,file_id,qualified_name,name,kind,start_line,end_line,exported,signature,summary)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    const insertImport = db.prepare(`INSERT INTO unresolved_imports(import_id,source_file_id,specifier,imported_names,line) VALUES(?,?,?,?,?)`)

    for (const { file, facts } of parsed) {
      upsertFile.run(file.fileId, file.path, file.name, file.extension, file.language, file.sizeBytes, file.lineCount,
        file.contentHash, file.modifiedAt, facts.summary, file.contentHash, 0, file.isTest ? 1 : 0, file.isGenerated ? 1 : 0, 0)
      db.prepare('DELETE FROM symbols WHERE file_id=?').run(file.fileId)
      db.prepare('DELETE FROM unresolved_imports WHERE source_file_id=?').run(file.fileId)
      for (const s of facts.symbols) {
        insertSymbol.run(s.symbolId, s.fileId, s.qualifiedName, s.name, s.kind, s.startLine, s.endLine,
          s.exported ? 1 : 0, s.signature, null)
      }
      for (const imp of facts.imports) {
        insertImport.run(importId(file.fileId, imp.specifier, imp.line, imp.sourceOffset), file.fileId, imp.specifier,
          JSON.stringify(imp.importedNames ?? []), imp.line ?? null)
      }
    }

    // Ensure newly discovered unchanged metadata is present during force rebuild/new DB.
    for (const file of scanned.files) {
      const exists = db.prepare('SELECT 1 ok FROM files WHERE file_id=?').get(file.fileId)
      if (!exists && !parsed.some(p => p.file.fileId === file.fileId)) {
        warnings.push({ path: file.path, code: 'INDEX_MISSING', message: 'File metadata missing; scheduled for next sync.' })
      }
    }

    rebuildEdges(db)
    updateImportance(db, gitCounts)
    for (const r of renames) {
      db.prepare('INSERT OR REPLACE INTO rename_hints(old_path,new_path,detected_at,confidence) VALUES(?,?,?,?)')
        .run(r.oldPath, r.newPath, new Date().toISOString(), r.confidence)
    }
    for (const w of warnings) {
      db.prepare('INSERT INTO index_warnings(graph_version,path,code,message) VALUES(?,?,?,?)')
        .run(graphVersion, w.path ?? null, w.code, w.message)
    }
    recordWorkingChange(db, graphVersion, [...added.map(f => f.path), ...modified.map(f => f.path), ...deleted])
    db.prepare('UPDATE project_meta SET last_indexed_head=?, repo_path=?, last_seen_at=?').run(head, root, new Date().toISOString())
  })

  const total = db.prepare('SELECT COUNT(*) c FROM files').get().c
  const symbols = db.prepare('SELECT COUNT(*) c FROM symbols').get().c
  const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c
  db.close()
  return {
    projectId: metadata.projectId,
    graphVersion,
    added: added.length,
    modified: modified.length,
    deleted: deleted.length,
    changedFiles: added.length + modified.length + deleted.length,
    files: total,
    symbols,
    edges,
    warnings,
    git: { head, statusCount: status.length },
    durationMs: Math.round(performance.now() - started),
    dbPath: registration.db_path
  }
}

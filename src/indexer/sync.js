import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { scanRepository } from './scanner.js'
import { parseFile } from './parser.js'
import { gitActivity, gitHead, gitRenameHints, gitStatus } from './git.js'
import { nextGraphVersion, openProjectStore, projectMeta } from '../storage/project-store.js'
import { withTransaction } from '../storage/db.js'
import { readProjectMetadata } from '../core/project.js'
import { INDEXER_VERSION, SUPPORTED_EXTENSIONS } from '../core/constants.js'
import { markProjectIndexed } from '../storage/registry.js'
import { resolveSemanticEdges } from './semantic-resolve.js'

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

// Reads compilerOptions.paths/baseUrl from tsconfig.json or jsconfig.json at the repo
// root (no `extends` chasing). Deterministic; returns [{prefix, suffix, targets}].
export async function loadPathAliases(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let text
    try { text = await fs.readFile(path.join(root, name), 'utf8') } catch { continue }
    let config
    try {
      const stripped = text
        .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '')
        .replace(/,(\s*[}\]])/g, '$1')
      config = JSON.parse(stripped)
    } catch { continue }
    const options = config?.compilerOptions ?? {}
    const baseUrl = path.posix.normalize(String(options.baseUrl ?? '.').replaceAll('\\', '/'))
    const aliases = []
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      if (!Array.isArray(targets)) continue
      const star = pattern.indexOf('*')
      const prefix = star >= 0 ? pattern.slice(0, star) : pattern
      const suffix = star >= 0 ? pattern.slice(star + 1) : null
      aliases.push({ prefix, suffix, targets: targets.map(t => path.posix.normalize(path.posix.join(baseUrl, String(t).replaceAll('\\', '/')))) })
    }
    // Longest prefix first so `@/lib/*` wins over `@/*`.
    return aliases.sort((a, b) => b.prefix.length - a.prefix.length)
  }
  return []
}

function jsCandidates(base) {
  // TypeScript ESM imports name the emitted file (`./repo.js`) while the source is `repo.ts`.
  const emitted = base.match(/^(.*)\.(m|c)?jsx?$/)
  const sourceTwins = emitted ? [`${emitted[1]}.${emitted[2] ?? ''}ts`, `${emitted[1]}.tsx`] : []
  return [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`,
    `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx'),
    ...sourceTwins
  ]
}

function resolveJSImport(sourcePath, specifier, fileSet, aliases = []) {
  if (specifier.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier))
    return jsCandidates(base).find(c => fileSet.has(c)) ?? null
  }
  for (const alias of aliases) {
    let captured
    if (alias.suffix === null) { if (specifier !== alias.prefix) continue; captured = '' }
    else {
      if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix) || specifier.length < alias.prefix.length + alias.suffix.length) continue
      captured = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length)
    }
    for (const target of alias.targets) {
      const base = path.posix.normalize(target.replace('*', captured)).replace(/^\.\//, '')
      if (base.startsWith('..')) continue
      const found = jsCandidates(base).find(c => fileSet.has(c))
      if (found) return found
    }
  }
  return null
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

function resolveImport(source, specifier, fileSet, aliases) {
  return source.endsWith('.py')
    ? resolvePythonImport(source, specifier, fileSet)
    : resolveJSImport(source, specifier, fileSet, aliases)
}

function rebuildEdges(db, aliases = []) {
  const semanticFileSet = new Set(db.prepare('SELECT path FROM files').all().map(row => row.path))
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
    const targetPath = resolveImport(imp.source_file_id, imp.specifier, fileSet, aliases)
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
    for (const item of importedNames) {
      const binding = typeof item === 'string' ? { importedName:item, localName:item, kind:'named' } : item
      if (!binding?.importedName || binding.importedName === '*' || binding.importedName === 'default') continue
      const symbol = db.prepare('SELECT symbol_id FROM symbols WHERE file_id=? AND name=? LIMIT 1').get(target.file_id, binding.importedName)
      if (symbol) {
        // Type-only bindings are recorded too (lower confidence): an interface a module
        // consumes is a contract for editing-prep and impact, though not a flow step.
        insert.run(edgeId(imp.source_file_id, symbol.symbol_id, 'references'), imp.source_file_id, symbol.symbol_id, 'references', 1, binding.kind === 'type' ? 0.6 : 0.9, imp.source_file_id,
          JSON.stringify({ importedName:binding.importedName, localName:binding.localName ?? binding.importedName, importKind:binding.kind ?? 'named', line:imp.line }))
      }
    }
  }
  // v0.6 semantic relations, resolved over every file's stored facts.
  return resolveSemanticEdges(db, {
    resolveImport: (source, specifier) => resolveImport(source, specifier, semanticFileSet, aliases),
    resolvePythonModule: (source, specifier) => resolvePythonImport(source, specifier, semanticFileSet)
  })
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
  const storedIndexerVersion = Number(metaBefore?.indexer_version ?? 0)
  const semanticReindex = storedIndexerVersion !== INDEXER_VERSION
  const forceReindex = Boolean(options.force) || semanticReindex

  // Fast path for already-indexed Git repositories: if HEAD is unchanged and Git reports
  // no supported source-file changes, the graph cannot be stale. This avoids walking 10k+
  // files on every AI query while still detecting tracked edits and untracked source files.
  let head = null
  let status = []
  if (!forceReindex && previous.size > 0) {
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
        await markProjectIndexed(metadata.projectId, { ...options, gitHead: head })
        return {
          projectId: metadata.projectId, graphVersion: metaBefore?.graph_version ?? 0, added: 0, modified: 0, deleted: 0,
          changedFiles: 0, files: total, symbols, edges, warnings: [], git: { head, statusCount: status.length },
          durationMs: Math.round(performance.now() - started), dbPath: registration.db_path, noChange: true, fastPath: 'git-clean'
        }
      }
    }
  }

  const scanned = await scanRepository(root, { previousByPath: forceReindex ? new Map() : previous, ignores: options.ignores })
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
  const changedFiles = forceReindex ? scanned.files : [...added, ...modified]
  const warnings = [...scanned.warnings]
  if (!head) head = await gitHead(root)
  if (!forceReindex && changedFiles.length === 0 && deleted.length === 0 && head === metaBefore?.last_indexed_head) {
    const total = db.prepare('SELECT COUNT(*) c FROM files').get().c
    const symbols = db.prepare('SELECT COUNT(*) c FROM symbols').get().c
    const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c
    db.close()
    await markProjectIndexed(metadata.projectId, { ...options, gitHead: head })
    return {
      projectId: metadata.projectId, graphVersion: metaBefore?.graph_version ?? 0, added: 0, modified: 0, deleted: 0,
      changedFiles: 0, files: total, symbols, edges, warnings, git: { head, statusCount: 0 },
      durationMs: Math.round(performance.now() - started), dbPath: registration.db_path, noChange: true
    }
  }
  const gitCounts = await gitActivity(root)
  const aliases = await loadPathAliases(root)
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
  let semanticEdges = null
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
    const upsertFacts = db.prepare(`INSERT INTO semantic_facts(file_id,facts_json) VALUES(?,?) ON CONFLICT(file_id) DO UPDATE SET facts_json=excluded.facts_json`)

    for (const { file, facts } of parsed) {
      upsertFile.run(file.fileId, file.path, file.name, file.extension, file.language, file.sizeBytes, file.lineCount,
        file.contentHash, file.modifiedAt, facts.summary, file.contentHash, 0, file.isTest ? 1 : 0, file.isGenerated ? 1 : 0, 0)
      db.prepare('DELETE FROM symbols WHERE file_id=?').run(file.fileId)
      db.prepare('DELETE FROM unresolved_imports WHERE source_file_id=?').run(file.fileId)
      for (const s of facts.symbols) {
        insertSymbol.run(s.symbolId, s.fileId, s.qualifiedName, s.name, s.kind, s.startLine, s.endLine,
          s.exported ? 1 : 0, s.signature, null)
      }
      if (facts.semantic) upsertFacts.run(file.fileId, JSON.stringify(facts.semantic))
      else db.prepare('DELETE FROM semantic_facts WHERE file_id=?').run(file.fileId)
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

    semanticEdges = rebuildEdges(db, aliases)
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
    db.prepare('UPDATE project_meta SET last_indexed_head=?, repo_path=?, last_seen_at=?, indexer_version=?').run(head, root, new Date().toISOString(), INDEXER_VERSION)
  })

  const total = db.prepare('SELECT COUNT(*) c FROM files').get().c
  const symbols = db.prepare('SELECT COUNT(*) c FROM symbols').get().c
  const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c
  db.close()
  await markProjectIndexed(metadata.projectId, { ...options, gitHead: head })
  return {
    projectId: metadata.projectId,
    graphVersion,
    added: added.length,
    modified: modified.length,
    deleted: deleted.length,
    changedFiles: forceReindex ? changedFiles.length + deleted.length : added.length + modified.length + deleted.length,
    files: total,
    symbols,
    edges,
    warnings,
    git: { head, statusCount: status.length },
    indexerVersion: INDEXER_VERSION,
    semanticEdges,
    semanticReindex,
    durationMs: Math.round(performance.now() - started),
    dbPath: registration.db_path
  }
}

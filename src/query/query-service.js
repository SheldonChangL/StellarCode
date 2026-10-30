import path from 'node:path'
import { withFreshProjectDb } from '../core/runtime.js'

function tokens(query) {
  return String(query ?? '').toLowerCase().split(/[^a-z0-9_$.-]+/i).filter(Boolean)
}

function scoreText(text, queryTokens) {
  const value = String(text ?? '').toLowerCase()
  let score = 0
  for (const token of queryTokens) {
    if (!token) continue
    if (value === token) score += 10
    else if (value.endsWith('/' + token) || value.endsWith(token)) score += 6
    else if (value.includes(token)) score += 3
  }
  return score
}

function fileRow(row) {
  return {
    path: row.path,
    name: row.name,
    language: row.language,
    lines: row.line_count,
    sizeBytes: row.size_bytes,
    summary: row.summary,
    importance: row.importance,
    modifiedAt: row.modified_at,
    isTest: Boolean(row.is_test),
    gitActivity: row.git_activity
  }
}

export async function searchProject(projectPath, query, options = {}) {
  const limit = Math.min(Number(options.limit ?? 10), 50)
  return withFreshProjectDb(projectPath, ({ db }) => {
    const qTokens = tokens(query)
    if (!qTokens.length) return []
    const fileRows = db.prepare('SELECT * FROM files').all()
    const symbolRows = db.prepare(`SELECT s.*, f.path, f.summary AS file_summary, f.importance FROM symbols s JOIN files f ON f.file_id=s.file_id`).all()
    const results = []
    for (const row of fileRows) {
      const s = scoreText(row.path, qTokens) * 2 + scoreText(row.summary, qTokens) + row.importance
      if (s > 0) results.push({ type: 'file', score: s, path: row.path, summary: row.summary, language: row.language, importance: row.importance })
    }
    for (const row of symbolRows) {
      const s = scoreText(row.name, qTokens) * 3 + scoreText(row.qualified_name, qTokens) * 2 + scoreText(row.path, qTokens) + row.importance
      if (s > 0) results.push({
        type: 'symbol', score: s, name: row.name, qualifiedName: row.qualified_name,
        kind: row.kind, path: row.path, lines: [row.start_line, row.end_line], summary: row.file_summary
      })
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
  }, options)
}

export async function fileDetail(projectPath, requestedPath, options = {}) {
  return withFreshProjectDb(projectPath, ({ db }) => {
    let file = db.prepare('SELECT * FROM files WHERE path=?').get(requestedPath.replaceAll('\\', '/'))
    if (!file) file = db.prepare('SELECT * FROM files WHERE name=? LIMIT 1').get(path.basename(requestedPath))
    if (!file) return null
    const symbols = db.prepare('SELECT name,qualified_name,kind,start_line,end_line,exported,signature FROM symbols WHERE file_id=? ORDER BY start_line LIMIT 20').all(file.file_id)
    const dependsOn = db.prepare(`SELECT e.edge_type, f.path, f.summary FROM edges e JOIN files f ON f.file_id=e.target_id
      WHERE e.source_id=? AND e.edge_type IN ('imports','tests') ORDER BY f.importance DESC LIMIT 10`).all(file.file_id)
    const usedBy = db.prepare(`SELECT e.edge_type, f.path, f.summary FROM edges e JOIN files f ON f.file_id=e.source_id
      WHERE e.target_id=? AND e.edge_type IN ('imports','tests') ORDER BY f.importance DESC LIMIT 10`).all(file.file_id)
    const tests = db.prepare(`SELECT DISTINCT f.path FROM edges e JOIN files f ON f.file_id=e.source_id
      WHERE e.target_id=? AND (e.edge_type='tests' OR f.is_test=1) LIMIT 10`).all(file.file_id).map(v => v.path)
    const recentChanges = db.prepare(`SELECT c.change_id,c.occurred_at,c.source,c.reason,c.commit_sha
      FROM change_files cf JOIN changes c ON c.change_id=cf.change_id WHERE cf.file_id=? ORDER BY c.occurred_at DESC LIMIT 8`).all(file.file_id)
    return {
      ...fileRow(file),
      symbols: symbols.map(s => ({ name: s.name, qualifiedName: s.qualified_name, kind: s.kind, lines: [s.start_line, s.end_line], exported: Boolean(s.exported), signature: s.signature })),
      dependsOn,
      usedBy,
      tests,
      recentChanges
    }
  }, options)
}

export async function symbolLookup(projectPath, query, options = {}) {
  const limit = Math.min(Number(options.limit ?? 10), 30)
  return withFreshProjectDb(projectPath, ({ db }) => {
    const q = String(query).toLowerCase()
    const rows = db.prepare(`SELECT s.*, f.path FROM symbols s JOIN files f ON f.file_id=s.file_id`).all()
    return rows.map(row => ({
      score: (row.name.toLowerCase() === q ? 20 : 0) + (row.qualified_name.toLowerCase() === q ? 20 : 0) +
        (row.name.toLowerCase().includes(q) ? 8 : 0) + (row.qualified_name.toLowerCase().includes(q) ? 4 : 0),
      name: row.name, qualifiedName: row.qualified_name, kind: row.kind, path: row.path,
      lines: [row.start_line, row.end_line], exported: Boolean(row.exported), signature: row.signature
    })).filter(v => v.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
  }, options)
}

async function resolveFileId(db, target) {
  let file = db.prepare('SELECT file_id,path FROM files WHERE path=? OR name=? LIMIT 1').get(target, path.basename(target))
  if (file) return file
  const symbol = db.prepare(`SELECT f.file_id,f.path FROM symbols s JOIN files f ON f.file_id=s.file_id
    WHERE s.qualified_name=? OR s.name=? LIMIT 1`).get(target, target)
  return symbol ?? null
}

export async function related(projectPath, target, options = {}) {
  const limit = Math.min(Number(options.limit ?? 30), 100)
  return withFreshProjectDb(projectPath, async ({ db }) => {
    const file = await resolveFileId(db, target)
    if (!file) return null
    const outgoing = db.prepare(`SELECT e.edge_type, f.path, f.summary, f.importance FROM edges e JOIN files f ON f.file_id=e.target_id
      WHERE e.source_id=? AND e.edge_type IN ('imports','tests') ORDER BY f.importance DESC LIMIT ?`).all(file.file_id, limit)
    const incoming = db.prepare(`SELECT e.edge_type, f.path, f.summary, f.importance FROM edges e JOIN files f ON f.file_id=e.source_id
      WHERE e.target_id=? AND e.edge_type IN ('imports','tests') ORDER BY f.importance DESC LIMIT ?`).all(file.file_id, limit)
    return { target: file.path, outgoing, incoming }
  }, options)
}

export async function impact(projectPath, target, options = {}) {
  const maxDepth = Math.min(Number(options.depth ?? 3), 6)
  const limit = Math.min(Number(options.limit ?? 50), 200)
  return withFreshProjectDb(projectPath, async ({ db }) => {
    const start = await resolveFileId(db, target)
    if (!start) return null
    const visited = new Set([start.file_id])
    let frontier = [{ id: start.file_id, path: start.path, depth: 0 }]
    const nodes = []
    const edges = []
    for (let depth = 1; depth <= maxDepth && frontier.length && nodes.length < limit; depth++) {
      const next = []
      for (const current of frontier) {
        const rows = db.prepare(`SELECT e.edge_type, f.file_id, f.path, f.is_test, f.importance
          FROM edges e JOIN files f ON f.file_id=e.source_id
          WHERE e.target_id=? AND e.edge_type IN ('imports','tests') ORDER BY f.importance DESC`).all(current.id)
        for (const row of rows) {
          edges.push({ source: row.path, target: current.path, type: row.edge_type, depth })
          if (!visited.has(row.file_id) && nodes.length < limit) {
            visited.add(row.file_id)
            const node = { path: row.path, depth, isTest: Boolean(row.is_test), importance: row.importance }
            nodes.push(node)
            next.push({ id: row.file_id, path: row.path, depth })
          }
        }
      }
      frontier = next
    }
    return {
      target: start.path,
      direct: nodes.filter(n => n.depth === 1).length,
      indirect: nodes.filter(n => n.depth > 1 && !n.isTest).length,
      tests: nodes.filter(n => n.isTest).length,
      nodes,
      edges
    }
  }, options)
}

export async function contextForTask(projectPath, task, options = {}) {
  const limit = Math.min(Number(options.limit ?? 8), 12)
  const syncOptions = { ...options }
  return withFreshProjectDb(projectPath, async ({ db }) => {
    const qTokens = tokens(task)
    const files = db.prepare('SELECT * FROM files').all()
    const symbols = db.prepare('SELECT file_id,name,qualified_name,start_line,end_line,kind FROM symbols').all()
    const symbolsByFile = new Map()
    for (const s of symbols) {
      if (!symbolsByFile.has(s.file_id)) symbolsByFile.set(s.file_id, [])
      symbolsByFile.get(s.file_id).push(s)
    }
    const ranked = files.map(file => {
      const ownSymbols = symbolsByFile.get(file.file_id) ?? []
      const symbolScore = Math.max(0, ...ownSymbols.map(s => scoreText(`${s.name} ${s.qualified_name}`, qTokens)))
      const lexical = scoreText(`${file.path} ${file.summary ?? ''}`, qTokens)
      const recent = file.git_activity > 0 ? Math.min(2, file.git_activity / 10) : 0
      const testPenalty = file.is_test ? -1 : 0
      return { file, score: lexical * 2 + symbolScore * 3 + file.importance * 4 + recent + testPenalty, ownSymbols }
    }).filter(v => v.score > 0).sort((a, b) => b.score - a.score)

    const primaryRanked = ranked.filter(v => !v.file.is_test).slice(0, Math.min(3, limit))
    const selected = new Map(primaryRanked.map(v => [v.file.file_id, { ...v, category: 'primary' }]))

    for (const p of primaryRanked) {
      const neighbors = db.prepare(`SELECT f.*, e.edge_type FROM edges e JOIN files f ON f.file_id=e.target_id
        WHERE e.source_id=? AND e.edge_type IN ('imports','tests')
        UNION
        SELECT f.*, e.edge_type FROM edges e JOIN files f ON f.file_id=e.source_id
        WHERE e.target_id=? AND e.edge_type IN ('imports','tests')`).all(p.file.file_id, p.file.file_id)
      for (const n of neighbors) {
        if (selected.size >= limit) break
        if (!selected.has(n.file_id)) selected.set(n.file_id, { file: n, score: p.score * 0.45 + n.importance, ownSymbols: symbolsByFile.get(n.file_id) ?? [], category: n.is_test ? 'tests' : 'related', via: n.edge_type })
      }
    }

    for (const v of ranked.filter(v => v.file.is_test)) {
      if (selected.size >= limit) break
      if (!selected.has(v.file.file_id)) selected.set(v.file.file_id, { ...v, category: 'tests' })
    }

    const makeEntry = (v) => {
      const matchingSymbols = v.ownSymbols.filter(s => scoreText(`${s.name} ${s.qualified_name}`, qTokens) > 0)
      const lines = matchingSymbols.length
        ? [Math.min(...matchingSymbols.map(s => s.start_line)), Math.max(...matchingSymbols.map(s => s.end_line))]
        : undefined
      let reason
      if (matchingSymbols.length) reason = `Matches symbols: ${matchingSymbols.slice(0, 3).map(s => s.qualified_name).join(', ')}`
      else if (v.via) reason = `${v.via} relation to a primary match`
      else reason = `Path/summary relevance with importance ${Number(v.file.importance).toFixed(2)}`
      return { path: v.file.path, ...(lines ? { lines } : {}), reason }
    }

    const values = [...selected.values()].sort((a, b) => b.score - a.score)
    const meta = db.prepare('SELECT graph_version FROM project_meta LIMIT 1').get()
    return {
      query: task,
      graphVersion: meta?.graph_version ?? 0,
      primary: values.filter(v => v.category === 'primary').slice(0, 3).map(makeEntry),
      related: values.filter(v => v.category === 'related').slice(0, 4).map(makeEntry),
      tests: values.filter(v => v.category === 'tests').slice(0, 3).map(makeEntry)
    }
  }, syncOptions)
}

export async function graphData(projectPath, options = {}) {
  const limit = Math.min(Number(options.limit ?? 5000), 10000)
  return withFreshProjectDb(projectPath, ({ db }) => {
    const files = db.prepare('SELECT path,name,language,line_count,importance,is_test,modified_at,summary FROM files ORDER BY importance DESC LIMIT ?').all(limit)
    const visible = new Set(files.map(f => f.path))
    const edges = db.prepare(`SELECT source_id,target_id,edge_type FROM edges WHERE edge_type IN ('imports','tests')`).all()
      .filter(e => visible.has(e.source_id) && visible.has(e.target_id))
    const meta = db.prepare('SELECT display_name,graph_version,last_indexed_head FROM project_meta LIMIT 1').get()
    return {
      project: meta,
      nodes: files.map(f => { const parts=f.path.split('/'); const group=parts.length>2 && ['src','tests','test','app','packages'].includes(parts[0]) ? parts.slice(0,2).join('/') : (parts[0] || '.'); return ({ id: f.path, label: f.name, group, language: f.language, lines: f.line_count,
        importance: f.importance, isTest: Boolean(f.is_test), modifiedAt: f.modified_at, summary: f.summary }) }),
      edges: edges.map(e => ({ source: e.source_id, target: e.target_id, type: e.edge_type }))
    }
  }, options)
}

export async function changes(projectPath, options = {}) {
  return withFreshProjectDb(projectPath, ({ db }) => {
    const rows = db.prepare(`SELECT c.change_id,c.occurred_at,c.source,c.reason,c.commit_sha,cf.file_id
      FROM changes c LEFT JOIN change_files cf ON cf.change_id=c.change_id ORDER BY c.occurred_at DESC LIMIT 100`).all()
    const grouped = new Map()
    for (const r of rows) {
      if (!grouped.has(r.change_id)) grouped.set(r.change_id, { id: r.change_id, occurredAt: r.occurred_at, source: r.source, reason: r.reason, commitSha: r.commit_sha, files: [] })
      if (r.file_id) grouped.get(r.change_id).files.push(r.file_id)
    }
    return [...grouped.values()].slice(0, 20)
  }, options)
}

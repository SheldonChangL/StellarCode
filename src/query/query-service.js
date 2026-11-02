import fs from 'node:fs/promises'
import path from 'node:path'
import { withFreshProjectDb } from '../core/runtime.js'
import { loadArchitectureHints, classifyArchitecture, architectureRank, hierarchyForPath, summarizeHierarchy } from './architecture.js'

const QUERY_CONCEPTS = [
  { patterns: ['登入', '登錄', '登录', '登入流程', '登入功能', '登入頁'], terms: ['login', 'signin', 'sign-in', 'auth', 'authentication'] },
  { patterns: ['登出', '注销', '登出流程'], terms: ['logout', 'signout', 'sign-out', 'auth'] },
  { patterns: ['認證', '认证', '驗證身份', '身份驗證'], terms: ['auth', 'authentication', 'identity'] },
  { patterns: ['權限', '权限', '授權', '授权'], terms: ['permission', 'authorization', 'authorize', 'access'] },
  { patterns: ['使用者', '用户', '用戶'], terms: ['user', 'account', 'profile'] },
  { patterns: ['設定', '配置', '設定檔', '配置文件'], terms: ['config', 'configuration', 'settings'] },
  { patterns: ['測試', '测试'], terms: ['test', 'spec'] },
  { patterns: ['入口', '進入點', '进入点', '啟動點', '启动点'], terms: ['index', 'main', 'bootstrap', 'entry', 'entrypoint'] },
  { patterns: ['核心', '核心模組', '核心模块'], terms: ['core', 'engine', 'service', 'manager'] },
  { patterns: ['路由'], terms: ['router', 'route', 'routing'] },
  { patterns: ['資料庫', '数据库'], terms: ['database', 'db', 'repository', 'store'] },
  { patterns: ['快取', '缓存'], terms: ['cache'] },
  { patterns: ['網路', '网络', '請求', '请求'], terms: ['network', 'http', 'api', 'client', 'request'] },
  { patterns: ['刷新', '更新 token', '更新token'], terms: ['refresh', 'token'] },
  { patterns: ['場景', '场景'], terms: ['scene'] },
  { patterns: ['遊戲', '游戏'], terms: ['game'] },
  { patterns: ['魚', '鱼'], terms: ['fish'] }
]

const STOP_WORDS = new Set([
  'a','an','the','to','of','for','and','or','in','on','with','from','is','are','be','this','that','these','those',
  'find','show','tell','locate','modify','change','fix','file','files','code','project','repo','repository','flow',
  'please','where','which','what','how','need','should','first','look','at','about'
])

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function asciiTokens(query) {
  return String(query ?? '')
    .toLowerCase()
    .match(/[a-z0-9_$.-]+/g)?.filter(token => token.length > 1 && !STOP_WORDS.has(token)) ?? []
}

function queryProfile(query) {
  const raw = String(query ?? '')
  const lower = raw.toLowerCase()
  const direct = asciiTokens(lower)
  const concepts = []
  const expanded = []

  for (const concept of QUERY_CONCEPTS) {
    if (concept.patterns.some(pattern => lower.includes(pattern.toLowerCase()))) {
      concepts.push(concept.patterns[0])
      expanded.push(...concept.terms)
    }
  }

  const architectureOverview = /入口|進入點|进入点|啟動點|启动点|核心|架構|架构|architecture|entry\s*point|entrypoint|core\s+module|main\s+module/i.test(raw)
  return {
    raw,
    terms: unique([...direct, ...expanded]),
    directTerms: unique(direct),
    concepts: unique(concepts),
    architectureOverview
  }
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

function entryPointBonus(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/').toLowerCase()
  const base = path.posix.basename(normalized).replace(/\.[^.]+$/, '')
  if (/(^|\/)src\/(index|main)\.[^/]+$/.test(normalized)) return 48
  if (['index', 'main', 'bootstrap', 'entry', 'entrypoint'].includes(base)) return 40
  if (/(^|\/)(server|cli)\.[^/]+$/.test(normalized)) return 20
  return 0
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
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    const profile = queryProfile(query)
    const qTokens = profile.terms
    if (!qTokens.length) return []
    const hints = await loadArchitectureHints(root)
    const fileRows = db.prepare('SELECT * FROM files').all()
    const symbolRows = db.prepare(`SELECT s.*, f.path, f.summary AS file_summary, f.importance FROM symbols s JOIN files f ON f.file_id=s.file_id`).all()
    const results = []
    for (const row of fileRows) {
      const architecture = classifyArchitecture(row, hints)
      const lexical = scoreText(row.path, qTokens) * 2 + scoreText(row.summary, qTokens)
      const structural = profile.architectureOverview ? Math.max(0, architecture.score * 0.55) : 0
      if (lexical <= 0 && structural <= 0) continue
      const s = lexical + structural + row.importance
      results.push({
        type: 'file', score: s, path: row.path, summary: row.summary, language: row.language,
        importance: row.importance, role: architecture.role, roleLabel: architecture.roleLabel
      })
    }
    for (const row of symbolRows) {
      const lexical = scoreText(row.name, qTokens) * 3 + scoreText(row.qualified_name, qTokens) * 2 + scoreText(row.path, qTokens)
      if (lexical <= 0) continue
      const s = lexical + row.importance
      results.push({
        type: 'symbol', score: s, name: row.name, qualifiedName: row.qualified_name,
        kind: row.kind, path: row.path, lines: [row.start_line, row.end_line], summary: row.file_summary
      })
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
  }, options)
}

export async function fileDetail(projectPath, requestedPath, options = {}) {
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    let file = db.prepare('SELECT * FROM files WHERE path=?').get(requestedPath.replaceAll('\\', '/'))
    if (!file) file = db.prepare('SELECT * FROM files WHERE name=? LIMIT 1').get(path.basename(requestedPath))
    if (!file) return null
    const hints = await loadArchitectureHints(root)
    const architecture = classifyArchitecture(file, hints)
    const hierarchy = hierarchyForPath(file.path)
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
      ...fileRow(file), architecture, hierarchy,
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
    const profile = queryProfile(query)
    const queryTerms = profile.terms.length ? profile.terms : [String(query).toLowerCase()]
    const rows = db.prepare(`SELECT s.*, f.path FROM symbols s JOIN files f ON f.file_id=s.file_id`).all()
    return rows.map(row => ({
      score: scoreText(row.name, queryTerms) * 3 + scoreText(row.qualified_name, queryTerms) * 2,
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
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    const profile = queryProfile(task)
    const qTokens = profile.terms
    const hints = await loadArchitectureHints(root)
    const files = db.prepare('SELECT * FROM files').all()
    const symbols = db.prepare('SELECT file_id,name,qualified_name,start_line,end_line,kind FROM symbols').all()
    const symbolsByFile = new Map()
    for (const symbol of symbols) {
      if (!symbolsByFile.has(symbol.file_id)) symbolsByFile.set(symbol.file_id, [])
      symbolsByFile.get(symbol.file_id).push(symbol)
    }

    const enriched = files.map(file => ({
      file,
      architecture: classifyArchitecture(file, hints),
      ownSymbols: symbolsByFile.get(file.file_id) ?? []
    }))

    let primaryRanked = []
    if (profile.architectureOverview) {
      const viable = enriched.filter(v => !['test', 'docs', 'config'].includes(v.architecture.role))
      const entries = viable
        .filter(v => v.architecture.role === 'application-entry')
        .sort((a, b) => architectureRank(b.file, b.architecture) - architectureRank(a.file, a.architecture))
      const core = viable
        .filter(v => v.architecture.role !== 'application-entry')
        .map(v => ({ ...v, structuralRank: architectureRank(v.file, v.architecture) + Number(v.file.importance ?? 0) * 35 }))
        .sort((a, b) => b.structuralRank - a.structuralRank || a.file.path.localeCompare(b.file.path))
      const distinctCore = []
      const seenModules = new Set()
      for (const candidate of core) {
        const module = hierarchyForPath(candidate.file.path).module
        if (seenModules.has(module)) continue
        seenModules.add(module)
        distinctCore.push(candidate)
      }
      primaryRanked = [...entries.slice(0, 1), ...distinctCore.slice(0, entries.length ? 2 : 3)]
        .slice(0, Math.min(3, limit))
        .map(v => ({ ...v, score: architectureRank(v.file, v.architecture), evidence: 0, category: 'primary' }))
    } else {
      const ranked = enriched.map(v => {
        const symbolScore = qTokens.length ? Math.max(0, ...v.ownSymbols.map(symbol => scoreText(`${symbol.name} ${symbol.qualified_name}`, qTokens))) : 0
        const lexical = qTokens.length ? scoreText(`${v.file.path} ${v.file.summary ?? ''}`, qTokens) : 0
        const evidence = lexical * 2 + symbolScore * 3
        const recent = v.file.git_activity > 0 ? Math.min(1, v.file.git_activity / 20) : 0
        return { ...v, evidence, score: evidence + (evidence > 0 ? v.file.importance * 2 + recent : 0) + (v.file.is_test ? -1 : 0) }
      }).filter(v => v.evidence > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      primaryRanked = ranked.filter(v => !v.file.is_test).slice(0, Math.min(3, limit)).map(v => ({ ...v, category: 'primary' }))
    }

    const selected = new Map(primaryRanked.map(v => [v.file.file_id, v]))
    for (const primary of primaryRanked) {
      const neighbors = db.prepare(`SELECT f.*, e.edge_type FROM edges e JOIN files f ON f.file_id=e.target_id
        WHERE e.source_id=? AND e.edge_type IN ('imports','tests')
        UNION
        SELECT f.*, e.edge_type FROM edges e JOIN files f ON f.file_id=e.source_id
        WHERE e.target_id=? AND e.edge_type IN ('imports','tests')`).all(primary.file.file_id, primary.file.file_id)
      for (const neighbor of neighbors) {
        if (selected.size >= limit) break
        if (selected.has(neighbor.file_id)) continue
        const architecture = classifyArchitecture(neighbor, hints)
        selected.set(neighbor.file_id, {
          file: neighbor,
          architecture,
          score: primary.score * 0.45 + neighbor.importance,
          evidence: 0,
          ownSymbols: symbolsByFile.get(neighbor.file_id) ?? [],
          category: neighbor.is_test ? 'tests' : 'related',
          via: neighbor.edge_type
        })
      }
    }

    if (!profile.architectureOverview) {
      const testMatches = enriched.map(v => {
        const symbolScore = qTokens.length ? Math.max(0, ...v.ownSymbols.map(symbol => scoreText(`${symbol.name} ${symbol.qualified_name}`, qTokens))) : 0
        const lexical = qTokens.length ? scoreText(`${v.file.path} ${v.file.summary ?? ''}`, qTokens) : 0
        return { ...v, evidence: lexical * 2 + symbolScore * 3, score: lexical * 2 + symbolScore * 3 + v.file.importance }
      }).filter(v => v.file.is_test && v.evidence > 0).sort((a, b) => b.score - a.score)
      for (const match of testMatches) {
        if (selected.size >= limit) break
        if (!selected.has(match.file.file_id)) selected.set(match.file.file_id, { ...match, category: 'tests' })
      }
    }

    const makeEntry = v => {
      const matchingSymbols = qTokens.length ? v.ownSymbols.filter(symbol => scoreText(`${symbol.name} ${symbol.qualified_name}`, qTokens) > 0) : []
      const symbolEvidence = matchingSymbols
        .sort((a, b) => a.start_line - b.start_line)
        .slice(0, 3)
        .map(symbol => ({ name: symbol.name, qualifiedName: symbol.qualified_name, kind: symbol.kind, lines: [symbol.start_line, symbol.end_line] }))
      const exactLines = matchingSymbols.length
        ? [Math.min(...matchingSymbols.map(symbol => symbol.start_line)), Math.max(...matchingSymbols.map(symbol => symbol.end_line))]
        : undefined
      const fileLines = Math.max(1, Number(v.file.line_count ?? 1))
      const readLines = exactLines
        ? [Math.max(1, exactLines[0] - 6), Math.min(fileLines, exactLines[1] + 10)]
        : [1, Math.min(fileLines, 140)]
      let reason
      if (profile.architectureOverview && v.category === 'primary') reason = `${v.architecture.roleLabel}: ${v.architecture.reason}; importance ${Number(v.file.importance).toFixed(2)}`
      else if (matchingSymbols.length) reason = `Matches symbols: ${matchingSymbols.slice(0, 3).map(symbol => symbol.qualified_name).join(', ')}`
      else if (v.via) reason = `${v.via} relation to a primary match`
      else reason = `Matches query terms: ${qTokens.filter(term => scoreText(`${v.file.path} ${v.file.summary ?? ''}`, [term]) > 0).slice(0, 4).join(', ') || 'symbol match'}`
      return {
        path: v.file.path,
        role: v.architecture.role,
        ...(exactLines ? { lines: exactLines } : {}),
        ...(symbolEvidence.length ? { symbols: symbolEvidence } : {}),
        reason,
        read: {
          required: v.category === 'primary',
          lines: readLines,
          command: `stellar source ${JSON.stringify(v.file.path)} --lines ${readLines[0]}:${readLines[1]} --json`
        }
      }
    }

    const values = [...selected.values()].sort((a, b) => b.score - a.score)
    const meta = db.prepare('SELECT graph_version FROM project_meta LIMIT 1').get()
    const primary = values.filter(v => v.category === 'primary').slice(0, 3).map(makeEntry)
    const relatedFiles = values.filter(v => v.category === 'related').slice(0, 4).map(makeEntry)
    const tests = values.filter(v => v.category === 'tests').slice(0, 3).map(makeEntry)
    return {
      query: task,
      graphVersion: meta?.graph_version ?? 0,
      queryProfile: { terms: qTokens, concepts: profile.concepts, architectureOverview: profile.architectureOverview },
      confidence: primary.length ? (profile.architectureOverview ? 'structural' : 'lexical') : 'none',
      ...(primary.length ? {} : { noMatchReason: qTokens.length ? 'No indexed path, summary, or symbol matched the query.' : 'No deterministic query terms could be extracted.' }),
      sourceGrounding: {
        required: primary.length > 0,
        minimumPrimaryReads: primary.length > 0 ? 1 : 0,
        policy: 'StellarCode metadata is navigation evidence, not source-of-truth. Read the recommended repository source range before making implementation claims.'
      },
      primary,
      related: relatedFiles,
      tests
    }
  }, options)
}


function parseLineRange(value, maxLine) {
  if (!value) return [1, Math.min(maxLine, 160)]
  if (Array.isArray(value) && value.length >= 2) {
    const start = Math.max(1, Math.floor(Number(value[0]) || 1))
    const end = Math.max(start, Math.floor(Number(value[1]) || start))
    return [start, Math.min(maxLine, end)]
  }
  const match = String(value).match(/^(\d+)(?::|-)(\d+)$/)
  if (!match) return [1, Math.min(maxLine, 160)]
  const start = Math.max(1, Number(match[1]))
  const end = Math.max(start, Number(match[2]))
  return [start, Math.min(maxLine, end)]
}

export async function sourceExcerpt(projectPath, requestedPath, options = {}) {
  const maxLines = Math.min(Math.max(Number(options.maxLines ?? 220), 20), 400)
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    let file = db.prepare('SELECT * FROM files WHERE path=?').get(String(requestedPath).replaceAll('\\', '/'))
    if (!file) file = db.prepare('SELECT * FROM files WHERE name=? LIMIT 1').get(path.basename(String(requestedPath)))
    if (!file) return null
    const absolute = path.resolve(root, file.path)
    const relative = path.relative(root, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Indexed file resolved outside repository root')
    const text = await fs.readFile(absolute, 'utf8')
    const allLines = text.split(/\r?\n/)
    let [start, end] = parseLineRange(options.lines, allLines.length)
    if (end - start + 1 > maxLines) end = start + maxLines - 1
    const excerpt = allLines.slice(start - 1, end)
    return {
      path: file.path,
      lines: [start, end],
      lineCount: excerpt.length,
      content: excerpt.map((line, index) => `${start + index}: ${line}`).join('\n'),
      sourceOfTruth: true,
      note: 'This content was read from the repository working tree after StellarCode located the file.'
    }
  }, options)
}

export async function architectureOverview(projectPath, options = {}) {
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    const hints = await loadArchitectureHints(root)
    const files = db.prepare('SELECT * FROM files').all()
    const enriched = files.map(file => {
      const architecture = classifyArchitecture(file, hints)
      const hierarchy = hierarchyForPath(file.path)
      return { ...fileRow(file), architecture, ...hierarchy, rank: architectureRank(file, architecture) }
    })
    const { galaxies, modules } = summarizeHierarchy(enriched)
    const entries = enriched.filter(v => v.architecture.role === 'application-entry').sort((a, b) => b.rank - a.rank).slice(0, 8)
    const coreRanked = enriched.filter(v => ['domain-core', 'service', 'infrastructure', 'source'].includes(v.architecture.role) && !v.isTest)
      .sort((a, b) => (b.importance * 50 + b.rank) - (a.importance * 50 + a.rank))
    const core = []
    const coreModules = new Set()
    for (const candidate of coreRanked) {
      if (coreModules.has(candidate.module)) continue
      coreModules.add(candidate.module)
      core.push(candidate)
      if (core.length >= 12) break
    }
    const roleCounts = {}
    for (const file of enriched) roleCounts[file.architecture.role] = (roleCounts[file.architecture.role] ?? 0) + 1
    return { entries, core, galaxies, modules, roleCounts }
  }, options)
}

export async function graphData(projectPath, options = {}) {
  const limit = Math.min(Number(options.limit ?? 5000), 10000)
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    const hints = await loadArchitectureHints(root)
    const files = db.prepare('SELECT path,name,language,line_count,importance,is_test,modified_at,summary,git_activity FROM files ORDER BY importance DESC LIMIT ?').all(limit)
    const visible = new Set(files.map(file => file.path))
    const nodes = files.map(file => {
      const architecture = classifyArchitecture(file, hints)
      const { galaxy, module } = hierarchyForPath(file.path)
      return {
        id: file.path,
        label: file.name,
        galaxy,
        module,
        language: file.language,
        lines: file.line_count,
        importance: file.importance,
        gitActivity: file.git_activity,
        isTest: Boolean(file.is_test),
        modifiedAt: file.modified_at,
        summary: file.summary,
        role: architecture.role,
        roleLabel: architecture.roleLabel,
        roleReason: architecture.reason
      }
    })
    const edges = db.prepare(`SELECT source_id,target_id,edge_type FROM edges WHERE edge_type IN ('imports','tests')`).all()
      .filter(edge => visible.has(edge.source_id) && visible.has(edge.target_id))
      .map(edge => ({ source: edge.source_id, target: edge.target_id, type: edge.edge_type }))
    const meta = db.prepare('SELECT display_name,graph_version,last_indexed_head FROM project_meta LIMIT 1').get()
    const { galaxies, modules } = summarizeHierarchy(nodes)
    return { project: meta, nodes, edges, galaxies, modules }
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

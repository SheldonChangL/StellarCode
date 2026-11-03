import fs from 'node:fs/promises'
import path from 'node:path'
import { withFreshProjectDb } from '../core/runtime.js'
import { loadArchitectureHints, classifyArchitecture, architectureRank, hierarchyForPath, summarizeHierarchy } from './architecture.js'
import { classifyIntent } from './intent.js'
import { stemTerm, termMatch, termWeights, weightedScore, termCoverage, rankFileSymbols, focusRange, overlapLines, subtractTaken, allocateBudget, densestWindow, identifierPattern } from './precision.js'

const QUERY_CONCEPTS = [
  { patterns: ['登入', '登錄', '登录', '登入流程', '登入功能', '登入頁'], terms: ['login', 'signin', 'sign-in', 'auth', 'authentication'] },
  { patterns: ['登出', '注销', '登出流程'], terms: ['logout', 'signout', 'sign-out', 'auth'] },
  { patterns: ['認證', '认证', '驗證身份', '身份驗證'], terms: ['auth', 'authentication', 'identity'] },
  { patterns: ['權限', '权限', '授權', '授权'], terms: ['permission', 'authorization', 'authorize', 'access'] },
  { patterns: ['使用者', '用户', '用戶'], terms: ['user', 'account', 'profile'] },
  { patterns: ['設定', '配置', '設定檔', '配置文件'], terms: ['config', 'configuration', 'settings'] },
  { patterns: ['測試', '测试'], terms: ['test', 'spec'] },
  { patterns: ['入口', '進入點', '进入点', '啟動點', '启动点'], terms: ['index', 'main', 'bootstrap', 'entry', 'entrypoint'] },
  { patterns: ['startup', 'start-up', '啟動流程', '启动流程'], terms: ['start', 'main', 'bootstrap', 'entrypoint'] },
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
  'please','where','which','what','how','need','should','first','look','at','about',
  // Task-instruction vocabulary: describes the requested answer, not the code.
  'explain','identify','summarize','describe','implementation','implementations','implemented','responsibility','responsibilities',
  'each','why','their','its','it','they','them','without','making','directly','if','into','through','before','after',
  'when','then','also','both','any','all','is','was','be','do','does','used','using',
  'direct','relationship','relationships','responsible','participating','production','scope',
  'area','areas','perform','changes'
])

// Imperative verbs that open an instruction sentence ("List the files…", "Trace how…").
// Only dropped at sentence start, so domain uses such as "user list" are kept.
const LEADING_IMPERATIVES = new Set(['list','trace','find','show','explain','identify','describe','summarize','give','return','locate','check','map','outline'])

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function asciiTokens(query) {
  const tokens = []
  for (const sentence of String(query ?? '').toLowerCase().split(/[.?!;:\n]+(?:\s|$)/)) {
    const words = (sentence.match(/[a-z0-9_$.-]+/g) ?? []).map(token => token.replace(/^[.-]+|[.-]+$/g, ''))
    if (words.length && LEADING_IMPERATIVES.has(words[0])) words.shift()
    // "end-of-cleaning" and "predator-dodge" are phrases; match their parts, not the compound.
    const parts = words.flatMap(token => /^[a-z]+(?:-[a-z]+)+$/.test(token) ? token.split('-') : [token])
    tokens.push(...parts.filter(token => token.length > 1 && !STOP_WORDS.has(token)).map(stemTerm))
  }
  return tokens
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

// Share of the top primary score a file needs to stay a primary target. Weak lexical
// coincidences ("scene", "start") must not take a target slot and source budget.
const PRIMARY_RELATIVE_CUTOFF = { navigation: 0.5, flow: 0.35, impact: 0.35, 'editing-prep': 0.35 }
const EVIDENCE_LIMITS = { flow: 3, impact: 2, 'editing-prep': 2, navigation: 1 }
const EVIDENCE_RELATIVE_CUTOFF = 0.6
const UNLINKED_FLOW_CUTOFF = 0.6
const CALLABLE_KINDS = new Set(['function', 'method', 'class'])

function referencesFrom(db, fileId) {
  return db.prepare(`SELECT e.metadata_json,s.symbol_id,s.name,s.qualified_name,s.kind,s.start_line,s.end_line,f.file_id,f.path,f.line_count,f.size_bytes,f.is_test,f.importance
    FROM edges e JOIN symbols s ON s.symbol_id=e.target_id JOIN files f ON f.file_id=s.file_id
    WHERE e.source_id=? AND e.edge_type='references' ORDER BY f.file_id,s.start_line,s.qualified_name`).all(fileId).map(ref => {
    let metadata = {}
    try { metadata = JSON.parse(ref.metadata_json || '{}') } catch {}
    return { ...ref, localName: metadata.localName ?? metadata.importedName ?? ref.name, typeOnly: metadata.importKind === 'type' }
  }).filter(ref => ref.localName && ref.file_id !== fileId)
}

function referencesInto(db, fileId) {
  return db.prepare(`SELECT e.source_id AS consumer_id,e.metadata_json,s.name,s.qualified_name,s.kind
    FROM edges e JOIN symbols s ON s.symbol_id=e.target_id
    WHERE s.file_id=? AND e.edge_type='references' AND e.source_id<>? ORDER BY e.source_id,s.start_line,s.qualified_name`).all(fileId, fileId).map(ref => {
    let metadata = {}
    try { metadata = JSON.parse(ref.metadata_json || '{}') } catch {}
    return { ...ref, localName: metadata.localName ?? metadata.importedName ?? ref.name }
  })
}

function usesBinding(text, localName) {
  return identifierPattern(localName).test(text)
}

function nonImportText(lines) {
  return lines.filter(line => !/^\s*import\b/.test(line)).join('\n')
}

export async function contextForTask(projectPath, task, options = {}) {
  const compact=Boolean(options.compact)
  const depth=Math.max(0,Math.min(2,Number(options.depth??0)))
  const limit=Math.min(Math.max(Number(options.maxFiles??options.limit??(compact?3:8)),1),12)
  const maxLines=Math.min(Math.max(Number(options.maxLines??300),20),1000)
  const maxBytes=Math.min(Math.max(Number(options.maxBytes??12_000),512),100_000)
  return withFreshProjectDb(projectPath, async ({ db, root }) => {
    const profile = queryProfile(task)
    const qTokens = profile.terms
    const intentDetail = classifyIntent(task)
    const intent = intentDetail.intent
    const hints = await loadArchitectureHints(root)
    const files = db.prepare('SELECT * FROM files').all()
    const symbols = db.prepare('SELECT file_id,name,qualified_name,start_line,end_line,kind FROM symbols ORDER BY file_id,start_line,qualified_name').all()
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
    const documentOf = v => `${v.file.path} ${v.file.summary ?? ''} ${v.ownSymbols.map(symbol => symbol.name).join(' ')}`
    const weights = termWeights(qTokens, enriched.map(documentOf))
    const shapeWords = new Set(intentDetail.signalWords.map(stemTerm))
    for (const term of qTokens) if (shapeWords.has(term)) weights.set(term, weights.get(term) * 0.3)
    const fileEvidence = v => {
      if (!qTokens.length) return 0
      // A top-level symbol (or file) named exactly like a query term is a module-level owner
      // and scores as exact; a method named like a common verb ("finish") does not.
      const symbolScore = Math.max(0, ...v.ownSymbols.map(symbol => symbol.name === symbol.qualified_name
        ? weightedScore(symbol.name, qTokens, weights)
        : weightedScore(`${symbol.name} ${symbol.qualified_name}`, qTokens, weights)))
      const basename = path.posix.basename(v.file.path).replace(/\.[^.]+$/, '')
      const lexical = weightedScore(`${v.file.path} ${v.file.summary ?? ''}`, qTokens, weights) + weightedScore(basename, qTokens, weights) * 0.5
      if (lexical <= 0 && symbolScore <= 0) return 0
      // Distinct rare terms matter more than one common term repeated across path, summary and symbols.
      // Coverage uses path and summary only; counting every symbol name would favor the largest files.
      return lexical * 2 + symbolScore * 3 + termCoverage(`${v.file.path} ${v.file.summary ?? ''}`, qTokens, weights).covered * 6
    }

    const sourceCache = new Map()
    const sourceLines = async filePath => {
      if (!sourceCache.has(filePath)) {
        let lines = null
        const absolute = path.resolve(root, filePath)
        const relative = path.relative(root, absolute)
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          try { lines = (await fs.readFile(absolute, 'utf8')).split(/\r?\n/) } catch {}
        }
        sourceCache.set(filePath, lines)
      }
      return sourceCache.get(filePath)
    }
    const referenceCache = new Map()
    const refsFrom = fileId => {
      if (!referenceCache.has(fileId)) referenceCache.set(fileId, referencesFrom(db, fileId))
      return referenceCache.get(fileId)
    }

    let primaryRanked = []
    let rankedById = new Map()
    const flowCallees = []
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
      const startupNavigation = intent === 'navigation' && profile.concepts.includes('startup')
      const ranked = enriched.map(v => {
        const evidence = fileEvidence(v)
        const recent = v.file.git_activity > 0 ? Math.min(1, v.file.git_activity / 20) : 0
        const actionBoundary=/(^|\/)actions?\//.test(v.file.path)?20:0
        const startupEntry = startupNavigation
          ? Math.max(entryPointBonus(v.file.path), v.architecture.role === 'application-entry' ? 48 : 0)
          : 0
        return { ...v, evidence, startupEntry, score: evidence + (evidence > 0 ? v.file.importance * 2 + recent + actionBoundary : 0) + startupEntry + (v.file.is_test ? -1 : 0) }
      }).filter(v => v.evidence > 0 || v.startupEntry > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))

      // Flow, impact and editing tasks span modules. A candidate whose query-relevant
      // callable is imported AND used by another candidate forms part of the behavior
      // chain; both ends gain rank. A generic neighbor that merely shares a common term
      // gains nothing, so it cannot displace the connected file.
      if (intent !== 'navigation') {
        const pool = ranked.filter(v => !v.file.is_test).slice(0, 8)
        const poolById = new Map(pool.map(v => [v.file.file_id, v]))
        for (const source of pool) {
          const lines = await sourceLines(source.file.path)
          if (!lines) continue
          const text = nonImportText(lines)
          for (const ref of refsFrom(source.file.file_id)) {
            const target = poolById.get(ref.file_id)
            // Interfaces/types are contracts an edit or impact must respect, but not flow steps.
            if (!target || ((!CALLABLE_KINDS.has(ref.kind) || ref.typeOnly) && intent === 'flow')) continue
            if (weightedScore(ref.name, qTokens, weights) <= 0 || !usesBinding(text, ref.localName)) continue
            const link = Math.min(source.score, target.score) * 0.5
            flowCallees.push({ caller: source.file.file_id, callee: target.file.file_id, range: [Number(ref.start_line), Number(ref.end_line)] })
            if (link > (target.flowLink ?? 0)) { target.flowLink = link; target.linkedFrom = `${source.file.path} uses ${ref.name}` }
            if (link > (source.flowLink ?? 0)) { source.flowLink = link; source.linkedFrom = `uses ${ref.name} from ${ref.path}` }
          }
        }
        for (const v of pool) if (v.flowLink) v.score += v.flowLink
        ranked.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      }
      rankedById = new Map(ranked.map(v => [v.file.file_id, v]))

      const viable = ranked.filter(v => !v.file.is_test && !/(^|\/)types?(\/|$)/.test(v.file.path))
      const topScore = viable[0]?.score ?? 0
      primaryRanked = viable
        // In a flow, a file outside the linked behavior chain must be a strong match on its own.
        .filter((v, index) => index === 0 || v.score >= topScore * (intent === 'flow' && !v.flowLink && viable[0].flowLink ? UNLINKED_FLOW_CUTOFF : PRIMARY_RELATIVE_CUTOFF[intent]))
        .slice(0, Math.min(3, limit)).map(v => ({ ...v, category: 'primary' }))
      // A server action imported by a client-side flow is a concrete behavior boundary.
      // Prefer it over lower-ranked configuration files without exposing a full neighbor set.
      const selectedIds=new Set(primaryRanked.map(v=>v.file.file_id))
      for(const primary of [...primaryRanked]) {
        const actions=db.prepare(`SELECT f.* FROM edges e JOIN files f ON f.file_id=e.target_id WHERE e.source_id=? AND e.edge_type='imports'`).all(primary.file.file_id)
        const action=actions.find(file=>!selectedIds.has(file.file_id)&&/(^|\/)actions?\//.test(file.path))
        if(!action) continue
        const candidate={file:action,architecture:classifyArchitecture(action,hints),score:primary.score*0.9,evidence:primary.evidence,ownSymbols:symbolsByFile.get(action.file_id)??[],category:'primary'}
        const replaceAt=primaryRanked.length-1
        if(replaceAt>=0) { selectedIds.delete(primaryRanked[replaceAt].file.file_id);primaryRanked[replaceAt]=candidate;selectedIds.add(action.file_id) }
        break
      }
    }

    const selected = new Map(primaryRanked.map(v => [v.file.file_id, v]))
    const primaryIds = new Set(primaryRanked.map(v => v.file.file_id))
    const relatedCandidates = new Map()
    for (const primary of primaryRanked) {
      if(compact && depth===0) break
      const outgoing = db.prepare(`SELECT f.*, e.edge_type FROM edges e JOIN files f ON f.file_id=e.target_id
        WHERE e.source_id=? AND e.edge_type IN ('imports','tests')`).all(primary.file.file_id)
      const incoming = db.prepare(`SELECT f.*, e.edge_type FROM edges e JOIN files f ON f.file_id=e.source_id
        WHERE e.target_id=? AND e.edge_type IN ('imports','tests')`).all(primary.file.file_id)
      for (const [neighbor,direction] of [...outgoing.map(v=>[v,'outgoing']), ...incoming.map(v=>[v,'incoming'])]) {
        if (selected.has(neighbor.file_id)) continue
        const architecture = classifyArchitecture(neighbor, hints)
        const candidate = {
          file:neighbor,
          architecture,
          score:primary.score * 0.45 + neighbor.importance + (direction === 'outgoing' ? 1 : 0),
          evidence:0,
          ownSymbols:symbolsByFile.get(neighbor.file_id) ?? [],
          category:neighbor.is_test ? 'tests' : 'related',
          via:neighbor.edge_type,
          direction
        }
        const existing=relatedCandidates.get(neighbor.file_id)
        if(!existing || candidate.score>existing.score) relatedCandidates.set(neighbor.file_id,candidate)
      }
    }
    for(const candidate of [...relatedCandidates.values()].sort((a,b)=>b.score-a.score || a.file.path.localeCompare(b.file.path))) {
      if(selected.size>=limit) break
      selected.set(candidate.file.file_id,candidate)
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

    // Symbol relevance is decided per file, after file relevance: the best range inside
    // a correct file is the query-matching behavior that uses relevant imported bindings,
    // not merely the first or the largest matching declaration.
    const constructionQuery = /\bconstruct|\binstantiat/i.test(profile.raw)
    const relationQuery = constructionQuery || /\bconsum|\bintegrat|\bappl(?:y|ies|ied)\b|\bwired?\b/i.test(profile.raw)
    const bindingRelevance = ref => {
      const primary = primaryIds.has(ref.file_id)
      // A config constant named after the domain (RUSH, CLEANING) is read by most methods
      // of a domain file; it says nothing about which behavior the flow/impact goes through.
      if (!CALLABLE_KINDS.has(ref.kind) && !primary && (intent === 'flow' || intent === 'impact')) return 0
      if (ref.typeOnly && intent === 'flow') return 0
      let relevance = weightedScore(ref.name, qTokens, weights) / 3 + (primary ? 1.5 : 0)
      if (!CALLABLE_KINDS.has(ref.kind) && intent !== 'navigation') relevance *= 0.5
      return relevance
    }
    const choices = new Map()
    const chooseSymbols = async v => {
      if (!choices.has(v.file.file_id)) {
        const lines = qTokens.length ? await sourceLines(v.file.path) : null
        const bindings = v.file.is_test ? [] : refsFrom(v.file.file_id).filter(ref => !ref.is_test).map(ref => ({ ...ref, relevance: bindingRelevance(ref), primary: primaryIds.has(ref.file_id) }))
        const ranked = qTokens.length ? rankFileSymbols({ symbols: v.ownSymbols, lines, terms: qTokens, weights, intent, bindings, relationQuery, constructionQuery, maxLines }) : []
        choices.set(v.file.file_id, { ranked, best: ranked[0] ?? null, bindings, lines })
      }
      return choices.get(v.file.file_id)
    }

    const values = [...selected.values()].sort((a, b) => b.score - a.score)
    for (const v of values) await chooseSymbols(v)

    const makeEntry = v => {
      const choice = choices.get(v.file.file_id)
      const best = choice?.best
      const matchingSymbols = qTokens.length ? v.ownSymbols.filter(symbol => scoreText(`${symbol.name} ${symbol.qualified_name}`, qTokens) > 0) : []
      const symbolEvidence = best ? [{ name: best.symbol.name, qualifiedName: best.symbol.qualified_name, kind: best.symbol.kind, lines: [best.symbol.start_line, best.symbol.end_line] }] : []
      const exactLines = best ? [best.symbol.start_line, best.symbol.end_line] : undefined
      const fileLines = Math.max(1, Number(v.file.line_count ?? 1))
      let readLines=exactLines?[Math.max(1,exactLines[0]-6),Math.min(fileLines,exactLines[1]+8)]:[1,Math.min(fileLines,80)]
      // A long symbol is narrowed to the window where the relevant bindings and terms are used.
      // The top-ranked target keeps its whole symbol (up to maxLines) as the anchor.
      if(best&&choice.lines&&(v!==values[0]||best.symbol.kind==='class')) {
        const focused=focusRange([Number(best.symbol.start_line),Number(best.symbol.end_line)],choice.lines,{names:best.usedBindings.filter(binding=>binding.primary).map(binding=>binding.localName),terms:qTokens,weights})
        if(focused[0]!==Number(best.symbol.start_line)||focused[1]!==Number(best.symbol.end_line))readLines=focused
      }
      readLines[1]=Math.min(readLines[1],readLines[0]+maxLines-1)
      const estimatedLineBytes=Math.max(1,Math.ceil(Number(v.file.size_bytes??0)/fileLines))
      readLines[1]=Math.min(readLines[1],readLines[0]+Math.max(1,Math.floor(maxBytes/estimatedLineBytes))-1)
      let reason
      if (profile.architectureOverview && v.category === 'primary') reason = `${v.architecture.roleLabel}: ${v.architecture.reason}; importance ${Number(v.file.importance).toFixed(2)}`
      else if (matchingSymbols.length) reason = `Matches symbols: ${matchingSymbols.slice(0, 3).map(symbol => symbol.qualified_name).join(', ')}`
      else if (v.via) reason = `${v.via} relation to a primary match`
      else reason = `Matches query terms: ${qTokens.filter(term => scoreText(`${v.file.path} ${v.file.summary ?? ''}`, [term]) > 0).slice(0, 4).join(', ') || 'symbol match'}`
      const why = []
      if (v.startupEntry > 0) why.push('application entry')
      const nameTerms = best ? qTokens.filter(term => termMatch(best.symbol.name, term)) : []
      if (nameTerms.length) why.push(`name matches ${nameTerms.slice(0, 3).join(', ')}`)
      if (best?.usedBindings.length) why.push(`uses ${best.usedBindings.slice(0, 2).map(binding => binding.name).join(', ')}`)
      else if (best?.bodyTerms.length) why.push(`body mentions ${best.bodyTerms.slice(0, 3).join(', ')}`)
      if (v.linkedFrom && !best?.usedBindings.length) why.push(v.linkedFrom)
      return {
        path: v.file.path,
        score:v.score,
        role: v.architecture.role,
        ...(exactLines ? { lines: exactLines } : {}),
        ...(symbolEvidence.length ? { symbols: symbolEvidence } : {}),
        reason,
        precisionReason: why.join('; ') || reason,
        ...(v.via ? { relation:v.via } : {}),
        ...(v.direction ? { direction:v.direction } : {}),
        read: {
          required: v.category === 'primary',
          lines: readLines,
          command: `stellar source ${JSON.stringify(v.file.path)} --lines ${readLines[0]}:${readLines[1]} --json`
        }
      }
    }

    const meta = db.prepare('SELECT graph_version FROM project_meta LIMIT 1').get()
    const primary = values.filter(v => v.category === 'primary').slice(0, 3).map(makeEntry)
    const relatedFiles=(compact&&depth===0)?[]:values.filter(v=>v.category==='related').slice(0,4).map(makeEntry)
    const tests=compact?[]:values.filter(v=>v.category==='tests').slice(0,3).map(makeEntry)
    if(compact) {
      // In a flow, a primary file reached only as the callee of another primary file's
      // used binding is reported as relatedEvidence from that caller: the caller is where
      // the behavior happens, the callee range is the precise implementation it reaches.
      const calleeIds=new Set()
      const callerIds=new Set()
      if(intent==='flow'&&depth>0) {
        const rankOf=id=>primaryRanked.findIndex(v=>v.file.file_id===id)
        for(const {caller,callee,range} of flowCallees) {
          if(caller===callee||rankOf(caller)<0||rankOf(callee)<0||calleeIds.has(caller)||callerIds.has(callee))continue
          // Only when the callee's own most relevant range is the referenced symbol; a callee
          // whose best evidence lies elsewhere is an independent primary target.
          const best=choices.get(callee)?.best?.symbol
          if(!best||Number(best.start_line)<range[0]||Number(best.end_line)>range[1])continue
          const mutual=flowCallees.some(link=>link.caller===callee&&link.callee===caller)
          if(mutual&&rankOf(callee)<rankOf(caller))continue
          calleeIds.add(callee)
          callerIds.add(caller)
        }
      }
      const kept=primary.filter(v=>!calleeIds.has(v.path))
      const targets=kept.slice(0,Math.min(3,limit)).map(v=>({path:v.path,lines:v.read.lines,symbol:v.symbols?.[0]?.qualifiedName??null,confidence:Number((v.score/(kept[0].score||1)).toFixed(2)),reason:v.precisionReason}))
      const targetPaths=new Set(targets.map(target=>target.path))
      const relatedHints=depth>0?relatedFiles.filter(v=>!targetPaths.has(v.path)).slice(0,Math.max(0,limit-targets.length)).map(v=>({path:v.path,lines:v.read.lines,symbol:v.symbols?.[0]?.qualifiedName??null,relation:v.relation??'imports',direction:v.direction??'outgoing'})):[]
      const evidenceLimit=depth>0?Math.min(EVIDENCE_LIMITS[intent]??1,Math.max(0,limit-targets.length)):0
      const evidenceCandidates=[]
      if(evidenceLimit>0) for(const primaryValue of primaryRanked.filter(v=>!calleeIds.has(v.file.file_id))) {
        const choice=await chooseSymbols(primaryValue)
        const primaryLines=choice.lines ?? await sourceLines(primaryValue.file.path)
        if(!primaryLines)continue
        const anchor=choice.best?.symbol
        const rankIndex=symbol=>choice.ranked.findIndex(entry=>entry.symbol===symbol)
        const bodyOf=symbol=>primaryLines.slice(Math.max(0,Number(symbol.start_line)-1),Number(symbol.end_line)).join('\n')
        // Outgoing: an imported symbol whose binding is used inside the relevant behavior.
        for(const ref of choice.bindings) {
          if(ref.typeOnly&&intent!=='editing-prep')continue
          const usageSymbols=primaryValue.ownSymbols.filter(symbol=>usesBinding(bodyOf(symbol),ref.localName))
          if(!usageSymbols.length)continue
          const lexical=weightedScore(`${ref.name} ${ref.qualified_name}`,qTokens,weights)
          const fileLexical=weightedScore(ref.path,qTokens,weights)
          if(intent==='navigation' && lexical+fileLexical<=0)continue
          const preciseAnchor=anchor&&Number(anchor.end_line)-Number(anchor.start_line)+1<=maxLines/2
          const inAnchor=preciseAnchor?usageSymbols.some(symbol=>Number(symbol.start_line)<=Number(anchor.start_line)&&Number(symbol.end_line)>=Number(anchor.end_line)&&(symbol===anchor||symbol.kind!=='class')):false
          const usageSymbol=[...usageSymbols].sort((a,b)=>{
            const ra=rankIndex(a),rb=rankIndex(b)
            return (ra<0?1e9:ra)-(rb<0?1e9:rb)||(Number(a.end_line)-Number(a.start_line))-(Number(b.end_line)-Number(b.start_line))
          })[0]
          const usageText=bodyOf(usageSymbol)
          const usageRank=rankIndex(usageSymbol)
          const usageRelevant=usageRank>=0&&usageRank<3?4:0
          const callable=CALLABLE_KINDS.has(ref.kind)?4:0
          const callLike=new RegExp(`(?<![\\w$])${escapeRegex(ref.localName)}\\s*[.(]`).test(usageText)?4:0
          const primaryTarget=primaryIds.has(ref.file_id)?8:0
          // A non-callable import (config constant, enum) is grounded only when the
          // relevant behavior itself reads it; otherwise it stays a navigation hint.
          if(!CALLABLE_KINDS.has(ref.kind)&&intent!=='navigation'&&!inAnchor)continue
          const declaration=!CALLABLE_KINDS.has(ref.kind)&&intent!=='navigation'?6:0
          const promotedCallee=calleeIds.has(ref.file_id)?10:0
          // Grounded evidence needs query relevance of its own (symbol, path or file match).
          // A call made by the anchor with no lexical handle (a UI helper, or the only callee
          // of a tiny flow function) is kept only as a fallback; see weakEvidence below.
          const weak=lexical+fileLexical<=0&&!promotedCallee&&!((rankedById.get(ref.file_id)?.evidence??0)>0)
          if(weak&&!inAnchor)continue
          const score=lexical*2+fileLexical*0.5+(inAnchor?14:0)+primaryTarget+usageRelevant+callable+callLike+promotedCallee-declaration+Number(ref.importance??0)
          // A referenced class is a container; narrow it to its best-ranked member when one matches.
          let range={symbol:ref.qualified_name,start:Number(ref.start_line),end:Number(ref.end_line)}
          if(ref.kind==='class') {
            const owner=rankedById.get(ref.file_id)??enriched.find(v=>v.file.file_id===ref.file_id)
            const inner=owner?(await chooseSymbols(owner)).ranked.find(entry=>entry.symbol!==undefined&&Number(entry.symbol.start_line)>=range.start&&Number(entry.symbol.end_line)<=range.end&&entry.symbol.kind!=='class'):null
            if(inner)range={symbol:inner.symbol.qualified_name,start:Number(inner.symbol.start_line),end:Number(inner.symbol.end_line)}
          }
          evidenceCandidates.push({weak,path:ref.path,symbol:range.symbol,start:range.start,end:range.end,lineCount:Number(ref.line_count||ref.end_line),relation:'imported-symbol',direction:'outgoing',reason:`binding ${ref.localName} used in ${usageSymbol.qualified_name}`,score})
        }
        // Impact: consumers whose relevant code uses a symbol exported by the primary file.
        if(intent==='impact') {
          const consumers=new Map()
          for(const ref of referencesInto(db,primaryValue.file.file_id)) {
            if(primaryIds.has(ref.consumer_id))continue
            const consumer=enriched.find(v=>v.file.file_id===ref.consumer_id)
            if(!consumer||consumer.file.is_test)continue
            const lines=await sourceLines(consumer.file.path)
            if(!lines)continue
            const usage=consumer.ownSymbols.filter(symbol=>usesBinding(lines.slice(Math.max(0,Number(symbol.start_line)-1),Number(symbol.end_line)).join('\n'),ref.localName))
              .sort((a,b)=>weightedScore(b.name,qTokens,weights)-weightedScore(a.name,qTokens,weights)||(Number(a.end_line)-Number(a.start_line))-(Number(b.end_line)-Number(b.start_line)))[0]
            if(!usage)continue
            // Consumers are the answer to an impact question: rank them with the strongest edges.
            const score=30+fileEvidence(consumer)/4+weightedScore(usage.name,qTokens,weights)+(CALLABLE_KINDS.has(ref.kind)?4:0)
            const existing=consumers.get(consumer.file.file_id)
            if(!existing||score>existing.score)consumers.set(consumer.file.file_id,{path:consumer.file.path,symbol:usage.qualified_name,start:Number(usage.start_line),end:Number(usage.end_line),lineCount:Number(consumer.file.line_count||usage.end_line),relation:'imported-by',direction:'incoming',reason:`uses ${ref.name} from ${primaryValue.file.path}`,score})
          }
          evidenceCandidates.push(...consumers.values())
        }
        // Flow: a second behavior range in the same primary file that also uses a relevant
        // binding (for example where a collaborator is constructed and where it is consumed).
        if(intent==='flow'&&choice.best) {
          const second=choice.ranked.slice(1).find(entry=>entry.usedBindings.some(binding=>binding.primary)&&entry.score>=choice.best.score*0.5&&overlapLines([entry.symbol.start_line,entry.symbol.end_line],[anchor.start_line,anchor.end_line])===0&&entry.symbol.kind!=='class')
          if(second)evidenceCandidates.push({path:primaryValue.file.path,symbol:second.symbol.qualified_name,start:Number(second.symbol.start_line),end:Number(second.symbol.end_line),lineCount:Number(primaryValue.file.line_count||second.symbol.end_line),relation:'same-file-symbol',direction:'internal',reason:`also uses ${second.usedBindings.slice(0,2).map(binding=>binding.name).join(', ')}`,score:12+second.score/4})
        }
      }
      // Weak (anchor-call-only) evidence is used only when nothing lexically relevant exists.
      if(evidenceCandidates.some(candidate=>!candidate.weak&&candidate.relation==='imported-symbol'))evidenceCandidates.splice(0,evidenceCandidates.length,...evidenceCandidates.filter(candidate=>!candidate.weak))
      evidenceCandidates.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)||a.start-b.start)
      // Evidence must be competitive with the strongest edge; a long tail of weakly
      // related imports is what turns grounded context into noise.
      const evidenceFloor=(evidenceCandidates.find(candidate=>candidate.relation!=='same-file-symbol')?.score??0)*EVIDENCE_RELATIVE_CUTOFF
      const uniqueEvidence=[];const seenEvidence=new Set()
      for(const candidate of evidenceCandidates) {
        if(uniqueEvidence.length>=evidenceLimit)break
        if(candidate.relation!=='same-file-symbol'&&candidate.score<evidenceFloor)continue
        const key=`${candidate.path}:${candidate.symbol}`
        if(seenEvidence.has(key))continue
        seenEvidence.add(key);uniqueEvidence.push(candidate)
      }

      const relatedEvidence=[]
      const groundedFiles=[]
      if(options.withSource) {
        // Collect every requested range first, drop duplicates (same path, overlapping
        // lines), then split the byte budget fairly instead of first-come-first-served.
        const requests=[]
        for(const [index,target] of targets.entries()) requests.push({entry:target,range:target.lines,cap:maxLines,weight:index===0?1.5:1.2,minLines:1})
        for(const candidate of uniqueEvidence) {
          const start=Math.max(1,candidate.start-3)
          const end=Math.min(candidate.lineCount,candidate.end+5)
          requests.push({entry:{path:candidate.path,symbol:candidate.symbol,lines:[start,end],relation:candidate.relation,direction:candidate.direction,reason:candidate.reason},range:[start,end],cap:80,weight:1,minLines:3,evidence:true})
        }
        const taken=new Map()
        const prepared=[]
        for(const request of requests) {
          const lines=await sourceLines(request.entry.path)
          if(!lines)continue
          const start=Math.max(1,request.range?.[0]??1)
          let range=[start,Math.min(lines.length,Math.max(start,request.range?.[1]??start),start+request.cap-1)]
          if(range[1]<range[0])continue
          if(request.evidence)range=focusRange(range,lines,{terms:qTokens,weights})
          range=subtractTaken(range,taken.get(request.entry.path))
          if(!range)continue
          taken.set(request.entry.path,[...(taken.get(request.entry.path)??[]),range])
          const rendered=[]
          for(let n=range[0];n<=range[1];n++)rendered.push(`${n}: ${lines[n-1]}`)
          const costs=rendered.map(line=>Buffer.byteLength(line)+1)
          const lineScores=[]
          for(let n=range[0];n<=range[1];n++)lineScores.push(termCoverage(lines[n-1]??'',qTokens,weights).covered)
          prepared.push({...request,range,rendered,costs,lineScores,desired:costs.reduce((a,b)=>a+b,0)})
        }
        const allotted=allocateBudget(prepared,maxBytes)
        for(const [index,request] of prepared.entries()) {
          // When the fair share cannot hold the whole range, keep its densest window.
          const [from,to]=densestWindow(request.costs,request.lineScores,allotted[index])
          const count=to-from
          if(count<Math.min(request.minLines,request.costs.length))continue
          request.entry.lines=[request.range[0]+from,request.range[0]+to-1]
          request.entry.source=request.rendered.slice(from,to).join('\n')
          if(request.evidence)relatedEvidence.push(request.entry)
          if(!groundedFiles.includes(request.entry.path))groundedFiles.push(request.entry.path)
        }
      }
      const groundedPaths=new Set(groundedFiles)
      const finalRelatedHints=relatedHints.filter(item=>!groundedPaths.has(item.path))
      return {targets,relatedEvidence,relatedHints:finalRelatedHints,groundedFiles,intent,intentDetail:{confidence:intentDetail.confidence,signals:intentDetail.signals},depth,more:values.length>primary.length+finalRelatedHints.length+relatedEvidence.length||uniqueEvidence.length>relatedEvidence.length,...(options.withSource?{sourceOfTruth:'targets[].source and relatedEvidence[].source are repository source read live from the working tree'}:{})}
    }
    return {
      query: task,
      graphVersion: meta?.graph_version ?? 0,
      queryProfile: { terms: qTokens, concepts: profile.concepts, architectureOverview: profile.architectureOverview },
      intent,
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

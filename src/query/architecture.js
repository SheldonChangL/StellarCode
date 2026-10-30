import fs from 'node:fs/promises'
import path from 'node:path'

const GENERIC_CONTAINERS = new Set(['lib', 'game', 'features', 'feature', 'modules', 'module', 'packages', 'package', 'components', 'component', 'app', 'pages', 'ui'])
const UI_SEGMENTS = new Set(['ui', 'components', 'component', 'pages', 'page', 'views', 'view', 'screens', 'screen'])
const SERVICE_SEGMENTS = new Set(['services', 'service', 'actions', 'action', 'usecases', 'usecase', 'commands', 'command'])
const CORE_SEGMENTS = new Set(['core', 'domain', 'engine', 'engines', 'kernel', 'runtime', 'manager', 'managers'])
const INFRA_SEGMENTS = new Set(['infra', 'infrastructure', 'adapters', 'adapter', 'http', 'network', 'db', 'database', 'storage', 'repositories', 'repository', 'clients', 'client'])
const CONFIG_NAMES = new Set(['config', 'configuration', 'settings', 'env'])

function normalize(p) { return String(p ?? '').replaceAll('\\', '/').replace(/^\.\//, '') }
function withoutExt(name) { return name.replace(/\.[^.]+$/, '') }
function segments(filePath) { return normalize(filePath).toLowerCase().split('/').filter(Boolean) }

export function hierarchyForPath(filePath) {
  const p = normalize(filePath)
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 1) return { galaxy: 'root', module: 'root' }
  const galaxy = parts[0]
  const dirs = parts.slice(0, -1)
  if (dirs.length === 1) return { galaxy, module: galaxy }
  if (galaxy === 'packages' && dirs.length >= 2) return { galaxy, module: dirs.slice(0, 2).join('/') }
  if (dirs.length >= 3 && GENERIC_CONTAINERS.has(String(dirs[1]).toLowerCase())) {
    return { galaxy, module: dirs.slice(0, 3).join('/') }
  }
  return { galaxy, module: dirs.slice(0, 2).join('/') }
}

function candidatePathsFromPackage(pkg) {
  const values = []
  const add = value => {
    if (typeof value === 'string') values.push(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(add)
  }
  add(pkg?.main)
  add(pkg?.module)
  add(pkg?.browser)
  add(pkg?.bin)
  const scripts = pkg?.scripts ?? {}
  for (const [name, command] of Object.entries(scripts)) {
    if (!/(start|dev|serve|cli|worker|server)/i.test(name) || typeof command !== 'string') continue
    const matches = command.match(/(?:^|\s)(?:\.\/)?([\w@./-]+\.(?:[cm]?[jt]sx?|py))(?:\s|$)/g) ?? []
    for (const match of matches) {
      const found = match.trim().replace(/^\.\//, '')
      if (found) values.push(found)
    }
  }
  return values.map(v => normalize(v).replace(/^dist\//, 'src/').replace(/^build\//, 'src/'))
}

export async function loadArchitectureHints(root) {
  let pkg = null
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) } catch {}
  const declaredEntries = new Set(candidatePathsFromPackage(pkg))
  const framework = {
    next: Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next),
    vite: Boolean(pkg?.dependencies?.vite || pkg?.devDependencies?.vite),
    react: Boolean(pkg?.dependencies?.react || pkg?.devDependencies?.react)
  }
  return { packageJson: pkg, declaredEntries, framework }
}

function matchesDeclaredEntry(filePath, hints) {
  const p = normalize(filePath)
  for (const raw of hints?.declaredEntries ?? []) {
    const e = normalize(raw)
    if (p === e) return true
    const pNoExt = p.replace(/\.[^.]+$/, '')
    const eNoExt = e.replace(/\.[^.]+$/, '')
    if (pNoExt === eNoExt) return true
  }
  return false
}

export function classifyArchitecture(file, hints = {}) {
  const p = normalize(file.path)
  const lower = p.toLowerCase()
  const segs = segments(p)
  const name = String(file.name ?? path.posix.basename(p)).toLowerCase()
  const base = withoutExt(name)
  const isTest = Boolean(file.is_test ?? file.isTest) || /(^|\/)(tests?|__tests__|e2e|specs?)(\/|$)/.test(lower) || /\.(test|spec)\.[^.]+$/.test(lower)

  if (isTest) return { role: 'test', roleLabel: 'Test', reason: 'Test path or test filename convention', score: 0 }
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(lower) || /(^|\/)readme(?:\.|$)/.test(lower)) return { role: 'docs', roleLabel: 'Docs', reason: 'Documentation path', score: 0 }
  if (/(^|\/)(config|configs|settings)(\/|$)/.test(lower) || CONFIG_NAMES.has(base) || /(?:^|\.)(config|rc)\.[^.]+$/.test(name)) return { role: 'config', roleLabel: 'Config', reason: 'Configuration convention', score: 2 }

  if (matchesDeclaredEntry(p, hints)) return { role: 'application-entry', roleLabel: 'App Entry', reason: 'Declared by package metadata or run script', score: 100 }
  if (/^(?:src\/)?(?:main|bootstrap|entry|entrypoint)\.[^/]+$/.test(lower)) return { role: 'application-entry', roleLabel: 'App Entry', reason: 'Root application entry convention', score: 92 }
  if (/^src\/index\.[^/]+$/.test(lower) || /^index\.[^/]+$/.test(lower)) return { role: 'application-entry', roleLabel: 'App Entry', reason: 'Root source index', score: 78 }
  if (/^(?:src\/)?(?:server|cli|worker)\.[^/]+$/.test(lower)) return { role: 'application-entry', roleLabel: 'App Entry', reason: 'Executable entry convention', score: 82 }
  if (/(^|\/)app\/layout\.(?:tsx?|jsx?)$/.test(lower) || /(^|\/)pages\/_app\.(?:tsx?|jsx?)$/.test(lower)) return { role: 'application-entry', roleLabel: 'App Entry', reason: 'Framework application shell convention', score: 86 }

  if (['index', '__init__'].includes(base)) return { role: 'module-entry', roleLabel: 'Module Entry', reason: 'Nested module barrel/entry file', score: 8 }
  if (segs.some(s => CORE_SEGMENTS.has(s))) return { role: 'domain-core', roleLabel: 'Domain Core', reason: 'Core/domain/engine path convention', score: 26 }
  if (segs.some(s => SERVICE_SEGMENTS.has(s)) || /(service|manager|controller|orchestrator)/.test(base)) return { role: 'service', roleLabel: 'Service', reason: 'Service/action/orchestration convention', score: 20 }
  if (segs.some(s => UI_SEGMENTS.has(s)) || /\.(tsx|jsx)$/.test(lower)) return { role: 'ui', roleLabel: 'UI', reason: 'UI/component path or JSX/TSX file', score: 10 }
  if (segs.some(s => INFRA_SEGMENTS.has(s))) return { role: 'infrastructure', roleLabel: 'Infrastructure', reason: 'Infrastructure/adapter/storage path convention', score: 12 }
  return { role: 'source', roleLabel: 'Source', reason: 'General source file', score: 4 }
}

export function architectureRank(file, classification) {
  const importance = Number(file.importance ?? 0)
  const activity = Math.min(1, Number(file.git_activity ?? file.gitActivity ?? 0) / 20)
  return classification.score + importance * 24 + activity * 2
}

export function summarizeHierarchy(files) {
  const galaxyMap = new Map()
  const moduleMap = new Map()
  for (const file of files) {
    const { galaxy, module } = hierarchyForPath(file.path ?? file.id)
    const role = file.architecture?.role ?? file.role ?? 'source'
    const add = (map, id, extra) => {
      if (!map.has(id)) map.set(id, { id, label: id.split('/').at(-1), files: 0, tests: 0, lines: 0, importance: 0, maxImportance: 0, roles: {}, ...extra })
      const row = map.get(id)
      row.files++
      row.tests += role === 'test' ? 1 : 0
      row.lines += Number(file.lines ?? file.line_count ?? 0)
      row.importance += Number(file.importance ?? 0)
      row.maxImportance = Math.max(row.maxImportance, Number(file.importance ?? 0))
      row.roles[role] = (row.roles[role] ?? 0) + 1
    }
    add(galaxyMap, galaxy, { galaxy })
    add(moduleMap, module, { galaxy, module })
  }
  const finalize = rows => [...rows.values()].map(row => ({ ...row, importance: row.files ? Number((row.importance / row.files).toFixed(6)) : 0 }))
  return { galaxies: finalize(galaxyMap), modules: finalize(moduleMap) }
}

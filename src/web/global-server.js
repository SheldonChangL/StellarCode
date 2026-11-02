import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT } from '../core/constants.js'
import { projectSummaries, reconcileProjects, resolveRegisteredProject, markProjectAccess } from '../storage/registry.js'
import { ensureFreshProject } from '../core/global-runtime.js'
import { graphData, searchProject, fileDetail, related, impact, contextForTask, architectureOverview, changes } from '../query/query-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, 'public')

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function sendPublic(res, name) {
  const safe = path.basename(name)
  const file = path.join(publicDir, safe)
  try {
    const data = await fs.readFile(file)
    const ext = path.extname(file)
    const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream'
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60' })
    res.end(data)
    return true
  } catch { return false }
}

function projectApiMatch(pathname) {
  const match = pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/)
  return match ? { projectId: decodeURIComponent(match[1]), endpoint: match[2] || '/' } : null
}

export async function createGlobalWebServer(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT)
  const host = options.host ?? '127.0.0.1'
  const dirs = options.dirs
  const syncCache = new Map()
  const syncMinIntervalMs = Number(options.syncMinIntervalMs ?? 800)

  await reconcileProjects({ ...options, dirs })

  async function projectRoot(projectId) {
    const row = await resolveRegisteredProject(projectId, { ...options, dirs })
    const last = syncCache.get(row.project_id) ?? 0
    if (Date.now() - last >= syncMinIntervalMs) {
      await ensureFreshProject(row.project_id, { ...options, dirs })
      syncCache.set(row.project_id, Date.now())
    } else {
      await markProjectAccess(row.project_id, { ...options, dirs })
    }
    return row.repo_path
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      if (url.pathname === '/api/projects') return json(res, 200, await projectSummaries({ ...options, dirs }))

      const match = projectApiMatch(url.pathname)
      if (match) {
        const root = await projectRoot(match.projectId)
        const qopts = { ...options, dirs, sync: false }
        if (match.endpoint === '/graph') return json(res, 200, await graphData(root, { ...qopts, limit: Number(url.searchParams.get('limit') || 5000) }))
        if (match.endpoint === '/search') return json(res, 200, await searchProject(root, url.searchParams.get('q') || '', { ...qopts, limit: 12 }))
        if (match.endpoint === '/file') {
          const result = await fileDetail(root, url.searchParams.get('path') || '', qopts)
          return json(res, result ? 200 : 404, result ?? { error: 'not_found' })
        }
        if (match.endpoint === '/related') {
          const result = await related(root, url.searchParams.get('target') || '', qopts)
          return json(res, result ? 200 : 404, result ?? { error: 'not_found' })
        }
        if (match.endpoint === '/impact') {
          const result = await impact(root, url.searchParams.get('target') || '', { ...qopts, depth: Number(url.searchParams.get('depth') || 3), limit: 100 })
          return json(res, result ? 200 : 404, result ?? { error: 'not_found' })
        }
        if (match.endpoint === '/context') return json(res, 200, await contextForTask(root, url.searchParams.get('q') || '', { ...qopts, limit: 8 }))
        if (match.endpoint === '/architecture') return json(res, 200, await architectureOverview(root, qopts))
        if (match.endpoint === '/changes') return json(res, 200, await changes(root, qopts))
        return json(res, 404, { error: 'not_found' })
      }

      if (url.pathname === '/') return sendPublic(res, 'dashboard.html')
      if (/^\/project\/[^/]+$/.test(url.pathname)) return sendPublic(res, 'index.html')
      const staticName = url.pathname.replace(/^\//, '')
      if (['dashboard.css','dashboard.js','styles.css','app.js'].includes(staticName) && await sendPublic(res, staticName)) return
      return json(res, 404, { error: 'not_found' })
    } catch (error) {
      const status = ['PROJECT_UNAVAILABLE','PROJECT_IDENTITY_MISMATCH','PROJECT_NOT_REGISTERED'].includes(error.code) ? 404 : 500
      json(res, status, { error: error.code ?? 'INTERNAL', message: error.message })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const timer = setInterval(() => reconcileProjects({ ...options, dirs }).catch(() => {}), options.reconcileIntervalMs ?? 5 * 60 * 1000)
  timer.unref?.()
  server.once('close', () => clearInterval(timer))
  const actualPort = server.address()?.port ?? port
  return { server, port: actualPort, url: `http://${host}:${actualPort}` }
}

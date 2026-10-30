import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT } from '../core/constants.js'
import { graphData, searchProject, fileDetail, related, impact, contextForTask, changes } from '../query/query-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, 'public')

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

async function staticFile(res, pathname) {
  const safe = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = path.normalize(path.join(publicDir, safe))
  if (!file.startsWith(publicDir)) return false
  try {
    const data = await fs.readFile(file)
    const ext = path.extname(file)
    const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream'
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
    res.end(data)
    return true
  } catch {
    return false
  }
}

export async function createWebServer(projectRoot, options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT)
  const host = options.host ?? '127.0.0.1'
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      if (url.pathname === '/api/graph') return json(res, 200, await graphData(projectRoot, { limit: Number(url.searchParams.get('limit') || 5000) }))
      if (url.pathname === '/api/search') return json(res, 200, await searchProject(projectRoot, url.searchParams.get('q') || '', { limit: 12 }))
      if (url.pathname === '/api/file') {
        const result = await fileDetail(projectRoot, url.searchParams.get('path') || '')
        return json(res, result ? 200 : 404, result ?? { error: 'not_found' })
      }
      if (url.pathname === '/api/related') {
        const result = await related(projectRoot, url.searchParams.get('target') || '')
        return json(res, result ? 200 : 404, result ?? { error: 'not_found' })
      }
      if (url.pathname === '/api/impact') {
        const result = await impact(projectRoot, url.searchParams.get('target') || '', { depth: Number(url.searchParams.get('depth') || 3), limit: 100 })
        return json(res, result ? 200 : 404, result ?? { error: 'not_found' })
      }
      if (url.pathname === '/api/context') return json(res, 200, await contextForTask(projectRoot, url.searchParams.get('q') || '', { limit: 8 }))
      if (url.pathname === '/api/changes') return json(res, 200, await changes(projectRoot))
      if (await staticFile(res, url.pathname)) return
      json(res, 404, { error: 'not_found' })
    } catch (error) {
      json(res, 500, { error: error.code ?? 'INTERNAL', message: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address()?.port ?? port
  return { server, port: actualPort, url: `http://${host}:${actualPort}` }
}

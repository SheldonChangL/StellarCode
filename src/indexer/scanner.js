import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_IGNORES, MAX_SOURCE_BYTES, SUPPORTED_EXTENSIONS } from '../core/constants.js'

export function toPosix(input) {
  return input.split(path.sep).join('/')
}

export function isTestPath(relativePath) {
  const p = relativePath.toLowerCase()
  return /(^|\/)(test|tests|__tests__)(\/|$)/.test(p) || /\.(test|spec)\.[^.]+$/.test(p) || /^test_.*\.py$/.test(path.basename(p))
}

export function isGeneratedPath(relativePath) {
  const p = relativePath.toLowerCase()
  return p.includes('/generated/') || p.includes('/gen/') || /\.generated\./.test(p)
}

async function inspectFile(absPath, relativePath, stat, previous) {
  if (stat.size > MAX_SOURCE_BYTES) return null
  const extension = path.extname(absPath).toLowerCase()
  const language = SUPPORTED_EXTENSIONS.get(extension)
  if (!language) return null
  const modifiedAt = stat.mtime.toISOString()
  if (previous && previous.sizeBytes === stat.size && previous.modifiedAt === modifiedAt && previous.contentHash) {
    return {
      fileId: toPosix(relativePath), path: toPosix(relativePath), absPath, name: path.basename(relativePath),
      extension, language, sizeBytes: stat.size, lineCount: previous.lineCount ?? 0,
      contentHash: previous.contentHash, modifiedAt, isTest: isTestPath(toPosix(relativePath)),
      isGenerated: isGeneratedPath(toPosix(relativePath)), reusedHash: true
    }
  }
  const content = await fs.readFile(absPath)
  if (content.includes(0)) return null
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  const text = content.toString('utf8')
  return {
    fileId: toPosix(relativePath),
    path: toPosix(relativePath),
    absPath,
    name: path.basename(relativePath),
    extension,
    language,
    sizeBytes: stat.size,
    lineCount: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    contentHash: hash,
    modifiedAt,
    isTest: isTestPath(toPosix(relativePath)),
    isGenerated: isGeneratedPath(toPosix(relativePath))
  }
}

export async function scanRepository(root, options = {}) {
  const ignores = new Set([...DEFAULT_IGNORES, ...(options.ignores ?? [])])
  const files = []
  const warnings = []
  const previousByPath = options.previousByPath ?? new Map()
  const candidates = []
  const dirQueue = [root]
  const dirConcurrency = Math.max(1, Math.min(Number(options.dirConcurrency ?? 24), 64))
  const fileConcurrency = Math.max(1, Math.min(Number(options.fileConcurrency ?? 64), 256))

  while (dirQueue.length) {
    const batch = dirQueue.splice(0, dirConcurrency)
    const listings = await Promise.all(batch.map(async dir => {
      try { return { dir, entries: await fs.readdir(dir, { withFileTypes: true }) } }
      catch (error) {
        warnings.push({ path: toPosix(path.relative(root, dir)), code: 'READ_DIR', message: error.message })
        return { dir, entries: [] }
      }
    }))
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (ignores.has(entry.name) || entry.isSymbolicLink()) continue
        const abs = path.join(dir, entry.name)
        const rel = path.relative(root, abs)
        if (entry.isDirectory()) dirQueue.push(abs)
        else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) candidates.push({ abs, rel })
      }
    }
  }

  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= candidates.length) return
      const { abs, rel } = candidates[index]
      try {
        const stat = await fs.stat(abs)
        const relPosix = toPosix(rel)
        const info = await inspectFile(abs, rel, stat, previousByPath.get(relPosix))
        if (info) files.push(info)
      } catch (error) {
        warnings.push({ path: toPosix(rel), code: 'READ_FILE', message: error.message })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(fileConcurrency, Math.max(1, candidates.length)) }, () => worker()))
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, warnings }
}

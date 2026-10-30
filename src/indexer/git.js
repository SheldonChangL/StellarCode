import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function gitHead(root) {
  return await git(root, ['rev-parse', 'HEAD']) || null
}

export async function gitStatus(root) {
  const out = await git(root, ['status', '--porcelain=v1', '-z'])
  if (!out) return []
  return out.split('\0').filter(Boolean).map(entry => ({ code: entry.slice(0, 2), path: entry.slice(3) }))
}

export async function gitActivity(root, maxCommits = 200) {
  const out = await git(root, ['log', `-n${maxCommits}`, '--name-only', '--pretty=format:'])
  const counts = new Map()
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().replaceAll('\\', '/')
    if (!p) continue
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return counts
}

export async function gitRenameHints(root) {
  const out = await git(root, ['diff', '--name-status', '-M', 'HEAD'])
  if (!out) return []
  return out.split(/\r?\n/).map(line => line.split('\t')).filter(parts => parts[0]?.startsWith('R')).map(parts => ({
    confidence: Number(parts[0].slice(1) || 100) / 100,
    oldPath: parts[1]?.replaceAll('\\', '/'),
    newPath: parts[2]?.replaceAll('\\', '/')
  })).filter(v => v.oldPath && v.newPath)
}

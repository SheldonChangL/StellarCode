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

// Files that history shows changing together with `files`: for every commit that touched
// some of them, each other file in that commit scores the number of `files` it changed with.
// Deterministic, read from `git log` alone. Large commits (imports, renames, formatting) say
// nothing about what belongs together and are skipped. `before` (ISO time) limits history,
// for evaluation against a past moment.
export async function coChangedFiles(root, files, { limit = 3, before = null, maxCommits = 400, maxCommitFiles = 40, accept = null } = {}) {
  const given = new Set(files)
  if (!given.size) return []
  const out = await git(root, ['log', `-n${maxCommits}`, ...(before ? [`--before=${before}`] : []), '--name-only', '--pretty=format:%x00'])
  const scores = new Map()
  for (const commit of out.split('\0')) {
    const changed = commit.split(/\r?\n/).map(line => line.trim().replaceAll('\\', '/')).filter(Boolean)
    if (changed.length < 2 || changed.length > maxCommitFiles) continue
    const shared = changed.filter(file => given.has(file)).length
    if (!shared) continue
    for (const file of changed) if (!given.has(file) && (!accept || accept(file))) scores.set(file, (scores.get(file) ?? 0) + shared)
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([file, score]) => ({ path: file, score }))
}

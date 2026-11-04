import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Directories whose content defines StellarCode runtime behaviour. Benchmark tooling lives
// in src/benchmark and is part of the fingerprint too: a campaign must run one exact build.
export const RUNTIME_PATHS = ['src', 'bin', 'package.json']
// Ranking/context behaviour that v0.5.6 freezes; their git tree ids are recorded so a
// report can prove the runtime equals a named release.
// src/cli.js is excluded: v0.5.6 adds benchmark subcommand routing there; its non-benchmark
// command paths are covered by the existing CLI tests instead.
export const FROZEN_RUNTIME_TREES = ['src/query', 'src/indexer', 'src/mcp', 'src/core', 'src/storage', 'src/platform', 'src/web']

export async function fileSha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function walk(root, rel, out) {
  const full = path.join(root, rel)
  let stat
  try { stat = await fs.stat(full) } catch { return }
  if (stat.isFile()) { out.push(rel); return }
  if (!stat.isDirectory()) return
  for (const name of (await fs.readdir(full)).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    await walk(root, path.join(rel, name), out)
  }
}

async function git(root, args) {
  try { return (await execFileAsync('git', ['-C', root, ...args], { maxBuffer: 10 * 1024 * 1024 })).stdout.trim() } catch { return null }
}

// Content hash of every runtime file (tracked or not), plus git identity when available.
export async function runtimeFingerprint(packageRoot) {
  const files = []
  for (const rel of RUNTIME_PATHS) await walk(packageRoot, rel, files)
  const hash = crypto.createHash('sha256')
  for (const rel of files.sort()) {
    hash.update(rel.replaceAll('\\', '/')); hash.update('\u0000')
    hash.update(await fs.readFile(path.join(packageRoot, rel))); hash.update('\u0000')
  }
  let packageVersion = null
  try { packageVersion = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version ?? null } catch {}
  const commit = await git(packageRoot, ['rev-parse', 'HEAD'])
  const porcelain = commit == null ? null : await git(packageRoot, ['status', '--porcelain', '--', ...RUNTIME_PATHS])
  // Same filter as the content hash: dotfiles (e.g. .DS_Store) are not runtime source.
  const dirtyFiles = porcelain ? porcelain.split(/\r?\n/).map(line => line.slice(3)).filter(p => !p.split('/').some(part => part.startsWith('.'))) : []
  const trees = {}
  if (commit) for (const rel of FROZEN_RUNTIME_TREES) trees[rel] = await git(packageRoot, ['rev-parse', `HEAD:${rel}`])
  return {
    commit, packageVersion,
    dirty: porcelain == null ? null : dirtyFiles.length > 0,
    dirtyFiles,
    contentHash: hash.digest('hex'),
    files: files.length,
    frozenTrees: trees
  }
}

// Stable repository identity independent of clone directory names: the root commit(s).
export async function repositoryIdentity(root) {
  const roots = await git(root, ['rev-list', '--max-parents=0', 'HEAD'])
  return { rootCommits: roots ? roots.split(/\r?\n/).sort() : null, remote: await git(root, ['remote', 'get-url', 'origin']) }
}

// Decomposes time-to-first-relevant-source from one run's telemetry. All values are
// milliseconds from agent process spawn. Pure measurement; never alters the agent.
export function latencyDecomposition(metrics = {}, firstRelevantMs = null) {
  const interactions = (metrics.interactions ?? []).filter(i => i.startedAtMs != null || i.completedAtMs != null)
  const byStart = [...interactions].sort((a, b) => (a.startedAtMs ?? a.completedAtMs) - (b.startedAtMs ?? b.completedAtMs))
  const first = byStart[0] ?? null
  // The relevant source read is attributed to the tool completion nearest its timestamp
  // (both clocks share the agent spawn origin; a few ms of event-loop skew is tolerated).
  let relevant = null
  if (firstRelevantMs != null) for (const i of interactions) {
    if (i.completedAtMs == null || Math.abs(i.completedAtMs - firstRelevantMs) > 50) continue
    if (!relevant || Math.abs(i.completedAtMs - firstRelevantMs) < Math.abs(relevant.completedAtMs - firstRelevantMs)) relevant = i
  }
  const context = byStart.find(i => i.kind === 'stellarContext') ?? null
  return {
    firstEventMs: metrics.timing?.firstEventMs ?? null,
    firstModelEventMs: metrics.timing?.firstModelEventMs ?? null,
    agentStartToFirstToolMs: first?.startedAtMs ?? null,
    firstToolDurationMs: first?.durationMs ?? null,
    firstToolKind: first?.kind ?? null,
    stellarContextDurationMs: context?.durationMs ?? null,
    firstRelevantToolStartedAtMs: relevant?.startedAtMs ?? null,
    firstRelevantToolDurationMs: relevant?.durationMs ?? null,
    firstRelevantToolSequence: relevant?.sequence ?? null,
    firstRelevantSourceCompletionMs: firstRelevantMs
  }
}

async function readLines(file) {
  try { return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return null }
}

// Retroactive decomposition for runs recorded before v0.5.6 telemetry. Uses the raw
// stream-json events and their arrival times persisted in each diagnostic directory.
// Claude stream-json only: tool start = arrival of the assistant event carrying tool_use,
// completion = arrival of the user event carrying the matching tool_result.
export async function decomposeDiagnosticDirectory(dir, { expectedFiles = [], firstRelevantMs = null } = {}) {
  const events = await readLines(path.join(dir, 'raw-events.jsonl'))
  const times = await readLines(path.join(dir, 'event-times.jsonl'))
  if (!events || !times || events.length !== times.length) return null
  const started = new Map(), interactions = []
  let firstModelEventMs = null, sequence = 0
  let init = null
  for (let i = 0; i < events.length; i++) {
    const e = events[i], at = times[i].atMs
    if (e.type === 'system' && e.subtype === 'init' && init == null) init = at
    if (e.type === 'assistant' && firstModelEventMs == null) firstModelEventMs = at
    const content = e.message?.content
    if (e.type === 'assistant' && Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use') started.set(b.id, { at, name: b.name, input: b.input })
    if (e.type === 'user' && Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result') {
      const s = started.get(b.tool_use_id)
      if (!s) continue
      const text = JSON.stringify(s.input ?? '')
      interactions.push({ sequence: ++sequence, tool: s.name, kind: /\bstellar\s+context\b/.test(text) ? 'stellarContext' : /\bstellar\s+source\b/.test(text) ? 'stellarSource' : 'other', startedAtMs: s.at, completedAtMs: at, durationMs: at - s.at, mentionsExpected: expectedFiles.some(f => text.includes(f)) })
    }
  }
  const metrics = { interactions, timing: { firstEventMs: times[0]?.atMs ?? null, firstModelEventMs } }
  return { ...latencyDecomposition(metrics, firstRelevantMs), agentInitEventMs: init, interactions: interactions.length }
}

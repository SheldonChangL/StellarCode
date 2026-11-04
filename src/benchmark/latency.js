import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadBenchmarkTasks } from './tasks.js'
import { prepareBenchmarkSnapshot } from './snapshot.js'
import { stellarContextArgs } from './agents.js'
import { runtimeFingerprint, fileSha256 } from './campaign.js'

const execFileAsync = promisify(execFile)

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const rank = Math.ceil(p / 100 * v.length) - 1
  return v[Math.min(v.length - 1, Math.max(0, rank))]
}

function distributionOf(values) {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }
}

export function embeddedSourceBytes(value) {
  let total = 0
  const visit = v => {
    if (Array.isArray(v)) { v.forEach(visit); return }
    if (!v || typeof v !== 'object') return
    for (const [key, child] of Object.entries(v)) {
      if (key === 'source' && typeof child === 'string') total += Buffer.byteLength(child)
      else visit(child)
    }
  }
  visit(value)
  return total
}

async function timed(bin, args, options) {
  const started = performance.now()
  const { stdout } = await execFileAsync(process.execPath, [bin, ...args], { ...options, maxBuffer: 64 * 1024 * 1024 })
  return { ms: performance.now() - started, stdout }
}

// Deterministic local cost of the STELLAR condition's first command, without any agent or
// provider. Runs against a clean detached worktree of the project's HEAD with a freshly
// built index in a private data directory, through the same read-only snapshot path the
// agent benchmark uses. Only task.prompt is sent to StellarCode.
//
// cold = a new CLI process on a freshly copied snapshot file (no process or SQLite state;
//        the OS page cache may still be warm, so this is "cold process", not "cold disk").
// warm = repeated new CLI processes on the same snapshot file.
export async function runLocalLatency({ projectRoot, tasksFile, repeat = 5, stellarBin, env = process.env, onProgress }) {
  const { tasks } = await loadBenchmarkTasks(tasksFile)
  const packageRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
  stellarBin = stellarBin ?? path.join(packageRoot, 'bin', 'stellar.js')
  const commit = (await execFileAsync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'])).stdout.trim()
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-latency-'))
  const worktree = path.join(base, 'repo')
  await execFileAsync('git', ['-C', projectRoot, 'worktree', 'add', '--detach', '--quiet', worktree, commit])
  try {
    const dirs = { STELLAR_DATA_DIR: path.join(base, 'data'), STELLAR_CACHE_DIR: path.join(base, 'cache'), STELLAR_LOG_DIR: path.join(base, 'logs') }
    const indexEnv = { ...env, ...dirs, STELLAR_BENCH_INDEX_FILE: '', STELLAR_BENCH_TRACE_FILE: '' }
    const floor = []
    for (let i = 0; i < repeat; i++) floor.push((await timed(stellarBin, ['--version'], { cwd: worktree, env: indexEnv })).ms)
    await timed(stellarBin, ['init', worktree], { cwd: worktree, env: indexEnv })
    const build = await timed(stellarBin, ['sync', worktree, '--json'], { cwd: worktree, env: indexEnv })
    const noop = []
    for (let i = 0; i < repeat; i++) noop.push((await timed(stellarBin, ['sync', worktree, '--json'], { cwd: worktree, env: indexEnv })).ms)
    let indexedFiles = null
    try { const s = JSON.parse(build.stdout); indexedFiles = s.counts?.files ?? s.files ?? s.stats?.files ?? null } catch {}
    const snapshot = await prepareBenchmarkSnapshot(worktree, worktree, base, commit, indexEnv)
    const perTask = []
    const all = { cold: [], warm: [] }
    for (const task of tasks) {
      const samples = { cold: [], warm: [] }
      let contextJsonBytes = null, sourceBytes = null, targets = null
      for (let i = 0; i < repeat; i++) {
        const copy = path.join(base, `cold-${encodeURIComponent(task.id)}-${i}.db`)
        await fs.copyFile(snapshot.indexFile, copy)
        const r = await timed(stellarBin, stellarContextArgs(task.prompt), { cwd: worktree, env: { ...indexEnv, STELLAR_BENCH_INDEX_FILE: copy } })
        samples.cold.push(r.ms)
        await fs.rm(copy, { force: true })
      }
      for (let i = 0; i < repeat; i++) {
        const r = await timed(stellarBin, stellarContextArgs(task.prompt), { cwd: worktree, env: { ...indexEnv, STELLAR_BENCH_INDEX_FILE: snapshot.indexFile } })
        samples.warm.push(r.ms)
        if (contextJsonBytes == null) {
          contextJsonBytes = Buffer.byteLength(r.stdout)
          try { const parsed = JSON.parse(r.stdout); sourceBytes = embeddedSourceBytes(parsed); targets = Array.isArray(parsed.targets) ? parsed.targets.length : null } catch {}
        }
      }
      all.cold.push(...samples.cold); all.warm.push(...samples.warm)
      perTask.push({ taskId: task.id, category: task.category, contextJsonBytes, embeddedSourceBytes: sourceBytes, targets, coldMs: distributionOf(samples.cold), warmMs: distributionOf(samples.warm) })
      onProgress?.({ task: task.id, done: perTask.length, total: tasks.length })
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      projectRoot, projectCommit: commit, tasksFile, taskHash: await fileSha256(tasksFile), repeat,
      runtime: await runtimeFingerprint(packageRoot),
      environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, cpus: os.cpus().length },
      command: ['stellar', ...stellarContextArgs('<task prompt>')],
      definitions: {
        cliMs: 'Wall time of one new `node bin/stellar.js` process, including Node startup, measured from this harness.',
        cold: 'New process on a freshly copied read-only index snapshot (OS page cache may be warm).',
        warm: 'New process on an already-used snapshot file.',
        nodeCliFloorMs: 'Wall time of `stellar --version`: the process-startup floor no context call can beat.',
        indexBuildMs: 'Full `stellar sync` of the clean worktree into an empty data directory.',
        indexSyncNoopMs: '`stellar sync` with no source changes (lazy-sync cost when nothing changed).'
      },
      indexedFiles,
      nodeCliFloorMs: distributionOf(floor),
      indexBuildMs: build.ms,
      indexSyncNoopMs: distributionOf(noop),
      contextColdMs: distributionOf(all.cold),
      contextWarmMs: distributionOf(all.warm),
      contextJsonBytes: distributionOf(perTask.map(t => t.contextJsonBytes).filter(Number.isFinite)),
      embeddedSourceBytes: distributionOf(perTask.map(t => t.embeddedSourceBytes).filter(Number.isFinite)),
      tasks: perTask
    }
  } finally {
    try { await execFileAsync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktree]) } catch {}
    await fs.rm(base, { recursive: true, force: true })
  }
}

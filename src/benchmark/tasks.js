import fs from 'node:fs/promises'
import path from 'node:path'
import { StellarError } from '../core/errors.js'

export const BENCHMARK_SCHEMA_VERSION = 1

export function defaultBenchmarkConfig() {
  return {
    version: BENCHMARK_SCHEMA_VERSION,
    notes: 'Replace the example tasks with real repository questions. expectedFiles are the answer key and are never shown to the agent.',
    tasks: [
      {
        id: 'example-entry',
        enabled: false,
        category: 'navigation',
        prompt: 'Find the application entry point and explain the main startup path.',
        expectedFiles: ['REPLACE_WITH_REAL_ENTRY_FILE'],
        expectedMatch: 'any'
      },
      {
        id: 'example-feature',
        enabled: false,
        category: 'navigation',
        prompt: 'Find the implementation of a real user-facing feature and identify the main implementation file.',
        expectedFiles: ['REPLACE_WITH_REAL_FEATURE_FILE'],
        expectedMatch: 'any'
      },
      {
        id: 'example-flow',
        enabled: false,
        category: 'navigation',
        prompt: 'Trace one real flow from its entry point to the core implementation and list the key files involved.',
        expectedFiles: ['REPLACE_WITH_REAL_FLOW_FILE'],
        expectedMatch: 'any'
      }
    ]
  }
}

export async function benchmarkConfigPath(projectRoot) {
  return path.join(projectRoot, '.stellar', 'benchmark', 'tasks.json')
}

export async function initBenchmarkConfig(projectRoot, { force = false } = {}) {
  const file = await benchmarkConfigPath(projectRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (!force) {
    try {
      await fs.access(file)
      return { file, created: false }
    } catch {}
  }
  await fs.writeFile(file, JSON.stringify(defaultBenchmarkConfig(), null, 2) + '\n')
  return { file, created: true }
}

export async function loadBenchmarkTasks(file) {
  let parsed
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { throw new StellarError(`Cannot read benchmark tasks: ${file}: ${error.message}`, 'BENCHMARK_TASKS_INVALID', 2) }
  if (parsed.version !== BENCHMARK_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
    throw new StellarError(`Invalid benchmark task file: ${file}`, 'BENCHMARK_TASKS_INVALID', 2)
  }
  const ids = new Set()
  const tasks = []
  for (const raw of parsed.tasks) {
    if (raw.enabled === false) continue
    if (!raw.id || !raw.prompt) throw new StellarError('Each enabled benchmark task needs id and prompt', 'BENCHMARK_TASKS_INVALID', 2)
    if (ids.has(raw.id)) throw new StellarError(`Duplicate benchmark task id: ${raw.id}`, 'BENCHMARK_TASKS_INVALID', 2)
    ids.add(raw.id)
    tasks.push({
      id: String(raw.id),
      category: raw.category === 'edit' ? 'edit' : 'navigation',
      prompt: String(raw.prompt),
      expectedFiles: Array.isArray(raw.expectedFiles) ? raw.expectedFiles.map(v => String(v).replaceAll('\\','/')) : [],
      expectedMatch: raw.expectedMatch === 'all' ? 'all' : 'any',
      maxTurns: Number.isFinite(raw.maxTurns) ? Math.max(1, Number(raw.maxTurns)) : undefined
    })
  }
  if (!tasks.length) throw new StellarError(`No enabled benchmark tasks in ${file}. Edit the file and enable real tasks first.`, 'BENCHMARK_TASKS_EMPTY', 2)
  return { file, tasks, raw: parsed }
}

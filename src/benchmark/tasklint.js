import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadBenchmarkTasks, BENCHMARK_CATEGORIES } from './tasks.js'
import { fileSha256 } from './campaign.js'

const execFileAsync = promisify(execFile)

// Integrity checks for a holdout task set. Uses only the task file and git; it never calls
// StellarCode, so linting cannot leak StellarCode output into the answer key.
export async function lintTaskSet(tasksFile, { repoRoot = null, commit = 'HEAD' } = {}) {
  const errors = [], warnings = []
  const raw = JSON.parse(await fs.readFile(tasksFile, 'utf8'))
  let tasks = []
  try { tasks = (await loadBenchmarkTasks(tasksFile)).tasks } catch (error) { errors.push({ task: null, check: 'load', message: error.message }) }
  for (const t of raw.tasks ?? []) {
    if (t.enabled === false) continue
    if (t.category == null) errors.push({ task: t.id, check: 'category', message: 'category must be explicit for v0.5.6 holdouts' })
  }
  let resolvedCommit = null
  if (repoRoot) {
    try { resolvedCommit = (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', commit])).stdout.trim() } catch (error) { errors.push({ task: null, check: 'commit', message: `cannot resolve ${commit} in ${repoRoot}` }) }
  }
  for (const task of tasks) {
    const prompt = task.prompt.toLowerCase()
    if (!task.expectedFiles.length) errors.push({ task: task.id, check: 'expectedFiles', message: 'no expectedFiles' })
    if (new Set(task.expectedFiles).size !== task.expectedFiles.length) errors.push({ task: task.id, check: 'expectedFiles', message: 'duplicate expectedFiles' })
    for (const file of task.expectedFiles) {
      const base = path.posix.basename(file).toLowerCase()
      const stem = base.replace(/\.[^.]+$/, '')
      if (prompt.includes(file.toLowerCase()) || prompt.includes(base)) errors.push({ task: task.id, check: 'leak', message: `prompt names expected file ${file}` })
      else if (stem.length >= 4 && new RegExp(`(^|[^a-z0-9])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(prompt)) warnings.push({ task: task.id, check: 'leak', message: `prompt contains the file stem "${stem}" of ${file}; confirm it is domain language, not a filename hint` })
      if (/(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\.[^.]+$/.test(file)) {
        if (task.category !== 'editing-prep') warnings.push({ task: task.id, check: 'expectedFiles', message: `${file} is a test file in a ${task.category} task` })
      }
      if (resolvedCommit) {
        try { await execFileAsync('git', ['-C', repoRoot, 'cat-file', '-e', `${resolvedCommit}:${file}`]) }
        catch { errors.push({ task: task.id, check: 'exists', message: `${file} does not exist at ${resolvedCommit.slice(0, 12)}` }) }
      }
    }
    if (task.category === 'flow' && task.expectedFiles.length < 2) errors.push({ task: task.id, check: 'flow', message: 'flow tasks must span at least 2 production files' })
    if (task.expectedFiles.length > 1 && task.expectedMatch !== 'all') warnings.push({ task: task.id, check: 'expectedMatch', message: 'multi-file task uses expectedMatch "any"; grounding then needs only one file' })
    if (task.expectedFiles.length > 4) warnings.push({ task: task.id, check: 'expectedFiles', message: `${task.expectedFiles.length} expected files; check the answer key is not over-broad` })
  }
  const distribution = Object.fromEntries(BENCHMARK_CATEGORIES.map(c => [c, tasks.filter(t => t.category === c).length]))
  if (tasks.length < 10 || tasks.length > 14) warnings.push({ task: null, check: 'distribution', message: `${tasks.length} tasks (v0.5.6 asks for 10-14)` })
  for (const [category, count] of Object.entries(distribution)) if (count < 2 || count > 4) warnings.push({ task: null, check: 'distribution', message: `${category}: ${count} tasks (v0.5.6 asks for 2-4)` })
  return { tasksFile: path.resolve(tasksFile), sha256: await fileSha256(tasksFile), repoRoot, commit: resolvedCommit, tasks: tasks.length, distribution, ok: errors.length === 0, errors, warnings }
}

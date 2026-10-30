import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { searchProject, contextForTask } from '../src/query/query-service.js'
import { makeWorkspace } from './helpers.js'

const execFileAsync = promisify(execFile)

test('CLI documents and recognizes stellar search as an alias', async () => {
  const cli = new URL('../src/cli.js', import.meta.url)
  const help = await execFileAsync(process.execPath, [cli.pathname, 'help'])
  assert.match(help.stdout, /stellar search <query>/)
  try {
    await execFileAsync(process.execPath, [cli.pathname, 'search'])
    assert.fail('search without a query should fail with usage')
  } catch (error) {
    assert.match(error.stderr, /search requires a query/)
    assert.doesNotMatch(error.stderr, /Unknown command: search/)
  }
})

test('Chinese login query expands deterministically to indexed auth/login symbols', async () => {
  const w = await makeWorkspace()
  try {
    await initializeProject(w.repo)
    await syncProject(w.repo, { dirs: w.dirs, force: true })
    const search = await searchProject(w.repo, '登入流程', { dirs: w.dirs })
    assert.ok(search.some(v => v.path === 'src/auth/AuthService.ts'))

    const context = await contextForTask(w.repo, '如果我要修改登入流程，應該先看哪些檔案', { dirs: w.dirs })
    assert.notEqual(context.confidence, 'none')
    assert.ok(context.primary.some(v => v.path === 'src/auth/AuthService.ts'))
    assert.ok(context.queryProfile.terms.includes('login'))
  } finally { await w.cleanup() }
})

test('architecture-overview query favors entry points and structural core', async () => {
  const w = await makeWorkspace()
  try {
    await initializeProject(w.repo)
    await syncProject(w.repo, { dirs: w.dirs, force: true })
    const context = await contextForTask(w.repo, '找出這個專案的主要入口與核心模組', { dirs: w.dirs })
    assert.equal(context.queryProfile.architectureOverview, true)
    assert.equal(context.confidence, 'structural')
    assert.equal(context.primary[0]?.path, 'src/index.ts')
  } finally { await w.cleanup() }
})

test('no-evidence task returns no primary files instead of importance fallback', async () => {
  const w = await makeWorkspace()
  try {
    await initializeProject(w.repo)
    await syncProject(w.repo, { dirs: w.dirs, force: true })
    const context = await contextForTask(w.repo, '修正量子傳送門的曲速矩陣', { dirs: w.dirs })
    assert.equal(context.confidence, 'none')
    assert.deepEqual(context.primary, [])
    assert.deepEqual(context.related, [])
    assert.deepEqual(context.tests, [])
    assert.match(context.noMatchReason, /No indexed|No deterministic/)
  } finally { await w.cleanup() }
})


test('recognized Chinese intent with no repository evidence still returns no match', async () => {
  const w = await makeWorkspace()
  try {
    await fs.rm(path.join(w.repo, 'src'), { recursive: true, force: true })
    await fs.rm(path.join(w.repo, 'tests'), { recursive: true, force: true })
    await fs.mkdir(path.join(w.repo, 'src', 'game'), { recursive: true })
    await fs.writeFile(path.join(w.repo, 'src', 'game', 'RushScene.ts'), 'export class RushScene { start() {} }\n')
    await fs.writeFile(path.join(w.repo, 'src', 'game', 'PredatorAI.ts'), 'export class PredatorAI { chase() {} }\n')
    await initializeProject(w.repo)
    await syncProject(w.repo, { dirs: w.dirs, force: true })
    const context = await contextForTask(w.repo, '如果我要修改登入流程，應該先看哪些檔案', { dirs: w.dirs })
    assert.ok(context.queryProfile.terms.includes('login'))
    assert.equal(context.confidence, 'none')
    assert.deepEqual(context.primary, [])
    assert.deepEqual(context.related, [])
  } finally { await w.cleanup() }
})

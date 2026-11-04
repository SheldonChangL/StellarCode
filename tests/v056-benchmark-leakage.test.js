import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { runBenchmark } from '../src/benchmark/runner.js'
import { benchmarkReport } from '../src/benchmark/report.js'
import { benchmarkPrompt, stellarContextArgs, STELLAR_CONTEXT_FLAGS } from '../src/benchmark/agents.js'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { makeWorkspace } from './helpers.js'

test('v0.5.6 stellar context command is built from the prompt only and matches the agent contract', () => {
  const task = { id: 'secret-id', category: 'impact', prompt: 'Which consumers depend on token persistence?', expectedFiles: ['src/auth/TokenStore.ts'], expectedMatch: 'all' }
  const args = stellarContextArgs(task.prompt)
  assert.deepEqual(args, ['context', task.prompt, ...STELLAR_CONTEXT_FLAGS])
  assert.ok(benchmarkPrompt(task, 'stellar').includes(`stellar context ${JSON.stringify(task.prompt)} ${STELLAR_CONTEXT_FLAGS.join(' ')}.`))
  for (const mode of ['baseline', 'stellar']) assert.equal(benchmarkPrompt(task, mode), benchmarkPrompt({ prompt: task.prompt }, mode))
})

test('v0.5.6 answer key, category and match mode never reach the agent, its env, or StellarCode requests', async () => {
  const w = await makeWorkspace()
  try {
    await initializeProject(w.repo)
    await syncProject(w.repo, { dirs: w.dirs })
    const tasksFile = path.join(w.base, 'tasks.json')
    const expected = 'src/auth/TokenStore.ts'
    await fs.writeFile(tasksFile, JSON.stringify({ version: 1, tasks: [{ id: 'leak-probe-task', enabled: true, category: 'editing-prep', prompt: 'Before changing how login credentials persist, which code should be inspected?', expectedFiles: [expected], expectedMatch: 'all' }] }))
    const capture = path.join(w.base, 'capture.jsonl')
    const fake = path.join(w.base, 'fake-codex.mjs')
    await fs.writeFile(fake, `#!/usr/bin/env node
import {execSync} from 'node:child_process'
import fs from 'node:fs'
const a=process.argv.slice(2)
if(a.includes('--version')){console.log('codex fake 1.0');process.exit(0)}
if(a.includes('--help')){console.log('--json --sandbox --ephemeral --ignore-user-config --ignore-rules');process.exit(0)}
const prompt=a[a.length-1]||''
const s=prompt.includes('Benchmark condition: STELLAR')
const commands=[]
const run=(id,command)=>{commands.push(command);console.log(JSON.stringify({type:'item.started',item:{id,type:'command_execution',command}}));const output=execSync(command,{encoding:'utf8'});console.log(JSON.stringify({type:'item.completed',item:{id,type:'command_execution',command,aggregated_output:output,exit_code:0,status:'completed'}}))}
console.log(JSON.stringify({type:'thread.started',thread_id:'x'}))
if(s){const m=prompt.match(/first action must be exactly one command: (stellar context .*? --json)\\./);run('1',m[1])}
run('2','sed -n 1,20p ${expected}')
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({argv:a,env:process.env,commands})+'\\n')
console.log(JSON.stringify({type:'item.completed',item:{id:'3',type:'agent_message',text:JSON.stringify({summary:'x',files:['${expected}'],symbols:[]})}}))
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:s?400:1000,cached_input_tokens:0,output_tokens:10,reasoning_output_tokens:0}}))
`)
    await fs.chmod(fake, 0o755)
    const outDir = path.join(w.base, 'run')
    const result = await runBenchmark({ projectRoot: w.repo, tasksFile, agent: 'codex', mode: 'both', outDir, repository: 'fixture-repo', stellarBin: path.resolve('bin/stellar.js'), env: { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_BENCH_CODEX_BIN: fake } })
    const captured = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    assert.equal(captured.length, 2)
    for (const c of captured) {
      const argv = c.argv.join('\n')
      assert.ok(!argv.includes(expected), 'expected file path must not appear in agent argv/prompt')
      assert.ok(!argv.includes('TokenStore'), 'expected file stem must not appear in agent argv/prompt')
      assert.ok(!/editing-prep|leak-probe-task|expectedFiles|expectedMatch/.test(argv), 'category, task id and answer-key fields must not reach the agent')
      for (const [key, value] of Object.entries(c.env)) {
        if (!key.startsWith('STELLAR') && !key.startsWith('npm_')) continue
        assert.ok(!String(value).includes('TokenStore') && !String(value).includes('editing-prep'), `env ${key} leaks benchmark metadata`)
      }
      const contextCommand = c.commands.find(cmd => cmd.startsWith('stellar context'))
      if (contextCommand) assert.ok(!/TokenStore|editing-prep|leak-probe-task|expected/.test(contextCommand), 'StellarCode request must carry the prompt only')
    }
    assert.ok(captured.some(c => c.commands.some(cmd => cmd.startsWith('stellar context'))), 'stellar condition ran the context command')

    const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.schemaVersion, 3)
    assert.equal(manifest.repository, 'fixture-repo')
    assert.match(manifest.taskHash, /^[0-9a-f]{64}$/)
    assert.match(manifest.runtime.contentHash, /^[0-9a-f]{64}$/)
    assert.equal(manifest.runtime.changedDuringCampaign, false)
    assert.ok(manifest.runtime.packageVersion)
    assert.ok(manifest.environment.node.startsWith('v'))
    assert.ok(manifest.startedAt && manifest.completedAt)

    const row = JSON.parse((await fs.readFile(result.files.stellar, 'utf8')).trim())
    assert.equal(row.schemaVersion, 4)
    assert.ok(Number.isFinite(row.agentStartToFirstToolMs))
    assert.ok(Number.isFinite(row.firstToolDurationMs))
    assert.equal(row.firstToolKind, 'stellarContext')
    assert.ok(Number.isFinite(row.stellarContextDurationMs))
    assert.equal(row.firstRelevantSourceCompletionMs, row.firstRelevantMs)

    const report = await benchmarkReport(result.files.baseline, result.files.stellar)
    assert.equal(report.schemaVersion, 5)
    assert.equal(report.campaign.repository, 'fixture-repo')
    assert.equal(report.campaign.taskHash, manifest.taskHash)
    assert.equal(report.firstRelevantDecomposition.stellar.runsWithTelemetry, 1)
    assert.equal(report.winLoss.inputTokens.wins, 1)
    assert.ok(report.pairs[0].baseline.sourceBytesRead > 0)
  } finally { await w.cleanup() }
})

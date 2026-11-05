import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runBenchmark, parseBenchmarkModes, conditionOrder } from '../src/benchmark/runner.js'
import { loadBenchmarkTasks } from '../src/benchmark/tasks.js'
import { semanticPathLength } from '../src/benchmark/semantic-diagnostics.js'
import { deliveryMetrics } from '../src/benchmark/delivery.js'
import { semanticRepo } from './helpers-v06.js'

const FILES = {
  'src/repo/userRepository.ts': `export class UserRepository {\n  async insertUser(user: { email: string }) {\n    return db.query('insert', user)\n  }\n}\n\nexport default new UserRepository()\n`,
  'src/services/userService.ts': `import userRepository from '../repo/userRepository'\n\nclass UserService {\n  async registerUser(email: string) {\n    return userRepository.insertUser({ email })\n  }\n}\n\nexport default new UserService()\n`,
  'src/api/userController.ts': `import userService from '../services/userService'\n\nexport async function postRegistration(req: any) {\n  return userService.registerUser(req.body.email)\n}\n`
}

test('v0.6 expectedSemanticEdges is evaluation-only; stellar-lexical runs the same prompt with the slice switched off', async () => {
  const w = await semanticRepo(FILES)
  try {
    const marker = 'ZZ_SEMANTIC_ANSWER_KEY_MARKER'
    const tasksFile = path.join(w.base, 'tasks.json')
    await fs.writeFile(tasksFile, JSON.stringify({ version: 1, tasks: [{ id: 'semantic-leak-probe', category: 'flow', prompt: 'Trace how the registration request handler reaches the repository insert for a new user.', expectedFiles: ['src/repo/userRepository.ts'], expectedMatch: 'any', expectedSemanticEdges: [{ from: `src/services/userService.ts#${marker}`, relation: 'CALLS', to: 'src/repo/userRepository.ts#UserRepository.insertUser' }] }] }))
    const loaded = await loadBenchmarkTasks(tasksFile)
    assert.equal(loaded.tasks[0].expectedSemanticEdges.length, 1)
    const capture = path.join(w.base, 'capture.jsonl')
    const fake = path.join(w.base, 'fake-codex.mjs')
    await fs.writeFile(fake, `#!/usr/bin/env node
import {execSync} from 'node:child_process'
import fs from 'node:fs'
const a=process.argv.slice(2)
if(a.includes('--version')){console.log('codex fake 1.0');process.exit(0)}
if(a.includes('--help')){console.log('--json --sandbox --ephemeral --ignore-user-config --ignore-rules');process.exit(0)}
const prompt=a[a.length-1]||''
const outputs=[]
console.log(JSON.stringify({type:'thread.started',thread_id:'x'}))
const m=prompt.match(/first action must be exactly one command: (stellar context .*? --json)\\./)
const command=m[1]
console.log(JSON.stringify({type:'item.started',item:{id:'1',type:'command_execution',command}}))
const output=execSync(command,{encoding:'utf8'})
outputs.push(output)
console.log(JSON.stringify({type:'item.completed',item:{id:'1',type:'command_execution',command,aggregated_output:output,exit_code:0,status:'completed'}}))
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({argv:a,env:process.env,command,output})+'\\n')
console.log(JSON.stringify({type:'item.completed',item:{id:'3',type:'agent_message',text:JSON.stringify({summary:'x',files:['src/repo/userRepository.ts'],symbols:[]})}}))
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:400,cached_input_tokens:0,output_tokens:10,reasoning_output_tokens:0}}))
`)
    await fs.chmod(fake, 0o755)
    const outDir = path.join(w.base, 'run')
    const result = await runBenchmark({ projectRoot: w.repo, tasksFile, agent: 'codex', mode: 'stellar,stellar-lexical', outDir, repository: 'fixture', stellarBin: path.resolve('bin/stellar.js'), env: { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_BENCH_CODEX_BIN: fake } })
    const captured = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(captured.length, 2)
    for (const c of captured) {
      assert.ok(!c.argv.join('\n').includes(marker), 'semantic answer key never reaches the agent prompt')
      assert.ok(!c.command.includes(marker), 'semantic answer key never reaches StellarCode')
      for (const value of Object.values(c.env)) assert.ok(!String(value).includes(marker), 'semantic answer key never reaches the env')
    }
    assert.equal(captured[0].argv.at(-1), captured[1].argv.at(-1), 'both conditions send the identical prompt')
    const parsed = captured.map(c => JSON.parse(c.output))
    assert.ok(parsed.some(p => Array.isArray(p.semanticEvidence) && p.semanticEvidence.length > 0), 'semantic condition returns a slice')
    assert.ok(parsed.some(p => p.semanticEvidence === undefined), 'stellar-lexical returns no slice')
    const semanticRow = JSON.parse((await fs.readFile(result.files.stellar, 'utf8')).trim())
    const lexicalRow = JSON.parse((await fs.readFile(result.files['stellar-lexical'], 'utf8')).trim())
    assert.ok(semanticRow.semanticEdgesReturned > 0)
    assert.equal(lexicalRow.semanticEdgesReturned, null)
    assert.equal(lexicalRow.deliveryMode, 'stellar-lexical')
  } finally { await w.cleanup() }
})

test('v0.6 condition parsing and counterbalanced order for the three-way holdout', () => {
  assert.deepEqual(parseBenchmarkModes('baseline,stellar-lexical,stellar'), ['baseline', 'stellar-lexical', 'stellar'])
  const modes = ['baseline', 'stellar-lexical', 'stellar']
  assert.deepEqual([1, 2, 3].map(r => conditionOrder(modes, modes.join(','), 0, r)), [modes, ['stellar-lexical', 'stellar', 'baseline'], ['stellar', 'baseline', 'stellar-lexical']])
})

test('v0.6 postContextExplorationTurns counts model turns after the context that still inspect the repository', () => {
  const turns = [{ turn: 1, id: 'a', inputTokens: 100, outputTokens: 1, toolUses: 1 }, { turn: 2, id: 'b', inputTokens: 200, outputTokens: 1, toolUses: 2 }, { turn: 3, id: 'c', inputTokens: 300, outputTokens: 1, toolUses: 1 }, { turn: 4, id: 'd', inputTokens: 400, outputTokens: 1, toolUses: 0 }]
  const interactions = [{ kind: 'stellarContext', turn: 1, semanticEdges: 4 }, { kind: 'nativeSourceRead', turn: 2 }, { kind: 'nativeSourceRead', turn: 2 }, { kind: 'search', turn: 3, search: true }]
  const metrics = deliveryMetrics({ condition: 'stellar', result: { metrics: { turns, interactions, sourceReads: [] } } })
  assert.equal(metrics.postContextExplorationTurns, 2)
  assert.equal(metrics.semanticEdgesReturned, 4)
  const missing = deliveryMetrics({ condition: 'stellar', result: { metrics: { interactions, sourceReads: [] } } })
  assert.equal(missing.postContextExplorationTurns, null, 'missing turn telemetry is n/a, never zero')
})

test('v0.6 semanticPathLength follows outgoing CALLS/REGISTERS from a target', () => {
  const edges = [
    { relation: 'CALLS', direction: 'outgoing', from: { path: 'a.ts', symbol: 'h' }, to: { path: 'b.ts', symbol: 'S.create' } },
    { relation: 'CALLS', direction: 'outgoing', from: { path: 'b.ts', symbol: 'S.create' }, to: { path: 'c.ts', symbol: 'R.save' } },
    { relation: 'CALLS', direction: 'outgoing', from: { path: 'x.ts', symbol: 'other' }, to: { path: 'y.ts', symbol: 'z' } }
  ]
  assert.equal(semanticPathLength(edges, [{ path: 'a.ts', symbol: 'h' }]), 2)
  assert.equal(semanticPathLength([], [{ path: 'a.ts', symbol: 'h' }]), 0)
})

test('v0.6 semantic report pairs by task and repetition, keeps n/a out, and flags catastrophes', async () => {
  const { paired, catastrophes } = await import('../src/benchmark/semantic-report.js')
  const row = (taskId, repetition, values) => ({ taskId, repetition, category: 'flow', answerSuccess: true, success: true, ...values })
  const lexical = [row('t1', 1, { postContextExplorationTurns: 4, inputTokens: 100 }), row('t1', 2, { postContextExplorationTurns: 2, inputTokens: 100 }), row('t2', 1, { postContextExplorationTurns: null, inputTokens: 100 })]
  const semantic = [row('t1', 1, { postContextExplorationTurns: 1, inputTokens: 80 }), row('t1', 2, { postContextExplorationTurns: 2, inputTokens: 90 }), row('t2', 1, { postContextExplorationTurns: 3, inputTokens: 70 }), row('t3', 1, { postContextExplorationTurns: 0, inputTokens: 10 })]
  const pce = paired(semantic, lexical, 'postContextExplorationTurns')
  assert.deepEqual([pce.pairs, pce.a, pce.b, pce.reductionPct], [2, 3, 6, 50])
  assert.equal(paired(semantic, lexical, 'inputTokens').reductionPct, 20)
  const baseline = [row('t1', 1, { inputTokens: 100, toolCalls: 2 }), row('t2', 1, { inputTokens: 100, toolCalls: 2 })]
  const worse = [row('t1', 1, { inputTokens: 130, toolCalls: 2 }), row('t2', 1, { inputTokens: 90, toolCalls: 5, success: false })]
  const found = catastrophes(worse, baseline)
  assert.deepEqual(found.map(f => f.taskId), ['t1', 't2'])
  assert.match(found[1].reasons.join(' '), /tools 5 vs 2/)
  assert.match(found[1].reasons.join(' '), /grounded 0% vs 100%/)
})

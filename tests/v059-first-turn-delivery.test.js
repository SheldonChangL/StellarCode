import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runBenchmark, conditionOrder, parseBenchmarkModes } from '../src/benchmark/runner.js'
import { runAgent, benchmarkPrompt } from '../src/benchmark/agents.js'
import { completedEvidence } from '../src/benchmark/evidence.js'
import { deliveryReport } from '../src/benchmark/delivery-report.js'
import { latinSquareOrder, buildContextEnvelope, duplicateReads, turnMetrics, verificationClass, deliveryMetrics, DELIVERY_MODES } from '../src/benchmark/delivery.js'
import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { makeWorkspace } from './helpers.js'

const ANSWER_MARKER = 'docs/ANSWER-KEY-MARKER.md'

// Fake Claude CLI. It records the prompt it receives, emits real-shaped stream events with
// message ids and per-call usage, and behaves per condition:
//   pull: turn 1 runs stellar context, turn 2 re-reads the delivered file, turn 3 answers
//   prefetch: answers on turn 1 with no tool call
//   prefetch-contract: turn 1 re-reads delivered lines 1-5, turn 2 answers
const FAKE = `#!/usr/bin/env node
import {execSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import path from 'node:path'
const a=process.argv.slice(2)
if(a.includes('--version')){console.log('claude fake 2.0');process.exit(0)}
if(a.includes('--help')){console.log('--output-format --permission-mode --allowedTools --setting-sources --strict-mcp-config --mcp-config');process.exit(0)}
const p=a[a.indexOf('-p')+1]||''
if(process.env.FAKE_PROMPT_DIR){mkdirSync(process.env.FAKE_PROMPT_DIR,{recursive:true});writeFileSync(path.join(process.env.FAKE_PROMPT_DIR,Date.now()+'-'+Math.random().toString(36).slice(2)+'.txt'),p)}
const emit=o=>console.log(JSON.stringify(o))
let n=0
const turn=(content,input)=>{n++;emit({type:'assistant',message:{id:'msg_'+n,content,usage:{input_tokens:2,cache_read_input_tokens:input,cache_creation_input_tokens:100,output_tokens:10}}});for(const b of content){if(b.type!=='tool_use')continue;let out='';if(b.name==='Read'){const lines=readFileSync(b.input.file_path,'utf8').split('\\n');const from=(b.input.offset||1);out=lines.slice(from-1,from-1+(b.input.limit||lines.length)).map((l,i)=>(from+i)+'\\t'+l).join('\\n')}if(b.name==='Bash')out=execSync(b.input.command,{encoding:'utf8'});emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:b.id,content:out}]}})}}
const answer={summary:'login',files:['src/auth/AuthService.ts'],symbols:['login']}
const prefetched=p.includes('<stellar-grounded-context>')
if(p.includes('BASELINE')){turn([{type:'tool_use',id:'t1',name:'Read',input:{file_path:'src/auth/AuthService.ts'}}],1000)}
else if(prefetched&&p.includes('Grounding contract:')){turn([{type:'tool_use',id:'t1',name:'Read',input:{file_path:'src/auth/AuthService.ts',offset:1,limit:5}}],1000)}
else if(!prefetched){turn([{type:'tool_use',id:'t1',name:'Bash',input:{command:'stellar context "Find the login implementation." --compact --with-source --depth 1 --max-files 6 --max-lines 160 --max-bytes 12000 --json'}}],1000);turn([{type:'tool_use',id:'t2',name:'Read',input:{file_path:'src/auth/AuthService.ts'}}],1200)}
turn([{type:'text',text:JSON.stringify(answer)}],1500)
emit({type:'result',num_turns:n,result:JSON.stringify(answer),structured_output:answer,total_cost_usd:0.01,usage:{input_tokens:2*n,cache_creation_input_tokens:100*n,cache_read_input_tokens:0,output_tokens:10*n}})
`

async function deliveryFixture() {
  const w = await makeWorkspace()
  await initializeProject(w.repo)
  await syncProject(w.repo, { dirs: w.dirs })
  const tasksFile = path.join(w.base, 'tasks.json')
  await fs.writeFile(tasksFile, JSON.stringify({ version: 1, tasks: [
    { id: 'auth', enabled: true, category: 'impact', prompt: 'Find the login implementation.', expectedFiles: ['src/auth/AuthService.ts', ANSWER_MARKER], expectedMatch: 'any' },
    { id: 'other', enabled: true, category: 'navigation', prompt: 'Find the login implementation again.', expectedFiles: ['src/auth/AuthService.ts'], expectedMatch: 'any' }
  ] }, null, 2))
  const fake = path.join(w.base, 'fake-claude.mjs')
  await fs.writeFile(fake, FAKE, { mode: 0o755 })
  return { w, tasksFile, fake, promptDir: path.join(w.base, 'prompts') }
}

async function runDelivery(fixture, extra = {}) {
  const { w, tasksFile, fake, promptDir } = fixture
  return runBenchmark({ projectRoot: w.repo, tasksFile, agent: 'claude', mode: 'delivery', outDir: path.join(w.base, 'run'), stellarBin: path.resolve('bin/stellar.js'), taskIds: ['auth'], env: { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_BENCH_CLAUDE_BIN: fake, FAKE_PROMPT_DIR: promptDir }, ...extra })
}

const readRows = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

test('v0.5.9 prefetch envelope and prompts never contain benchmark metadata', async () => {
  const fixture = await deliveryFixture()
  try {
    await runDelivery(fixture)
    const prompts = await Promise.all((await fs.readdir(fixture.promptDir)).map(name => fs.readFile(path.join(fixture.promptDir, name), 'utf8')))
    assert.equal(prompts.length, 3)
    assert.equal(prompts.filter(p => p.includes('<stellar-grounded-context>')).length, 2)
    for (const prompt of prompts) {
      assert.ok(!prompt.includes(ANSWER_MARKER), 'expected file leaked')
      for (const word of ['expectedFiles', 'expectedMatch', 'category', '"impact"']) assert.ok(!prompt.includes(word), `${word} leaked`)
    }
    // The prompt builder takes the prompt alone; extra task fields are ignored.
    const leaky = { prompt: 'Q?', expectedFiles: [ANSWER_MARKER], category: 'impact', expectedMatch: 'all' }
    assert.ok(!benchmarkPrompt(leaky, 'prefetch', { envelope: '<stellar-grounded-context>\n</stellar-grounded-context>' }).includes(ANSWER_MARKER))
  } finally { await fixture.w.cleanup() }
})

test('v0.5.9 prefetched source counts as grounding and as source bytes; delivery fields survive the row', async () => {
  const fixture = await deliveryFixture()
  try {
    const result = await runDelivery(fixture)
    assert.deepEqual(Object.keys(result.files).sort(), [...DELIVERY_MODES].sort())
    const prefetch = (await readRows(result.files.prefetch))[0]
    assert.equal(prefetch.mode, 'prefetch')
    assert.equal(prefetch.deliveryMode, 'prefetch')
    assert.equal(prefetch.conditionOrder, 2)
    // No tool call at all, yet grounded: the delivered excerpt was supplied to the model.
    assert.equal(prefetch.toolCalls, 0)
    assert.equal(prefetch.sourceGrounded, true)
    assert.equal(prefetch.success, true)
    assert.ok(prefetch.sourceReads.some(read => read.via === 'prefetch' && read.path === 'src/auth/AuthService.ts'))
    assert.ok(prefetch.prefetchSourceBytes > 0 && prefetch.prefetchPayloadBytes > prefetch.prefetchSourceBytes)
    assert.ok(prefetch.sourceBytesRead >= prefetch.contextSourceBytes && prefetch.sourceBytesRead > 0)
    assert.equal(prefetch.verificationClass, 'A')
    assert.equal(prefetch.solvedWithoutAdditionalRepoInspection, true)
    assert.ok(Number.isFinite(prefetch.prefetchLocalMs))
    assert.equal(prefetch.modelTurns, 1)
    assert.equal(typeof prefetch.contextTopTarget, 'string')
    const pull = (await readRows(result.files.pull))[0]
    assert.equal(pull.deliveryMode, 'pull')
    assert.equal(pull.conditionOrder, 1)
    assert.equal(pull.groundedContextTurn, 1)
    assert.equal(pull.modelTurns, 3)
    assert.equal(pull.turnsAfterGroundedContextAvailable, 1)
    assert.equal(pull.verificationClass, 'C')
    // The agent's own context call returns the same deterministic payload as the prefetch.
    assert.equal(pull.contextTopTarget, prefetch.contextTopTarget)
    const contract = (await readRows(result.files['prefetch-contract']))[0]
    assert.equal(contract.conditionOrder, 3)
    assert.equal(contract.duplicateReadRanges, 1)
    assert.ok(contract.duplicateReadBytes > 0 && contract.duplicateReadBytes < contract.contextSourceBytes)
    const report = await deliveryReport([`fixture=${result.outDir}`])
    assert.equal(report.byRepository.fixture.vsPull.prefetch.pairs, 1)
    assert.ok(report.byRepository.fixture.vsPull.prefetch.modelTurnReductionPct > 0)
    assert.equal(report.byRepository.fixture.conditions['prefetch-contract'].verificationClasses.C, 1)
    const stratum = prefetch.contextTopTarget === 'src/auth/AuthService.ts' ? 'prefetch:topCorrect' : 'prefetch:topWrong'
    assert.equal(report.stratification[stratum].tasks, 1)
  } finally { await fixture.w.cleanup() }
})

test('v0.5.9 related hints never count as grounding', async () => {
  const w = await makeWorkspace()
  try {
    const file = 'src/auth/AuthService.ts'
    const lines = (await fs.readFile(path.join(w.repo, file), 'utf8')).split(/\r?\n/).slice(0, 6)
    const context = { intent: 'navigation', contextMode: 'focused', confidence: 'high', targets: [{ path: file, lines: [1, 6], source: lines.map((line, i) => `${i + 1}: ${line}`).join('\n') }], relatedEvidence: [], relatedHints: [{ path: 'src/main.ts', lines: null, relation: 'imports' }] }
    const envelope = buildContextEnvelope(context, { snapshotCommit: 'abc' })
    assert.match(envelope.text, /Related hints \(navigation metadata only; NOT inspected source\):\n- src\/main\.ts/)
    assert.match(envelope.text, /\[Source: src\/auth\/AuthService\.ts lines 1-6 sha256:[0-9a-f]{12}\]/)
    assert.deepEqual(envelope.hintPaths, ['src/main.ts'])
    assert.ok(!envelope.text.includes('score'))
    const evidence = await completedEvidence({ input: 'stellar context x --compact --with-source --json', output: JSON.stringify(context), ok: true, cwd: w.repo, atMs: 0, via: 'prefetch' })
    assert.ok(evidence.reads.every(read => read.path === file))
    assert.ok(evidence.discovered.includes('src/main.ts'))
  } finally { await w.cleanup() }
})

test('v0.5.9 duplicate reads use range overlap and scale partial overlaps', () => {
  const delivered = [{ path: 'a.ts', startLine: 10, endLine: 19 }, { path: 'a.ts', startLine: 15, endLine: 25 }, { path: 'b.ts', startLine: 1, endLine: 5 }]
  const none = duplicateReads(delivered, [{ path: 'a.ts', startLine: 30, endLine: 40, bytes: 100 }, { path: 'c.ts', startLine: 1, endLine: 9, bytes: 90 }], 500)
  assert.deepEqual(none, { duplicateReadFiles: 0, duplicateReadRanges: 0, duplicateReadBytes: 0, duplicateReadPct: 0 })
  // Lines 1-40 read; 10-25 (16 lines) overlap the merged delivered span: 16/40 of 400 bytes.
  const partial = duplicateReads(delivered, [{ path: 'a.ts', startLine: 1, endLine: 40, bytes: 400 }], 500)
  assert.equal(partial.duplicateReadBytes, 160)
  assert.equal(partial.duplicateReadPct, 32)
  const exact = duplicateReads(delivered, [{ path: 'b.ts', startLine: 1, endLine: 5, bytes: 50 }, { path: 'a.ts', startLine: 12, endLine: 13, bytes: 20 }], 500)
  assert.deepEqual([exact.duplicateReadFiles, exact.duplicateReadRanges, exact.duplicateReadBytes], [2, 2, 70])
})

test('v0.5.9 model turns follow assistant message ids and per-call usage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-turns-'))
  try {
    const fake = path.join(dir, 'claude.mjs')
    // Two content blocks of one message share an id: still one model turn.
    await fs.writeFile(fake, `#!/usr/bin/env node
const e=o=>console.log(JSON.stringify(o))
e({type:'assistant',message:{id:'m1',content:[{type:'thinking',thinking:'x'}],usage:{input_tokens:2,cache_read_input_tokens:30000,cache_creation_input_tokens:5000,output_tokens:5}}})
e({type:'assistant',message:{id:'m1',content:[{type:'tool_use',id:'u1',name:'Grep',input:{pattern:'x'}}],usage:{input_tokens:2,cache_read_input_tokens:30000,cache_creation_input_tokens:5000,output_tokens:9}}})
e({type:'user',message:{content:[{type:'tool_result',tool_use_id:'u1',content:''}]}})
e({type:'assistant',message:{id:'m2',content:[{type:'text',text:'{}'}],usage:{input_tokens:2,cache_read_input_tokens:35000,cache_creation_input_tokens:100,output_tokens:3}}})
e({type:'result',num_turns:2,result:'{"summary":"","files":[],"symbols":[]}',usage:{input_tokens:4,cache_read_input_tokens:65000,cache_creation_input_tokens:5100,output_tokens:12}})
`, { mode: 0o755 })
    const result = await runAgent({ agent: 'claude', task: { prompt: 'x' }, mode: 'baseline', cwd: dir, env: { ...process.env, STELLAR_BENCH_CLAUDE_BIN: fake } })
    assert.equal(result.metrics.turns.length, 2)
    assert.deepEqual(result.metrics.turns.map(t => t.inputTokens), [35002, 35102])
    assert.equal(result.metrics.turns[0].toolUses, 1)
    assert.equal(result.metrics.resultNumTurns, 2)
    assert.equal(result.metrics.usage.inputTokens, 70104)
    assert.equal(result.metrics.interactions[0].turn, 1)
    assert.equal(result.metrics.interactions[0].search, true)
    const turns = turnMetrics(result.metrics.turns, { availableTurn: 0, firstRelevantTurn: null })
    assert.equal(turns.initialTurnInputTokens + turns.subsequentTurnInputTokens, result.metrics.usage.inputTokens)
    assert.equal(turns.turnsAfterGroundedContextAvailable, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('v0.5.9 missing telemetry is reported as n/a, never estimated', () => {
  assert.deepEqual(turnMetrics([]), { modelTurns: null, initialTurnInputTokens: null, subsequentTurnInputTokens: null, turnsAfterGroundedContextAvailable: null, turnsBeforeFirstRelevantSource: null, turnsAfterFirstRelevantSource: null })
  const partial = turnMetrics([{ turn: 1, inputTokens: null, toolUses: 0 }, { turn: 2, inputTokens: 10, toolUses: 0 }])
  assert.equal(partial.modelTurns, 2)
  assert.equal(partial.initialTurnInputTokens, null)
  assert.equal(partial.subsequentTurnInputTokens, null)
  // A pull run whose agent never called stellar context has no delivered context.
  const noContext = deliveryMetrics({ condition: 'pull', result: { metrics: { interactions: [], sourceReads: [], turns: [] } } })
  assert.equal(noContext.groundedContextTurn, null)
  assert.equal(noContext.verificationClass, null)
  assert.equal(noContext.duplicateReadPct, null)
  assert.equal(noContext.modelTurns, null)
})

test('v0.5.9 condition order is a deterministic Latin square', () => {
  const modes = parseBenchmarkModes('delivery')
  assert.deepEqual(modes, ['pull', 'prefetch', 'prefetch-contract'])
  assert.deepEqual([1, 2, 3].map(r => latinSquareOrder(modes, r)), [
    ['pull', 'prefetch', 'prefetch-contract'],
    ['prefetch', 'prefetch-contract', 'pull'],
    ['prefetch-contract', 'pull', 'prefetch']
  ])
  // Every condition takes every position exactly once across three repetitions.
  for (const mode of modes) assert.deepEqual([1, 2, 3].map(r => latinSquareOrder(modes, r).indexOf(mode)).sort(), [0, 1, 2])
  assert.deepEqual(latinSquareOrder(modes, 4), latinSquareOrder(modes, 1))
  assert.deepEqual(conditionOrder(modes, 'delivery', 5, 2), latinSquareOrder(modes, 2))
  assert.deepEqual(parseBenchmarkModes('pull,prefetch-contract'), ['pull', 'prefetch-contract'])
  // The original paired design keeps its alternating order.
  assert.deepEqual(conditionOrder(['baseline', 'stellar'], 'both', 0, 1), ['stellar', 'baseline'])
  assert.equal(verificationClass({ postContextToolCalls: 0, duplicateReadRanges: 0, postContextSearchCalls: 0 }), 'A')
  assert.equal(verificationClass({ postContextToolCalls: 2, duplicateReadRanges: 0, postContextSearchCalls: 2 }), 'D')
  assert.equal(verificationClass({ postContextToolCalls: 1, duplicateReadRanges: 0, postContextSearchCalls: 0 }), 'B')
})

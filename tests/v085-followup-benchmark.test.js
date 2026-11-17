import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { runBenchmark, hookAttachment, BENCHMARK_CONDITIONS } from '../src/benchmark/runner.js'
import { followUpPrompt, runAgent } from '../src/benchmark/agents.js'
import { loadBenchmarkTasks } from '../src/benchmark/tasks.js'
import { semanticRepo } from './helpers-v06.js'

// v0.8.5 two-turn benchmark: the second turn resumes the first turn's session with a
// follow-up message, so the hook sees a transcript and session-aware delivery and session
// hints act as they do in real use.

const body = (name, lines) => `export function ${name}(input) {\n${Array.from({ length: lines }, (_, i) => `  const step${i} = input + ${i} // ${name} lockout window computation line ${i}`).join('\n')}\n  return input\n}\n`
const REPO = {
  'src/auth/throttle.js': `import { recordFailure } from './failures.js'\n\n${body('lockoutDuration', 60)}\nexport function onLoginFailure(account) {\n  return recordFailure(account, lockoutDuration(account.failures))\n}\n`,
  'src/auth/failures.js': body('recordFailure', 60),
  'src/billing/invoice.js': body('invoiceTotal', 40)
}
const NAMED = 'How does onLoginFailure use lockoutDuration and recordFailure to compute the lockout window after repeated login failures?'
const VAGUE = 'please keep going with what we discussed and tidy the remaining parts up'

// Fake Claude CLI that does what the real one does for this benchmark: runs the
// UserPromptSubmit hook from --settings with the session's transcript path, records the
// attachment and tool calls in the transcript under CLAUDE_CONFIG_DIR, and continues a
// session given with --resume. Turn 1 reads throttle.js; a resumed turn reads invoice.js.
const FAKE = `#!/usr/bin/env node
import {execSync} from 'node:child_process';import {readFileSync,appendFileSync,mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto'
const a=process.argv.slice(2)
if(a.includes('--version')){console.log('claude fake 3.0');process.exit(0)}
if(a.includes('--help')){console.log('--output-format --permission-mode --allowedTools --setting-sources --strict-mcp-config --mcp-config');process.exit(0)}
const arg=name=>a.includes(name)?a[a.indexOf(name)+1]:null
const p=arg('-p')||'',resume=arg('--resume'),sid=resume||randomUUID()
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fake');mkdirSync(dir,{recursive:true})
const transcript=path.join(dir,sid+'.jsonl'),log=line=>appendFileSync(transcript,JSON.stringify(line)+'\\n')
let attached=''
if(arg('--settings')){const settings=JSON.parse(readFileSync(arg('--settings'),'utf8'));const out=execSync(settings.hooks.UserPromptSubmit[0].hooks[0].command,{input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:sid,cwd:process.cwd(),prompt:p,transcript_path:transcript}),encoding:'utf8'});if(out.trim()){attached=JSON.parse(out).hookSpecificOutput.additionalContext;log({type:'attachment',timestamp:new Date().toISOString(),attachment:{type:'hook_additional_context',hookEvent:'UserPromptSubmit',content:[attached]}})}}
mkdirSync(process.env.FAKE_LOG,{recursive:true});writeFileSync(path.join(process.env.FAKE_LOG,Date.now()+'-'+Math.random().toString(36).slice(2)+'.json'),JSON.stringify({prompt:p,resume,attached,args:a}))
const emit=o=>console.log(JSON.stringify({...o,session_id:sid}))
emit({type:'system',subtype:'init'})
const file=resume?'src/billing/invoice.js':'src/auth/throttle.js'
const read={type:'tool_use',id:'t1',name:'Read',input:{file_path:path.resolve(file)}}
log({type:'assistant',cwd:process.cwd(),message:{content:[read]}})
emit({type:'assistant',message:{id:'m1',content:[read],usage:{input_tokens:1,cache_read_input_tokens:100,cache_creation_input_tokens:50,output_tokens:5}}})
emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:readFileSync(file,'utf8').split('\\n').map((l,i)=>(i+1)+'\\t'+l).join('\\n')}]}})
const answer={summary:'x',files:[file],symbols:[]}
emit({type:'assistant',message:{id:'m2',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input_tokens:1,cache_read_input_tokens:150,cache_creation_input_tokens:10,output_tokens:20}}})
emit({type:'result',num_turns:2,result:JSON.stringify(answer),structured_output:answer,total_cost_usd:resume?0.01:0.02,usage:{input_tokens:2,cache_creation_input_tokens:60,cache_read_input_tokens:250,output_tokens:25}})
`

test('v0.8.5 follow-up task format and prompt', async () => {
  const w = await semanticRepo(REPO)
  try {
    const file = path.join(w.base, 'tasks.json')
    const write = tasks => fs.writeFile(file, JSON.stringify({ version: 1, tasks }))
    await write([{ id: 'a', prompt: NAMED, expectedFiles: ['src/auth/throttle.js'], followUp: { prompt: VAGUE, expectedFiles: ['src\\auth\\failures.js'] } }, { id: 'b', prompt: NAMED }])
    const { tasks } = await loadBenchmarkTasks(file)
    assert.deepEqual(tasks[0].followUp, { prompt: VAGUE, expectedFiles: ['src/auth/failures.js'], expectedMatch: 'any' })
    assert.equal(tasks[1].followUp, undefined)
    await write([{ id: 'a', prompt: NAMED, followUp: { prompt: VAGUE } }])
    await assert.rejects(loadBenchmarkTasks(file), /Invalid followUp/)

    const prompt = followUpPrompt(VAGUE)
    assert.ok(prompt.startsWith(VAGUE))
    assert.match(prompt, /same final JSON object/)
    assert.ok(!prompt.includes('Benchmark condition'))
    assert.ok(BENCHMARK_CONDITIONS.includes('hook-nohints'))
    await assert.rejects(runAgent({ agent: 'claude', task: { prompt: 'x' }, mode: 'baseline', cwd: w.repo, env: process.env, followUp: VAGUE }), /session to resume/)
  } finally { await w.cleanup() }
})

test('v0.8.5 hook attachment parsing: source files and session hints', () => {
  const hints = 'StellarCode: Files linked to files already in this conversation by git history or imports (navigation hints only; NOT inspected source):\n- src/a.js\n- src/b.kt'
  assert.deepEqual(hookAttachment(hints), { hookDelivered: false, hookChars: hints.length, hookSourceFiles: [], hookHints: ['src/a.js', 'src/b.kt'] })
  const source = '<stellar-grounded-context>\n[Source: src/c.js lines 1-20 sha256:abc | target]\nx\n[Source: src/c.js lines 30-40 sha256:def]\n</stellar-grounded-context>\n\nFiles that import, or are imported by, files already in this conversation (navigation hints only; NOT inspected source):\n- src/d.js'
  const parsed = hookAttachment(source)
  assert.equal(parsed.hookDelivered, true)
  assert.deepEqual(parsed.hookSourceFiles, ['src/c.js'])
  assert.deepEqual(parsed.hookHints, ['src/d.js'])
  assert.deepEqual(hookAttachment(''), { hookDelivered: false, hookChars: 0, hookSourceFiles: [], hookHints: [] })
})

test('v0.8.5 two-turn benchmark: the second turn resumes the session and the hook sees it', async () => {
  const w = await semanticRepo(REPO)
  try {
    const tasksFile = path.join(w.base, 'tasks.json')
    await fs.writeFile(tasksFile, JSON.stringify({ version: 1, tasks: [{ id: 'lockout', prompt: NAMED, expectedFiles: ['src/auth/throttle.js'], followUp: { prompt: VAGUE, expectedFiles: ['src/billing/invoice.js'] } }] }))
    const fake = path.join(w.base, 'fake-claude.mjs')
    await fs.writeFile(fake, FAKE, { mode: 0o755 })
    const fakeLog = path.join(w.base, 'fake-log')
    const env = { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_BENCH_CLAUDE_BIN: fake, CLAUDE_CONFIG_DIR: path.join(w.base, 'claude-config'), FAKE_LOG: fakeLog }
    const run = extra => runBenchmark({ projectRoot: w.repo, tasksFile, agent: 'claude', mode: 'baseline,hook,hook-nohints', outDir: path.join(w.base, 'run'), stellarBin: path.resolve('bin/stellar.js'), env, ...extra })
    await assert.rejects(run({ agent: 'codex', followUp: true }), /--follow-up needs --agent claude/)
    const result = await run({ followUp: true })

    const rows = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(Object.keys(result.followUpFiles).sort(), ['baseline', 'hook', 'hook-nohints'])
    assert.equal(result.manifest.followUp, true)
    const first = Object.fromEntries(await Promise.all(Object.entries(result.files).map(async ([mode, file]) => [mode, (await rows(file))[0]])))
    const second = Object.fromEntries(await Promise.all(Object.entries(result.followUpFiles).map(async ([mode, file]) => [mode, (await rows(file))[0]])))

    // The second turn resumes the first turn's session, with the follow-up as its message.
    const calls = await Promise.all((await fs.readdir(fakeLog)).map(async name => JSON.parse(await fs.readFile(path.join(fakeLog, name), 'utf8'))))
    const resumed = calls.filter(call => call.resume)
    assert.equal(resumed.length, 3)
    for (const call of resumed) assert.equal(call.prompt, followUpPrompt(VAGUE))
    for (const mode of ['baseline', 'hook', 'hook-nohints']) {
      assert.equal(second[mode].turn, 2)
      assert.ok(second[mode].sessionId)
      assert.equal(second[mode].firstRunId, first[mode].runId)
      assert.equal(second[mode].costUsd, 0.01)
      assert.equal(second[mode].firstTurnCostUsd, 0.02)
      assert.deepEqual(second[mode].filesOpenedList, ['src/billing/invoice.js'])
      assert.deepEqual(second[mode].newFilesRead, ['src/billing/invoice.js'])
      assert.equal(second[mode].success, true)
    }

    // Turn 1: the hook attached the named source (throttle.js and failures.js).
    assert.equal(first.hook.hookDelivered, true)
    assert.deepEqual(first.hook.hookHints, [])
    assert.ok(first.hook.filesOpenedList.includes('src/auth/failures.js'))
    // Turn 2: the hook read the transcript; throttle.js was read and failures.js attached, so
    // it attached no source and named the remaining linked file as a hint, unless hints are off.
    assert.equal(second.hook.hookDelivered, false)
    assert.deepEqual(second.hook.hookHints, ['src/billing/invoice.js'])
    assert.deepEqual(second.hook.hintsRead, ['src/billing/invoice.js'])
    assert.deepEqual(second.hook.hintsExpected, ['src/billing/invoice.js'])
    assert.deepEqual(second['hook-nohints'].hookHints, [])
    assert.equal(second['hook-nohints'].hookChars, 0)
    assert.equal(second.baseline.hookHints, undefined)
    // The hook hands the product hook the follow-up text, not the wrapped prompt.
    const hookCall = resumed.find(call => call.attached)
    assert.match(hookCall.attached, /^StellarCode: Files linked to files already in this conversation/)
  } finally { await w.cleanup() }
})

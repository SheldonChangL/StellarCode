import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { preflight, promptGate, claudeHookOutput, installClaudeHook, CLAUDE_HOOK_MAX_CHARS, CLAUDE_HOOK_GUIDANCE, matchedTerms, namedInPrompt, filesInTranscript } from '../src/core/preflight.js'
import { semanticRepo } from './helpers-v06.js'

// v0.8 first-turn delivery: the context an agent would ask for in its first turn is
// attached to the prompt by a hook instead.

const BIN = fileURLToPath(new URL('../bin/stellar.js', import.meta.url))
const body = (name, lines) => `export function ${name}(input) {\n${Array.from({ length: lines }, (_, i) => `  const step${i} = input + ${i} // ${name} lockout window computation line ${i}`).join('\n')}\n  return input\n}\n`
const REPO = {
  'src/auth/throttle.js': `import { recordFailure } from './failures.js'\n\n${body('lockoutDuration', 60)}\nexport function onLoginFailure(account) {\n  return recordFailure(account, lockoutDuration(account.failures))\n}\n`,
  'src/auth/failures.js': body('recordFailure', 60),
  'src/billing/invoice.js': body('invoiceTotal', 40)
}
const QUESTION = 'Where is the lockout duration computed after repeated login failures for an account?'
// The same question naming the function: what the strict gate of the automatic hook needs.
const NAMED = 'How does onLoginFailure use lockoutDuration and recordFailure to compute the lockout window after repeated login failures?'

test('v0.8 prompt gate: commands and short follow-ups get no lookup', () => {
  assert.equal(promptGate(''), 'empty')
  assert.equal(promptGate('/compact'), 'command')
  assert.equal(promptGate('!npm test'), 'command')
  assert.equal(promptGate('yes go ahead'), 'too-short')
  assert.equal(promptGate('run the tests'), 'too-short')
  assert.equal(promptGate('see <stellar-grounded-context> above and continue with the lockout change'), 'already-attached')
  assert.equal(promptGate(QUESTION), null)
  assert.equal(promptGate('登入失敗後的鎖定時間是在哪裡計算的 lockout duration'), null)
  assert.equal(promptGate('好，繼續'), 'too-short')
})

test('v0.8 preflight attaches grounded source, once per session', async () => {
  const w = await semanticRepo(REPO)
  try {
    const outside = await preflight({ cwd: w.base, prompt: QUESTION, dirs: w.dirs })
    assert.deepEqual(outside, { deliver: false, reason: 'no-project' })

    const first = await preflight({ cwd: path.join(w.repo, 'src'), prompt: QUESTION, sessionId: 'session-a', dirs: w.dirs })
    assert.equal(first.deliver, true)
    assert.equal(first.targets[0], 'src/auth/throttle.js')
    assert.match(first.text, /<stellar-grounded-context>[\s\S]*\[Source: src\/auth\/throttle\.js lines \d+-\d+ sha256:[0-9a-f]{12}/)
    assert.match(first.text, /Do not run that command again\./)
    assert.ok(first.text.includes(JSON.stringify(QUESTION)))
    assert.equal(first.chars, first.text.length)

    // The same excerpts are not sent twice in one session; another session starts fresh.
    assert.deepEqual(await preflight({ cwd: w.repo, prompt: QUESTION, sessionId: 'session-a', dirs: w.dirs }), { deliver: false, reason: 'already-delivered' })
    assert.equal((await preflight({ cwd: w.repo, prompt: QUESTION, sessionId: 'session-b', dirs: w.dirs })).deliver, true)
    // Only a hash of the session id and excerpt keys are stored, never source.
    const stored = await fs.readdir(path.join(w.dirs.cache, 'preflight'))
    assert.equal(stored.length, 2)
    const record = await fs.readFile(path.join(w.dirs.cache, 'preflight', stored[0]), 'utf8')
    assert.ok(!record.includes('session-') && !record.includes('lockout window computation'))
  } finally { await w.cleanup() }
})

test('v0.8 preflight fits a host character limit without truncating an excerpt', async () => {
  const w = await semanticRepo(REPO)
  try {
    const free = await preflight({ cwd: w.repo, prompt: QUESTION, dirs: w.dirs })
    const limit = 3000
    assert.ok(free.chars > limit, `fixture must exceed the limit unbounded (got ${free.chars})`)
    const fitted = await preflight({ cwd: w.repo, prompt: QUESTION, dirs: w.dirs, maxChars: limit, guidance: CLAUDE_HOOK_GUIDANCE })
    assert.equal(fitted.deliver, true)
    assert.ok(fitted.chars <= limit, `${fitted.chars} > ${limit}`)
    assert.ok(fitted.text.endsWith('</stellar-grounded-context>'))
    assert.ok(!fitted.text.includes(JSON.stringify(QUESTION)), 'the prompt is not repeated under a limit')
    assert.deepEqual(await preflight({ cwd: w.repo, prompt: QUESTION, dirs: w.dirs, maxChars: 400 }), { deliver: false, reason: 'too-large' })
    assert.ok(CLAUDE_HOOK_MAX_CHARS < 10_000)
  } finally { await w.cleanup() }
})

test('v0.8 Claude Code hook: output shape, install and a hook that never fails', async () => {
  assert.equal(claudeHookOutput({ deliver: false, reason: 'too-short' }), '')
  assert.deepEqual(JSON.parse(claudeHookOutput({ deliver: true, text: 'ctx' })), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' } })

  const w = await semanticRepo(REPO)
  try {
    await fs.mkdir(path.join(w.repo, '.claude'))
    const settings = path.join(w.repo, '.claude', 'settings.json')
    await fs.writeFile(settings, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }))
    assert.deepEqual(await installClaudeHook(w.repo), { file: settings, installed: true })
    assert.deepEqual(await installClaudeHook(w.repo), { file: settings, installed: false })
    const written = JSON.parse(await fs.readFile(settings, 'utf8'))
    assert.deepEqual(written.permissions, { allow: ['Bash(npm test)'] })
    assert.equal(written.hooks.Stop.length, 1)
    assert.deepEqual(written.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'stellar preflight --hook', timeout: 20 }] }])
    await fs.writeFile(settings, '{ not json')
    await assert.rejects(installClaudeHook(w.repo), /not valid JSON/)

    const env = { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_CACHE_DIR: w.dirs.cache, STELLAR_LOG_DIR: w.dirs.logs }
    const run = input => execFileSync(process.execPath, [BIN, 'preflight', '--hook'], { input, env, encoding: 'utf8' })
    const output = JSON.parse(run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cli', cwd: w.repo, prompt: NAMED })))
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.ok(output.hookSpecificOutput.additionalContext.length <= CLAUDE_HOOK_MAX_CHARS)
    assert.match(output.hookSpecificOutput.additionalContext, /src\/auth\/throttle\.js/)
    // Bad input, a prompt that needs no lookup and a directory outside any project print nothing and exit 0.
    assert.equal(run('not json'), '')
    assert.equal(run(JSON.stringify({ cwd: w.repo, prompt: 'yes go ahead' })), '')
    // The automatic hook is strict: a prompt that names no attached file or symbol gets nothing,
    // unless the gate is switched off.
    assert.equal(run(JSON.stringify({ session_id: 'strict', cwd: w.repo, prompt: QUESTION })), '')
    const loose = execFileSync(process.execPath, [BIN, 'preflight', '--hook', '--gate', 'any'], { input: JSON.stringify({ session_id: 'loose', cwd: w.repo, prompt: QUESTION }), env, encoding: 'utf8' })
    assert.match(JSON.parse(loose).hookSpecificOutput.additionalContext, /src\/auth\/throttle\.js/)
    assert.equal(run(JSON.stringify({ cwd: w.base, prompt: QUESTION })), '')
  } finally { await w.cleanup() }
})

test('v0.8 --install-hook makes sure Claude Code reads the agent rule', async () => {
  const { installAgentRule } = await import('../src/core/agent-rule.js')
  const w = await semanticRepo(REPO)
  try {
    // Only AGENTS.md exists: Claude Code would never see the rule there.
    await fs.writeFile(path.join(w.repo, 'AGENTS.md'), '# Rules\n')
    assert.deepEqual(await installAgentRule(w.repo, { ensure: 'CLAUDE.md' }), ['AGENTS.md', 'CLAUDE.md'])
    for (const name of ['AGENTS.md', 'CLAUDE.md']) assert.match(await fs.readFile(path.join(w.repo, name), 'utf8'), /<stellar-grounded-context>` block is already attached/)
    // Idempotent, and an existing CLAUDE.md keeps its own content.
    assert.deepEqual(await installAgentRule(w.repo, { ensure: 'CLAUDE.md' }), [])
    await fs.appendFile(path.join(w.repo, 'CLAUDE.md'), '\n## House rules\nKeep it short.\n')
    assert.deepEqual(await installAgentRule(w.repo, { ensure: 'CLAUDE.md' }), [])
    const claude = await fs.readFile(path.join(w.repo, 'CLAUDE.md'), 'utf8')
    assert.match(claude, /## House rules\nKeep it short\./)
    assert.equal(claude.match(/## StellarCode repository navigation/g).length, 1)
  } finally { await w.cleanup() }
})

test('v0.8 benchmark hook condition: product path, no context in the prompt', async () => {
  const { benchmarkPrompt } = await import('../src/benchmark/agents.js')
  const { parseBenchmarkModes } = await import('../src/benchmark/runner.js')
  assert.deepEqual(parseBenchmarkModes('pull,hook'), ['pull', 'hook'])
  assert.deepEqual(parseBenchmarkModes('hook-brief,hook'), ['hook-brief', 'hook'])
  assert.deepEqual(parseBenchmarkModes('hook-any,hook'), ['hook-any', 'hook'])
  assert.equal(benchmarkPrompt({ prompt: QUESTION }, 'hook-any'), benchmarkPrompt({ prompt: QUESTION }, 'hook'))
  assert.equal(benchmarkPrompt({ prompt: QUESTION }, 'hook-brief'), benchmarkPrompt({ prompt: QUESTION }, 'hook'))
  // The shorthand for the v0.5.9 delivery experiment is unchanged.
  assert.deepEqual(parseBenchmarkModes('delivery'), ['pull', 'prefetch', 'prefetch-contract'])
  const prompt = benchmarkPrompt({ prompt: QUESTION }, 'hook')
  assert.ok(prompt.includes(QUESTION))
  assert.match(prompt, /## StellarCode repository navigation/)
  assert.ok(!prompt.includes('Your first action must be'))
  assert.ok(!prompt.includes('[Source: '))

  const w = await semanticRepo(REPO)
  try {
    const env = { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_CACHE_DIR: w.dirs.cache, STELLAR_LOG_DIR: w.dirs.logs }
    // --claude applies the hook's strict gate too, so it records what the hook would attach.
    assert.equal(JSON.parse(execFileSync(process.execPath, [BIN, 'preflight', QUESTION, w.repo, '--claude', '--json'], { env, encoding: 'utf8' })).reason, 'weak-match')
    const attached = JSON.parse(execFileSync(process.execPath, [BIN, 'preflight', NAMED, w.repo, '--claude', '--json'], { env, encoding: 'utf8' }))
    assert.equal(attached.deliver, true)
    assert.ok(attached.chars <= CLAUDE_HOOK_MAX_CHARS)
    assert.equal(attached.excerpts[0].path, 'src/auth/throttle.js')
    assert.deepEqual(Object.keys(attached.excerpts[0]).sort(), ['bytes', 'endLine', 'path', 'section', 'sha256', 'startLine'])
    assert.equal(attached.sourceBytes, attached.excerpts.reduce((sum, e) => sum + e.bytes, 0))
    // The hook carries the benchmarked guidance by default; the brief form is opt-in.
    assert.match(attached.text, /answer immediately with no further tool calls/)
    const brief = JSON.parse(execFileSync(process.execPath, [BIN, 'preflight', NAMED, w.repo, '--claude', '--guidance', 'brief', '--json'], { env, encoding: 'utf8' }))
    assert.ok(!brief.text.includes('answer immediately with no further tool calls'))
    assert.ok(brief.chars <= CLAUDE_HOOK_MAX_CHARS)
  } finally { await w.cleanup() }
})

test('v0.8.1 strict gate: attach only when the prompt names an attached file or symbol and matches enough terms', async () => {
  const targets = [
    { path: 'src/a.kt', symbol: 'DeviceService.bind', reason: 'name matches bind, device; body mentions error' },
    { path: 'src/b.kt', symbol: 'Main', reason: 'uses AppError; body mentions commit' },
    { path: 'src/c.kt', symbol: null, reason: 'Matches query terms: symbol match' }
  ]
  assert.deepEqual([...matchedTerms(targets)].sort(), ['bind', 'commit', 'device', 'error'])
  assert.deepEqual(namedInPrompt('fix DeviceService bind when the device is busy', { targets, paths: ['src/a.kt', 'src/deviceRepository.kt'] }), ['bind'])
  assert.deepEqual(namedInPrompt('commit these changes', { targets, paths: ['src/a.kt'] }), [])
  assert.deepEqual(namedInPrompt('look at deviceRepository.kt', { targets: [], paths: ['src/deviceRepository.kt'] }), ['devicerepository'])

  const w = await semanticRepo(REPO)
  try {
    // A conversational prompt that only shares common words with the code gets nothing.
    const chore = await preflight({ cwd: w.repo, prompt: 'commit the login lockout account changes and push them', dirs: w.dirs, strict: true })
    assert.equal(chore.deliver, false)
    assert.equal(chore.reason, 'weak-match')
    assert.equal((await preflight({ cwd: w.repo, prompt: QUESTION, dirs: w.dirs, strict: true })).reason, 'weak-match')
    const named = await preflight({ cwd: w.repo, prompt: NAMED, dirs: w.dirs, strict: true })
    assert.equal(named.deliver, true)
    assert.equal(named.excerpts[0].path, 'src/auth/throttle.js')
    // Without strict the old behavior holds: the manual command still answers any question.
    assert.equal((await preflight({ cwd: w.repo, prompt: QUESTION, dirs: w.dirs })).deliver, true)
  } finally { await w.cleanup() }
})

test('v0.8.2 session-aware delivery: files the conversation already has are not attached again', async () => {
  const w = await semanticRepo(REPO)
  try {
    // A Claude Code transcript: an absolute Read, an Edit, a relative path in a shell command,
    // a file outside the project and lines that are not tool calls.
    const transcript = path.join(w.base, 'session.jsonl')
    const use = (cwd, name, input) => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name, input }] } })
    await fs.writeFile(transcript, [
      JSON.stringify({ type: 'user', cwd: w.repo, message: { content: 'look at the lockout' } }),
      use(w.repo, 'Read', { file_path: path.join(w.repo, 'src/auth/throttle.js') }),
      use(path.join(w.repo, 'src'), 'Bash', { command: 'sed -n 1,20p auth/failures.js && ls' }),
      use(w.repo, 'Read', { file_path: path.join(w.base, 'elsewhere.js') }),
      use(w.repo, 'Grep', { pattern: 'invoiceTotal' }),
      'not json'
    ].join('\n'))
    assert.deepEqual([...await filesInTranscript(transcript, w.repo)].sort(), ['src/auth/failures.js', 'src/auth/throttle.js'])
    assert.equal((await filesInTranscript(path.join(w.base, 'missing.jsonl'), w.repo)).size, 0)

    const all = await preflight({ cwd: w.repo, prompt: NAMED, dirs: w.dirs })
    const files = [...new Set(all.excerpts.map(excerpt => excerpt.path))]
    assert.ok(files.includes('src/auth/throttle.js') && files.length > 1, `fixture attaches several files (got ${files})`)
    const rest = await preflight({ cwd: w.repo, prompt: NAMED, dirs: w.dirs, seenFiles: ['src/auth/throttle.js'] })
    assert.equal(rest.deliver, true)
    assert.ok(!rest.excerpts.some(excerpt => excerpt.path === 'src/auth/throttle.js'))
    assert.ok(rest.chars < all.chars)
    assert.deepEqual(await preflight({ cwd: w.repo, prompt: NAMED, dirs: w.dirs, seenFiles: files }), { deliver: false, reason: 'already-in-context' })
    // A prompt that named a file the agent already read still counts as naming the code.
    const named = await preflight({ cwd: w.repo, prompt: NAMED, dirs: w.dirs, strict: true, seenFiles: ['src/auth/throttle.js'] })
    assert.equal(named.deliver, true)

    // The hook reads the transcript Claude Code passes it.
    const readOne = path.join(w.base, 'read-one.jsonl')
    await fs.writeFile(readOne, use(w.repo, 'Read', { file_path: path.join(w.repo, 'src/auth/throttle.js') }) + '\n')
    const env = { ...process.env, STELLAR_DATA_DIR: w.dirs.data, STELLAR_CACHE_DIR: w.dirs.cache, STELLAR_LOG_DIR: w.dirs.logs }
    const hook = transcriptPath => execFileSync(process.execPath, [BIN, 'preflight', '--hook'], { input: JSON.stringify({ session_id: `t-${transcriptPath ? 1 : 0}`, cwd: w.repo, prompt: NAMED, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }), env, encoding: 'utf8' })
    const fresh = JSON.parse(hook(null)).hookSpecificOutput.additionalContext
    const later = JSON.parse(hook(readOne)).hookSpecificOutput.additionalContext
    // Under the hook's limit the attachment is these two files; with both read there is nothing new.
    // (Session hints are measured separately; off here.)
    assert.equal(execFileSync(process.execPath, [BIN, 'preflight', '--hook', '--session-hints', 'off'], { input: JSON.stringify({ session_id: 't-2', cwd: w.repo, prompt: NAMED, transcript_path: transcript }), env, encoding: 'utf8' }), '')
    // By default the hook then names what history ties to the files already read: paths only.
    const hintsOnly = JSON.parse(execFileSync(process.execPath, [BIN, 'preflight', '--hook'], { input: JSON.stringify({ session_id: 't-3', cwd: w.repo, prompt: NAMED, transcript_path: transcript }), env, encoding: 'utf8' })).hookSpecificOutput.additionalContext
    assert.match(hintsOnly, /by git history or imports[^]*- src\/billing\/invoice\.js/)
    assert.doesNotMatch(hintsOnly, /\[Source: /)
    assert.match(fresh, /\[Source: src\/auth\/throttle\.js/)
    assert.doesNotMatch(later, /\[Source: src\/auth\/throttle\.js/)
  } finally { await w.cleanup() }
})

test('v0.8.3 session hints: files that changed together with the files a session already has', async () => {
  const { coChangedFiles } = await import('../src/indexer/git.js')
  const { SESSION_HINT_LIMIT } = await import('../src/core/preflight.js')
  const w = await semanticRepo(REPO)
  try {
    const git = (...args) => execFileSync('git', ['-C', w.repo, ...args], { encoding: 'utf8' })
    const commit = async (message, files) => {
      for (const file of files) await fs.appendFile(path.join(w.repo, file), `// ${message}\n`)
      git('add', '.'); git('commit', '-qm', message)
    }
    // failures.js changes with throttle.js twice, invoice.js once; notes.md is not source.
    await fs.writeFile(path.join(w.repo, 'notes.md'), 'notes\n')
    await commit('one', ['src/auth/throttle.js', 'src/auth/failures.js', 'notes.md'])
    await commit('two', ['src/auth/throttle.js', 'src/auth/failures.js'])
    await commit('three', ['src/auth/throttle.js', 'src/billing/invoice.js'])
    await commit('alone', ['src/billing/invoice.js'])

    // The fixture's first commit holds all three source files, so each pair starts at 1.
    const tracked = file => file.startsWith('src/') || file === 'notes.md'
    assert.deepEqual(await coChangedFiles(w.repo, ['src/auth/throttle.js'], { limit: 5, accept: tracked }), [
      { path: 'src/auth/failures.js', score: 3 }, { path: 'src/billing/invoice.js', score: 2 }, { path: 'notes.md', score: 1 }])
    assert.deepEqual(await coChangedFiles(w.repo, [], { limit: 5 }), [])
    // A commit larger than the cap says nothing about what belongs together.
    assert.deepEqual((await coChangedFiles(w.repo, ['src/auth/throttle.js'], { maxCommitFiles: 2 })).map(entry => entry.path), ['src/auth/failures.js', 'src/billing/invoice.js'])

    // A follow-up with no lexical match still gets the hints, alone and once per session.
    const vague = 'please keep going with what we discussed and tidy the remaining parts up'
    const options = { cwd: w.repo, prompt: vague, dirs: w.dirs, strict: true, seenFiles: ['src/auth/throttle.js'], sessionHints: true, sessionId: 'hints' }
    const first = await preflight(options)
    assert.equal(first.deliver, true)
    assert.equal(first.hintsOnly, true)
    assert.deepEqual(first.sessionHints, ['src/auth/failures.js', 'src/billing/invoice.js'])
    assert.ok(first.sessionHints.length <= SESSION_HINT_LIMIT)
    assert.match(first.text, /NOT inspected source/)
    assert.ok(!first.text.includes('notes.md') && !first.text.includes('[Source: '))
    assert.equal((await preflight(options)).deliver, false)
    // No seen files (a new conversation) or the option off: no hints.
    assert.equal((await preflight({ ...options, sessionId: 'new', seenFiles: [] })).hintsOnly, undefined)
    assert.equal((await preflight({ ...options, sessionId: 'off', sessionHints: false })).deliver, false)
    // With source attached, the hints follow it and leave out files already attached.
    const both = await preflight({ cwd: w.repo, prompt: 'How does invoiceTotal compute the invoice total for the billing invoice?', dirs: w.dirs, seenFiles: ['src/auth/throttle.js'], sessionHints: true })
    assert.equal(both.hintsOnly, undefined)
    assert.ok(both.excerpts.some(excerpt => excerpt.path === 'src/billing/invoice.js'))
    assert.deepEqual(both.sessionHints, ['src/auth/failures.js'])
    assert.ok(both.text.indexOf('by git history or imports') > both.text.indexOf('</stellar-grounded-context>'))
  } finally { await w.cleanup() }
})

test('v0.8.4 session hints from the dependency graph, interleaved with git co-change', async () => {
  const { dependencyNeighbors } = await import('../src/query/query-service.js')
  const { filesAt } = await import('../src/indexer/git.js')
  const w = await semanticRepo(REPO)
  try {
    // throttle.js imports failures.js: each is the other's neighbor; invoice.js is unrelated.
    assert.deepEqual(await dependencyNeighbors(w.repo, ['src/auth/throttle.js'], { dirs: w.dirs }), [{ path: 'src/auth/failures.js', score: 1 }])
    assert.deepEqual(await dependencyNeighbors(w.repo, ['src/auth/failures.js'], { dirs: w.dirs }), [{ path: 'src/auth/throttle.js', score: 1 }])
    assert.deepEqual(await dependencyNeighbors(w.repo, ['src/auth/throttle.js'], { dirs: w.dirs, accept: file => !file.includes('failures') }), [])
    assert.deepEqual(await dependencyNeighbors(w.repo, ['missing.js'], { dirs: w.dirs }), [])

    const vague = 'please keep going with what we discussed and tidy the remaining parts up'
    const hintsFor = async (sessionHints, sessionId) => (await preflight({ cwd: w.repo, prompt: vague, dirs: w.dirs, seenFiles: ['src/auth/throttle.js'], sessionHints, sessionId })).sessionHints
    // Co-change names both other files (the fixture commits them together); imports only one.
    assert.deepEqual(await hintsFor({ source: 'deps' }, 'deps'), ['src/auth/failures.js'])
    assert.deepEqual(await hintsFor({ source: 'cochange' }, 'cochange'), ['src/auth/failures.js', 'src/billing/invoice.js'])
    assert.deepEqual(await hintsFor(true, 'default'), ['src/auth/failures.js', 'src/billing/invoice.js'])
    assert.deepEqual(await hintsFor({ limit: 1 }, 'limit'), ['src/auth/failures.js'])
    const deps = await preflight({ cwd: w.repo, prompt: vague, dirs: w.dirs, seenFiles: ['src/auth/throttle.js'], sessionHints: { source: 'deps' } })
    assert.match(deps.text, /import, or are imported by/)

    // For evaluation, a candidate must have existed at the prompt's time.
    assert.equal(await filesAt(w.repo, '2000-01-01T00:00:00Z'), null)
    assert.ok((await filesAt(w.repo, new Date(Date.now() + 86400000).toISOString())).has('src/auth/throttle.js'))
    assert.equal((await preflight({ cwd: w.repo, prompt: vague, dirs: w.dirs, seenFiles: ['src/auth/throttle.js'], sessionHints: { before: '2000-01-01T00:00:00Z' } })).deliver, false)
  } finally { await w.cleanup() }
})

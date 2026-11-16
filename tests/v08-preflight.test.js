import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { preflight, promptGate, claudeHookOutput, installClaudeHook, CLAUDE_HOOK_MAX_CHARS, CLAUDE_HOOK_GUIDANCE } from '../src/core/preflight.js'
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
    const output = JSON.parse(run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cli', cwd: w.repo, prompt: QUESTION })))
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.ok(output.hookSpecificOutput.additionalContext.length <= CLAUDE_HOOK_MAX_CHARS)
    assert.match(output.hookSpecificOutput.additionalContext, /src\/auth\/throttle\.js/)
    // Bad input, a prompt that needs no lookup and a directory outside any project print nothing and exit 0.
    assert.equal(run('not json'), '')
    assert.equal(run(JSON.stringify({ cwd: w.repo, prompt: 'yes go ahead' })), '')
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
    const attached = JSON.parse(execFileSync(process.execPath, [BIN, 'preflight', QUESTION, w.repo, '--claude', '--json'], { env, encoding: 'utf8' }))
    assert.equal(attached.deliver, true)
    assert.ok(attached.chars <= CLAUDE_HOOK_MAX_CHARS)
    assert.equal(attached.excerpts[0].path, 'src/auth/throttle.js')
    assert.deepEqual(Object.keys(attached.excerpts[0]).sort(), ['bytes', 'endLine', 'path', 'section', 'sha256', 'startLine'])
    assert.equal(attached.sourceBytes, attached.excerpts.reduce((sum, e) => sum + e.bytes, 0))
    // The hook carries the benchmarked guidance by default; the brief form is opt-in.
    assert.match(attached.text, /answer immediately with no further tool calls/)
    const brief = JSON.parse(execFileSync(process.execPath, [BIN, 'preflight', QUESTION, w.repo, '--claude', '--guidance', 'brief', '--json'], { env, encoding: 'utf8' }))
    assert.ok(!brief.text.includes('answer immediately with no further tool calls'))
    assert.ok(brief.chars <= CLAUDE_HOOK_MAX_CHARS)
  } finally { await w.cleanup() }
})

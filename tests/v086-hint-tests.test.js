import test from 'node:test'
import assert from 'node:assert/strict'

import { preflight } from '../src/core/preflight.js'
import { semanticRepo } from './helpers-v06.js'

// v0.8.6: session hints leave out test files.

const body = (name, lines) => `export function ${name}(input) {\n${Array.from({ length: lines }, (_, i) => `  const step${i} = input + ${i} // ${name} line ${i}`).join('\n')}\n  return input\n}\n`
const REPO = {
  'src/auth/throttle.js': `import { recordFailure } from './failures.js'\n\n${body('lockoutDuration', 20)}`,
  'src/auth/failures.js': body('recordFailure', 20),
  'tests/throttle.test.js': `import { lockoutDuration } from '../src/auth/throttle.js'\n${body('checkLockout', 5)}`
}

test('v0.8.6 session hints leave out test files unless asked to keep them', async () => {
  const w = await semanticRepo(REPO)
  try {
    const vague = 'please keep going with what we discussed and tidy the remaining parts up'
    const hintsFor = async sessionHints => (await preflight({ cwd: w.repo, prompt: vague, dirs: w.dirs, seenFiles: ['src/auth/throttle.js'], sessionHints })).sessionHints
    assert.deepEqual(await hintsFor({ source: 'deps' }), ['src/auth/failures.js'])
    assert.deepEqual((await hintsFor({ source: 'deps', tests: true })).sort(), ['src/auth/failures.js', 'tests/throttle.test.js'])
  } finally { await w.cleanup() }
})

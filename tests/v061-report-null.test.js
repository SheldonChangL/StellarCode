import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { median, paired, semanticReport, formatSemanticReportMarkdown, formatValue } from '../src/benchmark/semantic-report.js'

test('v0.6.1 median keeps missing values unavailable instead of turning them into 0', () => {
  assert.equal(median([null, undefined]), null)
  assert.equal(median([]), null)
  assert.equal(median([null, 4, undefined, 2]), 3)
  assert.equal(median([0, null]), 0)
  assert.equal(formatValue(null, '%'), 'n/a')
  assert.equal(formatValue(0, '%'), '0%')
})

test('v0.6.1 comparisons without pairs report null repo medians and n/a in the human report', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-null-'))
  try {
    const run = (taskId, extra) => ({ taskId, repetition: 1, category: 'flow', inputTokens: 100, toolCalls: 2, searchCalls: 1, sourceBytesRead: 10, modelTurns: 3, answerSuccess: true, success: true, ...extra })
    const write = async (repo) => {
      const dir = path.join(base, repo)
      await fs.mkdir(dir)
      await fs.writeFile(path.join(dir, 'manifest.json'), '{}')
      await fs.writeFile(path.join(dir, 'baseline.jsonl'), JSON.stringify(run('t1', { postContextExplorationTurns: null })) + '\n')
      await fs.writeFile(path.join(dir, 'stellar-lexical.jsonl'), JSON.stringify(run('t1', { postContextExplorationTurns: 2 })) + '\n')
      await fs.writeFile(path.join(dir, 'stellar.jsonl'), JSON.stringify(run('t1', { postContextExplorationTurns: 1 })) + '\n')
      return `${repo}=${dir}`
    }
    const report = await semanticReport([await write('a'), await write('b')])
    assert.equal(report.byRepository.a.semanticVsBaseline.postContextExplorationTurns.pairs, 0)
    assert.equal(report.byRepository.a.semanticVsBaseline.postContextExplorationTurns.reductionPct, null)
    assert.equal(report.repoMedian.semanticVsBaseline.postContextExplorationTurns, null)
    assert.equal(report.repoMedian.semanticVsLexical.postContextExplorationTurns, 50)
    const md = formatSemanticReportMarkdown(report)
    assert.match(md, /\| postContextExplorationTurns \| 50% \| n\/a \| n\/a \|/)
    assert.equal(paired([run('x', { m: null })], [run('x', { m: 1 })], 'm').reductionPct, null)
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

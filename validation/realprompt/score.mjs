#!/usr/bin/env node
// Scores StellarCode retrieval on the real-prompt evaluation set built by extract.mjs.
//
//   node validation/realprompt/score.mjs <eval-dir> --label NAME [--split dev|holdout] [--confirm-holdout]
//        [--hook] [--strict] [--session drop|skip] [--hints [--hint-source both|cochange|deps] [--hint-limit N] [--hint-tests]]
//   node validation/realprompt/score.mjs <eval-dir> --compare BASE NEW [--split dev|holdout]
//
// For each prompt it runs the same lookup as `stellar preflight` (context options of the
// delivery benchmarks, no character limit, no strict gate) against the pinned clone and
// compares the attached files with the files the agent actually touched in that turn.
// Per-prompt results go to <eval-dir>/results/<split>/<label>.jsonl (private: they contain
// paths); the printed summary contains only aggregates.
//
// Delivery variants: --hook uses the Claude hook's character limit; --strict its match gate;
// --session drop leaves out files the agent already touched earlier in the session, and
// --session skip attaches nothing when any file it would attach was already touched.
//
// --hints adds session hints (files linked to the seen files by git history before the
// prompt's time or by the dependency graph, once per session); it implies --session drop and replays each
// session in order with a fresh session store. --hint-source picks git co-change and the
// dependency graph interleaved (default), or one of them; --hint-limit caps the hints.
// --hint-tests keeps test files as hints (they are left out by default).
// Candidates must have existed at the prompt's time.
//
// The holdout split is for confirming a change already chosen on dev. Scoring it needs
// --confirm-holdout, and every holdout run is appended to <eval-dir>/holdout-log.jsonl.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const evalDir = path.resolve(args[0] ?? '')
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const split = flag('--split', 'dev')
if (!args[0] || !fs.existsSync(path.join(evalDir, `${split}.jsonl`)) || !['dev', 'holdout'].includes(split)) {
  console.error('usage: score.mjs <eval-dir> --label NAME [--split dev|holdout] [--confirm-holdout] | --compare BASE NEW')
  process.exit(2)
}
const resultsDir = path.join(evalDir, 'results', split)
const readRows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const sum = values => values.reduce((a, b) => a + b, 0)
const mean = values => (values.length ? sum(values) / values.length : 0)

// Deterministic bootstrap over prompts.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }
function interval(values, statistic, rounds = 4000) {
  const next = rng(20261116), stats = []
  for (let r = 0; r < rounds; r++) stats.push(statistic(values.map(() => values[Math.floor(next() * values.length)])))
  stats.sort((a, b) => a - b)
  return [stats[Math.floor(rounds * 0.025)], stats[Math.floor(rounds * 0.975)]]
}
const pct = x => `${(100 * x).toFixed(1)}%`
const METRICS = {
  delivered: 'attached anything',
  reachNew: 'a new touched file was attached, hinted, or hinted earlier in the session',
  hitNew: 'an attached file was touched and was new to the session',
  hit: 'an attached file was touched',
  top1: 'top target was touched',
  hitWithHints: 'touched file among attached or hinted',
  recall: 'share of touched files attached',
  precision: 'share of attached files touched (attached only)',
  redundant: 'share of attached files the session already had (attached only)'
}

function summarize(rows) {
  const delivered = rows.filter(row => row.delivered)
  return {
    items: rows.length,
    delivered: mean(rows.map(row => +row.delivered)),
    reachNew: mean(rows.map(row => +row.reachNew)),
    hitNew: mean(rows.map(row => +row.hitNew)),
    hit: mean(rows.map(row => +row.hit)),
    top1: mean(rows.map(row => +row.top1)),
    hitWithHints: mean(rows.map(row => +row.hitWithHints)),
    recall: mean(rows.map(row => row.recall)),
    precision: mean(delivered.map(row => row.precision)),
    redundant: mean(delivered.map(row => row.redundant)),
    chars: sum(rows.map(row => row.chars))
  }
}

if (args.includes('--compare')) {
  const i = args.indexOf('--compare')
  const [base, next] = [args[i + 1], args[i + 2]].map(label => new Map(readRows(path.join(resultsDir, `${label}.jsonl`)).map(row => [row.id, row])))
  const ids = [...base.keys()].filter(id => next.has(id))
  console.log(`${split}: ${args[i + 1]} -> ${args[i + 2]}, ${ids.length} paired prompts`)
  for (const metric of ['delivered', 'reachNew', 'hitNew', 'hit', 'top1', 'hitWithHints', 'recall']) {
    const diffs = ids.map(id => +next.get(id)[metric] - +base.get(id)[metric])
    const [lo, hi] = interval(diffs, mean)
    console.log(`  ${metric.padEnd(13)} ${pct(mean(ids.map(id => +base.get(id)[metric])))} -> ${pct(mean(ids.map(id => +next.get(id)[metric])))}  diff ${(100 * mean(diffs)).toFixed(1)} pts [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`)
  }
  const chars = rows => sum(rows.map(row => row.chars))
  console.log(`  attached characters ${chars([...base.values()])} -> ${chars([...next.values()])}`)
  process.exit(0)
}

const label = flag('--label')
if (!label) { console.error('--label NAME is required'); process.exit(2) }
const items = readRows(path.join(evalDir, `${split}.jsonl`))
const expected = JSON.parse(fs.readFileSync(path.join(evalDir, 'manifest.json'), 'utf8')).splits[split].sha256
const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(evalDir, `${split}.jsonl`))).digest('hex')
if (actual !== expected) { console.error(`${split}.jsonl changed since extraction (sha256 ${actual} != ${expected})`); process.exit(1) }
if (split === 'holdout' && !args.includes('--confirm-holdout')) { console.error('holdout scoring needs --confirm-holdout (confirm a change chosen on dev)'); process.exit(2) }

process.env.STELLAR_DATA_DIR = path.join(evalDir, 'stellar', 'data')
process.env.STELLAR_CACHE_DIR = path.join(evalDir, 'stellar', 'cache')
process.env.STELLAR_LOG_DIR = path.join(evalDir, 'stellar', 'logs')
const { preflight } = await import('../../src/core/preflight.js')

const hints = args.includes('--hints')
const session = hints ? 'drop' : flag('--session')
const hintSource = flag('--hint-source', 'both')
if (session && !['drop', 'skip'].includes(session)) { console.error('--session drop|skip'); process.exit(2) }
// Sessions are replayed in order; hint memory lives in a store that starts empty for this run.
items.sort((a, b) => a.session.localeCompare(b.session) || a.turn - b.turn || a.id.localeCompare(b.id))
const storeDirs = hints ? { data: process.env.STELLAR_DATA_DIR, logs: process.env.STELLAR_LOG_DIR, cache: fs.mkdtempSync(path.join(evalDir, 'stellar', 'hint-store-')) } : null
const hintedInSession = new Map()
const variant = { ...(args.includes('--hook') ? { maxChars: 9800 } : {}), strict: args.includes('--strict') }
const rows = []
for (const item of items) {
  const seen = new Set(item.seenBefore ?? [])
  let result = await preflight({ cwd: path.join(evalDir, 'repos', item.repo), prompt: item.prompt, ...variant, ...(session === 'drop' ? { seenFiles: item.seenBefore ?? [] } : {}), ...(hints ? { sessionHints: { before: item.timestamp, source: hintSource, ...(flag('--hint-limit') ? { limit: Number(flag('--hint-limit')) } : {}), ...(args.includes('--hint-tests') ? { tests: true } : {}) }, sessionId: `hints-${item.session}`, dirs: storeDirs } : {}) })
  if (session === 'skip' && result.deliver && result.excerpts.some(excerpt => seen.has(excerpt.path))) result = { deliver: false, reason: 'continuing' }
  const attached = [...new Set((result.excerpts ?? []).map(excerpt => excerpt.path))]
  const hinted = result.hintPaths ?? []
  const touched = new Set(item.touched)
  const found = attached.filter(file => touched.has(file))
  const remembered = hintedInSession.get(item.session) ?? new Set()
  hintedInSession.set(item.session, remembered)
  for (const hint of result.sessionHints ?? []) remembered.add(hint)
  const reachable = new Set([...attached, ...hinted, ...remembered])
  rows.push({
    id: item.id, repo: item.repo, followUp: seen.size > 0,
    delivered: !!result.deliver, reason: result.reason ?? null, chars: result.chars ?? 0,
    reachNew: item.touched.some(file => !seen.has(file) && reachable.has(file)),
    hintsOnly: !!result.hintsOnly, sessionHints: result.sessionHints ?? [],
    hitNew: found.some(file => !seen.has(file)),
    hit: found.length > 0,
    top1: touched.has(result.targets?.[0]),
    hitWithHints: found.length > 0 || hinted.some(file => touched.has(file)),
    recall: found.length / touched.size,
    precision: attached.length ? found.length / attached.length : 0,
    redundant: attached.length ? attached.filter(file => seen.has(file)).length / attached.length : 0,
    attached, hinted
  })
}
fs.mkdirSync(resultsDir, { recursive: true })
fs.writeFileSync(path.join(resultsDir, `${label}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
if (split === 'holdout') fs.appendFileSync(path.join(evalDir, 'holdout-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), label }) + '\n')

const pooled = summarize(rows)
console.log(`${split} / ${label}: ${rows.length} prompts in ${new Set(rows.map(row => row.repo)).size} repositories`)
for (const [metric, description] of Object.entries(METRICS)) {
  const base = metric === 'precision' ? rows.filter(row => row.delivered) : rows
  const [lo, hi] = interval(base, sample => summarize(sample)[metric])
  console.log(`  ${metric.padEnd(13)} ${pct(pooled[metric]).padStart(6)} [${pct(lo)}, ${pct(hi)}]  ${description}`)
}
console.log(`  attached characters: ${pooled.chars}`)
if (hints) {
  const given = rows.flatMap(row => row.sessionHints.map(hint => `${items.find(item => item.id === row.id).session}\n${hint}`))
  const later = new Set()
  for (const item of items) for (const file of item.touched) later.add(`${item.session}\n${file}`)
  console.log(`  session hints: ${given.length} given in ${rows.filter(row => row.sessionHints.length).length} turns (${rows.filter(row => row.hintsOnly).length} without source); ${given.filter(key => later.has(key)).length} were touched in the same session`)
}
const table = (title, groups) => {
  console.log(`  ${title} (items, delivered, hitNew, hit, top1, redundant):`)
  for (const [name, group] of groups) {
    const s = summarize(group)
    console.log(`    ${name.padEnd(10)} ${String(s.items).padStart(4)}  ${pct(s.delivered).padStart(6)} ${pct(s.hitNew).padStart(6)} ${pct(s.hit).padStart(6)} ${pct(s.top1).padStart(6)} ${pct(s.redundant).padStart(6)}`)
  }
}
table('per repository', [...new Set(rows.map(row => row.repo))].sort().map(repo => [repo, rows.filter(row => row.repo === repo)]))
table('by conversation state', [['new', rows.filter(row => !row.followUp)], ['follow-up', rows.filter(row => row.followUp)]])
const reasons = {}
for (const row of rows) if (!row.delivered) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1
console.log('  not attached:', JSON.stringify(reasons))

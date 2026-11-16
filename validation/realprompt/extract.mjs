#!/usr/bin/env node
// Builds a retrieval evaluation set from a developer's own Claude Code sessions.
//
//   node validation/realprompt/extract.mjs <eval-dir> [--until ISO-TIME]
//
// <eval-dir>/repos.json lists the repositories ({ id, stack, path, split }). For each one this
// clones the current HEAD into <eval-dir>/repos/<id>, indexes the clone with StellarCode (data
// under <eval-dir>/stellar), and reads every session transcript in ~/.claude/projects whose
// working directory is inside the repository. An item is a prompt the developer typed plus the
// source files the agent read, edited or wrote in that turn, before the next prompt, and the
// files it had already touched earlier in the same session (already in the conversation).
// --until keeps only prompts typed up to that time, so a set can be rebuilt unchanged.
//
// Everything written stays in <eval-dir>: prompts are private session content and must never
// be committed. The committed part is the method (this file, score.mjs) and aggregate results.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_EXTENSIONS } from '../../src/core/constants.js'
import { promptGate } from '../../src/core/preflight.js'

const evalDir = path.resolve(process.argv[2] ?? '')
const untilIndex = process.argv.indexOf('--until')
const until = untilIndex > 0 ? process.argv[untilIndex + 1] : null
if (!process.argv[2] || !fs.existsSync(path.join(evalDir, 'repos.json'))) {
  console.error('usage: extract.mjs <eval-dir>   (needs <eval-dir>/repos.json)')
  process.exit(2)
}
const BIN = fileURLToPath(new URL('../../bin/stellar.js', import.meta.url))
const home = os.homedir()
const expand = p => p.replace(/^~(?=\/|$)/, home)
const { repos } = JSON.parse(fs.readFileSync(path.join(evalDir, 'repos.json'), 'utf8'))
const stellarEnv = { ...process.env, STELLAR_DATA_DIR: path.join(evalDir, 'stellar', 'data'), STELLAR_CACHE_DIR: path.join(evalDir, 'stellar', 'cache'), STELLAR_LOG_DIR: path.join(evalDir, 'stellar', 'logs') }
const sha = text => crypto.createHash('sha256').update(text).digest('hex')

// 1. Pinned clones, indexed.
for (const repo of repos) {
  repo.source = expand(repo.path)
  repo.clone = path.join(evalDir, 'repos', repo.id)
  if (!fs.existsSync(repo.clone)) execFileSync('git', ['clone', '-q', '--local', '--no-hardlinks', repo.source, repo.clone])
  repo.commit = execFileSync('git', ['-C', repo.clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync(process.execPath, [BIN, 'init', repo.clone], { env: stellarEnv, stdio: 'ignore' })
}

// 2. Prompts and the files their turn touched.
const SKIP = ['<command-', '<local-command', '<system-reminder>', '<task-notification', '<side-sessions', '<ci-monitor', 'This session is being continued', 'Caveat:', '[Request interrupted']
function promptText(event) {
  if (event.type !== 'user' || event.isMeta || event.isSidechain || event.isCompactSummary) return null
  let content = event.message?.content
  if (Array.isArray(content)) {
    if (content.some(part => part?.type === 'tool_result')) return null
    content = content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
  }
  if (typeof content !== 'string') return null
  const text = content.trim()
  return !text || SKIP.some(prefix => text.startsWith(prefix)) ? null : text
}
// The checkout a session ran in: the repository itself, or one of its worktrees.
function checkoutOf(cwd) {
  for (const repo of repos) {
    if (cwd !== repo.source && !cwd.startsWith(repo.source + '/')) continue
    const worktree = cwd.slice(repo.source.length).match(/^\/\.claude\/worktrees\/[^/]+/)
    return { repo, root: worktree ? repo.source + worktree[0] : repo.source }
  }
  return null
}
const PATH_IN_COMMAND = /[\w./~-]+\.(?:kt|kts|ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|py|swift)\b/g
function sourceFile(candidate, cwd, checkout) {
  const absolute = path.resolve(cwd, expand(candidate))
  const relative = path.relative(checkout.root, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (!SUPPORTED_EXTENSIONS.has(path.extname(relative))) return null
  return fs.existsSync(path.join(checkout.repo.clone, relative)) ? relative.split(path.sep).join('/') : null
}

const items = new Map()
const sessionTouched = new Map()   // session id -> files touched so far in that session
const sessionTurns = new Map()     // session id -> prompts seen so far in that session
const projectsDir = path.join(home, '.claude', 'projects')
for (const dir of fs.readdirSync(projectsDir)) {
  let files = []
  try { files = fs.readdirSync(path.join(projectsDir, dir)).filter(name => name.endsWith('.jsonl')) } catch { continue }
  for (const name of files) {
    let current = null
    for (const line of fs.readFileSync(path.join(projectsDir, dir, name), 'utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      const text = promptText(event)
      if (text !== null) {
        const checkout = event.cwd ? checkoutOf(event.cwd) : null
        if (!checkout || (until && event.timestamp && event.timestamp > until)) { current = null; continue }
        const seen = sessionTouched.get(event.sessionId) ?? new Set()
        sessionTouched.set(event.sessionId, seen)
        const turn = sessionTurns.get(event.sessionId) ?? 0
        sessionTurns.set(event.sessionId, turn + 1)
        const id = sha(`${event.sessionId}\n${text}`).slice(0, 16)
        if (!items.has(id)) items.set(id, { id, repo: checkout.repo.id, split: checkout.repo.split, session: sha(String(event.sessionId)).slice(0, 16), timestamp: event.timestamp ?? null, turn, prompt: text, seenBefore: [...seen].sort(), touched: new Set(), edited: new Set() })
        current = { item: items.get(id), checkout, seen }
        continue
      }
      if (!current || event.type !== 'assistant') continue
      for (const part of event.message?.content ?? []) {
        if (part?.type !== 'tool_use') continue
        const input = part.input ?? {}
        const cwd = event.cwd ?? current.checkout.root
        const direct = input.file_path ?? input.notebook_path
        if (direct) {
          const file = sourceFile(direct, cwd, current.checkout)
          if (file) {
            current.item.touched.add(file)
            current.seen.add(file)
            if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(part.name)) current.item.edited.add(file)
          }
        }
        if (part.name === 'Bash' && typeof input.command === 'string') {
          for (const candidate of input.command.match(PATH_IN_COMMAND) ?? []) {
            const file = sourceFile(candidate, cwd, current.checkout)
            if (file) { current.item.touched.add(file); current.seen.add(file) }
          }
        }
      }
    }
  }
}

// 3. Keep prompts the hook would look up (not commands or short follow-ups) whose turn touched source.
const counts = {}
const kept = []
for (const item of items.values()) {
  const count = counts[item.repo] ??= { prompts: 0, gated: 0, noSource: 0, kept: 0 }
  count.prompts++
  if (promptGate(item.prompt)) { count.gated++; continue }
  if (!item.touched.size) { count.noSource++; continue }
  count.kept++
  kept.push({ ...item, touched: [...item.touched].sort(), edited: [...item.edited].sort() })
}
kept.sort((a, b) => a.id.localeCompare(b.id))
const manifest = { createdAt: new Date().toISOString(), until, repos: [], splits: {} }
for (const split of ['dev', 'holdout']) {
  const rows = kept.filter(item => item.split === split)
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  fs.writeFileSync(path.join(evalDir, `${split}.jsonl`), text)
  manifest.splits[split] = { items: rows.length, sha256: sha(text) }
}
for (const repo of repos) manifest.repos.push({ id: repo.id, stack: repo.stack, split: repo.split, commitSha256: sha(repo.commit).slice(0, 16), ...counts[repo.id] })
fs.writeFileSync(path.join(evalDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))

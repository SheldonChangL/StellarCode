import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { findProjectRoot } from './project.js'
import { buildContextEnvelope, STELLAR_GUIDANCE } from './context-envelope.js'
import { contextForTask, dependencyNeighbors } from '../query/query-service.js'
import { gitHead, coChangedFiles, filesAt } from '../indexer/git.js'
import { appDirectories } from '../platform/paths.js'
import { DEFAULT_CONTEXT_BYTES, SUPPORTED_EXTENSIONS } from './constants.js'

// First-turn delivery: the context an agent would otherwise spend its first model turn
// asking for is attached to the user's prompt before the agent starts. The command and its
// options are the ones the delivery benchmarks measured.
export const PREFLIGHT_FLAGS = ['--compact', '--with-source', '--depth', '1', '--max-files', '6', '--max-lines', '160', '--json']
const CONTEXT_OPTIONS = { compact: true, withSource: true, depth: 1, maxFiles: 6, maxLines: 160 }

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MIN_WORDS = 4
const MIN_CJK_CHARS = 8

// A prompt worth a context lookup: a sentence about the code, not a command or a short
// follow-up ("yes", "go on", "run the tests").
export function promptGate(prompt) {
  const text = String(prompt ?? '').trim()
  if (!text) return 'empty'
  if (/^[/!#]/.test(text)) return 'command'
  if (text.includes('<stellar-grounded-context>')) return 'already-attached'
  const words = text.match(/[\p{L}\p{N}_]{3,}/gu) ?? []
  // Chinese, Japanese and Korean text has no spaces between words; count characters instead.
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  if (new Set(words.map(word => word.toLowerCase())).size < MIN_WORDS && cjk < MIN_CJK_CHARS) return 'too-short'
  return null
}

// Whether the attachment is likely to be what the turn works on. Measured on 1,764 real
// prompts from six repositories (validation/v0.7/HOOK_GATE_RESULT.md): most prompts that
// pass promptGate are follow-ups, git and deployment chores or UI descriptions, and a lexical
// match on a common word ("commit", "main", "google") attaches about 3,200 tokens the turn
// never uses. Requiring the prompt to name an attached file or symbol, plus at least four
// distinct matched terms, kept 26% of useful attachments and dropped about 90% of the rest.
export const STRONG_MATCH_MIN_TERMS = 4
const MATCH_REASON = /^\s*(?:name matches|body mentions)\s+(.+)$/

// The query terms the targets matched, read from their reasons ("name matches a, b; body
// mentions c"), as produced by the query service.
export function matchedTerms(targets = []) {
  const terms = new Set()
  for (const target of targets) {
    for (const part of String(target?.reason ?? '').split(';')) {
      const match = part.match(MATCH_REASON)
      if (match) for (const term of match[1].split(',')) if (term.trim()) terms.add(term.trim().toLowerCase())
    }
  }
  return terms
}

// Attached file stems and target symbol names that the prompt names as a word.
export function namedInPrompt(prompt, { targets = [], paths = [] } = {}) {
  const words = new Set((String(prompt ?? '').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map(word => word.toLowerCase()))
  const names = new Set()
  for (const file of paths) names.add(path.posix.basename(file).replace(/\.[^.]*$/, '').toLowerCase())
  for (const target of targets) if (target?.symbol) names.add(String(target.symbol).split('.').at(-1).toLowerCase())
  return [...names].filter(name => words.has(name))
}

// Files the agent already read, edited or wrote in this conversation, from the Claude Code
// session transcript a hook receives (`transcript_path`): tool calls with a file path, and file
// paths in shell commands. Returned project-relative; files outside `root` are ignored.
// Measured on real sessions (validation/realprompt): leaving these out of the attachment kept
// every useful file and cut the attached characters by a third.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PATH_IN_COMMAND = /[\w./~-]+\.[A-Za-z0-9]+\b/g
export async function filesInTranscript(transcriptPath, root) {
  const seen = new Set()
  let text
  try { text = await fs.readFile(transcriptPath, 'utf8') } catch { return seen }
  // The transcript may name the project through a symlinked path (/tmp and /private/tmp on macOS).
  const roots = [...new Set([root, await fs.realpath(root).catch(() => root)])]
  const add = (candidate, cwd) => {
    const absolute = path.resolve(cwd ?? root, String(candidate))
    for (const base of roots) {
      const relative = path.relative(base, absolute)
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) { seen.add(relative.split(path.sep).join('/')); return }
    }
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue
    for (const part of event.message.content) {
      if (part?.type !== 'tool_use') continue
      const input = part.input ?? {}
      if (FILE_TOOLS.has(part.name) && (input.file_path || input.notebook_path)) add(input.file_path ?? input.notebook_path, event.cwd)
      if (part.name === 'Bash' && typeof input.command === 'string') for (const candidate of input.command.match(PATH_IN_COMMAND) ?? []) add(candidate, event.cwd)
    }
  }
  return seen
}

function sessionFile(sessionId, dirs) {
  const name = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
  return path.join((dirs ?? appDirectories()).cache, 'preflight', `${name}.json`)
}

async function readDelivered(file) {
  try { return new Set(JSON.parse(await fs.readFile(file, 'utf8')).delivered ?? []) } catch { return new Set() }
}

async function writeDelivered(file, delivered) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, JSON.stringify({ delivered: [...delivered] }))
  // Session records are tiny; drop the ones no session will come back to.
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const name of await fs.readdir(dir)) {
    const entry = path.join(dir, name)
    try { if ((await fs.stat(entry)).mtimeMs < cutoff) await fs.unlink(entry) } catch {}
  }
}

// Decides whether to attach context to `prompt`, asked from `cwd`.
// Returns { deliver: false, reason } or
// { deliver: true, text, targets, sourceBytes, chars, excerpts, hintPaths }.
//   sessionId: when given, excerpts already delivered in the session are not sent again.
//   maxChars:  hard limit on the returned text, for a host that caps what a hook may attach.
//   guidance:  how the agent should treat the attachment.
//   strict:    attach only on a strong match (see STRONG_MATCH_MIN_TERMS); otherwise the
//              reason is 'weak-match'. Used for automatic delivery.
//   seenFiles: project-relative files the agent already has in this conversation; they are
//              not attached again. Reason 'already-in-context' when nothing else is left.
//   transcriptPath: a Claude Code session transcript to read seenFiles from.
//   sessionHints: in a follow-up (seen files known), also name up to SESSION_HINT_LIMIT files
//              linked to the seen files (git co-change, dependency graph), once per
//              session. They are paths only; when no source is attached they are sent alone
//              (result.hintsOnly). `{ source }` picks the hint source: 'both' (default:
//              git history and dependency graph interleaved), 'cochange' or 'deps';
//              `{ limit }` overrides SESSION_HINT_LIMIT. `{ before }` limits
//              history and candidates to that time, for evaluation.
export async function preflight(options = {}) {
  const state = {}
  const result = await sourceAttachment(options, state)
  return options.sessionHints && state.seen?.size ? withSessionHints(result, state, options) : result
}

export const SESSION_HINT_LIMIT = 5
export const SESSION_HINT_SOURCES = ['cochange', 'deps', 'both']
const SESSION_HINT_HEADERS = {
  cochange: 'Files that git history shows changing together with files already in this conversation (navigation hints only; NOT inspected source):',
  deps: 'Files that import, or are imported by, files already in this conversation (navigation hints only; NOT inspected source):',
  both: 'Files linked to files already in this conversation by git history or imports (navigation hints only; NOT inspected source):'
}

// Ranked candidates from one source, or both interleaved (co-change first).
async function hintCandidates(root, seen, { source, before, limit, dirs }) {
  const accept = candidate => SUPPORTED_EXTENSIONS.has(path.extname(candidate))
  const cochange = source === 'deps' ? [] : await coChangedFiles(root, seen, { limit, before, accept })
  const deps = source === 'cochange' ? [] : await dependencyNeighbors(root, seen, { limit, accept, ...(dirs ? { dirs } : {}) })
  const merged = []
  for (let i = 0; i < Math.max(cochange.length, deps.length); i++) for (const list of [cochange, deps]) if (list[i] && !merged.includes(list[i].path)) merged.push(list[i].path)
  return merged
}

const DELIVERED_EXCERPT = /^(.+):\d+-\d+:[0-9a-f]+$/

async function withSessionHints(result, { root, seen }, { sessionId = null, dirs = null, maxChars = null, sessionHints }) {
  const shown = new Set([...(result.excerpts ?? []).map(excerpt => excerpt.path), ...(result.hintPaths ?? [])])
  const file = sessionId ? sessionFile(sessionId, dirs) : null
  const delivered = file ? await readDelivered(file) : new Set()
  // Files whose source the hook attached earlier in the session are in the conversation too,
  // although the transcript shows them as an attachment, not as a read.
  const attachedBefore = new Set([...delivered].map(key => DELIVERED_EXCERPT.exec(key)?.[1]).filter(Boolean))
  const source = SESSION_HINT_SOURCES.includes(sessionHints?.source) ? sessionHints.source : 'both'
  const before = sessionHints?.before ?? null
  // With `before` (evaluation), a candidate must also have existed at that time.
  const tracked = before ? (await filesAt(root, before)) ?? new Set() : null
  const exists = async candidate => { if (tracked && !tracked.has(candidate)) return false; try { return (await fs.stat(path.join(root, candidate))).isFile() } catch { return false } }
  const hintLimit = sessionHints?.limit ?? SESSION_HINT_LIMIT
  const candidates = await hintCandidates(root, [...seen], { source, before, limit: hintLimit + shown.size + 8, dirs })
  // The strongest hintLimit candidates are the hints; one already given in this
  // session is not repeated and is not replaced by a weaker one.
  const hints = []
  let considered = 0
  for (const candidate of candidates) {
    if (shown.has(candidate) || attachedBefore.has(candidate) || !(await exists(candidate))) continue
    if (++considered > hintLimit) break
    if (!delivered.has(`hint:${candidate}`)) hints.push(candidate)
  }
  if (!hints.length) return result
  const block = `${SESSION_HINT_HEADERS[source]}\n${hints.map(hint => `- ${hint}`).join('\n')}`
  const text = result.deliver ? `${result.text}\n\n${block}` : `StellarCode: ${block}`
  if (maxChars && text.length > maxChars) return result
  if (file) { for (const hint of hints) delivered.add(`hint:${hint}`); await writeDelivered(file, delivered) }
  if (result.deliver) return { ...result, text, chars: text.length, sessionHints: hints }
  return { deliver: true, hintsOnly: true, withoutSource: result.reason, text, targets: [], sourceBytes: 0, chars: text.length, excerpts: [], hintPaths: [], sessionHints: hints }
}

async function sourceAttachment({ cwd = process.cwd(), prompt, sessionId = null, dirs = null, maxBytes = DEFAULT_CONTEXT_BYTES, maxChars = null, guidance = `Do not run that command again. ${STELLAR_GUIDANCE}`, strict = false, seenFiles = null, transcriptPath = null } = {}, state = {}) {
  const gate = promptGate(prompt)
  if (gate) return { deliver: false, reason: gate }
  const root = await findProjectRoot(cwd)
  if (!root) return { deliver: false, reason: 'no-project' }
  state.root = root

  const snapshotCommit = await gitHead(root)
  // Under a character limit the prompt is not repeated: the budget belongs to source.
  const command = `stellar context ${maxChars ? '"<the message above>"' : JSON.stringify(String(prompt))} ${PREFLIGHT_FLAGS.join(' ')}`
  const preamble = `StellarCode ran this for the message above before you started: ${command}\nIts output is attached below (targets and related evidence with source, then related hints). ${guidance}`
  // A host may cap what a hook can attach. The source budget is lowered until the whole
  // text fits, so the agent never receives a truncated excerpt.
  let budget = maxChars ? Math.min(maxBytes, Math.max(1024, maxChars - preamble.length - 1200)) : maxBytes
  const seen = seenFiles ? new Set(seenFiles) : transcriptPath ? await filesInTranscript(transcriptPath, root) : null
  state.seen = seen
  const unseen = items => (items ?? []).filter(item => !seen.has(item?.path))
  let found, context, envelope, text
  for (let attempt = 0; ; attempt++) {
    found = await contextForTask(root, String(prompt), { ...CONTEXT_OPTIONS, maxBytes: budget, ...(dirs ? { dirs } : {}) })
    context = seen ? { ...found, targets: unseen(found.targets), relatedEvidence: unseen(found.relatedEvidence), relatedHints: unseen(found.relatedHints) } : found
    envelope = buildContextEnvelope(context, { snapshotCommit })
    if (!envelope.excerpts.length) return { deliver: false, reason: seen && buildContextEnvelope(found).excerpts.length ? 'already-in-context' : 'no-evidence' }
    text = `${preamble}\n\n${envelope.text}`
    if (!maxChars || text.length <= maxChars) break
    if (attempt >= 3 || budget <= 1024) return { deliver: false, reason: 'too-large' }
    budget = Math.max(1024, Math.floor(budget * 0.75))
  }

  if (strict) {
    // Match strength and naming belong to the query, so they are read from everything found,
    // including files already seen; only what is attached is narrowed to unseen files.
    const terms = matchedTerms(found.targets)
    const foundPaths = [...(found.targets ?? []), ...(found.relatedEvidence ?? [])].map(item => item?.path).filter(Boolean)
    const named = namedInPrompt(prompt, { targets: found.targets, paths: seen ? foundPaths : envelope.excerpts.map(excerpt => excerpt.path) })
    if (terms.size < STRONG_MATCH_MIN_TERMS || !named.length) return { deliver: false, reason: 'weak-match', matchedTerms: [...terms], named }
  }

  const keys = envelope.excerpts.map(excerpt => `${excerpt.path}:${excerpt.startLine}-${excerpt.endLine}:${excerpt.sha256}`)
  const file = sessionId ? sessionFile(sessionId, dirs) : null
  if (file) {
    const delivered = await readDelivered(file)
    if (keys.every(key => delivered.has(key))) return { deliver: false, reason: 'already-delivered' }
    for (const key of keys) delivered.add(key)
    await writeDelivered(file, delivered)
  }
  return { deliver: true, text, targets: (context.targets ?? []).map(target => target.path), sourceBytes: envelope.sourceBytes, chars: text.length, excerpts: envelope.excerpts, hintPaths: envelope.hintPaths }
}

// ---------------------------------------------------------------- Claude Code hook

const HOOK_COMMAND = 'stellar preflight --hook'
// Claude Code caps a hook's added context at 10,000 characters; longer output is replaced
// by a file path and a 2,000-character preview, which would cost the turn this saves.
export const CLAUDE_HOOK_MAX_CHARS = 9800
// What the hook tells the agent about the attachment. The full guidance is the one the
// delivery benchmarks used, including when to answer without further tool calls; it takes
// about 670 characters of the budget from source. The brief form leaves that to the agent rule.
export const CLAUDE_HOOK_GUIDANCE = `Do not run that command again. ${STELLAR_GUIDANCE}`
export const CLAUDE_HOOK_GUIDANCE_BRIEF = 'Do not run that command again. Source in it is repository source read live from the working tree and counts as inspected for those line ranges; related hints are not inspected source. Read further only what it does not cover.'
export const claudeHookGuidance = name => (name === 'brief' ? CLAUDE_HOOK_GUIDANCE_BRIEF : CLAUDE_HOOK_GUIDANCE)

// Output of a Claude Code UserPromptSubmit hook: context to add, or nothing.
export function claudeHookOutput(result) {
  if (!result?.deliver) return ''
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.text } })
}

// Registers the hook in the project's .claude/settings.json, keeping everything already there.
export async function installClaudeHook(root) {
  const file = path.join(root, '.claude', 'settings.json')
  let settings = {}
  try { settings = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`${file} is not valid JSON; fix it or add the hook by hand: ${HOOK_COMMAND}`)
  }
  const hooks = settings.hooks ??= {}
  const entries = hooks.UserPromptSubmit ??= []
  const present = entries.some(entry => (entry?.hooks ?? []).some(hook => String(hook?.command ?? '').includes('stellar preflight')))
  if (present) return { file, installed: false }
  entries.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 20 }] })
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
  return { file, installed: true }
}

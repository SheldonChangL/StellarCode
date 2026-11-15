import crypto from 'node:crypto'

const sha12 = text => crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12)

// Stable text envelope from a compact `stellar context --with-source --json` result. Only
// fields a normal context call returns are used: no scores, no debug data. Every excerpt
// keeps its path, line range and a hash of the exact excerpt text, plus the snapshot commit.
export function buildContextEnvelope(context, { snapshotCommit = null } = {}) {
  const lines = ['<stellar-grounded-context>']
  if (snapshotCommit) lines.push(`Snapshot: ${snapshotCommit}`)
  lines.push(`Intent: ${context?.intent ?? 'unknown'}`)
  if (context?.contextMode) lines.push(`Context mode: ${context.contextMode}`)
  if (context?.confidence) lines.push(`Confidence: ${context.confidence}`)
  const excerpts = []
  const section = (title, items) => {
    const sourced = (items ?? []).filter(item => typeof item?.source === 'string' && item.source.length)
    if (!sourced.length) return
    lines.push('', `${title}:`)
    for (const item of sourced) {
      const [start, end] = Array.isArray(item.lines) ? item.lines : [null, null]
      const hash = sha12(item.source)
      const label = [item.symbol ? `symbol ${item.symbol}` : null, item.relation ? `relation ${item.relation}` : null, item.direction && item.direction !== 'none' ? `direction ${item.direction}` : null].filter(Boolean).join(', ')
      lines.push('', `[Source: ${item.path} lines ${start}-${end} sha256:${hash}${label ? ` | ${label}` : ''}]`)
      lines.push(item.source)
      excerpts.push({ path: item.path, startLine: start, endLine: end, bytes: Buffer.byteLength(item.source), sha256: hash, section: title })
    }
  }
  section('Targets', context?.targets)
  section('Related evidence', context?.relatedEvidence)
  const hints = (context?.relatedHints ?? []).filter(hint => hint?.path)
  if (hints.length) {
    lines.push('', 'Related hints (navigation metadata only; NOT inspected source):')
    for (const hint of hints) lines.push(`- ${hint.path}${hint.relation ? ` (${hint.relation})` : ''}`)
  }
  lines.push('</stellar-grounded-context>')
  const text = lines.join('\n')
  return {
    text,
    excerpts,
    hintPaths: hints.map(hint => hint.path),
    topTarget: context?.targets?.[0]?.path ?? null,
    sourceBytes: excerpts.reduce((sum, excerpt) => sum + excerpt.bytes, 0),
    payloadBytes: Buffer.byteLength(text)
  }
}

// How an agent should treat a delivered context. The same wording is used whether the agent
// ran the command itself or received its output in the first turn.
export const STELLAR_GUIDANCE = `Any item in targets or relatedEvidence with a "source" field contains repository source read live from the working tree, with line numbers, and counts as inspected source for that range. Do not re-read those same embedded ranges. relatedHints are navigation metadata only: never list a hinted file in the final answer unless you separately inspect its source. Paths, symbols, confidence values and relation metadata without source are never source-of-truth. If targets plus relatedEvidence cover every part the task asks about, answer immediately with no further tool calls. If a concrete part is still unsupported, inspect only the smallest relevant hinted file/range (stellar source <path> --lines START:END --json or your file reader), then answer. Do not answer from paths or symbol names alone. Do not fall back to broad find/tree/grep/rg unless the returned grounded evidence is clearly unrelated.`

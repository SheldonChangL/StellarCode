import fs from 'node:fs/promises'
import path from 'node:path'

export const AGENT_RULE = `## StellarCode repository navigation

Repository navigation: query StellarCode before broad find/tree/grep/rg searches.
Prefer one compact context call with source when implementation evidence is needed: \`stellar context "<task>" --compact --with-source --depth 1 --json\`.
When a \`<stellar-grounded-context>\` block is already attached to the message, that call has been made for you: do not repeat it, and start from its source.
Source embedded in a successful Stellar response counts as inspected repository source; do not re-read the same range.
\`relatedEvidence\` contains grounded related source that may be cited. \`relatedHints\` is navigation metadata only and must not be presented as inspected implementation.
StellarCode metadata is navigation evidence, not source-of-truth. If the returned source is insufficient, read only the specific missing range via native Read or \`stellar source <path> --lines START:END\`.
Do not answer from summaries, paths, symbol names, or related hints alone.
`

// `ensure`: a file that must carry the rule even if it does not exist yet. Claude Code
// reads CLAUDE.md, not AGENTS.md.
export async function installAgentRule(root, { ensure = null } = {}) {
  const candidates = ['AGENTS.md', 'CLAUDE.md']
  const existing = new Set()
  const installed = []
  let found = false
  for (const name of candidates) {
    const file = path.join(root, name)
    try {
      const current = await fs.readFile(file, 'utf8')
      found = true
      existing.add(name)
      let next
      if (current.includes('## StellarCode repository navigation')) {
        // Whitespace around the section is kept, so installing twice changes nothing.
        next = current.replace(/(\n?)## StellarCode repository navigation\n[\s\S]*?(\n*)(?=\n## |$)/g, (match, lead, trail) => `${lead}${AGENT_RULE.trimEnd()}${trail}`)
        if (!next.endsWith('\n')) next += '\n'
      } else {
        next = `${current.trimEnd()}\n\n${AGENT_RULE}`
      }
      if (next !== current) {
        await fs.writeFile(file, next)
        installed.push(name)
      }
    } catch {}
  }
  if (!found) {
    const file = path.join(root, 'AGENTS.md')
    await fs.writeFile(file, AGENT_RULE)
    installed.push('AGENTS.md')
    existing.add('AGENTS.md')
  }
  if (ensure && !existing.has(ensure)) {
    await fs.writeFile(path.join(root, ensure), AGENT_RULE)
    installed.push(ensure)
  }
  return installed
}

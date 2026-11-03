import fs from 'node:fs/promises'
import path from 'node:path'

export const AGENT_RULE = `## StellarCode repository navigation

Repository navigation: query StellarCode before broad find/tree/grep/rg searches.
Prefer one compact context call with source when implementation evidence is needed: \`stellar context "<task>" --compact --with-source --depth 1 --json\`.
Source embedded in a successful Stellar response counts as inspected repository source; do not re-read the same range.
\`relatedEvidence\` contains grounded related source that may be cited. \`relatedHints\` is navigation metadata only and must not be presented as inspected implementation.
StellarCode metadata is navigation evidence, not source-of-truth. If the returned source is insufficient, read only the specific missing range via native Read or \`stellar source <path> --lines START:END\`.
Do not answer from summaries, paths, symbol names, or related hints alone.
`

export async function installAgentRule(root) {
  const candidates = ['AGENTS.md', 'CLAUDE.md']
  const installed = []
  let found = false
  for (const name of candidates) {
    const file = path.join(root, name)
    try {
      const current = await fs.readFile(file, 'utf8')
      found = true
      let next
      if (current.includes('## StellarCode repository navigation')) {
        next = current.replace(/\n?## StellarCode repository navigation\n[\s\S]*?(?=\n## |$)/g, `\n${AGENT_RULE.trimEnd()}`)
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
  }
  return installed
}

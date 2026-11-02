import fs from 'node:fs/promises'
import path from 'node:path'

export const AGENT_RULE = `## StellarCode repository navigation

Repository navigation: query StellarCode before broad find/tree/grep/rg searches.
Use StellarCode to locate relevant files, symbols, dependencies, tests, and impact scope.
StellarCode metadata is navigation evidence, not source-of-truth. Before making factual implementation claims, read the recommended source range (via native Read or \`stellar source <path> --lines START:END\`).
Do not answer from Stellar summaries alone. Read at least one primary source range for implementation questions; read additional primary files when your answer depends on them.
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

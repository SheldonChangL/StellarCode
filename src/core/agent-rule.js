import fs from 'node:fs/promises'
import path from 'node:path'

export const AGENT_RULE = `## StellarCode repository navigation\n\nRepository navigation: query StellarCode before broad find/tree/grep/rg searches.\nUse StellarCode to locate relevant files, symbols, dependencies, tests, and impact scope.\nRead source only after StellarCode narrows the target set.\n`

export async function installAgentRule(root) {
  const candidates = ['AGENTS.md', 'CLAUDE.md']
  const installed = []
  let found = false
  for (const name of candidates) {
    const file = path.join(root, name)
    try {
      const current = await fs.readFile(file, 'utf8')
      found = true
      if (!current.includes('## StellarCode repository navigation')) {
        await fs.appendFile(file, `\n${AGENT_RULE}`)
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

import { readFileSync } from 'node:fs'

// package.json is the single source of truth for the release version. It is resolved
// relative to this module, so it works from any cwd and from an installed package root.
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export const VERSION = packageJson.version
export const VERSION_LABEL = `StellarCode ${VERSION}`

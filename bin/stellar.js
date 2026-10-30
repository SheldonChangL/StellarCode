#!/usr/bin/env node

// Node 22 still labels node:sqlite as experimental. StellarCode intentionally targets
// Node 22.5+ and exercises SQLite through its test suite, so hide only this one noisy
// runtime warning from the end-user CLI while preserving every other warning.
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === 'string' ? warning : warning?.message ?? ''
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type
  if ((type === 'ExperimentalWarning' || warning?.name === 'ExperimentalWarning') && message.includes('SQLite is an experimental feature')) return
  return originalEmitWarning(warning, ...args)
}

await import('../src/cli.js')

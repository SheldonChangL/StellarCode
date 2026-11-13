export const PRODUCT_NAME = 'StellarCode'
export const PROJECT_SCHEMA_VERSION = 1
export const DB_SCHEMA_VERSION = 4
export const INDEXER_VERSION = 7
export const DEFAULT_PORT = 7432
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024
export const SUPPORTED_EXTENSIONS = new Map([
  ['.ts', 'TypeScript'],
  ['.tsx', 'TypeScript'],
  ['.mts', 'TypeScript'],
  ['.cts', 'TypeScript'],
  ['.js', 'JavaScript'],
  ['.jsx', 'JavaScript'],
  ['.mjs', 'JavaScript'],
  ['.cjs', 'JavaScript'],
  ['.py', 'Python'],
  ['.rs', 'Rust'],
  ['.kt', 'Kotlin'],
  ['.swift', 'Swift']
])
export const DEFAULT_IGNORES = new Set([
  '.git', '.stellar', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode'
])
// Source bytes one context response may carry. A model turn costs far more input than a few
// more kilobytes of source, so the budget favors whole symbols over a smaller payload.
export const DEFAULT_CONTEXT_BYTES = 20_000
// Serialized size one compact context response may reach. Agent harnesses cut a tool result
// off near 30,000 characters and show only a preview, which costs more than the dropped entries.
export const COMPACT_RESPONSE_BYTES = 29_000

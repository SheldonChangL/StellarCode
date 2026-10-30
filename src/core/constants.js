export const PRODUCT_NAME = 'StellarCode'
export const PROJECT_SCHEMA_VERSION = 1
export const DB_SCHEMA_VERSION = 1
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
  ['.py', 'Python']
])
export const DEFAULT_IGNORES = new Set([
  '.git', '.stellar', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode'
])

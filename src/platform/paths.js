import os from 'node:os'
import path from 'node:path'

export function appDirectories(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()

  if (env.STELLAR_DATA_DIR || env.STELLAR_CACHE_DIR || env.STELLAR_LOG_DIR) {
    const defaults = appDirectories({ platform, env: { ...env, STELLAR_DATA_DIR: undefined, STELLAR_CACHE_DIR: undefined, STELLAR_LOG_DIR: undefined }, home })
    return {
      data: env.STELLAR_DATA_DIR || defaults.data,
      cache: env.STELLAR_CACHE_DIR || defaults.cache,
      logs: env.STELLAR_LOG_DIR || defaults.logs
    }
  }

  if (platform === 'darwin') {
    return {
      data: path.join(home, 'Library', 'Application Support', 'StellarCode'),
      cache: path.join(home, 'Library', 'Caches', 'StellarCode'),
      logs: path.join(home, 'Library', 'Logs', 'StellarCode')
    }
  }

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return {
      data: path.join(local, 'StellarCode'),
      cache: path.join(local, 'StellarCode', 'Cache'),
      logs: path.join(local, 'StellarCode', 'Logs')
    }
  }

  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  const cacheHome = env.XDG_CACHE_HOME || path.join(home, '.cache')
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state')
  return {
    data: path.join(dataHome, 'stellarcode'),
    cache: path.join(cacheHome, 'stellarcode'),
    logs: path.join(stateHome, 'stellarcode', 'logs')
  }
}

export function normalizeRepoPath(input) {
  return path.resolve(input)
}

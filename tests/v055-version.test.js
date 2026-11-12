import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VERSION, VERSION_LABEL } from '../src/core/version.js'
import { handleMcpMessage } from '../src/mcp/server.js'

const run = promisify(execFile)
const bin = fileURLToPath(new URL('../bin/stellar.js', import.meta.url))

async function packageVersion() {
  return JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version
}

test('release version comes from package.json and reaches CLI and MCP', async () => {
  const pkg = await packageVersion()
  assert.match(pkg, /^\d+\.\d+\.\d+/)
  assert.equal(VERSION, pkg)
  assert.equal(VERSION_LABEL, `StellarCode ${pkg}`)

  for (const flag of ['--version', '-v']) {
    const { stdout } = await run(process.execPath, [bin, flag])
    assert.equal(stdout.trim(), `StellarCode ${pkg}`)
  }
  const help = await run(process.execPath, [bin, 'help'])
  assert.equal(help.stdout.split('\n')[0], `StellarCode ${pkg}`)

  const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.deepEqual(init.result.serverInfo, { name: 'stellarcode', version: pkg })
})

test('package-lock root version matches package.json', async () => {
  const pkg = await packageVersion()
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.equal(lock.version, pkg)
  assert.equal(lock.packages[''].version, pkg)
})

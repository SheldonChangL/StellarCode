import test from 'node:test'
import assert from 'node:assert/strict'
import { contextForTask } from '../src/query/query-service.js'
import { invokeMcpTool } from '../src/mcp/server.js'
import { semanticRepo } from './helpers-v06.js'


const BENCH = { compact: true, depth: 1, maxFiles: 6, maxLines: 160, maxBytes: 12000, withSource: true }
const CHAIN = {
  'src/repo/userRepository.ts': `export class UserRepository {\n  async insertUser(user: { email: string }) {\n    return db.query('insert', user)\n  }\n  async deleteUser(id: string) {\n    return db.query('delete', id)\n  }\n}\n\nexport default new UserRepository()\n`,
  'src/services/userService.ts': `import userRepository from '../repo/userRepository'\n\nclass UserService {\n  async registerUser(email: string) {\n    const user = { email: email.toLowerCase() }\n    return userRepository.insertUser(user)\n  }\n}\n\nexport default new UserService()\n`,
  'src/api/userController.ts': `import userService from '../services/userService'\n\nexport async function postRegistration(req: any, res: any) {\n  const created = await userService.registerUser(req.body.email)\n  res.json(created)\n}\n`,
  'src/api/routes.ts': `import { postRegistration } from './userController'\n\nexport function mount(router: any) {\n  router.post('/registration', postRegistration)\n}\n`
}

test('v0.6 flow slice grounds handler -> service -> repository with explicit CALLS direction', async () => {
  const w = await semanticRepo(CHAIN)
  try {
    const ctx = await contextForTask(w.repo, 'Trace how the registration request handler reaches the repository insert for a new user.', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.intent, 'flow')
    const grounded = new Set([...ctx.targets.filter(t => t.source).map(t => `${t.path}#${t.symbol}`), ...ctx.relatedEvidence.filter(e => e.source).map(e => `${e.path}#${e.symbol}`)])
    for (const symbol of ['src/api/userController.ts#postRegistration', 'src/services/userService.ts#UserService.registerUser', 'src/repo/userRepository.ts#UserRepository.insertUser'])
      assert.ok(grounded.has(symbol), `${symbol} grounded in ${[...grounded].join(', ')}`)
    const calls = ctx.semanticEvidence.filter(e => e.relation === 'CALLS')
    assert.ok(calls.some(e => e.from.symbol === 'UserService.registerUser' && e.to.symbol === 'UserRepository.insertUser' && e.direction === 'outgoing'), JSON.stringify(ctx.semanticEvidence))
    assert.ok(ctx.semanticEvidence.every(e => ['outgoing', 'incoming'].includes(e.direction) && ['high', 'medium'].includes(e.confidence)))
    assert.equal(ctx.semanticCapability.TypeScript, 'semantic')
    // Unrelated sibling behavior is not part of the slice.
    assert.ok(!ctx.relatedEvidence.some(e => e.symbol === 'UserRepository.deleteUser'))
  } finally { await w.cleanup() }
})

test('v0.6 impact slice grounds incoming consumers and does not expand the contract outgoing calls', async () => {
  const w = await semanticRepo({
    'src/Parser.ts': `export function parseConfigText(text: string) {\n  return text.split('=')\n}\n`,
    'src/Config.ts': `import { parseConfigText } from './Parser'\n\nexport function loadSettingsConfig(text: string) {\n  parseConfigText(text)\n  return { timeout: 1 }\n}\n`,
    'src/ServiceA.ts': `import { loadSettingsConfig } from './Config'\n\nexport function startA() {\n  const c = loadSettingsConfig('a=1')\n  return c.timeout\n}\n`,
    'src/ServiceB.ts': `import { loadSettingsConfig } from './Config'\n\nexport function startB() {\n  return loadSettingsConfig('b=2').timeout\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'If loadSettingsConfig changes its return shape, which code is affected?', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.intent, 'impact')
    assert.equal(ctx.targets[0].path, 'src/Config.ts')
    const consumers = ctx.relatedEvidence.filter(e => e.source && e.direction === 'incoming').map(e => e.path).sort()
    assert.deepEqual(consumers, ['src/ServiceA.ts', 'src/ServiceB.ts'])
    assert.ok(!ctx.semanticEvidence.some(e => e.to.path === 'src/Parser.ts'), 'impact does not follow the outgoing Parser call')
    assert.ok(ctx.semanticEvidence.every(e => e.direction === 'incoming'))
  } finally { await w.cleanup() }
})

test('v0.6 CLI context and MCP stellar_context return the same semantic slice; the switch disables it', async () => {
  const w = await semanticRepo(CHAIN)
  try {
    const task = 'Trace how the registration request handler reaches the repository insert for a new user.'
    const cli = await contextForTask(w.repo, task, { dirs: w.dirs, ...BENCH })
    const mcp = await invokeMcpTool('stellar_context', { task, withSource: true, projectPath: w.repo }, null, { dirs: w.dirs })
    assert.deepEqual(mcp.semanticEvidence, cli.semanticEvidence)
    assert.deepEqual(mcp.relatedEvidence, cli.relatedEvidence)
    process.env.STELLAR_SEMANTIC_SLICE = '0'
    try {
      const off = await contextForTask(w.repo, task, { dirs: w.dirs, ...BENCH })
      assert.equal(off.semanticEvidence, undefined)
      assert.ok(!off.relatedEvidence.some(e => e.semantic))
    } finally { delete process.env.STELLAR_SEMANTIC_SLICE }
  } finally { await w.cleanup() }
})

test('v0.6 a range shared by several semantic edges is grounded once', async () => {
  const w = await semanticRepo({
    'src/store.ts': `export function writeAuditRecord(entry: string) {\n  return entry.length\n}\n`,
    'src/a.ts': `import { writeAuditRecord } from './store'\n\nexport function auditLogin(user: string) {\n  writeAuditRecord(user)\n  writeAuditRecord(user + '!')\n}\n`,
    'src/b.ts': `import { writeAuditRecord } from './store'\n\nexport function auditLogout(user: string) {\n  return writeAuditRecord(user)\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Which callers are affected if writeAuditRecord changes?', { dirs: w.dirs, ...BENCH })
    const ranges = [...ctx.targets, ...ctx.relatedEvidence].filter(e => e.source).map(e => `${e.path}:${e.lines.join('-')}`)
    assert.equal(new Set(ranges).size, ranges.length)
    const lines = new Map()
    for (const e of [...ctx.targets, ...ctx.relatedEvidence].filter(e => e.source)) {
      for (let n = e.lines[0]; n <= e.lines[1]; n++) { const k = `${e.path}:${n}`; assert.ok(!lines.has(k), `line ${k} grounded twice`); lines.set(k, true) }
    }
  } finally { await w.cleanup() }
})

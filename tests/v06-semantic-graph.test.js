import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { syncProject } from '../src/indexer/sync.js'
import { semanticRepo, semanticEdges } from './helpers-v06.js'

const has = (edges, type, from, to, confidence) => edges.some(e => e.type === type && e.from === from && e.to === to && (!confidence || e.confidence === confidence))
const describe = edges => edges.map(e => `${e.type} ${e.from} -> ${e.to} (${e.confidence})`).sort().join('\n')

test('v0.6 direct call chain handler -> service -> repository (CALLS, imported binding and singleton instance)', async () => {
  const w = await semanticRepo({
    'src/repo.ts': `export function save(user: { id: string }) {\n  return db.insert(user)\n}\n`,
    'src/service.ts': `import { save } from './repo.js'\n\nexport class UserService {\n  create(user: { id: string }) {\n    const normalized = { ...user }\n    return save(normalized)\n  }\n}\n\nexport default new UserService()\n`,
    'src/handler.ts': `import userService from './service.js'\n\nexport async function handleCreate(req: any) {\n  return userService.create(req.body)\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/handler.ts#handleCreate', 'src/service.ts#UserService.create', 'high'), describe(edges))
    assert.ok(has(edges, 'CALLS', 'src/service.ts#UserService.create', 'src/repo.ts#save', 'high'), describe(edges))
    const evidence = edges.find(e => e.to === 'src/repo.ts#save')
    assert.equal(evidence.line, 6)
    assert.match(evidence.expression, /^save\(/)
  } finally { await w.cleanup() }
})

test('v0.6 aliased import resolves to the original symbol', async () => {
  const w = await semanticRepo({
    'src/repo.ts': `export function save(data: string) {\n  return data.length\n}\n`,
    'src/use.ts': `import { save as persist } from './repo'\n\nexport function store(data: string) {\n  return persist(data)\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/use.ts#store', 'src/repo.ts#save', 'high'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 this.field.method resolves through TS parameter properties, typed fields and constructor assignments', async () => {
  const w = await semanticRepo({
    'src/UserRepository.ts': `export class UserRepository {\n  save(user: string) {\n    return user\n  }\n}\n`,
    'src/AuditLog.ts': `export class AuditLog {\n  write(entry: string) {\n    return entry\n  }\n}\n`,
    'src/UserService.ts': `import { UserRepository } from './UserRepository'\nimport { AuditLog } from './AuditLog'\n\nexport class UserService {\n  private audit: AuditLog\n  constructor(private readonly repository: UserRepository, audit: AuditLog) {\n    this.audit = audit\n  }\n\n  create(user: string) {\n    this.audit.write(user)\n    return this.repository.save(user)\n  }\n}\n`,
    'src/plain.js': `import { UserRepository } from './UserRepository'\n\nexport class PlainService {\n  constructor() {\n    this.repo = new UserRepository()\n  }\n  run(x) {\n    return this.repo.save(x)\n  }\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/UserService.ts#UserService.create', 'src/UserRepository.ts#UserRepository.save', 'high'), describe(edges))
    assert.ok(has(edges, 'CALLS', 'src/UserService.ts#UserService.create', 'src/AuditLog.ts#AuditLog.write', 'high'), describe(edges))
    assert.ok(has(edges, 'CALLS', 'src/plain.js#PlainService.run', 'src/UserRepository.ts#UserRepository.save', 'high'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 untyped JS constructor field is inferred only from agreeing instantiation sites (medium)', async () => {
  const w = await semanticRepo({
    'src/SqlRepo.js': `export class SqlRepo {\n  save(x) {\n    return x\n  }\n}\n`,
    'src/Service.js': `export class Service {\n  constructor(repository) {\n    this.repository = repository\n  }\n  create(x) {\n    return this.repository.save(x)\n  }\n}\n`,
    'src/main.js': `import { Service } from './Service'\nimport { SqlRepo } from './SqlRepo'\n\nexport function boot() {\n  const service = new Service(new SqlRepo())\n  return service\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/Service.js#Service.create', 'src/SqlRepo.js#SqlRepo.save', 'medium'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 interface receiver with several implementations calls the contract, never a guessed implementation', async () => {
  const w = await semanticRepo({
    'src/Repository.ts': `export interface Repository {\n  save(x: string): Promise<void>\n  find(id: string): Promise<string>\n}\n`,
    'src/SqlRepository.ts': `import { Repository } from './Repository'\n\nexport class SqlRepository implements Repository {\n  async save(x: string) {\n    return\n  }\n  async find(id: string) {\n    return id\n  }\n}\n`,
    'src/MemoryRepository.ts': `import { Repository } from './Repository'\n\nexport class MemoryRepository implements Repository {\n  async save(x: string) {\n    return\n  }\n  async find(id: string) {\n    return id\n  }\n}\n`,
    'src/Consumer.ts': `import type { Repository } from './Repository'\n\nexport class Consumer {\n  constructor(private repo: Repository) {}\n  async run(x: string) {\n    await this.repo.save(x)\n  }\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/Consumer.ts#Consumer.run', 'src/Repository.ts#Repository.save', 'medium'), describe(edges))
    assert.ok(!edges.some(e => e.type === 'CALLS' && e.from === 'src/Consumer.ts#Consumer.run' && /Sql|Memory/.test(e.to)), describe(edges))
    // Explicit implements: class and method level.
    assert.ok(has(edges, 'IMPLEMENTS', 'src/SqlRepository.ts#SqlRepository', 'src/Repository.ts#Repository', 'high'), describe(edges))
    assert.ok(has(edges, 'IMPLEMENTS', 'src/MemoryRepository.ts#MemoryRepository.save', 'src/Repository.ts#Repository.save', 'high'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 impact consumers: callers and type consumers are incoming edges, the contract outgoing edges are separate', async () => {
  const w = await semanticRepo({
    'src/Parser.ts': `export function parse(text: string) {\n  return text.split('=')\n}\n`,
    'src/Config.ts': `import { parse } from './Parser'\n\nexport interface ConfigShape {\n  timeout: number\n}\n\nexport function loadConfig(text: string): ConfigShape {\n  parse(text)\n  return { timeout: 1 }\n}\n`,
    'src/ServiceA.ts': `import { loadConfig } from './Config'\n\nexport function startA() {\n  return loadConfig('a=1')\n}\n`,
    'src/ServiceB.ts': `import { type ConfigShape } from './Config'\n\nexport function startB(config: ConfigShape) {\n  return config.timeout\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/ServiceA.ts#startA', 'src/Config.ts#loadConfig', 'high'), describe(edges))
    assert.ok(has(edges, 'CONSUMES', 'src/ServiceB.ts#startB', 'src/Config.ts#ConfigShape', 'high'), describe(edges))
    assert.ok(has(edges, 'CALLS', 'src/Config.ts#loadConfig', 'src/Parser.ts#parse', 'high'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 registration: a known function passed as a callback argument (no library hardcoded)', async () => {
  const w = await semanticRepo({
    'src/handlers.ts': `export function onUserCreated(event: unknown) {\n  return event\n}\nexport function createUser(req: unknown) {\n  return req\n}\n`,
    'src/wire.ts': `import { onUserCreated } from './handlers'\nimport * as handlers from './handlers'\n\nexport function wire(bus: any, router: any) {\n  bus.register('user.created', onUserCreated)\n  router.post('/users', handlers.createUser)\n  bus.register('user.deleted', someUnknownThing)\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'REGISTERS', 'src/wire.ts#wire', 'src/handlers.ts#onUserCreated', 'high'), describe(edges))
    assert.ok(has(edges, 'REGISTERS', 'src/wire.ts#wire', 'src/handlers.ts#createUser', 'high'), describe(edges))
    assert.equal(edges.filter(e => e.from === 'src/wire.ts#wire').length, 2, describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 barrel re-export resolves to the original implementation, not the index file', async () => {
  const w = await semanticRepo({
    'src/repo/save.ts': `export function save(x: string) {\n  return x\n}\n`,
    'src/repo/index.ts': `export { save } from './save'\nexport * from './other'\n`,
    'src/repo/other.ts': `export function remove(x: string) {\n  return x\n}\n`,
    'src/service.ts': `import { save, remove } from './repo'\n\nexport function run(x: string) {\n  save(x)\n  remove(x)\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'src/service.ts#run', 'src/repo/save.ts#save', 'high'), describe(edges))
    assert.ok(has(edges, 'CALLS', 'src/service.ts#run', 'src/repo/other.ts#remove', 'high'), describe(edges))
    assert.ok(!edges.some(e => e.to.startsWith('src/repo/index.ts')), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 dynamic and computed calls produce no concrete edge', async () => {
  const w = await semanticRepo({
    'src/actions.ts': `export function approve() {\n  return 1\n}\nexport function reject() {\n  return 2\n}\nexport const actions = { approve, reject }\n`,
    'src/dispatch.ts': `import { actions } from './actions'\n\nexport function dispatch(actionName: string, obj: any) {\n  obj[actionName]()\n  actions[actionName]()\n  const fn = pick(actionName)\n  return fn()\n}\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(!edges.some(e => e.type === 'CALLS' && e.from.startsWith('src/dispatch.ts')), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 Python: imported function call, aliased import, module call and typed self field', async () => {
  const w = await semanticRepo({
    'app/__init__.py': '',
    'app/repo.py': `def save_user(user):\n    return user\n\n\nclass Repository:\n    def save(self, item):\n        return item\n`,
    'app/handlers.py': `from app.repo import save_user\nfrom app.repo import save_user as persist\nfrom app import repo\n\n\ndef handle(user):\n    save_user(user)\n    persist(user)\n    return repo.save_user(user)\n`,
    'app/service.py': `from app.repo import Repository\n\n\nclass Service:\n    def __init__(self, repo: Repository):\n        self.repo = repo\n        self.backup = Repository()\n\n    def run(self, item):\n        self.repo.save(item)\n        return self.backup.save(item)\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'CALLS', 'app/handlers.py#handle', 'app/repo.py#save_user', 'high'), describe(edges))
    assert.ok(has(edges, 'CALLS', 'app/service.py#Service.run', 'app/repo.py#Repository.save', 'high'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 Python: untyped self field without assignment evidence produces no concrete callee', async () => {
  const w = await semanticRepo({
    'svc/__init__.py': '',
    'svc/repo.py': `class SqlRepo:\n    def save(self, x):\n        return x\n\n\nclass MemoryRepo:\n    def save(self, x):\n        return x\n`,
    'svc/service.py': `class Service:\n    def __init__(self, repo):\n        self.repo = repo\n\n    def run(self, x):\n        return self.repo.save(x)\n`,
    'svc/factory.py': `from svc.service import Service\n\n\ndef build(repo_factory):\n    return Service(repo_factory())\n`
  })
  try {
    const edges = await semanticEdges(w)
    assert.ok(!edges.some(e => e.type === 'CALLS' && e.from === 'svc/service.py#Service.run'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6 index records the indexer version and rebuilds semantic facts on a version change', async () => {
  const w = await semanticRepo({ 'src/a.ts': `export function a() {\n  return b()\n}\nexport function b() {\n  return 1\n}\n` })
  try {
    assert.equal(w.sync.indexerVersion, 3)
    assert.ok(w.sync.semanticEdges.CALLS >= 1)
    const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
    db.prepare('UPDATE project_meta SET indexer_version=2').run()
    db.prepare("DELETE FROM edges WHERE edge_type='CALLS'").run()
    db.close()
    const again = await syncProject(w.repo, { dirs: w.dirs })
    assert.equal(again.semanticReindex, true)
    assert.ok((await semanticEdges(w)).some(e => e.type === 'CALLS' && e.to === 'src/a.ts#b'))
    // Incremental edit: a changed file is re-parsed and relations are resolved again.
    await fs.writeFile(path.join(w.repo, 'src/a.ts'), `export function a() {\n  return 1\n}\nexport function b() {\n  return a()\n}\n`)
    await syncProject(w.repo, { dirs: w.dirs })
    const edges = await semanticEdges(w)
    assert.ok(edges.some(e => e.type === 'CALLS' && e.from === 'src/a.ts#b' && e.to === 'src/a.ts#a'), describe(edges))
    assert.ok(!edges.some(e => e.type === 'CALLS' && e.from === 'src/a.ts#a'), describe(edges))
  } finally { await w.cleanup() }
})

// Review regressions: each case once produced a wrong HIGH-confidence edge.
const FALSE_EDGE_CASES = {
  'nested declaration does not replace the module-level symbol': [{
    'a.js': 'export function outer() {\n  const save = (y) => { return y }\n  return save(1)\n}\nexport function save(x) { return x }\nexport function main() {\n  return save(2)\n}\n'
  }, edges => !edges.some(e => e.type === 'CALLS' && e.to.endsWith('#save') && e.from.endsWith('#outer')) && edges.some(e => e.from === 'a.js#main' && e.to === 'a.js#save')],
  'untyped parameter shadows an import': [{
    'lib.js': 'export function format(x) { return x }\n',
    'a.js': "import { format } from './lib.js'\nexport function run(format) {\n  return format(1)\n}\nexport function wire(handler, register) {\n  return register(handler)\n}\nexport function handler() {}\n"
  }, edges => !edges.some(e => e.from === 'a.js#run') && !edges.some(e => e.from === 'a.js#wire')],
  'regex literal does not unmask a string': [{
    'a.js': 'export function danger(x) { return x }\nexport function f(s) {\n  s = s.replace(/"/g, "")\n  const msg = "never call danger(now)"\n  return msg\n}\n'
  }, edges => !edges.some(e => e.to === 'a.js#danger')],
  'JSX text is not a call': [{
    'v.jsx': 'export function deleteAll(items) { return items }\nexport function View() {\n  return <p>do not deleteAll(items)</p>\n}\n'
  }, edges => !edges.some(e => e.to === 'v.jsx#deleteAll')],
  'commented-out re-export and require are ignored': [{
    'legacy.js': 'export function save(x) { return x }\nexport function go() {}\n',
    'modern.js': 'export function save(x) { return x }\n',
    'index.js': "// export { save } from './legacy.js'\nexport { save } from './modern.js'\n",
    'a.js': "import { save } from './index.js'\n// const svc = require('./legacy.js')\nexport function f() {\n  save(1)\n  return svc.go()\n}\n"
  }, edges => edges.some(e => e.from === 'a.js#f' && e.to === 'modern.js#save') && !edges.some(e => e.to.startsWith('legacy.js'))],
  'reassigned binding has no type': [{
    'c.js': 'export class A { run() {} }\nexport class B { run() {} }\n',
    'a.js': "import { A, B } from './c.js'\nexport function f() {\n  let x = new A()\n  x = new B()\n  return x.run()\n}\n"
  }, edges => !edges.some(e => e.type === 'CALLS' && e.from === 'a.js#f' && e.to.endsWith('.run'))],
  'conflicting field assignments give no field type': [{
    'c.js': 'export class A { go() {} }\nexport class B { go() {} }\n',
    's.js': "import { A, B } from './c.js'\nexport class S {\n  r = new A()\n  constructor(r) {\n    this.r = r\n  }\n  reset() {\n    this.r = new B()\n  }\n  run() {\n    return this.r.go()\n  }\n}\nexport function boot() { return new S(new B()) }\n"
  }, edges => !edges.some(e => e.from === 's.js#S.run' && e.to.endsWith('.go'))],
  'this inside an object-literal method is not the class': [{
    's.js': 'export class S {\n  save() {}\n  run() {\n    const o = {\n      save() {},\n      go() { return this.save() }\n    }\n    return o\n  }\n}\n'
  }, edges => !edges.some(e => e.to === 's.js#S.save') && !edges.some(e => e.from === 's.js#S.go')],
  'object key is not a consumption': [{
    'lib.js': 'export const config = { a: 1 }\n',
    'a.js': "import { config } from './lib.js'\nexport function other(opts) {\n  return { config: opts }\n}\n"
  }, edges => !edges.some(e => e.type === 'CONSUMES' && e.from === 'a.js#other')],
  'Python class attribute does not leak into methods': [{
    'm.py': 'class A:\n    def save(self):\n        pass\n\nclass B:\n    def save(self):\n        pass\n\nrepo = B()\n\nclass C:\n    repo = A()\n    def m(self):\n        repo.save()\n'
  }, edges => !edges.some(e => e.to === 'm.py#A.save') && edges.some(e => e.from === 'm.py#C.m' && e.to === 'm.py#B.save')],
  'Python keyword argument is not an assignment; untyped param shadows': [{
    'm.py': 'class Sql:\n    def save(self):\n        pass\n\ndef build(**kw):\n    pass\n\ndef save_user(x):\n    pass\n\ndef run(repo, save_user):\n    build(\n        repo=Sql(),\n    )\n    repo.save()\n    save_user(1)\n    return [f(1) for f in repo]\n'
  }, edges => !edges.some(e => e.to === 'm.py#Sql.save') && !edges.some(e => e.to === 'm.py#save_user') && edges.some(e => e.to === 'm.py#build')]
}

for (const [name, [files, ok]] of Object.entries(FALSE_EDGE_CASES)) {
  test(`v0.6 no false edge: ${name}`, async () => {
    const w = await semanticRepo(files)
    try {
      const edges = await semanticEdges(w)
      assert.ok(ok(edges), describe(edges))
    } finally { await w.cleanup() }
  })
}

test('v0.6 extraction stays linear on very large files', async () => {
  const { extractSemanticFacts } = await import('../src/indexer/semantic-extract.js')
  const N = 8000
  const text = 'export interface Big {\n' + Array.from({ length: N }, (_, i) => `  m${i}(x: number): void`).join('\n') + '\n}\n'
  const symbols = [{ qualifiedName: 'Big', name: 'Big', kind: 'interface', startLine: 1, endLine: N + 2, exported: true }]
  const t0 = Date.now()
  const { extraSymbols } = extractSemanticFacts({ text, masked: text, symbols, imports: [], file: { fileId: 'big.ts', path: 'big.ts', language: 'TypeScript' } })
  assert.equal(extraSymbols.length, N)
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`)
})

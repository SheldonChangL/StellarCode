import test from 'node:test'
import assert from 'node:assert/strict'
import { readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { pythonLogicalLines } from '../src/indexer/parser.js'
import { semanticRepo, semanticEdges } from './helpers-v06.js'

// v0.6.1 range repair: a truncated body range makes body calls look module-level, which
// drops the CALLS source symbol and breaks A -> B -> C semantic chains.

async function symbolRanges(w) {
  const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
  const rows = db.prepare('SELECT file_id,qualified_name,kind,start_line,end_line FROM symbols').all()
  db.close()
  return Object.fromEntries(rows.map(r => [`${r.file_id}#${r.qualified_name}`, { kind: r.kind, start: r.start_line, end: r.end_line }]))
}

const has = (edges, from, to) => edges.some(e => e.type === 'CALLS' && e.from === from && e.to === to && e.confidence === 'high')
const describe = edges => edges.map(e => `${e.type} ${e.from} -> ${e.to} (${e.confidence})`).sort().join('\n')
const noModuleCaller = (edges, to) => !edges.some(e => e.type === 'CALLS' && e.to === to && !e.from.includes('#'))

const REPO_TS = `export function save(x: unknown) {\n  return x\n}\n\nexport function audit(x: unknown) {\n  return x\n}\n`

test('v0.6.1 JS/TS: destructured parameter brace is not the function body', async () => {
  const w = await semanticRepo({
    'src/repo.ts': REPO_TS,
    // single-line destructuring
    'src/a.js': `import { save } from './repo'\n\nexport function f(a, { b }) {\n  const x = { a, b }\n  return save(x)\n}\n`,
    // multi-line destructuring with trailing commas, async
    'src/b.ts': `import { save, audit } from './repo'\n\nexport async function g(\n  a: string,\n  {\n    b,\n    c,\n  }: { b: string; c: number },\n): Promise<{ ok: boolean }> {\n  if (a) {\n    audit({ a })\n  }\n  await save({ b, c })\n  return { ok: true }\n}\n`,
    // Next.js-style exported async route handler
    'src/route.ts': `import { save } from './repo'\n\nexport async function PATCH(req: Request, { params }: { params: { id: string } }) {\n  const body = await req.json()\n  return save({ id: params.id, body })\n}\n`,
    // export default with multi-line params
    'src/c.ts': `import { save } from './repo'\n\nexport default async function handler(\n  req: any,\n  { params }: any,\n) {\n  return save(params)\n}\n`
  })
  try {
    const ranges = await symbolRanges(w)
    assert.deepEqual(ranges['src/a.js#f'], { kind: 'function', start: 3, end: 6 })
    assert.deepEqual(ranges['src/b.ts#g'], { kind: 'function', start: 3, end: 15 })
    assert.deepEqual(ranges['src/route.ts#PATCH'], { kind: 'function', start: 3, end: 6 })
    assert.deepEqual(ranges['src/c.ts#handler'], { kind: 'function', start: 3, end: 8 })
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'src/a.js#f', 'src/repo.ts#save'), describe(edges))
    assert.ok(has(edges, 'src/b.ts#g', 'src/repo.ts#save'), describe(edges))
    assert.ok(has(edges, 'src/b.ts#g', 'src/repo.ts#audit'), describe(edges))
    assert.ok(has(edges, 'src/route.ts#PATCH', 'src/repo.ts#save'), describe(edges))
    assert.ok(has(edges, 'src/c.ts#handler', 'src/repo.ts#save'), describe(edges))
    assert.ok(noModuleCaller(edges, 'src/repo.ts#save'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6.1 JS/TS: arrow functions with destructured and multi-line parameters', async () => {
  const w = await semanticRepo({
    'src/repo.ts': REPO_TS,
    'src/arrows.ts': `import { save, audit } from './repo'\n\nexport const f = (\n  { a, b }: { a: string; b: string },\n  c: number,\n) => {\n  const nested = { inner: { a } }\n  return save(nested)\n}\n\nexport const g = async (\n  {\n    a,\n  }: { a: string },\n): Promise<void> => {\n  await audit(a)\n}\n\nexport const h = ({ a }: { a: string }) =>\n  save(a)\n\nexport const k = async function ({ a }: any) {\n  return audit(a)\n}\n`
  })
  try {
    const ranges = await symbolRanges(w)
    assert.deepEqual(ranges['src/arrows.ts#f'], { kind: 'constant', start: 3, end: 9 })
    assert.deepEqual(ranges['src/arrows.ts#g'], { kind: 'constant', start: 11, end: 17 })
    assert.deepEqual(ranges['src/arrows.ts#h'], { kind: 'constant', start: 19, end: 20 })
    assert.deepEqual(ranges['src/arrows.ts#k'], { kind: 'constant', start: 22, end: 24 })
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'src/arrows.ts#f', 'src/repo.ts#save'), describe(edges))
    assert.ok(has(edges, 'src/arrows.ts#g', 'src/repo.ts#audit'), describe(edges))
    assert.ok(has(edges, 'src/arrows.ts#h', 'src/repo.ts#save'), describe(edges))
    assert.ok(has(edges, 'src/arrows.ts#k', 'src/repo.ts#audit'), describe(edges))
    assert.ok(noModuleCaller(edges, 'src/repo.ts#save') && noModuleCaller(edges, 'src/repo.ts#audit'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6.1 JS/TS: nested braces in the body and object return types keep the full method range; chain A -> B -> C holds', async () => {
  const w = await semanticRepo({
    'src/repo.ts': REPO_TS,
    'src/service.ts': `import { save } from './repo'\n\nexport class OrderService {\n  async update({ id, patch }: { id: string; patch: { status?: string } }): Promise<{ id: string }> {\n    const plan = { steps: [{ id }], meta: { patch } }\n    for (const step of plan.steps) {\n      if (step.id) {\n        save(step)\n      }\n    }\n    return { id }\n  }\n}\n\nexport default new OrderService()\n`,
    'src/controller.ts': `import orderService from './service'\n\nexport async function PATCH(req: any, { params }: { params: { id: string } }) {\n  return orderService.update({ id: params.id, patch: req.body })\n}\n`
  })
  try {
    const ranges = await symbolRanges(w)
    assert.deepEqual(ranges['src/service.ts#OrderService.update'], { kind: 'method', start: 4, end: 12 })
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'src/controller.ts#PATCH', 'src/service.ts#OrderService.update'), describe(edges))
    assert.ok(has(edges, 'src/service.ts#OrderService.update', 'src/repo.ts#save'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6.1 JS/TS: unreadable syntax falls back to a one-line range instead of a wrong one', async () => {
  const w = await semanticRepo({
    'src/broken.ts': `export function overload(a: string): string\nexport function overload(a: any) {\n  return a\n}\n\nexport function unbalanced(a, { b ) {\n  return a\n`
  })
  try {
    const ranges = await symbolRanges(w)
    const unbalanced = Object.entries(ranges).find(([k]) => k === 'src/broken.ts#unbalanced')?.[1]
    if (unbalanced) assert.equal(unbalanced.end, unbalanced.start)
  } finally { await w.cleanup() }
})

const PY_REPO = `def save_token(user_id, token):\n    return token\n\n\ndef audit(event):\n    return event\n`

test('v0.6.1 Python: multi-line def, async multi-line def and decorated multi-line def keep their bodies', async () => {
  const w = await semanticRepo({
    'app/__init__.py': '',
    'app/repo.py': PY_REPO,
    'app/tokens.py': `from app.repo import save_token, audit\n\n\ndef put_redmine_token(\n    user_id: str,\n    token: str,\n    *,\n    overwrite: bool = False,\n):\n    if overwrite:\n        audit("overwrite")\n    return save_token(user_id, token)\n\n\nasync def rotate_token(\n    user_id: str,\n) -> dict:\n    new = "x"\n    save_token(user_id, new)\n    return {"ok": True}\n\n\n@router.post(\n    "/tokens",\n    response_model=dict,\n)\nasync def create_token(\n    user_id: str,\n    token: str,\n):\n    \"\"\"Create a token.\n\nNot a def: def fake(x):\n\"\"\"\n    query = (\n"select 1"\n    )\n    # comment at body indent\n\n    return save_token(user_id, token)\n\n\ndef after():\n    return audit("after")\n`
  })
  try {
    const ranges = await symbolRanges(w)
    assert.deepEqual(ranges['app/tokens.py#put_redmine_token'], { kind: 'function', start: 4, end: 12 })
    assert.deepEqual(ranges['app/tokens.py#rotate_token'], { kind: 'function', start: 15, end: 20 })
    assert.deepEqual(ranges['app/tokens.py#create_token'], { kind: 'function', start: 27, end: 40 })
    assert.deepEqual(ranges['app/tokens.py#after'], { kind: 'function', start: 43, end: 44 })
    assert.equal(ranges['app/tokens.py#fake'], undefined, 'text inside a docstring is not a def')
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'app/tokens.py#put_redmine_token', 'app/repo.py#save_token'), describe(edges))
    assert.ok(has(edges, 'app/tokens.py#put_redmine_token', 'app/repo.py#audit'), describe(edges))
    assert.ok(has(edges, 'app/tokens.py#rotate_token', 'app/repo.py#save_token'), describe(edges))
    assert.ok(has(edges, 'app/tokens.py#create_token', 'app/repo.py#save_token'), describe(edges))
    assert.ok(has(edges, 'app/tokens.py#after', 'app/repo.py#audit'), describe(edges))
    assert.ok(noModuleCaller(edges, 'app/repo.py#save_token'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6.1 Python: nested blocks and methods with multi-line signatures attribute calls to the method', async () => {
  const w = await semanticRepo({
    'app/__init__.py': '',
    'app/repo.py': PY_REPO,
    'app/service.py': `from app.repo import save_token\n\n\nclass TokenService:\n    def store(\n        self,\n        user_id: str,\n        token: str,\n    ) -> None:\n        for attempt in range(3):\n            try:\n                if token:\n                    save_token(user_id, token)\n            except ValueError:\n                continue\n\n    def other(self):\n        return None\n`
  })
  try {
    const ranges = await symbolRanges(w)
    assert.deepEqual(ranges['app/service.py#TokenService'], { kind: 'class', start: 4, end: 18 })
    assert.deepEqual(ranges['app/service.py#TokenService.store'], { kind: 'method', start: 5, end: 15 })
    assert.deepEqual(ranges['app/service.py#TokenService.other'], { kind: 'method', start: 17, end: 18 })
    const edges = await semanticEdges(w)
    assert.ok(has(edges, 'app/service.py#TokenService.store', 'app/repo.py#save_token'), describe(edges))
  } finally { await w.cleanup() }
})

test('v0.6.1 Python logical lines: brackets, triple-quoted strings and backslash continuations', () => {
  const text = `x = (\n1,\n)\ns = """\ndef no():\n"""\ny = 1 + \\\n  2\n# only comment\n\nz = 3\n`
  assert.deepEqual(pythonLogicalLines(text), [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 7 }, { start: 10, end: 10 }])
})

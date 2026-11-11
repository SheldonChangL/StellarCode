import test from 'node:test'
import assert from 'node:assert/strict'
import { contextForTask } from '../src/query/query-service.js'
import { codeOnly } from '../src/query/semantic-seed.js'
import { SLICE_PLANS, semanticSlice } from '../src/query/semantic-slice.js'
import { readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { semanticRepo } from './helpers-v06.js'

// v0.6.1 seed relevance and traversal admission (no budget change).
const BENCH = { compact: true, depth: 1, maxFiles: 6, maxLines: 160, maxBytes: 12000, withSource: true }
const seedKeys = ctx => (ctx.semanticRoute?.seeds ?? []).map(s => `${s.path}#${s.symbol}`)
const edgeKeys = ctx => ctx.semanticEvidence.map(e => `${e.from.path}#${e.from.symbol}|${e.relation}|${e.to.path}#${e.to.symbol}`)

test('v0.6.1 code-only text drops strings, comments and JSX text but keeps identifiers', () => {
  const text = codeOnly('const label = "voucher expired" // voucher here\nreturn <p className="x">Voucher expired</p>\nconst ok = checkVoucherExpiry(v) /* voucher */')
  assert.ok(!/expired/i.test(text), text)
  assert.match(text, /checkVoucherExpiry/)
  assert.match(codeOnly('def f():\n    """voucher docs"""\n    return redeem_voucher(x)  # voucher'), /redeem_voucher/)
  assert.ok(!/docs/.test(codeOnly('def f():\n    """voucher docs"""\n    return 1')))
})

test('v0.6.1 the function covering distinct query concepts outranks a helper that repeats one word', async () => {
  const w = await semanticRepo({
    'src/lib/voucherLog.ts': `export function voucher(message: string) {\n  return message\n}\n`,
    'src/repo/voucherRepo.ts': `export function markRedeemed(code: string) {\n  return code\n}\n`,
    'src/services/redeem.ts': `import { markRedeemed } from '../repo/voucherRepo'\n\nexport function redeemVoucher(code: string, balance: number, expiresAt: number) {\n  if (expiresAt < Date.now()) throw new Error('expired')\n  const remaining = balance - 1\n  if (remaining < 0) throw new Error('empty')\n  return markRedeemed(code)\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Where is a voucher redeemed after checking its expiry and remaining balance?', { dirs: w.dirs, ...BENCH })
    assert.equal(seedKeys(ctx)[0], 'src/services/redeem.ts#redeemVoucher', JSON.stringify(ctx.semanticRoute))
  } finally { await w.cleanup() }
})

test('v0.6.1 UI labels that restate the query do not make a page component the behavior seed', async () => {
  const w = await semanticRepo({
    'src/repo/store.ts': `export function persistShipment(id: string) {\n  return id\n}\n`,
    'src/server/shipments.ts': `import { persistShipment } from '../repo/store'\n\nexport function cancelShipment(shipmentId: string, refundCarrier: boolean) {\n  if (refundCarrier) persistShipment(shipmentId)\n  return persistShipment(shipmentId)\n}\n`,
    'src/ui/ShipmentPanel.tsx': `export function ShipmentPanel() {\n  return (\n    <div>\n      <h1>Cancel shipment</h1>\n      <p>Cancelling a shipment refunds the carrier fee and releases the label.</p>\n      <button>Cancel shipment and refund carrier</button>\n    </div>\n  )\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Where is a shipment cancelled and the carrier refunded?', { dirs: w.dirs, ...BENCH })
    assert.equal(seedKeys(ctx)[0], 'src/server/shipments.ts#cancelShipment', JSON.stringify(ctx.semanticRoute))
  } finally { await w.cleanup() }
})

test('v0.6.1 flow keeps the most relevant upstream callers of a shared step (was: all dropped)', async () => {
  const w = await semanticRepo({
    'src/services/ledger.ts': `export function postLedgerEntry(amount: number) {\n  return amount\n}\n`,
    'src/controllers/payoutController.ts': `import { postLedgerEntry } from '../services/ledger'\n\nexport function payoutSettlement(amount: number) {\n  return postLedgerEntry(amount)\n}\n`,
    'src/controllers/refundController.ts': `import { postLedgerEntry } from '../services/ledger'\n\nexport function refundCustomer(amount: number) {\n  return postLedgerEntry(-amount)\n}\n`,
    'src/jobs/cleanup.ts': `import { postLedgerEntry } from '../services/ledger'\n\nexport function nightlyCleanup() {\n  return postLedgerEntry(0)\n}\n`,
    'src/routes/payouts.ts': `import { payoutSettlement } from '../controllers/payoutController'\n\nexport function mountPayoutRoutes(router: any) {\n  return payoutSettlement(router.amount)\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Trace how a payout settlement posts the ledger entry.', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.intent, 'flow')
    const keys = edgeKeys(ctx)
    assert.ok(keys.includes('src/controllers/payoutController.ts#payoutSettlement|CALLS|src/services/ledger.ts#postLedgerEntry'), keys.join('\n'))
    assert.ok(ctx.semanticEvidence.length <= SLICE_PLANS.flow.maxEdges)
  } finally { await w.cleanup() }
})

test('v0.6.1 an edge between two distinct seeds in one file is admitted; sibling members of one seed container are not', async () => {
  const w = await semanticRepo({
    'app/__init__.py': '',
    'app/rules.py': `def load_published_rules(version):\n    rules = {"version": version}\n    return rules\n\n\ndef validate_required_fields(ticket, version):\n    rules = load_published_rules(version)\n    missing = [f for f in rules if f not in ticket]\n    return missing\n`,
    'src/Engine.ts': `export class Engine {\n  load() {\n    return 1\n  }\n  validate() {\n    return this.load()\n  }\n}\n`
  })
  try {
    const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
    try {
      const seeds = [
        { path: 'app/rules.py', symbol: 'load_published_rules', lines: [1, 3] },
        { path: 'app/rules.py', symbol: 'validate_required_fields', lines: [6, 9] }
      ]
      const slice = semanticSlice(db, { intent: 'impact', targets: seeds, seedRole: 'consumer', intentConfidence: 'high' })
      assert.ok(slice.edges.some(e => e.from.symbol === 'validate_required_fields' && e.to.symbol === 'load_published_rules'), JSON.stringify(slice.edges))
      // One class seed expands to its members; a member calling its sibling adds nothing.
      const container = semanticSlice(db, { intent: 'impact', targets: [{ path: 'src/Engine.ts', symbol: 'Engine', lines: [1, 8] }], seedRole: 'consumer', intentConfidence: 'high' })
      assert.ok(!container.edges.some(e => e.from.symbol === 'Engine.validate' && e.to.symbol === 'Engine.load'), JSON.stringify(container.edges))
    } finally { db.close() }
  } finally { await w.cleanup() }
})

test('v0.6.1 navigation behavior reports the owner callee as a relation without grounding its source', async () => {
  const w = await semanticRepo({
    'src/billing/rounding.ts': `export function nearestCent(value: number) {\n  return Math.round(value * 100) / 100\n}\n`,
    'src/billing/invoiceTotal.ts': `import { nearestCent } from './rounding'\n\nexport function computeInvoiceTotal(lines: number[], taxRate: number) {\n  const subtotal = lines.reduce((a, b) => a + b, 0)\n  return nearestCent(subtotal * (1 + taxRate))\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Where is the invoice total computed with the tax rate?', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.intent, 'navigation')
    assert.equal(ctx.semanticRoute.plan, 'navigation-behavior')
    assert.ok(edgeKeys(ctx).includes('src/billing/invoiceTotal.ts#computeInvoiceTotal|CALLS|src/billing/rounding.ts#nearestCent'), edgeKeys(ctx).join('\n'))
    assert.ok(!ctx.relatedEvidence.some(e => e.path === 'src/billing/rounding.ts' && e.source), 'callee stays ungrounded')
    assert.ok(ctx.semanticEvidence.length <= SLICE_PLANS.navigation.maxEdges)
  } finally { await w.cleanup() }
})

test('v0.6.1 widely consumed infrastructure ranks below the specific callee within the budget', async () => {
  const users = Array.from({ length: 8 }, (_, i) => `src/other/use${i}.ts`)
  const files = {
    'src/db/index.ts': `export const db = { run(q: string) { return q } }\n`,
    'src/authz/permission.ts': `export function assertCanMove(user: string) {\n  return user\n}\n`,
    'src/pages/move.ts': `import { db } from '../db/index'\nimport { assertCanMove } from '../authz/permission'\n\nexport function movePageToSpace(user: string, page: string) {\n  assertCanMove(user)\n  return db.run(page)\n}\n`
  }
  for (const [i, file] of users.entries()) files[file] = `import { db } from '../db/index'\n\nexport function use${i}() {\n  return db\n}\n`
  const w = await semanticRepo(files)
  try {
    const ctx = await contextForTask(w.repo, 'I need to change movePageToSpace permission checks.', { dirs: w.dirs, ...BENCH })
    const keys = edgeKeys(ctx)
    const callee = keys.indexOf('src/pages/move.ts#movePageToSpace|CALLS|src/authz/permission.ts#assertCanMove')
    const infra = keys.indexOf('src/pages/move.ts#movePageToSpace|CONSUMES|src/db/index.ts#db')
    assert.ok(callee >= 0, keys.join('\n'))
    assert.ok(infra < 0 || infra > callee, keys.join('\n'))
  } finally { await w.cleanup() }
})

test('v0.6.1 a guard registered everywhere ranks below the specific callee within the budget', async () => {
  const files = {
    'src/auth/session.ts': `export function requireSession(req: unknown) {\n  return req\n}\n`,
    'src/orders/price.ts': `export function priceOrder(order: string) {\n  return order\n}\n`,
    'src/orders/create.ts': `import { requireSession } from '../auth/session'\nimport { priceOrder } from './price'\n\nexport function createOrder(app: { use(fn: unknown): void }, order: string) {\n  app.use(requireSession)\n  return priceOrder(order)\n}\n`
  }
  for (let i = 0; i < 8; i++) files[`src/other/route${i}.ts`] = `import { requireSession } from '../auth/session'\n\nexport function route${i}(app: { use(fn: unknown): void }) {\n  app.use(requireSession)\n}\n`
  const w = await semanticRepo(files)
  try {
    const ctx = await contextForTask(w.repo, 'Trace the flow of createOrder from the request to the result.', { dirs: w.dirs, ...BENCH })
    const keys = edgeKeys(ctx)
    const callee = keys.indexOf('src/orders/create.ts#createOrder|CALLS|src/orders/price.ts#priceOrder')
    const guard = keys.indexOf('src/orders/create.ts#createOrder|REGISTERS|src/auth/session.ts#requireSession')
    assert.ok(callee >= 0, keys.join('\n'))
    assert.ok(guard < 0 || guard > callee, keys.join('\n'))
  } finally { await w.cleanup() }
})

test('v0.6.1 relations beyond the edge budget are reported as hints without source', async () => {
  const helpers = Array.from({ length: 10 }, (_, i) => `step${i}`)
  const files = { 'src/flow/run.ts': `${helpers.map(h => `import { ${h} } from './${h}'`).join('\n')}\n\nexport function runCheckout(order: string) {\n${helpers.map(h => `  ${h}(order)`).join('\n')}\n  return order\n}\n` }
  for (const h of helpers) files[`src/flow/${h}.ts`] = `export function ${h}(order: string) {\n  return order\n}\n`
  const w = await semanticRepo(files)
  try {
    const ctx = await contextForTask(w.repo, 'Trace the flow of runCheckout from the request to the result.', { dirs: w.dirs, ...BENCH })
    const key = e => `${e.from.path}#${e.from.symbol}|${e.relation}|${e.to.path}#${e.to.symbol}`
    const edges = ctx.semanticEvidence.map(key)
    const hints = (ctx.semanticHints ?? []).map(key)
    assert.equal(edges.length, SLICE_PLANS.flow.maxEdges, 'the grounded edge budget is unchanged')
    assert.equal(hints.length, 4, 'the four admitted relations beyond the budget are hinted')
    assert.ok(hints.every(k => !edges.includes(k)), 'a hint never repeats a returned edge')
    assert.equal(new Set([...edges, ...hints]).size, 10)
    const hintedFiles = new Set(ctx.semanticHints.map(e => e.to.path))
    assert.ok(!ctx.relatedEvidence.some(e => e.semantic && e.source && hintedFiles.has(e.path)), 'a hinted relation attaches no source')
    assert.ok(ctx.semanticHints.every(e => !('source' in e)))
  } finally { await w.cleanup() }
})

test('v0.6.1 no hints field when every admitted relation fits the budget', async () => {
  const w = await semanticRepo({
    'src/a.ts': `import { b } from './b'\n\nexport function runSmall(x: string) {\n  return b(x)\n}\n`,
    'src/b.ts': `export function b(x: string) {\n  return x\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Trace the flow of runSmall from the request to the result.', { dirs: w.dirs, ...BENCH })
    assert.ok(ctx.semanticEvidence.length >= 1)
    assert.ok(!('semanticHints' in ctx))
  } finally { await w.cleanup() }
})

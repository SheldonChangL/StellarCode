import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { contextForTask } from '../src/query/query-service.js'
import { classifyIntent } from '../src/query/intent.js'
import { slicePlanFor, SLICE_PLANS } from '../src/query/semantic-slice.js'
import { symbolNature, seedSuitability, SEED_LIMITS } from '../src/query/semantic-seed.js'
import { semanticDiagnostics, funnelSummary, seedReachable, semanticAdjacency } from '../src/benchmark/semantic-diagnostics.js'
import { semanticRepo } from './helpers-v06.js'

const BENCH = { compact: true, depth: 1, maxFiles: 6, maxLines: 160, maxBytes: 12000, withSource: true }
const seedKeys = ctx => (ctx.semanticRoute?.seeds ?? []).map(s => `${s.path}#${s.symbol}`)

// ------------------------------------------------------------------ seed eligibility

const ORDER_REFUND = {
  // The interface carries every domain word of the query; it is type-only.
  'src/models/interfaces/OrderRefund.ts': `export interface OrderRefundRequest {\n  orderId: string\n  refundAmount: number\n  refundReason: string\n  approvedBy: string\n}\n\nexport interface OrderRefundResult {\n  refundId: string\n  orderId: string\n}\n`,
  'src/repo/refundRepository.ts': `export function insertRefund(row: { orderId: string }) {\n  return row\n}\n`,
  'src/services/refundService.ts': `import { insertRefund } from '../repo/refundRepository'\nimport type { OrderRefundRequest } from '../models/interfaces/OrderRefund'\n\nexport function approveRefund(request: OrderRefundRequest) {\n  if (request.refundAmount <= 0) throw new Error('invalid refund')\n  return insertRefund({ orderId: request.orderId })\n}\n`
}

test('v0.6.1 behavior query: a service method is the seed, the domain-word interface is not', async () => {
  const w = await semanticRepo(ORDER_REFUND)
  try {
    const ctx = await contextForTask(w.repo, 'Where is an order refund request approved and validated?', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.semanticRoute.seedRole, 'behavior')
    assert.deepEqual(seedKeys(ctx)[0], 'src/services/refundService.ts#approveRefund')
    assert.ok(ctx.semanticRoute.seeds.every(s => !['interface', 'type'].includes(s.kind)), JSON.stringify(ctx.semanticRoute))
    // The interface remains lexical evidence: excluded as a seed, not deleted from targets/hints.
    const lexical = [...ctx.targets.map(t => t.path), ...ctx.relatedHints.map(h => h.path), ...ctx.relatedEvidence.map(e => e.path)]
    assert.ok(lexical.includes('src/models/interfaces/OrderRefund.ts'), lexical.join(', '))
  } finally { await w.cleanup() }
})

test('v0.6.1 definition query: the interface is a valid seed', async () => {
  const w = await semanticRepo(ORDER_REFUND)
  try {
    const ctx = await contextForTask(w.repo, 'Where is the order refund request defined? What fields does it have?', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.semanticRoute.seedRole, 'definition')
    assert.equal(seedKeys(ctx)[0], 'src/models/interfaces/OrderRefund.ts#OrderRefundRequest')
  } finally { await w.cleanup() }
})

test('v0.6.1 symbol nature and role suitability: type-only never seeds behavior or flow', () => {
  assert.equal(symbolNature({ kind: 'interface' }), 'declaration')
  assert.equal(symbolNature({ kind: 'type' }), 'declaration')
  assert.equal(symbolNature({ kind: 'method' }, 'interface'), 'declaration')
  assert.equal(symbolNature({ kind: 'method' }, 'class'), 'executable')
  assert.equal(symbolNature({ kind: 'constant', start_line: 3, end_line: 3, signature: 'export const LIMIT = 5' }), 'declaration')
  assert.equal(symbolNature({ kind: 'constant', start_line: 3, end_line: 3, signature: 'export const f = (x) => x' }), 'executable')
  for (const role of ['behavior', 'flow']) assert.equal(seedSuitability(role, 'declaration'), 0)
  assert.ok(seedSuitability('definition', 'declaration') > 0)
  assert.ok(seedSuitability('consumer', 'declaration') > 0)
  assert.ok(Object.values(SEED_LIMITS).every(limit => limit >= 1 && limit <= 3))
})

// ------------------------------------------------------------------ multi-seed

const TWO_CONTROLLERS = {
  'src/services/invoiceStore.ts': `export function saveInvoice(x: unknown) {\n  return x\n}\nexport function auditInvoice(x: unknown) {\n  return x\n}\nexport function notifyInvoice(x: unknown) {\n  return x\n}\n`,
  'src/controllers/invoiceRefundController.ts': `import { saveInvoice, auditInvoice, notifyInvoice } from '../services/invoiceStore'\n\nexport function refundInvoice(req: any) {\n  saveInvoice(req)\n  auditInvoice(req)\n  return notifyInvoice(req)\n}\n`,
  'src/controllers/invoiceCreditController.ts': `import { saveInvoice, auditInvoice, notifyInvoice } from '../services/invoiceStore'\n\nexport function creditInvoice(req: any) {\n  saveInvoice(req)\n  auditInvoice(req)\n  return notifyInvoice(req)\n}\n`
}

test('v0.6.1 two similarly relevant controllers: 2 seeds, one shared edge budget, deterministic order', async () => {
  const w = await semanticRepo(TWO_CONTROLLERS)
  try {
    const query = 'Trace how an invoice refund or invoice credit request reaches the invoice store.'
    const a = await contextForTask(w.repo, query, { dirs: w.dirs, ...BENCH })
    const b = await contextForTask(w.repo, query, { dirs: w.dirs, ...BENCH })
    assert.equal(a.intent, 'flow')
    const seeds = seedKeys(a)
    assert.ok(seeds.includes('src/controllers/invoiceRefundController.ts#refundInvoice'), seeds.join(', '))
    assert.ok(seeds.includes('src/controllers/invoiceCreditController.ts#creditInvoice'), seeds.join(', '))
    assert.ok(seeds.length >= 2 && seeds.length <= SEED_LIMITS.flow)
    // 2 seeds x 3 callees = 6 candidate edges, but the flow budget is shared, not per seed.
    assert.ok(a.semanticEvidence.length <= SLICE_PLANS.flow.maxEdges, `${a.semanticEvidence.length} edges`)
    assert.deepEqual(seedKeys(b), seeds)
    assert.deepEqual(b.semanticEvidence, a.semanticEvidence)
  } finally { await w.cleanup() }
})

// ------------------------------------------------------------------ hub protection

test('v0.6.1 a high-degree hub does not become the seed on edge count', async () => {
  const helpers = Array.from({ length: 12 }, (_, i) => `export function helper${i}(x: unknown) {\n  return x\n}\n`).join('')
  const w = await semanticRepo({
    'src/lib/helpers.ts': helpers,
    // Hub: executable, calls 12 helpers, only loosely named after the query.
    'src/lib/dispatch.ts': `import { ${Array.from({ length: 12 }, (_, i) => `helper${i}`).join(', ')} } from './helpers'\n\nexport function dispatchCoupon(x: unknown) {\n${Array.from({ length: 12 }, (_, i) => `  helper${i}(x)\n`).join('')}  return x\n}\n`,
    // Small method, lexically the better match, with one semantic edge.
    'src/coupons/couponExpiry.ts': `import { helper0 } from '../lib/helpers'\n\nexport function checkCouponExpiryDate(coupon: { expiresAt: number }) {\n  const expired = coupon.expiresAt < Date.now()\n  helper0(expired)\n  return expired\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'Where is the coupon expiry date checked?', { dirs: w.dirs, ...BENCH })
    assert.equal(seedKeys(ctx)[0], 'src/coupons/couponExpiry.ts#checkCouponExpiryDate', JSON.stringify(ctx.semanticRoute))
  } finally { await w.cleanup() }
})

// ------------------------------------------------------------------ impact contract seed

test('v0.6.1 impact: a Config interface is a valid seed and its consumers are grounded', async () => {
  const w = await semanticRepo({
    'src/config/BillingConfig.ts': `export interface BillingConfig {\n  billingCurrency: string\n  billingRetries: number\n}\n`,
    'src/services/ServiceA.ts': `import type { BillingConfig } from '../config/BillingConfig'\n\nexport function chargeA(config: BillingConfig) {\n  return config.billingCurrency\n}\n`,
    'src/services/ServiceB.ts': `import type { BillingConfig } from '../config/BillingConfig'\n\nexport function retryB(config: BillingConfig) {\n  return config.billingRetries\n}\n`
  })
  try {
    const ctx = await contextForTask(w.repo, 'If BillingConfig changes, which modules are affected?', { dirs: w.dirs, ...BENCH })
    assert.equal(ctx.intent, 'impact')
    assert.equal(ctx.semanticRoute.seedRole, 'consumer')
    assert.ok(seedKeys(ctx).includes('src/config/BillingConfig.ts#BillingConfig'), JSON.stringify(ctx.semanticRoute))
    const consumers = ctx.semanticEvidence.filter(e => e.direction === 'incoming' && e.to.symbol === 'BillingConfig').map(e => `${e.from.path}#${e.from.symbol}`)
    assert.ok(consumers.includes('src/services/ServiceA.ts#chargeA'), consumers.join(', '))
    assert.ok(consumers.includes('src/services/ServiceB.ts#retryB'), consumers.join(', '))
  } finally { await w.cleanup() }
})

// ------------------------------------------------------------------ intent routing

test('v0.6.1 intent precedence on generic prompts', () => {
  const cases = [
    ['What uses Config?', 'impact'],
    ['If Config changes, what needs review?', 'impact'],
    ['I need to change Config validation.', 'editing-prep'],
    ['Trace Config from request to persistence.', 'flow'],
    ['Where is Config defined?', 'navigation'],
    ['Where is Config validation performed?', 'navigation'],
    ['Before changing Config, which consumers need review?', 'impact'],
    ['If I change X, what else is affected?', 'impact'],
    ['Where should I edit X?', 'editing-prep'],
    ['What files should I inspect before implementing X?', 'editing-prep'],
    ['Add X behavior', 'editing-prep'],
    ['Modify X validation', 'editing-prep'],
    ['Which modules need review if X changes?', 'impact'],
    ['What consumers call X?', 'impact'],
    ['What depends on X?', 'impact'],
    ['What happens after X?', 'flow'],
    ['How does an order get persisted?', 'flow'],
    ['Trace how X reaches Y; which file starts it?', 'flow'],
    ['How long does it wait after the last change before saving?', 'navigation'],
    ['Before adding a webhook channel, which files must be edited?', 'editing-prep']
  ]
  for (const [query, intent] of cases) assert.equal(classifyIntent(query).intent, intent, query)
  assert.equal(classifyIntent('Where is Config defined?').seedRole, 'definition')
  assert.equal(classifyIntent('Where is Config validation performed?').seedRole, 'behavior')
  assert.equal(classifyIntent('What uses Config?').seedRole, 'consumer')
  assert.equal(classifyIntent('Trace Config from request to persistence.').seedRole, 'flow')
})

test('v0.6.1 ambiguous intent uses a small mixed slice, never every direction', () => {
  const ambiguous = classifyIntent('invoice rounding currency')
  assert.equal(ambiguous.intentConfidence, 'low')
  const plan = slicePlanFor(ambiguous.intent, ambiguous)
  assert.equal(plan.name, 'mixed')
  assert.ok(plan.maxEdges <= SLICE_PLANS.flow.maxEdges)
  assert.ok(plan.steps.every(step => step.depth === 1))
  assert.equal(classifyIntent('What uses Config?').intentConfidence, 'high')
  assert.equal(slicePlanFor('impact', classifyIntent('What uses Config?')).name, 'impact')
  // Navigation keeps its incoming-only budget (callees stay hints).
  assert.deepEqual(slicePlanFor('navigation', classifyIntent('Where is Config validation performed?')).steps.map(s => s.direction), ['incoming'])
})

// ------------------------------------------------------------------ funnel + leakage

test('v0.6.1 semantic funnel ratios and seed reachability', () => {
  const indexed = new Set(['a#x|CALLS|b#y', 'b#y|CALLS|c#z', 'c#z|CALLS|d#w'])
  const adj = semanticAdjacency(indexed)
  assert.equal(seedReachable('a#x|CALLS|b#y', ['a#x'], adj), true)
  assert.equal(seedReachable('b#y|CALLS|c#z', ['a#x'], adj), true)
  assert.equal(seedReachable('c#z|CALLS|d#w', ['a#x'], adj), false)
  const f = funnelSummary([{ requiredEdges: 4, requiredEdgesIndexed: 3, requiredEdgesInCandidatePool: 3, requiredEdgesFileInCandidatePool: 3, requiredEdgesSeedReachable: 2, requiredEdgesAdmitted: 2, requiredEdgesReturned: 1 }])
  assert.equal(f.indexRecall, 0.75)
  assert.equal(f.routingRecall, 0.3333)
  assert.equal(f.contextRecall, 0.25)
  assert.equal(funnelSummary([]).routingRecall, null)
})

test('v0.6.1 answer keys never reach seed selection or traversal', async () => {
  const w = await semanticRepo(ORDER_REFUND)
  try {
    const task = { id: 'probe', category: 'navigation', prompt: 'Where is an order refund request approved and validated?' }
    const write = async (name, extra) => { const file = path.join(w.base, name); await fs.writeFile(file, JSON.stringify({ version: 1, tasks: [{ ...task, ...extra }] })); return file }
    const a = await semanticDiagnostics(w.repo, await write('a.json', { category: 'impact', expectedFiles: ['src/models/interfaces/OrderRefund.ts'], expectedSemanticEdges: [{ from: 'x#ZZ_LEAK', relation: 'CALLS', to: 'src/models/interfaces/OrderRefund.ts#OrderRefundRequest' }] }), { dirs: w.dirs })
    const b = await semanticDiagnostics(w.repo, await write('b.json', { category: 'flow', expectedFiles: ['src/services/refundService.ts'], expectedSemanticEdges: [] }), { dirs: w.dirs })
    for (const field of ['intent', 'seedRole', 'semanticSeedPaths', 'semanticSeedKinds', 'primary', 'semanticEdges'])
      assert.deepEqual(a.tasks[0][field], b.tasks[0][field], field)
  } finally { await w.cleanup() }
  // Static guard: runtime query code never names benchmark answer-key fields.
  for (const file of ['intent.js', 'semantic-seed.js', 'semantic-slice.js', 'query-service.js']) {
    const text = await fs.readFile(new URL(`../src/query/${file}`, import.meta.url), 'utf8')
    assert.ok(!/expectedSemanticEdges|expectedFiles|task\.category/.test(text), file)
  }
})

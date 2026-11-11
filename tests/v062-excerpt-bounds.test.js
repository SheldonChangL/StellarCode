import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { initializeProject } from '../src/core/project.js'
import { syncProject } from '../src/indexer/sync.js'
import { contextForTask } from '../src/query/query-service.js'
import { makeWorkspace } from './helpers.js'

const CONTEXT = { sync:false, compact:true, depth:1, withSource:true, maxFiles:6, maxLines:160, maxBytes:12000 }

async function fixture(files) {
  const w=await makeWorkspace()
  for(const dir of ['src','tests','python'])await fs.rm(path.join(w.repo,dir),{recursive:true,force:true})
  for(const [file,text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(w.repo,file)),{recursive:true})
    await fs.writeFile(path.join(w.repo,file),text)
  }
  await initializeProject(w.repo);await syncProject(w.repo,{dirs:w.dirs,force:true})
  return w
}

const grounded=ctx=>[...ctx.targets,...ctx.relatedEvidence].filter(item=>item.source)
const sourceBytes=ctx=>grounded(ctx).reduce((sum,item)=>sum+Buffer.byteLength(item.source)+1,0)

// A function of `length` lines whose query terms sit in a short stretch in the middle, so
// the focus window narrows it and leaves its signature and tail outside.
function longFunction(name,length,middle) {
  const body=[]
  for(let n=0;n<length-2;n++)body.push(n>=20&&n<24?`  ${middle}`:`  const step${n} = ${n}`)
  return [`export function ${name}(invoice) {`,...body,'}'].join('\n')
}

const FILES={
  'src/billing/settle.ts':`import { applyLateFee } from './fees'\n\nexport function settleInvoice(invoice) {\n  return applyLateFee(invoice)\n}\n`,
  'src/billing/fees.ts':`${longFunction('applyLateFee',90,'invoice.lateFee = computeLateFee(invoice)')}\n\nexport function computeLateFee(invoice) {\n  return invoice.total * 0.02\n}\n`
}

test('v0.6.2 a narrowed range grows back to its whole symbol when budget is left', async () => {
  const w=await fixture(FILES)
  const ctx=await contextForTask(w.repo,'Trace how settling an invoice applies the late fee.',{...CONTEXT,dirs:w.dirs})
  const fee=grounded(ctx).find(item=>item.path==='src/billing/fees.ts'&&item.symbol==='applyLateFee')
  assert.ok(fee,'the long callee is grounded')
  assert.deepEqual(fee.lines,[1,90])
  assert.equal(fee.source.split('\n').length,90)
  assert.ok(fee.source.startsWith('1: export function applyLateFee'))
  assert.ok(sourceBytes(ctx)<=CONTEXT.maxBytes)
  assert.deepEqual(await contextForTask(w.repo,'Trace how settling an invoice applies the late fee.',{...CONTEXT,dirs:w.dirs}),ctx,'deterministic')
})

test('v0.6.2 growth never exceeds the byte budget or overlaps another range', async () => {
  const w=await fixture(FILES)
  const ctx=await contextForTask(w.repo,'Trace how settling an invoice applies the late fee.',{...CONTEXT,maxBytes:1500,dirs:w.dirs})
  assert.ok(sourceBytes(ctx)<=1500)
  const byPath=new Map()
  for(const item of grounded(ctx)) {
    for(const other of byPath.get(item.path)??[])assert.ok(item.lines[1]<other[0]||other[1]<item.lines[0],'ranges of one file stay disjoint')
    byPath.set(item.path,[...(byPath.get(item.path)??[]),item.lines])
  }
})

test('v0.6.2 a symbol too long to return whole only gains a margin', async () => {
  const w=await fixture({...FILES,'src/billing/fees.ts':`${longFunction('applyLateFee',400,'invoice.lateFee = computeLateFee(invoice)')}\n\nexport function computeLateFee(invoice) {\n  return invoice.total * 0.02\n}\n`})
  const ctx=await contextForTask(w.repo,'Trace how settling an invoice applies the late fee.',{...CONTEXT,dirs:w.dirs})
  const fee=grounded(ctx).find(item=>item.path==='src/billing/fees.ts'&&item.symbol==='applyLateFee')
  assert.ok(fee)
  const length=fee.lines[1]-fee.lines[0]+1
  assert.ok(length<=CONTEXT.maxLines,`at most maxLines, got ${length}`)
  assert.ok(length<400)
})

test('v0.6.2 the default context budget is 20,000 bytes everywhere it is used', async () => {
  const { DEFAULT_CONTEXT_BYTES } = await import('../src/core/constants.js')
  const { STELLAR_CONTEXT_FLAGS } = await import('../src/benchmark/agents.js')
  const { DIAGNOSTIC_CONTEXT } = await import('../src/benchmark/semantic-diagnostics.js')
  assert.equal(DEFAULT_CONTEXT_BYTES,20000)
  assert.equal(STELLAR_CONTEXT_FLAGS[STELLAR_CONTEXT_FLAGS.indexOf('--max-bytes')+1],'20000')
  assert.equal(DIAGNOSTIC_CONTEXT.maxBytes,20000)
})

const THROTTLE=`import { db } from './db'

/**
 * Lock grows with the failure count, up to fifteen minutes.
 */
const FREE_ATTEMPTS = 5
const MAX_LOCK_MS = 15 * 60 * 1000
const UNRELATED_TABLE = [
  'alpha',
  'beta'
]

function lockDurationMs(failedCount) {
  if (failedCount < FREE_ATTEMPTS) return 0
  return Math.min(30000 * 2 ** (failedCount - FREE_ATTEMPTS), MAX_LOCK_MS)
}

export function unrelatedHelper(value) {
  return value + 1
}

export async function recordLoginFailure(email) {
  const row = await db.find(email)
  const failedCount = (row?.failedCount ?? 0) + 1
  const lockedUntil = new Date(Date.now() + lockDurationMs(failedCount))
  await db.save(email, failedCount, lockedUntil)
}
`

test('v0.6.2 same-file declarations a returned range names are attached, two hops deep', async () => {
  const w=await fixture({'src/auth/throttle.ts':THROTTLE,'src/auth/db.ts':'export const db = { find(email) { return null }, save() {} }\n'})
  const ctx=await contextForTask(w.repo,'Find where a login failure is recorded and how long the account stays locked.',{...CONTEXT,dirs:w.dirs})
  const declared=ctx.relatedEvidence.filter(item=>item.relation==='same-file-declaration'&&item.path==='src/auth/throttle.ts')
  const names=declared.flatMap(item=>item.symbol.split(', '))
  assert.ok(names.includes('lockDurationMs'),'the helper the function calls')
  assert.ok(names.includes('FREE_ATTEMPTS')&&names.includes('MAX_LOCK_MS'),'the constants that helper reads (second hop)')
  assert.ok(!names.includes('UNRELATED_TABLE')&&!names.includes('unrelatedHelper'),'unreferenced declarations stay out')
  const text=declared.map(item=>item.source).join('\n')
  assert.match(text,/\d+: const MAX_LOCK_MS = 15 \* 60 \* 1000/)
  assert.match(text,/Lock grows with the failure count/,'the comment directly above comes along')
  for(const item of declared) {
    assert.equal(item.direction,'internal')
    for(const other of grounded(ctx).filter(other=>other!==item&&other.path===item.path))assert.ok(item.lines[1]<other.lines[0]||other.lines[1]<item.lines[0],'disjoint from other ranges')
  }
  assert.ok(sourceBytes(ctx)<=CONTEXT.maxBytes)
})

test('v0.6.2 Python module-level bindings are attached and a tight budget attaches none', async () => {
  const files={'python/client.py':`import os\n\n_DEFAULT_RETRIES: Final[int] = 3\n_DEFAULT_TIMEOUT_S = 10.0\n_UNUSED = 1\n\n\ndef other_one():\n    return 1\n\n\ndef other_two():\n    return 2\n\n\ndef other_three():\n    return 3\n\n\ndef fetch_issue(issue_id):\n    for attempt in range(_DEFAULT_RETRIES):\n        result = request_issue(issue_id, timeout=_DEFAULT_TIMEOUT_S)\n        if result:\n            return result\n    return None\n`}
  const w=await fixture(files)
  const ctx=await contextForTask(w.repo,'Find where an issue is fetched with retries.',{...CONTEXT,dirs:w.dirs})
  const names=ctx.relatedEvidence.filter(item=>item.relation==='same-file-declaration').flatMap(item=>item.symbol.split(', '))
  assert.deepEqual(names.sort(),['_DEFAULT_RETRIES','_DEFAULT_TIMEOUT_S'])
  const tight=await contextForTask(w.repo,'Find where an issue is fetched with retries.',{...CONTEXT,maxBytes:512,dirs:w.dirs})
  assert.ok(sourceBytes(tight)<=512)
})
